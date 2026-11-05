// @ts-check
/**
 * Pure readings of a fuzz report as `test/utils/FuzzDashboardReporter.ts` writes it. Nothing here touches the
 * DOM, so the verdict, coverage, yield and timelines can be tested on plain documents.
 */

/** @typedef {Record<string, any>} Json */

/**
 * @typedef {object} FuzzReport
 * @property {number} [schemaVersion]
 * @property {string} [kind]
 * @property {string} [updatedAt]
 * @property {Json} [run] status, seed, config, startedAt, finishedAt, setup, signal, result, failures, traceHash, replay
 * @property {Json} [latest] root, queue, pace, actions, assurance, quotes, corners, lastActivity
 * @property {Json} [counters] roots, discardedReasons, actions, decisions
 * @property {Json} [milestones] quoteStates and corners, each keyed by target with the first time it was reached
 * @property {{ quoteStates?: string[], cornerOperations?: string[] }} [targets]
 * @property {Json[]} [timeline]
 * @property {Json[]} [activity]
 * @property {Json} [retention]
 */

/** @typedef {'good' | 'bad' | 'warn' | 'info' | 'neutral'} Tone */
/** @typedef {{ key: string, label: string, group: string }} QuoteStateTarget */
/** @typedef {{ key: string, label: string }} CornerTarget */
/** @typedef {{ cycle?: number, quoteId?: string, actionSequence?: number, detail: string }} Milestone */
/**
 * @typedef {object} FailureRecord
 * @property {string} boundary
 * @property {string} message
 * @property {number} [cycle] the cycle during which the run failed
 * @property {number} [actionSequence]
 * @property {string} actionTitle
 * @property {string} stack
 * @property {string} cause
 */

export const SUPPORTED_SCHEMA_VERSION = 1

/** Names for the runner's quote states. The report says which states are targets; this only labels them. */
const QUOTE_STATE_LABELS = {
  PENDING: ['Awaiting hedger', 'waiting'],
  LOCKED: ['Reserved by hedger', 'waiting'],
  CANCEL_PENDING: ['Cancellation requested', 'waiting'],
  OPENED: ['Position open', 'positions'],
  CLOSE_PENDING: ['Close requested', 'positions'],
  CANCEL_CLOSE_PENDING: ['Close cancellation requested', 'positions'],
  CANCELED: ['Canceled before opening', 'outcomes'],
  CLOSED: ['Closed', 'outcomes'],
  LIQUIDATED: ['Liquidated after opening', 'outcomes'],
  EXPIRED: ['Expired', 'outcomes'],
  LIQUIDATED_PENDING: ['Liquidated before opening', 'outcomes'],
}

const CORNER_LABELS = {
  FUNDING_CHARGE: 'Funding charge',
  SETTLE_UPNL: 'Settle unrealized PnL',
  FORCE_CLOSE: 'Force close',
  EMERGENCY_CLOSE: 'Emergency close',
  EXPIRE_QUOTE: 'Quote expiry',
  LIQUIDATE_PARTY_A: 'User liquidation',
  LIQUIDATE_PARTY_B: 'Hedger liquidation',
  ACCOUNT_LAYER_LIFECYCLE: 'AccountLayer lifecycle',
  INSTANT_LAYER_LIFECYCLE: 'InstantLayer lifecycle',
  ACCOUNT_LAYER_SINGLE_VA: 'Single VA routing',
  ACCOUNT_LAYER_OWNERSHIP: 'Account ownership',
  ACCOUNT_LAYER_LEGACY_IMPORT: 'Legacy account import',
  ACCOUNT_LAYER_MARGIN_RECOVERY: 'Safe margin and recovery',
  ACCOUNT_LAYER_TIMELOCK: 'AccountLayer timelocks',
  INSTANT_LAYER_TIMELOCK: 'InstantLayer timelocks',
  INSTANT_LAYER_DELEGATION: 'Delegation lifecycle',
  INSTANT_LAYER_FLEX_FIELDS: 'Flex field fills',
  INSTANT_LAYER_TEMPLATE: 'Instant-open template',
  INSTANT_LAYER_PARTY_B_RELAYS: 'PartyB signed relays',
}

/** Action types with an independent state validator. */
export const ACTION_TYPES = [
  'SEND_QUOTE',
  'CANCEL_REQUEST',
  'ACCEPT_CANCEL_REQUEST',
  'LOCK_QUOTE',
  'UNLOCK_QUOTE',
  'OPEN_POSITION',
  'CLOSE_REQUEST',
  'CANCEL_CLOSE_REQUEST',
  'ACCEPT_CANCEL_CLOSE_REQUEST',
  'FILL_POSITION',
]

