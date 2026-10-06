import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { loadCheckpoint, saveCheckpoint, setCheckpointSimulated } from "./checkpoint.js"
import { componentCheckpointScope, type DeploymentComponentName } from "./deploymentRecipe.js"
import { getConnection } from "./helpers.js"
import { emitTaskEvent, logger } from "./logger.js"
import { requireActiveDeploymentRecipe } from "./recipeRuntime.js"
import { reconcileDeploymentTransactions } from "./tx.js"

export const reconcileTransactionsTask = task(
	"reconcile:deployment-transactions",
	"Read-only chain reconciliation for transaction outcomes in one recipe-bound checkpoint",
)
	.addOption({
		name: "component",
		description: "Optional component checkpoint: partyB, symbolManager, expressProvider, or gaslessLayer",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.setAction(async () => ({
		default: async ({ component: rawComponent }, hre) => {
			const active = requireActiveDeploymentRecipe()
			const connection = await getConnection(hre)
			const { ethers } = connection
			const chainId = Number((await ethers.provider.getNetwork()).chainId)
			const simulated = connection.networkConfig?.type === "edr-simulated"
			if (chainId !== active.recipe.network.chainId || connection.networkName !== active.recipe.network.name) {
				throw new Error(
					`Recipe/checkpoint target mismatch: connected ${connection.networkName}/${chainId}, expected ${active.recipe.network.name}/${active.recipe.network.chainId}`,
				)
			}
			setCheckpointSimulated(simulated)
			let scope: string | undefined
			if (rawComponent) {
				if (!(["partyB", "symbolManager", "expressProvider", "gaslessLayer"] as string[]).includes(rawComponent)) {
					throw new Error(`Unknown component checkpoint ${JSON.stringify(rawComponent)}`)
				}
				scope = componentCheckpointScope(active.recipe.name, rawComponent as DeploymentComponentName)
			}
			const checkpoint = loadCheckpoint(chainId, scope)
			if (!checkpoint) {
				logger.info("No active deployment checkpoint exists; there are no checkpoint transactions to reconcile.")
				return { reconciled: 0, transactions: [] }
			}
			let reconciled = 0
			try {
				reconciled = await reconcileDeploymentTransactions(checkpoint.transactions || [], ethers.provider, checkpoint.deployerAddress)
			} finally {
				saveCheckpoint(checkpoint)
				for (const transaction of checkpoint.transactions || []) {
					if (transaction.status === "confirmed" || transaction.status === "replaced") {
						emitTaskEvent("tx.confirmed", { transaction })
					} else if (transaction.status === "failed") emitTaskEvent("tx.failed", { transaction })
				}
			}
			logger.info(`Reconciled ${reconciled} deployment transaction outcome(s).`)
			return { reconciled, transactions: checkpoint.transactions || [] }
		},
	}))
	.build()
