import { PROJECT_ROOT } from "../lib/paths.js";
import { createSafeBatch, safeBatchDigest, writeSafeBatch, writeSafeIntent } from "./safe-batch.js";
import { Wallet, getAddress, isAddress } from "ethers";
import fs from "node:fs";
import path from "node:path";

export const SIGNER_MODES = Object.freeze({
	KEYSTORE: "hardhat-keystore",
	PRIVATE_KEY: "private-key",
	SAFE_FILE: "safe-file",
	SAFE_SERVICE: "safe-service",
	LEDGER: "ledger",
	LOCAL_NODE: "local-node",
});

export const EOA_SIGNER_MODES = Object.freeze([SIGNER_MODES.KEYSTORE, SIGNER_MODES.PRIVATE_KEY, SIGNER_MODES.LEDGER, SIGNER_MODES.LOCAL_NODE]);
export const SAFE_SIGNER_MODES = Object.freeze([SIGNER_MODES.SAFE_FILE, SIGNER_MODES.SAFE_SERVICE]);

const transientSecrets = new WeakMap();
const transientSecretValues = new Set();

function rememberSecrets(values) {
	for (const value of Object.values(values)) if (typeof value === "string" && value) transientSecretValues.add(value);
	return values;
}

function nonZeroAddress(value) {
	return isAddress(value) && !/^0x0{40}$/i.test(value);
}

function keyName(value) {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value || "");
}

function safeApiKeyError(value) {
	return value?.trim().length >= 16 ? undefined : "Enter the Safe Transaction Service API key (at least 16 characters)";
}

function modeLabel(mode) {
	return {
		[SIGNER_MODES.KEYSTORE]: "Hardhat keystore wallet",
		[SIGNER_MODES.PRIVATE_KEY]: "Private-key wallet",
		[SIGNER_MODES.SAFE_FILE]: "Safe multisig — export JSON",
		[SIGNER_MODES.SAFE_SERVICE]: "Safe multisig — create proposal",
		[SIGNER_MODES.LEDGER]: "Ledger hardware wallet",
		[SIGNER_MODES.LOCAL_NODE]: "Unlocked local-node account",
	}[mode];
}

function modeHint(mode) {
	return {
		[SIGNER_MODES.KEYSTORE]: "encrypted; key name only is persisted",
		[SIGNER_MODES.PRIVATE_KEY]: "masked; held in memory only and requested again on resume",
		[SIGNER_MODES.SAFE_FILE]: "Safe Transaction Builder compatible JSON with decoded methods",
		[SIGNER_MODES.SAFE_SERVICE]: "sign and propose through the official Safe Transaction Service",
		[SIGNER_MODES.LEDGER]: "device confirmation for each broadcast",
		[SIGNER_MODES.LOCAL_NODE]: "local development only; RPC owns the key",
	}[mode];
}

async function configureKeystore(ui, key, label) {
	const configure = await ui.confirm({ message: `Configure or refresh Hardhat keystore key ${key}?`, initialValue: true });
	if (configure === null) return false;
	if (!configure) return true;
	const code = await ui.runInteractive("./node_modules/.bin/hardhat", ["keystore", "set", "--force", key]);
	if (code !== 0) throw new Error(`Hardhat keystore did not store ${label || key}`);
	return true;
}

async function askPrivateKey(ui, expectedAddress) {
	const value = await ui.password({
		message: expectedAddress ? `Private key for ${expectedAddress}` : "Private key",
		validate: candidate => {
			try {
				const wallet = new Wallet(candidate);
				if (expectedAddress && wallet.address !== getAddress(expectedAddress))
					return `This key belongs to ${wallet.address}, not ${expectedAddress}`;
			} catch {
				return "Enter a valid 32-byte EVM private key";
			}
		},
	});
	if (value === null) return null;
	return { value, address: new Wallet(value).address };
}

