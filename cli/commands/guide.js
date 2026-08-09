// Interactive mode: work out where this checkout stands and offer the next useful step.
//
// The wizard never performs a deployment itself. Every action it offers dispatches to the same
// command an operator would type, so preflight gates, risk-proportional confirmation, checkpoint
// binding and exit-code semantics are identical either way. It shows the equivalent command
// before running it, so using it teaches the CLI instead of hiding it.
import { readCheckpoint, readDeploymentReport, resolveNetwork } from "../lib/context.js";
import { PROJECT_ROOT, projectPath } from "../lib/paths.js";
import { banner, blank, c, clear, createPrompter, eyebrow, log, SYM, title } from "../lib/ui.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEPLOYMENTS_DIR = projectPath("deployments");
const GUIDE_DOC = "docs/deployment-guide.html";

function relative(file) {
	const rel = path.relative(PROJECT_ROOT, file);
	return rel.startsWith("..") ? file : rel;
}

/** Never let a malformed or half-written recipe crash the wizard; report it as a state instead. */
export function describeRecipe(file) {
	const entry = { path: file, label: relative(file), valid: false, placeholders: [], components: {} };
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		entry.error = `cannot read: ${error.message}`;
		return entry;
	}
	entry.placeholders = [...raw.matchAll(/"(REPLACE_WITH_[A-Z_]*)"/g)].map(match => match[1]);
	let recipe;
	try {
		recipe = JSON.parse(raw);
	} catch (error) {
		entry.error = `not valid JSON: ${error.message}`;
		return entry;
	}
	entry.valid = true;
	entry.name = recipe.name;
	entry.network = recipe.network?.name;
	entry.chainId = Number(recipe.network?.chainId);
	entry.mode = recipe.network?.mode;
	entry.simulated = recipe.network?.mode === "fork";
	for (const component of ["core", "partyB", "symbolManager", "expressProvider"]) {
		entry.components[component] = recipe[component]?.mode;
	}
	entry.isAddon = recipe.core?.mode === "reuse";
	entry.addon = ["partyB", "symbolManager", "expressProvider"].find(name => entry.components[name] === "deploy" && entry.isAddon);
	// An express patch recipe (reuse + address + declared sections) is also addressed with
	// --only expressProvider; it reconciles the deployed provider instead of creating one.
	if (!entry.addon && entry.isAddon && recipe.expressProvider?.mode === "reuse" && recipe.expressProvider?.address) {
		entry.addon = "expressProvider";
	}
	return entry;
}

export function listRecipes() {
	if (!fs.existsSync(DEPLOYMENTS_DIR)) return [];
	return fs
		.readdirSync(DEPLOYMENTS_DIR)
		.filter(name => name.endsWith(".json"))
		.sort()
		.map(name => describeRecipe(path.join(DEPLOYMENTS_DIR, name)));
}

function readState(recipe) {
	if (!recipe?.valid || !Number.isFinite(recipe.chainId)) return { report: null, checkpoint: null };
	const options = { simulated: recipe.simulated };
	let report = null;
	let checkpoint = null;
	try {
		report = readDeploymentReport(recipe.chainId, options);
	} catch {}
	try {
		checkpoint = readCheckpoint(recipe.chainId, options);
	} catch {}
	return { report, checkpoint };
}

/** Plain-English gloss for network mode. "live" vs "fork" is the difference that costs money. */
function describeMode(recipe) {
	if (recipe.mode === "live") return c.yellow("real chain, real funds");
	if (recipe.mode === "fork") return c.grey("practice run on a copy of the real chain — nothing real is spent");
	return c.grey("local test chain");
}

/** Component names are internal. Say what each one actually is. */
const COMPONENT_LABELS = {
	core: "the protocol itself (Core + AccountLayer + InstantLayer)",
	partyB: "PartyB (solver/hedger contract)",
	symbolManager: "SymbolManager (adds and removes tradable symbols)",
	expressProvider: "ExpressProvider (fast withdrawals)",
};

