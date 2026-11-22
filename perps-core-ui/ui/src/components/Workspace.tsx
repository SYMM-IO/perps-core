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
  Code,
  Combobox,
  FileButton,
  Group,
  Modal,
  Popover,
  ScrollArea,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  UnstyledButton,
  useCombobox,
} from '@mantine/core'
import { Check, ChevronDown, ChevronsUpDown, GitCompareArrows, RefreshCw } from 'lucide-react'
import { Suspense, useEffect, useId, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

// Links saved before the filter chips named one of these sets; they still open on the same connections.
const LEGACY_MODES: Record<string, string[]> = {
  integrations: ['grant', 'roleAdmin', 'ownership', 'wiring'],
  roles: ['wiring'],
  wiring: ['integration', 'grant', 'roleAdmin', 'ownership'],
}
const DEPLOYMENT_ENVIRONMENTS = ['Production', 'Staging', 'Test / development', 'Deprecated']
const statusMenuButtonStyles = {
  root: { height: 'auto', minHeight: 'var(--button-height)', paddingBlock: '0.125rem' },
  label: { whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.25 },
} as const
function deploymentIdentity(profile: Profile, profiles: Profile[]) {
  const { name, version, chainId, chainName, environment, id } = profile
  const ties = profiles.filter((other) => other.id !== id && other.name === name && (other.version || '') === (version || ''))
  const sameChain = ties.some((other) => other.chainId === chainId)
  const chain = `Chain ${chainId}`
  return {
    name,
    label: [sameChain && id, ties.length > 0 && chain, name, version].filter(Boolean).join(' · '),
    metadata: [chainName ? `${chainName} · ${chainId}` : chain, version, sameChain && id].filter(Boolean).join(' · '),
    searchable: [name, version, chainName, chainId, environment, id].filter(Boolean).join(' ').toLowerCase(),
  }
}

type DeploymentOption = ReturnType<typeof deploymentIdentity> & { value: string }

function DeploymentPicker({
  value,
  label,
  groups,
  disabled,
  onChange,
}: {
  value: string
  label: string
  groups: { group: string; items: DeploymentOption[] }[]
  disabled: boolean
  onChange: (value: string) => void
}) {
  const [search, setSearch] = useState('')
  const labelId = useId()
  const restoreSelectionFocus = useRef(false)
  const combobox = useCombobox({
    onDropdownOpen: () => {
      combobox.updateSelectedOptionIndex('active', { scrollIntoView: true })
      combobox.focusSearchInput()
    },
    onDropdownClose: (source) => {
      setSearch('')
      combobox.resetSelectedOption()
      if (source === 'keyboard') combobox.targetRef.current?.focus()
    },
  })
  const { dropdownOpened, closeDropdown, targetRef } = combobox
  useEffect(() => {
    if (disabled && dropdownOpened) closeDropdown()
  }, [disabled, dropdownOpened, closeDropdown])
  useEffect(() => {
    if (disabled || !restoreSelectionFocus.current) return
    restoreSelectionFocus.current = false
    // The busy state disables the trigger while selection is in flight.
    if (document.activeElement === document.body) targetRef.current?.focus({ preventScroll: true })
  }, [disabled, targetRef])

  const words = search.trim().toLowerCase().split(/\s+/)
  const visible = groups
    .map(({ group, items }) => ({ group, items: items.filter((item) => words.every((word) => item.searchable.includes(word))) }))
    .filter(({ items }) => items.length)

  return (
    <Combobox
      store={combobox}
      width="min(28rem, calc(100vw - 1rem))"
      position="bottom-start"
      onOptionSubmit={(option) => {
        combobox.closeDropdown()
        targetRef.current?.focus()
        if (!disabled && option !== value) {
          restoreSelectionFocus.current = true
          onChange(option)
        }
      }}
    >
      <Combobox.Target targetType="button" withExpandedAttribute>
        <UnstyledButton
          type="button"
          role="combobox"
          aria-label="Deployment"
          aria-describedby={labelId}
          className="deployment-picker-target"
          disabled={disabled}
          onClick={() => combobox.toggleDropdown()}
        >
          <span id={labelId}>{label}</span>
          <ChevronsUpDown size={16} aria-hidden />
        </UnstyledButton>
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Search
          type="search"
          role="searchbox"
          aria-label="Search deployments"
          placeholder="Search deployments"
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value)
            combobox.resetSelectedOption()
          }}
          onBlur={(event) => {
            if (event.relatedTarget !== combobox.targetRef.current) combobox.closeDropdown()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              combobox.closeDropdown()
              combobox.targetRef.current?.focus()
            }
          }}
        />
        <Combobox.Options aria-label="Deployments">
          <ScrollArea.Autosize
            className="deployment-options"
            mah="var(--deployment-options-max-height, 220px)"
            type="auto"
            scrollbars="y"
            scrollbarSize={8}
            classNames={{ thumb: 'deployment-scroll-thumb' }}
          >
            {visible.length ? (
              visible.map(({ group, items }) => (
                <Combobox.Group key={group} label={group}>
                  {items.map((item) => (
                    <Combobox.Option
                      key={item.value}
                      value={item.value}
                      active={item.value === value}
                      aria-selected={item.value === value}
                      className="deployment-option"
                    >
                      <Check size="1em" aria-hidden style={{ visibility: item.value === value ? 'visible' : 'hidden' }} />
                      <div>
                        <div>{item.name}</div>
                        <Text size="xs" c="dimmed">
                          {item.metadata}
                        </Text>
                      </div>
                    </Combobox.Option>
                  ))}
                </Combobox.Group>
              ))
            ) : (
              <Combobox.Empty>No matching deployments</Combobox.Empty>
            )}
          </ScrollArea.Autosize>
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  )
}

