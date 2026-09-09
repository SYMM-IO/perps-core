import { expect } from "chai"
import { FunctionFragment, Interface, ParamType, TypedDataDomain, ZeroAddress, ZeroHash } from "ethers"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture, time } from "../helpers/network-helpers.js"
import { RunContext } from "../models/RunContext.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "../utils/Common.js"

const POSITION = 0
const DELAY = 300n
const MARGIN = decimal(1000n)
const GRACE = 600n

const APPROVAL_TYPES = {
	TimelockApproval: [
		{ name: "account", type: "address" },
		{ name: "unlocker", type: "address" },
		{ name: "callDataHash", type: "bytes32" },
		{ name: "deadline", type: "uint256" },
		{ name: "salt", type: "bytes32" },
	],
}

const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))

function selectorOf(iface: Interface, name: string): string {
	return iface.getFunction(name)!.selector
}

function randomSalt(): string {
	return ethers.hexlify(ethers.randomBytes(32))
}

describe("AccountLayer Timelock", function () {
	let context: RunContext
	let user: any
	let user2: any
	let unlocker: any
	let subAccount: string
	let accountLayer: string
	let domain: TypedDataDomain
	let view: any
	let control: any
	let internalTransferCd: string
	let allocateCd: string
	let quoteCallData: string
	let SEL: Record<string, string>

	// One unlocker's approval over an exact calldata, as executeTimelockOp takes it.
	async function signApproval(
		callDataHash: string,
		deadlineOffset = 60n,
		signer = unlocker,
		account = subAccount,
		unlockerAddress?: string,
	): Promise<{ approval: any; signature: string }> {
		const approval = {
			account,
			unlocker: unlockerAddress ?? signer.address,
			callDataHash,
			deadline: BigInt(await time.latest()) + deadlineOffset,
			salt: randomSalt(),
		}
		const signature = await signer.signTypedData(domain, APPROVAL_TYPES, approval)
		return { approval, signature }
	}

	async function grantSetter() {
		await context.alControlFacet.connect(context.signers.admin).grantRole(context.signers.admin.address, roleHash("SETTER_ROLE"))
	}

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		user = context.signers.user
		user2 = context.signers.user2
		unlocker = context.signers.hedger
		accountLayer = context.accountLayerDiamond
		view = context.alViewFacet
		control = context.alControlFacet
		const affiliate = await context.accountManager.getAddress()

		const creationData = [{ name: "tl", metadata: "0x", symmioCore: context.diamond, isolationType: POSITION, singleVAMode: false }]
		const predicted = await context.alCoreFacet.connect(user).createSubAccounts.staticCall(affiliate, creationData)
		await context.alCoreFacet.connect(user).createSubAccounts(affiliate, creationData)
		subAccount = predicted[0]

		await context.collateral.connect(user).mint(user.address, decimal(100000n))
		await context.collateral.connect(user).approve(context.diamond, ethers.MaxUint256)
		await context.accountFacet.connect(user).depositFor(subAccount, decimal(10000n))

		domain = {
			name: "SymmioAccountLayerTimelock",
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
			verifyingContract: accountLayer,
		}

		internalTransferCd = context.accountFacet.interface.encodeFunctionData("internalTransfer", [user2.address, decimal(10n)])
		allocateCd = context.accountFacet.interface.encodeFunctionData("allocate", [decimal(10n)])

		const request = limitQuoteRequestBuilder()
			.partyBWhiteList([await context.signers.hedger.getAddress()])
			.build()
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

		SEL = {
			internalTransfer: selectorOf(context.accountFacet.interface, "internalTransfer"),
			allocate: selectorOf(context.accountFacet.interface, "allocate"),
			requestToCancelQuote: selectorOf(context.partyAFacet.interface, "requestToCancelQuote"),
			addMarginToNextVA: selectorOf(context.alMarginFacet.interface, "addMarginToNextVA"),
			transferSubAccountOwnership: selectorOf(context.alCoreFacet.interface, "transferSubAccountOwnership"),
		}
	})

	describe("setupTimelocks", function () {
		it("is instant on a fresh account and records config and selectors", async function () {
			const tl = context.alTimelockFacet
			await expect(tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer]))
				.to.emit(tl, "TimelocksSetup")
				.withArgs(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
				.and.to.emit(tl, "TimelockNonceAdvanced")
				.withArgs(subAccount, 1n)

			const timelock = await view.getSelectorTimelock(subAccount, SEL.internalTransfer)
			expect(timelock.unlocker).to.equal(unlocker.address)
			expect(timelock.delay).to.equal(DELAY)
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(true)
			expect(await view.isTimelocked(subAccount, SEL.allocate)).to.equal(false)
			expect(await view.timelockNonce(subAccount)).to.equal(1n)
		})

		it("rejects a zero unlocker, a non-owner, and a delay above the maximum", async function () {
			const tl = context.alTimelockFacet
			await expect(tl.connect(user).setupTimelocks(subAccount, ZeroAddress, DELAY, [])).to.be.revertedWithCustomError(tl, "ZeroUnlocker")
			await expect(tl.connect(user).setupTimelocks(subAccount, unlocker.address, 31n * 24n * 3600n, [])).to.be.revertedWithCustomError(
				tl,
				"DelayAboveMaximum",
			)
			await expect(tl.connect(user2).setupTimelocks(subAccount, unlocker.address, DELAY, [])).to.be.revertedWithCustomError(tl, "NotOwner")
		})

		it("enforces the admin minimum delay", async function () {
			const tl = context.alTimelockFacet
			await grantSetter()
			await control.connect(context.signers.admin).setMinTimelockDelay(600n)
			expect(await view.minTimelockDelay()).to.equal(600n)
			await expect(tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [])).to.be.revertedWithCustomError(tl, "DelayBelowMinimum")
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, 600n, [])
		})

		it("adding selectors or raising the delay is instant, weakening is locked", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			// a fresh selector and a longer delay never weaken anything
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY + 1n, [SEL.allocate])
			expect(await view.isTimelocked(subAccount, SEL.allocate)).to.equal(true)

			await expect(tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY - 1n, [SEL.internalTransfer])).to.be.revertedWithCustomError(
				tl,
				"TimelockOpNotApprovedOrScheduled",
			)
			await expect(tl.connect(user).setupTimelocks(subAccount, user2.address, DELAY + 1n, [SEL.internalTransfer])).to.be.revertedWithCustomError(
				tl,
				"TimelockOpNotApprovedOrScheduled",
			)
		})

		it("bounds the admin setters to the maximum delay", async function () {
			await grantSetter()
			const admin = context.signers.admin
			await expect(control.connect(admin).setMinTimelockDelay(31n * 24n * 3600n)).to.be.revertedWithCustomError(control, "DelayAboveMaximum")
			await expect(control.connect(admin).setScheduleGracePeriod(31n * 24n * 3600n)).to.be.revertedWithCustomError(
				control,
				"ScheduleGracePeriodAboveMaximum",
			)
		})

		it("requires the setter role, accepts the exact maximum, and lets zero restore the default grace period", async function () {
			const maxDelay = 30n * 24n * 3600n
			await expect(control.connect(user).setMinTimelockDelay(maxDelay)).to.be.revertedWithCustomError(control, "MustHaveRole")
			await expect(control.connect(user).setScheduleGracePeriod(maxDelay)).to.be.revertedWithCustomError(control, "MustHaveRole")

			await grantSetter()
			const admin = context.signers.admin
			await expect(control.connect(admin).setMinTimelockDelay(maxDelay)).to.emit(control, "MinTimelockDelayUpdated").withArgs(maxDelay)
			await expect(control.connect(admin).setScheduleGracePeriod(maxDelay)).to.emit(control, "ScheduleGracePeriodUpdated").withArgs(maxDelay)
			expect(await view.minTimelockDelay()).to.equal(maxDelay)
			expect(await view.scheduleGracePeriod()).to.equal(maxDelay)

			await control.connect(admin).setScheduleGracePeriod(0)
			expect(await view.scheduleGracePeriod()).to.equal(GRACE)
		})

		it("allows configuration only on a root sub-account, never directly on its virtual accounts", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			await core.connect(user)._callWithMargin(subAccount, POSITION, 1, MARGIN, [quoteCallData])
			const va = (await context.viewFacetQuote.getQuote(1)).partyA

			await expect(tl.connect(user).setupTimelocks(va, unlocker.address, DELAY, [SEL.internalTransfer])).to.be.revertedWithCustomError(
				tl,
				"NotRootSubAccount",
			)
			await expect(tl.connect(user).clearTimelocks(va, [SEL.internalTransfer])).to.be.revertedWithCustomError(tl, "NotRootSubAccount")
		})
	})

	describe("clearTimelocks", function () {
		it("is locked while the timelock is active", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			await expect(tl.connect(user).clearTimelocks(subAccount, [SEL.internalTransfer])).to.be.revertedWithCustomError(
				tl,
				"TimelockOpNotApprovedOrScheduled",
			)
		})
	})

	describe("pause behavior", function () {
		it("blocks timelock mutations and rolls back wrapper approvals while paused", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			const clearCd = tl.interface.encodeFunctionData("clearTimelocks", [subAccount, [SEL.internalTransfer]])
			const clearHash = ethers.keccak256(clearCd)
			await tl.connect(user).scheduleTimelockOp(subAccount, clearHash)
			const signed = await signApproval(clearHash)
			const approvalHash = await view.hashTimelockApproval(signed.approval)
			await control.connect(context.signers.admin).pause()

			await expect(tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.allocate])).to.be.revertedWithCustomError(
				tl,
				"EnforcedPause",
			)
			await expect(tl.connect(user).clearTimelocks(subAccount, [SEL.internalTransfer])).to.be.revertedWithCustomError(tl, "EnforcedPause")
			await expect(tl.connect(user).scheduleTimelockOp(subAccount, ethers.keccak256(internalTransferCd))).to.be.revertedWithCustomError(
				tl,
				"EnforcedPause",
			)
			await expect(tl.connect(user).cancelTimelockOp(subAccount, clearHash)).to.be.revertedWithCustomError(tl, "EnforcedPause")
			await expect(tl.connect(user).executeTimelockOp([signed], clearCd)).to.be.revertedWithCustomError(tl, "EnforcedPause")

			expect(await view.isApprovalUsed(approvalHash)).to.equal(false)
			expect((await view.getSchedule(subAccount, clearHash)).scheduledAt).to.not.equal(0n)
		})
	})

	describe("scheduled timelock ops", function () {
		let transferHash: string

		beforeEach(async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			transferHash = ethers.keccak256(internalTransferCd)
		})

		it("opens a window after the delay; the direct call consumes it", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			await expect(tl.connect(user).scheduleTimelockOp(subAccount, transferHash)).to.emit(tl, "TimelockOpScheduled")
			await expect(core.connect(user)._call(subAccount, [internalTransferCd])).to.be.revertedWithCustomError(core, "ScheduleNotReady")

			await time.increase(Number(DELAY))
			await expect(core.connect(user)._call(subAccount, [internalTransferCd]))
				.to.emit(tl, "TimelockOpExecuted")
				.withArgs(subAccount, transferHash)

			// the schedule is single use
			expect((await view.getSchedule(subAccount, transferHash)).scheduledAt).to.equal(0n)
			await expect(core.connect(user)._call(subAccount, [internalTransferCd])).to.be.revertedWithCustomError(core, "TimelockOpNotApprovedOrScheduled")
		})

		it("executeTimelockOp with no approvals passes through to a matured window", async function () {
			const tl = context.alTimelockFacet
			const clearCd = tl.interface.encodeFunctionData("clearTimelocks", [subAccount, [SEL.internalTransfer]])
			await tl.connect(user).scheduleTimelockOp(subAccount, ethers.keccak256(clearCd))
			await time.increase(Number(DELAY))
			await tl.connect(user).executeTimelockOp([], clearCd)
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(false)
		})

		it("expires after the operation window", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			expect(await view.scheduleGracePeriod()).to.equal(GRACE)
			await tl.connect(user).scheduleTimelockOp(subAccount, transferHash)
			await time.increase(Number(DELAY + GRACE) + 1)
			await expect(core.connect(user)._call(subAccount, [internalTransferCd])).to.be.revertedWithCustomError(core, "ScheduleExpired")
		})

		it("includes the exact ready and expiry timestamps in the execution window", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			await tl.connect(user).scheduleTimelockOp(subAccount, transferHash)
			const first = await view.getSchedule(subAccount, transferHash)
			await time.setNextBlockTimestamp(first.scheduledAt + DELAY)
			await core.connect(user)._call(subAccount, [internalTransferCd])

			const secondCd = context.accountFacet.interface.encodeFunctionData("internalTransfer", [user2.address, decimal(11n)])
			const secondHash = ethers.keccak256(secondCd)
			await tl.connect(user).scheduleTimelockOp(subAccount, secondHash)
			const second = await view.getSchedule(subAccount, secondHash)
			await time.setNextBlockTimestamp(second.scheduledAt + DELAY + GRACE)
			await core.connect(user)._call(subAccount, [secondCd])
		})

		it("re-scheduling restarts the clock and cancel clears the window", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			await tl.connect(user).scheduleTimelockOp(subAccount, transferHash)
			await time.increase(Number(DELAY))
			await tl.connect(user).scheduleTimelockOp(subAccount, transferHash)
			await expect(core.connect(user)._call(subAccount, [internalTransferCd])).to.be.revertedWithCustomError(core, "ScheduleNotReady")

			await expect(tl.connect(user).cancelTimelockOp(subAccount, transferHash)).to.emit(tl, "TimelockOpCancelled").withArgs(subAccount, transferHash)
			expect((await view.getSchedule(subAccount, transferHash)).scheduledAt).to.equal(0n)
		})

		it("only the owner may schedule or cancel", async function () {
			const tl = context.alTimelockFacet
			await expect(tl.connect(user2).scheduleTimelockOp(subAccount, transferHash)).to.be.revertedWithCustomError(tl, "NotOwner")
			await expect(tl.connect(user2).cancelTimelockOp(subAccount, transferHash)).to.be.revertedWithCustomError(tl, "NotOwner")
		})

		it("isolates the same operation hash and schedule between account families", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			const affiliate = await context.accountManager.getAddress()
			const data = [{ name: "second-root", metadata: "0x", symmioCore: context.diamond, isolationType: POSITION, singleVAMode: false }]
			const second = (await core.connect(user).createSubAccounts.staticCall(affiliate, data))[0]
			await core.connect(user).createSubAccounts(affiliate, data)
			await context.accountFacet.connect(user).depositFor(second, decimal(100n))
			await tl.connect(user).setupTimelocks(second, unlocker.address, DELAY, [SEL.internalTransfer])

			await tl.connect(user).scheduleTimelockOp(subAccount, transferHash)
			await time.increase(Number(DELAY))
			await core.connect(user)._call(subAccount, [internalTransferCd])
			await expect(core.connect(user)._call(second, [internalTransferCd]))
				.to.be.revertedWithCustomError(core, "TimelockOpNotApprovedOrScheduled")
				.withArgs(second, transferHash)

			await tl.connect(user).scheduleTimelockOp(second, transferHash)
			await time.increase(Number(DELAY))
			await core.connect(user)._call(second, [internalTransferCd])
		})

		it("honours an admin-configured operation window", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			await grantSetter()
			await control.connect(context.signers.admin).setScheduleGracePeriod(60n)
			expect(await view.scheduleGracePeriod()).to.equal(60n)

			await tl.connect(user).scheduleTimelockOp(subAccount, transferHash)
			await time.increase(Number(DELAY) + 61)
			await expect(core.connect(user)._call(subAccount, [internalTransferCd])).to.be.revertedWithCustomError(core, "ScheduleExpired")
		})

		it("applies the current grace period to existing schedules, including shortening and revival", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			await grantSetter()
			const admin = context.signers.admin

			await tl.connect(user).scheduleTimelockOp(subAccount, transferHash)
			const shortened = await view.getSchedule(subAccount, transferHash)
			await control.connect(admin).setScheduleGracePeriod(60n)
			await time.setNextBlockTimestamp(shortened.scheduledAt + DELAY + 61n)
			await expect(core.connect(user)._call(subAccount, [internalTransferCd])).to.be.revertedWithCustomError(core, "ScheduleExpired")

			const secondCd = context.accountFacet.interface.encodeFunctionData("internalTransfer", [user2.address, decimal(11n)])
			const secondHash = ethers.keccak256(secondCd)
			await tl.connect(user).scheduleTimelockOp(subAccount, secondHash)
			const revived = await view.getSchedule(subAccount, secondHash)
			await time.setNextBlockTimestamp(revived.scheduledAt + DELAY + 61n)
			await expect(core.connect(user)._call(subAccount, [secondCd])).to.be.revertedWithCustomError(core, "ScheduleExpired")
			await control.connect(admin).setScheduleGracePeriod(GRACE)
			await core.connect(user)._call(subAccount, [secondCd])
			expect((await view.getSchedule(subAccount, secondHash)).scheduledAt).to.equal(0n)
		})
	})

	describe("executeTimelockOp with approvals", function () {
		let clearCd: string
		let clearHash: string

		beforeEach(async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			clearCd = tl.interface.encodeFunctionData("clearTimelocks", [subAccount, [SEL.internalTransfer]])
			clearHash = ethers.keccak256(clearCd)
		})

		it("rejects a public-view approval burn and leaves the signature usable by the owner", async function () {
			const tl = context.alTimelockFacet
			const signed = await signApproval(clearHash)
			const readCd = view.interface.encodeFunctionData("ownerOf", [subAccount])
			await expect(tl.connect(user2).executeTimelockOp([signed], readCd)).to.be.revertedWithCustomError(tl, "UnusedTimelockApproval")
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(false)
			await tl.connect(user).executeTimelockOp([signed], clearCd)
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(true)
		})

		it("rejects surplus approvals with distinct salts for the same tuple", async function () {
			const tl = context.alTimelockFacet
			const a = await signApproval(clearHash)
			const b = await signApproval(clearHash)
			await expect(tl.connect(user).executeTimelockOp([a, b], clearCd)).to.be.revertedWithCustomError(tl, "UnusedTimelockApproval")
			for (const signed of [a, b]) expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(false)
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(true)
			await tl.connect(user).executeTimelockOp([a], clearCd)
		})

		it("rejects nested surplus approvals for the same tuple", async function () {
			const tl = context.alTimelockFacet
			const outer = await signApproval(clearHash)
			const inner = await signApproval(clearHash)
			const nested = tl.interface.encodeFunctionData("executeTimelockOp", [[inner], clearCd])
			await expect(tl.connect(user).executeTimelockOp([outer], nested)).to.be.revertedWithCustomError(tl, "UnusedTimelockApproval")
			for (const signed of [outer, inner]) expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(false)
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(true)
		})

		it("consumes approvals from outer and inner wrappers for repeated exact calls", async function () {
			const tl = context.alTimelockFacet
			const hash = ethers.keccak256(internalTransferCd)
			const outer = await signApproval(hash)
			const inner = await signApproval(hash)
			const twice = context.alCoreFacet.interface.encodeFunctionData("_call", [subAccount, [internalTransferCd, internalTransferCd]])
			const nested = tl.interface.encodeFunctionData("executeTimelockOp", [[inner], twice])
			await tl.connect(user).executeTimelockOp([outer], nested)
			for (const signed of [outer, inner]) expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(true)
		})

		it("an empty nested wrapper can consume an outer approval", async function () {
			const tl = context.alTimelockFacet
			const signed = await signApproval(clearHash)
			const nested = tl.interface.encodeFunctionData("executeTimelockOp", [[], clearCd])
			await tl.connect(user).executeTimelockOp([signed], nested)
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(true)
		})

		it("rejects replay of an outer approval inside a nested wrapper", async function () {
			const tl = context.alTimelockFacet
			const signed = await signApproval(clearHash)
			const nested = tl.interface.encodeFunctionData("executeTimelockOp", [[signed], clearCd])
			await expect(tl.connect(user).executeTimelockOp([signed], nested)).to.be.revertedWithCustomError(tl, "ApprovalUsed")
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(false)
			await tl.connect(user).executeTimelockOp([signed], clearCd)
		})

		it("a mature schedule cannot burn an unrelated approval", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).scheduleTimelockOp(subAccount, clearHash)
			await time.increase(Number(DELAY))
			const signed = await signApproval(ethers.keccak256(internalTransferCd))
			await expect(tl.connect(user).executeTimelockOp([signed], clearCd)).to.be.revertedWithCustomError(tl, "UnusedTimelockApproval")
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(false)
			expect((await view.getSchedule(subAccount, clearHash)).scheduledAt).to.not.equal(0n)
			await tl.connect(user).executeTimelockOp([], clearCd)
		})

		it("hashes like the reference EIP-712 encoding", async function () {
			const { approval } = await signApproval(clearHash)
			const expected = ethers.TypedDataEncoder.hash(domain, APPROVAL_TYPES, approval)
			expect(await view.hashTimelockApproval(approval)).to.equal(expected)
			expect(await view.timelockDomainSeparator()).to.equal(ethers.TypedDataEncoder.hashDomain(domain))
		})

		it("binds every approval field, the chain, and the verifying contract", async function () {
			const tl = context.alTimelockFacet
			const approval = {
				account: subAccount,
				unlocker: unlocker.address,
				callDataHash: clearHash,
				deadline: BigInt(await time.latest()) + 600n,
				salt: randomSalt(),
			}
			const signature = await unlocker.signTypedData(domain, APPROVAL_TYPES, approval)
			const mutations = [
				{ ...approval, account: user2.address },
				{ ...approval, unlocker: user2.address },
				{ ...approval, callDataHash: ZeroHash },
				{ ...approval, deadline: approval.deadline + 1n },
				{ ...approval, salt: randomSalt() },
			]
			for (const mutated of mutations) {
				await expect(tl.connect(user).executeTimelockOp([{ approval: mutated, signature }], clearCd)).to.be.revertedWithCustomError(
					tl,
					"InvalidApprovalSignature",
				)
			}

			const chainId = BigInt(domain.chainId!.toString())
			for (const wrongDomain of [
				{ ...domain, chainId: chainId + 1n },
				{ ...domain, verifyingContract: context.diamond },
			]) {
				const wrongSignature = await unlocker.signTypedData(wrongDomain, APPROVAL_TYPES, approval)
				await expect(tl.connect(user).executeTimelockOp([{ approval, signature: wrongSignature }], clearCd)).to.be.revertedWithCustomError(
					tl,
					"InvalidApprovalSignature",
				)
			}

			await tl.connect(user).executeTimelockOp([{ approval, signature }], clearCd)
		})

		it("accepts an approval at its exact deadline", async function () {
			const tl = context.alTimelockFacet
			const deadline = BigInt(await time.latest()) + 10n
			const approval = { account: subAccount, unlocker: unlocker.address, callDataHash: clearHash, deadline, salt: randomSalt() }
			const signature = await unlocker.signTypedData(domain, APPROVAL_TYPES, approval)
			await time.setNextBlockTimestamp(deadline)
			await tl.connect(user).executeTimelockOp([{ approval, signature }], clearCd)
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(approval))).to.equal(true)
		})

		it("runs the inner call immediately, marks the approval used, and cleans the window", async function () {
			const tl = context.alTimelockFacet
			const signed = await signApproval(clearHash)
			const approvalHash = await view.hashTimelockApproval(signed.approval)
			await expect(tl.connect(user).executeTimelockOp([signed], clearCd))
				.to.emit(tl, "TimelockOpApproved")
				.withArgs(subAccount, clearHash, unlocker.address, approvalHash)
				.and.to.emit(tl, "TimelockOpExecuted")
				.withArgs(subAccount, clearHash)
				.and.to.emit(tl, "TimelocksCleared")
				.withArgs(subAccount, [SEL.internalTransfer])
			expect(await view.isApprovalUsed(approvalHash)).to.equal(true)
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(false)
			expect((await view.getSchedule(subAccount, clearHash)).scheduledAt).to.equal(0n)

			await expect(tl.connect(user).executeTimelockOp([signed], clearCd)).to.be.revertedWithCustomError(tl, "ApprovalUsed")
		})

		it("rejects mismatched, expired, and foreign approvals", async function () {
			const tl = context.alTimelockFacet
			const mismatched = await signApproval(ZeroHash)
			await expect(tl.connect(user).executeTimelockOp([mismatched], clearCd)).to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")

			const expired = await signApproval(clearHash, -1n)
			await expect(tl.connect(user).executeTimelockOp([expired], clearCd)).to.be.revertedWithCustomError(tl, "ApprovalExpired")

			const foreign = await signApproval(clearHash, 60n, user2)
			await expect(tl.connect(user).executeTimelockOp([foreign], clearCd)).to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")

			const inactive = await signApproval(clearHash, 60n, unlocker, user2.address)
			await expect(tl.connect(user).executeTimelockOp([inactive], clearCd)).to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
		})

		it("rejects a signature that is not the named unlocker's", async function () {
			const tl = context.alTimelockFacet
			const forged = await signApproval(clearHash, 60n, user2, subAccount, unlocker.address)
			await expect(tl.connect(user).executeTimelockOp([forged], clearCd)).to.be.revertedWithCustomError(tl, "InvalidApprovalSignature")
			const unsigned = await signApproval(clearHash)
			await expect(tl.connect(user).executeTimelockOp([{ approval: unsigned.approval, signature: "0x" }], clearCd)).to.be.revertedWithCustomError(
				tl,
				"InvalidApprovalSignature",
			)
		})

		it("rejects surplus approvals for other accounts and a blank unlocker", async function () {
			const tl = context.alTimelockFacet
			// An approval naming another account is recorded under that account and never consulted here.
			const forOther = await signApproval(clearHash, 60n, unlocker, user2.address)
			const forThis = await signApproval(clearHash)
			await expect(tl.connect(user).executeTimelockOp([forOther, forThis], clearCd)).to.be.revertedWithCustomError(tl, "UnusedTimelockApproval")
			for (const signed of [forOther, forThis]) expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(false)
			await tl.connect(user).executeTimelockOp([forThis], clearCd)

			const blank = await signApproval(clearHash, 60n, unlocker, subAccount, ZeroAddress)
			await expect(tl.connect(user).executeTimelockOp([blank], clearCd)).to.be.revertedWithCustomError(tl, "ZeroUnlocker")
		})

		it("accepts an EIP-1271 contract as unlocker", async function () {
			const tl = context.alTimelockFacet
			const wallet = await (await ethers.getContractFactory("Mock1271")).deploy(unlocker.address)
			const walletAddress = await wallet.getAddress()
			await tl.connect(user).setupTimelocks(subAccount, walletAddress, DELAY, [SEL.allocate])
			const clearAllocate = tl.interface.encodeFunctionData("clearTimelocks", [subAccount, [SEL.allocate]])
			const hash = ethers.keccak256(clearAllocate)

			// the wallet's own key signs on its behalf; a stranger's signature is refused by the wallet
			const byStranger = await signApproval(hash, 60n, user2, subAccount, walletAddress)
			await expect(tl.connect(user).executeTimelockOp([byStranger], clearAllocate)).to.be.revertedWithCustomError(tl, "InvalidApprovalSignature")
			// and the key signing as itself is not the wallet
			const asEoa = await signApproval(hash, 60n, unlocker)
			await expect(tl.connect(user).executeTimelockOp([asEoa], clearAllocate)).to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")

			const byWallet = await signApproval(hash, 60n, unlocker, subAccount, walletAddress)
			await expect(tl.connect(user).executeTimelockOp([byWallet], clearAllocate))
				.to.emit(tl, "TimelockOpApproved")
				.withArgs(subAccount, hash, walletAddress, await view.hashTimelockApproval(byWallet.approval))
			expect(await view.unlockerOf(subAccount, SEL.allocate)).to.equal(ZeroAddress)
		})

		it("a different salt is a distinct approval", async function () {
			const tl = context.alTimelockFacet
			const a = await signApproval(clearHash)
			const b = await signApproval(clearHash)
			expect(await view.hashTimelockApproval(a.approval)).to.not.equal(await view.hashTimelockApproval(b.approval))
			await tl.connect(user).executeTimelockOp([a], clearCd)
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(b.approval))).to.equal(false)
		})

		it("a non-owner submitting the owner's approval fails and leaves the approval unused", async function () {
			const tl = context.alTimelockFacet
			const signed = await signApproval(clearHash)
			await expect(tl.connect(user2).executeTimelockOp([signed], clearCd)).to.be.revertedWithCustomError(tl, "NotOwner")
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(false)
		})

		it("bubbles inner revert data unchanged", async function () {
			const tl = context.alTimelockFacet
			const zeroMargin = context.alMarginFacet.interface.encodeFunctionData("addMarginToNextVA", [subAccount, POSITION, 1, 0])
			await expect(tl.connect(user).executeTimelockOp([], zeroMargin)).to.be.revertedWithCustomError(context.alMarginFacet, "ZeroAmount")
		})

		it("rolls back an approval consumed by a call whose body reverts", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.addMarginToNextVA])
			const zeroMargin = context.alMarginFacet.interface.encodeFunctionData("addMarginToNextVA", [subAccount, POSITION, 1, 0])
			const signed = await signApproval(ethers.keccak256(zeroMargin))
			const approvalHash = await view.hashTimelockApproval(signed.approval)

			await expect(tl.connect(user).executeTimelockOp([signed], zeroMargin)).to.be.revertedWithCustomError(context.alMarginFacet, "ZeroAmount")
			expect(await view.isApprovalUsed(approvalHash)).to.equal(false)
		})

		it("rolls back a mature schedule consumed by a call whose body reverts", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.addMarginToNextVA])
			const zeroMargin = context.alMarginFacet.interface.encodeFunctionData("addMarginToNextVA", [subAccount, POSITION, 1, 0])
			const hash = ethers.keccak256(zeroMargin)
			await tl.connect(user).scheduleTimelockOp(subAccount, hash)
			await time.increase(Number(DELAY))

			await expect(context.alMarginFacet.connect(user).addMarginToNextVA(subAccount, POSITION, 1, 0)).to.be.revertedWithCustomError(
				context.alMarginFacet,
				"ZeroAmount",
			)
			expect((await view.getSchedule(subAccount, hash)).scheduledAt).to.not.equal(0n)
		})

		it("an approval shortcuts a pending scheduled window", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).scheduleTimelockOp(subAccount, clearHash)
			const signed = await signApproval(clearHash)
			await tl.connect(user).executeTimelockOp([signed], clearCd)
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(false)
		})

		it("using an approval leaves a separate pending schedule for the same operation intact", async function () {
			const tl = context.alTimelockFacet
			const core = context.alCoreFacet
			const hash = ethers.keccak256(internalTransferCd)
			const wrapped = core.interface.encodeFunctionData("_call", [subAccount, [internalTransferCd]])
			await tl.connect(user).scheduleTimelockOp(subAccount, hash)
			const signed = await signApproval(hash)
			await tl.connect(user).executeTimelockOp([signed], wrapped)
			expect((await view.getSchedule(subAccount, hash)).scheduledAt).to.not.equal(0n)

			await time.increase(Number(DELAY))
			await core.connect(user)._call(subAccount, [internalTransferCd])
			expect((await view.getSchedule(subAccount, hash)).scheduledAt).to.equal(0n)
		})

		it("unlocks a weakening setupTimelocks", async function () {
			const tl = context.alTimelockFacet
			const cd = tl.interface.encodeFunctionData("setupTimelocks", [subAccount, user2.address, DELAY, [SEL.internalTransfer]])
			const signed = await signApproval(ethers.keccak256(cd))
			await tl.connect(user).executeTimelockOp([signed], cd)
			expect(await view.unlockerOf(subAccount, SEL.internalTransfer)).to.equal(user2.address)
		})

		it("passes through an untimelocked call only when no approvals are supplied", async function () {
			const tl = context.alTimelockFacet
			const core = context.alCoreFacet
			const renameCd = core.interface.encodeFunctionData("editAccountName", [subAccount, "x"])
			await expect(tl.connect(user).executeTimelockOp([], renameCd)).to.emit(core, "EditAccountName").withArgs(subAccount, "x")

			const ungatedCall = core.interface.encodeFunctionData("_call", [subAccount, [allocateCd]])
			const signed = await signApproval(ethers.keccak256(ungatedCall))
			await expect(tl.connect(user).executeTimelockOp([signed], ungatedCall)).to.be.revertedWithCustomError(tl, "UnusedTimelockApproval")
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(false)
		})

		it("a nested executeTimelockOp reaches the op inside", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).scheduleTimelockOp(subAccount, clearHash)
			await time.increase(Number(DELAY))
			const nested = tl.interface.encodeFunctionData("executeTimelockOp", [[], clearCd])
			await expect(tl.connect(user).executeTimelockOp([], nested)).to.emit(tl, "TimelockOpExecuted").withArgs(subAccount, clearHash)
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(false)
		})

		it("a schedule for another op is untouched by an unrelated wrapped call", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).scheduleTimelockOp(subAccount, clearHash)
			await time.increase(Number(DELAY))
			const otherCd = context.alCoreFacet.interface.encodeFunctionData("_call", [subAccount, [allocateCd]])
			await tl.connect(user).executeTimelockOp([], otherCd)
			expect((await view.getSchedule(subAccount, clearHash)).scheduledAt).to.not.equal(0n)
			await expect(tl.connect(user).executeTimelockOp([], clearCd)).to.emit(tl, "TimelockOpExecuted").withArgs(subAccount, clearHash)
		})
	})

	describe("_call and _callWithMargin gates", function () {
		beforeEach(async function () {
			await context.alTimelockFacet.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
		})

		it("locks a batch carrying a timelocked core selector and passes one that does not", async function () {
			const core = context.alCoreFacet
			await expect(core.connect(user)._call(subAccount, [internalTransferCd])).to.be.revertedWithCustomError(core, "TimelockOpNotApprovedOrScheduled")
			await core.connect(user)._call(subAccount, [allocateCd])
			await expect(core.connect(user)._call(subAccount, [allocateCd, internalTransferCd])).to.be.revertedWithCustomError(
				core,
				"TimelockOpNotApprovedOrScheduled",
			)
		})

		it("passes a locked batch after a schedule, and through executeTimelockOp with an approval", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			const cd = core.interface.encodeFunctionData("_call", [subAccount, [internalTransferCd]])
			// the timelocked op is the inner call, so that is what the owner schedules and the unlocker approves
			const hash = ethers.keccak256(internalTransferCd)

			await tl.connect(user).scheduleTimelockOp(subAccount, hash)
			await time.increase(Number(DELAY))
			await expect(core.connect(user)._call(subAccount, [internalTransferCd]))
				.to.emit(tl, "TimelockOpExecuted")
				.withArgs(subAccount, hash)

			const before = await context.viewFacet.allocatedBalanceOfPartyA(user2.address)
			const signed = await signApproval(hash)
			await tl.connect(user).executeTimelockOp([signed], cd)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(user2.address)).to.be.greaterThan(before)
		})

		it("returns the inner call's data through executeTimelockOp", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			const cd = core.interface.encodeFunctionData("_call", [subAccount, [internalTransferCd]])
			const signed = await signApproval(ethers.keccak256(internalTransferCd))
			const raw = await tl.connect(user).executeTimelockOp.staticCall([signed], cd)
			const [results] = core.interface.decodeFunctionResult("_call", raw)
			expect(results.length).to.equal(1)
		})

		it("does not gate accounts outside the timelocked family", async function () {
			const affiliate = await context.accountManager.getAddress()
			const data = [{ name: "free", metadata: "0x", symmioCore: context.diamond, isolationType: POSITION, singleVAMode: false }]
			const free = (await context.alCoreFacet.connect(user).createSubAccounts.staticCall(affiliate, data))[0]
			await context.alCoreFacet.connect(user).createSubAccounts(affiliate, data)
			await context.accountFacet.connect(user).depositFor(free, decimal(100n))
			await context.alCoreFacet.connect(user)._call(free, [internalTransferCd])
		})

		it("_callWithMargin is gated by the addMarginToNextVA it performs on the side, named by that call's own calldata", async function () {
			const core = context.alCoreFacet
			await core.connect(user)._callWithMargin(subAccount, POSITION, 1, MARGIN, [quoteCallData])
			await context.alTimelockFacet.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.addMarginToNextVA])
			const sideCd = context.alMarginFacet.interface.encodeFunctionData("addMarginToNextVA", [subAccount, POSITION, 1, MARGIN])
			await expect(core.connect(user)._callWithMargin(subAccount, POSITION, 1, MARGIN, [quoteCallData]))
				.to.be.revertedWithCustomError(core, "TimelockOpNotApprovedOrScheduled")
				.withArgs(subAccount, ethers.keccak256(sideCd))
		})

		it("the side op is unlocked by the standalone call's calldata only, never by the whole entry", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.addMarginToNextVA])
			const sideCd = context.alMarginFacet.interface.encodeFunctionData("addMarginToNextVA", [subAccount, POSITION, 1, MARGIN])
			const sideHash = ethers.keccak256(sideCd)
			const entryCd = core.interface.encodeFunctionData("_callWithMargin", [subAccount, POSITION, 1, MARGIN, [quoteCallData]])

			// the unlocker approves the margin call it guards
			const sideApproval = await signApproval(sideHash)
			await expect(tl.connect(user).executeTimelockOp([sideApproval], entryCd))
				.to.emit(tl, "TimelockOpExecuted")
				.withArgs(subAccount, sideHash)

			// approving the whole entry covers nothing inside it, and the approval is not burned
			const entryApproval = await signApproval(ethers.keccak256(entryCd))
			await expect(tl.connect(user).executeTimelockOp([entryApproval], entryCd))
				.to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
				.withArgs(subAccount, sideHash)
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(entryApproval.approval))).to.equal(false)

			// a schedule over the standalone margin call unlocks it inside the batch too
			await tl.connect(user).scheduleTimelockOp(subAccount, sideHash)
			await expect(core.connect(user)._callWithMargin(subAccount, POSITION, 1, MARGIN, [quoteCallData])).to.be.revertedWithCustomError(
				core,
				"ScheduleNotReady",
			)
			await time.increase(Number(DELAY))
			await expect(core.connect(user)._callWithMargin(subAccount, POSITION, 1, MARGIN, [quoteCallData]))
				.to.emit(tl, "TimelockOpExecuted")
				.withArgs(subAccount, sideHash)
			expect((await view.getSchedule(subAccount, sideHash)).scheduledAt).to.equal(0n)
		})

		it("requires and atomically consumes separate approvals for the entry, implied margin move, and inner Core call", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			const entrySelector = core.interface.getFunction("_callWithMargin")!.selector
			const quoteSelector = ethers.dataSlice(quoteCallData, 0, 4)
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [entrySelector, SEL.addMarginToNextVA, quoteSelector])

			const sideCd = context.alMarginFacet.interface.encodeFunctionData("addMarginToNextVA", [subAccount, POSITION, 1, MARGIN])
			const entryCd = core.interface.encodeFunctionData("_callWithMargin", [subAccount, POSITION, 1, MARGIN, [quoteCallData]])
			const entry = await signApproval(ethers.keccak256(entryCd))
			const side = await signApproval(ethers.keccak256(sideCd))
			const inner = await signApproval(ethers.keccak256(quoteCallData))
			const entryApprovalHash = await view.hashTimelockApproval(entry.approval)
			const sideApprovalHash = await view.hashTimelockApproval(side.approval)
			const nextQuoteId = await context.viewFacetQuote.getNextQuoteId()

			await expect(tl.connect(user).executeTimelockOp([entry, side], entryCd))
				.to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
				.withArgs(subAccount, ethers.keccak256(quoteCallData))
			expect(await view.isApprovalUsed(entryApprovalHash)).to.equal(false)
			expect(await view.isApprovalUsed(sideApprovalHash)).to.equal(false)
			expect(await context.viewFacetQuote.getNextQuoteId()).to.equal(nextQuoteId)

			await tl.connect(user).executeTimelockOp([entry, side, inner], entryCd)
			expect(await view.isApprovalUsed(entryApprovalHash)).to.equal(true)
			expect(await view.isApprovalUsed(sideApprovalHash)).to.equal(true)
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(inner.approval))).to.equal(true)
			expect(await context.viewFacetQuote.getNextQuoteId()).to.equal(nextQuoteId + 1n)
		})

		it("a VA inherits its parent's timelocks: gating, scheduling, and approvals all resolve to the parent", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			await core.connect(user)._callWithMargin(subAccount, POSITION, 1, MARGIN, [quoteCallData])
			const va = (await context.viewFacetQuote.getQuote(1)).partyA
			const cancelCd = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [1])
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.requestToCancelQuote])

			await expect(core.connect(user)._call(va, [cancelCd])).to.be.revertedWithCustomError(core, "TimelockOpNotApprovedOrScheduled")

			const cd = core.interface.encodeFunctionData("_call", [va, [cancelCd]])
			const hash = ethers.keccak256(cancelCd)
			await expect(tl.connect(user).scheduleTimelockOp(va, hash)).to.emit(tl, "TimelockOpScheduled")
			expect((await view.getSchedule(subAccount, hash)).scheduledAt).to.not.equal(0n)
			expect((await view.getSchedule(va, hash)).scheduledAt).to.not.equal(0n)
			await tl.connect(user).cancelTimelockOp(va, hash)
			expect((await view.getSchedule(subAccount, hash)).scheduledAt).to.equal(0n)

			// approval names the parent, inner call targets the VA
			const signed = await signApproval(hash, 60n, unlocker, subAccount)
			await expect(tl.connect(user).executeTimelockOp([signed], cd))
				.to.emit(tl, "TimelockOpExecuted")
				.withArgs(subAccount, hash)
		})

		it("applies inner Core timelocks to calls requested by an affiliate hook", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			const affiliate = await context.accountManager.getAddress()
			const hook = await (await ethers.getContractFactory("MockAccountLayerHook")).deploy()
			const onCall = hook.interface.getFunction("onCall")!.selector
			await hook.setAccountLayer(accountLayer)
			await context.alAffiliateFacet.connect(context.signers.admin).setHook(affiliate, onCall, await hook.getAddress())
			await grantSetter()
			await control.connect(context.signers.admin).setHookAllowedSelectors(affiliate, [SEL.internalTransfer], true)
			await hook.setExecuteForAccountCallback(onCall, internalTransferCd, true)

			const before = await context.viewFacet.allocatedBalanceOfPartyA(user2.address)
			await expect(core.connect(user)._call(subAccount, [allocateCd])).to.be.revertedWithCustomError(core, "HookFailed")
			expect(await context.viewFacet.allocatedBalanceOfPartyA(user2.address)).to.equal(before)

			const hash = ethers.keccak256(internalTransferCd)
			const wrapped = core.interface.encodeFunctionData("_call", [subAccount, [allocateCd]])
			const signed = await signApproval(hash)
			await tl.connect(user).executeTimelockOp([signed], wrapped)
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(signed.approval))).to.equal(true)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(user2.address)).to.be.greaterThan(before)

			await tl.connect(user).scheduleTimelockOp(subAccount, hash)
			await time.increase(Number(DELAY))
			await core.connect(user)._call(subAccount, [allocateCd])
			expect((await view.getSchedule(subAccount, hash)).scheduledAt).to.equal(0n)
		})

		it("gates a real virtual-account margin transfer with the parent family's policy", async function () {
			const core = context.alCoreFacet
			const margin = context.alMarginFacet
			const tl = context.alTimelockFacet
			await core.connect(user)._callWithMargin(subAccount, POSITION, 1, MARGIN, [quoteCallData])
			const va = (await context.viewFacetQuote.getQuote(1)).partyA
			const selector = margin.interface.getFunction("addMargin")!.selector
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [selector])
			const amount = decimal(25n)
			const cd = margin.interface.encodeFunctionData("addMargin", [va, amount])
			const parentBefore = await context.viewFacet.balanceOf(subAccount)
			const vaBefore = await context.viewFacet.allocatedBalanceOfPartyA(va)

			await expect(margin.connect(user).addMargin(va, amount)).to.be.revertedWithCustomError(margin, "TimelockOpNotApprovedOrScheduled")
			const signed = await signApproval(ethers.keccak256(cd))
			await tl.connect(user).executeTimelockOp([signed], cd)
			expect(await context.viewFacet.balanceOf(subAccount)).to.equal(parentBefore - amount)
			expect(await context.viewFacet.allocatedBalanceOfPartyA(va)).to.equal(vaBefore + amount)
		})
	})

	describe("entry-point gates and surface", function () {
		const GATED = [
			"_call",
			"_callWithMargin",
			"setSingleVAMode",
			"deleteSubAccount",
			"transferSubAccountOwnership",
			"createCustomVirtualAccount",
			"addMargin",
			"addMarginToNextVA",
			"removeMargin",
			"safeRemoveMargin",
			"emergencyRecoverMargin",
		]
		const EXEMPT = ["depositForAccount", "depositAndAllocateForAccount", "editAccountName"]
		const OWNER_PARAMS = new Set(["account", "subAccount", "virtualAccount", "parentAccount"])

		function ownerFunctions(iface: Interface): FunctionFragment[] {
			return iface.fragments.filter(
				(f): f is FunctionFragment =>
					f.type === "function" &&
					(f as FunctionFragment).stateMutability !== "view" &&
					(f as FunctionFragment).stateMutability !== "pure" &&
					(f as FunctionFragment).inputs.length > 0 &&
					OWNER_PARAMS.has((f as FunctionFragment).inputs[0].name),
			)
		}

		function dummyArg(t: ParamType): any {
			if (t.baseType === "array") return []
			if (t.baseType === "tuple") return t.components!.map(dummyArg)
			if (t.baseType === "address") return ZeroAddress
			if (t.baseType === "bool") return false
			if (t.baseType === "string") return ""
			if (t.baseType === "bytes") return "0x"
			if (t.baseType.startsWith("bytes")) return ethers.zeroPadValue("0x", Number(t.baseType.slice(5)))
			return 0
		}

		it("every owner entry point on CoreFacet and MarginFacet is either gated or exempt", async function () {
			const found = [...ownerFunctions(context.alCoreFacet.interface), ...ownerFunctions(context.alMarginFacet.interface)].map(f => f.name)
			expect(found.sort()).to.deep.equal([...GATED, ...EXEMPT].sort())
		})

		it("each gated entry point reverts TimelockOpNotApprovedOrScheduled once its selector is timelocked", async function () {
			const tl = context.alTimelockFacet
			const facets = [context.alCoreFacet, context.alMarginFacet]
			for (const facet of facets) {
				for (const frag of ownerFunctions(facet.interface)) {
					if (!GATED.includes(frag.name)) continue
					await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [frag.selector])
					const args = frag.inputs.map(dummyArg)
					args[0] = subAccount
					const data = facet.interface.encodeFunctionData(frag, args)
					await expect(user.sendTransaction({ to: accountLayer, data }), frag.name).to.be.revertedWithCustomError(
						tl,
						"TimelockOpNotApprovedOrScheduled",
					)
				}
			}
		})

		it("gated entry points pass when their selector is not in the set", async function () {
			const core = context.alCoreFacet
			await context.alTimelockFacet.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			await core.connect(user).setSingleVAMode(subAccount, false)
			await context.alMarginFacet.connect(user).addMarginToNextVA(subAccount, POSITION, 1, MARGIN)
		})

		it("exempt entry points pass regardless of the set", async function () {
			const core = context.alCoreFacet
			await context.alTimelockFacet
				.connect(user)
				.setupTimelocks(subAccount, unlocker.address, DELAY, [
					selectorOf(core.interface, "editAccountName"),
					selectorOf(core.interface, "depositForAccount"),
				])
			await core.connect(user).editAccountName(subAccount, "renamed")
			await context.collateral.connect(user).approve(accountLayer, ethers.MaxUint256)
			await core.connect(user).depositForAccount(subAccount, decimal(1n))
		})

		it("transferSubAccountOwnership is gated and the timelock follows the account", async function () {
			const core = context.alCoreFacet
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.transferSubAccountOwnership])
			await expect(core.connect(user).transferSubAccountOwnership(subAccount, user2.address)).to.be.revertedWithCustomError(
				core,
				"TimelockOpNotApprovedOrScheduled",
			)

			const cd = core.interface.encodeFunctionData("transferSubAccountOwnership", [subAccount, user2.address])
			const signed = await signApproval(ethers.keccak256(cd))
			await tl.connect(user).executeTimelockOp([signed], cd)

			// the policy survives the handover, so the new owner is gated exactly as the old one was
			expect(await view.unlockerOf(subAccount, SEL.transferSubAccountOwnership)).to.equal(unlocker.address)
			await expect(core.connect(user2).transferSubAccountOwnership(subAccount, user.address)).to.be.revertedWithCustomError(
				core,
				"TimelockOpNotApprovedOrScheduled",
			)
		})
	})

	describe("policy changes and legacy accounts", function () {
		it("rejects an imported legacy account, whose MultiAccount route bypasses the gate", async function () {
			const tl = context.alTimelockFacet
			const legacyMultiAccounts = await view.getLegacyMultiAccounts()
			const legacy = await ethers.getContractAt("MockMultiAccount", legacyMultiAccounts[0])
			const tx = await legacy.createMockAccountWithName(user.address, "legacy-tl")
			const receipt = await tx.wait()
			let legacyAccount = ZeroAddress
			for (const log of receipt!.logs) {
				try {
					const parsed = legacy.interface.parseLog(log)
					if (parsed?.name === "AccountCreated") legacyAccount = parsed.args.account
				} catch {}
			}
			expect(legacyAccount).to.not.equal(ZeroAddress)
			await context.alCoreFacet
				.connect(user)
				.importLegacyAccounts(
					legacyMultiAccounts[0],
					await context.accountManager.getAddress(),
					[context.diamond],
					[{ account: legacyAccount, name: "legacy-tl", coreIndex: 0 }],
				)
			expect((await view.getSubAccount(legacyAccount)).isExists).to.equal(true)

			await expect(tl.connect(user).setupTimelocks(legacyAccount, unlocker.address, DELAY, [SEL.internalTransfer])).to.be.revertedWithCustomError(
				tl,
				"LegacyAccountCannotBeTimelocked",
			)
			expect(await view.isTimelocked(legacyAccount, SEL.internalTransfer)).to.equal(false)
		})

		it("a policy change invalidates every scheduled window", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, 0n, [SEL.internalTransfer])
			const clearCd = tl.interface.encodeFunctionData("clearTimelocks", [subAccount, [SEL.internalTransfer]])
			const clearHash = ethers.keccak256(clearCd)
			await tl.connect(user).scheduleTimelockOp(subAccount, clearHash)
			expect((await view.getSchedule(subAccount, clearHash)).scheduledAt).to.not.equal(0n)

			// Raising the delay is instant, but it must not leave the zero-delay window usable.
			await expect(tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer]))
				.to.emit(tl, "TimelockNonceAdvanced")
				.withArgs(subAccount, 2n)
			expect(await view.timelockNonce(subAccount)).to.equal(2n)
			expect((await view.getSchedule(subAccount, clearHash)).scheduledAt).to.equal(0n)
			await expect(tl.connect(user).clearTimelocks(subAccount, [SEL.internalTransfer])).to.be.revertedWithCustomError(
				tl,
				"TimelockOpNotApprovedOrScheduled",
			)

			// The dead window does not block a fresh schedule under the new delay.
			await tl.connect(user).scheduleTimelockOp(subAccount, clearHash)
			await expect(tl.connect(user).clearTimelocks(subAccount, [SEL.internalTransfer])).to.be.revertedWithCustomError(tl, "ScheduleNotReady")
			await time.increase(Number(DELAY))
			await tl.connect(user).clearTimelocks(subAccount, [SEL.internalTransfer])
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(false)
		})

		it("adding a selector invalidates a window scheduled while that selector was ungated", async function () {
			const tl = context.alTimelockFacet
			const core = context.alCoreFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			const allocateHash = ethers.keccak256(allocateCd)
			await tl.connect(user).scheduleTimelockOp(subAccount, allocateHash)
			await time.increase(Number(DELAY))

			// allocate becomes timelocked, which advances the nonce and kills the schedule made before it
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.allocate])
			expect((await view.getSchedule(subAccount, allocateHash)).scheduledAt).to.equal(0n)
			await expect(core.connect(user)._call(subAccount, [allocateCd])).to.be.revertedWithCustomError(core, "TimelockOpNotApprovedOrScheduled")
		})
	})

	describe("per-selector unlockers", function () {
		it("an inner op is approved by its own calldata, and by nothing around it", async function () {
			const tl = context.alTimelockFacet
			const core = context.alCoreFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			await tl.connect(user).setupTimelocks(subAccount, user2.address, DELAY, [SEL.allocate])
			const batch = core.interface.encodeFunctionData("_call", [subAccount, [allocateCd, internalTransferCd]])
			const allocateHash = ethers.keccak256(allocateCd)
			const transferHash = ethers.keccak256(internalTransferCd)

			// Each unlocker signs only the inner call it guards.
			const transferByUnlocker = await signApproval(transferHash, 60n, unlocker)
			const allocateByUser2 = await signApproval(allocateHash, 60n, user2)
			// Nobody approved or scheduled the allocate op, so the gate names it.
			await expect(tl.connect(user).executeTimelockOp([transferByUnlocker], batch))
				.to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
				.withArgs(subAccount, allocateHash)
			await expect(tl.connect(user).executeTimelockOp([transferByUnlocker, allocateByUser2], batch))
				.to.emit(tl, "TimelockOpExecuted")
				.withArgs(subAccount, allocateHash)
				.and.to.emit(tl, "TimelockOpExecuted")
				.withArgs(subAccount, transferHash)

			// An approval over the whole batch covers nothing inside it, and is not burned.
			const transferAgain = await signApproval(transferHash, 60n, unlocker)
			const batchByUser2 = await signApproval(ethers.keccak256(batch), 60n, user2)
			await expect(tl.connect(user).executeTimelockOp([transferAgain, batchByUser2], batch))
				.to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
				.withArgs(subAccount, allocateHash)
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(batchByUser2.approval))).to.equal(false)

			// An inner-call approval from the wrong unlocker covers nothing.
			const allocateByUnlocker = await signApproval(allocateHash, 60n, unlocker)
			await expect(tl.connect(user).executeTimelockOp([transferAgain, allocateByUnlocker], batch))
				.to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
				.withArgs(subAccount, allocateHash)
		})

		it("the same inner calldata twice is two ops: two approvals, and never one schedule", async function () {
			const tl = context.alTimelockFacet
			const core = context.alCoreFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			const transferHash = ethers.keccak256(internalTransferCd)
			const twice = core.interface.encodeFunctionData("_call", [subAccount, [internalTransferCd, internalTransferCd]])

			const once = await signApproval(transferHash)
			await expect(tl.connect(user).executeTimelockOp([once], twice))
				.to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
				.withArgs(subAccount, transferHash)
			const again = await signApproval(transferHash)
			await tl.connect(user).executeTimelockOp([once, again], twice)

			// a schedule is one notice for one execution
			await tl.connect(user).scheduleTimelockOp(subAccount, transferHash)
			await time.increase(Number(DELAY))
			await expect(core.connect(user)._call(subAccount, [internalTransferCd, internalTransferCd]))
				.to.be.revertedWithCustomError(core, "TimelockOpNotApprovedOrScheduled")
				.withArgs(subAccount, transferHash)
			await core.connect(user)._call(subAccount, [internalTransferCd])
		})

		it("a schedule over an inner call unlocks it inside any batch", async function () {
			const tl = context.alTimelockFacet
			const core = context.alCoreFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			await tl.connect(user).scheduleTimelockOp(subAccount, ethers.keccak256(internalTransferCd))
			await expect(core.connect(user)._call(subAccount, [allocateCd, internalTransferCd])).to.be.revertedWithCustomError(core, "ScheduleNotReady")
			await time.increase(Number(DELAY))
			await core.connect(user)._call(subAccount, [allocateCd, internalTransferCd])
			// used up: the same inner call needs a new schedule
			await expect(core.connect(user)._call(subAccount, [internalTransferCd])).to.be.revertedWithCustomError(core, "TimelockOpNotApprovedOrScheduled")
		})

		it("a batch checks each inner call's schedule and delay separately without scheduling the batch", async function () {
			const tl = context.alTimelockFacet
			const core = context.alCoreFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			await tl.connect(user).setupTimelocks(subAccount, user2.address, DELAY * 2n, [SEL.allocate])
			const transferHash = ethers.keccak256(internalTransferCd)
			const allocateHash = ethers.keccak256(allocateCd)
			const calls = [internalTransferCd, allocateCd]
			const batchHash = ethers.keccak256(core.interface.encodeFunctionData("_call", [subAccount, calls]))

			await tl.connect(user).scheduleTimelockOp(subAccount, transferHash)
			await time.increase(Number(DELAY))
			await expect(core.connect(user)._call(subAccount, calls))
				.to.be.revertedWithCustomError(core, "TimelockOpNotApprovedOrScheduled")
				.withArgs(subAccount, allocateHash)
			// Failure on the second call rolls back consumption of the first call's schedule.
			expect((await view.getSchedule(subAccount, transferHash)).scheduledAt).to.not.equal(0n)

			await tl.connect(user).scheduleTimelockOp(subAccount, allocateHash)
			await time.increase(Number(DELAY))
			const allocateReadyAt = (await view.getSchedule(subAccount, allocateHash)).scheduledAt + DELAY * 2n
			await expect(core.connect(user)._call(subAccount, calls))
				.to.be.revertedWithCustomError(core, "ScheduleNotReady")
				.withArgs(subAccount, allocateHash, allocateReadyAt)

			// Refresh the first schedule so both independent execution windows overlap.
			await tl.connect(user).scheduleTimelockOp(subAccount, transferHash)
			await time.increase(Number(DELAY))
			expect((await view.getSchedule(subAccount, batchHash)).scheduledAt).to.equal(0n)
			await expect(core.connect(user)._call(subAccount, calls))
				.to.emit(tl, "TimelockOpExecuted")
				.withArgs(subAccount, transferHash)
				.and.to.emit(tl, "TimelockOpExecuted")
				.withArgs(subAccount, allocateHash)
			expect((await view.getSchedule(subAccount, transferHash)).scheduledAt).to.equal(0n)
			expect((await view.getSchedule(subAccount, allocateHash)).scheduledAt).to.equal(0n)
		})

		it("different selectors can be guarded by different unlockers", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			// a selector nobody guards yet can be handed to a second unlocker instantly
			await tl.connect(user).setupTimelocks(subAccount, user2.address, DELAY, [SEL.allocate])
			expect(await view.unlockerOf(subAccount, SEL.internalTransfer)).to.equal(unlocker.address)
			expect(await view.unlockerOf(subAccount, SEL.allocate)).to.equal(user2.address)
			expect(await view.allTimelockedBy(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])).to.equal(true)
			expect(await view.allTimelockedBy(subAccount, user2.address, DELAY, [SEL.allocate])).to.equal(true)
			expect(await view.allTimelockedBy(subAccount, unlocker.address, DELAY, [SEL.internalTransfer, SEL.allocate])).to.equal(false)
			expect(await view.allTimelockedBy(subAccount, unlocker.address, DELAY + 1n, [SEL.internalTransfer])).to.equal(false)
			expect(await view.allTimelockedBy(subAccount, ZeroAddress, 0, [SEL.internalTransfer])).to.equal(false)
			expect(await view.allTimelockedBy(subAccount, unlocker.address, 0, [])).to.equal(false)
		})

		it("each inner op needs its own unlocker; a batch over two unlockers carries one approval per op", async function () {
			const tl = context.alTimelockFacet
			const core = context.alCoreFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			await tl.connect(user).setupTimelocks(subAccount, user2.address, DELAY, [SEL.allocate])
			const allocateHash = ethers.keccak256(allocateCd)
			const transferHash = ethers.keccak256(internalTransferCd)

			const allocateOnly = core.interface.encodeFunctionData("_call", [subAccount, [allocateCd]])
			const byWrongUnlocker = await signApproval(allocateHash, 60n, unlocker)
			await expect(tl.connect(user).executeTimelockOp([byWrongUnlocker], allocateOnly)).to.be.revertedWithCustomError(
				tl,
				"TimelockOpNotApprovedOrScheduled",
			)
			const byRightUnlocker = await signApproval(allocateHash, 60n, user2)
			await tl.connect(user).executeTimelockOp([byRightUnlocker], allocateOnly)

			// a batch touching both selectors needs both unlockers: each alone is refused, together they unlock it
			const mixed = core.interface.encodeFunctionData("_call", [subAccount, [allocateCd, internalTransferCd]])
			const a = await signApproval(transferHash, 60n, unlocker)
			await expect(tl.connect(user).executeTimelockOp([a], mixed))
				.to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
				.withArgs(subAccount, allocateHash)
			const b = await signApproval(allocateHash, 60n, user2)
			await expect(tl.connect(user).executeTimelockOp([b], mixed))
				.to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
				.withArgs(subAccount, transferHash)
			// a refused approval is not burned
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(a.approval))).to.equal(false)
			await tl.connect(user).executeTimelockOp([a, b], mixed)
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(a.approval))).to.equal(true)
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(b.approval))).to.equal(true)

			// the owner can also schedule it, one notice per timelocked inner op, without either unlocker
			await tl.connect(user).scheduleTimelockOp(subAccount, allocateHash)
			await tl.connect(user).scheduleTimelockOp(subAccount, transferHash)
			await time.increase(Number(DELAY))
			await core.connect(user)._call(subAccount, [allocateCd, internalTransferCd])

			// or mix: one unlocker's approval and a schedule for the other op
			await tl.connect(user).scheduleTimelockOp(subAccount, allocateHash)
			await time.increase(Number(DELAY))
			const c = await signApproval(transferHash, 60n, unlocker)
			await tl.connect(user).executeTimelockOp([c], mixed)
		})

		it("lowering a selector's delay or reassigning it needs its current unlocker", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY + 1n, [SEL.internalTransfer])

			const lower = tl.interface.encodeFunctionData("setupTimelocks", [subAccount, unlocker.address, DELAY, [SEL.internalTransfer]])
			const lowerByStranger = await signApproval(ethers.keccak256(lower), 60n, user2)
			await expect(tl.connect(user).executeTimelockOp([lowerByStranger], lower)).to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
			const lowerByUnlocker = await signApproval(ethers.keccak256(lower), 60n, unlocker)
			await tl.connect(user).executeTimelockOp([lowerByUnlocker], lower)
			expect((await view.getSelectorTimelock(subAccount, SEL.internalTransfer)).delay).to.equal(DELAY)

			const reassign = tl.interface.encodeFunctionData("setupTimelocks", [subAccount, user2.address, DELAY, [SEL.internalTransfer]])
			const byNewUnlocker = await signApproval(ethers.keccak256(reassign), 60n, user2)
			await expect(tl.connect(user).executeTimelockOp([byNewUnlocker], reassign)).to.be.revertedWithCustomError(
				tl,
				"TimelockOpNotApprovedOrScheduled",
			)
			const byCurrentUnlocker = await signApproval(ethers.keccak256(reassign), 60n, unlocker)
			await tl.connect(user).executeTimelockOp([byCurrentUnlocker], reassign)
			expect(await view.unlockerOf(subAccount, SEL.internalTransfer)).to.equal(user2.address)
		})

		it("rejects a previously signed approval after the selector moves to a new unlocker", async function () {
			const tl = context.alTimelockFacet
			const core = context.alCoreFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			const transferHash = ethers.keccak256(internalTransferCd)
			const oldApproval = await signApproval(transferHash, 600n, unlocker)

			const reassign = tl.interface.encodeFunctionData("setupTimelocks", [subAccount, user2.address, DELAY, [SEL.internalTransfer]])
			const reassignApproval = await signApproval(ethers.keccak256(reassign), 600n, unlocker)
			await tl.connect(user).executeTimelockOp([reassignApproval], reassign)

			const wrapped = core.interface.encodeFunctionData("_call", [subAccount, [internalTransferCd]])
			await expect(tl.connect(user).executeTimelockOp([oldApproval], wrapped)).to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
			expect(await view.isApprovalUsed(await view.hashTimelockApproval(oldApproval.approval))).to.equal(false)

			const currentApproval = await signApproval(transferHash, 60n, user2)
			await tl.connect(user).executeTimelockOp([currentApproval], wrapped)
		})

		it("clearing selectors of two unlockers in one call is one op that needs both unlockers' consent", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			await tl.connect(user).setupTimelocks(subAccount, user2.address, DELAY, [SEL.allocate])
			const clearBoth = tl.interface.encodeFunctionData("clearTimelocks", [subAccount, [SEL.internalTransfer, SEL.allocate]])
			const hash = ethers.keccak256(clearBoth)
			const a = await signApproval(hash, 60n, unlocker)
			const b = await signApproval(hash, 60n, user2)
			await expect(tl.connect(user).executeTimelockOp([a], clearBoth)).to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
			await expect(tl.connect(user).executeTimelockOp([a, b], clearBoth))
				.to.emit(tl, "TimelockOpExecuted")
				.withArgs(subAccount, hash)
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(false)
			expect(await view.isTimelocked(subAccount, SEL.allocate)).to.equal(false)
		})

		it("one unlocker guarding two cleared selectors consents once, not twice", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer, SEL.allocate])
			const clearBoth = tl.interface.encodeFunctionData("clearTimelocks", [subAccount, [SEL.internalTransfer, SEL.allocate]])
			const hash = ethers.keccak256(clearBoth)

			// Exactly one signature over the op covers both of that unlocker's selectors.
			const one = await signApproval(hash, 60n, unlocker)
			await expect(tl.connect(user).executeTimelockOp([one], clearBoth))
				.to.emit(tl, "TimelockOpExecuted")
				.withArgs(subAccount, hash)
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(false)
			expect(await view.isTimelocked(subAccount, SEL.allocate)).to.equal(false)
		})

		it("a policy change over two unlockers takes one approval and the schedule for the other", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			await tl.connect(user).setupTimelocks(subAccount, user2.address, DELAY * 2n, [SEL.allocate])
			const clearBoth = tl.interface.encodeFunctionData("clearTimelocks", [subAccount, [SEL.internalTransfer, SEL.allocate]])
			const hash = ethers.keccak256(clearBoth)
			await tl.connect(user).scheduleTimelockOp(subAccount, hash)
			// the schedule has to wait the delay of the unlocker who did not approve, not the approving one's
			await time.increase(Number(DELAY))
			const early = await signApproval(hash, 60n, unlocker)
			await expect(tl.connect(user).executeTimelockOp([early], clearBoth)).to.be.revertedWithCustomError(tl, "ScheduleNotReady")
			await time.increase(Number(DELAY))
			const a = await signApproval(hash, 60n, unlocker)
			await tl.connect(user).executeTimelockOp([a], clearBoth)
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(false)
			expect(await view.isTimelocked(subAccount, SEL.allocate)).to.equal(false)
		})

		it("clearing two locks uses one policy-change schedule after the longest affected delay", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY * 2n, [SEL.allocate])
			const selectors = [SEL.internalTransfer, SEL.allocate]
			const clearHash = ethers.keccak256(tl.interface.encodeFunctionData("clearTimelocks", [subAccount, selectors]))
			await tl.connect(user).scheduleTimelockOp(subAccount, clearHash)
			const readyAt = (await view.getSchedule(subAccount, clearHash)).scheduledAt + DELAY * 2n

			await time.increase(Number(DELAY))
			await expect(tl.connect(user).clearTimelocks(subAccount, selectors))
				.to.be.revertedWithCustomError(tl, "ScheduleNotReady")
				.withArgs(subAccount, clearHash, readyAt)
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(true)
			expect(await view.isTimelocked(subAccount, SEL.allocate)).to.equal(true)

			await time.increase(Number(DELAY))
			await expect(tl.connect(user).clearTimelocks(subAccount, selectors)).to.emit(tl, "TimelockOpExecuted").withArgs(subAccount, clearHash)
			expect(await view.isTimelocked(subAccount, SEL.internalTransfer)).to.equal(false)
			expect(await view.isTimelocked(subAccount, SEL.allocate)).to.equal(false)
			expect((await view.getSchedule(subAccount, clearHash)).scheduledAt).to.equal(0n)
		})

		it("clearing selectors needs each selector's own unlocker", async function () {
			const tl = context.alTimelockFacet
			await tl.connect(user).setupTimelocks(subAccount, unlocker.address, DELAY, [SEL.internalTransfer])
			await tl.connect(user).setupTimelocks(subAccount, user2.address, DELAY, [SEL.allocate])
			const clearAllocate = tl.interface.encodeFunctionData("clearTimelocks", [subAccount, [SEL.allocate]])
			const wrong = await signApproval(ethers.keccak256(clearAllocate), 60n, unlocker)
			await expect(tl.connect(user).executeTimelockOp([wrong], clearAllocate)).to.be.revertedWithCustomError(tl, "TimelockOpNotApprovedOrScheduled")
			const right = await signApproval(ethers.keccak256(clearAllocate), 60n, user2)
			await tl.connect(user).executeTimelockOp([right], clearAllocate)
			expect(await view.unlockerOf(subAccount, SEL.allocate)).to.equal(ZeroAddress)
			// clearing an already ungated selector is a no-op that needs no window
			await tl.connect(user).clearTimelocks(subAccount, [SEL.allocate])
		})
	})
})
