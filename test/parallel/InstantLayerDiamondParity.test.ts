import { expect } from "chai"
import { Contract, Signer } from "ethers"
import { readFileSync } from "node:fs"

import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { RunContext } from "../models/RunContext.js"
import { getBlockTimestamp } from "../utils/Common.js"
import { InstantLayerDiamondDeployment, deployInstantLayerDiamondForTest } from "../utils/InstantLayerDiamond.js"

const role = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))
const ALL_FACETS = ["ControlFacet", "ViewFacet", "DelegationFacet", "ExecutionFacet", "MigrationFacet"]
const EMPTY_OP = { insertionPoints: [], sourceIndices: [], sourceOffsets: [] }

describe("InstantLayer diamond parity with the monolith", function () {
	let context: RunContext
	let admin: Signer
	let stranger: Signer
	let strangerAddress: string
	let deployment: InstantLayerDiamondDeployment
	let diamond: Contract

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		admin = context.signers.admin
		stranger = context.signers.others[0]
		strangerAddress = await stranger.getAddress()
		deployment = await deployInstantLayerDiamondForTest(ethers, admin, context.diamond, ALL_FACETS)
		diamond = deployment.diamond
	})

	describe("TEMPLATE_MANAGER_ROLE", function () {
		it("is granted to the admin at init and exposed by the view facet", async function () {
			expect(await diamond.TEMPLATE_MANAGER_ROLE()).to.equal(role("TEMPLATE_MANAGER_ROLE"))
			expect(await diamond.hasRole(role("TEMPLATE_MANAGER_ROLE"), await admin.getAddress())).to.equal(true)
		})

		it("refuses addTemplate and setTemplateActive from a holder of SETTER_ROLE only", async function () {
			await diamond.connect(admin).grantRole(role("SETTER_ROLE"), strangerAddress)
			await expect(diamond.connect(stranger).addTemplate("t", [EMPTY_OP])).to.be.revertedWithCustomError(diamond, "MustHaveRole")
			await diamond.connect(admin).addTemplate("t", [EMPTY_OP])
			await expect(diamond.connect(stranger).setTemplateActive(0, false)).to.be.revertedWithCustomError(diamond, "MustHaveRole")
		})

		it("lets a holder of TEMPLATE_MANAGER_ROLE only add and toggle templates", async function () {
			await diamond.connect(admin).grantRole(role("TEMPLATE_MANAGER_ROLE"), strangerAddress)
			await expect(diamond.connect(stranger).addTemplate("t", [EMPTY_OP]))
				.to.emit(diamond, "TemplateAdded")
				.withArgs(0, "t")
			await diamond.connect(stranger).setTemplateActive(0, false)
			expect((await diamond.getTemplate(0)).active).to.equal(false)
		})

		it("keeps setTemplateInstantOpenMode on SETTER_ROLE", async function () {
			await diamond.connect(admin).addTemplate("t", [EMPTY_OP])
			await diamond.connect(admin).grantRole(role("TEMPLATE_MANAGER_ROLE"), strangerAddress)
			await expect(diamond.connect(stranger).setTemplateInstantOpenMode(0, true)).to.be.revertedWithCustomError(diamond, "MustHaveRole")
		})
	})

	describe("grantDelegations", function () {
		const SELECTOR_A = "0x12345678"
		const SELECTOR_B = "0x9abcdef0"
		let owner: Signer
		let accountAddress: string
		let delegateOne: string
		let delegateTwo: string

		beforeEach(async function () {
			owner = context.signers.user
			delegateOne = await context.signers.user2.getAddress()
			delegateTwo = await context.signers.others[1].getAddress()
			await diamond.connect(admin).setAccountLayer(context.accountLayerDiamond)
			await context.accountManager.connect(owner).addAccount("parityAccount")
			const accounts = await context.accountManager.getAccounts(await owner.getAddress(), 0, 100)
			accountAddress = accounts.find((a: { name: string }) => a.name === "parityAccount")!.accountAddress
		})

		const info = (delegate: string, selector: string, expiry: bigint, account = accountAddress) => ({
			account: { addr: account, isPartyB: false },
			delegatedSigner: delegate,
			selectors: [selector],
			expiryTimestamp: expiry,
		})

		it("grants several delegates, each with its own selector and expiry", async function () {
			const expiryOne = await getBlockTimestamp(3600n)
			const expiryTwo = await getBlockTimestamp(7200n)
			await diamond.connect(owner).grantDelegations([info(delegateOne, SELECTOR_A, expiryOne), info(delegateTwo, SELECTOR_B, expiryTwo)])
			expect(await diamond.delegations(accountAddress, delegateOne, SELECTOR_A)).to.equal(expiryOne)
			expect(await diamond.delegations(accountAddress, delegateTwo, SELECTOR_B)).to.equal(expiryTwo)
			expect(await diamond.isDelegationActive(accountAddress, delegateOne, SELECTOR_B)).to.equal(false)
		})

		it("reverts on an empty list", async function () {
			await expect(diamond.connect(owner).grantDelegations([])).to.be.revertedWithCustomError(diamond, "InvalidDelegation")
		})

		it("reverts when an entry names a different account", async function () {
			const expiry = await getBlockTimestamp(3600n)
			await expect(
				diamond.connect(owner).grantDelegations([info(delegateOne, SELECTOR_A, expiry), info(delegateTwo, SELECTOR_B, expiry, strangerAddress)]),
			).to.be.revertedWithCustomError(diamond, "InvalidDelegation")
		})

		it("reverts for a caller who does not own the account", async function () {
			const expiry = await getBlockTimestamp(3600n)
			await expect(diamond.connect(stranger).grantDelegations([info(delegateOne, SELECTOR_A, expiry)]))
				.to.be.revertedWithCustomError(diamond, "NotOwnerOfAccount")
				.withArgs(strangerAddress, accountAddress)
		})
	})

	describe("isRoleAdmin", function () {
		it("reports DEFAULT_ADMIN_ROLE holders as admins of every role", async function () {
			expect(await diamond.isRoleAdmin(await admin.getAddress(), role("OPERATOR_ROLE"))).to.equal(true)
			expect(await diamond.isRoleAdmin(strangerAddress, role("OPERATOR_ROLE"))).to.equal(false)
		})

		it("keeps showing a per-role admin after that account holds no role at all", async function () {
			await diamond.connect(admin).setRoleAdmin(strangerAddress, role("SETTER_ROLE"), true)
			expect(await diamond.hasRole(role("SETTER_ROLE"), strangerAddress)).to.equal(false)
			expect(await diamond.isRoleAdmin(strangerAddress, role("SETTER_ROLE"))).to.equal(true)
			expect(await diamond.isRoleAdmin(strangerAddress, role("OPERATOR_ROLE"))).to.equal(false)
			await diamond.connect(admin).setRoleAdmin(strangerAddress, role("SETTER_ROLE"), false)
			expect(await diamond.isRoleAdmin(strangerAddress, role("SETTER_ROLE"))).to.equal(false)
		})
	})

	describe("eip712Domain", function () {
		it("describes the SymmioInstantLayer domain bound to the diamond's address", async function () {
			const [fields, name, version, chainId, verifyingContract, salt, extensions] = await diamond.eip712Domain()
			expect(fields).to.equal("0x0f")
			expect(name).to.equal("SymmioInstantLayer")
			expect(version).to.equal("1")
			expect(chainId).to.equal((await ethers.provider.getNetwork()).chainId)
			expect(verifyingContract).to.equal(deployment.address)
			expect(salt).to.equal(ethers.ZeroHash)
			expect([...extensions]).to.deep.equal([])
		})

		it("agrees with domainSeparator", async function () {
			const [, name, version, chainId, verifyingContract] = await diamond.eip712Domain()
			expect(await diamond.domainSeparator()).to.equal(ethers.TypedDataEncoder.hashDomain({ name, version, chainId, verifyingContract }))
		})
	})

	describe("ABI", function () {
		const loadAbi = (file: string) => JSON.parse(readFileSync(file, "utf8")).abi
		const legacyAbi = () => loadAbi("scripts/utils/legacy/InstantLayerV1.json")
		const diamondAbi = () => loadAbi("artifacts/contracts/instantLayer/interfaces/IInstantLayerDiamond.sol/IInstantLayerDiamond.json")

		const REMOVED_FUNCTIONS = ["getRoleAdmin(bytes32)", "getRoleMember(bytes32,uint256)", "getRoleMemberCount(bytes32)", "getRoleMembers(bytes32)"]
		const ADDED_FUNCTIONS = [
			"MIGRATOR_ROLE()",
			"acceptOwnership()",
			"cancelOwnershipTransfer()",
			"diamondCut((address,uint8,bytes4[])[],address,bytes)",
			"delegationOwnershipEpoch(address,address,bytes4)",
			"facetAddress(bytes4)",
			"facetAddresses()",
			"facetFunctionSelectors(address)",
			"facets()",
			"getOwner()",
			"isRoleAdmin(address,bytes32)",
			"migrateDelegations(address,(address,address,bytes4[])[])",
			"pendingOwner()",
			"setRoleAdmin(address,bytes32,bool)",
			"transferOwnership(address)",
		]
		// Events and errors only OpenZeppelin's AccessControl and EIP712 emit or throw.
		const LEGACY_ONLY_EVENTS = ["EIP712DomainChanged", "RoleAdminChanged"]
		const LEGACY_ONLY_ERRORS = ["AccessControlBadConfirmation", "AccessControlUnauthorizedAccount", "InvalidShortString", "StringTooLong"]

		const functions = (abi: any[]) => {
			const map = new Map<string, string>()
			new ethers.Interface(abi).forEachFunction(f => {
				map.set(f.format("sighash"), `${f.outputs.map(o => o.format("sighash")).join(",")}|${f.stateMutability}`)
			})
			return map
		}

		it("keeps every monolith function with the same outputs and mutability, minus the four removed", function () {
			const legacy = functions(legacyAbi())
			const diamondFns = functions(diamondAbi())
			for (const removed of REMOVED_FUNCTIONS) expect(legacy.has(removed), `${removed} should exist on the monolith`).to.equal(true)
			for (const [signature, shape] of legacy) {
				if (REMOVED_FUNCTIONS.includes(signature)) {
					expect(diamondFns.has(signature), `${signature} should be gone`).to.equal(false)
					continue
				}
				expect(diamondFns.get(signature), signature).to.equal(shape)
			}
		})

		it("adds only ownership, role-admin, diamond, delegation-migration and ownership-epoch functions", function () {
			const legacy = functions(legacyAbi())
			const added = [...functions(diamondAbi()).keys()].filter(signature => !legacy.has(signature)).sort()
			expect(added).to.deep.equal([...ADDED_FUNCTIONS].sort())
		})

		it("keeps every monolith event with the same topic and indexing", function () {
			const diamondEvents = new Map<string, string>()
			new ethers.Interface(diamondAbi()).forEachEvent(e => diamondEvents.set(e.topicHash, e.inputs.map(i => i.indexed).join(",")))
			new ethers.Interface(legacyAbi()).forEachEvent(e => {
				if (LEGACY_ONLY_EVENTS.includes(e.name)) return
				expect(diamondEvents.get(e.topicHash), e.format("sighash")).to.equal(e.inputs.map(i => i.indexed).join(","))
			})
		})

		it("publishes only functions the diamond routes", function () {
			const routed = functions(diamondAbi())
			const publishedAbi = JSON.parse(readFileSync("abis/instantLayer.json", "utf8"))
			const published = [...functions(publishedAbi).keys()].filter(signature => !routed.has(signature))
			expect(published).to.deep.equal([])
		})

		it("keeps every error the monolith declares", function () {
			const diamondErrors = new Set<string>()
			new ethers.Interface(diamondAbi()).forEachError(e => diamondErrors.add(e.format("sighash")))
			const missing: string[] = []
			new ethers.Interface(legacyAbi()).forEachError(e => {
				if (!LEGACY_ONLY_ERRORS.includes(e.name) && !diamondErrors.has(e.format("sighash"))) missing.push(e.format("sighash"))
			})
			expect(missing).to.deep.equal([])
		})
	})
})
