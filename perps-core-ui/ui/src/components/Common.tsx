import { useWorkbench } from '../api'
import { httpUrl, planChainId, short } from '../lib/state'
import type { Deployment, Plan, Profile } from '../types'
import { ActionIcon, Alert, Badge, Button, Code, Group, Loader, Stack, Text, Tooltip } from '@mantine/core'
import { Box, Check, Copy, ExternalLink, Gem, Handshake, Layers, ShieldCheck, Zap, type LucideIcon } from 'lucide-react'
import { Children, createContext, isValidElement, useContext, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export function Address({
  value,
  align = 'start',
  href,
  compact = false,
}: {
  value: string
  align?: 'start' | 'center'
  href?: string
  compact?: boolean
}) {
  const [copied, setCopied] = useState(false),
    [copyFailed, setCopyFailed] = useState(false)
  return (
    <Stack gap={4}>
      <Group gap={6} wrap="nowrap" align="center" justify={align === 'center' ? 'center' : 'flex-start'}>
        <Code className="address" title={compact ? value : undefined} translate="no">
          {compact ? short(value) : value}
        </Code>
        <Tooltip label={copied ? 'Copied' : 'Copy address'}>
          <ActionIcon
            variant="subtle"
            aria-label={copied ? 'Copied address' : 'Copy address'}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value)
                setCopied(true)
                setCopyFailed(false)
                setTimeout(() => setCopied(false), 1800)
              } catch {
                setCopied(false)
                setCopyFailed(true)
              }
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </ActionIcon>
        </Tooltip>
        {href && (
          <Tooltip label="View on explorer">
            <ActionIcon component="a" variant="subtle" href={href} target="_blank" rel="noopener noreferrer" aria-label="View on explorer">
              <ExternalLink size={15} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      <span className="sr-only" role="status">
        {copied ? 'Copied to clipboard' : ''}
      </span>
      {copyFailed && (
        <>
          <Text size="xs" c="red" role="alert">
            Could not copy the address. Select and copy the full address below.
          </Text>
          <Code className="address address-copy-fallback" translate="no">
            {value}
          </Code>
        </>
      )}
    </Stack>
  )
}
const KIND_ICONS: Record<string, LucideIcon> = { core: Gem, accountLayer: Layers, instantLayer: Zap, partyB: Handshake, verifier: ShieldCheck }
/** The rounded icon that stands for a contract family wherever one is named. */
export function KindTile({ kind }: { kind: string }) {
  const Icon = KIND_ICONS[kind] || Box
  return (
    <span className="tile" data-kind={kind} aria-hidden>
      <Icon size={18} />
    </span>
  )
}
export function Empty({
  title,
  children,
  action,
  loading = false,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
  loading?: boolean
}) {
  return (
    <Stack className="empty-state" data-loading={loading || undefined} align="center" gap="sm">
      {loading ? (
        <Group gap="xs" justify="center" wrap="nowrap">
          <Loader size="sm" aria-hidden />
          <Text fw={600}>{title}</Text>
        </Group>
      ) : (
        <Text fw={600}>{title}</Text>
      )}
      {children && (
        <Text c="dimmed" size="sm" ta="center" maw={520}>
          {children}
        </Text>
      )}
      {action}
    </Stack>
  )
}
/** Switch from a comparison table to flat rows when the panel has less room. */
export function ResponsiveReview({ table, rows, className }: { table: ReactNode; rows: ReactNode; className?: string }) {
  return (
    <div className={className ? `responsive-review ${className}` : 'responsive-review'}>
      <div className="review-table">{table}</div>
      <ul className="review-rows" role="list">
        {rows}
      </ul>
    </div>
  )
}

/**
 * A long list that starts collapsed behind its count, with a filter once opened. Short lists and lists
 * with something wrong (`attention`) render as they always did. Filtering matches each child's key, so
 * callers put the searchable text — address, name — in the key.
 */
export function Collection({
  children,
  attention = false,
  unit = 'members',
  flow = 'rows',
}: {
  children: ReactNode
  attention?: boolean
  unit?: string
  /** `rows` stacks one item per line; `inline` keeps pills flowing like text. */
  flow?: 'rows' | 'inline'
}) {
  const [query, setQuery] = useState('')
  const filterId = useId()
  const filterInput = useRef<HTMLInputElement>(null)
  const items = Children.toArray(children)
  if (items.length <= 6 || attention) return <>{children}</>
  const q = query.trim().toLowerCase()
  const matches = items.flatMap((child, index) => {
    const key = isValidElement(child) ? child.key : null
    if (q && !String(key || '').toLowerCase().includes(q)) return []
    return [{ child, key: key ?? index }]
  })
  return (
    <details className="inspector-collection">
      <summary>
        {items.length} {unit}{' '}
        <Text span size="xs" c="dimmed">
          · expand list
        </Text>
      </summary>
      <Text component="label" htmlFor={filterId} display="block" size="sm" c="dimmed">
        Filter {unit}
      </Text>
      <input
        id={filterId}
        ref={filterInput}
        value={query}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => setQuery(e.currentTarget.value)}
      />
      <Text role="status" size="sm" c="dimmed">
        {matches.length === 0 && `No matching ${unit}`}
      </Text>
      {matches.length === 0 && (
        <Button
          type="button"
          size="compact-xs"
          variant="default"
          mt={4}
          onClick={() => {
            setQuery('')
            filterInput.current?.focus()
          }}
        >
          Clear filter
        </Button>
      )}
      <div className="inspector-collection-items" data-flow={flow}>
        {matches.map(({ child, key }) => (
          <div key={key}>{child}</div>
        ))}
      </div>
    </details>
  )
}
export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <Alert color="red" role="alert">
      {children}
    </Alert>
  )
}
export function StatusBadge({ status }: { status: string }) {
  const set = ['verified', 'set', 'confirmed', 'passed'].includes(status)
  const missing = ['missing', 'mismatch', 'failed', 'no-code'].includes(status)
  return (
    <Badge variant="light" color={set ? 'teal' : missing ? 'red' : 'gray'}>
      {set ? '✓ ' : missing ? '× ' : '? '}
      {status}
    </Badge>
  )
}
export function JsonView({ value }: { value: unknown }) {
  return (
    <Code block className="json-code" translate="no">
      {JSON.stringify(value, null, 2)}
    </Code>
  )
}
export function CopyData({ value }: { value: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState('')
  return (
    <>
      <Button
        size="xs"
        variant="default"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            setError('')
            setTimeout(() => setCopied(false), 1800)
          } catch {
            setCopied(false)
            setError('Copy failed. Select the calldata above.')
          }
        }}
      >
        {copied ? 'Copied' : 'Copy calldata'}
      </Button>
      <Text size="xs" c="dimmed" role="status" className={error ? undefined : 'sr-only'}>
        {copied ? 'Copied to clipboard' : error}
      </Text>
    </>
  )
}

