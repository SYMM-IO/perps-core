import { Signing, WalletRequest } from '../src/components/Signing'
import { Upgrade } from '../src/components/Upgrade'
import { Workspace } from '../src/components/Workspace'
import { draftKey, readDraft } from '../src/lib/state'
import type { PlanRecord } from '../src/types'
import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ api: {} as any }))
vi.mock('../src/api', () => ({ useWorkbench: () => mock.api, nextStep: (code?: string) => (code ? `Next step for ${code}` : undefined) }))
const address = '0x1111111111111111111111111111111111111111',
  other = '0x2222222222222222222222222222222222222222',
  hash = '0x' + 'b'.repeat(64)
const record = {
  status: 'prepared',
  plan: {
    id: 'a'.repeat(64),
    scope: 'core',
    snapshot: { chainId: 31337, target: address, owner: address },
    blockers: [],
    deployments: [],
    changes: [],
  },
  rehearsal: { status: 'passed' },
} as unknown as PlanRecord
const profiles = [
  { id: 'arbitrum-vibe', name: 'Vibe Arbitrum', chainId: 42161, chainName: 'arbitrum', environment: 'Production', nodes: [] },
  { id: 'vibe-arbitrum-stage', name: 'Vibe Arbitrum', chainId: 42161, chainName: 'arbitrum', environment: 'Staging', nodes: [] },
  { id: 'base-vibe', name: 'Vibe Base', chainId: 8453, chainName: 'base', environment: 'Production', nodes: [] },
]
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
/** A Diamond engine that has inspected `address` on `chainId` and compiled the AccountLayer family. */
const engineOn = (chainId: number, map: Record<string, string> = {}, catalog: any[] = []) => ({
  prompts: [],
  snapshot: { chainId, target: address, owner: address, facets: [], map, authority: { kind: 'eoa' }, blockNumber: 1234, fingerprint: 'f' },
  build: { scope: 'accountLayer', digest: 'd'.repeat(64), source: { commit: 'c'.repeat(40) }, catalog },
})
beforeEach(() => {
  route = '/?view=upgrade&target=' + address + '&scope=accountLayer'
  localStorage.clear()
  window.ethereum = undefined
  mock.api = {
    busy: false,
    engine: { prompts: [] },
    system: { profile: { id: 'test', rpc: 'http://localhost:8545', chainId: 31337 }, profiles: [], comparison: {} },
    request: vi.fn().mockResolvedValue({}),
    refresh: vi.fn(),
    setError: vi.fn(),
    run: vi.fn(async (_label, fn) => fn()),
    job: vi.fn(),
    errors: [],
    dismiss: vi.fn(),
    jobs: [],
  }
})
it('requires the exact chain and plan confirmation for plans saved without a deployment, and does not retain it after remount', () => {
  const page = render(<Signing record={record} adapter="diamond" />, { wrapper })
  const button = screen.getByRole('button', { name: 'Start upgrade' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Confirm deployment and plan'), { target: { value: '42161:aaaaaaaa' } })
  expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Confirm deployment and plan'), { target: { value: '31337:aaaaaaaa' } })
  expect(button.disabled).toBe(false)
  page.unmount()
  render(<Signing record={record} adapter="diamond" />, { wrapper })
  expect((screen.getByLabelText('Confirm deployment and plan') as HTMLInputElement).value).toBe('')
})
it('asks for the deployment id, not the chain, once the plan records its deployment', () => {
  const plan = { ...record.plan, deployment: { id: 'vibe-arbitrum-stage', name: 'Vibe Arbitrum', environment: 'Staging', chainId: 42161 } }
  render(<Signing record={{ ...record, plan } as PlanRecord} adapter="diamond" />, { wrapper })
  const button = screen.getByRole('button', { name: 'Start upgrade' }) as HTMLButtonElement
  expect(screen.getByText(/Type vibe-arbitrum-stage:aaaaaaaa\./)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Confirm deployment and plan'), { target: { value: '31337:aaaaaaaa' } })
  expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Confirm deployment and plan'), { target: { value: 'vibe-arbitrum-stage:aaaaaaaa' } })
  expect(button.disabled).toBe(false)
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
it('preselects Safe for a Safe-owned Diamond and names who deploys and who authorizes', () => {
  const plan = {
    ...record.plan,
    deployer: other,
    snapshot: { ...record.plan.snapshot, authority: { kind: 'safe', threshold: 2, owners: [address, other, address] } },
  }
  render(<Signing record={{ ...record, plan } as PlanRecord} adapter="diamond" />, { wrapper })
  expect((screen.getByRole('combobox', { name: 'Authorize upgrade with' }) as HTMLInputElement).value).toBe('Safe · export batch')
  fireEvent.click(screen.getByRole('combobox', { name: 'Authorize upgrade with' }))
  expect(screen.queryByRole('option', { name: 'Browser wallet' })).toBeNull()
  expect(screen.getByText(`Deploys as ${other}`)).toBeTruthy()
  expect(screen.getByText(`Authorizes as ${address} (Safe 2 of 3)`)).toBeTruthy()
})
it('checks the connected browser wallet and its chain against the plan', async () => {
  window.ethereum = { request: vi.fn(async ({ method }) => (method === 'eth_accounts' ? [other] : '0x1')) }
  const plan = { ...record.plan, deployer: address }
  render(<Signing record={{ ...record, plan } as PlanRecord} adapter="diamond" />, { wrapper })
  expect(await screen.findByText(/Connected wallet 0x222222…222222 is not the deployer/)).toBeTruthy()
  expect(screen.getByText(/Wallet is on Chain 1; this plan is on Chain 31337/)).toBeTruthy()
})
it('keeps Export Safe calls disabled, with the reason, until the deployment is confirmed', () => {
  const peripheral = {
    status: 'prepared',
    plan: {
      id: 'c'.repeat(64),
      kind: 'peripheral',
      scope: 'verifier',
      chainId: 31337,
      deployer: address,
      authority: other,
      actions: [
        { id: 'deploy', label: 'Deploy Signature verifier replacement', phase: 'deploy', sender: address, data: '0x', value: '0' },
        { id: 'action-1', label: 'Switch the verifier', phase: 'cutover', sender: other, to: address, data: '0x', value: '0' },
      ],
      blockers: [],
      changes: [],
      warnings: [],
    },
    rehearsal: { status: 'passed' },
    journal: {},
  } as unknown as PlanRecord
  const page = render(<Signing record={peripheral} adapter="system" />, { wrapper })
  expect((screen.getByRole('button', { name: 'Export Safe calls' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('Available once the deployment transaction is confirmed.')).toBeTruthy()
  page.rerender(
    <Signing
      record={{ ...peripheral, journal: { deploy: { id: 'deploy', sender: address, status: 'confirmed', hash, request: {} as any } } }}
      adapter="system"
    />,
  )
  expect((screen.getByRole('button', { name: 'Export Safe calls' }) as HTMLButtonElement).disabled).toBe(false)
})
it('lists every step of the active task with its signer, state and hash', () => {
  const plan = { ...record.plan, deployer: other, deployments: [{ id: 'deploy.viewfacet', name: 'ViewFacet' }] }
  mock.api.engine.active = {
    taskId: 'maintenance.upgrade-workbench',
    status: 'waiting_external',
    input: { planId: plan.id },
    runner: { running: false },
    plan: [
      { id: 'deploy.viewfacet', title: 'Deploy ViewFacet', phase: 'deploy' },
      { id: 'cut', title: 'Rehearse and execute the Diamond cut', phase: 'upgrade' },
      { id: 'verify', title: 'Verify the upgraded system', phase: 'verify' },
    ],
    completedSteps: ['deploy.viewfacet'],
  }
  const journal = { 'deploy.viewfacet': { id: 'deploy.viewfacet', sender: other, status: 'confirmed', hash, request: {} } }
  render(<Signing record={{ ...record, plan, journal, execution: { upgradeMode: 'safe' } } as unknown as PlanRecord} adapter="diamond" />, {
    wrapper,
  })
  expect(screen.getByText('1 of 3 steps done; next: Rehearse and execute the Diamond cut (waiting for Safe)')).toBeTruthy()
  expect(screen.getByText('Waiting for Safe')).toBeTruthy()
  expect(screen.getByText(hash)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }))
  expect(screen.getByText('1 of 3 steps done; next: Rehearse and execute the Diamond cut (waiting for Safe).')).toBeTruthy()
})
it('offers a reconnect instead of Continue and Cancel when the task has lost its connection', async () => {
  mock.api.system.profiles = profiles
  mock.api.engine = {
    prompts: [],
    needsReconnect: true,
    active: { taskId: 'maintenance.upgrade-workbench', input: { planId: record.plan.id }, runner: { running: false } },
  }
  const plan = { ...record.plan, snapshot: { ...record.plan.snapshot, chainId: 42161 } }
  render(<Signing record={{ ...record, plan } as PlanRecord} adapter="diamond" />, { wrapper })
  expect(screen.queryByRole('button', { name: 'Continue task' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Cancel task' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect to arbitrum to continue' }))
  await waitFor(() => expect(mock.api.request).toHaveBeenCalledWith('reconnect', {}))
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
it('does not treat a Diamond read on another chain at the same address as this deployment', () => {
  mock.api.system = { ...mock.api.system, profile: { ...profiles[0], rpc: 'http://localhost:8545' }, profiles }
  mock.api.engine = engineOn(8453)
  const page = render(<Upgrade />, { wrapper })
  expect(screen.getByText('Connected to base (8453); this deployment is on arbitrum (42161). Inspect & compile again.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Prepare upgrade plan' })).toBeNull()
  mock.api.engine = engineOn(42161)
  page.rerender(<Upgrade />)
  expect(screen.queryByText(/Connected to base/)).toBeNull()
  expect(screen.getByText('arbitrum (42161) · Block 1,234')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Prepare upgrade plan' })).toBeTruthy()
})
it('pins the deployment, environment, chain and target above the upgrade flow', () => {
  mock.api.system = { ...mock.api.system, profile: { ...profiles[1], rpc: 'http://localhost:8545' }, profiles }
  render(<Upgrade />, { wrapper })
  const bar = screen.getByRole('region', { name: 'Upgrade context' })
  expect(bar.textContent).toContain('Vibe Arbitrum')
  expect(bar.textContent).toContain('Staging')
  expect(bar.textContent).toContain('arbitrum (42161)')
})
it('works out the reconcile removal set and fills it with one acknowledgement', async () => {
  const keep = '0xaaaaaaaa',
    gone = '0xbbbbbbbb',
    alsoGone = '0xcccccccc'
  mock.api.system = {
    ...mock.api.system,
    chainId: 31337,
    snapshot: { nodes: [{ id: 'old', kind: 'facet', name: 'OldFacet', address: other, state: {} }] },
  }
  mock.api.engine = {
    ...engineOn(31337, { [keep]: address, [gone]: other, [alsoGone]: other, '0x1f931c1c': address }, [
      { name: 'KeptFacet', kind: 'facet', selectors: { [keep]: 'keep()' }, dependencies: [] },
    ]),
  }
  mock.api.request.mockImplementation(async (r: string) => (r === 'prepare' ? { plan: { id: 'f'.repeat(64) } } : {}))
  sessionStorage.setItem(
    draftKey(31337, address, 'accountLayer', 'd'.repeat(64)),
    JSON.stringify({ selected: ['KeptFacet'], removals: [], deployer: address, mode: 'reconcile' }),
  )
  render(<Upgrade />, { wrapper })
  const prepare = screen.getByRole('button', { name: 'Prepare upgrade plan' }) as HTMLButtonElement
  expect(prepare.disabled).toBe(true)
  expect(screen.getByText('2 from 1 facet')).toBeTruthy()
  fireEvent.click(screen.getByLabelText('I reviewed these 2 removals from OldFacet'))
  expect(prepare.disabled).toBe(false)
  fireEvent.click(prepare)
  await waitFor(() =>
    expect(mock.api.request).toHaveBeenCalledWith('prepare', expect.objectContaining({ mode: 'reconcile', removals: [gone, alsoGone] })),
  )
})
it('marks selectors a selected facet keeps instead of offering them for removal in patch mode', () => {
  const keep = '0xaaaaaaaa'
  mock.api.engine = engineOn(31337, { [keep]: address, '0xbbbbbbbb': address }, [
    { name: 'KeptFacet', kind: 'facet', selectors: { [keep]: 'keep()' }, dependencies: [] },
  ])
  sessionStorage.setItem(
    draftKey(31337, address, 'accountLayer', 'd'.repeat(64)),
    JSON.stringify({ selected: ['KeptFacet'], removals: [], deployer: '', mode: 'patch' }),
  )
  render(<Upgrade />, { wrapper })
  fireEvent.click(screen.getByText('Explicit function removals (0)'))
  expect((screen.getByLabelText(`${keep} keep() · kept by KeptFacet`) as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByLabelText('0xbbbbbbbb Unknown function') as HTMLInputElement).disabled).toBe(false)
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
it('offers to compile again when the server reports a stale source', async () => {
  mock.api.errors = [{ id: 'e1', operation: 'Prepare', message: 'Source changed; compile again', code: 'stale-source', at: 1, source: 'engine' }]
  render(<Upgrade />, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Compile again' }))
  await waitFor(() => expect(mock.api.job).toHaveBeenCalledWith('compile', { scope: 'accountLayer' }))
  expect(mock.api.dismiss).toHaveBeenCalled()
})
it('asks before stopping while this tab still has the wallet open', async () => {
  let resolveWallet: (value: string) => void = () => {}
  const wallet = new Promise<string>((resolve) => {
    resolveWallet = resolve
  })
  mock.api.engine.prompts = [
    { id: 'cut', requestId: 'r1', sender: address, request: { chainId: 31337, nonce: 0, gasLimit: '21000', value: '0', data: '0x', to: address } },
  ]
  window.ethereum = {
    request: vi.fn(async ({ method }) => (method === 'eth_requestAccounts' ? [address] : method === 'eth_chainId' ? '0x7a69' : wallet)),
  }
  render(<WalletRequest />, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Review in wallet' }))
  await waitFor(() => expect(mock.api.request).toHaveBeenCalledWith('claim', { requestId: 'r1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Stop waiting and recover' }))
  expect(mock.api.request).not.toHaveBeenCalledWith('pause-wallet', expect.anything())
  expect(await screen.findByText(/the app will need its hash/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }))
  await waitFor(() => expect(mock.api.request).toHaveBeenCalledWith('pause-wallet', { requestId: 'r1' }))
  resolveWallet(hash)
  await waitFor(() => expect(mock.api.refresh).toHaveBeenCalled())
})
it('shows the plan, step, target and fees of a wallet request', () => {
  mock.api.system.snapshot = { nodes: [{ id: 'core', kind: 'core', name: 'Symmio', address, state: {} }] }
  mock.api.engine.prompts = [
    {
      id: 'cut',
      requestId: 'r1',
      planId: 'e'.repeat(64),
      step: 3,
      of: 4,
      label: 'Execute Diamond cut',
      sender: address,
      request: { chainId: 31337, nonce: 7, gasLimit: '100000', value: '0', maxFeePerGas: '2000000000', data: '0x', to: address },
    },
  ]
  render(<WalletRequest />, { wrapper })
  expect(screen.getByText('eeeeeeee')).toBeTruthy()
  expect(screen.getByText(/step 3 of 4/)).toBeTruthy()
  expect(screen.getByText(/Symmio/)).toBeTruthy()
  expect(screen.getByText('100,000')).toBeTruthy()
  expect(screen.getByText('2 gwei · up to 0.0002')).toBeTruthy()
})
it('keeps a wallet hash the server did not hear about, offers to attach it and fills the recovery form with it', async () => {
  const planId = record.plan.id
  mock.api.engine = {
    prompts: [
      {
        id: 'cut',
        requestId: 'r1',
        planId,
        sender: address,
        request: { chainId: 31337, nonce: 0, gasLimit: '21000', value: '0', data: '0x', to: address },
      },
    ],
    active: { taskId: 'maintenance.upgrade-workbench', input: { planId }, runner: { running: false } },
  }
  mock.api.request.mockImplementation(async (r: string) => {
    if (r === 'respond') throw new Error('This wallet request is no longer active')
    return {}
  })
  window.ethereum = {
    request: vi.fn(async ({ method }) => (method === 'eth_requestAccounts' ? [address] : method === 'eth_chainId' ? '0x7a69' : hash)),
  }
  const page = render(<WalletRequest />, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Review in wallet' }))
  expect(await screen.findByText(`The wallet returned ${hash}; the transaction may be on chain. The app did not record it for cut.`)).toBeTruthy()
  expect(mock.api.setError).not.toHaveBeenCalledWith('This wallet request is no longer active')
  // The task paused and dropped the prompt: attaching goes through the recovery route.
  mock.api.engine = { ...mock.api.engine, prompts: [] }
  page.rerender(<WalletRequest />)
  fireEvent.click(screen.getByRole('button', { name: 'Attach this transaction' }))
  await waitFor(() => expect(mock.api.request).toHaveBeenCalledWith('attach', { id: planId, actionId: 'cut', hash }))
  page.unmount()
  const journal = { cut: { id: 'cut', sender: address, status: 'awaiting-signature', request: {} } }
  render(<Signing record={{ ...record, journal } as unknown as PlanRecord} adapter="diamond" />, { wrapper })
  expect((screen.getByLabelText('Transaction hash') as HTMLInputElement).value).toBe(hash)
})
it("never hands a kept hash to another plan's live prompt for a step with the same id", async () => {
  const planId = record.plan.id,
    request = { chainId: 31337, nonce: 0, gasLimit: '21000', value: '0', data: '0x', to: address }
  mock.api.engine = {
    prompts: [{ id: 'cut', requestId: 'r1', planId, sender: address, request }],
    active: { taskId: 'maintenance.upgrade-workbench', input: { planId }, runner: { running: false } },
  }
  mock.api.request.mockImplementation(async (r: string) => {
    if (r === 'respond') throw new Error('This wallet request is no longer active')
    return {}
  })
  window.ethereum = {
    request: vi.fn(async ({ method }) => (method === 'eth_requestAccounts' ? [address] : method === 'eth_chainId' ? '0x7a69' : hash)),
  }
  const page = render(<WalletRequest />, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Review in wallet' }))
  await screen.findByText(/The wallet returned/)
  // Another plan's task is now asking for its own "cut".
  const otherPlan = 'c'.repeat(64)
  mock.api.engine = {
    prompts: [{ id: 'cut', requestId: 'r2', planId: otherPlan, sender: address, request }],
    active: { taskId: 'maintenance.upgrade-workbench', input: { planId: otherPlan }, runner: { running: false } },
  }
  mock.api.request.mockClear()
  page.rerender(<WalletRequest />)
  fireEvent.click(screen.getByRole('button', { name: 'Attach this transaction' }))
  await waitFor(() => expect(mock.api.request).toHaveBeenCalledWith('attach', { id: planId, actionId: 'cut', hash }))
  expect(mock.api.request).not.toHaveBeenCalledWith('respond', expect.anything())
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

it('requires a deployment wallet and a live connection before preparation', () => {
  route = '/?view=upgrade&adapter=system&scope=verifier&upgradeNode=verifier&target=' + address
  mock.api.system = {
    ...mock.api.system,
    connected: true,
    snapshot: {
      nodes: [{ id: 'verifier', address, kind: 'verifier', name: 'Verifier', state: { roles: { DEFAULT_ADMIN_ROLE: [address] } } }],
    },
  }
  const page = render(<Upgrade />, { wrapper })
  const button = screen.getByRole('button', { name: 'Prepare transactions' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Deployment wallet address'), { target: { value: address } })
  expect(button.disabled).toBe(false)
  mock.api.system = { ...mock.api.system, connected: false }
  page.rerender(<Upgrade />)
  expect(button.disabled).toBe(true)
})
it("does not offer to resume another plan under the current plan's summary, and links to the active one", () => {
  mock.api.engine.active = { taskId: 'maintenance.system-upgrade', input: { planId: 'd'.repeat(64) }, runner: { running: false } }
  render(<Signing record={record} adapter="diamond" />, { wrapper })
  expect(screen.queryByRole('button', { name: 'Continue task' })).toBeNull()
  expect(screen.getByText(/Another task is active/)).toBeTruthy()
  const link = screen.getByRole('link', { name: 'Open the active plan' }) as HTMLAnchorElement
  expect(link.getAttribute('href')).toBe(`/?view=upgrade&adapter=system&plan=${'d'.repeat(64)}&step=2`)
})

it('compiles the selected peripheral family before preparing its transaction sequence', async () => {
  route = '/?view=upgrade&adapter=system&scope=verifier&upgradeNode=verifier&target=' + address
  mock.api.system = {
    ...mock.api.system,
    connected: true,
    snapshot: { nodes: [{ id: 'verifier', address, kind: 'verifier', name: 'Verifier', state: { roles: { DEFAULT_ADMIN_ROLE: [address] } } }] },
  }
  mock.api.job.mockResolvedValue({ planId: 'b'.repeat(64) })
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
it('says so when a link was made on another deployment instead of opening it on the loaded one', async () => {
  route = '/?view=workspace&tab=contracts&node=core&deployment=base-vibe'
  mock.api.system = { ...mock.api.system, profile: { ...profiles[0], nodes: [] }, profiles, delta: [], history: [] }
  render(<Workspace onPrepare={vi.fn()} />, { wrapper })
  expect(screen.getByText('This link is for Vibe Base')).toBeTruthy()
  expect(screen.queryByRole('tab', { name: /Contracts/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Switch' }))
  await waitFor(() => expect(mock.api.request).toHaveBeenCalledWith('system/select', { id: 'base-vibe' }))
})
it('tells apart two deployments that share a name and version in the picker', () => {
  route = '/?view=workspace&tab=contracts&deployment=arbitrum-vibe'
  const both = profiles.slice(0, 2).map((p) => ({ ...p, version: '0.8.6' }))
  mock.api.system = { ...mock.api.system, profile: { ...both[0] }, profiles: both, delta: [], history: [] }
  render(<Workspace onPrepare={vi.fn()} />, { wrapper })
  expect((screen.getByRole('combobox', { name: 'Deployment' }) as HTMLInputElement).value).toBe('Vibe Arbitrum · 0.8.6 · Production')
})
