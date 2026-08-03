import { Builder } from "builder-pattern"
import { Subscription } from "rxjs"

import type { QuoteStructOutput, SymbolStructOutput } from "../../src/types/interfaces/ISymmio.js"
import { time } from "../helpers/network-helpers.js"
import { getQuoteMinLeftQuantityForFill, getQuoteQuantity, getTotalLockedValuesForQuoteIds } from "../utils/Common.js"
import { logger } from "../utils/LoggerUtils.js"
import { getPrice } from "../utils/PriceUtils.js"
import { pick, randomBigNumber, randomFloat } from "../utils/RandomUtils.js"
import { safeDiv } from "../utils/SafeMath.js"
import { Action, actionNamesMap, ActionWrapper, expandActions, hedgerActionsMap } from "./Actions.js"
import { OrderType, PositionType, QuoteStatus } from "./Enums.js"
import type { FuzzControllerOptions } from "./FuzzLogTypes.js"
import { Hedger } from "./Hedger.js"
import { isHedgerEligibleForQuote } from "./QuoteStateRouting.js"
import { RunContext } from "./RunContext.js"
import { TestManager } from "./TestManager.js"
import { QuoteCheckpoint } from "./quoteCheckpoint.js"
import { FillCloseRequest } from "./requestModels/FillCloseRequest.js"
import { OpenRequest } from "./requestModels/OpenRequest.js"
import { AcceptCancelCloseRequestValidator, AcceptCancelCloseRequestValidatorBeforeOutput } from "./validators/AcceptCancelCloseRequestValidator.js"
import { AcceptCancelRequestValidator, AcceptCancelRequestValidatorBeforeOutput } from "./validators/AcceptCancelRequestValidator.js"
import { FillCloseRequestValidator, FillCloseRequestValidatorBeforeOutput } from "./validators/FillCloseRequestValidator.js"
import { LockQuoteValidator, LockQuoteValidatorBeforeOutput } from "./validators/LockQuoteValidator.js"
import { OpenPositionValidator, OpenPositionValidatorBeforeOutput } from "./validators/OpenPositionValidator.js"
import { UnlockQuoteValidator, UnlockQuoteValidatorBeforeOutput } from "./validators/UnlockQuoteValidator.js"

type PartyALockedValues = {
	cva: bigint
	lf: bigint
	partyAmm: bigint
}

export function calculatePartyALockedValueAfterOpen(lockedValues: PartyALockedValues, openedPrice: bigint, requestedOpenPrice: bigint): bigint {
	if (requestedOpenPrice <= 0n) throw new RangeError(`Requested open price must be positive, received ${requestedOpenPrice}`)
	if (openedPrice < 0n) throw new RangeError(`Opened price must be non-negative, received ${openedPrice}`)

	return (
		(lockedValues.cva * openedPrice) / requestedOpenPrice +
		(lockedValues.lf * openedPrice) / requestedOpenPrice +
		(lockedValues.partyAmm * openedPrice) / requestedOpenPrice
	)
}

export function selectFuzzOpenedPrice(
	orderType: bigint,
	positionType: bigint,
	lockedValues: PartyALockedValues,
	requestedOpenPrice: bigint,
	marketPrice: bigint,
	minAcceptableQuoteValue: bigint,
): bigint {
	if (orderType === BigInt(OrderType.LIMIT)) return requestedOpenPrice
	const marketPriceHasValidDirection =
		positionType === BigInt(PositionType.LONG) ? marketPrice <= requestedOpenPrice : marketPrice >= requestedOpenPrice
	if (!marketPriceHasValidDirection) return requestedOpenPrice

	const adjustedLockedValue = calculatePartyALockedValueAfterOpen(lockedValues, marketPrice, requestedOpenPrice)
	return adjustedLockedValue >= minAcceptableQuoteValue ? marketPrice : requestedOpenPrice
}

