// Shared context: .env loading, chain registry, RPC/provider resolution, deployer
// identity. Mirrors how hardhat.config.ts resolves things, so the CLI reports what a real
// deploy would actually do rather than a parallel guess.
import { PROJECT_ROOT } from "./paths.js";
import { KNOWN_MAINNET_CHAIN_IDS, UNSAFE_DEPLOYERS } from "./safety-mirror.js";
import { parse as parseDotenv } from "dotenv";
import { JsonRpcProvider, Wallet } from "ethers";
import fs from "node:fs";
import path from "node:path";

/** Networks defined in hardhat.config.ts, with their default RPC and explorer. */
const BASE_CHAINS = {
	arbitrum: {
		chainId: 42161,
		name: "Arbitrum One",
		rpc: "https://arbitrum.llamarpc.com",
		forkRpc: "https://arbitrum.drpc.org",
		explorer: "https://arbiscan.io",
	},
	base: { chainId: 8453, name: "Base", rpc: "https://mainnet.base.org", forkRpc: "https://base.drpc.org", explorer: "https://basescan.org" },
	bsc: { chainId: 56, name: "BNB Smart Chain", rpc: "https://bsc-rpc.publicnode.com", explorer: "https://bscscan.com" },
	mantle: { chainId: 5000, name: "Mantle", rpc: "https://mantle.drpc.org", explorer: "https://mantlescan.xyz" },
	hyperevm: { chainId: 999, name: "HyperEVM", rpc: "https://rpc.hyperliquid.xyz/evm", explorer: "https://hyperevmscan.io" },
	sonic: { chainId: 146, name: "Sonic", rpc: "https://rpc.soniclabs.com", explorer: "https://sonicscan.org" },
	plasma: { chainId: 9745, name: "Plasma", rpc: "https://rpc.plasma.to", explorer: "https://plasmascan.to" },
	bera: { chainId: 80094, name: "Berachain", rpc: "https://rpc.berachain.com", explorer: "https://berascan.com" },
	polygon: { chainId: 137, name: "Polygon", rpc: "https://polygon-rpc.com", explorer: "https://polygonscan.com" },
	mode: {
		chainId: 34443,
		name: "Mode",
		rpc: "https://mainnet.mode.network",
		explorer: "https://explorer.mode.network",
		verification: { provider: "blockscout", apiUrl: "https://explorer.mode.network/api" },
	},
	blast: { chainId: 81457, name: "Blast", rpc: "https://rpc.blast.io", explorer: "https://blastscan.io" },
	iota: {
		chainId: 8822,
		name: "IOTA",
		rpc: "https://json-rpc.evm.iotaledger.net",
		explorer: "https://explorer.evm.iota.org",
		verification: { provider: "blockscout", apiUrl: "https://explorer.evm.iota.org/api" },
	},
	sei: { chainId: 1329, name: "Sei", rpc: "https://evm-rpc.sei-apis.com", explorer: "https://seiscan.io" },
	coti: {
		chainId: 2632500,
		name: "COTI",
		rpc: "https://mainnet.coti.io/rpc",
		explorer: "https://mainnet.cotiscan.io",
		verification: { provider: "blockscout", apiUrl: "https://mainnet.cotiscan.io/api" },
	},
	localhost: { chainId: 31337, name: "Local node", rpc: "http://127.0.0.1:8545", explorer: null },
};

const FORK_NETWORKS = ["arbitrum", "base", "bsc", "mantle", "hyperevm"];

export const CHAINS = {
	...BASE_CHAINS,
	...Object.fromEntries(
		FORK_NETWORKS.map(upstream => {
			const chain = BASE_CHAINS[upstream];
			return [
				`fork-${upstream}`,
				{
					...chain,
					name: `${chain.name} fork`,
					simulated: true,
					upstream,
				},
			];
		}),
	),
};

