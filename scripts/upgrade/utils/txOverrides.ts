import connection from "../../../test/helpers/hardhat-connection.js"

export type TxOverrides = {
	gasLimit?: bigint
}

const DEFAULT_DEPLOY_GAS_LIMIT = 8_000_000n
const DEFAULT_TX_GAS_LIMIT = 1_500_000n
const DEFAULT_MIGRATION_GAS_LIMIT = 8_000_000n
const DEFAULT_SET_SYMBOL_TYPES_GAS_LIMIT = 5_000_000n
const DEFAULT_ACCOUNT_LAYER_CUT_GAS_LIMIT = 8_000_000n
const DEFAULT_DIAMOND_CUT_GAS_LIMIT = 20_000_000n

function firstEnv(names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]
		if (value && value.trim()) return value.trim()
	}
	return undefined
}

function explicitGasEnabled(): boolean {
	const flag = firstEnv(["EXPLICIT_GAS_LIMITS", "USE_EXPLICIT_GAS_LIMITS"])
	if (flag) return flag !== "false" && flag !== "0"
	return connection.networkName === "coti"
}

function gasLimit(names: string[], fallback: bigint): bigint | undefined {
	const configured = firstEnv(names)
	if (!configured && !explicitGasEnabled()) return undefined
	const value = configured ?? fallback.toString()
	const parsed = BigInt(value)
	if (parsed <= 0n) throw new Error(`Invalid gas limit ${value} for ${names.join("/")}`)
	return parsed
}

export function deployTxOverrides(): TxOverrides {
	const limit = gasLimit(["DEPLOY_GAS_LIMIT", "TX_GAS_LIMIT", "GAS_LIMIT"], DEFAULT_DEPLOY_GAS_LIMIT)
	return limit ? { gasLimit: limit } : {}
}

export function writeTxOverrides(): TxOverrides {
	const limit = gasLimit(["TX_GAS_LIMIT", "GAS_LIMIT"], DEFAULT_TX_GAS_LIMIT)
	return limit ? { gasLimit: limit } : {}
}

export function migrationTxOverrides(): TxOverrides {
	const limit = gasLimit(["MIGRATION_GAS_LIMIT", "MIGRATE_GAS_LIMIT", "TX_GAS_LIMIT", "GAS_LIMIT"], DEFAULT_MIGRATION_GAS_LIMIT)
	return limit ? { gasLimit: limit } : {}
}

export function setSymbolTypesTxOverrides(): TxOverrides {
	const limit = gasLimit(["SET_SYMBOL_TYPES_GAS_LIMIT", "SYMBOL_TYPES_GAS_LIMIT", "TX_GAS_LIMIT", "GAS_LIMIT"], DEFAULT_SET_SYMBOL_TYPES_GAS_LIMIT)
	return limit ? { gasLimit: limit } : {}
}

export function accountLayerCutTxOverrides(): TxOverrides {
	const limit = gasLimit(["ACCOUNT_LAYER_CUT_GAS_LIMIT", "DIAMOND_CUT_GAS_LIMIT", "TX_GAS_LIMIT", "GAS_LIMIT"], DEFAULT_ACCOUNT_LAYER_CUT_GAS_LIMIT)
	return limit ? { gasLimit: limit } : {}
}

export function diamondCutTxOverrides(): TxOverrides {
	const limit = gasLimit(["DIAMOND_CUT_GAS_LIMIT", "TX_GAS_LIMIT", "GAS_LIMIT"], DEFAULT_DIAMOND_CUT_GAS_LIMIT)
	return limit ? { gasLimit: limit } : {}
}
