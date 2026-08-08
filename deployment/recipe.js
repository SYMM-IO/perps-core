import { DEPLOYABLE_CONTRACTS, VANITY_GROUPS } from "./deployableContracts.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RECIPE_API_VERSION = "deployment.symm.io/v1";
export const DEPLOYMENT_COMPONENTS = Object.freeze(["core", "partyB", "symbolManager", "expressProvider"]);

const COMPONENT_MODES = ["deploy", "reuse", "skip"];
const MUON_PERMISSIONS = [
	"Trading",
	"AccountManagement",
	"Settlement",
	"ForceClose",
	"Funding",
	"LiquidationPartyA",
	"LiquidationPartyB",
	"RemoveMargin",
];
/**
 * Exact, case-sensitive role names from LibAccessControl. An unknown or misspelled name is
 * rejected rather than silently granting nothing.
 */
const EXPRESS_ROLES = [
	"OPERATOR_ROLE",
	"LOCKER_ROLE",
	"SIGNER_ROLE",
	"SETTER_ROLE",
	"FEE_CLAIMER_ROLE",
	"UNLOCK_ROLE",
	"WITHDRAWER_ROLE",
	"PAUSER_ROLE",
];
/** Roles Init grants to the configured admin; the deployment proves them rather than re-granting. */
const EXPRESS_INIT_ADMIN_ROLES = ["SETTER_ROLE", "FEE_CLAIMER_ROLE", "WITHDRAWER_ROLE", "PAUSER_ROLE"];
const BPS_DENOMINATOR = 10000;
const VANITY_HEX = /^[0-9a-fA-F]{1,8}$/;
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);
const DEFAULT_CONFIRMATIONS = 1;
const DEFAULT_TX_TIMEOUT_SECONDS = 300;
const DEFAULT_SLOW_NOTICE_SECONDS = 30;

function fail(source, field, message, code) {
	const error = new Error(`${source}: ${field} ${message}`);
	if (code) error.code = code;
	throw error;
}

function object(value, source, field) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(source, field, "must be an object");
	return value;
}

function onlyKeys(value, allowed, source, field) {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) fail(source, `${field}.${key}`, "is not a supported field");
	}
}

function required(value, keys, source, field) {
	for (const key of keys) {
		if (!Object.hasOwn(value, key)) fail(source, `${field}.${key}`, "is required");
	}
}

function string(value, source, field) {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
		fail(source, field, "must be a non-empty trimmed string");
	}
	return value;
}

function boolean(value, source, field) {
	if (typeof value !== "boolean") fail(source, field, "must be a boolean");
	return value;
}

function enumValue(value, choices, source, field) {
	if (!choices.includes(value)) fail(source, field, `must be one of: ${choices.join(", ")}`);
	return value;
}

function integer(value, source, field, minimum = 0) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		fail(source, field, `must be a safe integer >= ${minimum}`);
	}
	return value;
}

function uintString(value, source, field, minimum = BigInt(0)) {
	if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
		fail(source, field, "must be a canonical unsigned base-10 integer string");
	}
	const parsed = BigInt(value);
	if (parsed < minimum) fail(source, field, `must be >= ${minimum}`);
	if (parsed > UINT256_MAX) fail(source, field, "must fit in uint256");
	return value;
}

function address(value, source, field) {
	if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
		fail(source, field, "must be a 20-byte hexadecimal address");
	}
	if (/^0x0{40}$/i.test(value)) fail(source, field, "must not be the zero address");
	return value;
}

function uniqueAddresses(value, source, field) {
	if (!Array.isArray(value) || value.length === 0) fail(source, field, "must be a non-empty array");
	const seen = new Set();
	for (const [index, entry] of value.entries()) {
		address(entry, source, `${field}[${index}]`);
		const normalized = entry.toLowerCase();
		if (seen.has(normalized)) fail(source, `${field}[${index}]`, "duplicates an earlier address");
		seen.add(normalized);
	}
}

