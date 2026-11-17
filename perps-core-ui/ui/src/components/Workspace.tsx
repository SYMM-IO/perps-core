import { linkId } from '../../../shared/graph-model.js'
import { useWorkbench } from '../api'
import { lazyView } from '../lib/lazy'
import { useParamPatch, type PatchOptions } from '../lib/url'
import { download, httpUrl, isIssue, pretty } from '../lib/state'
import type { ContractNode, GraphFilters, Profile, Snapshot } from '../types'
import { Empty, EnvironmentBadge, JsonView } from './Common'
import { ContractsTable } from './ContractsTable'
import { MaintenanceOverview } from './MaintenanceOverview'
import { Sources } from './Sources'
import {
  Accordion,
  Alert,
  Badge,
  Button,
  FileButton,
  Group,
  Modal,
  Popover,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core'
import { ChevronsUpDown, GitCompareArrows, RefreshCw } from 'lucide-react'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

// Links saved before the filter chips named one of these sets; they still open on the same connections.
const LEGACY_MODES: Record<string, string[]> = {
  integrations: ['grant', 'roleAdmin', 'ownership', 'wiring'],
  roles: ['wiring'],
  wiring: ['integration', 'grant', 'roleAdmin', 'ownership'],
}
/** Picker labels, made distinct where two deployments share a name and version: first by environment, then by id. */
function deploymentLabels(profiles: Profile[]) {
  const base = (p: Profile) => `${p.name}${p.version ? ` · ${p.version}` : ''}`
  const count = (labels: string[], label: string) => labels.filter((l) => l === label).length
  const first = profiles.map(base)
  const second = profiles.map((p, i) => (count(first, first[i]) > 1 && p.environment ? `${first[i]} · ${p.environment}` : first[i]))
  return new Map(profiles.map((p, i) => [p.id, count(second, second[i]) > 1 ? `${second[i]} · ${p.id}` : second[i]]))
}
const ContractGraph = lazyView(() => import('./ContractGraph').then((module) => ({ default: module.ContractGraph })))

export function Workspace({ onPrepare }: { onPrepare: (node: ContractNode) => void }) {
  const { system, engine, run, job, request, busy, jobs, operation } = useWorkbench()
  const [params, setParams] = useSearchParams()
  const patch = useParamPatch()
  // Older shared links carry map state without naming a tab. A fresh visit starts with the maintenance overview.
  const mapLink = [...params.keys()].some((key) => key === 'node' || key === 'link' || key.startsWith('graph')),
    tab = params.get('tab') || (mapLink ? 'map' : 'overview')
  const legacyMapDefaults = useRef(mapLink)
  const [settings, setSettings] = useState(false),
    [sources, setSources] = useState(false),
    [rpc, setRpc] = useState(''),
    [mapOpened, setMapOpened] = useState(tab === 'map'),
    [focusDetails, setFocusDetails] = useState(0)
  const kept = useRef<{ id: string; snapshot: Snapshot } | null>(null)
  const deploymentRpc = system?.profile.rpc || system?.profiles.find((p) => p.id === system.profile.id)?.rpc || ''
  useEffect(() => {
    if (tab === 'map') setMapOpened(true)
  }, [tab])
  useEffect(() => {
    setRpc(deploymentRpc)
  }, [system?.profile.id, deploymentRpc])
  // Links carry the deployment they were made on, so a pasted one can say when the app has another loaded.
  useEffect(() => {
    if (system?.profile.id && !params.get('deployment')) patch({ deployment: system.profile.id }, { replace: true })
  }, [system?.profile.id, params.get('deployment')])
  if (!system) return <Empty title="Loading deployment workspaces…" />
  const profile = system.profile,
    running = (jobs || []).filter((j) => j.state === 'running'),
    inspecting = running.some((j) => j.route === 'system/scan') || operation === 'Inspecting live deployment'
  if (system.snapshot) kept.current = { id: profile.id, snapshot: system.snapshot }
  // While an inspection runs the last snapshot of this deployment stays on screen, marked as such, rather than an empty map.
  const snapshot = system.snapshot || (inspecting && kept.current?.id === profile.id ? kept.current.snapshot : undefined),
    blocked = busy || !!running.length,
    linked = params.get('deployment'),
    foreign = !!linked && linked !== profile.id,
    linkedProfile = foreign ? system.profiles.find((p) => p.id === linked) : undefined,
    locked = !!system.active || !!engine?.active,
    labels = deploymentLabels(system.profiles)
  const nodes = snapshot?.nodes || profile.nodes,
    selected = params.has('node') ? params.get('node')! : legacyMapDefaults.current ? 'core' : ''
  const link = params.get('link') || ''
  const mode = params.get('graphMode') || 'all'
  const filters: GraphFilters = {
    mode: mode === 'implementation' ? 'implementation' : 'all',
    hide: params.has('graphHide') ? params.get('graphHide')!.split(',').filter(Boolean) : LEGACY_MODES[mode] || [],
    focus: params.has('graphFocus') ? params.get('graphFocus')! : legacyMapDefaults.current ? 'core' : '',
    query: params.get('graphQuery') || '',
    missingOnly: params.get('graphAttention') === '1',
  }
  // An empty link means no connection is open, so it leaves the URL rather than lingering as "link=".
  const update = (values: Record<string, string>, options?: PatchOptions) =>
    patch('link' in values && !values.link ? { ...values, link: null } : values, options)
  const select = (id: string) => update({ node: id, link: '' })
  const inspectContract = (node: ContractNode) => {
    setFocusDetails((request) => request + 1)
    update({
      tab: 'map',
      node: node.id,
      graphFocus: node.id,
      graphMode: 'all',
      graphHide: '',
      graphQuery: '',
      graphAttention: '0',
      link: '',
    })
  }
  const edges = snapshot?.edges || [],
    issues = edges.filter(isIssue)
  const prepare = (node: ContractNode) => onPrepare(node)
  const selectDeployment = (id: string) =>
    run('Loading workspace', async () => {
      await request('system/select', { id })
      legacyMapDefaults.current = false
      setParams({ view: 'workspace', deployment: id })
      return true
    })
  // An issue opens the map on the contract that owns it, with the failing connection selected.
  const showIssue = (edge: (typeof edges)[number]) => {
    setFocusDetails((request) => request + 1)
    const anchor = nodes.some((n) => n.id === edge.from) ? edge.from : edge.to
    update({
      tab: 'map',
      node: anchor,
      graphFocus: anchor,
      graphMode: 'all',
      graphHide: '',
      graphQuery: '',
      graphAttention: '0',
      link: linkId(edge.from, edge.to),
    })
  }
  const stale = !(system.live ?? system.connected) && !!snapshot,
    partial =
      !!snapshot?.roleHistory &&
      (snapshot.roleHistory.complete === false || Object.values(snapshot.roleHistory).some((v: any) => v?.complete === false))
  const compareBlocked = !snapshot || !system.connected ? 'Inspect live first' : ''
  return (
    <Tabs value={tab} onChange={(value) => update({ tab: value || 'overview' })} keepMounted={false} className="seg-tabs workspace-tabs">
      <section className="workspace-heading" aria-label="Deployment">
        <div className="hero-main">
          <Select
            aria-label="Deployment"
            className="hero-select"
            variant="unstyled"
            rightSection={<ChevronsUpDown size={16} aria-hidden />}
            searchable
            allowDeselect={false}
            data={['Production', 'Staging', 'Test / development', 'Deprecated']
              .map((group) => ({
                group,
                items: system.profiles.filter((p) => p.environment === group).map((p) => ({ value: p.id, label: labels.get(p.id) || p.name })),
              }))
              .filter((g) => g.items.length)
              .concat(
                system.profiles.some((p) => p.id === profile.id) ? [] : [{ group: 'Imported', items: [{ value: profile.id, label: profile.name }] }],
              )}
            value={profile.id}
            disabled={busy || locked}
            onChange={(value) => {
              if (value && value !== profile.id) void selectDeployment(value)
            }}
          />
        </div>
        <div className="workspace-toolbar">
          {!foreign && (
            <Tabs.List>
              <Tabs.Tab value="overview">Overview</Tabs.Tab>
              <Tabs.Tab value="map">Map</Tabs.Tab>
              <Tabs.Tab value="contracts">Contracts</Tabs.Tab>
              <Tabs.Tab value="changes">Changes</Tabs.Tab>
            </Tabs.List>
          )}
        </div>
        <Group gap={6} wrap="nowrap" className="workspace-actions">
          <Popover position="bottom-end" width={320}>
            <Popover.Target>
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                className="workspace-status"
                leftSection={
                  <span className="dot" data-state={stale || inspecting ? 'saved' : (system.live ?? system.connected) ? 'live' : undefined} />
                }
              >
                {inspecting ? 'Inspecting…' : stale ? 'Saved snapshot' : (system.live ?? system.connected) ? 'Live' : 'Not inspected'}
              </Button>
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap="sm">
                <Group gap="xs">
                  <EnvironmentBadge environment={profile.environment} />
                  <Text size="sm">
                    {profile.chainName || 'Chain'} · {profile.chainId}
                  </Text>
                </Group>
                {snapshot && (
                  <Text size="sm" c="dimmed">
                    {new Date(snapshot.at).toLocaleString()} · Block {snapshot.blockNumber.toLocaleString()}
                  </Text>
                )}
                {inspecting && snapshot && <Text size="sm">Showing the saved inspection while the new one runs.</Text>}
                {partial && <Text size="sm">Partial role history</Text>}
                <Button variant="default" size="compact-sm" onClick={() => setSources(true)}>
                  Inspection sources
                </Button>
                <Button variant="subtle" color="gray" size="compact-sm" onClick={() => setSettings(true)}>
                  Deployment settings
                </Button>
              </Stack>
            </Popover.Dropdown>
          </Popover>
          <Button
            variant="default"
            size="compact-sm"
            leftSection={<RefreshCw size={14} />}
            disabled={busy || !rpc}
            onClick={() => run('Inspecting live deployment', () => job('system/scan', { rpc }, true))}
          >
            Inspect live
          </Button>
        </Group>
      </section>
      {foreign ? (
        <Alert color="orange" title={`This link is for ${linkedProfile?.name || linked}`} className="link-mismatch">
          <Text size="sm">
            {profile.name} is loaded, and this link's contracts and connections would open on it instead.
            {linkedProfile ? '' : ' The address book has no deployment with this id.'}
          </Text>
          <Group mt="sm" gap="sm">
            {linkedProfile && (
              <Button disabled={busy || locked} onClick={() => void selectDeployment(linkedProfile.id)}>
                Switch
              </Button>
            )}
            <Button
              variant="default"
              onClick={() => {
                legacyMapDefaults.current = false
                setParams({ view: 'workspace', deployment: profile.id })
              }}
            >
              Stay on {profile.name}
            </Button>
            {locked && (
              <Text size="xs" c="dimmed">
                Finish the active upgrade before switching.
              </Text>
            )}
          </Group>
        </Alert>
      ) : (
        <>
          <Tabs.Panel value="overview" pt="md">
            <MaintenanceOverview
              profile={profile}
              snapshot={snapshot}
              partial={partial}
              onInspect={inspectContract}
              onIssue={showIssue}
              onContracts={() => update({ tab: 'contracts' })}
            />
          </Tabs.Panel>
          {/* The map stays mounted across tabs, so its question, arrangement and zoom survive a look at the table. */}
          <Tabs.Panel value="map" pt="sm" keepMounted>
            {(mapOpened || tab === 'map') && (
              <Suspense fallback={<Empty title="Loading graph…" />}>
                <ContractGraph
                  snapshot={snapshot}
                  profile={profile}
                  selected={selected}
                  link={link}
                  filters={filters}
                  delta={system.delta}
                  since={system.since}
                  onSelect={select}
                  onLink={(id) => update({ link: id })}
                  onFilters={(next, options) =>
                    update(
                      {
                        graphMode: next.mode,
                        graphHide: next.hide.join(','),
                        graphFocus: next.focus,
                        graphQuery: next.query,
                        graphAttention: next.missingOnly ? '1' : '0',
                      },
                      options,
                    )
                  }
                  onPrepare={prepare}
                  prepareDisabled={blocked}
                  focusDetails={focusDetails}
                />
              </Suspense>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="contracts" pt="sm">
            <ContractsTable
              nodes={nodes}
              comparison={system.comparison}
              explorer={profile.explorer}
              busy={blocked}
              onInspect={inspectContract}
              onPrepare={prepare}
            />
          </Tabs.Panel>
          <Tabs.Panel value="changes" pt="md">
            <Stack>
              <Group justify="space-between">
                <div>
                  <Title order={2} size="h4">
                    Source comparison
                  </Title>
                </div>
                <Tooltip label={compareBlocked} disabled={!compareBlocked}>
                  <div>
                    <Button
                      leftSection={<GitCompareArrows size={15} />}
                      disabled={blocked || !!compareBlocked}
                      onClick={() =>
                        run('Compiling and comparing source', async () => {
                          await job('compile', { scope: 'core' })
                          return job('system/compare', {}, true)
                        })
                      }
                    >
                      Compare source
                    </Button>
                  </div>
                </Tooltip>
              </Group>
              {!Object.keys(system.comparison || {}).length ? (
                <Text size="sm" c="dimmed">
                  {compareBlocked ? 'Inspect live to compare source.' : 'Run Compare source to find changed code.'}
                </Text>
              ) : (
                Object.entries(system.comparison).map(([id, c]) => {
                  const n = nodes.find((n) => n.id === id)
                  return (
                    <section className="panel" key={id}>
                      <Group justify="space-between">
                        <div>
                          <Title order={3} size="h4">
                            {n?.name || id}
                          </Title>
                          <Text size="sm" c="dimmed">
                            {c.kind === 'diamond'
                              ? c.total === c.matching
                                ? 'Matches this checkout'
                                : `${c.total - c.matching} changed or new facets`
                              : c.matching
                                ? 'Bytecode matches'
                                : 'Deployed bytecode differs'}
                          </Text>
                        </div>
                        {n && (
                          <Button disabled={blocked} onClick={() => prepare(n)}>
                            Prepare upgrade
                          </Button>
                        )}
                      </Group>
                      {c.note && (
                        <Text size="sm" c="dimmed" mt="sm">
                          {c.note}
                        </Text>
                      )}
                      <Accordion mt="sm">
                        <Accordion.Item value="changes">
                          <Accordion.Control>Detailed source comparison</Accordion.Control>
                          <Accordion.Panel>
                            {c.facets && (
                              <Table>
                                <Table.Tbody>
                                  {c.facets.map((f: any) => (
                                    <Table.Tr key={f.name}>
                                      <Table.Td>{f.name}</Table.Td>
                                      <Table.Td>{f.functions} functions</Table.Td>
                                      <Table.Td>
                                        <Badge variant="light" color={f.state === 'matching' ? 'teal' : 'orange'}>
                                          {f.state}
                                        </Badge>
                                      </Table.Td>
                                    </Table.Tr>
                                  ))}
                                </Table.Tbody>
                              </Table>
                            )}
                            <JsonView value={c.interfaceChanges || c} />
                          </Accordion.Panel>
                        </Accordion.Item>
                      </Accordion>
                    </section>
                  )
                })
              )}
              {!!system.delta?.length && (
                <Accordion>
                  <Accordion.Item value="state">
                    <Accordion.Control>Configuration changes since the last inspection ({system.delta.length})</Accordion.Control>
                    <Accordion.Panel>
                      {system.delta.length ? (
                        system.delta.map((d: any, i: number) => (
                          <div className="diff-row" key={i}>
                            <Text fw={600} size="sm">
                              {d.name || d.node} · {d.field}
                            </Text>
                            <code>{pretty(d.before)}</code>
                            <span>→</span>
                            <code>{pretty(d.after)}</code>
                          </div>
                        ))
                      ) : (
                        <Text size="sm" c="dimmed">
                          No configuration changes recorded.
                        </Text>
                      )}
                    </Accordion.Panel>
                  </Accordion.Item>
                </Accordion>
              )}
            </Stack>
          </Tabs.Panel>
        </>
      )}
      <Sources
        opened={sources}
        onClose={() => setSources(false)}
        profile={profile}
        snapshot={snapshot}
        connected={!!system.connected}
        issues={issues.length}
      />
      <Modal opened={settings} onClose={() => setSettings(false)} title="Deployment settings">
        <Stack>
          <TextInput label="Read-only RPC endpoint" value={rpc} onChange={(e) => setRpc(e.currentTarget.value)} placeholder="https://…" />
          <Text size="xs" c="dimmed">
            The scan verifies chain {profile.chainId} before reading contracts. RPC credentials stay in server memory.
          </Text>
          <Group>
            <FileButton
              accept="application/json,.json"
              onChange={(file) => {
                if (file)
                  void run('Importing deployment profile', async () => {
                    const imported = JSON.parse(await file.text())
                    await request('system/select', { profile: imported })
                    legacyMapDefaults.current = false
                    setParams({ view: 'workspace', deployment: String(imported.id) })
                    setSettings(false)
                    return true
                  })
              }}
            >
              {(props) => (
                <Button {...props} variant="default" disabled={busy}>
                  Import profile
                </Button>
              )}
            </FileButton>
            <Button variant="default" onClick={() => download(profile, 'deployment-profile.json')}>
              Export profile
            </Button>
          </Group>
          {httpUrl(profile.source?.url) && (
            <a href={httpUrl(profile.source?.url)} target="_blank" rel="noopener noreferrer">
              Profile source ↗
            </a>
          )}
          {profile.notes?.map((note, i) => (
            <Text size="xs" c="dimmed" key={i}>
              {note}
            </Text>
          ))}
        </Stack>
      </Modal>
    </Tabs>
  )
}
