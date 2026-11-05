import { Fuzz } from '../src/fuzz/Fuzz'
import { MantineProvider } from '@mantine/core'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../src/api', () => ({ useWorkbench: () => ({ token: 'a'.repeat(64) }) }))
const archived = '2026-07-28T14-48-05.123Z-e971dfb5.json'
let report: Record<string, any>
let runs: unknown[]
let etag: string | null
const reportCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/fuzz/report')
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const sent = (init?.headers as Record<string, string>)['If-None-Match']
  if (url === '/api/fuzz/report' && etag && sent === etag) return { ok: false, status: 304, headers: new Headers() } as Response
  const body = url === '/api/fuzz/runs' ? { runs } : structuredClone(report)
  const headers = new Headers(url === '/api/fuzz/report' && etag ? { ETag: etag } : {})
  return { ok: true, status: 200, headers, json: async () => body } as Response
})

// The shape test/utils/FuzzDashboardReporter.ts writes.
function runReport(status: string, extra: Record<string, any> = {}) {
  return {
    schemaVersion: 1,
    kind: 'symmio-fuzz-dashboard',
    updatedAt: '2026-10-14T10:05:00.000Z',
    run: {
      status,
      seed: 'seed-1',
      config: { seed: 'seed-1', runMode: 'bounded', userCount: 1, hedgerCount: 1 },
      startedAt: '2026-10-14T10:00:00.000Z',
      ...(status === 'running' ? {} : { finishedAt: '2026-10-14T10:05:00.000Z', replay: 'FUZZ_SEED=seed-1 npm run test:fuzz' }),
      ...extra,
    },
    latest: {
      root: { completed: 12, sent: 9, discarded: 3 },
      queue: { accepted: 4, completed: 4, scheduled: 0, pending: 0, running: false, paused: false, stopped: false, failures: 0 },
      actions: { successful: 4, failed: 0, timedOut: 0 },
      assurance: { confirmedActionTypes: ['SEND_QUOTE'], observedQuoteStatuses: ['PENDING'] },
      quotes: { total: 9, active: 1, terminal: 8, byStatus: { PENDING: 1, CLOSED: 8 } },
      corners: {
        totals: { attempted: 0, succeeded: 0, skipped: 0, failed: 0 },
        byOperation: { FUNDING_CHARGE: { attempted: 0, succeeded: 0, skipped: 0, failed: 0 } },
      },
    },
    counters: { roots: { completed: 12, sent: 9, discarded: 3 }, discardedReasons: { 'insufficient-balance': 2, 'pending-quote-limit': 1 } },
    milestones: { quoteStates: { PENDING: { root: 2, elapsedMs: 40, quoteId: '3' } }, corners: {} },
    timeline: [],
    activity: [],
    retention: {},
  }
}
const failure = {
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
}

beforeEach(() => {
  report = { status: 'waiting' }
  runs = [archived]
  etag = null
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  // jsdom has no canvas; the charts only need calls that do not throw.
  const context = new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }), set: () => true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
})
const mount = () => {
  const page = render(
    <MantineProvider env="test">
      <Fuzz />
    </MantineProvider>,
  )
  return { page, root: page.container.querySelector('.fuzz-view')!.shadowRoot! }
}
const visibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

it('reads the fuzz report with the session token and keeps its markup inside its own shadow root', async () => {
  const { root } = mount()
  await waitFor(() => expect(root.getElementById('run-select')!.querySelectorAll('option')).toHaveLength(2))
  const calls = fetchMock.mock.calls.map(([url, init]) => [String(url), (init!.headers as Record<string, string>).Authorization])
  expect(calls).toContainEqual(['/api/fuzz/report', `Bearer ${'a'.repeat(64)}`])
  expect(calls).toContainEqual(['/api/fuzz/runs', `Bearer ${'a'.repeat(64)}`])
  expect(root.getElementById('waiting-state')!.hidden).toBe(false)
  expect(root.getElementById('dashboard')!.hidden).toBe(true)
  // Nothing of the report leaks into the app's own document, so neither side's CSS or ids can collide.
  expect(document.getElementById('dashboard')).toBeNull()
  expect(document.querySelector('.control-bar')).toBeNull()
})

