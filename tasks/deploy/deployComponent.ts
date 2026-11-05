import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { createDeploymentPlan, DEPLOYMENT_COMPONENTS } from "../../deployment-tooling/recipe.js"
import { executeComponentDeployment } from "./componentDeployment.js"
import {
	assertExpressProviderDeployable,
	assertExpressProviderPatchable,
	DeploymentComponentName,
	loadCoreDependencyReport,
} from "./deploymentRecipe.js"
import { logger } from "./logger.js"
import { requireActiveDeploymentRecipe } from "./recipeRuntime.js"

function displayComponentResult(result: Awaited<ReturnType<typeof executeComponentDeployment>>): void {
	const { report, reportPath } = result
	logger.info("")
	logger.info(`Component: ${report.component}`)
	logger.info(`Lifecycle: ${report.lifecycle}`)
	logger.info(`Address: ${report.address || "not deployed"}`)
	if (report.implementation) logger.info(`Implementation: ${report.implementation}`)
	logger.info(`Admin: ${report.config.admin}`)
	if (report.config.signer) logger.info(`Signer: ${report.config.signer}`)
	if (report.config.adlEnabled !== undefined) logger.info(`ADL enabled: ${report.config.adlEnabled}`)
	if (report.config.operator) logger.info(`Operator: ${report.config.operator}`)
	logger.info(`Verification: ${report.verification.status} (${report.verification.policy})`)
	logger.info(`Health: ${report.health.status}`)
	logger.info(`Report: ${reportPath}`)

	if (report.manualActions.length === 0) {
		logger.info("Manual Safe actions: none")
		return
	}

	logger.warn(`Manual Safe actions required: ${report.manualActions.length}`)
	for (const [index, action] of report.manualActions.entries()) {
		logger.warn(`  [${index + 1}] ${action.description}`)
		logger.warn(`      to: ${action.to}`)
		logger.warn(`      value: ${action.value}`)
		logger.warn(`      data: ${action.data}`)
	}
}

export const deployComponentTask = task(
	"deploy:component",
	"Deploys one recipe component against a proven existing core with scoped recovery and verification",
)
	.addOption({
		name: "recipe",
		description: "Path to the deployment recipe (must match SYMMIO_DEPLOYMENT_RECIPE used to bootstrap Hardhat)",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "component",
		description: `Component to deploy: ${DEPLOYMENT_COMPONENTS.join(", ")}`,
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "fresh",
		description: "Archive the scoped component checkpoint and deliberately start another deployment",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.addOption({
		name: "verify",
		description: "Request explorer verification in addition to recipe execution.verify (mandatory for live targets)",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.setAction(async () => ({
		default: async ({ recipe: recipePath, component: rawComponent, fresh, verify }, hre) => {
			if (!recipePath) throw new Error("Missing required option --recipe")
			if (!rawComponent) throw new Error("Missing required option --component")
			if (!(DEPLOYMENT_COMPONENTS as readonly string[]).includes(rawComponent)) {
				throw new Error(`Unknown deployment component ${JSON.stringify(rawComponent)}. Valid components: ${DEPLOYMENT_COMPONENTS.join(", ")}`)
			}
			const component = rawComponent as DeploymentComponentName | "core"
			const active = requireActiveDeploymentRecipe(recipePath)
			createDeploymentPlan(active.recipe, { only: component })
			if (component === "core") {
				throw new Error("Core is a system bundle. Run deploy:system with this recipe instead of deploy:component --component core.")
			}
			if (component === "expressProvider") {
				if (active.recipe.expressProvider.mode === "reuse") assertExpressProviderPatchable(active.recipe.expressProvider)
				else assertExpressProviderDeployable(active.recipe.expressProvider, active.recipe.network)
			}
			if (active.recipe.core.mode !== "reuse" || !active.recipe.core.fromReport) {
				throw new Error(
					`DEPENDENCY_UNAVAILABLE: standalone ${component} deployment requires core.mode=reuse and core.fromReport; received core.mode=${active.recipe.core.mode}`,
				)
			}
			const coreReportBinding = active.dependencies.coreReport
			if (!coreReportBinding) throw new Error("DEPENDENCY_UNAVAILABLE: validated reuse recipe is missing its pinned core report digest")

			const coreReport = loadCoreDependencyReport(active.recipe.core.fromReport, {
				network: active.recipe.network.name,
				chainId: active.recipe.network.chainId,
				live: active.recipe.network.mode === "live",
				digest: coreReportBinding.digest,
			})
			if (coreReport.config.admin.toLowerCase() !== active.recipe.governance.admin.toLowerCase()) {
				throw new Error(
					`DEPENDENCY_UNAVAILABLE: recipe governance.admin ${active.recipe.governance.admin} does not match core report admin ${coreReport.config.admin}`,
				)
			}
			const result = await executeComponentDeployment(hre, {
				recipeName: active.recipe.name,
				recipePath: active.identityPath,
				recipeDigest: active.digest,
				target: active.recipe.network,
				component,
				// ExpressProvider and GaslessLayer may carry component-local admin overrides.
				componentConfig: {
					...active.recipe[component],
					admin: (active.recipe[component] as { admin?: string }).admin || active.recipe.governance.admin,
				},
				coreReport,
				coreReportPath: coreReportBinding.identityPath,
				fresh,
				verify: Boolean(active.recipe.execution.verify || verify),
			})
			displayComponentResult(result)
			return result
		},
	}))
	.build()
