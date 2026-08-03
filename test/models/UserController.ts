import { Builder } from "builder-pattern"
import { Subscription } from "rxjs"

import type { SymbolStructOutput } from "../../src/types/facets/Control/ControlFacet.js"
import type { QuoteStructOutput } from "../../src/types/interfaces/ISymmio.js"
import { decimal, getBlockTimestamp, getQuoteMinLeftQuantityForClose, getSymbols, min, unDecimal } from "../utils/Common.js"
import { logger } from "../utils/LoggerUtils.js"
import { getPrice } from "../utils/PriceUtils.js"
import { pick, randomBigNumber, randomBigNumberRatio, randomFloat } from "../utils/RandomUtils.js"
import { roundToPrecision, safeDiv } from "../utils/SafeMath.js"
import { getDummySingleUpnlAndPriceSig } from "../utils/SignatureUtils.js"
import { Action, actionNamesMap, ActionWrapper, expandActions, userActionsMap } from "./Actions.js"
import { OrderType, PositionType, QuoteStatus } from "./Enums.js"
import type { FuzzControllerOptions } from "./FuzzLogTypes.js"
import { ManagedError } from "./ManagedError.js"
import { RunContext } from "./RunContext.js"
import { TestManager } from "./TestManager.js"
import { User } from "./User.js"
import { QuoteCheckpoint } from "./quoteCheckpoint.js"
import { CloseRequest } from "./requestModels/CloseRequest.js"
import { QuoteRequest } from "./requestModels/QuoteRequest.js"
import { CancelCloseRequestValidator, CancelCloseRequestValidatorBeforeOutput } from "./validators/CancelCloseRequestValidator.js"
import { CancelQuoteValidator, CancelQuoteValidatorBeforeOutput } from "./validators/CancelQuoteValidator.js"
import { CloseRequestValidator, CloseRequestValidatorBeforeOutput } from "./validators/CloseRequestValidator.js"
import { SendQuoteValidator, SendQuoteValidatorBeforeOutput } from "./validators/SendQuoteValidator.js"

type ValidatedSendQuoteOptions = {
	context: RunContext
	manager: Pick<TestManager, "setPauseState">
	user: User
	validator: SendQuoteValidator
	validationProbability: number
	sendQuote: () => Promise<bigint>
	onValidated: (quoteId: bigint, validated: boolean) => Promise<void>
}

export function expectedCancelTargetStatus(
	quoteStatus: bigint,
	deadline: bigint,
	nextBlockTimestamp: bigint,
): QuoteStatus.CANCELED | QuoteStatus.EXPIRED | undefined {
	if (nextBlockTimestamp > deadline) return QuoteStatus.EXPIRED
	return quoteStatus === BigInt(QuoteStatus.PENDING) ? QuoteStatus.CANCELED : undefined
}

export async function executeValidatedSendQuote({
	context,
	manager,
	user,
	validator,
	validationProbability,
	sendQuote,
	onValidated,
}: ValidatedSendQuoteOptions): Promise<bigint> {
	const validate = randomFloat() < validationProbability

	if (validate) manager.setPauseState(true)
	const quoteId = await (async () => {
		try {
			const before: SendQuoteValidatorBeforeOutput | undefined = validate ? await validator.before(context, { user }) : undefined
			const sentQuoteId = await sendQuote()
			if (validate) {
				await validator.after(context, {
					user,
					quoteId: sentQuoteId,
					beforeOutput: before!,
				})
			}
			return sentQuoteId
		} finally {
			if (validate) manager.setPauseState(false)
		}
	})()

	await onValidated(quoteId, validate)
	return quoteId
}

export class UserController {
	private readonly context: RunContext
	private readonly subscriptions: Subscription[] = []

	constructor(
		private manager: TestManager,
		private user: User,
		private checkpoint: QuoteCheckpoint,
		private readonly actorId = "user",
		private readonly fuzzOptions?: FuzzControllerOptions,
	) {
		this.context = manager.context
	}

