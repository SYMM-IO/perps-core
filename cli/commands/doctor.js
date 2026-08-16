// `symmio doctor` — everything that should be true BEFORE you spend gas.
//
// The audit that motivated this CLI found that the expensive failures were operator
// failures, not code failures: a variable the config never reads, a mock verifier left
// enabled, a collateral address nobody set. Every check here corresponds to a way a real
// deployment has been or could be silently ruined.
import { doctorNextStepLines, recipeDiagnostic, runtimeConfigurationRows } from "../lib/config-guide.js";
import {
	KNOWN_COLLATERAL,
	UNSAFE_DEPLOYERS,
	isMainnet,
	isLiveMainnet,
	loadEnv,
	makeProvider,
	deploymentCheckpointPath,
	readCheckpoint,
	resolveDeployer,
	resolveNetwork,
	rpcEnvKey,
	resolveRpc,
	verificationProviderForChain,
} from "../lib/context.js";
import { checkFacetMirrorDrift } from "../lib/facets-mirror.js";
import {
	checkMuonFunctionMirrorDrift,
	inspectMuonFunctionAuthorizations,
	muonAuthorizationVerdict,
	parseMuonFunctionPermissions,
} from "../lib/muon-permissions.js";
import { projectPath } from "../lib/paths.js";
import { assertRecipeNetworkCompatibility, loadCoreDependencyReport, loadRecipeContext } from "../lib/recipe-context.js";
import { checkMirrorDrift } from "../lib/safety-mirror.js";
import { blank, c, fail, info, kv, log, ok, skip, title, warn } from "../lib/ui.js";
import { Contract, Wallet, getAddress, isAddress } from "ethers";
import fs from "node:fs";

const ERC20 = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const MUON_VERIFIER = [
	"function SETTER_ROLE() view returns (bytes32)",
	"function hasRole(bytes32,address) view returns (bool)",
	"function getAllPublicKeys() view returns (tuple(uint256 x,uint8 parity)[])",
	"function getAllGatewaySigners() view returns (address[])",
	"function isPublicKeyAuthorized(tuple(uint256 x,uint8 parity),uint8) view returns (bool)",
	"function isGatewaySignerAuthorized(address,uint8) view returns (bool)",
];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function parseRpcChainId(value) {
	if (typeof value !== "string" || !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
		throw new Error(`invalid eth_chainId response: ${JSON.stringify(value)}`);
	}
	const parsed = BigInt(value);
	if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`eth_chainId is out of range: ${value}`);
	return Number(parsed);
}

function enabledByDefault(env, name, defaultValue) {
	return env[name] === undefined || env[name] === "" ? defaultValue : env[name] === "true";
}

