import { DEPLOYABLE_CONTRACTS } from "../../deployment-tooling/deployableContracts.js";
import { config as runConfig } from "../commands/config.js";
import { deploy, readComponentReport, validateDeploymentHandoff } from "../commands/deploy.js";
import { doctor } from "../commands/doctor.js";
import { status } from "../commands/status.js";
import { verify } from "../commands/verify.js";
import { readDeploymentReport, resolveNetwork } from "../lib/context.js";
import { PROJECT_ROOT } from "../lib/paths.js";
import { loadRecipeContext, recipeHardhatEnvironment } from "../lib/recipe-context.js";
import { EOA_SIGNER_MODES, SAFE_SIGNER_MODES, SIGNER_MODES, dispatchSafeActions, selectSigner } from "../signer/index.js";
import { ownershipAcceptanceAction, roleGrantAction } from "../signer/safe-batch.js";
import { atomicWrite, prepareDeploymentRecipe, prepareExpressPatch } from "./guided-recipe.js";
import { isAddress } from "ethers";
import fs from "node:fs";
import path from "node:path";

const READ_ONLY_POLICY = Object.freeze({ strategy: "restart", sourceDrift: "refuse" });
const RESUMABLE_POLICY = Object.freeze({ strategy: "stable-step-id", sourceDrift: "refuse", inputDrift: "refuse" });
const SAFE_CANCEL_POLICY = Object.freeze({ rollback: false, reconcileSubmittedTransactions: true, unresolvedOutcome: "cancel_pending" });