const LIVE_QUOTE_STATES = ['PENDING', 'LOCKED', 'CANCEL_PENDING', 'OPENED', 'CLOSE_PENDING', 'CANCEL_CLOSE_PENDING']
const ENDED_QUOTE_STATES = ['CANCELED', 'CLOSED', 'LIQUIDATED', 'EXPIRED', 'LIQUIDATED_PENDING']
const LIVE_RUN_STATES = ['initializing', 'running', 'draining']
const TERMINAL_RUN_STATES = ['passed', 'stopped', 'failed']

// ---- Values and formatting -------------------------------------------------------------------------

/** @param {unknown} value @returns {value is Json} */
export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {Json} */
export function object(value) {
  return isObject(value) ? value : {}
}

/** The first finite number among `values`, reading bigints and numeric strings. @param {...unknown} values */
export function optionalNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'bigint') return Number(value)
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/** @param {unknown} value @param {number} [fallback] */
export function numeric(value, fallback = 0) {
  return optionalNumber(value) ?? fallback
}

/** @param {unknown} value @param {string} [fallback] @returns {string} */
export function text(value, fallback = '—') {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (isObject(value) && value.message !== undefined) return text(value.message, fallback)
  return fallback
}

/** @param {unknown} value */
export function compactNumber(value) {
  const number = numeric(value)
  const absolute = Math.abs(number)
  if (absolute < 10_000) return new Intl.NumberFormat('en-US', { maximumFractionDigits: absolute < 10 ? 1 : 0 }).format(number)
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(number)
}

/** @param {unknown} value */
export function rate(value) {
  const number = optionalNumber(value)
  return number === undefined ? '—' : `${number.toFixed(number >= 10 ? 0 : 1)}/s`
}

/** A ratio in [0, 1] as a percentage. @param {unknown} value */
export function percent(value) {
  const number = optionalNumber(value)
  if (number === undefined) return '—'
  const normalized = number * 100
  return `${normalized.toFixed(normalized >= 10 || normalized === 0 ? 0 : 1)}%`
}

/** @param {unknown} value milliseconds */
export function duration(value) {
  const milliseconds = optionalNumber(value)
  if (milliseconds === undefined) return '—'
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`
  const seconds = milliseconds / 1_000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** @param {unknown} value */
export function timestampNumber(value) {
  const number = optionalNumber(value)
  if (number !== undefined) return number > 0 && number < 10_000_000_000 ? number * 1_000 : number
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** SEND_QUOTE → Send Quote. @param {unknown} value */
export function humanize(value) {
  return text(value, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

/** @param {unknown} count @param {string} singular @param {string} [pluralForm] */
export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${compactNumber(count)} ${numeric(count) === 1 ? singular : pluralForm}`
}

/** Speaks of users, hedgers and cycles instead of the runner's PartyA, PartyB and roots. @param {unknown} value */
export function stakeholderCopy(value, fallback = '') {
  return text(value, fallback)
    .replace(/\bParty\s*A\b/gi, 'user')
    .replace(/\bParty\s*B\b/gi, 'hedger')
    .replace(/\bPartyA\b/gi, 'user')
    .replace(/\bPartyB\b/gi, 'hedger')
    .replace(/\broot actions?\b/gi, 'simulation cycles')
    .replace(/\broots?\b/gi, (match) => (/s$/i.test(match) ? 'simulation cycles' : 'simulation cycle'))
}

/** @param {unknown} value @returns {string[] | undefined} */
function stringList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string') ? value : undefined
}

// ---- Report identity -------------------------------------------------------------------------------

/** A report the view can draw, as opposed to the server's `{ status: 'waiting' }`. @param {unknown} value */
export function isReport(value) {
  return isObject(value) && (isObject(value.run) || isObject(value.latest))
}

/** A plain notice when the report is in a newer format than this view reads, otherwise ''. @param {FuzzReport | null} report */
export function schemaNotice(report) {
  const version = optionalNumber(report?.schemaVersion)
  if (version === undefined || version <= SUPPORTED_SCHEMA_VERSION) return ''
  return `This report is in format ${version}, and this view reads format ${SUPPORTED_SCHEMA_VERSION}. Some sections may be missing or incomplete; update this checkout to read it in full.`
}

/** Changes whenever the runner writes something new. @param {FuzzReport | null} report */
export function reportKey(report) {
  return `${text(report?.updatedAt, '')}|${runStatus(report)}`
}

/** @param {FuzzReport | null} report */
export function runStatus(report) {
  return text(report?.run?.status, 'waiting').toLowerCase()
}

/** @param {FuzzReport | null} report */
export function isLiveRun(report) {
  return LIVE_RUN_STATES.includes(runStatus(report))
}

/** @param {FuzzReport | null} report */
export function isTerminalRun(report) {
  return TERMINAL_RUN_STATES.includes(runStatus(report))
}

