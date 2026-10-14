import { CANCELLABLE, nextStep, useWorkbench, type ShownError } from './api'
import { Address, chainLabel, Empty, EnvironmentBadge } from './components/Common'
import { connectWallet, WalletRequest } from './components/Signing'
import { Upgrade } from './components/Upgrade'
import { Workspace } from './components/Workspace'
import { lazyView } from './lib/lazy'
import { familyName, historyEntries, inDeployment, planTarget, recordState, short, upgradeParams, type HistoryRow } from './lib/state'
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
  PasswordInput,
  Progress,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core'
import { CircleArrowUp, FlaskConical, GitBranch, History as HistoryIcon, Moon, Sun, Wallet, Waypoints } from 'lucide-react'
import { Suspense, useEffect, useRef, useState, type MouseEvent } from 'react'
import { useSearchParams } from 'react-router-dom'

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

export default function App() {
  const api = useWorkbench()
  const { engine, system, run } = api
  const [params, setParams] = useSearchParams()
  const requested = params.get('view') || 'workspace',
    view = (requested in PAGES ? requested : 'workspace') as Page
  const [wallet, setWallet] = useState(''),
    [access, setAccess] = useState('')
  const main = useRef<HTMLElement>(null),
    first = useRef(true)
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  const viewParams = (page: string) => {
    const next = new URLSearchParams(params)
    next.set('view', page)
    return next
  }
  const navigate = (page: string) => setParams(viewParams(page))
  useEffect(() => {
    document.title = `${PAGES[view].label} · SYMMIO`
    if (!first.current) {
      main.current?.focus()
      window.scrollTo({ top: 0 })
    }
    first.current = false
  }, [view])
  const prepare = (node: ContractNode) => setParams((p) => upgradeParams(p, node))
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
          <span className="brand-name">SYMMIO</span>
          <span className="brand-product">Perps Core</span>
        </div>
        <nav className="app-nav" aria-label="Sections">
          {(Object.keys(PAGES) as Page[]).map((page) => {
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
        <div className="header-tools">
          {engine?.build && (
            <span className="checkout-label" title="Checkout">
              <GitBranch size={13} aria-hidden />
              {engine.build.source.branch} · {engine.build.source.commit.slice(0, 8)}
            </span>
          )}
          <Tooltip label="Switch theme">
            <ActionIcon variant="default" size={36} aria-label="Switch theme" onClick={toggleColorScheme}>
              {colorScheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </ActionIcon>
          </Tooltip>
          <Button
            variant="default"
            leftSection={wallet ? <span className="dot" data-state="live" /> : <Wallet size={15} />}
            onClick={() =>
              run('Connecting wallet', async () => {
                const address = await connectWallet()
                setWallet(address)
                return address
              })
            }
          >
            {wallet ? short(wallet) : 'Connect wallet'}
          </Button>
        </div>
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        <Stack gap="sm">
          {!api.token || api.unauthorized ? (
            <section className="auth-panel panel">
              <Title order={1} size="h3">
                Connect to the local app
              </Title>
              <Text size="sm" c="dimmed">
                Paste the complete access link printed by <Code>npm run ui</Code>.
              </Text>
              <PasswordInput label="Local access link" value={access} onChange={(e) => setAccess(e.currentTarget.value)} mt="md" />
              <Button mt="md" onClick={() => api.login(access)}>
                Open
              </Button>
              {api.error && (
                <Alert mt="md" color="red">
                  {api.error}
                </Alert>
              )}
            </section>
          ) : (
            <>
              <ErrorBanner errors={errors} onDismiss={() => void api.dismiss(errors)} />
              <StatusRow
                reserve={view !== 'fuzz'}
                idle={params.get('adapter') === 'diamond' && view === 'upgrade' ? engine?.activity : system?.activity}
              />
              <WalletRequest />
              {view === 'fuzz' ? (
                <Suspense fallback={<Empty title="Loading fuzz report…" />}>
                  <Fuzz />
                </Suspense>
              ) : api.loading && !system ? (
                <Empty title="Loading…" action={<Loader size="sm" />} />
              ) : view === 'upgrade' ? (
                <Upgrade />
              ) : view === 'history' ? (
                <History onWorkspace={() => navigate('workspace')} />
              ) : (
                <Workspace onPrepare={prepare} />
              )}
            </>
          )}
        </Stack>
      </main>
      <footer>Local only · Plans, receipts and fuzz reports stay in this checkout</footer>
    </>
  )
}

/** One banner for every failure on screen, newest first, each with what failed and when. */
export function ErrorBanner({ errors, onDismiss }: { errors: ShownError[]; onDismiss: () => void }) {
  if (!errors.length) return null
  const [latest, ...older] = errors,
    step = nextStep(latest.code)
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

/**
 * What the app is doing: the running job's label, phase and progress, with Cancel where the server can abort it.
 * On workbench views the row keeps its height when idle and shows the last activity, so nothing below it moves.
 */
export function StatusRow({ reserve, idle }: { reserve: boolean; idle?: string }) {
  const { progress, jobs, operation, cancel, engine, system } = useWorkbench()
  const running = jobs.find((j) => j.state === 'running'),
    busy = engine?.busy ? engine : system?.busy ? system : undefined
  const label = progress?.label || busy?.activity || operation
  if (!label && !reserve) return null
  const fraction = progress?.total ? Math.min(1, (progress.done || 0) / progress.total) : undefined,
    since = progress?.startedAt ?? running?.startedAt
  return (
    <div className="status-row" role="status" data-busy={label ? true : undefined}>
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
export function History({ onWorkspace }: { onWorkspace: () => void }) {
  const { engine, system, run, request, busy } = useWorkbench()
  const [, setParams] = useSearchParams()
  const [everything, setEverything] = useState(false)
  const profiles = system?.profiles || [],
    profile = system?.profile
  const entries = historyEntries(engine?.history, system?.history).map((h) => withActive(h, [engine?.active, system?.active]))
  const pinned = entries.filter((h) => h.active),
    rest = entries.filter((h) => !h.active),
    here = rest.filter((h) => inDeployment(h, profile)),
    elsewhere = rest.length - here.length,
    shown = everything ? rest : here,
    byChain = !everything && here.some((h) => !h.deployment)
  const open = (h: HistoryRow) =>
    run('Opening saved plan', async () => {
      const record = h.adapter === 'system' ? await request('system/open', { id: h.id }) : await request(`plan?id=${h.id}`)
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
  const name = (h: HistoryRow) => contractName(h, profiles) || (h.scope ? familyName(h.scope) : 'Diamond upgrade')
  const deployment = (h: HistoryRow) => (
    <Group gap={6} wrap="nowrap">
      <Text size="sm">{h.deployment?.name || chainLabel(h.chainId, profiles)}</Text>
      <EnvironmentBadge environment={h.deployment?.environment} />
    </Group>
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
              : `Prepared for ${profile?.name || 'this deployment'}${profile?.environment ? ` (${profile.environment})` : ''}${
                  byChain ? `, and older plans on ${chainLabel(profile?.chainId, profiles)} that do not record a deployment` : ''
                }`}
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
              <Button disabled={busy} onClick={() => open(h)}>
                Open plan
              </Button>
            </Group>
          </section>
        )
      })}
      {shown.length ? (
        <div className="table-scroll">
          <Table highlightOnHover verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Contract</Table.Th>
                <Table.Th>Deployment</Table.Th>
                <Table.Th>Address</Table.Th>
                <Table.Th>Created</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>
                  <span className="sr-only">Actions</span>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((h) => {
                const state = recordState(h)
                return (
                  <Table.Tr key={`${h.adapter}:${h.id}`}>
                    <Table.Td>
                      <Text size="sm" fw={600}>
                        {name(h)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {familyName(h.scope)}
                      </Text>
                    </Table.Td>
                    <Table.Td>{deployment(h)}</Table.Td>
                    <Table.Td>{h.target && <Address value={h.target} />}</Table.Td>
                    <Table.Td>{h.at ? new Date(h.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={state.color}>
                        {state.label}
                      </Badge>
                    </Table.Td>
                    <Table.Td className="contracts-action">
                      <Button size="compact-sm" variant="default" disabled={busy} onClick={() => open(h)}>
                        Open plan
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Tbody>
          </Table>
        </div>
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
