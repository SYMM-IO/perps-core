import { DEPLOYABLE_CONTRACTS } from "../../deployment/deployableContracts.js";
import { recipeDigest, validateDeploymentRecipe } from "../../deployment/recipe.js";
import { buildInitialRecipe } from "../commands/recipe.js";
import { RECIPE_EXAMPLE } from "../lib/config-guide.js";
import { readCheckpoint, readDeploymentReport, resolveNetwork } from "../lib/context.js";
import { PROJECT_ROOT } from "../lib/paths.js";
import { loadRecipeContext } from "../lib/recipe-context.js";
import { EOA_SIGNER_MODES, SIGNER_MODES, selectSigner } from "../signer/index.js";
import { isAddress } from "ethers";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LABELS = Object.freeze({
	"governance.admin": "Protocol admin address",
	"governance.feeReceiver": "Fee receiver address",
	"governance.liquidationInsuranceVault": "Liquidation insurance vault",
	"governance.softLiquidationPenaltyCollector": "Soft-liquidation penalty collector",
	"create2.factoryAddress": "Reviewed CREATE2 factory",
	"core.collateral.address": "Collateral token address",
	"core.muon.appId": "Muon app ID",
	"core.muon.publicKey.x": "Muon public-key X coordinate",
	"core.muon.gatewaySigners.0": "Muon gateway signer",
	"partyB.signer": "PartyB signer",
	"symbolManager.operator": "SymbolManager operator",
	"expressProvider.creditLine.muonAppId": "ExpressProvider Muon app ID",
	"expressProvider.roles.OPERATOR_ROLE.0": "ExpressProvider operator",
	"expressProvider.roles.LOCKER_ROLE.0": "ExpressProvider locker",
	"expressProvider.roles.UNLOCK_ROLE.0": "ExpressProvider unlock operator",
	"expressProvider.roles.SIGNER_ROLE.0": "ExpressProvider quote signer",
	"expressProvider.affiliates.0.address": "ExpressProvider affiliate",
	"expressProvider.affiliates.0.maxDebt": "ExpressProvider maximum debt in collateral decimals",
});

const EXPRESS_ROLES = Object.freeze([
	"OPERATOR_ROLE",
	"LOCKER_ROLE",
	"SIGNER_ROLE",
	"SETTER_ROLE",
	"FEE_CLAIMER_ROLE",
	"UNLOCK_ROLE",
	"WITHDRAWER_ROLE",
	"PAUSER_ROLE",
]);

const PROTOCOL_FIELDS = Object.freeze([
	["balanceLimitPerUser", "Balance limit per user", "uint-string"],
	["maxWithdrawParts", "Maximum withdrawal parts", "integer"],
	["deallocateCooldown", "Deallocate cooldown in seconds", "integer"],
	["settlementCooldown", "Settlement cooldown in seconds", "integer"],
	["deallocateDebounceTime", "Deallocate debounce time in seconds", "integer"],
	["liquidatorShare", "Liquidator share in fixed-point units", "uint-string"],
	["liquidationTimeout", "Liquidation timeout in seconds", "integer"],
	["forceCancelCooldown", "Force-cancel cooldown in seconds", "integer"],
	["forceCancelCloseCooldown", "Force-cancel-close cooldown in seconds", "integer"],
	["pendingQuotesValidLength", "Pending quotes valid length", "integer"],
	["maxPartyAConnectionLimit", "Maximum PartyA connection count", "integer"],
]);

const LOCAL_RPC = "http://127.0.0.1:8545";

