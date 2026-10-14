import { useWorkbench } from '../api'
import { confirmationFor, download, planChainId, short } from '../lib/state'
import type { ActiveTask, ContractNode, Plan, PlanRecord, WalletPrompt } from '../types'
import { chainLabel, chainName, CopyData, explorerTx, JsonView, planDeployment, readTxHash, saveTxHash, useTrackedRun } from './Common'
import { Accordion, Alert, Anchor, Badge, Button, Code, Group, Modal, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import { formatEther, formatUnits, toQuantity } from 'ethers'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<any>
      on?: (event: string, listener: (...args: any[]) => void) => void
      removeListener?: (event: string, listener: (...args: any[]) => void) => void
    }
  }
}
export async function connectWallet() {
  if (!window.ethereum) throw new Error('No browser wallet found. Open this app in a browser with a wallet extension, or choose Ledger / Safe.')
  const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' })
  return address as string
}
/** The browser wallet's account and chain, read without prompting and kept current through the wallet's events. */
function useWalletState() {
  const [state, setState] = useState<{ account?: string; chainId?: number }>({})
  useEffect(() => {
    const eth = window.ethereum
    if (!eth) return
    let live = true
    const read = async () => {
      try {
        const [accounts, chain] = await Promise.all([eth.request({ method: 'eth_accounts' }), eth.request({ method: 'eth_chainId' })])
        if (live) setState({ account: Array.isArray(accounts) ? accounts[0] : undefined, chainId: Number(chain) || undefined })
      } catch {}
    }
    void read()
    eth.on?.('accountsChanged', read)
    eth.on?.('chainChanged', read)
    return () => {
      live = false
      eth.removeListener?.('accountsChanged', read)
      eth.removeListener?.('chainChanged', read)
    }
  }, [])
  return state
}
const TASK_ADAPTERS: Record<string, 'diamond' | 'system'> = {
  'maintenance.upgrade-workbench': 'diamond',
  'maintenance.system-upgrade': 'system',
}
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const nodeName = (nodes: ContractNode[] | undefined, address?: string) => nodes?.find((n) => same(n.address, address))?.name
const gwei = (value: string) => `${Number(formatUnits(value, 'gwei')).toLocaleString(undefined, { maximumFractionDigits: 4 })} gwei`

