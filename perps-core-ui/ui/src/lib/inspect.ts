import { edgeKind, isImplementation, linkId } from '../../../shared/graph-model.js'
import type { Connection, ContractNode } from '../types'
import { isIssue } from './state'

// Roles, role admins and ownership are power over a contract; they are shown as who can change what.
const POWER = new Set(['role', 'roleAdmin', 'ownership'])
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ZERO = /^0x0{40}$/
// Values fixed by the code rather than chosen by anyone: useful as evidence, noise among settings.
const CONSTANT = /TYPEHASH$|^domainSeparator$|_VERSION$/
const TIMED = /cool ?down|timeout|period|debounce|blackout|delay/i

export interface Relation {
  /** The contract at the other end, and the link that carries every connection between the two. */
  other: string
  link: string
  labels: string[]
  state: 'set' | 'missing' | 'unknown'
}
/**
 * What a contract depends on and what depends on it: pointers, registrations and permissions, one row per
 * other contract. Power (roles, role admins, ownership) and facets are left out; each has its own place.
 */
export function relations(node: ContractNode, edges: Connection[]) {
  const rows = { pointsTo: new Map<string, Relation>(), referencedBy: new Map<string, Relation>() }
  for (const e of edges) {
    const kind = edgeKind(e)
    if ((e.from !== node.id && e.to !== node.id) || e.from === e.to || POWER.has(kind) || isImplementation(kind) || e.removed) continue
    const outgoing = e.from === node.id,
      other = outgoing ? e.to : e.from,
      group = outgoing ? rows.pointsTo : rows.referencedBy,
      row = group.get(other) || { other, link: linkId(e.from, e.to), labels: [], state: 'set' as Relation['state'] }
    row.labels.push(e.label)
    const state = isIssue(e) ? 'missing' : e.status === 'verified' ? 'set' : 'unknown'
    if (state === 'missing' || (state === 'unknown' && row.state === 'set')) row.state = state
    group.set(other, row)
  }
  const sorted = (group: Map<string, Relation>) => [...group.values()].sort((a, b) => Number(b.state !== 'set') - Number(a.state !== 'set'))
  return { pointsTo: sorted(rows.pointsTo), referencedBy: sorted(rows.referencedBy) }
}

export interface RoleRow {
  role: string
  holders: { id: string; missing: boolean }[]
  admins: string[]
}
/** The roles defined on a contract, each with who holds it and who can grant it. A missing expected grant sorts first. */
export function rolesOn(node: ContractNode, edges: Connection[]): RoleRow[] {
  const roles = new Map<string, RoleRow>(),
    row = (role: string) => roles.get(role) || roles.set(role, { role, holders: [], admins: [] }).get(role)!
  for (const e of edges) {
    if (e.to !== node.id || e.removed) continue
    const kind = edgeKind(e)
    if (kind === 'role') row(e.label).holders.push({ id: e.from, missing: isIssue(e) })
    else if (kind === 'roleAdmin' && e.status === 'verified') row(e.label.replace(/^Admin · /, '')).admins.push(e.from)
  }
  const urgent = (r: RoleRow) => Number(r.holders.some((h) => h.missing))
  return [...roles.values()].sort((a, b) => urgent(b) - urgent(a) || a.role.localeCompare(b.role))
}

/** Seconds as a person would say them, for values whose name says they are a length of time. */
export function duration(key: string, value: unknown): string | undefined {
  if (!TIMED.test(key)) return undefined
  if (Array.isArray(value)) {
    const parts = value.map((v) => duration(key, v))
    return parts.every(Boolean) ? parts.join(', ') : undefined
  }
  const total = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : typeof value === 'number' ? value : NaN
  if (!Number.isSafeInteger(total) || total <= 0) return undefined
  const units: [number, string][] = [
      [86400, 'd'],
      [3600, 'h'],
      [60, 'min'],
      [1, 's'],
    ],
    parts: string[] = []
  let left = total
  for (const [size, unit] of units) {
    const whole = Math.floor(left / size)
    if (whole && parts.length < 2) parts.push(`${whole} ${unit}`)
    left -= whole * size
  }
  return parts.join(' ')
}

/**
 * Splits what was read from a contract into what someone set and what the code fixed. An address that
 * is drawn on the map is left out, because it is already shown as a connection; the raw `setup` reads
 * behind those connections are left out for the same reason.
 */
export function settingsOf(node: ContractNode, nodes: ContractNode[]) {
  const drawn = new Set(nodes.map((n) => n.address?.toLowerCase())),
    settings: [string, unknown][] = [],
    constants: [string, unknown][] = []
  for (const [key, value] of Object.entries(node.state || {})) {
    // Counts of what a contract is made of are shown beside its name, not as something that was set.
    if (['roles', 'setup', 'facets', 'functions'].includes(key)) continue
    if (CONSTANT.test(key)) constants.push([key, value])
    else if (typeof value === 'string' && ADDRESS.test(value)) {
      if (ZERO.test(value)) settings.push([key, 'not set'])
      else if (!drawn.has(value.toLowerCase())) settings.push([key, value])
    } else settings.push([key, value])
  }
  return { settings, constants }
}
