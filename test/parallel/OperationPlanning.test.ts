import { expect } from "chai"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { operationFixture } from "../../cli/test/fixtures/operation.js"
import { buildCorePlan, captureCoreSnapshot } from "../../deployment-tooling/operations/core-plan.js"
import { hashBytes, loadOperation } from "../../deployment-tooling/operations/inputs.js"
import { writeOperationFile } from "../../deployment-tooling/operations/outputs.js"
import { inspectOperation } from "../../tasks/deploy/operationsInspect.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

describe("Generic Core operation planning", function () {
	it("plans two separately owned real diamonds without sending a transaction", async function () {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "core-plan-chain-"))
		try {
			const owners = (await ethers.getSigners()).slice(0, 2)
			const cut = await ethers.deployContract("DiamondCutFacet")
			const loupe = await ethers.deployContract("DiamondLoupeFacet")
			const view = await ethers.deployContract("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet")
			await Promise.all([cut.waitForDeployment(), loupe.waitForDeployment(), view.waitForDeployment()])
			const facetCodes = await Promise.all([cut, loupe, view].map(async c => ethers.keccak256(await ethers.provider.getCode(await c.getAddress()))))
			for (const [index, owner] of owners.entries()) {
				const diamond = await ethers.deployContract("Diamond", [owner.address, await cut.getAddress()])
				await diamond.waitForDeployment()
				const dcut = await ethers.getContractAt("DiamondCutFacet", await diamond.getAddress(), owner)
				await (
					await dcut.diamondCut(
						[
							{ facetAddress: await loupe.getAddress(), action: 0, functionSelectors: [loupe.interface.getFunction("facets")!.selector] },
							{ facetAddress: await view.getAddress(), action: 0, functionSelectors: [view.interface.getFunction("getOwner")!.selector] },
						],
						ethers.ZeroAddress,
						"0x",
					)
				).wait()
				const f = operationFixture(path.join(scratch, String(index)))
				f.profile.components.core = {
					address: await diamond.getAddress(),
					upgradeAuthority: owner.address,
					baseline: { id: "core-fixture", facetCodeHashes: facetCodes },
				}
				writeOperationFile(f.profileFile, f.profile)
				f.release.components.core.facets = []
				for (const name of ["DiamondLoupeFacet", "contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet"]) {
					const artifact = await hre.artifacts.readArtifact(name)
					const file = path.join(path.dirname(f.releaseFile), `${artifact.contractName}.json`)
					writeOperationFile(file, artifact)
					f.release.components.core.facets.push({ artifactPath: path.basename(file), sha256: hashBytes(fs.readFileSync(file)) })
				}
				writeOperationFile(f.releaseFile, f.release)
				const bundle = loadOperation(f.file)
				const before = await ethers.provider.getBlockNumber()
				const snapshot = await captureCoreSnapshot(ethers.provider, bundle.resolved)
				const plan = buildCorePlan(bundle, snapshot)
				expect(plan.target).to.equal(await diamond.getAddress())
				expect(plan.authority).to.equal(owner.address)
				expect(plan.executable).to.equal(false)
				expect(plan.changes.some((c: any) => c.change === "add")).to.equal(true)
				expect(plan.changes.some((c: any) => c.change === "remove")).to.equal(false)
				expect(await ethers.provider.getBlockNumber()).to.equal(before)
				const pinned = await captureCoreSnapshot(ethers.provider, bundle.resolved, snapshot.blockNumber)
				expect(pinned).to.deep.equal(snapshot)
			}
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true })
		}
	})

	it("refuses an unbound direct adapter invocation before opening a connection", async function () {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "core-plan-guard-"))
		try {
			const f = operationFixture(scratch)
			let error: any
			try {
				await inspectOperation({}, f.file, path.join(scratch, "snapshot.json"))
			} catch (e) {
				error = e
			}
			expect(error?.code).to.equal("input-drift")
			expect(fs.existsSync(path.join(scratch, "snapshot.json"))).to.equal(false)
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true })
		}
	})
})
