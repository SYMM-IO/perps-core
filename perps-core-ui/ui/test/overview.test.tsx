import { Workspace } from '../src/components/Workspace'
import type { Profile, Snapshot } from '../src/types'
import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ api: {} as any }))
vi.mock('../src/api', () => ({ useWorkbench: () => mock.api }))
vi.mock('../src/components/ContractGraph', () => ({
  ContractGraph: ({ selected, link, filters, focusDetails }: any) => (
    <div data-testid="graph-state">{JSON.stringify({ selected, link, filters, focusDetails })}</div>
  ),
}))
vi.mock('../src/components/Sources', () => ({ Sources: () => null }))

const address = '0x1111111111111111111111111111111111111111'
const profile: Profile = {
  id: 'example',
  name: 'Example deployment',
  chainId: 42161,
  chainName: 'Arbitrum',
  environment: 'Production',
  rpc: 'https://example.test',
  nodes: [
    { id: 'core', name: 'Symmio', kind: 'core', address, state: {} },
    { id: 'accounts', name: 'Accounts', kind: 'accountLayer', address, state: {} },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `wallet-${i}`, name: `Wallet ${i}`, kind: 'authority', address, state: {} })),
  ],
}
const snapshot: Snapshot = {
  profile,
  nodes: profile.nodes,
  chainId: profile.chainId,
  blockNumber: 123456,
  at: '2026-11-17T10:00:00Z',
  fingerprint: 'snapshot',
  edges: [{ from: 'accounts', to: 'core', label: 'REGISTRAR_ROLE', status: 'missing', expected: true, actual: false }],
}
function Location() {
  return <output data-testid="location">{useLocation().search}</output>
}
function open(route = '/?view=workspace') {
  return render(
    <MantineProvider env="test">
      <MemoryRouter initialEntries={[route]}>
        <Workspace onPrepare={vi.fn()} />
        <Location />
      </MemoryRouter>
    </MantineProvider>,
  )
}
const graphState = async () => JSON.parse((await screen.findByTestId('graph-state')).textContent || '{}')

beforeEach(() => {
  mock.api = {
    system: { profile, profiles: [profile], snapshot, connected: false, live: false, comparison: {}, delta: [], history: [] },
    engine: {},
    jobs: [],
    busy: false,
    run: vi.fn(async (_label: string, fn: () => unknown) => fn()),
    job: vi.fn().mockResolvedValue({}),
    request: vi.fn().mockResolvedValue({}),
  }
})

it('starts on a small overview without selecting Core, loading the map, or showing source comparison', async () => {
  open()
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('heading', { name: '1 connection needs review' })).toBeTruthy()
  expect(screen.getByText('Saved snapshot')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Compare source' })).toBeNull()
  expect(screen.queryByTestId('graph-state')).toBeNull()
  expect(screen.getByText('Review connection').closest('details')?.open).toBe(false)
  expect(screen.getByRole('button', { name: 'Inspect Symmio' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Wallet 0/ })).toBeNull()
  await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('deployment=example'))
  expect(screen.getByTestId('location').textContent).not.toMatch(/node=|graphFocus=|tab=map/)
})

it('opens the full map with no inspector selection when Map is explicitly chosen', async () => {
  open()
  fireEvent.click(screen.getByRole('tab', { name: 'Map' }))
  expect(await graphState()).toMatchObject({ selected: '', link: '', filters: { mode: 'all', focus: '', query: '' } })
})

it.each([
  ['/?node=accounts', 'accounts', 'core'],
  ['/?graphQuery=REGISTRAR_ROLE', 'core', 'core'],
  ['/?link=accounts%7Ccore', 'core', 'core'],
])('preserves legacy map links %s', async (route, selected, focus) => {
  open(route)
  expect(screen.getByRole('tab', { name: 'Map' }).getAttribute('aria-selected')).toBe('true')
  expect(await graphState()).toMatchObject({ selected, filters: { focus } })
})

it('honors an explicit Overview tab even when the URL retains map state', () => {
  open('/?tab=overview&node=core&graphFocus=core')
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.queryByTestId('graph-state')).toBeNull()
})

it('opens a reviewed connection with its owning contract and clears unrelated graph filters', async () => {
  open('/?tab=overview&graphQuery=other&graphHide=grant&graphAttention=1')
  const review = screen.getByText('Review connection').closest('details')!
  expect(review.open).toBe(false)
  fireEvent.click(screen.getByText('Review connection'))
  // jsdom does not implement the summary default action.
  review.open = true
  fireEvent.click(screen.getByRole('button', { name: /REGISTRAR_ROLE not granted/ }))
  expect(await graphState()).toMatchObject({
    selected: 'accounts',
    focusDetails: 1,
    filters: { focus: 'accounts', query: '', hide: [], missingOnly: false },
  })
  expect((await graphState()).link).toBeTruthy()
})

it('opens a chosen component as the focused contract', async () => {
  open('/?tab=overview&graphQuery=other&graphHide=grant&graphAttention=1')
  fireEvent.click(screen.getByRole('button', { name: 'Inspect Accounts' }))
  expect(await graphState()).toMatchObject({
    selected: 'accounts',
    focusDetails: 1,
    filters: { focus: 'accounts', query: '', hide: [], missingOnly: false },
  })
})

it('keeps Compare source in Changes and retains the live-inspection gate', async () => {
  open()
  fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
  expect((screen.getByRole('button', { name: 'Compare source' }) as HTMLButtonElement).disabled).toBe(true)
  expect(mock.api.job).not.toHaveBeenCalled()
})

it('keeps incomplete reads visible without claiming deployment health', () => {
  mock.api.system.snapshot = {
    ...snapshot,
    edges: [{ from: 'accounts', to: 'core', label: 'Owner', status: 'unknown' }],
    roleHistory: { complete: false },
  }
  open()
  expect(screen.getByRole('heading', { name: 'No missing connections found' })).toBeTruthy()
  expect(screen.getByText('1 connection read was unavailable · Role history is incomplete')).toBeTruthy()
  expect(screen.queryByText('Partial role history')).toBeNull()
  expect(screen.queryByText('No problems')).toBeNull()
})

it('asks for inspection when no snapshot exists', () => {
  mock.api.system.snapshot = undefined
  open()
  expect(screen.getByRole('heading', { name: 'Start with a live inspection' })).toBeTruthy()
  expect(screen.getByText('Not inspected')).toBeTruthy()
  expect(screen.queryByText('No missing connections found')).toBeNull()
})

it('enables inspection when the RPC list arrives after the saved deployment status', async () => {
  mock.api.system = { ...mock.api.system, profile: { ...profile, rpc: undefined }, profiles: [] }
  const page = open()
  expect((screen.getByRole('button', { name: 'Inspect live' }) as HTMLButtonElement).disabled).toBe(true)
  mock.api.system = { ...mock.api.system, profiles: [profile] }
  page.rerender(
    <MantineProvider env="test">
      <MemoryRouter initialEntries={['/?view=workspace']}>
        <Workspace onPrepare={vi.fn()} />
        <Location />
      </MemoryRouter>
    </MantineProvider>,
  )
  await waitFor(() => expect((screen.getByRole('button', { name: 'Inspect live' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Inspect live' }))
  expect(mock.api.job).toHaveBeenCalledWith('system/scan', { rpc: profile.rpc }, true)
})