function validateProtocol(value, source, field) {
	const protocol = object(value, source, field);
	onlyKeys(protocol, ["description", "parameters", "instantLayerTemplates"], source, field);
	required(protocol, ["parameters", "instantLayerTemplates"], source, field);
	if (protocol.description !== undefined) string(protocol.description, source, `${field}.description`);

	const parameters = object(protocol.parameters, source, `${field}.parameters`);
	const parameterKeys = [
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
	onlyKeys(parameters, parameterKeys, source, `${field}.parameters`);
	required(parameters, parameterKeys, source, `${field}.parameters`);
	uintString(parameters.balanceLimitPerUser, source, `${field}.parameters.balanceLimitPerUser`, BigInt(1));
	integer(parameters.maxWithdrawParts, source, `${field}.parameters.maxWithdrawParts`, 1);
	integer(parameters.deallocateCooldown, source, `${field}.parameters.deallocateCooldown`, 1);
	integer(parameters.settlementCooldown, source, `${field}.parameters.settlementCooldown`, 1);
	integer(parameters.deallocateDebounceTime, source, `${field}.parameters.deallocateDebounceTime`, 0);
	uintString(parameters.liquidatorShare, source, `${field}.parameters.liquidatorShare`, BigInt(1));
	if (BigInt(parameters.liquidatorShare) > BigInt("1000000000000000000")) {
		fail(source, `${field}.parameters.liquidatorShare`, "must be <= 1000000000000000000");
	}
	integer(parameters.liquidationTimeout, source, `${field}.parameters.liquidationTimeout`, 1);
	if (!Array.isArray(parameters.forceCloseCooldowns) || parameters.forceCloseCooldowns.length !== 2) {
		fail(source, `${field}.parameters.forceCloseCooldowns`, "must be a two-item tuple");
	}
	integer(parameters.forceCloseCooldowns[0], source, `${field}.parameters.forceCloseCooldowns[0]`, 1);
	integer(parameters.forceCloseCooldowns[1], source, `${field}.parameters.forceCloseCooldowns[1]`, 1);
	integer(parameters.forceCancelCooldown, source, `${field}.parameters.forceCancelCooldown`, 1);
	integer(parameters.forceCancelCloseCooldown, source, `${field}.parameters.forceCancelCloseCooldown`, 1);
	integer(parameters.pendingQuotesValidLength, source, `${field}.parameters.pendingQuotesValidLength`, 1);
	integer(parameters.maxPartyAConnectionLimit, source, `${field}.parameters.maxPartyAConnectionLimit`, 1);

	if (!Array.isArray(protocol.instantLayerTemplates) || protocol.instantLayerTemplates.length === 0) {
		fail(source, `${field}.instantLayerTemplates`, "must be a non-empty array");
	}
	const names = new Set();
	for (const [templateIndex, rawTemplate] of protocol.instantLayerTemplates.entries()) {
		const templateField = `${field}.instantLayerTemplates[${templateIndex}]`;
		const template = object(rawTemplate, source, templateField);
		onlyKeys(template, ["name", "instantOpenMode", "operations"], source, templateField);
		required(template, ["name", "operations"], source, templateField);
		string(template.name, source, `${templateField}.name`);
		if (names.has(template.name)) fail(source, `${templateField}.name`, `duplicates template name ${JSON.stringify(template.name)}`);
		names.add(template.name);
		if (template.instantOpenMode !== undefined) boolean(template.instantOpenMode, source, `${templateField}.instantOpenMode`);
		if (!Array.isArray(template.operations) || template.operations.length === 0) {
			fail(source, `${templateField}.operations`, "must be a non-empty array");
		}
		for (const [operationIndex, rawOperation] of template.operations.entries()) {
			const operationField = `${templateField}.operations[${operationIndex}]`;
			const operation = object(rawOperation, source, operationField);
			const arrayFields = ["insertionPoints", "sourceIndices", "sourceOffsets"];
			onlyKeys(operation, arrayFields, source, operationField);
			required(operation, arrayFields, source, operationField);
			for (const arrayField of arrayFields) {
				if (!Array.isArray(operation[arrayField])) fail(source, `${operationField}.${arrayField}`, "must be an array");
				for (const [entryIndex, entry] of operation[arrayField].entries()) {
					integer(entry, source, `${operationField}.${arrayField}[${entryIndex}]`, 0);
				}
			}
			if (
				operation.insertionPoints.length !== operation.sourceIndices.length ||
				operation.insertionPoints.length !== operation.sourceOffsets.length
			) {
				fail(source, operationField, "must have equal insertionPoints, sourceIndices, and sourceOffsets lengths");
			}
			for (const [entryIndex, sourceIndex] of operation.sourceIndices.entries()) {
				if (sourceIndex >= operationIndex) {
					fail(source, `${operationField}.sourceIndices[${entryIndex}]`, `must reference an earlier operation (index < ${operationIndex})`);
				}
			}
		}
	}
}

function validateMuon(value, source, field, networkMode) {
	const muon = object(value, source, field);
	const keys = ["mode", "address", "appId", "upnlValidTime", "priceValidTime", "publicKey", "gatewaySigners", "permissions"];
	onlyKeys(muon, keys, source, field);
	required(muon, ["mode", "upnlValidTime", "priceValidTime"], source, field);
	enumValue(muon.mode, ["mock", "deploy", "reuse"], source, `${field}.mode`);
	uintString(muon.upnlValidTime, source, `${field}.upnlValidTime`, BigInt(1));
	uintString(muon.priceValidTime, source, `${field}.priceValidTime`, BigInt(1));

	if (muon.mode === "mock") {
		if (networkMode === "live") fail(source, `${field}.mode`, "mock is forbidden for live targets");
		for (const key of ["address", "appId", "publicKey", "gatewaySigners", "permissions"]) {
			if (muon[key] !== undefined) fail(source, `${field}.${key}`, `must be omitted when ${field}.mode is mock`);
		}
		return;
	}

	required(muon, ["appId", "permissions"], source, field);
	uintString(muon.appId, source, `${field}.appId`, BigInt(1));
	if (!Array.isArray(muon.permissions)) fail(source, `${field}.permissions`, "must be an array");
	if (muon.permissions.length !== MUON_PERMISSIONS.length || MUON_PERMISSIONS.some(name => !muon.permissions.includes(name))) {
		fail(source, `${field}.permissions`, `must contain every Muon permission exactly once: ${MUON_PERMISSIONS.join(", ")}`);
	}
	if (new Set(muon.permissions).size !== muon.permissions.length) fail(source, `${field}.permissions`, "must not contain duplicates");
	for (const [index, permission] of muon.permissions.entries()) {
		if (!MUON_PERMISSIONS.includes(permission)) fail(source, `${field}.permissions[${index}]`, "is not a known Muon permission");
	}

	if (muon.publicKey !== undefined) {
		const publicKey = object(muon.publicKey, source, `${field}.publicKey`);
		onlyKeys(publicKey, ["x", "parity"], source, `${field}.publicKey`);
		required(publicKey, ["x", "parity"], source, `${field}.publicKey`);
		uintString(publicKey.x, source, `${field}.publicKey.x`, BigInt(1));
		if (publicKey.parity !== 0 && publicKey.parity !== 1) fail(source, `${field}.publicKey.parity`, "must be 0 or 1");
	}
	if (muon.gatewaySigners !== undefined) uniqueAddresses(muon.gatewaySigners, source, `${field}.gatewaySigners`);

	if (muon.mode === "deploy") {
		if (muon.address !== undefined) fail(source, `${field}.address`, "must be omitted when deploying Muon");
		required(muon, ["publicKey", "gatewaySigners"], source, field);
	} else {
		required(muon, ["address"], source, field);
		address(muon.address, source, `${field}.address`);
	}
}

function validateVanityPattern(value, source, field) {
	const pattern = object(value, source, field);
	onlyKeys(pattern, ["prefix", "suffix"], source, field);
	for (const key of ["prefix", "suffix"]) {
		if (pattern[key] === undefined) continue;
		if (typeof pattern[key] !== "string" || !VANITY_HEX.test(pattern[key])) {
			fail(source, `${field}.${key}`, "must contain 1-8 hexadecimal characters without 0x");
		}
	}
	return pattern.prefix !== undefined || pattern.suffix !== undefined;
}

/**
 * Vanity address intent for every component. Declaring a pattern without a factory would
 * silently fall back to ordinary CREATE and produce an address nobody reviewed, so it fails.
 * The factory itself is either reused at a known address or deployed by the run.
 */
function validateCreate2(value, source) {
	const create2 = object(value, source, "create2");
	onlyKeys(create2, ["factory", "factoryAddress", "groups", "overrides", "miningBudget"], source, "create2");
	if (create2.factory !== undefined && create2.factoryAddress !== undefined) {
		fail(source, "create2.factory", "and create2.factoryAddress are two spellings of the same intent; keep one");
	}
	if (create2.factoryAddress !== undefined) address(create2.factoryAddress, source, "create2.factoryAddress");
	if (create2.factory !== undefined) {
		const factory = object(create2.factory, source, "create2.factory");
		onlyKeys(factory, ["mode", "address"], source, "create2.factory");
		required(factory, ["mode"], source, "create2.factory");
		enumValue(factory.mode, ["deploy", "reuse"], source, "create2.factory.mode");
		if (factory.mode === "reuse") {
			required(factory, ["address"], source, "create2.factory");
			address(factory.address, source, "create2.factory.address");
		} else if (factory.address !== undefined) {
			fail(source, "create2.factory.address", "must be omitted when create2.factory.mode is deploy");
		}
	}
	if (create2.miningBudget !== undefined) integer(create2.miningBudget, source, "create2.miningBudget", 1);

	let declared = false;
	if (create2.groups !== undefined) {
		const groups = object(create2.groups, source, "create2.groups");
		onlyKeys(groups, VANITY_GROUPS, source, "create2.groups");
		for (const name of Object.keys(groups)) {
			declared = validateVanityPattern(groups[name], source, `create2.groups.${name}`) || declared;
		}
	}
	if (create2.overrides !== undefined) {
		const overrides = object(create2.overrides, source, "create2.overrides");
		for (const key of Object.keys(overrides)) {
			if (!Object.hasOwn(DEPLOYABLE_CONTRACTS, key)) {
				fail(source, `create2.overrides.${key}`, 'is not a known deployable contract; use a qualified key such as "core/PartyAFacet"');
			}
			declared = validateVanityPattern(overrides[key], source, `create2.overrides.${key}`) || declared;
		}
	}
	if (declared && create2.factory === undefined && create2.factoryAddress === undefined) {
		fail(
			source,
			"create2.factory",
			'is required when any group or override declares a vanity pattern; use { "mode": "deploy" } to have the run create one, ' +
				'or { "mode": "reuse", "address": "0x…" }',
		);
	}
}

function validateCore(value, source, networkMode) {
	const core = object(value, source, "core");
	if (core.create2 !== undefined) {
		fail(source, "core.create2", 'has moved to the top-level "create2" block; see deployment/examples/arbitrum.v1.example.json');
	}
	const keys = ["mode", "fromReport", "collateral", "muon", "protocol", "setupInstantLayerTemplates", "registerDummyAffiliate"];
	onlyKeys(core, keys, source, "core");
	required(core, ["mode"], source, "core");
	enumValue(core.mode, COMPONENT_MODES, source, "core.mode");
	if (core.setupInstantLayerTemplates !== undefined) boolean(core.setupInstantLayerTemplates, source, "core.setupInstantLayerTemplates");
	if (core.registerDummyAffiliate !== undefined) boolean(core.registerDummyAffiliate, source, "core.registerDummyAffiliate");
	if (networkMode === "live" && core.registerDummyAffiliate === true) fail(source, "core.registerDummyAffiliate", "must be false for live targets");

	if (core.collateral !== undefined) {
		const collateral = object(core.collateral, source, "core.collateral");
		onlyKeys(collateral, ["mode", "address"], source, "core.collateral");
		required(collateral, ["mode"], source, "core.collateral");
		enumValue(collateral.mode, ["deploy", "reuse"], source, "core.collateral.mode");
		if (collateral.mode === "reuse") {
			required(collateral, ["address"], source, "core.collateral");
			address(collateral.address, source, "core.collateral.address");
		} else if (collateral.address !== undefined) {
			fail(source, "core.collateral.address", "must be omitted when deploying collateral");
		}
		if (networkMode === "live" && collateral.mode === "deploy") {
			fail(source, "core.collateral.mode", "deploy is forbidden for live targets; reuse a reviewed collateral token");
		}
	}

	if (core.muon !== undefined) validateMuon(core.muon, source, "core.muon", networkMode);
	if (core.protocol !== undefined) validateProtocol(core.protocol, source, "core.protocol");
	if (core.mode === "deploy") {
		required(core, ["collateral", "muon", "protocol", "setupInstantLayerTemplates", "registerDummyAffiliate"], source, "core");
	}
	if (core.mode === "reuse") {
		required(core, ["fromReport"], source, "core");
		string(core.fromReport, source, "core.fromReport");
	}
	if (core.mode !== "reuse" && core.fromReport !== undefined) fail(source, "core.fromReport", "must be omitted unless core.mode is reuse");
}

/**
 * ExpressProvider carries more deployment intent than the other add-ons: credit-line Muon
 * inputs, per-affiliate policy, validator sets, and eight role assignments. Everything the
 * deployment will write is declared here so the plan, digest, and post-state health check all
 * read from one reviewed source.
 */
function validateExpressProvider(value, source, name = "expressProvider") {
	const component = object(value, source, name);
	const allowed = ["mode", "address", "admin", "registerOnCore", "securityWindow", "tolerancePeriod", "creditLine", "roles", "affiliates"];
	onlyKeys(component, allowed, source, name);
	required(component, ["mode"], source, name);
	enumValue(component.mode, COMPONENT_MODES, source, `${name}.mode`);

	const deployOnly = ["admin", "registerOnCore", "securityWindow", "tolerancePeriod", "creditLine", "roles", "affiliates"];
	if (component.mode === "skip") {
		if (component.address !== undefined) fail(source, `${name}.address`, "must be omitted when mode is skip");
		for (const field of deployOnly) {
			if (component[field] !== undefined) fail(source, `${name}.${field}`, "must be omitted when mode is skip");
		}
		return;
	}

	// reuse + declared sections is a patch: reconcile the deployed provider at `address` to
	// match them. An omitted section is left untouched, so partial intent stays partial.
	const patch = component.mode === "reuse";
	if (patch) {
		required(component, ["address"], source, name);
		address(component.address, source, `${name}.address`);
	} else {
		if (component.address !== undefined) fail(source, `${name}.address`, "must be omitted when mode is deploy");
		required(component, ["registerOnCore", "creditLine", "roles", "affiliates"], source, name);
	}
	if (component.admin !== undefined) address(component.admin, source, `${name}.admin`);
	if (component.registerOnCore !== undefined) boolean(component.registerOnCore, source, `${name}.registerOnCore`);
	// Init seeds 20s/60s; ControlFacet rejects anything below 10 for either.
	if (component.securityWindow !== undefined) integer(component.securityWindow, source, `${name}.securityWindow`, 10);
	if (component.tolerancePeriod !== undefined) integer(component.tolerancePeriod, source, `${name}.tolerancePeriod`, 10);

	if (component.creditLine !== undefined) {
		const creditLine = object(component.creditLine, source, `${name}.creditLine`);
		onlyKeys(creditLine, ["signatureVerifier", "muonAppId", "muonFreshnessWindow"], source, `${name}.creditLine`);
		required(creditLine, ["signatureVerifier", "muonAppId", "muonFreshnessWindow"], source, `${name}.creditLine`);
		// "fromCore" resolves to the core diamond's configured verifier at execution time, so a
		// standalone Express run cannot drift from the core it is bound to.
		if (creditLine.signatureVerifier !== "fromCore") {
			address(creditLine.signatureVerifier, source, `${name}.creditLine.signatureVerifier`);
		}
		uintString(creditLine.muonAppId, source, `${name}.creditLine.muonAppId`, BigInt(1));
		integer(creditLine.muonFreshnessWindow, source, `${name}.creditLine.muonFreshnessWindow`, 1);
	}

	if (component.roles !== undefined) {
		const roles = object(component.roles, source, `${name}.roles`);
		onlyKeys(roles, EXPRESS_ROLES, source, `${name}.roles`);
		for (const role of EXPRESS_ROLES) {
			if (roles[role] === undefined) continue;
			uniqueAddresses(roles[role], source, `${name}.roles.${role}`);
		}
		// A declared roles section is the complete desired set, so a provider with no operator
		// could never process a withdrawal it accepted.
		if (roles.OPERATOR_ROLE === undefined) fail(source, `${name}.roles.OPERATOR_ROLE`, "is required so accepted withdrawals can be processed");
	}

	if (component.affiliates === undefined) return;
	if (!Array.isArray(component.affiliates) || component.affiliates.length === 0) {
		fail(source, `${name}.affiliates`, "must be a non-empty array");
	}
	const seenAffiliates = new Set();
	for (const [index, entry] of component.affiliates.entries()) {
		const field = `${name}.affiliates[${index}]`;
		const affiliate = object(entry, source, field);
		const affiliateKeys = [
			"address",
			"feeRate",
			"operatorFee",
			"maxDebt",
			"maxDebtBps",
			"minValidatorSignatures",
			"validatorApprovalTimeout",
			"validators",
		];
		onlyKeys(affiliate, affiliateKeys, source, field);
		required(affiliate, ["address", "feeRate", "operatorFee", "maxDebt", "maxDebtBps"], source, field);
		address(affiliate.address, source, `${field}.address`);
		const normalized = affiliate.address.toLowerCase();
		if (seenAffiliates.has(normalized)) fail(source, `${field}.address`, "duplicates an earlier affiliate");
		seenAffiliates.add(normalized);
		// setAffiliateConfig rejects a feeRate above 100%.
		uintString(affiliate.feeRate, source, `${field}.feeRate`, BigInt(0));
		if (BigInt(affiliate.feeRate) > BigInt(BPS_DENOMINATOR)) fail(source, `${field}.feeRate`, `must be <= ${BPS_DENOMINATOR}`);
		uintString(affiliate.operatorFee, source, `${field}.operatorFee`);
		// These become the protocol-side caps (setCreditLineProtocolConfig); the affiliate may
		// only tighten them. 0 means "no limit" on-chain, not "cannot borrow".
		uintString(affiliate.maxDebt, source, `${field}.maxDebt`);
		integer(affiliate.maxDebtBps, source, `${field}.maxDebtBps`);
		if (affiliate.maxDebtBps > BPS_DENOMINATOR) fail(source, `${field}.maxDebtBps`, `must be <= ${BPS_DENOMINATOR}`);
		if (affiliate.validators !== undefined) uniqueAddresses(affiliate.validators, source, `${field}.validators`);
		if (affiliate.minValidatorSignatures !== undefined) {
			integer(affiliate.minValidatorSignatures, source, `${field}.minValidatorSignatures`);
			const available = affiliate.validators?.length ?? 0;
			if (affiliate.minValidatorSignatures > available) {
				fail(
					source,
					`${field}.minValidatorSignatures`,
					`must be <= the ${available} configured validators, or the affiliate can never be served`,
				);
			}
		}
		if (affiliate.validatorApprovalTimeout !== undefined) {
			integer(affiliate.validatorApprovalTimeout, source, `${field}.validatorApprovalTimeout`, 1);
		}
	}
}

function validateAddon(value, source, name, extraField, requireExtraForDeploy) {
	const component = object(value, source, name);
	const allowed = ["mode", "address", ...(extraField ? [extraField] : []), ...(name === "partyB" ? ["adlEnabled"] : [])];
	onlyKeys(component, allowed, source, name);
	const requiredFields = ["mode", ...(name === "partyB" ? ["adlEnabled"] : [])];
	required(component, requiredFields, source, name);
	enumValue(component.mode, COMPONENT_MODES, source, `${name}.mode`);
	if (name === "partyB") boolean(component.adlEnabled, source, "partyB.adlEnabled");

	if (component.mode === "reuse") {
		required(component, ["address"], source, name);
		address(component.address, source, `${name}.address`);
		if (extraField && component[extraField] !== undefined) fail(source, `${name}.${extraField}`, "must be omitted when mode is reuse");
	} else if (component.mode === "deploy") {
		if (component.address !== undefined) fail(source, `${name}.address`, "must be omitted when mode is deploy");
		if (extraField && requireExtraForDeploy) {
			required(component, [extraField], source, name);
			address(component[extraField], source, `${name}.${extraField}`);
		}
	} else {
		if (component.address !== undefined) fail(source, `${name}.address`, "must be omitted when mode is skip");
		if (extraField && component[extraField] !== undefined) fail(source, `${name}.${extraField}`, "must be omitted when mode is skip");
		if (name === "partyB" && component.adlEnabled !== false) fail(source, "partyB.adlEnabled", "must be false when mode is skip");
	}
}

export function parseSecretRef(ref, source = "secret reference") {
	if (typeof ref !== "string") fail(source, "value", "must be a string");
	const match = /^(hardhat-keystore|env):\/\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
	if (!match) {
		fail(source, "value", "must use hardhat-keystore://KEY or env://KEY (inline secret values are forbidden)");
	}
	return Object.freeze({ provider: match[1], key: match[2] });
}

export function validateDeploymentRecipe(value, source = "deployment recipe") {
	const recipe = object(value, source, "recipe");
	const rootKeys = [
		"$schema",
		"apiVersion",
		"kind",
		"name",
		"network",
		"secrets",
		"execution",
		"governance",
		"create2",
		"core",
		"partyB",
		"symbolManager",
		"expressProvider",
	];
	onlyKeys(recipe, rootKeys, source, "recipe");
	required(
		recipe,
		rootKeys.filter(key => key !== "$schema" && key !== "create2"),
		source,
		"recipe",
	);
	if (recipe.$schema !== undefined) string(recipe.$schema, source, "$schema");
	if (recipe.apiVersion !== RECIPE_API_VERSION) fail(source, "apiVersion", `must equal ${JSON.stringify(RECIPE_API_VERSION)}`);
	if (recipe.kind !== "DeploymentRecipe") fail(source, "kind", 'must equal "DeploymentRecipe"');
	if (typeof recipe.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(recipe.name)) {
		fail(source, "name", "must be a safe 1-128 character slug using letters, numbers, dot, underscore, or hyphen");
	}

	const network = object(recipe.network, source, "network");
	onlyKeys(network, ["name", "chainId", "mode"], source, "network");
	required(network, ["name", "chainId", "mode"], source, "network");
	string(network.name, source, "network.name");
	integer(network.chainId, source, "network.chainId", 1);
	enumValue(network.mode, ["live", "fork", "local"], source, "network.mode");

	if (recipe.create2 !== undefined) validateCreate2(recipe.create2, source);

	const secrets = object(recipe.secrets, source, "secrets");
	onlyKeys(secrets, ["deployer", "rpc", "explorer"], source, "secrets");
	for (const key of ["deployer", "rpc", "explorer"]) {
		if (secrets[key] !== undefined) parseSecretRef(secrets[key], `${source}: secrets.${key}`);
	}

	const execution = object(recipe.execution, source, "execution");
	const executionKeys = ["logLevel", "verify", "confirmations", "txTimeoutSeconds", "slowNoticeSeconds", "forkBlockNumber"];
	onlyKeys(execution, executionKeys, source, "execution");
	required(execution, ["logLevel", "verify"], source, "execution");
	enumValue(execution.logLevel, ["silent", "minimal", "verbose"], source, "execution.logLevel");
	boolean(execution.verify, source, "execution.verify");
	if (execution.confirmations !== undefined) {
		integer(execution.confirmations, source, "execution.confirmations", 1);
		if (execution.confirmations > 64) fail(source, "execution.confirmations", "must be <= 64");
	}
	if (execution.txTimeoutSeconds !== undefined) {
		integer(execution.txTimeoutSeconds, source, "execution.txTimeoutSeconds", 30);
		if (execution.txTimeoutSeconds > 86400) fail(source, "execution.txTimeoutSeconds", "must be <= 86400");
	}
	if (execution.slowNoticeSeconds !== undefined) {
		integer(execution.slowNoticeSeconds, source, "execution.slowNoticeSeconds", 5);
		if (execution.slowNoticeSeconds > 86400) fail(source, "execution.slowNoticeSeconds", "must be <= 86400");
	}
	if (execution.forkBlockNumber !== undefined) {
		integer(execution.forkBlockNumber, source, "execution.forkBlockNumber", 1);
		if (network.mode !== "fork") fail(source, "execution.forkBlockNumber", "is only allowed when network.mode is fork");
	}
	const timeout = execution.txTimeoutSeconds ?? DEFAULT_TX_TIMEOUT_SECONDS;
	const slowNotice = execution.slowNoticeSeconds ?? DEFAULT_SLOW_NOTICE_SECONDS;
	if (slowNotice >= timeout) fail(source, "execution.slowNoticeSeconds", "must be less than txTimeoutSeconds");

	if (network.mode === "live") {
		if (!execution.verify) fail(source, "execution.verify", "must be true for live targets");
		if (execution.logLevel === "silent") fail(source, "execution.logLevel", "must be minimal or verbose for live targets");
		required(secrets, ["deployer", "rpc"], source, "secrets");
		required(secrets, ["explorer"], source, "secrets");
	}

	const governance = object(recipe.governance, source, "governance");
	const governanceKeys = [
		"admin",
		"feeReceiver",
		"liquidationInsuranceVault",
		"maxLiquidationProfitPerPosition",
		"softLiquidationPenaltyCollector",
	];
	onlyKeys(governance, governanceKeys, source, "governance");
	required(governance, ["admin"], source, "governance");
	address(governance.admin, source, "governance.admin");
	if (governance.feeReceiver !== undefined) address(governance.feeReceiver, source, "governance.feeReceiver");
	if (governance.liquidationInsuranceVault !== undefined) {
		address(governance.liquidationInsuranceVault, source, "governance.liquidationInsuranceVault");
	}
	if (governance.maxLiquidationProfitPerPosition !== undefined) {
		uintString(governance.maxLiquidationProfitPerPosition, source, "governance.maxLiquidationProfitPerPosition", BigInt(1));
	}
	if (governance.softLiquidationPenaltyCollector !== undefined) {
		address(governance.softLiquidationPenaltyCollector, source, "governance.softLiquidationPenaltyCollector");
	}

	validateCore(recipe.core, source, network.mode);
	if (recipe.core.mode === "deploy") required(governance, governanceKeys, source, "governance");
	validateAddon(recipe.partyB, source, "partyB", "signer", true);
	validateAddon(recipe.symbolManager, source, "symbolManager", "operator", true);
	validateExpressProvider(recipe.expressProvider, source, "expressProvider");

	return JSON.parse(JSON.stringify(recipe));
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

export function recipeDigest(recipe) {
	const intent =
		recipe && typeof recipe === "object" && !Array.isArray(recipe)
			? Object.fromEntries(Object.entries(recipe).filter(([key]) => key !== "$schema"))
			: recipe;
	return createHash("sha256").update(stableSerialize(intent)).digest("hex");
}

export function loadDeploymentRecipe(recipePath, { projectRoot = process.cwd() } = {}) {
	if (typeof recipePath !== "string" || recipePath.trim() === "") throw new Error("deployment recipe path must be a non-empty string");
	const resolvedProjectRoot = path.resolve(projectRoot);
	const absolutePath = path.isAbsolute(recipePath) ? path.normalize(recipePath) : path.resolve(resolvedProjectRoot, recipePath);
	const relativeRecipePath = path.relative(resolvedProjectRoot, absolutePath);
	const identityPath = relativeRecipePath && !relativeRecipePath.startsWith("..") ? relativeRecipePath.split(path.sep).join("/") : absolutePath;
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
	} catch (error) {
		throw new Error(`Failed to load deployment recipe ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const recipe = validateDeploymentRecipe(parsed, absolutePath);
	const recipeOnlyDigest = recipeDigest(recipe);
	const dependencies = {};
	let digest = recipeOnlyDigest;
	if (recipe.core.fromReport) {
		recipe.core.fromReport = path.isAbsolute(recipe.core.fromReport)
			? path.normalize(recipe.core.fromReport)
			: path.resolve(path.dirname(absolutePath), recipe.core.fromReport);
		let reportContents;
		try {
			reportContents = fs.readFileSync(recipe.core.fromReport);
		} catch (error) {
			throw new Error(`Failed to bind core.fromReport ${recipe.core.fromReport}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const reportDigest = createHash("sha256").update(reportContents).digest("hex");
		const relativeReportPath = path.relative(resolvedProjectRoot, recipe.core.fromReport);
		const reportIdentityPath =
			relativeReportPath && !relativeReportPath.startsWith("..") ? relativeReportPath.split(path.sep).join("/") : recipe.core.fromReport;
		dependencies.coreReport = { path: recipe.core.fromReport, identityPath: reportIdentityPath, digest: reportDigest };
		digest = createHash("sha256")
			.update(stableSerialize({ recipe: recipeOnlyDigest, coreReport: reportDigest }))
			.digest("hex");
	}
	return { recipe, path: absolutePath, identityPath, digest, recipeOnlyDigest, dependencies };
}

function dependencyFail(message) {
	const error = new Error(`DEPENDENCY_UNAVAILABLE: ${message}`);
	error.code = "DEPENDENCY_UNAVAILABLE";
	throw error;
}

function dependencyObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) dependencyFail(`${label} must be an object`);
	return value;
}

