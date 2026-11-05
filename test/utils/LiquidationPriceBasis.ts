import type { BigNumberish } from "ethers"

import { ethers } from "../helpers/hardhat-connection.js"
import type { RunContext } from "../models/RunContext.js"
import type { getDummyLiquidationSig, getDummyPriceSig } from "./SignatureUtils.js"

export async function bindLiquidationPriceBasis(context: RunContext, payloadHash: string, symbolIds: BigNumberish[]): Promise<string> {
	const priceBases = await Promise.all(
		symbolIds.map(async symbolId => {
			const adjustment = await context.viewFacetSymbol.getSymbolAdjustment(symbolId)
			return ethers.keccak256(
				ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "bool"], [symbolId, adjustment.restatementEpoch, adjustment.restating]),
			)
		}),
	)
	return ethers.keccak256(
		ethers.AbiCoder.defaultAbiCoder().encode(
			["bytes32", "bytes32", "bytes32[]"],
			[ethers.id("SYMMIO_LIQUIDATION_PRICE_BASIS_V1"), payloadHash, priceBases],
		),
	)
}

type LiquidationSig = Awaited<ReturnType<typeof getDummyLiquidationSig>>
type SnapshotState = { partyB: string; symbolId: bigint; price: bigint; cumulativeLongFee: bigint; cumulativeShortFee: bigint }

export async function partyALiquidationHash(
	context: RunContext,
	partyA: string,
	path: "legacy" | "deferred" | "snapshot",
	sig: LiquidationSig & { states?: SnapshotState[] },
): Promise<string> {
	const types = ["uint256", "bytes", "bytes", "address", "string", "address", "uint256", "int256", "int256"]
	const method = { legacy: "verifyLiquidationSig", deferred: "verifyDeferredLiquidationSig", snapshot: "verifyLiquidationSnapshotSig" }[path]
	const values: unknown[] = [
		await context.viewFacet.getMuonIds(),
		sig.reqId,
		sig.liquidationId,
		context.diamond,
		method,
		partyA,
		await context.viewFacet.nonceOfPartyA(partyA),
		sig.upnl,
		sig.totalUnrealizedLoss,
	]
	let symbolIds = sig.symbolIds
	if (path === "snapshot") {
		const states = sig.states ?? []
		symbolIds = states.map(state => state.symbolId)
		types.push("bytes32")
		values.push(
			ethers.keccak256(
				ethers.AbiCoder.defaultAbiCoder().encode(
					["tuple(address,uint256,uint256,int256,int256)[]"],
					[states.map(state => [state.partyB, state.symbolId, state.price, state.cumulativeLongFee, state.cumulativeShortFee])],
				),
			),
		)
	} else {
		types.push("uint256[]", "uint256[]")
		values.push(sig.symbolIds, sig.prices)
	}
	types.push("uint256")
	values.push(sig.timestamp)
	if (path !== "legacy") {
		types.push("uint256", "uint256", "uint256")
		values.push(sig.liquidationBlockNumber, sig.liquidationTimestamp, sig.liquidationAllocatedBalance)
	}
	types.push("uint256")
	values.push((await ethers.provider.getNetwork()).chainId)
	return bindLiquidationPriceBasis(context, ethers.solidityPackedKeccak256(types, values), symbolIds)
}

export async function partyBLiquidationPriceHash(context: RunContext, sig: Awaited<ReturnType<typeof getDummyPriceSig>>): Promise<string> {
	const payloadHash = ethers.solidityPackedKeccak256(
		["uint256", "bytes", "address", "uint256[]", "uint256[]", "uint256", "uint256"],
		[
			await context.viewFacet.getMuonIds(),
			sig.reqId,
			context.diamond,
			sig.quoteIds,
			sig.prices,
			sig.timestamp,
			(await ethers.provider.getNetwork()).chainId,
		],
	)
	const symbolIds = await Promise.all(sig.quoteIds.map(async quoteId => (await context.viewFacetQuote.getQuote(quoteId)).symbolId))
	return bindLiquidationPriceBasis(context, payloadHash, symbolIds)
}