export function isValidFuzzPartialOpen(
	lockedValues: PartyALockedValues,
	filledAmount: bigint,
	quantity: bigint,
	openedPrice: bigint,
	requestedOpenPrice: bigint,
	minAcceptableQuoteValue: bigint,
	allowSmallRemainder: boolean,
): boolean {
	if (filledAmount <= 0n || filledAmount >= quantity || quantity <= 0n || requestedOpenPrice <= 0n || openedPrice < 0n) return false

	const filledLockedValues = {
		cva: (lockedValues.cva * filledAmount) / quantity,
		lf: (lockedValues.lf * filledAmount) / quantity,
		partyAmm: (lockedValues.partyAmm * filledAmount) / quantity,
	}
	const openedLockedValue = calculatePartyALockedValueAfterOpen(filledLockedValues, openedPrice, requestedOpenPrice)
	const remainingLockedValue =
		lockedValues.cva - filledLockedValues.cva + (lockedValues.lf - filledLockedValues.lf) + (lockedValues.partyAmm - filledLockedValues.partyAmm)

	return openedLockedValue >= minAcceptableQuoteValue && (allowSmallRemainder || remainingLockedValue >= minAcceptableQuoteValue)
}

export function quoteStateIdsAfterOpen(quoteId: bigint, remainderQuoteId?: bigint): bigint[] {
	return remainderQuoteId === undefined ? [quoteId] : [quoteId, remainderQuoteId]
}

export { isHedgerEligibleForQuote } from "./QuoteStateRouting.js"

export class HedgerController {
	private readonly context: RunContext
	private readonly subscriptions: Subscription[] = []

	constructor(
		private manager: TestManager,
		private hedger: Hedger,
		private checkpoint: QuoteCheckpoint,
		private readonly actorId = "hedger",
		private readonly fuzzOptions?: FuzzControllerOptions,
	) {
		this.context = manager.context
	}

	public async start() {
		const hedgerAddress = await this.hedger.getAddress()
		const statuses = Object.values(QuoteStatus).filter((status): status is QuoteStatus => typeof status === "number")
		for (const status of statuses) {
			const actions = hedgerActionsMap.get(status)
			if (!actions) throw new Error(`Missing hedger fuzz actions for quote status ${QuoteStatus[status]}`)
			if (actions.length === 1 && actions[0].action === Action.NOTHING && !actions[0].rethink) continue

			this.subscriptions.push(
				this.manager.getQueueObservable(status, { kind: "hedger", address: hedgerAddress }).subscribe(quoteId => {
					this.manager.enqueueAction({
						title: `Observe:${this.actorId}:${QuoteStatus[status]}:${quoteId}`,
						action: async () => {
							const quote = await this.context.viewFacetQuote.getQuote(quoteId)
							if (quote.quoteStatus === BigInt(status) && isHedgerEligibleForQuote(quote, hedgerAddress)) {
								await this.handleQuote(quote, actions)
							}
						},
					})
				}),
			)
		}
	}

	public stop(): void {
		for (const subscription of this.subscriptions.splice(0)) subscription.unsubscribe()
	}