/** The deployment a plan was prepared for. Peripheral plans saved before plans carried `deployment` still name their profile. */
export function planDeployment(plan: Plan): Deployment | undefined {
  const d = plan.deployment || (plan.kind === 'peripheral' ? plan.profile : undefined)
  return d?.id ? { id: d.id, name: d.name || d.id, environment: d.environment, chainId: d.chainId ?? planChainId(plan) } : undefined
}
/** The address book's name for a chain ("arbitrum"), or "chain 42161" when no profile names it. */
export const chainName = (chainId: number | undefined, profiles: Profile[] = []) =>
  profiles.find((p) => p.chainId === chainId && p.chainName)?.chainName || `chain ${chainId ?? '?'}`
/** "arbitrum (42161)" when the address book names the chain, otherwise "Chain 42161". */
export function chainLabel(chainId: number | undefined, profiles: Profile[] = []) {
  const name = profiles.find((p) => p.chainId === chainId && p.chainName)?.chainName
  return name ? `${name} (${chainId})` : `Chain ${chainId ?? '?'}`
}
export function EnvironmentBadge({ environment }: { environment?: string }) {
  if (!environment) return null
  return (
    <span className="env-badge" data-env={environment}>
      {environment}
    </span>
  )
}
export function explorerTx(explorer: string | undefined, hash: string) {
  const base = httpUrl(explorer)
  return base ? `${base.replace(/\/$/, '')}/tx/${hash}` : undefined
}
/** Wallet hashes are public, so they are kept in localStorage per plan and action and outlive a closed tab. */
const txKey = (planId: string, actionId: string) => `workbench-tx:${planId}:${actionId}`
export function saveTxHash(planId: string, actionId: string, value: { hash: string; sender?: string; nonce?: number | string }) {
  try {
    localStorage.setItem(txKey(planId, actionId), JSON.stringify({ ...value, at: new Date().toISOString() }))
  } catch {}
}
export function readTxHash(planId: string | undefined, actionId: string | undefined): string {
  if (!planId || !actionId) return ''
  try {
    const hash = JSON.parse(localStorage.getItem(txKey(planId, actionId)) || 'null')?.hash
    return typeof hash === 'string' && /^0x[\da-f]{64}$/i.test(hash) ? hash : ''
  } catch {
    return ''
  }
}
export const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}
/** Lets a screen hear the error code of an operation started further down, to offer the obvious next step. */
export const ErrorCodeContext = createContext<(code: string) => void>(() => {})
export function useTrackedRun() {
  const { run } = useWorkbench()
  const report = useContext(ErrorCodeContext)
  return <T,>(label: string, fn: () => Promise<T>) =>
    run(label, async () => {
      report('')
      try {
        return await fn()
      } catch (error) {
        report(errorCode(error))
        throw error
      }
    })
}
