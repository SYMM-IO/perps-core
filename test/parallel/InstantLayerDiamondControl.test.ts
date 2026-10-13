import { expect } from "chai"
import { Contract, Signer, keccak256, toUtf8Bytes } from "ethers"

import { ethers } from "../helpers/hardhat-connection.js"
import { InstantLayerDiamondDeployment, deployInstantLayerDiamondForTest } from "../utils/InstantLayerDiamond.js"

const DEFAULT_ADMIN_ROLE = keccak256(toUtf8Bytes("DEFAULT_ADMIN_ROLE"))
const SETTER_ROLE = keccak256(toUtf8Bytes("SETTER_ROLE"))
const TEMPLATE_MANAGER_ROLE = keccak256(toUtf8Bytes("TEMPLATE_MANAGER_ROLE"))
const OPERATOR_ROLE = keccak256(toUtf8Bytes("OPERATOR_ROLE"))
const REVOKER_ROLE = keccak256(toUtf8Bytes("REVOKER_ROLE"))

const EMPTY_OPERATION = { insertionPoints: [], sourceIndices: [], sourceOffsets: [] }

describe("InstantLayer diamond control", async function () {
	let admin: Signer
	let stranger: Signer
	let outsider: Signer
	let adminAddress: string
	let strangerAddress: string
	let outsiderAddress: string
	let symmio: string
	let deployment: InstantLayerDiamondDeployment
	let diamond: Contract

	beforeEach(async function () {
		const signers = await ethers.getSigners()
		admin = signers[0]
		stranger = signers[1]
		outsider = signers[2]
		adminAddress = await admin.getAddress()
		strangerAddress = await stranger.getAddress()
		outsiderAddress = await outsider.getAddress()
		// Nothing in this layer calls into symmio, so an EOA stands in for the core diamond.
		symmio = await signers[3].getAddress()

		// ViewFacet is cut alongside for hasRole, the read every role assertion below relies on.
		deployment = await deployInstantLayerDiamondForTest(ethers, admin, symmio, ["ControlFacet", "ViewFacet"])
		diamond = deployment.diamond
	})

	describe("initialization", async function () {
		it("applies every default the monolith constructor applied", async function () {
			await expect(deployment.cutTx).to.emit(diamond, "TransientContextEnabledUpdated").withArgs(true)
			await expect(deployment.cutTx).to.emit(diamond, "RevocationCooldownUpdated").withArgs(0, 600)
			await expect(deployment.cutTx).to.emit(diamond, "TargetWhitelistUpdated").withArgs(symmio, true)
		})

		it("logs a RoleGranted for each genesis grant", async function () {
			// The diamond has no getRoleMember or getRoleMemberCount, so these logs are the only
			// off-chain route to the initial role holders. Without them an indexer replaying the
			// chain sees the admin holding nothing.
			for (const role of [DEFAULT_ADMIN_ROLE, SETTER_ROLE, TEMPLATE_MANAGER_ROLE, OPERATOR_ROLE]) {
				await expect(deployment.cutTx).to.emit(diamond, "RoleGranted").withArgs(role, adminAddress, adminAddress)
			}
		})

		it("logs no RoleGranted for the role it deliberately withholds", async function () {
			await expect(deployment.cutTx).to.not.emit(diamond, "RoleRevoked")
			const receipt = await deployment.cutTx.wait()
			const granted = receipt!.logs
				.map(log => {
					try {
						return diamond.interface.parseLog({ topics: [...log.topics], data: log.data })
					} catch {
						return null
					}
				})
				.filter(parsed => parsed?.name === "RoleGranted")
			expect(granted).to.have.lengthOf(4)
			expect(granted.map(entry => entry!.args[0])).to.not.include(REVOKER_ROLE)
		})

		it("grants the admin DEFAULT_ADMIN, SETTER, TEMPLATE_MANAGER and OPERATOR but not REVOKER", async function () {
			expect(await diamond.hasRole(DEFAULT_ADMIN_ROLE, adminAddress)).to.equal(true)
			expect(await diamond.hasRole(SETTER_ROLE, adminAddress)).to.equal(true)
			expect(await diamond.hasRole(TEMPLATE_MANAGER_ROLE, adminAddress)).to.equal(true)
			expect(await diamond.hasRole(OPERATOR_ROLE, adminAddress)).to.equal(true)
			expect(await diamond.hasRole(REVOKER_ROLE, adminAddress)).to.equal(false)
		})

		it("grants nothing to anyone but the admin", async function () {
			for (const role of [DEFAULT_ADMIN_ROLE, SETTER_ROLE, TEMPLATE_MANAGER_ROLE, OPERATOR_ROLE, REVOKER_ROLE]) {
				expect(await diamond.hasRole(role, strangerAddress)).to.equal(false)
			}
		})

		it("refuses a second init through diamondCut", async function () {
			const init = await ethers.getContractAt("contracts/instantLayer/Init.sol:Init", deployment.initAddress)
			const diamondCut = await ethers.getContractAt("IDiamondCut", deployment.address)
			const initCall = init.interface.encodeFunctionData("init", [symmio, adminAddress])
			const cutCall = diamondCut.interface.encodeFunctionData("diamondCut", [[], deployment.initAddress, initCall])

			const error: any = await ethers.provider.call({ to: deployment.address, from: adminAddress, data: cutCall }).then(
				() => null,
				(caught: any) => caught,
			)
			expect(error, "a second init through diamondCut should revert").to.not.equal(null)

			// LibDiamond bubbles a failed init as revert(string(returndata)), so the custom
			// error arrives as the payload of an Error(string) rather than as itself.
			const data: string = error.data ?? error.info?.error?.data ?? ""
			expect(data.slice(0, 10), `unexpected revert data ${data}`).to.equal("0x08c379a0")
			const [inner] = ethers.AbiCoder.defaultAbiCoder().decode(["bytes"], `0x${data.slice(10)}`)
			expect(inner).to.equal(ethers.id("AlreadyInitialized()").slice(0, 10))
		})

		it("refuses a second init on Init itself", async function () {
			const InitFactory = await ethers.getContractFactory("contracts/instantLayer/Init.sol:Init")
			const init = await InitFactory.connect(admin).deploy()
			await init.waitForDeployment()

			await init.init(symmio, adminAddress)
			await expect(init.init(symmio, adminAddress)).to.be.revertedWithCustomError(init, "AlreadyInitialized")
		})

		it("rejects a zero symmio or a zero admin", async function () {
			const InitFactory = await ethers.getContractFactory("contracts/instantLayer/Init.sol:Init")
			const init = await InitFactory.connect(admin).deploy()
			await init.waitForDeployment()

			await expect(init.init(ethers.ZeroAddress, adminAddress)).to.be.revertedWithCustomError(init, "ZeroAddress")
			await expect(init.init(symmio, ethers.ZeroAddress)).to.be.revertedWithCustomError(init, "ZeroAddress")
		})
	})

	describe("role management", async function () {
		it("keeps the OpenZeppelin selectors for the role externals", async function () {
			// Every other test here consumes whatever order the ABI declares, so a self-consistent
			// flip to (address,bytes32) would pass all of them while breaking every bot and script
			// already encoding these calls. These four literals are the wire contract.
			const expected: Record<string, string> = {
				"grantRole(bytes32,address)": "0x2f2ff15d",
				"hasRole(bytes32,address)": "0x91d14854",
				"revokeRole(bytes32,address)": "0xd547741f",
				"renounceRole(bytes32,address)": "0x36568abe",
			}
			for (const [signature, selector] of Object.entries(expected)) {
				const name = signature.slice(0, signature.indexOf("("))
				const fragment = diamond.interface.getFunction(name)
				expect(fragment, `${name} is not on the diamond`).to.not.equal(null)
				expect(fragment!.format("sighash"), `${name} argument order changed`).to.equal(signature)
				expect(fragment!.selector, `${signature} selector changed`).to.equal(selector)
			}
		})

		it("lets the admin grant a role and emits RoleGranted", async function () {
			await expect(diamond.connect(admin).grantRole(OPERATOR_ROLE, strangerAddress))
				.to.emit(diamond, "RoleGranted")
				.withArgs(OPERATOR_ROLE, strangerAddress, adminAddress)
			expect(await diamond.hasRole(OPERATOR_ROLE, strangerAddress)).to.equal(true)
		})

		it("grants only the role that was named", async function () {
			// The library takes (user, role) while this external takes (role, account). A
			// transposed call site would move the grant onto the wrong role, so assert the
			// other three roles stayed false.
			await diamond.connect(admin).grantRole(SETTER_ROLE, strangerAddress)
			expect(await diamond.hasRole(SETTER_ROLE, strangerAddress)).to.equal(true)
			for (const role of [DEFAULT_ADMIN_ROLE, OPERATOR_ROLE, REVOKER_ROLE]) {
				expect(await diamond.hasRole(role, strangerAddress)).to.equal(false)
			}
			// A grant must land on the named account, not on the caller.
			expect(await diamond.hasRole(SETTER_ROLE, outsiderAddress)).to.equal(false)
		})

		it("refuses a grant from a caller who is not a role admin", async function () {
			await expect(diamond.connect(stranger).grantRole(OPERATOR_ROLE, strangerAddress)).to.be.revertedWithCustomError(diamond, "MustBeRoleAdmin")
			expect(await diamond.hasRole(OPERATOR_ROLE, strangerAddress)).to.equal(false)
		})

		it("lets the admin revoke a role and emits RoleRevoked", async function () {
			await diamond.connect(admin).grantRole(OPERATOR_ROLE, strangerAddress)
			await expect(diamond.connect(admin).revokeRole(OPERATOR_ROLE, strangerAddress))
				.to.emit(diamond, "RoleRevoked")
				.withArgs(OPERATOR_ROLE, strangerAddress, adminAddress)
			expect(await diamond.hasRole(OPERATOR_ROLE, strangerAddress)).to.equal(false)
		})

		it("refuses a revoke from a caller who is not a role admin", async function () {
			await diamond.connect(admin).grantRole(OPERATOR_ROLE, strangerAddress)
			await expect(diamond.connect(stranger).revokeRole(OPERATOR_ROLE, strangerAddress)).to.be.revertedWithCustomError(diamond, "MustBeRoleAdmin")
			expect(await diamond.hasRole(OPERATOR_ROLE, strangerAddress)).to.equal(true)
		})

		it("lets a delegated role admin grant that one role only", async function () {
			await diamond.connect(admin).setRoleAdmin(strangerAddress, OPERATOR_ROLE, true)
			await diamond.connect(stranger).grantRole(OPERATOR_ROLE, outsiderAddress)
			expect(await diamond.hasRole(OPERATOR_ROLE, outsiderAddress)).to.equal(true)
			await expect(diamond.connect(stranger).grantRole(SETTER_ROLE, outsiderAddress)).to.be.revertedWithCustomError(diamond, "MustBeRoleAdmin")
		})

		it("refuses setRoleAdmin from anyone but DEFAULT_ADMIN_ROLE", async function () {
			await expect(diamond.connect(stranger).setRoleAdmin(strangerAddress, OPERATOR_ROLE, true)).to.be.revertedWithCustomError(
				diamond,
				"MustHaveRole",
			)
		})

		it("lets a holder renounce their own role", async function () {
			await diamond.connect(admin).grantRole(OPERATOR_ROLE, strangerAddress)
			await expect(diamond.connect(stranger).renounceRole(OPERATOR_ROLE, strangerAddress))
				.to.emit(diamond, "RoleRevoked")
				.withArgs(OPERATOR_ROLE, strangerAddress, strangerAddress)
			expect(await diamond.hasRole(OPERATOR_ROLE, strangerAddress)).to.equal(false)
		})

		it("refuses a renounce on someone else's behalf", async function () {
			await diamond.connect(admin).grantRole(OPERATOR_ROLE, strangerAddress)
			await expect(diamond.connect(admin).renounceRole(OPERATOR_ROLE, strangerAddress)).to.be.revertedWithCustomError(
				diamond,
				"CanOnlyRenounceForSelf",
			)
			expect(await diamond.hasRole(OPERATOR_ROLE, strangerAddress)).to.equal(true)
		})
	})

	describe("ownership", async function () {
		it("lets the owner start a transfer and refuses everyone else", async function () {
			await expect(diamond.connect(admin).transferOwnership(strangerAddress))
				.to.emit(diamond, "OwnershipTransferStarted")
				.withArgs(adminAddress, strangerAddress)
			await expect(diamond.connect(stranger).transferOwnership(strangerAddress)).to.be.revertedWith("LibDiamond: Must be contract owner")
		})

		it("hands ownership over only to the pending owner", async function () {
			await diamond.connect(admin).transferOwnership(strangerAddress)
			await expect(diamond.connect(outsider).acceptOwnership()).to.be.revertedWith("LibDiamond: Sender should be the pendingOwner")
			await expect(diamond.connect(stranger).acceptOwnership()).to.emit(diamond, "OwnershipTransferred").withArgs(adminAddress, strangerAddress)
		})

		it("lets the owner cancel a pending transfer", async function () {
			await diamond.connect(admin).transferOwnership(strangerAddress)
			await expect(diamond.connect(stranger).cancelOwnershipTransfer()).to.be.revertedWith("LibDiamond: Must be contract owner")
			await expect(diamond.connect(admin).cancelOwnershipTransfer()).to.emit(diamond, "OwnershipTransferCanceled").withArgs(strangerAddress)
			await expect(diamond.connect(stranger).acceptOwnership()).to.be.revertedWith("LibDiamond: Sender should be the pendingOwner")
		})

		it("moves diamondCut authority to the new owner", async function () {
			// This is the point of the two-step transfer: diamondCut gates on the diamond owner,
			// not on a role, so without it upgrade authority is frozen at the deploy-time EOA.
			const diamondCut = await ethers.getContractAt("IDiamondCut", deployment.address)
			const loupeFactory = await ethers.getContractFactory("DiamondLoupeFacet")
			const spare = await loupeFactory.connect(admin).deploy()
			await spare.waitForDeployment()
			const spareAddress = await spare.getAddress()
			const selectors = [diamond.interface.getFunction("facetAddresses")!.selector]
			const replace = [{ facetAddress: spareAddress, action: 1, functionSelectors: selectors }]

			await diamond.connect(admin).transferOwnership(strangerAddress)
			await diamond.connect(stranger).acceptOwnership()

			await expect(diamondCut.connect(admin).diamondCut(replace, ethers.ZeroAddress, "0x")).to.be.revertedWith("LibDiamond: Must be contract owner")
			await diamondCut.connect(stranger).diamondCut(replace, ethers.ZeroAddress, "0x")
			const loupe = await ethers.getContractAt("IDiamondLoupe", deployment.address)
			expect(await loupe.facetAddress(selectors[0])).to.equal(spareAddress)
		})
	})

	describe("configuration, gated by SETTER_ROLE", async function () {
		it("whitelists a target for the setter and refuses everyone else", async function () {
			await expect(diamond.connect(admin).setTargetWhitelist(outsiderAddress, true))
				.to.emit(diamond, "TargetWhitelistUpdated")
				.withArgs(outsiderAddress, true)
			await expect(diamond.connect(stranger).setTargetWhitelist(outsiderAddress, true)).to.be.revertedWithCustomError(diamond, "MustHaveRole")
		})

		it("rejects a zero target", async function () {
			await expect(diamond.connect(admin).setTargetWhitelist(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(diamond, "InvalidCallData")
		})

		it("registers PartyBs for the setter and refuses everyone else", async function () {
			await expect(diamond.connect(admin).registerPartyBs([strangerAddress]))
				.to.emit(diamond, "PartyBRegistered")
				.withArgs(strangerAddress)
			expect(await diamond.hasRole(OPERATOR_ROLE, strangerAddress)).to.equal(true)

			await expect(diamond.connect(stranger).registerPartyBs([outsiderAddress])).to.be.revertedWithCustomError(diamond, "MustHaveRole")
		})

		it("refuses an empty PartyB array and a duplicate registration", async function () {
			await expect(diamond.connect(admin).registerPartyBs([])).to.be.revertedWithCustomError(diamond, "EmptyArray")
			await diamond.connect(admin).registerPartyBs([strangerAddress])
			await expect(diamond.connect(admin).registerPartyBs([strangerAddress]))
				.to.be.revertedWithCustomError(diamond, "PartyBAlreadyRegistered")
				.withArgs(strangerAddress)
		})

		it("unregisters a PartyB and takes its OPERATOR_ROLE back", async function () {
			await diamond.connect(admin).registerPartyBs([strangerAddress])
			await expect(diamond.connect(admin).unregisterPartyB(strangerAddress)).to.emit(diamond, "PartyBUnregistered").withArgs(strangerAddress)
			expect(await diamond.hasRole(OPERATOR_ROLE, strangerAddress)).to.equal(false)

			await expect(diamond.connect(admin).unregisterPartyB(strangerAddress))
				.to.be.revertedWithCustomError(diamond, "PartyBNotRegistered")
				.withArgs(strangerAddress)
		})

		it("moves the whitelist entry when the AccountLayer changes", async function () {
			await expect(diamond.connect(admin).setAccountLayer(outsiderAddress))
				.to.emit(diamond, "AccountLayerUpdated")
				.withArgs(ethers.ZeroAddress, outsiderAddress)
			await expect(diamond.connect(stranger).setAccountLayer(strangerAddress)).to.be.revertedWithCustomError(diamond, "MustHaveRole")
			await expect(diamond.connect(admin).setAccountLayer(ethers.ZeroAddress))
				.to.be.revertedWithCustomError(diamond, "UnregisteredAccountLayer")
				.withArgs(ethers.ZeroAddress)
		})

		it("sets the revocation cooldown for the setter and refuses everyone else", async function () {
			await expect(diamond.connect(admin).setRevocationCooldown(3600)).to.emit(diamond, "RevocationCooldownUpdated").withArgs(600, 3600)
			await expect(diamond.connect(stranger).setRevocationCooldown(3600)).to.be.revertedWithCustomError(diamond, "MustHaveRole")
		})

		it("holds the revocation cooldown inside its bounds", async function () {
			await expect(diamond.connect(admin).setRevocationCooldown(299)).to.be.revertedWithCustomError(diamond, "InvalidCallData")
			await expect(diamond.connect(admin).setRevocationCooldown(30 * 24 * 3600 + 1)).to.be.revertedWithCustomError(diamond, "InvalidCallData")
		})

		it("toggles the transient context for the setter and refuses everyone else", async function () {
			await expect(diamond.connect(admin).setTransientContextEnabled(false)).to.emit(diamond, "TransientContextEnabledUpdated").withArgs(false)
			await expect(diamond.connect(stranger).setTransientContextEnabled(true)).to.be.revertedWithCustomError(diamond, "MustHaveRole")
		})
	})

	describe("template administration, gated by TEMPLATE_MANAGER_ROLE", async function () {
		it("adds a template with a sequential id and emits TemplateAdded", async function () {
			await expect(diamond.connect(admin).addTemplate("InstantOpen", [EMPTY_OPERATION]))
				.to.emit(diamond, "TemplateAdded")
				.withArgs(0, "InstantOpen")
			await expect(diamond.connect(admin).addTemplate("InstantClose", [EMPTY_OPERATION]))
				.to.emit(diamond, "TemplateAdded")
				.withArgs(1, "InstantClose")
		})

		it("refuses addTemplate from a caller without SETTER_ROLE", async function () {
			await expect(diamond.connect(stranger).addTemplate("InstantOpen", [EMPTY_OPERATION])).to.be.revertedWithCustomError(diamond, "MustHaveRole")
		})

		it("refuses a template with no operations", async function () {
			await expect(diamond.connect(admin).addTemplate("Empty", [])).to.be.revertedWithCustomError(diamond, "EmptyTemplate")
		})

		it("toggles a template active for the setter and refuses everyone else", async function () {
			await diamond.connect(admin).addTemplate("InstantOpen", [EMPTY_OPERATION])
			await expect(diamond.connect(admin).setTemplateActive(0, false)).to.emit(diamond, "TemplateUpdated").withArgs(0, false)
			await expect(diamond.connect(stranger).setTemplateActive(0, true)).to.be.revertedWithCustomError(diamond, "MustHaveRole")
		})

		it("refuses to touch a template id that was never created", async function () {
			await expect(diamond.connect(admin).setTemplateActive(0, false)).to.be.revertedWithCustomError(diamond, "InvalidTemplate").withArgs(0)
			await expect(diamond.connect(admin).setTemplateInstantOpenMode(0, true)).to.be.revertedWithCustomError(diamond, "InvalidTemplate").withArgs(0)
		})

		it("sets instant-open mode for the setter and refuses everyone else", async function () {
			await diamond.connect(admin).addTemplate("InstantOpen", [EMPTY_OPERATION])
			await diamond.connect(admin).setTemplateInstantOpenMode(0, true)
			await expect(diamond.connect(stranger).setTemplateInstantOpenMode(0, true)).to.be.revertedWithCustomError(diamond, "MustHaveRole")
		})
	})
})
