import { AbiCoder, keccak256, toUtf8Bytes, ZeroAddress } from "ethers"

import { OrderType, QuoteStatus } from "../models/Enums.js"
import type { RunContext } from "../models/RunContext.js"

export type ConservationTracking = {
	partyAs: Iterable<string>
	partyBs: Iterable<string>
	others?: Iterable<string>
	quoteIds: Iterable<bigint>
}

/** Exact collateral ledger, including reserved request-time open fees. No PnL/locked-value
 * liabilities are added: those are claims on allocations, not additional collateral. */
export async function conservationOracle(context: RunContext, tracked: ConservationTracking) {
	const v = context.viewFacet
	const unique = (addresses: Iterable<string>) => new Set([...addresses].map(a => a.toLowerCase()))
	const signers = Object.values(context.signers)
		.flat()
		.map(s => s.address)
	const partyAs = unique([...tracked.partyAs, ...signers])
	const partyBs = unique(tracked.partyBs)
	const [vault] = await v.getLiquidationInsuranceVaultParams()
	const everyone = unique([
		...partyAs,
		...partyBs,
		...(tracked.others ?? []),
		vault,
		ZeroAddress,
		await v.getDefaultFeeCollector(),
		await v.getFeeCollector(ZeroAddress),
	])
	const breakdown: Record<string, bigint> = {}
	const openCounts = new Map<string, bigint>()
	for (const id of new Set(tracked.quoteIds)) {
		const q = await context.viewFacetQuote.getQuote(id)
		partyAs.add(q.partyA.toLowerCase())
		if (q.partyB !== ZeroAddress) partyBs.add(q.partyB.toLowerCase())
		everyone.add((await v.getFeeCollector(q.affiliate)).toLowerCase())
		if ([QuoteStatus.OPENED, QuoteStatus.CLOSE_PENDING, QuoteStatus.CANCEL_CLOSE_PENDING].includes(Number(q.quoteStatus))) {
			const key = `${q.partyB.toLowerCase()}:${q.partyA.toLowerCase()}`
			openCounts.set(key, (openCounts.get(key) ?? 0n) + 1n)
		}
		if ([QuoteStatus.PENDING, QuoteStatus.LOCKED, QuoteStatus.CANCEL_PENDING].includes(Number(q.quoteStatus))) {
			const price = q.orderType === BigInt(OrderType.LIMIT) ? q.requestedOpenPrice : q.marketPrice
			breakdown[`reservedOpenFee:${id}`] = ((q.quantity - q.closedAmount) * price * q.tradingFee) / 10n ** 36n
		}
	}
	for (const a of [...partyAs, ...partyBs]) everyone.add(a)
	const add = async (key: string, value: Promise<bigint>) => {
		breakdown[key] = await value
	}
	for (const a of everyone) {
		await add(`balance:${a}`, v.balanceOf(a))
		await add(`allocatedA:${a}`, v.allocatedBalanceOfPartyA(a))
		await add(`reimbursement:${a}`, v.partyAReimbursement(a))
		await add(`escrow:${a}`, v.getLiquidationEscrow(a))
		await add(`deferred:${a}`, v.getPartyADeferredBalance(a))
		if (await v.isPartyALiquidated(a)) {
			// A NORMAL liquidation credits the insurance vault with the LF above the liquidator cap at
			// start, while PartyA's allocation (which funds it) is debited only at finalization. Until
			// then the credit is a claim on that allocation, not extra collateral.
			// The claim is what the allocation still has to fund beyond the buckets and the fee: allocation minus
			// locked CVA plus the uPNL the buckets settle at, minus the liquidator fee. Once the last position has
			// closed without a dispute, the buckets settle at the capped on-chain uPNL and the plan step may already
			// have drawn the rounding difference from the deferred balance, the fee or the vault.
			const detail = await v.getLiquidatedStateOfPartyA(a)
			if (detail.liquidationType === 1n) {
				const info = await v.balanceInfoOfPartyA(a)
				const planned = !detail.disputed && (await context.viewFacetQuote.partyAPositionsCount(a)) === 0n
				const basis = planned ? detail.partyAAccumulatedUpnl : detail.upnl
				breakdown[`inFlightVaultCredit:${a}`] = -(info[0] - info[1] + basis - detail.liquidationFee)
			}
		}
	}
	for (const b of partyBs) {
		for (const a of partyAs) {
			// Isolated PartyB liquidation parks unpaid position-liquidator rewards outside allocations.
			// MAStorage.Layout slot 12 is partyBPositionLiquidatorsShare (no public view).
			// Read the actual stored share; multiplying by still-open positions counts only unpaid claims.
			const count = openCounts.get(`${b}:${a}`) ?? 0n
			if (count > 0n && (await v.isPartyBLiquidated(b, a))) {
				const coder = AbiCoder.defaultAbiCoder()
				const base = BigInt(keccak256(toUtf8Bytes("diamond.standard.storage.masteragreement"))) + 12n
				const outer = keccak256(coder.encode(["address", "uint256"], [b, base]))
				const slot = keccak256(coder.encode(["address", "bytes32"], [a, outer]))
				const share = BigInt(await context.viewFacet.runner!.provider!.getStorage(context.diamond, slot))
				breakdown[`partyBPositionLiquidatorEscrow:${b}:${a}`] = count * share
			}
			// address(0) is the cross allocation key, counted through balanceOfCrossPartyB below.
			if (a !== ZeroAddress) await add(`allocatedB:${b}:${a}`, v.allocatedBalanceOfPartyB(b, a))
		}
		await add(`cross:${b}`, v.balanceOfCrossPartyB(b))
		await add(`reserve:${b}`, v.balanceOfReserveVault(b))
	}
	await add("withdrawLocked", v.getWithdrawLockedBalance())
	const decimals = BigInt(await context.collateral.decimals())
	if (decimals > 18n) throw new Error(`Unsupported collateral decimals ${decimals}`)
	const tokens = (await context.collateral.balanceOf(context.diamond)) * 10n ** (18n - decimals)
	const ledger = Object.values(breakdown).reduce((a, b) => a + b, 0n)
	return { ledger, tokens, diff: ledger - tokens, breakdown }
}
