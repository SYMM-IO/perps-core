import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { captureCoreSnapshot } from "../../deployment-tooling/operations/core-plan.js"
import { assertOperationUnchanged, readOperationJson, OperationError, operationDigest } from "../../deployment-tooling/operations/inputs.js"
import { writeImmutableDocument } from "../../deployment-tooling/operations/outputs.js"
import { getConnection } from "./helpers.js"

export async function inspectOperation(hre: any, request: string, output: string) {
	const bundle = assertOperationUnchanged(request, process.env.SYMMIO_OPERATION_INPUT || "")
	const { resolved } = bundle,
		profile = resolved.profile
	if (
		process.env.SYMMIO_RECIPE_READ_ONLY !== "true" ||
		process.env.SYMMIO_DEPLOYMENT_RECIPE_DIGEST !== bundle.recipe.digest ||
		path.resolve(process.env.SYMMIO_DEPLOYMENT_RECIPE || "") !== bundle.recipe.path
	)
		throw new OperationError("invalid-context", "Use the registered operations planner with its bound read-only credential recipe")
	if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== resolved.release.sourceCommit)
		throw new OperationError("source-mismatch", "Checkout commit differs from the pinned release source")
	const connection = await getConnection(hre)
	const mode = connection.networkConfig?.type === "edr-simulated" ? "fork" : connection.networkName === "localhost" ? "local" : "live"
	if (connection.networkName !== profile.network.name || mode !== profile.network.mode)
		throw new OperationError("network-mismatch", "Connected network mode differs from the deployment profile")
	const saved = fs.existsSync(output) ? readOperationJson(output).value : null
	const snapshot = await captureCoreSnapshot(connection.ethers.provider, resolved, saved?.blockNumber)
	assertOperationUnchanged(request, resolved.inputDigest)
	if (saved && operationDigest(saved) !== operationDigest(snapshot))
		throw new OperationError("evidence-drift", "Saved snapshot differs from its pinned historical block")
	writeImmutableDocument(path.dirname(output), path.basename(output), snapshot)
}

export const operationsInspectTask = task("internal:operations-inspect", "Read-only adapter for standard operation plans")
	.addOption({ name: "request", description: "Operation request JSON", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "output", description: "Snapshot output", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.setAction(async () => ({
		default: async ({ request, output }, hre) => {
			if (!request || !output) throw new Error("Request and output are required")
			await inspectOperation(hre, path.resolve(request), path.resolve(output))
		},
	}))
	.build()
