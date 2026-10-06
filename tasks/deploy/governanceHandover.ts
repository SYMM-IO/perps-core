import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import fs from "node:fs"

import { getDataDir, setDataScope } from "../utils/fs.js"
import { loadCheckpoint } from "./checkpoint.js"
import { classifyGovernanceAdmin, executeGovernanceActions, governanceAction, type GovernanceAction } from "./governanceActions.js"
import { getConnection } from "./helpers.js"
import { requireActiveDeploymentRecipe } from "./recipeRuntime.js"

function readJson(path: string, label: string): any {
	if (!fs.existsSync(path)) throw new Error(`${label} is missing: ${path}`)
	try {
		return JSON.parse(fs.readFileSync(path, "utf8"))
	} catch (error) {
		throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
	}
}

export async function executeGovernanceHandover(hre: any, recipePath?: string): Promise<{ submitted: number; skipped: number; verified: number }> {
	const active = requireActiveDeploymentRecipe(recipePath)
	const { ethers } = await getConnection(hre)
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	if (chainId !== active.recipe.network.chainId) {
		throw new Error(`Governance handover connected to chainId ${chainId}; recipe requires ${active.recipe.network.chainId}`)
	}
	setDataScope(chainId, { simulated: active.recipe.network.mode === "fork" })
	const reportPath = `${getDataDir()}/deployment-report.json`
	const report = readJson(reportPath, "deployment report")
	if (report?.recipe?.name !== active.recipe.name || report?.recipe?.digest !== active.digest) {
		throw new Error("Deployment report is not bound to the active reviewed recipe")
	}
	if (report.lifecycle !== "pending_handover") {
		throw new Error(`Deployment report lifecycle is ${JSON.stringify(report.lifecycle)}; expected pending_handover`)
	}
	const admin = ethers.getAddress(active.recipe.governance.admin)
	if (active.recipe.network.mode === "live") {
		if (process.env.CONFIRM_CHAIN_ID !== String(chainId)) {
			throw new Error(`Live governance handover requires CONFIRM_CHAIN_ID=${chainId}`)
		}
		if (!process.env.SYMMIO_EXPECTED_SIGNER || ethers.getAddress(process.env.SYMMIO_EXPECTED_SIGNER) !== admin) {
			throw new Error(`Live governance handover requires SYMMIO_EXPECTED_SIGNER=${admin}`)
		}
	}
	if (ethers.getAddress(report.config?.admin) !== admin) throw new Error("Deployment report admin does not match the reviewed recipe")
	if (report.governanceAdmin?.type !== "eoa" || ethers.getAddress(report.governanceAdmin?.address) !== admin) {
		throw new Error("Deployment report does not classify the reviewed governance administrator as an EOA")
	}
	const currentClassification = await classifyGovernanceAdmin(ethers.provider, admin)
	if (currentClassification.type !== "eoa") {
		throw new Error(`Governance administrator ${admin} is currently ${currentClassification.type}; refusing automatic EOA execution`)
	}
	if (!Array.isArray(report.governanceActions) || report.governanceActions.length === 0) {
		throw new Error("Deployment report has no verified governance actions")
	}
	if (!Array.isArray(report.safeActions) || report.safeActions.length !== report.governanceActions.length) {
		throw new Error("Some pending actions lack post-state proofs; refusing automatic EOA execution")
	}
	const actions: GovernanceAction[] = report.governanceActions.map((action: GovernanceAction) => governanceAction(action))
	const checkpoint = loadCheckpoint(chainId)
	if (!checkpoint || checkpoint.deploymentId !== report.deploymentId || checkpoint.step !== "pending_handover") {
		throw new Error("Governance handover requires the matching pending deployment checkpoint")
	}
	return executeGovernanceActions(hre, actions, { expectedAdmin: admin, chainId, checkpoint })
}

export const executeGovernanceHandoverTask = task(
	"internal:execute-governance-handover",
	"Internal adapter for journaled EOA execution of verified deployment governance actions",
)
	.addOption({
		name: "recipe",
		description: "Exact reviewed deployment recipe",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.setAction(async () => ({
		default: async ({ recipe }, hre) => executeGovernanceHandover(hre, recipe),
	}))
	.build()
