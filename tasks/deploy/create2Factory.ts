import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { getDataDir, readDataIfExists, writeData } from "../utils/fs.js"
import { type DeploymentCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { CREATE2FACTORY_DEPLOYMENT_FILE } from "./constants.js"
import { checkpointDeployment, recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import { resolveCreate2FactoryAddress } from "./diamond.js"
import { assertStandaloneDeploymentTaskAllowed, getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import { confirmDeployment, confirmDeploymentWithReceipt } from "./tx.js"
import type { VanityPlan } from "./vanityPlan.js"

const CREATE2_FACTORY_COMPONENT = "contracts.create2Factory"

export async function deployCreate2Factory(hre: any, { logData = true }: { logData?: boolean } = {}) {
	const { ethers } = await getConnection(hre)

	logger.section("Create2Factory Deployment")

	const [deployer] = await ethers.getSigners()
	logger.debug("Deploying Create2Factory with account:", deployer.address)

	const factory = await ethers.getContractFactory("Create2Factory")
	const contract = await factory.connect(deployer).deploy()
	const address = await confirmDeployment(contract, "Create2Factory")
	logger.deployed("Create2Factory", address)

	if (logData) {
		writeData(CREATE2FACTORY_DEPLOYMENT_FILE, [
			{
				name: "Create2Factory",
				address,
				constructorArguments: [],
			},
		])
		logger.debug("Deployed address written to JSON file")
	}

	console.log(`\nAdd this to your deployment recipe:`)
	console.log(`  "create2": { "factory": { "mode": "reuse", "address": "${address}" }, "groups": { "facets": { "suffix": "86" } } }`)

	return contract
}

/** The paste-back block an operator needs so the next run does not mine against a new factory. */
export function formatFactoryPinHint(address: string): string {
	return [
		"",
		`Create2Factory deployed at ${address}`,
		"",
		"Pin this in your recipe before the next run:",
		`  "create2": { "factory": { "mode": "reuse", "address": "${address}" } }`,
		"",
	].join("\n")
}

/**
 * A finished deployment on this chain already fixed a factory. Deploying another would change
 * every mined address, including the Diamond, so a live run stops here. A checkpoint hit means
 * "same deployment, resume" and is handled before this runs; a report hit with no checkpoint
 * means a previous deployment finished, which is the case worth refusing.
 */
async function assertNoRecordedFactory(ethers: any, options: { isLive: boolean; allowNewFactory: boolean }): Promise<void> {
	const report = readDataIfExists("deployment-report.json")
	const recorded: string | undefined = report?.addresses?.create2Factory
	if (!recorded) return
	if ((await ethers.provider.getCode(recorded)) === "0x") return

	const detail =
		`${recorded} is already recorded in ${getDataDir()}/deployment-report.json and has code.\n\n` +
		`Pin it:\n  "create2": { "factory": { "mode": "reuse", "address": "${recorded}" } }\n\n` +
		"A new factory changes every mined address, including the Diamond."

	if (options.isLive && !options.allowNewFactory) {
		throw new Error(
			`Refusing to deploy a second CREATE2 factory. ${detail}\n\n` + "Or pass --allow-new-create2-factory=true if a fresh factory is intended.",
		)
	}
	logger.warn(detail)
}

/**
 * Resolve the plan's factory intent to a real address and bind it. Reuse checks for code;
 * deploy recovers a checkpointed factory, refuses a silent second one, or creates it.
 *
 * The creation is journalled through checkpointDeployment, so an uncertain receipt is
 * reconciled on resume rather than orphaning a factory. That is the property the standalone
 * deploy:create2factory task lacks, and the reason this path is safe on a live chain.
 */
export async function ensureCreate2Factory(
	hre: any,
	plan: VanityPlan,
	options: { checkpoint?: DeploymentCheckpoint; isLive: boolean; allowNewFactory: boolean; logData?: boolean },
): Promise<{ address: string; deployed: boolean }> {
	const { ethers } = await getConnection(hre)

	if (plan.factoryIntent.mode === "reuse") {
		const address = await resolveCreate2FactoryAddress(ethers, plan.factoryIntent.address)
		plan.bindFactory(address)
		return { address, deployed: false }
	}

	const { checkpoint, isLive, allowNewFactory, logData = true } = options

	await recoverCheckpointContractDeployments(checkpoint, ethers.provider, CREATE2_FACTORY_COMPONENT)
	const recovered = checkpoint?.contracts.create2Factory?.address
	if (recovered) {
		const address = ethers.getAddress(recovered)
		if ((await ethers.provider.getCode(address)) === "0x") {
			throw new Error(`Checkpoint records a Create2Factory at ${address} but it has no code on this network`)
		}
		logger.info(`  ⏭ Create2Factory already deployed at ${address}`)
		plan.bindFactory(address)
		return { address, deployed: false }
	}

	await assertNoRecordedFactory(ethers, { isLive, allowNewFactory })

	logger.section("Create2Factory Deployment")
	const factory = await ethers.getContractFactory("Create2Factory")
	const contract = await factory.deploy()
	const { address } = await confirmDeploymentWithReceipt(contract, "Create2Factory", checkpointDeployment(checkpoint, CREATE2_FACTORY_COMPONENT, []))

	if (checkpoint) {
		checkpoint.contracts.create2Factory = createDeployedContract(address, [])
		saveCheckpoint(checkpoint)
	}
	logger.deployed("Create2Factory", address)
	if (logData) writeData(CREATE2FACTORY_DEPLOYMENT_FILE, [{ name: "Create2Factory", address, constructorArguments: [] }])

	plan.bindFactory(address)
	return { address, deployed: true }
}

export const create2FactoryTask = task("deploy:create2factory", "Deploys the Create2Factory for deterministic address deployments")
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ logData }, hre) => {
			await assertStandaloneDeploymentTaskAllowed(
				hre,
				"deploy:create2factory",
				'For a live deployment, set "create2": { "factory": { "mode": "deploy" } } in the recipe and run the normal deployment; ' +
					"the factory is then deployed and journalled as part of the run.",
			)
			return deployCreate2Factory(hre, { logData })
		},
	}))
	.build()
