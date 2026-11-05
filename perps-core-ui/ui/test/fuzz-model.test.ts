import {
  ACTION_TYPES,
  coverageSnapshot,
  cornerTargets,
  elapsedMs,
  failureRecords,
  firstReached,
  firstReachedCopy,
  inputYieldSnapshot,
  isReport,
  paceTimeline,
  percent,
  queueTimeline,
  quoteStateTargets,
  quoteTimeline,
  reportKey,
  runHeadline,
  runOutcomeSnapshot,
  runSignalSnapshot,
  runSummary,
  schemaNotice,
  targetEvidence,
  type FuzzReport,
} from '../src/fuzz/model.js'
import { describe, expect, it } from 'vitest'

// The shape test/utils/FuzzDashboardReporter.ts writes, for a bounded run that reached every target.
const STATES = [
  'PENDING',
  'LOCKED',
  'CANCEL_PENDING',
  'CANCELED',
  'OPENED',
  'CLOSE_PENDING',
  'CANCEL_CLOSE_PENDING',
  'CLOSED',
  'LIQUIDATED',
  'EXPIRED',
  'LIQUIDATED_PENDING',
]
const CORNERS = cornerTargets(null).map((target) => target.key)
const counts = (keys: string[], value: number) => Object.fromEntries(keys.map((key) => [key, value]))
const queue = { accepted: 100, completed: 100, scheduled: 0, pending: 0, running: false, paused: false, stopped: true, failures: 0 }

function cleanReport(): FuzzReport {
  return {
    schemaVersion: 1,
    kind: 'symmio-fuzz-dashboard',
    updatedAt: '2026-10-14T10:05:00.000Z',
    run: {
      status: 'passed',
      seed: 'seed-1',
      config: { seed: 'seed-1', runMode: 'bounded', userCount: 2, hedgerCount: 1, validationProbability: 0.25, blockedQuoteProbability: 0 },
      startedAt: '2026-10-14T10:00:00.000Z',
      finishedAt: '2026-10-14T10:05:00.000Z',
      setup: { users: [{ id: 'user#1' }, { id: 'user#2' }], hedgers: [{ id: 'hedger#1' }], durationMs: 5 },
      replay: 'FUZZ_SEED=seed-1 npm run test:fuzz',
      traceHash: '0xabc',
    },
    latest: {
      root: { completed: 40, sent: 30, discarded: 10 },
      queue,
      pace: { rootP50Ms: 120, rootP95Ms: 400, window: 40 },
      actions: { successful: 90, failed: 0, timedOut: 0 },
      assurance: {
        confirmedActionTypes: [...ACTION_TYPES],
        observedQuoteStatuses: [...STATES],
        observableSuccessfulTransitions: 8,
        confirmedValidatorTransitions: 2,
      },
      quotes: { total: 7, active: 2, terminal: 5, byStatus: { ...counts(STATES, 0), OPENED: 2, CLOSED: 5 } },
      corners: { totals: { attempted: CORNERS.length, succeeded: CORNERS.length, skipped: 0, failed: 0 }, byOperation: counts(CORNERS, 0) },
    },
    counters: {
      roots: { completed: 40, sent: 30, discarded: 10 },
      discardedReasons: { 'insufficient-balance': 7, 'invalid-generated-quote': 1, 'pending-quote-limit': 2 },
    },
    milestones: {
      quoteStates: {
        ...counts(STATES, 0),
        PENDING: { root: 0, elapsedMs: 10, quoteId: '1' },
        CLOSED: { root: 3, elapsedMs: 900, quoteId: '4', actionSequence: 12 },
      },
      corners: { FUNDING_CHARGE: { root: 5, elapsedMs: 1_000, quoteIds: ['7', '8'], detail: 'charged PartyB' } },
    },
    targets: { quoteStates: [...STATES], cornerOperations: [...CORNERS] },
    timeline: [
      {
        root: 1,
        elapsedMs: 1_000,
        durationMs: 100,
        queue,
        queuePeak: { outstanding: 4, pending: 1, scheduled: 2, running: true },
        pace: { rootP50Ms: 100, rootP95Ms: 100, window: 1 },
        roots: { completed: 1 },
        quotes: { active: 1, terminal: 0 },
      },
      {
        root: 40,
        elapsedMs: 21_000,
        durationMs: 130,
        queue,
        queuePeak: { outstanding: 0, pending: 0, scheduled: 0, running: false },
        pace: { rootP50Ms: 120, rootP95Ms: 400, window: 40 },
        roots: { completed: 40 },
        quotes: { active: 2, terminal: 5 },
      },
    ],
    activity: [],
    retention: { maxBytes: 1_048_576, droppedActivity: 0 },
  }
}
// Every corner passed once.
function withCorners(report: FuzzReport) {
  for (const key of CORNERS) report.latest!.corners.byOperation[key] = { attempted: 1, succeeded: 1, skipped: 0, failed: 0 }
  return report
}

