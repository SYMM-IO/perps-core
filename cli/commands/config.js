// `symmio config show|diff|export`
//
// Protocol configuration is an operational contract: every value and every ordered
// InstantLayer template operation must match. A shallow name/count comparison can report
// "match" while hedgers execute materially different calldata, so this command compares
// one coherent on-chain block in full.
import { loadEnv, makeProvider, resolveNetwork } from "../lib/context.js";
import { hardhat } from "../lib/hardhat.js";
import { PROJECT_ROOT, projectPath } from "../lib/paths.js";
import { KNOWN_MAINNET_CHAIN_IDS } from "../lib/safety-mirror.js";
import { blank, c, fail, info, kv, log, table, title, warn } from "../lib/ui.js";
import { Contract } from "ethers";
import fs from "node:fs";
import path from "node:path";

const VIEW_ABI = [
	"function getBalanceLimitPerUser() view returns (uint256)",
	"function getMaxWithdrawParts() view returns (uint256)",
	"function deallocateCooldown() view returns (uint256)",
	"function settlementCooldown() view returns (uint256)",
	"function getDeallocateDebounceTime() view returns (uint256)",
	"function liquidatorShare() view returns (uint256)",
	"function liquidationTimeout() view returns (uint256)",
	"function coolDownsOfMA() view returns (uint256,uint256,uint256,uint256)",
	"function forceCloseCooldowns() view returns (uint256,uint256)",
	"function pendingQuotesValidLength() view returns (uint256)",
	"function maxConnectedCounterParty() view returns (uint256)",
	"function getMuonConfig() view returns (uint256,uint256)",
];
const IL_ABI = [
	"function nextTemplateId() view returns (uint256)",
	"function templateInstantOpenMode(uint256) view returns (bool)",
	"function getTemplates(uint256,uint256) view returns (tuple(string name, tuple(uint256[] insertionPoints, uint256[] sourceIndices, uint256[] sourceOffsets)[] operations, bool active)[])",
];

export const PROTOCOL_PARAMETER_NAMES = [
	"balanceLimitPerUser",
	"maxWithdrawParts",
	"deallocateCooldown",
	"settlementCooldown",
	"deallocateDebounceTime",
	"liquidatorShare",
	"liquidationTimeout",
	"forceCloseCooldowns",
	"forceCancelCooldown",
	"forceCancelCloseCooldown",
	"pendingQuotesValidLength",
	"maxPartyAConnectionLimit",
];

export function configPath(chainId) {
	return projectPath("tasks", "config", `protocol-${Number(chainId)}.json`);
}

export function configLabel(chainId) {
	return path.relative(PROJECT_ROOT, configPath(chainId));
}

export function readConfig(chainId) {
	const target = configPath(chainId);
	if (!fs.existsSync(target)) return null;
	try {
		return JSON.parse(fs.readFileSync(target, "utf8"));
	} catch (error) {
		throw new Error(`failed to parse ${configLabel(chainId)}: ${error.message || error}`);
	}
}

function stringify(value) {
	if (Array.isArray(value)) return `[${value.map(stringify).join(",")}]`;
	return String(value);
}

function normalizeArray(value) {
	return Array.from(value ?? [], item => BigInt(item).toString());
}

export async function readProtocolParameters(view, blockTag) {
	const call = name => view[name]({ blockTag });
	const [
		balanceLimitPerUser,
		maxWithdrawParts,
		deallocateCooldown,
		settlementCooldown,
		deallocateDebounceTime,
		liquidatorShare,
		liquidationTimeout,
		coolDowns,
		forceCloseCooldowns,
		pendingQuotesValidLength,
		maxPartyAConnectionLimit,
	] = await Promise.all([
		call("getBalanceLimitPerUser"),
		call("getMaxWithdrawParts"),
		call("deallocateCooldown"),
		call("settlementCooldown"),
		call("getDeallocateDebounceTime"),
		call("liquidatorShare"),
		call("liquidationTimeout"),
		call("coolDownsOfMA"),
		call("forceCloseCooldowns"),
		call("pendingQuotesValidLength"),
		call("maxConnectedCounterParty"),
	]);

	// coolDownsOfMA = deallocate, force-cancel, force-cancel-close, force-close-first.
	// Read the dedicated deallocate and force-close getters too: this avoids relying on a
	// tuple position for fields that have an unambiguous public getter.
	if (BigInt(coolDowns[0]) !== BigInt(deallocateCooldown) || BigInt(coolDowns[3]) !== BigInt(forceCloseCooldowns[0])) {
		throw new Error("inconsistent protocol cooldown getters on the live Diamond");
	}

	return {
		balanceLimitPerUser: BigInt(balanceLimitPerUser).toString(),
		maxWithdrawParts: BigInt(maxWithdrawParts).toString(),
		deallocateCooldown: BigInt(deallocateCooldown).toString(),
		settlementCooldown: BigInt(settlementCooldown).toString(),
		deallocateDebounceTime: BigInt(deallocateDebounceTime).toString(),
		liquidatorShare: BigInt(liquidatorShare).toString(),
		liquidationTimeout: BigInt(liquidationTimeout).toString(),
		forceCloseCooldowns: normalizeArray(forceCloseCooldowns),
		forceCancelCooldown: BigInt(coolDowns[1]).toString(),
		forceCancelCloseCooldown: BigInt(coolDowns[2]).toString(),
		pendingQuotesValidLength: BigInt(pendingQuotesValidLength).toString(),
		maxPartyAConnectionLimit: BigInt(maxPartyAConnectionLimit).toString(),
	};
}

