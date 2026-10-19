import { expect } from "chai"

import { FacetCutAction, getSelectors } from "../../tasks/utils/diamondCut.js"
import { initializeFixture } from "../Initialize.fixture.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { loadFixture, time } from "../helpers/network-helpers.js"

describe("Audit remediation coordinated upgrade", function () {
	it("fails closed without epoch support and preserves account and grant state across coordinated facet cuts", async function () {
		const context = await loadFixture(initializeFixture)
		const { admin, user: owner, user2: delegate, hedger: nextOwner } = context.signers
		const instant = context.instantLayer
		const instantAddress = await instant.getAddress()
		await instant.connect(admin).setAccountLayer(context.accountLayerDiamond)
		await context.accountManager.connect(owner).addAccount("auditUpgrade")
		const accounts = await context.accountManager.getAccounts(owner.address, 0, 100)
		const account = accounts.find(entry => entry.name === "auditUpgrade")!.accountAddress
		const selector = context.accountFacet.interface.getFunction("withdrawTo")!.selector
		const expiry = (await time.latest()) + 86_400
		await instant.connect(owner).grantDelegation({
			account: { addr: account, isPartyB: false },
			delegatedSigner: delegate.address,
			selectors: [selector],
			expiryTimestamp: expiry,
		})
		await context.alTimelockFacet.connect(owner).setupTimelocks(account, owner.address, 300, [selector])
		const timelockBefore = await context.alViewFacet.getSelectorTimelock(account, selector)
		await instant.connect(admin).addTemplate("auditUpgrade", [{ insertionPoints: [], sourceIndices: [], sourceOffsets: [] }])
		const templateId = (await instant.getNextTemplateId()) - 1n
		const domainBefore = await instant.domainSeparator()
		const accountCut = await ethers.getContractAt("IDiamondCut", context.accountLayerDiamond)
		const instantCut = await ethers.getContractAt("IDiamondCut", instantAddress)
		const epochSelector = context.alViewFacet.interface.getFunction("getAccountOwnershipEpoch")!.selector
		const grantEpochSelector = instant.interface.getFunction("delegationOwnershipEpoch")!.selector
		await accountCut
			.connect(admin)
			.diamondCut([{ facetAddress: ethers.ZeroAddress, action: FacetCutAction.Remove, functionSelectors: [epochSelector] }], ethers.ZeroAddress, "0x")
		await instantCut
			.connect(admin)
			.diamondCut(
				[{ facetAddress: ethers.ZeroAddress, action: FacetCutAction.Remove, functionSelectors: [grantEpochSelector] }],
				ethers.ZeroAddress,
				"0x",
			)
		await expect(instant.isDelegationActive(account, delegate.address, selector)).to.be.reverted

		async function replaceFacet(diamondAddress: string, artifact: string, libraries: Record<string, string> = {}) {
			const replacement = await (await ethers.getContractFactory(artifact, { libraries })).connect(admin).deploy()
			await replacement.waitForDeployment()
			const replacementAddress = await replacement.getAddress()
			const loupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress)
			const grouped = new Map<FacetCutAction, string[]>()
			for (const item of getSelectors(ethers, replacement as any).selectors) {
				const action = (await loupe.facetAddress(item)) === ethers.ZeroAddress ? FacetCutAction.Add : FacetCutAction.Replace
				grouped.set(action, [...(grouped.get(action) ?? []), item])
			}
			const cut = await ethers.getContractAt("IDiamondCut", diamondAddress)
			await cut.connect(admin).diamondCut(
				[...grouped].map(([action, functionSelectors]) => ({ facetAddress: replacementAddress, action, functionSelectors })),
				ethers.ZeroAddress,
				"0x",
			)
		}

		const params = await (await ethers.getContractFactory("contracts/accountLayer/libraries/LibQuoteParams.sol:LibQuoteParams")).deploy()
		await params.waitForDeployment()
		await replaceFacet(context.accountLayerDiamond, "contracts/accountLayer/facets/Core/CoreFacet.sol:CoreFacet", {
			LibQuoteParams: await params.getAddress(),
		})
		await replaceFacet(context.accountLayerDiamond, "contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet")
		for (const group of ["Delegation", "Execution", "View", "Migration"]) {
			await replaceFacet(instantAddress, `contracts/instantLayer/facets/${group}/${group}Facet.sol:${group}Facet`)
		}

		expect(await context.alViewFacet.ownerOf(account)).to.equal(owner.address)
		expect(await context.alViewFacet.getAccountOwnershipEpoch(account)).to.equal(0n)
		expect(await instant.delegationOwnershipEpoch(account, delegate.address, selector)).to.equal(0n)
		expect(await instant.delegations(account, delegate.address, selector)).to.equal(expiry)
		expect(await instant.isDelegationActive(account, delegate.address, selector)).to.equal(true)
		expect(await instant.domainSeparator()).to.equal(domainBefore)
		expect((await instant.getTemplate(templateId)).name).to.equal("auditUpgrade")
		expect(await context.alViewFacet.getSelectorTimelock(account, selector)).to.deep.equal(timelockBefore)
		await context.alCoreFacet.connect(owner).transferSubAccountOwnership(account, nextOwner.address)
		expect(await context.alViewFacet.getAccountOwnershipEpoch(account)).to.equal(1n)
		expect(await instant.isDelegationActive(account, delegate.address, selector)).to.equal(false)
		await context.alCoreFacet.connect(nextOwner).transferSubAccountOwnership(account, owner.address)
		expect(await instant.isDelegationActive(account, delegate.address, selector)).to.equal(false)
	})
})
