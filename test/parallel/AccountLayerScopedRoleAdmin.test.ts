import { expect } from "chai"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"

describe("AccountLayer scoped role administration", function () {
	it("lets DEFAULT_ADMIN manage SIGNER_SETTER_ROLE without a separate role-admin grant", async function () {
		const context = await loadFixture(initializeFixture)
		const defaultAdmin = context.signers.admin
		const newInstantLayer = context.signers.user2
		const signerSetterRole = ethers.keccak256(ethers.toUtf8Bytes("SIGNER_SETTER_ROLE"))
		const defaultAdminRole = ethers.keccak256(ethers.toUtf8Bytes("DEFAULT_ADMIN_ROLE"))

		expect(await context.alViewFacet.hasRole(defaultAdmin.address, defaultAdminRole)).to.equal(true)
		expect(await context.alViewFacet.isRoleAdmin(defaultAdmin.address, signerSetterRole)).to.equal(true)

		await context.alControlFacet.connect(defaultAdmin).grantRole(newInstantLayer.address, signerSetterRole)
		expect(await context.alViewFacet.hasRole(newInstantLayer.address, signerSetterRole)).to.equal(true)

		await context.alControlFacet.connect(defaultAdmin).revokeRole(newInstantLayer.address, signerSetterRole)
		expect(await context.alViewFacet.hasRole(newInstantLayer.address, signerSetterRole)).to.equal(false)
	})

	it("lets a delegated SIGNER_SETTER_ROLE admin wire and cut over InstantLayer without broad roles", async function () {
		const context = await loadFixture(initializeFixture)
		const delegatedAdmin = context.signers.user
		const newInstantLayer = context.signers.user2
		const signerSetterRole = ethers.keccak256(ethers.toUtf8Bytes("SIGNER_SETTER_ROLE"))
		const defaultAdminRole = ethers.keccak256(ethers.toUtf8Bytes("DEFAULT_ADMIN_ROLE"))
		const setterRole = ethers.keccak256(ethers.toUtf8Bytes("SETTER_ROLE"))

		expect(await context.alViewFacet.hasRole(delegatedAdmin.address, defaultAdminRole)).to.equal(false)
		expect(await context.alViewFacet.hasRole(delegatedAdmin.address, setterRole)).to.equal(false)

		await context.alControlFacet.connect(context.signers.admin).setRoleAdmin(delegatedAdmin.address, signerSetterRole, true)
		expect(await context.alViewFacet.isRoleAdmin(delegatedAdmin.address, signerSetterRole)).to.equal(true)

		await context.alControlFacet.connect(delegatedAdmin).grantRole(newInstantLayer.address, signerSetterRole)
		expect(await context.alViewFacet.hasRole(newInstantLayer.address, signerSetterRole)).to.equal(true)

		await context.alControlFacet.connect(delegatedAdmin).revokeRole(newInstantLayer.address, signerSetterRole)
		expect(await context.alViewFacet.hasRole(newInstantLayer.address, signerSetterRole)).to.equal(false)
	})
})
