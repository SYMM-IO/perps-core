import { expect } from "chai"
import { Contract, Signer, TypedDataDomain } from "ethers"
import { readFileSync } from "node:fs"

import { FacetCutAction, getSelectors } from "../../tasks/utils/diamondCut.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { cloneTypes } from "../helpers/instantLayerEIP712Types.js"
import { loadFixture } from "../helpers/network-helpers.js"
import { RunContext } from "../models/RunContext.js"
import { getBlockTimestamp } from "../utils/Common.js"
import { InstantLayerDiamondDeployment, deployInstantLayerDiamondForTest } from "../utils/InstantLayerDiamond.js"

const role = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name))
const EXECUTION_FACET = "contracts/instantLayer/facets/Execution/ExecutionFacet.sol:ExecutionFacet"
const SELECTOR = "0x12345678"
const EMPTY_OP = { insertionPoints: [], sourceIndices: [], sourceOffsets: [] }
const RELEASE_LIMIT = 23_552

describe("InstantLayer diamond upgrade", function () {
	let context: RunContext
	let admin: Signer
	let owner: Signer
	let ownerAddress: string
	let deployment: InstantLayerDiamondDeployment
	let diamond: Contract
	let domain: TypedDataDomain
	let accountAddress: string
	let delegateOne: string
	let delegateTwo: string

	beforeEach(async function () {
		context = await loadFixture(initializeFixture)
		admin = context.signers.admin
		owner = context.signers.user
		ownerAddress = await owner.getAddress()
		delegateOne = await context.signers.user2.getAddress()
		delegateTwo = await context.signers.others[1].getAddress()

		deployment = await deployInstantLayerDiamondForTest(ethers, admin, context.diamond, [
			"ControlFacet",
			"ViewFacet",
			"DelegationFacet",
			"ExecutionFacet",
		])
		diamond = deployment.diamond

		// executeBatch opens and closes a core execution scope, which core gates on this role.
		await context.controlFacet.connect(admin).grantRole(deployment.address, role("INSTANT_LAYER_ROLE"))
		await diamond.connect(admin).setAccountLayer(context.accountLayerDiamond)

		await context.accountManager.connect(owner).addAccount("upgradeAccount")
		const accounts = await context.accountManager.getAccounts(ownerAddress, 0, 100)
		accountAddress = accounts.find((a: { name: string }) => a.name === "upgradeAccount")!.accountAddress

		domain = {
			name: "SymmioInstantLayer",
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
			verifyingContract: deployment.address,
		}
	})

	async function signedGrant(delegate: string, signingDomain: TypedDataDomain = domain) {
		const op = {
			signer: ownerAddress,
			target: deployment.address,
			callData: diamond.interface.encodeFunctionData("grantDelegation", [
				{
					account: { addr: accountAddress, isPartyB: false },
					delegatedSigner: delegate,
					selectors: [SELECTOR],
					expiryTimestamp: await getBlockTimestamp(3600n),
				},
			]),
			signerAccount: { addr: accountAddress, isPartyB: false },
			flexFields: [],
			maxUses: 1,
			replayAttackHeader: { nonce: 0n, deadline: await getBlockTimestamp(300n), salt: ethers.hexlify(ethers.randomBytes(32)) },
		}
		return { op, sig: await owner.signTypedData(signingDomain, cloneTypes(), op) }
	}

	async function cutExecutionFacet(action: FacetCutAction) {
		const replacement = await (await ethers.getContractFactory(EXECUTION_FACET)).connect(admin).deploy()
		await replacement.waitForDeployment()
		const replacementAddress = await replacement.getAddress()
		const selectors = getSelectors(ethers, replacement as any).selectors
		const cut = await ethers.getContractAt("IDiamondCut", deployment.address)
		const facetAddress = action === FacetCutAction.Remove ? ethers.ZeroAddress : replacementAddress
		await cut.connect(admin).diamondCut([{ facetAddress, action, functionSelectors: selectors }], ethers.ZeroAddress, "0x")
		return { replacementAddress, selectors }
	}

	it("keeps templates, delegations, the domain and a pre-signed operation across a facet replacement", async function () {
		await diamond.connect(admin).addTemplate("t", [EMPTY_OP])
		await diamond.connect(owner).grantDelegation({
			account: { addr: accountAddress, isPartyB: false },
			delegatedSigner: delegateOne,
			selectors: [SELECTOR],
			expiryTimestamp: await getBlockTimestamp(3600n),
		})
		const { op, sig } = await signedGrant(delegateTwo)
		const separatorBefore = await diamond.domainSeparator()
		const opHash = await diamond.getOperationHash(op)

		const { replacementAddress, selectors } = await cutExecutionFacet(FacetCutAction.Replace)

		const loupe = await ethers.getContractAt("IDiamondLoupe", deployment.address)
		expect(await loupe.facetAddress(selectors[0])).to.equal(replacementAddress)
		expect(replacementAddress).to.not.equal(deployment.facetAddresses.ExecutionFacet)

		expect(await diamond.domainSeparator()).to.equal(separatorBefore)
		expect(await diamond.getOperationHash(op)).to.equal(opHash)
		expect((await diamond.getTemplate(0)).name).to.equal("t")
		expect(await diamond.nextTemplateId()).to.equal(1n)
		expect(await diamond.isDelegationActive(accountAddress, delegateOne, SELECTOR)).to.equal(true)

		await diamond.connect(admin).executeBatch([op], [sig], [[]], [[]])
		expect(await diamond.isDelegationActive(accountAddress, delegateTwo, SELECTOR)).to.equal(true)
		expect(await diamond.operationUsageCount(opHash)).to.equal(1n)
	})

	it("stops routing execution once the execution selectors are removed", async function () {
		const { op, sig } = await signedGrant(delegateTwo)
		await cutExecutionFacet(FacetCutAction.Remove)
		await expect(diamond.connect(admin).executeBatch([op], [sig], [[]], [[]])).to.be.reverted
		expect(await diamond.isDelegationActive(accountAddress, delegateTwo, SELECTOR)).to.equal(false)
	})

	it("refuses a cut from anyone but the owner", async function () {
		const cut = await ethers.getContractAt("IDiamondCut", deployment.address)
		await expect(cut.connect(owner).diamondCut([], ethers.ZeroAddress, "0x")).to.be.reverted
	})

	it("refuses execution on the facet contract itself", async function () {
		const { op, sig } = await signedGrant(delegateTwo)
		const facet = await ethers.getContractAt(EXECUTION_FACET, deployment.facetAddresses.ExecutionFacet)
		await expect(facet.connect(admin).executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(facet, "MustHaveRole")
	})

	it("rejects an operation signed for another verifying contract", async function () {
		const { op, sig } = await signedGrant(delegateTwo, { ...domain, verifyingContract: await context.instantLayer.getAddress() })
		await expect(diamond.connect(admin).executeBatch([op], [sig], [[]], [[]])).to.be.revertedWithCustomError(diamond, "InvalidSignature")
	})

	it("keeps every facet under the release size limit", function () {
		for (const [group, name] of [
			["Control", "ControlFacet"],
			["Execution", "ExecutionFacet"],
			["Delegation", "DelegationFacet"],
			["View", "ViewFacet"],
		]) {
			const artifact = JSON.parse(readFileSync(`artifacts/contracts/instantLayer/facets/${group}/${name}.sol/${name}.json`, "utf8"))
			const bytes = (artifact.deployedBytecode.length - 2) / 2
			expect(bytes, `${name} is ${bytes} bytes`).to.be.lessThanOrEqual(RELEASE_LIMIT)
		}
	})
})