function isPositiveDecimal(value) {
	return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function isNonZeroAddress(value) {
	return isAddress(value) && value.toLowerCase() !== ZERO_ADDRESS;
}

export function isMainnetAdminDeployer(admin, deployerAddress, mainnet) {
	return Boolean(mainnet && admin && deployerAddress && admin.toLowerCase() === deployerAddress.toLowerCase());
}

export function deploymentComponentProblems(env) {
	const deployPartyB = enabledByDefault(env, "DEPLOY_PARTYB", true);
	const deploySymbolManager = enabledByDefault(env, "DEPLOY_SYMBOL_MANAGER", true);
	const problems = [];
	if (deployPartyB) {
		if (!env.PARTYB_SIGNER) problems.push(["PARTYB_SIGNER is required when DEPLOY_PARTYB=true", "set the production ERC-1271 signer address"]);
		else if (!isNonZeroAddress(env.PARTYB_SIGNER)) problems.push(["PARTYB_SIGNER is not a valid non-zero address", env.PARTYB_SIGNER]);
	} else {
		if (env.PARTYB_SIGNER) problems.push(["PARTYB_SIGNER is set while DEPLOY_PARTYB=false", "remove it or enable PartyB"]);
		if (env.SET_ADL_ENABLED === "true")
			problems.push(["SET_ADL_ENABLED=true while DEPLOY_PARTYB=false", "ADL configuration has no PartyB target"]);
	}
	if (deploySymbolManager) {
		if (!env.SYMBOL_MANAGER_OPERATOR) {
			problems.push([
				"SYMBOL_MANAGER_OPERATOR is required when DEPLOY_SYMBOL_MANAGER=true",
				"the manager would otherwise have no adder/remover operator",
			]);
		} else if (!isNonZeroAddress(env.SYMBOL_MANAGER_OPERATOR)) {
			problems.push(["SYMBOL_MANAGER_OPERATOR is not a valid non-zero address", env.SYMBOL_MANAGER_OPERATOR]);
		}
	} else if (env.SYMBOL_MANAGER_OPERATOR) {
		problems.push(["SYMBOL_MANAGER_OPERATOR is set while DEPLOY_SYMBOL_MANAGER=false", "remove it or enable SymbolManager"]);
	}
	return { deployPartyB, deploySymbolManager, problems };
}

export function deploymentAccountingProblems(env, { productionShape = false } = {}) {
	const problems = [];
	for (const [name, purpose] of [
		["LIQUIDATION_INSURANCE_VAULT", "receives liquidation profit above the per-position cap"],
		["SOFT_LIQUIDATION_PENALTY_COLLECTOR", "receives non-zero soft-liquidation penalties"],
	]) {
		if (!env[name]) {
			if (productionShape) problems.push([`${name} is required for mainnet deployments and rehearsals`, purpose]);
		} else if (!isNonZeroAddress(env[name])) {
			problems.push([`${name} is not a valid non-zero address`, env[name]]);
		}
	}
	if (!env.MAX_LIQUIDATION_PROFIT_PER_POSITION) {
		if (productionShape) {
			problems.push([
				"MAX_LIQUIDATION_PROFIT_PER_POSITION is required for mainnet deployments and rehearsals",
				"use the reviewed 18-decimal per-position cap",
			]);
		}
	} else if (!isPositiveDecimal(env.MAX_LIQUIDATION_PROFIT_PER_POSITION)) {
		problems.push(["MAX_LIQUIDATION_PROFIT_PER_POSITION must be a positive base-10 integer", env.MAX_LIQUIDATION_PROFIT_PER_POSITION]);
	} else if (BigInt(env.MAX_LIQUIDATION_PROFIT_PER_POSITION) > (1n << 256n) - 1n) {
		problems.push(["MAX_LIQUIDATION_PROFIT_PER_POSITION must fit in uint256", env.MAX_LIQUIDATION_PROFIT_PER_POSITION]);
	}
	return problems;
}

/**
 * Missing verifier configuration is repairable only when the actual deployment signer is
 * known to hold SETTER_ROLE. A keystore signer has no address in this dependency-free CLI,
 * so lack of an address is "deferred", never evidence that the signer lacks the role.
 */
export function verifierRepairAuthorityVerdict(repairItems, deployerAddress, hasSetterRole) {
	if (repairItems.length === 0) return "ok";
	if (!deployerAddress || typeof hasSetterRole !== "boolean") return "deferred";
	return muonAuthorizationVerdict(repairItems, hasSetterRole);
}

/** Describe what deploy:system will do with the current checkpoint. */
export function checkpointDisposition(checkpoint, { fresh = false, target = "deploy:system" } = {}) {
	if (!checkpoint) return { kind: "none", message: `no in-progress ${target} checkpoint — this would be a fresh deployment` };
	if (checkpoint._corrupt) return { kind: "corrupt", message: "checkpoint file is unreadable", detail: checkpoint._path };
	if (checkpoint._scopeMismatch) {
		return {
			kind: "mismatch",
			message: "checkpoint scope does not match the selected deployment",
			detail: `${checkpoint._path}; expected ${checkpoint._expectedScope ?? "system"}, got ${checkpoint._actualScope ?? "system"}`,
		};
	}
	if (fresh) {
		return {
			kind: "archive",
			message: `a ${target} checkpoint exists — --fresh will archive it and start a new deployment`,
			detail: checkpoint._path,
		};
	}
	return {
		kind: "resume",
		message: `a checkpoint exists — ${target} would RESUME, not start fresh`,
		detail: checkpoint._path,
	};
}

const CORE_ONLY_GUIDANCE = "Core is a system bundle; choose Core bundle in the operator menu instead of a primitive component target";

export function assertDoctorSelectionSupported(only) {
	if (only === "core") throw new Error(CORE_ONLY_GUIDANCE);
}

export function isPartialAddonPreflight(recipeContext, only) {
	return Boolean(recipeContext && (only === "partyB" || only === "symbolManager" || only === "expressProvider"));
}

export function doctorCheckpointScope(recipeContext, only) {
	if (!isPartialAddonPreflight(recipeContext, only)) return undefined;
	return `component-${recipeContext.recipe.name}-${only}`;
}

export function deploymentComponentProblemsForSelection(env, only) {
	if (!only) return deploymentComponentProblems(env);
	const problems = [];
	if (only === "partyB") {
		if (!env.PARTYB_SIGNER) problems.push(["PARTYB_SIGNER is required when DEPLOY_PARTYB=true", "set the production ERC-1271 signer address"]);
		else if (!isNonZeroAddress(env.PARTYB_SIGNER)) problems.push(["PARTYB_SIGNER is not a valid non-zero address", env.PARTYB_SIGNER]);
		return { deployPartyB: true, deploySymbolManager: false, problems };
	}
	if (only === "symbolManager") {
		if (!env.SYMBOL_MANAGER_OPERATOR) {
			problems.push([
				"SYMBOL_MANAGER_OPERATOR is required when DEPLOY_SYMBOL_MANAGER=true",
				"the manager would otherwise have no adder/remover operator",
			]);
		} else if (!isNonZeroAddress(env.SYMBOL_MANAGER_OPERATOR)) {
			problems.push(["SYMBOL_MANAGER_OPERATOR is not a valid non-zero address", env.SYMBOL_MANAGER_OPERATOR]);
		}
		return { deployPartyB: false, deploySymbolManager: true, problems };
	}
	return deploymentComponentProblems(env);
}

export function resolveDoctorRecipeContext(args, runtime = {}, loader = loadRecipeContext) {
	assertDoctorSelectionSupported(args.only);
	if (!args.config) return null;
	const context = runtime.recipeContext || loader(args.config, { only: args.only });
	if (!context.plan) throw new Error("doctor requires a validated deployment plan");
	return context;
}

export function componentPreflightSummary(plan, componentName) {
	const selected = plan?.components?.find(component => component.name === componentName);
	if (!selected) throw new Error(`deployment plan does not contain selected component ${componentName}`);
	return `${componentName}; dependencies: ${selected.dependsOn.join(", ") || "none"}`;
}

export function allowsLocalDummyDeployer(chain, recipe = null) {
	return chain?.key === "localhost" && (!recipe || recipe.network?.mode === "local");
}

export function assertCoreDependencyAdmin(dependency, recipeAdmin) {
	if (dependency?.config?.admin?.toLowerCase() !== recipeAdmin?.toLowerCase()) {
		throw new Error(`governance.admin ${recipeAdmin} does not match core report config.admin ${dependency?.config?.admin}`);
	}
}

class Report {
	constructor({ recipePath = null } = {}) {
		this.errors = 0;
		this.warnings = 0;
		this.recipePath = recipePath;
		this.blockingFields = new Set();
	}
	decorate(message, detail, includeEditHint = false) {
		if (!this.recipePath) return { message, detail, fields: [] };
		return recipeDiagnostic(message, detail, this.recipePath, { includeEditHint });
	}
	ok(m, d) {
		const rendered = this.decorate(m, d);
		ok(rendered.message, rendered.detail);
	}
	warn(m, d) {
		this.warnings++;
		const rendered = this.decorate(m, d);
		warn(rendered.message, rendered.detail);
	}
	fail(m, d) {
		this.errors++;
		const rendered = this.decorate(m, d, true);
		for (const field of rendered.fields) this.blockingFields.add(field);
		fail(rendered.message, rendered.detail);
	}
	info(m, d) {
		const rendered = this.decorate(m, d);
		info(rendered.message, rendered.detail);
	}
	skip(m, d) {
		const rendered = this.decorate(m, d);
		skip(rendered.message, rendered.detail);
	}
}

function checkBooleanEnv(report, env, name) {
	const value = env[name];
	if (value !== undefined && value !== "" && value !== "true" && value !== "false") {
		report.fail(`${name} must be exactly true or false`, JSON.stringify(value));
		return false;
	}
	return true;
}

export async function doctor(args, runtime = {}) {
	const recipeContext = resolveDoctorRecipeContext(args, runtime);
	const networkName = recipeContext?.networkName || args.network;
	if (!networkName) throw new Error("exactly one of --config or --network is required");
	const chain = resolveNetwork(networkName);
	if (recipeContext) assertRecipeNetworkCompatibility(recipeContext.recipe, chain);
	const env = recipeContext?.env || loadEnv().vars;
	const mainnet = isLiveMainnet(chain);
	const partialAddon = isPartialAddonPreflight(recipeContext, args.only);
	const deploymentTaskLabel = partialAddon ? `deploy:component --component ${args.only}` : "deploy:system";
	const r = new Report({ recipePath: recipeContext?.path });
	const configuration = runtimeConfigurationRows({
		chainId: chain.chainId,
		simulated: chain.simulated,
		recipePath: recipeContext?.path,
		recipeName: recipeContext?.recipe.name,
		component: args.only,
		coreReportPath: recipeContext?.recipe.core.fromReport,
		legacy: !recipeContext,
	});

	blank();
	kv([
		["network", `${chain.key} ${c.grey(`(${chain.name}, chainId ${chain.chainId})`)}`],
		[
			"mode",
			chain.simulated
				? c.cyan(`SIMULATED — reads ${chain.upstream} upstream, writes only local fork state`)
				: mainnet
					? c.yellow("MAINNET — real funds")
					: c.grey("non-mainnet"),
		],
	]);

	title("Configuration locations");
	kv(configuration.rows);
	if (recipeContext) {
		r.ok("recipe loaded and schema-valid", recipeContext.path);
		r.info("recipe digest", recipeContext.digest);
		if (args.only) r.info("component preflight", componentPreflightSummary(recipeContext.plan, args.only));
		for (const missing of recipeContext.missingSecrets) {
			r.fail(`${missing.field}.key references an unavailable process secret`, missing.key);
		}
		if (args.only && args.only !== "core") {
			try {
				const dependency = loadCoreDependencyReport(recipeContext.recipe.core.fromReport, {
					network: networkName,
					chainId: chain.chainId,
					live: mainnet,
					digest: recipeContext.dependencies.coreReport?.digest,
				});
				try {
					assertCoreDependencyAdmin(dependency, recipeContext.recipe.governance.admin);
				} catch (error) {
					r.blockingFields.add("governance.admin");
					throw error;
				}
				r.ok(
					"core.fromReport proves the component dependency",
					`${recipeContext.recipe.core.fromReport}; deployment ${dependency.deploymentId}; Core ${dependency.addresses.diamond}`,
				);
			} catch (error) {
				r.blockingFields.add("core.fromReport");
				r.fail("core.fromReport cannot prove the selected component dependency", error.message || String(error));
			}
		}
	} else {
		r.warn("internal network-only mode", "operator runs must start from the guided menu and a digest-bound recipe");
		r.info("operator path", `./symmio → Deploy a contract → choose a target on ${networkName}`);
	}

	// PRIVATE_KEY is the single most dangerous piece of documentation drift in this repo:
	// operators set it, believe they configured the deployer, and sign with a public key.
	if (env.PRIVATE_KEY) {
		r.fail("PRIVATE_KEY is set but nothing reads it", "hardhat.config.ts uses NEW_DEPLOYER / TEAM_DEPLOYER / keystore");
	}
	if (env.PRIVATE_KEYS_STR) {
		r.warn("PRIVATE_KEYS_STR is set but nothing reads it", "safe to delete");
	}
	for (const name of [
		"USE_KEYSTORE",
		"DEPLOY_MOCK_VERIFIER",
		"REGISTER_DUMMY_AFFILIATE",
		"DEPLOY_PARTYB",
		"SET_ADL_ENABLED",
		"DEPLOY_SYMBOL_MANAGER",
		"SETUP_INSTANT_LAYER_TEMPLATES",
	]) {
		checkBooleanEnv(r, env, name);
	}
	if (env.FORK_BLOCK_NUMBER && env.FORK_BLOCK_NUMBER !== "0" && !/^[1-9]\d*$/.test(env.FORK_BLOCK_NUMBER)) {
		r.fail("FORK_BLOCK_NUMBER must be a positive whole number", JSON.stringify(env.FORK_BLOCK_NUMBER));
	}
	if (env.DEPLOY_LOG_LEVEL && !["silent", "minimal", "verbose"].includes(env.DEPLOY_LOG_LEVEL)) {
		r.fail("DEPLOY_LOG_LEVEL must be silent, minimal, or verbose", JSON.stringify(env.DEPLOY_LOG_LEVEL));
	}

	// ── deployer ────────────────────────────────────────────────────────────────
	title("Deployer");
	const deployerSecret = recipeContext?.secrets.deployer;
	const operatorSignerMode = process.env.SYMMIO_SIGNER_MODE;
	let localNodeDeployer = null;
	if (chain.key === "localhost" && recipeContext?.recipe.network.mode === "local" && (!deployerSecret || operatorSignerMode === "local-node")) {
		try {
			const localAccounts = await makeProvider(networkName, env).send("eth_accounts", []);
			if (isAddress(localAccounts?.[0])) {
				localNodeDeployer = { source: "unlocked local Hardhat account", address: localAccounts[0], isDummy: false, remote: true };
			}
		} catch {}
	}
	let operatorDeployer = null;
	if (operatorSignerMode === "hardhat-keystore") {
		operatorDeployer = {
			source: `Hardhat keystore (${process.env.KEYSTORE_DEPLOYER_KEY || "NEW_DEPLOYER"})`,
			address: null,
			isDummy: false,
			keystore: true,
		};
	} else if (operatorSignerMode === "private-key") {
		try {
			operatorDeployer = {
				source: "task-bound transient private key",
				address: new Wallet(process.env.SYMMIO_EPHEMERAL_PRIVATE_KEY).address,
				isDummy: false,
			};
		} catch {
			operatorDeployer = { source: "task-bound transient private key", invalid: true };
		}
	} else if (operatorSignerMode === "ledger") {
		const address = process.env.SYMMIO_LEDGER_ADDRESS;
		operatorDeployer = isAddress(address || "")
			? { source: "Ledger hardware wallet", address: getAddress(address), isDummy: false, hardware: true }
			: { source: "Ledger hardware wallet", invalid: true };
	} else if (operatorSignerMode === "safe-file" || operatorSignerMode === "safe-service") {
		const address = process.env.SYMMIO_SAFE_ADDRESS;
		operatorDeployer = isAddress(address || "")
			? { source: "Safe governance action intent", address: getAddress(address), isDummy: false, safeOnly: true }
			: { source: "Safe governance action intent", invalid: true, safeOnly: true };
	} else if (operatorSignerMode === "local-node") {
		operatorDeployer = localNodeDeployer || { source: "unlocked local-node account", missing: true, remote: true };
	}
	const deployer =
		operatorDeployer ||
		(chain.simulated
			? { source: "Hardhat simulated account", address: null, simulated: true }
			: localNodeDeployer
				? localNodeDeployer
				: deployerSecret?.provider === "hardhat-keystore"
					? { source: "keystore", address: null, isDummy: false, keystore: true }
					: resolveDeployer(env, { allowLocalDummy: allowsLocalDummyDeployer(chain, recipeContext?.recipe) }));
	if (deployer.safeOnly && !deployer.invalid) {
		r.ok("Safe action-only mode; this process will not broadcast an EOA transaction", deployer.address);
	} else if (deployer.hardware && !deployer.invalid) {
		r.ok("Ledger signer bound to the task", deployer.address);
	} else if (deployer.simulated) {
		r.ok("deployer is a pre-funded Hardhat simulation account");
	} else if (deployer.keystore) {
		r.warn(
			"deployer keystore reference is declared but not unlocked",
			recipeContext ? "secrets.deployer; key presence and signer address are not yet proven" : "USE_KEYSTORE=true",
		);
		r.info(
			"signer checks deferred",
			`${deploymentTaskLabel} unlocks the keystore and rechecks key presence, public-key safety, balance, and admin separation before any checkpoint or transaction`,
		);
	} else if (deployer.invalid) {
		r.fail(`${deployer.source} is set but is not a valid private key`);
	} else if (deployer.missing) {
		r.fail("no deployment signer is configured", "set NEW_DEPLOYER / TEAM_DEPLOYER, or use the Hardhat keystore");
	} else if (deployer.remote) {
		r.ok("using unlocked account from the persistent local Hardhat node", deployer.address);
		r.info("local-only signer boundary", "no private key is stored in the recipe, task state, or raw log");
	} else if (deployer.isDummy && chain.key === "localhost") {
		r.warn("using the repository dummy deployer for localhost only", deployer.address);
		r.info("local-only signer boundary", "Hardhat never configures this public key for live recipe targets");
	} else if (deployer.isDummy || UNSAFE_DEPLOYERS.has((deployer.address || "").toLowerCase())) {
		const why = UNSAFE_DEPLOYERS.get((deployer.address || "").toLowerCase()) || "committed to this repo";
		if (mainnet) r.fail(`deployer is a publicly-known key (${why})`, deployer.address);
		else r.warn(`deployer is a publicly-known key (${why})`, deployer.address);
		r.info("set NEW_DEPLOYER, or USE_KEYSTORE=true");
	} else {
		r.ok(`deployer resolved from ${deployer.source}`, deployer.address);
	}

	// ── rpc ─────────────────────────────────────────────────────────────────────
	title("RPC");
	const rpcSecret = recipeContext?.secrets.rpc;
	const rpcResolution =
		rpcSecret?.provider === "hardhat-keystore"
			? {
					url: null,
					source: `Hardhat keystore (${rpcSecret.key})`,
					key: rpcEnvKey(networkName),
					inspectable: false,
				}
			: resolveRpc(networkName, env);
	const url = rpcResolution.url;
	const rpcKey = rpcEnvKey(networkName);
	const usingDefault = rpcResolution.source === "built-in public endpoint";
	if (!rpcResolution.inspectable) {
		r.warn(
			"Hardhat RPC endpoint is encrypted and cannot be directly probed by this CLI",
			recipeContext
				? "secrets.rpc uses the Hardhat keystore; the deployment task will unlock and recheck it before any transaction"
				: `${rpcKey} from the keystore; set SYMMIO_RPC_URL_OVERRIDE for a read-only doctor probe`,
		);
		r.info(
			"RPC chain and downstream contract probes are deferred",
			`${deploymentTaskLabel} rechecks the actual endpoint and chainId before any transaction`,
		);
	} else if (usingDefault && mainnet) {
		r.warn(`using the built-in public endpoint`, url);
		r.info(`set ${rpcKey} — public RPCs rate-limit and can drop transactions`);
	} else {
		r.ok(chain.simulated ? "upstream endpoint configured" : "endpoint configured", usingDefault ? url : `from ${rpcResolution.source}`);
	}

	let provider = null;
	let liveChainId = null;
	if (rpcResolution.inspectable) {
		try {
			provider = makeProvider(networkName, env);
			// JsonRpcProvider is configured with a static expected network so getNetwork() may
			// return that expectation without an RPC round trip. Probe eth_chainId directly.
			liveChainId = parseRpcChainId(await provider.send("eth_chainId", []));
			if (liveChainId !== chain.chainId) {
				r.fail(`RPC reports chainId ${liveChainId}, expected ${chain.chainId}`, "the endpoint points at the wrong chain");
			} else {
				const block = await provider.getBlockNumber();
				r.ok(`reachable, chainId ${liveChainId}`, `block ${block}`);
			}
		} catch (err) {
			r.fail("RPC unreachable", (err.shortMessage || err.message || "").slice(0, 90));
		}
	}

	// ── deployer balance ────────────────────────────────────────────────────────
	if (provider && deployer.address && liveChainId === chain.chainId && !chain.simulated && !deployer.safeOnly) {
		try {
			const bal = await provider.getBalance(deployer.address);
			const eth = Number(bal) / 1e18;
			if (bal === 0n) r.fail("deployer balance is zero", deployer.address);
			else if (mainnet && eth < 0.05) r.warn(`deployer balance is low: ${eth.toFixed(5)} ETH`, "a full deploy is ~45 contracts");
			else r.ok(`deployer balance ${eth.toFixed(5)} ETH`);
		} catch {
			r.warn("could not read deployer balance");
		}
	}

	// ── deployment configuration ────────────────────────────────────────────────
	title("Deployment configuration");

	const admin = env.ADMIN_PUBLIC_KEY;
	if (!admin) {
		if (mainnet) r.fail("ADMIN_PUBLIC_KEY is not set", "would default to the deployer, leaving a hot wallet as protocol admin");
		else r.warn("ADMIN_PUBLIC_KEY is not set", "defaults to the deployer");
	} else if (!isNonZeroAddress(admin)) {
		r.fail("ADMIN_PUBLIC_KEY is not a valid non-zero address", admin);
	} else if (deployer.safeOnly && deployer.address && admin.toLowerCase() === deployer.address.toLowerCase()) {
		r.ok("ADMIN_PUBLIC_KEY matches the selected Safe", admin);
	} else if (deployer.address && admin.toLowerCase() === deployer.address.toLowerCase()) {
		if (isMainnetAdminDeployer(admin, deployer.address, mainnet)) {
			r.fail("ADMIN_PUBLIC_KEY is the deployer", "privileges cannot be handed over; use a distinct multisig");
		} else r.ok("ADMIN_PUBLIC_KEY set (same as deployer)", admin);
	} else {
		r.ok("ADMIN_PUBLIC_KEY set", admin);
	}

	if (partialAddon) {
		r.skip(
			"Core deployment inputs are not applied for this component-only run",
			"collateral, Muon, Create2, protocol parameters, fee routing, and liquidation settings come from core.fromReport",
		);
	} else {
		if (!env.SYMMIO_FEE_RECEIVER) r.warn("SYMMIO_FEE_RECEIVER not set", "defaults to ADMIN_PUBLIC_KEY");
		else if (!isNonZeroAddress(env.SYMMIO_FEE_RECEIVER)) r.fail("SYMMIO_FEE_RECEIVER is not a valid non-zero address", env.SYMMIO_FEE_RECEIVER);
		else r.ok("SYMMIO_FEE_RECEIVER set", env.SYMMIO_FEE_RECEIVER);

		// collateral — a wrong or empty value here is unrecoverable after setCollateral
		const collateral = env.COLLATERAL_ADDRESS;
		if (!collateral) {
			if (mainnet) r.fail("COLLATERAL_ADDRESS is empty", "deploy:system would create a mintable FakeStablecoin as protocol collateral");
			else r.info("COLLATERAL_ADDRESS empty — a FakeStablecoin will be deployed (fine locally)");
		} else if (!isNonZeroAddress(collateral)) {
			r.fail("COLLATERAL_ADDRESS is not a valid non-zero address", collateral);
		} else if (provider && liveChainId === chain.chainId) {
			try {
				const code = await provider.getCode(collateral);
				if (code === "0x") {
					r.fail("COLLATERAL_ADDRESS has no contract code on this chain", collateral);
				} else {
					const token = new Contract(collateral, ERC20, provider);
					const [sym, dec] = [await token.symbol(), Number(await token.decimals())];
					const known = KNOWN_COLLATERAL[chain.chainId]?.[collateral.toLowerCase()];
					r.ok(`collateral ${sym} (${dec} decimals)`, known ? `recognised: ${known}` : collateral);
					if (!known && mainnet) r.warn("collateral is not a token this CLI recognises for this chain", "double-check the address");
				}
			} catch {
				r.warn("could not read collateral token metadata", collateral);
			}
		} else if (!provider) {
			r.warn("collateral contract probes deferred with encrypted RPC", "deploy:system validates code and ERC-20 views before spending gas");
		}

		// the two switches that silently produce a compromised protocol
		if (env.DEPLOY_MOCK_VERIFIER === "true") {
			if (mainnet) r.fail("DEPLOY_MOCK_VERIFIER=true", "installs a verifier that accepts EVERY signature");
			else r.info("DEPLOY_MOCK_VERIFIER=true (expected for local/test)");
		} else {
			r.ok("DEPLOY_MOCK_VERIFIER is off");
		}
		if (env.REGISTER_DUMMY_AFFILIATE === "true") {
			if (mainnet) r.fail("REGISTER_DUMMY_AFFILIATE=true", 'registers a real "Test Affiliate" on-chain');
			else r.info("REGISTER_DUMMY_AFFILIATE=true (expected for local/test)");
		} else {
			r.ok("REGISTER_DUMMY_AFFILIATE is off");
		}
	}

	const componentConfig = deploymentComponentProblemsForSelection(env, partialAddon ? args.only : undefined);
	for (const [message, detail] of componentConfig.problems) r.fail(message, detail);
	if (!partialAddon) {
		const productionShape = isMainnet(chain.chainId);
		const accountingProblems = deploymentAccountingProblems(env, { productionShape });
		for (const [message, detail] of accountingProblems) r.fail(message, detail);
		if (accountingProblems.length === 0) {
			if (env.LIQUIDATION_INSURANCE_VAULT) r.ok("liquidation insurance vault configured", env.LIQUIDATION_INSURANCE_VAULT);
			else r.info("liquidation insurance vault defaults to admin (local/test only)");
			if (env.MAX_LIQUIDATION_PROFIT_PER_POSITION) {
				r.ok("max liquidation profit per position configured", env.MAX_LIQUIDATION_PROFIT_PER_POSITION);
			} else r.info("max liquidation profit defaults to 100e18 (local/test only)");
			if (env.SOFT_LIQUIDATION_PENALTY_COLLECTOR) {
				r.ok("soft liquidation penalty collector configured", env.SOFT_LIQUIDATION_PENALTY_COLLECTOR);
			} else r.info("soft liquidation penalty collector defaults to admin (local/test only)");
		}
	}
	const deployPartyB = componentConfig.deployPartyB;
	if (deployPartyB) {
		if (isNonZeroAddress(env.PARTYB_SIGNER)) r.ok("PartyB signer configured", env.PARTYB_SIGNER);
	} else {
		r.info("PartyB deployment disabled");
	}

	const deploySymbolManager = componentConfig.deploySymbolManager;
	if (deploySymbolManager) {
		if (isNonZeroAddress(env.SYMBOL_MANAGER_OPERATOR)) r.ok("SymbolManager operator configured", env.SYMBOL_MANAGER_OPERATOR);
	} else {
		r.info("SymbolManager deployment disabled");
	}

	const expressProvider = recipeContext?.recipe?.expressProvider;
	if (expressProvider?.mode === "deploy") {
		const operators = expressProvider.roles?.OPERATOR_ROLE || [];
		r.ok(`ExpressProvider operators configured (${operators.length})`, operators.join(", "));
		if (expressProvider.creditLine?.signatureVerifier === "fromCore") {
			r.info("ExpressProvider credit line reuses the core Muon verifier", "resolved from the core diamond at execution time");
		} else {
			r.ok("ExpressProvider credit line verifier configured", expressProvider.creditLine?.signatureVerifier);
		}
		if (expressProvider.registerOnCore !== true) {
			r.warn(
				"ExpressProvider will not be registered on core",
				"expressProvider.registerOnCore is false; the provider cannot call advanceWithdraw and stays inert until registered",
			);
		}
		// 0 means "no cap" on-chain. An uncapped credit line lets a compromised or buggy bot
		// advance the entire eligible base out of core, so it must be a deliberate choice.
		for (const affiliate of expressProvider.affiliates || []) {
			const uncapped = [];
			if (affiliate.maxDebt === "0") uncapped.push("maxDebt");
			if (affiliate.maxDebtBps === 0) uncapped.push("maxDebtBps");
			if (uncapped.length === 2) {
				r.warn(
					`ExpressProvider affiliate ${affiliate.address} has an uncapped credit line`,
					"both maxDebt and maxDebtBps are 0, which on-chain means no limit; set at least one cap unless this is deliberate",
				);
			} else if (uncapped.length === 1) {
				r.info(`ExpressProvider affiliate ${affiliate.address} ${uncapped[0]} is 0 (no cap on that axis)`, "the other cap still applies");
			} else {
				r.ok(
					`ExpressProvider affiliate ${affiliate.address} credit caps configured`,
					`maxDebt=${affiliate.maxDebt}, maxDebtBps=${affiliate.maxDebtBps}`,
				);
			}
		}
	} else if (expressProvider) {
		r.info(`ExpressProvider deployment ${expressProvider.mode === "skip" ? "disabled" : expressProvider.mode}`);
	}

	// Muon is a Core deployment concern. Component-only runs trust the validated,
	// chain-bound core.fromReport instead of requiring unrelated deployment inputs.
	if (!partialAddon && env.DEPLOY_MOCK_VERIFIER === "true") {
		if (env.MUON_SIGNATURE_VERIFIER_ADDRESS) {
			r.fail("MUON_SIGNATURE_VERIFIER_ADDRESS and DEPLOY_MOCK_VERIFIER=true are mutually exclusive");
		}
		if (env.MUON_FUNCTION_PERMISSIONS) r.warn("MUON_FUNCTION_PERMISSIONS is ignored by MockMuonSignatureVerifier");
		r.skip("Muon configuration not required with the mock verifier");
	} else if (!partialAddon) {
		let muonFunctionPermissions = [];
		try {
			muonFunctionPermissions = parseMuonFunctionPermissions(env.MUON_FUNCTION_PERMISSIONS);
			r.ok("all eight Muon function permissions configured", muonFunctionPermissions.map(({ name }) => name).join(", "));
		} catch (error) {
			r.fail("MUON_FUNCTION_PERMISSIONS is invalid", error.message || String(error));
		}

		const verifierAddress = env.MUON_SIGNATURE_VERIFIER_ADDRESS;
		if (verifierAddress && !isNonZeroAddress(verifierAddress)) {
			r.fail("MUON_SIGNATURE_VERIFIER_ADDRESS is not a valid non-zero address", verifierAddress);
		}

		if (!isPositiveDecimal(env.MUON_APP_ID || "")) {
			r.fail("MUON_APP_ID must be a positive base-10 integer when DEPLOY_MOCK_VERIFIER=false");
		}
		for (const [name, fallback] of [
			["MUON_UPNL_VALID_TIME", "300"],
			["MUON_PRICE_VALID_TIME", "300"],
		]) {
			if (!isPositiveDecimal(env[name] || fallback)) r.fail(`${name} must be a positive base-10 integer`, JSON.stringify(env[name]));
		}

		const hasKeyX = Boolean(env.MUON_PUBLIC_KEY_X);
		const hasParity = env.MUON_PUBLIC_KEY_PARITY !== undefined && env.MUON_PUBLIC_KEY_PARITY !== "";
		let configuredPublicKey = null;
		if (hasKeyX !== hasParity) r.fail("MUON_PUBLIC_KEY_X and MUON_PUBLIC_KEY_PARITY must either both be set or both be omitted");
		if (hasKeyX) {
			try {
				const x = BigInt(env.MUON_PUBLIC_KEY_X);
				if (x <= 0n || x >= 1n << 256n) throw new Error("out of uint256 range");
				if (env.MUON_PUBLIC_KEY_PARITY === "0" || env.MUON_PUBLIC_KEY_PARITY === "1") {
					configuredPublicKey = { x: x.toString(), parity: Number(env.MUON_PUBLIC_KEY_PARITY) };
				}
			} catch {
				r.fail("MUON_PUBLIC_KEY_X must be an integer in the uint256 range 1..2^256-1", env.MUON_PUBLIC_KEY_X);
			}
			if (env.MUON_PUBLIC_KEY_PARITY !== "0" && env.MUON_PUBLIC_KEY_PARITY !== "1") {
				r.fail("MUON_PUBLIC_KEY_PARITY must be exactly 0 or 1", JSON.stringify(env.MUON_PUBLIC_KEY_PARITY));
			}
		}

		const rawGatewaySigners = (env.MUON_GATEWAY_SIGNERS || "")
			.split(",")
			.map(value => value.trim())
			.filter(Boolean);
		const invalidGatewaySigners = rawGatewaySigners.filter(value => !isNonZeroAddress(value));
		if (invalidGatewaySigners.length) r.fail("MUON_GATEWAY_SIGNERS contains invalid addresses", invalidGatewaySigners.join(", "));
		if (new Set(rawGatewaySigners.map(value => value.toLowerCase())).size !== rawGatewaySigners.length) {
			r.fail("MUON_GATEWAY_SIGNERS contains duplicate addresses");
		}

		if (!verifierAddress) {
			const missing = [];
			if (!hasKeyX || !hasParity) missing.push("MUON_PUBLIC_KEY_X/MUON_PUBLIC_KEY_PARITY");
			if (rawGatewaySigners.length === 0) missing.push("MUON_GATEWAY_SIGNERS");
			if (missing.length) {
				r.fail(`new Muon verifier configuration incomplete: ${missing.join(", ")}`);
			} else {
				r.ok("new Muon verifier inputs configured");
			}
		} else if (provider && liveChainId === chain.chainId && isNonZeroAddress(verifierAddress)) {
			try {
				const code = await provider.getCode(verifierAddress);
				if (code === "0x") {
					r.fail("MUON_SIGNATURE_VERIFIER_ADDRESS has no contract code on this chain", verifierAddress);
				} else {
					const verifier = new Contract(verifierAddress, MUON_VERIFIER, provider);
					const setterRole = await verifier.SETTER_ROLE();
					if (!setterRole || setterRole === `0x${"0".repeat(64)}`)
						r.fail("existing verifier does not expose a valid SETTER_ROLE", verifierAddress);
					const [existingKeys, existingGatewaySigners] = await Promise.all([verifier.getAllPublicKeys(), verifier.getAllGatewaySigners()]);
					const targetPublicKeys = configuredPublicKey
						? [configuredPublicKey]
						: existingKeys.map(key => ({ x: key.x, parity: Number(key.parity) }));
					const validConfiguredGatewaySigners = rawGatewaySigners.filter(isNonZeroAddress);
					const targetGatewaySigners = rawGatewaySigners.length > 0 ? validConfiguredGatewaySigners : Array.from(existingGatewaySigners);
					const missingRegistrations = [];
					if (
						configuredPublicKey &&
						!existingKeys.some(
							key => String(key.x) === String(configuredPublicKey.x) && Number(key.parity) === Number(configuredPublicKey.parity),
						)
					) {
						missingRegistrations.push(`public key x=${configuredPublicKey.x}, parity=${configuredPublicKey.parity} is not registered`);
					}
					const existingGatewaySet = new Set(Array.from(existingGatewaySigners, signer => signer.toLowerCase()));
					for (const signer of validConfiguredGatewaySigners) {
						if (!existingGatewaySet.has(signer.toLowerCase())) missingRegistrations.push(`gateway signer ${signer} is not registered`);
					}
					if (targetPublicKeys.length === 0) r.fail("existing Muon verifier has no public keys configured", verifierAddress);
					if (targetGatewaySigners.length === 0) r.fail("existing Muon verifier has no gateway signers configured", verifierAddress);
					if (targetPublicKeys.length > 0 && targetGatewaySigners.length > 0) {
						r.ok(
							"existing Muon verifier targets resolved",
							`${targetPublicKeys.length} key(s), ${targetGatewaySigners.length} gateway(s)`,
						);
					}

					if (muonFunctionPermissions.length === 8 && targetPublicKeys.length > 0 && targetGatewaySigners.length > 0) {
						const missingAuthorizations = await inspectMuonFunctionAuthorizations(verifier, {
							publicKeys: targetPublicKeys,
							gatewaySigners: targetGatewaySigners,
							permissions: muonFunctionPermissions,
						});
						const repairItems = [...missingRegistrations, ...missingAuthorizations];
						const deployerCanRepair =
							repairItems.length > 0 && deployer.address ? await verifier.hasRole(setterRole, deployer.address) : undefined;
						const authorizationVerdict = verifierRepairAuthorityVerdict(repairItems, deployer.address, deployerCanRepair);
						if (authorizationVerdict === "ok") {
							r.ok("existing Muon verifier registers every target and authorizes every configured function category");
						} else if (authorizationVerdict === "deferred") {
							const detail = `${repairItems.slice(0, 4).join("; ")}${repairItems.length > 4 ? `; +${repairItems.length - 4} more` : ""}`;
							r.warn(
								`existing Muon verifier needs ${repairItems.length} repair item(s); deployment signer authority is not visible to this CLI`,
								`${detail}; deploy:system checks the unlocked signer for SETTER_ROLE before any transaction`,
							);
						} else {
							const detail = `${repairItems.slice(0, 4).join("; ")}${repairItems.length > 4 ? `; +${repairItems.length - 4} more` : ""}`;
							if (authorizationVerdict === "repairable") {
								r.warn(
									`existing Muon verifier has ${repairItems.length} missing registration/authorization item(s), but deployer SETTER_ROLE can repair them`,
									detail,
								);
							} else {
								r.fail(
									`existing Muon verifier has ${repairItems.length} missing registration/authorization item(s) and deployer lacks SETTER_ROLE`,
									detail,
								);
							}
						}
					}
				}
			} catch (error) {
				r.fail("unable to inspect existing Muon verifier", (error.shortMessage || error.message || String(error)).slice(0, 100));
			}
		} else if (verifierAddress && isNonZeroAddress(verifierAddress) && !provider) {
			r.warn(
				"existing Muon verifier probes deferred with encrypted RPC",
				"deploy:system validates code, registrations, all eight permissions, and unlocked-signer SETTER_ROLE before any transaction",
			);
		}
		r.info("Muon validity", `${env.MUON_UPNL_VALID_TIME || 300}/${env.MUON_PRICE_VALID_TIME || 300}s`);
	}

	const recipeVerification = recipeContext?.recipe.execution.verify;
	if (mainnet && recipeContext && recipeVerification !== true) {
		r.fail("execution.verify must be true for a live network", "live deployments cannot opt out of explorer verification");
	}
	const verificationRequired = mainnet && args["no-verify"] !== true && recipeVerification !== false;
	const verificationProvider = verificationProviderForChain(chain);
	r.info("explorer verification provider", verificationProvider);
	let explorerProbeUrl = null;
	if (verificationProvider === "blockscout") {
		r.ok("Blockscout verification needs no API key", chain.verification.apiUrl);
		explorerProbeUrl = `${chain.verification.apiUrl}?module=contract&action=getsourcecode&address=${ZERO_ADDRESS}`;
	} else if (env.ETHERSCAN_APIKEY) {
		r.ok("ETHERSCAN_APIKEY set");
		explorerProbeUrl = `https://api.etherscan.io/v2/api?chainid=${chain.chainId}&module=contract&action=getsourcecode&address=${ZERO_ADDRESS}&apikey=${encodeURIComponent(env.ETHERSCAN_APIKEY)}`;
	} else if (recipeContext?.secrets.explorer?.provider === "hardhat-keystore" || (!recipeContext && env.USE_KEYSTORE === "true")) {
		r.warn(
			"explorer keystore reference is declared but not unlocked",
			recipeContext
				? "secrets.explorer; key presence and API validity are not yet proven"
				: "ETHERSCAN_APIKEY; key presence and API validity are not yet proven",
		);
		r.info("explorer check deferred", "Hardhat resolves the key before deployment and explorer verification remains a mandatory live gate");
	} else if (verificationRequired) {
		r.fail("ETHERSCAN_APIKEY not set", "live deployment verifies by default and would fail only after spending deployment gas");
	} else {
		r.warn("ETHERSCAN_APIKEY not set", "contract verification is unavailable");
	}

	if (verificationRequired && explorerProbeUrl) {
		try {
			const response = await fetch(explorerProbeUrl, { signal: AbortSignal.timeout(8_000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = await response.json();
			const detail = String(payload?.result || payload?.message || "").slice(0, 120);
			if (String(payload?.status) === "0" && /invalid api key|unsupported|not supported|missing api key/i.test(detail)) {
				throw new Error(detail);
			}
			r.ok(`${verificationProvider} explorer API reachable`, chain.explorer);
		} catch (error) {
			r.fail(`${verificationProvider} explorer API preflight failed`, String(error.message || error).slice(0, 120));
		}
	}

	// ── protocol config ─────────────────────────────────────────────────────────
	title("Protocol config");
	if (recipeContext) {
		if (partialAddon) {
			r.skip("protocol configuration is not reapplied", `validated core dependency: ${recipeContext.recipe.core.fromReport}`);
		} else if (recipeContext.recipe.core.mode === "deploy") {
			r.ok("core.protocol passed recipe validation", `${recipeContext.path}#core.protocol`);
			r.info("protocol values are bound to the recipe digest", recipeContext.digest);
		} else if (recipeContext.recipe.core.mode === "reuse") {
			r.ok("core reuse source passed recipe validation", recipeContext.recipe.core.fromReport);
		} else {
			r.skip("core.mode is skip; protocol configuration will not be applied");
		}
	} else {
		const cfgLabel = `tasks/config/protocol-${chain.chainId}.json`;
		const cfgPath = projectPath("tasks", "config", `protocol-${chain.chainId}.json`);
		if (!fs.existsSync(cfgPath)) {
			if (isMainnet(chain.chainId))
				r.fail(`no ${cfgLabel}`, "known mainnets and their fork rehearsals require an explicit reviewed protocol config");
			else r.info(`no ${cfgLabel} — built-in defaults will be used`);
			r.info("compatibility mode can mirror an existing deployment with the config export command");
		} else {
			try {
				const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
				const required = [
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
				const missing = required.filter(k => cfg.parameters?.[k] === undefined);
				if (missing.length) r.fail(`${cfgLabel} missing parameters: ${missing.join(", ")}`);
				else r.ok(`${cfgLabel} valid`, `${cfg.instantLayerTemplates?.length ?? 0} templates`);

				const unverified = cfg._provenance?.UNVERIFIED_still_defaults;
				if (unverified?.length) {
					r.warn(`${unverified.length} parameters are unverified defaults`, unverified.join(", "));
				}
				if (cfg.instantLayerTemplates?.length) {
					log("");
					for (const [i, t] of cfg.instantLayerTemplates.entries()) {
						info(`template ${i}: ${t.name}`, `${t.operations.length} ops${t.instantOpenMode ? ", instantOpenMode" : ""}`);
					}
				}
			} catch (err) {
				r.fail(`${cfgLabel} is not valid JSON`, String(err.message).slice(0, 80));
			}
		}
	}

	// ── in-flight deployment ────────────────────────────────────────────────────
	title("Deployment state");
	const checkpointScope = doctorCheckpointScope(recipeContext, args.only);
	const checkpointOptions = { simulated: chain.simulated, scope: checkpointScope };
	const checkpointPath = deploymentCheckpointPath(chain.chainId, checkpointOptions);
	r.info("checkpoint path", checkpointPath);
	const checkpoint = readCheckpoint(chain.chainId, checkpointOptions);
	const checkpointPlan = checkpointDisposition(checkpoint, { fresh: args.fresh === true, target: deploymentTaskLabel });
	if (checkpointPlan.kind === "none") {
		r.ok(checkpointPlan.message);
	} else if (checkpointPlan.kind === "corrupt" || checkpointPlan.kind === "mismatch") {
		r.fail(checkpointPlan.message, checkpointPlan.detail);
	} else {
		r.warn(checkpointPlan.message, checkpointPlan.detail);
		r.info(`last step: ${checkpoint.step ?? "unknown"}`);
	}

	// ── internal consistency ────────────────────────────────────────────────────
	const driftProblems = [...checkMirrorDrift().problems, ...checkFacetMirrorDrift().problems];
	if (driftProblems.length) {
		title("CLI consistency");
		for (const p of driftProblems) r.warn(p);
	}
	const muonDriftProblems = partialAddon ? [] : checkMuonFunctionMirrorDrift().problems;
	if (muonDriftProblems.length) {
		title("Muon permission consistency");
		for (const problem of muonDriftProblems) r.fail(problem);
	}

	// ── verdict ─────────────────────────────────────────────────────────────────
	blank();
	if (r.errors > 0) {
		log(
			`  ${c.red(c.bold(`${r.errors} blocking issue${r.errors > 1 ? "s" : ""}`))}${r.warnings ? c.grey(`, ${r.warnings} warning${r.warnings > 1 ? "s" : ""}`) : ""}`,
		);
		log(`  ${c.grey("fix these before deploying")}`);
		const [nextTitle, ...nextLines] = doctorNextStepLines({
			networkName,
			recipePath: recipeContext?.path,
			blockingFields: [...r.blockingFields].sort(),
			only: args.only,
			legacy: !recipeContext,
		});
		title(nextTitle);
		for (const line of nextLines) log(line);
		blank();
		return 1;
	}
	if (r.warnings > 0) {
		log(`  ${c.yellow(c.bold(`ready, with ${r.warnings} warning${r.warnings > 1 ? "s" : ""}`))}`);
		blank();
		return 0;
	}
	log(`  ${c.green(c.bold("all checks passed"))}`);
	blank();
	return 0;
}