function atomicWrite(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, file);
	} catch (error) {
		try {
			fs.unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

function setAtPath(target, parts, value) {
	let cursor = target;
	for (let index = 0; index < parts.length - 1; index++) cursor = cursor[parts[index]];
	cursor[parts.at(-1)] = value;
}

function placeholders(value, parts = [], found = []) {
	if (typeof value === "string" && value.startsWith("REPLACE_WITH_")) found.push({ path: parts.join("."), parts, placeholder: value });
	else if (Array.isArray(value)) value.forEach((entry, index) => placeholders(entry, [...parts, String(index)], found));
	else if (value && typeof value === "object") Object.entries(value).forEach(([key, entry]) => placeholders(entry, [...parts, key], found));
	return found;
}

function placeholderType(placeholder) {
	return placeholder.includes("ADDRESS") || placeholder.includes("SIGNER") || placeholder.includes("OPERATOR") || placeholder.includes("AFFILIATE")
		? "address"
		: "uint";
}

function isNonZeroAddress(value) {
	return isAddress(value || "") && !/^0x0{40}$/i.test(value);
}

function integerValidator({ minimum = 0, maximum = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
	return value => {
		if (optional && String(value || "").trim() === "") return undefined;
		if (!/^(0|[1-9]\d*)$/.test(String(value || ""))) return "Enter an unsigned base-10 integer";
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return `Enter a value from ${minimum} to ${maximum}`;
	};
}

function uintStringValidator({ positive = false } = {}) {
	return value => {
		const pattern = positive ? /^[1-9]\d*$/ : /^(0|[1-9]\d*)$/;
		if (!pattern.test(String(value || ""))) return positive ? "Enter a positive base-10 integer" : "Enter an unsigned base-10 integer";
	};
}

function addressList(value, { allowEmpty = true } = {}) {
	const entries = String(value || "")
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
	if (!allowEmpty && entries.length === 0) return { error: "Enter at least one address", entries };
	if (entries.some(entry => !isNonZeroAddress(entry))) return { error: "Enter non-zero EVM addresses separated by commas", entries };
	if (new Set(entries.map(entry => entry.toLowerCase())).size !== entries.length) return { error: "Remove duplicate addresses", entries };
	return { entries };
}

async function askAddress(ui, message, current) {
	return ui.text({
		message,
		initialValue: isNonZeroAddress(current) ? current : undefined,
		placeholder: "0x…",
		validate: value => (!isNonZeroAddress(value) ? "Enter a non-zero EVM address" : undefined),
	});
}

async function askUintString(ui, message, current, options) {
	return ui.text({
		message,
		initialValue: current === undefined ? undefined : String(current),
		placeholder: "unsigned integer",
		validate: uintStringValidator(options),
	});
}

async function askInteger(ui, message, current, options) {
	const value = await ui.text({
		message,
		initialValue: current === undefined ? undefined : String(current),
		placeholder: "whole number",
		validate: integerValidator(options),
	});
	return value === null || value === "" ? value : Number(value);
}

async function askAddressList(ui, message, current = [], { allowEmpty = true } = {}) {
	const value = await ui.text({
		message,
		initialValue: current.join(", "),
		placeholder: allowEmpty ? "Leave empty for no holders" : "0x…, 0x…",
		validate: answer => addressList(answer, { allowEmpty }).error,
	});
	return value === null ? null : addressList(value, { allowEmpty }).entries;
}

function relativeReference(fromFile, toFile) {
	let relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join("/");
	if (!relative.startsWith(".")) relative = `./${relative}`;
	return relative;
}

function boundIntentDigest(recipe, outputPath) {
	const recipeOnly = recipeDigest(recipe);
	if (!recipe.core.fromReport) return recipeOnly;
	const reportPath = path.isAbsolute(recipe.core.fromReport)
		? recipe.core.fromReport
		: path.resolve(path.dirname(outputPath), recipe.core.fromReport);
	const reportDigest = createHash("sha256").update(fs.readFileSync(reportPath)).digest("hex");
	return createHash("sha256").update(`{"coreReport":"${reportDigest}","recipe":"${recipeOnly}"}`).digest("hex");
}

async function discoverLocalAccounts(fetchImpl = globalThis.fetch) {
	if (typeof fetchImpl !== "function") throw new Error("This Node runtime cannot query the local Hardhat node");
	let response;
	try {
		response = await fetchImpl(LOCAL_RPC, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] }),
			signal: AbortSignal.timeout(2500),
		});
	} catch (error) {
		throw new Error(`Persistent local Hardhat node is not reachable at ${LOCAL_RPC}. Start it with ./node_modules/.bin/hardhat node`);
	}
	const payload = await response.json();
	const accounts = Array.isArray(payload?.result) ? payload.result.filter(isNonZeroAddress) : [];
	if (accounts.length < 2) throw new Error("The local Hardhat node must expose at least two unlocked accounts");
	return accounts;
}

function applyLocalAccountDefaults(recipe, accounts) {
	const account = index => accounts[Math.min(index, accounts.length - 1)];
	recipe.secrets = {};
	recipe.governance = {
		...recipe.governance,
		admin: account(1),
		feeReceiver: account(1),
		liquidationInsuranceVault: account(1),
		softLiquidationPenaltyCollector: account(1),
	};
	if (recipe.partyB.mode === "deploy") recipe.partyB.signer = account(2);
	if (recipe.symbolManager.mode === "deploy") recipe.symbolManager.operator = account(3);
	if (recipe.expressProvider.mode === "deploy") {
		recipe.expressProvider.creditLine = {
			...recipe.expressProvider.creditLine,
			signatureVerifier: "fromCore",
			muonAppId: "1",
		};
		recipe.expressProvider.roles = {
			...recipe.expressProvider.roles,
			OPERATOR_ROLE: [account(4)],
			LOCKER_ROLE: [account(4)],
			UNLOCK_ROLE: [account(4)],
			SIGNER_ROLE: [account(5)],
		};
		recipe.expressProvider.affiliates = [
			{
				...recipe.expressProvider.affiliates?.[0],
				address: account(6),
				feeRate: recipe.expressProvider.affiliates?.[0]?.feeRate || "0",
				operatorFee: recipe.expressProvider.affiliates?.[0]?.operatorFee || "0",
				maxDebt: "1000000000000000000000000",
				maxDebtBps: recipe.expressProvider.affiliates?.[0]?.maxDebtBps || 5000,
			},
		];
	}
	return recipe;
}

