import type { Connection, ContractNode, DiamondDraft, DiamondPlan, HistoryItem, Plan, PlanRecord, Profile } from '../types'

export const familyName = (kind?: string) =>
  ({ core: 'Core Diamond', accountLayer: 'AccountLayer', instantLayer: 'InstantLayer', partyB: 'PartyB', verifier: 'Signature verifier' })[
    kind || 'core'
  ] ||
  kind ||
  'Contract'
export const UPGRADEABLE = ['core', 'accountLayer', 'partyB', 'verifier']
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
export const isDiamondPlan = (p: Plan): p is DiamondPlan => p.kind !== 'peripheral'
export const planChainId = (p: Plan) => (isDiamondPlan(p) ? p.snapshot.chainId : p.chainId)
export const planTarget = (p: Plan) => (isDiamondPlan(p) ? p.snapshot.target : p.sourceAddress)
export const planAuthority = (p: Plan) => (isDiamondPlan(p) ? p.snapshot.owner : p.authority)
export const planBlock = (p: Plan) => (isDiamondPlan(p) ? p.snapshot.blockNumber : p.blockNumber)
/** What the operator types to start execution: the deployment id, or the chain for plans saved before plans recorded it. */
export const confirmationFor = (p: Plan) => `${p.deployment?.id ?? planChainId(p)}:${p.id.slice(0, 8)}`

/** A saved plan as History lists it, with the adapter that owns it. */
export type HistoryRow = HistoryItem & { adapter: 'diamond' | 'system'; at: string }
type RowState = { label: string; color: string; detail?: string }
/** The state of a saved plan in words. The active plan says what it is waiting for; the rest say how far they got. */
export function recordState(h: Pick<HistoryItem, 'status'> & Partial<HistoryItem>): RowState {
  const unresolved = !!h.execution?.unresolved
  if (h.active)
    switch (h.taskStatus) {
      case 'waiting_external':
        return /safe/i.test(h.waitingFor || '')
          ? { label: 'Waiting for Safe execution', color: 'orange', detail: h.waitingFor }
          : unresolved || /reconcile/i.test(h.waitingFor || '')
            ? { label: 'Paused, needs a transaction hash', color: 'orange', detail: h.waitingFor }
            : { label: 'Waiting', color: 'orange', detail: h.waitingFor }
      case 'paused':
        return { label: unresolved ? 'Paused, needs a transaction hash' : 'Paused', color: 'orange', detail: h.waitingFor }
      case 'cancel_pending':
        return { label: 'Cancelling', color: 'orange' }
      default:
        return { label: 'Executing', color: 'blue' }
    }
  if (h.status === 'verified') return { label: 'Verified', color: 'teal' }
  const sent = h.execution && h.execution.confirmed + h.execution.submitted + h.execution.unresolved > 0
  // Not active but transactions went out: the task was cancelled or ended before verification.
  if (sent) return { label: unresolved ? 'Partly executed, outcome unknown' : 'Partly executed', color: 'orange' }
  if (h.rehearsal === 'failed') return { label: 'Rehearsal failed', color: 'red' }
  if (h.rehearsal === 'passed') return { label: 'Rehearsed', color: 'teal' }
  return { label: 'Prepared', color: 'gray' }
}
/** Diamond and peripheral history in one list, newest first. Older servers sent `at` for peripheral plans. */
export function historyEntries(engine: HistoryItem[] = [], system: HistoryItem[] = []): HistoryRow[] {
  const row = (h: HistoryItem, adapter: HistoryRow['adapter']) => {
    const at = h.createdAt || (h as { at?: string }).at || ''
    return { ...h, adapter, at, createdAt: at }
  }
  return [...engine.map((h) => row(h, 'diamond')), ...system.map((h) => row(h, 'system'))].sort((a, b) => b.at.localeCompare(a.at))
}
/** A plan belongs to the deployment it was prepared for; plans saved before that was recorded fall back to the chain. */
export const inDeployment = (h: Pick<HistoryItem, 'chainId' | 'deployment'>, profile?: Pick<Profile, 'id' | 'chainId'>) =>
  !profile || (h.deployment ? h.deployment.id === profile.id : !h.chainId || h.chainId === profile.chainId)
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
