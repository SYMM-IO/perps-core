import { useWorkbench } from './api'
import { Address, Empty } from './components/Common'
import { connectWallet, WalletRequest } from './components/Signing'
import { Upgrade } from './components/Upgrade'
import { Workspace } from './components/Workspace'
import { lazyView } from './lib/lazy'
import { familyName, historyEntries, recordState, short, upgradeParams } from './lib/state'
import type { ContractNode } from './types'
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
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core'
import { CircleArrowUp, FlaskConical, GitBranch, History as HistoryIcon, Moon, Sun, Wallet, Waypoints } from 'lucide-react'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

const Fuzz = lazyView(() => import('./fuzz/Fuzz').then((module) => ({ default: module.Fuzz })))
const PAGES = {
  workspace: { label: 'Workspace', icon: Waypoints },
  upgrade: { label: 'Upgrade', icon: CircleArrowUp },
  history: { label: 'History', icon: HistoryIcon },
  fuzz: { label: 'Fuzz testing', icon: FlaskConical },
}
type Page = keyof typeof PAGES

export default function App() {
  const api = useWorkbench()
  const { engine, system, run, request } = api
  const [params, setParams] = useSearchParams()
  const requested = params.get('view') || 'workspace',
    view = (requested in PAGES ? requested : 'workspace') as Page
  const [wallet, setWallet] = useState(''),
    [access, setAccess] = useState('')
  const main = useRef<HTMLElement>(null),
    first = useRef(true)
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  const navigate = (page: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p)
      next.set('view', page)
      return next
    })
  useEffect(() => {
    document.title = `${PAGES[view].label} · SYMMIO`
    if (!first.current) {
      main.current?.focus()
      window.scrollTo({ top: 0 })
    }
    first.current = false
  }, [view])
  const prepare = (node: ContractNode) => setParams((p) => upgradeParams(p, node))
  const error = api.error || api.connectionError?.message || engine?.error || system?.error
  const operation = engine?.busy ? engine.activity : system?.busy ? system.activity : api.operation
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
              <button
                type="button"
                key={page}
                aria-current={view === page ? 'page' : undefined}
                className={view === page ? 'current' : ''}
                onClick={() => navigate(page)}
              >
                <Icon size={15} aria-hidden />
                <span>{PAGES[page].label}</span>
              </button>
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
              {error && (
                <Alert color="red" role="alert" withCloseButton={!!api.error} onClose={() => api.setError('')}>
                  {error}
                </Alert>
              )}
              {operation && (
                <Alert variant="light" color="gray" role="status">
                  <Group gap="sm">
                    <Loader size={14} />
                    <Text size="sm">{operation}</Text>
                  </Group>
                </Alert>
              )}
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

/** Saved plans for the selected deployment; plans from other chains are one click away, not mixed in. */
function History({ onWorkspace }: { onWorkspace: () => void }) {
  const { engine, system, run, request, busy } = useWorkbench()
  const [, setParams] = useSearchParams()
  const [everything, setEverything] = useState(false)
  const entries = historyEntries(engine?.history, system?.history),
    chain = system?.profile.chainId,
    here = entries.filter((h) => !h.chainId || h.chainId === chain),
    elsewhere = entries.length - here.length,
    shown = everything ? entries : here
  return (
    <Stack className="history-view" gap="sm">
      <Group justify="space-between" align="end">
        <div>
          <Title order={1} size="h3">
            Saved upgrades
          </Title>
          <Text size="sm" c="dimmed">
            {everything ? 'All deployments' : `${system?.profile.name || 'This deployment'} · Chain ${chain}`}
          </Text>
        </div>
        {!!elsewhere && (
          <Checkbox
            label={`Include ${elsewhere} from other deployments`}
            checked={everything}
            onChange={(e) => setEverything(e.currentTarget.checked)}
          />
        )}
      </Group>
      {shown.length ? (
        <div className="table-scroll">
          <Table highlightOnHover verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Contract</Table.Th>
                <Table.Th>Address</Table.Th>
                <Table.Th>Chain</Table.Th>
                <Table.Th>Created</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>
                  <span className="sr-only">Actions</span>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((h) => {
                const state = recordState(h.status)
                return (
                  <Table.Tr key={`${h.adapter}:${h.id}`}>
                    <Table.Td>
                      <Text size="sm" fw={600}>
                        {h.scope ? familyName(h.scope) : 'Diamond upgrade'}
                      </Text>
                    </Table.Td>
                    <Table.Td>{h.target && <Address value={h.target} />}</Table.Td>
                    <Table.Td>{h.chainId || '—'}</Table.Td>
                    <Table.Td>{new Date(h.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={state.color}>
                        {state.label}
                      </Badge>
                    </Table.Td>
                    <Table.Td className="contracts-action">
                      <Button
                        size="compact-sm"
                        variant="default"
                        disabled={busy}
                        onClick={() =>
                          run('Opening saved plan', async () => {
                            const record = await request(
                              h.adapter === 'system' ? 'system/open' : `plan?id=${h.id}`,
                              h.adapter === 'system' ? { id: h.id } : undefined,
                            )
                            setParams((p) => {
                              const next = new URLSearchParams(p)
                              next.set('view', 'upgrade')
                              next.set('adapter', h.adapter)
                              next.set('plan', h.id)
                              next.set('scope', record.plan.scope || 'core')
                              next.set('target', record.plan.snapshot?.target || record.plan.sourceAddress)
                              next.set('step', record.rehearsal?.status === 'passed' || record.status === 'verified' ? '2' : '1')
                              return next
                            })
                            return record
                          })
                        }
                      >
                        Open plan
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Tbody>
          </Table>
        </div>
      ) : (
        <Empty
          title={elsewhere ? `No saved upgrades for ${system?.profile.name || 'this deployment'}` : 'No saved upgrades yet'}
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
