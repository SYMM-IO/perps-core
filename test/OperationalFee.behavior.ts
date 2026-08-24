import { expect } from "chai"
import { ethers, TypedDataDomain } from "ethers"

import type { InstantLayer } from "../src/types/index.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { ethers as hreEthers } from "./helpers/hardhat-connection.js"
import { cloneTypes } from "./helpers/instantLayerEIP712Types.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { getBlockTimestamp } from "./utils/Common.js"
import { decimal } from "./utils/Common.js"

// OperationalFeeCharged + BalanceChangePartyA are emitted from SharedEvents (an internal library),
// so their ABI entries are not on the facet contract handles. Build standalone Interfaces
// from the event signatures and parse raw receipt logs — same approach as SolverFee.behavior.ts.
const operationalFeeEventInterface = new ethers.Interface([
	"event OperationalFeeCharged(address indexed payer, address indexed charger, address receiver, uint256 amount)",
])
const partyABalanceChangeInterface = new ethers.Interface(["event BalanceChangePartyA(address indexed partyA, uint256 amount, uint8 _type)"])
// SharedEvents.BalanceChangeType.OPERATIONAL_FEE_OUT
const OPERATIONAL_FEE_OUT = 15n

function parseLogs(receipt: any, iface: ethers.Interface, name: string): any[] {
	return receipt.logs.flatMap((log: any) => {
		try {
			const parsed = iface.parseLog(log)
			return parsed?.name === name ? [parsed] : []
		} catch {
			return []
		}
	})
}

