import { expect } from "chai"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { loadDeploymentRecipe } from "../../deployment-tooling/recipe.js"
import { createCheckpoint, getCheckpointPath } from "../../tasks/deploy/checkpoint.js"
import { DEPLOYER_SETUP_ROLES } from "../../tasks/deploy/deployAll.js"
import { deployDiamond } from "../../tasks/deploy/diamond.js"
import { deploySymmioLiquidator, liquidatorTask } from "../../tasks/deploy/liquidator.js"
import { ensureLiquidatorMetadata, LIQUIDATOR_METADATA, verifyLiquidatorMetadata } from "../../tasks/deploy/liquidatorMetadata.js"
import { runStandaloneLiquidator } from "../../tasks/deploy/standaloneLiquidator.js"
import { getDeploymentTransactionJournal, resetDeploymentTransactionJournal } from "../../tasks/deploy/tx.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"
import { loadFixture } from "../helpers/network-helpers.js"

async function fixture() {
	const [admin, operator, other] = await ethers.getSigners()
	const diamond = await deployDiamond(hre, { logData: false, reportGas: false })
	const core = await diamond.getAddress()
	const control = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", core)
	const view = await ethers.getContractAt("contracts/core/facets/ViewFacet/ViewFacet.sol:ViewFacet", core)
	await (await control.setAdmin(admin.address)).wait()
	await (await control.grantRole(admin.address, ethers.id("AFFILIATE_MANAGER_ROLE"))).wait()
	return { admin, operator, other, core, control, view }
}

const ENV_KEYS = [
	"EXECUTE",
	"DRY_RUN",
	"CONFIRM_CHAIN_ID",
	"SYMMIO_ADDRESS",
	"ADMIN_PUBLIC_KEY",
	"OPERATORS",
	"LIQUIDATOR_ADDRESS",
	"LIQUIDATOR_RESUME_FILE",
]