/** Return exact, field-level differences for an ordered InstantLayer template. */
export function templateDifferences(templateId, live, configured, instantOpenMode) {
	const differences = [];
	const prefix = `template ${templateId}`;
	if (!live || !configured) {
		differences.push(`${prefix}: ${live ? "missing from config" : "missing on-chain"}`);
		return differences;
	}
	if (live.name !== configured.name)
		differences.push(`${prefix}.name: live=${JSON.stringify(live.name)} config=${JSON.stringify(configured.name)}`);
	if (live.active !== true) differences.push(`${prefix}.active: live=${String(live.active)} config=true`);
	if (Boolean(instantOpenMode) !== Boolean(configured.instantOpenMode)) {
		differences.push(`${prefix}.instantOpenMode: live=${Boolean(instantOpenMode)} config=${Boolean(configured.instantOpenMode)}`);
	}

	const liveOperations = Array.from(live.operations ?? []);
	const configuredOperations = configured.operations ?? [];
	if (liveOperations.length !== configuredOperations.length) {
		differences.push(`${prefix}.operations.length: live=${liveOperations.length} config=${configuredOperations.length}`);
	}
	for (let operationIndex = 0; operationIndex < Math.max(liveOperations.length, configuredOperations.length); operationIndex++) {
		const liveOperation = liveOperations[operationIndex];
		const configuredOperation = configuredOperations[operationIndex];
		if (!liveOperation || !configuredOperation) continue;
		for (const field of ["insertionPoints", "sourceIndices", "sourceOffsets"]) {
			const liveValues = normalizeArray(liveOperation[field]);
			const configuredValues = normalizeArray(configuredOperation[field]);
			if (stringify(liveValues) !== stringify(configuredValues)) {
				differences.push(
					`${prefix}.operations[${operationIndex}].${field}: live=${stringify(liveValues)} config=${stringify(configuredValues)}`,
				);
			}
		}
	}
	return differences;
}

export async function config(args) {
	const sub = args._[1];
	if (!sub || sub === "show") return show(args);
	if (sub === "diff") return diff(args);
	if (sub === "export") return exportConfig(args);
	throw new Error(`Unknown subcommand "${sub}". Use: show | diff | export`);
}

function show(args) {
	const chainId = args.chain ? Number(args.chain) : args.network ? resolveNetwork(args.network).chainId : null;
	if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("pass a positive integer --chain <id> or a supported --network <name>");

	const cfg = readConfig(chainId);
	if (!cfg) {
		blank();
		if (KNOWN_MAINNET_CHAIN_IDS.has(chainId)) {
			fail(`no ${configLabel(chainId)} — deploy:system blocks known mainnets and their forks without a reviewed chain-specific config`);
			blank();
			return 1;
		}
		info(`no ${configLabel(chainId)} — local/test deployments use built-in defaults`);
		blank();
		return 0;
	}

	title(`Protocol config — chain ${chainId}`);
	if (cfg.description) log(`  ${c.grey(cfg.description)}`);
	blank();
	kv(Object.entries(cfg.parameters).map(([k, v]) => [k, Array.isArray(v) ? `[${v.join(", ")}]` : String(v)]));

	title("InstantLayer templates");
	table(
		["id", "name", "ops", "instantOpenMode"],
		(cfg.instantLayerTemplates ?? []).map((t, i) => [i, t.name, t.operations.length, t.instantOpenMode ? "yes" : ""]),
	);

	const unverified = cfg._provenance?.UNVERIFIED_still_defaults;
	if (unverified?.length) {
		blank();
		warn(`${unverified.length} parameters are unverified defaults`, unverified.join(", "));
	}
	blank();
	return 0;
}

