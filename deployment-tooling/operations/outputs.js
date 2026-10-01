import { OperationError, operationDigest, readOperationJson, validateDocument } from "./inputs.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function writeOperationFile(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		fs.renameSync(temporary, file);
	} finally {
		if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
	}
}

export function writeImmutableDocument(directory, name, document) {
	const file = path.join(directory, name);
	if (fs.existsSync(file)) {
		if (operationDigest(readOperationJson(file).value) !== operationDigest(document))
			throw new OperationError("evidence-drift", "Saved operation evidence changed");
	} else writeOperationFile(file, document);
}

export function renderCoreReview(resolved, snapshot, plan) {
	return (
		[
			`# Core upgrade plan: ${resolved.profile.id}`,
			"Planning only. No contracts were deployed and no governance transaction was exported, signed or sent.",
			`Network: ${resolved.profile.network.name} (${snapshot.chainId}, ${resolved.profile.network.mode})`,
			`Core: ${plan.target}\n\nUpgrade authority: ${plan.authority}`,
			`Snapshot: block ${snapshot.blockNumber}, ${snapshot.blockHash}`,
			`Release: ${resolved.release.id}\n\nSource: ${resolved.release.sourceCommit}`,
			"Facet replacements are proposed from the full supplied manifest; unchanged runtime bytecode has not been proven. diamondCut is retained.",
			[
				"| Selector | Change | Installed facet | Target artifact |\n| --- | --- | --- | --- |",
				...plan.changes.map(c => `| ${c.selector} | ${c.change} | ${c.currentFacet ?? "—"} | ${c.targetArtifact ?? "—"} |`),
			].join("\n"),
			"\nRequired before execution:\n",
			...plan.requiredChecks.map(check => `- ${check}`),
			`\nDeclared migrations: ${plan.migrations.join(", ") || "none"}. These declarations have not been executed or verified.`,
		].join("\n\n") + "\n"
	);
}

export function writeOperationResult(directory, resolved, { runId, eventPath, status, plan = null, error = null }) {
	const result = validateDocument("result", {
		schemaVersion: 1,
		kind: "symmio.result",
		runId: `run-${runId}`,
		operation: resolved.request.operation,
		chainId: resolved.profile.network.chainId,
		target: resolved.profile.components.core.address,
		inputDigest: resolved.inputDigest,
		status,
		planDigest: plan ? operationDigest(plan) : null,
		transactions: [],
		verification: "not-run",
		artifacts: {
			request: "request.json",
			resolvedInput: "resolved-input.json",
			snapshot: "snapshot.json",
			plan: "plan.json",
			review: "review.md",
			verification: "verification.json",
			transactions: "transactions.json",
			events: eventPath,
			summary: "summary.md",
		},
		errors: error
			? [
					{
						code: error instanceof OperationError ? error.code : "inspection-failed",
						message:
							error instanceof OperationError
								? error.message.slice(0, 256)
								: "Inspection failed; see the redacted task journal for details",
					},
				]
			: [],
		nextAction:
			status === "planned"
				? "Review the selector plan and required checks; execution is not supported by this planner"
				: status === "cancelled"
					? "Retain this evidence; start a new planning run when needed"
					: "Resolve the reported error and continue the same task, or cancel it",
	});
	writeOperationFile(path.join(directory, "transactions.json"), []);
	writeOperationFile(
		path.join(directory, "verification.json"),
		validateDocument("verification", {
			schemaVersion: 1,
			kind: "symmio.verification",
			inputDigest: resolved.inputDigest,
			status: "not-run",
			reason: "Planning does not execute or verify an upgrade",
		}),
	);
	writeOperationFile(
		path.join(directory, "summary.md"),
		`# Operation ${result.runId}\n\nStatus: **${status}**\n\nChain: ${result.chainId}\n\nTarget: ${result.target}\n\nNo on-chain transactions were submitted. Upgrade verification: not run.\n\n${result.errors.map(e => `${e.code}: ${e.message}`).join("\n")}\n\n${result.nextAction}\n`,
	);
	// Publish the machine-readable result last; no successful result before its artifacts exist.
	writeOperationFile(path.join(directory, "result.json"), result);
	return result;
}
