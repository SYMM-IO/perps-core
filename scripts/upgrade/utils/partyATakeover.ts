import fs from "node:fs"

import { ethers } from "../../../test/helpers/hardhat-connection.js"

export const PARTY_A_TAKEOVER_STEPS = ["inspect", "pending", "positions", "deallocate", "distribute", "settle", "all"] as const

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

export type MuonPriceResult = {
	quoteIds: bigint[]
	prices: bigint[]
	symbols: string[]
	latestBlockNumber: string
	timestamp: number
}

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

export function parseMuonPriceResponse(value: unknown, expectedChainId: number, expectedSymmio: string, expectedQuoteIds: bigint[]): MuonPriceResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Muon response must be a JSON object")
	}

	const response = value as any
	if (response.success !== true) {
		throw new Error(`Muon request failed: ${response.error?.message ?? response.message ?? "unknown error"}`)
	}

	const data = response.result?.data
	const result = data?.result
	if (!result || typeof result !== "object") {
		throw new Error("Muon response is missing result.data.result")
	}
	if (String(result.chainId) !== String(expectedChainId)) {
		throw new Error(`Muon chainId mismatch: expected ${expectedChainId}, got ${String(result.chainId)}`)
	}
	if (String(result.symmio).toLowerCase() !== expectedSymmio.toLowerCase()) {
		throw new Error(`Muon Symmio address mismatch: expected ${expectedSymmio}, got ${String(result.symmio)}`)
	}

	if (!Array.isArray(result.quoteIds) || !Array.isArray(result.prices) || !Array.isArray(result.symbols)) {
		throw new Error("Muon response quoteIds, prices, and symbols must be arrays")
	}
	if (result.quoteIds.length !== expectedQuoteIds.length || result.prices.length !== expectedQuoteIds.length) {
		throw new Error(`Muon response length mismatch: expected ${expectedQuoteIds.length} quote(s)`)
	}

	const quoteIds = result.quoteIds.map((quoteId: unknown) => BigInt(String(quoteId)))
	const prices = result.prices.map((price: unknown) => BigInt(String(price)))
	const symbols = result.symbols.map((symbol: unknown) => String(symbol))

	for (let i = 0; i < expectedQuoteIds.length; i++) {
		if (quoteIds[i] !== expectedQuoteIds[i]) {
			throw new Error(`Muon quote order mismatch at index ${i}: expected ${expectedQuoteIds[i]}, got ${quoteIds[i]}`)
		}
		if (prices[i] <= 0n) {
			throw new Error(`Muon returned a non-positive price for quote ${quoteIds[i]}`)
		}
	}

	const timestamp = Number(data.timestamp)
	if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
		throw new Error(`Invalid Muon timestamp: ${String(data.timestamp)}`)
	}

	return {
		quoteIds,
		prices,
		symbols,
		latestBlockNumber: String(result.latestBlockNumber),
		timestamp,
	}
}

export function formatSigned(value: bigint): string {
	return value < 0n ? `-${ethers.formatEther(-value)}` : ethers.formatEther(value)
}