async function diff(args) {
	const networkName = args.network;
	const symmio = args.symmio;
	const instantLayerAddress = args["instant-layer"];
	const against = args.against ? Number(args.against) : null;
	if (!networkName || !symmio || !instantLayerAddress || !Number.isSafeInteger(against) || against <= 0) {
		throw new Error("usage: symmio config diff --network <live-network> --symmio <address> --instant-layer <address> --against <chainId>");
	}

	const cfg = readConfig(against);
	if (!cfg) throw new Error(`no ${configLabel(against)} to compare against`);
	for (const name of PROTOCOL_PARAMETER_NAMES) {
		if (cfg.parameters?.[name] === undefined) throw new Error(`${configLabel(against)} is missing parameters.${name}`);
	}

	const { vars: env } = loadEnv();
	const provider = makeProvider(networkName, env);
	const chain = resolveNetwork(networkName);
	const blockTag = await provider.getBlockNumber();
	title(`Live ${chain.name} at block ${blockTag} vs ${configLabel(against)}`);
	blank();

	const view = new Contract(symmio, VIEW_ABI, provider);
	let liveParameters;
	try {
		liveParameters = await readProtocolParameters(view, blockTag);
	} catch (error) {
		fail(
			"could not read all 12 protocol parameters from the live deployment",
			(error.shortMessage || error.message || String(error)).slice(0, 120),
		);
		return 1;
	}

	let mismatches = 0;
	const rows = PROTOCOL_PARAMETER_NAMES.map(name => {
		const live = stringify(liveParameters[name]);
		const configured = stringify(cfg.parameters[name]);
		const same = live === configured;
		if (!same) mismatches++;
		return [same ? c.green("=") : c.red("≠"), name, live, configured];
	});
	table([" ", "parameter", "live", "config"], rows);

	try {
		const [upnl, price] = await view.getMuonConfig({ blockTag });
		blank();
		info(`live Muon validity: ${upnl}/${price}s`, "deployment environment inputs; verify these against the intended target values");
	} catch {
		warn("could not read live Muon validity");
	}

	title("InstantLayer templates");
	const instantLayer = new Contract(instantLayerAddress, IL_ABI, provider);
	let templateCount;
	let liveTemplates;
	let instantOpenModes;
	try {
		templateCount = Number(await instantLayer.nextTemplateId({ blockTag }));
		if (!Number.isSafeInteger(templateCount)) throw new Error(`invalid nextTemplateId ${templateCount}`);
		liveTemplates = templateCount === 0 ? [] : await instantLayer.getTemplates(0, templateCount, { blockTag });
		if (liveTemplates.length !== templateCount) throw new Error(`getTemplates returned ${liveTemplates.length}; expected ${templateCount}`);
		instantOpenModes = await Promise.all(
			Array.from({ length: templateCount }, (_, templateId) => instantLayer.templateInstantOpenMode(templateId, { blockTag })),
		);
	} catch (error) {
		fail("could not read complete InstantLayer templates", (error.shortMessage || error.message || String(error)).slice(0, 120));
		return 1;
	}

	const configuredTemplates = cfg.instantLayerTemplates ?? [];
	const templateRows = [];
	const templateDetails = [];
	for (let templateId = 0; templateId < Math.max(liveTemplates.length, configuredTemplates.length); templateId++) {
		const differences = templateDifferences(templateId, liveTemplates[templateId], configuredTemplates[templateId], instantOpenModes[templateId]);
		mismatches += differences.length;
		templateDetails.push(...differences);
		templateRows.push([
			differences.length === 0 ? c.green("=") : c.red("≠"),
			templateId,
			liveTemplates[templateId]?.name ?? c.grey("—"),
			configuredTemplates[templateId]?.name ?? c.grey("—"),
			differences.length === 0 ? "all fields" : `${differences.length} field difference${differences.length === 1 ? "" : "s"}`,
		]);
	}
	table([" ", "id", "live", "config", "comparison"], templateRows);
	for (const difference of templateDetails) warn(difference);

	blank();
	if (mismatches === 0) {
		log(`  ${c.green(c.bold("configurations match"))}`);
		blank();
		return 0;
	}
	log(`  ${c.red(c.bold(`${mismatches} field difference${mismatches > 1 ? "s" : ""}`))}`);
	log(`  ${c.grey("template ids and operation wiring are part of the hedger contract — any difference changes behaviour")}`);
	blank();
	return 1;
}

async function exportConfig(args) {
	const networkName = args.network;
	if (!networkName || !args.symmio || !args["instant-layer"]) {
		throw new Error("usage: symmio config export --network <live-network> --symmio <address> --instant-layer <address> [--to <chainId>]");
	}
	const to = args.to ? Number(args.to) : resolveNetwork(networkName).chainId;
	if (!Number.isSafeInteger(to) || to <= 0) throw new Error("--to must be a positive integer chainId");
	info(`reading ${args.symmio} on ${networkName} → ${configLabel(to)}`);
	return hardhat(["run", "scripts/exportProtocolConfig.ts", "--network", networkName], {
		env: {
			SYMMIO: args.symmio,
			INSTANT_LAYER: args["instant-layer"],
			TARGET_CHAIN_ID: String(to),
		},
	});
}
