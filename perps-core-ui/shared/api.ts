/**
 * The HTTP contract between `server/` and `ui/`. Types only: nothing here runs, so the server can point
 * JSDoc at it and the UI imports it through `ui/src/types.ts`.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
/** Milliseconds since the epoch or an ISO string; `new Date(value)` reads both. */
export type Time = number | string

// Address book and inspection

export interface Deployment {
	id: string
	name: string
	environment?: string
	chainId: number
}
export interface ContractNode {
	id: string
	kind: string
	name: string
	address: string
	strategy?: string
	implementation?: string
	status?: string
	state: Record<string, any>
	errors?: string[]
	[key: string]: any
}
export interface Connection {
	from: string
	to: string
	label: string
	kind?: string
	status: string
	basis?: string
	/** The value read at the pinned block: an address, a flag, or null when the read was unavailable. */
	actual?: Json
	expected?: Json
	[key: string]: any
}
export interface Profile {
	id: string
	name: string
	chainId: number
	/** The `chains` key in addresses.json, e.g. `arbitrum`. Imported profiles may not have one. */
	chainName?: string
	version?: string
	environment?: string
	rpc?: string
	explorer?: string
	nodes: ContractNode[]
	notes?: string[]
	source?: { url?: string; entry?: string; checked?: string }
	links?: { label?: string; url: string }[]
	[key: string]: any
}
export interface Snapshot {
	nodes: ContractNode[]
	edges: Connection[]
	chainId: number
	blockNumber: number
	at: string
	fingerprint: string
	profile: Profile
	coverage?: Record<string, any>
	roleHistory?: Record<string, any>
	/** Where each kind of fact in this snapshot came from. Absent on snapshots saved before the engine recorded it. */
	sources?: Record<string, any>
}
/** One entry of the configuration changes since the previous inspection. `kind` says what it is about. */
export type SystemChange =
	| { kind: "contract"; node: string; name: string; nodeKind: string; field: string; before: Json; after: Json }
	| { kind: "state"; node: string; name: string; field: string; before: Json; after: Json }
	| {
			kind: "connection"
			node: string
			to: string
			label: string
			edgeKind?: string
			field: string
			before: { value: Json; status: string } | null
			after: { value: Json; status: string } | null
	  }
/** Checkout against live code for one contract, keyed by node id. Diamonds count facets; the others compare runtime. */
export type Comparison = DiamondComparison | RuntimeComparison
export interface DiamondComparison {
	kind: "diamond"
	matching: number
	total: number
	buildDigest: string
	facets: { name: string; state: "matching" | "changed"; current: string | string[]; functions: number; dependencies: string[] }[]
	unrecognized: string[]
	interfaceChanges: { added: { selector: string; signature: string }[]; removed: string[] }
}
export interface RuntimeComparison {
	kind: "partyB" | "verifier"
	matching: boolean
	buildDigest: string
	note?: string
}

// Builds and the Diamond engine

export interface SourceIdentity {
	branch?: string
	commit: string
	digest: string
}
export interface Facet {
	name: string
	kind: string
	selectors: Record<string, string>
	dependencies: string[]
}
export interface BuildSummary {
	scope?: string
	digest: string
	source: SourceIdentity
	catalog: Facet[]
}
export interface EngineSnapshot {
	chainId: number
	target: string
	owner: string
	blockNumber: number
	blockHash?: string
	diamondCodeHash?: string
	facets: { address: string; selectors: string[]; codeHash?: string }[]
	map: Record<string, string>
	authority: { kind: string; [key: string]: any }
	fingerprint: string
	/** When `connect` read this snapshot; null for one restored from an open task's plan. */
	inspectedAt?: string | null
	/** True when the snapshot was restored after a restart; it can be shown but not prepared from. */
	restored?: boolean
}

// Plans

