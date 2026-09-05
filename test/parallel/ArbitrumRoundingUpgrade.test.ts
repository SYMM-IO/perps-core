import { expect } from "chai"

import { DEPLOYMENTS, FACETS, GETTER } from "../../deployment-tooling/arbitrum-rounding-upgrade.js"
import { assertRoundingFactory, assertRoundingRuntime, deployRoundingSelection } from "../../tasks/deploy/arbitrumRoundingUpgrade.js"
import { deploymentOnlyArtifact } from "../../tasks/deploy/artifacts.js"
import { createCheckpoint, setCheckpointSimulated } from "../../tasks/deploy/checkpoint.js"
import { resetDeploymentTransactionJournal } from "../../tasks/deploy/tx.js"
import { LibrarySpecs, linkedLibrariesFor } from "../../utils/deploymentManifest.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

describe("Arbitrum rounding-only release deployment", function () {
	it("deploys a wallet-administered factory plus eight upgrade contracts and recovers the same factory without transactions", async function () {
		resetDeploymentTransactionJournal()
		setCheckpointSimulated(true)
		const [deployer, coreAdmin] = await ethers.getSigners()
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
			target: { safe: coreAdmin.address, reuseLibraries },
			create2: {
				factory: { mode: "deploy" },
				groups: { diamonds: { prefix: "573310" }, facets: { suffix: "862" } },
				miningBudget: 200000000,
			},
		}
		const checkpoint = createCheckpoint("hardhat", 31337, `rounding-test-${Date.now()}`)
		const report: any = {}
		const before = await ethers.provider.getTransactionCount(deployer.address)
		await deployRoundingSelection(hre, ethers, input, report, checkpoint, () => {})
		expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(before + 9)
		expect(Object.keys(report.deployments).sort()).to.deep.equal([...DEPLOYMENTS].sort())
		const factoryEntry = report.deployments.Create2Factory
		const create2 = await ethers.getContractAt("Create2Factory", factoryEntry.address)
		expect(checkpoint.contracts.create2Factory?.address).to.equal(factoryEntry.address)
		expect(factoryEntry.constructorArguments).to.deep.equal([deployer.address, deployer.address])
		expect(await create2.hasRole(ethers.ZeroHash, deployer.address)).to.equal(true)
		expect(await create2.hasRole(await create2.DEPLOYER_ROLE(), deployer.address)).to.equal(true)
		expect(await create2.hasRole(ethers.ZeroHash, coreAdmin.address)).to.equal(false)
		for (const name of FACETS) {
			expect(report.facets[name].address.toLowerCase().endsWith("862"), name).to.equal(true)
			expect(report.facets[name].selectors.length, name).to.be.greaterThan(0)
		}
		expect(report.facets.ViewFacet.selectors).to.include(GETTER)
		expect(report.libraries.LibQuoteFunding).to.equal(addresses.LibQuoteFunding)
		expect(report.libraries.LibQuoteClose).to.equal(addresses.LibQuoteClose)
		await deployRoundingSelection(hre, ethers, input, report, checkpoint, () => {})
		expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(before + 9)
		// Simulate interruption after the receipt but before the factory report/checkpoint component was saved.
		delete report.deployments.Create2Factory
		delete checkpoint.contracts.create2Factory
		await deployRoundingSelection(hre, ethers, input, report, checkpoint, () => {})
		expect(report.deployments.Create2Factory.address).to.equal(factoryEntry.address)
		expect(checkpoint.contracts.create2Factory?.address).to.equal(factoryEntry.address)
		expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(before + 9)
		const conflicting = structuredClone(report)
		conflicting.deployments.Create2Factory.address = coreAdmin.address
		await expectFailure(() => deployRoundingSelection(hre, ethers, input, conflicting, checkpoint, () => {}), /conflicts with transaction journal/)
		const changedSigner = { ...checkpoint, deployerAddress: coreAdmin.address }
		await expectFailure(() => deployRoundingSelection(hre, ethers, input, report, changedSigner, () => {}), /Deployment signer changed/)
		expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(before + 9)
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
		await (await create2.revokeRole(ethers.ZeroHash, deployer.address)).wait()
		const afterRevoke = await ethers.provider.getTransactionCount(deployer.address)
		await expectFailure(() => deployRoundingSelection(hre, ethers, input, report, checkpoint, () => {}), /must hold admin and deployer roles/)
		expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(afterRevoke)
	})

	it("rejects a factory whose deployer is authorized but whose administrator is someone else", async function () {
		const [deployer, otherAdmin] = await ethers.getSigners()
		const factory = await (await ethers.getContractFactory("Create2Factory")).deploy(otherAdmin.address, deployer.address)
		await factory.waitForDeployment()
		await expectFailure(
			() =>
				assertRoundingFactory(
					hre,
					ethers,
					{
						address: factory.target,
						artifact: "Create2Factory",
						constructorArguments: [deployer.address, deployer.address],
					},
					deployer.address,
				),
			/must hold admin and deployer roles/,
		)
	})
})

async function expectFailure(action: () => Promise<unknown>, pattern: RegExp) {
	let failure: unknown
	try {
		await action()
	} catch (error) {
		failure = error
	}
	expect(String(failure)).to.match(pattern)
}
