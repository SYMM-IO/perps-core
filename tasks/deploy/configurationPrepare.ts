import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import { execFileSync } from "node:child_process"
import path from "node:path"

import { loadConfigurationRequest, prepareConfiguration } from "../../deployment-tooling/operations/configuration-request.js"
import { writeImmutableDocument } from "../../deployment-tooling/operations/outputs.js"
import { loadDeploymentRecipe } from "../../deployment-tooling/recipe.js"
import { getConnection } from "./helpers.js"

export const configurationPrepareTask = task("internal:configuration-prepare", "Read-only configuration-preservation adapter")
	.addOption({ name: "request", description: "Configuration request JSON", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "output", description: "Prepared configuration output", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.setAction(async () => ({
		default: async ({ request, output }, hre) => {
			if (!request || !output || process.env.SYMMIO_RECIPE_READ_ONLY !== "true")
				throw new Error("Use the registered read-only configuration preparation task")
			const bundle = loadConfigurationRequest(path.resolve(request)),
				recipe = loadDeploymentRecipe(bundle.recipePath)
			if (
				bundle.inputDigest !== process.env.SYMMIO_CONFIGURATION_INPUT ||
				recipe.digest !== process.env.SYMMIO_DEPLOYMENT_RECIPE_DIGEST ||
				path.resolve(process.env.SYMMIO_DEPLOYMENT_RECIPE || "") !== recipe.path ||
				execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== bundle.request.sourceCommit ||
				execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()
			)
				throw new Error("Configuration preparation input, recipe or source changed")
			const connection = await getConnection(hre),
				mode = connection.networkConfig?.type === "edr-simulated" ? "fork" : connection.networkName === "localhost" ? "local" : "live"
			if (
				connection.networkName !== recipe.recipe.network.name ||
				mode !== recipe.recipe.network.mode ||
				bundle.profile.chainId !== recipe.recipe.network.chainId
			)
				throw new Error("Configuration preparation network differs from its recipe")
			const result = await prepareConfiguration(connection.ethers.provider, bundle)
			if (
				loadConfigurationRequest(bundle.path).inputDigest !== bundle.inputDigest ||
				loadDeploymentRecipe(bundle.recipePath).digest !== recipe.digest
			)
				throw new Error("Configuration preparation input changed during inspection")
			writeImmutableDocument(path.dirname(path.resolve(output)), path.basename(output), result)
		},
	}))
	.build()
