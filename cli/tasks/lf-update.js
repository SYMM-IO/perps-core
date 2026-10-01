import { CHAINS, resolveNetwork, rpcEnvKey } from "../lib/context.js";
import { SIGNER_MODES, selectSigner, signerEnvironment } from "../signer/index.js";
import { getAddress, isAddress, ZeroAddress } from "ethers";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Operator-supplied deployments; every selection is checked against live wiring and authority.
export const LF_DEPLOYMENTS = [
	{
		id: "base-085",
		name: "Base v0.8.5",
		network: "base",
		core: "0x91Cf2D8Ed503EC52768999aA6D8DBeA6e52dbe43",
		symbolManager: "0x39E5d7c13d61d0D493ECc9B7A7f38905df2Db923",
	},
	{
		id: "arbitrum-085",
		name: "Arbitrum v0.8.5",
		network: "arbitrum",
		core: "0x8F06459f184553e5d04F07F868720BDaCAB39395",
		symbolManager: "0x5d1e5dd0463dce32c6502e0fc98b2081cba55c73",
	},
	{
		id: "arbitrum-0862",
		name: "Arbitrum v0.8.6.2",
		network: "arbitrum",
		core: "0x57331027091994FCb9c5Aec48ea92cEf0a93CF6A",
		symbolManager: "0x3FB153ee0a18B2726a54E132C173AC73D8c05e20",
	},
	{
		id: "bsc-085",
		name: "BNB v0.8.5",
		network: "bsc",
		core: "0x9A9F48888600FC9c05f11E03Eab575EBB2Fc2c8f",
		symbolManager: "0x657A15cdA334599954a743971A739264AFE6ff4b",
	},
];
export const LF_STEPS = [
	{ id: "inspect", phase: "prepare", title: "Read symbols and review BTC/ETH classifications" },
	{ id: "authorize", phase: "authorization", title: "Review LF changes and authorize the selected chain" },
	// Keep the bound title compatible with already-reviewed, paused runs.
	{ id: "apply", phase: "execution", title: "Apply and verify LF batches" },
	{ id: "verify", phase: "verification", title: "Verify every symbol against the reviewed plan" },
];
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
export const lfDirectory = ctx => path.join(path.dirname(ctx.state.eventPath), "lf-update");
function outputFile(ctx, name) {
	const pointer = path.join(lfDirectory(ctx), "latest-output.json");
	if (fs.existsSync(pointer)) {
		const output = read(pointer);
		if (output.files?.[name]) return path.join(output.directory, output.files[name]);
	}
	return path.join(lfDirectory(ctx), name);
}
const configFor = input =>
	Object.fromEntries(
		["network", "chainId", "core", "symbolManager", "authority", "batchSize", "announcementReference", "enforcementAt"].map(key => [
			key,
			input[key],
		]),
	);
