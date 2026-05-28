import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"

import type { MockLiquidatorTarget, MockToken, SymmioLiquidator } from "../src/types/index.js"
import { deployProxy } from "../utils/upgrades-shim.js"
import { ethers, hre } from "./helpers/hardhat-connection.js"

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

async function getImplementation(proxyAddress: string): Promise<string> {
	const value = await ethers.provider.getStorage(proxyAddress, IMPLEMENTATION_SLOT)
	return ethers.getAddress("0x" + value.slice(26))
}

export function shouldBehaveLikeSymmioLiquidator(): void {
	describe("SymmioLiquidator", function () {
		let deployer: HardhatEthersSigner
		let admin: HardhatEthersSigner
		let manager: HardhatEthersSigner
		let operator: HardhatEthersSigner
		let pauser: HardhatEthersSigner
		let unpauser: HardhatEthersSigner
		let treasury: HardhatEthersSigner
		let stranger: HardhatEthersSigner

		let liquidator: SymmioLiquidator
		let target: MockLiquidatorTarget
		let token: MockToken

		let OPERATOR_ROLE: string
		let MANAGER_ROLE: string
		let PAUSER_ROLE: string
		let UNPAUSER_ROLE: string
		let DEFAULT_ADMIN_ROLE: string

		// Selectors of core liquidation functions we expect to be hardcoded on init
		const HARDCODED_PARTY_A = [
			"liquidatePartyA",
			"setSymbolsPrice",
			"liquidatePartyAWithSnapshot",
			"setSymbolsPriceWithSnapshot",
			"liquidatePendingPositionsPartyAWithSnapshot",
			"liquidatePositionsPartyAWithSnapshot",
			"settlePartyALiquidationWithSnapshot",
			"singleStepLiquidatePartyAWithSnapshot",
		] as const
		const HARDCODED_PARTY_A_LEGACY = [
			"deferredLiquidatePartyA",
			"deferredSetSymbolsPrice",
			"liquidatePendingPositionsPartyA",
			"liquidatePositionsPartyA",
			"settlePartyALiquidation",
		] as const
		const HARDCODED_PARTY_B = ["liquidatePartyB", "liquidatePositionsPartyB"] as const

		// Explicitly NOT hardcoded by design
		const NOT_HARDCODED_PARTY_A = ["resolveLiquidationDispute", "resolveLiquidationDisputeWithSnapshot"] as const

		let partyALiquidationIface: any
		let partyALiquidationSnapshotIface: any
		let partyBLiquidationIface: any

		beforeEach(async function () {
			;[deployer, admin, manager, operator, pauser, unpauser, treasury, stranger] = await ethers.getSigners()

			const MockTargetFactory = await ethers.getContractFactory("MockLiquidatorTarget")
			target = (await MockTargetFactory.deploy()) as unknown as MockLiquidatorTarget
			await target.waitForDeployment()

			// MockToken mints 1_000_000 * 1e18 to deployer (msg.sender) in its constructor
			const MockTokenFactory = await ethers.getContractFactory("MockToken")
			token = (await MockTokenFactory.connect(deployer).deploy("Mock USDC", "mUSDC")) as unknown as MockToken
			await token.waitForDeployment()

			const Factory = await ethers.getContractFactory("SymmioLiquidator")
			liquidator = (await deployProxy(hre, Factory, [admin.address, await target.getAddress()], { kind: "erc1967" })) as unknown as SymmioLiquidator

			OPERATOR_ROLE = await liquidator.OPERATOR_ROLE()
			MANAGER_ROLE = await liquidator.MANAGER_ROLE()
			PAUSER_ROLE = await liquidator.PAUSER_ROLE()
			UNPAUSER_ROLE = await liquidator.UNPAUSER_ROLE()
			DEFAULT_ADMIN_ROLE = await liquidator.DEFAULT_ADMIN_ROLE()

			await liquidator.connect(admin).grantRole(OPERATOR_ROLE, operator.address)
			await liquidator.connect(admin).grantRole(MANAGER_ROLE, manager.address)
			await liquidator.connect(admin).grantRole(PAUSER_ROLE, pauser.address)
			await liquidator.connect(admin).grantRole(UNPAUSER_ROLE, unpauser.address)

			partyALiquidationIface = (await ethers.getContractAt("IPartyALiquidationFacet", ethers.ZeroAddress)).interface
			partyALiquidationSnapshotIface = (await ethers.getContractAt("IPartyALiquidationSnapshotFacet", ethers.ZeroAddress)).interface
			partyBLiquidationIface = (await ethers.getContractAt("IPartyBLiquidationFacet", ethers.ZeroAddress)).interface
		})

		describe("initialization", function () {
			it("sets symmioAddress and grants admin + manager roles to admin", async function () {
				expect(await liquidator.symmioAddress()).to.equal(await target.getAddress())
				expect(await liquidator.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true)
				expect(await liquidator.hasRole(MANAGER_ROLE, admin.address)).to.equal(true)
			})

			it("hardcodes PartyA liquidation selectors", async function () {
				for (const name of HARDCODED_PARTY_A) {
					const iface =
						name == "liquidatePartyAWithSnapshot" ||
						name == "setSymbolsPriceWithSnapshot" ||
						name == "liquidatePendingPositionsPartyAWithSnapshot" ||
						name == "liquidatePositionsPartyAWithSnapshot" ||
						name == "settlePartyALiquidationWithSnapshot" ||
						name == "singleStepLiquidatePartyAWithSnapshot"
							? partyALiquidationSnapshotIface
							: partyALiquidationIface
					const sel = iface.getFunction(name).selector
					expect(await liquidator.allowedSelectors(sel), `expected ${name} allowed`).to.equal(true)
				}
				for (const name of HARDCODED_PARTY_A_LEGACY) {
					const sel = partyALiquidationIface.getFunction(name).selector
					expect(await liquidator.allowedSelectors(sel), `expected ${name} allowed`).to.equal(true)
				}
			})

			it("hardcodes PartyB liquidation selectors", async function () {
				for (const name of HARDCODED_PARTY_B) {
					const sel = partyBLiquidationIface.getFunction(name).selector
					expect(await liquidator.allowedSelectors(sel), `expected ${name} allowed`).to.equal(true)
				}
			})

			it("does NOT hardcode resolveLiquidationDispute", async function () {
				for (const name of NOT_HARDCODED_PARTY_A) {
					const iface = name == "resolveLiquidationDisputeWithSnapshot" ? partyALiquidationSnapshotIface : partyALiquidationIface
					const sel = iface.getFunction(name).selector
					expect(await liquidator.allowedSelectors(sel), `expected ${name} NOT allowed`).to.equal(false)
				}
			})

			it("reverts on zero admin", async function () {
				const Factory = await ethers.getContractFactory("SymmioLiquidator")
				await expect(deployProxy(hre, Factory, [ethers.ZeroAddress, await target.getAddress()], { kind: "erc1967" })).to.be.revertedWithCustomError(
					liquidator,
					"ZeroAddress",
				)
			})

			it("reverts on zero symmio address", async function () {
				const Factory = await ethers.getContractFactory("SymmioLiquidator")
				await expect(deployProxy(hre, Factory, [admin.address, ethers.ZeroAddress], { kind: "erc1967" })).to.be.revertedWithCustomError(
					liquidator,
					"ZeroAddress",
				)
			})

			it("cannot be re-initialized", async function () {
				await expect(liquidator.initialize(admin.address, await target.getAddress())).to.be.reverted
			})
		})

		describe("admin config", function () {
			it("admin can update symmioAddress and emits event", async function () {
				const newAddr = stranger.address
				await expect(liquidator.connect(admin).setSymmioAddress(newAddr)).to.emit(liquidator, "SetSymmioAddress")
				expect(await liquidator.symmioAddress()).to.equal(newAddr)
			})

			it("non-admin cannot update symmioAddress", async function () {
				await expect(liquidator.connect(manager).setSymmioAddress(stranger.address)).to.be.reverted
				await expect(liquidator.connect(operator).setSymmioAddress(stranger.address)).to.be.reverted
			})

			it("rejects zero symmio address", async function () {
				await expect(liquidator.connect(admin).setSymmioAddress(ethers.ZeroAddress)).to.be.revertedWithCustomError(liquidator, "ZeroAddress")
			})

			it("admin can toggle single selector and emits event", async function () {
				const sel = "0xdeadbeef"
				expect(await liquidator.allowedSelectors(sel)).to.equal(false)

				await expect(liquidator.connect(admin).setAllowedSelector(sel, true)).to.emit(liquidator, "SetAllowedSelector").withArgs(sel, true)
				expect(await liquidator.allowedSelectors(sel)).to.equal(true)

				await liquidator.connect(admin).setAllowedSelector(sel, false)
				expect(await liquidator.allowedSelectors(sel)).to.equal(false)
			})

			it("non-admin cannot toggle selectors", async function () {
				await expect(liquidator.connect(manager).setAllowedSelector("0xdeadbeef", true)).to.be.reverted
				await expect(liquidator.connect(operator).setAllowedSelector("0xdeadbeef", true)).to.be.reverted
			})

			it("admin can batch set selectors", async function () {
				const sels = ["0xaaaaaaaa", "0xbbbbbbbb", "0xcccccccc"]
				await liquidator.connect(admin).setAllowedSelectors(sels, [true, true, false])
				expect(await liquidator.allowedSelectors(sels[0])).to.equal(true)
				expect(await liquidator.allowedSelectors(sels[1])).to.equal(true)
				expect(await liquidator.allowedSelectors(sels[2])).to.equal(false)
			})

			it("batch set reverts on array length mismatch", async function () {
				await expect(liquidator.connect(admin).setAllowedSelectors(["0xaaaaaaaa"], [true, false])).to.be.revertedWithCustomError(
					liquidator,
					"ArrayLengthMismatch",
				)
			})
		})

		describe("operator call()", function () {
			it("operator can call a hardcoded-allowed selector and it forwards to the target", async function () {
				const callData = partyALiquidationIface.encodeFunctionData("liquidatePendingPositionsPartyA", [stranger.address])

				await liquidator.connect(operator).call([callData])

				expect(await target.callCount()).to.equal(1)
				expect(await target.lastCalldata()).to.equal(callData)
			})

			it("batch forwards all calls in order", async function () {
				const callData = partyALiquidationIface.encodeFunctionData("liquidatePendingPositionsPartyA", [stranger.address])
				await liquidator.connect(operator).call([callData, callData, callData])
				expect(await target.callCount()).to.equal(3)
			})

			it("rejects disallowed selectors", async function () {
				// revertMe() on the mock is a real function with a real selector, but it's not in the allowlist
				const iface = new ethers.Interface(["function revertMe()"])
				const selector = iface.getFunction("revertMe")!.selector
				const callData = iface.encodeFunctionData("revertMe", [])
				await expect(liquidator.connect(operator).call([callData]))
					.to.be.revertedWithCustomError(liquidator, "SelectorNotAllowed")
					.withArgs(selector)
			})

			it("rejects call data shorter than 4 bytes", async function () {
				await expect(liquidator.connect(operator).call(["0x112233"])).to.be.revertedWithCustomError(liquidator, "InvalidCallData")
			})

			it("non-operator cannot call (manager, admin, stranger all rejected)", async function () {
				const callData = partyALiquidationIface.encodeFunctionData("liquidatePendingPositionsPartyA", [stranger.address])
				await expect(liquidator.connect(manager).call([callData])).to.be.reverted
				await expect(liquidator.connect(admin).call([callData])).to.be.reverted
				await expect(liquidator.connect(stranger).call([callData])).to.be.reverted
			})

			it("call() is blocked while paused", async function () {
				await liquidator.connect(pauser).pause()
				const callData = partyALiquidationIface.encodeFunctionData("liquidatePendingPositionsPartyA", [stranger.address])
				await expect(liquidator.connect(operator).call([callData])).to.be.reverted
			})

			it("bubbles revert data from the target", async function () {
				// allow a reverting selector so we can test revert bubbling (bypasses allowlist gate)
				const iface = new ethers.Interface(["function revertMe()", "error MockRevert(uint256 code)"])
				const selector = iface.getFunction("revertMe")!.selector
				await liquidator.connect(admin).setAllowedSelector(selector, true)

				const callData = iface.encodeFunctionData("revertMe", [])
				await expect(liquidator.connect(operator).call([callData]))
					.to.be.revertedWithCustomError({ interface: iface } as any, "MockRevert")
					.withArgs(42)
			})

			it("falls back to generic error on empty revert data", async function () {
				const iface = new ethers.Interface(["function silentRevert()"])
				const selector = iface.getFunction("silentRevert")!.selector
				await liquidator.connect(admin).setAllowedSelector(selector, true)

				const callData = iface.encodeFunctionData("silentRevert", [])
				await expect(liquidator.connect(operator).call([callData])).to.be.revertedWithCustomError(liquidator, "ExecutionReverted")
			})

			it("operator batch reverts atomically when any call reverts", async function () {
				const good = partyALiquidationIface.encodeFunctionData("liquidatePendingPositionsPartyA", [stranger.address])
				const iface = new ethers.Interface(["function revertMe()"])
				const badSelector = iface.getFunction("revertMe")!.selector
				await liquidator.connect(admin).setAllowedSelector(badSelector, true)
				const bad = iface.encodeFunctionData("revertMe", [])

				await expect(liquidator.connect(operator).call([good, bad])).to.be.reverted
				// good call was in same tx — state must be unchanged
				expect(await target.callCount()).to.equal(0)
			})
		})

		describe("managerCall()", function () {
			it("manager can call any selector (bypasses allowlist)", async function () {
				// revertMe is not in the allowlist — but we won't revert, we'll just verify routing
				// Use liquidatePendingPositionsPartyA to avoid revert; it IS in allowlist but that's OK, managerCall ignores the list.
				const callData = partyALiquidationIface.encodeFunctionData("liquidatePendingPositionsPartyA", [stranger.address])
				await liquidator.connect(manager).managerCall([callData])
				expect(await target.callCount()).to.equal(1)
			})

			it("manager can invoke a selector NOT in the allowlist", async function () {
				// Ensure selector is not allowed
				const iface = new ethers.Interface(["function liquidatePendingPositionsPartyA(address)"])
				// Disable the hardcoded allow for this test to prove managerCall doesn't consult the map
				const selector = iface.getFunction("liquidatePendingPositionsPartyA")!.selector
				await liquidator.connect(admin).setAllowedSelector(selector, false)
				expect(await liquidator.allowedSelectors(selector)).to.equal(false)

				const callData = iface.encodeFunctionData("liquidatePendingPositionsPartyA", [stranger.address])
				await liquidator.connect(manager).managerCall([callData])
				expect(await target.callCount()).to.equal(1)
			})

			it("operator cannot invoke managerCall (even with an allowed selector)", async function () {
				const callData = partyALiquidationIface.encodeFunctionData("liquidatePendingPositionsPartyA", [stranger.address])
				await expect(liquidator.connect(operator).managerCall([callData])).to.be.reverted
			})

			it("stranger cannot invoke managerCall", async function () {
				const callData = partyALiquidationIface.encodeFunctionData("liquidatePendingPositionsPartyA", [stranger.address])
				await expect(liquidator.connect(stranger).managerCall([callData])).to.be.reverted
			})

			it("works while paused (by design, so admin can always drain fees)", async function () {
				await liquidator.connect(pauser).pause()
				const callData = partyALiquidationIface.encodeFunctionData("liquidatePendingPositionsPartyA", [stranger.address])
				await liquidator.connect(manager).managerCall([callData])
				expect(await target.callCount()).to.equal(1)
			})

			it("reverts on call data shorter than 4 bytes", async function () {
				await expect(liquidator.connect(manager).managerCall(["0x112233"])).to.be.revertedWithCustomError(liquidator, "InvalidCallData")
			})

			it("bubbles revert data from target", async function () {
				const iface = new ethers.Interface(["function revertMe()", "error MockRevert(uint256 code)"])
				const callData = iface.encodeFunctionData("revertMe", [])
				await expect(liquidator.connect(manager).managerCall([callData]))
					.to.be.revertedWithCustomError({ interface: iface } as any, "MockRevert")
					.withArgs(42)
			})
		})

		describe("fee withdrawal", function () {
			const FEE_AMOUNT = 1_000_000n

			beforeEach(async function () {
				await token.connect(deployer).transfer(await liquidator.getAddress(), FEE_AMOUNT)
			})

			it("manager can withdrawERC20 to a recipient", async function () {
				const before = await token.balanceOf(treasury.address)
				await expect(liquidator.connect(manager).withdrawERC20(await token.getAddress(), treasury.address, FEE_AMOUNT))
					.to.emit(liquidator, "FeeWithdrawn")
					.withArgs(await token.getAddress(), treasury.address, FEE_AMOUNT)
				expect(await token.balanceOf(treasury.address)).to.equal(before + FEE_AMOUNT)
				expect(await token.balanceOf(await liquidator.getAddress())).to.equal(0n)
			})

			it("operator cannot withdrawERC20", async function () {
				await expect(liquidator.connect(operator).withdrawERC20(await token.getAddress(), operator.address, FEE_AMOUNT)).to.be.reverted
			})

			it("stranger cannot withdrawERC20", async function () {
				await expect(liquidator.connect(stranger).withdrawERC20(await token.getAddress(), stranger.address, FEE_AMOUNT)).to.be.reverted
			})

			it("rejects zero recipient", async function () {
				await expect(
					liquidator.connect(manager).withdrawERC20(await token.getAddress(), ethers.ZeroAddress, FEE_AMOUNT),
				).to.be.revertedWithCustomError(liquidator, "ZeroAddress")
			})

			it("withdrawERC20 reverts if balance is insufficient (SafeERC20)", async function () {
				await expect(liquidator.connect(manager).withdrawERC20(await token.getAddress(), treasury.address, FEE_AMOUNT + 1n)).to.be.reverted
			})

			it("works while paused (by design)", async function () {
				await liquidator.connect(pauser).pause()
				await liquidator.connect(manager).withdrawERC20(await token.getAddress(), treasury.address, FEE_AMOUNT)
				expect(await token.balanceOf(treasury.address)).to.equal(FEE_AMOUNT)
			})
		})

		describe("pause / unpause", function () {
			it("only PAUSER_ROLE can pause", async function () {
				await expect(liquidator.connect(operator).pause()).to.be.reverted
				await expect(liquidator.connect(manager).pause()).to.be.reverted
				await liquidator.connect(pauser).pause()
				expect(await liquidator.paused()).to.equal(true)
			})

			it("only UNPAUSER_ROLE can unpause", async function () {
				await liquidator.connect(pauser).pause()
				await expect(liquidator.connect(operator).unpause()).to.be.reverted
				await expect(liquidator.connect(pauser).unpause()).to.be.reverted
				await liquidator.connect(unpauser).unpause()
				expect(await liquidator.paused()).to.equal(false)
			})
		})

		describe("UUPS upgrade", function () {
			it("admin can upgrade implementation", async function () {
				const proxy = await liquidator.getAddress()
				const before = await getImplementation(proxy)

				const Factory = await ethers.getContractFactory("SymmioLiquidator")
				const newImpl = await Factory.deploy()
				await newImpl.waitForDeployment()

				await liquidator.connect(admin).upgradeTo(await newImpl.getAddress())

				const after = await getImplementation(proxy)
				expect(after).to.not.equal(before)
				expect(after).to.equal(await newImpl.getAddress())
			})

			it("non-admin cannot upgrade", async function () {
				const Factory = await ethers.getContractFactory("SymmioLiquidator")
				const newImpl = await Factory.deploy()
				await newImpl.waitForDeployment()

				await expect(liquidator.connect(manager).upgradeTo(await newImpl.getAddress())).to.be.reverted
				await expect(liquidator.connect(operator).upgradeTo(await newImpl.getAddress())).to.be.reverted
			})

			it("state persists after upgrade", async function () {
				const symmioBefore = await liquidator.symmioAddress()

				const Factory = await ethers.getContractFactory("SymmioLiquidator")
				const newImpl = await Factory.deploy()
				await newImpl.waitForDeployment()

				await liquidator.connect(admin).upgradeTo(await newImpl.getAddress())

				expect(await liquidator.symmioAddress()).to.equal(symmioBefore)
				expect(await liquidator.hasRole(OPERATOR_ROLE, operator.address)).to.equal(true)
			})
		})
	})
}