function summarize(recipe, state) {
	title("Where this deployment stands");
	if (!recipe.valid) {
		log(`  ${c.red(SYM.fail)} ${recipe.label} could not be read: ${recipe.error}`);
		return;
	}
	const row = (label, value) => log(`  ${label.padEnd(15)}${value}`);

	row("Settings file", c.cyan(recipe.label));
	log(`  ${" ".repeat(15)}${c.grey("one file describes the whole deployment; every command reads it")}`);
	row("Blockchain", `${c.bold(recipe.network)}  ${describeMode(recipe)}`);

	const enabled = Object.entries(recipe.components)
		.filter(([, mode]) => mode === "deploy")
		.map(([name]) => name);
	if (enabled.length === 0) {
		row("Will install", c.grey("nothing selected"));
	} else {
		row("Will install", enabled.join(", "));
		for (const name of enabled) log(`  ${" ".repeat(15)}${c.grey(`· ${COMPONENT_LABELS[name] ?? name}`)}`);
	}

	if (recipe.placeholders.length > 0) {
		row("Ready?", `${c.yellow("no")} — ${recipe.placeholders.length} value${recipe.placeholders.length === 1 ? "" : "s"} still need filling in`);
	} else {
		row("Ready?", `${c.green("yes")} — every value is filled in`);
	}

	if (state.checkpoint) {
		row("In progress", `${c.yellow("a deployment was interrupted")} ${c.grey(`(stopped at: ${state.checkpoint.step || "unknown"})`)}`);
	}
	if (state.report) {
		const lifecycle = state.report.lifecycle;
		const wording =
			lifecycle === "complete"
				? c.green("finished and handed over")
				: lifecycle === "failed"
					? c.red("failed")
					: c.yellow("deployed, but the handover is not finished");
		row("On chain", wording);
		const pending = state.report.manualActions?.length || 0;
		if (pending > 0) {
			row("Waiting on you", `${c.yellow(`${pending} action${pending === 1 ? "" : "s"}`)} ${c.grey("your admin wallet needs to run")}`);
		}
	} else if (!state.checkpoint) {
		row("On chain", c.grey("nothing deployed to this blockchain yet"));
	}
}

function openInEditor(file) {
	const editor = process.env.VISUAL || process.env.EDITOR;
	if (!editor) {
		log(`  ${c.grey("No $EDITOR set. Open this file in your editor:")}`);
		log(`    ${c.cyan(relative(file))}`);
		return;
	}
	spawnSync(editor, [file], { stdio: "inherit", cwd: PROJECT_ROOT });
}

/** Announce the equivalent command, then run the real one. */
async function dispatch(commandName, args, display) {
	blank();
	log(`  ${c.grey("running")} ${c.cyan(display)}`);
	blank();
	const { COMMANDS } = await import("../symmio.js");
	const run = await COMMANDS[commandName].load();
	return (await run({ _: [commandName], ...args })) ?? 0;
}

export function actionsFor(recipe, state) {
	const actions = [];
	const config = recipe.label;
	const only = recipe.addon;
	const onlyArgs = only ? { only } : {};
	const onlyFlag = only ? ` --only ${only}` : "";

	// Ordered by what is most likely to matter right now. An in-progress checkpoint outranks
	// everything: money may already be committed on chain.
	if (!recipe.valid) {
		actions.push({
			label: "Open the settings file and fix it",
			detail: recipe.error,
			value: { kind: "edit" },
		});
		return actions;
	}

	if (recipe.placeholders.length > 0) {
		const unique = [...new Set(recipe.placeholders)];
		actions.push({
			label: `Fill in the ${recipe.placeholders.length} missing value${recipe.placeholders.length === 1 ? "" : "s"}`,
			detail: `opens ${recipe.label} in your editor — still needed: ${unique.slice(0, 2).join(", ")}${unique.length > 2 ? `, +${unique.length - 2} more` : ""}`,
			value: { kind: "edit" },
		});
	}

	if (state.checkpoint && state.checkpoint.step !== "complete") {
		actions.push({
			label: "Continue the interrupted deployment",
			detail: "Picks up where it stopped — contracts already deployed are reused, never deployed twice",
			value: { kind: "run", command: "deploy", args: { config, ...onlyArgs }, display: `./symmio deploy --config ${config}${onlyFlag}` },
		});
	}

	if (state.report?.manualActions?.length > 0) {
		actions.push({
			label: `Show the ${state.report.manualActions.length} action${state.report.manualActions.length === 1 ? "" : "s"} waiting on your admin wallet`,
			detail: "Ready-to-paste transactions to finish the handover",
			value: { kind: "handover" },
		});
	}

	if (state.report && state.report.lifecycle !== "complete") {
		actions.push({
			label: "Check those actions are done and finish up",
			detail: "Re-reads the blockchain and completes the deployment once the handover has gone through",
			value: { kind: "run", command: "deploy", args: { config, ...onlyArgs }, display: `./symmio deploy --config ${config}${onlyFlag}` },
		});
	}

	if (recipe.placeholders.length === 0 && !state.checkpoint && !state.report) {
		actions.push({
			label: "Check everything is correct before deploying",
			detail: "Read-only. Points at the exact setting if anything is wrong. Costs nothing",
			value: { kind: "run", command: "doctor", args: { config, ...onlyArgs }, display: `./symmio doctor --config ${config}${onlyFlag}` },
		});
		actions.push({
			label: "Show exactly what would be deployed",
			detail: "Read-only preview. Sends no transactions",
			value: {
				kind: "run",
				command: "deploy",
				args: { config, plan: true, ...onlyArgs },
				display: `./symmio deploy --config ${config}${onlyFlag} --plan`,
			},
		});
		actions.push({
			label: recipe.mode === "live" ? "Deploy to the real blockchain" : "Deploy (practice run)",
			detail:
				recipe.mode === "live"
					? "Spends real funds. You will be asked to confirm before anything is sent"
					: "Nothing real is spent — this is a rehearsal",
			value: { kind: "run", command: "deploy", args: { config, ...onlyArgs }, display: `./symmio deploy --config ${config}${onlyFlag}` },
		});
	} else if (recipe.placeholders.length === 0) {
		actions.push({
			label: "Check everything is still correct",
			detail: "Read-only re-check of the settings and the blockchain",
			value: { kind: "run", command: "doctor", args: { config, ...onlyArgs }, display: `./symmio doctor --config ${config}${onlyFlag}` },
		});
	}

	if (state.report) {
		actions.push({
			label: "Look at what is deployed on the blockchain",
			detail: "Reads the live contracts and confirms they match what was deployed",
			value: { kind: "run", command: "status", args: { config, ...onlyArgs }, display: `./symmio status --config ${config}${onlyFlag}` },
		});
		actions.push({
			label: "Re-try publishing the source code to the explorer",
			detail: "Only retries contracts whose Arbiscan verification failed",
			value: {
				kind: "run",
				command: "verify",
				args: { config, "retry-failed": true },
				display: `./symmio verify --config ${config} --retry-failed`,
			},
		});
	}

	if (Number.isFinite(recipe.chainId)) {
		actions.push({
			label: "Show this chain's protocol settings",
			detail: "Cooldowns, limits and fees — nothing to do with deploying",
			value: {
				kind: "run",
				command: "config",
				args: { _: ["config", "show"], chain: String(recipe.chainId) },
				display: `./symmio config show --chain ${recipe.chainId}`,
			},
		});
	}

	actions.push({
		label: "Set up another deployment",
		detail: "A different blockchain, or just one add-on onto an existing deployment",
		value: { kind: "init" },
	});
	actions.push({ label: "Work on a different deployment", detail: "Switch to another settings file", value: { kind: "switch" } });
	actions.push({ label: "Read the deployment guide", detail: GUIDE_DOC, value: { kind: "docs" } });
	return actions;
}