/** @param {string} status @returns {Tone} */
export function statusTone(status) {
  if (status === 'failed') return 'bad'
  if (status === 'passed') return 'good'
  if (status === 'stopped' || status === 'draining') return 'warn'
  if (status === 'running' || status === 'initializing') return 'info'
  return 'neutral'
}

// ---- Targets ---------------------------------------------------------------------------------------

/** The report's quote-state targets, or the runner's list for reports written before it carried them. */
export function quoteStateTargets(/** @type {FuzzReport | null} */ report) {
  const keys = stringList(report?.targets?.quoteStates) ?? Object.keys(QUOTE_STATE_LABELS)
  return keys.map((key) => {
    const known = /** @type {Record<string, string[]>} */ (QUOTE_STATE_LABELS)[key]
    return { key, label: known?.[0] ?? humanize(key), group: known?.[1] ?? 'other' }
  })
}

/** The report's high-risk workflow targets, or the runner's list for older reports. */
export function cornerTargets(/** @type {FuzzReport | null} */ report) {
  const keys = stringList(report?.targets?.cornerOperations) ?? Object.keys(CORNER_LABELS)
  return keys.map((key) => ({ key, label: /** @type {Record<string, string>} */ (CORNER_LABELS)[key] ?? humanize(key) }))
}

/**
 * When a target was first reached. A milestone's `root` counts the cycles completed before the event, so the
 * event happened during the next one.
 * @param {FuzzReport | null} report @param {'quoteStates' | 'corners'} kind @param {string} key
 * @returns {Milestone | undefined}
 */
export function firstReached(report, kind, key) {
  const entry = report?.milestones?.[kind]?.[key]
  if (!isObject(entry)) return undefined
  const root = optionalNumber(entry.root)
  const quoteId = entry.quoteId ?? (Array.isArray(entry.quoteIds) ? entry.quoteIds[0] : undefined)
  return {
    cycle: root === undefined ? undefined : root + 1,
    quoteId: quoteId === undefined ? undefined : text(quoteId, ''),
    actionSequence: optionalNumber(entry.actionSequence),
    detail: text(entry.detail, ''),
  }
}

