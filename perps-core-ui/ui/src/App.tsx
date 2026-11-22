import { CANCELLABLE, nextStep, useWorkbench, type ShownError } from './api'
import { chainLabel, Empty, EnvironmentBadge, ResponsiveReview } from './components/Common'
import { WalletRequest } from './components/Signing'
import { Upgrade } from './components/Upgrade'
import { Workspace } from './components/Workspace'
import { lazyView } from './lib/lazy'
import { familyName, historyEntries, inDeployment, planTarget, recordState, upgradeParams, type HistoryRow } from './lib/state'
import type { ActiveTask, ContractNode, Profile, Time } from './types'
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Loader,
  Menu,
  PasswordInput,
  Progress,
  Stack,
  Table,
  Text,
  Title,
  useMantineColorScheme,
} from '@mantine/core'
import { CircleArrowUp, Eye, EyeOff, FlaskConical, History as HistoryIcon, Moon, Sun, MoreHorizontal, Waypoints } from 'lucide-react'
import { Suspense, useEffect, useEffectEvent, useRef, useState, type MouseEvent } from 'react'
import { useLocation, useNavigationType, useSearchParams } from 'react-router-dom'

const Fuzz = lazyView(() => import('./fuzz/Fuzz').then((module) => ({ default: module.Fuzz })))
const PAGES = {
  workspace: { label: 'Workspace', icon: Waypoints },
  upgrade: { label: 'Upgrade', icon: CircleArrowUp },
  history: { label: 'History', icon: HistoryIcon },
  fuzz: { label: 'Fuzz testing', icon: FlaskConical },
}
type Page = keyof typeof PAGES

const clock = (at: Time) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
/** A plain left click stays in the app; modified and middle clicks are left to the browser, so a section opens in a new tab. */
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

function restoreSectionScroll(main: HTMLElement, top: number) {
  let frame = 0
  const input = new AbortController()
  const stop = () => {
    observer.disconnect()
    window.cancelAnimationFrame(frame)
    input.abort()
  }
  const restore = () => {
    const viewport = document.scrollingElement
    // A loading state or lazy section can be shorter than the page that was left.
    if (!viewport || viewport.scrollHeight - viewport.clientHeight < top) return
    window.scrollTo({ top })
    stop()
  }
  const schedule = () => {
    window.cancelAnimationFrame(frame)
    frame = window.requestAnimationFrame(restore)
  }
  const observer = new ResizeObserver(schedule)
  observer.observe(main)
  schedule()
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    window.addEventListener(event, stop, { passive: true, signal: input.signal })
  }
  return stop
}

