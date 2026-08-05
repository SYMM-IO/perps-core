// Shared context: .env loading, chain registry, RPC/provider resolution, deployer
// identity. Mirrors how hardhat.config.ts resolves things, so the CLI reports what a real
// deploy would actually do rather than a parallel guess.

import fs from "node:fs"
import path from "node:path"
import { JsonRpcProvider, Wallet } from "ethers"

import { KNOWN_MAINNET_CHAIN_IDS, UNSAFE_DEPLOYERS } from "./safety-mirror.js"

/** Networks defined in hardhat.config.ts, with their default RPC and explorer. */
export const CHAINS = {
	arbitrum: { chainId: 42161, name: "Arbitrum One", rpc: "https://arbitrum.llamarpc.com", explorer: "https://arbiscan.io" },
	base: { chainId: 8453, name: "Base", rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
	bsc: { chainId: 56, name: "BNB Smart Chain", rpc: "https://bsc-rpc.publicnode.com", explorer: "https://bscscan.com" },
	mantle: { chainId: 5000, name: "Mantle", rpc: "https://mantle.drpc.org", explorer: "https://mantlescan.xyz" },
	hyperevm: { chainId: 999, name: "HyperEVM", rpc: "https://rpc.hyperliquid.xyz/evm", explorer: "https://hyperevmscan.io" },
	sonic: { chainId: 146, name: "Sonic", rpc: "https://rpc.soniclabs.com", explorer: "https://sonicscan.org" },
	plasma: { chainId: 9745, name: "Plasma", rpc: "https://rpc.plasma.to", explorer: "https://plasmascan.to" },
	bera: { chainId: 80094, name: "Berachain", rpc: "https://rpc.berachain.com", explorer: "https://berascan.com" },
	polygon: { chainId: 137, name: "Polygon", rpc: "https://polygon-rpc.com", explorer: "https://polygonscan.com" },
	mode: { chainId: 34443, name: "Mode", rpc: "https://mainnet.mode.network", explorer: "https://modescan.io" },
	blast: { chainId: 81457, name: "Blast", rpc: "https://rpc.blast.io", explorer: "https://blastscan.io" },
	iota: { chainId: 8822, name: "IOTA", rpc: "https://json-rpc.evm.iotaledger.net", explorer: "https://explorer.evm.iota.org" },
	sei: { chainId: 1329, name: "Sei", rpc: "https://evm-rpc.sei-apis.com", explorer: "https://seitrace.com" },
	coti: { chainId: 2632500, name: "COTI", rpc: "https://mainnet.coti.io/rpc", explorer: "https://mainnet.cotiscan.io" },
}

/** Well-known collateral tokens, used to sanity-check COLLATERAL_ADDRESS. */
export const KNOWN_COLLATERAL = {
	42161: { "0xaf88d065e77c8cc2239327c5edb3a432268e5831": "USDC (native)", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": "USDC.e (bridged)" },
	8453: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC" },
	999: { "0xb88339cb7199b77e23db6e890353e22632ba630f": "USDC" },
}

export { KNOWN_MAINNET_CHAIN_IDS, UNSAFE_DEPLOYERS }

/** Minimal .env parser — avoids depending on dotenv's load order or its side effects. */
export function loadEnv(file = ".env") {
	const envPath = path.resolve(process.cwd(), process.env.DOTENV_CONFIG_PATH || file)
	const vars = {}
	if (!fs.existsSync(envPath)) return { vars, path: envPath, exists: false }

	for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
		const line = raw.trim()
		if (!line || line.startsWith("#")) continue
		const eq = line.indexOf("=")
		if (eq === -1) continue
		const key = line.slice(0, eq).trim()
		let value = line.slice(eq + 1).trim()
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		}
		vars[key] = value
	}
	return { vars, path: envPath, exists: true }
}