async function chooseRecipe(prompt, recipes) {
	if (recipes.length === 1) return recipes[0];
	const choice = await prompt.select(
		"Which deployment do you want to work on?",
		recipes.map(entry => ({
			label: entry.label,
			detail: entry.valid ? `${entry.network} — ${describeMode(entry)}` : entry.error,
			value: entry,
		})),
	);
	return choice;
}

async function runInit(prompt) {
	const network = await prompt.ask("Which blockchain? (arbitrum for real, fork-arbitrum to practise)", "arbitrum");
	if (!network) return 0;
	// "full" rather than null, because select() returns null to mean the operator quit.
	const scope = await prompt.select("What do you want to install?", [
		{ label: "Everything", detail: "The whole protocol plus all the add-ons", value: "full" },
		{ label: "Just PartyB", detail: "Adds a solver contract to a protocol that is already deployed", value: "partyB" },
		{ label: "Just SymbolManager", detail: "Adds symbol management to a protocol that is already deployed", value: "symbolManager" },
		{ label: "Just ExpressProvider", detail: "Adds fast withdrawals to a protocol that is already deployed", value: "expressProvider" },
	]);
	if (scope === null) return 0;
	const only = scope === "full" ? null : scope;
	const display = `./symmio recipe init --network ${network}${only ? ` --only ${only}` : ""}`;
	return dispatch("recipe", { _: ["recipe", "init"], network, ...(only ? { only } : {}) }, display);
}

function showHandover(report) {
	screen("handover");
	title("Waiting on your admin wallet");
	log(`  ${c.grey("Run these from the admin wallet, then come back and choose “Check those actions are done”.")}`);
	for (const [index, action] of report.manualActions.entries()) {
		blank();
		log(`  ${c.bold(`${index + 1}. ${action.description ?? action}`)}`);
		if (action.to) {
			log(`     ${c.grey("to    ")} ${action.to}`);
			log(`     ${c.grey("value ")} ${action.value}`);
			log(`     ${c.grey("data  ")} ${action.data}`);
		}
	}
	blank();
}

