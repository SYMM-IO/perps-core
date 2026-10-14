import { nextStep, useWorkbench } from '../api'
import {
  draftKey,
  download,
  familyName,
  isDiamondPlan,
  planBlock,
  planChainId,
  planState,
  planTarget,
  pretty,
  readDraft,
  short,
  UPGRADEABLE,
  upgradeParams,
} from '../lib/state'
import type { ContractNode, DiamondDraft, DiamondPlan, EngineStatus, ErrorCode, PlanRecord } from '../types'
import {
  Address,
  chainLabel,
  CopyData,
  Empty,
  EnvironmentBadge,
  errorCode,
  ErrorCodeContext,
  JsonView,
  KindTile,
  planDeployment,
  useTrackedRun,
} from './Common'
import { connectWallet, Signing } from './Signing'
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  FileButton,
  Group,
  Select,
  Stack,
  Stepper,
  Table,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { isAddress } from 'ethers'
import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

/** Diamond upgrade and introspection functions; the server refuses to remove them. */
const PROTECTED = ['0x1f931c1c', '0x7a0ed627']
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
/** Failures with one obvious way forward, and the button that takes it. */
const ACTIONS: Partial<Record<ErrorCode, string>> = {
  'stale-source': 'Compile again',
  'stale-plan': 'Prepare a new plan',
  'nonce-changed': 'Prepare a new plan',
  'stale-fingerprint': 'Prepare a new plan',
  'chain-mismatch': 'Back to Prepare',
}

