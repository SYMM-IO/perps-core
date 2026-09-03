import { validateDeploymentRecipe } from "./recipe.js";
import { getAddress } from "ethers";
import { createHash } from "node:crypto";
import fs from "node:fs";

export const ARBITRUM_PERPS_UPGRADE_INPUT_API_VERSION = "operations.symm.io/arbitrum-perps-upgrade-input-v2";
export const ARBITRUM_PERPS_UPGRADE_REPORT_API_VERSION = "operations.symm.io/arbitrum-perps-upgrade-report-v1";

export const ARBITRUM_PERPS_UPGRADE_TARGET = Object.freeze({
	chainId: 42161,
	network: "arbitrum",
	safe: "0x89bE952790657297ac03f1954b22B668d819D3d9",
	previousAdmin: "0x77A955776Ee1dd3E9C800c3214ed489441d74b94",
	contracts: Object.freeze({
		core: "0x573310dB6d160B26026B8706EBe9831c7dEF1D09",
		collateral: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
		accountLayer: "0x5733107211B2801Acd39933a54d482FE303c4907",
		currentInstantLayer: "0xDBc6DAe3De0b10a10b6c4d1b33D4C79567E07F6d",
		expressProvider: "0x573310D7b04fF21BB8628C69eE103dDF4922294A",
		signatureVerifier: "0xe8D2220Fd6D56C3f2fBDB3c7FF14FEAFA7573695",
		symbolManager: "0x902a529f5f1E9BCEBe7BC6e785A70aC2Db07Ad2c",
		feesManager: "0xc9B7E07E2Fce4FbFbf59D7d06b41Dc5e2Bd495e1",
		create2Factory: "0x99B425BC19F99a1B922664c0E4fa8A0870CE9975",
		currentGaslessLayer: "0x1c863aF5affc105EE42B8CAbA617E033A8F3Be22",
		liquidatorProxy: "0xC180F4C7c6c7C6a2247073Ca7bEaEBeb00D1D23F",
	}),
});

const INPUT_KEYS = [
	"$schema",
	"apiVersion",
	"kind",
	"name",
	"network",
	"source",
	"governance",
	"contracts",
	"instantLayer",
	"gaslessLayer",
	"execution",
];
const CONTRACT_KEYS = Object.keys(ARBITRUM_PERPS_UPGRADE_TARGET.contracts);
const UINT256_MAX = (1n << 256n) - 1n;

function fail(source, field, message) {
	throw new Error(`${source}: ${field} ${message}`);
}

function object(value, source, field) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(source, field, "must be an object");
	return value;
}

function exactKeys(value, required, source, field, optional = []) {
	for (const key of required) if (!Object.hasOwn(value, key)) fail(source, `${field}.${key}`, "is required");
	for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) fail(source, `${field}.${key}`, "is not supported");
}

function string(value, source, field) {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) fail(source, field, "must be a non-empty trimmed string");
	return value;
}

function address(value, source, field) {
	if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
		fail(source, field, "must be a non-zero address");
	}
	return getAddress(value);
}

function expectedAddress(value, expected, source, field) {
	const normalized = address(value, source, field);
	if (normalized !== getAddress(expected)) fail(source, field, `must equal the reviewed target ${getAddress(expected)}`);
	return normalized;
}

function integer(value, source, field, minimum = 0) {
	if (!Number.isSafeInteger(value) || value < minimum) fail(source, field, `must be a safe integer >= ${minimum}`);
	return value;
}

function uintString(value, source, field) {
	if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) fail(source, field, "must be a canonical unsigned integer string");
	if (BigInt(value) > UINT256_MAX) fail(source, field, "must fit in uint256");
	return value;
}

function boolean(value, source, field) {
	if (typeof value !== "boolean") fail(source, field, "must be a boolean");
	return value;
}

