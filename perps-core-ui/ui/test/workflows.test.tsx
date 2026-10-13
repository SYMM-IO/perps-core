import { Signing, WalletRequest } from '../src/components/Signing'
import { Upgrade } from '../src/components/Upgrade'
import { draftKey, readDraft } from '../src/lib/state'
import type { PlanRecord } from '../src/types'
import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ api: {} as any }))
vi.mock('../src/api', () => ({ useWorkbench: () => mock.api }))
const address = '0x1111111111111111111111111111111111111111'
const record: PlanRecord = {
  status: 'prepared',
  plan: { id: 'a'.repeat(64), scope: 'core', snapshot: { chainId: 31337, target: address, owner: address }, blockers: [] },
  rehearsal: { status: 'passed' },
}
let route = ''
function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider env="test">
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>
  )
}
beforeEach(() => {
  route = '/?view=upgrade&target=' + address + '&scope=accountLayer'
  mock.api = {
    busy: false,
    engine: { prompts: [] },
    system: { profile: { id: 'test', rpc: 'http://localhost:8545' }, profiles: [], comparison: {} },
    request: vi.fn().mockResolvedValue({}),
    refresh: vi.fn(),
    setError: vi.fn(),
    run: vi.fn(async (_label, fn) => fn()),
    job: vi.fn(),
  }
})
it('requires the exact chain and plan confirmation and does not retain it after remount', () => {
  const page = render(<Signing record={record} adapter="diamond" />, { wrapper })
  const button = screen.getByRole('button', { name: 'Start upgrade' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Confirm chain and plan'), { target: { value: '42161:aaaaaaaa' } })
  expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Confirm chain and plan'), { target: { value: '31337:aaaaaaaa' } })
  expect(button.disabled).toBe(false)
  page.unmount()
  render(<Signing record={record} adapter="diamond" />, { wrapper })
  expect((screen.getByLabelText('Confirm chain and plan') as HTMLInputElement).value).toBe('')
})
it('requires a passed rehearsal even when navigating directly to execution', () => {
  render(<Signing record={{ ...record, rehearsal: { status: 'failed' } }} adapter="diamond" />, { wrapper })
  expect(screen.queryByRole('button', { name: 'Start upgrade' })).toBeNull()
})
it('shows the Ledger path only when Ledger is selected', () => {
  render(<Signing record={record} adapter="diamond" />, { wrapper })
  expect(screen.queryByLabelText('Ledger derivation path')).toBeNull()
  fireEvent.click(screen.getByRole('combobox', { name: 'Deploy with' }))
  fireEvent.click(screen.getByRole('option', { name: 'Ledger' }))
  expect(screen.getByLabelText('Ledger derivation path')).toBeTruthy()
})
it('retains edited target across polling updates and sends the AccountLayer scope', async () => {
  const page = render(<Upgrade />, { wrapper })
  const target = '0x2222222222222222222222222222222222222222'
  expect(screen.queryByLabelText('Diamond address')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Change target or RPC' }))
  fireEvent.change(screen.getByLabelText('Diamond address'), { target: { value: target } })
  mock.api = { ...mock.api, engine: { ...mock.api.engine, revision: 2 } }
  page.rerender(<Upgrade />)
  expect((screen.getByLabelText('Diamond address') as HTMLInputElement).value).toBe(target)
  fireEvent.click(screen.getByRole('button', { name: 'Inspect & compile' }))
  await waitFor(() => expect(mock.api.request).toHaveBeenCalledWith('connect', { rpc: 'http://localhost:8545', target }))
  expect(mock.api.job).toHaveBeenCalledWith('compile', { scope: 'accountLayer' })
})
it('reuses the live workspace connection instead of asking for the target and RPC again', async () => {
  mock.api.system = { ...mock.api.system, connected: true }
  render(<Upgrade />, { wrapper })
  expect(screen.queryByLabelText('RPC endpoint')).toBeNull()
  expect(screen.getByText('Using the workspace connection')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect & compile' }))
  await waitFor(() => expect(mock.api.request).toHaveBeenCalledWith('connect', { target: address }))
  expect(mock.api.job).toHaveBeenCalledWith('compile', { scope: 'accountLayer' })
})
it('offers the upgradeable contracts when no target is chosen', () => {
  route = '/?view=upgrade'
  mock.api.system = {
    ...mock.api.system,
    snapshot: {
      nodes: [
        { id: 'core', address, kind: 'core', name: 'Symmio', strategy: 'Diamond cut', state: {} },
        { id: 'affiliate', address, kind: 'affiliate', name: 'Vibe', state: {} },
      ],
    },
  }
  render(<Upgrade />, { wrapper })
  expect(screen.getByRole('button', { name: /Symmio/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Vibe/ })).toBeNull()
})
it('keeps wallet recovery usable while the extension has an unresolved request', async () => {
  let resolveWallet: (value: string) => void = () => {}
  const wallet = new Promise<string>((resolve) => {
    resolveWallet = resolve
  })
  mock.api.engine.prompts = [
    { id: 'cut', requestId: 'r1', sender: address, request: { chainId: 31337, nonce: 0, gasLimit: 21000, data: '0x', to: address } },
  ]
  window.ethereum = {
    request: vi.fn(async ({ method }) => (method === 'eth_requestAccounts' ? [address] : method === 'eth_chainId' ? '0x7a69' : wallet)),
  }
  render(<WalletRequest />, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Review in wallet' }))
  await waitFor(() => expect(mock.api.request).toHaveBeenCalledWith('claim', { requestId: 'r1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Stop waiting and recover' }))
  await waitFor(() => expect(mock.api.request).toHaveBeenCalledWith('pause-wallet', { requestId: 'r1' }))
  resolveWallet('0x' + 'b'.repeat(64))
  await waitFor(() => expect(mock.api.refresh).toHaveBeenCalled())
})
it('isolates drafts by chain, target, family and source and migrates old removal selections', () => {
  const fallback = { selected: [], removals: [], deployer: '', mode: 'patch' },
    key = draftKey(1, address, 'core', 'source1')
  sessionStorage.setItem(
    key,
    JSON.stringify({ selected: ['ControlFacet'], removed: ['0x12345678'], deployer: address, mode: 'patch', confirmation: 'do not restore' }),
  )
  expect(readDraft(sessionStorage, key, fallback)).toEqual({
    selected: ['ControlFacet'],
    removals: ['0x12345678'],
    deployer: address,
    mode: 'patch',
  })
  for (const other of [
    draftKey(2, address, 'core', 'source1'),
    draftKey(1, address, 'accountLayer', 'source1'),
    draftKey(1, address, 'core', 'source2'),
    draftKey(1, '0x2222', 'core', 'source1'),
  ])
    expect(readDraft(sessionStorage, other, fallback)).toEqual(fallback)
})

it('requires a live connection and reviewed InstantLayer inventory before preparation', () => {
  route = '/?view=upgrade&adapter=system&scope=instantLayer&upgradeNode=instant&target=' + address
  mock.api.system = {
    ...mock.api.system,
    connected: true,
    snapshot: {
      nodes: [{ id: 'instant', address, kind: 'instantLayer', name: 'InstantLayer', state: { roles: { DEFAULT_ADMIN_ROLE: [address] } } }],
    },
  }
  const page = render(<Upgrade />, { wrapper })
  fireEvent.change(screen.getByLabelText('Deployment wallet address'), { target: { value: address } })
  const button = screen.getByRole('button', { name: 'Prepare transactions' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the migration inventory/ }))
  expect(button.disabled).toBe(false)
  mock.api.system = { ...mock.api.system, connected: false }
  page.rerender(<Upgrade />)
  expect(button.disabled).toBe(true)
})
it("does not offer to resume another plan under the current plan's summary", () => {
  mock.api.engine.active = { input: { planId: 'other' } }
  render(<Signing record={record} adapter="diamond" />, { wrapper })
  expect(screen.queryByRole('button', { name: 'Continue task' })).toBeNull()
  expect(screen.getByText(/Another task is active/)).toBeTruthy()
})

it('compiles the selected peripheral family before preparing its transaction sequence', async () => {
  route = '/?view=upgrade&adapter=system&scope=verifier&upgradeNode=verifier&target=' + address
  mock.api.system = {
    ...mock.api.system,
    connected: true,
    snapshot: { nodes: [{ id: 'verifier', address, kind: 'verifier', name: 'Verifier', state: { roles: { DEFAULT_ADMIN_ROLE: [address] } } }] },
  }
  const saved = {
    status: 'prepared',
    plan: {
      id: 'b'.repeat(64),
      scope: 'verifier',
      chainId: 31337,
      sourceAddress: address,
      authority: address,
      createdAt: new Date().toISOString(),
      blockers: [],
      warnings: [],
      changes: [],
      actions: [],
    },
  }
  mock.api.job.mockResolvedValue({ plan: saved })
  mock.api.request.mockResolvedValue(saved)
  render(<Upgrade />, { wrapper })
  fireEvent.change(screen.getByLabelText('Deployment wallet address'), { target: { value: address } })
  fireEvent.click(screen.getByRole('button', { name: 'Prepare transactions' }))
  await waitFor(() =>
    expect(mock.api.job).toHaveBeenNthCalledWith(
      2,
      'system/prepare',
      expect.objectContaining({ nodeId: 'verifier', deployer: address, authority: address }),
      true,
    ),
  )
  expect(mock.api.job).toHaveBeenNthCalledWith(1, 'compile', { scope: 'verifier' })
})
