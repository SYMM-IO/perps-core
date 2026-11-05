import { expect } from "chai"
import { Contract, Signer, TypedDataDomain, ZeroAddress } from "ethers"

import { ethers } from "../helpers/hardhat-connection.js"
import { cloneTypes, DELEGATE_TYPES, FLEX_FILLER_AUTH_TYPES } from "../helpers/instantLayerEIP712Types.js"
import { InstantLayerDiamondDeployment, deployInstantLayerDiamondForTest } from "../utils/InstantLayerDiamond.js"

const EMPTY_OPERATION = { insertionPoints: [], sourceIndices: [], sourceOffsets: [] }

describe("InstantLayer diamond view", async function () {
	let admin: Signer
	let stranger: Signer
	let adminAddress: string
	let strangerAddress: string
	let symmio: string
	let deployment: InstantLayerDiamondDeployment
	let diamond: Contract
	let domain: TypedDataDomain

	beforeEach(async function () {
		const signers = await ethers.getSigners()
		admin = signers[0]
		stranger = signers[1]
		adminAddress = await admin.getAddress()
		strangerAddress = await stranger.getAddress()
		// Nothing in this layer calls into symmio, so an EOA stands in for the core diamond.
		symmio = await signers[2].getAddress()

		deployment = await deployInstantLayerDiamondForTest(ethers, admin, symmio, ["ControlFacet", "ViewFacet"])
		diamond = deployment.diamond

		domain = {
			name: "SymmioInstantLayer",
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
			verifyingContract: deployment.address,
		}
	})

	describe("post-init state, asserted directly against storage", async function () {
		// The events prove the write happened at init time; these getters prove the value is
		// still readable afterwards, which the events alone cannot show.
		it("reports transientContextEnabled true", async function () {
			expect(await diamond.transientContextEnabled()).to.equal(true)
		})

		it("reports the symmio address whitelisted", async function () {
			expect(await diamond.whitelistedTargets(symmio)).to.equal(true)
		})

		it("reports symmio() as the init value and accountLayer() as zero until set", async function () {
			expect(await diamond.symmio()).to.equal(symmio)
			expect(await diamond.accountLayer()).to.equal(ZeroAddress)
		})

		it("reports the default revocation cooldown", async function () {
			expect(await diamond.revocationCooldown()).to.equal(600)
		})
	})

	describe("control writes, view reads", async function () {
		it("whitelists a target and reads it back", async function () {
			expect(await diamond.whitelistedTargets(strangerAddress)).to.equal(false)
			await diamond.connect(admin).setTargetWhitelist(strangerAddress, true)
			expect(await diamond.whitelistedTargets(strangerAddress)).to.equal(true)
		})

		it("registers a PartyB and reports it registered", async function () {
			expect(await diamond.isPartyBRegistered(strangerAddress)).to.equal(false)
			expect(await diamond.registeredPartyBs(strangerAddress)).to.equal(false)
			await diamond.connect(admin).registerPartyBs([strangerAddress])
			expect(await diamond.isPartyBRegistered(strangerAddress)).to.equal(true)
			expect(await diamond.registeredPartyBs(strangerAddress)).to.equal(true)
		})

		it("adds a template and reflects it in every template getter", async function () {
			await diamond.connect(admin).addTemplate("InstantOpen", [EMPTY_OPERATION])

			expect(await diamond.getNextTemplateId()).to.equal(1)

			const template = await diamond.getTemplate(0)
			expect(template.name).to.equal("InstantOpen")
			expect(template.active).to.equal(true)
			expect(template.operations.length).to.equal(1)

			const [name, active] = await diamond.templates(0)
			expect(name).to.equal("InstantOpen")
			expect(active).to.equal(true)

			const ops = await diamond.getTemplateOperations(0)
			expect(ops.length).to.equal(1)

			const range = await diamond.getTemplates(0, 10)
			expect(range.length).to.equal(1)
			expect(range[0].name).to.equal("InstantOpen")
		})
	})

	describe("EIP-712 domain and hashes", async function () {
		it("computes the domain separator the same way ethers does", async function () {
			const expected = ethers.TypedDataEncoder.hashDomain(domain)
			expect(await diamond.domainSeparator()).to.equal(expected)
		})

		it("hashes a signed operation with no flex fields the same way ethers does", async function () {
			// Pins the empty-array branch of _hashFlexFields: keccak256("") for zero elements,
			// separately from the non-empty case below.
			const types = cloneTypes()
			const signedOp = {
				signer: adminAddress,
				target: symmio,
				callData: "0x12345678",
				signerAccount: { addr: adminAddress, isPartyB: false },
				flexFields: [],
				maxUses: 1,
				replayAttackHeader: { nonce: 0, deadline: 0, salt: ethers.hexlify(ethers.randomBytes(32)) },
			}

			const expected = ethers.TypedDataEncoder.hash(domain, types, signedOp)
			expect(await diamond.getOperationHash(signedOp)).to.equal(expected)
		})

		it("hashes a signed operation with flex fields the same way ethers does", async function () {
			// Two flex fields exercise both the per-element FLEX_FIELD_TYPEHASH encoding and the
			// abi.encodePacked concatenation across more than one element — an empty flexFields
			// array (above) never enters this loop at all.
			// getOperationHash only hashes the flex field descriptors; it does not validate them
			// against callData bounds (that belongs to the execution facet's fill-application
			// path), so a short callData is fine here.
			const types = cloneTypes()
			const signedOp = {
				signer: adminAddress,
				target: symmio,
				callData: "0x12345678",
				signerAccount: { addr: adminAddress, isPartyB: false },
				flexFields: [
					{ offset: 0, length: 32, authorizedFlexFiller: adminAddress },
					{ offset: 32, length: 32, authorizedFlexFiller: strangerAddress },
				],
				maxUses: 1,
				replayAttackHeader: { nonce: 0, deadline: 0, salt: ethers.hexlify(ethers.randomBytes(32)) },
			}

			const expected = ethers.TypedDataEncoder.hash(domain, types, signedOp)
			expect(await diamond.getOperationHash(signedOp)).to.equal(expected)
		})

		it("hashes a flex fill authorization the same way ethers does", async function () {
			const opHash = ethers.hexlify(ethers.randomBytes(32))
			const fieldIndex = 0
			const value = ethers.hexlify(ethers.randomBytes(32))

			const expected = ethers.TypedDataEncoder.hash(domain, FLEX_FILLER_AUTH_TYPES, { opHash, fieldIndex, value })
			expect(await diamond.getFlexFillAuthHash(opHash, fieldIndex, value)).to.equal(expected)
		})

		it("hashes a signed delegation the same way ethers does", async function () {
			const signedDelegation = {
				delegationInfo: {
					account: { addr: adminAddress, isPartyB: false },
					delegatedSigner: strangerAddress,
					selectors: ["0x12345678"],
					expiryTimestamp: 9999999999,
				},
				replayAttackHeader: { nonce: 0, deadline: 0, salt: ethers.hexlify(ethers.randomBytes(32)) },
			}

			const expected = ethers.TypedDataEncoder.hash(domain, DELEGATE_TYPES, signedDelegation)
			expect(await diamond.getDelegationHash(signedDelegation)).to.equal(expected)
		})
	})

	describe("constant getters", async function () {
		it("returns the role identifiers used by ControlFacet", async function () {
			// DEFAULT_ADMIN_ROLE is keccak256("DEFAULT_ADMIN_ROLE") here, not OpenZeppelin's
			// bytes32(0) — a pinned spec decision matching LibInstantLayerAccessibility.
			expect(await diamond.DEFAULT_ADMIN_ROLE()).to.equal(ethers.keccak256(ethers.toUtf8Bytes("DEFAULT_ADMIN_ROLE")))
			expect(await diamond.SETTER_ROLE()).to.equal(ethers.keccak256(ethers.toUtf8Bytes("SETTER_ROLE")))
			expect(await diamond.OPERATOR_ROLE()).to.equal(ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE")))
			expect(await diamond.REVOKER_ROLE()).to.equal(ethers.keccak256(ethers.toUtf8Bytes("REVOKER_ROLE")))
		})

		it("returns every EIP-712 typehash constant, each matched to its own literal type string", async function () {
			// Reached only through the getters here — the parity tests above hit the library
			// constants directly and would not notice a copy/paste swap between two of these.
			expect(await diamond.ACCOUNT_TYPEHASH()).to.equal(ethers.keccak256(ethers.toUtf8Bytes("Account(address addr,bool isPartyB)")))
			expect(await diamond.REPLAY_HEADER_TYPEHASH()).to.equal(
				ethers.keccak256(ethers.toUtf8Bytes("ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)")),
			)
			expect(await diamond.FLEX_FIELD_TYPEHASH()).to.equal(
				ethers.keccak256(ethers.toUtf8Bytes("FlexField(uint256 offset,uint256 length,address authorizedFlexFiller)")),
			)
			expect(await diamond.FLEX_FILL_AUTH_TYPEHASH()).to.equal(
				ethers.keccak256(ethers.toUtf8Bytes("FlexFillAuth(bytes32 opHash,uint256 fieldIndex,bytes value)")),
			)
			expect(await diamond.DELEGATION_INFO_TYPEHASH()).to.equal(
				ethers.keccak256(
					ethers.toUtf8Bytes(
						"DelegationInfo(Account account,address delegatedSigner,bytes4[] selectors,uint256 expiryTimestamp)" +
							"Account(address addr,bool isPartyB)",
					),
				),
			)
			expect(await diamond.SIGNED_DELEGATION_TYPEHASH()).to.equal(
				ethers.keccak256(
					ethers.toUtf8Bytes(
						"SignedDelegation(DelegationInfo delegationInfo,ReplayAttackHeader replayAttackHeader)" +
							"Account(address addr,bool isPartyB)" +
							"DelegationInfo(Account account,address delegatedSigner,bytes4[] selectors,uint256 expiryTimestamp)" +
							"ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)",
					),
				),
			)
		})
	})
})