function recipeReviewText(recipe, { identityPath, digest, only } = {}) {
	const roles = recipe.expressProvider.roles || {};
	const roleSummary = Object.entries(roles)
		.filter(([, holders]) => holders.length > 0)
		.map(([name, holders]) => `${name.replace(/_ROLE$/, "")}: ${holders.length}`)
		.join(" • ");
	const affiliateSummary = (recipe.expressProvider.affiliates || [])
		.map(
			(affiliate, index) =>
				`#${index + 1} ${affiliate.address} • debt ${affiliate.maxDebt === "0" ? "unlimited" : affiliate.maxDebt} • ${affiliate.maxDebtBps === 0 ? "unlimited" : `${affiliate.maxDebtBps} bps`}`,
		)
		.join("\n");
	const secretSummary = Object.entries(recipe.secrets)
		.map(([purpose, reference]) => `${purpose}: ${reference}`)
		.join("\n");
	const componentSummary = ["core", "partyB", "symbolManager", "expressProvider"].map(name => `${name}: ${recipe[name].mode}`).join("\n");
	const warnings = [];
	for (const affiliate of recipe.expressProvider.affiliates || []) {
		if (affiliate.maxDebt === "0" && affiliate.maxDebtBps === 0)
			warnings.push(`Affiliate ${affiliate.address} has no debt limit on either axis.`);
	}
	return [
		"TARGET",
		`${recipe.network.name} • chain ${recipe.network.chainId} • ${recipe.network.mode}`,
		`Scope: ${only || "full system"}`,
		`Recipe: ${identityPath || recipe.name}`,
		`Intent digest: ${digest || recipeDigest(recipe)}`,
		"",
		"SIGNING AND EXECUTION",
		secretSummary || "Unlocked accounts supplied by the persistent local node; no secret reference is stored.",
		`${recipe.execution.logLevel} logs • ${recipe.execution.confirmations || 1} confirmation(s) • ${recipe.execution.txTimeoutSeconds || 300}s receipt timeout`,
		`Explorer verification: ${recipe.execution.verify ? "required" : "not applicable"}`,
		"",
		"OWNERSHIP",
		`Admin: ${recipe.governance.admin}`,
		`Fee receiver: ${recipe.governance.feeReceiver || "admin"}`,
		`Insurance vault: ${recipe.governance.liquidationInsuranceVault || "admin"}`,
		"",
		"COMPONENTS",
		componentSummary,
		...(recipe.partyB.signer ? [`PartyB signer: ${recipe.partyB.signer}`] : []),
		...(recipe.symbolManager.operator ? [`SymbolManager operator: ${recipe.symbolManager.operator}`] : []),
		...(recipe.expressProvider.mode !== "skip"
			? [
					`Express timing: ${recipe.expressProvider.securityWindow === undefined ? "unchanged" : `${recipe.expressProvider.securityWindow}s`} security • ${recipe.expressProvider.tolerancePeriod === undefined ? "unchanged" : `${recipe.expressProvider.tolerancePeriod}s`} tolerance`,
					`Express roles: ${roleSummary || "none declared"}`,
					affiliateSummary || "Express affiliates: none declared",
				]
			: []),
		...(warnings.length ? ["", "WARNINGS", ...warnings] : []),
	].join("\n");
}

function reviewText(context, only) {
	return recipeReviewText(context.recipe, { identityPath: context.identityPath, digest: context.digest, only });
}

function removeLegacyRecipeSignerReference(recipe) {
	recipe.secrets ||= {};
	delete recipe.secrets.deployer;
}

async function configureInfrastructureCredentials(ui, recipe) {
	recipe.secrets ||= {};
	if (recipe.network.mode === "local") {
		delete recipe.secrets.rpc;
		delete recipe.secrets.explorer;
		return true;
	}
	const useKeystore = await ui.confirm({ message: "Store RPC and explorer credentials in the Hardhat keystore?", initialValue: true });
	if (useKeystore === null) return false;
	if (!useKeystore) {
		if (recipe.network.mode === "live") {
			ui.note("Live RPC and explorer credentials require encrypted Hardhat keystore references.", "Encrypted credentials required");
			return false;
		}
		recipe.secrets.rpc = `env://RPC_${recipe.network.name.replace(/^fork-/, "").toUpperCase()}`;
		delete recipe.secrets.explorer;
		return true;
	}
	const rpcKey = `RPC_${recipe.network.name.replace(/^fork-/, "").toUpperCase()}`;
	const keys = [rpcKey, ...(recipe.network.mode === "live" ? ["ETHERSCAN_APIKEY"] : [])];
	recipe.secrets.rpc = `hardhat-keystore://${rpcKey}`;
	if (recipe.network.mode === "live") recipe.secrets.explorer = "hardhat-keystore://ETHERSCAN_APIKEY";
	else delete recipe.secrets.explorer;
	const configure = await ui.confirm({
		message: `Configure or refresh ${keys.length === 2 ? "the RPC and explorer values" : "the RPC value"} now?`,
		initialValue: true,
	});
	if (configure === null) return false;
	if (configure) {
		for (const key of keys) {
			const code = await ui.runInteractive("./node_modules/.bin/hardhat", ["keystore", "set", "--force", key]);
			if (code !== 0) throw new Error(`Hardhat keystore did not store ${key}`);
		}
	}
	return true;
}

async function fillRecipe(ui, recipe) {
	const grouped = new Map();
	for (const entry of placeholders(recipe)) {
		if (!grouped.has(entry.placeholder)) grouped.set(entry.placeholder, []);
		grouped.get(entry.placeholder).push(entry);
	}
	let section;
	for (const [placeholder, entries] of grouped) {
		const nextSection = entries[0].parts[0];
		if (nextSection !== section) {
			section = nextSection;
			ui.note(
				"Only values not supplied by the reviewed network profile are requested here.",
				`${section[0].toUpperCase()}${section.slice(1)} required values`,
			);
		}
		const type = placeholderType(placeholder);
		const reused = entries.length > 1 ? ` (used in ${entries.length} fields)` : "";
		const answer = await ui.text({
			message: `${LABELS[entries[0].path] || entries[0].path}${reused}`,
			placeholder: type === "address" ? "0x…" : "unsigned integer",
			validate: value => {
				if (type === "address" && !isNonZeroAddress(value)) return "Enter a non-zero EVM address";
				if (type === "uint") return uintStringValidator()(value);
			},
		});
		if (answer === null) return false;
		for (const entry of entries) setAtPath(recipe, entry.parts, answer);
	}
	return true;
}