export function Upgrade() {
  const [params, setParams] = useSearchParams()
  const { engine, system, request, busy, run, job, errors, dismiss } = useWorkbench()
  const adapter = params.get('adapter') === 'system' ? 'system' : 'diamond',
    planId = params.get('plan') || '',
    scope = params.get('scope') || 'core',
    target = params.get('target') || '',
    step = Math.max(0, Math.min(2, Number(params.get('step')) || 0))
  const nodeId = params.get('upgradeNode') || params.get('node') || scope
  // Wide screens put the steps in a side rail, so the work area can use the rest of the width.
  const wide = useMediaQuery('(min-width: 901px)', true)
  const [code, setCode] = useState('')
  const recordQuery = useQuery({
    queryKey: ['plan', adapter, planId],
    queryFn: () => request<PlanRecord>(`${adapter === 'system' ? 'system/' : ''}plan?id=${planId}`),
    enabled: !!planId,
    refetchInterval: 1500,
    retry: false,
  })
  const record = recordQuery.data || (adapter === 'system' && system?.plan?.plan.id === planId ? system.plan : undefined)
  const go = (values: Record<string, string>) =>
    setParams((previous) => {
      const p = new URLSearchParams(previous)
      for (const [k, v] of Object.entries(values)) v ? p.set(k, v) : p.delete(k)
      return p
    })
  const prepared = (id: string) => go({ plan: id, step: '1' })
  // Operations started here report their error code, so the obvious next step can be offered beside the error.
  const track = <T,>(label: string, fn: () => Promise<T>) =>
    run(label, async () => {
      setCode('')
      try {
        return await fn()
      } catch (error) {
        setCode(errorCode(error))
        throw error
      }
    })
  if (!target && !planId) {
    const choices = (system?.snapshot?.nodes || system?.profile.nodes || [])
      .filter((n) => UPGRADEABLE.includes(n.kind))
      .sort((a, b) => UPGRADEABLE.indexOf(a.kind) - UPGRADEABLE.indexOf(b.kind) || a.name.localeCompare(b.name))
    return (
      <Stack gap="sm" className="upgrade-view">
        <div>
          <Title order={1} size="h3">
            Upgrade a contract
          </Title>
          <Text size="sm" c="dimmed">
            {system?.profile.name
              ? // Two deployments can share a name and differ in environment, so one that is not production says so.
                `${system.profile.name}${system.profile.environment && system.profile.environment !== 'Production' ? ` (${system.profile.environment})` : ''} · Chain ${system.profile.chainId}`
              : 'Choose what to upgrade.'}
          </Text>
        </div>
        {choices.length ? (
          <div className="upgrade-choices">
            {choices.map((n) => (
              <UnstyledButton key={n.id} className="upgrade-choice" onClick={() => setParams((p) => upgradeParams(p, n))}>
                <KindTile kind={n.kind} />
                <span className="upgrade-choice-text">
                  <b>{n.name}</b>
                  <small>
                    {familyName(n.kind)}
                    {n.strategy ? ` · ${n.strategy}` : ''}
                  </small>
                </span>
                <code>{short(n.address)}</code>
                <ArrowRight size={16} className="upgrade-choice-go" aria-hidden />
              </UnstyledButton>
            ))}
          </div>
        ) : (
          <Empty title="Nothing to upgrade in this deployment" action={<Button onClick={() => go({ view: 'workspace' })}>Open workspace</Button>}>
            This workspace has no contract with an upgrade path here. Choose another deployment in Workspace.
          </Empty>
        )}
      </Stack>
    )
  }
  const shownError = (errors || []).find((e) => e.code && ACTIONS[e.code]),
    failure = (code && ACTIONS[code] ? code : shownError?.code) as ErrorCode | undefined
  function takeNextStep() {
    setCode('')
    if (shownError) void dismiss?.([shownError])
    if (failure === 'stale-source') void track('Compiling the current checkout', () => job('compile', { scope: record?.plan.scope || scope }))
    else go({ step: '0', plan: '' })
  }
  const p = record?.plan
  const deployConfirmed = !!p && !isDiamondPlan(p) && record?.journal?.[p.actions[0]?.id]?.status === 'confirmed'
  const ownRunning = !!p && system?.active?.input?.planId === p.id && !!system.active.runner?.running
  const verifyBlocked = !deployConfirmed
    ? 'Available once the deployment transaction is confirmed.'
    : ownRunning
      ? 'Available once the task has paused.'
      : ''
  return (
    <ErrorCodeContext.Provider value={setCode}>
      <Stack gap="lg" className="upgrade-view">
        <Group justify="space-between">
          <div>
            <Title order={1} size="h3">
              {familyName(record?.plan.scope || scope)} upgrade
            </Title>
            <Text size="sm" c="dimmed">
              Prepare, rehearse, then sign the reviewed transactions.
            </Text>
          </div>
          <Button variant="subtle" onClick={() => go({ view: 'workspace' })}>
            ← Workspace
          </Button>
        </Group>
        <ContextBar record={record} scope={scope} address={target} />
        <div className="upgrade-layout">
          <aside className="upgrade-rail" aria-label="Upgrade steps">
            <Stepper
              active={Math.min(step, 2)}
              onStepClick={(index) => go({ step: String(index) })}
              size="sm"
              orientation={wide ? 'vertical' : 'horizontal'}
            >
              <Stepper.Step label="Prepare" description="Target and changes" />
              <Stepper.Step label="Rehearse" description="Local fork" allowStepSelect={!!record} />
              <Stepper.Step
                label="Execute"
                description="Wallet, Ledger or Safe"
                allowStepSelect={!!record && record.rehearsal?.status === 'passed'}
              />
            </Stepper>
          </aside>
          <Stack gap="md" className="upgrade-main">
            {recordQuery.error && <Alert color="red">{recordQuery.error.message}</Alert>}
            {failure && (
              <Alert color="orange" variant="light" className="next-step">
                <Group justify="space-between" wrap="wrap" gap="sm">
                  <Text size="sm">{nextStep(failure)}</Text>
                  <Button size="compact-sm" variant="default" disabled={busy} onClick={takeNextStep}>
                    {ACTIONS[failure]}
                  </Button>
                </Group>
              </Alert>
            )}
            {step === 0 &&
              (adapter === 'diamond' ? (
                <DiamondPrepare key={`${scope}:${target}`} scope={scope} target={target} onPrepared={prepared} />
              ) : (
                <PeripheralPrepare key={`${system?.profile.id}:${nodeId}`} scope={scope} nodeId={nodeId} onPrepared={prepared} />
              ))}
            {step > 0 && !record && (
              <Empty
                title={recordQuery.isFetching ? 'Loading saved plan…' : 'No prepared plan'}
                action={
                  <Button variant="default" onClick={() => go({ step: '0' })}>
                    Prepare upgrade
                  </Button>
                }
              />
            )}
            {step > 0 && record && (
              <>
                <PlanSummary record={record} />
                {step === 1 ? (
                  <>
                    <section className="panel">
                      <Group justify="space-between">
                        <Title order={3} size="h4">
                          Fork rehearsal
                        </Title>
                        {record.rehearsal && (
                          <Badge color={record.rehearsal.status === 'passed' ? 'teal' : 'red'} variant="light">
                            {record.rehearsal.status}
                          </Badge>
                        )}
                      </Group>
                      <Text size="sm" c="dimmed" mt="sm">
                        Deploy and apply this exact plan on an isolated local fork, then verify the resulting configuration. No live upgrade is sent.
                      </Text>
                      {record.rehearsal?.error && (
                        <Alert color="red" mt="md">
                          {record.rehearsal.error}
                        </Alert>
                      )}
                      {record.rehearsal?.status === 'passed' && (
                        <Stack mt="md" gap="xs">
                          {record.rehearsal.checks?.map((c) => (
                            <Text size="sm" key={c}>
                              ✓ {c}
                            </Text>
                          ))}
                          <Text size="sm">Passed at block {record.rehearsal.blockNumber}</Text>
                          {record.rehearsal.limitations?.map((l, i) => (
                            <Text size="xs" c="dimmed" key={i}>
                              {l}
                            </Text>
                          ))}
                          <Accordion>
                            <Accordion.Item value="evidence">
                              <Accordion.Control>Rehearsal evidence</Accordion.Control>
                              <Accordion.Panel>
                                <JsonView value={record.rehearsal} />
                              </Accordion.Panel>
                            </Accordion.Item>
                          </Accordion>
                        </Stack>
                      )}
                      <Group mt="md">
                        <Button
                          disabled={busy || !!record.plan.blockers?.length || !!engine?.active || !!system?.active}
                          onClick={() =>
                            track('Rehearsing upgrade', () =>
                              adapter === 'system' ? job('system/rehearse', { id: record.plan.id }, true) : job('rehearse', { id: record.plan.id }),
                            )
                          }
                        >
                          Run fork rehearsal
                        </Button>
                        {record.rehearsal?.status === 'passed' && (
                          <Button variant="default" onClick={() => go({ step: '2' })}>
                            Review execution →
                          </Button>
                        )}
                        <Button
                          variant="subtle"
                          disabled={busy || (adapter === 'system' && record.rehearsal?.status !== 'passed')}
                          onClick={() =>
                            track('Exporting review bundle', async () => {
                              download(
                                await request<unknown>(`${adapter === 'system' ? 'system/' : ''}export?id=${record.plan.id}`),
                                `${scope}-${record.plan.id.slice(0, 8)}.json`,
                              )
                              return true
                            })
                          }
                        >
                          Download review bundle
                        </Button>
                      </Group>
                    </section>
                  </>
                ) : (
                  <>
                    {record.rehearsal?.status === 'passed' || record.status === 'verified' ? (
                      <Signing key={`${adapter}:${record.plan.id}`} record={record} adapter={adapter} />
                    ) : (
                      <Empty title="Rehearse this plan before signing" action={<Button onClick={() => go({ step: '1' })}>Run rehearsal</Button>} />
                    )}
                    {adapter === 'system' && record.rehearsal?.status === 'passed' && record.status !== 'verified' && (
                      <Group gap="sm">
                        <Button
                          variant="default"
                          disabled={busy || !!verifyBlocked}
                          onClick={() => track('Verifying executed upgrade', () => job('system/verify', { id: record.plan.id }, true))}
                        >
                          Verify executed upgrade
                        </Button>
                        {verifyBlocked && (
                          <Text size="xs" c="dimmed">
                            {verifyBlocked}
                          </Text>
                        )}
                      </Group>
                    )}
                  </>
                )}
              </>
            )}
          </Stack>
        </div>
      </Stack>
    </ErrorCodeContext.Provider>
  )
}