function validateOperations(templates, source) {
	if (!Array.isArray(templates) || templates.length === 0) fail(source, "instantLayer.templates", "must be a non-empty array");
	const names = new Set();
	for (const [templateIndex, rawTemplate] of templates.entries()) {
		const field = `instantLayer.templates[${templateIndex}]`;
		const template = object(rawTemplate, source, field);
		exactKeys(template, ["name", "operations"], source, field, ["instantOpenMode"]);
		string(template.name, source, `${field}.name`);
		if (names.has(template.name)) fail(source, `${field}.name`, "duplicates an earlier template");
		names.add(template.name);
		if (template.instantOpenMode !== undefined) boolean(template.instantOpenMode, source, `${field}.instantOpenMode`);
		if (!Array.isArray(template.operations) || template.operations.length === 0) fail(source, `${field}.operations`, "must be a non-empty array");
		for (const [operationIndex, rawOperation] of template.operations.entries()) {
			const operationField = `${field}.operations[${operationIndex}]`;
			const operation = object(rawOperation, source, operationField);
			const keys = ["insertionPoints", "sourceIndices", "sourceOffsets"];
			exactKeys(operation, keys, source, operationField);
			for (const key of keys) {
				if (!Array.isArray(operation[key])) fail(source, `${operationField}.${key}`, "must be an array");
				operation[key].forEach((entry, index) => integer(entry, source, `${operationField}.${key}[${index}]`));
			}
			if (
				operation.insertionPoints.length !== operation.sourceIndices.length ||
				operation.insertionPoints.length !== operation.sourceOffsets.length
			) {
				fail(source, operationField, "must have equal insertionPoints, sourceIndices, and sourceOffsets lengths");
			}
			operation.sourceIndices.forEach((entry, index) => {
				if (entry >= operationIndex) fail(source, `${operationField}.sourceIndices[${index}]`, "must reference an earlier operation");
			});
		}
	}
}

function validateGasless(value, source) {
	const gasless = object(value, source, "gaslessLayer");
	const keys = [
		"mode",
		"admin",
		"treasury",
		"depositFee",
		"minimumDeposit",
		"defaultSelectorFee",
		"dailyFreeOpsLimit",
		"revertWhenFreeQuotaExhausted",
		"dailySponsoredNativeLimit",
		"revertWhenNativeSponsorLimitExhausted",
		"maxNativeGasTopUpAmount",
		"nativeGasTopUpFeeBps",
		"relayers",
		"selectorFees",
	];
	exactKeys(gasless, keys, source, "gaslessLayer");
	if (gasless.mode !== "deploy") fail(source, "gaslessLayer.mode", 'must equal "deploy"');
	expectedAddress(gasless.admin, ARBITRUM_PERPS_UPGRADE_TARGET.safe, source, "gaslessLayer.admin");
	address(gasless.treasury, source, "gaslessLayer.treasury");
	for (const key of [
		"depositFee",
		"minimumDeposit",
		"defaultSelectorFee",
		"dailyFreeOpsLimit",
		"dailySponsoredNativeLimit",
		"maxNativeGasTopUpAmount",
	]) {
		uintString(gasless[key], source, `gaslessLayer.${key}`);
	}
	boolean(gasless.revertWhenFreeQuotaExhausted, source, "gaslessLayer.revertWhenFreeQuotaExhausted");
	boolean(gasless.revertWhenNativeSponsorLimitExhausted, source, "gaslessLayer.revertWhenNativeSponsorLimitExhausted");
	integer(gasless.nativeGasTopUpFeeBps, source, "gaslessLayer.nativeGasTopUpFeeBps");
	if (gasless.nativeGasTopUpFeeBps > 10000) fail(source, "gaslessLayer.nativeGasTopUpFeeBps", "must be <= 10000");
	if (!Array.isArray(gasless.relayers) || gasless.relayers.length === 0) fail(source, "gaslessLayer.relayers", "must be a non-empty array");
	const relayers = new Set();
	gasless.relayers.forEach((entry, index) => {
		const normalized = address(entry, source, `gaslessLayer.relayers[${index}]`).toLowerCase();
		if (relayers.has(normalized)) fail(source, `gaslessLayer.relayers[${index}]`, "duplicates an earlier relayer");
		relayers.add(normalized);
	});
	if (!Array.isArray(gasless.selectorFees)) fail(source, "gaslessLayer.selectorFees", "must be an array");
	gasless.selectorFees.forEach((rawEntry, index) => {
		const field = `gaslessLayer.selectorFees[${index}]`;
		const entry = object(rawEntry, source, field);
		exactKeys(entry, ["selector", "configured", "amount"], source, field);
		if (typeof entry.selector !== "string" || !/^0x[0-9a-fA-F]{8}$/.test(entry.selector))
			fail(source, `${field}.selector`, "must be four-byte calldata");
		boolean(entry.configured, source, `${field}.configured`);
		uintString(entry.amount, source, `${field}.amount`);
	});
}

