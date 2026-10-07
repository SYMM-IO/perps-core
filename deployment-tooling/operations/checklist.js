export function checklistExplorerVerification(context, report) {
	if (context?.recipe?.network?.mode === "live") {
		return report?.checks?.verificationPolicy === "required" && report?.checks?.verification === "passed";
	}
	return report?.checks?.verificationPolicy === "not_applicable" && report?.checks?.verification === "skipped";
}

export const CHECKLIST_ITEMS = [
	["recipe-report binding", ({ report, context }) => report?.recipe?.digest === context.digest && report.recipe.name === context.recipe.name],
	[
		"transaction receipts",
		({ report }) =>
			Array.isArray(report?.transactions) &&
			report.transactions.length > 0 &&
			report.transactions.every(
				transaction => ["confirmed", "replaced"].includes(transaction.status) && /^0x[0-9a-f]{64}$/i.test(transaction.hash),
			),
	],
	["bytecode and facet selectors", ({ statusCode }) => statusCode === 0],
	["ownership and roles", ({ statusCode, report }) => statusCode === 0 && report?.ownershipHandover?.status === "complete"],
	["deployer privilege removal", ({ statusCode }) => statusCode === 0],
	["protocol configuration", ({ statusCode }) => statusCode === 0],
	["InstantLayer templates", ({ statusCode }) => statusCode === 0],
	["Muon permissions", ({ statusCode }) => statusCode === 0],
	["component settings", ({ statusCode }) => statusCode === 0],
	["ExpressProvider credit caps", ({ statusCode }) => statusCode === 0],
	["explorer verification", ({ context, report }) => checklistExplorerVerification(context, report)],
	[
		"handover",
		({ report }) =>
			report?.lifecycle === "complete" && report?.ownershipHandover?.status === "complete" && (report.manualActions || []).length === 0,
	],
	["current health", ({ doctorCode, statusCode, report }) => doctorCode === 0 && statusCode === 0 && report?.checks?.health === "passed"],
];

export function assessChecklist(evidence) {
	return CHECKLIST_ITEMS.map(([title, check], index) => ({
		id: `check-${String(index + 1).padStart(2, "0")}`,
		title,
		status: check(evidence) ? "passed" : "failed",
	}));
}
