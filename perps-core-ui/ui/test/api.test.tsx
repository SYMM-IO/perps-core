import { ErrorBanner, StatusRow } from '../src/App'
import { ApiError, useWorkbench, WorkbenchProvider, type Request } from '../src/api'
import type { EngineStatus, Job } from '../src/types'
import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// App.tsx brings in every view; these tests only need its banner and status row.
vi.mock('../src/components/Workspace', () => ({ Workspace: () => null }))
vi.mock('../src/components/Upgrade', () => ({ Upgrade: () => null }))
vi.mock('../src/components/Signing', () => ({ WalletRequest: () => null, connectWallet: vi.fn() }))

type Handler = (init: RequestInit & { headers: Record<string, string> }) => Response | Promise<Response>
let routes: Record<string, Handler>, calls: { route: string; init: RequestInit & { headers: Record<string, string> } }[]
const realFetch = globalThis.fetch
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const engineStatus = (extra: Partial<EngineStatus> = {}): EngineStatus => ({
  revision: 1,
  connected: false,
  busy: false,
  activity: 'Connect to a deployment to begin',
  prompts: [],
  history: [],
  jobs: [],
  progress: null,
  errorInfo: null,
  ...extra,
})
const systemStatus = {
  revision: 1,
  connected: false,
  busy: false,
  activity: 'Idle',
  history: [],
  profile: { id: 'p', name: 'P', chainId: 1, nodes: [] },
  comparison: {},
  delta: [],
}