export function validateArbitrumPerpsUpgradeInput(value, source = "Arbitrum Perps upgrade input") {
	const input = object(value, source, "input");
	exactKeys(
		input,
		INPUT_KEYS.filter(key => key !== "$schema"),
		source,
		"input",
		["$schema"],
	);
	if (input.$schema !== undefined) string(input.$schema, source, "$schema");
	if (input.apiVersion !== ARBITRUM_PERPS_UPGRADE_INPUT_API_VERSION)
		fail(source, "apiVersion", `must equal ${ARBITRUM_PERPS_UPGRADE_INPUT_API_VERSION}`);
	if (input.kind !== "ArbitrumPerpsUpgrade") fail(source, "kind", 'must equal "ArbitrumPerpsUpgrade"');
	string(input.name, source, "name");

	const network = object(input.network, source, "network");
	exactKeys(network, ["name", "chainId", "mode"], source, "network");
	if (network.name !== ARBITRUM_PERPS_UPGRADE_TARGET.network) fail(source, "network.name", 'must equal "arbitrum"');
	if (network.chainId !== ARBITRUM_PERPS_UPGRADE_TARGET.chainId) fail(source, "network.chainId", "must equal 42161");
	if (network.mode !== "live") fail(source, "network.mode", 'must equal "live"');

	const sourceBinding = object(input.source, source, "source");
	exactKeys(sourceBinding, ["commit", "recipe"], source, "source");
	if (typeof sourceBinding.commit !== "string" || !/^[0-9a-f]{40}$/.test(sourceBinding.commit))
		fail(source, "source.commit", "must be a lowercase 40-byte Git commit");
	const recipe = object(sourceBinding.recipe, source, "source.recipe");
	exactKeys(recipe, ["path", "digest"], source, "source.recipe");
	string(recipe.path, source, "source.recipe.path");
	if (typeof recipe.digest !== "string" || !/^[0-9a-f]{64}$/.test(recipe.digest))
		fail(source, "source.recipe.digest", "must be a lowercase SHA-256 digest");

	const governance = object(input.governance, source, "governance");
	exactKeys(governance, ["safe", "previousAdmin"], source, "governance");
	expectedAddress(governance.safe, ARBITRUM_PERPS_UPGRADE_TARGET.safe, source, "governance.safe");
	expectedAddress(governance.previousAdmin, ARBITRUM_PERPS_UPGRADE_TARGET.previousAdmin, source, "governance.previousAdmin");

	const contracts = object(input.contracts, source, "contracts");
	exactKeys(contracts, CONTRACT_KEYS, source, "contracts");
	for (const key of CONTRACT_KEYS) expectedAddress(contracts[key], ARBITRUM_PERPS_UPGRADE_TARGET.contracts[key], source, `contracts.${key}`);

	const instantLayer = object(input.instantLayer, source, "instantLayer");
	exactKeys(instantLayer, ["mode", "admin", "templates"], source, "instantLayer");
	if (instantLayer.mode !== "deploy") fail(source, "instantLayer.mode", 'must equal "deploy"');
	expectedAddress(instantLayer.admin, ARBITRUM_PERPS_UPGRADE_TARGET.safe, source, "instantLayer.admin");
	validateOperations(instantLayer.templates, source);
	validateGasless(input.gaslessLayer, source);

	const execution = object(input.execution, source, "execution");
	exactKeys(execution, ["verify", "confirmations", "txTimeoutSeconds", "slowNoticeSeconds", "requireForkRehearsal"], source, "execution");
	if (execution.verify !== true) fail(source, "execution.verify", "must be true for this live upgrade");
	integer(execution.confirmations, source, "execution.confirmations", 1);
	integer(execution.txTimeoutSeconds, source, "execution.txTimeoutSeconds", 30);
	integer(execution.slowNoticeSeconds, source, "execution.slowNoticeSeconds", 5);
	if (execution.slowNoticeSeconds >= execution.txTimeoutSeconds) fail(source, "execution.slowNoticeSeconds", "must be less than txTimeoutSeconds");
	boolean(execution.requireForkRehearsal, source, "execution.requireForkRehearsal");
	return input;
}

function stableSerialize(value) {
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function arbitrumPerpsUpgradeInputDigest(value) {
	const input = validateArbitrumPerpsUpgradeInput(value);
	const intent = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "$schema"));
	return createHash("sha256").update(stableSerialize(intent)).digest("hex");
}

