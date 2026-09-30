import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { initializeLegacyPauseFixture } from "../helpers/legacy-pause-fixture.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { User } from "../models/User.js"

// Independent permission specification: a holder can stop only its assigned scope.
const permissions = [
	["GLOBAL_PAUSER_ROLE", "Global"],
	["PARTY_A_PAUSER_ROLE", "PartyAActions"],
	["PARTY_B_PAUSER_ROLE", "PartyBActions"],
	["PARTY_B_OPENING_PAUSER_ROLE", "PartyBOpenPositions"],
	["PARTY_B_OPENING_PAUSER_ROLE", "PartyBOpenPositionsFor"],
	["ACCOUNTING_PAUSER_ROLE", "Accounting"],
	["INTERNAL_TRANSFER_PAUSER_ROLE", "InternalTransfer"],
	["EXTERNAL_TRANSFER_PAUSER_ROLE", "ExternalTransfer"],
	["LIQUIDATION_PAUSER_ROLE", "Liquidation"],
	["INSTANT_LAYER_PAUSER_ROLE", "InstantLayer"],
	["WITHDRAW_ADVANCE_PAUSER_ROLE", "WithdrawAdvance"],
] as const
const missingRole = "Accessibility: Must have role"

describe("Core granular pause authority", function () {
	it("covers every pause entry point in the public ABI", async function () {
		const context = await loadFixture(initializeFixture)
		const actual = context.pauseControlFacet.interface.fragments
			.filter(f => f.type === "function")
			.map(f => f.format("sighash").split("(")[0])
			.filter(name => name.startsWith("pause"))
		expect(actual.sort()).to.deep.equal(permissions.map(([, scope]) => `pause${scope}`).sort())
	})

	for (const role of new Set(permissions.map(([role]) => role))) {
		it(`${role} can pause only its scope, cannot resume, and loses access on revocation`, async function () {
			const context = await loadFixture(initializeFixture)
			const operator = context.signers.user2
			const target = context.signers.hedger.address
			const pause = context.pauseControlFacet.connect(operator)
			await context.controlFacet.grantRole(operator.address, ethers.id(role))
			for (const [required, scope] of permissions) {
				const args = scope === "PartyBOpenPositionsFor" ? [target] : []
				const call = pause.getFunction(`pause${scope}`)(...args)
				if (required === role) {
					const event = scope === "PartyBOpenPositionsFor" ? "SetPartyBOpenPositionsPausedForPartyB" : `Pause${scope}`
					await expect(call).to.emit(pause, event)
				} else await expect(call).to.be.revertedWith(missingRole)
				await expect(pause.getFunction(`unpause${scope}`)(...args)).to.be.revertedWith(missingRole)
			}
			await expect(pause.suspendedAddress(target)).to.be.revertedWith(missingRole)
			await expect(pause.unsuspendedAddress(target)).to.be.revertedWith(missingRole)
			await expect(pause.activeEmergencyMode()).to.be.revertedWith(missingRole)
			await expect(context.controlFacet.connect(operator).grantRole(operator.address, ethers.id("UNPAUSER_ROLE"))).to.be.revertedWith(
				"Accessibility: Must be role admin",
			)
			await context.controlFacet.revokeRole(operator.address, ethers.id(role))
			for (const [required, scope] of permissions) {
				if (required !== role) continue
				await expect(pause.getFunction(`pause${scope}`)(...(scope === "PartyBOpenPositionsFor" ? [target] : []))).to.be.revertedWith(missingRole)
			}
		})
	}

	for (const role of [undefined, "PAUSER_ROLE", "DEFAULT_ADMIN_ROLE", "UNPAUSER_ROLE", "SUSPENDER_ROLE", "EMERGENCY_ADMIN_ROLE"]) {
		it(`${role ?? "an unprivileged caller"} alone cannot invoke any pause`, async function () {
			const context = await loadFixture(initializeFixture)
			const operator = context.signers.user2
			if (role) await context.controlFacet.grantRole(operator.address, ethers.id(role))
			for (const [, scope] of permissions) {
				await expect(
					context.pauseControlFacet.connect(operator).getFunction(`pause${scope}`)(
						...(scope === "PartyBOpenPositionsFor" ? [context.signers.hedger.address] : []),
					),
				).to.be.revertedWith(missingRole)
			}
		})
	}

	it("keeps unpause authority separate and restores flags without changing balances", async function () {
		const context = await loadFixture(initializeFixture)
		const operator = context.signers.user2
		const before = await context.viewFacet.pauseState()
		const balance = await context.viewFacet.balanceOf(operator.address)
		await context.controlFacet.grantRole(operator.address, ethers.id("UNPAUSER_ROLE"))
		const execution = await ethers.getContractAt("ExecutionContextFacet", context.diamond)
		for (const [, scope] of permissions) {
			const args = scope === "PartyBOpenPositionsFor" ? [context.signers.hedger.address] : []
			await context.pauseControlFacet.getFunction(`pause${scope}`)(...args)
			if (scope === "InstantLayer") {
				await expect(execution.beginInstantLayerExecution.staticCall(false)).to.be.revertedWith("ControlFacet: Instant Layer Paused")
			} else if (scope === "PartyBOpenPositionsFor") {
				expect(await context.viewFacet.isPartyBOpenPositionsPaused(context.signers.hedger.address)).to.equal(true)
			} else {
				const flag = scope[0].toLowerCase() + scope.slice(1) + "Paused"
				expect((await context.viewFacet.pauseState()).getValue(flag), flag).to.equal(true)
			}
			await context.pauseControlFacet.connect(operator).getFunction(`unpause${scope}`)(...args)
		}
		await expect(execution.beginInstantLayerExecution.staticCall(false)).not.to.be.reverted
		expect(await context.viewFacet.pauseState()).to.deep.equal(before)
		expect(await context.viewFacet.isPartyBOpenPositionsPaused(context.signers.hedger.address)).to.equal(false)
		expect(await context.viewFacet.balanceOf(operator.address)).to.equal(balance)
	})

	it("allows scoped role administration without granting authority over other pause roles", async function () {
		const context = await loadFixture(initializeFixture)
		const roleAdmin = context.signers.user
		const operator = context.signers.user2
		const role = ethers.id("ACCOUNTING_PAUSER_ROLE")
		await context.controlFacet.addRoleAdmin(role, roleAdmin.address)
		await context.controlFacet.connect(roleAdmin).grantRole(operator.address, role)
		await context.pauseControlFacet.connect(operator).pauseAccounting()
		await expect(context.pauseControlFacet.connect(roleAdmin).pauseAccounting()).to.be.revertedWith(missingRole)
		await expect(context.controlFacet.connect(roleAdmin).grantRole(operator.address, ethers.id("GLOBAL_PAUSER_ROLE"))).to.be.revertedWith(
			"Accessibility: Must be role admin",
		)
		await context.controlFacet.connect(roleAdmin).revokeRole(operator.address, role)
		await expect(context.pauseControlFacet.connect(operator).pauseAccounting()).to.be.revertedWith(missingRole)
	})

	it("activates pre-granted granular authority across a legacy facet replacement without resetting state", async function () {
		const context = await loadFixture(initializeLegacyPauseFixture)
		const legacyOperator = context.signers.user
		const newOperator = context.signers.user2
		await context.controlFacet.grantRole(legacyOperator.address, ethers.id("PAUSER_ROLE"))
		await context.controlFacet.grantRole(newOperator.address, ethers.id("GLOBAL_PAUSER_ROLE"))
		const user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(ethers.parseEther("100"), ethers.parseEther("100"))
		await context.pauseControlFacet.pauseAccounting()
		await context.pauseControlFacet.pausePartyBOpenPositionsFor(context.signers.hedger.address)
		await expect(context.pauseControlFacet.connect(newOperator).pauseGlobal()).to.be.revertedWith(missingRole)
		await context.pauseControlFacet.connect(legacyOperator).pauseGlobal()
		const before = await context.viewFacet.pauseState()
		const replacement = await (await ethers.getContractFactory("PauseControlFacet")).deploy()
		const cut = await ethers.getContractAt("DiamondCutFacet", context.diamond)
		await cut.diamondCut(
			[
				{
					facetAddress: await replacement.getAddress(),
					action: 1,
					functionSelectors: [context.pauseControlFacet.interface.getFunction("pauseGlobal")!.selector],
				},
			],
			ethers.ZeroAddress,
			"0x",
		)
		expect(await context.viewFacet.pauseState()).to.deep.equal(before)
		expect(await context.viewFacet.balanceOf(user.address)).to.equal(ethers.parseEther("100"))
		expect(await context.viewFacet.isPartyBOpenPositionsPaused(context.signers.hedger.address)).to.equal(true)
		expect(await context.viewFacet.hasRole(legacyOperator.address, ethers.id("PAUSER_ROLE"))).to.equal(true)
		await expect(context.pauseControlFacet.connect(legacyOperator).pauseGlobal()).to.be.revertedWith(missingRole)
		await context.pauseControlFacet.unpauseGlobal()
		await context.pauseControlFacet.connect(newOperator).pauseGlobal()
		expect(await context.viewFacet.pauseState()).to.deep.equal(before)
	})

	it("PartyA pause permits deposits and withdrawals; accounting pause blocks both", async function () {
		const context = await loadFixture(initializeFixture)
		const user = new User(context, context.signers.user)
		await user.setup()
		await user.setBalances(ethers.parseEther("100"))
		const amount = ethers.parseEther("10")
		const account = context.accountFacet.connect(context.signers.user)
		const withdraw = context.withdrawFacet.connect(context.signers.user)
		const parts = [
			{
				id: 1,
				amount,
				chainId: (await ethers.provider.getNetwork()).chainId,
				receiver: user.address,
				virtualProvider: ethers.ZeroAddress,
				expressProvider: ethers.ZeroAddress,
			},
		]
		await context.controlFacet.setMaxWithdrawParts(10)
		await context.controlFacet.setWithdrawCooldownPeriod(0)
		await context.pauseControlFacet.pausePartyAActions()
		await account.deposit(amount * 2n)
		await expect(user.sendQuote()).to.be.revertedWith("Pausable: PartyA actions paused")
		await withdraw.initiateWithdraw(parts, false, "0x")
		await withdraw.finalizeWithdrawRequest(user.address, 1)
		expect(await context.viewFacet.balanceOf(user.address)).to.equal(amount)
		await withdraw.initiateWithdraw(parts, false, "0x")
		await context.pauseControlFacet.pauseAccounting()
		await expect(account.deposit(amount)).to.be.revertedWith("Pausable: Accounting paused")
		await expect(withdraw.initiateWithdraw(parts, false, "0x")).to.be.revertedWith("Pausable: Accounting paused")
		await expect(withdraw.finalizeWithdrawRequest(user.address, 2)).to.be.revertedWith("Pausable: Accounting paused")
		await context.pauseControlFacet.unpauseAccounting()
		await withdraw.finalizeWithdrawRequest(user.address, 2)
		expect(await context.viewFacet.balanceOf(user.address)).to.equal(0n)
		expect(await context.collateral.balanceOf(user.address)).to.equal(ethers.parseEther("100"))
	})
})
