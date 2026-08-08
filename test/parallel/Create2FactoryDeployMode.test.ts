import { expect } from "chai"
import fs from "node:fs"
import path from "node:path"

import { createCheckpoint } from "../../tasks/deploy/checkpoint.js"
import { ensureCreate2Factory } from "../../tasks/deploy/create2Factory.js"
import { getConnection } from "../../tasks/deploy/helpers.js"
import { resetDeploymentTransactionJournal } from "../../tasks/deploy/tx.js"
import { buildVanityPlan } from "../../tasks/deploy/vanityPlan.js"
import { getDataDir, writeData } from "../../tasks/utils/fs.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

const PATTERN = { groups: { facets: { suffix: "86" } } }

// checkpoint-31337.json is the path a real local deploy:system uses, so keep test checkpoints
// on their own chain id the way the other deployment tests do.
const TEST_CHAIN_ID = 98_601_339

describe("ensure create2 factory", function () {
	beforeEach(function () {
		// The journal is process-wide and refuses two creation records for one component.
		resetDeploymentTransactionJournal()
	})

	after(function () {
		fs.rmSync(path.resolve(`tasks/data/checkpoints/checkpoint-${TEST_CHAIN_ID}.json`), { force: true })
	})

	it("deploys a factory when the recipe asks for one", async function () {
		const plan = buildVanityPlan({ factory: { mode: "deploy" }, ...PATTERN })!
		const result = await ensureCreate2Factory(hre, plan, { isLive: false, allowNewFactory: false, logData: false })

		expect(result.deployed).to.equal(true)
		expect(await ethers.provider.getCode(result.address)).to.not.equal("0x")
		expect(plan.factoryAddress).to.equal(result.address)
	})

	it("records the factory in the checkpoint and reuses it on a second call", async function () {
		const checkpoint = createCheckpoint("ensure-create2-factory-test", TEST_CHAIN_ID)
		const first = buildVanityPlan({ factory: { mode: "deploy" }, ...PATTERN })!
		const deployed = await ensureCreate2Factory(hre, first, { checkpoint, isLive: false, allowNewFactory: false, logData: false })
		expect(checkpoint.contracts.create2Factory?.address).to.equal(deployed.address)

		const second = buildVanityPlan({ factory: { mode: "deploy" }, ...PATTERN })!
		const resumed = await ensureCreate2Factory(hre, second, { checkpoint, isLive: false, allowNewFactory: false, logData: false })

		expect(resumed.deployed).to.equal(false)
		expect(resumed.address).to.equal(deployed.address)
	})

	it("binds an existing factory in reuse mode without deploying", async function () {
		const factory = await (await ethers.getContractFactory("Create2Factory")).deploy()
		await factory.waitForDeployment()
		const address = await factory.getAddress()

		const plan = buildVanityPlan({ factory: { mode: "reuse", address }, ...PATTERN })!
		const result = await ensureCreate2Factory(hre, plan, { isLive: false, allowNewFactory: false, logData: false })

		expect(result.deployed).to.equal(false)
		expect(result.address).to.equal(address)
	})

	it("refuses a reuse address with no code", async function () {
		const plan = buildVanityPlan({ factory: { mode: "reuse", address: "0x1111111111111111111111111111111111111111" }, ...PATTERN })!
		let failure: Error | undefined
		try {
			await ensureCreate2Factory(hre, plan, { isLive: false, allowNewFactory: false, logData: false })
		} catch (error) {
			failure = error as Error
		}
		expect(failure, "expected the reuse check to stop the run").to.not.equal(undefined)
		expect(failure!.message).to.match(/has no code on this network/)
	})
})

describe("create2 factory drift guard", function () {
	// getConnection() re-scopes data records to the connected chain on every call, so a
	// fixture report has to live in the run's real scope rather than an invented one.
	// Snapshot whatever is already there and put it back afterwards.
	let reportPath: string
	let savedReport: string | null = null

	async function recordExistingFactory(): Promise<string> {
		const existing = await (await ethers.getContractFactory("Create2Factory")).deploy()
		await existing.waitForDeployment()
		const recorded = await existing.getAddress()
		writeData("deployment-report.json", { addresses: { create2Factory: recorded } })
		return recorded
	}

	before(async function () {
		await getConnection(hre)
		reportPath = path.resolve(`${getDataDir()}/deployment-report.json`)
		savedReport = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : null
	})

	beforeEach(function () {
		resetDeploymentTransactionJournal()
	})

	after(function () {
		if (savedReport === null) fs.rmSync(reportPath, { force: true })
		else fs.writeFileSync(reportPath, savedReport)
	})

	it("refuses a second factory on a live target when a report already names one", async function () {
		const recorded = await recordExistingFactory()
		const plan = buildVanityPlan({ factory: { mode: "deploy" }, ...PATTERN })!

		let failure: Error | undefined
		try {
			await ensureCreate2Factory(hre, plan, { isLive: true, allowNewFactory: false, logData: false })
		} catch (error) {
			failure = error as Error
		}

		expect(failure, "expected the drift guard to stop the run").to.not.equal(undefined)
		expect(failure!.message).to.match(/Refusing to deploy a second CREATE2 factory/)
		expect(failure!.message).to.contain(recorded)
	})

	it("allows a second factory on a live target with the override flag", async function () {
		const recorded = await recordExistingFactory()
		const plan = buildVanityPlan({ factory: { mode: "deploy" }, ...PATTERN })!

		const result = await ensureCreate2Factory(hre, plan, { isLive: true, allowNewFactory: true, logData: false })

		expect(result.deployed).to.equal(true)
		expect(result.address).to.not.equal(recorded)
	})

	it("warns but continues on a non-live target", async function () {
		await recordExistingFactory()
		const plan = buildVanityPlan({ factory: { mode: "deploy" }, ...PATTERN })!

		const result = await ensureCreate2Factory(hre, plan, { isLive: false, allowNewFactory: false, logData: false })

		expect(result.deployed).to.equal(true)
	})
})