/** "first at cycle 4 · quote #12", or '' when nothing was recorded. @param {Milestone | undefined} milestone */
export function firstReachedCopy(milestone) {
  if (!milestone) return ''
  return [
    milestone.cycle === undefined ? 'first reached' : `first at cycle ${compactNumber(milestone.cycle)}`,
    milestone.quoteId && `quote #${milestone.quoteId}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

// ---- Quotes, queue and workflows -------------------------------------------------------------------

/** @param {unknown} quotes */
export function hasQuoteTelemetry(quotes) {
  return isObject(quotes) && ['total', 'active', 'terminal', 'byStatus'].some((field) => quotes[field] !== undefined)
}

/** @param {unknown} quotes */
export function hasQuoteStatusBreakdown(quotes) {
  const counts = object(object(quotes).byStatus)
  return Object.keys(QUOTE_STATE_LABELS).some((key) => counts[key] !== undefined && counts[key] !== null)
}

/** Live and ended counts. A count the report does not give stays undefined rather than zero. @param {unknown} source */
export function quoteTotals(source) {
  const quotes = object(source)
  const counts = object(quotes.byStatus)
  const sum = (/** @type {string[]} */ keys) =>
    keys.every((key) => optionalNumber(counts[key]) !== undefined) ? keys.reduce((total, key) => total + numeric(counts[key]), 0) : undefined
  const active = optionalNumber(quotes.active) ?? sum(LIVE_QUOTE_STATES)
  const terminal = optionalNumber(quotes.terminal) ?? sum(ENDED_QUOTE_STATES)
  const total = optionalNumber(quotes.total) ?? (active !== undefined && terminal !== undefined ? active + terminal : undefined)
  return { active, terminal, total }
}

/** @param {unknown} queue */
export function hasQueueTelemetry(queue) {
  return isObject(queue) && ['accepted', 'outstanding', 'pending', 'scheduled'].some((field) => queue[field] !== undefined)
}

/** Works for a queue snapshot and for a checkpoint's queue peak, which carries `outstanding` itself. @param {unknown} source */
export function queueTotals(source) {
  const queue = object(source)
  return {
    accepted: numeric(queue.accepted),
    completed: numeric(queue.completed),
    outstanding: optionalNumber(queue.outstanding) ?? Math.max(0, numeric(queue.accepted) - numeric(queue.completed)),
    pending: numeric(queue.pending),
    scheduled: numeric(queue.scheduled),
    running: queue.running === true ? 1 : 0,
    failures: optionalNumber(queue.failures),
  }
}

/** @param {unknown} corners @param {string} key */
export function cornerCounts(corners, key) {
  const source = object(object(object(corners).byOperation)[key])
  const attempted = numeric(source.attempted)
  const succeeded = numeric(source.succeeded)
  const skipped = numeric(source.skipped)
  const failed = numeric(source.failed)
  return { attempted, succeeded, skipped, failed, unresolved: Math.max(0, attempted - succeeded - skipped - failed) }
}

/** @param {ReturnType<typeof cornerCounts>} counts */
export function cornerState(counts) {
  if (counts.succeeded > 0 && counts.failed > 0) return 'verified-with-failures'
  if (counts.failed > 0) return 'failed'
  if (counts.unresolved > 0) return 'unresolved'
  if (counts.succeeded > 0) return 'passed'
  if (counts.skipped > 0) return 'skipped'
  return 'unseen'
}

/** @param {FuzzReport | null} report */
export function cornerTotals(report) {
  const corners = object(report?.latest?.corners)
  const explicit = object(corners.totals)
  const entries = cornerTargets(report).map((target) => cornerCounts(corners, target.key))
  const aggregate = (/** @type {'attempted' | 'succeeded' | 'skipped' | 'failed'} */ field) => entries.reduce((sum, counts) => sum + counts[field], 0)
  return {
    attempted: optionalNumber(explicit.attempted) ?? aggregate('attempted'),
    succeeded: optionalNumber(explicit.succeeded) ?? aggregate('succeeded'),
    skipped: optionalNumber(explicit.skipped) ?? aggregate('skipped'),
    failed: optionalNumber(explicit.failed) ?? aggregate('failed'),
  }
}

/**
 * Which configured targets have evidence: quote states observed, action types independently checked, and
 * high-risk workflows that passed at least once. `available` is false when the report holds no such evidence.
 * @param {FuzzReport | null} report
 */
export function targetEvidence(report) {
  const assurance = object(report?.latest?.assurance)
  const milestones = object(report?.milestones?.quoteStates)
  const stateTargets = quoteStateTargets(report)
  const observed = new Set(Array.isArray(assurance.observedQuoteStatuses) ? assurance.observedQuoteStatuses.map((value) => text(value, '')) : [])
  for (const target of stateTargets) if (isObject(milestones[target.key])) observed.add(target.key)
  const statesAvailable = Array.isArray(assurance.observedQuoteStatuses) || Object.keys(milestones).length > 0

  const actionsAvailable = Array.isArray(assurance.confirmedActionTypes)
  const confirmed = new Set(actionsAvailable ? assurance.confirmedActionTypes.map((/** @type {unknown} */ value) => text(value, '')) : [])

  const corners = object(report?.latest?.corners)
  const cornersAvailable = Object.keys(object(corners.byOperation)).length > 0
  const workflowTargets = cornerTargets(report)
  return {
    states: {
      available: statesAvailable,
      targets: stateTargets,
      observed,
      missing: statesAvailable ? stateTargets.filter((target) => !observed.has(target.key)) : [],
    },
    actions: {
      available: actionsAvailable,
      targets: ACTION_TYPES,
      confirmed,
      missing: actionsAvailable ? ACTION_TYPES.filter((action) => !confirmed.has(action)) : [],
    },
    corners: {
      available: cornersAvailable,
      targets: workflowTargets,
      missing: cornersAvailable ? workflowTargets.filter((target) => cornerCounts(corners, target.key).succeeded === 0) : [],
    },
  }
}

// ---- Failures and verdict --------------------------------------------------------------------------

/** @param {unknown} value */
function errorText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (!isObject(value)) return String(value)
  if (typeof value.stack === 'string' && value.stack) return value.stack
  const heading = [text(value.name, ''), text(value.message, '')].filter(Boolean).join(': ')
  return heading || JSON.stringify(value, null, 2)
}

/** The failures the run ended with, newest last, each with where it happened and its stack and cause. */
export function failureRecords(/** @type {FuzzReport | null} */ report) {
  const failures = Array.isArray(report?.run?.failures) ? report.run.failures : []
  return failures.map((/** @type {unknown} */ raw) => {
    const item = object(raw)
    const error = object(item.error)
    const root = optionalNumber(item.root)
    const nested = Array.isArray(error.errors) ? error.errors.map(errorText).filter(Boolean) : []
    return /** @type {FailureRecord} */ ({
      boundary: text(item.boundary, 'failure'),
      message: text(isObject(item.error) ? error.message : item.error, 'Unknown failure'),
      cycle: root === undefined ? undefined : root + 1,
      actionSequence: optionalNumber(error.actionSequence),
      actionTitle: text(error.actionTitle, ''),
      stack: typeof error.stack === 'string' ? error.stack : '',
      cause: [errorText(error.cause), ...nested].filter(Boolean).join('\n\n'),
    })
  })
}

/**
 * Every signal that something went wrong, and which of those signals the report could not give.
 * @param {FuzzReport | null} report
 */
export function runSignalSnapshot(report) {
  const records = failureRecords(report).length
  const actions = object(report?.latest?.actions)
  const failedActions = optionalNumber(actions.failed)
  const timedOutActions = optionalNumber(actions.timedOut)
  const queueFailures = optionalNumber(report?.latest?.queue?.failures)
  const cornerFailures = optionalNumber(report?.latest?.corners?.totals?.failed)
  const evidenceGaps = [
    failedActions === undefined && 'action failures',
    timedOutActions === undefined && 'action timeouts',
    queueFailures === undefined && 'queue failures',
    cornerFailures === undefined && 'high-risk workflow failures',
  ].filter((gap) => typeof gap === 'string')
  const count = (/** @type {number | undefined} */ value, /** @type {string} */ singular, /** @type {string} */ pluralForm) =>
    value !== undefined && value > 0 ? plural(value, singular, pluralForm) : ''
  const failureCategories = [
    count(records, 'boundary record', 'boundary records'),
    count(failedActions, 'failed action', 'failed actions'),
    count(timedOutActions, 'timed-out action', 'timed-out actions'),
    count(queueFailures, 'queue failure', 'queue failures'),
    count(cornerFailures, 'high-risk workflow failure', 'high-risk workflow failures'),
  ].filter(Boolean)
  if (runStatus(report) === 'failed' && failureCategories.length === 0) failureCategories.push('Run status: Failed')
  const storageWarning = text(report?.retention?.lastWriteError, '')
  const categories = [...failureCategories, ...(storageWarning ? [`Storage warning: ${storageWarning}`] : [])]
  return {
    count: categories.length,
    categories,
    failureCategories,
    hasFailure: failureCategories.length > 0,
    storageWarning,
    evidenceComplete: evidenceGaps.length === 0,
    evidenceGaps,
  }
}

/** The run's verdict: what the status badge says and in which tone. @param {FuzzReport | null} report */
export function runOutcomeSnapshot(report) {
  const status = runStatus(report)
  const signals = runSignalSnapshot(report)
  const queue = hasQueueTelemetry(report?.latest?.queue) ? queueTotals(report?.latest?.queue) : undefined
  const clean = !signals.hasFailure && signals.evidenceComplete
  const stoppedCleanly = status === 'stopped' && clean && queue?.outstanding === 0
  const label = signals.hasFailure
    ? 'Needs attention'
    : stoppedCleanly
      ? 'Stopped cleanly'
      : status === 'draining'
        ? 'Finishing current work'
        : status === 'running' || status === 'initializing'
          ? 'Simulation running'
          : status === 'passed' && clean
            ? 'Completed cleanly'
            : humanize(status)
  /** @type {Tone} */
  const tone = signals.hasFailure ? 'bad' : stoppedCleanly ? 'good' : statusTone(status)
  return { status, signals, clean, stoppedCleanly, label, tone }
}

/**
 * The hero's headline. `connection` is the view's freshness state: a snapshot that is stale, paused or
 * unreachable says so instead of claiming the run is still going.
 * @param {FuzzReport | null} report @param {string} [connection]
 */
export function runHeadline(report, connection = '') {
  const outcome = runOutcomeSnapshot(report)
  if (['stale', 'frozen', 'error'].includes(connection) && isLiveRun(report)) {
    return connection === 'error' ? 'Last report unavailable' : 'Last reported snapshot'
  }
  if (outcome.signals.hasFailure) return 'Needs attention'
  if (outcome.stoppedCleanly) return 'Stopped cleanly'
  if (outcome.status === 'draining') return 'Finishing…'
  if (outcome.status === 'running' || outcome.status === 'initializing') return 'Simulation running'
  if (outcome.status === 'passed' && outcome.clean) return 'Completed cleanly'
  return `Simulation ${humanize(outcome.status).toLowerCase()}`
}

/** @param {FuzzReport | null} report */
export function participantSnapshot(report) {
  const setup = object(report?.run?.setup)
  const config = object(report?.run?.config)
  const users = Array.isArray(setup.users) ? setup.users : []
  const hedgers = Array.isArray(setup.hedgers) ? setup.hedgers : []
  return { userCount: users.length || numeric(config.userCount), hedgerCount: hedgers.length || numeric(config.hedgerCount) }
}

/** @param {FuzzReport | null} report */
export function rootCount(report) {
  return optionalNumber(report?.latest?.root?.completed, report?.counters?.roots?.completed, report?.run?.result?.rootActions) ?? 0
}

/**
 * How long the run has gone on. A finished run uses its own times; a live one runs to `now` when the view is
 * following it, and to the last report write otherwise.
 * @param {FuzzReport | null} report @param {number} [now]
 */
export function elapsedMs(report, now) {
  const reported = optionalNumber(report?.run?.result?.durationMs)
  if (reported !== undefined) return reported
  const startedAt = timestampNumber(report?.run?.startedAt)
  if (startedAt === undefined) return undefined
  const end = timestampNumber(report?.run?.finishedAt) ?? now ?? timestampNumber(report?.updatedAt)
  return end === undefined ? undefined : Math.max(0, end - startedAt)
}

/** "2 randomized users · 1 hedger · 40 cycles · 12 quotes · 3m 2s" @param {FuzzReport | null} report @param {number} [now] */
export function runSummary(report, now) {
  const participants = participantSnapshot(report)
  const quotes = hasQuoteTelemetry(report?.latest?.quotes) ? quoteTotals(report?.latest?.quotes) : undefined
  return [
    participants.userCount || participants.hedgerCount
      ? `${plural(participants.userCount, 'randomized user')} · ${plural(participants.hedgerCount, 'hedger')}`
      : 'Actors unavailable',
    plural(rootCount(report), 'cycle'),
    quotes?.total !== undefined ? plural(quotes.total, 'quote') : 'Quotes unavailable',
    duration(elapsedMs(report, now)),
  ].join(' · ')
}

/** @param {unknown} reason insufficient-balance → insufficient balance */
function reasonLabel(reason) {
  return text(reason, 'unknown').replace(/[-_]+/g, ' ').toLowerCase()
}

/**
 * How many generated inputs became quotes, and the two most common reasons the rest were discarded.
 * @param {FuzzReport | null} report
 */
export function inputYieldSnapshot(report) {
  const roots = object(report?.counters?.roots)
  const sent = optionalNumber(roots.sent)
  const discarded = optionalNumber(roots.discarded)
  if (sent === undefined || discarded === undefined) return undefined
  const total = sent + discarded
  const reasons = Object.entries(object(report?.counters?.discardedReasons))
    .map(([reason, count]) => ({ reason: reasonLabel(reason), count: numeric(count) }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    .slice(0, 2)
  return { sent, discarded, total, ratio: total > 0 ? sent / total : undefined, reasons }
}

// ---- Coverage --------------------------------------------------------------------------------------

/** @param {number} count */
const targets = (count) => `${compactNumber(count)} configured ${count === 1 ? 'target' : 'targets'}`

/**
 * The coverage verdict: a title, a badge, one summary sentence, four cards and the list of gaps.
 * @param {FuzzReport | null} report
 */
export function coverageSnapshot(report) {
  const evidence = targetEvidence(report)
  const { states, actions, corners } = evidence
  const signals = runSignalSnapshot(report)
  const available = states.available && actions.available && corners.available
  const complete = available && states.missing.length === 0 && actions.missing.length === 0 && corners.missing.length === 0
  const terminal = isTerminalRun(report)
  const gapCount = states.missing.length + actions.missing.length + corners.missing.length
  const reached = complete ? 'Every configured run target was reached, but ' : ''
  /** @type {Tone} */
  const tone = signals.hasFailure
    ? 'bad'
    : signals.storageWarning || !available || !signals.evidenceComplete
      ? 'warn'
      : complete
        ? 'good'
        : terminal
          ? 'warn'
          : 'info'
  const summary = signals.hasFailure
    ? `${reached}${signals.failureCategories.join('; ')}. Review these signals before trusting this run.`
    : signals.storageWarning
      ? `${complete ? 'Every configured run target was reached, but dashboard' : 'Dashboard'} persistence reported a storage warning. The protocol run may be clean, but this report needs review.`
      : !available
        ? 'Historical target evidence is unavailable in this report; the current quote snapshot is not treated as proof.'
        : !signals.evidenceComplete
          ? `${complete ? 'Every configured run target was reached, but issue' : 'Issue'} telemetry is incomplete: ${signals.evidenceGaps.join(', ')} unavailable.`
          : complete
            ? 'Every configured target was reached: all quote states, supported action types, and high-risk workflows have evidence. This is not exhaustive protocol coverage.'
            : terminal
              ? `The run ended with ${targets(gapCount)} still unverified.`
              : `Evidence is still building; ${targets(gapCount)} ${gapCount === 1 ? 'remains' : 'remain'}.`
  const title = signals.hasFailure
    ? 'Review needed'
    : signals.storageWarning
      ? 'Storage warning'
      : !available
        ? 'Coverage unavailable'
        : !signals.evidenceComplete
          ? 'Telemetry incomplete'
          : complete
            ? 'Configured targets met'
            : terminal
              ? `${targets(gapCount)} missing`
              : 'Building coverage'
  const label = signals.hasFailure
    ? complete
      ? 'REVIEW'
      : 'ATTENTION'
    : signals.storageWarning
      ? complete
        ? 'WARNING'
        : 'STORAGE WARNING'
      : !available
        ? 'UNAVAILABLE'
        : !signals.evidenceComplete
          ? complete
            ? 'TELEMETRY'
            : 'TELEMETRY GAPS'
          : complete
            ? 'TARGETS MET'
            : terminal
              ? 'GAPS'
              : 'BUILDING'
  const notYet = (/** @type {string} */ verb) => `${terminal ? `Not ${verb} in this run` : `Not ${verb} yet`}`
  /** @type {{ label: string, value: string, detail: string, tone: Tone }[]} */
  const cards = [
    {
      label: 'Quote states',
      value: states.available ? `${states.targets.length - states.missing.length}/${states.targets.length}` : '—',
      detail: !states.available
        ? 'Historical target evidence unavailable'
        : states.missing.length
          ? `${notYet('observed')}: ${states.missing.map((item) => item.label).join(', ')}`
          : 'All configured quote states reached',
      tone: states.available && !states.missing.length ? 'good' : 'warn',
    },
    {
      label: 'Actions checked',
      value: actions.available ? `${actions.targets.length - actions.missing.length}/${actions.targets.length}` : '—',
      detail: !actions.available
        ? 'Confirmed action-type data unavailable'
        : actions.missing.length
          ? `${notYet('confirmed')}: ${actions.missing.map(humanize).join(', ')}`
          : 'Every supported action type independently checked',
      tone: actions.available && !actions.missing.length ? 'good' : 'warn',
    },
    {
      label: 'High-risk checks',
      value: corners.available ? `${corners.targets.length - corners.missing.length}/${corners.targets.length}` : '—',
      detail: !corners.available
        ? 'High-risk workflow data unavailable'
        : corners.missing.length
          ? `${notYet('verified')}: ${corners.missing.map((item) => item.label).join(', ')}`
          : 'Every configured workflow passed',
      tone: corners.available && !corners.missing.length ? 'good' : 'warn',
    },
    {
      label: 'Problems',
      value: signals.hasFailure ? 'FOUND' : signals.storageWarning ? 'WARNING' : signals.evidenceComplete ? '0' : '—',
      detail:
        signals.categories.length > 0
          ? `${signals.categories.slice(0, 2).join(' · ')}${signals.categories.length > 2 ? ` · +${signals.categories.length - 2} more` : ''}`
          : signals.evidenceComplete
            ? 'No failures, timeouts, or storage warnings'
            : `Unavailable: ${signals.evidenceGaps.join(', ')}`,
      tone: signals.hasFailure ? 'bad' : signals.storageWarning || !signals.evidenceComplete ? 'warn' : 'good',
    },
  ]
  /** @type {{ label: string, tone: Tone }[]} */
  const gaps = [
    ...(!states.available ? [{ label: 'Lifecycle coverage data unavailable', tone: /** @type {Tone} */ ('warn') }] : []),
    ...(!actions.available ? [{ label: 'Independent state-check data unavailable', tone: /** @type {Tone} */ ('warn') }] : []),
    ...(!corners.available ? [{ label: 'High-risk workflow data unavailable', tone: /** @type {Tone} */ ('warn') }] : []),
    ...states.missing.map((item) => ({ label: `State not observed · ${item.label}`, tone: /** @type {Tone} */ ('warn') })),
    ...actions.missing.map((action) => ({ label: `Action type not checked · ${humanize(action)}`, tone: /** @type {Tone} */ ('warn') })),
    ...corners.missing.map((item) => ({ label: `Workflow not verified · ${item.label}`, tone: /** @type {Tone} */ ('warn') })),
    ...signals.failureCategories.map((item) => ({ label: item, tone: /** @type {Tone} */ ('bad') })),
    ...(signals.storageWarning ? [{ label: `Storage · ${signals.storageWarning}`, tone: /** @type {Tone} */ ('warn') }] : []),
    ...(!signals.evidenceComplete
      ? [{ label: `Run-signal telemetry unavailable · ${signals.evidenceGaps.join(', ')}`, tone: /** @type {Tone} */ ('warn') }]
      : []),
    ...(complete && signals.count === 0 && signals.evidenceComplete
      ? [{ label: 'All configured run targets reached', tone: /** @type {Tone} */ ('good') }]
      : []),
  ]
  return { tone, title, label, summary, cards, gaps, evidence }
}

// ---- Timelines -------------------------------------------------------------------------------------

/** @param {FuzzReport | null} report @returns {Json[]} */
function timelinePoints(report) {
  return Array.isArray(report?.timeline) ? report.timeline.map(object) : []
}

/** @param {Json} point @param {number} index */
function pointLabel(point, index) {
  const root = optionalNumber(point.root)
  return root === undefined ? `#${index + 1}` : `cycle ${compactNumber(root)}`
}

/** @param {number[]} values @param {number} quantile */
export function percentile(values, quantile) {
  if (values.length === 0) return undefined
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(quantile * ordered.length) - 1))]
}

