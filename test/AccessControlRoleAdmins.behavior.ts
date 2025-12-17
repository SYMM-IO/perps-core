import { loadFixture } from "./helpers/network-helpers"
import { expect } from "chai"
import sha3 from "js-sha3"
import { initializeFixture } from "./Initialize.fixture"
import { RunContext } from "./models/RunContext"
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { ethers } from "./helpers/hardhat-connection"

const { keccak256 } = sha3

const SETTER_ROLE = `0x${keccak256("SETTER_ROLE")}`
const LIQUIDATOR_ROLE = `0x${keccak256("LIQUIDATOR_ROLE")}`

export function shouldBehaveLikeAccessControlRoleAdmins(): void {
	describe("AccessControl role admins", () => {
		let context: RunContext
		let admin: SignerWithAddress
		let secondaryAdmin: SignerWithAddress
		let operator: SignerWithAddress
		let outsider: SignerWithAddress

		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			admin = context.signers.admin
			secondaryAdmin = context.signers.user
			operator = context.signers.user2
			outsider = context.signers.others[0]
		})

		describe("unit", () => {
			describe("isRoleAdmin", () => {
				it("Should treat default admin as admin for every role", async function () {
					// baseline default admin
					expect(await context.viewFacet.isRoleAdmin(await admin.getAddress(), SETTER_ROLE)).to.equal(true)
					expect(await context.viewFacet.isRoleAdmin(await admin.getAddress(), LIQUIDATOR_ROLE)).to.equal(true)
					expect(await context.viewFacet.isRoleAdmin(await outsider.getAddress(), SETTER_ROLE)).to.equal(false)
				})
			})

			describe("addRoleAdmin", () => {
				it("Should add a new admin for a role", async function () {
					// verify secondaryAdmin is not role admin
					expect(await context.viewFacet.isRoleAdmin(await secondaryAdmin.getAddress(), SETTER_ROLE)).to.equal(false)
					// add admin as default admin
					await expect(context.controlFacet.connect(admin).addRoleAdmin(SETTER_ROLE, await secondaryAdmin.getAddress()))
						.to.emit(context.controlFacet, "RoleAdminAdded")
						.withArgs(SETTER_ROLE, await secondaryAdmin.getAddress())
					expect(await context.viewFacet.isRoleAdmin(await secondaryAdmin.getAddress(), SETTER_ROLE)).to.equal(true)
				})

				it("Should revert when caller is not a role admin", async function () {
					// outsider cannot add
					await expect(
						context.controlFacet.connect(outsider).addRoleAdmin(SETTER_ROLE, await secondaryAdmin.getAddress()),
					).to.be.revertedWith("Accessibility: Must has role")
				})

				it("Should revert when role admin (non-default) tries to add another admin", async function () {
					// default admin delegates admin rights for role
					await context.controlFacet.connect(admin).addRoleAdmin(SETTER_ROLE, await secondaryAdmin.getAddress())
					// secondaryAdmin cannot further delegate
					await expect(
						context.controlFacet.connect(secondaryAdmin).addRoleAdmin(SETTER_ROLE, await operator.getAddress()),
					).to.be.revertedWith("Accessibility: Must has role")
				})

				it("Should revert when admin address is zero", async function () {
					// prevent zero admin
					await expect(
						context.controlFacet.connect(admin).addRoleAdmin(SETTER_ROLE, ethers.ZeroAddress),
					).to.be.revertedWith("ControlFacet: Zero address")
				})
			})

			describe("removeRoleAdmin", () => {
				beforeEach(async function () {
					// add admin
					await context.controlFacet.connect(admin).addRoleAdmin(SETTER_ROLE, await secondaryAdmin.getAddress())
				})

				it("Should remove an existing admin for a role", async function () {
					// remove admin
					await expect(context.controlFacet.connect(admin).removeRoleAdmin(SETTER_ROLE, await secondaryAdmin.getAddress()))
						.to.emit(context.controlFacet, "RoleAdminRemoved")
						.withArgs(SETTER_ROLE, await secondaryAdmin.getAddress())
					expect(await context.viewFacet.isRoleAdmin(await secondaryAdmin.getAddress(), SETTER_ROLE)).to.equal(false)
					// default admin stays admin
					expect(await context.viewFacet.isRoleAdmin(await admin.getAddress(), SETTER_ROLE)).to.equal(true)
				})

				it("Should revert when caller is not a role admin", async function () {
					// outsider cannot remove
					await expect(
						context.controlFacet.connect(outsider).removeRoleAdmin(SETTER_ROLE, await secondaryAdmin.getAddress()),
					).to.be.revertedWith("Accessibility: Must has role")
				})

				it("Should block delegated admins from removing other delegated admins", async function () {
					// delegated admin cannot remove another admin
					await context.controlFacet.connect(admin).addRoleAdmin(SETTER_ROLE, await operator.getAddress())
					await expect(
						context.controlFacet.connect(secondaryAdmin).removeRoleAdmin(SETTER_ROLE, await operator.getAddress()),
					).to.be.revertedWith("Accessibility: Must has role")
				})

				it("Should block delegated admins from removing themselves", async function () {
					// delegated admin cannot remove self
					await expect(
						context.controlFacet.connect(secondaryAdmin).removeRoleAdmin(SETTER_ROLE, await secondaryAdmin.getAddress()),
					).to.be.revertedWith("Accessibility: Must has role")
				})
			})

			describe("grantRole and revokeRole via delegated admins", () => {
				beforeEach(async function () {
					// assign admin
					await context.controlFacet.connect(admin).addRoleAdmin(LIQUIDATOR_ROLE, await secondaryAdmin.getAddress())
				})

				it("Should allow delegated admin to grant role", async function () {
					// grant from delegated admin
					await expect(context.controlFacet.connect(secondaryAdmin).grantRole(await operator.getAddress(), LIQUIDATOR_ROLE)).to.not.reverted
					expect(await context.viewFacet.hasRole(await operator.getAddress(), LIQUIDATOR_ROLE)).to.equal(true)
				})

				it("Should revert grant when caller is not an admin for that role", async function () {
					// outsider blocked
					await expect(
						context.controlFacet.connect(outsider).grantRole(await operator.getAddress(), LIQUIDATOR_ROLE),
					).to.be.revertedWith("Accessibility: Must be role admin")
				})

				it("Should allow delegated admin to revoke role and prevent actions after removal", async function () {
					// grant then revoke
					await context.controlFacet.connect(secondaryAdmin).grantRole(await operator.getAddress(), LIQUIDATOR_ROLE)
					await expect(context.controlFacet.connect(secondaryAdmin).revokeRole(await operator.getAddress(), LIQUIDATOR_ROLE)).to.not.reverted
					expect(await context.viewFacet.hasRole(await operator.getAddress(), LIQUIDATOR_ROLE)).to.equal(false)
					// remove admin then ensure blocked
					await context.controlFacet.connect(admin).removeRoleAdmin(LIQUIDATOR_ROLE, await secondaryAdmin.getAddress())
					await expect(
						context.controlFacet.connect(secondaryAdmin).grantRole(await operator.getAddress(), LIQUIDATOR_ROLE),
					).to.be.revertedWith("Accessibility: Must be role admin")
				})

				it("Should always allow default admin to manage the role", async function () {
					// default admin can grant regardless of delegated list state
					await expect(context.controlFacet.connect(admin).grantRole(await operator.getAddress(), LIQUIDATOR_ROLE)).to.not.reverted
					expect(await context.viewFacet.hasRole(await operator.getAddress(), LIQUIDATOR_ROLE)).to.equal(true)
				})
			})
		})

		describe("scenario", () => {
			it("Should handle multi-admin lifecycle across roles", async function () {
				// add setter role admins
				await context.controlFacet.connect(admin).addRoleAdmin(SETTER_ROLE, await secondaryAdmin.getAddress())
				await context.controlFacet.connect(admin).addRoleAdmin(SETTER_ROLE, await operator.getAddress())
				expect(await context.viewFacet.isRoleAdmin(await secondaryAdmin.getAddress(), SETTER_ROLE)).to.equal(true)
				expect(await context.viewFacet.isRoleAdmin(await operator.getAddress(), SETTER_ROLE)).to.equal(true)

				// delegated admin grants setter role to outsider
				await context.controlFacet.connect(secondaryAdmin).grantRole(await outsider.getAddress(), SETTER_ROLE)
				expect(await context.viewFacet.hasRole(await outsider.getAddress(), SETTER_ROLE)).to.equal(true)

				// new setter executes a setter-only action
				await context.controlFacet.connect(outsider).setPendingQuotesValidLength(15)
				expect(await context.viewFacet.pendingQuotesValidLength()).to.equal(15)

				// remove secondaryAdmin and block further grants from them
				await context.controlFacet.connect(admin).removeRoleAdmin(SETTER_ROLE, await secondaryAdmin.getAddress())
				await expect(
					context.controlFacet.connect(secondaryAdmin).grantRole(await admin.getAddress(), SETTER_ROLE),
				).to.be.revertedWith("Accessibility: Must be role admin")

				// remaining admin revokes the operator and cleans up
				await context.controlFacet.connect(operator).revokeRole(await outsider.getAddress(), SETTER_ROLE)
				expect(await context.viewFacet.hasRole(await outsider.getAddress(), SETTER_ROLE)).to.equal(false)

				// promote a dedicated liquidator admin and delegate lifecycle
				await context.controlFacet.connect(admin).addRoleAdmin(LIQUIDATOR_ROLE, await secondaryAdmin.getAddress())
				await context.controlFacet.connect(secondaryAdmin).grantRole(await outsider.getAddress(), LIQUIDATOR_ROLE)
				expect(await context.viewFacet.hasRole(await outsider.getAddress(), LIQUIDATOR_ROLE)).to.equal(true)

				// strip delegated liquidator admin and ensure actions stop
				await context.controlFacet.connect(admin).removeRoleAdmin(LIQUIDATOR_ROLE, await secondaryAdmin.getAddress())
				await expect(
					context.controlFacet.connect(secondaryAdmin).revokeRole(await outsider.getAddress(), LIQUIDATOR_ROLE),
				).to.be.revertedWith("Accessibility: Must be role admin")

				// default admin can still clean up roles after delegated admin removal
				await context.controlFacet.connect(admin).revokeRole(await outsider.getAddress(), LIQUIDATOR_ROLE)
				expect(await context.viewFacet.hasRole(await outsider.getAddress(), LIQUIDATOR_ROLE)).to.equal(false)
			})
		})
	})
}
