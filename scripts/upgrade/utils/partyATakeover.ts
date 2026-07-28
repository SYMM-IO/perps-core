import fs from "node:fs"

import { ethers } from "../../../test/helpers/hardhat-connection.js"

export const PARTY_A_TAKEOVER_STEPS = ["inspect", "takeover", "pending", "positions", "deallocate", "distribute", "settle", "all"] as const

export type PartyATakeoverStep = (typeof PARTY_A_TAKEOVER_STEPS)[number]

export type PartyATakeoverConfig = {
	chainId: number
	diamondAddress: string
	partyA: string
	partyB: string
}

export type PositionAccounting = {
	pricePnl: bigint
	fundingDebt: bigint
	partyANetPnl: bigint
	partyBClaim: bigint
}

export type RecoveryDeallocation = {
	remainingClaim: bigint
	fromPartyAAllocation: bigint
	fromReimbursement: bigint
	shortfall: bigint
}

export type FrozenLiquidationPriceRequest = {
	partyB: string
	symbolId: bigint
}

export type FrozenLiquidationPrice = FrozenLiquidationPriceRequest & {
	price: bigint
	source: "legacy-symbol" | "party-b-symbol-snapshot"
}

type StorageReader = {
	getStorage(address: string, position: string): Promise<string>
}

const ACCOUNT_STORAGE_SLOT = BigInt(ethers.keccak256(ethers.toUtf8Bytes("diamond.standard.storage.account")))
const SYMBOLS_PRICES_OFFSET = 12n
const LIQUIDATION_USES_PARTY_B_SYMBOL_SNAPSHOTS_OFFSET = 24n
const LIQUIDATION_PARTY_B_SYMBOL_SNAPSHOTS_OFFSET = 25n

export function parsePartyATakeoverStep(value: string | undefined): PartyATakeoverStep {
	const normalized = (value ?? "inspect").trim().toLowerCase()
	if (!(PARTY_A_TAKEOVER_STEPS as readonly string[]).includes(normalized)) {
		throw new Error(`Invalid TAKEOVER_STEP "${value}". Expected one of: ${PARTY_A_TAKEOVER_STEPS.join(", ")}`)
	}
	return normalized as PartyATakeoverStep
}

export function parsePartyATakeoverConfig(value: unknown): PartyATakeoverConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("PartyA takeover config must be a JSON object")
	}

	const config = value as Partial<PartyATakeoverConfig>
	if (!Number.isSafeInteger(config.chainId) || Number(config.chainId) <= 0) {
		throw new Error("Config chainId must be a positive integer")
	}

	for (const field of ["diamondAddress", "partyA", "partyB"] as const) {
		const address = config[field]
		if (!address || !ethers.isAddress(address) || address === ethers.ZeroAddress) {
			throw new Error(`Invalid ${field}: ${address ?? "<missing>"}`)
		}
	}

	const diamondAddress = ethers.getAddress(config.diamondAddress!)
	const partyA = ethers.getAddress(config.partyA!)
	const partyB = ethers.getAddress(config.partyB!)
	if (partyA === partyB) {
		throw new Error("Config partyA and partyB must be different addresses")
	}

	return {
		chainId: Number(config.chainId),
		diamondAddress,
		partyA,
		partyB,
	}
}