/** Names the exact deployment, chain, target, plan and block every step on this page acts on. */
function ContextBar({ record, scope, address }: { record?: PlanRecord; scope: string; address: string }) {
  const { system, engine } = useWorkbench()
  const profiles = system?.profiles || [],
    profile = system?.profile,
    p = record?.plan
  const deployment =
    (p && planDeployment(p)) ||
    (profile ? { id: profile.id, name: profile.name, environment: profile.environment, chainId: profile.chainId } : undefined)
  const chain = p ? planChainId(p) : profile?.chainId,
    target = p ? planTarget(p) : address,
    name = system?.snapshot?.nodes.find((n) => same(n.address, target))?.name || familyName(p?.scope || scope)
  const block = p
    ? planBlock(p)
    : same(engine?.snapshot?.target, address) && engine?.snapshot?.chainId === chain
      ? engine?.snapshot?.blockNumber
      : undefined
  const elsewhere = !!p && !!profile && !!deployment && deployment.id !== profile.id
  return (
    <div className="context-bar" role="region" aria-label="Upgrade context">
      <span className="context-deployment">{deployment?.name || 'Unknown deployment'}</span>
      <EnvironmentBadge environment={deployment?.environment} />
      <span className="chip">{chainLabel(chain, profiles)}</span>
      {target && (
        <span className="chip" title={target}>
          {name} <b>{short(target)}</b>
        </span>
      )}
      {p && (
        <span className="chip">
          Plan <b>{p.id.slice(0, 8)}</b>
        </span>
      )}
      {block !== undefined && (
        <span className="chip">
          Block <b>{block.toLocaleString()}</b>
        </span>
      )}
      {elsewhere && (
        <span className="chip" data-tone="warn">
          The workspace shows {profile!.name}
        </span>
      )}
    </div>
  )
}

