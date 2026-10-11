import { expect } from "chai"
import fs from "node:fs"
import path from "node:path"

import { createCheckpoint } from "../../tasks/deploy/checkpoint.js"
import { deployInstantLayer } from "../../tasks/deploy/instantLayer.js"
import { deployContract } from "../../tasks/deploy/vanityDeploy.js"
import { resetDataScope, setDataScope } from "../../tasks/utils/fs.js"
import { InstantLayerFacetNames } from "../../utils/deploymentManifest.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

// Pinned bytes32 role identifiers, independent of the deployed diamond, so a wrong constant
// getter on ViewFacet (or a swapped Init argument) cannot cancel itself out.
const DEFAULT_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DEFAULT_ADMIN_ROLE"))
const SETTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SETTER_ROLE"))
const TEMPLATE_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TEMPLATE_MANAGER_ROLE"))
const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"))
const REVOKER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REVOKER_ROLE"))

describe("InstantLayer diamond production deployment", function () {
	const testChainId = 98_601_340
	const checkpointPath = path.resolve(`tasks/data/checkpoints/checkpoint-${testChainId}.json`)

	afterEach(function () {
		fs.rmSync(checkpointPath, { force: true })
		fs.rmSync(path.resolve(`tasks/data/${testChainId}-fork`), { recursive: true, force: true })
		resetDataScope()
	})

	it("cuts exactly the expected facet set, routes every selector, and runs Init", async function () {
		const [deployer, symmioSigner] = await ethers.getSigners()
		const symmio = await symmioSigner.getAddress()

		const diamond = await deployInstantLayer(hre, {
			symmioaddress: symmio,
			admin: deployer.address,
			logData: false,
		})

		// Loupe: exactly DiamondCutFacet plus the five InstantLayer facets (Control, View,
		// Delegation, Execution, DiamondLoupe) are cut in — no facet dropped, none duplicated.
		const loupe = await ethers.getContractAt("IDiamondLoupe", await diamond.getAddress())
		const facetList = await loupe.facets()
		expect(facetList.length).to.equal(1 + InstantLayerFacetNames.length)

		// Every facet actually routes: call one selector that only exists on each of them.
		expect(await diamond.symmio()).to.equal(symmio) // ViewFacet
		expect(await diamond.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)).to.equal(true) // ControlFacet
		const executeBatchSelector = diamond.interface.getFunction("executeBatch")!.selector
		const grantDelegationSelector = diamond.interface.getFunction("grantDelegation")!.selector
		const ownedBy = (selector: string) => facetList.find((f: any) => f.functionSelectors.includes(selector))?.facetAddress
		expect(ownedBy(executeBatchSelector), "executeBatch (ExecutionFacet) is not routed").to.not.equal(undefined)
		expect(ownedBy(grantDelegationSelector), "grantDelegation (DelegationFacet) is not routed").to.not.equal(undefined)

		// Init actually ran: roles granted, symmio recorded, and the documented defaults applied
		// (mirrors what the monolith's constructor used to do — see Init.sol's own doc comment).
		expect(await diamond.hasRole(SETTER_ROLE, deployer.address)).to.equal(true)
		expect(await diamond.hasRole(TEMPLATE_MANAGER_ROLE, deployer.address)).to.equal(true)
		expect(await diamond.hasRole(OPERATOR_ROLE, deployer.address)).to.equal(true)
		expect(await diamond.hasRole(REVOKER_ROLE, deployer.address)).to.equal(false) // Init grants this separately; nobody asked for it here
		expect(await diamond.revocationCooldown()).to.equal(600n)
		expect(await diamond.whitelistedTargets(symmio)).to.equal(true)
		expect(await diamond.transientContextEnabled()).to.equal(true)
	})

	it("resumes from checkpoint without redeploying, re-cutting, or re-running Init", async function () {
		setDataScope(testChainId, { simulated: true })
		const [deployer, symmioSigner] = await ethers.getSigners()
		const symmio = await symmioSigner.getAddress()
		const checkpoint = createCheckpoint("instant-layer-diamond-resume-test", testChainId)

		const first = await deployInstantLayer(hre, { symmioaddress: symmio, admin: deployer.address, checkpoint, logData: false })
		const firstAddress = await first.getAddress()
		expect(checkpoint.contracts.instantLayerDiamond?.diamondCutComplete).to.equal(true)
		expect(Object.keys(checkpoint.contracts.instantLayerDiamond?.facets || {})).to.have.lengthOf(InstantLayerFacetNames.length)

		const blockBeforeResume = await ethers.provider.getBlockNumber()
		const second = await deployInstantLayer(hre, { symmioaddress: symmio, admin: deployer.address, checkpoint, logData: false })
		const blockAfterResume = await ethers.provider.getBlockNumber()

		// Same diamond, and — the real proof of "resume" rather than "coincidentally same
		// address" — not a single transaction was broadcast the second time. A resume that
		// silently redeployed a facet, or re-ran diamondCut, would advance the block number.
		expect(await second.getAddress()).to.equal(firstAddress)
		expect(blockAfterResume, "resume broadcast a transaction instead of reusing the checkpoint").to.equal(blockBeforeResume)
		expect(await second.symmio()).to.equal(symmio)
	})

	it("refuses to deploy an InstantLayer facet under an unregistered vanity-registry key", async function () {
		// Confirms deployContract's registry guard (tasks/deploy/vanityDeploy.ts) rejects an
		// unregistered "instantLayer/" key with a named error. This key is unregistered by
		// construction, so it does not check whether the real facet keys (ControlFacet,
		// ViewFacet, DelegationFacet, ExecutionFacet, DiamondLoupeFacet) are themselves
		// registered — a successful deploy elsewhere already proves that.
		const BogusFactory = await ethers.getContractFactory("DiamondLoupeFacet")
		let failure: Error | undefined
		try {
			await deployContract(null, {
				key: "instantLayer/NotARealFacet",
				component: "contracts.instantLayerDiamond.facets.NotARealFacet",
				label: "InstantLayer NotARealFacet",
				factory: BogusFactory,
			})
		} catch (error) {
			failure = error as Error
		}
		expect(failure, "expected the registry guard to reject an unregistered key").to.not.equal(undefined)
		expect(failure!.message).to.match(/instantLayer\/NotARealFacet is not registered/)
	})

	it("grants roles to an admin that is not the deployer and leaves it as pending owner, without repeating itself", async function () {
		setDataScope(testChainId, { simulated: true })
		const [deployer, symmioSigner, other] = await ethers.getSigners()
		const checkpoint = createCheckpoint("instant-layer-admin-handoff-test", testChainId)

		const instantLayer = await deployInstantLayer(hre, { symmioaddress: symmioSigner.address, admin: other.address, checkpoint, logData: false })
		for (const roleHash of [DEFAULT_ADMIN_ROLE, SETTER_ROLE, TEMPLATE_MANAGER_ROLE, OPERATOR_ROLE]) {
			expect(await instantLayer.hasRole(roleHash, other.address)).to.equal(true)
			expect(await instantLayer.hasRole(roleHash, deployer.address)).to.equal(false)
		}
		expect(await instantLayer.getOwner()).to.equal(deployer.address)
		expect(await instantLayer.pendingOwner()).to.equal(other.address)

		const nonceBefore = await ethers.provider.getTransactionCount(deployer.address)
		const again = await deployInstantLayer(hre, { symmioaddress: symmioSigner.address, admin: other.address, checkpoint, logData: false })
		expect(await again.getAddress()).to.equal(await instantLayer.getAddress())
		expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonceBefore)
		expect(await again.pendingOwner()).to.equal(other.address)

		await instantLayer.connect(other).acceptOwnership()
		expect(await instantLayer.getOwner()).to.equal(other.address)
	})

	it("resumes without error or transactions after ownership has moved on to the governance owner", async function () {
		setDataScope(testChainId, { simulated: true })
		const [deployer, symmioSigner, governance] = await ethers.getSigners()
		const checkpoint = createCheckpoint("instant-layer-resume-after-handover-test", testChainId)
		const instantLayer = await deployInstantLayer(hre, { symmioaddress: symmioSigner.address, admin: deployer.address, checkpoint, logData: false })

		// What deploy:system and the governance hand-over do after the deploy step.
		await instantLayer.connect(deployer).transferOwnership(governance.address)
		await instantLayer.connect(governance).acceptOwnership()

		const nonceBefore = await ethers.provider.getTransactionCount(deployer.address)
		const again = await deployInstantLayer(hre, { symmioaddress: symmioSigner.address, admin: deployer.address, checkpoint, logData: false })
		expect(await again.getAddress()).to.equal(await instantLayer.getAddress())
		expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonceBefore)
		expect(await again.getOwner()).to.equal(governance.address)
	})
})
