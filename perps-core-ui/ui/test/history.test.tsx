import App, { History } from '../src/App'
import { historyEntries, inDeployment, recordState } from '../src/lib/state'
import type { ActiveTask, HistoryItem, Profile } from '../src/types'
import { MantineProvider } from '@mantine/core'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ api: {} as any }))
vi.mock('../src/api', async (original) => ({ ...(await original<typeof import('../src/api')>()), useWorkbench: () => mock.api }))
vi.mock('../src/components/Workspace', () => ({ Workspace: () => null }))
vi.mock('../src/components/Upgrade', () => ({ Upgrade: () => null }))
vi.mock('../src/components/Signing', () => ({ WalletRequest: () => null, connectWallet: vi.fn() }))
vi.mock('../src/fuzz/Fuzz', () => ({ Fuzz: () => <p>Fuzz report</p> }))

const CORE = '0x1111111111111111111111111111111111111111',
  STAGE_CORE = '0x2222222222222222222222222222222222222222'
const profile = (id: string, name: string, environment: string, core: string): Profile => ({
  id,
  name,
  environment,
  chainId: 42161,
  chainName: 'arbitrum',
  nodes: [{ id: 'core', kind: 'core', name: 'Symmio', address: core, state: {} }],
})
const production = profile('arbitrum-vibe', 'Vibe Arbitrum', 'Production', CORE),
  staging = profile('vibe-arbitrum-stage', 'Vibe Arbitrum', 'Staging', STAGE_CORE)
const item = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
  id: id.padEnd(64, '0'),
  family: 'diamond',
  target: CORE,
  scope: 'core',
  chainId: 42161,
  createdAt: '2026-10-01T10:00:00.000Z',
  status: 'prepared',
  changes: 3,
  rehearsal: 'none',
  active: false,
  deployment: { id: production.id, name: production.name, environment: 'Production', chainId: 42161 },
  ...extra,
})
const stagingPlan = { deployment: { id: staging.id, name: staging.name, environment: 'Staging', chainId: 42161 }, target: STAGE_CORE }

let path = ''
function Where() {
  path = useLocation().search
  return null
}
function show(engineHistory: HistoryItem[], systemHistory: HistoryItem[] = [], selected = production, active?: ActiveTask) {
  mock.api = {
    busy: false,
    engine: { history: engineHistory, active },
    system: { profile: selected, profiles: [production, staging], history: systemHistory },
    request: vi.fn(async (route: string) => ({
      status: 'prepared',
      plan: route.startsWith('system/')
        ? { kind: 'peripheral', scope: 'partyB', sourceAddress: CORE }
        : { scope: 'core', snapshot: { target: CORE } },
    })),
    run: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
  }
  return render(
    <MantineProvider env="test">
      <MemoryRouter initialEntries={['/?view=history']}>
        <History onWorkspace={vi.fn()} />
        <Where />
      </MemoryRouter>
    </MantineProvider>,
  )
}
const rows = () => screen.queryAllByRole('row').slice(1)

beforeEach(() => {
  path = ''
})