async function selectOwner(ui, { initialMode } = {}) {
	const mode = await ui.select({
		message: "Which Safe owner creates the proposal?",
		options: [SIGNER_MODES.KEYSTORE, SIGNER_MODES.PRIVATE_KEY, SIGNER_MODES.LEDGER].map(value => ({
			value,
			label: modeLabel(value),
			hint: modeHint(value),
		})),
		initialValue: initialMode || SIGNER_MODES.KEYSTORE,
	});
	if (mode === null) return null;
	return selectSigner(ui, { role: "Safe owner", allowedModes: [mode], initialMode: mode, nested: true });
}

export async function selectSigner(
	ui,
	{
		role = "Transaction signer",
		allowedModes = EOA_SIGNER_MODES,
		initialMode,
		network,
		chainId,
		safeAddress,
		expectedAddress,
		nested = false,
	} = {},
) {
	const allowed = [...new Set(allowedModes)].filter(mode => Object.values(SIGNER_MODES).includes(mode));
	if (network !== "localhost") {
		const localIndex = allowed.indexOf(SIGNER_MODES.LOCAL_NODE);
		if (localIndex >= 0) allowed.splice(localIndex, 1);
	}
	if (allowed.length === 0) throw new Error(`${role} has no compatible signer modes`);
	const mode =
		allowed.length === 1
			? allowed[0]
			: await ui.select({
					message: role,
					options: allowed.map(value => ({ value, label: modeLabel(value), hint: modeHint(value) })),
					initialValue: allowed.includes(initialMode) ? initialMode : allowed[0],
				});
	if (mode === null) return null;
	let selection;
	if (mode === SIGNER_MODES.KEYSTORE) {
		const key = await ui.text({
			message: `${role} keystore key`,
			initialValue: "NEW_DEPLOYER",
			validate: value => (keyName(value) ? undefined : "Use an environment-style key name such as NEW_DEPLOYER"),
		});
		if (key === null || !(await configureKeystore(ui, key, key))) return null;
		selection = { mode, key, ...(nonZeroAddress(expectedAddress) ? { address: getAddress(expectedAddress) } : {}) };
	} else if (mode === SIGNER_MODES.PRIVATE_KEY) {
		const secret = await askPrivateKey(ui, expectedAddress);
		if (!secret) return null;
		selection = { mode, address: secret.address };
		transientSecrets.set(selection, rememberSecrets({ privateKey: secret.value }));
		ui.note(`Address: ${secret.address}\nThe key is held only in memory and is never written to task state or logs.`, role);
	} else if (mode === SIGNER_MODES.LEDGER) {
		const address = await ui.text({
			message: `${role} Ledger address`,
			placeholder: "0x…",
			validate: value => {
				if (!nonZeroAddress(value)) return "Enter the non-zero address displayed by Ledger";
				if (expectedAddress && getAddress(value) !== getAddress(expectedAddress)) {
					return `Ledger address ${getAddress(value)} does not match governance admin ${getAddress(expectedAddress)}`;
				}
			},
		});
		if (address === null) return null;
		const derivation = await ui.select({
			message: "Ledger derivation path family",
			options: [
				{ value: "ledger-live", label: "Ledger Live", hint: "m/44'/60'/x'/0/0" },
				{ value: "legacy", label: "Legacy", hint: "m/44'/60'/0'/x" },
			],
			initialValue: "ledger-live",
		});
		if (derivation === null) return null;
		if (!(await ui.confirm({ message: "Ledger is connected and the Ethereum app is open?", initialValue: true }))) return null;
		selection = { mode, address: getAddress(address), derivation };
	} else if (mode === SIGNER_MODES.LOCAL_NODE) {
		selection = { mode, ...(nonZeroAddress(expectedAddress) ? { address: getAddress(expectedAddress) } : {}) };
	} else {
		const resolvedSafe = safeAddress
			? getAddress(safeAddress)
			: await ui.text({
					message: "Safe multisig address",
					placeholder: "0x…",
					validate: value => (nonZeroAddress(value) ? undefined : "Enter a non-zero Safe address"),
				});
		if (resolvedSafe === null) return null;
		selection = { mode, safeAddress: getAddress(resolvedSafe) };
		if (mode === SIGNER_MODES.SAFE_SERVICE) {
			const owner = await selectOwner(ui);
			if (!owner) return null;
			const apiKey = await ui.password({
				message: "Safe Transaction Service API key",
				validate: safeApiKeyError,
			});
			if (apiKey === null) return null;
			selection.owner = owner;
			transientSecrets.set(selection, rememberSecrets({ apiKey }));
		}
	}
	if (!nested) {
		ui.note(
			[
				`${modeLabel(selection.mode)}${selection.key ? ` • ${selection.key}` : ""}`,
				selection.address ? `Address: ${selection.address}` : "",
				selection.safeAddress ? `Safe: ${selection.safeAddress}` : "",
				chainId ? `Chain: ${chainId}${network ? ` • ${network}` : ""}` : network || "",
			]
				.filter(Boolean)
				.join("\n"),
			role,
		);
	}
	return selection;
}