function dependencyString(record, field, label) {
	const value = record[field];
	if (typeof value !== "string" || value.trim() === "") dependencyFail(`${label}.${field} must be a non-empty string`);
	return value;
}

function dependencyAddress(record, field, label, { optional = false } = {}) {
	const value = record[field];
	if (optional && value === undefined) return undefined;
	if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
		dependencyFail(`${label}.${field} must be a valid non-zero address`);
	}
	return value;
}

/**
 * Validate the durable core report used as the trust boundary for component-only
 * deployment. This is independent of Hardhat so doctor and the task executor reject
 * the same bad proof before an RPC call or transaction.
 */
export function parseCoreDependencyReport(value, expected) {
	const source = expected?.source || "core deployment report";
	if (!expected || typeof expected.network !== "string" || expected.network.trim() === "") {
		dependencyFail("expected network must be a non-empty string");
	}
	if (!Number.isSafeInteger(expected.chainId) || expected.chainId < 1) {
		dependencyFail(`expected chainId must be a positive safe integer; received ${JSON.stringify(expected.chainId)}`);
	}
	if (typeof expected.live !== "boolean") dependencyFail("expected live flag must be a boolean");

	const report = dependencyObject(value, source);
	if (report.network !== expected.network) {
		dependencyFail(`${source} network is ${JSON.stringify(report.network)}, expected ${JSON.stringify(expected.network)}`);
	}
	if (!Number.isSafeInteger(report.chainId) || report.chainId !== expected.chainId) {
		dependencyFail(`${source} chainId is ${JSON.stringify(report.chainId)}, expected ${expected.chainId}`);
	}
	if (report.lifecycle !== "complete" && report.lifecycle !== "pending_handover") {
		dependencyFail(`${source} lifecycle is ${JSON.stringify(report.lifecycle)}; expected complete or pending_handover`);
	}

	const checks = dependencyObject(report.checks, `${source}.checks`);
	if (checks.health !== "passed") dependencyFail(`${source} health gate is ${JSON.stringify(checks.health)}, expected passed`);
	if (checks.verification !== "passed" && checks.verification !== "skipped") {
		dependencyFail(`${source} verification gate is ${JSON.stringify(checks.verification)}; expected passed or skipped`);
	}
	if (!["required", "not_applicable", "explicitly_skipped"].includes(checks.verificationPolicy)) {
		dependencyFail(`${source} verification policy is invalid: ${JSON.stringify(checks.verificationPolicy)}`);
	}
	if (checks.verificationPolicy === "required" && checks.verification !== "passed") {
		dependencyFail(`${source} required explorer-verification gate is ${JSON.stringify(checks.verification)}, expected passed`);
	}
	if (expected.live && (checks.verificationPolicy !== "required" || checks.verification !== "passed")) {
		dependencyFail(
			`${source} live verification proof is incomplete: policy=${JSON.stringify(checks.verificationPolicy)}, status=${JSON.stringify(checks.verification)}`,
		);
	}

	const addresses = dependencyObject(report.addresses, `${source}.addresses`);
	const config = dependencyObject(report.config, `${source}.config`);
	return {
		deploymentId: dependencyString(report, "deploymentId", source),
		network: expected.network,
		chainId: expected.chainId,
		lifecycle: report.lifecycle,
		checks: {
			health: "passed",
			verification: checks.verification,
			verificationPolicy: checks.verificationPolicy,
		},
		deployerAddress: dependencyAddress(report, "deployerAddress", source),
		config: { admin: dependencyAddress(config, "admin", `${source}.config`) },
		addresses: {
			diamond: dependencyAddress(addresses, "diamond", `${source}.addresses`),
			instantLayer: dependencyAddress(addresses, "instantLayer", `${source}.addresses`),
			collateral: dependencyAddress(addresses, "collateral", `${source}.addresses`, { optional: true }),
			signatureVerifier: dependencyAddress(addresses, "signatureVerifier", `${source}.addresses`, { optional: true }),
			accountLayerDiamond: dependencyAddress(addresses, "accountLayerDiamond", `${source}.addresses`, { optional: true }),
		},
	};
}