describe('History', () => {
  it('pins the active plan above the table with what it is waiting for, even when it belongs to another deployment', async () => {
    show([
      item('a'),
      item('b', {
        ...stagingPlan,
        active: true,
        taskStatus: 'waiting_external',
        waitingFor: 'Download the Safe batch, execute it in Safe, then continue here.',
      }),
    ])
    const pinned = screen.getByRole('region', { name: 'Plan in progress' })
    expect(within(pinned).getByText('Waiting for Safe execution')).toBeTruthy()
    expect(within(pinned).getByText(/execute it in Safe/)).toBeTruthy()
    expect(within(pinned).getByText('Staging')).toBeTruthy()
    // The table keeps to the selected deployment.
    expect(rows()).toHaveLength(1)
    fireEvent.click(within(pinned).getByRole('button', { name: 'Open plan' }))
    await waitFor(() => expect(path).toContain('plan=b'))
    expect(mock.api.request).toHaveBeenCalledWith(`plan?id=${'b'.padEnd(64, '0')}`)
    expect(new URLSearchParams(path).get('target')).toBe(CORE)
  })

  it('marks the active plan from the task lock when the history row does not say so', () => {
    const task: ActiveTask = { runId: 'r', taskId: 't', status: 'paused', input: { planId: 'c'.padEnd(64, '0') }, runner: { running: false } }
    show([item('a'), item('c', { execution: { confirmed: 1, submitted: 0, unresolved: 1 } })], [], production, task)
    expect(within(screen.getByRole('region', { name: 'Plan in progress' })).getByText('Paused, needs a transaction hash')).toBeTruthy()
    expect(rows()).toHaveLength(1)
  })

  it('says how far each saved plan got', () => {
    show([
      item('1', { createdAt: '2026-10-05T00:00:00Z' }),
      item('2', { createdAt: '2026-10-04T00:00:00Z', rehearsal: 'passed' }),
      item('3', { createdAt: '2026-10-03T00:00:00Z', rehearsal: 'failed' }),
      item('4', {
        createdAt: '2026-10-02T00:00:00Z',
        rehearsal: 'passed',
        status: 'verified',
        execution: { confirmed: 3, submitted: 0, unresolved: 0 },
      }),
    ])
    expect(rows().map((r) => within(r).getAllByText(/Prepared|Rehearsed|Rehearsal failed|Verified/)[0].textContent)).toEqual([
      'Prepared',
      'Rehearsed',
      'Rehearsal failed',
      'Verified',
    ])
  })

  it('names the contract and its deployment', () => {
    show([item('a')])
    const [row] = rows()
    expect(within(row).getByText('Symmio')).toBeTruthy()
    expect(within(row).getByText('Core Diamond')).toBeTruthy()
    expect(within(row).getByText('Vibe Arbitrum')).toBeTruthy()
    expect(within(row).getByText('Production')).toBeTruthy()
  })

  it('filters by the selected deployment, not the chain, with other deployments one checkbox away', () => {
    show([item('p'), item('s', stagingPlan)], [], staging)
    expect(rows()).toHaveLength(1)
    expect(within(rows()[0]).getByText('Staging')).toBeTruthy()
    expect(screen.getByText('Prepared for Vibe Arbitrum (Staging)')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Show other deployments (1)'))
    expect(rows()).toHaveLength(2)
    expect(screen.getByText('Every deployment')).toBeTruthy()
  })

  it('matches older plans without a deployment by chain, and says so', () => {
    show([item('o', { deployment: undefined })], [{ ...item('q', { deployment: undefined, chainId: 8453, family: 'peripheral' }) }], staging)
    expect(rows()).toHaveLength(1)
    expect(screen.getByText(/older plans on arbitrum \(42161\) that do not record a deployment/)).toBeTruthy()
    expect(screen.getByLabelText('Show other deployments (1)')).toBeTruthy()
  })
})

describe('recordState', () => {
  it('reads the active task first, then execution, rehearsal and preparation', () => {
    const base = { status: 'prepared', rehearsal: 'passed' as const }
    expect(recordState({ ...base, active: true, taskStatus: 'running' }).label).toBe('Executing')
    expect(recordState({ ...base, active: true, taskStatus: 'waiting_external', waitingFor: 'Reconcile the pending transaction' }).label).toBe(
      'Paused, needs a transaction hash',
    )
    expect(recordState({ ...base, active: true, taskStatus: 'paused' }).label).toBe('Paused')
    expect(recordState({ ...base, execution: { confirmed: 1, submitted: 0, unresolved: 0 } }).label).toBe('Partly executed')
    expect(recordState({ status: 'verified' }).label).toBe('Verified')
    expect(recordState({ status: 'prepared' }).label).toBe('Prepared')
  })
  it('lists both adapters newest first, reading `at` from older peripheral entries', () => {
    const older = { ...item('x', { family: 'peripheral' }), createdAt: '', at: '2026-10-09T00:00:00Z' } as HistoryItem
    const rows = historyEntries([item('d', { createdAt: '2026-10-08T00:00:00Z' })], [older])
    expect(rows.map((r) => [r.adapter, r.at])).toEqual([
      ['system', '2026-10-09T00:00:00Z'],
      ['diamond', '2026-10-08T00:00:00Z'],
    ])
  })
  it('falls back to the chain only for plans that do not record a deployment', () => {
    expect(inDeployment(item('a'), staging)).toBe(false)
    expect(inDeployment(item('a', { deployment: undefined }), staging)).toBe(true)
    expect(inDeployment(item('a', { deployment: undefined, chainId: 1 }), staging)).toBe(false)
  })
})

describe('App shell', () => {
  const at = Date.now()
  function shell(view: string) {
    show([])
    mock.api = {
      ...mock.api,
      token: 'a'.repeat(64),
      errors: [
        { id: 'e1', operation: 'Fork rehearsal', message: 'Fork failed', at, source: 'engine', held: true },
        { id: 'local:1', operation: 'Connecting wallet', message: 'No browser wallet found', at },
      ],
      dismiss: vi.fn(),
      jobs: [],
      progress: null,
      operation: '',
    }
    return render(
      <MantineProvider env="test">
        <MemoryRouter initialEntries={[`/?view=${view}&adapter=diamond`]}>
          <App />
          <Where />
        </MemoryRouter>
      </MantineProvider>,
    )
  }
  it('renders the sections as links that open in a new tab, and navigates in place on a plain click', () => {
    shell('workspace')
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    const history = within(nav).getByRole('link', { name: 'History' })
    expect(new URLSearchParams(history.getAttribute('href')!.slice(1)).get('view')).toBe('history')
    expect(new URLSearchParams(history.getAttribute('href')!.slice(1)).get('adapter')).toBe('diamond')
    expect(within(nav).getByRole('link', { name: 'Workspace' }).getAttribute('aria-current')).toBe('page')
    // A modified click is the browser's: the app does not navigate.
    fireEvent.click(history, { metaKey: true })
    expect(new URLSearchParams(path).get('view')).toBe('workspace')
    fireEvent.click(history)
    expect(new URLSearchParams(path).get('view')).toBe('history')
  })
  it('shows server errors on workbench views only, and keeps this tab’s own errors everywhere', async () => {
    shell('history')
    expect(screen.getByText('Fork failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(mock.api.dismiss).toHaveBeenCalledWith(mock.api.errors)
    cleanup()
    shell('fuzz')
    await screen.findByText('Fuzz report')
    expect(screen.queryByText('Fork failed')).toBeNull()
    expect(screen.getByText('No browser wallet found')).toBeTruthy()
  })
})
