import { useWorkbench } from '../api'
import { httpUrl, planChainId } from '../lib/state'
import type { Deployment, Plan, Profile } from '../types'
import { ActionIcon, Alert, Badge, Button, Code, Group, Stack, Text, Tooltip } from '@mantine/core'
import { Box, Check, Copy, ExternalLink, Gem, Handshake, Layers, ShieldCheck, Zap, type LucideIcon } from 'lucide-react'
import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'

export function Address({ value, align = 'start', href }: { value: string; align?: 'start' | 'center'; href?: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState('')
  return (
    <Stack gap={4}>
      <Group gap={6} wrap="nowrap" align="center" justify={align === 'center' ? 'center' : 'flex-start'}>
        <Code className="address">{value}</Code>
        <Tooltip label={copied ? 'Copied' : 'Copy address'}>
          <ActionIcon
            variant="subtle"
            aria-label={copied ? 'Copied address' : 'Copy address'}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value)
                setCopied(true)
                setTimeout(() => setCopied(false), 1800)
              } catch {
                setError('Could not copy. Select and copy the address.')
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
      {error && (
        <Text size="xs" c="red">
          {error}
        </Text>
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
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <Stack className="empty-state" align="center" gap="sm">
      <Text fw={600}>{title}</Text>
      {children && (
        <Text c="dimmed" size="sm" ta="center" maw={520}>
          {children}
        </Text>
      )}
      {action}
    </Stack>
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
    <Code block className="json-code">
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
            setTimeout(() => setCopied(false), 1800)
          } catch {
            setError('Copy failed. Select the calldata above.')
          }
        }}
      >
        {copied ? 'Copied' : 'Copy calldata'}
      </Button>
      <span role="status" className="sr-only">
        {copied ? 'Copied to clipboard' : error}
      </span>
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
