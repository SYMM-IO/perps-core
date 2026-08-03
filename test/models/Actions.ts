import { QuoteStatus } from "./Enums.js"

export enum Action {
	CANCEL_REQUEST,
	ACCEPT_CANCEL_REQUEST,
	LOCK_QUOTE,
	UNLOCK_QUOTE,
	OPEN_POSITION,
	CLOSE_REQUEST,
	FORCE_CLOSE_REQUEST,
	CANCEL_CLOSE_REQUEST,
	ACCEPT_CANCEL_CLOSE_REQUEST,
	FILL_POSITION,
	NOTHING,
	SEND_QUOTE,
}

export class ActionWrapper {
	constructor(
		public action: Action,
		public probability: number = 1,
		public rethink: boolean = false,
	) {}
}

export const actionNamesMap: Map<Action, string> = new Map([
	[Action.CANCEL_REQUEST, "CANCEL_REQUEST"],
	[Action.ACCEPT_CANCEL_REQUEST, "ACCEPT_CANCEL_REQUEST"],
	[Action.LOCK_QUOTE, "LOCK_QUOTE"],
	[Action.UNLOCK_QUOTE, "UNLOCK_QUOTE"],
	[Action.OPEN_POSITION, "OPEN_POSITION"],
	[Action.CLOSE_REQUEST, "CLOSE_REQUEST"],
	[Action.FORCE_CLOSE_REQUEST, "FORCE_CLOSE_REQUEST"],
	[Action.CANCEL_CLOSE_REQUEST, "CANCEL_CLOSE_REQUEST"],
	[Action.ACCEPT_CANCEL_CLOSE_REQUEST, "ACCEPT_CANCEL_CLOSE_REQUEST"],
	[Action.FILL_POSITION, "FILL_POSITION"],
	[Action.NOTHING, "NOTHING"],
	[Action.SEND_QUOTE, "SEND_QUOTE"],
])

export const userActionsMap: Map<QuoteStatus, ActionWrapper[]> = new Map([
	[QuoteStatus.PENDING, [new ActionWrapper(Action.CANCEL_REQUEST, 2), new ActionWrapper(Action.NOTHING, 8)]],
	[QuoteStatus.LOCKED, [new ActionWrapper(Action.CANCEL_REQUEST, 2), new ActionWrapper(Action.NOTHING, 8)]],
	[QuoteStatus.CANCEL_PENDING, [new ActionWrapper(Action.NOTHING)]],
	[QuoteStatus.CANCELED, [new ActionWrapper(Action.NOTHING)]],
	// Keep most positions open so later world ticks can exercise funding,
	// settlement, force-close, emergency, and liquidation paths.
	[QuoteStatus.OPENED, [new ActionWrapper(Action.CLOSE_REQUEST, 7), new ActionWrapper(Action.NOTHING, 3)]],
	[QuoteStatus.CLOSE_PENDING, [new ActionWrapper(Action.CANCEL_CLOSE_REQUEST, 1), new ActionWrapper(Action.NOTHING, 3)]],
	[QuoteStatus.CANCEL_CLOSE_PENDING, [new ActionWrapper(Action.NOTHING)]],
	[QuoteStatus.CLOSED, [new ActionWrapper(Action.NOTHING)]],
	[QuoteStatus.LIQUIDATED, [new ActionWrapper(Action.NOTHING)]],
	[QuoteStatus.EXPIRED, [new ActionWrapper(Action.NOTHING)]],
	[QuoteStatus.LIQUIDATED_PENDING, [new ActionWrapper(Action.NOTHING)]],
])

