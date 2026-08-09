import { Subject } from "rxjs"

import { MultiError } from "../utils/MultiError.js"
import { QuoteStatus } from "./Enums.js"
import type { QuoteRoute, QuoteStateEnvelope } from "./QuoteStateRouting.js"
import { RunContext } from "./RunContext.js"

type EventContract = {
	on(event: string, listener: (...args: any[]) => void): Promise<unknown>
	off(event: string, listener: (...args: any[]) => void): Promise<unknown>
}

type Registration = {
	contract: EventContract
	event: string
	listener: (...args: any[]) => void
}

const SEND_QUOTE_EVENT =
	"SendQuote(address,uint256,address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
const OPEN_POSITION_EVENT = "OpenPosition(uint256,address,address,uint256,uint256)"
const FILL_CLOSE_REQUEST_EVENT = "FillCloseRequest(uint256,address,address,uint256,uint256,uint8,uint256)"

function eventValue(args: any[]): any {
	const payload = args.at(-1)
	if (!payload?.args) throw new Error("Fuzz event listener received an event without decoded arguments")
	return payload.args
}

export class EventListener {
	readonly queues: Map<QuoteStatus, Subject<QuoteStateEnvelope>> = new Map(
		Object.values(QuoteStatus)
			.filter((status): status is QuoteStatus => typeof status === "number")
			.map(status => [status, new Subject<QuoteStateEnvelope>()]),
	)

	private readonly registrations: Registration[] = []
	private started = false

	constructor(public readonly context: RunContext) {
		const pollingInterval = Number(process.env.FUZZ_EVENT_POLL_MS ?? 50)
		if (!Number.isFinite(pollingInterval) || pollingInterval <= 0) {
			throw new Error(`FUZZ_EVENT_POLL_MS must be a positive number, received ${process.env.FUZZ_EVENT_POLL_MS}`)
		}

		for (const facet of [context.partyAFacet, context.partyBQuoteActionsFacet, context.partyBPositionActionsFacet]) {
			;(facet.runner as any).pollingInterval = pollingInterval
		}
	}

	async start(): Promise<void> {
		if (this.started) return
		this.started = true

		await this.listen(this.context.partyAFacet as any, SEND_QUOTE_EVENT, (...args) => {
			this.emitQuoteStatus(QuoteStatus.PENDING, eventValue(args).quoteId)
		})
		await this.listen(this.context.partyAFacet as any, "RequestToCancelQuote", (...args) => {
			const value = eventValue(args)
			this.emitQuoteStatus(Number(value.quoteStatus) as QuoteStatus, value.quoteId)
		})
		await this.listen(this.context.partyAFacet as any, "RequestToClosePosition", (...args) => {
			this.emitQuoteStatus(QuoteStatus.CLOSE_PENDING, eventValue(args).quoteId)
		})
		await this.listen(this.context.partyAFacet as any, "RequestToCancelCloseRequest", (...args) => {
			this.emitQuoteStatus(QuoteStatus.CANCEL_CLOSE_PENDING, eventValue(args).quoteId)
		})

		await this.listen(this.context.partyBQuoteActionsFacet as any, "LockQuote", (...args) => {
			this.emitQuoteStatus(QuoteStatus.LOCKED, eventValue(args).quoteId)
		})
		await this.listen(this.context.partyBQuoteActionsFacet as any, "UnlockQuote", (...args) => {
			const value = eventValue(args)
			this.emitQuoteStatus(Number(value.quoteStatus) as QuoteStatus, value.quoteId)
		})
		await this.listen(this.context.partyBQuoteActionsFacet as any, "AcceptCancelRequest", (...args) => {
			const value = eventValue(args)
			this.emitQuoteStatus(Number(value.quoteStatus) as QuoteStatus, value.quoteId)
		})

		await this.listen(this.context.partyBPositionActionsFacet as any, OPEN_POSITION_EVENT, (...args) => {
			this.emitQuoteStatus(QuoteStatus.OPENED, eventValue(args).quoteId)
		})
		await this.listen(this.context.partyBPositionActionsFacet as any, "AcceptCancelCloseRequest", (...args) => {
			const value = eventValue(args)
			this.emitQuoteStatus(Number(value.quoteStatus) as QuoteStatus, value.quoteId)
		})
		await this.listen(this.context.partyBPositionActionsFacet as any, FILL_CLOSE_REQUEST_EVENT, (...args) => {
			const value = eventValue(args)
			this.emitQuoteStatus(Number(value.quoteStatus) as QuoteStatus, value.quoteId)
		})
	}

	getQueue(status: QuoteStatus): Subject<QuoteStateEnvelope> {
		const queue = this.queues.get(status)
		if (!queue) throw new Error(`No fuzz event queue configured for quote status ${status}`)
		return queue
	}

	async stop(): Promise<void> {
		const results = this.started
			? await Promise.allSettled(this.registrations.splice(0).map(({ contract, event, listener }) => contract.off(event, listener)))
			: []
		this.started = false
		for (const queue of this.queues.values()) queue.complete()

		const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
		if (failures.length > 0) {
			throw new MultiError(
				failures.map(failure => failure.reason),
				"Failed to remove one or more fuzz event listeners",
			)
		}
	}

	private async listen(contract: EventContract, event: string, listener: (...args: any[]) => void): Promise<void> {
		await contract.on(event, listener)
		this.registrations.push({ contract, event, listener })
	}

	emitQuoteStatus(status: QuoteStatus, quoteId: bigint, route?: QuoteRoute): void {
		this.getQueue(status).next({ quoteId, ...(route === undefined ? {} : { route }) })
	}
}
