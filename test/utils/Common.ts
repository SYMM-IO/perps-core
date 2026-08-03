import { JsonSerializer } from "typescript-json-serializer"

import type { QuoteStructOutput, SymbolStructOutput } from "../../src/types/interfaces/ISymmio.js"
import { network } from "../helpers/hardhat-connection.js"
import { time } from "../helpers/network-helpers.js"
import { OrderType, QuoteStatus } from "../models/Enums.js"
import type { RunContext } from "../models/RunContext.js"
import { safeDiv } from "./SafeMath.js"

const defaultSerializer = new JsonSerializer()

export type PromiseOrValue<T> = T | Promise<T>

export function decimal(value: bigint, decimal: number = 18): bigint {
	return value * 10n ** BigInt(decimal)
}

export function unDecimal(value: bigint, decimal: number = 18): bigint {
	return value / 10n ** BigInt(decimal)
}

export async function getBlockTimestamp(additional: bigint = 0n): Promise<bigint> {
	const latest = await time.latest()
	const latestBigInt = typeof latest === "bigint" ? latest : BigInt(latest)
	return latestBigInt + 1n + additional
}

export async function getQuoteQuantity(context: RunContext, quoteId: bigint): Promise<bigint> {
	return (await context.viewFacetQuote.getQuote(quoteId)).quantity
}

export async function getQuoteMinLeftQuantityForClose(context: RunContext, quoteId: bigint): Promise<bigint> {
	const openAmount = await getQuoteOpenAmount(context, quoteId)
	const totalLocked = await getTotalLockedValuesForQuoteIds(context, [quoteId])

	const q = await context.viewFacetQuote.getQuote(quoteId)
	const symbol: SymbolStructOutput = await context.viewFacetSymbol.getSymbol(q.symbolId)

	return safeDiv(symbol.minAcceptableQuoteValue * openAmount, totalLocked)
}

export async function getQuoteMinLeftQuantityForFill(context: RunContext, quoteId: bigint): Promise<bigint> {
	const openAmount = await getQuoteOpenAmount(context, quoteId)
	const totalLocked = await getTotalLockedValuesForQuoteIds(context, [quoteId])

	const q = await context.viewFacetQuote.getQuote(quoteId)
	const symbol: SymbolStructOutput = await context.viewFacetSymbol.getSymbol(q.symbolId)

	return safeDiv(symbol.minAcceptableQuoteValue * openAmount, totalLocked)
}

export async function getQuoteOpenAmount(context: RunContext, quoteId: bigint): Promise<bigint> {
	const q = await context.viewFacetQuote.getQuote(quoteId)
	return q.quantity - q.closedAmount
}

export async function getQuoteNotFilledAmount(context: RunContext, quoteId: bigint): Promise<bigint> {
	const q = await context.viewFacetQuote.getQuote(quoteId)
	return q.quantityToClose - q.closedAmount
}

export async function getTotalPartyALockedValuesForQuotes(
	quotes: QuoteStructOutput[],
	includeMM: boolean = true,
	returnAfterOpened: boolean = true,
): Promise<bigint> {
	let out = 0n
	for (const q of quotes) {
		let addition = q.lockedValues.cva + q.lockedValues.lf
		if (includeMM) addition += q.lockedValues.partyAmm
		if (returnAfterOpened && q.orderType === BigInt(OrderType.LIMIT)) {
			if (q.requestedOpenPrice < q.openedPrice) addition *= q.openedPrice / q.requestedOpenPrice
		}
		out += addition
	}
	return out
}

export async function getTotalPartyBLockedValuesForQuotes(
	quotes: QuoteStructOutput[],
	includeMM: boolean = true,
	returnAfterOpened: boolean = true,
): Promise<bigint> {
	let out = 0n
	for (const q of quotes) {
		let addition = q.lockedValues.cva + q.lockedValues.lf
		if (includeMM) addition += q.lockedValues.partyBmm
		if (returnAfterOpened && q.orderType === BigInt(OrderType.LIMIT)) {
			if (q.requestedOpenPrice < q.openedPrice) addition *= q.openedPrice / q.requestedOpenPrice
		}
		out += addition
	}
	return out
}

export async function getTotalLockedValuesForQuoteIds(
	context: RunContext,
	quoteIds: bigint[],
	includeMM: boolean = true,
	returnAfterOpened: boolean = true,
): Promise<bigint> {
	let quotes: QuoteStructOutput[] = []
	for (const quoteId of quoteIds) quotes.push(await context.viewFacetQuote.getQuote(quoteId))
	return getTotalPartyALockedValuesForQuotes(quotes, includeMM, returnAfterOpened)
}

export async function getTradingFeeForQuotes(context: RunContext, quoteIds: bigint[]): Promise<bigint> {
	let out = 0n
	for (const quoteId of quoteIds) {
		let q = await context.viewFacetQuote.getQuote(quoteId)
		// Use the quote's actual trading fee, not the symbol's default
		let tf = q.tradingFee
		if (q.orderType === BigInt(OrderType.LIMIT)) out += unDecimal(q.quantity * q.requestedOpenPrice * tf, 36)
		else out += unDecimal(q.quantity * q.marketPrice * tf, 36)
	}
	return out
}

