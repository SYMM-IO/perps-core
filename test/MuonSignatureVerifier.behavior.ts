import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"

import type { MuonSignatureVerifier } from "../src/types/helpers/verification/SymmioSignatureVerifier.sol/MuonSignatureVerifier.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture } from "./helpers/network-helpers.js"

// MuonFunction enum values (must match the Solidity enum order)
const MuonFunction = {
	Trading: 0,
	AccountManagement: 1,
	Settlement: 2,
	ForceClose: 3,
	Funding: 4,
	LiquidationPartyA: 5,
	LiquidationPartyB: 6,
} as const

export function shouldBehaveLikeMuonSignatureVerifier(): void {
	let verifier: MuonSignatureVerifier
	let admin: HardhatEthersSigner
	let setter: HardhatEthersSigner
	let nonSetter: HardhatEthersSigner

	const dummyPubKey = { x: 12345n, parity: 0 }
	const dummyPubKey2 = { x: 67890n, parity: 1 }

	async function deployFixture() {
		const [, adminSigner, setterSigner, nonSetterSigner] = await ethers.getSigners()
		const Factory = await ethers.getContractFactory("MuonSignatureVerifier")
		const contract = await Factory.deploy(adminSigner.address)
		await contract.waitForDeployment()

		// Grant SETTER_ROLE to setter
		const SETTER_ROLE = await contract.SETTER_ROLE()
		await contract.connect(adminSigner).grantRole(SETTER_ROLE, setterSigner.address)

		return { contract, adminSigner, setterSigner, nonSetterSigner, SETTER_ROLE }
	}

	beforeEach(async function () {
		const fixture = await loadFixture(deployFixture)
		verifier = fixture.contract
		admin = fixture.adminSigner
		setter = fixture.setterSigner
		nonSetter = fixture.nonSetterSigner
	})

	describe("MuonSignatureVerifier Permissions", function () {
		describe("Public Key Permissions", function () {
			it("should default to unauthorized for all categories", async function () {
				await verifier.connect(setter).addPublicKey(dummyPubKey)

				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.Trading)).to.equal(false)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.AccountManagement)).to.equal(false)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.Settlement)).to.equal(false)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.LiquidationPartyA)).to.equal(false)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.LiquidationPartyB)).to.equal(false)
			})

			it("should authorize a key for specific categories", async function () {
				await verifier.connect(setter).addPublicKey(dummyPubKey)
				await verifier.connect(setter).setPublicKeyPermissions(dummyPubKey, [MuonFunction.Trading, MuonFunction.AccountManagement], true)

				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.Trading)).to.equal(true)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.AccountManagement)).to.equal(true)
				// Other categories remain unauthorized
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.LiquidationPartyA)).to.equal(false)
			})

			it("should revoke permissions for specific categories", async function () {
				await verifier.connect(setter).addPublicKey(dummyPubKey)
				await verifier.connect(setter).setPublicKeyPermissions(dummyPubKey, [MuonFunction.Trading, MuonFunction.AccountManagement], true)

				// Revoke one category
				await verifier.connect(setter).setPublicKeyPermissions(dummyPubKey, [MuonFunction.Trading], false)

				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.Trading)).to.equal(false)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.AccountManagement)).to.equal(true)
			})

			it("should handle multiple keys independently", async function () {
				await verifier.connect(setter).addPublicKey(dummyPubKey)
				await verifier.connect(setter).addPublicKey(dummyPubKey2)

				await verifier.connect(setter).setPublicKeyPermissions(dummyPubKey, [MuonFunction.Trading], true)
				await verifier.connect(setter).setPublicKeyPermissions(dummyPubKey2, [MuonFunction.LiquidationPartyA], true)

				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.Trading)).to.equal(true)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.LiquidationPartyA)).to.equal(false)

				expect(await verifier.isPublicKeyAuthorized(dummyPubKey2, MuonFunction.Trading)).to.equal(false)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey2, MuonFunction.LiquidationPartyA)).to.equal(true)
			})

			it("should emit PublicKeyPermissionsUpdated on grant", async function () {
				await expect(verifier.connect(setter).setPublicKeyPermissions(dummyPubKey, [MuonFunction.Trading, MuonFunction.AccountManagement], true))
					.to.emit(verifier, "PublicKeyPermissionsUpdated")
					.withArgs(dummyPubKey.x, dummyPubKey.parity, [MuonFunction.Trading, MuonFunction.AccountManagement], true)
			})

			it("should emit PublicKeyPermissionsUpdated on revoke", async function () {
				await verifier.connect(setter).setPublicKeyPermissions(dummyPubKey, [MuonFunction.Trading], true)

				await expect(verifier.connect(setter).setPublicKeyPermissions(dummyPubKey, [MuonFunction.Trading], false))
					.to.emit(verifier, "PublicKeyPermissionsUpdated")
					.withArgs(dummyPubKey.x, dummyPubKey.parity, [MuonFunction.Trading], false)
			})

			it("should revert when non-setter sets permissions", async function () {
				await expect(verifier.connect(nonSetter).setPublicKeyPermissions(dummyPubKey, [MuonFunction.Trading], true)).to.be.reverted
			})

			it("should allow admin to set permissions", async function () {
				// Admin also has SETTER_ROLE (granted in constructor)
				await verifier.connect(admin).setPublicKeyPermissions(dummyPubKey, [MuonFunction.Trading], true)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.Trading)).to.equal(true)
			})

			it("should handle setting permissions for all categories at once", async function () {
				const allCategories = Object.values(MuonFunction)
				await verifier.connect(setter).setPublicKeyPermissions(dummyPubKey, allCategories, true)

				for (const cat of allCategories) {
					expect(await verifier.isPublicKeyAuthorized(dummyPubKey, cat)).to.equal(true)
				}
			})

			it("should handle empty functions array", async function () {
				await verifier.connect(setter).setPublicKeyPermissions(dummyPubKey, [], true)
				// No permissions should be set
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.Trading)).to.equal(false)
			})
		})

		describe("Gateway Signer Permissions", function () {
			let gatewaySigner: string
			let gatewaySigner2: string

			beforeEach(async function () {
				const signers = await ethers.getSigners()
				gatewaySigner = signers[4].address
				gatewaySigner2 = signers[5].address
			})

			it("should default to unauthorized for all categories", async function () {
				await verifier.connect(setter).addGatewaySigner(gatewaySigner)

				expect(await verifier.isGatewaySignerAuthorized(gatewaySigner, MuonFunction.Trading)).to.equal(false)
				expect(await verifier.isGatewaySignerAuthorized(gatewaySigner, MuonFunction.AccountManagement)).to.equal(false)
				expect(await verifier.isGatewaySignerAuthorized(gatewaySigner, MuonFunction.LiquidationPartyA)).to.equal(false)
			})

			it("should authorize a signer for specific categories", async function () {
				await verifier.connect(setter).addGatewaySigner(gatewaySigner)
				await verifier.connect(setter).setGatewaySignerPermissions(gatewaySigner, [MuonFunction.Trading, MuonFunction.AccountManagement], true)

				expect(await verifier.isGatewaySignerAuthorized(gatewaySigner, MuonFunction.Trading)).to.equal(true)
				expect(await verifier.isGatewaySignerAuthorized(gatewaySigner, MuonFunction.AccountManagement)).to.equal(true)
				expect(await verifier.isGatewaySignerAuthorized(gatewaySigner, MuonFunction.LiquidationPartyA)).to.equal(false)
			})

			it("should revoke permissions for specific categories", async function () {
				await verifier.connect(setter).setGatewaySignerPermissions(gatewaySigner, [MuonFunction.Trading, MuonFunction.AccountManagement], true)
				await verifier.connect(setter).setGatewaySignerPermissions(gatewaySigner, [MuonFunction.Trading], false)

				expect(await verifier.isGatewaySignerAuthorized(gatewaySigner, MuonFunction.Trading)).to.equal(false)
				expect(await verifier.isGatewaySignerAuthorized(gatewaySigner, MuonFunction.AccountManagement)).to.equal(true)
			})

			it("should handle multiple signers independently", async function () {
				await verifier.connect(setter).addGatewaySigner(gatewaySigner)
				await verifier.connect(setter).addGatewaySigner(gatewaySigner2)

				await verifier.connect(setter).setGatewaySignerPermissions(gatewaySigner, [MuonFunction.Trading], true)
				await verifier.connect(setter).setGatewaySignerPermissions(gatewaySigner2, [MuonFunction.LiquidationPartyA], true)

				expect(await verifier.isGatewaySignerAuthorized(gatewaySigner, MuonFunction.Trading)).to.equal(true)
				expect(await verifier.isGatewaySignerAuthorized(gatewaySigner, MuonFunction.LiquidationPartyA)).to.equal(false)

				expect(await verifier.isGatewaySignerAuthorized(gatewaySigner2, MuonFunction.Trading)).to.equal(false)
				expect(await verifier.isGatewaySignerAuthorized(gatewaySigner2, MuonFunction.LiquidationPartyA)).to.equal(true)
			})

			it("should emit GatewaySignerPermissionsUpdated on grant", async function () {
				await expect(
					verifier.connect(setter).setGatewaySignerPermissions(gatewaySigner, [MuonFunction.Trading, MuonFunction.AccountManagement], true),
				)
					.to.emit(verifier, "GatewaySignerPermissionsUpdated")
					.withArgs(gatewaySigner, [MuonFunction.Trading, MuonFunction.AccountManagement], true)
			})

			it("should emit GatewaySignerPermissionsUpdated on revoke", async function () {
				await verifier.connect(setter).setGatewaySignerPermissions(gatewaySigner, [MuonFunction.Trading], true)

				await expect(verifier.connect(setter).setGatewaySignerPermissions(gatewaySigner, [MuonFunction.Trading], false))
					.to.emit(verifier, "GatewaySignerPermissionsUpdated")
					.withArgs(gatewaySigner, [MuonFunction.Trading], false)
			})

			it("should revert when non-setter sets permissions", async function () {
				await expect(verifier.connect(nonSetter).setGatewaySignerPermissions(gatewaySigner, [MuonFunction.Trading], true)).to.be.reverted
			})

			it("should handle setting permissions for all categories at once", async function () {
				const allCategories = Object.values(MuonFunction)
				await verifier.connect(setter).setGatewaySignerPermissions(gatewaySigner, allCategories, true)

				for (const cat of allCategories) {
					expect(await verifier.isGatewaySignerAuthorized(gatewaySigner, cat)).to.equal(true)
				}
			})
		})

		describe("Access Control", function () {
			it("should grant SETTER_ROLE to admin on deployment", async function () {
				const SETTER_ROLE = await verifier.SETTER_ROLE()
				expect(await verifier.hasRole(SETTER_ROLE, admin.address)).to.equal(true)
			})

			it("should grant DEFAULT_ADMIN_ROLE to admin on deployment", async function () {
				const DEFAULT_ADMIN_ROLE = await verifier.DEFAULT_ADMIN_ROLE()
				expect(await verifier.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true)
			})

			it("should allow admin to grant SETTER_ROLE to new address", async function () {
				const SETTER_ROLE = await verifier.SETTER_ROLE()
				const signers = await ethers.getSigners()
				const newSetter = signers[6]

				await verifier.connect(admin).grantRole(SETTER_ROLE, newSetter.address)
				expect(await verifier.hasRole(SETTER_ROLE, newSetter.address)).to.equal(true)

				// New setter can set permissions
				await verifier.connect(newSetter).setPublicKeyPermissions(dummyPubKey, [MuonFunction.Trading], true)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.Trading)).to.equal(true)
			})

			it("should not allow non-setter to add/remove public keys", async function () {
				await expect(verifier.connect(nonSetter).addPublicKey(dummyPubKey)).to.be.reverted
				await expect(verifier.connect(nonSetter).removePublicKey(dummyPubKey)).to.be.reverted
			})

			it("should not allow non-setter to add/remove gateway signers", async function () {
				const signers = await ethers.getSigners()
				await expect(verifier.connect(nonSetter).addGatewaySigner(signers[4].address)).to.be.reverted
				await expect(verifier.connect(nonSetter).removeGatewaySigner(signers[4].address)).to.be.reverted
			})
		})

		describe("Key and Signer Management", function () {
			it("should add and retrieve public keys", async function () {
				await verifier.connect(setter).addPublicKey(dummyPubKey)
				await verifier.connect(setter).addPublicKey(dummyPubKey2)

				const keys = await verifier.getAllPublicKeys()
				expect(keys.length).to.equal(2)
				expect(keys[0].x).to.equal(dummyPubKey.x)
				expect(keys[0].parity).to.equal(dummyPubKey.parity)
				expect(keys[1].x).to.equal(dummyPubKey2.x)
				expect(keys[1].parity).to.equal(dummyPubKey2.parity)
			})

			it("should remove public keys", async function () {
				await verifier.connect(setter).addPublicKey(dummyPubKey)
				await verifier.connect(setter).addPublicKey(dummyPubKey2)
				await verifier.connect(setter).removePublicKey(dummyPubKey)

				const keys = await verifier.getAllPublicKeys()
				expect(keys.length).to.equal(1)
				expect(keys[0].x).to.equal(dummyPubKey2.x)
			})

			it("should revert when removing non-existent public key", async function () {
				await expect(verifier.connect(setter).removePublicKey(dummyPubKey)).to.be.revertedWith("MuonSignatureVerifier: public key not found")
			})

			it("should add and retrieve gateway signers", async function () {
				const signers = await ethers.getSigners()
				await verifier.connect(setter).addGatewaySigner(signers[4].address)
				await verifier.connect(setter).addGatewaySigner(signers[5].address)

				const gwSigners = await verifier.getAllGatewaySigners()
				expect(gwSigners.length).to.equal(2)
				expect(gwSigners[0]).to.equal(signers[4].address)
				expect(gwSigners[1]).to.equal(signers[5].address)
			})

			it("should emit events on key/signer add and remove", async function () {
				await expect(verifier.connect(setter).addPublicKey(dummyPubKey))
					.to.emit(verifier, "PublicKeyAdded")
					.withArgs(dummyPubKey.x, dummyPubKey.parity)

				await expect(verifier.connect(setter).removePublicKey(dummyPubKey))
					.to.emit(verifier, "PublicKeyRemoved")
					.withArgs(dummyPubKey.x, dummyPubKey.parity)

				const signers = await ethers.getSigners()
				await expect(verifier.connect(setter).addGatewaySigner(signers[4].address))
					.to.emit(verifier, "GatewaySignerAdded")
					.withArgs(signers[4].address)

				await expect(verifier.connect(setter).removeGatewaySigner(signers[4].address))
					.to.emit(verifier, "GatewaySignerRemoved")
					.withArgs(signers[4].address)
			})
		})

		describe("Permissions persist independently of key lifecycle", function () {
			it("should allow setting permissions before adding the key", async function () {
				// Set permissions for a key that hasn't been added yet
				await verifier.connect(setter).setPublicKeyPermissions(dummyPubKey, [MuonFunction.Trading], true)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.Trading)).to.equal(true)

				// Permissions survive adding the key
				await verifier.connect(setter).addPublicKey(dummyPubKey)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.Trading)).to.equal(true)
			})

			it("should retain permissions after removing and re-adding a key", async function () {
				await verifier.connect(setter).addPublicKey(dummyPubKey)
				await verifier.connect(setter).setPublicKeyPermissions(dummyPubKey, [MuonFunction.Trading], true)

				await verifier.connect(setter).removePublicKey(dummyPubKey)
				// Permission mapping still exists
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.Trading)).to.equal(true)

				// Re-add key - permissions are still there
				await verifier.connect(setter).addPublicKey(dummyPubKey)
				expect(await verifier.isPublicKeyAuthorized(dummyPubKey, MuonFunction.Trading)).to.equal(true)
			})
		})
	})
}
