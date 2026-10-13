import { __iconData as bookOpen } from 'lucide-react/dist/esm/icons/book-open.mjs'
import { __iconData as circleDollarSign } from 'lucide-react/dist/esm/icons/circle-dollar-sign.mjs'
import { __iconData as diamond } from 'lucide-react/dist/esm/icons/diamond.mjs'
import { __iconData as fileCode } from 'lucide-react/dist/esm/icons/file-code.mjs'
import { __iconData as fuel } from 'lucide-react/dist/esm/icons/fuel.mjs'
import { __iconData as gavel } from 'lucide-react/dist/esm/icons/gavel.mjs'
import { __iconData as handCoins } from 'lucide-react/dist/esm/icons/hand-coins.mjs'
import { __iconData as handshake } from 'lucide-react/dist/esm/icons/handshake.mjs'
import { __iconData as keyRound } from 'lucide-react/dist/esm/icons/key-round.mjs'
import { __iconData as layers } from 'lucide-react/dist/esm/icons/layers.mjs'
import { __iconData as plug } from 'lucide-react/dist/esm/icons/plug.mjs'
import { __iconData as puzzle } from 'lucide-react/dist/esm/icons/puzzle.mjs'
import { __iconData as rocket } from 'lucide-react/dist/esm/icons/rocket.mjs'
import { __iconData as shieldCheck } from 'lucide-react/dist/esm/icons/shield-check.mjs'
import { __iconData as store } from 'lucide-react/dist/esm/icons/store.mjs'
import { __iconData as tags } from 'lucide-react/dist/esm/icons/tags.mjs'
import { __iconData as timer } from 'lucide-react/dist/esm/icons/timer.mjs'
import { __iconData as vault } from 'lucide-react/dist/esm/icons/vault.mjs'
import { __iconData as walletCards } from 'lucide-react/dist/esm/icons/wallet-cards.mjs'
import { __iconData as zap } from 'lucide-react/dist/esm/icons/zap.mjs'

export const NODE = { width: 212, height: 58 }
/** Where a contract's name starts: after the icon, so every name on the map lines up like a list. */
const TEXT_LEFT = 52
export const TEXT_WIDTH = NODE.width - TEXT_LEFT - 12
export const NODE_FONT = { family: 'Manrope, sans-serif', size: 13, weight: 600 }

type Icon = { node: [string, Record<string, string>][] }
export type Shape = 'tile' | 'pill' | 'cut'
/**
 * A family is what a contract is to the protocol. It sets the node's tone and outline, so the map can be
 * read from far out; the icon inside then says which contract of that family it is.
 */
export const FAMILIES = [
  { id: 'core', label: 'Core', shape: 'tile' },
  { id: 'protocol', label: 'Protocol', shape: 'tile' },
  { id: 'solver', label: 'Solvers', shape: 'tile' },
  { id: 'frontend', label: 'Frontends', shape: 'tile' },
  { id: 'governance', label: 'Governance & wallets', shape: 'pill' },
  { id: 'token', label: 'Token', shape: 'tile' },
  { id: 'external', label: 'External', shape: 'tile' },
  { id: 'code', label: 'Facets & libraries', shape: 'cut' },
] as const satisfies readonly { id: string; label: string; shape: Shape }[]
export type Family = (typeof FAMILIES)[number]['id']

const KINDS: Record<string, { family: Family; icon: Icon }> = {
  core: { family: 'core', icon: diamond },
  accountLayer: { family: 'protocol', icon: layers },
  instantLayer: { family: 'protocol', icon: zap },
  gasless: { family: 'protocol', icon: fuel },
  express: { family: 'protocol', icon: rocket },
  verifier: { family: 'protocol', icon: shieldCheck },
  symbolManager: { family: 'protocol', icon: tags },
  liquidator: { family: 'protocol', icon: gavel },
  partyB: { family: 'solver', icon: handshake },
  affiliate: { family: 'frontend', icon: store },
  multiAccount: { family: 'frontend', icon: walletCards },
  feeDistributor: { family: 'frontend', icon: handCoins },
  authority: { family: 'governance', icon: keyRound },
  proxyAdmin: { family: 'governance', icon: keyRound },
  safe: { family: 'governance', icon: vault },
  timelock: { family: 'governance', icon: timer },
  token: { family: 'token', icon: circleDollarSign },
  external: { family: 'external', icon: plug },
  facet: { family: 'code', icon: puzzle },
  implementation: { family: 'code', icon: fileCode },
  library: { family: 'code', icon: bookOpen },
}
export const NODE_KINDS = Object.keys(KINDS)
/** A kind the map has no entry for is drawn as an outside address, never left unstyled. */
export const familyOf = (kind?: string): Family => KINDS[kind || '']?.family || 'external'