export async function selectGovernanceSigner(ui, { classification, network, chainId }) {
	if (classification.type === "unknown-contract") return { delivery: "manual", address: classification.address };
	if (classification.type === "safe") {
		return selectSigner(ui, {
			role: "Governance handover delivery",
			allowedModes: SAFE_SIGNER_MODES,
			initialMode: SIGNER_MODES.SAFE_FILE,
			network,
			chainId,
			safeAddress: classification.address,
		});
	}
	return selectSigner(ui, {
		role: "Governance administrator signer",
		allowedModes: network === "localhost" ? EOA_SIGNER_MODES : EOA_SIGNER_MODES.filter(mode => mode !== SIGNER_MODES.LOCAL_NODE),
		initialMode: SIGNER_MODES.LEDGER,
		network,
		chainId,
		expectedAddress: classification.address,
	});
}

export function copyTransientSignerSecrets(from, to) {
	const secret = transientSecrets.get(from);
	if (secret) transientSecrets.set(to, secret);
	if (from?.owner && to?.owner) copyTransientSignerSecrets(from.owner, to.owner);
	return to;
}

export async function hydrateSigner(selection, ui) {
	if (!selection) return null;
	if (selection.mode === SIGNER_MODES.PRIVATE_KEY && !transientSecrets.get(selection)?.privateKey) {
		const secret = await askPrivateKey(ui, selection.address);
		if (!secret) throw new Error("Signer credential entry was cancelled");
		transientSecrets.set(selection, rememberSecrets({ privateKey: secret.value }));
	}
	if (selection.mode === SIGNER_MODES.SAFE_SERVICE) {
		if (!selection.owner) throw new Error("Safe service signer is missing its owner binding");
		await hydrateSigner(selection.owner, ui);
		if (!transientSecrets.get(selection)?.apiKey) {
			const apiKey = await ui.password({
				message: "Safe Transaction Service API key",
				validate: safeApiKeyError,
			});
			if (apiKey === null) throw new Error("Safe API key entry was cancelled");
			transientSecrets.set(selection, rememberSecrets({ apiKey }));
		}
	}
	return selection;
}

export function signerEnvironment(selection) {
	if (!selection) return {};
	const base = { SYMMIO_SIGNER_MODE: selection.mode };
	if (selection.mode === SIGNER_MODES.KEYSTORE) {
		return {
			...base,
			USE_KEYSTORE: "true",
			KEYSTORE_DEPLOYER_KEY: selection.key,
			KEYSTORE_ACCOUNTS: selection.key,
			...(selection.address ? { SYMMIO_EXPECTED_SIGNER: selection.address } : {}),
		};
	}
	if (selection.mode === SIGNER_MODES.PRIVATE_KEY) {
		const privateKey = transientSecrets.get(selection)?.privateKey;
		if (!privateKey) throw new Error(`Private key for ${selection.address} has not been hydrated`);
		return { ...base, SYMMIO_EPHEMERAL_PRIVATE_KEY: privateKey, SYMMIO_EXPECTED_SIGNER: selection.address };
	}
	if (selection.mode === SIGNER_MODES.LEDGER) {
		return {
			...base,
			SYMMIO_LEDGER_ADDRESS: selection.address,
			SYMMIO_LEDGER_DERIVATION: selection.derivation,
			SYMMIO_EXPECTED_SIGNER: selection.address,
		};
	}
	if (selection.mode === SIGNER_MODES.LOCAL_NODE) {
		return { ...base, ...(selection.address ? { SYMMIO_EXPECTED_SIGNER: selection.address } : {}) };
	}
	return { ...base, SYMMIO_SAFE_ACTIONS_ONLY: "true", SYMMIO_SAFE_ADDRESS: selection.safeAddress };
}

