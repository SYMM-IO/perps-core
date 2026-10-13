import { Fuzz } from '../src/fuzz/Fuzz'
import { MantineProvider } from '@mantine/core'
import { render, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../src/api', () => ({ useWorkbench: () => ({ token: 'a'.repeat(64) }) }))
const archived = '2026-07-28T14-48-05.123Z-e971dfb5.json'
let report: unknown
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const body = String(input) === '/api/fuzz/runs' ? { runs: [archived] } : report
  return { ok: true, status: 200, json: async () => body } as Response
})
beforeEach(() => {
  report = { status: 'waiting' }
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

it('renders a finished run and loads an archived one from the fuzz archive route', async () => {
  report = { kind: 'symmio-fuzz-dashboard', run: { status: 'passed' }, config: { seed: 'seed-1' }, latest: { roots: 12 } }
  const { root } = mount()
  await waitFor(() => expect(root.getElementById('dashboard')!.hidden).toBe(false))
  expect(root.getElementById('waiting-state')!.hidden).toBe(true)
  expect(root.getElementById('seed-value')!.textContent).toBe('seed-1')
  const select = root.getElementById('run-select') as HTMLSelectElement
  await waitFor(() => expect(select.options).toHaveLength(2))
  select.value = archived
  select.dispatchEvent(new Event('change'))
  await waitFor(() => expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(`/api/fuzz/runs/${encodeURIComponent(archived)}`))
})

it('stops polling when the view is left', async () => {
  vi.useFakeTimers()
  try {
    const { page } = mount()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2)
    page.unmount()
    const before = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchMock.mock.calls.length).toBe(before)
  } finally {
    vi.useRealTimers()
  }
})