export default function App() {
  const api = useWorkbench()
  const { system } = api
  const [params, setParams] = useSearchParams()
  const { key } = useLocation()
  const navigationType = useNavigationType()
  const requested = params.get('view') || 'workspace',
    view = (requested in PAGES ? requested : 'workspace') as Page
  const showAccessForm = !api.token || api.unauthorized
  const [moreOpened, setMoreOpened] = useState(false)
  const [access, setAccess] = useState('')
  const [accessVisible, setAccessVisible] = useState(false)
  const [accessSubmission, setAccessSubmission] = useState(0)
  const accessField = useRef<HTMLInputElement>(null)
  const loadingWorkspace = !showAccessForm && view !== 'fuzz' && api.loading && !system
  const [loadingStatus, setLoadingStatus] = useState('')
  const main = useRef<HTMLElement>(null),
    previousView = useRef(view),
    sectionScroll = useRef(new Map<string, number>())
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  const viewParams = (page: string) => {
    const next = new URLSearchParams(params)
    next.set('view', page)
    return next
  }
  const rememberSectionScroll = (top = window.scrollY) => sectionScroll.current.set(key, top)
  const navigate = (page: string) => {
    if (page !== view) rememberSectionScroll()
    setParams(viewParams(page))
  }
  useEffect(() => {
    document.title = `${showAccessForm ? 'Connect' : PAGES[view].label} · SYMMIO`
  }, [showAccessForm, view])
  useEffect(() => {
    if (accessSubmission && api.accessError) accessField.current?.focus()
  }, [accessSubmission, api.accessError])
  useEffect(() => {
    if (showAccessForm) setMoreOpened(false)
    else setAccessVisible(false)
  }, [showAccessForm])
  useEffect(() => {
    setLoadingStatus(loadingWorkspace ? 'Loading workspace…' : '')
  }, [loadingWorkspace])
  const updateSection = useEffectEvent(() => {
    if (previousView.current === view) return
    previousView.current = view
    if (navigationType !== 'POP') {
      main.current?.focus()
      window.scrollTo({ top: 0 })
    } else if (main.current) {
      main.current.focus({ preventScroll: true })
      const top = sectionScroll.current.get(key)
      if (top !== undefined) {
        sectionScroll.current.delete(key)
        return restoreSectionScroll(main.current, top)
      }
    }
  })
  useEffect(() => updateSection(), [view])
  const prepare = (node: ContractNode) => {
    rememberSectionScroll()
    setParams((p) => upgradeParams(p, node))
  }
  // Server errors belong to the workbench; the fuzz report keeps only this tab's own errors.
  const errors = view === 'fuzz' ? api.errors.filter((e) => !e.source) : api.errors
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <img src="/docs/v0.8.6/assets/symmio-mark.svg" alt="" width={20} height={20} />
          </span>
          <span className="brand-name" translate="no">
            SYMMIO
          </span>
        </div>
        {showAccessForm ? (
          <div className="header-tools">
            <Button
              variant="subtle"
              color="gray"
              size="compact-sm"
              leftSection={colorScheme === 'dark' ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
              onClick={toggleColorScheme}
            >
              Switch theme
            </Button>
          </div>
        ) : (
          <>
            <nav className="app-nav" aria-label="Sections">
              {(['workspace', 'history'] as Page[]).map((page) => {
                const Icon = PAGES[page].icon
                return (
                  <a
                    key={page}
                    href={`?${viewParams(page)}`}
                    aria-current={view === page ? 'page' : undefined}
                    className={view === page ? 'current' : ''}
                    onClick={(e) => {
                      if (!plainClick(e)) return
                      e.preventDefault()
                      navigate(page)
                    }}
                  >
                    <Icon size={15} aria-hidden />
                    <span>{PAGES[page].label}</span>
                  </a>
                )
              })}
            </nav>
            <Menu position="bottom-end" width={200} opened={moreOpened} onChange={setMoreOpened} transitionProps={{ duration: 0 }}>
              <Menu.Target>
                <Button
                  variant="subtle"
                  color="gray"
                  size="compact-sm"
                  leftSection={<MoreHorizontal size={16} aria-hidden />}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && moreOpened) {
                      event.preventDefault()
                      setMoreOpened(false)
                    }
                  }}
                >
                  {view === 'upgrade' || view === 'fuzz' ? PAGES[view].label : 'More'}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {(['upgrade', 'fuzz'] as Page[]).map((page) => {
                  const Icon = PAGES[page].icon
                  return (
                    <Menu.Item
                      key={page}
                      component="a"
                      href={`?${viewParams(page)}`}
                      leftSection={<Icon size={14} />}
                      onClick={(event) => {
                        if (plainClick(event)) {
                          event.preventDefault()
                          navigate(page)
                        }
                      }}
                    >
                      {PAGES[page].label}
                    </Menu.Item>
                  )
                })}
                <Menu.Divider />
                <Menu.Item leftSection={colorScheme === 'dark' ? <Sun size={14} /> : <Moon size={14} />} onClick={toggleColorScheme}>
                  Switch theme
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </>
        )}
      </header>
      <main id="main" ref={main} tabIndex={-1} data-view={view}>
        <span className="sr-only" role="status">
          {loadingStatus}
        </span>
        <Stack gap="sm">
          {showAccessForm ? (
            <section className="auth-panel panel">
              <Title order={1} size="h3">
                {api.unauthorized ? 'Reconnect to the local app' : 'Connect to the local app'}
              </Title>
              {api.unauthorized && (
                <Text size="sm" c="dimmed" role="alert">
                  Your previous session ended.
                </Text>
              )}
              <Text size="sm" c="dimmed">
                {api.unauthorized ? 'Paste the current access link printed by ' : 'Paste the complete access link printed by '}
                <Code translate="no" style={{ whiteSpace: 'nowrap' }}>
                  npm run ui
                </Code>
                .
              </Text>
              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault()
                  api.login(access)
                  setAccessSubmission((count) => count + 1)
                }}
              >
                <PasswordInput
                  ref={accessField}
                  label="Local access link"
                  name="access"
                  required
                  withAsterisk={false}
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={access}
                  onChange={(e) => setAccess(e.currentTarget.value)}
                  error={api.accessError ? <span role="alert">{api.accessError}</span> : undefined}
                  aria-invalid={!!api.accessError || undefined}
                  visible={accessVisible}
                  rightSection={
                    <ActionIcon
                      type="button"
                      variant="subtle"
                      color="gray"
                      aria-label={accessVisible ? 'Hide access link' : 'Show access link'}
                      onClick={() => setAccessVisible((visible) => !visible)}
                    >
                      {accessVisible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                    </ActionIcon>
                  }
                  mt="md"
                />
                <Button mt="md" type="submit">
                  {api.unauthorized ? 'Reconnect' : 'Connect'}
                </Button>
              </form>
              {api.error && !api.accessError && (
                <Alert mt="md" color="red" role="alert">
                  {api.error}
                </Alert>
              )}
            </section>
          ) : (
            <>
              <ErrorBanner errors={errors} onDismiss={() => void api.dismiss(errors)} />
              <StatusRow reserve={false} />
              <WalletRequest />
              {view === 'workspace' && api.profilesError && (
                <Group gap="xs" role="status">
                  <Text size="sm">Couldn’t load the deployment catalogue.</Text>
                  <Button size="compact-sm" variant="default" loading={api.profilesRetrying} onClick={() => void api.retryProfiles()}>
                    Retry
                  </Button>
                </Group>
              )}
              {view === 'fuzz' ? (
                <Suspense fallback={<Empty title="Loading fuzz report…" loading />}>
                  <Fuzz />
                </Suspense>
              ) : loadingWorkspace ? (
                <div aria-busy="true">
                  <Empty title="Loading workspace…" loading />
                </div>
              ) : view === 'workspace' && !system && api.systemError ? (
                <Empty
                  title="Could not load the workspace"
                  action={
                    <Button variant="default" loading={api.systemRetrying} onClick={() => void api.retrySystem()}>
                      Retry loading workspace
                    </Button>
                  }
                />
              ) : view === 'upgrade' ? (
                <Upgrade />
              ) : view === 'history' ? (
                <History onWorkspace={() => navigate('workspace')} onOpenPlan={rememberSectionScroll} />
              ) : (
                <Workspace onPrepare={prepare} />
              )}
            </>
          )}
        </Stack>
      </main>
    </>
  )
}

