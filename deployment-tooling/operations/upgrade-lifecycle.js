import { operationDigest } from "./inputs.js";

/** Shared lifecycle for reviewed component adapters. Rehearsal has its own run. */
export const LIVE_UPGRADE_STAGES = Object.freeze(["inspect", "deploy", "prepare-services", "checkpoint", "apply", "verify", "restore", "publish"]);

export function rehearsalStatus(evidence, currentBindings) {
	if (!evidence) return "not-run";
	if (evidence.status !== "complete") return evidence.status === "failed" ? "failed" : "not-run";
	return operationDigest(evidence.bindings) === operationDigest(currentBindings) ? "complete" : "outdated";
}

/** A successful transaction is not a verified migration or a completed publication. */
export function upgradeCompletionStatus({ executionVerified, serviceRestored, publicationVerified }) {
	if (!executionVerified) return "execution-pending";
	if (!serviceRestored) return "restoration-pending";
	return publicationVerified ? "complete" : "publication-pending";
}

/** Persist each published item independently; a retry never re-enters upgrade execution. */
export async function publishUpgradeItems(items, progress, persist, publish) {
	const ids = new Set();
	for (const item of items) {
		if (!item.id || ids.has(item.id)) throw new Error("Publication items need unique stable IDs");
		ids.add(item.id);
	}
	for (const item of items) {
		const binding = operationDigest(item);
		if (progress[item.id]) {
			if (progress[item.id] !== binding) throw new Error(`Published item ${item.id} changed`);
			continue;
		}
		await publish(item);
		progress[item.id] = binding;
		await persist();
	}
}