function DiamondPrepare({ scope, target, onPrepared }: { scope: string; target: string; onPrepared: (id: string) => void }) {
  const { engine, system, request, job, busy } = useWorkbench()
  const run = useTrackedRun()
  const profiles = system?.profiles || []
  const defaultRpc = system?.profile.rpc || profiles.find((p) => p.id === system?.profile.id)?.rpc || ''
  const [rpc, setRpc] = useState(defaultRpc),
    [address, setAddress] = useState(target),
    [editing, setEditing] = useState(false)
  const snapshot = engine?.snapshot,
    expectedChain = system?.profile.chainId,
    sameTarget = same(snapshot?.target, address),
    sameChain = !!snapshot && (!expectedChain || snapshot.chainId === expectedChain)
  // The engine keeps its own connection, so a Diamond read on another chain at the same address must not pass for this deployment.
  // A snapshot restored after a restart is for reading only; the server prepares from a live inspection.
  const ready = sameTarget && sameChain && !snapshot?.restored && (engine?.build?.scope || 'core') === scope && !!engine?.build
  const wrongChain = sameTarget && !!snapshot && !sameChain
  const node = system?.snapshot?.nodes?.find((n) => same(n.address, address))
  // The workspace already holds a live connection to this deployment; reuse it unless the operator overrides it.
  const shared = !!system?.connected && !editing
  const inspectedAt = snapshot?.inspectedAt
  return (
    <Stack>
      <section className="panel">
        <Group justify="space-between" align="start" wrap="nowrap">
          <div>
            <Title order={3} size="h4">
              {node?.name || familyName(scope)}
            </Title>
            <Address value={address} />
            <Text size="xs" c="dimmed" mt={4}>
              {shared ? 'Using the workspace connection' : rpc ? `RPC ${rpc.replace(/^https?:\/\//, '').split(/[/?]/)[0]}` : 'No RPC endpoint set'}
            </Text>
          </div>
          <Button
            variant="subtle"
            color="gray"
            size="compact-sm"
            aria-expanded={editing}
            onClick={() => {
              if (editing) {
                setAddress(target)
                setRpc(defaultRpc)
              }
              setEditing(!editing)
            }}
          >
            {editing ? 'Use defaults' : 'Change target or RPC'}
          </Button>
        </Group>
        {editing && (
          <div className="two-columns" style={{ marginTop: 12 }}>
            <TextInput label="Diamond address" value={address} onChange={(e) => setAddress(e.currentTarget.value)} disabled={busy} />
            <TextInput label="RPC endpoint" value={rpc} onChange={(e) => setRpc(e.currentTarget.value)} disabled={busy} />
          </div>
        )}
        <Group mt="md">
          <Button
            disabled={busy || !isAddress(address) || (!shared && !rpc)}
            onClick={() =>
              run('Inspecting target and compiling source', async () => {
                await request('connect', shared ? { target: address } : { rpc, target: address })
                return job('compile', { scope })
              })
            }
          >
            Inspect & compile
          </Button>
          <FileButton
            accept="application/json,.json"
            onChange={(file) => {
              if (file) void run('Importing baseline', () => file.text().then((text) => request('baseline', JSON.parse(text))))
            }}
          >
            {(props) => (
              <Button {...props} variant="default" disabled={busy}>
                Import deployed baseline
              </Button>
            )}
          </FileButton>
          <Button
            variant="subtle"
            disabled={busy || !engine?.build}
            onClick={() =>
              run('Exporting build', async () => {
                download(await request('build'), 'symmio-build.json')
                return true
              })
            }
          >
            Export build
          </Button>
        </Group>
        {engine?.baseline && (
          <Text size="xs" mt="sm" c="dimmed">
            Baseline {engine.baseline.digest.slice(0, 12)}
          </Text>
        )}
        {wrongChain && (
          <Alert color="orange" mt="md">
            Connected to {chainLabel(snapshot!.chainId, profiles)}; this deployment is on {chainLabel(expectedChain, profiles)}. Inspect & compile
            again.
          </Alert>
        )}
        {ready && (
          <div className="target-summary">
            <Text size="sm">
              {chainLabel(snapshot!.chainId, profiles)} · Block {snapshot!.blockNumber.toLocaleString()}
              {inspectedAt ? ` · ${new Date(inspectedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : ''}
            </Text>
            <Text size="sm">
              {snapshot!.facets.length} facets · {Object.keys(snapshot!.map).length} functions
            </Text>
            <Text size="xs" c="dimmed">
              Upgrade owner · {snapshot!.authority.kind}
            </Text>
            <Address value={snapshot!.owner} />
            <Text size="xs" c="dimmed">
              Source {engine!.build!.source.commit.slice(0, 12)} · Build {engine!.build!.digest.slice(0, 12)}
            </Text>
          </div>
        )}
      </section>
      {ready ? (
        <FacetSelection
          key={draftKey(snapshot!.chainId, address, scope, engine!.build!.digest)}
          engine={engine!}
          scope={scope}
          nodes={system?.snapshot?.nodes || []}
          initial={
            (system?.comparison[system.snapshot?.nodes.find((n) => same(n.address, address))?.id || ''] as any)?.facets
              ?.filter((f: any) => f.state !== 'matching')
              .map((f: any) => f.name) || []
          }
          onPrepared={onPrepared}
        />
      ) : (
        <Text size="sm" c="dimmed">
          Inspect & compile reads this Diamond and builds the checkout, then lists the facets you can change. The plan records the exact target,
          source and compiler inputs.
        </Text>
      )}
    </Stack>
  )
}
interface FacetGroup {
  address: string
  name: string
  selectors: string[]
}
/** Selectors grouped by the facet that serves them now, named from the workspace's inspection where it knows the facet. */
function groupByFacet(selectors: string[], map: Record<string, string>, nodes: ContractNode[]): FacetGroup[] {
  const groups = new Map<string, FacetGroup>()
  for (const s of selectors) {
    const address = map[s] || ''
    if (!groups.has(address))
      groups.set(address, { address, name: nodes.find((n) => same(n.address, address))?.name || `Facet ${short(address)}`, selectors: [] })
    groups.get(address)!.selectors.push(s)
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
}
function FacetSelection({
  engine,
  scope,
  nodes,
  initial,
  onPrepared,
}: {
  engine: EngineStatus
  scope: string
  nodes: ContractNode[]
  initial: string[]
  onPrepared: (id: string) => void
}) {
  const { request, busy } = useWorkbench()
  const run = useTrackedRun()
  const key = draftKey(engine.snapshot!.chainId, engine.snapshot!.target, scope, engine.build!.digest)
  const [draft, setDraft] = useState<DiamondDraft>(() =>
      readDraft(sessionStorage, key, { selected: initial, removals: [], deployer: '', mode: 'patch' }),
    ),
    [search, setSearch] = useState(''),
    [removalSearch, setRemovalSearch] = useState(''),
    [storageError, setStorageError] = useState('')
  function update(patch: Partial<DiamondDraft>) {
    const next = { ...draft, ...patch }
    setDraft(next)
    try {
      sessionStorage.setItem(key, JSON.stringify(next))
    } catch {
      setStorageError('Could not retain this draft. Keep this page open until you download the prepared plan.')
    }
  }
  const catalog = engine.build!.catalog,
    map = engine.snapshot!.map,
    reconcile = draft.mode === 'reconcile'
  const facets = catalog.filter(
      (f) => f.kind === 'facet' && `${f.name} ${Object.values(f.selectors).join(' ')}`.toLowerCase().includes(search.toLowerCase()),
    ),
    known: Record<string, string> = Object.assign({}, ...catalog.map((f) => f.selectors))
  // A live selector a selected facet also provides is kept (replaced), so it cannot be removed.
  const covered = new Map<string, string>()
  for (const f of catalog) if (draft.selected.includes(f.name)) for (const s of Object.keys(f.selectors)) covered.set(s.toLowerCase(), f.name)
  const live = Object.keys(map)
      .filter((s) => !PROTECTED.includes(s))
      .sort(),
    required = live.filter((s) => !covered.has(s)),
    acknowledged = required.length === draft.removals.length && required.every((s) => draft.removals.includes(s))
  const groups = groupByFacet(reconcile ? required : live, map, nodes)
  const query = removalSearch.trim().toLowerCase(),
    matches = (g: FacetGroup, s: string) => !query || `${s} ${known[s] || ''} ${g.name} ${g.address}`.toLowerCase().includes(query)
  function toggleFacet(name: string, checked: boolean) {
    const selected = checked ? [...new Set([...draft.selected, name])] : draft.selected.filter((v) => v !== name)
    const own = new Set(Object.keys(catalog.find((f) => f.name === name)?.selectors || {}).map((s) => s.toLowerCase()))
    update({ selected, removals: checked && !reconcile ? draft.removals.filter((s) => !own.has(s)) : draft.removals })
  }
  const toggleRemoval = (value: string, checked: boolean) =>
    update({ removals: checked ? [...new Set([...draft.removals, value])] : draft.removals.filter((v) => v !== value) })
  const groupList = (render: (g: FacetGroup, s: string) => ReactNode) =>
    groups.map((g) => {
      const shown = g.selectors.filter((s) => matches(g, s))
      return shown.length ? (
        <div className="removal-group" key={g.address}>
          <Text size="sm" fw={600}>
            {g.name}{' '}
            <Text span size="xs" c="dimmed">
              · {g.selectors.length} {g.selectors.length === 1 ? 'function' : 'functions'}
            </Text>
          </Text>
          {shown.map((s) => render(g, s))}
        </div>
      ) : null
    })
  const removalSearchInput = (
    <TextInput
      type="search"
      size="xs"
      mb="sm"
      aria-label="Find a function to remove"
      placeholder="Find by selector, function or facet"
      value={removalSearch}
      onChange={(e) => setRemovalSearch(e.currentTarget.value)}
    />
  )
  return (
    <Stack>
      {storageError && <Alert color="red">{storageError}</Alert>}
      <Group grow align="end">
        <TextInput type="search" label="Find facets or functions" value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
        <Select
          label="Upgrade scope"
          value={draft.mode}
          onChange={(v) => update({ mode: v || 'patch', removals: [] })}
          allowDeselect={false}
          data={[
            { value: 'patch', label: 'Patch selected facets' },
            { value: 'reconcile', label: 'Reconcile all functions' },
          ]}
        />
      </Group>
      <Text size="sm" c="dimmed">
        {reconcile
          ? 'Every live function the selected facets do not provide is removed. Review the removals below and acknowledge them.'
          : 'Unselected functions remain unchanged.'}
      </Text>
      <section className="panel">
        <Group justify="space-between" mb="sm">
          <Title order={3} size="h4">
            Facets
          </Title>
          <Text size="sm" c="dimmed">
            {draft.selected.length} selected
          </Text>
        </Group>
        <div className="bounded-list">
          {facets.length ? (
            facets.map((f) => (
              <div className="facet-item" key={f.name}>
                <Checkbox
                  label={f.name}
                  checked={draft.selected.includes(f.name)}
                  onChange={(e) => toggleFacet(f.name, e.currentTarget.checked)}
                  disabled={busy}
                />
                <Text size="xs" c="dimmed">
                  {Object.keys(f.selectors).length} functions{f.dependencies.length ? ` · ${f.dependencies.length} libraries` : ''}
                </Text>
                <Accordion variant="default">
                  <Accordion.Item value="details">
                    <Accordion.Control>Functions & dependencies</Accordion.Control>
                    <Accordion.Panel>
                      <JsonView value={{ functions: f.selectors, libraries: f.dependencies }} />
                    </Accordion.Panel>
                  </Accordion.Item>
                </Accordion>
              </div>
            ))
          ) : (
            <Empty title="No matching facets" />
          )}
        </div>
      </section>
      {reconcile ? (
        <section className="panel" aria-label="Functions this cut removes">
          <Group justify="space-between" mb="sm">
            <Title order={3} size="h4">
              Functions this cut removes
            </Title>
            <Text size="sm" c={required.length ? 'red' : 'dimmed'} fw={required.length ? 600 : undefined}>
              {required.length} from {groups.length} {groups.length === 1 ? 'facet' : 'facets'}
            </Text>
          </Group>
          {required.length ? (
            <>
              {removalSearchInput}
              <div className="bounded-list">
                {groupList((_g, s) => (
                  <div className="removal-row" key={s}>
                    <code>{s}</code>
                    <span>{known[s] || 'Unknown function'}</span>
                  </div>
                ))}
              </div>
              <Checkbox
                mt="md"
                checked={acknowledged}
                disabled={busy}
                onChange={(e) => update({ removals: e.currentTarget.checked ? required : [] })}
                label={`I reviewed these ${required.length} removals from ${groups.map((g) => g.name).join(', ')}`}
              />
            </>
          ) : (
            <Text size="sm" c="dimmed">
              The selected facets provide every live function, so nothing is removed.
            </Text>
          )}
          <Text size="xs" c="dimmed" mt="sm">
            Diamond upgrade and introspection functions are never removed.
          </Text>
        </section>
      ) : (
        <Accordion variant="contained">
          <Accordion.Item value="removals">
            <Accordion.Control>Explicit function removals ({draft.removals.length})</Accordion.Control>
            <Accordion.Panel>
              <Text size="sm" c="dimmed" mb="sm">
                Diamond upgrade and introspection functions cannot be removed. Functions a selected facet provides are kept.
              </Text>
              {removalSearchInput}
              <Stack gap="xs" className="bounded-list">
                {groupList((_g, s) => {
                  const keptBy = covered.get(s)
                  return (
                    <Checkbox
                      key={s}
                      label={`${s} ${known[s] || 'Unknown function'}${keptBy ? ` · kept by ${keptBy}` : ''}`}
                      checked={!keptBy && draft.removals.includes(s)}
                      onChange={(e) => toggleRemoval(s, e.currentTarget.checked)}
                      disabled={busy || !!keptBy}
                    />
                  )
                })}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
      <section className="panel">
        <TextInput
          label="Deployment signer address"
          description="Deploys the new libraries and facets. The Diamond owner authorizes the cut."
          value={draft.deployer}
          onChange={(e) => update({ deployer: e.currentTarget.value })}
          error={draft.deployer && !isAddress(draft.deployer) ? 'Enter a valid Ethereum address' : undefined}
          disabled={busy}
        />
        <Button
          variant="subtle"
          mt="sm"
          disabled={busy}
          onClick={() =>
            run('Connecting wallet', async () => {
              update({ deployer: await connectWallet() })
              return true
            })
          }
        >
          Use wallet address
        </Button>
      </section>
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          {reconcile && required.length && !acknowledged ? 'Acknowledge the removals to prepare.' : 'Draft saved for this chain, target and source.'}
        </Text>
        <Button
          disabled={
            busy ||
            !isAddress(draft.deployer) ||
            !(draft.selected.length || draft.removals.length) ||
            (reconcile && !!required.length && !acknowledged)
          }
          onClick={() =>
            run('Preparing Diamond upgrade', async () => {
              const record = await request('prepare', { ...draft })
              onPrepared(record.plan.id)
              return record
            })
          }
        >
          Prepare upgrade plan
        </Button>
      </Group>
    </Stack>
  )
}
function PeripheralPrepare({ scope, nodeId, onPrepared }: { scope: string; nodeId: string; onPrepared: (id: string) => void }) {
  const { system, request, job, busy, setError } = useWorkbench()
  const run = useTrackedRun()
  const node = system?.snapshot?.nodes.find((n) => n.id === nodeId)
  const storageKey = `workbench-component-draft:${system?.profile.chainId}:${node?.address || nodeId}:${scope}`
  const [draft, setDraft] = useState(() => {
      try {
        return (
          JSON.parse(sessionStorage.getItem(storageKey) || 'null') || {
            deployer: '',
            authority: node?.state.roles?.DEFAULT_ADMIN_ROLE?.[0] || system?.snapshot?.nodes.find((n) => n.kind === 'core')?.state.owner || '',
          }
        )
      } catch {
        return { deployer: '', authority: '' }
      }
    }),
    [baseline, setBaseline] = useState('')
  const update = (patch: Record<string, string>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      setError('Could not retain this draft. Keep this page open until the plan is saved.')
    }
  }
  if (!node) return <Empty title="Inspect this deployment first">A verified snapshot is needed to prepare its replacement and wiring.</Empty>
  return (
    <Stack>
      <section className="panel">
        {!system?.connected && <Alert mb="md">Saved snapshot. Return to Workspace and Inspect live before preparing.</Alert>}
        <Title order={3} size="h4" mb="sm">
          {node.name}
        </Title>
        <Address value={node.address} />
        <div className="two-columns">
          <TextInput
            label="Deployment wallet address"
            value={draft.deployer}
            onChange={(e) => update({ deployer: e.currentTarget.value })}
            disabled={busy}
          />
          <TextInput
            label="Configuration and upgrade authority"
            description="Owner, admin or Safe with the required roles."
            value={draft.authority}
            onChange={(e) => update({ authority: e.currentTarget.value })}
            disabled={busy}
          />
        </div>
        <Button
          variant="subtle"
          mt="sm"
          disabled={busy}
          onClick={() =>
            run('Connecting wallet', async () => {
              update({ deployer: await connectWallet() })
              return true
            })
          }
        >
          Use wallet address
        </Button>
      </section>
      <Group>
        <FileButton
          accept="application/json,.json"
          onChange={(file) => {
            if (file)
              void run('Importing component baseline', async () => {
                const result = await request('system/baseline', JSON.parse(await file.text()))
                setBaseline(`${result.scope} baseline imported`)
                return result
              })
          }}
        >
          {(props) => (
            <Button {...props} variant="default" disabled={busy}>
              Import deployed baseline
            </Button>
          )}
        </FileButton>
        <Button
          variant="subtle"
          disabled={busy}
          onClick={() =>
            run('Exporting component build', async () => {
              await job('compile', { scope })
              download(await request(`system/build?scope=${scope}`), `${scope}-build.json`)
              return true
            })
          }
        >
          Export component build
        </Button>
        {baseline && (
          <Text size="xs" c="dimmed">
            {baseline}
          </Text>
        )}
      </Group>
      <Button
        disabled={busy || !isAddress(draft.deployer) || !isAddress(draft.authority) || system?.connected === false}
        onClick={() =>
          run('Compiling and preparing component upgrade', async () => {
            await job('compile', { scope })
            const result = await job(
              'system/prepare',
              {
                nodeId,
                deployer: draft.deployer.trim(),
                authority: draft.authority.trim(),
              },
              true,
            )
            // Servers before background jobs answered with the whole plan record.
            const id = result?.planId || (result as { plan?: { plan?: { id?: string } } } | undefined)?.plan?.plan?.id
            if (id) onPrepared(id)
            return result
          })
        }
      >
        Prepare transactions
      </Button>
      {system?.connected === false && <Alert color="gray">Inspect live in the workspace to reconnect before preparing transactions.</Alert>}
    </Stack>
  )
}
/** Planned selector changes per facet: what each facet gains, has replaced, or loses. */
function cutByFacet(p: DiamondPlan, nodes: ContractNode[]) {
  const rows = new Map<string, { add: number; replace: number; remove: number }>()
  for (const c of p.changes) {
    const name =
      c.action === 'remove'
        ? nodes.find((n) => same(n.address, c.from))?.name || `Facet ${short(c.from || '')}`
        : c.name || nodes.find((n) => same(n.address, c.to))?.name || short(c.to || '')
    const row = rows.get(name) || { add: 0, replace: 0, remove: 0 }
    row[c.action]++
    rows.set(name, row)
  }
  return [...rows.entries()].sort(([a], [b]) => a.localeCompare(b))
}
function PlanSummary({ record }: { record: PlanRecord }) {
  const { system } = useWorkbench()
  const p = record.plan,
    state = planState(record),
    diamond = isDiamondPlan(p),
    removes = diamond ? p.changes.filter((c) => c.action === 'remove').length : 0
  const byFacet = diamond ? cutByFacet(p, system?.snapshot?.nodes || []) : []
  return (
    <section className="panel">
      <Group justify="space-between">
        <Title order={3} size="h4">
          {familyName(p.scope)} · {p.id.slice(0, 8)}
        </Title>
        <Badge color={state.color} variant="light">
          {state.label}
        </Badge>
      </Group>
      <Text size="sm" c="dimmed" mt="sm">
        Chain {planChainId(p)} · {new Date(p.createdAt).toLocaleString()}
      </Text>
      <Address value={planTarget(p)} />
      <div className="two-columns">
        <div>
          <Text size="xs" c="dimmed" mt="xs">
            Deployer
          </Text>
          <Address value={p.deployer} />
        </div>
        <div>
          <Text size="xs" c="dimmed" mt="xs">
            Authority
          </Text>
          <Address value={diamond ? p.snapshot.owner : p.authority} />
        </div>
      </div>
      {(p.blockers || []).map((b: string, i: number) => (
        <Alert color="red" mt="sm" key={i}>
          {b}
        </Alert>
      ))}
      {(!diamond ? p.warnings || [] : []).map((w: string, i: number) => (
        <Alert color="orange" mt="sm" key={i}>
          {w}
        </Alert>
      ))}
      {diamond && !!byFacet.length && (
        <div className="table-scroll">
          <Table mt="md" className="cut-by-facet">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Facet</Table.Th>
                <Table.Th>Adds</Table.Th>
                <Table.Th>Replaces</Table.Th>
                <Table.Th>Removes</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {byFacet.map(([name, c]) => (
                <Table.Tr key={name}>
                  <Table.Td>{name}</Table.Td>
                  <Table.Td>{c.add || '—'}</Table.Td>
                  <Table.Td>{c.replace || '—'}</Table.Td>
                  <Table.Td c={c.remove ? 'red' : undefined}>{c.remove || '—'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {!!removes && (
        <Text size="sm" c="red" fw={600} mt="sm">
          Removes {removes} {removes === 1 ? 'function' : 'functions'}
        </Text>
      )}
      <Accordion mt="md">
        <Accordion.Item value="changes">
          <Accordion.Control>
            {diamond
              ? `${p.deployments.length} deployments · ${p.changes.length} function changes`
              : `Before → after · ${p.changes.length} configuration changes`}
          </Accordion.Control>
          <Accordion.Panel>
            {diamond ? (
              <>
                <Table>
                  <Table.Tbody>
                    {p.deployments.map((d) => (
                      <Table.Tr key={d.name}>
                        <Table.Td>{d.name}</Table.Td>
                        <Table.Td>{d.reason}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
                {p.changes.map((c, i) => (
                  <div className="diff-row" key={i}>
                    <Badge variant="light" color={c.action === 'remove' ? 'red' : 'gray'}>
                      {c.action}
                    </Badge>
                    <Code>{c.signature || c.selector}</Code>
                    <Text size="xs">{c.name || c.from}</Text>
                  </div>
                ))}
              </>
            ) : (
              p.changes.map((c, i) => (
                <div className="diff-row" key={i}>
                  <Text fw={600} size="sm">
                    {c.contract} · {c.field}
                  </Text>
                  <code>{pretty(c.before)}</code>
                  <span>→</span>
                  <code>{pretty(c.after)}</code>
                </div>
              ))
            )}
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="source">
          <Accordion.Control>Source & plan evidence</Accordion.Control>
          <Accordion.Panel>
            <JsonView
              value={{
                source: p.source,
                buildDigest: p.buildDigest,
                baseline: diamond ? p.baselineDigest : undefined,
                bindings: diamond ? p.bindings : undefined,
                block: planBlock(p),
              }}
            />
          </Accordion.Panel>
        </Accordion.Item>
        {!diamond && (
          <Accordion.Item value="transactions">
            <Accordion.Control>Exact transaction sequence ({p.actions.length})</Accordion.Control>
            <Accordion.Panel>
              <Accordion multiple>
                {p.actions.map((a, i) => (
                  <Accordion.Item key={a.id} value={a.id}>
                    <Accordion.Control>
                      {i + 1}. {a.label}
                    </Accordion.Control>
                    <Accordion.Panel>
                      <Stack gap="xs">
                        <Text size="xs">
                          {a.phase} · {a.method || 'CREATE'}
                        </Text>
                        <Text size="xs" c="dimmed">
                          Signer
                        </Text>
                        <Address value={a.sender} />
                        <Text size="xs" c="dimmed">
                          {a.to ? 'Target' : 'Creates'}
                        </Text>
                        <Address value={a.to || a.creates || ''} />
                        {a.nonce !== undefined && <Text size="sm">Bound nonce {a.nonce}</Text>}
                        {a.args && <JsonView value={a.args} />}
                        <Text size="xs">Exact calldata · 0 ETH</Text>
                        <Code block className="json-code">
                          {a.data}
                        </Code>
                        <CopyData value={a.data} />
                      </Stack>
                    </Accordion.Panel>
                  </Accordion.Item>
                ))}
              </Accordion>
            </Accordion.Panel>
          </Accordion.Item>
        )}
      </Accordion>
    </section>
  )
}
