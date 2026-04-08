import fs from "fs"

/**
 * Shared fields from upgrade.json that other config files can fall back to,
 * avoiding duplication of diamondAddress, subgraphEndpoint, etc.
 */
export type UpgradeConfigShared = {
	diamondAddress?: string
	protocolAdmin?: string
	safeAddress?: string
	subgraphEndpoint?: string
	spotCheckCount?: number
	symmioFeeReceiver?: string
	symmioPartyBAddress?: string
}

const DEFAULT_UPGRADE_CONFIG_FILE = "./scripts/upgrade/config/upgrade.json"

let cachedConfig: UpgradeConfigShared | null = null

/**
 * Load shared fields from upgrade.json (cached after first call).
 * Returns an empty object if the file doesn't exist.
 */
export function loadUpgradeConfigShared(): UpgradeConfigShared {
	if (cachedConfig !== null) return cachedConfig
	const configPath = process.env.UPGRADE_CONFIG_FILE ?? DEFAULT_UPGRADE_CONFIG_FILE
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