export const hedgerActionsMap: Map<QuoteStatus, ActionWrapper[]> = new Map([
	[QuoteStatus.PENDING, [new ActionWrapper(Action.LOCK_QUOTE)]],
	[QuoteStatus.LOCKED, [new ActionWrapper(Action.UNLOCK_QUOTE, 1), new ActionWrapper(Action.OPEN_POSITION, 4)]],
	[QuoteStatus.CANCEL_PENDING, [new ActionWrapper(Action.ACCEPT_CANCEL_REQUEST, 1), new ActionWrapper(Action.OPEN_POSITION, 1)]],
	[QuoteStatus.CANCELED, [new ActionWrapper(Action.NOTHING)]],
	[QuoteStatus.OPENED, [new ActionWrapper(Action.NOTHING)]],
	[QuoteStatus.CLOSE_PENDING, [new ActionWrapper(Action.FILL_POSITION)]], //TODO : Review
	[QuoteStatus.CANCEL_CLOSE_PENDING, [new ActionWrapper(Action.FILL_POSITION, 1), new ActionWrapper(Action.ACCEPT_CANCEL_CLOSE_REQUEST, 2)]],
	[QuoteStatus.CLOSED, [new ActionWrapper(Action.NOTHING)]],
	[QuoteStatus.LIQUIDATED, [new ActionWrapper(Action.NOTHING)]],
	[QuoteStatus.EXPIRED, [new ActionWrapper(Action.NOTHING)]],
	[QuoteStatus.LIQUIDATED_PENDING, [new ActionWrapper(Action.NOTHING)]],
])

export function expandActions(wrappers: ActionWrapper[]): ActionWrapper[] {
	let actions: ActionWrapper[] = []
	for (const wrapper of wrappers) {
		if (!Number.isInteger(wrapper.probability) || wrapper.probability <= 0) {
			throw new Error(`Action probability must be a positive integer, received ${wrapper.probability}`)
		}
		for (let i = 0; i < wrapper.probability; i++) actions.push(wrapper)
	}
	return actions
}

export function assertActionMapsComplete(): void {
	const statuses = Object.values(QuoteStatus).filter((status): status is QuoteStatus => typeof status === "number")
	for (const [name, actions] of [
		["user", userActionsMap],
		["hedger", hedgerActionsMap],
	] as const) {
		for (const status of statuses) {
			if (!actions.has(status)) throw new Error(`Missing ${name} fuzz actions for quote status ${QuoteStatus[status]}`)
		}
	}
}

export type FuzzActionRoute = "root" | "user" | "hedger"

const handledActionsByRoute: Readonly<Record<FuzzActionRoute, ReadonlySet<Action>>> = {
	root: new Set([Action.SEND_QUOTE]),
	user: new Set([Action.CANCEL_REQUEST, Action.CLOSE_REQUEST, Action.CANCEL_CLOSE_REQUEST, Action.NOTHING]),
	hedger: new Set([
		Action.ACCEPT_CANCEL_REQUEST,
		Action.LOCK_QUOTE,
		Action.UNLOCK_QUOTE,
		Action.OPEN_POSITION,
		Action.ACCEPT_CANCEL_CLOSE_REQUEST,
		Action.FILL_POSITION,
		Action.NOTHING,
	]),
}

export function assertFuzzActionRoute(route: FuzzActionRoute, action: Action): void {
	if (!handledActionsByRoute[route].has(action)) {
		throw new Error(`Missing ${route} handler for fuzz action ${actionNamesMap.get(action) ?? Action[action] ?? action}`)
	}
}

export function assertFuzzActionCoverage(validators: ReadonlyMap<Action, unknown>): void {
	assertFuzzActionRoute("root", Action.SEND_QUOTE)
	if (!validators.has(Action.SEND_QUOTE)) throw new Error("Missing validator for root fuzz action SEND_QUOTE")

	for (const [route, actions] of [
		["user", userActionsMap],
		["hedger", hedgerActionsMap],
	] as const) {
		for (const wrappers of actions.values()) {
			for (const { action } of wrappers) {
				if (action === Action.NOTHING) continue
				assertFuzzActionRoute(route, action)
				if (!validators.has(action)) {
					throw new Error(`Missing validator for reachable ${route} fuzz action ${actionNamesMap.get(action) ?? Action[action] ?? action}`)
				}
			}
		}
	}
}

assertActionMapsComplete()