export interface Tone {
  /** The node's fill and the text on it. */
  bg: string
  ink: string
  /** The disc behind the icon, and the icon. */
  chip: string
  glyph: string
}
/** Flat tonal containers, one hue per family. Kept beside the roles in styles.css; Cytoscape cannot read CSS variables. */
export function familyTones(light: boolean): Record<Family, Tone> {
  return light
    ? {
        core: { bg: '#ffdad4', ink: '#410503', chip: '#ffb4a8', glyph: '#5c1109' },
        protocol: { bg: '#e3e3e7', ink: '#1b1b1d', chip: '#ffdad4', glyph: '#8c2a1e' },
        solver: { bg: '#cdeeea', ink: '#00201f', chip: '#a5dcd6', glyph: '#003735' },
        frontend: { bg: '#d6e3ff', ink: '#001b3d', chip: '#b0c9f5', glyph: '#0b315f' },
        governance: { bg: '#e9e1f4', ink: '#211a2e', chip: '#d2c5e8', glyph: '#3a2f52' },
        token: { bg: '#ffe9b0', ink: '#261a00', chip: '#f5d27a', glyph: '#4a3600' },
        external: { bg: '#ededf0', ink: '#5e5e64', chip: '#dcdce0', glyph: '#5e5e64' },
        code: { bg: '#e3e3e7', ink: '#1b1b1d', chip: '#d0d0d6', glyph: '#3b3b40' },
      }
    : {
        core: { bg: '#73342a', ink: '#ffdad4', chip: '#8f4538', glyph: '#ffdad4' },
        protocol: { bg: '#2e2e32', ink: '#e6e6e8', chip: '#5a2f28', glyph: '#ffb4a8' },
        solver: { bg: '#1d3a38', ink: '#b7ecea', chip: '#2b5350', glyph: '#b7ecea' },
        frontend: { bg: '#23384f', ink: '#d2e4ff', chip: '#335070', glyph: '#d2e4ff' },
        governance: { bg: '#3f394b', ink: '#e9e0f7', chip: '#574f68', glyph: '#e9e0f7' },
        token: { bg: '#46380f', ink: '#ffe08a', chip: '#62500f', glyph: '#ffe08a' },
        external: { bg: '#222225', ink: '#b4b4ba', chip: '#333337', glyph: '#b4b4ba' },
        code: { bg: '#303035', ink: '#e6e6e8', chip: '#44444a', glyph: '#c9c9cf' },
      }
}
/** The icon for a kind of contract on its tonal disc, as an image Cytoscape can paint inside the node. */
export function nodeGlyph(kind: string, tone: Tone) {
  const { icon } = KINDS[kind] || KINDS.external
  const strokes = icon.node
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .filter(([name]) => name !== 'key')
          .map(([name, value]) => `${name}="${value}"`)
          .join(' ')}/>`,
    )
    .join('')
  // Drawn at twice its painted size so it stays sharp when the map is zoomed in.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 30 30"><circle cx="15" cy="15" r="15" fill="${tone.chip}"/><g transform="translate(6.6 6.6) scale(0.7)" fill="none" stroke="${tone.glyph}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${strokes}</g></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}
/** For a stack of addresses the disc carries their number where a single contract has its icon. */
export function countGlyph(count: number, tone: Tone) {
  const text = count > 99 ? '99+' : String(count)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 30 30"><circle cx="15" cy="15" r="15" fill="${tone.glyph}"/><text x="15" y="${text.length > 2 ? 19 : 20}" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="${text.length > 2 ? 11 : 14}" font-weight="700" fill="${tone.bg}">${text}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}
const SHAPES: Record<Shape, object> = {
  tile: { shape: 'round-rectangle', 'corner-radius': 18 },
  pill: { shape: 'round-rectangle', 'corner-radius': NODE.height / 2 },
  cut: { shape: 'cut-rectangle', 'corner-radius': 10 },
}

export function graphStyles(light: boolean): any[] {
  const bg = light ? '#fafafa' : '#121212',
    ink = light ? '#1b1b1d' : '#e6e6e8',
    dim = light ? '#5e5e64' : '#a9a9af',
    ok = light ? '#1b7a4f' : '#86d9a8',
    bad = light ? '#ba1a1a' : '#ffb4ab',
    primary = light ? '#b3392b' : '#ffb4a8',
    // Amber marks what is different from the previous inspection.
    warn = light ? '#8a6100' : '#e9c46a',
    tones = familyTones(light),
    shapeOf = Object.fromEntries(FAMILIES.map((f) => [f.id, f.shape])) as Record<Family, Shape>
  const look = (kind: string) => {
    const family = familyOf(kind),
      tone = tones[family]
    return { ...SHAPES[shapeOf[family]], 'background-color': tone.bg, color: tone.ink, 'background-image': nodeGlyph(kind, tone) }
  }
  return [
    {
      // A flat tonal tile laid out like a list row: icon, then the name over the address. No outline, no shadow.
      selector: 'node',
      style: {
        width: NODE.width,
        height: NODE.height,
        'border-width': 0,
        ...look('external'),
        'background-width': 30,
        'background-height': 30,
        'background-position-x': 12,
        'background-position-y': '50%',
        'background-fit': 'none',
        'background-repeat': 'no-repeat',
        label: 'data(label)',
        'font-family': NODE_FONT.family,
        'font-size': NODE_FONT.size,
        'font-weight': NODE_FONT.weight,
        'text-wrap': 'wrap',
        'text-justification': 'left',
        'text-valign': 'center',
        // The label is anchored to the right edge and pulled back, which starts it at the same place in every node.
        'text-halign': 'right',
        'text-margin-x': TEXT_LEFT - NODE.width,
        'line-height': 1.5,
        'overlay-opacity': 0,
      },
    },
    ...NODE_KINDS.map((kind) => ({ selector: `node[kind="${kind}"]`, style: look(kind) })),
    // The diamond everything hangs off is the one node that is larger and bolder than the rest.
    { selector: 'node[kind="core"]', style: { height: 66, 'corner-radius': 22, 'font-size': 14, 'font-weight': 700 } },
    // Several addresses drawn as one: the disc is filled and carries their number instead of an icon.
    {
      selector: 'node.stack',
      style: { 'background-image': (node: any) => countGlyph(node.data('count'), tones[familyOf(node.data('kind'))]) },
    },
    { selector: 'node.attention', style: { 'border-color': bad, 'border-width': 2, 'border-style': 'dashed' } },
    { selector: 'node.diff-added', style: { 'border-color': warn, 'border-width': 3, 'border-style': 'solid' } },
    { selector: 'node.diff-changed', style: { 'border-color': warn, 'border-width': 3, 'border-style': 'dashed' } },
    {
      selector: 'node.diff-removed',
      style: { 'border-color': dim, 'border-width': 2, 'border-style': 'dashed', 'background-opacity': 0.45, 'text-opacity': 0.7 },
    },
    { selector: 'node:selected', style: { 'border-color': primary, 'border-width': 3, 'border-style': 'solid' } },
    {
      selector: 'node.lane',
      style: {
        shape: 'rectangle',
        width: 1,
        height: 1,
        'background-opacity': 0,
        'background-image': 'none',
        'border-width': 0,
        color: dim,
        'font-size': 12,
        'font-weight': 600,
        'text-transform': 'uppercase',
        'text-halign': 'center',
        'text-margin-x': 0,
        events: 'no',
      },
    },
    {
      selector: 'edge',
      style: {
        width: 'data(width)',
        'curve-style': 'bezier',
        'control-point-step-size': 46,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.9,
        'line-color': ok,
        'target-arrow-color': ok,
        'line-opacity': 0.75,
        // At rest a link shows only its count, beside the contract it belongs to, where nothing overlaps it.
        'source-label': 'data(sourceCount)',
        'target-label': 'data(targetCount)',
        'source-text-offset': 20,
        'target-text-offset': 28,
        color: ok,
        'font-size': 12,
        'font-family': 'JetBrains Mono, monospace',
        'text-background-color': bg,
        'text-background-opacity': 1,
        'text-background-padding': 3,
        'text-background-shape': 'round-rectangle',
        'text-events': 'yes',
        'overlay-opacity': 0,
      },
    },
    {
      selector: 'edge[state="missing"]',
      style: {
        'line-color': bad,
        'target-arrow-color': bad,
        color: bad,
        'line-style': 'dashed',
        'line-opacity': 1,
        'z-index': 5,
        label: 'data(label)',
      },
    },
    {
      selector: 'edge[state="unknown"]',
      style: { 'line-color': '#8f8884', 'target-arrow-color': '#8f8884', color: dim, 'line-style': 'dotted' },
    },
    { selector: 'edge.diff-added', style: { 'line-color': warn, 'target-arrow-color': warn, color: warn, 'line-style': 'solid', 'line-opacity': 1 } },
    {
      selector: 'edge.diff-changed',
      style: { 'line-color': warn, 'target-arrow-color': warn, color: warn, 'line-style': 'dashed', 'line-opacity': 1 },
    },
    {
      selector: 'edge.diff-removed',
      style: { 'line-color': dim, 'target-arrow-color': dim, color: dim, 'line-style': 'dashed', 'line-opacity': 0.7 },
    },
    // A dense overview keeps its lines; counts and names appear on hover, selection, or when something is wrong.
    { selector: 'edge.quiet[state="set"]', style: { 'text-opacity': 0, 'text-background-opacity': 0, 'line-opacity': 0.45 } },
    {
      selector: 'edge:selected, edge.hover-edge',
      style: {
        label: 'data(label)',
        'text-opacity': 1,
        'text-background-opacity': 1,
        'line-opacity': 1,
        'text-border-width': 1,
        'text-border-opacity': 1,
        'text-border-color': dim,
        'font-weight': 700,
        'z-index': 9,
      },
    },
    { selector: 'edge:selected', style: { 'line-color': ink, 'target-arrow-color': ink, color: ink } },
    // Everything outside the highlighted contract's neighbourhood steps back but stays readable as context.
    { selector: '.faded', style: { opacity: 0.16 } },
    { selector: 'edge.faded', style: { 'text-opacity': 0, 'text-background-opacity': 0 } },
  ]
}