export function loadCoreDependencyReport(filePath, expected) {
	if (typeof filePath !== "string" || filePath.trim() === "") dependencyFail("core deployment report path must be a non-empty string");
	const absolutePath = path.resolve(filePath);
	let contents;
	try {
		contents = fs.readFileSync(absolutePath, "utf8");
	} catch (error) {
		dependencyFail(`cannot read core deployment report ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const sourceDigest = createHash("sha256").update(contents).digest("hex");
	if (expected?.digest !== undefined && expected.digest !== sourceDigest) {
		dependencyFail(`core deployment report ${absolutePath} changed after recipe confirmation (expected ${expected.digest}, got ${sourceDigest})`);
	}
	let value;
	try {
		value = JSON.parse(contents);
	} catch (error) {
		dependencyFail(`cannot parse core deployment report ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { ...parseCoreDependencyReport(value, { ...expected, source: absolutePath }), sourceDigest };
}

export function createDeploymentPlan(recipeValue, { only } = {}) {
	const recipe = validateDeploymentRecipe(recipeValue);
	if (only !== undefined && !DEPLOYMENT_COMPONENTS.includes(only)) {
		throw new Error(`Unknown deployment component ${JSON.stringify(only)}. Valid components: ${DEPLOYMENT_COMPONENTS.join(", ")}`);
	}
	if (only === "core") {
		const error = new Error(
			'TARGET_MODE_UNSUPPORTED: Core is a system bundle; set partyB.mode, symbolManager.mode, and expressProvider.mode to "skip", then run without --only',
		);
		error.code = "TARGET_MODE_UNSUPPORTED";
		throw error;
	}

	const selectedNames = only ? (only === "core" ? ["core"] : ["core", only]) : [...DEPLOYMENT_COMPONENTS];
	const unsupportedMode = (component, expected) => {
		const error = new Error(
			`TARGET_MODE_UNSUPPORTED: ${component}.mode is ${recipe[component].mode}; this deployment target requires ${expected}`,
		);
		error.code = "TARGET_MODE_UNSUPPORTED";
		throw error;
	};

	if (only === "core") {
		if (recipe.core.mode !== "deploy") unsupportedMode("core", "deploy");
	} else if (only) {
		// ExpressProvider additionally supports reuse-as-patch: reconcile the deployed
		// provider at expressProvider.address to the declared sections.
		const patchable = only === "expressProvider" && recipe.expressProvider.mode === "reuse";
		if (recipe[only].mode !== "deploy" && !patchable) {
			unsupportedMode(only, only === "expressProvider" ? "deploy or reuse (patch)" : "deploy");
		}
		if (recipe.core.mode !== "reuse" || !recipe.core.fromReport) {
			const error = new Error(`Cannot deploy only ${only}: core.mode must be reuse and core.fromReport must prove the target core deployment`);
			error.code = "CORE_DEPENDENCY_UNPROVEN";
			throw error;
		}
	} else {
		if (recipe.core.mode !== "deploy") unsupportedMode("core", "deploy");
		for (const name of DEPLOYMENT_COMPONENTS.slice(1)) {
			if (recipe[name].mode === "reuse") unsupportedMode(name, "deploy or skip");
		}
	}

	return {
		network: { ...recipe.network },
		only: only ?? null,
		components: selectedNames.map(name => ({ name, mode: recipe[name].mode, dependsOn: name === "core" ? [] : ["core"] })),
	};
}

export function recipeEnvironment(recipeValue) {
	const recipe = validateDeploymentRecipe(recipeValue);
	const { core } = recipe;
	const deployCore = core.mode === "deploy";
	const env = {
		ADMIN_PUBLIC_KEY: recipe.governance.admin,
		SYMMIO_FEE_RECEIVER: recipe.governance.feeReceiver ?? "",
		LIQUIDATION_INSURANCE_VAULT: recipe.governance.liquidationInsuranceVault ?? "",
		MAX_LIQUIDATION_PROFIT_PER_POSITION: recipe.governance.maxLiquidationProfitPerPosition ?? "",
		SOFT_LIQUIDATION_PENALTY_COLLECTOR: recipe.governance.softLiquidationPenaltyCollector ?? "",
		COLLATERAL_ADDRESS: deployCore && core.collateral?.mode === "reuse" ? core.collateral.address : "",
		DEPLOY_PARTYB: String(recipe.partyB.mode === "deploy"),
		SET_ADL_ENABLED: String(recipe.partyB.mode === "deploy" && recipe.partyB.adlEnabled),
		PARTYB_SIGNER: recipe.partyB.mode === "deploy" ? recipe.partyB.signer : "",
		DEPLOY_SYMBOL_MANAGER: String(recipe.symbolManager.mode === "deploy"),
		SYMBOL_MANAGER_OPERATOR: recipe.symbolManager.mode === "deploy" ? recipe.symbolManager.operator : "",
		REGISTER_DUMMY_AFFILIATE: String(deployCore && core.registerDummyAffiliate === true),
		SETUP_INSTANT_LAYER_TEMPLATES: String(deployCore && core.setupInstantLayerTemplates === true),
		MUON_SIGNATURE_VERIFIER_ADDRESS: deployCore && core.muon?.mode === "reuse" ? core.muon.address : "",
		DEPLOY_MOCK_VERIFIER: String(deployCore && core.muon?.mode === "mock"),
		MUON_APP_ID: deployCore ? (core.muon?.appId ?? "") : "",
		MUON_UPNL_VALID_TIME: deployCore ? (core.muon?.upnlValidTime ?? "") : "",
		MUON_PRICE_VALID_TIME: deployCore ? (core.muon?.priceValidTime ?? "") : "",
		MUON_PUBLIC_KEY_X: deployCore ? (core.muon?.publicKey?.x ?? "") : "",
		MUON_PUBLIC_KEY_PARITY: deployCore && core.muon?.publicKey !== undefined ? String(core.muon.publicKey.parity) : "",
		MUON_GATEWAY_SIGNERS: deployCore ? (core.muon?.gatewaySigners?.join(",") ?? "") : "",
		MUON_FUNCTION_PERMISSIONS: deployCore ? (core.muon?.permissions?.join(",") ?? "") : "",
		DEPLOY_LOG_LEVEL: recipe.execution.logLevel,
		DEPLOY_CONFIRMATIONS: String(recipe.execution.confirmations ?? DEFAULT_CONFIRMATIONS),
		DEPLOY_TX_TIMEOUT: String(recipe.execution.txTimeoutSeconds ?? DEFAULT_TX_TIMEOUT_SECONDS),
		DEPLOY_SLOW_TX_NOTICE: String(recipe.execution.slowNoticeSeconds ?? DEFAULT_SLOW_NOTICE_SECONDS),
		FORK_BLOCK_NUMBER: recipe.execution.forkBlockNumber === undefined ? "" : String(recipe.execution.forkBlockNumber),
	};
	const secrets = Object.fromEntries(Object.entries(recipe.secrets).map(([name, ref]) => [name, parseSecretRef(ref, `secrets.${name}`)]));
	return { env, secrets };
}