export async function guide() {
	clear();
	banner("SYMMIO", "deploy and operate the protocol by answering questions");
	log(`  ${c.grey("enter picks the recommended option  ·  ? explains a question  ·  q quits")}`);

	const prompt = createPrompter();
	if (!prompt) {
		log(`  ${c.grey("Not a terminal, so there is nothing to prompt. Start here:")}`);
		blank();
		log(`    ${c.cyan("./symmio recipe init --network arbitrum")}`);
		log(`    ${c.cyan("./symmio doctor --config deployments/arbitrum.json")}`);
		log(`    ${c.cyan("./symmio deploy --config deployments/arbitrum.json")}`);
		blank();
		return 0;
	}
	try {
		return await session(prompt);
	} catch (error) {
		// A failing command should end this step, not tear the whole wizard down without
		// telling the operator how to get back in.
		blank();
		log(`  ${c.red(SYM.fail)} ${error.message || String(error)}`);
		log(`  ${c.grey("Nothing further was attempted. Fix that, then run")} ${c.cyan("./symmio")} ${c.grey("again.")}`);
		blank();
		return 1;
	} finally {
		// Leaving an open interface behind keeps the process alive after the wizard returns.
		prompt.close();
	}
}

function goodbye(code) {
	blank();
	log(`  ${c.grey("Done. Re-run")} ${c.cyan("./symmio")} ${c.grey("any time to pick up where you left off.")}`);
	blank();
	return code;
}

/** Plain-English purpose for each value the operator has to supply. */
const FIELD_HELP = {
	REPLACE_WITH_ADMIN_ADDRESS: "your admin multisig — it ends up owning the protocol",
	REPLACE_WITH_FEE_RECEIVER_ADDRESS: "wallet that collects protocol fees",
	REPLACE_WITH_LIQUIDATION_INSURANCE_VAULT_ADDRESS: "wallet that receives surplus from liquidations",
	REPLACE_WITH_SOFT_LIQUIDATION_PENALTY_COLLECTOR_ADDRESS: "wallet that collects soft-liquidation penalties",
	REPLACE_WITH_COLLATERAL_ADDRESS: "the token traders deposit (USDC on Arbitrum: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831)",
	REPLACE_WITH_MUON_APP_ID: "your Muon oracle app id",
	REPLACE_WITH_MUON_PUBLIC_KEY_X: "Muon signing key — a plain decimal number, NOT 0x hex",
	REPLACE_WITH_MUON_GATEWAY_SIGNER_ADDRESS: "address of your Muon gateway signer",
	REPLACE_WITH_PARTY_B_SIGNER_ADDRESS: "wallet your solver signs with",
	REPLACE_WITH_SYMBOL_MANAGER_OPERATOR_ADDRESS: "wallet allowed to add and remove tradable symbols",
	REPLACE_WITH_EXPRESS_MUON_APP_ID: "Muon app id for the fast-withdrawal credit checks",
	REPLACE_WITH_EXPRESS_OPERATOR_ADDRESS: "the bot wallet that processes fast withdrawals",
	REPLACE_WITH_EXPRESS_SIGNER_ADDRESS: "wallet that signs fast-withdrawal offers",
	REPLACE_WITH_EXPRESS_AFFILIATE_ADDRESS: "the affiliate whose pool funds fast withdrawals",
	REPLACE_WITH_EXPRESS_MAX_DEBT_IN_COLLATERAL_DECIMALS: "most that can be advanced, in token units (1M USDC = 1000000000000). 0 means unlimited",
};

const NETWORK_CHOICES = [
	{ label: "arbitrum", detail: "the real Arbitrum chain — spends real funds", value: "arbitrum" },
	{ label: "fork-arbitrum", detail: "a practice copy of Arbitrum — nothing real is spent, ideal for a first run", value: "fork-arbitrum" },
];

/** Keystore entry names for this network's secrets, e.g. RPC_ARBITRUM for fork-arbitrum too. */
function rpcKeyFor(network) {
	return `RPC_${String(network || "")
		.replace(/^fork-/, "")
		.toUpperCase()}`;
}

/** Tell the operator exactly what is still missing, then wait for them to say they are done. */
async function ensureFilled(prompt, recipePath) {
	for (;;) {
		const recipe = describeRecipe(recipePath);
		// Each pass starts on a clean screen and re-renders the complete current state, so the
		// operator always sees exactly what is still missing — never a stale list.
		screen(`deploy · ${recipe.valid ? recipe.network : recipe.label}`);
		eyebrow("step 3 of 4 · your addresses and keys");
		if (!recipe.valid) {
			blank();
			log(`  ${c.red(SYM.fail)} ${recipe.label} is not valid JSON yet: ${recipe.error}`);
		} else if (recipe.placeholders.length === 0) {
			blank();
			log(`  ${c.green(SYM.ok)} Every value is filled in.`);
			return true;
		} else {
			const unique = [...new Set(recipe.placeholders)];
			blank();
			log(`  ${c.bold(`Open ${c.cyan(recipe.label)} and replace these ${unique.length} value${unique.length === 1 ? "" : "s"}:`)}`);
			blank();
			for (const name of unique) {
				log(`    ${c.yellow(name)}`);
				const help = FIELD_HELP[name];
				if (help) log(`      ${c.grey(help)}`);
			}
			blank();
			log(`  ${c.grey("Secrets — your deployer key, RPC URL and explorer key — never go in this file.")}`);
			log(`  ${c.grey("Store them once in the encrypted keystore (it prompts for each value):")}`);
			log(`    ${c.cyan("./node_modules/.bin/hardhat keystore set NEW_DEPLOYER")}`);
			log(`    ${c.cyan(`./node_modules/.bin/hardhat keystore set ${rpcKeyFor(recipe.network)}`)}`);
			log(`    ${c.cyan("./node_modules/.bin/hardhat keystore set ETHERSCAN_APIKEY")}`);
		}

		const next = await prompt.select(
			"Ready?",
			[
				{ label: "I've filled it in — check it", value: "check" },
				{ label: "Open it in my editor now", value: "edit" },
				{ label: "Stop here, I'll come back later", detail: "Re-run ./symmio and it picks up from here", value: "stop" },
			],
			{
				help: [
					`The file is plain JSON — open ${relative(recipePath)} in any editor.`,
					"Every REPLACE_WITH_… string must become a real value. When you say you're",
					"done, the wizard re-reads the file and lists anything still missing, so",
					"nothing slips through. The secret values live in the keystore, not the file.",
				],
			},
		);
		if (next === null || next === "stop") return false;
		if (next === "edit") openInEditor(recipePath);
	}
}