export interface SelectorChange {
	selector: string
	action: "add" | "replace" | "remove"
	signature?: string
	name?: string
	from: string | null
	to: string | null
}
export interface PeripheralChange {
	contract: string
	field: string
	before: Json
	after: Json
}
export interface PlannedAction {
	id: string
	label: string
	phase: "deploy" | "configure" | "cutover" | "retire"
	sender: string
	to?: string
	data: string
	value: string
	method?: string
	args?: Json
	nonce?: number
	creates?: string
}
interface PlanBase {
	id: string
	version: number
	scope: string
	createdAt: string
	source: SourceIdentity
	buildDigest: string
	blockers: string[]
	/** Which deployment the plan was prepared for. Absent on plans saved before plans recorded it. */
	deployment?: Deployment
}
/** A Diamond cut prepared by the engine. Older records carry no `kind`; an absent `kind` means Diamond. */
export interface DiamondPlan extends PlanBase {
	kind?: "diamond"
	snapshot: EngineSnapshot
	baselineDigest: string
	selected: string[]
	mode: "patch" | "reconcile"
	removals: string[]
	deployer: string
	bindings: Record<string, string>
	deployments: { name: string; kind?: string; address: string; [key: string]: any }[]
	supportingCode: Record<string, string>
	changes: SelectorChange[]
	finalMap: Record<string, string>
	// Peripheral-only fields, so shared fallbacks such as `p.chainId || p.snapshot?.chainId` read either kind.
	chainId?: never
	sourceAddress?: never
	authority?: never
	actions?: never
	warnings?: never
	blockNumber?: never
}
/** A deployment, configuration and cutover sequence prepared by the peripheral workspace. */
export interface PeripheralPlan extends PlanBase {
	kind: "peripheral"
	nodeId: string
	chainId: number
	blockNumber: number
	blockHash?: string
	profile: Profile
	sourceAddress: string
	replacement: string
	deployer: string
	authority: string
	actions: PlannedAction[]
	changes: PeripheralChange[]
	warnings: string[]
	reads?: Json
	codePins?: Record<string, string>
	roles?: Json
	storagePins?: Record<string, string>
	// Diamond-only fields, read the same way.
	snapshot?: never
	baselineDigest?: never
	bindings?: never
}
export type Plan = DiamondPlan | PeripheralPlan
export type JournalStatus = "awaiting-signature" | "submitted" | "confirmed" | "failed" | (string & {})
export interface JournalEntry {
	id: string
	component?: string
	sender: string
	request: TransactionRequest
	status: JournalStatus
	hash?: string
	blockNumber?: number
	createdAt?: string
}
export interface Rehearsal {
	status: "passed" | "failed" | (string & {})
	error?: string
	at?: string
	blockNumber?: number
	checks?: string[]
	gas?: { action: string; gasUsed: string }[]
	limitations?: string[]
	[key: string]: any
}
export interface PlanRecord<P extends Plan = Plan> {
	plan: P
	status: "prepared" | "verified" | (string & {})
	rehearsal?: Rehearsal
	journal?: Record<string, JournalEntry>
	deployed?: Record<string, string>
	execution?: { deploymentMode?: string; upgradeMode?: string; ledgerPath?: string; [key: string]: any }
	safe?: { transactionBuilder: unknown }
	[key: string]: any
}

// Saved plans (C9)

export type PlanFamily = "diamond" | "peripheral"
export type TaskStatus = "prepared" | "running" | "paused" | "waiting_external" | "cancel_pending"
export interface HistoryItem {
	id: string
	family: PlanFamily
	target: string
	scope: string
	chainId: number
	createdAt: string
	status: string
	changes: number
	deployment?: Deployment
	rehearsal: "none" | "passed" | "failed"
	execution?: { confirmed: number; submitted: number; unresolved: number }
	active: boolean
	taskStatus?: TaskStatus
	waitingFor?: string
}

// Tasks, jobs, progress and errors

