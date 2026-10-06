import { expect } from "chai"
import { toUtf8Bytes, TypedDataDomain, ZeroAddress } from "ethers"

import type { InstantLayer } from "../src/types/index.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { cloneTypes } from "./helpers/instantLayerEIP712Types.js"
import { loadFixture } from "./helpers/network-helpers.js"
import { Hedger } from "./models/Hedger.js"
import { User } from "./models/User.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "./utils/Common.js"

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const ROLES = {
	SETTER_ROLE: ethers.keccak256(toUtf8Bytes("SETTER_ROLE")),
	OPERATOR_ROLE: ethers.keccak256(toUtf8Bytes("OPERATOR_ROLE")),
	INSTANT_LAYER_ROLE: ethers.keccak256(toUtf8Bytes("INSTANT_LAYER_ROLE")),
}

const SEND_QUOTE_WITH_AFFILIATE_SIGNATURE =
	"sendQuoteWithAffiliate(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,(bytes,uint256,int256,uint256,bytes,(uint256,address,address)))"

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

async function createDomain(instantLayerAddress: string): Promise<TypedDataDomain> {
	return {
		name: "SymmioInstantLayer",
		version: "1",
		chainId: (await ethers.provider.getNetwork()).chainId,
		verifyingContract: instantLayerAddress,
	}
}

function generateSalt(): string {
	return ethers.hexlify(ethers.randomBytes(32))
}

function createSignedOperation(
	signer: string,
	target: string,
	callData: string,
	signerAccount: InstantLayer.AccountStruct,
	nonce: bigint,
	deadline: bigint,
): InstantLayer.SignedOperationStruct {
	return {
		signer,
		target,
		callData,
		signerAccount,
		flexFields: [],
		maxUses: 1,
		replayAttackHeader: { nonce, deadline, salt: generateSalt() },
	}
}

async function signOperation(
	signer: any,
	domain: TypedDataDomain,
	types: ReturnType<typeof cloneTypes>,
	op: InstantLayer.SignedOperationStruct,
): Promise<string> {
	return signer.signTypedData(domain, types, op)
}

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════