const COMPONENT_HELP = [
	"Core is the exchange itself. The add-ons plug into a deployed core, so core",
	"is required unless this checkout has a completed deployment record for the",
	"chosen chain — then you can untick it and install a single add-on on its own.",
	"PartyB is the contract your market-making bot trades through.",
	"SymbolManager lets an operator list and delist trading pairs.",
	"ExpressProvider lets users withdraw in seconds instead of 12 hours by",
	"advancing funds against a credit line. It moves real money — most teams",
	"add it later, once the basics are running.",
	"Anything you skip now can be added later.",
];

const RECIPE_EXAMPLE_PATH = projectPath("deployment", "examples", "arbitrum.v1.example.json");

/**
 * Write the operator's part picks into the settings file. Re-enabling a part that was
 * skipped restores its section from the reviewed example, placeholders and all — the
 * fill-in step then asks for exactly the values that section needs.
 */
function setComponentModes(recipePath, selected) {
	const raw = JSON.parse(fs.readFileSync(recipePath, "utf8"));
	const example = JSON.parse(fs.readFileSync(RECIPE_EXAMPLE_PATH, "utf8"));
	for (const name of ["partyB", "symbolManager", "expressProvider"]) {
		const wanted = selected.includes(name);
		const enabled = raw[name]?.mode === "deploy";
		if (wanted && !enabled) raw[name] = example[name];
		if (!wanted && enabled) raw[name] = name === "partyB" ? { mode: "skip", adlEnabled: false } : { mode: "skip" };
	}
	fs.writeFileSync(recipePath, `${JSON.stringify(raw, null, 2)}\n`);
}

/**
 * Compact card describing an existing settings file: what it installs, how far along it is,
 * and what is on chain — so choosing between "continue" and "fresh" is an informed choice.
 */
function previewCard(entry) {
	log(`  ${c.cyan(entry.label)}`);
	if (!entry.valid) {
		log(`    ${c.red(SYM.fail)} ${entry.error}`);
		return;
	}
	const parts = Object.entries(entry.components)
		.filter(([, mode]) => mode === "deploy")
		.map(([name]) => name);
	log(`    ${c.grey("installs ")}  ${parts.join(", ") || c.grey("nothing selected")}`);
	log(
		`    ${c.grey("filled in")}  ${entry.placeholders.length > 0 ? c.yellow(`${entry.placeholders.length} value${entry.placeholders.length === 1 ? "" : "s"} still missing`) : c.green("complete")}`,
	);
	const state = readState(entry);
	if (state.checkpoint) {
		log(`    ${c.grey("on chain ")}  ${c.yellow("a deployment is mid-flight")}`);
	} else if (state.report) {
		const wording =
			state.report.lifecycle === "complete"
				? c.green("deployed and finished")
				: state.report.lifecycle === "failed"
					? c.red("last run failed")
					: c.yellow("deployed, handover unfinished");
		log(`    ${c.grey("on chain ")}  ${wording}`);
	} else {
		log(`    ${c.grey("on chain ")}  ${c.grey("nothing yet")}`);
	}
	blank();
}

/** Copy a settings file aside before it is replaced. The .bak suffix keeps it out of the recipe list. */
function backupSettingsFile(file) {
	if (!fs.existsSync(file)) return null;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backup = `${file}.${stamp}.bak`;
	fs.copyFileSync(file, backup);
	return backup;
}

/**
 * The completed core deployment this chain already has, if any. Add-ons attach to a live
 * core, so its existence is what decides whether "the protocol itself" can be unticked.
 */
