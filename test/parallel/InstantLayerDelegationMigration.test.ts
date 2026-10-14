import { expect } from "chai"
import { Contract, ZeroAddress, ZeroHash } from "ethers"

import { LEGACY_INSTANT_LAYER } from "../../scripts/utils/instantLayerMigrationRunner.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { cloneTypes } from "../helpers/instantLayerEIP712Types.js"
import { loadFixture, time } from "../helpers/network-helpers.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "../utils/Common.js"
import { deployInstantLayerDiamondForTest } from "../utils/InstantLayerDiamond.js"

const SELECTOR = "0x12345678"
const OTHER_SELECTOR = "0x87654321"
const MIGRATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MIGRATOR_ROLE"))

async function migrationFixture() {
	const context = await initializeFixture()
	const { admin, user: owner, user2: delegate } = context.signers
	const migrator = context.signers.others[0]
	const diamond = context.instantLayer as unknown as Contract
	await context.controlFacet.connect(admin).grantRole(await diamond.getAddress(), ethers.keccak256(ethers.toUtf8Bytes("INSTANT_LAYER_ROLE")))
	await diamond.connect(admin).setAccountLayer(context.accountLayerDiamond)
	await diamond.connect(admin).grantRole(MIGRATOR_ROLE, migrator.address)
	const Legacy = new ethers.ContractFactory(LEGACY_INSTANT_LAYER.abi, LEGACY_INSTANT_LAYER.bytecode, admin)
	const source = (await Legacy.deploy(context.diamond, admin.address)) as unknown as Contract
	await source.waitForDeployment()
	await source.setAccountLayer(context.accountLayerDiamond)
	await context.accountManager.connect(owner).addAccount("migrationAccount")
	const accounts = await context.accountManager.getAccounts(owner.address, 0, 100)
	const account = accounts.find(entry => entry.name === "migrationAccount")!.accountAddress
	return { context, admin, owner, delegate, migrator, diamond, source, account }
}

