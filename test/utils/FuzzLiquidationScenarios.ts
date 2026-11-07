import { ethers } from "../helpers/hardhat-connection.js"
import { LiquidationType, PositionType, QuoteStatus } from "../models/Enums.js"
import type { FuzzCornerOperation } from "../models/FuzzLogTypes.js"
import { Hedger } from "../models/Hedger.js"
import type { RunContext } from "../models/RunContext.js"
import type { TestManager } from "../models/TestManager.js"
import { User } from "../models/User.js"
import { limitOpenRequestBuilder } from "../models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "../models/requestModels/QuoteRequest.js"
import { decimal } from "./Common.js"
import { getDummyLiquidationSig } from "./SignatureUtils.js"

const lateScenario = (operation: string) => operation === "LIQUIDATE_PARTY_A_LATE"

/** Fresh relationship per operation: allocations cannot depend on earlier shuffled operations. */
export async function executeLiquidationScenario(context: RunContext, manager: TestManager, operation: FuzzCornerOperation) {
	const address = ethers.getAddress(
		"0x" + ethers.keccak256(ethers.toUtf8Bytes(`${manager.conservationSeed}:${operation}:${manager.users.size}`)).slice(-40),
	)
	const user = new User(context, await ethers.getImpersonatedSigner(address))
	const check = (step: string) => manager.assertConservation(`${operation}:${step}`)
	await user.setup()
	await user.setNativeBalance(decimal(100n))
	await user.setBalances(decimal(2000n), decimal(500n), decimal(500n))
	await check("fund")
	const hedgers = [context.signers.hedger, context.signers.hedger2].map(s => new Hedger(context, s))
	const mixed = operation === "LIQUIDATE_PARTY_A_OVERDUE_MIXED_SOLVER"
	for (const [index, h] of hedgers.entries()) {
		await h.setup()
		// Deposit fresh collateral; never change an existing relationship's allocation.
		await context.collateral.mint(h.address, decimal(10000n))
		await context.collateral.connect(h.signer).approve(context.diamond, decimal(10000n))
		await context.accountFacet.connect(h.signer).deposit(decimal(10000n))
		await check(`fund-solver-${index}`)
		await context.partyBAccountFacet.connect(h.signer).allocateForPartyB(decimal(mixed && index === 1 ? 220n : 5000n), user.address)
		await check(`allocate-solver-${index}`)
	}
	const ids: bigint[] = []
	const legs: [number, PositionType, bigint][] = mixed
		? [
				[0, PositionType.SHORT, 100n],
				[1, PositionType.LONG, 30n],
				[1, PositionType.SHORT, 10n],
			]
		: [
				[0, PositionType.SHORT, 100n],
				[1, PositionType.SHORT, 10n],
			]
	for (const [index, side, qty] of legs) {
		const id = await user.sendQuote(
			limitQuoteRequestBuilder()
				.positionType(side)
				.quantity(decimal(qty))
				.cva(decimal(lateScenario(operation) && index === 1 ? 23n : 22n))
				.build(),
		)
		ids.push(id)
		await check(`send-${id}`)
		await hedgers[index].lockQuote(id, 0n, null)
		await check(`lock-${id}`)
		await hedgers[index].openPosition(id, limitOpenRequestBuilder().filledAmount(decimal(qty)).build())
		await check(`open-${id}`)
	}
	let pending: bigint | undefined
	if (operation === "LIQUIDATE_PARTY_A_PENDING") {
		pending = await user.sendQuote(limitQuoteRequestBuilder().build())
		await check("pending-quote")
	}
	const allocated = await context.viewFacet.allocatedBalanceOfPartyA(user.address)
	const late = operation === "LIQUIDATE_PARTY_A_LATE"
	// LATE: loss consumes allocation and part of the 44 CVA; OVERDUE: loss exceeds allocation.
	const price = late ? decimal(1n) + (allocated - decimal(21n)) / 110n + 1n : decimal(12n)
	const netQty = mixed ? 80n : 110n
	const loss = (price - decimal(1n)) * netQty
	const unrealizedLoss = -(price - decimal(1n)) * 110n
	const sig = await getDummyLiquidationSig("0x10", -loss, [1n], [price], unrealizedLoss, allocated)
	const liquidator = context.partyALiquidationFacet.connect(context.signers.liquidator)
	if (operation === "LIQUIDATE_PARTY_A_SNAPSHOT") {
		const facet = context.partyALiquidationSnapshotFacet.connect(context.signers.liquidator)
		const snapshot = { ...sig, states: hedgers.map(h => ({ partyB: h.address, symbolId: 1n, price, cumulativeLongFee: 0n, cumulativeShortFee: 0n })) }
		// Fresh isolated relationships have no accumulated funding configured.
		for (const h of hedgers) {
			const f = await context.viewFacetSymbol.getFundingFeesOfPartyB(1n, h.address)
			if (f.epochDuration !== 0n && f.startEpoch !== 0n) throw new Error("Snapshot scenario requires zero accumulated funding")
		}
		await facet.liquidatePartyAWithSnapshot(user.address, { ...snapshot, states: [] })
		await check("snapshot-start")
		await facet.setSymbolsPriceWithSnapshot(user.address, snapshot)
	} else if (operation === "LIQUIDATE_PARTY_A_DEFERRED") {
		// Add collateral after signing, before the account enters liquidation.
		await context.accountFacet.connect(user.signer).deposit(decimal(7n))
		await check("late-deposit")
		await context.accountFacet.connect(user.signer).allocate(decimal(7n))
		await check("late-allocation")
		await liquidator.deferredLiquidatePartyA(user.address, sig)
		await check("deferred-start")
		await liquidator.deferredSetSymbolsPrice(user.address, sig)
	} else {
		await liquidator.liquidatePartyA(user.address, sig)
		await check("start")
		await liquidator.setSymbolsPrice(user.address, sig)
	}
	await check("prices")
	const state = await user.getLiquidatedStateOfPartyA()
	if (state.liquidationType !== BigInt(late ? LiquidationType.LATE : LiquidationType.OVERDUE))
		throw new Error(`${operation}: unexpected liquidation type ${state.liquidationType}`)
	await user.liquidatePendingPositions()
	await check("pending-liquidated")
	if (pending !== undefined && (await context.viewFacetQuote.getQuote(pending)).quoteStatus !== BigInt(QuoteStatus.LIQUIDATED_PENDING))
		throw new Error("Pending quote was not liquidated")
	await user.liquidatePositions(ids)
	await check("positions")
	if ((await user.getLiquidatedStateOfPartyA()).disputed) throw new Error(`${operation}: unexpected dispute`)
	const parties = hedgers.map(h => h.address)
	const states = await context.viewFacet.getSettlementStates(user.address, parties)
	const amounts = await Promise.all(hedgers.map(h => context.viewFacet.allocatedBalanceOfPartyB(h.address, user.address)))
	const detail = states
		.map((s, i) => `solver=${parties[i]} expected=${s.expectedAmount} actual=${s.actualAmount} allocation=${amounts[i]}`)
		.join("; ")
	// The mixed-book solver's allocation equals its net claim: the plan must never debit it beyond that, and the uncovered
	// loss must land on the receiver's bucket (actual above expected) rather than on the mixed solver's gross legs.
	if (mixed && !(states[1].actualAmount <= amounts[1] && states[0].actualAmount > states[0].expectedAmount))
		throw new Error(`Mixed-solver OVERDUE shape not reached: ${detail}`)
	await liquidator.settlePartyALiquidation(user.address, parties)
	await check(`settlement price=${price} allocated=${allocated} ${detail}`)
	if (await context.viewFacet.isPartyALiquidated(user.address)) throw new Error(`${operation}: settlement incomplete`)
	return { quoteIds: [...ids, ...(pending === undefined ? [] : [pending])], detail }
}