function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map(key => [key, stable(value[key])]),
		);
	return value;
}
export function readLfPlan(ctx) {
	const plan = read(path.join(lfDirectory(ctx), "plan.json"));
	const { digest, ...unsigned } = plan;
	const actual = `sha256:${createHash("sha256")
		.update(JSON.stringify(stable(unsigned)))
		.digest("hex")}`;
	if (!ctx.state.lfPlanDigest || digest !== ctx.state.lfPlanDigest || actual !== digest)
		throw new Error("Reviewed LF plan changed; restore it or cancel and review a new plan");
	return plan;
}
export function lfEnvironment(ctx, input, phase, execute = false) {
	if (input.signer?.mode !== SIGNER_MODES.KEYSTORE) throw new Error("LF updates require the selected existing keystore wallet");
	return {
		...signerEnvironment(input.signer),
		DOTENV_CONFIG_PATH: "/dev/null",
		SYMMIO_DEPLOYMENT_RECIPE: "",
		SYMMIO_RPC_URL_OVERRIDE: "",
		LF_UPDATE_CONFIG: JSON.stringify(configFor(input)),
		LF_UPDATE_DIRECTORY: lfDirectory(ctx),
		LF_UPDATE_PHASE: phase,
		LF_UPDATE_PLAN_DIGEST: ctx.state.lfPlanDigest || "",
		LF_UPDATE_CONTINUATION: "false",
		EXECUTE: String(execute),
		CONFIRM_CHAIN_ID: execute ? String(input.chainId) : "",
		DRY_RUN: "",
	};
}
async function adapter(ctx, input, phase, execute = false, extra = {}) {
	await ctx.runProcess("./node_modules/.bin/hardhat", ["run", "--no-compile", "scripts/symbols/updateLf.ts", "--network", input.network], {
		env: { ...lfEnvironment(ctx, input, phase, execute), ...extra },
	});
}
async function address(ui, message, initialValue) {
	const value = await ui.text({
		message,
		...(initialValue ? { initialValue } : {}),
		validate: value => (isAddress(value) && getAddress(value) !== ZeroAddress ? undefined : "Enter a non-zero EVM address"),
	});
	return value === null ? null : getAddress(value);
}
async function prepare({ ui }) {
	const selected = await ui.select({
		message: "LF update deployment",
		initialValue: "base-085",
		options: [...LF_DEPLOYMENTS.map(item => ({ value: item.id, label: item.name })), { value: "custom", label: "Another deployment" }],
	});
	if (selected === null) return null;
	const preset = LF_DEPLOYMENTS.find(item => item.id === selected);
	const network =
		preset?.network ||
		(await ui.select({
			message: "Deployment network",
			options: Object.entries(CHAINS)
				.filter(([, chain]) => !chain.simulated)
				.map(([value, chain]) => ({ value, label: chain.name })),
		}));
	if (network === null) return null;
	const core = await address(ui, "Core address", preset?.core);
	if (core === null) return null;
	const symbolManager = await address(ui, "Symbol Manager address", preset?.symbolManager);
	if (symbolManager === null) return null;
	const authority = await address(ui, "Wallet that holds the LF-management role");
	if (authority === null) return null;
	const batchSize = await ui.text({
		message: "Maximum symbols per transaction",
		initialValue: "50",
		validate: value => (/^[1-9]\d*$/.test(value) && Number(value) <= 50 ? undefined : "Enter an integer from 1 to 50"),
	});
	if (batchSize === null) return null;
	const announcementReference = await ui.text({
		message: "Recorded solver announcement reference",
		validate: value => (value.trim() ? undefined : "Enter the announcement URL or record identifier"),
	});
	if (announcementReference === null) return null;
	const enforcementAt = await ui.text({
		message: "Announced enforcement time in UTC",
		placeholder: "YYYY-MM-DDTHH:mm:ssZ",
		validate: value =>
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? undefined : "Use YYYY-MM-DDTHH:mm:ssZ",
	});
	if (enforcementAt === null) return null;
	ui.note(
		`The existing Hardhat keystore supplies ${rpcEnvKey(network)} and your wallet key. No RPC URL or private key is stored in this task.`,
		"Keystore credentials",
	);
	const signer = await selectSigner(ui, {
		role: "LF operator",
		allowedModes: [SIGNER_MODES.KEYSTORE],
		network,
		expectedAddress: authority,
		existingKeystoreOnly: true,
		initialKeystoreKey: "TEAM_DEPLOYER",
	});
	if (!signer) return null;
	return {
		network,
		chainId: resolveNetwork(network).chainId,
		core,
		symbolManager,
		authority,
		batchSize: Number(batchSize),
		announcementReference,
		enforcementAt,
		signer,
	};
}
export async function reconcileLfTask(ctx, input) {
	if (ctx.state.lfPlanDigest) {
		const file = path.join(lfDirectory(ctx), "report.json");
		const report = fs.existsSync(file)
			? read(file)
			: {
					apiVersion: "operations.symm.io/lf-report-v1",
					planDigest: ctx.state.lfPlanDigest,
					authority: input.authority,
					status: "prepared",
					transactions: [],
				};
		if (report.planDigest !== ctx.state.lfPlanDigest || report.authority.toLowerCase() !== input.authority.toLowerCase())
			throw new Error("LF report binding mismatch");
		// The runner journal also survives a failed adapter write-ahead save.
		for (const transaction of ctx.state.transactions || [])
			if (!report.transactions.some(existing => existing.hash === transaction.hash)) report.transactions.push(transaction);
		fs.mkdirSync(lfDirectory(ctx), { recursive: true });
		const temporary = `${file}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(temporary, file);
		if (report.transactions.some(tx => ["submitted", "unresolved", "timed_out"].includes(tx.status))) await adapter(ctx, input, "reconcile");
	}
	return {
		unresolved: (ctx.state.transactions || []).filter(tx => ["submitted", "unresolved", "timed_out"].includes(tx.status)).map(tx => tx.hash),
	};
}
export function createLfUpdateTask(common) {
	return common({
		id: "maintenance.update-symbol-lf",
		version: 1,
		category: "maintenance",
		risk: "transaction",
		title: "Update symbol LF minimums",
		description: "Set BTC/ETH to 3% and other symbols to 4%, then verify every symbol and preserved quote minimum.",
		supportedNetworks: Object.keys(CHAINS).filter(name => !CHAINS[name].simulated),
		inputs: [
			{ id: "network", type: "network", label: "Network", required: true },
			{ id: "chainId", type: "integer", label: "Chain ID", required: true },
			...["core", "symbolManager", "authority"].map(id => ({ id, type: "address", label: id, required: true })),
			{ id: "batchSize", type: "integer", label: "Symbols per batch", required: true },
			...["announcementReference", "enforcementAt"].map(id => ({ id, type: "string", label: id, required: true })),
		],
		artifacts: [
			"symbol snapshot",
			"reviewed LF plan and CSV",
			"solver announcement reference and enforcement time",
			"transaction journal",
			"receipts and on-chain symbol verification",
		],
		prepare,
		signerPolicy: { role: "LF operator", allowedModes: [SIGNER_MODES.KEYSTORE] },
		// Preserve the reviewed LF plan and journal when an operator accepts a recovery fix.
		// The shared runner requires typed source-hash confirmation and refuses unresolved transactions.
		resumePolicy: { strategy: "stable-step-id", sourceDrift: "confirm", inputDrift: "refuse" },
		plan: () => LF_STEPS.map(step => ({ ...step })),
		run: async (ctx, input) => {
			await ctx.step("inspect", LF_STEPS[0].title, async () => {
				await adapter(ctx, input, "inspect");
				const snapshot = read(path.join(lfDirectory(ctx), "snapshot.json"));
				const candidates = new Set([...snapshot.classification.btcEthIds, ...snapshot.classification.ambiguousIds]);
				ctx.ui.note(
					[
						`Inventory: ${snapshot.symbols.length} symbols, including inactive listings.`,
						...snapshot.symbols
							.filter(symbol => candidates.has(symbol.symbolId))
							.map(
								symbol =>
									`#${symbol.symbolId} ${symbol.name}${snapshot.classification.ambiguousIds.includes(symbol.symbolId) ? " — review classification" : " — suggested BTC/ETH"}`,
							),
					].join("\n"),
					"BTC/ETH classification",
				);
				const ids = await ctx.ui.text({
					message: "BTC/ETH symbol IDs for 3% (comma-separated; every other ID gets 4%)",
					initialValue: snapshot.classification.btcEthIds.join(","),
					validate: value => {
						const values = value.trim() ? value.split(",").map(id => id.trim()) : [];
						return new Set(values).size === values.length && values.every(id => snapshot.symbols.some(symbol => symbol.symbolId === id))
							? undefined
							: "Use unique IDs from the snapshot";
					},
				});
				if (ids === null) {
					ctx.requestPause();
					ctx.checkpoint();
					return;
				}
				await adapter(ctx, input, "plan", false, { LF_UPDATE_SNAPSHOT_DIGEST: snapshot.digest, LF_UPDATE_BTC_ETH_IDS: ids });
				ctx.state.lfPlanDigest = read(path.join(lfDirectory(ctx), "plan.json")).digest;
			});
			await ctx.step("authorize", LF_STEPS[1].title, async () => {
				const plan = readLfPlan(ctx);
				await adapter(ctx, input, "apply");
				const changed = plan.rows.filter(row => row.minAcceptablePortionLF !== row.targetLF);
				const reductions = changed.filter(row => BigInt(row.minAcceptablePortionLF) > BigInt(row.targetLF));
				ctx.ui.note(
					[
						`Network: ${input.network} (${input.chainId})`,
						`Manager: ${input.symbolManager}`,
						`Wallet: ${input.authority}`,
						`${changed.length} changes; ${plan.btcEthIds.length} BTC/ETH IDs at 3%; ${plan.rows.length - plan.btcEthIds.length} other IDs at 4%.`,
						`Existing minimum quote values are preserved. ${reductions.length} existing LF rates would decrease to the exact policy target.`,
						`Announcement: ${input.announcementReference}`,
						`Enforcement: ${input.enforcementAt}`,
						`Review all names, IDs, old/new rates and quote minima: ${outputFile(ctx, "preview.csv")}`,
					].join("\n"),
					"LF rollout preview",
				);
				const typed = await ctx.ui.text({
					message: `After reviewing the CSV, type ${input.chainId} to authorize these LF changes`,
					validate: value => (value === String(input.chainId) ? undefined : `Type exactly ${input.chainId}`),
				});
				if (typed === null) {
					ctx.requestPause();
					ctx.checkpoint();
					return;
				}
				if (typed !== String(input.chainId)) throw new Error("LF chain confirmation did not match");
			});
			await ctx.step("apply", LF_STEPS[2].title, async () => {
				readLfPlan(ctx);
				await reconcileLfTask(ctx, input);
				let previousPending = Infinity;
				let continuing = false;
				for (;;) {
					ctx.checkpoint();
					await adapter(ctx, input, "apply", true, { LF_UPDATE_CONTINUATION: String(continuing) });
					const report = read(path.join(lfDirectory(ctx), "report.json"));
					if (report.status === "submitted" || report.status === "complete") break;
					if (report.status === "waiting-daily-limit" || report.status === "waiting-enforcement")
						ctx.wait(`${report.status}: ${report.nextEligibleAt}. Choose Continue active task when eligible.`);
					if (report.status !== "ready" || report.pending >= previousPending)
						throw new Error(`LF update made no progress (${report.status}); inspect the report`);
					previousPending = report.pending;
					continuing = true;
				}
			});
			await ctx.step("verify", LF_STEPS[3].title, async () => {
				await adapter(ctx, input, "verify");
				const report = read(path.join(lfDirectory(ctx), "report.json"));
				if (report.status !== "complete" || report.verification?.symbols?.length !== report.total)
					throw new Error("LF final on-chain verification is incomplete");
				const pointer = path.join(lfDirectory(ctx), "latest-output.json");
				const evidence = fs.existsSync(pointer) ? read(pointer).directory : lfDirectory(ctx);
				ctx.ui.note(`${report.total} symbols verified at block ${report.block.number}. Evidence: ${evidence}`, "LF update complete");
			});
		},
		validateResume: ({ state }) => {
			if (state.lfPlanDigest) readLfPlan({ state });
		},
		reconcile: reconcileLfTask,
	});
}
