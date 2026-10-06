function governanceLabel(type) {
	return type === "eoa" ? "EOA" : type === "safe" ? "Safe" : "unknown contract";
}

function statusFor(lifecycle) {
	if (lifecycle === "complete") return { heading: "DEPLOYMENT COMPLETE", label: "Complete" };
	if (lifecycle === "pending_handover") return { heading: "HANDOVER REQUIRED", label: "Pending governance handover" };
	return { heading: "DEPLOYMENT FAILED", label: "Failed" };
}

export function normalizeDeploymentSummary(report, { explorer } = {}) {
	if (!report || typeof report !== "object") throw new Error("Deployment report must be an object");
	const governance = report.governance || report.governanceAdmin || {};
	const address = value => (typeof value === "string" && value ? value : null);
	const rows = [
		["Symmio Core", report.addresses?.diamond],
		["Collateral", report.addresses?.collateral || report.config?.collateralAddress],
		["AccountLayer", report.addresses?.accountLayerDiamond],
		["InstantLayer", report.addresses?.instantLayer],
		["ExpressProvider", report.addresses?.expressProvider],
		["Signature verifier", report.addresses?.signatureVerifier],
		[`Governance admin (${governanceLabel(governance.type)})`, governance.address || report.config?.admin],
		["Fee receiver", report.config?.symmioFeeReceiver],
		["SymbolManager", report.addresses?.symbolManager],
		["Symbol manager operator", report.config?.symbolManagerOperator],
		["CREATE2 factory", report.addresses?.create2Factory],
		["GaslessLayer proxy", report.addresses?.gaslessLayer],
		["GaslessLayer implementation", report.addresses?.gaslessLayerImplementation],
		["Liquidator proxy", report.addresses?.symmioLiquidator],
		["Liquidator implementation", report.addresses?.symmioLiquidatorImplementation],
		["PartyB proxy", report.addresses?.symmioPartyB],
		["PartyB implementation", report.addresses?.symmioPartyBImplementation],
	].map(([label, value]) => {
		const resolved = address(value);
		return { label, address: resolved, url: resolved && explorer ? `${String(explorer).replace(/\/$/, "")}/address/${resolved}` : null };
	});
	return {
		...statusFor(report.lifecycle),
		lifecycle: report.lifecycle,
		network: report.network || "unknown",
		chainId: report.chainId,
		deploymentId: report.deploymentId || "unknown",
		recipeName: report.recipe?.name || "unbound",
		recipeDigest: report.recipe?.digest || "unbound",
		updatedAt: report.updatedAt || report.timestamp,
		health: report.checks?.health || "unknown",
		verification: report.checks?.verification || "unknown",
		verificationPolicy: report.checks?.verificationPolicy || "unknown",
		transactionCount: Array.isArray(report.transactions) ? report.transactions.length : 0,
		rows,
		actions: Array.isArray(report.governanceActions) ? report.governanceActions : [],
	};
}

export function renderDeploymentTerminal(summary) {
	const width = Math.max(...summary.rows.map(row => row.label.length), 1);
	const lines = [
		summary.heading,
		"",
		`Network: ${summary.network} (${summary.chainId})`,
		`Deployment: ${summary.deploymentId}`,
		`Recipe: ${summary.recipeName} • ${summary.recipeDigest}`,
		`Health: ${summary.health}`,
		`Explorer verification: ${summary.verification} (${summary.verificationPolicy})`,
		`Confirmed/recorded transactions: ${summary.transactionCount}`,
		"",
		"IMPORTANT ADDRESSES",
		...summary.rows.map(row => `${row.label.padEnd(width)}  ${row.address || "Not deployed"}`),
	];
	if (summary.actions.length > 0) {
		lines.push("", "GOVERNANCE HANDOVER", ...summary.actions.map((action, index) => `${index + 1}. ${action.description} [${action.method}]`));
	}
	return `${lines.join("\n")}\n`;
}

export function renderDeploymentMarkdown(summary) {
	const rows = summary.rows.map(
		row => `| ${row.label} | ${row.address ? (row.url ? `[${row.address}](${row.url})` : row.address) : "Not deployed"} |`,
	);
	const actions = summary.actions.length
		? summary.actions.map((action, index) => `${index + 1}. **${action.description}** — \`${action.method}\` on \`${action.to}\``)
		: ["No governance actions remain."];
	return `${[
		"# SYMMIO deployment report",
		"",
		"## Status",
		"",
		`**${summary.heading}**`,
		"",
		`- Network: ${summary.network} (${summary.chainId})`,
		`- Deployment ID: \`${summary.deploymentId}\``,
		`- Recipe: ${summary.recipeName} (\`${summary.recipeDigest}\`)`,
		`- Updated: ${summary.updatedAt || "Unknown"}`,
		"",
		"## Important addresses",
		"",
		"| Component | Address |",
		"| --- | --- |",
		...rows,
		"",
		"## Verification",
		"",
		`- Health: **${summary.health}**`,
		`- Explorer verification: **${summary.verification}** (${summary.verificationPolicy})`,
		`- Confirmed/recorded transactions: ${summary.transactionCount}`,
		"",
		"## Governance handover",
		"",
		...actions,
		"",
	].join("\n")}\n`;
}
