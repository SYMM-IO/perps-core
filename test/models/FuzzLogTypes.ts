export type FuzzLogLevel = "quiet" | "summary" | "progress" | "trace"

export type FuzzLogFormat = "pretty" | "json"

export type FuzzRunMode = "continuous" | "bounded"

export type FuzzStopSignal = "SIGINT" | "SIGTERM"

export type FuzzFailureBoundary = "setup" | "execution" | "drain" | "verification"

export type FuzzActorInfo = {
	id: string
	address: string
}

export type FuzzQueueSnapshot = {
	accepted: number
	completed: number
	scheduled: number
	pending: number
	running: boolean
	paused: boolean
	stopped: boolean
	failures: number
}

export type FuzzActionPhase = "queued" | "started" | "succeeded" | "failed" | "timed_out" | "settled_after_timeout"

export const FUZZ_CORNER_OPERATIONS = [
	"FUNDING_CHARGE",
	"SETTLE_UPNL",
	"FORCE_CLOSE",
	"EMERGENCY_CLOSE",
	"EXPIRE_QUOTE",
	"LIQUIDATE_PARTY_A",
	"LIQUIDATE_PARTY_B",
] as const

export type FuzzCornerOperation = (typeof FUZZ_CORNER_OPERATIONS)[number]

export type FuzzOperationPhase = "started" | "succeeded" | "skipped" | "failed"

export type FuzzQuoteSnapshot = {
	positionType: string
	orderType: string
	quantity: bigint
	closedAmount: bigint
	quantityToClose: bigint
	parentId: bigint
}

export type FuzzModelEvent =
	| {
			type: "action"
			sequence: number
			title: string
			phase: FuzzActionPhase
			queue: FuzzQueueSnapshot
			error?: unknown
	  }
	| {
			type: "decision"
			actionSequence?: number
			actor: "user" | "hedger"
			actorId: string
			quoteId: bigint
			quoteStatus: string
			action: string
			validated: boolean
	  }
	| {
			type: "state"
			actionSequence?: number
			quoteId: bigint
			quoteStatus: string
			quote: FuzzQuoteSnapshot
	  }
	| {
			type: "operation"
			actionSequence?: number
			operation: FuzzCornerOperation
			phase: FuzzOperationPhase
			quoteIds?: bigint[]
			actorIds?: string[]
			detail?: string
			error?: unknown
	  }
	| {
			type: "pause"
			paused: boolean
	  }

export type FuzzRunConfig = {
	seed: string
	runMode: FuzzRunMode
	rootActions: number
	userCount: number
	hedgerCount: number
	progressEvery: number
	cornerEvery: number
	eventMode: "direct" | "provider"
	validationProbability: number
	blockedQuoteProbability: number
	rethinkDelayMs: number
	actionTimeoutMs: number
	runTimeoutMs: number
	drainTimeoutMs: number
}

export type FuzzControllerOptions = Pick<FuzzRunConfig, "validationProbability" | "blockedQuoteProbability" | "rethinkDelayMs">

export type FuzzSetupInfo = {
	users: FuzzActorInfo[]
	hedgers: FuzzActorInfo[]
	durationMs: number
}

export type FuzzRootResult = {
	index: number
	total?: number
	userId: string
	hedgerId: string
	status: "sent" | "discarded"
	quoteId?: bigint
	reason?: string
	durationMs: number
	queue: FuzzQueueSnapshot
}

export type FuzzRunResult = {
	durationMs: number
	rootActions: number
	sentQuotes: number
	discardedInputs: number
	discardedReasons: Record<string, number>
	queue: FuzzQueueSnapshot
}

export type FuzzFailure = {
	boundary: FuzzFailureBoundary
	error: unknown
}
