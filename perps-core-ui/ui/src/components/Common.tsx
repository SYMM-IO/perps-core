import { ActionIcon, Alert, Badge, Button, Code, Group, Stack, Text, Tooltip } from '@mantine/core'
import { Box, Check, Copy, ExternalLink, Gem, Handshake, Layers, ShieldCheck, Zap, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
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