/** The task lock shared with `./symmio`, as `getActive()` returns it. */
export interface ActiveTask {
	runId: string
	taskId: string
	title?: string
	status: TaskStatus
	waitingFor?: string
	lastError?: string | null
	chainId?: number
	input: { planId?: string; [key: string]: any }
	runner: { running: boolean; pid?: number }
	/** The task's steps in order, as its definition planned them. */
	plan?: { id: string; title: string; phase?: string }[]
	/** Ids of the steps that finished. */
	completedSteps?: string[]
	createdAt?: string
	updatedAt?: string
}
export type JobState = "running" | "done" | "failed" | "cancelled"
export interface Job<R = JobResult> {
	id: string
	route: string
	state: JobState
	error?: string
	code?: ErrorCode
	result?: R
	startedAt: Time
	endedAt?: Time
}
/** What a finished job hands back: `{ planId }` for prepare, `{ digest }` for compile. */
export type JobResult = { planId?: string; digest?: string; [key: string]: Json | undefined }
export interface Progress {
	label: string
	phase: string
	/** 1-based: the first phase is 1. */
	phaseIndex: number
	phaseCount: number
	/** Units finished in this phase, and how many there are; null when the phase cannot count them. */
	done?: number | null
	total?: number | null
	startedAt: Time
}
export type ErrorCode =
	| "busy"
	| "stale-source"
	| "stale-plan"
	| "nonce-changed"
	| "stale-fingerprint"
	| "chain-mismatch"
	| "task-active"
	| "rpc"
	| "bad-input"
	| "bad-request"
	| "not-found"
	| "internal"
	| "unexpected"
	| "cancelled"
	| (string & {})
export interface ErrorInfo {
	id: string
	operation: string
	message: string
	code?: ErrorCode
	at: Time
}
/** The body of every failed request. */
export interface ErrorBody {
	error: string
	code?: ErrorCode
}

// Wallet prompts (C10)

export interface TransactionRequest {
	to?: string
	data: string
	value: string
	chainId: number
	nonce: number
	gasLimit: string
	type?: number
	gasPrice?: string
	maxFeePerGas?: string
	maxPriorityFeePerGas?: string
	[key: string]: string | number | undefined
}
export interface WalletPrompt {
	requestId: string
	id: string
	sender: string
	label?: string
	target?: string
	request: TransactionRequest
	claimed?: boolean
	planId?: string
	/** 1-based position of this transaction in the plan, and the plan's transaction count. */
	step?: number
	of?: number
}

// Status payloads

interface StatusBase {
	revision: number
	connected: boolean
	busy: boolean
	error?: string | null
	errorInfo?: ErrorInfo | null
	activity: string
	progress?: Progress | null
	/** The last ten jobs, newest first. */
	jobs?: Job[]
	active?: ActiveTask
	/** The plan the active task runs, and whether this adapter runs it. */
	activePlanId?: string | null
	ownsActiveTask?: boolean
	/** What the task this adapter owns is waiting for, wallet prompts included. */
	waitingFor?: string | null
	/** This adapter owns the active task and has no provider: reconnect before continuing. */
	needsReconnect?: boolean
	history: HistoryItem[]
}
export interface SystemStatus extends StatusBase {
	/** The snapshot on screen was read live in this session, not restored from disk. */
	live?: boolean
	profile: Profile
	snapshot?: Snapshot
	/** Keyed by node id. Read entries as `Comparison` and narrow on `kind`. */
	comparison: Record<string, any>
	delta: SystemChange[]
	/** The inspection `delta` was measured against. */
	since?: { blockNumber: number; at?: string } | null
	plan?: PlanRecord
}
export interface EngineStatus extends StatusBase {
	snapshot?: EngineSnapshot
	build?: BuildSummary
	baseline?: { digest: string; source?: SourceIdentity }
	prompts: WalletPrompt[]
}

// Routes