	public async start() {
		const userAddress = await this.user.getAddress()
		const statuses = Object.values(QuoteStatus).filter((status): status is QuoteStatus => typeof status === "number")
		for (const status of statuses) {
			const actions = userActionsMap.get(status)
			if (!actions) throw new Error(`Missing user fuzz actions for quote status ${QuoteStatus[status]}`)
			if (actions.length === 1 && actions[0].action === Action.NOTHING && !actions[0].rethink) continue

			this.subscriptions.push(
				this.manager.getQueueObservable(status, { kind: "user", address: userAddress }).subscribe(quoteId => {
					this.manager.enqueueAction({
						title: `Observe:${this.actorId}:${QuoteStatus[status]}:${quoteId}`,
						action: async () => {
							const quote = await this.context.viewFacetQuote.getQuote(quoteId)
							if (quote.quoteStatus === BigInt(status) && quote.partyA === userAddress) {
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

	public async sendQuote(maxLockedAmountForQuote = decimal(100n), partyBWhiteList: readonly string[] = []): Promise<bigint> {
		if (await this.manager.getPauseState()) throw new Error("This method is not allowed when state is paused")

		const pendingQuotes = await this.context.viewFacetQuote.getPartyAPendingQuotes(this.user.getAddress())
		if (pendingQuotes.length >= 10) throw new ManagedError("Too many open quotes")

		const orderType = pick([OrderType.MARKET, OrderType.LIMIT])
		const positionType = pick([PositionType.SHORT, PositionType.LONG])
		const symbol: SymbolStructOutput = pick(await getSymbols(this.manager.context))
		let symbolQP = this.manager.symbolManager.getSymbolQuantityPrecision(Number(symbol.symbolId))
		let symbolPP = this.manager.symbolManager.getSymbolPricePrecision(Number(symbol.symbolId))
		const price = await getPrice()
		const upnl = await this.user.getUpnl()
		const availableForQuote = await this.user.getAvailableBalanceForQuote(upnl)
		if (availableForQuote < symbol.minAcceptableQuoteValue) throw new ManagedError("Insufficient funds available")

		const lockedAmount = randomBigNumber(min(availableForQuote, maxLockedAmountForQuote), symbol.minAcceptableQuoteValue)
		const lf = randomBigNumber(unDecimal(lockedAmount * decimal(5n, 17)), unDecimal(lockedAmount * symbol.minAcceptablePortionLF))
		const cva = randomBigNumberRatio(lockedAmount - lf, 0.2)
		const mm = lockedAmount - lf - cva

		let requestPrice =
			orderType == OrderType.MARKET
				? price + randomBigNumberRatio(price, 0.1) * (positionType == PositionType.LONG ? 1n : -1n)
				: price + randomBigNumberRatio(price, 0.1) * (positionType == PositionType.SHORT ? 1n : -1n)
		requestPrice = roundToPrecision(requestPrice, symbolPP)

		let notionalPrice =
			orderType == OrderType.MARKET ? price : price + randomBigNumberRatio(price, 0.1) * (positionType == PositionType.SHORT ? 1n : -1n)
		notionalPrice = roundToPrecision(notionalPrice, symbolPP)

		const leverage = safeDiv(symbol.maxLeverage * 9n, 10n) //10% safe margin
		let quantity
		try {
			quantity = roundToPrecision(safeDiv(lockedAmount * leverage, price), symbolQP)
		} catch (ex) {
			throw new ManagedError("Random data lead to invalid quote... This request will be rejected")
		}
		const notional = unDecimal(quantity * notionalPrice)
		const tradingFee = unDecimal(symbol.tradingFee * notional)

		if (availableForQuote - tradingFee < symbol.minAcceptableQuoteValue) throw new ManagedError("Insufficient funds available for tradingFee")

		if (availableForQuote - tradingFee < lockedAmount) throw new ManagedError("Random data lead to invalid quote... This request will be rejected")

		const request = Builder<QuoteRequest>()
			.partyBWhiteList([...partyBWhiteList])
			.quantity(quantity)
			.partyAmm(mm)
			.partyBmm(mm / 2n)
			.cva(cva)
			.lf(lf)
			.symbolId(symbol.symbolId)
			.positionType(positionType)
			.orderType(orderType)
			.deadline(getBlockTimestamp(3600n))
			.price(requestPrice)
			.upnlSig(getDummySingleUpnlAndPriceSig(price, upnl))
			.maxFundingRate(0n)
			.build()
		const validator = this.manager.getValidator("root", Action.SEND_QUOTE) as SendQuoteValidator
		const id = await executeValidatedSendQuote({
			context: this.context,
			manager: this.manager,
			user: this.user,
			validator,
			validationProbability: this.getProbability("VALIDATION_PROBABILITY", 1),
			sendQuote: () => this.user.sendQuote(request),
			onValidated: async (quoteId, validated) => {
				this.manager.recordDecision("user", this.actorId, quoteId, BigInt(QuoteStatus.PENDING), Action.SEND_QUOTE, validated)
				if (randomFloat() < this.getProbability("FUZZ_BLOCKED_QUOTE_PROBABILITY", 0)) {
					this.checkpoint.addBlockedQuotes(quoteId)
				}
				await this.manager.dispatchQuoteState(quoteId)
			},
		})
		return id
	}

	private async handleQuote(quote: QuoteStructOutput, actions: ActionWrapper[]): Promise<void> {
		const actionWrapper: ActionWrapper = pick(expandActions(actions))
		logger.debug(`[${this.actorId}] selects ${actionNamesMap.get(actionWrapper.action)} for quote ${quote.id}`)

		const validator = actionWrapper.action === Action.NOTHING ? undefined : this.manager.getValidator("user", actionWrapper.action)
		const validate = Boolean(validator && randomFloat() < this.getProbability("VALIDATION_PROBABILITY", 1))
		this.manager.recordDecision("user", this.actorId, quote.id, quote.quoteStatus, actionWrapper.action, validate)

		let quoteChanged = false
		if (validate) this.manager.setPauseState(true)
		try {
			switch (actionWrapper.action) {
				case Action.CANCEL_REQUEST: {
					let before: CancelQuoteValidatorBeforeOutput
					if (validate) {
						before = await (validator as CancelQuoteValidator).before(this.context, {
							user: this.user,
							quoteId: quote.id,
						})
					}
					const targetStatus = expectedCancelTargetStatus(quote.quoteStatus, quote.deadline, await getBlockTimestamp())
					await this.user.requestToCancelQuote(quote.id)
					if (validate) {
						await (validator as CancelQuoteValidator).after(this.context, {
							user: this.user,
							quoteId: quote.id,
							targetStatus,
							beforeOutput: before!,
						})
					}
					quoteChanged = true
					break
				}
				case Action.CLOSE_REQUEST: {
					let symbol = await this.context.viewFacetSymbol.getSymbol(quote.symbolId)
					let symbolQP = this.manager.symbolManager.getSymbolQuantityPrecision(Number(symbol.symbolId))
					let symbolPP = this.manager.symbolManager.getSymbolPricePrecision(Number(symbol.symbolId))

					let quantityToClose: bigint
					const openAmount = quote.quantity - quote.closedAmount
					const minLeftQuantity = await getQuoteMinLeftQuantityForClose(this.manager.context, quote.id)
					let maxValidClose = openAmount - minLeftQuantity
					if (maxValidClose <= 0n) {
						quantityToClose = openAmount
					} else {
						quantityToClose = roundToPrecision(randomBigNumber(maxValidClose), symbolQP)
						if (quantityToClose > maxValidClose || quantityToClose < minLeftQuantity) {
							quantityToClose = openAmount
						}
					}

					const orderType = pick([OrderType.LIMIT, OrderType.MARKET])
					const price = await getPrice()
					const hedger = this.manager.getHedger(quote.partyB)

					const closePrice = roundToPrecision(price + randomBigNumberRatio(price, 0.05) * BigInt(pick([1, -1])), symbolPP)

					let before: CloseRequestValidatorBeforeOutput | undefined
					if (validate) {
						before = await (validator as CloseRequestValidator).before(this.context, {
							user: this.user,
							hedger: hedger,
							quoteId: quote.id,
						})
					}

					await this.user.requestToClosePosition(
						quote.id,
						Builder<CloseRequest>()
							.quantityToClose(quantityToClose)
							.orderType(orderType)
							.deadline(getBlockTimestamp(100000n))
							.upnl(await this.user.getUpnl())
							.closePrice(closePrice)
							.price(price)
							.build(),
					)

					if (validate) {
						await (validator as CloseRequestValidator).after(this.context, {
							user: this.user,
							hedger: hedger,
							quoteId: quote.id,
							beforeOutput: before!,
							quantityToClose: quantityToClose,
							closePrice: closePrice,
						})
					}
					quoteChanged = true
					break
				}
				case Action.CANCEL_CLOSE_REQUEST: {
					let before: CancelCloseRequestValidatorBeforeOutput
					const hedger = this.manager.getHedger(quote.partyB)
					if (validate) {
						before = await (validator as CancelCloseRequestValidator).before(this.context, {
							user: this.user,
							hedger: hedger,
							quoteId: quote.id,
						})
					}
					await this.user.requestToCancelCloseRequest(quote.id)
					if (validate) {
						await (validator as CancelCloseRequestValidator).after(this.context, {
							user: this.user,
							hedger: hedger,
							quoteId: quote.id,
							beforeOutput: before!,
						})
					}
					quoteChanged = true
					break
				}
				case Action.FORCE_CLOSE_REQUEST: {
					throw new Error("FORCE_CLOSE_REQUEST is not part of the current fuzz policy; the protocol now uses the multi-step force-close flow")
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
					throw new Error(`Unsupported user fuzz action ${actionNamesMap.get(actionWrapper.action) ?? actionWrapper.action}`)
				}
			}
			if (quoteChanged) await this.manager.dispatchQuoteState(quote.id)
		} finally {
			if (validate) this.manager.setPauseState(false)
		}
	}

	private getProbability(name: string, defaultValue: number): number {
		const configured =
			name === "VALIDATION_PROBABILITY"
				? this.fuzzOptions?.validationProbability
				: name === "FUZZ_BLOCKED_QUOTE_PROBABILITY"
					? this.fuzzOptions?.blockedQuoteProbability
					: undefined
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
