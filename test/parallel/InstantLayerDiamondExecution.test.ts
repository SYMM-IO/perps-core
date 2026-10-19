import { expect } from "chai"
import { Contract, Signer, TypedDataDomain } from "ethers"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { FLEX_FILLER_AUTH_TYPES, cloneTypes } from "../helpers/instantLayerEIP712Types.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { QuoteStatus } from "../models/Enums.js"
import { RunContext } from "../models/RunContext.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "../utils/Common.js"
import { InstantLayerDiamondDeployment, deployInstantLayerDiamondForTest } from "../utils/InstantLayerDiamond.js"
import { getDummySingleUpnlSig } from "../utils/SignatureUtils.js"

// This is a smoke suite: one PartyA operation through executeBatch, the OPERATOR_ROLE gate, the
// maxUses replay guard, one template injection, the AccountLayer signer-clear across two ops in
// one call, one delegate-signed execution (both the grant and no-grant paths), and one
// sequential-call probe of core's execution-context close. The full behavior matrix (flex fills,
// nonce ordering, PartyB routing edge cases, multi-op delegation scenarios, ...) arrives with
// Task 8's ported suites, which move the rest of test/InstantLayer.behavior.ts's execution
// coverage.

const ROLES = {
	// Core diamond: gates beginInstantLayerExecution/endInstantLayerExecution/setCallFromInstantLayer.
	CORE_INSTANT_LAYER_ROLE: ethers.keccak256(ethers.toUtf8Bytes("INSTANT_LAYER_ROLE")),
	// AccountLayer diamond: gates setSigner/setSignerScoped/setTransientSigner/setTransientSignerScoped.
	AL_SIGNER_SETTER_ROLE: ethers.keccak256(ethers.toUtf8Bytes("SIGNER_SETTER_ROLE")),
	// SymmioPartyB helper contract: gates its own setSigner.
	PARTY_B_SETTER_ROLE: ethers.keccak256(ethers.toUtf8Bytes("SETTER_ROLE")),
	// This InstantLayer diamond's own OPERATOR_ROLE. Unlike the two grants above (account, role),
	// the diamond's own grantRole keeps the OpenZeppelin (role, account) order.
	DIAMOND_OPERATOR_ROLE: ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE")),
}

const DEFAULT_DEADLINE_OFFSET = 300n

function generateSalt(): string {
	return ethers.hexlify(ethers.randomBytes(32))
}

type SignedOperationInput = {
	signer: string
	target: string
	callData: string
	signerAccount: { addr: string; isPartyB: boolean }
	nonce: bigint
	deadline: bigint
	maxUses?: number
}

function createSignedOperation({ signer, target, callData, signerAccount, nonce, deadline, maxUses = 1 }: SignedOperationInput) {
	return {
		signer,
		target,
		callData,
		signerAccount,
		flexFields: [] as { offset: number; length: number; authorizedFlexFiller: string }[],
		maxUses,
		replayAttackHeader: { nonce, deadline, salt: generateSalt() },
	}
}

// getAccounts(user, 0, 100) returns every sub-account owned by `user`, oldest first. Indexing
// [0] silently retargets to the wrong account if the fixture — now or later — ever pre-creates
// one for that signer; filtering by the name passed to addAccount does not have that failure mode.
function findAccountByName(accounts: readonly { accountAddress: string; name: string }[], name: string): string {
	const match = accounts.find(account => account.name === name)
	if (!match) throw new Error(`no sub-account named "${name}" found`)
	return match.accountAddress
}

