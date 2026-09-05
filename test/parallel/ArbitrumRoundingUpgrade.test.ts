import { expect } from "chai"

import { FACETS, GETTER, LIBRARIES } from "../../deployment-tooling/arbitrum-rounding-upgrade.js"
import { assertRoundingRuntime, deployRoundingSelection } from "../../tasks/deploy/arbitrumRoundingUpgrade.js"
import { deploymentOnlyArtifact } from "../../tasks/deploy/artifacts.js"
import { createCheckpoint, setCheckpointSimulated } from "../../tasks/deploy/checkpoint.js"
import { resetDeploymentTransactionJournal } from "../../tasks/deploy/tx.js"
import { LibrarySpecs, linkedLibrariesFor } from "../../utils/deploymentManifest.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

describe("Arbitrum rounding-only release deployment", function () {
	it("deploys exactly four libraries and four 862 facets, links reused dependencies, and resumes without transactions", async function () {
		resetDeploymentTransactionJournal()
		setCheckpointSimulated(true)
		const [deployer] = await ethers.getSigners()
		const create2 = await (await ethers.getContractFactory("Create2Factory")).deploy(deployer.address, deployer.address)
		await create2.waitForDeployment()
		const factoryAddress = await create2.getAddress()
		const addresses: Record<string, string> = {}
		const reuseLibraries: Record<string, { address: string; codeHash: string }> = {}
		for (const name of ["LibQuoteFunding", "LibQuoteClose"]) {
			const spec = LibrarySpecs.core[name]
			const artifact = await hre.artifacts.readArtifact(spec.artifact)
			const factory = await ethers.getContractFactoryFromArtifact(deploymentOnlyArtifact(artifact), {
				libraries: linkedLibrariesFor("core", spec, addresses),
			})
			const contract = await factory.deploy()
			await contract.waitForDeployment()
			addresses[name] = await contract.getAddress()
			reuseLibraries[name] = { address: addresses[name], codeHash: ethers.keccak256(await ethers.provider.getCode(addresses[name])) }
		}
		const input = {
			release: "version_0.8.6.2",
			target: { factory: factoryAddress, factoryCodeHash: ethers.keccak256(await ethers.provider.getCode(factoryAddress)), reuseLibraries },
			create2: {
				factory: { mode: "reuse", address: factoryAddress },
				groups: { diamonds: { prefix: "573310" }, facets: { suffix: "862" } },
				miningBudget: 200000000,
			},
		}
		const checkpoint = createCheckpoint("hardhat", 31337, `rounding-test-${Date.now()}`)
		const report: any = {}
		const before = await ethers.provider.getTransactionCount(deployer.address)
		await deployRoundingSelection(hre, ethers, input, report, checkpoint, () => {})
		expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(before + 8)
		expect(Object.keys(report.deployments).sort()).to.deep.equal([...LIBRARIES, ...FACETS].sort())
		for (const name of FACETS) {
			expect(report.facets[name].address.toLowerCase().endsWith("862"), name).to.equal(true)
			expect(report.facets[name].selectors.length, name).to.be.greaterThan(0)
		}
		expect(report.facets.ViewFacet.selectors).to.include(GETTER)
		expect(report.libraries.LibQuoteFunding).to.equal(addresses.LibQuoteFunding)
		expect(report.libraries.LibQuoteClose).to.equal(addresses.LibQuoteClose)
		await deployRoundingSelection(hre, ethers, input, report, checkpoint, () => {})
		expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(before + 8)
		const process = report.deployments.LibPartyALiquidationProcess
		let mismatch: unknown
		try {
			await assertRoundingRuntime(
				ethers,
				await hre.artifacts.readArtifact(process.artifact),
				process.address,
				Object.fromEntries(Object.keys(process.libraries).map(k => [k, deployer.address])),
			)
		} catch (error) {
			mismatch = error
		}
		expect(String(mismatch)).to.match(/linked-library mismatch/)
	})
})