export interface Accepted {
	accepted: true
}
export interface JobAccepted extends Accepted {
	jobId: string
}
interface Get<Response> {
	method: "GET"
	response: Response
}
interface Post<Body, Response> {
	method: "POST"
	body: Body
	response: Response
}
export interface ExecuteBody {
	id: string
	deploymentMode: string
	upgradeMode: string
	ledgerPath?: string
	/** `<deploymentId>:<planId first 8>`, or `<chainId>:<planId first 8>` for plans without a deployment. */
	confirmation: string
}
export interface AttachBody {
	id: string
	actionId: string
	hash: string
}
/** Route (without `/api/`) to its method, body and response. GET routes may add a query string. */
export interface Routes {
	status: Get<EngineStatus>
	"system/status": Get<SystemStatus>
	profiles: Get<{ profiles: Profile[] }>
	plan: Get<PlanRecord<DiamondPlan>>
	export: Get<PlanRecord<DiamondPlan> & { build: unknown }>
	build: Get<Json>
	"system/plan": Get<PlanRecord<PeripheralPlan>>
	"system/build": Get<Json>
	"system/export": Get<PlanRecord<PeripheralPlan>>
	"system/safe": Get<{ transactionBuilder: unknown }>
	"fuzz/report": Get<unknown>
	"fuzz/runs": Get<unknown>

	claim: Post<{ requestId: string }, Accepted>
	"pause-wallet": Post<{ requestId: string }, Accepted>
	respond: Post<{ requestId: string; hash?: string; rejected?: true }, Accepted>
	"jobs/cancel": Post<{ jobId: string }, Accepted>
	"errors/dismiss": Post<{ id: string }, { dismissed: boolean }>

	connect: Post<{ rpc?: string; target: string }, EngineSnapshot>
	reconnect: Post<{ rpc?: string }, Accepted>
	compile: Post<{ scope: string }, JobAccepted>
	baseline: Post<Json, { digest: string }>
	prepare: Post<{ selected: string[]; removals: string[]; deployer: string; mode: string }, PlanRecord<DiamondPlan>>
	rehearse: Post<{ id: string }, JobAccepted>
	execute: Post<ExecuteBody, JobAccepted>
	resume: Post<Record<string, never>, JobAccepted>
	cancel: Post<Record<string, never>, JobAccepted>
	attach: Post<AttachBody, unknown>

	"system/select": Post<{ id: string } | { profile: Profile }, unknown>
	"system/reconnect": Post<{ rpc?: string }, Accepted>
	"system/scan": Post<{ rpc?: string; profile?: Profile }, JobAccepted>
	"system/compare": Post<Record<string, never>, JobAccepted>
	"system/prepare": Post<{ nodeId: string; deployer: string; authority: string }, JobAccepted>
	"system/rehearse": Post<{ id: string }, JobAccepted>
	"system/verify": Post<{ id: string }, JobAccepted>
	"system/execute": Post<ExecuteBody, JobAccepted>
	"system/resume": Post<Record<string, never>, JobAccepted>
	"system/cancel": Post<Record<string, never>, JobAccepted>
	"system/attach": Post<AttachBody, unknown>
	"system/open": Post<{ id: string }, PlanRecord<PeripheralPlan>>
	"system/baseline": Post<Json, { scope: string; digest: string }>
}
export type Route = keyof Routes
export type GetRoute = { [R in Route]: Routes[R] extends { method: "GET" } ? R : never }[Route]
export type PostRoute = { [R in Route]: Routes[R] extends { method: "POST" } ? R : never }[Route]
/** A GET route, optionally with its query string: `plan?id=…`. */
export type GetPath = GetRoute | `${GetRoute}?${string}`
export type RouteOf<P extends string> = P extends `${infer R}?${string}` ? R : P
export type ResponseOf<P extends string> = RouteOf<P> extends Route ? Routes[RouteOf<P>]["response"] : never
export type BodyOf<R extends PostRoute> = Routes[R] extends { body: infer B } ? B : never
/** Routes whose POST starts a background job and answers 202 with a job id. */
export type JobRoute = { [R in PostRoute]: Routes[R]["response"] extends JobAccepted ? R : never }[PostRoute]
