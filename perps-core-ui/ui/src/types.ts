import type { Connection, Profile, SystemStatus as SystemPayload } from '../../shared/api'

export type {
  ActiveTask,
  BuildSummary,
  Comparison,
  DiamondComparison,
  Connection,
  ContractNode,
  Deployment,
  DiamondPlan,
  EngineSnapshot,
  EngineStatus,
  ErrorBody,
  ErrorCode,
  ErrorInfo,
  Facet,
  HistoryItem,
  Job,
  JobResult,
  JobState,
  JournalEntry,
  Json,
  PeripheralPlan,
  Plan,
  PlanFamily,
  PlannedAction,
  PlanRecord,
  Profile,
  Progress,
  Rehearsal,
  RuntimeComparison,
  Routes,
  SelectorChange,
  Snapshot,
  SystemChange,
  TaskStatus,
  Time,
  TransactionRequest,
  WalletPrompt,
} from '../../shared/api'

/** The workspace status as the app holds it: `/api/system/status` plus the address book from `/api/profiles`. */
export type SystemStatus = SystemPayload & { profiles: Profile[] }

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
