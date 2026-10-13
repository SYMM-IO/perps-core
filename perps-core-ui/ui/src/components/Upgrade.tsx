import { useWorkbench } from '../api'
import { draftKey, download, familyName, planState, pretty, readDraft, short, UPGRADEABLE, upgradeParams } from '../lib/state'
import type { DiamondDraft, EngineStatus, PlanRecord } from '../types'
import { Address, CopyData, Empty, JsonView, KindTile } from './Common'
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
  Textarea,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { isAddress } from 'ethers'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

export function Upgrade() {
  const [params, setParams] = useSearchParams()
  const { engine, system, request, busy, run, job } = useWorkbench()
  const adapter = params.get('adapter') === 'system' ? 'system' : 'diamond',
    planId = params.get('plan') || '',
    scope = params.get('scope') || 'core',
    target = params.get('target') || '',
    step = Math.max(0, Math.min(2, Number(params.get('step')) || 0))
  const nodeId = params.get('upgradeNode') || params.get('node') || scope
  // Wide screens put the steps in a side rail, so the work area can use the rest of the width.
  const wide = useMediaQuery('(min-width: 901px)', true)
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
      for (const [k, v] of Object.entries(values)) p.set(k, v)
      return p
    })
  function prepared(record: PlanRecord) {
    go({ plan: record.plan.id, step: '1' })
  }
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
  return (
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
            <Stepper.Step label="Execute" description="Wallet, Ledger or Safe" allowStepSelect={!!record && record.rehearsal?.status === 'passed'} />
          </Stepper>
        </aside>
        <Stack gap="md" className="upgrade-main">
          {recordQuery.error && <Alert color="red">{recordQuery.error.message}</Alert>}
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
                          run('Rehearsing upgrade', () =>
                            job(`${adapter === 'system' ? 'system/' : ''}rehearse`, { id: record.plan.id }, adapter === 'system'),
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
                          run('Exporting review bundle', async () => {
                            download(
                              await request(`${adapter === 'system' ? 'system/' : ''}export?id=${record.plan.id}`),
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
                  )}{' '}
                  {adapter === 'system' && record.rehearsal?.status === 'passed' && (
                    <Button
                      variant="default"
                      disabled={busy}
                      onClick={() => run('Verifying executed upgrade', () => job('system/verify', { id: record.plan.id }, true))}
                    >
                      Verify executed upgrade
                    </Button>
                  )}
                </>
              )}
            </>
          )}
        </Stack>
      </div>
    </Stack>
  )
}
function DiamondPrepare({ scope, target, onPrepared }: { scope: string; target: string; onPrepared: (record: PlanRecord) => void }) {
  const { engine, system, request, run, job, busy } = useWorkbench()
  const defaultRpc = system?.profile.rpc || system?.profiles.find((p) => p.id === system?.profile.id)?.rpc || ''
  const [rpc, setRpc] = useState(defaultRpc),
    [address, setAddress] = useState(target),
    [editing, setEditing] = useState(false)
  const ready = engine?.snapshot?.target.toLowerCase() === address.toLowerCase() && (engine?.build?.scope || 'core') === scope && !!engine?.build
  const node = system?.snapshot?.nodes?.find((n) => n.address.toLowerCase() === address.toLowerCase())
  // The workspace already holds a live connection to this deployment; reuse it unless the operator overrides it.
  const shared = !!system?.connected && !editing
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
        {ready && (
          <div className="target-summary">
            <Text size="sm">
              Chain {engine.snapshot!.chainId} · {engine.snapshot!.facets.length} facets · {Object.keys(engine.snapshot!.map).length} functions
            </Text>
            <Text size="xs" c="dimmed">
              Upgrade owner · {engine.snapshot!.authority.kind}
            </Text>
            <Address value={engine.snapshot!.owner} />
            <Text size="xs" c="dimmed">
              Source {engine.build!.source.commit.slice(0, 12)} · Build {engine.build!.digest.slice(0, 12)}
            </Text>
          </div>
        )}
      </section>
      {ready ? (
        <FacetSelection
          key={draftKey(engine!.snapshot!.chainId, address, scope, engine!.build!.digest)}
          engine={engine!}
          scope={scope}
          initial={
            system?.comparison[system.snapshot?.nodes.find((n) => n.address.toLowerCase() === address.toLowerCase())?.id || '']?.facets
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
function FacetSelection({
  engine,
  scope,
  initial,
  onPrepared,
}: {
  engine: EngineStatus
  scope: string
  initial: string[]
  onPrepared: (record: PlanRecord) => void
}) {
  const { request, run, busy } = useWorkbench()
  const key = draftKey(engine.snapshot!.chainId, engine.snapshot!.target, scope, engine.build!.digest)
  const [draft, setDraft] = useState<DiamondDraft>(() =>
      readDraft(sessionStorage, key, { selected: initial, removals: [], deployer: '', mode: 'patch' }),
    ),
    [search, setSearch] = useState(''),
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
  const facets = engine.build!.catalog.filter(
      (f) => f.kind === 'facet' && `${f.name} ${Object.values(f.selectors).join(' ')}`.toLowerCase().includes(search.toLowerCase()),
    ),
    known = Object.assign({}, ...engine.build!.catalog.map((f) => f.selectors))
  const toggle = (field: 'selected' | 'removals', value: string, checked: boolean) =>
    update({ [field]: checked ? [...new Set([...draft[field], value])] : draft[field].filter((v) => v !== value) })
  return (
    <Stack>
      {storageError && <Alert color="red">{storageError}</Alert>}
      <Group grow align="end">
        <TextInput type="search" label="Find facets or functions" value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
        <Select
          label="Upgrade scope"
          value={draft.mode}
          onChange={(v) => update({ mode: v || 'patch' })}
          data={[
            { value: 'patch', label: 'Patch selected facets' },
            { value: 'reconcile', label: 'Reconcile all functions' },
          ]}
        />
      </Group>
      <Text size="sm" c="dimmed">
        {draft.mode === 'patch'
          ? 'Unselected functions remain unchanged.'
          : 'Functions absent from your selection will be removed. Select every removal explicitly below.'}
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
                  onChange={(e) => toggle('selected', f.name, e.currentTarget.checked)}
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
      <Accordion variant="contained">
        <Accordion.Item value="removals">
          <Accordion.Control>Explicit function removals ({draft.removals.length})</Accordion.Control>
          <Accordion.Panel>
            <Text size="sm" c="dimmed" mb="sm">
              Diamond upgrade and introspection functions cannot be removed.
            </Text>
            <Stack gap="xs" className="bounded-list">
              {Object.keys(engine.snapshot!.map)
                .filter((s) => !['0x1f931c1c', '0x7a0ed627'].includes(s))
                .sort()
                .map((s) => (
                  <Checkbox
                    key={s}
                    label={`${s} ${known[s] || 'Unknown function'}`}
                    checked={draft.removals.includes(s)}
                    onChange={(e) => toggle('removals', s, e.currentTarget.checked)}
                    disabled={busy}
                  />
                ))}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
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
          Draft saved for this chain, target and source.
        </Text>
        <Button
          disabled={busy || !isAddress(draft.deployer) || !(draft.selected.length || draft.removals.length)}
          onClick={() =>
            run('Preparing Diamond upgrade', async () => {
              const record = await request<PlanRecord>('prepare', { ...draft, selected: draft.selected })
              onPrepared(record)
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
function PeripheralPrepare({ scope, nodeId, onPrepared }: { scope: string; nodeId: string; onPrepared: (record: PlanRecord) => void }) {
  const { system, request, run, job, busy, setError } = useWorkbench()
  const node = system?.snapshot?.nodes.find((n) => n.id === nodeId)
  const storageKey = `workbench-component-draft:${system?.profile.chainId}:${node?.address || nodeId}:${scope}`
  const [draft, setDraft] = useState(() => {
      try {
        return (
          JSON.parse(sessionStorage.getItem(storageKey) || 'null') || {
            deployer: '',
            authority: node?.state.roles?.DEFAULT_ADMIN_ROLE?.[0] || system?.snapshot?.nodes.find((n) => n.kind === 'core')?.state.owner || '',
            inventory: '',
          }
        )
      } catch {
        return { deployer: '', authority: '', inventory: '' }
      }
    }),
    [reviewed, setReviewed] = useState(false),
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
      {scope === 'instantLayer' && (
        <section className="panel">
          <Textarea
            label="Additional migration addresses"
            description="PartyBs and whitelisted targets that could not be discovered. One address per line."
            value={draft.inventory}
            onChange={(e) => update({ inventory: e.currentTarget.value })}
            minRows={3}
          />
          <Checkbox
            mt="md"
            label="I reviewed the migration inventory and client/operator cutover. Users will reauthorize sessions on the replacement InstantLayer."
            checked={reviewed}
            onChange={(e) => setReviewed(e.currentTarget.checked)}
          />
        </section>
      )}
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
        disabled={
          busy ||
          !isAddress(draft.deployer) ||
          !isAddress(draft.authority) ||
          (scope === 'instantLayer' && !reviewed) ||
          (system as any)?.connected === false
        }
        onClick={() =>
          run('Compiling and preparing component upgrade', async () => {
            await job('compile', { scope })
            const result = await job<any>(
              'system/prepare',
              {
                nodeId,
                deployer: draft.deployer.trim(),
                authority: draft.authority.trim(),
                inventory: draft.inventory.split(/[\s,]+/).filter(Boolean),
                inventoryReviewed: reviewed,
              },
              true,
            )
            if (result.plan) onPrepared(result.plan)
            return result
          })
        }
      >
        Prepare transactions
      </Button>
      {(system as any)?.connected === false && <Alert color="gray">Inspect live in the workspace to reconnect before preparing transactions.</Alert>}
    </Stack>
  )
}
function PlanSummary({ record }: { record: PlanRecord }) {
  const p = record.plan,
    state = planState(record),
    diamond = !!p.snapshot
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
        Chain {p.chainId || p.snapshot?.chainId} · {new Date(p.createdAt).toLocaleString()}
      </Text>
      <Address value={p.snapshot?.target || p.sourceAddress} />
      <Text size="xs" c="dimmed" mt="xs">
        Authority
      </Text>
      <Address value={p.snapshot?.owner || p.authority} />
      {(p.blockers || []).map((b: string, i: number) => (
        <Alert color="red" mt="sm" key={i}>
          {b}
        </Alert>
      ))}
      {(p.warnings || []).map((w: string, i: number) => (
        <Alert color="orange" mt="sm" key={i}>
          {w}
        </Alert>
      ))}
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
                    {p.deployments.map((d: any) => (
                      <Table.Tr key={d.name}>
                        <Table.Td>{d.name}</Table.Td>
                        <Table.Td>{d.reason}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
                {p.changes.map((c: any, i: number) => (
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
              p.changes.map((c: any, i: number) => (
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
                baseline: p.baselineDigest,
                bindings: p.bindings,
                block: p.blockNumber || p.snapshot?.blockNumber,
              }}
            />
          </Accordion.Panel>
        </Accordion.Item>
        {!diamond && (
          <Accordion.Item value="transactions">
            <Accordion.Control>Exact transaction sequence ({p.actions.length})</Accordion.Control>
            <Accordion.Panel>
              <Accordion multiple>
                {p.actions.map((a: any, i: number) => (
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
                        <Address value={a.to || a.creates} />
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
