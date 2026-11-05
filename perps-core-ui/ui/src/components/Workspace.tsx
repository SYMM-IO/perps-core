import { linkId } from '../../../shared/graph-model.js'
import { useWorkbench } from '../api'
import { lazyView } from '../lib/lazy'
import { useParamPatch, type PatchOptions } from '../lib/url'
import { download, httpUrl, isIssue, issueText, pretty } from '../lib/state'
import type { ContractNode, GraphFilters, Profile, Snapshot } from '../types'
import { Empty, EnvironmentBadge, JsonView } from './Common'
import { ContractsTable } from './ContractsTable'
import { Sources } from './Sources'
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  FileButton,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core'
import { ArrowUpRight, ChevronsUpDown, Database, GitCompareArrows, RefreshCw, Rows3, Settings, TriangleAlert, Waypoints } from 'lucide-react'
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
  const [settings, setSettings] = useState(false),
    [sources, setSources] = useState(false),
    [rpc, setRpc] = useState('')
  const kept = useRef<{ id: string; snapshot: Snapshot } | null>(null)
  useEffect(() => {
    setRpc(system?.profile.rpc || system?.profiles.find((p) => p.id === system.profile.id)?.rpc || '')
  }, [system?.profile.id])
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
    selected = params.get('node') || 'core'
  const tab = params.get('tab') || 'map',
    link = params.get('link') || ''
  const mode = params.get('graphMode') || 'all'
  const filters: GraphFilters = {
    mode: mode === 'implementation' ? 'implementation' : 'all',
    hide: params.has('graphHide') ? params.get('graphHide')!.split(',').filter(Boolean) : LEGACY_MODES[mode] || [],
    focus: params.has('graphFocus') ? params.get('graphFocus')! : 'core',
    query: params.get('graphQuery') || '',
    missingOnly: params.get('graphAttention') === '1',
  }
  // An empty link means no connection is open, so it leaves the URL rather than lingering as "link=".
  const update = (values: Record<string, string>, options?: PatchOptions) =>
    patch('link' in values && !values.link ? { ...values, link: null } : values, options)
  const select = (id: string) => update({ node: id, link: '' })
  const edges = snapshot?.edges || [],
    issues = edges.filter(isIssue)
  const name = (id: string) => nodes.find((n) => n.id === id)?.name || id.replace(/^address:/, '')
  const prepare = (node: ContractNode) => onPrepare(node)
  const selectDeployment = (id: string) =>
    run('Loading workspace', async () => {
      await request('system/select', { id })
      setParams({ view: 'workspace', tab: 'map', node: 'core', deployment: id })
      return true
    })
  // An issue opens the map on the contract that owns it, with the failing connection selected.
  const showIssue = (edge: (typeof edges)[number]) => {
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
    <Stack gap="sm">
      <section className="hero" aria-label="Deployment">
        <div className="hero-main">
          <span className="eyebrow">Deployment</span>
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
          <div className="deployment-meta">
            <EnvironmentBadge environment={profile.environment} />
            {inspecting && snapshot ? (
              <span className="chip" role="status">
                <i className="dot" data-state="saved" /> Inspecting… showing the saved snapshot
              </span>
            ) : (system.live ?? system.connected) ? (
              <span className="chip">
                <i className="dot" data-state="live" /> Live
              </span>
            ) : stale ? (
              <Tooltip
                label="Read from the last saved inspection. Inspect live to reconnect before comparing or preparing an upgrade."
                multiline
                w={280}
              >
                <span className="chip" tabIndex={0}>
                  <i className="dot" data-state="saved" /> Saved snapshot
                </span>
              </Tooltip>
            ) : (
              <span className="chip">
                <i className="dot" /> Not inspected
              </span>
            )}
            <span className="chip">
              {profile.chainName || 'Chain'} <b>{profile.chainId}</b>
            </span>
            {snapshot && (
              <>
                <span className="chip">
                  Block <b>{snapshot.blockNumber.toLocaleString()}</b>
                </span>
                <span className="chip chip-date">{new Date(snapshot.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </>
            )}
            <button type="button" className="chip chip-button" onClick={() => setSources(true)}>
              <Database size={12} aria-hidden /> Sources{partial ? ' · partial history' : ''}
            </button>
          </div>
        </div>
        <div className="hero-stats">
          <div className="stat">
            <b>{nodes.length}</b>
            <span>addresses</span>
          </div>
          <div className="stat">
            <b>{snapshot ? edges.length : '—'}</b>
            <span>connections</span>
          </div>
          <button
            type="button"
            className="stat"
            data-tone={issues.length ? 'bad' : undefined}
            disabled={!issues.length}
            onClick={() => update({ tab: 'map', graphFocus: '', graphMode: 'all', graphHide: '', graphQuery: '', graphAttention: '1', link: '' })}
          >
            <b>{snapshot ? issues.length : '—'}</b>
            <span>{issues.length === 1 ? 'issue' : 'issues'}</span>
          </button>
        </div>
        <Group gap="xs" wrap="nowrap" className="hero-actions">
          <Button
            leftSection={<RefreshCw size={15} />}
            disabled={busy || !rpc}
            onClick={() => run('Inspecting live deployment', () => job('system/scan', { rpc }, true))}
          >
            Inspect live
          </Button>
          <Tooltip label={compareBlocked} disabled={!compareBlocked}>
            <div>
              <Button
                variant="default"
                leftSection={<GitCompareArrows size={15} />}
                disabled={busy || !!compareBlocked}
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
          <Tooltip label="Deployment settings">
            <ActionIcon variant="default" size={36} aria-label="Deployment settings" onClick={() => setSettings(true)}>
              <Settings size={16} />
            </ActionIcon>
          </Tooltip>
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
            <Button variant="default" onClick={() => setParams({ view: 'workspace', tab: 'map', node: 'core', deployment: profile.id })}>
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
        <Tabs value={tab} onChange={(value) => update({ tab: value || 'map' })} keepMounted={false} className="seg-tabs">
          {/* Tabs and open issues share a row, so the map starts higher on the page. */}
          <div className="workspace-bar">
            <Tabs.List>
              <Tabs.Tab value="map" leftSection={<Waypoints size={14} aria-hidden />}>
                Map
              </Tabs.Tab>
              <Tabs.Tab value="contracts" leftSection={<Rows3 size={14} aria-hidden />}>
                Contracts
              </Tabs.Tab>
              <Tabs.Tab value="changes" leftSection={<GitCompareArrows size={14} aria-hidden />}>
                Changes
              </Tabs.Tab>
            </Tabs.List>
            {!!issues.length && (
              <div className="issue-strip" role="region" aria-label="Connections needing attention">
                <span className="issue-count">
                  <TriangleAlert size={14} aria-hidden /> {issues.length} {issues.length === 1 ? 'needs' : 'need'} attention
                </span>
                {issues.slice(0, 3).map((e, i) => (
                  <button type="button" className="issue-chip" key={i} onClick={() => showIssue(e)}>
                    <b>
                      {name(e.from)} → {name(e.to)}
                    </b>
                    <span>{issueText(e)}</span>
                    <ArrowUpRight size={13} aria-hidden />
                  </button>
                ))}
                {issues.length > 3 && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    onClick={() =>
                      update({ tab: 'map', graphFocus: '', graphMode: 'all', graphHide: '', graphQuery: '', graphAttention: '1', link: '' })
                    }
                  >
                    Show all {issues.length} on the map
                  </Button>
                )}
              </div>
            )}
          </div>
          {/* The map stays mounted across tabs, so its question, arrangement and zoom survive a look at the table. */}
          <Tabs.Panel value="map" pt="sm" keepMounted>
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
              />
            </Suspense>
          </Tabs.Panel>
          <Tabs.Panel value="contracts" pt="sm">
            <ContractsTable
              nodes={nodes}
              comparison={system.comparison}
              busy={blocked}
              onInspect={(node) => update({ node: node.id, graphFocus: node.id, tab: 'map', link: '' })}
              onPrepare={prepare}
            />
          </Tabs.Panel>
          <Tabs.Panel value="changes" pt="md">
            <Stack>
              {!Object.keys(system.comparison || {}).length ? (
                <Empty title="Compare this checkout with the deployment">
                  Use Compare source to see changed facets, implementations and functions.
                </Empty>
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
                              ? `${c.matching} matching · ${c.total - c.matching} changed or new facets`
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
            </Stack>
          </Tabs.Panel>
        </Tabs>
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
                    setParams({ view: 'workspace', tab: 'map', node: 'core', deployment: String(imported.id) })
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
    </Stack>
  )
}
