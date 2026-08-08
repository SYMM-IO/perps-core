import { expect } from "chai"

import { ensureCreate2Factory } from "../../tasks/deploy/create2Factory.js"
import { deployDiamond } from "../../tasks/deploy/diamond.js"
import { resetDeploymentTransactionJournal } from "../../tasks/deploy/tx.js"
import { createVanityContext } from "../../tasks/deploy/vanityDeploy.js"
import { buildVanityPlan } from "../../tasks/deploy/vanityPlan.js"
import { ethers, hre } from "../helpers/hardhat-connection.js"

describe("vanity address deployment", function () {
	let factoryAddress: string

	beforeEach(async function () {
		// The journal is process-wide and deliberately refuses two creation records for one
		// component. Each case here deploys the same components again, so it starts clean.
		resetDeploymentTransactionJournal()
		const factory = await ethers.getContractFactory("Create2Factory")
		const create2Factory = await factory.deploy()
		await create2Factory.waitForDeployment()
		factoryAddress = await create2Factory.getAddress()
	})

	it("gives every facet an address ending in the configured suffix", async function () {
		const plan = buildVanityPlan({ factoryAddress, groups: { facets: { suffix: "86" } } })!
		const vanity = createVanityContext(ethers, plan)

		// deployDiamond returns the Diamond contract instance itself.
		const diamond = await deployDiamond(hre, { logData: false, reportGas: false, vanity })

		const loupe = await ethers.getContractAt("IDiamondLoupe", await diamond.getAddress())
		const facets = await loupe.facets()
		expect(facets.length).to.be.greaterThan(0)
		for (const facet of facets) {
			expect(facet.facetAddress.toLowerCase().endsWith("86"), `${facet.facetAddress} does not end in 86`).to.be.true
			expect(facet.functionSelectors.length).to.be.greaterThan(0)
		}
	})

	it("leaves contracts without a pattern on ordinary CREATE", async function () {
		const plan = buildVanityPlan({ factoryAddress, groups: { facets: { suffix: "86" } } })!
		const vanity = createVanityContext(ethers, plan)

		const diamond = await deployDiamond(hre, { logData: false, reportGas: false, vanity })

		// The diamonds group declares no pattern, so the Diamond must not be mined.
		expect((await diamond.getAddress()).toLowerCase().endsWith("86")).to.be.false
	})

	it("stops cleanly when the mining budget is exhausted", async function () {
		// A 6-character prefix on every facet cannot fit in 1000 attempts.
		const plan = buildVanityPlan({ factoryAddress, groups: { facets: { prefix: "abcdef" } }, miningBudget: 1000 })!
		const vanity = createVanityContext(ethers, plan)

		let failure: Error | undefined
		try {
			await deployDiamond(hre, { logData: false, reportGas: false, vanity })
		} catch (error) {
			failure = error as Error
		}
		expect(failure, "expected the deployment to stop").to.not.equal(undefined)
		expect(failure!.message).to.match(/miningBudget/)
	})

	it("deploys nothing through the factory when no pattern is declared", async function () {
		expect(buildVanityPlan({ factoryAddress, groups: { facets: {} } })).to.equal(null)

		const diamond = await deployDiamond(hre, { logData: false, reportGas: false, vanity: null })
		const loupe = await ethers.getContractAt("IDiamondLoupe", await diamond.getAddress())
		expect((await loupe.facets()).length).to.be.greaterThan(0)
	})
})

describe("vanity address deployment with a run-deployed factory", function () {
	beforeEach(function () {
		resetDeploymentTransactionJournal()
	})

	it("deploys its own factory and mines every facet against it", async function () {
		const plan = buildVanityPlan({ factory: { mode: "deploy" }, groups: { facets: { suffix: "86" } } })!
		const factory = await ensureCreate2Factory(hre, plan, { isLive: false, allowNewFactory: false, logData: false })
		expect(factory.deployed).to.equal(true)

		const vanity = createVanityContext(ethers, plan)
		const diamond = await deployDiamond(hre, { logData: false, reportGas: false, vanity })

		// Mining used the factory the run created, not some pre-existing one.
		expect(plan.factoryAddress).to.equal(factory.address)

		const loupe = await ethers.getContractAt("IDiamondLoupe", await diamond.getAddress())
		const facets = await loupe.facets()
		expect(facets.length).to.be.greaterThan(0)
		for (const facet of facets) {
			// Only CREATE2 through the bound factory can land an address on this suffix.
			expect(facet.facetAddress.toLowerCase().endsWith("86"), `${facet.facetAddress} does not end in 86`).to.be.true
		}
	})

	it("refuses to mine before the factory is bound", async function () {
		const plan = buildVanityPlan({ factory: { mode: "deploy" }, groups: { facets: { suffix: "86" } } })!
		const vanity = createVanityContext(ethers, plan)

		let failure: Error | undefined
		try {
			await deployDiamond(hre, { logData: false, reportGas: false, vanity })
		} catch (error) {
			failure = error as Error
		}
		expect(failure, "expected mining to stop without a bound factory").to.not.equal(undefined)
		expect(failure!.message).to.match(/before ensureCreate2Factory bound it/)
	})
})