/** One banner for every failure on screen, newest first, each with what failed and when. */
export function ErrorBanner({ errors, onDismiss }: { errors: ShownError[]; onDismiss: () => void }) {
  if (!errors.length) return null
  const [latest, ...older] = errors,
    step = recoveryStep(latest)
  return (
    <Alert
      color="red"
      role="alert"
      title={`${latest.operation} failed · ${clock(latest.at)}`}
      withCloseButton
      closeButtonLabel="Dismiss"
      onClose={onDismiss}
    >
      <Text size="sm" className="break">
        {latest.message}
      </Text>
      {step && (
        <Text size="sm" mt={4} fw={600}>
          {step}
        </Text>
      )}
      {older.map((e) => (
        <Text size="sm" mt="xs" key={e.id} className="break">
          <b>
            {e.operation} failed · {clock(e.at)}
          </b>{' '}
          {e.message}
        </Text>
      ))}
    </Alert>
  )
}

function recoveryStep(error: ShownError) {
  const fallback = nextStep(error.code)
  const rpcSettings = 'Open the status menu beside Inspect live and select Deployment settings. Check the RPC endpoint'
  switch (error.operation.toLowerCase()) {
    case 'scan':
    case 'inspection':
    case 'inspecting live deployment':
      if (error.code === 'rpc') return `${rpcSettings}, then select Inspect live again.`
      return fallback ?? 'Resolve the reported issue, then select Inspect live again.'
    case 'connect':
      return error.code === 'rpc' ? 'Check the RPC endpoint under Change target or RPC, then select Inspect & compile again.' : fallback
    case 'compile':
    case 'compiling the current checkout':
    case 'inspecting target and compiling source':
      if (error.code === 'rpc') return 'Check the RPC endpoint under Change target or RPC, then select Inspect & compile again.'
      return fallback ?? 'Review the reported issue, then select Inspect & compile again.'
    case 'compare':
    case 'compiling and comparing source':
      if (error.code === 'not-ready') return 'Select Inspect live, then select Compare source again.'
      if (error.code === 'rpc') return `${rpcSettings}, then select Compare source again.`
      return fallback ?? 'Resolve the reported issue, then select Compare source again.'
    default:
      return fallback
  }
}