describe('the run verdict', () => {
  it('calls a passed run with every target reached and no problems clean', () => {
    const report = withCorners(cleanReport())
    expect(runOutcomeSnapshot(report)).toMatchObject({ label: 'Completed cleanly', tone: 'good', clean: true })
    expect(runHeadline(report)).toBe('Completed cleanly')
    expect(coverageSnapshot(report)).toMatchObject({ title: 'Configured targets met', label: 'TARGETS MET', tone: 'good' })
    expect(runSignalSnapshot(report)).toMatchObject({ hasFailure: false, evidenceComplete: true, categories: [] })
  })

  it('says a failed run needs attention and reads where each failure happened', () => {
    const report = withCorners(cleanReport())
    report.run!.status = 'failed'
    report.run!.failures = [
      {
        boundary: 'execution',
        root: 11,
        error: {
          name: 'FuzzActionError',
          message: 'Fuzz action "LockQuote" failed: reverted',
          actionSequence: 345,
          actionTitle: 'Root:12:user#1->hedger#1:LockQuote',
          stack: 'FuzzActionError: Fuzz action "LockQuote" failed\n    at run',
          cause: { name: 'Error', message: 'reverted', stack: 'Error: reverted\n    at lock' },
        },
      },
    ]
    expect(runOutcomeSnapshot(report)).toMatchObject({ label: 'Needs attention', tone: 'bad' })
    expect(runHeadline(report)).toBe('Needs attention')
    expect(failureRecords(report)).toEqual([
      {
        boundary: 'execution',
        message: 'Fuzz action "LockQuote" failed: reverted',
        cycle: 12,
        actionSequence: 345,
        actionTitle: 'Root:12:user#1->hedger#1:LockQuote',
        stack: 'FuzzActionError: Fuzz action "LockQuote" failed\n    at run',
        cause: 'Error: reverted\n    at lock',
      },
    ])
    expect(coverageSnapshot(report)).toMatchObject({ title: 'Review needed', label: 'REVIEW', tone: 'bad' })
    expect(coverageSnapshot(report).summary).toContain('1 boundary record')
  })

  it('counts live failure signals before the run has written its failure records', () => {
    const report = cleanReport()
    report.run!.status = 'running'
    report.latest!.actions = { successful: 3, failed: 2, timedOut: 1 }
    expect(runSignalSnapshot(report).failureCategories).toEqual(['2 failed actions', '1 timed-out action'])
    expect(failureRecords(report)).toEqual([])
    expect(runOutcomeSnapshot(report).label).toBe('Needs attention')
  })

  it('separates a storage warning from failures, and missing telemetry from a clean result', () => {
    const report = withCorners(cleanReport())
    report.retention!.lastWriteError = 'report: ENOSPC'
    expect(runSignalSnapshot(report)).toMatchObject({ hasFailure: false, storageWarning: 'report: ENOSPC' })
    expect(coverageSnapshot(report)).toMatchObject({ title: 'Storage warning', tone: 'warn' })

    const partial = withCorners(cleanReport())
    delete partial.latest!.queue
    expect(runSignalSnapshot(partial)).toMatchObject({ evidenceComplete: false, evidenceGaps: ['queue failures'] })
    expect(runOutcomeSnapshot(partial).clean).toBe(false)
    expect(coverageSnapshot(partial).title).toBe('Telemetry incomplete')
  })

  it('says a stopped run stopped cleanly only when its queue drained', () => {
    const report = withCorners(cleanReport())
    report.run!.status = 'stopped'
    expect(runOutcomeSnapshot(report).label).toBe('Stopped cleanly')
    report.latest!.queue = { ...queue, completed: 97 }
    expect(runOutcomeSnapshot(report).label).toBe('Stopped')
  })

  it('labels a snapshot that is no longer fresh instead of claiming the run is going', () => {
    const report = cleanReport()
    report.run!.status = 'running'
    expect(runHeadline(report)).toBe('Simulation running')
    expect(runHeadline(report, 'stale')).toBe('Last reported snapshot')
    expect(runHeadline(report, 'error')).toBe('Last report unavailable')
  })
})