export function shouldBehaveLikeOperationalFee(): void {
	let context: RunContext, user: User, hedger: Hedger
	let charger: string, admin: any

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		admin = context.signers.admin
		user = new User(context, context.signers.user)
		await user.setup()
		// setBalances(collateralAmount, depositAmount, allocatedAmount):
		//   mints 3000, deposits 2000 → free=2000, allocates 1500 → free=500, allocated=1500
		await user.setBalances(decimal(3000n), decimal(2000n), decimal(1500n))
		hedger = new Hedger(context, context.signers.hedger)
		await hedger.setup()
		await hedger.setBalances(decimal(4000n), decimal(4000n))
		charger = context.signers.user2.address
	})

	describe("Charger registry", () => {
		it("registers and unregisters a charger only via FEE_ADMIN_ROLE", async function () {
			expect(await (context.viewFacet as any).isOperationalFeeCharger(charger)).to.equal(false)

			await expect((context.controlFacet.connect(user.signer) as any).registerOperationalFeeCharger(charger)).to.be.revertedWith(
				"Accessibility: Must have role",
			)

			await expect((context.controlFacet.connect(admin) as any).registerOperationalFeeCharger(charger))
				.to.emit(context.controlFacet, "OperationalFeeChargerRegistered")
				.withArgs(charger)
			expect(await (context.viewFacet as any).isOperationalFeeCharger(charger)).to.equal(true)

			await expect((context.controlFacet.connect(admin) as any).unregisterOperationalFeeCharger(charger))
				.to.emit(context.controlFacet, "OperationalFeeChargerUnregistered")
				.withArgs(charger)
			expect(await (context.viewFacet as any).isOperationalFeeCharger(charger)).to.equal(false)
		})

		it("treats registered PartyBs as operational-fee chargers by default", async function () {
			const hedgerAddr = await hedger.getAddress()
			expect(await (context.viewFacet as any).isOperationalFeeCharger(hedgerAddr)).to.equal(true)

			await expect((context.controlFacet.connect(admin) as any).registerOperationalFeeCharger(hedgerAddr)).to.be.revertedWith(
				"ControlFacet: Already a charger",
			)
		})
	})

	describe("Allowance grant", () => {
		beforeEach(async function () {
			await (context.controlFacet.connect(admin) as any).registerOperationalFeeCharger(charger)
		})

		it("ignores allowance state stored in the deprecated mapping slot", async function () {
			const payer = await user.getAddress()
			const diamond = context.diamond
			const coder = ethers.AbiCoder.defaultAbiCoder()
			const layoutSlot = BigInt(ethers.keccak256(ethers.toUtf8Bytes("diamond.standard.storage.operationalfee")))
			const payerMappingSlot = ethers.keccak256(coder.encode(["address", "uint256"], [payer, layoutSlot]))
			const legacyAllowanceSlot = ethers.keccak256(coder.encode(["address", "bytes32"], [charger, payerMappingSlot]))
			const legacyAllowance = decimal(123n)

			await hreEthers.provider.send("hardhat_setStorageAt", [diamond, legacyAllowanceSlot, ethers.zeroPadValue(ethers.toBeHex(legacyAllowance), 32)])

			expect((await (context.viewFacet as any).getOperationalFeeAllowance(payer, charger)).allowance).to.equal(0n)
			await (context.accountFacet.connect(user.signer) as any).approveOperationalFee([charger], [decimal(7n)])
			expect((await (context.viewFacet as any).getOperationalFeeAllowance(payer, charger)).allowance).to.equal(decimal(7n))
			expect(BigInt(await hreEthers.provider.getStorage(diamond, legacyAllowanceSlot))).to.equal(legacyAllowance)
		})

		it("defaults the fee multiplier to 1x", async function () {
			const payerAddress = await user.getAddress()

			const view = await (context.viewFacet as any).getOperationalFeeAllowance(payerAddress, charger)
			expect(view.feeMultiplier).to.equal(10000n)
		})

		it("sets and raises an allowance instantly and exposes it via the view", async function () {
			const facet = context.accountFacet as any
			const payerAddress = await user.getAddress()

			await expect(facet.connect(user.signer).approveOperationalFee([charger], [decimal(100n)]))
				.to.emit(context.accountFacet, "OperationalFeeAllowanceSet")
				.withArgs(payerAddress, charger, decimal(100n))

			let view = await (context.viewFacet as any).getOperationalFeeAllowance(payerAddress, charger)
			expect(view.allowance).to.equal(decimal(100n))

			// raising is instant: new allowance > current -> immediate, no pending reduction
			await facet.connect(user.signer).approveOperationalFee([charger], [decimal(250n)])
			view = await (context.viewFacet as any).getOperationalFeeAllowance(payerAddress, charger)
			expect(view.allowance).to.equal(decimal(250n))
			expect(view.reductionReadyAt).to.equal(0n)
		})

		it("sets an allowance and fee multiplier together", async function () {
			const facet = context.accountFacet as any
			const payerAddress = await user.getAddress()

			await expect(facet.connect(user.signer).approveOperationalFeeWithMultiplier([charger], [decimal(100n)], [11000]))
				.to.emit(context.accountFacet, "OperationalFeeMultiplierSet")
				.withArgs(payerAddress, charger, 11000)

			const view = await (context.viewFacet as any).getOperationalFeeAllowance(payerAddress, charger)
			expect(view.allowance).to.equal(decimal(100n))
			expect(view.feeMultiplier).to.equal(11000n)
		})
	})

	describe("chargeOperationalFee", () => {
		let chargerSigner: any

		beforeEach(async function () {
			// Use signers.others[0] as the charger so we have a live signer to connect with
			chargerSigner = context.signers.others[0]
			charger = chargerSigner.address
			await (context.controlFacet.connect(admin) as any).registerOperationalFeeCharger(charger)
			// user now has free=500 (deposited 2000, allocated 1500) and allocated=1500
		})

		it("rejects an unregistered charger", async function () {
			const stranger = context.signers.others[1]
			await expect((context.accountFacet.connect(stranger) as any).chargeOperationalFee(await user.getAddress(), decimal(1n))).to.be.revertedWith(
				"OperationalFee: Not a registered charger",
			)
		})

		it("draws free balance first, credits the charger, and consumes allowance", async function () {
			const payer = await user.getAddress()
			await (context.accountFacet.connect(user.signer) as any).approveOperationalFee([charger], [decimal(100n)])

			// free = 500, allocated = 1500 at this point
			const freeBefore = await context.viewFacet.balanceOf(payer)
			const allocatedBefore = (await user.getBalanceInfo()).allocatedBalances
			const chargerBalanceBefore = await context.viewFacet.balanceOf(charger)

			// charge 2 - should come entirely from free (free=500 > 2)
			const tx = await (context.accountFacet.connect(chargerSigner) as any).chargeOperationalFee(payer, decimal(2n))
			const receipt = await tx.wait()

			// OperationalFeeCharged is emitted from SharedEvents (internal library), so its ABI is not on the
			// facet handle - parse it (and BalanceChangePartyA) from the raw receipt logs.
			const charged = parseLogs(receipt, operationalFeeEventInterface, "OperationalFeeCharged")
			expect(charged.length).to.equal(1)
			expect(charged[0].args.payer).to.equal(payer)
			expect(charged[0].args.charger).to.equal(charger)
			expect(charged[0].args.receiver).to.equal(charger) // default receiver = charger
			expect(charged[0].args.amount).to.equal(decimal(2n))

			const balanceChanges = parseLogs(receipt, partyABalanceChangeInterface, "BalanceChangePartyA").filter(p => p.args._type === OPERATIONAL_FEE_OUT)
			expect(balanceChanges).to.have.length(0)

			expect(await context.viewFacet.balanceOf(payer)).to.equal(freeBefore - decimal(2n))
			expect((await user.getBalanceInfo()).allocatedBalances).to.equal(allocatedBefore) // allocated untouched
			expect(await context.viewFacet.balanceOf(charger)).to.equal(chargerBalanceBefore + decimal(2n))

			const view = await (context.viewFacet as any).getOperationalFeeAllowance(payer, charger)
			expect(view.allowance).to.equal(decimal(98n))
		})

		it("sets a fresh remaining allowance after prior charges", async function () {
			const payer = await user.getAddress()
			const facet = context.accountFacet as any

			await facet.connect(user.signer).approveOperationalFee([charger], [decimal(100n)])
			await facet.connect(chargerSigner).chargeOperationalFee(payer, decimal(60n))
			expect((await (context.viewFacet as any).getOperationalFeeAllowance(payer, charger)).allowance).to.equal(decimal(40n))

			// Like ERC20 approve, the absolute setter replaces the remaining spend authority.
			await facet.connect(user.signer).approveOperationalFee([charger], [decimal(100n)])
			expect((await (context.viewFacet as any).getOperationalFeeAllowance(payer, charger)).allowance).to.equal(decimal(100n))
		})

		it("spills into allocated when free is insufficient, then reverts past total balance", async function () {
			const payer = await user.getAddress()
			// Need an allowance large enough to cover free + partial allocated
			await (context.accountFacet.connect(user.signer) as any).approveOperationalFee([charger], [decimal(5000n)])

			const free = await context.viewFacet.balanceOf(payer) // 500
			const alloc = (await user.getBalanceInfo()).allocatedBalances // 1500

			// charge free + 100 allocated
			const tx = await (context.accountFacet.connect(chargerSigner) as any).chargeOperationalFee(payer, free + decimal(100n))
			const receipt = await tx.wait()
			const balanceChanges = parseLogs(receipt, partyABalanceChangeInterface, "BalanceChangePartyA").filter(p => p.args._type === OPERATIONAL_FEE_OUT)
			expect(balanceChanges).to.have.length(1)
			expect(balanceChanges[0].args.partyA).to.equal(payer)
			expect(balanceChanges[0].args.amount).to.equal(decimal(100n))
			expect(await context.viewFacet.balanceOf(payer)).to.equal(0n)
			expect((await user.getBalanceInfo()).allocatedBalances).to.equal(alloc - decimal(100n))

			// charging beyond remaining allocated reverts on the balance guard
			const remainingAlloc = (await user.getBalanceInfo()).allocatedBalances
			await expect((context.accountFacet.connect(chargerSigner) as any).chargeOperationalFee(payer, remainingAlloc + decimal(1n))).to.be.revertedWith(
				"OperationalFee: Insufficient balance",
			)
		})

		it("reverts when the remaining allowance is exceeded", async function () {
			const payer = await user.getAddress()
			await (context.accountFacet.connect(user.signer) as any).approveOperationalFee([charger], [decimal(3n)])
			await (context.accountFacet.connect(chargerSigner) as any).chargeOperationalFee(payer, decimal(2n))
			await expect((context.accountFacet.connect(chargerSigner) as any).chargeOperationalFee(payer, decimal(2n))).to.be.revertedWith(
				"OperationalFee: Allowance exceeded",
			)
		})

		it("reverts a zero-amount charge", async function () {
			await (context.accountFacet.connect(user.signer) as any).approveOperationalFee([charger], [decimal(3n)])
			await expect((context.accountFacet.connect(chargerSigner) as any).chargeOperationalFee(await user.getAddress(), 0n)).to.be.revertedWith(
				"OperationalFee: Zero amount",
			)
		})

		// no external-call surface in chargeOperationalFee; the core charge path does not use a reentrancy modifier
	})

	describe("Fee receiver", () => {
		let chargerSigner: any

		beforeEach(async function () {
			chargerSigner = context.signers.others[0]
			charger = chargerSigner.address
			await (context.controlFacet.connect(admin) as any).registerOperationalFeeCharger(charger)
			await (context.accountFacet.connect(user.signer) as any).approveOperationalFee([charger], [decimal(100n)])
		})

		it("defaults to the charger and routes to a configured receiver", async function () {
			const facet = context.accountFacet as any

			// getOperationalFeeReceiver lives on viewFacet
			expect(await (context.viewFacet as any).getOperationalFeeReceiver(charger)).to.equal(charger)

			const receiver = context.signers.feeCollector.address
			await expect((context.controlFacet.connect(chargerSigner) as any).setOperationalFeeReceiver(charger, receiver))
				.to.emit(context.controlFacet, "SetOperationalFeeReceiver")
				.withArgs(charger, receiver)
			expect(await (context.viewFacet as any).getOperationalFeeReceiver(charger)).to.equal(receiver)

			// charge should now credit the receiver, not the charger
			const receiverBalanceBefore = await context.viewFacet.balanceOf(receiver)
			await facet.connect(chargerSigner).chargeOperationalFee(await user.getAddress(), decimal(2n))
			expect(await context.viewFacet.balanceOf(receiver)).to.equal(receiverBalanceBefore + decimal(2n))
		})

		it("credits receiver after setOperationalFeeReceiver; charger balance stays flat", async function () {
			const facet = context.accountFacet as any
			const payer = await user.getAddress()
			const receiver = context.signers.feeCollector.address
			await (context.controlFacet.connect(chargerSigner) as any).setOperationalFeeReceiver(charger, receiver)

			const chargerBalanceBefore = await context.viewFacet.balanceOf(charger)
			const receiverBalanceBefore = await context.viewFacet.balanceOf(receiver)

			const tx = await facet.connect(chargerSigner).chargeOperationalFee(payer, decimal(2n))
			const receipt = await tx.wait()

			// OperationalFeeCharged carries the configured receiver (parsed from raw logs - SharedEvents library)
			const charged = parseLogs(receipt, operationalFeeEventInterface, "OperationalFeeCharged")
			expect(charged.length).to.equal(1)
			expect(charged[0].args.payer).to.equal(payer)
			expect(charged[0].args.charger).to.equal(charger)
			expect(charged[0].args.receiver).to.equal(receiver) // routed to the configured receiver, not the charger
			expect(charged[0].args.amount).to.equal(decimal(2n))

			expect(await context.viewFacet.balanceOf(receiver)).to.equal(receiverBalanceBefore + decimal(2n))
			expect(await context.viewFacet.balanceOf(charger)).to.equal(chargerBalanceBefore) // charger itself gets nothing
		})

		it("allows a registered PartyB to configure an operational-fee receiver without explicit charger registration", async function () {
			const hedgerAddr = await hedger.getAddress()
			const receiver = context.signers.feeCollector.address

			await expect((context.controlFacet.connect(hedger.signer) as any).setOperationalFeeReceiver(hedgerAddr, receiver))
				.to.emit(context.controlFacet, "SetOperationalFeeReceiver")
				.withArgs(hedgerAddr, receiver)

			expect(await (context.viewFacet as any).getOperationalFeeReceiver(hedgerAddr)).to.equal(receiver)
		})

		it("rejects routing a payer's operational fee back to the payer", async function () {
			const payer = await user.getAddress()
			const free = await context.viewFacet.balanceOf(payer)

			await (context.accountFacet.connect(user.signer) as any).approveOperationalFee([charger], [decimal(5000n)])
			await (context.controlFacet.connect(chargerSigner) as any).setOperationalFeeReceiver(charger, payer)

			await expect((context.accountFacet.connect(chargerSigner) as any).chargeOperationalFee(payer, free + decimal(100n))).to.be.revertedWith(
				"OperationalFee: Receiver is payer",
			)
		})

		it("rejects a non-charger setting a receiver", async function () {
			await expect(
				(context.controlFacet.connect(user.signer) as any).setOperationalFeeReceiver(user.signer.address, user.signer.address),
			).to.be.revertedWith("OperationalFee: Not a registered charger")
		})

		it("allows FEE_ADMIN_ROLE to set a charger's receiver on its behalf", async function () {
			const receiver = context.signers.feeCollector.address

			await expect((context.controlFacet.connect(admin) as any).setOperationalFeeReceiver(charger, receiver))
				.to.emit(context.controlFacet, "SetOperationalFeeReceiver")
				.withArgs(charger, receiver)

			expect(await (context.viewFacet as any).getOperationalFeeReceiver(charger)).to.equal(receiver)
		})

		it("rejects an unauthorized third party setting another charger's receiver", async function () {
			await expect((context.controlFacet.connect(user.signer) as any).setOperationalFeeReceiver(charger, user.signer.address)).to.be.revertedWith(
				"ControlFacet: Not authorized",
			)
		})

		it("resets to the charger itself when the receiver is cleared", async function () {
			const receiver = context.signers.feeCollector.address
			await (context.controlFacet.connect(chargerSigner) as any).setOperationalFeeReceiver(charger, receiver)
			expect(await (context.viewFacet as any).getOperationalFeeReceiver(charger)).to.equal(receiver)

			await (context.controlFacet.connect(chargerSigner) as any).setOperationalFeeReceiver(charger, ethers.ZeroAddress)
			expect(await (context.viewFacet as any).getOperationalFeeReceiver(charger)).to.equal(charger)
		})
	})

	describe("Timelocked reduction", () => {
		let chargerSigner: any
		const DELAY = 300 // seconds

		beforeEach(async function () {
			chargerSigner = context.signers.others[0]
			charger = chargerSigner.address
			await (context.controlFacet.connect(admin) as any).registerOperationalFeeCharger(charger)
			await (context.controlFacet.connect(admin) as any).setOperationalFeeReductionDelay(DELAY)
			// grant a large initial allowance so a reduction below it will be timelocked
			await (context.accountFacet.connect(user.signer) as any).approveOperationalFee([charger], [decimal(100n)])
		})

		it("schedules a reduction without lowering the live allowance (front-run defeated)", async function () {
			const facet = context.accountFacet as any
			const payer = await user.getAddress()

			// requesting a reduction schedules it
			await expect(facet.connect(user.signer).approveOperationalFee([charger], [decimal(1n)])).to.emit(
				context.accountFacet,
				"OperationalFeeAllowanceReductionRequested",
			)

			const view = await (context.viewFacet as any).getOperationalFeeAllowance(payer, charger)
			expect(view.allowance).to.equal(decimal(100n)) // live allowance unchanged
			expect(view.pendingAllowance).to.equal(decimal(1n))
			expect(view.reductionReadyAt).to.be.greaterThan(0n)

			// a charge within the window still succeeds against the live allowance
			await facet.connect(chargerSigner).chargeOperationalFee(payer, decimal(50n))
		})

		it("applies the reduction lazily on the next charge after the delay", async function () {
			const facet = context.accountFacet as any
			const payer = await user.getAddress()

			// schedule reduction to allowance=1
			await facet.connect(user.signer).approveOperationalFee([charger], [decimal(1n)])

			// advance time past the delay
			await time.increase(DELAY + 1)

			// now effective allowance = 1; charged = 0; charging 2 must exceed the new allowance
			await expect(facet.connect(chargerSigner).chargeOperationalFee(payer, decimal(2n))).to.be.revertedWith("OperationalFee: Allowance exceeded")

			// charging exactly 1 (the new allowance) succeeds
			await facet.connect(chargerSigner).chargeOperationalFee(payer, decimal(1n))
		})

		it("views a ready reduction as already effective before any state-changing charge", async function () {
			const facet = context.accountFacet as any
			const payer = await user.getAddress()

			await facet.connect(user.signer).approveOperationalFee([charger], [decimal(10n)])

			await time.increase(DELAY + 1)

			const view = await (context.viewFacet as any).getOperationalFeeAllowance(payer, charger)
			expect(view.allowance).to.equal(decimal(10n))
			expect(view.pendingAllowance).to.equal(0n)
			expect(view.reductionReadyAt).to.equal(0n)
		})

		it("does not replenish allowance consumed while a reduction is pending", async function () {
			const facet = context.accountFacet as any
			const payer = await user.getAddress()

			await facet.connect(user.signer).approveOperationalFee([charger], [decimal(20n)])
			await facet.connect(chargerSigner).chargeOperationalFee(payer, decimal(90n))
			expect((await (context.viewFacet as any).getOperationalFeeAllowance(payer, charger)).allowance).to.equal(decimal(10n))

			await time.increase(DELAY + 1)

			const view = await (context.viewFacet as any).getOperationalFeeAllowance(payer, charger)
			expect(view.allowance).to.equal(decimal(10n))
			expect(view.pendingAllowance).to.equal(0n)
			expect(view.reductionReadyAt).to.equal(0n)
			await expect(facet.connect(chargerSigner).chargeOperationalFee(payer, decimal(11n))).to.be.revertedWith("OperationalFee: Allowance exceeded")
		})

		it("cancels a pending reduction when raised back above the current live allowance", async function () {
			const facet = context.accountFacet as any
			const payer = await user.getAddress()

			// schedule a reduction (100 -> 1)
			await facet.connect(user.signer).approveOperationalFee([charger], [decimal(1n)])
			let view = await (context.viewFacet as any).getOperationalFeeAllowance(payer, charger)
			expect(view.reductionReadyAt).to.be.greaterThan(0n)

			// raise back to 200 -> instant + clears pending
			await facet.connect(user.signer).approveOperationalFee([charger], [decimal(200n)])
			view = await (context.viewFacet as any).getOperationalFeeAllowance(payer, charger)
			expect(view.allowance).to.equal(decimal(200n))
			expect(view.reductionReadyAt).to.equal(0n)
		})

		it("unregistering a charger instantly blocks further charges", async function () {
			const facet = context.accountFacet as any
			await (context.controlFacet.connect(admin) as any).unregisterOperationalFeeCharger(charger)
			await expect(facet.connect(chargerSigner).chargeOperationalFee(await user.getAddress(), decimal(1n))).to.be.revertedWith(
				"OperationalFee: Not a registered charger",
			)
		})

		it("applying a reduction if delay is zero makes it immediate", async function () {
			// set delay to zero so reductions are immediate
			await (context.controlFacet.connect(admin) as any).setOperationalFeeReductionDelay(0)
			const facet = context.accountFacet as any
			const payer = await user.getAddress()

			// requesting a reduction with delay=0 should apply immediately -> OperationalFeeAllowanceSet
			await expect(facet.connect(user.signer).approveOperationalFee([charger], [decimal(5n)]))
				.to.emit(context.accountFacet, "OperationalFeeAllowanceSet")
				.withArgs(payer, charger, decimal(5n))

			const view = await (context.viewFacet as any).getOperationalFeeAllowance(payer, charger)
			expect(view.allowance).to.equal(decimal(5n))
			expect(view.reductionReadyAt).to.equal(0n)
		})
	})

	describe("Solver as a standalone charger", () => {
		// The solver is a registered PartyB, so it is an operational-fee charger by default. It charges the standing operational-fee allowance
		// through AccountFacet.chargeOperationalFee (msg.sender = the solver).
		it("charges an approved third-party payer without touching quote partyA", async function () {
			const hedgerAddr = await hedger.getAddress()

			// Set up a second funded account (the third-party payer).
			// context.signers.user2 already exists; create a User on it and fund it.
			const thirdPartyPayer = new User(context, context.signers.user2)
			await thirdPartyPayer.setup()
			// Mint 1000, deposit 800 -> free = 800 (no allocation needed for payer role)
			await thirdPartyPayer.setBalances(decimal(1000n), decimal(800n))
			const thirdPartyPayerAddress = await thirdPartyPayer.getAddress()

			// Third-party grants allowance to the hedger (the solver).
			await (context.accountFacet.connect(context.signers.user2) as any).approveOperationalFee([hedgerAddr], [decimal(10n)])

			// PartyA is read for balance assertions only - it must be untouched by a third-party charge.
			const partyAAddr = await user.getAddress()
			const operationalFee = decimal(5n, 17) // 0.5 tokens

			// Snapshot balances before
			const thirdPartyPayerFreeBefore = await context.viewFacet.balanceOf(thirdPartyPayerAddress)
			const partyAFreeBefore = await context.viewFacet.balanceOf(partyAAddr)
			const partyAAllocatedBefore = (await user.getBalanceInfo()).allocatedBalances
			const hedgerBalanceBefore = await context.viewFacet.balanceOf(hedgerAddr)

			// Solver charges the third-party payer directly via chargeOperationalFee (msg.sender = hedger = charger)
			await (context.accountFacet.connect(hedger.signer) as any).chargeOperationalFee(thirdPartyPayerAddress, operationalFee)

			// Third-party payer's free balance dropped by operational fee
			const thirdPartyPayerFreeAfter = await context.viewFacet.balanceOf(thirdPartyPayerAddress)
			expect(thirdPartyPayerFreeBefore - thirdPartyPayerFreeAfter).to.equal(operationalFee)

			// PartyA's free balance was NOT touched by the operational fee
			const partyAFreeAfter = await context.viewFacet.balanceOf(partyAAddr)
			expect(partyAFreeAfter).to.equal(partyAFreeBefore)

			// PartyA's allocated balance was NOT touched by the operational fee
			const partyAAllocatedAfter = (await user.getBalanceInfo()).allocatedBalances
			expect(partyAAllocatedAfter).to.equal(partyAAllocatedBefore)

			// Hedger (default receiver = charger) balance rose by operational fee
			const hedgerBalanceAfter = await context.viewFacet.balanceOf(hedgerAddr)
			expect(hedgerBalanceAfter - hedgerBalanceBefore).to.equal(operationalFee)

			// The charge consumes the payer's remaining allowance for this solver.
			const view = await (context.viewFacet as any).getOperationalFeeAllowance(thirdPartyPayerAddress, hedgerAddr)
			expect(view.allowance).to.equal(decimal(10n) - operationalFee)
		})

		it("blocks a solver from charging a suspended third-party payer", async function () {
			const hedgerAddr = await hedger.getAddress()

			// Set up a funded third-party payer on context.signers.user2.
			const suspendedPayer = new User(context, context.signers.user2)
			await suspendedPayer.setup()
			await suspendedPayer.setBalances(decimal(1000n), decimal(800n))
			const suspendedPayerAddress = await suspendedPayer.getAddress()

			// Third-party grants an allowance to the hedger so the only thing that can block the charge is the suspend guard
			await (context.accountFacet.connect(context.signers.user2) as any).approveOperationalFee([hedgerAddr], [decimal(10n)])

			// Suspend the third-party payer (admin holds SUSPENDER_ROLE from the fixture grant loop)
			await context.pauseControlFacet.connect(admin).suspendedAddress(suspendedPayerAddress)

			// Solver attempts to charge the suspended payer directly via chargeOperationalFee - must revert
			await expect(
				(context.accountFacet.connect(hedger.signer) as any).chargeOperationalFee(suspendedPayerAddress, decimal(5n, 17)),
			).to.be.revertedWith("OperationalFee: Payer suspended")
		})

		it("grants operational-fee allowance and multiplier through an InstantLayer signed operation", async function () {
			// Replicate the minimal InstantLayer execution context.
			// The fixture grants admin OPERATOR_ROLE on InstantLayer (from its constructor)
			// but does NOT grant the InstantLayer contract itself INSTANT_LAYER_ROLE on core
			// (that is only granted in InstantLayer.behavior.ts beforeEach).
			// We must grant it here so executeBatch can call core.setCallFromInstantLayer().
			const instantLayerAddr = await context.instantLayer.getAddress()
			await context.controlFacet.connect(admin).grantRole(instantLayerAddr, ethers.keccak256(ethers.toUtf8Bytes("INSTANT_LAYER_ROLE")))

			// Register a charger — use context.signers.others[0] as the charger
			const chargerSigner = context.signers.others[0]
			const chargerAddr = chargerSigner.address
			await (context.controlFacet.connect(admin) as any).registerOperationalFeeCharger(chargerAddr)

			// Create a sub-account via accountManager (same pattern as InstantLayer.behavior.ts).
			// The sub-account owner is context.signers.user (the EOA that calls addAccount).
			await context.accountManager.connect(context.signers.user).addAccount("opFeeTestAccount")
			const accounts = await context.accountManager.getAccounts(context.signers.user.address, 0, 100)
			const subAccountAddr = accounts[accounts.length - 1].accountAddress

			// Build the EIP-712 domain and types (mirrors InstantLayer.behavior.ts exactly)
			const domain: TypedDataDomain = {
				name: "SymmioInstantLayer",
				version: "1",
				chainId: (await hreEthers.provider.getNetwork()).chainId,
				verifyingContract: instantLayerAddr,
			}
			const types = cloneTypes()

			const newAllowance = decimal(10n)
			const feeMultiplier = 11000n
			const deadline = await getBlockTimestamp(300n)

			// Encode approveOperationalFeeWithMultiplier([charger], [newAllowance], [feeMultiplier]) on the core diamond.
			// When InstantLayer routes this via accountLayer._call(subAccountAddr, ...),
			// LibAccountLayerUtils.executeWithSigner sets core's globalSigner = subAccountAddr,
			// so LibSigner.getSigner() returns subAccountAddr and the allowance lands there.
			const allowanceCallData = (context.accountFacet as any).interface.encodeFunctionData("approveOperationalFeeWithMultiplier", [
				[chargerAddr],
				[newAllowance],
				[feeMultiplier],
			])

			// Build the SignedOperation:
			//   signer            = context.signers.user (EOA owner of subAccountAddr)
			//   target            = context.diamond (core - triggers accountLayer._call routing)
			//   signerAccount.addr = subAccountAddr (InstantLayer resolves owner -> sets core signer to subAccountAddr)
			const signedOp: InstantLayer.SignedOperationStruct = {
				signer: context.signers.user.address,
				target: context.diamond,
				callData: allowanceCallData,
				signerAccount: { addr: subAccountAddr, isPartyB: false },
				flexFields: [],
				maxUses: 1,
				replayAttackHeader: {
					nonce: 1n,
					deadline,
					salt: ethers.hexlify(ethers.randomBytes(32)),
				},
			}

			// Sign with the sub-account owner (context.signers.user)
			const sig = await context.signers.user.signTypedData(domain, types, signedOp)

			// Execute the batch as the operator (admin has OPERATOR_ROLE on InstantLayer from its constructor)
			await expect(context.instantLayer.executeBatch([signedOp], [sig], [[]], [[]])).not.to.be.reverted

			// Assert: the allowance landed on the sub-account (getSigner() resolved to subAccountAddr)
			const view = await (context.viewFacet as any).getOperationalFeeAllowance(subAccountAddr, chargerAddr)
			expect(view.allowance).to.equal(newAllowance)
			expect(view.feeMultiplier).to.equal(feeMultiplier)
		})
	})
}