function coreReportFor(networkName) {
	try {
		const chain = resolveNetwork(networkName);
		const report = readDeploymentReport(chain.chainId, { simulated: Boolean(chain.simulated) });
		if (report && (report.lifecycle === "complete" || report.lifecycle === "pending_handover")) return report;
	} catch {}
	return null;
}

/** Where the deployment record for a network lives — the evidence coreReportFor looks for. */
function recordPathFor(networkName) {
	try {
		const chain = resolveNetwork(networkName);
		return `tasks/data/${chain.chainId}${chain.simulated ? "-fork" : ""}/deployment-report.json`;
	} catch {
		return "tasks/data/<chainId>/deployment-report.json";
	}
}

/** Wipe the screen and re-anchor with a mini masthead, so each step starts clean but never placeless. */
function screen(sub) {
	clear();
	log(`  ${c.red(SYM.mark)} ${c.bold("SYMMIO")}${sub ? `  ${c.grey(sub)}` : ""}`);
	log(`  ${c.grey("─".repeat(64))}`);
}

/** The step-2 checklist. Pre-set from an existing file when there is one. */
async function choosePartsFor(prompt, current, core = {}) {
	const coreOption = core.unlocked
		? { label: "The protocol itself", detail: core.detail, value: "core", selected: true }
		: { label: "The protocol itself", detail: core.detail || "Core, AccountLayer and InstantLayer", value: "core", locked: true };
	const help = core.help ? [...COMPONENT_HELP, "", ...core.help] : COMPONENT_HELP;
	return prompt.multiSelect(
		"Which parts do you want?",
		[
			coreOption,
			{
				label: "PartyB",
				detail: "solver / hedger contract",
				value: "partyB",
				selected: current ? current.components.partyB === "deploy" : true,
			},
			{
				label: "SymbolManager",
				detail: "adds and removes tradable symbols",
				value: "symbolManager",
				selected: current ? current.components.symbolManager === "deploy" : true,
			},
			{
				label: "ExpressProvider",
				detail: "fast withdrawals — advances real funds, most teams add it later",
				value: "expressProvider",
				selected: current ? current.components.expressProvider === "deploy" : false,
			},
		],
		{ help: COMPONENT_HELP },
	);
}