function Elapsed({ since }: { since: Time }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000)),
    pad = (n: number) => String(n).padStart(2, '0'),
    minutes = Math.floor(seconds / 60)
  return (
    <Text size="sm" c="dimmed" className="status-elapsed">
      {minutes >= 60 ? `${Math.floor(minutes / 60)}:${pad(minutes % 60)}` : minutes}:{pad(seconds % 60)} elapsed
    </Text>
  )
}

const JOB_OUTCOME = {
  done: 'Operation complete.',
  failed: 'Operation failed.',
  cancelled: 'Operation cancelled.',
  running: 'Operation ended.',
}

/**
 * What the app is doing: the running job's label, phase and progress, with Cancel where the server can abort it.
 * On workbench views the row keeps its height when idle and shows the last activity, so nothing below it moves.
 */
export function StatusRow({ reserve, idle }: { reserve: boolean; idle?: string }) {
  const { progress, jobs, operation, cancel, engine, system } = useWorkbench()
  const running = jobs.find((j) => j.state === 'running'),
    busy = engine?.busy ? engine : system?.busy ? system : undefined
  const label = progress?.label || busy?.activity || operation
  const phase = progress?.phase || busy?.activity || operation
  const phaseStatus = progress && progress.phaseCount > 1 ? `Phase ${progress.phaseIndex} of ${progress.phaseCount}. ${phase}` : phase
  const activeJob = useRef<{ id?: string } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const runningId = running?.id
  useEffect(() => {
    if (phaseStatus) {
      activeJob.current = { id: runningId ?? activeJob.current?.id }
      setAnnouncement(phaseStatus)
    } else if (activeJob.current) {
      const outcome = jobs.find((job) => job.id === activeJob.current?.id)?.state
      activeJob.current = null
      setAnnouncement(outcome ? JOB_OUTCOME[outcome] : 'Operation ended.')
    }
  }, [phaseStatus, runningId, jobs])
  const fraction = progress?.total ? Math.min(1, (progress.done || 0) / progress.total) : undefined,
    since = progress?.startedAt ?? running?.startedAt
  return (
    <>
      <span className="sr-only" role="status">
        {announcement}
      </span>
      {(label || reserve) && (
        <div className="status-row" data-busy={label ? true : undefined}>
          {label ? (
            <>
              <Loader size={14} aria-hidden />
              <Text size="sm" fw={600} className="status-label">
                {label}
              </Text>
              {progress && progress.phaseCount > 1 && (
                <Text size="sm" c="dimmed">
                  Phase {progress.phaseIndex} of {progress.phaseCount}
                  {progress.phase && progress.phase !== label ? ` · ${progress.phase}` : ''}
                </Text>
              )}
              {!progress && busy?.activity && operation && busy.activity !== operation && (
                <Text size="sm" c="dimmed" className="status-detail">
                  {busy.activity}
                </Text>
              )}
              {fraction !== undefined && (
                <>
                  <Progress className="status-bar" value={fraction * 100} size="sm" aria-label={`${label}: ${Math.round(fraction * 100)}%`} />
                  <Text size="sm" c="dimmed">
                    {progress!.done || 0} of {progress!.total}
                  </Text>
                </>
              )}
              {since !== undefined && <Elapsed since={since} />}
              {running && CANCELLABLE.includes(running.route) && (
                <Button size="compact-sm" variant="default" ml="auto" onClick={() => void cancel(running.id)}>
                  Cancel
                </Button>
              )}
            </>
          ) : (
            idle && (
              <Text size="sm" c="dimmed" className="status-label">
                {idle}
              </Text>
            )
          )}
        </div>
      )}
    </>
  )
}

/** Adds what the status payloads say about the active task to a history row, for servers that do not mark it. */
function withActive(h: HistoryRow, tasks: (ActiveTask | undefined)[]): HistoryRow {
  const task = tasks.find((t) => t?.input?.planId === h.id)
  return task && !h.active ? { ...h, active: true, taskStatus: task.status, waitingFor: task.waitingFor || task.lastError || undefined } : h
}
/** The contract a plan targets, by its address-book name where the deployment lists it. */
function contractName(h: HistoryRow, profiles: Profile[]) {
  const profile = profiles.find((p) => p.id === h.deployment?.id) || profiles.find((p) => p.chainId === h.chainId)
  return profile?.nodes.find((n) => n.address?.toLowerCase() === h.target?.toLowerCase())?.name
}