describe("liquidator deployment metadata", function () {
	let env: Record<string, string | undefined>
	let directory: string
	let context: Awaited<ReturnType<typeof fixture>>
	beforeEach(async function () {
		env = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
		for (const key of ENV_KEYS) delete process.env[key]
		context = await loadFixture(fixture)
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "liquidator-metadata-"))
		Object.assign(process.env, {
			SYMMIO_ADDRESS: context.core,
			ADMIN_PUBLIC_KEY: context.admin.address,
			OPERATORS: context.operator.address,
			LIQUIDATOR_RESUME_FILE: path.join(directory, "resume.json"),
		})
		resetDeploymentTransactionJournal()
	})
	afterEach(function () {
		for (const key of ENV_KEYS) {
			if (env[key] === undefined) delete process.env[key]
			else process.env[key] = env[key]
		}
		fs.rmSync(directory, { recursive: true, force: true })
		resetDeploymentTransactionJournal()
	})
	function execute() {
		process.env.EXECUTE = "true"
		process.env.CONFIRM_CHAIN_ID = "31337"
	}
	function savedProxy(): string {
		return JSON.parse(fs.readFileSync(process.env.LIQUIDATOR_RESUME_FILE!, "utf8")).proxy
	}

	it("runs the full-system deployment through metadata failure, resume and role cleanup", function () {
		this.timeout(120_000)
		const recipe = JSON.parse(fs.readFileSync("deployment-recipes/localhost.json", "utf8"))
		recipe.network.name = "default"
		recipe.name = "liquidator-system-metadata-test"
		recipe.execution.logLevel = "minimal"
		for (const component of ["partyB", "symbolManager", "expressProvider", "gaslessLayer"]) recipe[component] = { mode: "skip" }
		recipe.partyB.adlEnabled = false
		recipe.liquidator = { mode: "deploy", operators: [context.operator.address] }
		const recipeFile = path.join(directory, "recipe.json")
		fs.writeFileSync(recipeFile, JSON.stringify(recipe))
		const loaded = loadDeploymentRecipe(recipeFile)
		const result = spawnSync(
			process.execPath,
			["node_modules/hardhat/dist/src/cli.js", "run", "--no-compile", "test/fixtures/liquidator-system.ts"],
			{
				env: {
					...process.env,
					DOTENV_CONFIG_PATH: "/dev/null",
					SYMMIO_DEPLOYMENT_RECIPE: recipeFile,
					SYMMIO_DEPLOYMENT_RECIPE_DIGEST: loaded.digest,
					LIQUIDATOR_SYSTEM_TEST_DIR: directory,
				},
				encoding: "utf8",
				timeout: 110_000,
				maxBuffer: 8 * 1024 * 1024,
			},
		)
		expect(result.status, `${result.error || ""}\n${result.stdout}\n${result.stderr}`).to.equal(0)
		expect(result.stdout).to.include("FULL_SYSTEM_METADATA_RESUME_VERIFIED")
	})

	it("sends no transactions or resume writes in plan-only mode", async function () {
		const nonce = await ethers.provider.getTransactionCount(context.admin.address)
		await runStandaloneLiquidator(hre)
		expect(await ethers.provider.getTransactionCount(context.admin.address)).to.equal(nonce)
		expect(getDeploymentTransactionJournal()).to.have.length(0)
		expect(fs.existsSync(process.env.LIQUIDATOR_RESUME_FILE!)).to.equal(false)
	})
	it("preserves the explicit chain execution guard", async function () {
		execute()
		process.env.CONFIRM_CHAIN_ID = "999"
		await expect(runStandaloneLiquidator(hre)).to.be.rejectedWith("CONFIRM_CHAIN_ID=31337")
		expect(getDeploymentTransactionJournal()).to.have.length(0)
	})
	it("requires the exact affiliate manager role before a new standalone deployment", async function () {
		await (await context.control.revokeRole(context.admin.address, ethers.id("AFFILIATE_MANAGER_ROLE"))).wait()
		expect(await context.view.isRoleAdmin(context.admin.address, ethers.id("AFFILIATE_MANAGER_ROLE"))).to.equal(true)
		execute()
		await expect(runStandaloneLiquidator(hre)).to.be.rejectedWith("must hold AFFILIATE_MANAGER_ROLE")
		expect(getDeploymentTransactionJournal()).to.have.length(0)
	})
	it("confirms exact proxy metadata and retains operator/Core wiring without affiliate registration", async function () {
		execute()
		await runStandaloneLiquidator(hre)
		const proxy = savedProxy()
		expect(await context.view.getEntityMetadata(proxy)).to.deep.equal(Object.values(LIQUIDATOR_METADATA))
		expect(await context.view.isAffiliate(proxy)).to.equal(false)
		for (const role of ["LIQUIDATOR_ROLE", "PARTYB_LIQUIDATOR_ROLE"]) expect(await context.view.hasRole(proxy, ethers.id(role))).to.equal(true)
		const liquidator = await ethers.getContractAt("SymmioLiquidator", proxy)
		expect(await liquidator.hasRole(await liquidator.OPERATOR_ROLE(), context.operator.address)).to.equal(true)
		const metadataTx = getDeploymentTransactionJournal().find(tx => tx.label.startsWith("setAffiliateMetadata"))!
		expect(metadataTx.status).to.equal("confirmed")
		const receipt = await ethers.provider.getTransactionReceipt(metadataTx.hash)
		expect(receipt!.status).to.equal(1)
		expect(context.control.interface.parseLog(receipt!.logs[0])!.name).to.equal("SetEntityMetadata")
		const nonce = await ethers.provider.getTransactionCount(context.admin.address)
		await runStandaloneLiquidator(hre)
		expect(savedProxy()).to.equal(proxy)
		expect(await ethers.provider.getTransactionCount(context.admin.address)).to.equal(nonce)
	})
	it("surfaces a metadata failure and resumes the saved standalone proxy without another deployment", async function () {
		execute()
		const original = ethers.getContractAt
		let failed = false
		;(ethers as any).getContractAt = async (...args: any[]) => {
			const contract = await (original as any)(...args)
			if (String(args[0]).endsWith("ControlFacet.sol:ControlFacet")) {
				return new Proxy(contract, {
					get(target, property) {
						if (property === "setAffiliateMetadata")
							return {
								staticCall: async () => {
									failed = true
									throw new Error("injected metadata failure")
								},
							}
						return Reflect.get(target, property)
					},
				})
			}
			return contract
		}
		try {
			await expect(runStandaloneLiquidator(hre)).to.be.rejectedWith("injected metadata failure")
		} finally {
			ethers.getContractAt = original
		}
		expect(failed).to.equal(true)
		const proxy = savedProxy()
		const nonce = await ethers.provider.getTransactionCount(context.admin.address)
		await runStandaloneLiquidator(hre)
		expect(savedProxy()).to.equal(proxy)
		expect(await ethers.provider.getTransactionCount(context.admin.address)).to.equal(nonce + 1)
		await verifyLiquidatorMetadata(context.view, proxy)
	})
	it("refuses a resume record for another Core before sending", async function () {
		fs.writeFileSync(
			process.env.LIQUIDATOR_RESUME_FILE!,
			JSON.stringify({ chainId: "31337", core: context.other.address, admin: context.admin.address, proxy: context.other.address }),
		)
		execute()
		await expect(runStandaloneLiquidator(hre)).to.be.rejectedWith("resume record does not match")
		expect(getDeploymentTransactionJournal()).to.have.length(0)
	})
	it("reuses the full-system checkpoint proxy after metadata failure", async function () {
		const checkpoint = createCheckpoint("liquidator-metadata-test", 98601421)
		try {
			const args = { symmioAddress: context.core, admin: context.admin.address, checkpoint, logData: false }
			const liquidator = await deploySymmioLiquidator(hre, args)
			await expect(ensureLiquidatorMetadata(ethers, liquidator, context.core, context.other)).to.be.rejectedWith("must hold AFFILIATE_MANAGER_ROLE")
			const nonce = await ethers.provider.getTransactionCount(context.admin.address)
			const resumed = await deploySymmioLiquidator(hre, args)
			expect(await resumed.getAddress()).to.equal(await liquidator.getAddress())
			expect(await ethers.provider.getTransactionCount(context.admin.address)).to.equal(nonce)
			await ensureLiquidatorMetadata(ethers, resumed, context.core, context.admin)
			await verifyLiquidatorMetadata(context.view, await resumed.getAddress())
			expect(DEPLOYER_SETUP_ROLES).to.include("AFFILIATE_MANAGER_ROLE")
		} finally {
			fs.rmSync(getCheckpointPath(checkpoint.chainId), { force: true })
		}
	})
	it("covers the local-only task and its explicit proxy resume option", async function () {
		const action = await (liquidatorTask as any).action()
		const args = { symmioAddress: context.core, admin: context.admin.address, logData: false }
		const liquidator = await action.default(args, hre)
		const proxy = await liquidator.getAddress()
		await verifyLiquidatorMetadata(context.view, proxy)
		expect(await context.view.isAffiliate(proxy)).to.equal(false)
		const nonce = await ethers.provider.getTransactionCount(context.admin.address)
		const resumed = await action.default({ ...args, liquidatorAddress: proxy }, hre)
		expect(await resumed.getAddress()).to.equal(proxy)
		expect(await ethers.provider.getTransactionCount(context.admin.address)).to.equal(nonce)
	})
	it("refuses metadata on a Core different from the proxy connection", async function () {
		const liquidator = await deploySymmioLiquidator(hre, { symmioAddress: context.core, admin: context.admin.address, logData: false })
		await expect(ensureLiquidatorMetadata(ethers, liquidator, context.other.address, context.admin)).to.be.rejectedWith("different Symmio core")
	})
	for (const field of ["name", "brandColor", "metadata"] as const) {
		it(`rejects incorrect stored ${field} even if a write claimed success`, async function () {
			const view = { getEntityMetadata: async () => ({ ...LIQUIDATOR_METADATA, [field]: "wrong" }) }
			await expect(verifyLiquidatorMetadata(view, context.other.address)).to.be.rejectedWith(`${field} expected`)
		})
	}
	it("surfaces a reverted metadata receipt before the post-check", async function () {
		let reads = 0
		const view = {
			hasRole: async () => true,
			getEntityMetadata: async () => {
				reads++
				return { name: "", brandColor: "", metadata: "" }
			},
		}
		const setAffiliateMetadata = Object.assign(
			async () => ({ hash: "0xfailed", nonce: 1, wait: async () => ({ status: 0, blockNumber: 1, gasUsed: 1n }) }),
			{ staticCall: async () => {} },
		)
		const fakeEthers = { getContractAt: async (name: string) => (name.includes("ViewFacet") ? view : { setAffiliateMetadata }) }
		const proxy = { getAddress: async () => context.other.address, symmioAddress: async () => context.core }
		await expect(ensureLiquidatorMetadata(fakeEthers, proxy, context.core, context.admin)).to.be.rejectedWith("reverted in block")
		expect(reads).to.equal(1)
	})
})