/** The deployment conversation: pick a target, fill it in, check it, then deploy. */
async function deployConversation(prompt, existing) {
	let recipePath = existing?.path;
	let force = false;
	let justCreated = false;

	if (!recipePath) {
		screen("deploy");
		eyebrow("step 1 of 4 · blockchain");
		const network = await prompt.select(
			"Which blockchain?",
			[...NETWORK_CHOICES, { label: "something else", detail: "type the network name yourself", value: "__other" }],
			{
				help: [
					"A live chain spends real funds the moment you deploy. A fork is a private",
					"practice copy: it reads the real chain's state, but everything you do on it",
					"vanishes when you're done — perfect for a first run. Rehearsing on the fork",
					"and then repeating the same answers on the live chain is the recommended path.",
				],
			},
		);
		if (network === null) return 0;
		const chosen = network === "__other" ? await prompt.ask("Network name") : network;
		if (!chosen) return 0;

		// Re-running the wizard for a blockchain you already set up is normal, not an error.
		// Offer the existing file rather than letting `recipe init` refuse to overwrite it.
		const already = listRecipes().filter(entry => entry.network === chosen || entry.label.includes(`/${chosen}.json`));
		if (already.length > 0) {
			screen(`deploy · ${chosen}`);
			blank();
			log(`  ${c.bold(`You already have settings for ${chosen}:`)}`);
			blank();
			for (const entry of already) previewCard(entry);
			const reuse = await prompt.select(
				"What would you like to do?",
				[
					...already.map(entry => ({
						label: `Continue with ${entry.label}`,
						detail: "Keeps the file exactly as it is and picks up from where it stands",
						value: { kind: "reuse", entry },
					})),
					{
						label: "Start over with a fresh file",
						detail: "Your current file is saved as a timestamped .bak first — nothing is lost",
						value: { kind: "fresh" },
					},
				],
				{
					help: [
						"Continue keeps the existing file untouched and walks you through finishing",
						"it — filling values, checking, deploying. Start over writes a clean template",
						"in its place, but only after copying the current file to a .bak next to it,",
						"so you can always recover what you had.",
					],
				},
			);
			if (reuse === null) return 0;
			if (reuse.kind === "reuse") return deployConversation(prompt, reuse.entry);
			force = true;
		}

		screen(`deploy · ${chosen}`);
		eyebrow("step 2 of 4 · what to install");
		// Add-ons attach to a live core, so whether "the protocol itself" can be unticked is a
		// fact about the chain, not a preference: untickable exactly when a core is deployed.
		const liveCore = coreReportFor(chosen);
		let only = null;
		let parts = [];
		for (;;) {
			parts = await choosePartsFor(
				prompt,
				null,
				liveCore
					? { unlocked: true, detail: "this checkout has a completed deployment here — untick to add just one part" }
					: {
							detail: "required — this checkout has no deployment record for this chain",
							help: [
								`Add-ons attach to a deployed core, and the proof this tool trusts is the`,
								`deployment record it wrote when a deployment finished: ${recordPathFor(chosen)}.`,
								"Deploying from here creates it. If the protocol was deployed from another",
								"machine, copy that file into place and this checkbox unlocks.",
							],
						},
			);
			if (parts === null) return 0;
			if (parts.includes("core")) break;
			const addons = parts.filter(name => name !== "core");
			if (addons.length === 1) {
				only = addons[0];
				break;
			}
			blank();
			log(
				`  ${c.yellow(
					addons.length === 0
						? "Nothing selected — pick at least one part."
						: "Add-ons install one at a time. Keep exactly one ticked, or include the protocol itself.",
				)}`,
			);
		}

		// The promise made in the menu: starting over never destroys what was there.
		let backup = null;
		if (force) backup = backupSettingsFile(path.join(DEPLOYMENTS_DIR, `${chosen}${only ? `-${only}` : ""}.json`));

		const display = `./symmio recipe init --network ${chosen}${only ? ` --only ${only}` : ""}${force ? " --force" : ""}`;
		const code = await dispatch(
			"recipe",
			{ _: ["recipe", "init"], network: chosen, ...(only ? { only } : {}), ...(force ? { force: true } : {}) },
			display,
		);
		if (code !== 0) return code;
		if (backup) log(`  ${c.grey("Your previous settings are safe at")} ${c.cyan(relative(backup))}`);

		const created = listRecipes().find(entry => entry.network === chosen && (only ? entry.addon === only : !entry.isAddon));
		if (!created) {
			log(`  ${c.yellow(SYM.warn)} Could not find the file that was just created. Re-run ./symmio to continue.`);
			return 1;
		}
		recipePath = created.path;
		if (!only) setComponentModes(recipePath, parts);
		justCreated = true;
	}

	// Arriving with an existing file (continue/resume) must not silently lock in what it
	// installs — that decision belongs to the operator, not to whenever the file was made.
	// Once something is on chain the parts ARE fixed: the deployment's identity is bound to
	// them, and a resume would refuse a changed file.
	if (!justCreated) {
		const pre = describeRecipe(recipePath);
		if (pre.valid && !pre.isAddon) {
			const state = readState(pre);
			if (!state.checkpoint && !state.report) {
				screen(`deploy · ${pre.network}`);
				eyebrow("step 2 of 4 · what to install");
				const parts = await choosePartsFor(prompt, pre);
				if (parts === null) return 0;
				setComponentModes(recipePath, parts);
			} else {
				blank();
				log(`  ${c.grey("What to install was fixed when this deployment first ran; finishing it as configured.")}`);
			}
		}
	}

	if (!(await ensureFilled(prompt, recipePath))) return 0;

	const recipe = describeRecipe(recipePath);
	const only = recipe.addon;
	const onlyArgs = only ? { only } : {};
	const onlyFlag = only ? ` --only ${only}` : "";
	const config = recipe.label;

	screen(`deploy · ${recipe.network}`);
	eyebrow("step 4 of 4 · check and deploy");
	blank();
	log(`  ${c.grey("Checking your settings against the blockchain before anything is sent…")}`);
	const doctorCode = await dispatch("doctor", { config, ...onlyArgs }, `./symmio doctor --config ${config}${onlyFlag}`);
	if (doctorCode !== 0) {
		blank();
		log(`  ${c.yellow(SYM.warn)} Fix what it listed above, then run ${c.cyan("./symmio")} again.`);
		return doctorCode;
	}

	for (;;) {
		const next = await prompt.select(
			"Everything checks out. What now?",
			[
				{ label: "Show me exactly what will be deployed", detail: "Read-only preview — sends nothing", value: "plan" },
				{
					label: recipe.mode === "live" ? "Deploy to the real blockchain" : "Deploy (practice run)",
					detail: recipe.mode === "live" ? "Spends real funds. You will be asked to confirm again" : "Nothing real is spent",
					value: "deploy",
				},
				{ label: "Stop here", detail: "Re-run ./symmio to pick up from here", value: "stop" },
			],
			{
				help: [
					"The preview lists every contract that would be created, in order, without",
					"sending anything. Deploying on a live chain asks you to type the network",
					"name as a final confirmation. If the run is ever interrupted — network",
					"error, closed laptop — just re-run ./symmio: it resumes from where it",
					"stopped and never deploys the same contract twice.",
				],
			},
		);
		if (next === null || next === "stop") return 0;
		if (next === "plan") {
			await dispatch("deploy", { config, plan: true, ...onlyArgs }, `./symmio deploy --config ${config}${onlyFlag} --plan`);
			continue;
		}

		const code = await dispatch("deploy", { config, ...onlyArgs }, `./symmio deploy --config ${config}${onlyFlag}`);
		const after = readState(describeRecipe(recipePath));
		if (after.report?.manualActions?.length > 0) {
			showHandover(after.report);
			const done = await prompt.select(
				"When your admin wallet has run those:",
				[
					{ label: "I've run them — check and finish", value: "finish" },
					{ label: "Stop here", detail: "Re-run ./symmio when they are done", value: "stop" },
				],
				{
					help: [
						"The wallet that deployed hands control to your admin wallet (usually a",
						"Safe multisig), and a few final steps can only be signed by that admin.",
						"Paste each 'to' and 'data' shown above into a transaction from the admin",
						"wallet. Once they confirm on chain, this final check flips the deployment",
						"to complete.",
					],
				},
			);
			if (done === "finish") {
				const final = await dispatch("deploy", { config, ...onlyArgs }, `./symmio deploy --config ${config}${onlyFlag}`);
				if (final === 0) celebrate(recipe);
				return final;
			}
			return code;
		}
		if (code === 0) celebrate(recipe);
		return code;
	}
}

