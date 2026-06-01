import fs from "fs"

/**
 * Shared fields from upgrade.json that other config files can fall back to,
 * avoiding duplication of diamondAddress, subgraphEndpoint, etc.
 */
export type UpgradeConfigShared = {
	diamondAddress?: string
	protocolAdmin?: string
	upgradeOperator?: string
	safeAddress?: string

	migrationRunner?: string
	subgraphEndpoint?: string
	subgraphEndpoints?: string[]
	spotCheckCount?: number
	symmioFeeReceiver?: string
	instantLayerAddress?: string
	accountLayerDiamondAddress?: string
	newV085Parameters?: {
		symbolType?: number
		signatureVerifierAddress?: string
		liquidationInsuranceVault?: string
		maxLiquidationProfitPerPosition?: string
	}
}

const CONFIG_DIR = "./scripts/upgrade/config"

let cachedConfig: UpgradeConfigShared | null = null

/**
 * Map the hardhat network name to the suffix used for network-postfixed config
 * files (upgrade-<suffix>.json, partyBList-<suffix>.json, etc.).
 *
 * Resolution order:
 *   1. NETWORK_ALIAS env var, if set — use this when running against a forked
 *      node via a generic network name (e.g. --network docker pointing at a
 *      Base fork node, set NETWORK_ALIAS=base).
 *   2. Strip a leading "fork-" prefix (so "fork-base" → "base").
 *   3. Otherwise return the network name unchanged.
 */
export function baseNetworkName(name?: string): string | undefined {
	if (process.env.NETWORK_ALIAS) return process.env.NETWORK_ALIAS
	if (!name) return undefined
	return name.startsWith("fork-") ? name.slice("fork-".length) : name
}

/**
 * Resolve a config file path with network-name fallback.
 *
 * Tries `config/{baseName}-{networkName}.json` first, falls back to
 * `config/{baseName}.json`. Env var override (if provided) takes top priority.
 */
export function resolveConfigFile(baseName: string, networkName?: string, envOverride?: string): string {
	if (envOverride) return envOverride
	if (networkName) {
		const networkSpecific = `${CONFIG_DIR}/${baseName}-${networkName}.json`
		if (fs.existsSync(networkSpecific)) return networkSpecific
	}
	return `${CONFIG_DIR}/${baseName}.json`
}

/**
 * Load shared fields from upgrade.json (cached after first call).
 * Returns an empty object if the file doesn't exist.
 */
export function loadUpgradeConfigShared(networkName?: string): UpgradeConfigShared {
	if (cachedConfig !== null) return cachedConfig
	const configPath = resolveConfigFile("upgrade", networkName, process.env.UPGRADE_CONFIG_FILE)
	if (!fs.existsSync(configPath)) {
		cachedConfig = {}
		return cachedConfig
	}
	try {
		cachedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as UpgradeConfigShared
	} catch {
		cachedConfig = {}
	}
	return cachedConfig
}
