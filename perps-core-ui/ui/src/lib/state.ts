import type { Connection, ContractNode, DiamondDraft, PlanRecord } from '../types'

export const familyName = (kind?: string) =>
  ({ core: 'Core Diamond', accountLayer: 'AccountLayer', instantLayer: 'InstantLayer', partyB: 'PartyB', verifier: 'Signature verifier' })[
    kind || 'core'
  ] ||
  kind ||
  'Contract'
export const UPGRADEABLE = ['core', 'accountLayer', 'instantLayer', 'partyB', 'verifier']
const KINDS: Record<string, string> = {
  authority: 'Authority',
  safe: 'Safe',
  timelock: 'Timelock',
  proxyAdmin: 'Proxy admin',
  gasless: 'Gasless layer',
  multiAccount: 'MultiAccount',
  express: 'Express provider',
  symbolManager: 'Symbol manager',
  liquidator: 'Liquidator',
  feeDistributor: 'Fee distributor',
  token: 'Token',
  affiliate: 'Affiliate',
  external: 'External',
  facet: 'Facet',
  implementation: 'Implementation',
  library: 'Library',
}
export const kindName = (kind: string) => (UPGRADEABLE.includes(kind) ? familyName(kind) : KINDS[kind] || kind)
export const isIssue = (edge: Pick<Connection, 'status'>) => ['missing', 'mismatch'].includes(edge.status)
/** What is wrong with a connection, in the words an operator would use. */
export const issueText = (edge: Connection) =>
  edge.status === 'mismatch' ? `${edge.label.replace(/ · expected$/, '')} points elsewhere` : `${edge.label} not granted`
/** URL state that opens the upgrade flow for one contract. */
export function upgradeParams(previous: URLSearchParams, node: ContractNode) {
  const next = new URLSearchParams(previous)
  next.set('view', 'upgrade')
  next.set('adapter', ['core', 'accountLayer'].includes(node.kind) ? 'diamond' : 'system')
  next.set('scope', node.kind)
  next.set('target', node.address)
  next.set('upgradeNode', node.id)
  next.set('step', '0')
  next.delete('plan')
  return next
}
export const short = (value?: string) => (value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—')
export const pretty = (value: unknown) => (typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '—'))
export const draftKey = (chain: number, target: string, scope: string, source: string) =>
  `workbench-draft:${chain}:${target.toLowerCase()}:${scope}:${source}`
export function readDraft(storage: Pick<Storage, 'getItem'>, key: string, fallback: DiamondDraft): DiamondDraft {
  try {
    const value = JSON.parse(storage.getItem(key) || 'null')
    if (value && !value.removals) value.removals = value.removed
    return value && Array.isArray(value.selected) && Array.isArray(value.removals)
      ? {
          selected: value.selected.filter((v: unknown) => typeof v === 'string'),
          removals: value.removals.filter((v: unknown) => typeof v === 'string'),
          deployer: typeof value.deployer === 'string' ? value.deployer : '',
          mode: value.mode === 'reconcile' ? 'reconcile' : 'patch',
        }
      : fallback
  } catch {
    return fallback
  }
}
export function planState(record: PlanRecord) {
  if (record.status === 'verified') return { label: 'Verified on chain', color: 'teal' }
  if (record.plan.blockers?.length) return { label: 'Blocked', color: 'red' }
  if (record.rehearsal?.status === 'failed') return { label: 'Rehearsal failed', color: 'red' }
  if (record.rehearsal?.status === 'passed') return { label: 'Rehearsed', color: 'teal' }
  return { label: 'Prepared', color: 'gray' }
}
/** Saved plans are either prepared or verified on chain; anything else is shown as stored. */
export const recordState = (status: string) =>
  status === 'verified'
    ? { label: 'Verified on chain', color: 'teal' }
    : status === 'prepared'
      ? { label: 'Prepared', color: 'gray' }
      : { label: status ? status[0].toUpperCase() + status.slice(1) : 'Unknown', color: 'gray' }
export function historyEntries(engine: any[] = [], system: any[] = []) {
  return [...engine.map((h) => ({ ...h, adapter: 'diamond', at: h.createdAt })), ...system.map((h) => ({ ...h, adapter: 'system' }))].sort((a, b) =>
    String(b.at).localeCompare(String(a.at)),
  )
}
export function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A profile-supplied link, only if it is plain http(s). Anything else (javascript:, data:) is dropped. */
export function httpUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value ?? ''))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}