	private async handleQuote(quote: QuoteStructOutput, actions: ActionWrapper[]) {
		const actionWrapper: ActionWrapper = pick(expandActions(actions))
		logger.debug(`[${this.actorId}] selects ${actionNamesMap.get(actionWrapper.action)} for quote ${quote.id}`)

		const validator = actionWrapper.action === Action.NOTHING ? undefined : this.manager.getValidator("hedger", actionWrapper.action)
		const validate = Boolean(validator && randomFloat() < this.getProbability("VALIDATION_PROBABILITY", 1))
		this.manager.recordDecision("hedger", this.actorId, quote.id, quote.quoteStatus, actionWrapper.action, validate)

		let changedQuoteIds: bigint[] = []
		if (validate) this.manager.setPauseState(true)
		try {
			switch (actionWrapper.action) {
				case Action.LOCK_QUOTE: {
					const user = this.manager.getUser(quote.partyA)
					let before: LockQuoteValidatorBeforeOutput
					if (validate) {
						before = await (validator as LockQuoteValidator).before(this.context, {
							user: user,
							hedger: this.hedger,
							quoteId: quote.id,
						})
					}
					await this.hedger.lockQuote(quote.id)
					if (validate) {
						await (validator as LockQuoteValidator).after(this.context, {
							user: user,
							hedger: this.hedger,
							quoteId: quote.id,
							beforeOutput: before!,
						})
					}
					changedQuoteIds = [quote.id]
					break
				}
				case Action.UNLOCK_QUOTE: {
					const user = this.manager.getUser(quote.partyA)
					let before: UnlockQuoteValidatorBeforeOutput
					if (validate) {
						before = await (validator as UnlockQuoteValidator).before(this.context, {
							user: user,
							hedger: this.hedger,
							quoteId: quote.id,
						})
					}
					await this.hedger.unlockQuote(quote.id)
					if (validate) {
						await (validator as UnlockQuoteValidator).after(this.context, {
							user: user,
							hedger: this.hedger,
							quoteId: quote.id,
							transactionBlockTimestamp: BigInt(await time.latest()),
							beforeOutput: before!,
						})
					}
					changedQuoteIds = [quote.id]
					break
				}
				case Action.ACCEPT_CANCEL_REQUEST: {
					const user = this.manager.getUser(quote.partyA)
					let before: AcceptCancelRequestValidatorBeforeOutput
					if (validate) {
						before = await (validator as AcceptCancelRequestValidator).before(this.context, {
							user: user,
							quoteId: quote.id,
						})
					}
					await this.hedger.acceptCancelRequest(quote.id)
					if (validate) {
						await (validator as AcceptCancelRequestValidator).after(this.context, {
							user: user,
							quoteId: quote.id,
							beforeOutput: before!,
						})
					}
					changedQuoteIds = [quote.id]
					break
				}
				case Action.ACCEPT_CANCEL_CLOSE_REQUEST: {
					const user = this.manager.getUser(quote.partyA)
					let before: AcceptCancelCloseRequestValidatorBeforeOutput
					if (validate) {
						before = await (validator as AcceptCancelCloseRequestValidator).before(this.context, {
							user: user,
							hedger: this.hedger,
							quoteId: quote.id,
						})
					}
					await this.hedger.acceptCancelCloseRequest(quote.id)
					if (validate) {
						await (validator as AcceptCancelCloseRequestValidator).after(this.context, {
							user: user,
							hedger: this.hedger,
							quoteId: quote.id,
							beforeOutput: before!,
						})
					}
					changedQuoteIds = [quote.id]
					break
				}
				case Action.OPEN_POSITION: {
					const quantity = await getQuoteQuantity(this.context, quote.id)
					let fillAmount: bigint
					const symbol: SymbolStructOutput = await this.context.viewFacetSymbol.getSymbol(quote.symbolId)
					if (quote.orderType == BigInt(OrderType.LIMIT)) {
						const locked = await getTotalLockedValuesForQuoteIds(this.context, [quote.id])
						const minQuantity = safeDiv(symbol.minAcceptableQuoteValue * quantity, locked)
						const max = quantity - minQuantity
						if (max > minQuantity) {
							const partialQuantity = randomBigNumber(quantity - minQuantity, minQuantity)
							const partialIsValid = isValidFuzzPartialOpen(
								quote.lockedValues,
								partialQuantity,
								quantity,
								quote.requestedOpenPrice,
								quote.requestedOpenPrice,
								symbol.minAcceptableQuoteValue,
								quote.quoteStatus === BigInt(QuoteStatus.CANCEL_PENDING),
							)
							fillAmount = pick([partialIsValid ? partialQuantity : quantity, quantity])
						} else {
							fillAmount = quantity
						}
					} else {
						fillAmount = quantity
					}
					const price = await getPrice()
					const partyAUpnl = await this.manager.getUser(quote.partyA).getUpnl()
					const partyBUpnl = await this.hedger.getUpnl(quote.partyA)
					const openPrice = selectFuzzOpenedPrice(
						quote.orderType,
						quote.positionType,
						quote.lockedValues,
						quote.requestedOpenPrice,
						quote.marketPrice,
						symbol.minAcceptableQuoteValue,
					)

					const user = this.manager.getUser(quote.partyA)
					let before: OpenPositionValidatorBeforeOutput
					let newQuoteId: bigint | undefined
					let newQuoteTargetStatus: QuoteStatus | undefined
					if (fillAmount < quantity) {
						newQuoteId = (await this.context.viewFacetQuote.getNextQuoteId()) + 1n
						newQuoteTargetStatus = quote.quoteStatus === BigInt(QuoteStatus.CANCEL_PENDING) ? QuoteStatus.CANCELED : QuoteStatus.PENDING
					}
					if (validate) {
						before = await (validator as OpenPositionValidator).before(this.context, {
							user: user,
							hedger: this.hedger,
							quoteId: quote.id,
						})
					}
					await this.hedger.openPosition(
						quote.id,
						Builder<OpenRequest>().filledAmount(fillAmount).openPrice(openPrice).upnlPartyA(partyAUpnl).upnlPartyB(partyBUpnl).price(price).build(),
					)
					if (validate) {
						await (validator as OpenPositionValidator).after(this.context, {
							user: user,
							hedger: this.hedger,
							quoteId: quote.id,
							fillAmount: fillAmount,
							openedPrice: openPrice,
							beforeOutput: before!,
							newQuoteId,
							newQuoteTargetStatus,
						})
					}
					changedQuoteIds = quoteStateIdsAfterOpen(quote.id, newQuoteId)
					break
				}
				case Action.FILL_POSITION: {
					if (this.checkpoint.isBlockedQuote(quote.id)) {
						break
					}
					let fillAmount = undefined
					const minLeftQuantity = await getQuoteMinLeftQuantityForFill(this.manager.context, quote.id)
					if (quote.orderType === BigInt(OrderType.LIMIT)) {
						const maxFillAmount = quote.quantityToClose - minLeftQuantity
						if (maxFillAmount > 1n) {
							const partialQuantity = randomBigNumber(maxFillAmount, 1n)
							fillAmount = pick([partialQuantity, quote.quantityToClose])
						} else {
							fillAmount = quote.quantityToClose
						}
					} else {
						fillAmount = quote.quantityToClose
					}
					const price = await getPrice()
					const partyAUpnl = await this.manager.getUser(quote.partyA).getUpnl()
					const partyBUpnl = await this.hedger.getUpnl(quote.partyA)

					const closePrice = quote.requestedClosePrice //FIXME: Can we do anything else?

					const user = this.manager.getUser(quote.partyA)
					let before: FillCloseRequestValidatorBeforeOutput
					if (validate) {
						before = await (validator as FillCloseRequestValidator).before(this.context, {
							user: user,
							hedger: this.hedger,
							quoteId: quote.id,
						})
					}
					await this.hedger.fillCloseRequest(
						quote.id,
						Builder<FillCloseRequest>()
							.filledAmount(fillAmount)
							.closedPrice(closePrice)
							.upnlPartyA(partyAUpnl)
							.upnlPartyB(partyBUpnl)
							.price(price)
							.build(),
					)
					if (validate) {
						await (validator as FillCloseRequestValidator).after(this.context, {
							user: user,
							hedger: this.hedger,
							quoteId: quote.id,
							fillAmount: fillAmount,
							closePrice: closePrice,
							beforeOutput: before!,
						})
					}
					changedQuoteIds = [quote.id]
					break
				}
				case Action.NOTHING: {
					if (actionWrapper.rethink) {
						const status = quote.quoteStatus
						this.manager.scheduleAction(this.getRethinkDelay(), {
							title: `Rethink:${this.actorId}:${quote.id}`,
							action: async () => {
								const latestQuote = await this.context.viewFacetQuote.getQuote(quote.id)
								if (latestQuote.quoteStatus === status) await this.handleQuote(latestQuote, actions)
							},
						})
					}
					break
				}
				default: {
					throw new Error(`Unsupported hedger fuzz action ${actionWrapper.action}`)
				}
			}
		} finally {
			if (validate) this.manager.setPauseState(false)
		}
		for (const changedQuoteId of changedQuoteIds) await this.manager.dispatchQuoteState(changedQuoteId)
	}

	private getProbability(name: string, defaultValue: number): number {
		const configured = name === "VALIDATION_PROBABILITY" ? this.fuzzOptions?.validationProbability : undefined
		const probability = Number(configured ?? process.env[name] ?? defaultValue)
		if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
			throw new Error(`${name} must be a number between 0 and 1, received ${process.env[name]}`)
		}
		return probability
	}

	private getRethinkDelay(): number {
		const delay = Number(this.fuzzOptions?.rethinkDelayMs ?? process.env.FUZZ_RETHINK_DELAY_MS ?? 100)
		if (!Number.isFinite(delay) || delay < 0) {
			throw new Error(`FUZZ_RETHINK_DELAY_MS must be a non-negative number, received ${process.env.FUZZ_RETHINK_DELAY_MS}`)
		}
		return delay
	}
}