/**
 * Saved plans for the selected deployment, newest first. The plan a task is running is pinned above them whatever the filter,
 * since it is where every recovery starts. Plans for other deployments are one checkbox away.
 */
export function History({ onWorkspace, onOpenPlan }: { onWorkspace: () => void; onOpenPlan?: (top: number) => void }) {
  const { engine, system, run, request, busy } = useWorkbench()
  const [params, setParams] = useSearchParams()
  const everything = params.get('historyScope') === 'all'
  const setEverything = (all: boolean) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (all) next.set('historyScope', 'all')
        else next.delete('historyScope')
        return next
      },
      { replace: true, preventScrollReset: true },
    )
  const profiles = system?.profiles || [],
    profile = system?.profile
  const entries = historyEntries(engine?.history, system?.history).map((h) => withActive(h, [engine?.active, system?.active]))
  const pinned = entries.filter((h) => h.active),
    rest = entries.filter((h) => !h.active),
    here = rest.filter((h) => inDeployment(h, profile)),
    elsewhere = rest.length - here.length,
    shown = everything ? rest : here
  const open = (h: HistoryRow) => {
    // Opening can insert a status row and shift the document before its request finishes.
    const top = window.scrollY
    run('Opening saved plan', async () => {
      const record = h.adapter === 'system' ? await request('system/open', { id: h.id }) : await request(`plan?id=${h.id}`)
      onOpenPlan?.(top)
      setParams((p) => {
        const next = new URLSearchParams(p)
        next.set('view', 'upgrade')
        next.set('adapter', h.adapter)
        next.set('plan', h.id)
        next.set('scope', record.plan.scope || 'core')
        next.set('target', planTarget(record.plan))
        next.set('step', record.rehearsal?.status === 'passed' || record.status === 'verified' ? '2' : '1')
        return next
      })
      return record
    })
  }
  const name = (h: HistoryRow) => contractName(h, profiles) || (h.scope ? familyName(h.scope) : 'Diamond upgrade')
  const deploymentName = (h: HistoryRow) => h.deployment?.name || chainLabel(h.chainId, profiles)
  const deployment = (h: HistoryRow, historyRow = false) => {
    if (historyRow && !h.deployment) {
      return (
        <Text size="sm">
          {h.chainId != null && chainLabel(h.chainId, profiles)}
          <Text component="span" size="xs" c="dimmed">
            {h.chainId != null ? ' · no deployment recorded' : 'No deployment recorded'}
          </Text>
        </Text>
      )
    }
    return (
      <Group gap={6}>
        <Text size="sm" className="break">
          {deploymentName(h)}
        </Text>
        <EnvironmentBadge environment={h.deployment?.environment} />
      </Group>
    )
  }
  const rows = shown.map((plan) => ({
    plan,
    contract: name(plan),
    created: plan.at ? new Date(plan.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—',
    state: recordState(plan),
  }))
  const referenceGroups = new Map<string, Set<string>>()
  for (const { id } of entries) {
    const prefix = id.slice(0, 8)
    const group = referenceGroups.get(prefix) ?? new Set<string>()
    group.add(id)
    referenceGroups.set(prefix, group)
  }
  const reference = (id: string) => {
    const prefix = id.slice(0, 8)
    const group = referenceGroups.get(prefix)
    if (!group || group.size === 1) return prefix
    const others = [...group].filter((candidate) => candidate !== id)
    for (let length = 1; length < id.length - prefix.length; length++) {
      const suffix = id.slice(-length)
      if (others.every((candidate) => !candidate.endsWith(suffix))) return `${prefix}…${suffix}`
    }
    return id
  }
  const planReference = (id: string) => (
    <Text span size="xs" c="dimmed">
      Plan <code className="history-plan-id" title={id} translate="no">{reference(id)}</code>
    </Text>
  )
  const savedStatus = (state: ReturnType<typeof recordState>) => (
    <Badge variant="light" color={state.color}>
      {state.label}
    </Badge>
  )
  const openSavedPlan = (plan: HistoryRow, contract: string) => (
    <Button
      size="compact-sm"
      variant="default"
      disabled={busy}
      aria-label={`Open plan for ${contract} · Plan ${reference(plan.id)}`}
      aria-description={reference(plan.id).length > 8 ? plan.id : undefined}
      onClick={() => open(plan)}
    >
      Open plan
    </Button>
  )
  return (
    <Stack className="history-view" gap="sm">
      <Group justify="space-between" align="end">
        <div>
          <Title order={1} size="h3">
            Saved upgrades
          </Title>
          <Text size="sm" c="dimmed">
            {everything
              ? 'Every deployment'
              : `Prepared for ${profile?.name || 'this deployment'}${profile?.environment ? ` (${profile.environment})` : ''}`}
          </Text>
        </div>
        {(!!elsewhere || everything) && (
          <Checkbox
            label={`Show other deployments${elsewhere ? ` (${elsewhere})` : ''}`}
            checked={everything}
            onChange={(e) => setEverything(e.currentTarget.checked)}
          />
        )}
      </Group>
      {pinned.map((h) => {
        const state = recordState(h)
        return (
          <section className="panel history-active" key={`${h.adapter}:${h.id}`} aria-label="Plan in progress">
            <Group justify="space-between" align="center" wrap="wrap">
              <Stack gap={4}>
                <Group gap={6} c="dimmed">
                  <Text size="sm">In progress · {familyName(h.scope)} ·</Text>
                  {deployment(h)}
                </Group>
                <Group gap="sm">
                  <Title order={2} size="h4">
                    {name(h)}
                  </Title>
                  <Badge variant="light" color={state.color}>
                    {state.label}
                  </Badge>
                </Group>
                {state.detail && (
                  <Text size="sm" className="break">
                    {state.detail}
                  </Text>
                )}
              </Stack>
              <Button
                disabled={busy}
                aria-label={`Open plan for ${name(h)} · Plan ${reference(h.id)}`}
                aria-description={reference(h.id).length > 8 ? h.id : undefined}
                onClick={() => open(h)}
              >
                Open plan
              </Button>
            </Group>
          </section>
        )
      })}
      {shown.length ? (
        <ResponsiveReview
          className="history-records"
          table={
            <Table highlightOnHover verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Contract</Table.Th>
                  {everything && <Table.Th>Deployment</Table.Th>}
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>
                    <span className="sr-only">Actions</span>
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map(({ plan, contract, created, state }) => (
                  <Table.Tr key={`${plan.adapter}:${plan.id}`}>
                    <Table.Td>
                      <Group gap="4px 8px">
                        <Text size="sm" fw={600} className="break">
                          {contract}
                        </Text>
                        {planReference(plan.id)}
                      </Group>
                      {!everything && !plan.deployment && deployment(plan, true)}
                    </Table.Td>
                    {everything && <Table.Td>{deployment(plan, true)}</Table.Td>}
                    <Table.Td>{created}</Table.Td>
                    <Table.Td className="history-status-cell">{savedStatus(state)}</Table.Td>
                    <Table.Td className="contracts-action">{openSavedPlan(plan, contract)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          }
          rows={rows.map(({ plan, contract, created, state }) => (
            <li className="review-row" key={`${plan.adapter}:${plan.id}`}>
              <Text size="sm" fw={600} className="break">
                {contract}
              </Text>
              {everything && deployment(plan, true)}
              <Group gap="6px 8px">
                {savedStatus(state)}
                {openSavedPlan(plan, contract)}
              </Group>
              <Group gap="4px 8px">
                <Text span size="xs" c="dimmed">
                  Created {created}
                </Text>
                {planReference(plan.id)}
              </Group>
              {!everything && !plan.deployment && deployment(plan, true)}
            </li>
          ))}
        />
      ) : pinned.length ? null : (
        <Empty
          title={elsewhere ? `No saved upgrades for ${profile?.name || 'this deployment'}` : 'No saved upgrades yet'}
          action={
            elsewhere ? (
              <Button variant="default" onClick={() => setEverything(true)}>
                Show {elsewhere} from other deployments
              </Button>
            ) : (
              <Button variant="default" onClick={onWorkspace}>
                Choose a contract
              </Button>
            )
          }
        >
          Prepared plans, rehearsal results and receipts appear here.
        </Empty>
      )}
    </Stack>
  )
}