describe('targets', () => {
  it('takes the targets from the report, so a new workflow counts as missing until it passes', () => {
    const report = withCorners(cleanReport())
    report.targets!.cornerOperations = [...CORNERS, 'NEW_WORKFLOW']
    const evidence = targetEvidence(report)
    expect(evidence.corners.missing).toEqual([{ key: 'NEW_WORKFLOW', label: 'NEW WORKFLOW' }])
    expect(coverageSnapshot(report).cards[2]).toMatchObject({ value: `${CORNERS.length}/${CORNERS.length + 1}`, tone: 'warn' })
    expect(coverageSnapshot(report).title).toBe('1 configured target missing')
  })

  it("falls back to the runner's lists for a report written before it carried them", () => {
    const report = withCorners(cleanReport())
    delete report.targets
    expect(quoteStateTargets(report)).toHaveLength(11)
    expect(cornerTargets(report)).toHaveLength(19)
    expect(coverageSnapshot(report).title).toBe('Configured targets met')
  })

  it('places a quote state the view has no label for under other states', () => {
    const report = cleanReport()
    report.targets!.quoteStates = [...STATES, 'SUSPENDED']
    expect(quoteStateTargets(report).at(-1)).toEqual({ key: 'SUSPENDED', label: 'SUSPENDED', group: 'other' })
    expect(targetEvidence(report).states.missing.map((item) => item.key)).toEqual(['SUSPENDED'])
  })

  it('says when each target was first reached, during the cycle after the ones already completed', () => {
    const report = cleanReport()
    expect(firstReached(report, 'quoteStates', 'CLOSED')).toEqual({ cycle: 4, quoteId: '4', actionSequence: 12, detail: '' })
    expect(firstReachedCopy(firstReached(report, 'quoteStates', 'CLOSED'))).toBe('first at cycle 4 · quote #4')
    expect(firstReachedCopy(firstReached(report, 'corners', 'FUNDING_CHARGE'))).toBe('first at cycle 6 · quote #7')
    expect(firstReached(report, 'quoteStates', 'LOCKED')).toBeUndefined()
    expect(firstReachedCopy(undefined)).toBe('')
  })
})

describe('report identity', () => {
  it('flags a report in a newer format than the view reads', () => {
    expect(schemaNotice(cleanReport())).toBe('')
    expect(schemaNotice({ ...cleanReport(), schemaVersion: 2 })).toMatch(/format 2, and this view reads format 1/)
  })

  it('changes its key when the runner writes something new', () => {
    const report = cleanReport()
    const key = reportKey(report)
    expect(reportKey({ ...report })).toBe(key)
    expect(reportKey({ ...report, updatedAt: '2026-10-14T10:06:00.000Z' })).not.toBe(key)
    expect(reportKey({ ...report, run: { ...report.run, status: 'failed' } })).not.toBe(key)
  })

  it("tells a report from the server's waiting answer", () => {
    expect(isReport({ status: 'waiting' })).toBe(false)
    expect(isReport(cleanReport())).toBe(true)
  })
})

describe('yield, time and timelines', () => {
  it('reports the share of inputs that became quotes and the two most common discard reasons', () => {
    expect(inputYieldSnapshot(cleanReport())).toEqual({
      sent: 30,
      discarded: 10,
      total: 40,
      ratio: 0.75,
      reasons: [
        { reason: 'insufficient balance', count: 7 },
        { reason: 'pending quote limit', count: 2 },
      ],
    })
    expect(inputYieldSnapshot({ ...cleanReport(), counters: {} })).toBeUndefined()
    expect(percent(0.75)).toBe('75%')
    expect(percent(0.0625)).toBe('6.3%')
  })

  it('measures a finished run by its own times and a live one up to now', () => {
    const report = cleanReport()
    expect(elapsedMs(report)).toBe(300_000)
    delete report.run!.finishedAt
    report.run!.status = 'running'
    expect(elapsedMs(report)).toBe(300_000)
    expect(elapsedMs(report, Date.parse('2026-10-14T10:10:00.000Z'))).toBe(600_000)
    expect(runSummary(report, Date.parse('2026-10-14T10:01:00.000Z'))).toBe('2 randomized users · 1 hedger · 40 cycles · 7 quotes · 1m 0s')
  })

  it('reads quote stock, pace and queue pressure from the retained checkpoints', () => {
    const report = cleanReport()
    expect(quoteTimeline(report)).toEqual([
      { label: 'cycle 1', live: 1, ended: 0 },
      { label: 'cycle 40', live: 2, ended: 5 },
    ])
    const pace = paceTimeline(report)
    expect(pace.map((point) => [point.p50, point.p95, point.exact])).toEqual([
      [100, 100, true],
      [120, 400, true],
    ])
    expect(pace[1].rate).toBeCloseTo((39 * 1_000) / 20_000)
    expect(queueTimeline(report)[0]).toMatchObject({ outstanding: 4, pending: 1, scheduled: 2, running: 1, peak: true })
  })

  it('falls back to the current snapshot when there is no timeline', () => {
    const report = cleanReport()
    report.timeline = []
    expect(quoteTimeline(report)).toEqual([{ label: 'cycle 40', live: 2, ended: 5 }])
    expect(queueTimeline(report)).toEqual([{ label: 'cycle 40', outstanding: 0, pending: 0, scheduled: 0, running: 0, peak: false }])
    expect(paceTimeline(report)).toEqual([{ label: 'cycle 40', rate: 40_000 / 300_000, p50: 120, p95: 400, exact: true }])
  })
})