describe("InstantLayer diamond execution", function () {
	let context: RunContext
	let admin: Signer
	let partyA: Signer
	let partyB: Signer
	let adminAddress: string
	let partyAAddress: string
	let partyBHelperAddress: string
	let deployment: InstantLayerDiamondDeployment
	let diamond: Contract
	let domain: TypedDataDomain
	let accountAddress: string
	let quoteCallData: string
	let deadline: bigint

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		admin = context.signers.admin
		partyA = context.signers.user
		partyB = context.signers.hedger

		adminAddress = await admin.getAddress()
		partyAAddress = await partyA.getAddress()
		partyBHelperAddress = await context.symmioPartyB.getAddress()

		deployment = await deployInstantLayerDiamondForTest(ethers, admin, context.diamond, [
			"ControlFacet",
			"ViewFacet",
			"DelegationFacet",
			"ExecutionFacet",
		])
		diamond = deployment.diamond

		// Rewire the diamond into core and the AccountLayer the way the monolith's own suite does
		// (test/InstantLayer.behavior.ts), rather than initializeFixture itself — the fixture wires
		// the monolith InstantLayer it deploys, not this diamond.
		await context.controlFacet.connect(admin).grantRole(deployment.address, ROLES.CORE_INSTANT_LAYER_ROLE)
		await context.alControlFacet.connect(admin).grantRole(deployment.address, ROLES.AL_SIGNER_SETTER_ROLE)
		// setAccountLayer also whitelists the AccountLayer as an operation target.
		await diamond.connect(admin).setAccountLayer(context.accountLayerDiamond)

		// Register and bind the PartyB helper on the core diamond, and register it on this diamond.
		await context.controlFacet.connect(admin).registerPartyB(partyBHelperAddress)
		await context.controlFacet.connect(admin).setPartyBBindable(partyBHelperAddress, true)
		await diamond.connect(admin).registerPartyBs([partyBHelperAddress])
		await context.symmioPartyB.connect(admin).grantRole(ROLES.PARTY_B_SETTER_ROLE, adminAddress)
		await context.symmioPartyB.connect(admin).setSigner(await partyB.getAddress())
		await context.symbolControlFacet.connect(admin).whitelistSymbolType(partyBHelperAddress, 1)

		// Create and fund a PartyA sub-account through the AccountLayer.
		await context.accountManager.connect(partyA).addAccount("execTestAccount")
		const accounts = await context.accountManager.getAccounts(partyAAddress, 0, 100)
		accountAddress = findAccountByName(accounts, "execTestAccount")

		await context.collateral.connect(partyA).approve(context.diamond, ethers.MaxUint256)
		await context.collateral.connect(partyA).mint(partyAAddress, decimal(100000n))
		await context.accountFacet.connect(partyA).deposit(decimal(5000n))
		await context.accountFacet.connect(partyA).internalTransfer(accountAddress, decimal(1000n))

		const bindToPartyBCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [partyBHelperAddress])
		await context.accountManager.connect(partyA)._call(accountAddress, [bindToPartyBCallData])

		const request = limitQuoteRequestBuilder().partyBWhiteList([partyBHelperAddress]).build()
		quoteCallData = context.partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
			request.partyBWhiteList,
			request.symbolId,
			request.positionType,
			request.orderType,
			request.price,
			request.quantity,
			request.cva,
			request.lf,
			request.partyAmm,
			request.partyBmm,
			request.maxFundingRate,
			await request.deadline,
			request.affiliate,
			await request.upnlSig,
		])

		domain = {
			name: "SymmioInstantLayer",
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
			verifyingContract: deployment.address,
		}

		deadline = await getBlockTimestamp(DEFAULT_DEADLINE_OFFSET)
	})

	describe("executeBatch", function () {
		it("executes a signed PartyA sendQuote operation end to end", async function () {
			const op = createSignedOperation({
				signer: partyAAddress,
				target: context.diamond,
				callData: quoteCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 1n,
				deadline,
			})
			const sig = await partyA.signTypedData(domain, cloneTypes(), op)

			await expect(diamond.connect(admin).executeBatch([op], [sig], [[]], [[]])).to.not.be.reverted

			// quoteStatus alone would not catch a silently-skipped dispatch: PENDING is enum value
			// 0, the same default a nonexistent quote's zero-initialized struct would return. partyA
			// can only equal accountAddress if sendQuote genuinely ran.
			const quote = await context.viewFacetQuote.getQuote(1)
			expect(quote.partyA).to.equal(accountAddress)
			expect(quote.quoteStatus).to.equal(QuoteStatus.PENDING)

			// Op carried a non-zero nonce (1), so the whole expected-nonce block in
			// _verifyOperation ran; this pins the outcome rather than just exercising the branch.
			expect(await diamond.nonces(accountAddress)).to.equal(1n)
		})

		// What would have to break for this to fail: removing onlyRole(OPERATOR_ROLE) from
		// ExecutionFacet.executeBatch, or LibInstantLayerAccessibility.hasRole always returning true.
		it("reverts MustHaveRole for a caller without OPERATOR_ROLE", async function () {
			const op = createSignedOperation({
				signer: partyAAddress,
				target: context.diamond,
				callData: quoteCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 1n,
				deadline,
			})
			const sig = await partyA.signTypedData(domain, cloneTypes(), op)

			await expect(diamond.connect(partyA).executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(diamond, "MustHaveRole")
		})

		// What would have to break for this to fail: dropping the maxUses check in
		// ExecutionFacet._verifySignedOperation, or failing to persist operationUsageCount.
		it("reverts MaxUsesExceeded when the identical op/signature pair is replayed", async function () {
			const op = createSignedOperation({
				signer: partyAAddress,
				target: context.diamond,
				callData: quoteCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 1n,
				deadline,
				maxUses: 1,
			})
			const sig = await partyA.signTypedData(domain, cloneTypes(), op)

			await diamond.connect(admin).executeBatch([op], [sig], [[]], [[]])

			await expect(diamond.connect(admin).executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(diamond, "MaxUsesExceeded")
		})

		// What would have to break for this to fail: operationUsageCount or nonces moving inside
		// ExecutionStorage, or out of it. Both offsets are counted by hand from its Layout struct,
		// and the operation hash comes from ethers rather than from the diamond.
		it("keeps both replay counters in the execution storage slot", async function () {
			const op = createSignedOperation({
				signer: partyAAddress,
				target: context.diamond,
				callData: quoteCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 1n,
				deadline,
			})
			const sig = await partyA.signTypedData(domain, cloneTypes(), op)
			await diamond.connect(admin).executeBatch([op], [sig], [[]], [[]])

			const execution = BigInt(ethers.id("diamond.standard.storage.instantlayer.execution"))
			const entry = (keyType: string, key: string, slot: bigint) =>
				ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([keyType, "uint256"], [key, slot]))
			const opHash = ethers.TypedDataEncoder.hash(domain, cloneTypes(), op)

			const usageCount = await ethers.provider.getStorage(deployment.address, entry("bytes32", opHash, execution + 1n))
			const nonce = await ethers.provider.getStorage(deployment.address, entry("address", accountAddress, execution + 2n))
			expect(usageCount, "operationUsageCount").to.equal(ethers.toBeHex(1n, 32))
			expect(nonce, "nonces").to.equal(ethers.toBeHex(1n, 32))
		})
	})

	describe("executeTemplate", function () {
		it("rejects recipient injection into a fixed signed operation and rolls back its usage", async function () {
			await context.accountManager.connect(admin).addAccount("injectionSource")
			const sourceAccount = findAccountByName(await context.accountManager.getAccounts(adminAddress, 0, 100), "injectionSource")
			await context.accountFacet.connect(partyA).depositFor(accountAddress, decimal(100n))
			await diamond.addTemplate("recipient rewrite", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
				{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
			])
			const id = (await diamond.getNextTemplateId()) - 1n
			const source = createSignedOperation({
				signer: adminAddress,
				target: context.accountLayerDiamond,
				callData: context.alViewFacet.interface.encodeFunctionData("ownerOf", [sourceAccount]),
				signerAccount: { addr: sourceAccount, isPartyB: false },
				nonce: 0n,
				deadline,
			})
			const victim = createSignedOperation({
				signer: partyAAddress,
				target: context.diamond,
				callData: context.accountFacet.interface.encodeFunctionData("internalTransfer", [partyAAddress, decimal(100n)]),
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 0n,
				deadline,
			})
			const signature = await partyA.signTypedData(domain, cloneTypes(), victim)
			await expect(diamond.executeTemplate(id, [source, victim], ["0x", signature], [[], []], [[], []]))
				.to.be.revertedWithCustomError(diamond, "UnauthorizedTemplateInsertion")
				.withArgs(0)
			expect(await diamond.operationUsageCount(await diamond.getOperationHash(victim))).to.equal(0n)
			expect(await context.viewFacet.balanceOf(accountAddress)).to.equal(decimal(100n))
			await diamond.executeBatch([victim], [signature], [[]], [[]])
			expect(await context.viewFacet.balanceOf(accountAddress)).to.equal(0n)
		})

		it("reverts the entire atomic-open template when a sent quote is never opened", async function () {
			await diamond.addTemplate("orphan instant quote", [{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }])
			const id = (await diamond.getNextTemplateId()) - 1n
			await diamond.setTemplateInstantOpenMode(id, true)
			const op = createSignedOperation({
				signer: partyAAddress,
				target: context.diamond,
				callData: quoteCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 0n,
				deadline,
			})
			const sig = await partyA.signTypedData(domain, cloneTypes(), op)
			const before = await context.viewFacet.allocatedBalanceOfPartyA(accountAddress)
			const executionContext = await ethers.getContractAt("ExecutionContextFacet", context.diamond)
			await expect(diamond.executeTemplate(id, [op], [sig], [[]], [[]]))
				.to.be.revertedWithCustomError(executionContext, "IncompleteInstantOpen")
				.withArgs(1)
			expect(await context.viewFacetQuote.getNextQuoteId()).to.equal(0n)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(accountAddress)).to.equal(before)
			await diamond.executeBatch([op], [sig], [[]], [[]])
			expect((await context.viewFacetQuote.getQuote(1n)).quoteStatus).to.equal(QuoteStatus.PENDING)
		})

		it("requires the designated filler to authorize the actual injected result", async function () {
			const target = await (await ethers.getContractFactory("MockInstantTarget")).deploy()
			await diamond.setTargetWhitelist(await target.getAddress(), true)
			await diamond.addTemplate("signed pipeline word", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
				{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
			])
			const id = (await diamond.getNextTemplateId()) - 1n
			const source = createSignedOperation({
				signer: partyAAddress,
				target: context.accountLayerDiamond,
				callData: context.alViewFacet.interface.encodeFunctionData("ownerOf", [accountAddress]),
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 0n,
				deadline,
			})
			const store = createSignedOperation({
				signer: partyAAddress,
				target: await target.getAddress(),
				callData: target.interface.encodeFunctionData("store", [0]),
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 0n,
				deadline,
			})
			const filler = context.signers.hedger2
			store.flexFields = [{ offset: 0, length: 32, authorizedFlexFiller: filler.address }]
			const sigs = [await partyA.signTypedData(domain, cloneTypes(), source), await partyA.signTypedData(domain, cloneTypes(), store)]
			const message = {
				opHash: await diamond.getOperationHash(store),
				fieldIndex: 0,
				value: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [partyAAddress]),
			}
			const wrong = await filler.signTypedData(domain, FLEX_FILLER_AUTH_TYPES, { ...message, value: ethers.toBeHex(7, 32) })
			await expect(diamond.executeTemplate(id, [source, store], sigs, [[], ["0x"]], [[], [wrong]])).to.be.revertedWithCustomError(
				diamond,
				"UnauthorizedTemplateInsertion",
			)
			const approval = await filler.signTypedData(domain, FLEX_FILLER_AUTH_TYPES, message)
			await diamond.executeTemplate(id, [source, store], sigs, [[], ["0x"]], [[], [approval]])
			expect(await target.lastValue()).to.equal(BigInt(partyAAddress))
		})

		it("rejects an ordinary pending quote entering an atomic bookkeeping shortcut", async function () {
			const send = createSignedOperation({
				signer: partyAAddress,
				target: context.diamond,
				callData: quoteCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 0n,
				deadline,
			})
			await diamond.executeBatch([send], [await partyA.signTypedData(domain, cloneTypes(), send)], [[]], [[]])
			await diamond.addTemplate("ordinary quote in atomic scope", [{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }])
			const id = (await diamond.getNextTemplateId()) - 1n
			await diamond.setTemplateInstantOpenMode(id, true)
			const lock = createSignedOperation({
				signer: partyBHelperAddress,
				target: context.diamond,
				callData: context.partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [1n, await getDummySingleUpnlSig(10n)]),
				signerAccount: { addr: partyBHelperAddress, isPartyB: true },
				nonce: 0n,
				deadline,
			})
			const reason = new ethers.Interface(["error InvalidInstantOpenQuote(uint256 quoteId)"]).encodeErrorResult("InvalidInstantOpenQuote", [1n])
			await expect(diamond.executeTemplate(id, [lock], [await partyB.signTypedData(domain, cloneTypes(), lock)], [[]], [[]]))
				.to.be.revertedWithCustomError(diamond, "OperationFailed")
				.withArgs(0n, reason)
			expect((await context.viewFacetQuote.getQuote(1n)).quoteStatus).to.equal(QuoteStatus.PENDING)
		})

		it("invalidates old delegations on transfer, including when ownership later returns", async function () {
			const delegate = context.signers.hedger2
			const withdraw = context.accountFacet.interface.getFunction("withdrawTo")!.selector
			await context.alTimelockFacet.connect(partyA).setupTimelocks(accountAddress, partyAAddress, 300, [withdraw])
			const selector = context.viewFacet.interface.getFunction("balanceOf")!.selector
			const grant = {
				account: { addr: accountAddress, isPartyB: false },
				delegatedSigner: delegate.address,
				selectors: [selector],
				expiryTimestamp: deadline,
			}
			await diamond.connect(partyA).grantDelegation(grant)
			expect(await diamond.isDelegationActive(accountAddress, delegate.address, selector)).to.equal(true)
			const op = createSignedOperation({
				signer: delegate.address,
				target: context.diamond,
				callData: context.viewFacet.interface.encodeFunctionData("balanceOf", [accountAddress]),
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 0n,
				deadline,
			})
			const sig = await delegate.signTypedData(domain, cloneTypes(), op)
			await context.alCoreFacet.connect(partyA).transferSubAccountOwnership(accountAddress, context.signers.user2.address)
			expect((await context.alViewFacet.getSelectorTimelock(accountAddress, withdraw)).unlocker).to.equal(partyAAddress)
			expect(await context.alViewFacet.getAccountOwnershipEpoch(accountAddress)).to.equal(1n)
			expect(await diamond.isDelegationActive(accountAddress, delegate.address, selector)).to.equal(false)
			await expect(diamond.executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(diamond, "InvalidDelegation")
			await context.alCoreFacet.connect(context.signers.user2).transferSubAccountOwnership(accountAddress, partyAAddress)
			expect(await diamond.isDelegationActive(accountAddress, delegate.address, selector)).to.equal(false)
			await diamond.connect(partyA).grantDelegation(grant)
			expect(await diamond.isDelegationActive(accountAddress, delegate.address, selector)).to.equal(true)
			await diamond.executeBatch([op], [sig], [[]], [[]])
		})
		// What would have to break for this to fail: _insertResults never writing the injected
		// quote id into op2's calldata, or template gating (active flag / operation-count check)
		// letting a mismatched op array through. The placeholder quote id below is deliberately
		// wrong (999999, which does not exist) rather than the real value (1) — the real id only
		// reaches lockQuote if _insertResults actually overwrites the placeholder with op1's
		// result. A placeholder that already happened to equal the real id would pass this test
		// whether or not injection ran at all.
		it("executes a template with one result injection: sendQuote -> lockQuote", async function () {
			const lockQuoteCallData = context.partyBQuoteActionsFacet.interface.encodeFunctionData("lockQuote", [999999, await getDummySingleUpnlSig(10n)])

			await diamond.connect(admin).addTemplate("basicTemplate", [
				{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] },
				{ insertionPoints: [0], sourceIndices: [0], sourceOffsets: [0] },
			])
			const templateId = (await diamond.getNextTemplateId()) - 1n

			const op1 = createSignedOperation({
				signer: partyAAddress,
				target: context.diamond,
				callData: quoteCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 1n,
				deadline,
			})
			const op2 = createSignedOperation({
				signer: partyBHelperAddress,
				target: context.diamond,
				callData: lockQuoteCallData,
				signerAccount: { addr: partyBHelperAddress, isPartyB: true },
				nonce: 1n,
				deadline,
			})
			op2.flexFields = [{ offset: 0, length: 32, authorizedFlexFiller: adminAddress }]

			const sig1 = await partyA.signTypedData(domain, cloneTypes(), op1)
			const sig2 = await partyB.signTypedData(domain, cloneTypes(), op2)

			await expect(diamond.connect(admin).executeTemplate(templateId, [op1, op2], [sig1, sig2], [[], ["0x"]], [[], ["0x"]])).to.not.be.reverted

			const quote = await context.viewFacetQuote.getQuote(1)
			expect(quote.quoteStatus).to.equal(QuoteStatus.LOCKED)
		})
	})

	describe("AccountLayer signer lifecycle", function () {
		// What would have to break for this to fail: dropping
		// `IAccountLayerDiamond(accountLayer).setTransientSigner(address(0))` at the end of
		// _executeOperationSafe's AccountLayer branch. Op1 installs partyA as the AccountLayer's
		// transient signer; if that clear is skipped, op2's install attempt finds the signer slot
		// still occupied and the AccountLayer's own guard (ControlFacet._installTransientSigner)
		// reverts "ControlFacet: Transient signer is set" — a failure that only two
		// AccountLayer-routed operations in the same call can trigger, which is exactly why every
		// other test in this suite (at most one AccountLayer-routed op per call) never exercises it.
		it("routes two AccountLayer operations in one batch, each clearing the transient signer for the next", async function () {
			const op1 = createSignedOperation({
				signer: partyAAddress,
				target: context.diamond,
				callData: quoteCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 1n,
				deadline,
			})
			const op2 = createSignedOperation({
				signer: partyAAddress,
				target: context.diamond,
				callData: quoteCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 2n,
				deadline,
			})
			const sig1 = await partyA.signTypedData(domain, cloneTypes(), op1)
			const sig2 = await partyA.signTypedData(domain, cloneTypes(), op2)

			await expect(diamond.connect(admin).executeBatch([op1, op2], [sig1, sig2], [[], []], [[], []])).to.not.be.reverted

			const quote1 = await context.viewFacetQuote.getQuote(1)
			const quote2 = await context.viewFacetQuote.getQuote(2)
			expect(quote1.partyA).to.equal(accountAddress)
			expect(quote2.partyA).to.equal(accountAddress)
		})
	})

	describe("delegation-driven execution", function () {
		let delegate: Signer
		let delegateAddress: string

		beforeEach(async function () {
			delegate = context.signers.user2
			delegateAddress = await delegate.getAddress()
		})

		// What would have to break for this to fail: LibInstantLayerDelegation.requireAuthorized never
		// consulting isDelegationActive for a non-owner signer, or grantDelegation never
		// actually writing the grant. Every other operation in this suite is signed by the account
		// owner directly, so this is the only place execution — as opposed to DelegationFacet's own
		// grant/revoke suite, which never calls executeBatch — consults an active delegation to
		// authorize a call.
		it("executes an operation signed by a delegate holding an active grant for that selector", async function () {
			const selector = quoteCallData.slice(0, 10)
			await diamond.connect(partyA).grantDelegation({
				account: { addr: accountAddress, isPartyB: false },
				delegatedSigner: delegateAddress,
				selectors: [selector],
				expiryTimestamp: await getBlockTimestamp(3600n),
			})

			const op = createSignedOperation({
				signer: delegateAddress,
				target: context.diamond,
				callData: quoteCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 1n,
				deadline,
			})
			const sig = await delegate.signTypedData(domain, cloneTypes(), op)

			await expect(diamond.connect(admin).executeBatch([op], [sig], [[]], [[]])).to.not.be.reverted

			const quote = await context.viewFacetQuote.getQuote(1)
			expect(quote.partyA).to.equal(accountAddress)
		})

		// What would have to break for this to fail: the delegation check being skipped or always
		// passing — the mirror image of the test above, with no grantDelegation call at all.
		it("reverts InvalidDelegation for a delegate signature with no matching grant", async function () {
			const op = createSignedOperation({
				signer: delegateAddress,
				target: context.diamond,
				callData: quoteCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 1n,
				deadline,
			})
			const sig = await delegate.signTypedData(domain, cloneTypes(), op)

			await expect(diamond.connect(admin).executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(diamond, "InvalidDelegation")
		})
	})

	describe("core execution-context lifecycle", function () {
		// What would have to break for this to fail: dropping `symmio.endInstantLayerExecution()`
		// at the end of executeBatch. Both calls below are separate top-level calls (not nested —
		// each returns before the next starts), issued from one wrapper contract so they share the
		// core diamond's EIP-1153 execution-context slot within one transaction. If the first
		// call's close is skipped, the second call's own beginInstantLayerExecution finds the slot
		// still marked active and core reverts TransientContextAlreadyActive. Two separate
		// JSON-RPC transactions could never observe this — transient storage clears at transaction
		// end regardless of whether the close ran — which is why this needs a wrapper contract
		// rather than two `it`-level calls.
		it("closes the core execution context after each of two sequential executeBatch calls in one transaction", async function () {
			const SeqProbeFactory = await ethers.getContractFactory(
				"contracts/instantLayer/test/InstantLayerSequentialExecutionProbe.sol:InstantLayerSequentialExecutionProbe",
			)
			const seqProbe = await SeqProbeFactory.connect(admin).deploy()
			await seqProbe.waitForDeployment()
			const seqProbeAddress = await seqProbe.getAddress()

			await diamond.connect(admin).setTargetWhitelist(seqProbeAddress, true)
			await diamond.connect(admin).grantRole(ROLES.DIAMOND_OPERATOR_ROLE, seqProbeAddress)

			const noopCallData = seqProbe.interface.encodeFunctionData("noop")
			const op1 = createSignedOperation({
				signer: partyAAddress,
				target: seqProbeAddress,
				callData: noopCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 1n,
				deadline,
			})
			const op2 = createSignedOperation({
				signer: partyAAddress,
				target: seqProbeAddress,
				callData: noopCallData,
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 2n,
				deadline,
			})
			const sig1 = await partyA.signTypedData(domain, cloneTypes(), op1)
			const sig2 = await partyA.signTypedData(domain, cloneTypes(), op2)

			await expect(seqProbe.connect(admin).runTwice(deployment.address, [op1], [sig1], [[]], [[]], [op2], [sig2], [[]], [[]])).to.not.be.reverted
		})
	})

	// Asserts the guard's own error, since core's transient-context guard also blocks the nested call for an unrelated reason.
	describe("reentrancy guard", function () {
		it("rejects a batched operation that re-enters executeBatch, specifically via the guard's own error", async function () {
			const ProbeFactory = await ethers.getContractFactory("contracts/instantLayer/test/InstantLayerReentrancyProbe.sol:InstantLayerReentrancyProbe")
			const probe = await ProbeFactory.connect(admin).deploy()
			await probe.waitForDeployment()
			const probeAddress = await probe.getAddress()

			await diamond.connect(admin).setTargetWhitelist(probeAddress, true)

			// admin's own sub-account: signer == msg.sender == account owner, so this operation
			// needs neither a delegation grant nor a signature to verify — the only thing under
			// test is what happens when its target calls back into executeBatch.
			await context.accountManager.connect(admin).addAccount("reentrancyProbeAccount")
			const adminAccounts = await context.accountManager.getAccounts(adminAddress, 0, 100)
			const adminAccountAddress = findAccountByName(adminAccounts, "reentrancyProbeAccount")

			const op = createSignedOperation({
				signer: adminAddress,
				target: probeAddress,
				callData: probe.interface.encodeFunctionData("reenter", [deployment.address]),
				signerAccount: { addr: adminAccountAddress, isPartyB: false },
				nonce: 0n,
				deadline: 0n,
			})

			const reentrancySelector = diamond.interface.getError("ReentrancyGuardReentrantCall")!.selector

			// A plain `.to.be.reverted` would stay green even with the guard disabled, because the
			// core diamond independently refuses a nested beginInstantLayerExecution call
			// (TransientContextAlreadyActive) — a different guard, at a different layer, that would
			// mask InstantLayerReentrancyGuard having done nothing at all. Pinning the exact wrapped
			// selector is what actually isolates this diamond's own guard.
			await expect(diamond.connect(admin).executeBatch([op], ["0x"], [[]], [[]]))
				.to.be.revertedWithCustomError(diamond, "OperationFailed")
				.withArgs(0n, reentrancySelector)
		})
	})

	describe("grant operations", function () {
		const SELECTOR = "0x12345678"
		let delegateAddress: string

		beforeEach(async function () {
			delegateAddress = await context.signers.user2.getAddress()
		})

		const grantCallData = async () =>
			diamond.interface.encodeFunctionData("grantDelegation", [
				{
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: delegateAddress,
					selectors: [SELECTOR],
					expiryTimestamp: await getBlockTimestamp(3600n),
				},
			])

		it("applies an owner-signed grant that targets the diamond", async function () {
			const op = createSignedOperation({
				signer: partyAAddress,
				target: deployment.address,
				callData: await grantCallData(),
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 0n,
				deadline,
			})
			const sig = await partyA.signTypedData(domain, cloneTypes(), op)
			await diamond.connect(admin).executeBatch([op], [sig], [[]], [[]])
			expect(await diamond.isDelegationActive(accountAddress, delegateAddress, SELECTOR)).to.equal(true)
		})

		it("rejects any other selector that targets the diamond", async function () {
			const op = createSignedOperation({
				signer: partyAAddress,
				target: deployment.address,
				callData: diamond.interface.encodeFunctionData("setRevocationCooldown", [600]),
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 0n,
				deadline,
			})
			const sig = await partyA.signTypedData(domain, cloneTypes(), op)
			await expect(diamond.connect(admin).executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(diamond, "InvalidGrantOperation")
		})

		it("rejects a grant operation whose maxUses is not 1", async function () {
			const op = createSignedOperation({
				signer: partyAAddress,
				target: deployment.address,
				callData: await grantCallData(),
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 0n,
				deadline,
				maxUses: 2,
			})
			const sig = await partyA.signTypedData(domain, cloneTypes(), op)
			await expect(diamond.connect(admin).executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(diamond, "InvalidGrantOperation")
		})

		it("treats a facet's own address as an ordinary target, not as the layer", async function () {
			const op = createSignedOperation({
				signer: partyAAddress,
				target: deployment.facetAddresses.DelegationFacet,
				callData: await grantCallData(),
				signerAccount: { addr: accountAddress, isPartyB: false },
				nonce: 0n,
				deadline,
			})
			const sig = await partyA.signTypedData(domain, cloneTypes(), op)
			await expect(diamond.connect(admin).executeBatch([op], [sig], [[]], [[]]))
				.to.be.revertedWithCustomError(diamond, "TargetNotWhitelisted")
				.withArgs(deployment.facetAddresses.DelegationFacet)
		})
	})
})