it('says why Export JSON is unavailable and copies the start command from the empty state', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  const { root } = mount()
  await waitFor(() => expect(root.getElementById('waiting-state')!.hidden).toBe(false))
  const exportButton = root.getElementById('export-report') as HTMLButtonElement
  expect(exportButton.disabled).toBe(true)
  expect(root.getElementById('export-hint')!.hidden).toBe(false)
  expect(root.getElementById(exportButton.getAttribute('aria-describedby')!)!.textContent).toBe('No report to export yet')
  const copy = root.getElementById('copy-start-command') as HTMLButtonElement
  copy.click()
  await waitFor(() => expect(copy.textContent).toBe('Copied'))
  expect(writeText).toHaveBeenCalledWith('npm run test:fuzz:dashboard')
})

it('renders a finished run and loads an archived one from the fuzz archive route', async () => {
  report = runReport('passed')
  const { root } = mount()
  await waitFor(() => expect(root.getElementById('dashboard')!.hidden).toBe(false))
  expect(root.getElementById('waiting-state')!.hidden).toBe(true)
  expect(root.getElementById('seed-value')!.textContent).toBe('seed-1')
  expect(root.getElementById('export-hint')!.hidden).toBe(true)
  const select = root.getElementById('run-select') as HTMLSelectElement
  await waitFor(() => expect(select.options).toHaveLength(2))
  select.value = archived
  select.dispatchEvent(new Event('change'))
  await waitFor(() => expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(`/api/fuzz/runs/${encodeURIComponent(archived)}`))
})

it('puts what failed, where, and the replay directly under the hero of a failed run', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  report = runReport('failed', { failures: [failure] })
  const { root } = mount()
  await waitFor(() => expect(root.getElementById('problems')!.hidden).toBe(false))
  // The callout follows the hero, ahead of the numbers and the cycle explainer.
  expect(root.querySelector('.run-hero')!.nextElementSibling!.id).toBe('problems')
  const problem = root.querySelector('#problems-list .problem')!
  expect(problem.querySelector('.problem__boundary')!.textContent).toBe('Execution')
  expect(problem.querySelector('.problem__message')!.textContent).toBe('Fuzz action "LockQuote" failed: reverted')
  expect(problem.querySelector('.problem__where')!.textContent).toBe('During cycle 12 · action #345 · Root:12:user#1->hedger#1:LockQuote')
  const trace = problem.querySelector('details')!
  expect(trace.querySelector('summary')!.textContent).toBe('Stack and cause')
  expect([...trace.querySelectorAll('pre')].map((node) => node.textContent)).toEqual([failure.error.stack, failure.error.cause.stack])
  expect(root.getElementById('problems-seed')!.textContent).toBe('seed-1')
  expect(root.getElementById('run-title')!.textContent).toBe('Needs attention')
  const copy = root.getElementById('problems-copy') as HTMLButtonElement
  expect(copy.disabled).toBe(false)
  copy.click()
  await waitFor(() => expect(copy.textContent).toBe('Copied'))
  expect(writeText).toHaveBeenCalledWith('FUZZ_SEED=seed-1 npm run test:fuzz')
})

it('keeps the problems hidden on a clean run and shows each number with its explanation', async () => {
  report = runReport('passed')
  const { root } = mount()
  await waitFor(() => expect(root.getElementById('dashboard')!.hidden).toBe(false))
  expect(root.getElementById('problems')!.hidden).toBe(true)
  const kpis = [...root.querySelectorAll('.kpi')].map((node) => [
    node.querySelector('.kpi__label')!.textContent,
    node.querySelector('.kpi__value')!.textContent,
    node.querySelector('.kpi__detail')!.textContent,
  ])
  expect(kpis[1]).toEqual(['Input yield', '75%', '9 sent · 3 discarded · mostly insufficient balance (2), pending quote limit (1)'])
  expect(root.querySelector('[data-status="PENDING"] .lifecycle-row__first')!.textContent).toBe('first at cycle 3 · quote #3')
  // The validator panel keeps its action-type chips and no longer carries an always-empty table.
  expect(root.querySelector('.panel--assurance table')).toBeNull()
  expect(root.querySelectorAll('.action-type-chip')).toHaveLength(10)
  // The cycle explainer is collapsed until someone opens it.
  expect((root.getElementById('story') as HTMLDetailsElement).open).toBe(false)
})

it('shows a plain notice when the report is newer than the view', async () => {
  report = { ...runReport('passed'), schemaVersion: 2 }
  const { root } = mount()
  await waitFor(() => expect(root.getElementById('schema-notice')!.hidden).toBe(false))
  expect(root.getElementById('schema-notice')!.textContent).toMatch(/format 2/)
})