export function buildArbitrumPerpsUpgradeInput({ recipe: rawRecipe, recipePath, recipeDigest, sourceCommit, requireForkRehearsal = true }) {
	const recipe = validateDeploymentRecipe(structuredClone(rawRecipe), recipePath || "deployment recipe");
	if (recipe.network.name !== "arbitrum" || recipe.network.chainId !== 42161 || recipe.network.mode !== "live") {
		throw new Error("Arbitrum Perps upgrade requires a live Arbitrum recipe");
	}
	if (!recipe.core?.protocol?.instantLayerTemplates?.length) throw new Error("Arbitrum Perps upgrade recipe has no InstantLayer templates");
	if (recipe.gaslessLayer?.mode !== "deploy") throw new Error("Arbitrum Perps upgrade recipe must declare a GaslessLayer deployment");
	const gasless = recipe.gaslessLayer;
	const input = {
		$schema: "https://operations.symm.io/schemas/arbitrum-perps-upgrade-input-v2.json",
		apiVersion: ARBITRUM_PERPS_UPGRADE_INPUT_API_VERSION,
		kind: "ArbitrumPerpsUpgrade",
		name: "arbitrum-perps-core-v0.8.6-upgrade",
		network: { name: "arbitrum", chainId: 42161, mode: "live" },
		source: { commit: sourceCommit, recipe: { path: recipePath, digest: recipeDigest } },
		governance: { safe: ARBITRUM_PERPS_UPGRADE_TARGET.safe, previousAdmin: ARBITRUM_PERPS_UPGRADE_TARGET.previousAdmin },
		contracts: { ...ARBITRUM_PERPS_UPGRADE_TARGET.contracts },
		instantLayer: {
			mode: "deploy",
			admin: ARBITRUM_PERPS_UPGRADE_TARGET.safe,
			templates: structuredClone(recipe.core.protocol.instantLayerTemplates),
		},
		gaslessLayer: {
			mode: "deploy",
			admin: ARBITRUM_PERPS_UPGRADE_TARGET.safe,
			treasury: gasless.treasury,
			depositFee: gasless.depositFee,
			minimumDeposit: gasless.minimumDeposit,
			defaultSelectorFee: gasless.defaultSelectorFee,
			dailyFreeOpsLimit: gasless.dailyFreeOpsLimit,
			revertWhenFreeQuotaExhausted: gasless.revertWhenFreeQuotaExhausted,
			dailySponsoredNativeLimit: gasless.dailySponsoredNativeLimit,
			revertWhenNativeSponsorLimitExhausted: gasless.revertWhenNativeSponsorLimitExhausted,
			maxNativeGasTopUpAmount: gasless.maxNativeGasTopUpAmount,
			nativeGasTopUpFeeBps: gasless.nativeGasTopUpFeeBps,
			relayers: structuredClone(gasless.relayers),
			selectorFees: structuredClone(gasless.selectorFees),
		},
		execution: {
			verify: true,
			confirmations: recipe.execution.confirmations ?? 1,
			txTimeoutSeconds: recipe.execution.txTimeoutSeconds ?? 300,
			slowNoticeSeconds: recipe.execution.slowNoticeSeconds ?? 30,
			requireForkRehearsal,
		},
	};
	return validateArbitrumPerpsUpgradeInput(input, "generated Arbitrum Perps upgrade input");
}

export function loadArbitrumPerpsUpgradeInput(file) {
	let input;
	try {
		input = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read Arbitrum Perps upgrade input ${file}: ${error.message || error}`);
	}
	return validateArbitrumPerpsUpgradeInput(input, file);
}

export function createArbitrumPerpsUpgradeReport(input, now = new Date().toISOString()) {
	const validated = validateArbitrumPerpsUpgradeInput(input);
	return {
		$schema: "https://operations.symm.io/schemas/arbitrum-perps-upgrade-report-v1.json",
		apiVersion: ARBITRUM_PERPS_UPGRADE_REPORT_API_VERSION,
		kind: "ArbitrumPerpsUpgradeReport",
		name: validated.name,
		inputDigest: arbitrumPerpsUpgradeInputDigest(validated),
		source: structuredClone(validated.source),
		network: structuredClone(validated.network),
		lifecycle: "prepared",
		addresses: { ...validated.contracts, newInstantLayer: null, newGaslessLayer: null, newGaslessLayerImplementation: null },
		stages: {},
		safeBatches: {},
		externalActions: {},
		transactions: [],
		checks: [],
		createdAt: now,
		updatedAt: now,
	};
}

export function validateArbitrumPerpsUpgradeReport(value, input, source = "Arbitrum Perps upgrade report") {
	const report = object(value, source, "report");
	if (report.apiVersion !== ARBITRUM_PERPS_UPGRADE_REPORT_API_VERSION)
		fail(source, "apiVersion", `must equal ${ARBITRUM_PERPS_UPGRADE_REPORT_API_VERSION}`);
	if (report.kind !== "ArbitrumPerpsUpgradeReport") fail(source, "kind", 'must equal "ArbitrumPerpsUpgradeReport"');
	const digest = arbitrumPerpsUpgradeInputDigest(input);
	if (report.inputDigest !== digest) fail(source, "inputDigest", `must equal ${digest}`);
	for (const field of ["addresses", "stages", "safeBatches", "externalActions"]) object(report[field], source, field);
	for (const field of ["transactions", "checks"]) if (!Array.isArray(report[field])) fail(source, field, "must be an array");
	if (!["prepared", "in_progress", "waiting_external", "complete", "failed"].includes(report.lifecycle)) fail(source, "lifecycle", "is invalid");
	string(report.createdAt, source, "createdAt");
	string(report.updatedAt, source, "updatedAt");
	return report;
}