export function shouldBehaveLikeInstantLayerSecurity(): void {
	it("should block attacker from operating on victim's account via direct accountLayer target", async function () {
		// 1. SETUP
		const context = await loadFixture(initializeFixture)

		const victim = new User(context, context.signers.user)
		const alice = new User(context, context.signers.user2)
		const hedger = new Hedger(context, context.signers.hedger)

		await Promise.all([victim.setup(), alice.setup(), hedger.setup()])

		await victim.setBalances(decimal(100000n), decimal(5000n), decimal(2000n))
		await alice.setBalances(decimal(100000n), decimal(5000n))

		// Grant INSTANT_LAYER_ROLE on Diamond (for setCallFromInstantLayer)
		await context.controlFacet.grantRole(context.instantLayer, ROLES.INSTANT_LAYER_ROLE)

		await context.controlFacet.connect(context.signers.admin).registerPartyB(await context.symmioPartyB.getAddress())
		await context.controlFacet.connect(context.signers.admin).setPartyBBindable(await context.symmioPartyB.getAddress(), true)

		await context.instantLayer.setAccountLayer(context.accountLayerDiamond)
		await context.instantLayer.registerPartyBs([await context.symmioPartyB.getAddress()])

		// 2. VICTIM: Create account with funds
		await context.accountManager.connect(victim.signer).addAccount("victimAccount")
		const victimAccounts = await context.accountManager.getAccounts(victim.address, 0, 100)
		const victimAccount = victimAccounts[0].accountAddress

		const depositAmountCollateral = 1000n * 10n ** BigInt(await context.collateral.decimals())
		await context.collateral.connect(victim.signer).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(victim.signer).depositFor(victimAccount, depositAmountCollateral)

		// 3. ATTACKER: Create alice's account
		await context.accountManager.connect(alice.signer).addAccount("aliceAccount")
		const aliceAccounts = await context.accountManager.getAccounts(alice.address, 0, 100)
		const aliceAccount = aliceAccounts[0].accountAddress

		// 4. RECORD BALANCES BEFORE ATTACK
		const victimBalanceBefore = await context.viewFacet.balanceOf(victimAccount)
		expect(victimBalanceBefore).to.be.gt(0n)

		// 5. CONSTRUCT ATTACK
		const accountLayerAddress = context.accountLayerDiamond
		const deadline = await getBlockTimestamp(300n)

		// Encode withdrawTo(alice.address, amount) as inner call
		const withdrawToCallData = context.accountFacet.interface.encodeFunctionData("withdrawTo", [alice.address, depositAmountCollateral])

		// Encode _call(victimAccount, [withdrawToCallData]) — targets the VICTIM's account
		const maliciousCallData = context.alCoreFacet.interface.encodeFunctionData("_call", [victimAccount, [withdrawToCallData]])

		// signerAccount = aliceAccount (passes ownership check), but callData targets victimAccount
		const attackOp = createSignedOperation(
			alice.address,
			accountLayerAddress,
			maliciousCallData,
			{ addr: aliceAccount, isPartyB: false },
			1n,
			deadline,
		)

		const domain = await createDomain(await context.instantLayer.getAddress())
		const types = cloneTypes()
		const sig = await signOperation(alice.signer, domain, types, attackOp)

		// 6. EXECUTE ATTACK — should REVERT because setSigner sets alice's EOA,
		//    and onlyAccountOwner(victimAccount) checks ownership against alice's EOA → fails
		await expect(context.instantLayer.executeBatch([attackOp], [sig], [[]], [[]])).to.be.reverted

		// 7. VERIFY: Victim's funds are intact
		const victimBalanceAfter = await context.viewFacet.balanceOf(victimAccount)
		expect(victimBalanceAfter).to.equal(victimBalanceBefore)
	})

	it("should allow legitimate accountLayer calls through InstantLayer", async function () {
		// 1. SETUP
		const context = await loadFixture(initializeFixture)

		const user = new User(context, context.signers.user)
		const hedger = new Hedger(context, context.signers.hedger)

		await Promise.all([user.setup(), hedger.setup()])
		await user.setBalances(decimal(100000n), decimal(5000n), decimal(2000n))

		await context.controlFacet.grantRole(context.instantLayer, ROLES.INSTANT_LAYER_ROLE)
		await context.controlFacet.connect(context.signers.admin).registerPartyB(await context.symmioPartyB.getAddress())
		await context.controlFacet.connect(context.signers.admin).setPartyBBindable(await context.symmioPartyB.getAddress(), true)

		await context.instantLayer.setAccountLayer(context.accountLayerDiamond)
		await context.instantLayer.registerPartyBs([await context.symmioPartyB.getAddress()])

		// 2. USER: Create account with funds
		await context.accountManager.connect(user.signer).addAccount("myAccount")
		const accounts = await context.accountManager.getAccounts(user.address, 0, 100)
		const userAccount = accounts[0].accountAddress

		const depositAmountCollateral = 500n * 10n ** BigInt(await context.collateral.decimals())
		await context.collateral.connect(user.signer).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(user.signer).depositFor(userAccount, depositAmountCollateral)

		const balanceBefore = await context.viewFacet.balanceOf(userAccount)
		expect(balanceBefore).to.be.gt(0n)

		// 3. CONSTRUCT LEGITIMATE OPERATION: user targets their own account
		const accountLayerAddress = context.accountLayerDiamond
		const deadline = await getBlockTimestamp(300n)

		// Encode withdrawTo(user.address, smallAmount) as inner call
		const smallWithdrawAmount = 100n * 10n ** BigInt(await context.collateral.decimals())
		const withdrawToCallData = context.accountFacet.interface.encodeFunctionData("withdrawTo", [user.address, smallWithdrawAmount])

		// Encode _call(userAccount, [withdrawToCallData]) — targets user's OWN account
		const callData = context.alCoreFacet.interface.encodeFunctionData("_call", [userAccount, [withdrawToCallData]])

		const op = createSignedOperation(user.address, accountLayerAddress, callData, { addr: userAccount, isPartyB: false }, 1n, deadline)

		const domain = await createDomain(await context.instantLayer.getAddress())
		const types = cloneTypes()
		const sig = await signOperation(user.signer, domain, types, op)

		// 4. EXECUTE — should succeed because setSigner sets user's EOA,
		//    and onlyAccountOwner(userAccount) verifies user owns userAccount
		await context.instantLayer.executeBatch([op], [sig], [[]], [[]])

		// 5. VERIFY: Balance decreased
		const balanceAfter = await context.viewFacet.balanceOf(userAccount)
		expect(balanceAfter).to.be.lt(balanceBefore)
	})

	// ═══════════════════════════════════════════════════════════════════
	// DELEGATION ACCOUNT SCOPE
	//
	// A delegation is granted over one sub-account, but the AccountLayer signer InstantLayer installs
	// is the account OWNER. Ownership alone authorizes every sub-account that owner holds, so without
	// an explicit scope a delegate can reach the delegator's siblings.
	// ═══════════════════════════════════════════════════════════════════

	describe("Delegated call account scope", function () {
		// Sets up an owner holding two sub-accounts, and a delegate granted one selector over the first.
		async function setupDelegation(selectorName: string) {
			const context = await loadFixture(initializeFixture)
			const owner = new User(context, context.signers.user)
			const delegate = new User(context, context.signers.user2)

			await Promise.all([owner.setup(), delegate.setup()])
			await context.controlFacet.grantRole(context.instantLayer, ROLES.INSTANT_LAYER_ROLE)
			await context.instantLayer.setAccountLayer(context.accountLayerDiamond)

			await context.accountManager.connect(owner.signer).addAccount("delegatedAccount")
			await context.accountManager.connect(owner.signer).addAccount("siblingAccount")
			const ownerAccounts = await context.accountManager.getAccounts(owner.address, 0, 100)
			const delegatedAccount = ownerAccounts[0].accountAddress
			const siblingAccount = ownerAccounts[1].accountAddress

			const deadline = await getBlockTimestamp(300n)
			const selector = context.alCoreFacet.interface.getFunction(selectorName)!.selector
			await context.instantLayer.connect(owner.signer).grantDelegation({
				account: { addr: delegatedAccount, isPartyB: false },
				delegatedSigner: delegate.address,
				selectors: [selector],
				expiryTimestamp: deadline,
			})

			return { context, owner, delegate, delegatedAccount, siblingAccount, deadline }
		}

		async function buildOp(context: any, signerAddr: string, signer: any, callData: string, account: string, deadline: bigint) {
			const op = createSignedOperation(signerAddr, context.accountLayerDiamond, callData, { addr: account, isPartyB: false }, 1n, deadline)
			const sig = await signOperation(signer, await createDomain(await context.instantLayer.getAddress()), cloneTypes(), op)
			return { op, sig }
		}

		it("Should reject a delegated call that targets a sibling of the delegated account", async function () {
			const { context, owner, delegate, delegatedAccount, siblingAccount, deadline } = await setupDelegation("transferSubAccountOwnership")

			// Delegation covers `delegatedAccount`, but the call names the sibling.
			const callData = context.alCoreFacet.interface.encodeFunctionData("transferSubAccountOwnership", [siblingAccount, delegate.address])
			const { op, sig } = await buildOp(context, delegate.address, delegate.signer, callData, delegatedAccount, deadline)

			await expect(context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(context.instantLayer, "OperationFailed")

			// The sibling is untouched, and the failure is specifically the scope check rather than
			// some unrelated revert that would make this test pass for the wrong reason.
			expect(await context.alViewFacet.ownerOf(siblingAccount)).to.equal(owner.address)

			const reason = await context.instantLayer.executeBatch.staticCall([op], [sig], [[]], [[]]).catch((e: any) => e)
			const decoded = context.instantLayer.interface.parseError(reason.data)
			expect(decoded?.name).to.equal("OperationFailed")
			const inner = context.alCoreFacet.interface.parseError(decoded!.args[1])
			expect(inner?.name).to.equal("AccountOutOfScope")
			expect(inner!.args[0]).to.equal(delegatedAccount)
			expect(inner!.args[1]).to.equal(siblingAccount)
		})

		it("Should allow a delegated call that targets the delegated account itself", async function () {
			const { context, delegate, delegatedAccount, deadline } = await setupDelegation("editAccountName")

			const callData = context.alCoreFacet.interface.encodeFunctionData("editAccountName", [delegatedAccount, "renamed"])
			const { op, sig } = await buildOp(context, delegate.address, delegate.signer, callData, delegatedAccount, deadline)

			await expect(context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.not.be.reverted
			expect((await context.alViewFacet.getSubAccount(delegatedAccount)).name).to.equal("renamed")
		})

		it("Should leave the owner's own multi-account access unscoped", async function () {
			const { context, owner, siblingAccount, deadline } = await setupDelegation("editAccountName")

			// The owner is not a delegate, so no scope is installed and they may still act on any
			// account they hold -- including one that was never named in a delegation.
			const callData = context.alCoreFacet.interface.encodeFunctionData("editAccountName", [siblingAccount, "ownerRenamed"])
			const { op, sig } = await buildOp(context, owner.address, owner.signer, callData, siblingAccount, deadline)

			await expect(context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.not.be.reverted
			expect((await context.alViewFacet.getSubAccount(siblingAccount)).name).to.equal("ownerRenamed")
		})

		it("Should clear the scope after execution so it cannot leak into the next caller", async function () {
			const { context, owner, delegate, delegatedAccount, siblingAccount, deadline } = await setupDelegation("editAccountName")

			const callData = context.alCoreFacet.interface.encodeFunctionData("editAccountName", [delegatedAccount, "renamed"])
			const { op, sig } = await buildOp(context, delegate.address, delegate.signer, callData, delegatedAccount, deadline)
			await context.instantLayer.executeBatch([op], [sig], [[]], [[]])

			expect(await context.alViewFacet.getSignerScope()).to.equal(ethers.ZeroAddress)

			// A direct owner call on the sibling would revert if the delegate's scope had persisted.
			await expect(context.alCoreFacet.connect(owner.signer).editAccountName(siblingAccount, "stillWorks")).to.not.be.reverted
		})

		// A scope holds the canonical sub-account, so it must cover that account's Virtual Accounts too.
		// AccountLayer functions cross that boundary on purpose -- addMargin is gated on the VA but moves
		// collateral out of the parent -- so a scope pinned to the named account alone would break them.
		describe("Virtual accounts under the delegated sub-account", function () {
			async function setupCustomVA(name: string, owner: User, context: any) {
				await context.alCoreFacet
					.connect(owner.signer)
					.createSubAccounts(await context.accountManager.getAddress(), [
						{ name, metadata: "0x", symmioCore: context.diamond, isolationType: 3, singleVAMode: false },
					])
				const subAccounts = await context.alViewFacet.getUserSubAccountsAddresses(owner.address, 0, 100)
				const parent = subAccounts[subAccounts.length - 1]
				await context.alCoreFacet.connect(owner.signer).createCustomVirtualAccount(parent, "0x", 1, 1)
				const vas = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(parent, 0, 10)
				return { parent, va: vas[vas.length - 1] }
			}

			it("Should allow a delegated call on a virtual account of the delegated sub-account", async function () {
				const context = await loadFixture(initializeFixture)
				const owner = new User(context, context.signers.user)
				const delegate = new User(context, context.signers.user2)
				await Promise.all([owner.setup(), delegate.setup()])
				await owner.setBalances(decimal(10000n))
				await context.controlFacet.grantRole(context.instantLayer, ROLES.INSTANT_LAYER_ROLE)
				await context.instantLayer.setAccountLayer(context.accountLayerDiamond)

				const { parent, va } = await setupCustomVA("customParent", owner, context)

				// Fund the parent so addMargin has something to move into the VA.
				const amount = 100n * 10n ** BigInt(await context.collateral.decimals())
				await context.collateral.connect(owner.signer).approve(context.diamond, ethers.MaxUint256)
				await context.accountFacet.connect(owner.signer).depositFor(parent, amount)

				// The grant is on the parent; the delegate acts on the VA.
				const deadline = await getBlockTimestamp(300n)
				await context.instantLayer.connect(owner.signer).grantDelegation({
					account: { addr: parent, isPartyB: false },
					delegatedSigner: delegate.address,
					selectors: [context.alMarginFacet.interface.getFunction("addMargin")!.selector],
					expiryTimestamp: deadline,
				})

				const callData = context.alMarginFacet.interface.encodeFunctionData("addMargin", [va, decimal(50n)])
				const op = createSignedOperation(delegate.address, context.accountLayerDiamond, callData, { addr: va, isPartyB: false }, 1n, deadline)
				const sig = await signOperation(delegate.signer, await createDomain(await context.instantLayer.getAddress()), cloneTypes(), op)

				await expect(context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.not.be.reverted
				expect(await context.viewFacet.allocatedBalanceOfPartyA(va)).to.equal(decimal(50n))
			})

			it("Should reject a delegated call on a virtual account of a different sub-account", async function () {
				const context = await loadFixture(initializeFixture)
				const owner = new User(context, context.signers.user)
				const delegate = new User(context, context.signers.user2)
				await Promise.all([owner.setup(), delegate.setup()])
				await owner.setBalances(decimal(10000n))
				await context.controlFacet.grantRole(context.instantLayer, ROLES.INSTANT_LAYER_ROLE)
				await context.instantLayer.setAccountLayer(context.accountLayerDiamond)

				const granted = await setupCustomVA("grantedParent", owner, context)
				const other = await setupCustomVA("otherParent", owner, context)

				const amount = 100n * 10n ** BigInt(await context.collateral.decimals())
				await context.collateral.connect(owner.signer).approve(context.diamond, ethers.MaxUint256)
				await context.accountFacet.connect(owner.signer).depositFor(granted.parent, amount)

				const deadline = await getBlockTimestamp(300n)
				await context.instantLayer.connect(owner.signer).grantDelegation({
					account: { addr: granted.parent, isPartyB: false },
					delegatedSigner: delegate.address,
					selectors: [context.alMarginFacet.interface.getFunction("addMargin")!.selector],
					expiryTimestamp: deadline,
				})

				// Named account is inside the grant, so the delegation check passes; the call data is not.
				const callData = context.alMarginFacet.interface.encodeFunctionData("addMargin", [other.va, decimal(50n)])
				const op = createSignedOperation(
					delegate.address,
					context.accountLayerDiamond,
					callData,
					{ addr: granted.parent, isPartyB: false },
					1n,
					deadline,
				)
				const sig = await signOperation(delegate.signer, await createDomain(await context.instantLayer.getAddress()), cloneTypes(), op)

				const reason = await context.instantLayer.executeBatch.staticCall([op], [sig], [[]], [[]]).catch((e: any) => e)
				const decoded = context.instantLayer.interface.parseError(reason.data)
				expect(decoded?.name).to.equal("OperationFailed")
				const inner = context.alCoreFacet.interface.parseError(decoded!.args[1])
				expect(inner?.name).to.equal("AccountOutOfScope")
				expect(inner!.args[0]).to.equal(granted.parent)
				expect(inner!.args[1]).to.equal(other.va)
				expect(await context.viewFacet.allocatedBalanceOfPartyA(other.va)).to.equal(0n)
			})
		})

		// The scope is a storage slot that stays set for the whole call tree, so anything Symmio calls
		// back into the AccountLayer runs while it is active. Hook entry points are gated by onlySymmio
		// rather than onlyAccountOwner, so they should be unaffected -- this drives one to prove it.
		it("Should let a Symmio hook re-enter the AccountLayer inside a delegated scope", async function () {
			const context = await loadFixture(initializeFixture)
			const owner = new User(context, context.signers.user)
			const delegate = new User(context, context.signers.user2)
			const hedger = new Hedger(context, context.signers.hedger)
			await Promise.all([owner.setup(), delegate.setup(), hedger.setup()])
			await owner.setBalances(decimal(10000n), decimal(5000n), decimal(2000n))
			await hedger.setBalances(decimal(10000n), decimal(10000n))

			await context.controlFacet.grantRole(context.instantLayer, ROLES.INSTANT_LAYER_ROLE)
			await context.instantLayer.setAccountLayer(context.accountLayerDiamond)
			// Route Symmio's system hook back into the AccountLayer so onCancelQuote actually fires.
			await context.controlFacet.registerHook(ZeroAddress, context.accountLayerDiamond)

			// MARKET isolation creates a Virtual Account when the quote is sent.
			await context.alCoreFacet
				.connect(owner.signer)
				.createSubAccounts(await context.accountManager.getAddress(), [
					{ name: "hookParent", metadata: "0x", symmioCore: context.diamond, isolationType: 1, singleVAMode: false },
				])
			const parent = (await context.alViewFacet.getUserSubAccountsAddresses(owner.address, 0, 100))[0]
			await context.collateral.connect(owner.signer).approve(context.diamond, ethers.MaxUint256)
			await context.accountFacet.connect(owner.signer).depositFor(parent, decimal(3000n))

			const quoteRequest = limitQuoteRequestBuilder().build()
			await context.alMarginFacet.connect(owner.signer).addMarginToNextVA(parent, 1, quoteRequest.symbolId, decimal(500n))
			const sendQuoteCallData = context.partyAFacet.interface.encodeFunctionData(SEND_QUOTE_WITH_AFFILIATE_SIGNATURE, [
				quoteRequest.partyBWhiteList,
				quoteRequest.symbolId,
				quoteRequest.positionType,
				quoteRequest.orderType,
				quoteRequest.price,
				quoteRequest.quantity,
				quoteRequest.cva,
				quoteRequest.lf,
				quoteRequest.partyAmm,
				quoteRequest.partyBmm,
				quoteRequest.maxFundingRate,
				await quoteRequest.deadline,
				ZeroAddress,
				await quoteRequest.upnlSig,
			])
			await context.alCoreFacet.connect(owner.signer)._call(parent, [sendQuoteCallData])

			const va = (await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(parent, 0, 10))[0]
			const trackedBefore = await context.alViewFacet.getVirtualAccountQuoteIds(va, 0, 10)
			expect(trackedBefore.length).to.equal(1)

			// Delegate cancels through the VA. Scope resolves to the parent, and the cancel makes Symmio
			// call onCancelQuote back into the AccountLayer while that scope is still set.
			const deadline = await getBlockTimestamp(300n)
			await context.instantLayer.connect(owner.signer).grantDelegation({
				account: { addr: parent, isPartyB: false },
				delegatedSigner: delegate.address,
				selectors: [context.partyAFacet.interface.getFunction("requestToCancelQuote")!.selector],
				expiryTimestamp: deadline,
			})

			const cancelCallData = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [trackedBefore[0]])
			const op = createSignedOperation(delegate.address, await context.diamond, cancelCallData, { addr: va, isPartyB: false }, 1n, deadline)
			const sig = await signOperation(delegate.signer, await createDomain(await context.instantLayer.getAddress()), cloneTypes(), op)

			await expect(context.instantLayer.executeBatch([op], [sig], [[]], [[]])).to.not.be.reverted

			// The hook ran to completion inside the scoped window: it is what untracks the quote.
			expect((await context.alViewFacet.getVirtualAccountQuoteIds(va, 0, 10)).length).to.equal(0)
			expect(await context.alViewFacet.getSignerScope()).to.equal(ZeroAddress)
		})
	})
}