beforeEach(() => {
  sessionStorage.setItem('workbench-token', 'a'.repeat(64))
  calls = []
  routes = {
    'GET status': () => json(engineStatus()),
    'GET system/status': () => json(systemStatus),
    'GET profiles': () => json({ profiles: [] }),
  }
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init: any = {}) => {
    const route = String(url)
        .replace(/^\/api\//, '')
        .split('?')[0],
      key = `${init.method || 'GET'} ${route}`
    calls.push({ route: key, init })
    const handler = routes[key]
    if (!handler) return json({ error: `No handler for ${key}` }, 404)
    return handler(init)
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

let api: ReturnType<typeof useWorkbench>
function Probe() {
  api = useWorkbench()
  return (
    <>
      <p>{api.engine?.activity ?? 'no status'}</p>
      <ErrorBanner errors={api.errors} onDismiss={() => void api.dismiss()} />
      <StatusRow reserve />
    </>
  )
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MantineProvider env="test">
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WorkbenchProvider>
            <Probe />
          </WorkbenchProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  )
  return client
}

it('sends the last ETag and keeps the data it has when the server answers 304', async () => {
  routes['GET status'] = (init) =>
    init.headers['If-None-Match'] === '"1.0"'
      ? new Response(null, { status: 304 })
      : json(engineStatus({ activity: 'Build ready' }), 200, { ETag: '"1.0"' })
  const client = mount()
  await screen.findByText('Build ready')
  await act(() => client.refetchQueries({ queryKey: ['engine'] }))
  const statusCalls = calls.filter((c) => c.route === 'GET status')
  expect(statusCalls.length).toBeGreaterThan(1)
  expect(statusCalls.at(-1)!.init.headers['If-None-Match']).toBe('"1.0"')
  expect(screen.getByText('Build ready')).toBeTruthy()
})

it('reads the address book from /api/profiles into the workspace status', async () => {
  routes['GET profiles'] = () => json({ profiles: [{ id: 'vibe', name: 'Vibe', chainId: 42161, chainName: 'arbitrum', nodes: [] }] })
  mount()
  await waitFor(() => expect(api.system?.profiles.map((p) => p.id)).toEqual(['vibe']))
})

it('resolves a job with its own result, not with whatever else the status holds', async () => {
  let polls = 0
  const older: Job = { id: 'j1', route: 'compile', state: 'done', result: { digest: 'older' }, startedAt: 1, endedAt: 2 }
  routes['POST compile'] = () => json({ accepted: true, jobId: 'j2' }, 202)
  routes['GET status'] = () => {
    const done = ++polls > 2
    const mine: Job = { id: 'j2', route: 'compile', state: done ? 'done' : 'running', ...(done ? { result: { digest: 'mine' } } : {}), startedAt: 3 }
    return json(engineStatus({ revision: polls, busy: !done, jobs: [mine, older] }))
  }
  mount()
  await screen.findAllByText('Connect to a deployment to begin')
  let result: unknown
  await act(async () => {
    result = await api.job('compile', { scope: 'core' })
  })
  expect(result).toEqual({ digest: 'mine' })
  expect(calls.find((c) => c.route === 'POST compile')!.init.body).toBe(JSON.stringify({ scope: 'core' }))
})

it('rejects a failed job with its message and code', async () => {
  routes['POST system/rehearse'] = () => json({ accepted: true, jobId: 'j9' }, 202)
  routes['GET system/status'] = () =>
    json({
      ...systemStatus,
      jobs: [{ id: 'j9', route: 'system/rehearse', state: 'failed', error: 'Nonce moved', code: 'nonce-changed', startedAt: 1 }],
    })
  mount()
  await screen.findByText('Connect to a deployment to begin')
  let error: unknown
  await act(async () => {
    error = await api.job('system/rehearse', { id: 'x' }, true).catch((e) => e)
  })
  expect(error).toBeInstanceOf(ApiError)
  expect((error as ApiError).message).toBe('Nonce moved')
  expect((error as ApiError).code).toBe('nonce-changed')
})

it('stops waiting for a job once the app stops answering, instead of holding every action', async () => {
  routes['POST compile'] = () => json({ accepted: true, jobId: 'j3' }, 202)
  mount()
  await screen.findAllByText('Connect to a deployment to begin')
  // The service restarted: the old access link is refused from now on.
  routes['GET status'] = () => json({ error: 'Open the access link printed in your terminal', code: 'unauthorized' }, 401)
  let error: unknown
  await act(async () => {
    error = await api.job('compile', { scope: 'core' }).catch((e) => e)
  })
  expect(error).toBeInstanceOf(ApiError)
  expect((error as ApiError).message).toMatch(/Lost contact with the local app/)
})

it('names the failed operation and its time, and dismissing clears it on the server', async () => {
  const at = new Date(2026, 9, 14, 14, 2).getTime()
  let held = true
  routes['GET status'] = () =>
    json(
      engineStatus({
        error: held ? 'Fork failed' : null,
        errorInfo: held ? { id: 'e1', operation: 'Fork rehearsal', message: 'Fork failed', at } : null,
      }),
    )
  routes['POST errors/dismiss'] = () => {
    held = false
    return json({ accepted: true })
  }
  mount()
  const clock = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  await screen.findByText(`Fork rehearsal failed · ${clock}`)
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(JSON.parse(String(calls.find((c) => c.route === 'POST errors/dismiss')!.init.body))).toEqual({ id: 'e1' })
})

it('shows a job failure once even though the caller and the server both report it', async () => {
  routes['POST system/scan'] = () => json({ accepted: true, jobId: 'j5' }, 202)
  routes['GET system/status'] = () =>
    json({
      ...systemStatus,
      error: 'RPC refused',
      errorInfo: { id: 'e5', operation: 'Inspection', message: 'RPC refused', at: Date.now() },
      jobs: [{ id: 'j5', route: 'system/scan', state: 'failed', error: 'RPC refused', startedAt: 1 }],
    })
  mount()
  await screen.findByText('Connect to a deployment to begin')
  await act(() => api.run('Inspecting live deployment', () => api.job('system/scan', {}, true)))
  await waitFor(() => expect(screen.getAllByText('RPC refused')).toHaveLength(1))
})

it('shows phase, progress and elapsed time, and cancels a read-only job', async () => {
  routes['GET system/status'] = () =>
    json({
      ...systemStatus,
      busy: true,
      activity: 'Checking role grants 40 of 120',
      progress: {
        label: 'Inspecting live deployment',
        phase: 'Role holders',
        phaseIndex: 3,
        phaseCount: 6,
        done: 40,
        total: 120,
        startedAt: Date.now() - 65_000,
      },
      jobs: [{ id: 'j3', route: 'system/scan', state: 'running', startedAt: Date.now() - 65_000 }],
    })
  routes['POST jobs/cancel'] = () => json({ accepted: true })
  mount()
  await screen.findByText('Inspecting live deployment')
  expect(screen.getByText('Phase 3 of 6 · Role holders')).toBeTruthy()
  expect(screen.getByText('40 of 120')).toBeTruthy()
  expect(screen.getByText(/^1:0\d elapsed$/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(calls.some((c) => c.route === 'POST jobs/cancel')).toBe(true))
  expect(JSON.parse(String(calls.find((c) => c.route === 'POST jobs/cancel')!.init.body))).toEqual({ jobId: 'j3' })
})

it('offers no Cancel for execution, which keeps the task runner’s own policy', async () => {
  routes['GET status'] = () =>
    json(
      engineStatus({ busy: true, activity: 'Deploy ControlFacet', jobs: [{ id: 'j4', route: 'execute', state: 'running', startedAt: Date.now() }] }),
    )
  mount()
  await screen.findAllByText('Deploy ControlFacet')
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
})

it('checks the content type before parsing, and keeps the error code for callers', async () => {
  routes['POST connect'] = () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })
  routes['POST prepare'] = () => json({ error: 'Source changed; compile again', code: 'stale-source' }, 412)
  mount()
  await screen.findByText('Connect to a deployment to begin')
  const html = await api.request('connect', { target: '0x1' }).catch((e) => e)
  expect(html).toBeInstanceOf(ApiError)
  expect(html.status).toBe(502)
  expect(html.message).not.toMatch(/JSON|Unexpected token/)
  const stale = await api.request('prepare', { selected: [], removals: [], deployer: '0x1', mode: 'patch' }).catch((e) => e)
  expect([stale.status, stale.code]).toEqual([412, 'stale-source'])
})

it('types request against the route map', () => {
  const check = (request: Request) => {
    // @ts-expect-error rehearse takes a plan id
    void request('system/rehearse', { plan: 'x' })
    // @ts-expect-error status is a GET route
    void request('status', {})
    const plan: Promise<{ plan: { id: string } }> = request('plan?id=abc')
    return plan
  }
  expect(typeof check).toBe('function')
})