function atomicWriteText(file, contents) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(temporary, contents, { mode: 0o600 });
		fs.renameSync(temporary, file);
	} catch (error) {
		try {
			fs.unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

function common(definition) {
	const inputs = [
		...(definition.inputs || []),
		...(definition.risk === "transaction" &&
		!(definition.inputs || []).some(input => (typeof input === "string" ? input === "signer" : input.id === "signer"))
			? [{ id: "signer", label: "Transaction signer", type: "selection", required: true }]
			: []),
	].map(input =>
		typeof input === "string"
			? {
					id: input
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "_")
						.replace(/^_|_$/g, ""),
					label: input,
					type: /recipe/i.test(input)
						? "recipe"
						: /network/i.test(input)
							? "network"
							: /chain.?id/i.test(input)
								? "integer"
								: /keystore|secret/i.test(input)
									? "secret-reference"
									: /confirmation/i.test(input)
										? "boolean"
										: /sections|operators/i.test(input)
											? "selection"
											: /address|admin|signer|operator|symmio|proxy|receiver/i.test(input)
												? "address"
												: "string",
					required: true,
				}
			: input,
	);
	const originalPrepare = definition.prepare;
	const prepare = async context => {
		const input = await originalPrepare(context);
		if (input === null || input === undefined) return input;
		let prepared = input;
		if (definition.risk === "transaction" && !input.signer) {
			const policy = typeof definition.signerPolicy === "function" ? definition.signerPolicy(input) : definition.signerPolicy || {};
			const allowedModes = policy.allowedModes || EOA_SIGNER_MODES;
			const signer = await selectSigner(context.ui, {
				role: policy.role || "Transaction signer",
				allowedModes,
				initialMode:
					policy.initialMode ||
					(input.network === "localhost" && allowedModes.includes(SIGNER_MODES.LOCAL_NODE) ? SIGNER_MODES.LOCAL_NODE : allowedModes[0]),
				network: input.network,
				chainId: input.chainId,
				safeAddress: policy.safeAddress,
				expectedAddress: policy.expectedAddress,
			});
			if (!signer) return null;
			prepared = { ...input, signer };
		}
		return definition.postPrepare ? definition.postPrepare(context, prepared) : prepared;
	};
	return Object.freeze({
		supportedNetworks: ["any"],
		inputs,
		resumePolicy: definition.risk === "read-only" ? READ_ONLY_POLICY : RESUMABLE_POLICY,
		cancellationPolicy: SAFE_CANCEL_POLICY,
		artifacts: [],
		transactionJournal: definition.risk !== "read-only",
		...definition,
		version: definition.risk === "transaction" ? Math.max(definition.version || 1, 2) : definition.version || 1,
		inputs,
		prepare,
		handler: definition.run,
	});
}

function mutationReconcile({ state }) {
	return {
		unresolved: (state.transactions || [])
			.filter(transaction => ["submitted", "unresolved", "timed_out"].includes(transaction.status))
			.map(transaction => transaction.hash),
	};
}

async function deploymentReconcile(ctx, input) {
	if (!ctx.state.transactions.some(transaction => ["submitted", "unresolved", "timed_out"].includes(transaction.status))) return { unresolved: [] };
	const args = ["reconcile:deployment-transactions", "--network", input.network];
	if (input.only) args.push("--component", input.only);
	const recipe = loadRecipeContext(input.config, { only: input.only, plan: false });
	await ctx.runProcess("./node_modules/.bin/hardhat", args, {
		env: recipeHardhatEnvironment(recipe, { SYMMIO_RECIPE_READ_ONLY: "true" }),
	});
	return mutationReconcile(ctx);
}

function requireZero(code, label) {
	if (Number(code) !== 0) throw new Error(`${label} failed with exit code ${code}`);
	return code;
}

function readPendingSafeActions(input) {
	const recipe = loadRecipeContext(input.config, { only: input.only, plan: false });
	const simulated = recipe.recipe.network.mode === "fork";
	let report;
	let reportPath;
	if (input.only) {
		const component = recipe.recipe[input.only];
		const evidence = readComponentReport(input.chainId, {
			simulated,
			recipeName: recipe.recipe.name,
			component: input.only,
			networkName: recipe.networkName,
			recipeDigest: recipe.digest,
			live: recipe.recipe.network.mode === "live",
			config: {
				admin: component.admin || recipe.recipe.governance.admin,
				...(input.only === "partyB" ? { signer: component.signer, adlEnabled: component.adlEnabled } : {}),
				...(input.only === "symbolManager" ? { operator: component.operator } : {}),
			},
		});
		report = evidence.report;
		reportPath = evidence.path;
		report.safeActions = report.manualActions;
	} else {
		reportPath = path.join(PROJECT_ROOT, "tasks", "data", `${input.chainId}${simulated ? "-fork" : ""}`, "deployment-report.json");
		report = validateDeploymentHandoff(readDeploymentReport(input.chainId, { simulated }), input.chainId, {
			requireVerification: recipe.recipe.network.mode === "live",
			recipeContext: recipe,
		});
	}
	if (report.lifecycle !== "pending_handover") {
		throw new Error(`Task returned pending governance actions but report lifecycle is ${JSON.stringify(report.lifecycle)}`);
	}
	if (!Array.isArray(report.safeActions) || report.safeActions.length === 0) {
		throw new Error(
			`Pending report ${path.relative(PROJECT_ROOT, reportPath)} has no machine-readable Safe actions; refusing to infer calldata from prose`,
		);
	}
	return { actions: report.safeActions, recipe, reportPath };
}

async function dispatchPendingSafeActions(ctx, input) {
	const selection = input.patch && SAFE_SIGNER_MODES.includes(input.signer?.mode) ? input.signer : input.governanceSigner;
	if (!selection) return null;
	const { actions, recipe, reportPath } = readPendingSafeActions(input);
	const result = await dispatchSafeActions(ctx, selection, actions, {
		chainId: input.chainId,
		network: input.network,
		name: `${recipe.recipe.name} governance actions`,
		description: `Pending actions from ${path.relative(PROJECT_ROOT, reportPath)}`,
		processEnv: recipeHardhatEnvironment(recipe),
	});
	return result;
}

function inputText(ui, message, { address = false, placeholder, initialValue } = {}) {
	return ui.text({
		message,
		placeholder: placeholder || (address ? "0x…" : undefined),
		initialValue,
		validate: value => {
			if (!value?.trim()) return "A value is required";
			if (address && (!isAddress(value) || /^0x0{40}$/i.test(value))) return "Enter a non-zero EVM address";
		},
	});
}

async function configureRequiredKeystoreKeys(ui, signer, keys) {
	if (signer?.mode !== SIGNER_MODES.KEYSTORE || keys.length === 0) return true;
	const configure = await ui.confirm({ message: `Configure or refresh encrypted ${keys.join(" and ")} now?`, initialValue: true });
	if (configure === null) return false;
	if (!configure) return true;
	for (const key of keys) {
		const code = await ui.runInteractive("./node_modules/.bin/hardhat", ["keystore", "set", "--force", key]);
		if (code !== 0) throw new Error(`Hardhat keystore did not store ${key}`);
	}
	return true;
}

async function prepareExistingRecipe({ root, ui }, { only, fullOnly = false } = {}) {
	const directory = path.join(root, "deployment-recipes");
	if (!fs.existsSync(directory)) throw new Error("No deployment-recipes/ directory exists in this checkout");
	const files = fs
		.readdirSync(directory)
		.filter(file => file.endsWith(".json"))
		.map(file => path.join(directory, file))
		.filter(file => {
			if (!fullOnly) return true;
			try {
				const recipe = JSON.parse(fs.readFileSync(file, "utf8"));
				return [recipe.core, recipe.partyB, recipe.symbolManager, recipe.expressProvider, recipe.gaslessLayer].every(
					component => component?.mode !== "skip",
				);
			} catch {
				return false;
			}
		});
	if (files.length === 0) throw new Error("No deployment recipe exists under deployment-recipes/");
	const selected = await ui.select({
		message: "Which reviewed deployment recipe?",
		options: files.map(file => ({ value: file, label: path.basename(file), hint: path.relative(root, file) })),
	});
	if (selected === null) return null;
	const context = loadRecipeContext(selected, { only, plan: false });
	return {
		config: context.path,
		recipeDigest: context.digest,
		network: context.networkName,
		chainId: context.recipe.network.chainId,
		only,
	};
}

function deploymentPlan(input, scope) {
	const live = input.mode === "live";
	const contracts = scope === "full" || scope === "core" ? Object.keys(DEPLOYABLE_CONTRACTS).sort() : [];
	const batchItems = stage =>
		contracts.map((key, index) => {
			const slug = key
				.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
				.replace(/[^A-Za-z0-9]+/g, "-")
				.toLowerCase();
			return `${stage}.contract-${String(index + 1).padStart(3, "0")}.${slug}`;
		});
	return [
		{ id: "preflight", phase: "prepare", title: "Validate recipe, RPC, signer, permissions and deployment plan" },
		{ id: "compile", phase: "prepare", title: "Compile the exact production source" },
		...(live
			? [
					{
						id: "fork-rehearsal",
						phase: "rehearsal",
						title: "Execute the matching fork rehearsal",
						items: batchItems("fork"),
					},
					{ id: "rehearsal-review", phase: "rehearsal", title: "Review rehearsal receipts and health" },
					{ id: "network-confirmation", phase: "authorization", title: "Type the exact live network name" },
				]
			: []),
		{ id: "execute", phase: "execution", title: "Execute and reconcile deployment", items: batchItems("live") },
		...(input.mode === "local"
			? [{ id: "local-handover", phase: "handover", title: "Complete handover with the unlocked local governance account" }]
			: []),
		{ id: "verification", phase: "assurance", title: "Verify bytecode and explorer records" },
		{ id: "health", phase: "assurance", title: "Run canonical deployment health audit" },
		{ id: "handover", phase: "handover", title: "Prove ownership, roles and deployer privilege removal" },
	];
}

function validateDeploymentResume(_context, input) {
	const current = loadRecipeContext(input.config, { only: input.only });
	if (current.digest !== input.recipeDigest) throw new Error("Deployment recipe or its bound dependency report changed after task preparation");
	if (input.rehearsalConfig) {
		const rehearsal = loadRecipeContext(input.rehearsalConfig, { only: input.only });
		if (rehearsal.digest !== input.rehearsalDigest) throw new Error("Generated fork rehearsal intent changed after task preparation");
	}
}

async function executeDeployment(ctx, input) {
	const args = { config: input.config, only: input.only, _: [] };
	await ctx.step(
		"preflight",
		"Validate recipe, RPC, signer, permissions and deployment plan",
		async () => {
			requireZero(
				await ctx.runCallable("deployment preflight and plan", () =>
					deploy({ ...args, plan: true, fresh: !input.patch && !input.importLegacy }),
				),
				"Deployment plan",
			);
		},
		{ phase: "prepare" },
	);
	// deploy --plan includes compilation. The separate stable marker keeps the operator plan
	// explicit without compiling a second time.
	await ctx.step("compile", "Compile the exact production source", async () => {}, { phase: "prepare" });
	if (input.mode === "live") {
		await ctx.step(
			"fork-rehearsal",
			"Execute the matching fork rehearsal",
			async () => {
				const firstAttempt = ctx.state.rehearsalInitialized !== true;
				if (firstAttempt) {
					ctx.state.rehearsalInitialized = true;
					ctx.emit("task.binding", { name: "fork-rehearsal", initialized: true });
				}
				const code = await ctx.runCallable("matching fork rehearsal", () =>
					deploy({ config: input.rehearsalConfig, only: input.only, yes: true, fresh: firstAttempt, _: [] }),
				);
				if (![0, 2].includes(Number(code))) throw new Error(`Fork rehearsal failed with exit code ${code}`);
				if (Number(code) === 2) {
					ctx.emit("warning", {
						message:
							"Fork rehearsal reached the expected pending-governance boundary; its exact actions are available in the rehearsal report for review.",
					});
				}
			},
			{ phase: "rehearsal" },
		);
		await ctx.step(
			"rehearsal-review",
			"Review rehearsal receipts and health",
			async () => {
				const proceed = await ctx.ui.confirm({ message: "Fork rehearsal passed. Continue toward live authorization?", initialValue: false });
				if (!proceed) ctx.requestPause();
				ctx.checkpoint();
			},
			{ phase: "rehearsal" },
		);
		await ctx.step(
			"network-confirmation",
			"Type the exact live network name",
			async () => {
				const typed = await ctx.ui.text({
					message: `Type ${input.network} to authorize live transactions`,
					validate: value => (value === input.network ? undefined : `Type exactly ${input.network}`),
				});
				if (typed === null) ctx.requestPause();
				ctx.checkpoint();
			},
			{ phase: "authorization" },
		);
	}
	await ctx.step(
		"execute",
		"Execute and reconcile deployment",
		async () => {
			const firstAttempt = ctx.state.executionInitialized !== true;
			if (firstAttempt) {
				ctx.state.executionInitialized = true;
				ctx.emit("task.binding", { name: "live-execution", initialized: true });
			}
			const code = await ctx.runCallable("deployment execution", () =>
				deploy({
					...args,
					yes: true,
					fresh: !input.patch && !input.importLegacy && firstAttempt,
					"confirm-network": input.mode === "live" ? input.network : undefined,
				}),
			);
			if (Number(code) === 2 && input.mode === "local") {
				ctx.state.localHandoverRequired = true;
				ctx.emit("task.binding", { name: "local-handover", required: true });
				return;
			}
			if (Number(code) === 2) {
				const delivery = await dispatchPendingSafeActions(ctx, input);
				if (delivery?.mode === SIGNER_MODES.SAFE_FILE) {
					ctx.wait(
						`Import ${path.relative(PROJECT_ROOT, delivery.builderPath)} into Safe Transaction Builder, execute it, then continue this task`,
					);
				}
				if (delivery?.mode === SIGNER_MODES.SAFE_SERVICE) {
					ctx.wait(`Safe proposal ${delivery.safeTxHash} must execute before this task can continue`);
				}
				ctx.wait("Safe or governance actions must confirm externally; continue this task after confirmation");
			}
			requireZero(code, "Deployment");
		},
		{ phase: "execution" },
	);
	if (input.mode === "local") {
		await ctx.step(
			"local-handover",
			"Complete handover with the unlocked local governance account",
			async () => {
				if (!ctx.state.localHandoverRequired) return;
				const recipe = loadRecipeContext(input.config, { plan: false });
				await ctx.runProcess(
					"./node_modules/.bin/hardhat",
					["internal:complete-local-handover", "--recipe", input.config, "--network", input.network],
					{ env: recipeHardhatEnvironment(recipe) },
				);
				const code = await ctx.runCallable("deployment handover reconciliation", () => deploy({ ...args, yes: true, fresh: false }));
				requireZero(code, "Deployment handover reconciliation");
				ctx.state.localHandoverRequired = false;
			},
			{ phase: "handover" },
		);
	}
	await ctx.step("verification", "Verify bytecode and explorer records", async () => {}, { phase: "assurance" });
	await ctx.step(
		"health",
		"Run canonical deployment health audit",
		async () => {
			requireZero(await ctx.runCallable("deployment health", () => status(args)), "Deployment health audit");
		},
		{ phase: "assurance" },
	);
	await ctx.step("handover", "Prove ownership, roles and deployer privilege removal", async () => {}, { phase: "handover" });
	return { recipe: input.config, recipeDigest: input.recipeDigest, network: input.network };
}

function deployDefinition({ id, title, description, only, coreBundle = false }) {
	return common({
		id,
		category: "deploy",
		risk: "transaction",
		title,
		description,
		supportedNetworks: ["localhost", "fork-arbitrum", "arbitrum"],
		inputs: ["recipe", "network", "chainId", "scope", "keystore references"],
		artifacts: ["deployment recipe", "transaction journal", "receipts", "deployment report", "health report"],
		prepare: async context => {
			const input = await prepareDeploymentRecipe({ ...context, only, coreBundle });
			return input ? { ...input, fullSystem: !only && !coreBundle } : null;
		},
		postPrepare: async ({ ui }, input) => {
			if (input.mode !== "live") return input;
			const handling = await ui.select({
				message: "How should pending governance/Safe handover transactions be prepared?",
				options: [
					{
						value: SIGNER_MODES.SAFE_FILE,
						label: "Safe multisig — export JSON",
						hint: "recommended; import into Safe Transaction Builder",
					},
					{
						value: SIGNER_MODES.SAFE_SERVICE,
						label: "Safe multisig — create proposal",
						hint: "sign and submit through Safe Transaction Service",
					},
					{ value: "manual", label: "Record manual actions only", hint: "no Safe artifact or service call" },
				],
				initialValue: SIGNER_MODES.SAFE_FILE,
			});
			if (handling === null) return null;
			if (handling === "manual") return input;
			const recipe = loadRecipeContext(input.config, { only: input.only, plan: false });
			const governanceSigner = await selectSigner(ui, {
				role: "Governance transaction delivery",
				allowedModes: [handling],
				initialMode: handling,
				network: input.network,
				chainId: input.chainId,
				safeAddress: recipe.recipe.governance.admin,
			});
			return governanceSigner ? { ...input, governanceSigner } : null;
		},
		plan: (_context, input) => deploymentPlan(input, coreBundle ? "core" : only || "full"),
		run: executeDeployment,
		reconcile: deploymentReconcile,
		validateResume: validateDeploymentResume,
	});
}

const DEPLOY_TASKS = [
	deployDefinition({
		id: "deploy.full",
		title: "Full SYMMIO system",
		description: "Deploy Core, AccountLayer, InstantLayer, PartyB, SymbolManager, ExpressProvider and GaslessLayer with every safety gate.",
	}),
	deployDefinition({
		id: "deploy.core",
		title: "Core bundle",
		description: "Deploy the complete Core bundle while skipping optional add-ons.",
		coreBundle: true,
	}),
	deployDefinition({
		id: "deploy.party-b",
		title: "PartyB",
		description: "Deploy and bind PartyB to a completed Core deployment.",
		only: "partyB",
	}),
	deployDefinition({
		id: "deploy.symbol-manager",
		title: "SymbolManager",
		description: "Deploy and bind SymbolManager to a completed Core deployment.",
		only: "symbolManager",
	}),
	deployDefinition({
		id: "deploy.express-provider",
		title: "ExpressProvider",
		description: "Deploy and configure ExpressProvider against a completed Core deployment.",
		only: "expressProvider",
	}),
	deployDefinition({
		id: "deploy.gasless-layer",
		title: "GaslessLayer",
		description: "Deploy, configure and wire GaslessLayer against a completed Core deployment.",
		only: "gaslessLayer",
	}),
];

async function prepareSimpleDeployment({ ui }, kind) {
	const network = await ui.select({
		message: "Target network",
		options: [
			{ value: "localhost", label: "Local node" },
			{ value: "fork-arbitrum", label: "Arbitrum fork" },
			{ value: "fork-hyperevm", label: "HyperEVM fork" },
		],
		initialValue: "fork-arbitrum",
	});
	if (network === null) return null;
	const chain = resolveNetwork(network);
	const input = { network, chainId: chain.chainId, kind };
	if (kind !== "multicall") {
		input.symmio = await inputText(ui, "SYMMIO Core diamond", { address: true });
		if (input.symmio === null) return null;
		input.admin = await inputText(ui, "Admin address", { address: true });
		if (input.admin === null) return null;
	}
	if (kind === "feeDistributor") {
		input.receiver = await inputText(ui, "SYMMIO share receiver", { address: true });
		input.share = await inputText(ui, "SYMMIO share in fixed-point units", { placeholder: "0" });
		if (input.receiver === null || input.share === null) return null;
	}
	return input;
}

function simpleDeployDefinition(kind, title, taskName, extraArgs = input => []) {
	const extraInputs = kind === "feeDistributor" ? ["receiver", "share"] : [];
	return common({
		id: `deploy.${kind.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)}`,
		category: "deploy",
		risk: "transaction",
		title,
		description: `${title} deployment restricted to local and simulated fork networks until its live workflow meets the full safety contract.`,
		supportedNetworks: ["localhost", "fork-arbitrum", "fork-hyperevm"],
		inputs: ["network", ...(kind === "multicall" ? [] : ["symmio", "admin"]), ...extraInputs],
		artifacts: ["transaction journal", "deployment records"],
		prepare: context => prepareSimpleDeployment(context, kind),
		plan: () => [{ id: "deploy", phase: "execution", title: `Deploy ${title}` }],
		run: async (ctx, input) => {
			await ctx.step("deploy", `Deploy ${title}`, () =>
				ctx.runProcess("./node_modules/.bin/hardhat", [taskName, ...extraArgs(input), "--network", input.network]),
			);
		},
		reconcile: mutationReconcile,
	});
}

async function prepareLiquidator({ ui }) {
	const network = await ui.select({
		message: "Target network",
		options: [
			{ value: "localhost", label: "Persistent local Hardhat node", hint: "no secrets or HyperCore API calls" },
			{ value: "fork-hyperevm", label: "HyperEVM fork" },
			{ value: "hyperevm", label: "HyperEVM", hint: "live" },
		],
		initialValue: "localhost",
	});
	if (network === null) return null;
	const symmio = await inputText(ui, "SYMMIO Core diamond", { address: true });
	const admin = await inputText(ui, "Liquidator admin", { address: true });
	const operators = await ui.text({
		message: "Operator addresses, comma-separated",
		placeholder: "0x…,0x…",
		validate: value => {
			const values = value
				.split(",")
				.map(item => item.trim())
				.filter(Boolean);
			if (values.length === 0 || values.some(value => !isAddress(value) || /^0x0{40}$/i.test(value))) {
				return "Enter one or more non-zero EVM addresses separated by commas";
			}
		},
	});
	if ([symmio, admin, operators].some(value => value === null)) return null;
	return { network, chainId: resolveNetwork(network).chainId, symmio, admin, operators };
}

DEPLOY_TASKS.push(
	common({
		id: "deploy.symmio-liquidator",
		category: "deploy",
		risk: "transaction",
		title: "SymmioLiquidator",
		description: "Deploy the guarded liquidator proxy and wire Core roles, including HyperEVM big-block cleanup.",
		supportedNetworks: ["localhost", "hyperevm", "fork-hyperevm"],
		inputs: ["network", "symmio", "admin", "operators", "typed chain confirmation"],
		artifacts: ["transaction journal", "liquidator deployment record"],
		prepare: prepareLiquidator,
		postPrepare: async ({ ui }, input) =>
			input.network !== "hyperevm" || (await configureRequiredKeystoreKeys(ui, input.signer, ["RPC_HYPEREVM"])) ? input : null,
		plan: (_context, input) => [
			{ id: "compile", phase: "prepare", title: "Compile the exact production source" },
			{ id: "plan", phase: "prepare", title: "Validate and review liquidator plan" },
			...(input.network === "hyperevm"
				? [
						{ id: "fork-rehearsal", phase: "rehearsal", title: "Deploy and wire the liquidator on a matching HyperEVM fork" },
						{ id: "rehearsal-review", phase: "rehearsal", title: "Review fork receipts and role checks" },
						{ id: "network-confirmation", phase: "authorization", title: "Type the live HyperEVM chain ID" },
					]
				: []),
			{ id: "execute", phase: "execution", title: "Deploy, wire roles and restore big blocks" },
		],
		run: async (ctx, input) => {
			const env = {
				SYMMIO_ADDRESS: input.symmio,
				ADMIN_PUBLIC_KEY: input.admin,
				OPERATORS: input.operators,
			};
			await ctx.step("compile", "Compile the exact production source", () =>
				ctx.runProcess("./node_modules/.bin/hardhat", ["--build-profile", "production", "build"]),
			);
			await ctx.step("plan", "Validate and review liquidator plan", () =>
				ctx.runProcess("./node_modules/.bin/hardhat", ["run", "--no-compile", "scripts/deployLiquidator.ts", "--network", input.network], {
					env,
				}),
			);
			if (input.network === "hyperevm") {
				await ctx.step("fork-rehearsal", "Deploy and wire the liquidator on a matching HyperEVM fork", () =>
					ctx.runProcess(
						"./node_modules/.bin/hardhat",
						["run", "--no-compile", "scripts/deployLiquidator.ts", "--network", "fork-hyperevm"],
						{
							env: { ...env, EXECUTE: "true", CONFIRM_CHAIN_ID: String(input.chainId) },
						},
					),
				);
				await ctx.step("rehearsal-review", "Review fork receipts and role checks", async () => {
					if (
						!(await ctx.ui.confirm({
							message: "Fork deployment and role checks passed. Continue toward live execution?",
							initialValue: false,
						}))
					) {
						ctx.requestPause();
					}
					ctx.checkpoint();
				});
				await ctx.step("network-confirmation", "Type the live HyperEVM chain ID", async () => {
					const typed = await ctx.ui.text({
						message: `Type chain ID ${input.chainId} to authorize live execution`,
						validate: value => (value === String(input.chainId) ? undefined : `Type exactly ${input.chainId}`),
					});
					if (typed === null) ctx.requestPause();
					ctx.checkpoint();
				});
			}
			await ctx.step("execute", "Deploy, wire roles and restore big blocks", async () => {
				if (input.network !== "hyperevm") {
					const proceed = await ctx.ui.confirm({ message: "Run the local/fork liquidator deployment now?", initialValue: true });
					if (!proceed) ctx.requestPause();
					ctx.checkpoint();
				}
				await ctx.runProcess(
					"./node_modules/.bin/hardhat",
					["run", "--no-compile", "scripts/deployLiquidator.ts", "--network", input.network],
					{
						env: { ...env, EXECUTE: "true", CONFIRM_CHAIN_ID: String(input.chainId) },
					},
				);
			});
		},
		reconcile: mutationReconcile,
	}),
	simpleDeployDefinition("feeDistributor", "FeeDistributor", "deploy:feeDistributor", input => [
		"--symmio-address",
		input.symmio,
		"--admin",
		input.admin,
		"--symmio-share",
		input.share,
		"--symmio-share-receiver",
		input.receiver,
	]),
	simpleDeployDefinition("multiAccount", "MultiAccount", "deploy:multiAccount", input => [
		"--symmio-address",
		input.symmio,
		"--admin",
		input.admin,
	]),
	simpleDeployDefinition("multicall", "Multicall", "deploy:multicall"),
);

const PATCH_TASK = common({
	id: "patch.express-provider",
	category: "patch",
	risk: "transaction",
	title: "ExpressProvider reconciliation",
	description: "Reconcile declared ExpressProvider sections, including role revocations and Safe manual actions.",
	supportedNetworks: ["localhost", "fork-arbitrum", "arbitrum"],
	inputs: ["base deployment report", "authoritative sections", "patch recipe"],
	artifacts: ["patch recipe", "component report", "transaction journal", "Safe manual actions"],
	prepare: prepareExpressPatch,
	signerPolicy: input => ({
		role: "Patch transaction signer",
		allowedModes: input.mode === "live" ? [...EOA_SIGNER_MODES, ...SAFE_SIGNER_MODES] : EOA_SIGNER_MODES,
		initialMode: input.mode === "live" ? SIGNER_MODES.SAFE_FILE : EOA_SIGNER_MODES[0],
		safeAddress: loadRecipeContext(input.config, { only: "expressProvider", plan: false }).recipe.governance.admin,
		expectedAddress: loadRecipeContext(input.config, { only: "expressProvider", plan: false }).recipe.governance.admin,
	}),
	plan: (_context, input) => deploymentPlan(input, "expressProvider"),
	run: executeDeployment,
	reconcile: deploymentReconcile,
	validateResume: validateDeploymentResume,
});

export function checklistExplorerVerification(context, report) {
	if (context?.recipe?.network?.mode === "live") {
		return report?.checks?.verificationPolicy === "required" && report?.checks?.verification === "passed";
	}
	return report?.checks?.verificationPolicy === "not_applicable" && report?.checks?.verification === "skipped";
}

const CHECKLIST_ITEMS = [
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

const CHECKLIST_TASK = common({
	id: "checklist.full-deployment",
	category: "checklist",
	risk: "read-only",
	title: "Full deployment checklist",
	description: "Rebuild complete, current assurance evidence for a recipe-bound deployment.",
	inputs: ["deployment recipe", "deployment report"],
	artifacts: ["timestamped JSON checklist", "readable checklist summary"],
	prepare: context => prepareExistingRecipe(context, { fullOnly: true }),
	plan: () => CHECKLIST_ITEMS.map(([title], index) => ({ id: `check-${String(index + 1).padStart(2, "0")}`, phase: "checklist", title })),
	run: async (ctx, input, plan) => {
		const doctorCode = await ctx.runCallable("recipe preflight", () => doctor({ config: input.config, _: [] }));
		const statusCode = await ctx.runCallable("canonical deployment status", () => status({ config: input.config, _: [] }));
		const context = loadRecipeContext(input.config, { plan: false });
		const report = readDeploymentReport(input.chainId, { simulated: context.recipe.network.mode === "fork" });
		const evidence = { doctorCode, statusCode, report, context };
		const results = [];
		for (const [index, item] of plan.entries()) {
			const passed = await ctx.step(item.id, item.title, async () => Boolean(CHECKLIST_ITEMS[index][1](evidence)), {
				phase: item.phase,
			});
			results.push({ id: item.id, title: item.title, status: passed ? "passed" : "failed" });
		}
		const passed = results.every(result => result.status === "passed");
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const scope = `${input.chainId}${context.recipe.network.mode === "fork" ? "-fork" : ""}`;
		const directory = path.join(PROJECT_ROOT, "tasks", "data", scope, "checklists");
		const jsonPath = path.join(directory, `${stamp}.json`);
		const markdownPath = path.join(directory, `${stamp}.md`);
		atomicWrite(jsonPath, {
			apiVersion: "operations.symm.io/checklist-v1",
			createdAt: new Date().toISOString(),
			recipe: { path: context.identityPath, digest: context.digest },
			deployment: { id: report?.deploymentId, lifecycle: report?.lifecycle, reportDigest: report?.recipe?.digest },
			passed,
			results,
		});
		atomicWriteText(
			markdownPath,
			[
				`# SYMMIO deployment checklist`,
				"",
				`- Result: ${passed ? "PASSED" : "FAILED"}`,
				`- Recipe: ${context.identityPath}`,
				`- Recipe digest: ${context.digest}`,
				`- Deployment: ${report?.deploymentId || "missing"}`,
				"",
				...results.map(item => `- ${item.status === "passed" ? "[x]" : "[ ]"} ${item.title}`),
				"",
			].join("\n"),
		);
		if (!passed) throw new Error(`Deployment checklist failed; evidence was written to ${path.relative(PROJECT_ROOT, jsonPath)}`);
		return { jsonPath, markdownPath };
	},
});

function oneStepMaintenance(definition) {
	return common({
		category: "maintenance",
		inputs: [],
		artifacts: ["redacted raw log", "event journal"],
		plan: () => [{ id: "run", phase: "maintenance", title: definition.title }],
		...definition,
		run: async (ctx, input) => ctx.step("run", definition.title, () => definition.execute(ctx, input)),
	});
}

async function prepareNetwork({ ui }, options = ["arbitrum", "fork-arbitrum", "hyperevm", "fork-hyperevm", "localhost"]) {
	const network = await ui.select({ message: "Network", options: options.map(value => ({ value, label: value })) });
	return network === null ? null : { network, chainId: resolveNetwork(network).chainId };
}

async function prepareConfigOperation({ ui }, operation) {
	const networkInput = await prepareNetwork({ ui }, ["arbitrum", "hyperevm", "fork-arbitrum", "fork-hyperevm"]);
	if (!networkInput) return null;
	if (operation === "show") return networkInput;
	const symmio = await inputText(ui, "SYMMIO Core diamond", { address: true });
	const instantLayer = await inputText(ui, "InstantLayer address", { address: true });
	if (symmio === null || instantLayer === null) return null;
	const targetChain = await inputText(ui, operation === "diff" ? "Reviewed configuration chain ID" : "Output configuration chain ID", {
		placeholder: String(networkInput.chainId),
	});
	if (targetChain === null || !/^[1-9]\d*$/.test(targetChain)) return null;
	return { ...networkInput, symmio, instantLayer, targetChain: Number(targetChain), operation };
}

async function prepareHyperEvmSigner({ ui }, action) {
	const confirmed = await ui.confirm({
		message: `${action === "enable" ? "Enable" : "Disable"} big blocks for the configured HyperEVM signer?`,
		initialValue: action === "disable",
	});
	return confirmed ? { network: "hyperevm", chainId: 999 } : null;
}

function instantLayerDeploymentRecord(chainId) {
	const file = path.join(PROJECT_ROOT, "tasks", "data", String(chainId), "instantlayer.json");
	if (!fs.existsSync(file)) return null;
	try {
		const entries = JSON.parse(fs.readFileSync(file, "utf8"));
		const entry = Array.isArray(entries) ? entries.find(value => value?.name === "InstantLayer") : null;
		if (!entry || !isAddress(entry.address) || /^0x0{40}$/i.test(entry.address)) return null;
		return entry;
	} catch {
		return null;
	}
}

function instantLayerSetterAuthority(chainId) {
	try {
		const admin = readDeploymentReport(chainId)?.config?.admin;
		return isAddress(admin || "") && !/^0x0{40}$/i.test(admin) ? admin : undefined;
	} catch {
		return undefined;
	}
}

async function prepareSettlementTemplateRepair({ ui }) {
	const base = await prepareNetwork({ ui }, ["arbitrum", "fork-arbitrum", "localhost"]);
	if (!base) return null;
	const record = instantLayerDeploymentRecord(base.chainId);
	const instantLayer = await inputText(ui, "InstantLayer address", {
		address: true,
		initialValue: record?.address,
	});
	if (instantLayer === null) return null;
	const deactivateOriginals = await ui.confirm({
		message: "Deactivate the four original templates after exact offset-448 replacements are available?",
		initialValue: true,
	});
	if (deactivateOriginals === null) return null;
	return {
		...base,
		instantLayer,
		symmio: record?.constructorArguments?.[0],
		deactivateOriginals,
	};
}

function validateSettlementRepairPlan(plan, input) {
	if (plan?.apiVersion !== "operations.symm.io/instant-layer-settlement-template-recreation-v2") {
		throw new Error("Settlement-template script returned an unsupported plan artifact");
	}
	if (Number(plan.chainId) !== input.chainId) throw new Error(`Repair plan chain ${plan.chainId} does not match ${input.chainId}`);
	if (String(plan.instantLayer).toLowerCase() !== input.instantLayer.toLowerCase()) {
		throw new Error(`Repair plan target ${plan.instantLayer} does not match ${input.instantLayer}`);
	}
	if (plan.quoteIdOffset !== "448" || plan.currentPriceOffset !== "480") {
		throw new Error("Recreation plan must preserve quoteId at 448 and leave currentPrice at 480 untouched");
	}
	if (!Array.isArray(plan.actions)) throw new Error("Repair plan actions are missing");
	return plan;
}

async function writeSettlementRepairPlan(ctx, input, label) {
	const file = path.join(path.dirname(ctx.state.eventPath), `${label}.json`);
	await ctx.runProcess(
		"./node_modules/.bin/hardhat",
		["run", "--no-compile", "scripts/recreateInstantLayerSettlementTemplates.ts", "--network", input.network],
		{
			env: {
				INSTANT_LAYER_ADDRESS: input.instantLayer,
				...(input.symmio ? { SYMMIO_ADDRESS: input.symmio } : {}),
				DEACTIVATE_ORIGINAL_TEMPLATES: String(input.deactivateOriginals),
				REPAIR_PLAN_OUTPUT: file,
				EXECUTE: "false",
				CONFIRM_CHAIN_ID: "",
			},
		},
	);
	return { file, plan: validateSettlementRepairPlan(JSON.parse(fs.readFileSync(file, "utf8")), input) };
}

const SETTLEMENT_TEMPLATE_REPAIR_TASK = common({
	id: "maintenance.recreate-settlement-templates",
	version: 3,
	category: "maintenance",
	risk: "transaction",
	title: "Recreate settleUpnl InstantLayer templates",
	description: "Recreate exact offset-448 copies of all four settleUpnl templates, then retire the original template IDs.",
	supportedNetworks: ["localhost", "fork-arbitrum", "arbitrum"],
	inputs: ["network", "InstantLayer address", "original-template deactivation", "signer"],
	artifacts: ["reviewed action plan", "transaction journal", "Safe batch when selected", "post-state verification"],
	prepare: prepareSettlementTemplateRepair,
	signerPolicy: input => {
		const configuredAdmin = instantLayerSetterAuthority(input.chainId);
		return {
			role: "InstantLayer SETTER_ROLE authority",
			allowedModes: input.network === "arbitrum" ? [...EOA_SIGNER_MODES, ...SAFE_SIGNER_MODES] : EOA_SIGNER_MODES,
			initialMode: input.network === "arbitrum" ? SIGNER_MODES.SAFE_FILE : EOA_SIGNER_MODES[0],
			...(isAddress(configuredAdmin || "") ? { safeAddress: configuredAdmin, expectedAddress: configuredAdmin } : {}),
		};
	},
	plan: () => [
		{ id: "inspect", phase: "prepare", title: "Inspect live settlement templates and build exact actions" },
		{ id: "authorize", phase: "authorization", title: "Review and authorize exact offset-448 recreation" },
		{ id: "apply", phase: "execution", title: "Add exact replacements before deactivating originals" },
		{ id: "verify", phase: "verification", title: "Prove exact replacements active and originals inactive" },
	],
	run: async (ctx, input) => {
		await ctx.step("inspect", "Inspect live settlement templates and build exact actions", async () => {
			const result = await writeSettlementRepairPlan(ctx, input, "settlement-template-plan");
			ctx.state.settlementTemplatePlan = { path: result.file, actionCount: result.plan.actions.length, recreated: result.plan.recreated };
			ctx.ui.note(
				result.plan.actions.length === 0
					? "No actions are required; exact settlement-template replacements are already active."
					: result.plan.actions.map((action, index) => `${index + 1}. ${action.description}`).join("\n"),
				"Reviewed settlement-template actions",
			);
		});
		await ctx.step("authorize", "Review and authorize exact offset-448 recreation", async () => {
			if (ctx.state.settlementTemplatePlan?.actionCount === 0) return;
			if (input.network === "arbitrum") {
				const typed = await ctx.ui.text({
					message: `Type chain ID ${input.chainId} to authorize the live InstantLayer repair`,
					validate: value => (value === String(input.chainId) ? undefined : `Type exactly ${input.chainId}`),
				});
				if (typed === null) ctx.requestPause();
			} else {
				const confirmed = await ctx.ui.confirm({
					message: "Apply the reviewed template repair on this local/fork network?",
					initialValue: true,
				});
				if (!confirmed) ctx.requestPause();
			}
			ctx.checkpoint();
		});
		await ctx.step("apply", "Add exact replacements before deactivating originals", async () => {
			if (ctx.state.settlementTemplatePlan?.actionCount === 0) {
				ctx.ui.note(
					"Post-state already matches the reviewed recreation policy; no transaction subprocess was started.",
					"No writes required",
				);
				return;
			}
			if (SAFE_SIGNER_MODES.includes(input.signer.mode)) {
				const current = await writeSettlementRepairPlan(ctx, input, "settlement-template-before-safe");
				if (current.plan.actions.length === 0) return;
				await dispatchSafeActions(ctx, input.signer, current.plan.actions, {
					chainId: input.chainId,
					network: input.network,
					name: "Recreate InstantLayer settleUpnl templates",
					description: "Add exact offset-448 replacements first, then deactivate the four original template IDs.",
				});
				ctx.wait("Execute the exported/proposed Safe batch, then continue this task to verify the live template registry.");
			}
			await ctx.runProcess(
				"./node_modules/.bin/hardhat",
				["run", "--no-compile", "scripts/recreateInstantLayerSettlementTemplates.ts", "--network", input.network],
				{
					env: {
						INSTANT_LAYER_ADDRESS: input.instantLayer,
						...(input.symmio ? { SYMMIO_ADDRESS: input.symmio } : {}),
						DEACTIVATE_ORIGINAL_TEMPLATES: String(input.deactivateOriginals),
						EXECUTE: "true",
						CONFIRM_CHAIN_ID: String(input.chainId),
					},
				},
			);
		});
		await ctx.step("verify", "Prove exact replacements active and originals inactive", async () => {
			const result = await writeSettlementRepairPlan(ctx, input, "settlement-template-verification");
			if (!result.plan.recreated || result.plan.actions.length !== 0) {
				throw new Error(`Settlement-template verification still requires ${result.plan.actions.length} action(s)`);
			}
		});
	},
	reconcile: mutationReconcile,
});

const MAINTENANCE_TASKS = [
	SETTLEMENT_TEMPLATE_REPAIR_TASK,
	...["show", "diff", "export"].map(operation =>
		oneStepMaintenance({
			id: `maintenance.config-${operation}`,
			version: 1,
			risk: operation === "export" ? "local-write" : "read-only",
			title: `Protocol configuration ${operation}`,
			description: `${operation[0].toUpperCase()}${operation.slice(1)} protocol parameters and ordered InstantLayer templates.`,
			inputs: operation === "show" ? ["network"] : ["network", "symmio", "instantLayer", "chainId"],
			prepare: context => prepareConfigOperation(context, operation),
			execute: (ctx, input) =>
				ctx
					.runCallable(`configuration ${operation}`, () =>
						runConfig({
							_: ["config", operation],
							network: input.network,
							chain: input.chainId,
							symmio: input.symmio,
							"instant-layer": input.instantLayer,
							against: input.targetChain,
							to: input.targetChain,
						}),
					)
					.then(code => requireZero(code, `Configuration ${operation}`)),
			reconcile: mutationReconcile,
		}),
	),
	oneStepMaintenance({
		id: "maintenance.verify-diamond-facets",
		version: 1,
		risk: "read-only",
		title: "Diamond facet verification",
		description: "Enumerate and verify every unique facet behind a diamond.",
		inputs: ["network", "diamond address"],
		prepare: async ({ ui }) => {
			const base = await prepareNetwork({ ui }, ["arbitrum", "hyperevm"]);
			if (!base) return null;
			const diamond = await inputText(ui, "Diamond address", { address: true });
			return diamond === null ? null : { ...base, diamond };
		},
		execute: (ctx, input) =>
			ctx.runProcess("./node_modules/.bin/hardhat", ["run", "scripts/verify-diamond-facets.ts", "--network", input.network], {
				env: { DIAMOND_ADDRESS: input.diamond },
			}),
	}),
	oneStepMaintenance({
		id: "maintenance.verify-retry",
		version: 1,
		risk: "local-write",
		title: "Explorer verification retry",
		description: "Retry failed explorer verification entries bound to a reviewed recipe and report.",
		inputs: ["deployment recipe"],
		prepare: prepareExistingRecipe,
		execute: (ctx, input) =>
			ctx
				.runCallable("explorer verification retry", () => verify({ config: input.config, "retry-failed": true, _: [] }))
				.then(code => requireZero(code, "Explorer verification")),
		reconcile: mutationReconcile,
	}),
	...["enable", "disable"].map(action =>
		oneStepMaintenance({
			id: `maintenance.hyperevm-big-blocks-${action}`,
			version: 1,
			risk: "transaction",
			title: `HyperEVM big-block ${action}`,
			description: `${action === "enable" ? "Enable" : "Disable"} the signer big-block preference through the HyperCore API.`,
			supportedNetworks: ["hyperevm"],
			inputs: ["network", "signer", "confirmation"],
			prepare: context => prepareHyperEvmSigner(context, action),
			postPrepare: async ({ ui }, input) => ((await configureRequiredKeystoreKeys(ui, input.signer, ["RPC_HYPEREVM"])) ? input : null),
			execute: (ctx, input) => ctx.runProcess("./node_modules/.bin/hardhat", [`hyperevm:${action}-big-blocks`, "--network", input.network]),
			reconcile: mutationReconcile,
		}),
	),
	oneStepMaintenance({
		id: "maintenance.proxy-upgrade-rehearsal",
		version: 1,
		risk: "transaction",
		title: "Local/fork proxy-upgrade rehearsal",
		description: "Plan and execute a proxy upgrade only on a local or simulated fork network.",
		supportedNetworks: ["localhost", "fork-arbitrum", "fork-hyperevm"],
		inputs: ["network", "proxy", "contract"],
		prepare: async ({ ui }) => {
			const base = await prepareNetwork({ ui }, ["fork-arbitrum", "fork-hyperevm", "localhost"]);
			if (!base) return null;
			const proxy = await inputText(ui, "Proxy address", { address: true });
			const contract = await inputText(ui, "New implementation contract name", { placeholder: "MultiAccount" });
			return proxy === null || contract === null ? null : { ...base, proxy, contract };
		},
		execute: (ctx, input) =>
			ctx.runProcess(
				"./node_modules/.bin/hardhat",
				[
					"upgrade:proxy",
					"--proxy",
					input.proxy,
					"--contract",
					input.contract,
					"--execute=true",
					"--dryrun=false",
					"--network",
					input.network,
				],
				{ env: { CONFIRM_CHAIN_ID: String(input.chainId) } },
			),
		reconcile: mutationReconcile,
	}),
];

export const TASK_DEFINITIONS = Object.freeze([...DEPLOY_TASKS, PATCH_TASK, CHECKLIST_TASK, ...MAINTENANCE_TASKS]);