/** Well-known collateral tokens, used to sanity-check COLLATERAL_ADDRESS. */
export const KNOWN_COLLATERAL = {
	42161: { "0xaf88d065e77c8cc2239327c5edb3a432268e5831": "USDC (native)", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": "USDC.e (bridged)" },
	8453: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC" },
	999: { "0xb88339cb7199b77e23db6e890353e22632ba630f": "USDC" },
};

export { KNOWN_MAINNET_CHAIN_IDS, UNSAFE_DEPLOYERS };

export function verificationProviderForChain(chain) {
	return chain.verification?.provider || "etherscan";
}

/**
 * Parse the same dotenv syntax Hardhat uses, without mutating process.env. Existing process
 * variables win, matching dotenv's default `override: false` behaviour.
 */
export function loadEnv(file = ".env", processEnv = process.env) {
	const configuredPath = processEnv.DOTENV_CONFIG_PATH || file;
	const envPath = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(PROJECT_ROOT, configuredPath);
	const fileVars = fs.existsSync(envPath) ? parseDotenv(fs.readFileSync(envPath)) : {};
	return {
		vars: { ...fileVars, ...processEnv },
		fileVars,
		path: envPath,
		exists: fs.existsSync(envPath),
	};
}

export function resolveNetwork(networkName) {
	const chain = CHAINS[networkName];
	if (!chain) {
		const known = Object.keys(CHAINS).join(", ");
		throw new Error(`Unknown network "${networkName}". Known: ${known}`);
	}
	return { key: networkName, ...chain };
}

/** RPC resolution mirrors hardhat.config.ts: RPC_<NETWORK> uppercase, else the default. */
export function rpcEnvKey(networkName) {
	const chain = CHAINS[networkName];
	const rpcNetwork = chain?.upstream || networkName;
	return `RPC_${rpcNetwork.toUpperCase()}`;
}

/**
 * Resolve the endpoint Hardhat will actually use without pretending an encrypted value is
 * readable. Most HTTP/fork networks honor SYMMIO_RPC_URL_OVERRIDE first, then resolve their
 * RPC_<NETWORK> value from the keystore when USE_KEYSTORE=true. localhost and
 * fork-hyperevm are direct process-env configurations in hardhat.config.ts and therefore do
 * not use either mechanism.
 */
export function resolveRpc(networkName, env) {
	const key = rpcEnvKey(networkName);
	const chain = CHAINS[networkName];
	const fallback = chain?.simulated ? chain.forkRpc || chain.rpc : chain?.rpc;
	const directProcessEnv = networkName === "localhost" || networkName === "fork-hyperevm";

	if (directProcessEnv) {
		return env[key]
			? { url: env[key], source: key, key, inspectable: true }
			: { url: fallback, source: "built-in public endpoint", key, inspectable: true };
	}
	if (env.SYMMIO_RPC_URL_OVERRIDE) {
		return {
			url: env.SYMMIO_RPC_URL_OVERRIDE,
			source: "SYMMIO_RPC_URL_OVERRIDE",
			key,
			inspectable: true,
		};
	}
	if (env.USE_KEYSTORE === "true") {
		return {
			url: null,
			source: `Hardhat keystore (${key})`,
			key,
			inspectable: false,
		};
	}
	return env[key]
		? { url: env[key], source: key, key, inspectable: true }
		: { url: fallback, source: "built-in public endpoint", key, inspectable: true };
}

export function rpcUrl(networkName, env) {
	const resolution = resolveRpc(networkName, env);
	if (!resolution.inspectable || !resolution.url) {
		throw new Error(
			`${resolution.key} is resolved from the encrypted Hardhat keystore and cannot be read by this JavaScript command. ` +
				"Set SYMMIO_RPC_URL_OVERRIDE to the exact endpoint for this read-only CLI run.",
		);
	}
	return resolution.url;
}

export function makeProvider(networkName, env) {
	const url = rpcUrl(networkName, env);
	const chainId = CHAINS[networkName]?.chainId;
	return new JsonRpcProvider(url, chainId, { staticNetwork: true });
}

/**
 * Resolve the deployer exactly as hardhat.config.ts does for live HTTP networks:
 *   NEW_DEPLOYER -> TEAM_DEPLOYER -> keystore (when USE_KEYSTORE=true) -> no signer.
 * The committed dummy key is now local-only and is never configured on a live network.
 */
export const DUMMY_PRIVATE_KEY = "0xec81e00837948239d5927bcb2b785675552bc92f1d2607ee91c540ddb56d6796";

export function resolveDeployer(env, { allowLocalDummy = false } = {}) {
	const useKeystore = env.USE_KEYSTORE === "true";

	const fromVar = env.NEW_DEPLOYER || env.TEAM_DEPLOYER;
	if (fromVar) {
		try {
			return { source: env.NEW_DEPLOYER ? "NEW_DEPLOYER" : "TEAM_DEPLOYER", address: new Wallet(fromVar).address, isDummy: false };
		} catch {
			return { source: env.NEW_DEPLOYER ? "NEW_DEPLOYER" : "TEAM_DEPLOYER", address: null, isDummy: false, invalid: true };
		}
	}

	if (useKeystore) {
		// The key lives in hardhat's encrypted keystore; we cannot read it without the
		// password, and we should not try. Report it as unresolvable-but-configured.
		return { source: "keystore", address: null, isDummy: false, keystore: true };
	}

	if (allowLocalDummy) {
		return { source: "local DUMMY_PRIVATE_KEY fallback", address: new Wallet(DUMMY_PRIVATE_KEY).address, isDummy: true };
	}
	return { source: "no configured signer", address: null, isDummy: false, missing: true };
}

export function isMainnet(chainId) {
	return KNOWN_MAINNET_CHAIN_IDS.has(Number(chainId));
}

export function isLiveMainnet(chain) {
	return !chain.simulated && isMainnet(chain.chainId);
}

export function explorerAddressUrl(networkName, address) {
	const base = CHAINS[networkName]?.explorer;
	return base ? `${base}/address/${address}` : address;
}

/** Deployment records written by the deploy tasks, chainId-scoped since this audit. */
export function deploymentRecordDir(chainId, { simulated = false } = {}) {
	return path.join(PROJECT_ROOT, "tasks", "data", `${Number(chainId)}${simulated ? "-fork" : ""}`);
}

export function readDeploymentRecords(chainId, options = {}) {
	const files = [
		"stablecoin.json",
		"deployed.json",
		"accountlayer.json",
		"instantlayer.json",
		"partyb.json",
		"liquidator.json",
		"symbolmanager.json",
	];
	const dir = deploymentRecordDir(chainId, options);
	const out = [];
	for (const file of files) {
		const candidates = options.simulated ? [path.join(dir, file)] : [path.join(dir, file), path.join(PROJECT_ROOT, "tasks", "data", file)];
		for (const candidate of candidates) {
			if (!fs.existsSync(candidate)) continue;
			try {
				const data = JSON.parse(fs.readFileSync(candidate, "utf8"));
				if (Array.isArray(data)) out.push(...data.map(d => ({ ...d, _file: candidate })));
			} catch (error) {
				throw new Error(`deployment record ${candidate} is unreadable: ${error.message || error}`);
			}
			break; // scoped path wins over the legacy one
		}
	}
	return out;
}

/**
 * The deployment report carries an unambiguous `addresses` map. The per-contract record
 * files cannot be used for this: both deployed.json and accountlayer.json contain an entry
 * literally named "Diamond", so looking up by name picks whichever was read first.
 */
export function readDeploymentReport(chainId, options = {}) {
	const scoped = path.join(deploymentRecordDir(chainId, options), "deployment-report.json");
	const candidates = options.simulated ? [scoped] : [scoped, path.join(PROJECT_ROOT, "tasks", "data", "deployment-report.json")];
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			return JSON.parse(fs.readFileSync(candidate, "utf8"));
		} catch (error) {
			throw new Error(`deployment report ${candidate} is unreadable: ${error.message || error}`);
		}
	}
	return null;
}