export function loadPartyATakeoverConfig(file: string): PartyATakeoverConfig {
	if (!fs.existsSync(file)) {
		throw new Error(`PartyA takeover config not found: ${file}`)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf-8"))
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Invalid JSON in ${file}: ${message}`)
	}
	return parsePartyATakeoverConfig(parsed)
}

export function calculatePositionAccounting(
	positionType: number,
	openedPrice: bigint,
	closePrice: bigint,
	openAmount: bigint,
	fundingDebt: bigint,
): PositionAccounting {
	if (positionType !== 0 && positionType !== 1) {
		throw new Error(`Unsupported position type: ${positionType}`)
	}
	if (openedPrice <= 0n || closePrice <= 0n || openAmount <= 0n) {
		throw new Error("openedPrice, closePrice, and openAmount must be positive")
	}

	const longPnl = ((closePrice - openedPrice) * openAmount) / ethers.WeiPerEther
	const pricePnl = positionType === 0 ? longPnl : -longPnl
	const partyANetPnl = pricePnl - fundingDebt

	return {
		pricePnl,
		fundingDebt,
		partyANetPnl,
		partyBClaim: partyANetPnl < 0n ? -partyANetPnl : 0n,
	}
}

/**
 * Returns the net amount owed to PartyB by an already-created normal-liquidation
 * settlement bucket. A positive result must be routed to PartyB; a negative result
 * means PartyB owes PartyA and requires a different clearing-house distribution.
 */
export function calculatePartyBSettlementRecovery(actualAmount: bigint, cva: bigint): bigint {
	return cva - actualAmount
}

export function calculateRecoveryDeallocation(
	partyBClaim: bigint,
	confirmedDistributed: bigint,
	deallocatedPool: bigint,
	partyAAllocated: bigint,
	reimbursement: bigint,
): RecoveryDeallocation {
	for (const [name, value] of [
		["partyBClaim", partyBClaim],
		["confirmedDistributed", confirmedDistributed],
		["deallocatedPool", deallocatedPool],
		["partyAAllocated", partyAAllocated],
		["reimbursement", reimbursement],
	] as const) {
		if (value < 0n) throw new Error(`${name} cannot be negative`)
	}

	const accountedRecovery = confirmedDistributed + deallocatedPool
	const remainingClaim = partyBClaim > accountedRecovery ? partyBClaim - accountedRecovery : 0n
	const fromPartyAAllocation = remainingClaim < partyAAllocated ? remainingClaim : partyAAllocated
	const afterAllocation = remainingClaim - fromPartyAAllocation
	const fromReimbursement = afterAllocation < reimbursement ? afterAllocation : reimbursement

	return {
		remainingClaim,
		fromPartyAAllocation,
		fromReimbursement,
		shortfall: afterAllocation - fromReimbursement,
	}
}

function fixedKeyMappingSlot(key: string, slot: bigint): string {
	return ethers.keccak256(ethers.concat([ethers.zeroPadValue(key, 32), ethers.toBeHex(slot, 32)]))
}

function uintKeyMappingSlot(key: bigint, slot: string): string {
	return ethers.keccak256(ethers.concat([ethers.toBeHex(key, 32), slot]))
}

function bytesKeyMappingSlot(key: string, slot: string): string {
	if (!ethers.isHexString(key)) throw new Error(`Invalid bytes mapping key: ${key}`)
	return ethers.keccak256(ethers.concat([key, slot]))
}

export function legacyLiquidationPriceSlots(partyA: string, symbolId: bigint): { price: string; timestamp: string } {
	const partyASlot = fixedKeyMappingSlot(partyA, ACCOUNT_STORAGE_SLOT + SYMBOLS_PRICES_OFFSET)
	const price = uintKeyMappingSlot(symbolId, partyASlot)
	return {
		price,
		timestamp: ethers.toBeHex(BigInt(price) + 1n, 32),
	}
}

export function liquidationSnapshotFlagSlot(partyA: string, liquidationId: string): string {
	const partyASlot = fixedKeyMappingSlot(partyA, ACCOUNT_STORAGE_SLOT + LIQUIDATION_USES_PARTY_B_SYMBOL_SNAPSHOTS_OFFSET)
	return bytesKeyMappingSlot(liquidationId, partyASlot)
}

export function partyBSymbolSnapshotSlots(partyA: string, liquidationId: string, partyB: string, symbolId: bigint): { isSet: string; price: string } {
	const partyASlot = fixedKeyMappingSlot(partyA, ACCOUNT_STORAGE_SLOT + LIQUIDATION_PARTY_B_SYMBOL_SNAPSHOTS_OFFSET)
	const liquidationSlot = bytesKeyMappingSlot(liquidationId, partyASlot)
	const partyBSlot = fixedKeyMappingSlot(partyB, BigInt(liquidationSlot))
	const isSet = uintKeyMappingSlot(symbolId, partyBSlot)
	return {
		isSet,
		price: ethers.toBeHex(BigInt(isSet) + 1n, 32),
	}
}

export async function readFrozenLiquidationPrices(
	provider: StorageReader,
	diamondAddress: string,
	partyA: string,
	liquidationId: string,
	liquidationTimestamp: bigint,
	requests: FrozenLiquidationPriceRequest[],
): Promise<FrozenLiquidationPrice[]> {
	if (!ethers.isAddress(diamondAddress) || !ethers.isAddress(partyA)) {
		throw new Error("Invalid address while reading frozen liquidation prices")
	}
	if (!ethers.isHexString(liquidationId) || ethers.dataLength(liquidationId) === 0) {
		throw new Error("Liquidation ID is empty or invalid")
	}
	if (liquidationTimestamp <= 0n) {
		throw new Error("Liquidation price timestamp is missing")
	}

	const snapshotFlag = BigInt(await provider.getStorage(diamondAddress, liquidationSnapshotFlagSlot(partyA, liquidationId)))
	if (snapshotFlag !== 0n && snapshotFlag !== 1n) {
		throw new Error(`Invalid liquidation snapshot flag storage value: ${snapshotFlag}`)
	}
	const source: FrozenLiquidationPrice["source"] = snapshotFlag === 1n ? "party-b-symbol-snapshot" : "legacy-symbol"

	return Promise.all(
		requests.map(async request => {
			if (!ethers.isAddress(request.partyB) || request.symbolId < 0n) {
				throw new Error(`Invalid frozen-price request for symbol ${request.symbolId}`)
			}

			if (source === "party-b-symbol-snapshot") {
				const slots = partyBSymbolSnapshotSlots(partyA, liquidationId, request.partyB, request.symbolId)
				const [isSet, price] = await Promise.all([provider.getStorage(diamondAddress, slots.isSet), provider.getStorage(diamondAddress, slots.price)])
				if (BigInt(isSet) !== 1n) {
					throw new Error(`Missing signed liquidation snapshot for PartyB ${request.partyB}, symbol ${request.symbolId}`)
				}
				const parsedPrice = BigInt(price)
				if (parsedPrice <= 0n) {
					throw new Error(`Invalid signed liquidation snapshot price for PartyB ${request.partyB}, symbol ${request.symbolId}`)
				}
				return { ...request, price: parsedPrice, source }
			}

			const slots = legacyLiquidationPriceSlots(partyA, request.symbolId)
			const [price, timestamp] = await Promise.all([
				provider.getStorage(diamondAddress, slots.price),
				provider.getStorage(diamondAddress, slots.timestamp),
			])
			const parsedTimestamp = BigInt(timestamp)
			if (parsedTimestamp !== liquidationTimestamp) {
				throw new Error(
					`Frozen liquidation price timestamp mismatch for symbol ${request.symbolId}: ` + `expected ${liquidationTimestamp}, got ${parsedTimestamp}`,
				)
			}
			const parsedPrice = BigInt(price)
			if (parsedPrice <= 0n) {
				throw new Error(`Invalid frozen liquidation price for symbol ${request.symbolId}`)
			}
			return { ...request, price: parsedPrice, source }
		}),
	)
}

export function formatSigned(value: bigint): string {
	return value < 0n ? `-${ethers.formatEther(-value)}` : ethers.formatEther(value)
}