it('labels archived runs with their outcome, failures, cycles and seed', async () => {
  runs = [
    { name: 'b.json', status: 'failed', seed: 'seed-b', startedAt: '2026-10-14T10:00:00.000Z', cycles: 40, failures: 1 },
    { name: 'a.json', status: 'passed', seed: 'seed-a', startedAt: '2026-10-13T10:00:00.000Z', cycles: 12 },
    archived,
  ]
  const { root } = mount()
  const select = root.getElementById('run-select') as HTMLSelectElement
  await waitFor(() => expect(select.options).toHaveLength(4))
  expect(select.options[1].value).toBe('b.json')
  expect(select.options[1].text).toMatch(/^× .+ · Failed, 1 failure · 40 cycles · seed seed-b$/)
  expect(select.options[2].text).toMatch(/^[^×].+ · Passed · 12 cycles · seed seed-a$/)
  expect(select.options[3].text).toMatch(/ · e971dfb5 · archived$/)
})

it('leaves an unchanged report alone, so a selection or an open stack survives the next poll', async () => {
  vi.useFakeTimers()
  try {
    report = runReport('running', { failures: [failure] })
    const { root } = mount()
    await vi.advanceTimersByTimeAsync(100)
    const problem = root.querySelector('#problems-list .problem')!
    const kpi = root.querySelector('.kpi')!
    problem.querySelector('details')!.open = true
    await vi.advanceTimersByTimeAsync(6_000)
    expect(reportCalls().length).toBeGreaterThan(2)
    expect(root.querySelector('#problems-list .problem')).toBe(problem)
    expect(root.querySelector('.kpi')).toBe(kpi)
    expect(problem.querySelector('details')!.open).toBe(true)
    // A new write is drawn.
    report = { ...report, updatedAt: '2026-10-14T10:06:00.000Z' }
    await vi.advanceTimersByTimeAsync(2_000)
    expect(root.querySelector('.kpi')).not.toBe(kpi)
  } finally {
    vi.useRealTimers()
  }
})

it('treats a 304 as unchanged and keeps the report on screen', async () => {
  vi.useFakeTimers()
  try {
    report = runReport('running')
    etag = '"1-a"'
    const { root } = mount()
    await vi.advanceTimersByTimeAsync(100)
    const kpi = root.querySelector('.kpi')!
    await vi.advanceTimersByTimeAsync(4_000)
    const conditional = reportCalls().map(([, init]) => (init!.headers as Record<string, string>)['If-None-Match'])
    expect(conditional[0]).toBeUndefined()
    expect(conditional.slice(1)).toEqual(conditional.slice(1).map(() => '"1-a"'))
    expect(root.getElementById('dashboard')!.hidden).toBe(false)
    expect(root.querySelector('.kpi')).toBe(kpi)
  } finally {
    vi.useRealTimers()
  }
})

it('polls a running report every two seconds, stops once it is final, and pauses while the tab is hidden', async () => {
  vi.useFakeTimers()
  try {
    report = runReport('running')
    const { root } = mount()
    await vi.advanceTimersByTimeAsync(100)
    const start = reportCalls().length
    await vi.advanceTimersByTimeAsync(4_000)
    expect(reportCalls().length - start).toBe(2)

    visibility('hidden')
    const hidden = reportCalls().length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reportCalls().length).toBe(hidden)
    visibility('visible')
    await vi.advanceTimersByTimeAsync(10)
    expect(reportCalls().length).toBe(hidden + 1)

    report = runReport('passed')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(root.getElementById('connection-label')!.textContent).toBe('Final report')
    const final = reportCalls().length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reportCalls().length).toBe(final)
    // It still looks in now and then, in case a new run starts.
    await vi.advanceTimersByTimeAsync(4_000)
    expect(reportCalls().length).toBe(final + 1)
  } finally {
    visibility('visible')
    vi.useRealTimers()
  }
})

it('stops polling when the view is left', async () => {
  vi.useFakeTimers()
  try {
    const { page } = mount()
    await vi.advanceTimersByTimeAsync(4_500)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2)
    act(() => page.unmount())
    const before = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchMock.mock.calls.length).toBe(before)
  } finally {
    vi.useRealTimers()
  }
})