export function normalizeCheckpointScope(scope) {
	if (scope === undefined || scope === "") return undefined;
	if (typeof scope !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scope) || scope === "." || scope === "..") {
		throw new Error(`invalid deployment checkpoint scope ${JSON.stringify(scope)}`);
	}
	return scope;
}

export function deploymentCheckpointPath(chainId, { simulated = false, scope } = {}) {
	const normalizedScope = normalizeCheckpointScope(scope);
	const scopeSuffix = normalizedScope ? `-${normalizedScope}` : "";
	return path.join(PROJECT_ROOT, "tasks", "data", "checkpoints", `checkpoint-${Number(chainId)}${simulated ? "-fork" : ""}${scopeSuffix}.json`);
}

export function readCheckpoint(chainId, options = {}) {
	const p = deploymentCheckpointPath(chainId, options);
	if (!fs.existsSync(p)) return null;
	try {
		const checkpoint = JSON.parse(fs.readFileSync(p, "utf8"));
		const expectedScope = normalizeCheckpointScope(options.scope);
		const actualScope = normalizeCheckpointScope(checkpoint.scope);
		if (expectedScope !== actualScope) {
			return { ...checkpoint, _path: p, _scopeMismatch: true, _expectedScope: expectedScope, _actualScope: actualScope };
		}
		return { ...checkpoint, _path: p };
	} catch {
		return { _path: p, _corrupt: true };
	}
}
