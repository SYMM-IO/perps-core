export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface ContractNode {
  id: string
  kind: string
  name: string
  address: string
  strategy?: string
  implementation?: string
  status?: string
  state: Record<string, any>
  errors?: string[]
  [key: string]: any
}
export interface Connection {
  from: string
  to: string
  label: string
  kind?: string
  status: string
  basis?: string
  actual?: string
  [key: string]: any
}
/** One drawn line between two contracts; `edges` keeps every individual connection. */
export interface Link {
  id: string
  from: string
  to: string
  edges: (Connection & { state: string })[]
  count: number
  missing: number
  unknown: number
  state: string
  label: string
  /** Set when the map is drawing changes: how this link differs from the previous inspection. */
  diff?: 'added' | 'changed' | 'removed'
}
export interface Profile {
  id: string
  name: string
  chainId: number
  version?: string
  environment?: string
  rpc?: string
  explorer?: string
  nodes: ContractNode[]
  notes?: string[]
  source?: { url?: string; entry?: string; checked?: string }
  links?: { label?: string; url: string }[]
  [key: string]: any
}
export interface Snapshot {
  nodes: ContractNode[]
  edges: Connection[]
  chainId: number
  blockNumber: number
  at: string
  fingerprint: string
  profile: Profile
  coverage?: Record<string, any>
  roleHistory?: Record<string, any>
  /** Where each kind of fact in this snapshot came from. Absent on snapshots saved before the engine recorded it. */
  sources?: Record<string, any>
}
export interface HistoryItem {
  id: string
  scope?: string
  chainId?: number
  target?: string
  createdAt?: string
  at?: string
  status: string
  changes?: number
}
export interface PlanRecord {
  plan: Record<string, any>
  status: string
  rehearsal?: {
    status: string
    error?: string
    at?: string
    blockNumber?: number
    checks?: string[]
    gas?: { action: string; gasUsed: string }[]
    limitations?: string[]
    [key: string]: any
  }
  journal?: Record<string, any>
  safe?: { transactionBuilder: unknown }
  [key: string]: any
}
export interface SystemStatus {
  connected: boolean
  revision: number
  profile: Profile
  profiles: Profile[]
  snapshot?: Snapshot
  comparison: Record<string, any>
  delta: any[]
  /** The inspection `delta` was measured against. */
  since?: { blockNumber: number; at?: string } | null
  busy: boolean
  error?: string
  activity: string
  plan?: PlanRecord
  history: HistoryItem[]
  active?: any
}
export interface EngineStatus {
  revision: number
  busy: boolean
  error?: string
  activity: string
  snapshot?: {
    chainId: number
    target: string
    owner: string
    facets: any[]
    map: Record<string, string>
    authority: { kind: string }
    blockNumber: number
    fingerprint: string
  }
  build?: { scope?: string; digest: string; source: { branch?: string; commit: string; digest: string }; catalog: Facet[] }
  baseline?: any
  active?: any
  prompts: any[]
  history: HistoryItem[]
}
export interface Facet {
  name: string
  kind: string
  selectors: Record<string, string>
  dependencies: string[]
}
export interface DiamondDraft {
  selected: string[]
  removals: string[]
  deployer: string
  mode: string
}
export interface GraphFilters {
  mode: string
  focus: string
  query: string
  missingOnly: boolean
  /** Connection groups switched off on the map, by `EDGE_GROUPS` id. */
  hide: string[]
}