async function editExecution(ui, recipe) {
	const logLevel = await ui.select({
		message: "Deployment log detail",
		options: [
			{ value: "verbose", label: "Verbose", hint: "recommended for deployment evidence" },
			{ value: "minimal", label: "Minimal" },
			...(recipe.network.mode === "live" ? [] : [{ value: "silent", label: "Silent", hint: "local automation only" }]),
		],
		initialValue: recipe.execution.logLevel,
	});
	if (logLevel === null) return false;
	const confirmations = await askInteger(ui, "Receipt confirmations", recipe.execution.confirmations || 1, { minimum: 1, maximum: 64 });
	const timeout = await askInteger(ui, "Receipt timeout in seconds", recipe.execution.txTimeoutSeconds || 300, { minimum: 30, maximum: 86400 });
	const slow = await askInteger(ui, "Show a slow-transaction warning after seconds", recipe.execution.slowNoticeSeconds || 30, {
		minimum: 5,
		maximum: 86400,
	});
	if ([confirmations, timeout, slow].some(value => value === null)) return false;
	if (slow >= timeout) {
		ui.note("The slow warning must occur before the receipt timeout.", "Execution values not applied");
		return editExecution(ui, recipe);
	}
	recipe.execution = { ...recipe.execution, logLevel, confirmations, txTimeoutSeconds: timeout, slowNoticeSeconds: slow };
	if (recipe.network.mode === "fork") {
		const block = await askInteger(ui, "Pinned fork block (leave empty for latest)", recipe.execution.forkBlockNumber, {
			minimum: 1,
			optional: true,
		});
		if (block === null) return false;
		if (block === "") delete recipe.execution.forkBlockNumber;
		else recipe.execution.forkBlockNumber = block;
	}
	return true;
}

async function editGovernance(ui, recipe) {
	for (const [field, label] of [
		["admin", "Protocol admin"],
		["feeReceiver", "Fee receiver"],
		["liquidationInsuranceVault", "Liquidation insurance vault"],
		["softLiquidationPenaltyCollector", "Soft-liquidation penalty collector"],
	]) {
		const answer = await askAddress(ui, label, recipe.governance[field]);
		if (answer === null) return false;
		recipe.governance[field] = answer;
	}
	const maxProfit = await askUintString(ui, "Maximum liquidation profit per position", recipe.governance.maxLiquidationProfitPerPosition, {
		positive: true,
	});
	if (maxProfit === null) return false;
	recipe.governance.maxLiquidationProfitPerPosition = maxProfit;
	return true;
}