export function WalletRequest() {
  const { engine, system, request, run, setError, refresh } = useWorkbench()
  const [signing, setSigning] = useState(false),
    [confirmStop, setConfirmStop] = useState(false),
    [lost, setLost] = useState<{ planId: string; actionId: string; label: string; hash: string; prefix: string } | null>(null)
  const prompt: WalletPrompt | undefined = engine?.prompts?.[0]
  const active = engine?.active || system?.active
  if (!prompt && !lost) return null
  const prefix = active && TASK_ADAPTERS[active.taskId] === 'system' ? 'system/' : ''
  async function sign() {
    if (!prompt || signing) return
    const planId = prompt.planId || active?.input?.planId || ''
    let hash = ''
    setSigning(true)
    setError('')
    try {
      const sender = await connectWallet()
      if (sender.toLowerCase() !== prompt.sender.toLowerCase()) throw new Error(`Switch your wallet to ${prompt.sender}`)
      const chainId = toQuantity(prompt.request.chainId)
      if ((await window.ethereum!.request({ method: 'eth_chainId' })).toLowerCase() !== chainId)
        await window.ethereum!.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
      const tx: Record<string, any> = { from: sender, data: prompt.request.data, ...(prompt.request.to ? { to: prompt.request.to } : {}) }
      for (const key of ['value', 'chainId', 'nonce', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'type'])
        if (prompt.request[key] !== undefined) tx[key] = toQuantity(prompt.request[key] as string | number)
      tx.gas = toQuantity(prompt.request.gasLimit)
      await request('claim', { requestId: prompt.requestId })
      hash = await window.ethereum!.request({ method: 'eth_sendTransaction', params: [tx] })
      if (planId) saveTxHash(planId, prompt.id, { hash, sender, nonce: prompt.request.nonce })
      await request('respond', { requestId: prompt.requestId, hash })
    } catch (error: any) {
      if (error.code === 4001) {
        try {
          await request('respond', { requestId: prompt.requestId, rejected: true })
        } catch {}
      }
      // The wallet broadcast but the app did not hear about it: keep the hash in front of the operator instead of a bare error.
      if (hash && planId) setLost({ planId, actionId: prompt.id, label: prompt.label || prompt.id, hash, prefix })
      else setError(error.message || String(error))
    } finally {
      setSigning(false)
      await refresh()
    }
  }
  const stop = () => {
    setConfirmStop(false)
    if (prompt) void run('Pausing wallet request', () => request('pause-wallet', { requestId: prompt.requestId }))
  }
  const attach = (item: NonNullable<typeof lost>) =>
    run('Attaching transaction', async () => {
      // Action ids repeat across plans ("cut"), so a live prompt only takes this hash when it is for the same plan.
      const live = engine?.prompts?.find((p) => p.id === item.actionId && p.planId === item.planId)
      const result = live
        ? await request('respond', { requestId: live.requestId, hash: item.hash })
        : await request(`${item.prefix}attach`, { id: item.planId, actionId: item.actionId, hash: item.hash })
      setLost(null)
      return result
    })
  const nodes = system?.snapshot?.nodes
  const req = prompt?.request
  const fee = req?.maxFeePerGas ?? req?.gasPrice
  return (
    <>
      {lost && (
        <Alert color="orange" title="The transaction may be on chain" withCloseButton onClose={() => setLost(null)}>
          <Stack gap="sm">
            <Text size="sm" className="break">
              The wallet returned {lost.hash}; the transaction may be on chain. The app did not record it for {lost.label}.
            </Text>
            <Group>
              <Button disabled={!!active?.runner?.running} onClick={() => void attach(lost)}>
                Attach this transaction
              </Button>
              {active?.runner?.running && (
                <Text size="xs" c="dimmed">
                  Available once the task has paused.
                </Text>
              )}
            </Group>
          </Stack>
        </Alert>
      )}
      {prompt && req && (
        <Alert color="orange" title={prompt.label || 'Wallet signature required'}>
          <Stack gap="sm">
            <dl className="prompt-facts">
              {(prompt.planId || prompt.step) && (
                <div>
                  <dt>Plan</dt>
                  <dd>
                    {prompt.planId ? <code>{prompt.planId.slice(0, 8)}</code> : '—'}
                    {prompt.step && prompt.of ? ` · step ${prompt.step} of ${prompt.of}` : ''}
                  </dd>
                </div>
              )}
              <div>
                <dt>Target</dt>
                <dd className="break">
                  {req.to ? (
                    <>
                      {nodeName(nodes, req.to) || prompt.target || 'Contract'} <code>{req.to}</code>
                    </>
                  ) : (
                    'Creates a contract'
                  )}
                </dd>
              </div>
              <div>
                <dt>Signer</dt>
                <dd className="break">
                  <code>{prompt.sender}</code> · {chainLabel(Number(req.chainId), system?.profiles)} · nonce {req.nonce}
                </dd>
              </div>
              <div>
                <dt>Value</dt>
                <dd>{formatEther(req.value || '0')}</dd>
              </div>
              <div>
                <dt>Gas limit</dt>
                <dd>{Number(req.gasLimit).toLocaleString()}</dd>
              </div>
              {fee !== undefined && (
                <div>
                  <dt>{req.maxFeePerGas !== undefined ? 'Max fee' : 'Gas price'}</dt>
                  <dd>
                    {gwei(fee)} · up to {formatEther(BigInt(fee) * BigInt(req.gasLimit))}
                  </dd>
                </div>
              )}
            </dl>
            <Accordion>
              <Accordion.Item value="request">
                <Accordion.Control>Exact transaction</Accordion.Control>
                <Accordion.Panel>
                  <JsonView value={req} />
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
            <Group>
              <Button disabled={signing || prompt.claimed} onClick={sign}>
                {signing || prompt.claimed ? 'Waiting for wallet' : 'Review in wallet'}
              </Button>
              <Button variant="default" onClick={() => (signing ? setConfirmStop(true) : stop())}>
                Stop waiting and recover
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      <Modal opened={confirmStop} onClose={() => setConfirmStop(false)} title="Stop waiting for the wallet?">
        <Text size="sm">This tab still has the request open in your wallet. If you still sign in the wallet, the app will need its hash.</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setConfirmStop(false)}>
            Keep waiting
          </Button>
          <Button color="red" onClick={stop}>
            Stop waiting
          </Button>
        </Group>
      </Modal>
    </>
  )
}

type StepState = 'done' | 'wallet' | 'safe' | 'submitted' | 'unresolved' | 'failed' | 'pending'
const STEP_LABELS: Record<StepState, { label: string; color: string; summary: string }> = {
  done: { label: 'Done', color: 'teal', summary: 'done' },
  wallet: { label: 'Waiting for wallet', color: 'orange', summary: 'waiting for the wallet' },
  safe: { label: 'Waiting for Safe', color: 'orange', summary: 'waiting for Safe' },
  submitted: { label: 'Awaiting confirmation', color: 'orange', summary: 'sent, not yet confirmed' },
  unresolved: { label: 'Outcome not recorded', color: 'orange', summary: 'outcome not recorded' },
  failed: { label: 'Reverted', color: 'red', summary: 'reverted' },
  pending: { label: 'Pending', color: 'gray', summary: 'not sent' },
}
interface ExecutionStep {
  id: string
  title: string
  phase?: string
  signer?: string
  hash?: string
  state: StepState
}
/** The plan's steps in order, from the task while one runs and from the saved plan otherwise, each with its journal outcome. */
export function executionSteps(record: PlanRecord, own: ActiveTask | null, prompts: WalletPrompt[] = []): ExecutionStep[] {
  const p = record.plan
  const declared: { id: string; title: string; phase?: string }[] =
    own?.plan ||
    (p.kind === 'peripheral'
      ? p.actions.map((a) => ({ id: a.id, title: a.label, phase: a.phase }))
      : [
          ...(p.deployments || []).map((d) => ({ id: d.id as string, title: `Deploy ${d.name}`, phase: 'deploy' })),
          { id: 'cut', title: 'Rehearse and execute the Diamond cut', phase: 'upgrade' },
          { id: 'verify', title: 'Verify the upgraded system', phase: 'verify' },
        ])
  const completed: string[] = own?.completedSteps || []
  const signer = (id: string) =>
    p.kind === 'peripheral' ? p.actions.find((a) => a.id === id)?.sender : id === 'verify' ? undefined : id === 'cut' ? p.snapshot.owner : p.deployer
  let current = false
  return declared.map((step) => {
    const j = record.journal?.[step.id]
    let state: StepState =
      record.status === 'verified' || completed.includes(step.id) || j?.status === 'confirmed'
        ? 'done'
        : j?.status === 'failed'
          ? 'failed'
          : j?.status === 'submitted'
            ? 'submitted'
            : j?.status === 'awaiting-signature'
              ? prompts.some((x) => x.id === step.id)
                ? 'wallet'
                : 'unresolved'
              : 'pending'
    // The first unfinished step is the one a waiting task is waiting on; with a Safe authority that wait is the Safe.
    if (state === 'pending' && !current && own?.status === 'waiting_external' && record.execution?.upgradeMode === 'safe' && step.phase !== 'deploy')
      state = 'safe'
    if (state !== 'done') current = true
    return { ...step, signer: signer(step.id), hash: j?.hash, state }
  })
}
export function stepSummary(steps: ExecutionStep[]) {
  const done = steps.filter((s) => s.state === 'done').length,
    next = steps.find((s) => s.state !== 'done')
  return `${done} of ${steps.length} steps done${next ? `; next: ${next.title} (${STEP_LABELS[next.state].summary})` : ''}`
}
/** Who can authorize the upgrade, as far as the plan and the inspected snapshot say. */
function authorityOf(p: Plan, nodes: ContractNode[] = []) {
  if (p.kind !== 'peripheral') {
    const a = p.snapshot?.authority
    return {
      address: p.snapshot?.owner,
      kind: a?.kind === 'safe' ? 'safe' : a?.kind === 'eoa' ? 'eoa' : a?.kind === 'unknown-contract' ? 'contract' : 'unknown',
      threshold: a?.threshold as number | undefined,
      owners: (a?.owners as string[] | undefined)?.length,
    }
  }
  const node = nodes.find((n) => same(n.address, p.authority))
  const owners = node?.state?.owners as string[] | undefined
  const kind =
    node && (node.kind === 'safe' || owners?.length) ? 'safe' : node && (node.status === 'no-code' || node.codeSize === 0) ? 'eoa' : 'unknown'
  const threshold = Number(node?.state?.threshold)
  return { address: p.authority, kind, threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : undefined, owners: owners?.length }
}
const MODES = { browser: 'Browser wallet', ledger: 'Ledger', safe: 'Safe · export batch' }

export function Signing({ record, adapter }: { record: PlanRecord; adapter: 'diamond' | 'system' }) {
  const { engine, system, busy, request } = useWorkbench()
  const run = useTrackedRun()
  const p = record.plan,
    profiles = system?.profiles || [],
    authority = authorityOf(p, system?.snapshot?.nodes)
  const upgradeModes = (
    authority.kind === 'safe'
      ? ['safe']
      : authority.kind === 'eoa'
        ? ['browser', 'ledger']
        : authority.kind === 'contract'
          ? []
          : ['browser', 'ledger', 'safe']
  ) as (keyof typeof MODES)[]
  const [deploymentMode, setDeploymentMode] = useState('browser'),
    [upgradeMode, setUpgradeMode] = useState<string>(upgradeModes[0] || 'browser'),
    [ledgerPath, setLedgerPath] = useState("m/44'/60'/0'/0/0"),
    [confirmation, setConfirmation] = useState(''),
    [cancelOpen, setCancelOpen] = useState(false),
    [pending, setPending] = useState<string | null>(null),
    [hash, setHash] = useState(''),
    [reconnectRpc, setReconnectRpc] = useState('')
  const wallet = useWalletState()
  // The authority can become known after mount (the workspace snapshot loads later); keep the choice within what it allows.
  useEffect(() => {
    if (upgradeModes.length && !upgradeModes.includes(upgradeMode as keyof typeof MODES)) setUpgradeMode(upgradeModes[0])
  }, [upgradeModes.join()])
  const prefix = adapter === 'system' ? 'system/' : '',
    chain = planChainId(p),
    deployment = planDeployment(p),
    expected = confirmationFor(p),
    status = adapter === 'system' ? system : engine,
    active = status?.active,
    journal = Object.values(record.journal || {}),
    unresolved = journal.filter((j) => j.status !== 'confirmed')
  const ownActive = active?.input?.planId === p.id ? active : null
  const verified = record.status === 'verified',
    ready = record.rehearsal?.status === 'passed'
  const steps = executionSteps(
      record,
      ownActive,
      engine?.prompts?.filter((x) => x.planId === p.id),
    ),
    summary = stepSummary(steps)
  const explorer =
    profiles.find((x) => x.id === deployment?.id)?.explorer ||
    profiles.find((x) => x.chainId === chain && x.explorer)?.explorer ||
    (system?.profile.chainId === chain ? system?.profile.explorer : undefined)
  const selected = pending || unresolved[0]?.id,
    stored = readTxHash(p.id, selected)
  // A hash this browser kept from the wallet fills the recovery form, so it does not have to be dug out of the wallet.
  useEffect(() => {
    if (stored && !hash) setHash(stored)
  }, [stored])
  const activeAdapter = active ? TASK_ADAPTERS[active.taskId] || (active.input?.planId ? adapter : undefined) : undefined
  const needsReconnect = !!ownActive && !!status?.needsReconnect
  const deployConfirmed = p.kind === 'peripheral' && record.journal?.[p.actions[0]?.id]?.status === 'confirmed'
  const safeBlocked =
    authority.kind === 'eoa'
      ? 'The authority is not a Safe.'
      : !deployConfirmed
        ? 'Available once the deployment transaction is confirmed.'
        : ownActive?.runner?.running
          ? 'Available once the task has paused.'
          : ''
  const browserRoles = [
    ...(deploymentMode === 'browser' ? [{ role: 'deployer', address: p.deployer }] : []),
    ...(upgradeMode === 'browser' && authority.address ? [{ role: 'upgrade authority', address: authority.address }] : []),
  ]
  const safeOf =
    authority.kind === 'safe' && authority.threshold && authority.owners
      ? ` (Safe ${authority.threshold} of ${authority.owners})`
      : authority.kind === 'safe'
        ? ' (Safe)'
        : ''
  return (
    <Stack>
      {!verified && ready && (
        <section className="panel">
          <Title order={3} size="h4" mb="md">
            Sign the reviewed upgrade
          </Title>
          <div className="two-columns">
            <Select
              label="Deploy with"
              description={p.deployer ? `Deploys as ${p.deployer}` : undefined}
              data={[
                { value: 'browser', label: MODES.browser },
                { value: 'ledger', label: MODES.ledger },
              ]}
              value={deploymentMode}
              onChange={(v) => setDeploymentMode(v || 'browser')}
              disabled={!!active}
              allowDeselect={false}
            />
            <Select
              label="Authorize upgrade with"
              description={authority.address ? `Authorizes as ${authority.address}${safeOf}` : undefined}
              data={upgradeModes.map((value) => ({ value, label: MODES[value] }))}
              value={upgradeMode}
              onChange={(v) => setUpgradeMode(v || upgradeModes[0] || 'browser')}
              disabled={!!active || !upgradeModes.length}
              allowDeselect={false}
            />
          </div>
          {!upgradeModes.length && (
            <Alert color="red" mt="md">
              The upgrade owner is a contract that is not a Safe. This workbench cannot authorize it.
            </Alert>
          )}
          {[deploymentMode, upgradeMode].includes('ledger') && (
            <TextInput
              mt="md"
              label="Ledger derivation path"
              value={ledgerPath}
              onChange={(e) => setLedgerPath(e.currentTarget.value)}
              disabled={!!active}
            />
          )}
          {!!browserRoles.length && (
            <ul className="check-list" aria-label="Wallet checks">
              {!window.ethereum ? (
                <li data-ok="false">No browser wallet in this browser.</li>
              ) : !wallet.account ? (
                <li data-ok="false">Browser wallet not connected. Connect it from the header to check it against the plan.</li>
              ) : (
                browserRoles.map(({ role, address }) => (
                  <li key={role} data-ok={same(wallet.account, address)}>
                    {same(wallet.account, address)
                      ? `Connected wallet ${short(wallet.account)} is the ${role}`
                      : `Connected wallet ${short(wallet.account)} is not the ${role} ${short(address)}`}
                  </li>
                ))
              )}
              {wallet.chainId !== undefined && (
                <li data-ok={wallet.chainId === chain}>
                  {wallet.chainId === chain
                    ? `Wallet is on ${chainLabel(chain, profiles)}`
                    : `Wallet is on ${chainLabel(wallet.chainId, profiles)}; this plan is on ${chainLabel(chain, profiles)}. It will be asked to switch.`}
                </li>
              )}
            </ul>
          )}
          <TextInput
            mt="md"
            label="Confirm deployment and plan"
            description={`Type ${expected}. Each wallet transaction still requires your signature.`}
            value={confirmation}
            onChange={(e) => setConfirmation(e.currentTarget.value)}
            autoComplete="off"
            disabled={!!active}
          />
          <Button
            mt="md"
            disabled={busy || !!active || !!p.blockers?.length || !upgradeModes.length || confirmation.trim() !== expected}
            onClick={() =>
              run('Starting upgrade', () =>
                request(`${prefix}execute`, { id: p.id, deploymentMode, upgradeMode, ledgerPath, confirmation: confirmation.trim() }),
              )
            }
          >
            Start upgrade
          </Button>
        </section>
      )}
      <section className="panel">
        <Group justify="space-between" align="baseline">
          <Title order={3} size="h4">
            Execution
          </Title>
          <Text size="sm" c="dimmed">
            {summary}
          </Text>
        </Group>
        <ol className="exec-steps">
          {steps.map((s) => {
            const href = s.hash ? explorerTx(explorer, s.hash) : undefined
            return (
              <li key={s.id} data-state={s.state}>
                <div className="exec-step-body">
                  <Text size="sm" fw={600}>
                    {s.title}
                  </Text>
                  {s.signer && (
                    <Text size="xs" c="dimmed" className="break">
                      Signer <code>{s.signer}</code>
                    </Text>
                  )}
                  {s.hash && (
                    <Group gap={8} wrap="nowrap">
                      <Code className="break">{s.hash}</Code>
                      {href && (
                        <Anchor href={href} target="_blank" rel="noopener noreferrer" size="xs">
                          Explorer ↗
                        </Anchor>
                      )}
                    </Group>
                  )}
                </div>
                <Badge variant="light" color={STEP_LABELS[s.state].color}>
                  {STEP_LABELS[s.state].label}
                </Badge>
              </li>
            )
          })}
        </ol>
        {active && !ownActive && (
          <Alert mt="sm">
            Another task is active.{' '}
            {activeAdapter && active.input?.planId ? (
              <Anchor
                component={Link}
                to={`?${new URLSearchParams({ view: 'upgrade', adapter: activeAdapter, plan: active.input.planId, step: '2' })}`}
              >
                Open the active plan
              </Anchor>
            ) : (
              'Finish or cancel it in ./symmio.'
            )}
          </Alert>
        )}
        {ownActive?.waitingFor && <Alert mt="sm">{ownActive.waitingFor}</Alert>}
        {ownActive?.lastError && (
          <Alert mt="sm" color="red">
            {ownActive.lastError}
          </Alert>
        )}
        {needsReconnect && (
          <div className="two-columns reconnect-row">
            <TextInput
              label="RPC endpoint (optional)"
              description="Leave empty to use the address book's RPC for this chain."
              value={reconnectRpc}
              onChange={(e) => setReconnectRpc(e.currentTarget.value)}
              placeholder="https://…"
            />
          </div>
        )}
        <Group mt="md">
          {ownActive &&
            (needsReconnect ? (
              <Button
                disabled={busy}
                onClick={() => run('Reconnecting', () => request(`${prefix}reconnect`, reconnectRpc.trim() ? { rpc: reconnectRpc.trim() } : {}))}
              >
                Reconnect to {chainName(chain, profiles)} to continue
              </Button>
            ) : (
              <>
                <Button
                  variant="default"
                  disabled={busy || ownActive.runner?.running}
                  onClick={() => run('Resuming upgrade', () => request(`${prefix}resume`, {}))}
                >
                  Continue task
                </Button>
                <Button color="red" variant="subtle" disabled={busy || ownActive.runner?.running} onClick={() => setCancelOpen(true)}>
                  Cancel task
                </Button>
              </>
            ))}
          {adapter === 'diamond' && record.safe && (
            <Button variant="default" onClick={() => download(record.safe!.transactionBuilder, `safe-${p.id.slice(0, 8)}.json`)}>
              Download Safe batch
            </Button>
          )}
          {adapter === 'system' && ready && (
            <>
              <Button
                variant="default"
                disabled={busy || !!safeBlocked}
                onClick={() =>
                  run('Exporting Safe calls', async () => {
                    download((await request(`system/safe?id=${p.id}`)).transactionBuilder, `safe-${p.scope}.json`)
                    return true
                  })
                }
              >
                Export Safe calls
              </Button>
              {safeBlocked && (
                <Text size="xs" c="dimmed">
                  {safeBlocked}
                </Text>
              )}
            </>
          )}
        </Group>
      </section>
      {adapter === 'diamond' && record.final && <FinalCut final={record.final} />}
      {!!unresolved.length && (
        <Accordion variant="contained" defaultValue={stored ? 'recovery' : null}>
          <Accordion.Item value="recovery">
            <Accordion.Control>Recover a pending transaction</Accordion.Control>
            <Accordion.Panel>
              <Stack>
                <Text size="sm" c="dimmed">
                  Attach the wallet hash. The signer, nonce, chain and exact calldata must match.
                </Text>
                <Select
                  label="Pending action"
                  data={unresolved.map((j) => ({ value: j.id, label: j.component || j.id }))}
                  value={selected}
                  onChange={(v) => {
                    setPending(v)
                    setHash(readTxHash(p.id, v || undefined))
                  }}
                  allowDeselect={false}
                />
                <TextInput
                  label="Transaction hash"
                  description={stored && hash === stored ? 'Filled in from the hash this browser received from the wallet.' : undefined}
                  value={hash}
                  onChange={(e) => setHash(e.currentTarget.value)}
                  placeholder="0x…"
                />
                <Button
                  disabled={!/^0x[\da-f]{64}$/i.test(hash) || busy}
                  onClick={() =>
                    run('Reconciling transaction', () => {
                      const actionId = selected!,
                        prompt = engine?.prompts?.find((x) => x.id === actionId && x.planId === p.id)
                      return prompt
                        ? request('respond', { requestId: prompt.requestId, hash })
                        : request(`${prefix}attach`, { id: p.id, actionId, hash })
                    })
                  }
                >
                  Reconcile transaction
                </Button>
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
      <Modal opened={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel this upgrade task?">
        <Text size="sm" fw={600} mb="xs">
          {summary}.
        </Text>
        <Text size="sm">This stops new work and reconciles submitted transactions. Confirmed transactions remain on chain.</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setCancelOpen(false)}>
            Keep task
          </Button>
          <Button
            color="red"
            onClick={() => {
              setCancelOpen(false)
              void run('Cancelling task', () => request(`${prefix}cancel`, {}))
            }}
          >
            Cancel task
          </Button>
        </Group>
      </Modal>
    </Stack>
  )
}

/** The cut as built from the deployed facet addresses: what the wallet or the Safe batch sends, grouped the way it is encoded. */
function FinalCut({
  final,
}: {
  final: { bindings?: Record<string, string>; changes?: { action: string; selector: string; to: string | null }[]; data?: string }
}) {
  const names = Object.entries(final.bindings || {})
  const groups = new Map<string, { action: string; to: string | null; selectors: string[] }>()
  for (const c of final.changes || []) {
    const key = `${c.action}:${c.to || ''}`
    if (!groups.has(key)) groups.set(key, { action: c.action, to: c.to, selectors: [] })
    groups.get(key)!.selectors.push(c.selector)
  }
  return (
    <section className="panel">
      <Title order={3} size="h4">
        Final Diamond cut
      </Title>
      <Text size="sm" c="dimmed" mt={4}>
        Built from the deployed facet addresses after the second rehearsal. This is what the wallet signs or the Safe batch carries.
      </Text>
      <div className="table-scroll">
        <Table mt="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Action</Table.Th>
              <Table.Th>Facet</Table.Th>
              <Table.Th>Functions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {[...groups.values()].map((g) => (
              <Table.Tr key={`${g.action}:${g.to}`}>
                <Table.Td>
                  <Badge variant="light" color={g.action === 'remove' ? 'red' : 'gray'}>
                    {g.action}
                  </Badge>
                </Table.Td>
                <Table.Td className="break">
                  {g.to ? (
                    <>
                      {names.find(([, a]) => same(a, g.to))?.[0] || 'Facet'} <code>{g.to}</code>
                    </>
                  ) : (
                    'Removed from the Diamond'
                  )}
                </Table.Td>
                <Table.Td>{g.selectors.length}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {final.data && (
        <Accordion mt="sm">
          <Accordion.Item value="calldata">
            <Accordion.Control>Cut calldata</Accordion.Control>
            <Accordion.Panel>
              <Code block className="json-code">
                {final.data}
              </Code>
              <CopyData value={final.data} />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
    </section>
  )
}