type ComparedSelector = string | { selector: string; signature?: string }

function SelectorComparison({ title, selectors }: { title: string; selectors?: ComparedSelector[] }) {
  return (
    <Stack gap="xs">
      <Text component="h5" size="sm" fw={500}>
        {title}
        {Array.isArray(selectors) ? ` (${selectors.length})` : ''}
      </Text>
      {Array.isArray(selectors) ? (
        selectors.map((entry) => {
          const selector = typeof entry === 'string' ? entry : entry.selector
          const signature = typeof entry === 'string' ? undefined : entry.signature
          return (
            <div key={selector} className="comparison-selector">
              {signature && <Text size="sm">{signature}</Text>}
              <Code>{selector}</Code>
            </div>
          )
        })
      ) : (
        <Text size="sm" c="dimmed">
          Selector comparison unavailable
        </Text>
      )}
    </Stack>
  )
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
  const [statusPanel, setStatusPanel] = useState<'menu' | 'sources' | 'settings' | null>(null),
    [rpc, setRpc] = useState(''),
    [mapOpened, setMapOpened] = useState(tab === 'map'),
    [focusDetails, setFocusDetails] = useState(0)
  const statusButton = useRef<HTMLButtonElement>(null)
  const restoreSourcesFocus = useRef<() => void>(() => statusButton.current?.focus({ preventScroll: true }))
  const [sourcesEntry, setSourcesEntry] = useState({ map: false, sequence: 0 })
  const closeStatusPanel = () => {
    setStatusPanel(null)
    statusButton.current?.focus({ preventScroll: true })
  }
  const openStatusDialog = (dialog: 'sources' | 'settings') => {
    // Mantine restores focus to the active element at the time the dialog opens.
    statusButton.current?.focus({ preventScroll: true })
    if (dialog === 'sources') {
      restoreSourcesFocus.current = () => statusButton.current?.focus({ preventScroll: true })
      setSourcesEntry(({ sequence }) => ({ map: false, sequence: sequence + 1 }))
    }
    setStatusPanel(dialog)
  }
  const openMapSources = (restore: () => void) => {
    restoreSourcesFocus.current = restore
    setSourcesEntry(({ sequence }) => ({ map: true, sequence: sequence + 1 }))
    setStatusPanel('sources')
  }
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
  if (!system) return <Empty title="Loading deployment workspaces…" loading />
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
    locked = !!system.active || !!engine?.active
  const imported = !system.profiles.some((p) => p.id === profile.id)
  const selectableProfiles = imported ? [...system.profiles, profile] : system.profiles
  const identities = new Map(selectableProfiles.map((p) => [p.id, { ...deploymentIdentity(p, selectableProfiles), value: p.id }]))
  const deploymentLabel = (p: Profile) => identities.get(p.id)?.label || p.name
  const deploymentGroups = [
    ...DEPLOYMENT_ENVIRONMENTS.map((group) => ({ group, profiles: system.profiles.filter((p) => p.environment === group) })),
    { group: 'Other environments', profiles: system.profiles.filter((p) => !DEPLOYMENT_ENVIRONMENTS.includes(p.environment ?? '')) },
    ...(imported ? [{ group: 'Imported', profiles: [profile] }] : []),
  ]
    .filter(({ profiles }) => profiles.length)
    .map(({ group, profiles }) => ({ group, items: profiles.map((p) => identities.get(p.id)!) }))
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
  const compareBlocked = !snapshot || !system.connected
  const comparisons = Object.entries(system.comparison || {})
  const inspectDisabled = busy || !rpc
  const inspectLive = () => run('Inspecting live deployment', () => job('system/scan', { rpc }, true))
  return (
    <Tabs value={tab} onChange={(value) => update({ tab: value || 'overview' })} keepMounted={false} className="seg-tabs workspace-tabs">
      <section className="workspace-heading" aria-label="Deployment">
        <div className="hero-main">
          <DeploymentPicker
            value={profile.id}
            label={deploymentLabel(profile)}
            groups={deploymentGroups}
            disabled={busy || locked}
            onChange={(value) => void selectDeployment(value)}
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
        <Group gap={6} className="workspace-actions">
          <Popover
            position="bottom-end"
            width="min(20rem, calc(100vw - 1rem))"
            opened={statusPanel === 'menu'}
            onChange={(opened) => setStatusPanel(opened ? 'menu' : null)}
            transitionProps={{ exitDuration: 0 }}
            trapFocus
            returnFocus
          >
            <Popover.Target>
              <Button
                ref={statusButton}
                variant="subtle"
                color="gray"
                size="compact-sm"
                className="workspace-status"
                onClick={() => setStatusPanel(statusPanel === 'menu' ? null : 'menu')}
                leftSection={
                  <span className="dot" data-state={stale || inspecting ? 'saved' : (system.live ?? system.connected) ? 'live' : undefined} />
                }
                rightSection={<ChevronDown size={14} aria-hidden />}
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
                <Button variant="default" size="compact-sm" styles={statusMenuButtonStyles} onClick={() => openStatusDialog('sources')}>
                  Inspection sources
                </Button>
                <Button variant="subtle" color="gray" size="compact-sm" styles={statusMenuButtonStyles} onClick={() => openStatusDialog('settings')}>
                  Deployment settings
                </Button>
              </Stack>
            </Popover.Dropdown>
          </Popover>
          <Button
            variant="default"
            size="compact-sm"
            leftSection={<RefreshCw size={14} />}
            disabled={inspectDisabled}
            onClick={inspectLive}
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
              inspectionLabel={inspecting ? 'Previous inspection' : stale ? 'Saved inspection' : 'Inspection'}
              partial={partial}
              inspectDisabled={inspectDisabled}
              missingEndpoint={!rpc}
              onInspectLive={inspectLive}
              onInspect={inspectContract}
              onIssue={showIssue}
              onContracts={() => update({ tab: 'contracts' })}
            />
          </Tabs.Panel>
          {/* The map stays mounted across tabs, so its question, arrangement and zoom survive a look at the table. */}
          <Tabs.Panel value="map" pt="sm" keepMounted>
            {(mapOpened || tab === 'map') && (
              <Suspense fallback={<Empty title="Loading graph…" loading />}>
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
                  onOpenSources={openMapSources}
                  sourcesOpened={statusPanel === 'sources' && sourcesEntry.map}
                  prepareDisabled={blocked}
                  focusDetails={focusDetails}
                />
              </Suspense>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="contracts" pt="sm" keepMounted>
            <ContractsTable
              key={profile.id}
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
                {!compareBlocked && (
                  <Button
                    leftSection={<GitCompareArrows size={15} />}
                    disabled={blocked}
                    onClick={() =>
                      run('Compiling and comparing source', async () => {
                        await job('compile', { scope: 'core' })
                        return job('system/compare', {}, true)
                      })
                    }
                  >
                    Compare source
                  </Button>
                )}
              </Group>
              {!comparisons.length && (
                <Text size="sm" c="dimmed">
                  {compareBlocked ? 'Inspect live to compare source.' : 'Run Compare source to find changed code.'}
                </Text>
              )}
              {compareBlocked && comparisons.length > 0 && (
                <Text size="sm" c="dimmed">
                  Previous source comparison
                </Text>
              )}
              {comparisons.map(([id, c]) => {
                const n = nodes.find((n) => n.id === id)
                const changed = c.kind === 'diamond' ? c.total - c.matching : 0
                return (
                  <section className="panel" key={id}>
                    <Group justify="space-between">
                      <div>
                        <Title order={3} size="h4">
                          {n?.name || id}
                        </Title>
                        <Text size="sm" c="dimmed">
                          {c.kind === 'diamond'
                            ? changed
                              ? `${changed} changed or new ${changed === 1 ? 'facet' : 'facets'}`
                              : 'Matches this checkout'
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
                        <Accordion.Panel className={c.kind === 'diamond' ? 'comparison-details' : undefined}>
                          {c.facets && (
                            <Table className={c.kind === 'diamond' ? 'comparison-facets' : undefined}>
                              <Table.Thead>
                                <Table.Tr>
                                  <Table.Th scope="col">Facet</Table.Th>
                                  <Table.Th scope="col">Functions</Table.Th>
                                  <Table.Th scope="col">Comparison</Table.Th>
                                </Table.Tr>
                              </Table.Thead>
                              <Table.Tbody>
                                {c.facets.map((f: any) => (
                                  <Table.Tr key={f.name}>
                                    <Table.Td>{f.name}</Table.Td>
                                    <Table.Td>
                                      {f.functions} {f.functions === 1 ? 'function' : 'functions'}
                                    </Table.Td>
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
                          {c.kind === 'diamond' ? (
                            <Stack gap="sm" mt="md">
                              <Title order={4} size="h5">
                                Function selectors
                              </Title>
                              {c.interfaceChanges ? (
                                <div className="comparison-selectors">
                                  <SelectorComparison title="Only in this checkout" selectors={c.interfaceChanges.added} />
                                  <SelectorComparison title="Only in the deployed Diamond" selectors={c.interfaceChanges.removed} />
                                </div>
                              ) : (
                                <Text size="sm" c="dimmed">
                                  Selector comparison unavailable
                                </Text>
                              )}
                              <details className="comparison-raw">
                                <summary>Raw comparison data</summary>
                                <JsonView value={c} />
                              </details>
                            </Stack>
                          ) : (
                            <JsonView value={c.interfaceChanges || c} />
                          )}
                        </Accordion.Panel>
                      </Accordion.Item>
                    </Accordion>
                  </section>
                )
              })}
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
        key={sourcesEntry.sequence}
        opened={statusPanel === 'sources'}
        onClose={() => setStatusPanel(null)}
        onExit={() => restoreSourcesFocus.current()}
        showScope={sourcesEntry.map}
        profile={profile}
        snapshot={snapshot}
        connected={!!system.connected}
        issues={issues.length}
      />
      <Modal
        opened={statusPanel === 'settings'}
        onClose={closeStatusPanel}
        title="Deployment settings"
        classNames={{ content: 'inspection-dialog-content' }}
      >
        <Text size="sm" className="deployment-settings-identity" mb="md">
          {deploymentLabel(profile)} · {profile.chainName || `Chain ${profile.chainId}`}
        </Text>
        <Stack gap="xs">
          <TextInput
            label="Read-only RPC endpoint"
            inputMode="url"
            value={rpc}
            onChange={(e) => setRpc(e.currentTarget.value)}
            placeholder="https://…"
            description="Used for the next inspection while you stay in this Workspace. Profile exports use the saved profile."
            inputWrapperOrder={['label', 'input', 'description', 'error']}
          />
          <Text size="xs" c="dimmed">
            Inspect live uses this endpoint and verifies chain {profile.chainId} before reading contracts. RPC credentials stay in server memory.
          </Text>
        </Stack>
        <Stack gap="xs" mt="md">
          <Text size="xs" fw={600} c="dimmed">
            Deployment profile
          </Text>
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
          <Group gap="xs" className="deployment-settings-actions">
            <Button variant="default" onClick={() => download(profile, 'deployment-profile.json')}>
              Export profile
            </Button>
            <FileButton
              accept="application/json,.json"
              onChange={(file) => {
                if (file)
                  void run('Importing deployment profile', async () => {
                    const imported = JSON.parse(await file.text())
                    await request('system/select', { profile: imported })
                    legacyMapDefaults.current = false
                    setParams({ view: 'workspace', deployment: String(imported.id) })
                    closeStatusPanel()
                    return true
                  })
              }}
            >
              {(props) => (
                <Button {...props} variant="default" disabled={busy}>
                  Import and switch deployment…
                </Button>
              )}
            </FileButton>
          </Group>
        </Stack>
      </Modal>
    </Tabs>
  )
}