export function redactSignerSecrets(value) {
	let result = String(value);
	for (const secret of transientSecretValues) result = result.split(secret).join("<redacted-signer-secret>");
	return result;
}

const SIGNER_ENV_KEYS = [
	"SYMMIO_SIGNER_MODE",
	"SYMMIO_EPHEMERAL_PRIVATE_KEY",
	"SYMMIO_EXPECTED_SIGNER",
	"SYMMIO_LEDGER_ADDRESS",
	"SYMMIO_LEDGER_DERIVATION",
	"SYMMIO_SAFE_ACTIONS_ONLY",
	"SYMMIO_SAFE_ADDRESS",
	"USE_KEYSTORE",
	"KEYSTORE_DEPLOYER_KEY",
	"KEYSTORE_ACCOUNTS",
];

export async function withSignerEnvironment(selection, ui, action) {
	if (!selection) return action();
	await hydrateSigner(selection, ui);
	const previous = new Map(SIGNER_ENV_KEYS.map(key => [key, process.env[key]]));
	Object.assign(process.env, signerEnvironment(selection));
	try {
		return await action();
	} finally {
		for (const key of SIGNER_ENV_KEYS) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function safeDirectory(root, chainId, network) {
	const scope = String(network || "").startsWith("fork-") ? `${chainId}-fork` : String(chainId);
	return path.join(root, "tasks", "data", scope, "safe");
}

function safeArtifactPaths(root, chainId, network, runId, digest) {
	const base = `${String(runId).replace(/[^A-Za-z0-9._-]/g, "-")}-${digest.slice(0, 12)}`;
	const directory = safeDirectory(root, chainId, network);
	return {
		builder: path.join(directory, `${base}.json`),
		intent: path.join(directory, `${base}.intent.json`),
		proposal: path.join(directory, `${base}.proposal.json`),
	};
}

export async function dispatchSafeActions(
	ctx,
	selection,
	actions,
	{ root = PROJECT_ROOT, chainId, network, name, description, processEnv = {}, stateKey } = {},
) {
	if (!SAFE_SIGNER_MODES.includes(selection?.mode)) throw new Error("Safe action dispatch requires a Safe signer mode");
	if (stateKey !== undefined && !/^[a-z][a-z0-9.-]*$/.test(stateKey)) {
		throw new Error(`Safe dispatch state key must be a stable lowercase id; received ${JSON.stringify(stateKey)}`);
	}
	if (selection.mode === SIGNER_MODES.SAFE_SERVICE && (network === "localhost" || String(network).startsWith("fork-"))) {
		throw new Error("Safe Transaction Service proposals are refused for local and fork networks");
	}
	const batch = createSafeBatch({ root, chainId, safeAddress: selection.safeAddress, name, description, actions });
	const paths = safeArtifactPaths(root, chainId, network, ctx.state.runId, batch.digest);
	const previous = stateKey === undefined ? ctx.state.safeDispatch : ctx.state.safeDispatches?.[stateKey];
	if (previous && previous.digest !== batch.digest) {
		throw new Error(
			`Pending Safe intent${stateKey ? ` ${stateKey}` : ""} changed (${previous.digest.slice(0, 12)} != ${batch.digest.slice(0, 12)}); refusing to replace reviewed actions`,
		);
	}
	writeSafeBatch(paths.builder, batch);
	writeSafeIntent(paths.intent, batch);
	const dispatch = {
		...(stateKey ? { stateKey } : {}),
		mode: selection.mode,
		safeAddress: selection.safeAddress,
		digest: batch.digest,
		actionCount: batch.actions.length,
		builderPath: paths.builder,
		intentPath: paths.intent,
		proposalPath: selection.mode === SIGNER_MODES.SAFE_SERVICE ? paths.proposal : undefined,
		status: previous?.status || "exported",
	};
	if (stateKey === undefined) ctx.state.safeDispatch = dispatch;
	else {
		ctx.state.safeDispatches ||= {};
		ctx.state.safeDispatches[stateKey] = dispatch;
	}
	ctx.emit("safe.exported", { safe: dispatch });
	if (selection.mode === SIGNER_MODES.SAFE_FILE) return dispatch;
	if (previous?.status === "proposed" && fs.existsSync(paths.proposal)) return previous;
	await hydrateSigner(selection, ctx.ui);
	const apiKey = transientSecrets.get(selection)?.apiKey;
	const env = {
		...processEnv,
		...signerEnvironment(selection.owner),
		SYMMIO_SAFE_ACTIONS_ONLY: "false",
		SYMMIO_SAFE_ADDRESS: "",
		SYMMIO_SAFE_API_KEY: apiKey,
		SUBMIT_SAFE_PROPOSAL: "true",
		CONFIRM_CHAIN_ID: String(chainId),
		CONFIRM_SAFE_ADDRESS: selection.safeAddress,
	};
	await ctx.runProcess(
		"./node_modules/.bin/hardhat",
		["internal:propose-safe-batch", "--input", paths.intent, "--output", paths.proposal, "--network", network],
		{ env },
	);
	const proposal = JSON.parse(fs.readFileSync(paths.proposal, "utf8"));
	if (proposal.digest !== batch.digest || proposal.safeAddress !== selection.safeAddress) {
		throw new Error("Safe proposal result is not bound to the reviewed batch");
	}
	dispatch.status = "proposed";
	dispatch.safeTxHash = proposal.safeTxHash;
	dispatch.proposedBy = proposal.proposedBy;
	ctx.emit("safe.proposed", { safe: dispatch });
	return dispatch;
}

export function validateSignerSelection(selection, { allowSafe = true } = {}) {
	if (!selection || !Object.values(SIGNER_MODES).includes(selection.mode)) throw new Error("Signer selection has an unknown mode");
	if (!allowSafe && SAFE_SIGNER_MODES.includes(selection.mode)) throw new Error("This signing role cannot use a Safe transaction intent");
	if (selection.mode === SIGNER_MODES.KEYSTORE && !keyName(selection.key)) throw new Error("Keystore signer requires a valid key name");
	if (selection.mode === SIGNER_MODES.KEYSTORE && selection.address !== undefined && !nonZeroAddress(selection.address)) {
		throw new Error("Keystore signer requires a valid non-zero expected address when one is bound");
	}
	if ([SIGNER_MODES.PRIVATE_KEY, SIGNER_MODES.LEDGER].includes(selection.mode) && !nonZeroAddress(selection.address)) {
		throw new Error(`${modeLabel(selection.mode)} requires a non-zero address`);
	}
	if (selection.mode === SIGNER_MODES.LOCAL_NODE && selection.address !== undefined && !nonZeroAddress(selection.address)) {
		throw new Error("Unlocked local-node account requires a valid non-zero address when one is bound");
	}
	if (SAFE_SIGNER_MODES.includes(selection.mode) && !nonZeroAddress(selection.safeAddress))
		throw new Error("Safe signer requires a non-zero Safe address");
	if (selection.mode === SIGNER_MODES.SAFE_SERVICE) {
		if (!selection.owner) throw new Error("Safe service signer requires an owner signer");
		validateSignerSelection(selection.owner, { allowSafe: false });
	}
	return selection;
}

export { safeBatchDigest };
