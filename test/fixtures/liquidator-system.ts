// Executed only on an ephemeral Hardhat chain by LiquidatorDeploymentMetadata.test.ts.
import hre from "hardhat"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import { loadCheckpoint } from "../../tasks/deploy/checkpoint.js"
import { LIQUIDATOR_METADATA } from "../../tasks/deploy/liquidatorMetadata.js"
import { activeDeploymentRecipe } from "../../tasks/deploy/recipeRuntime.js"

const originalDirectory = process.cwd()
const scratch = process.env.LIQUIDATOR_SYSTEM_TEST_DIR!
assert(scratch && activeDeploymentRecipe?.recipe.network.mode === "local")
const connection = await hre.network.getOrCreate()
assert.equal(connection.networkConfig.type, "edr-simulated")
const { ethers } = connection
// All deployment records and checkpoints stay in the isolated test directory.
for (const name of ["contracts", "hardhat.config.ts", "package.json", "package-lock.json"])
	fs.symlinkSync(path.join(originalDirectory, name), path.join(scratch, name))
for (const name of ["deploy", "utils", "config"])
	fs.cpSync(path.join(originalDirectory, "tasks", name), path.join(scratch, "tasks", name), { recursive: true })
process.chdir(scratch)
const original = ethers.getContractAt
;(ethers as any).getContractAt = async (...args: any[]) => {
	const contract = await (original as any)(...args)
	if (String(args[0]).endsWith("ControlFacet.sol:ControlFacet"))
		return new Proxy(contract, {
			get(target, property) {
				if (property === "setAffiliateMetadata")
					return {
						staticCall: async () => {
							throw new Error("injected full-system metadata failure")
						},
					}
				return Reflect.get(target, property)
			},
		})
	return contract
}
try {
	await assert.rejects(hre.tasks.getTask("deploy:system").run({ fresh: true, verify: false }), /injected full-system metadata failure/)
} finally {
	ethers.getContractAt = original
}
const failed = loadCheckpoint(31337)!
assert(failed?.contracts.symmioLiquidator?.address)
const proxy = failed.contracts.symmioLiquidator.address
const core = failed.contracts.diamond!.diamond!.address
const [deployer] = await ethers.getSigners()
const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", core)
assert.equal(await view.hasRole(deployer.address, ethers.id("AFFILIATE_MANAGER_ROLE")), true)
const creations = failed
	.transactions!.filter(tx => tx.deployment)
	.map(tx => tx.hash)
	.sort()
await hre.tasks.getTask("deploy:system").run({ fresh: false, verify: false })
const resumed = loadCheckpoint(31337)!
assert.equal(resumed.contracts.symmioLiquidator!.address, proxy)
assert.deepEqual([...new Set(resumed.transactions!.filter(tx => tx.deployment).map(tx => tx.hash))].sort(), [...new Set(creations)])
assert.deepEqual(Array.from(await view.getEntityMetadata(proxy)), Object.values(LIQUIDATOR_METADATA))
assert.equal(await view.isAffiliate(proxy), false)
assert.equal(await view.hasRole(deployer.address, ethers.id("AFFILIATE_MANAGER_ROLE")), false)
const admin = activeDeploymentRecipe!.recipe.governance.admin
assert.equal(await view.hasRole(admin, ethers.id("AFFILIATE_MANAGER_ROLE")), true)
const liquidator = await ethers.getContractAt("SymmioLiquidator", proxy)
assert.equal(await liquidator.hasRole(await liquidator.DEFAULT_ADMIN_ROLE(), admin), true)
assert.equal(await liquidator.hasRole(await liquidator.DEFAULT_ADMIN_ROLE(), deployer.address), false)
for (const role of ["LIQUIDATOR_ROLE", "PARTYB_LIQUIDATOR_ROLE"]) assert.equal(await view.hasRole(proxy, ethers.id(role)), true)
assert(resumed.transactions!.some(tx => tx.label.startsWith("setAffiliateMetadata") && tx.status === "confirmed"))
console.log("FULL_SYSTEM_METADATA_RESUME_VERIFIED")
process.chdir(originalDirectory)