/**
 * Live and ended quotes at each retained checkpoint, or the current snapshot alone when there is no timeline.
 * @param {FuzzReport | null} report @returns {{ label: string, live: number, ended: number }[]}
 */
export function quoteTimeline(report) {
  const points = timelinePoints(report).flatMap((point, index) => {
    const totals = quoteTotals(point.quotes)
    return hasQuoteTelemetry(point.quotes) && totals.active !== undefined && totals.terminal !== undefined
      ? [{ label: pointLabel(point, index), live: totals.active, ended: totals.terminal }]
      : []
  })
  if (points.length > 0) return points
  const totals = quoteTotals(report?.latest?.quotes)
  if (!hasQuoteTelemetry(report?.latest?.quotes) || totals.active === undefined || totals.terminal === undefined) return []
  return [{ label: `cycle ${compactNumber(rootCount(report))}`, live: totals.active, ended: totals.terminal }]
}

/**
 * Cycles per second over the last 16 checkpoints, and the reporter's rolling whole-cycle p50 and p95. Where a
 * checkpoint carries no rolling window, the percentiles are approximated from retained cycle durations.
 * @param {FuzzReport | null} report
 */
export function paceTimeline(report) {
  /** @type {{ label: string, rate?: number, p50?: number, p95?: number, durationMs?: number, elapsedMs?: number, completed?: number, exact: boolean }[]} */
  const points = timelinePoints(report).map((point, index) => {
    const pace = object(point.pace)
    return {
      label: pointLabel(point, index),
      p50: optionalNumber(pace.rootP50Ms),
      p95: optionalNumber(pace.rootP95Ms),
      durationMs: optionalNumber(point.durationMs),
      elapsedMs: optionalNumber(point.elapsedMs),
      completed: optionalNumber(point.roots?.completed, point.root),
      exact: ['rootP50Ms', 'rootP95Ms', 'window'].some((field) => pace[field] !== undefined),
    }
  })
  points.forEach((point, index) => {
    const previous = points[Math.max(0, index - 16)]
    if (point.completed !== undefined && point.elapsedMs !== undefined) {
      if (previous.completed !== undefined && previous.elapsedMs !== undefined && point.elapsedMs > previous.elapsedMs) {
        point.rate = ((point.completed - previous.completed) * 1_000) / (point.elapsedMs - previous.elapsedMs)
      } else if (point.elapsedMs > 0) {
        point.rate = (point.completed * 1_000) / point.elapsedMs
      }
    }
    const durations = /** @type {number[]} */ (
      points
        .slice(Math.max(0, index - 63), index + 1)
        .map((candidate) => candidate.durationMs)
        .filter((value) => value !== undefined)
    )
    point.p50 ??= percentile(durations, 0.5)
    point.p95 ??= percentile(durations, 0.95)
  })
  if (points.some((point) => point.rate !== undefined || point.p50 !== undefined || point.p95 !== undefined)) return points
  const pace = object(report?.latest?.pace)
  const elapsed = elapsedMs(report)
  const p50 = optionalNumber(pace.rootP50Ms)
  const p95 = optionalNumber(pace.rootP95Ms)
  const rateNow = elapsed ? (rootCount(report) * 1_000) / elapsed : undefined
  if (p50 === undefined && p95 === undefined && rateNow === undefined) return []
  return [{ label: `cycle ${compactNumber(rootCount(report))}`, rate: rateNow, p50, p95, exact: p50 !== undefined || p95 !== undefined }]
}

/**
 * Queue pressure at each checkpoint: the interval maxima where the report kept them, else the settled snapshot.
 * @param {FuzzReport | null} report
 */
export function queueTimeline(report) {
  const points = timelinePoints(report).flatMap((point, index) => {
    const peak = hasQueueTelemetry(point.queuePeak)
    const source = peak ? point.queuePeak : hasQueueTelemetry(point.queue) ? point.queue : undefined
    if (!source) return []
    const totals = queueTotals(source)
    return [
      {
        label: pointLabel(point, index),
        outstanding: totals.outstanding,
        pending: totals.pending,
        scheduled: totals.scheduled,
        running: totals.running,
        peak,
      },
    ]
  })
  if (points.length > 0) return points
  if (!hasQueueTelemetry(report?.latest?.queue)) return []
  const totals = queueTotals(report?.latest?.queue)
  return [
    {
      label: `cycle ${compactNumber(rootCount(report))}`,
      outstanding: totals.outstanding,
      pending: totals.pending,
      scheduled: totals.scheduled,
      running: totals.running,
      peak: false,
    },
  ]
}