/** The finish line deserves more than an exit code. */
function celebrate(recipe) {
	blank();
	log(`  ${c.green(SYM.ok)} ${c.bold("Deployment complete.")}`);
	log(`  ${c.grey("Addresses and evidence:")} ${c.cyan(`tasks/data/${recipe.chainId}${recipe.simulated ? "-fork" : ""}/deployment-report.json`)}`);
	log(`  ${c.grey("Next: list trading symbols and connect your solver — run")} ${c.cyan("./symmio")} ${c.grey("any time to check on it.")}`);
	blank();
}

async function session(prompt) {
	const recipes = listRecipes();
	const started = recipes
		.filter(entry => entry.valid)
		.map(entry => ({ entry, state: readState(entry) }))
		.find(({ state }) => state.checkpoint || state.report);

	const intents = [];
	if (started) {
		const label = started.state.checkpoint ? "Continue the deployment you started" : "Finish off the deployment you started";
		intents.push({ label, detail: `${started.entry.network} — ${started.entry.label}`, value: { kind: "resume", entry: started.entry } });
	}
	intents.push({ label: "Deploy SYMMIO to a blockchain", detail: "Sets everything up and walks you through it", value: { kind: "deploy" } });
	if (recipes.length > 0) {
		intents.push({ label: "Check on a deployment", detail: "See where it stands and what is on chain", value: { kind: "check" } });
	}
	intents.push({
		label: "Read the deployment guide",
		detail: `optional deep-dive — the wizard covers the essentials (${GUIDE_DOC})`,
		value: { kind: "docs" },
	});

	const intent = await prompt.select("What do you want to do?", intents, {
		help: [
			"This wizard runs the same commands an expert would type, and shows you each",
			"one before it runs — so you learn the CLI as a side effect. Nothing is ever",
			"sent to a blockchain without asking you first, and you can stop at any point",
			"and pick up exactly where you left off.",
		],
	});
	if (intent === null) return goodbye(0);

	if (intent.kind === "docs") {
		blank();
		log(`  ${c.cyan(GUIDE_DOC)}`);
		blank();
		return 0;
	}
	if (intent.kind === "deploy") return deployConversation(prompt, null);
	if (intent.kind === "resume") return deployConversation(prompt, intent.entry);

	let current = await chooseRecipe(prompt, recipes);
	if (!current) return goodbye(0);

	let lastCode = 0;
	for (;;) {
		current = describeRecipe(current.path);
		const state = readState(current);
		screen(`overview · ${current.valid ? current.network : current.label}`);
		summarize(current, state);

		const actions = actionsFor(current, state);
		const choice = await prompt.select("What next?", actions);
		if (choice === null) return goodbye(lastCode);

		try {
			if (choice.kind === "edit") {
				openInEditor(current.path);
			} else if (choice.kind === "docs") {
				blank();
				log(`  ${c.cyan(GUIDE_DOC)}`);
				blank();
			} else if (choice.kind === "handover") {
				showHandover(state.report);
			} else if (choice.kind === "init") {
				await runInit(prompt);
			} else if (choice.kind === "switch") {
				const next = await chooseRecipe(prompt, listRecipes());
				if (next) current = next;
			} else if (choice.kind === "run") {
				lastCode = await dispatch(choice.command, choice.args, choice.display);
			}
		} catch (error) {
			blank();
			log(`  ${c.red(SYM.fail)} ${error.message || String(error)}`);
			log(`  ${c.grey("Nothing else was attempted. Fix the cause and choose again.")}`);
			lastCode = 1;
		}
	}
}