export function resolveNetwork(networkName) {
	const chain = CHAINS[networkName]
	if (!chain) {
		const known = Object.keys(CHAINS).join(", ")
		throw new Error(`Unknown network "${networkName}". Known: ${known}`)
	}
	return { key: networkName, ...chain }
}

/** RPC resolution mirrors hardhat.config.ts: RPC_<NETWORK> uppercase, else the default. */
export function rpcUrl(networkName, env) {
	const key = `RPC_${networkName.toUpperCase()}`
	return env[key] || process.env[key] || CHAINS[networkName]?.rpc
}

export function makeProvider(networkName, env) {
	const url = rpcUrl(networkName, env)
	const chainId = CHAINS[networkName]?.chainId
	return new JsonRpcProvider(url, chainId, { staticNetwork: true })
}

/**
 * Resolve the deployer exactly as hardhat.config.ts does:
 *   NEW_DEPLOYER -> TEAM_DEPLOYER -> keystore (when USE_KEYSTORE=true) -> DUMMY_PRIVATE_KEY
 * The dummy fallback is why `doctor` exists — it is committed to this repo.
 */
export const DUMMY_PRIVATE_KEY = "0xec81e00837948239d5927bcb2b785675552bc92f1d2607ee91c540ddb56d6796"

export function resolveDeployer(env) {
	const merged = { ...env, ...process.env }
	const useKeystore = merged.USE_KEYSTORE === "true"

	const fromVar = merged.NEW_DEPLOYER || merged.TEAM_DEPLOYER
	if (fromVar) {
		try {
			return { source: merged.NEW_DEPLOYER ? "NEW_DEPLOYER" : "TEAM_DEPLOYER", address: new Wallet(fromVar).address, isDummy: false }
		} catch {
			return { source: merged.NEW_DEPLOYER ? "NEW_DEPLOYER" : "TEAM_DEPLOYER", address: null, isDummy: false, invalid: true }
		}
	}

	if (useKeystore) {
		// The key lives in hardhat's encrypted keystore; we cannot read it without the
		// password, and we should not try. Report it as unresolvable-but-configured.
		return { source: "keystore", address: null, isDummy: false, keystore: true }
	}

	return { source: "DUMMY_PRIVATE_KEY fallback", address: new Wallet(DUMMY_PRIVATE_KEY).address, isDummy: true }
}

export function isMainnet(chainId) {
	return KNOWN_MAINNET_CHAIN_IDS.has(Number(chainId))
}

export function explorerAddressUrl(networkName, address) {
	const base = CHAINS[networkName]?.explorer
	return base ? `${base}/address/${address}` : address
}

/** Deployment records written by the deploy tasks, chainId-scoped since this audit. */
export function deploymentRecordDir(chainId) {
	return path.join("tasks", "data", String(Number(chainId)))
}

export function readDeploymentRecords(chainId) {
	const files = ["stablecoin.json", "deployed.json", "accountlayer.json", "instantlayer.json", "partyb.json", "liquidator.json", "symbolmanager.json"]
	const dir = deploymentRecordDir(chainId)
	const out = []
	for (const file of files) {
		for (const candidate of [path.join(dir, file), path.join("tasks", "data", file)]) {
			if (!fs.existsSync(candidate)) continue
			try {
				const data = JSON.parse(fs.readFileSync(candidate, "utf8"))
				if (Array.isArray(data)) out.push(...data.map(d => ({ ...d, _file: candidate })))
			} catch {
				/* unreadable record — status reports it as missing rather than crashing */
			}
			break // scoped path wins over the legacy one
		}
	}
	return out
}

export function readCheckpoint(chainId) {
	const p = path.join("tasks", "data", "checkpoints", `checkpoint-${Number(chainId)}.json`)
	if (!fs.existsSync(p)) return null
	try {
		return { ...JSON.parse(fs.readFileSync(p, "utf8")), _path: p }
	} catch {
		return { _path: p, _corrupt: true }
	}
}