describe("InstantLayer delegation migration", function () {
	let fixture: Awaited<ReturnType<typeof migrationFixture>>
	let source: Contract
	let diamond: Contract
	let account: string
	let sourceAddress: string
	let delegateAddress: string
	let expiry: number

	beforeEach(async function () {
		fixture = await loadFixture(migrationFixture)
		;({ source, diamond, account } = fixture)
		sourceAddress = await source.getAddress()
		delegateAddress = fixture.delegate.address
		expiry = (await time.latest()) + 86_400
	})

	const entry = (account: string, delegate: string, selectors = [SELECTOR]) => ({ account, delegate, selectors })
	const accountInfo = (addr: string) => ({ addr, isPartyB: false })
	const advanceTo = async (timestamp: bigint | number) => time.increase(Number(timestamp) - (await time.latest()))

	async function grant(layer = source, selectors = [SELECTOR], expiration = expiry, delegator = account, delegate = delegateAddress) {
		await layer.connect(fixture.owner).grantDelegation({
			account: accountInfo(delegator),
			delegatedSigner: delegate,
			selectors,
			expiryTimestamp: expiration,
		})
	}

	async function migrate(entries = [entry(account, delegateAddress)], oldLayer = sourceAddress) {
		return diamond.connect(fixture.migrator).migrateDelegations(oldLayer, entries)
	}

	it("does not resurrect legacy grants after an account ownership transfer", async function () {
		await grant()
		await fixture.context.alCoreFacet.connect(fixture.owner).transferSubAccountOwnership(account, fixture.context.signers.hedger.address)
		expect(await source.delegations(account, delegateAddress, SELECTOR)).to.equal(expiry)
		expect(await diamond.connect(fixture.migrator).migrateDelegations.staticCall(sourceAddress, [entry(account, delegateAddress)])).to.equal(0n)
		await migrate()
		expect(await diamond.isDelegationActive(account, delegateAddress, SELECTOR)).to.equal(false)
	})

	it("requires an explicit MIGRATOR_ROLE grant, and revoking it removes access", async function () {
		expect(await diamond.MIGRATOR_ROLE()).to.equal(MIGRATOR_ROLE)
		expect(await diamond.hasRole(MIGRATOR_ROLE, fixture.admin.address)).to.equal(false)
		for (const signer of [fixture.admin, fixture.owner, fixture.delegate]) {
			await expect(diamond.connect(signer).migrateDelegations(sourceAddress, [entry(account, delegateAddress)])).to.be.revertedWithCustomError(
				diamond,
				"MustHaveRole",
			)
		}
		await diamond.connect(fixture.admin).revokeRole(MIGRATOR_ROLE, fixture.migrator.address)
		await expect(migrate()).to.be.revertedWithCustomError(diamond, "MustHaveRole")
	})

	it("copies selected legacy grants with exact per-selector expiries and provenance events", async function () {
		await grant(source, [SELECTOR], expiry)
		await grant(source, [OTHER_SELECTOR], expiry + 3600)
		await grant(source, [SELECTOR], expiry + 7200, account, fixture.migrator.address)
		const entries = [entry(account, delegateAddress, [SELECTOR, OTHER_SELECTOR]), entry(account, fixture.migrator.address)]
		expect(await diamond.connect(fixture.migrator).migrateDelegations.staticCall(sourceAddress, entries)).to.equal(3n)
		await expect(migrate(entries))
			.to.emit(diamond, "DelegationMigrated")
			.withArgs(sourceAddress, account, delegateAddress, SELECTOR, expiry, 0)
			.and.to.emit(diamond, "DelegationGranted")
			.withArgs(account, delegateAddress, SELECTOR, expiry)
		expect(await diamond.delegations(account, delegateAddress, SELECTOR)).to.equal(expiry)
		expect(await diamond.delegations(account, delegateAddress, OTHER_SELECTOR)).to.equal(expiry + 3600)
		expect(await diamond.delegations(account, fixture.migrator.address, SELECTOR)).to.equal(expiry + 7200)
		expect(await diamond.isDelegationActive(account, delegateAddress, SELECTOR)).to.equal(true)
		expect(await source.delegations(account, delegateAddress, SELECTOR)).to.equal(expiry)
	})

	it("copies multiple accounts in one call and leaves unselected permissions untouched", async function () {
		await fixture.context.accountManager.connect(fixture.owner).addAccount("secondMigrationAccount")
		const accounts = await fixture.context.accountManager.getAccounts(fixture.owner.address, 0, 100)
		const second = accounts.find(item => item.name === "secondMigrationAccount")!.accountAddress
		await grant(source, [SELECTOR, OTHER_SELECTOR])
		await grant(source, [OTHER_SELECTOR], expiry + 500, second)
		await migrate([entry(account, delegateAddress), entry(second, delegateAddress, [OTHER_SELECTOR])])
		expect(await diamond.delegations(account, delegateAddress, OTHER_SELECTOR)).to.equal(0)
		expect(await diamond.delegations(second, delegateAddress, OTHER_SELECTOR)).to.equal(expiry + 500)
	})

	it("preserves a pending revocation ETA and becomes inactive when that original ETA arrives", async function () {
		await grant()
		await source.connect(fixture.owner).initiateRevokeDelegation(accountInfo(account), delegateAddress, [SELECTOR])
		const eta = await source.pendingRevocationEta(account, delegateAddress, SELECTOR)
		await expect(migrate()).to.emit(diamond, "RevocationScheduled").withArgs(account, delegateAddress, SELECTOR, eta)
		expect(await diamond.pendingRevocationEta(account, delegateAddress, SELECTOR)).to.equal(eta)
		expect(await diamond.isDelegationActive(account, delegateAddress, SELECTOR)).to.equal(true)
		await advanceTo(eta)
		expect(await diamond.isDelegationActive(account, delegateAddress, SELECTOR)).to.equal(false)
		await diamond.finalizeRevokeDelegation(accountInfo(account), delegateAddress, [SELECTOR])
		expect(await diamond.delegations(account, delegateAddress, SELECTOR)).to.equal(0)
	})

	it("skips missing, expired and effectively revoked source permissions", async function () {
		const shortExpiry = (await time.latest()) + 100
		await grant(source, [SELECTOR], shortExpiry)
		await grant(source, [OTHER_SELECTOR])
		await source.connect(fixture.owner).initiateRevokeDelegation(accountInfo(account), delegateAddress, [OTHER_SELECTOR])
		await advanceTo(await source.pendingRevocationEta(account, delegateAddress, OTHER_SELECTOR))
		const entries = [entry(account, delegateAddress, [SELECTOR, OTHER_SELECTOR, "0xaabbccdd"])]
		expect(await diamond.connect(fixture.migrator).migrateDelegations.staticCall(sourceAddress, entries)).to.equal(0)
		await expect(migrate(entries)).not.to.emit(diamond, "DelegationMigrated")
		for (const selector of entries[0].selectors) {
			expect(await diamond.delegations(account, delegateAddress, selector)).to.equal(0)
		}
	})

	it("allows duplicate selectors and repeated imports, refreshing permissions when the source changes", async function () {
		await grant()
		const entries = [entry(account, delegateAddress, [SELECTOR, SELECTOR]), entry(account, delegateAddress)]
		expect(await diamond.connect(fixture.migrator).migrateDelegations.staticCall(sourceAddress, entries)).to.equal(3)
		await migrate(entries)
		await migrate(entries)
		expect(await diamond.delegations(account, delegateAddress, SELECTOR)).to.equal(expiry)
		await grant(source, [SELECTOR], expiry + 10_000)
		expect(await diamond.connect(fixture.migrator).migrateDelegations.staticCall(sourceAddress, entries)).to.equal(3)
		await expect(migrate(entries))
			.to.emit(diamond, "DelegationMigrated")
			.withArgs(sourceAddress, account, delegateAddress, SELECTOR, expiry + 10_000, 0)
		expect(await diamond.delegations(account, delegateAddress, SELECTOR)).to.equal(expiry + 10_000)
	})

	it("merges several older instances and lets the last selected source overwrite overlapping keys", async function () {
		await grant(source, [SELECTOR, OTHER_SELECTOR])
		await migrate([entry(account, delegateAddress, [SELECTOR, OTHER_SELECTOR])])
		await diamond.connect(fixture.owner).initiateRevokeDelegation(accountInfo(account), delegateAddress, [SELECTOR])
		await advanceTo(await diamond.pendingRevocationEta(account, delegateAddress, SELECTOR))
		await diamond.finalizeRevokeDelegation(accountInfo(account), delegateAddress, [SELECTOR])
		// A different source can import the same key; the migrator chooses which grant to keep.
		const other = await deployInstantLayerDiamondForTest(ethers, fixture.admin, fixture.context.diamond, [
			"ControlFacet",
			"ViewFacet",
			"DelegationFacet",
		])
		await other.diamond.setAccountLayer(fixture.context.accountLayerDiamond)
		await grant(other.diamond, [SELECTOR], expiry + 2000)
		await migrate(undefined, other.address)
		expect(await diamond.delegations(account, delegateAddress, SELECTOR)).to.equal(expiry + 2000)
		expect(await diamond.delegations(account, delegateAddress, OTHER_SELECTOR)).to.equal(expiry)
		await migrate()
		expect(await diamond.delegations(account, delegateAddress, SELECTOR)).to.equal(expiry)
	})

	it("lets the trusted migrator overwrite local grants and clear local pending revocations", async function () {
		await grant()
		await grant(diamond, [SELECTOR], expiry - 3600)
		await diamond.connect(fixture.owner).initiateRevokeDelegation(accountInfo(account), delegateAddress, [SELECTOR])
		expect(await diamond.pendingRevocationEta(account, delegateAddress, SELECTOR)).to.not.equal(0)
		await expect(migrate()).to.emit(diamond, "DelegationMigrated").withArgs(sourceAddress, account, delegateAddress, SELECTOR, expiry, 0)
		expect(await diamond.delegations(account, delegateAddress, SELECTOR)).to.equal(expiry)
		expect(await diamond.pendingRevocationEta(account, delegateAddress, SELECTOR)).to.equal(0)
	})

	it("replaces expired destination grants with active source grants", async function () {
		await grant()
		await grant(diamond, [SELECTOR], (await time.latest()) + 10)
		await time.increase(20)
		await migrate()
		expect(await diamond.delegations(account, delegateAddress, SELECTOR)).to.equal(expiry)
		expect(await diamond.isDelegationActive(account, delegateAddress, SELECTOR)).to.equal(true)
	})

	it("lets the trusted migrator restore a locally revoked grant", async function () {
		await grant()
		await grant(diamond)
		await diamond.connect(fixture.owner).initiateRevokeDelegation(accountInfo(account), delegateAddress, [SELECTOR])
		await advanceTo(await diamond.pendingRevocationEta(account, delegateAddress, SELECTOR))
		await diamond.finalizeRevokeDelegation(accountInfo(account), delegateAddress, [SELECTOR])
		await migrate()
		expect(await diamond.delegations(account, delegateAddress, SELECTOR)).to.equal(expiry)
		expect(await diamond.isDelegationActive(account, delegateAddress, SELECTOR)).to.equal(true)
	})

	it("leaves existing destination permissions unchanged when the selected source entry is inactive", async function () {
		await grant(source, [SELECTOR], (await time.latest()) + 10)
		await grant(diamond)
		await time.increase(20)
		await migrate()
		expect(await diamond.delegations(account, delegateAddress, SELECTOR)).to.equal(expiry)
		expect(await diamond.isDelegationActive(account, delegateAddress, SELECTOR)).to.equal(true)
	})

	it("imports from an older diamond through the same getter interface", async function () {
		const old = await deployInstantLayerDiamondForTest(ethers, fixture.admin, fixture.context.diamond, [
			"ControlFacet",
			"ViewFacet",
			"DelegationFacet",
		])
		await old.diamond.setAccountLayer(fixture.context.accountLayerDiamond)
		await grant(old.diamond)
		await migrate(undefined, old.address)
		expect(await diamond.delegations(account, delegateAddress, SELECTOR)).to.equal(expiry)
	})

	it("rejects self, zero and EOA sources", async function () {
		for (const invalid of [await diamond.getAddress(), ZeroAddress, fixture.owner.address]) {
			await expect(migrate(undefined, invalid)).to.be.revertedWithCustomError(diamond, "InvalidMigrationSource").withArgs(invalid)
		}
	})

	it("rejects mismatched core and AccountLayer configurations and an unset destination AccountLayer", async function () {
		const wrongCore = await deployInstantLayerDiamondForTest(ethers, fixture.admin, fixture.owner.address, ["ControlFacet", "ViewFacet"])
		await wrongCore.diamond.setAccountLayer(fixture.context.accountLayerDiamond)
		await expect(migrate(undefined, wrongCore.address)).to.be.revertedWithCustomError(diamond, "InvalidMigrationSource")
		await source.setAccountLayer(fixture.owner.address)
		await expect(migrate()).to.be.revertedWithCustomError(diamond, "InvalidMigrationSource")
		const unset = await deployInstantLayerDiamondForTest(ethers, fixture.admin, fixture.context.diamond, [
			"ControlFacet",
			"ViewFacet",
			"MigrationFacet",
		])
		await unset.diamond.grantRole(MIGRATOR_ROLE, fixture.migrator.address)
		await expect(
			unset.diamond.connect(fixture.migrator).migrateDelegations(sourceAddress, [entry(account, delegateAddress)]),
		).to.be.revertedWithCustomError(unset.diamond, "AccountLayerNotSet")
	})

	it("rejects empty inputs and rolls back the whole batch on an invalid entry", async function () {
		await grant()
		await expect(migrate([])).to.be.revertedWithCustomError(diamond, "EmptyArray")
		await expect(migrate([entry(account, delegateAddress), entry(account, delegateAddress, [])])).to.be.revertedWithCustomError(
			diamond,
			"InvalidDelegation",
		)
		expect(await diamond.delegations(account, delegateAddress, SELECTOR)).to.equal(0)
	})

	it("keeps destination signature nonces and replay state independent of the old layer", async function () {
		const domain = {
			name: "SymmioInstantLayer",
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
			verifyingContract: sourceAddress,
		}
		const { DELEGATE_TYPES } = await import("../helpers/instantLayerEIP712Types.js")
		const signed = {
			delegationInfo: { account: accountInfo(account), delegatedSigner: delegateAddress, selectors: [SELECTOR], expiryTimestamp: expiry },
			replayAttackHeader: { nonce: 1, deadline: expiry, salt: ZeroHash },
		}
		const signature = await fixture.owner.signTypedData(domain, DELEGATE_TYPES, signed)
		await source.grantBatchDelegationBySig(signed, signature)
		expect(await source.delegationNonces(account)).to.equal(1)
		await migrate()
		expect(await diamond.delegationNonces(account)).to.equal(0)
		expect(await diamond.nonces(fixture.owner.address)).to.equal(0)
		expect(await diamond.usedDelegationHashes(await source.getDelegationHash(signed))).to.equal(false)
	})

	it("resolves a real virtual account to its parent delegation key", async function () {
		const { context, owner } = fixture
		const creation = [{ name: "migrationVA", metadata: "0x", symmioCore: context.diamond, isolationType: 0, singleVAMode: false }]
		const [parent] = await context.alCoreFacet.connect(owner).createSubAccounts.staticCall(await context.accountManager.getAddress(), creation)
		await context.alCoreFacet.connect(owner).createSubAccounts(await context.accountManager.getAddress(), creation)
		await context.collateral.connect(owner).mint(owner.address, decimal(100_000n))
		await context.collateral.connect(owner).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(owner).depositFor(parent, decimal(10_000n))
		await context.alMarginFacet.connect(owner).addMarginToNextVA(parent, 0, 1, decimal(1000n))
		const request = limitQuoteRequestBuilder().build()
		const calldata = context.partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
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
			ZeroAddress,
			await request.upnlSig,
		])
		await context.alCoreFacet.connect(owner)._call(parent, [calldata])
		const [virtual] = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(parent, 0, 10)
		expect((await context.alViewFacet.getVirtualAccount(virtual)).parentAccount).to.equal(parent)
		await grant(source, [SELECTOR], expiry, virtual)
		await migrate([entry(virtual, delegateAddress), entry(parent, delegateAddress)])
		expect(await diamond.delegations(parent, delegateAddress, SELECTOR)).to.equal(expiry)
		expect(await diamond.delegations(virtual, delegateAddress, SELECTOR)).to.equal(0)
	})

	it("authorizes signed execution on the new layer using the imported delegation", async function () {
		const target = await (await ethers.getContractFactory("MockInstantTarget")).deploy()
		const targetAddress = await target.getAddress()
		await diamond.setTargetWhitelist(targetAddress, true)
		const selector = target.interface.getFunction("store")!.selector
		const domain = {
			name: "SymmioInstantLayer",
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
			verifyingContract: await diamond.getAddress(),
		}
		const signed = {
			signer: delegateAddress,
			target: targetAddress,
			callData: target.interface.encodeFunctionData("store", [42]),
			signerAccount: accountInfo(account),
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 1, deadline: expiry, salt: ZeroHash },
		}
		const signature = await fixture.delegate.signTypedData(domain, cloneTypes(), signed)
		await expect(diamond.executeBatch([signed], [signature], [[]], [[]])).to.be.revertedWithCustomError(diamond, "InvalidDelegation")
		await grant(source, [selector])
		await migrate([entry(account, delegateAddress, [selector])])
		await diamond.executeBatch([signed], [signature], [[]], [[]])
		expect(await target.lastValue()).to.equal(42)
	})
})
