import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs"
import { expect } from "chai"
import { Contract, Signer, TypedDataDomain, ZeroAddress } from "ethers"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { DELEGATE_TYPES } from "../helpers/instantLayerEIP712Types.js"
import { loadFixture, time } from "../helpers/network-helpers.js"
import { RunContext } from "../models/RunContext.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "../utils/Common.js"
import { InstantLayerDiamondDeployment, deployInstantLayerDiamondForTest } from "../utils/InstantLayerDiamond.js"

const REVOKER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REVOKER_ROLE"))
const SELECTOR = "0x12345678"
const DEFAULT_EXPIRY_OFFSET = 3600n
const REVOCATION_COOLDOWN = 600 // seconds — the Init default (10 minutes)
const POSITION = 0 // SubAccountIsolationType.POSITION / VirtualAccountIsolationType.POSITION

describe("InstantLayer diamond delegation", function () {
	let context: RunContext
	let admin: Signer
	let owner: Signer
	let delegate: Signer
	let stranger: Signer
	let ownerAddress: string
	let delegateAddress: string
	let strangerAddress: string
	let deployment: InstantLayerDiamondDeployment
	let diamond: Contract
	let domain: TypedDataDomain
	let accountAddress: string

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		admin = context.signers.admin
		owner = context.signers.user
		delegate = context.signers.user2
		stranger = context.signers.others[0]

		ownerAddress = await owner.getAddress()
		delegateAddress = await delegate.getAddress()
		strangerAddress = await stranger.getAddress()

		deployment = await deployInstantLayerDiamondForTest(ethers, admin, context.diamond, ["ControlFacet", "ViewFacet", "DelegationFacet"])
		diamond = deployment.diamond

		// The real AccountLayer, so ownerOf/getVirtualAccount resolve against live sub-accounts
		// instead of the zero address every InstantLayer view otherwise falls back to.
		await diamond.connect(admin).setAccountLayer(context.accountLayerDiamond)

		domain = {
			name: "SymmioInstantLayer",
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
			verifyingContract: deployment.address,
		}

		await context.accountManager.connect(owner).addAccount("delegationTestAccount")
		const accounts = await context.accountManager.getAccounts(ownerAddress, 0, 100)
		accountAddress = accounts[0].accountAddress
	})

	describe("grantDelegation", function () {
		it("owner grants directly; delegations() and isDelegationActive reflect the exact expiry", async function () {
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)

			await expect(
				diamond.connect(owner).grantDelegation({
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: delegateAddress,
					selectors: [SELECTOR],
					expiryTimestamp: expiry,
				}),
			)
				.to.emit(diamond, "DelegationGranted")
				.withArgs(accountAddress, delegateAddress, SELECTOR, expiry)

			expect(await diamond.delegations(accountAddress, delegateAddress, SELECTOR)).to.equal(expiry)
			expect(await diamond.isDelegationActive(accountAddress, delegateAddress, SELECTOR)).to.equal(true)
		})

		it("reverts NotOwnerOfAccount when the caller does not own the account", async function () {
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)

			await expect(
				diamond.connect(stranger).grantDelegation({
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: delegateAddress,
					selectors: [SELECTOR],
					expiryTimestamp: expiry,
				}),
			).to.be.revertedWithCustomError(diamond, "NotOwnerOfAccount")
		})

		// Negative control (brief Step 3): with the `delegate == address(0)` clause removed from
		// _validateDelegation, this test stops reverting with InvalidDelegation. Restoring the
		// clause turns it green again — both runs are transcribed in the fix-round section of the
		// task's report, kept outside the committed tree.
		it("reverts InvalidDelegation for an empty selector list", async function () {
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)

			await expect(
				diamond.connect(owner).grantDelegation({
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: delegateAddress,
					selectors: [],
					expiryTimestamp: expiry,
				}),
			).to.be.revertedWithCustomError(diamond, "InvalidDelegation")
		})

		it("reverts InvalidDelegation for a PartyB account", async function () {
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)

			await expect(
				diamond.connect(owner).grantDelegation({
					account: { addr: accountAddress, isPartyB: true },
					delegatedSigner: delegateAddress,
					selectors: [SELECTOR],
					expiryTimestamp: expiry,
				}),
			).to.be.revertedWithCustomError(diamond, "InvalidDelegation")
		})

		it("reverts SelfDelegation when delegating to the owner", async function () {
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)

			await expect(
				diamond.connect(owner).grantDelegation({
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: ownerAddress,
					selectors: [SELECTOR],
					expiryTimestamp: expiry,
				}),
			).to.be.revertedWithCustomError(diamond, "SelfDelegation")
		})
	})

	describe("grantBatchDelegationBySig", function () {
		it("grants delegation via a signature over the diamond's own EIP-712 domain", async function () {
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)
			const deadline = (await getBlockTimestamp()) + 600n

			const signedDelegation = {
				delegationInfo: {
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: delegateAddress,
					selectors: [SELECTOR],
					expiryTimestamp: expiry,
				},
				replayAttackHeader: { nonce: 1n, deadline, salt: ethers.hexlify(ethers.randomBytes(32)) },
			}

			const sig = await owner.signTypedData(domain, DELEGATE_TYPES, signedDelegation)

			// A relayer (stranger), not the owner, submits the transaction — the authority comes
			// from the signature, not from msg.sender.
			await expect(diamond.connect(stranger).grantBatchDelegationBySig(signedDelegation, sig))
				.to.emit(diamond, "DelegationGranted")
				.withArgs(accountAddress, delegateAddress, SELECTOR, expiry)

			expect(await diamond.delegations(accountAddress, delegateAddress, SELECTOR)).to.equal(expiry)
			expect(await diamond.delegationNonces(accountAddress)).to.equal(1n)
		})

		it("reverts InvalidSignature when someone other than the account owner signs", async function () {
			// Negative control: with the isValidSignatureNow check removed from
			// grantBatchDelegationBySig, this test stops reverting — the delegation gets written
			// under a fraudulent signature. Restoring the check turns it green again. See the
			// fix-round section of the task's report (outside the committed tree) for both runs.
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)
			const deadline = (await getBlockTimestamp()) + 600n

			const signedDelegation = {
				delegationInfo: {
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: delegateAddress,
					selectors: [SELECTOR],
					expiryTimestamp: expiry,
				},
				replayAttackHeader: { nonce: 1n, deadline, salt: ethers.hexlify(ethers.randomBytes(32)) },
			}

			// Signed by the delegate, not accountAddress's owner — isValidSignatureNow(owner, ...) must fail.
			const sig = await delegate.signTypedData(domain, DELEGATE_TYPES, signedDelegation)

			await expect(diamond.grantBatchDelegationBySig(signedDelegation, sig)).to.be.revertedWithCustomError(diamond, "InvalidSignature")
		})

		it("enforces sequential delegationNonces", async function () {
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)
			const deadline = (await getBlockTimestamp()) + 600n

			const signedDelegation = {
				delegationInfo: {
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: delegateAddress,
					selectors: [SELECTOR],
					expiryTimestamp: expiry,
				},
				// delegationNonces(accountAddress) starts at 0, so the first valid nonce is 1, not 5.
				replayAttackHeader: { nonce: 5n, deadline, salt: ethers.hexlify(ethers.randomBytes(32)) },
			}

			const sig = await owner.signTypedData(domain, DELEGATE_TYPES, signedDelegation)

			await expect(diamond.grantBatchDelegationBySig(signedDelegation, sig)).to.be.revertedWithCustomError(diamond, "InvalidNonce")
		})

		it("rejects a byte-for-byte resubmission of an already-executed signed delegation with the same canonical delegator", async function () {
			// The delegation nonce is embedded in the EIP-712 hash and enforced strictly
			// sequentially, so replaying the identical (signedDelegation, signature) pair against
			// the same canonical delegator is caught by the nonce check before
			// usedDelegationHashes is ever consulted — this lands on InvalidNonce, not
			// DelegationAlreadyExecuted. The "virtual-account canonicalization" suite below covers
			// the case where the canonical delegator itself changes between the two submissions,
			// which is what actually reaches DelegationAlreadyExecuted.
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)
			const deadline = (await getBlockTimestamp()) + 600n

			const signedDelegation = {
				delegationInfo: {
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: delegateAddress,
					selectors: [SELECTOR],
					expiryTimestamp: expiry,
				},
				replayAttackHeader: { nonce: 1n, deadline, salt: ethers.hexlify(ethers.randomBytes(32)) },
			}

			const sig = await owner.signTypedData(domain, DELEGATE_TYPES, signedDelegation)

			await diamond.grantBatchDelegationBySig(signedDelegation, sig)

			await expect(diamond.grantBatchDelegationBySig(signedDelegation, sig)).to.be.revertedWithCustomError(diamond, "InvalidNonce")
		})

		it("reverts DeadlineExpired when the replay header deadline has passed", async function () {
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)
			const deadline = await getBlockTimestamp(-1000n)

			const signedDelegation = {
				delegationInfo: {
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: delegateAddress,
					selectors: [SELECTOR],
					expiryTimestamp: expiry,
				},
				replayAttackHeader: { nonce: 1n, deadline, salt: ethers.hexlify(ethers.randomBytes(32)) },
			}

			const sig = await owner.signTypedData(domain, DELEGATE_TYPES, signedDelegation)

			await expect(diamond.grantBatchDelegationBySig(signedDelegation, sig)).to.be.revertedWithCustomError(diamond, "DeadlineExpired")
		})

		it("treats a zero replay header deadline as no expiry", async function () {
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)

			const signedDelegation = {
				delegationInfo: {
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: delegateAddress,
					selectors: [SELECTOR],
					expiryTimestamp: expiry,
				},
				replayAttackHeader: { nonce: 1n, deadline: 0n, salt: ethers.hexlify(ethers.randomBytes(32)) },
			}

			const sig = await owner.signTypedData(domain, DELEGATE_TYPES, signedDelegation)

			await expect(diamond.grantBatchDelegationBySig(signedDelegation, sig)).to.not.be.reverted
			expect(await diamond.delegations(accountAddress, delegateAddress, SELECTOR)).to.equal(expiry)
		})
	})

	describe("revocation", function () {
		let expiry: bigint

		beforeEach(async function () {
			expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)
			await diamond.connect(owner).grantDelegation({
				account: { addr: accountAddress, isPartyB: false },
				delegatedSigner: delegateAddress,
				selectors: [SELECTOR],
				expiryTimestamp: expiry,
			})
		})

		describe("initiateRevokeDelegation authorization", function () {
			it("allows the account owner to schedule a revocation", async function () {
				await expect(diamond.connect(owner).initiateRevokeDelegation({ addr: accountAddress, isPartyB: false }, delegateAddress, [SELECTOR]))
					.to.emit(diamond, "RevocationScheduled")
					.withArgs(accountAddress, delegateAddress, SELECTOR, anyValue)
			})

			it("allows the delegate to schedule its own revocation", async function () {
				await expect(diamond.connect(delegate).initiateRevokeDelegation({ addr: accountAddress, isPartyB: false }, delegateAddress, [SELECTOR]))
					.to.emit(diamond, "RevocationScheduled")
					.withArgs(accountAddress, delegateAddress, SELECTOR, anyValue)
			})

			it("allows a REVOKER_ROLE holder to schedule a revocation", async function () {
				await diamond.connect(admin).grantRole(REVOKER_ROLE, strangerAddress)

				await expect(diamond.connect(stranger).initiateRevokeDelegation({ addr: accountAddress, isPartyB: false }, delegateAddress, [SELECTOR]))
					.to.emit(diamond, "RevocationScheduled")
					.withArgs(accountAddress, delegateAddress, SELECTOR, anyValue)
			})

			it("reverts NotOwnerOfAccount for an unrelated caller", async function () {
				await expect(
					diamond.connect(stranger).initiateRevokeDelegation({ addr: accountAddress, isPartyB: false }, delegateAddress, [SELECTOR]),
				).to.be.revertedWithCustomError(diamond, "NotOwnerOfAccount")
			})
		})

		// Negative control: temporarily neutering the `block.timestamp < eta` check in
		// DelegationFacet.finalizeRevokeDelegation makes the "before cooldown" test below stop
		// reverting; restoring it turns it green again (transcribed in the fix-round section of
		// the task's report, outside the committed tree). Without advancing time in the "after
		// cooldown" test, both tests would pass against a finalize that never enforces the
		// cooldown at all — advancing time is what makes this suite actually pin the cooldown.
		describe("finalizeRevokeDelegation cooldown", function () {
			it("reverts RevocationCooldownNotOver before the cooldown elapses", async function () {
				await diamond.connect(owner).initiateRevokeDelegation({ addr: accountAddress, isPartyB: false }, delegateAddress, [SELECTOR])

				await expect(
					diamond.connect(stranger).finalizeRevokeDelegation({ addr: accountAddress, isPartyB: false }, delegateAddress, [SELECTOR]),
				).to.be.revertedWithCustomError(diamond, "RevocationCooldownNotOver")
			})

			it("succeeds after the cooldown elapses, flips isDelegationActive false, and is callable by anyone", async function () {
				expect(await diamond.isDelegationActive(accountAddress, delegateAddress, SELECTOR)).to.equal(true)

				await diamond.connect(owner).initiateRevokeDelegation({ addr: accountAddress, isPartyB: false }, delegateAddress, [SELECTOR])
				await time.increase(REVOCATION_COOLDOWN)

				// finalizeRevokeDelegation has no caller restriction: "anyone may call once ETA has
				// passed" per the monolith, so a stranger with no relation to the account succeeds.
				await expect(diamond.connect(stranger).finalizeRevokeDelegation({ addr: accountAddress, isPartyB: false }, delegateAddress, [SELECTOR]))
					.to.emit(diamond, "DelegationSelectorRevoked")
					.withArgs(accountAddress, delegateAddress, SELECTOR)

				expect(await diamond.isDelegationActive(accountAddress, delegateAddress, SELECTOR)).to.equal(false)
				expect(await diamond.delegations(accountAddress, delegateAddress, SELECTOR)).to.equal(0)
				expect(await diamond.pendingRevocationEta(accountAddress, delegateAddress, SELECTOR)).to.equal(0)
			})

			it("reads the cooldown from storage rather than a hardcoded default", async function () {
				// A hardcoded 600 in finalizeRevokeDelegation would pass every other test in this
				// file, since none of them ever change the cooldown away from the Init default.
				// Raise it here and prove a duration between the old and new values still reverts.
				const EXTENDED_COOLDOWN = REVOCATION_COOLDOWN * 3
				await diamond.connect(admin).setRevocationCooldown(EXTENDED_COOLDOWN)

				await diamond.connect(owner).initiateRevokeDelegation({ addr: accountAddress, isPartyB: false }, delegateAddress, [SELECTOR])

				// Past the old 600s default, short of the new (1800s) cooldown.
				await time.increase(REVOCATION_COOLDOWN + 100)
				await expect(
					diamond.connect(stranger).finalizeRevokeDelegation({ addr: accountAddress, isPartyB: false }, delegateAddress, [SELECTOR]),
				).to.be.revertedWithCustomError(diamond, "RevocationCooldownNotOver")

				await time.increase(EXTENDED_COOLDOWN)
				await expect(
					diamond.connect(stranger).finalizeRevokeDelegation({ addr: accountAddress, isPartyB: false }, delegateAddress, [SELECTOR]),
				).to.emit(diamond, "DelegationSelectorRevoked")
			})
		})
	})

	// Covers the shared LibInstantLayerAccount.canonicalDelegator/getAccountOwner helper through
	// a genuinely live virtual account, and the one path that reaches DelegationAlreadyExecuted:
	// virtual-account deletion changes what a raw address canonicalizes to without changing the
	// EIP-712 hash a prior signed delegation used, which is keyed off the raw address.
	describe("virtual-account canonicalization", function () {
		let positionSubAccount: string
		let virtualAccountAddress: string

		beforeEach(async function () {
			// The system hook: core calls back into the AccountLayer diamond on quote lifecycle
			// events (onCancelQuote, onClosePosition, ...), which is what lets a virtual account's
			// deletion actually fire. initializeFixture never wires this on its own — it is an
			// opt-in step every suite that needs live VA deletion (e.g. AccountLayer.behavior.ts)
			// takes explicitly.
			await context.controlFacet.connect(admin).registerHook(ZeroAddress, context.accountLayerDiamond)

			const affiliate = await context.accountManager.getAddress()
			const creationData = [{ name: "va-canon", metadata: "0x", symmioCore: context.diamond, isolationType: POSITION, singleVAMode: false }]
			const predicted = await context.alCoreFacet.connect(owner).createSubAccounts.staticCall(affiliate, creationData)
			await context.alCoreFacet.connect(owner).createSubAccounts(affiliate, creationData)
			positionSubAccount = predicted[0]

			await context.collateral.connect(owner).mint(ownerAddress, decimal(100000n))
			await context.collateral.connect(owner).approve(context.diamond, ethers.MaxUint256)
			await context.accountFacet.connect(owner).depositFor(positionSubAccount, decimal(10000n))
			await context.alMarginFacet.connect(owner).addMarginToNextVA(positionSubAccount, POSITION, 1, decimal(1000n))

			const request = limitQuoteRequestBuilder().build()
			const quoteCallData = context.partyAFacet.interface.encodeFunctionData("sendQuoteWithAffiliate", [
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
			await context.alCoreFacet.connect(owner)._call(positionSubAccount, [quoteCallData])
			;[virtualAccountAddress] = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(positionSubAccount, 0, 10)

			expect((await context.alViewFacet.getVirtualAccount(virtualAccountAddress)).isExists).to.equal(true)
			expect((await context.alViewFacet.getVirtualAccount(virtualAccountAddress)).parentAccount).to.equal(positionSubAccount)
		})

		it("getActiveDelegations resolves a live virtual-account delegator to its parent sub-account", async function () {
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)

			await diamond.connect(owner).grantDelegation({
				account: { addr: virtualAccountAddress, isPartyB: false },
				delegatedSigner: delegateAddress,
				selectors: [SELECTOR],
				expiryTimestamp: expiry,
			})

			// Written under the canonical parent, not the raw virtual-account address.
			expect(await diamond.delegations(positionSubAccount, delegateAddress, SELECTOR)).to.equal(expiry)
			expect(await diamond.delegations(virtualAccountAddress, delegateAddress, SELECTOR)).to.equal(0)

			const active = await diamond.getActiveDelegations({ addr: virtualAccountAddress, isPartyB: false }, [delegateAddress], [[SELECTOR]])
			expect(active.length).to.equal(1)
			expect(active[0].account.addr).to.equal(virtualAccountAddress)
			expect(active[0].delegatedSigner).to.equal(delegateAddress)
			expect(active[0].selectors).to.deep.equal([SELECTOR])
			expect(active[0].expiryTimestamp).to.equal(expiry)
		})

		it("resubmitting a signed delegation after its virtual account is deleted reverts DelegationAlreadyExecuted, not InvalidNonce", async function () {
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)
			const deadline = (await getBlockTimestamp()) + 600n

			const signedDelegation = {
				delegationInfo: {
					account: { addr: virtualAccountAddress, isPartyB: false },
					delegatedSigner: delegateAddress,
					selectors: [SELECTOR],
					expiryTimestamp: expiry,
				},
				replayAttackHeader: { nonce: 1n, deadline, salt: ethers.hexlify(ethers.randomBytes(32)) },
			}
			const sig = await owner.signTypedData(domain, DELEGATE_TYPES, signedDelegation)

			// First submission: the VA is live, so canonicalDelegator(VA) == positionSubAccount.
			// nonce 1 is valid against delegationNonces(positionSubAccount) == 0.
			await diamond.grantBatchDelegationBySig(signedDelegation, sig)
			expect(await diamond.delegations(positionSubAccount, delegateAddress, SELECTOR)).to.equal(expiry)
			expect(await diamond.delegationNonces(positionSubAccount)).to.equal(1n)
			expect(await diamond.delegationNonces(virtualAccountAddress)).to.equal(0n)

			// Delete the VA by cancelling its only quote — a routine lifecycle event, not an
			// exotic state. isExists flips false; parentAccount is left populated.
			const [quoteId] = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
			const cancelCallData = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])
			await context.alCoreFacet.connect(owner)._call(virtualAccountAddress, [cancelCallData])
			expect((await context.alViewFacet.getVirtualAccount(virtualAccountAddress)).isExists).to.equal(false)

			// Resubmitting the byte-for-byte identical (signedDelegation, signature): canonicalDelegator
			// now returns the VA's own address (no longer "exists"), so the nonce check reads a fresh
			// counter (delegationNonces(virtualAccountAddress) == 0) and nonce 1 passes again.
			// resolveAccountOwner still returns the same owner (it keys off parentAccount, not
			// isExists), so the signature still verifies against the same hash — and that hash was
			// already marked used.
			await expect(diamond.grantBatchDelegationBySig(signedDelegation, sig)).to.be.revertedWithCustomError(diamond, "DelegationAlreadyExecuted")
		})
	})

	describe("accountLayer not configured", function () {
		it("reverts AccountLayerNotSet when the diamond was never pointed at an AccountLayer", async function () {
			const freshDeployment = await deployInstantLayerDiamondForTest(ethers, admin, context.diamond, ["ControlFacet", "ViewFacet", "DelegationFacet"])
			const freshDiamond = freshDeployment.diamond
			const expiry = await getBlockTimestamp(DEFAULT_EXPIRY_OFFSET)

			await expect(
				freshDiamond.connect(owner).grantDelegation({
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: delegateAddress,
					selectors: [SELECTOR],
					expiryTimestamp: expiry,
				}),
			).to.be.revertedWithCustomError(freshDiamond, "AccountLayerNotSet")
		})
	})
})