export async function getTradingFeeForQuoteWithFilledAmount(context: RunContext, quoteId: bigint, filledAmounts: bigint): Promise<bigint> {
	let out = 0n
	let q = await context.viewFacetQuote.getQuote(quoteId)
	let tf = q.tradingFee
	if (q.orderType === BigInt(OrderType.LIMIT)) out += unDecimal(filledAmounts * q.requestedOpenPrice * tf, 36)
	else out += unDecimal(filledAmounts * q.marketPrice * tf, 36)
	return out
}

export async function getOpenTradingFeeForQuoteWithFilledAmount(context: RunContext, quoteId: bigint, filledAmounts: bigint): Promise<bigint> {
	let out = 0n
	let q = await context.viewFacetQuote.getQuote(quoteId)
	let tf = q.tradingFee
	if (q.orderType === BigInt(OrderType.LIMIT)) out += unDecimal(filledAmounts * q.requestedOpenPrice * tf, 36)
	else out += unDecimal(filledAmounts * q.marketPrice * tf, 36)
	return out
}

export async function getCloseTradingFeeForQuoteWithFilledAmount(context: RunContext, quoteId: bigint, filledAmounts: bigint): Promise<bigint> {
	let out = 0n
	let q = await context.viewFacetQuote.getQuote(quoteId)
	let tf = q.closeFee
	if (q.orderType === BigInt(OrderType.LIMIT)) out += unDecimal(filledAmounts * q.requestedOpenPrice * tf, 36)
	else out += unDecimal(filledAmounts * q.marketPrice * tf, 36)
	return out
}

export async function getCloseTradingFeeForQuotes(context: RunContext, quoteIds: bigint[]): Promise<bigint> {
	let out = 0n
	for (const quoteId of quoteIds) {
		let q = await context.viewFacetQuote.getQuote(quoteId)
		let tf = q.closeFee
		if (q.orderType === BigInt(OrderType.LIMIT)) out += unDecimal(q.quantity * q.requestedOpenPrice * tf, 36)
		else out += unDecimal(q.quantity * q.marketPrice * tf, 36)
	}
	return out
}

export async function getOpenTradingFeeForQuotes(context: RunContext, quoteIds: bigint[]): Promise<bigint> {
	let out = 0n
	for (const quoteId of quoteIds) {
		let q = await context.viewFacetQuote.getQuote(quoteId)
		let tf = q.tradingFee
		if (q.orderType === BigInt(OrderType.LIMIT)) out += unDecimal(q.quantity * q.requestedOpenPrice * tf, 36)
		else out += unDecimal(q.quantity * q.marketPrice * tf, 36)
	}
	return out
}

export async function pausePartyB(context: RunContext): Promise<void> {
	await context.pauseControlFacet.connect(context.signers.admin).pausePartyBActions()
}

export async function pausePartyBOpenPositions(context: RunContext): Promise<void> {
	await context.pauseControlFacet.connect(context.signers.admin).pausePartyBOpenPositions()
}

export async function pausePartyA(context: RunContext): Promise<void> {
	await context.pauseControlFacet.connect(context.signers.admin).pausePartyAActions()
}

export async function pauseAccounting(context: RunContext): Promise<void> {
	await context.pauseControlFacet.connect(context.signers.admin).pauseAccounting()
}

export async function pauseGlobal(context: RunContext): Promise<void> {
	await context.pauseControlFacet.connect(context.signers.admin).pauseGlobal()
}

export async function suspendAddress(context: RunContext, address: string): Promise<void> {
	await context.pauseControlFacet.connect(context.signers.admin).suspendedAddress(address)
}

export async function getValue<T>(pov: T | Promise<T>): Promise<T> {
	if (pov instanceof Promise) return await pov
	return pov
}

export async function getBigNumberValue(pov: bigint | Promise<bigint>): Promise<bigint> {
	if (pov instanceof Promise) return await pov
	return pov
}

export async function getSymbols(context: RunContext): Promise<SymbolStructOutput[]> {
	return await context.viewFacetSymbol.getSymbols(0, 100)
}

export function max(a: bigint, b: bigint): bigint {
	return a >= b ? a : b
}

export function min(a: bigint, b: bigint): bigint {
	return a >= b ? b : a
}

export function serializeToJson(object: any): any {
	return defaultSerializer.serialize(object)
}

export async function checkStatus(context: RunContext, quoteId: bigint, quoteStatus: QuoteStatus): Promise<boolean> {
	return (await context.viewFacetQuote.getQuote(quoteId)).quoteStatus === BigInt(quoteStatus)
}

export function getPriceFetcher(symbolIds: bigint[], prices: bigint[]): (symbolId: bigint) => Promise<bigint> {
	return async (symbolId: bigint): Promise<bigint> => {
		for (let i = 0; i < symbolIds.length; i++) {
			if (symbolIds[i] === symbolId) return prices[i]
		}
		throw new Error("Invalid price requested")
	}
}