async function editCreate2(ui, recipe) {
	const previous = structuredClone(recipe.create2 || {});
	const current = !recipe.create2 ? "none" : recipe.create2.factory?.mode === "deploy" ? "deploy" : "reuse";
	const strategy = await ui.select({
		message: "CREATE2 strategy",
		options: [
			{ value: "none", label: "Ordinary CREATE", hint: "fastest; no vanity intent" },
			{ value: "deploy", label: "Deploy a new factory" },
			{ value: "reuse", label: "Reuse a reviewed factory" },
		],
		initialValue: current,
	});
	if (strategy === null) return false;
	if (strategy === "none") {
		delete recipe.create2;
		return true;
	}
	let factory;
	if (strategy === "deploy") factory = { mode: "deploy" };
	else {
		const address = await askAddress(ui, "CREATE2 factory address", recipe.create2?.factory?.address || recipe.create2?.factoryAddress);
		if (address === null) return false;
		factory = { mode: "reuse", address };
	}
	const useVanity = await ui.confirm({ message: "Mine reviewed vanity patterns?", initialValue: Boolean(previous.groups || previous.overrides) });
	if (useVanity === null) return false;
	recipe.create2 = { factory };
	if (!useVanity) return true;
	recipe.create2.groups = {};
	for (const group of ["diamonds", "facets", "libraries", "peripherals"]) {
		const prefix = await ui.text({
			message: `${group} hexadecimal prefix (empty for none)`,
			initialValue: previous.groups?.[group]?.prefix || "",
			validate: value => (value && !/^[0-9a-fA-F]{1,8}$/.test(value) ? "Use 1-8 hexadecimal characters without 0x" : undefined),
		});
		const suffix = await ui.text({
			message: `${group} hexadecimal suffix (empty for none)`,
			initialValue: previous.groups?.[group]?.suffix || "",
			validate: value => (value && !/^[0-9a-fA-F]{1,8}$/.test(value) ? "Use 1-8 hexadecimal characters without 0x" : undefined),
		});
		if (prefix === null || suffix === null) return false;
		if (prefix || suffix) recipe.create2.groups[group] = { ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
	}
	const overrideKeys = await ui.multiselect({
		message: "Contract-specific vanity overrides (optional)",
		options: Object.keys(DEPLOYABLE_CONTRACTS)
			.sort()
			.map(value => ({ value, label: value })),
		required: false,
		initialValues: Object.keys(previous.overrides || {}),
	});
	if (overrideKeys === null) return false;
	if (overrideKeys.length > 0) recipe.create2.overrides = {};
	for (const key of overrideKeys) {
		const prefix = await ui.text({
			message: `${key} hexadecimal prefix (empty for none)`,
			initialValue: previous.overrides?.[key]?.prefix || "",
			validate: value => (value && !/^[0-9a-fA-F]{1,8}$/.test(value) ? "Use 1-8 hexadecimal characters without 0x" : undefined),
		});
		const suffix = await ui.text({
			message: `${key} hexadecimal suffix (empty for none)`,
			initialValue: previous.overrides?.[key]?.suffix || "",
			validate: value => (value && !/^[0-9a-fA-F]{1,8}$/.test(value) ? "Use 1-8 hexadecimal characters without 0x" : undefined),
		});
		if (prefix === null || suffix === null) return false;
		if (!prefix && !suffix) continue;
		recipe.create2.overrides[key] = { ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
	}
	const budget = await askInteger(ui, "Maximum CREATE2 mining attempts", previous.miningBudget || 50_000_000, { minimum: 1 });
	if (budget === null) return false;
	recipe.create2.miningBudget = budget;
	return true;
}

async function editCore(ui, recipe) {
	if (recipe.core.mode !== "deploy") return true;
	const collateralMode = await ui.select({
		message: "Collateral token",
		options: [
			...(recipe.network.mode === "live" ? [] : [{ value: "deploy", label: "Deploy local fake collateral", hint: "local or fork only" }]),
			{ value: "reuse", label: "Reuse an existing ERC-20" },
		],
		initialValue: recipe.core.collateral?.mode,
	});
	if (collateralMode === null) return false;
	recipe.core.collateral = { mode: collateralMode };
	if (collateralMode === "reuse") {
		const collateral = await askAddress(ui, "Collateral token address", recipe.core.collateral.address);
		if (collateral === null) return false;
		recipe.core.collateral.address = collateral;
	}
	const muonMode = await ui.select({
		message: "Muon verifier",
		options: [
			...(recipe.network.mode === "live" ? [] : [{ value: "mock", label: "Mock verifier", hint: "local or fork only" }]),
			{ value: "deploy", label: "Deploy and configure verifier" },
			{ value: "reuse", label: "Reuse an existing verifier" },
		],
		initialValue: recipe.core.muon?.mode,
	});
	if (muonMode === null) return false;
	const upnlValidTime = await askUintString(ui, "Global Muon UPNL validity in seconds", recipe.core.muon?.upnlValidTime || "60", {
		positive: true,
	});
	const priceValidTime = await askUintString(ui, "Muon price validity in seconds", recipe.core.muon?.priceValidTime || "60", { positive: true });
	if (upnlValidTime === null || priceValidTime === null) return false;
	if (muonMode === "mock") recipe.core.muon = { mode: "mock", upnlValidTime, priceValidTime };
	else {
		const appId = await askUintString(ui, "Muon application ID", recipe.core.muon?.appId, { positive: true });
		if (appId === null) return false;
		const permissions = [
			"Trading",
			"AccountManagement",
			"Settlement",
			"ForceClose",
			"Funding",
			"LiquidationPartyA",
			"LiquidationPartyB",
			"RemoveMargin",
			"ExpressCredit",
		];
		if (muonMode === "reuse") {
			const address = await askAddress(ui, "Existing Muon verifier address", recipe.core.muon?.address);
			if (address === null) return false;
			recipe.core.muon = { mode: "reuse", address, appId, upnlValidTime, priceValidTime, permissions };
		} else {
			const publicKeyX = await askUintString(ui, "Muon public-key X coordinate", recipe.core.muon?.publicKey?.x, { positive: true });
			const parity = await ui.select({
				message: "Muon public-key parity",
				options: [
					{ value: 0, label: "0" },
					{ value: 1, label: "1" },
				],
				initialValue: recipe.core.muon?.publicKey?.parity || 0,
			});
			const gateways = await askAddressList(ui, "Muon gateway signers", recipe.core.muon?.gatewaySigners || [], { allowEmpty: false });
			if (publicKeyX === null || parity === null || gateways === null) return false;
			recipe.core.muon = {
				mode: "deploy",
				appId,
				upnlValidTime,
				priceValidTime,
				publicKey: { x: publicKeyX, parity },
				gatewaySigners: gateways,
				permissions,
			};
		}
	}
	const setupTemplates = await ui.confirm({
		message: "Install the reviewed InstantLayer templates?",
		initialValue: recipe.core.setupInstantLayerTemplates !== false,
	});
	if (setupTemplates === null) return false;
	recipe.core.setupInstantLayerTemplates = setupTemplates;
	if (recipe.network.mode !== "live") {
		const dummyAffiliate = await ui.confirm({
			message: "Register the local test affiliate?",
			initialValue: recipe.core.registerDummyAffiliate === true,
		});
		if (dummyAffiliate === null) return false;
		recipe.core.registerDummyAffiliate = dummyAffiliate;
	}
	return true;
}

async function editProtocol(ui, recipe) {
	if (recipe.core.mode !== "deploy" || !recipe.core.protocol) return true;
	ui.note(
		"Only select this section when governance intentionally approved values different from the reviewed profile. Template operation arrays remain the named reviewed preset.",
		"Protocol override",
	);
	const parameters = recipe.core.protocol.parameters;
	for (const [field, label, type] of PROTOCOL_FIELDS) {
		const answer =
			type === "integer"
				? await askInteger(ui, label, parameters[field], { minimum: field === "deallocateDebounceTime" ? 0 : 1 })
				: await askUintString(ui, label, parameters[field]);
		if (answer === null) return false;
		parameters[field] = answer;
	}
	const first = await askInteger(ui, "Force-close first cooldown in seconds", parameters.forceCloseCooldowns[0], { minimum: 1 });
	const second = await askInteger(ui, "Force-close second cooldown in seconds", parameters.forceCloseCooldowns[1], { minimum: 1 });
	if (first === null || second === null) return false;
	parameters.forceCloseCooldowns = [first, second];
	return true;
}

async function editComponents(ui, recipe) {
	if (recipe.partyB.mode === "deploy") {
		const signer = await askAddress(ui, "PartyB signer", recipe.partyB.signer);
		const adl = await ui.confirm({ message: "Enable PartyB ADL?", initialValue: recipe.partyB.adlEnabled === true });
		if (signer === null || adl === null) return false;
		recipe.partyB.signer = signer;
		recipe.partyB.adlEnabled = adl;
	}
	if (recipe.symbolManager.mode === "deploy") {
		const operator = await askAddress(ui, "SymbolManager operator", recipe.symbolManager.operator);
		if (operator === null) return false;
		recipe.symbolManager.operator = operator;
	}
	return true;
}

async function editExpressSections(ui, recipe, sections) {
	const express = recipe.expressProvider;
	if (sections.has("timing")) {
		const securityWindow = await askInteger(ui, "ExpressProvider security window in seconds", express.securityWindow || 20, { minimum: 10 });
		const tolerancePeriod = await askInteger(ui, "ExpressProvider tolerance period in seconds", express.tolerancePeriod || 60, { minimum: 10 });
		if (securityWindow === null || tolerancePeriod === null) return false;
		express.securityWindow = securityWindow;
		express.tolerancePeriod = tolerancePeriod;
	}
	if (sections.has("creditLine")) {
		const verifierMode = await ui.select({
			message: "Credit-line signature verifier",
			options: [
				{ value: "fromCore", label: "Use the verifier configured on Core", hint: "recommended" },
				{ value: "custom", label: "Use another reviewed verifier address" },
			],
			initialValue: express.creditLine?.signatureVerifier === "fromCore" ? "fromCore" : "custom",
		});
		if (verifierMode === null) return false;
		let signatureVerifier = "fromCore";
		if (verifierMode === "custom") {
			signatureVerifier = await askAddress(ui, "Credit-line verifier address", express.creditLine?.signatureVerifier);
			if (signatureVerifier === null) return false;
		}
		const muonAppId = await askUintString(ui, "ExpressProvider Muon application ID", express.creditLine?.muonAppId, { positive: true });
		const freshness = await askInteger(ui, "Credit-line Muon freshness window in seconds", express.creditLine?.muonFreshnessWindow || 300, {
			minimum: 1,
		});
		if (muonAppId === null || freshness === null) return false;
		express.creditLine = { signatureVerifier, muonAppId, muonFreshnessWindow: freshness };
	}
	if (sections.has("roles")) {
		ui.note(
			"Each list is the complete desired holder set. Leaving an optional role empty omits it from the desired set and revokes holders known from the last applied component report. At least one operator remains required.",
			"Authoritative role sets",
		);
		const currentRoles = express.roles || {};
		const nextRoles = {};
		for (const role of EXPRESS_ROLES) {
			const holders = await askAddressList(ui, role.replace(/_/g, " "), currentRoles[role] || [], { allowEmpty: role !== "OPERATOR_ROLE" });
			if (holders === null) return false;
			if (holders.length > 0) nextRoles[role] = holders;
		}
		express.roles = nextRoles;
	}
	if (sections.has("affiliates")) {
		const count = await askInteger(ui, "Number of authoritative affiliates", express.affiliates?.length || 1, { minimum: 1, maximum: 100 });
		if (count === null) return false;
		const affiliates = [];
		for (let index = 0; index < count; index++) {
			const current = express.affiliates?.[index] || {};
			ui.note(
				"A zero value means unlimited, not disabled. Removed affiliates are warn-only and must be handled by governance policy.",
				`Affiliate ${index + 1}`,
			);
			const address = await askAddress(ui, "Affiliate address", current.address);
			const feeRate = await askUintString(ui, "Affiliate fee rate", current.feeRate || "0");
			const operatorFee = await askUintString(ui, "Affiliate operator fee", current.operatorFee || "0");
			const maxDebt = await askUintString(ui, "Maximum absolute debt (0 = unlimited)", current.maxDebt || "0");
			const maxDebtBps = await askInteger(ui, "Maximum debt in basis points (0 = unlimited)", current.maxDebtBps ?? 0, {
				minimum: 0,
				maximum: 10_000,
			});
			const validators = await askAddressList(ui, "Validator addresses (optional)", current.validators || []);
			if ([address, feeRate, operatorFee, maxDebt, maxDebtBps, validators].some(value => value === null)) return false;
			let validatorPolicy = {};
			if (validators.length > 0) {
				const minimum = await askInteger(ui, "Minimum validator signatures", current.minValidatorSignatures ?? 1, {
					minimum: 0,
					maximum: validators.length,
				});
				const approvalTimeout = await askInteger(ui, "Validator approval timeout in seconds", current.validatorApprovalTimeout ?? 300, {
					minimum: 1,
				});
				if (minimum === null || approvalTimeout === null) return false;
				validatorPolicy = { validators, minValidatorSignatures: minimum, validatorApprovalTimeout: approvalTimeout };
			}
			affiliates.push({ address, feeRate, operatorFee, maxDebt, maxDebtBps, ...validatorPolicy });
		}
		express.affiliates = affiliates;
	}
	if (sections.has("registerOnCore")) {
		const registerOnCore = await ui.confirm({ message: "Register this ExpressProvider on Core?", initialValue: express.registerOnCore === true });
		if (registerOnCore === null) return false;
		express.registerOnCore = registerOnCore;
	}
	return true;
}

async function customizeRecipe(ui, recipe, { only, forceSelection = false } = {}) {
	const options = [
		{ value: "execution", label: "Execution and receipt policy", hint: "confirmations, timeouts, log detail" },
		{ value: "governance", label: "Governance and fee destinations" },
		...(recipe.core.mode === "deploy"
			? [
					{ value: "create2", label: "CREATE2 and vanity addresses" },
					{ value: "core", label: "Collateral, Muon, and Core switches" },
					{ value: "protocol", label: "Protocol parameter overrides", hint: "reviewed defaults are recommended" },
				]
			: []),
		...(only === "expressProvider" ? [] : [{ value: "components", label: "PartyB and SymbolManager assignments" }]),
		...(recipe.expressProvider.mode !== "skip" ? [{ value: "express", label: "ExpressProvider configuration" }] : []),
	];
	const selection = await ui.multiselect({
		message: forceSelection ? "Which sections do you want to edit?" : "Anything you want to override before the final review?",
		options,
		required: forceSelection,
	});
	if (selection === null) return false;
	const selected = new Set(selection);
	if (selected.has("execution") && !(await editExecution(ui, recipe))) return false;
	if (selected.has("governance") && !(await editGovernance(ui, recipe))) return false;
	if (selected.has("create2") && !(await editCreate2(ui, recipe))) return false;
	if (selected.has("core") && !(await editCore(ui, recipe))) return false;
	if (selected.has("protocol") && !(await editProtocol(ui, recipe))) return false;
	if (selected.has("components") && !(await editComponents(ui, recipe))) return false;
	if (
		selected.has("express") &&
		!(await editExpressSections(ui, recipe, new Set(["timing", "creditLine", "roles", "affiliates", "registerOnCore"])))
	)
		return false;
	return true;
}

export async function prepareDeploymentRecipe({ root = PROJECT_ROOT, ui, only, coreBundle = false, discoverAccounts = discoverLocalAccounts }) {
	const network = await ui.select({
		message: "Where do you want to deploy?",
		options: [
			{ value: "localhost", label: "Persistent local Hardhat node", hint: "recommended first rehearsal • no secrets" },
			{ value: "fork-arbitrum", label: "Arbitrum fork", hint: "safe rehearsal" },
			{ value: "arbitrum", label: "Arbitrum One", hint: "live transactions" },
		],
		initialValue: "localhost",
	});
	if (network === null) return null;
	const chain = resolveNetwork(network);
	ui.note(
		"Contract creation must be signed by a wallet or Ledger. If governance is a Safe, the live workflow prepares its handover separately after deployment.",
		"Two signing roles",
	);
	const signer = await selectSigner(ui, {
		role: "Deployment transaction signer",
		allowedModes: EOA_SIGNER_MODES,
		initialMode: network === "localhost" ? SIGNER_MODES.LOCAL_NODE : SIGNER_MODES.KEYSTORE,
		network,
		chainId: chain.chainId,
	});
	if (!signer) return null;
	const defaultFile = path.join(root, "deployments", `${network}${only ? `-${only}` : coreBundle ? "-core" : ""}.json`);
	const outputPath = defaultFile;
	let recipe;
	let replacing = fs.existsSync(defaultFile);
	if (fs.existsSync(defaultFile)) {
		const choice = await ui.select({
			message: "A reviewed recipe already exists for this scope",
			options: [
				{ value: "use", label: "Review and use it exactly", hint: path.relative(root, defaultFile) },
				{ value: "edit", label: "Edit it interactively", hint: "choose only the sections you want to override" },
				{ value: "defaults", label: "Start again from reviewed defaults", hint: "the old recipe is backed up after confirmation" },
			],
			initialValue: "use",
		});
		if (choice === null) return null;
		if (choice === "use") {
			const context = loadRecipeContext(defaultFile, { only });
			ui.note(reviewText(context, only), "Final review");
			if (!(await ui.confirm({ message: "Use this exact reviewed intent?", initialValue: true }))) return null;
			return { ...(await deploymentInput(context, only, root, ui)), signer };
		}
		if (choice === "edit") {
			recipe = structuredClone(loadRecipeContext(defaultFile, { only }).recipe);
			if (!(await customizeRecipe(ui, recipe, { only, forceSelection: true }))) return null;
		}
	}
	if (!recipe) {
		const source = JSON.parse(fs.readFileSync(RECIPE_EXAMPLE, "utf8"));
		recipe = buildInitialRecipe(network, source, { sourcePath: RECIPE_EXAMPLE, outputPath, only });
		if (coreBundle) {
			recipe.name = `${network}-core`;
			recipe.partyB = { mode: "skip", adlEnabled: false };
			recipe.symbolManager = { mode: "skip" };
			recipe.expressProvider = { mode: "skip" };
		}
		if (network === "localhost") {
			const accounts = await discoverAccounts();
			applyLocalAccountDefaults(recipe, accounts);
			ui.note(
				[
					`Deployer: ${accounts[0]}`,
					`Governance admin: ${recipe.governance.admin}`,
					`PartyB signer: ${recipe.partyB.signer || "not deployed"}`,
					`SymbolManager operator: ${recipe.symbolManager.operator || "not deployed"}`,
					"These are unlocked, pre-funded accounts exposed only by the persistent local node.",
				].join("\n"),
				"Detected local accounts",
			);
		}
		removeLegacyRecipeSignerReference(recipe);
		if (!(await configureInfrastructureCredentials(ui, recipe))) return null;
		if (!(await fillRecipe(ui, recipe))) return null;
		if (!(await customizeRecipe(ui, recipe, { only }))) return null;
	}
	removeLegacyRecipeSignerReference(recipe);
	recipe = validateDeploymentRecipe(recipe, "interactive deployment form");
	ui.note(
		recipeReviewText(recipe, { identityPath: path.relative(root, outputPath), digest: boundIntentDigest(recipe, outputPath), only }),
		"Final deployment review",
	);
	if (!(await ui.confirm({ message: "Create the task with this exact reviewed intent?", initialValue: true }))) return null;
	if (replacing) fs.copyFileSync(defaultFile, `${defaultFile}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	atomicWrite(outputPath, recipe);
	const context = loadRecipeContext(outputPath, { only });
	return { ...(await deploymentInput(context, only, root, ui)), signer };
}

async function deploymentInput(context, only, root, ui, { patch = false } = {}) {
	const chain = resolveNetwork(context.networkName);
	let importLegacy = false;
	if (!patch && !only) {
		const legacy = readCheckpoint(chain.chainId, { simulated: context.recipe.network.mode === "fork" });
		const validIncomplete =
			legacy &&
			!legacy._corrupt &&
			legacy.step !== "complete" &&
			legacy.recipeDigest === context.digest &&
			Number(legacy.chainId) === chain.chainId;
		if (validIncomplete) {
			importLegacy =
				(await ui.confirm({
					message: `Import incomplete legacy deployment ${legacy.deploymentId} at step ${legacy.step}?`,
					initialValue: false,
				})) === true;
		}
	}
	let rehearsalConfig;
	if (context.recipe.network.mode === "live") {
		const rehearsal = structuredClone(context.recipe);
		rehearsal.name = `${context.recipe.name}-rehearsal`;
		rehearsal.network = { ...rehearsal.network, name: `fork-${context.recipe.network.name}`, mode: "fork" };
		rehearsal.execution = { ...rehearsal.execution, verify: false };
		if (rehearsal.core.mode === "reuse" && rehearsal.core.fromReport) {
			const liveDependency = JSON.parse(fs.readFileSync(rehearsal.core.fromReport, "utf8"));
			liveDependency.network = rehearsal.network.name;
			const dependencyPath = path.join(root, ".symmio", "tasks", "recipes", "dependencies", `${rehearsal.name}-core-report.json`);
			atomicWrite(dependencyPath, liveDependency);
			rehearsal.core.fromReport = dependencyPath;
		}
		rehearsalConfig = path.join(root, ".symmio", "tasks", "recipes", `${rehearsal.name}.json`);
		atomicWrite(rehearsalConfig, rehearsal);
	}
	const rehearsalDigest = rehearsalConfig ? loadRecipeContext(rehearsalConfig, { only }).digest : undefined;
	return {
		config: context.path,
		recipeDigest: context.digest,
		network: context.networkName,
		chainId: chain.chainId,
		mode: context.recipe.network.mode,
		only,
		rehearsalConfig,
		rehearsalDigest,
		importLegacy,
		patch,
	};
}

export async function prepareExpressPatch({ root = PROJECT_ROOT, ui, readReport = readDeploymentReport }) {
	const candidates = [
		{ network: "localhost", chainId: 31337, mode: "local" },
		{ network: "fork-arbitrum", chainId: 42161, mode: "fork" },
		{ network: "arbitrum", chainId: 42161, mode: "live" },
	]
		.map(candidate => {
			const recipePath = path.join(root, "deployments", `${candidate.network}.json`);
			const reportPath = path.join(
				root,
				"tasks",
				"data",
				`${candidate.chainId}${candidate.mode === "fork" ? "-fork" : ""}`,
				"deployment-report.json",
			);
			if (!fs.existsSync(recipePath) || !fs.existsSync(reportPath)) return null;
			const report = readReport(candidate.chainId, { simulated: candidate.mode === "fork" });
			if (!report?.addresses?.expressProvider) return null;
			return { ...candidate, recipePath, reportPath, report };
		})
		.filter(Boolean);
	if (candidates.length === 0) throw new Error("No recipe-bound deployment report with an ExpressProvider is available to patch");
	const selectedPath = await ui.select({
		message: "Which deployed ExpressProvider do you want to reconcile?",
		options: candidates.map(candidate => ({
			value: candidate.recipePath,
			label: candidate.network,
			hint: `${candidate.report.lifecycle} • ${candidate.report.addresses.expressProvider}`,
		})),
		initialValue: candidates[0].recipePath,
	});
	if (selectedPath === null) return null;
	const selected = candidates.find(candidate => candidate.recipePath === selectedPath);
	const basePath = selected.recipePath;
	const base = loadRecipeContext(basePath, { plan: false });
	const report = selected.report;
	const sections = await ui.multiselect({
		message: "Which ExpressProvider sections are authoritative in this patch?",
		options: [
			{ value: "roles", label: "Roles", hint: "grants and revokes against last applied report" },
			{ value: "creditLine", label: "Credit-line verifier and Muon settings" },
			{ value: "timing", label: "Security window and tolerance period" },
			{ value: "affiliates", label: "Affiliate configuration and debt caps" },
			{ value: "registerOnCore", label: "Core registration" },
		],
		required: true,
	});
	if (sections === null) return null;
	const recipe = structuredClone(base.recipe);
	recipe.name = `${selected.network}-expressProvider-patch`;
	recipe.governance = { admin: base.recipe.governance.admin };
	const outputPath = path.join(root, "deployments", `${selected.network}-expressProvider-patch.json`);
	recipe.core = { mode: "reuse", fromReport: relativeReference(outputPath, selected.reportPath) };
	recipe.partyB = { mode: "skip", adlEnabled: false };
	recipe.symbolManager = { mode: "skip" };
	const source = base.recipe.expressProvider;
	recipe.expressProvider = { mode: "reuse", address: report.addresses.expressProvider };
	for (const section of sections) {
		if (section === "timing") {
			recipe.expressProvider.securityWindow = source.securityWindow;
			recipe.expressProvider.tolerancePeriod = source.tolerancePeriod;
		} else recipe.expressProvider[section] = structuredClone(source[section]);
	}
	if (!(await editExpressSections(ui, recipe, new Set(sections)))) return null;
	const keepSecrets = await ui.confirm({ message: "Keep the RPC and explorer references from the base deployment?", initialValue: true });
	if (keepSecrets === null) return null;
	if (!keepSecrets && !(await configureInfrastructureCredentials(ui, recipe))) return null;
	const validated = validateDeploymentRecipe(recipe, "interactive ExpressProvider patch form");
	ui.note(
		`${recipeReviewText(validated, {
			identityPath: path.relative(root, outputPath),
			digest: boundIntentDigest(validated, outputPath),
			only: "ExpressProvider patch",
		})}\n\nDeclared sections are authoritative. Role removals become revocations when authority permits; unauthorized mutations become Safe actions. Debt cap 0 means unlimited, not disabled. Removed affiliates remain warn-only by design.`,
		"Authoritative patch review",
	);
	if (!(await ui.confirm({ message: "Apply this exact patch intent?", initialValue: false }))) return null;
	if (fs.existsSync(outputPath)) fs.copyFileSync(outputPath, `${outputPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	atomicWrite(outputPath, validated);
	const context = loadRecipeContext(outputPath, { only: "expressProvider" });
	return deploymentInput(context, "expressProvider", root, ui, { patch: true });
}

export { applyLocalAccountDefaults, atomicWrite, discoverLocalAccounts, recipeReviewText, reviewText };
