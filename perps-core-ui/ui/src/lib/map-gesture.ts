import { LAYOUT, NODE } from '../../../shared/graph-model.js'

/** What the scroll wheel does over the map: zoom at the pointer, or move the map. */
export type ScrollMode = 'zoom' | 'move'
const SCROLL_KEY = 'perps-core-ui:map-scroll'
export const savedScrollMode = (): ScrollMode => {
  try {
    return localStorage.getItem(SCROLL_KEY) === 'move' ? 'move' : 'zoom'
  } catch {
    return 'zoom'
  }
}
export const saveScrollMode = (mode: ScrollMode) => {
  try {
    localStorage.setItem(SCROLL_KEY, mode)
  } catch {
    /* A browser that refuses storage still gets the choice for this visit. */
  }
}

type Wheel = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'timeStamp'>
export type WheelAction = { pan: { x: number; y: number } } | { zoom: number }
/**
 * Turns wheel events into one of two things: move the map, or zoom it by a factor. The rule never looks
 * at what device the event came from, because that cannot be told reliably and guessing made the same
 * scroll do different things. A pinch (which browsers report as Ctrl-scroll) and ⌘-scroll always zoom.
 * A sideways scroll always moves. Otherwise the chosen mode decides. Whether a run of events is sideways
 * is settled on its first event and kept to its last, so a gesture cannot change meaning half way.
 */
export function wheelReader(page = 800) {
  let last = -Infinity,
    sideways = false
  return (e: Wheel, mode: ScrollMode): WheelAction => {
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? page : 1,
      dx = e.deltaX * unit,
      dy = e.deltaY * unit
    if (e.timeStamp - last > 160) sideways = e.shiftKey || Math.abs(dx) > Math.abs(dy) * 1.5
    last = e.timeStamp
    const forced = e.ctrlKey || e.metaKey
    if (!forced && (mode === 'move' || sideways)) {
      // Shift turns a plain wheel sideways; some browsers have already swapped the axes, some have not.
      return { pan: e.shiftKey && !dx ? { x: -dy || 0, y: 0 } : { x: -dx || 0, y: -dy || 0 } }
    }
    // A pinch arrives as small steps and needs a higher rate; a wheel notch is about 100 and is capped,
    // so an accelerated wheel cannot throw the map across several zoom levels in one event.
    const rate = e.ctrlKey && Math.abs(dy) < 50 ? 0.01 : 0.0022
    return { zoom: Math.exp(-Math.max(-120, Math.min(120, dy)) * rate) }
  }
}

export type Box = { x1: number; y1: number; x2: number; y2: number }
type Point = { x: number; y: number }
/**
 * How far the view has to move back so that part of the map stays on screen. Without it a long scroll
 * leaves an empty canvas with nothing to steer by. `box` is the map in its own coordinates.
 */
export function panToKeep(box: Box, zoom: number, pan: { x: number; y: number }, size: { width: number; height: number }, keep = 140) {
  const along = (low: number, high: number, offset: number, length: number) => {
    const margin = Math.min(keep, length / 3),
      from = low * zoom + offset,
      to = high * zoom + offset
    return to < margin ? margin - to : from > length - margin ? length - margin - from : 0
  }
  return { x: along(box.x1, box.x2, pan.x, size.width), y: along(box.y1, box.y2, pan.y, size.height) }
}

type Inset = { top: number; right: number; bottom: number; left: number }
/**
 * The zoom and pan that fit `box` (the map in its own coordinates) into the canvas, less what covers its
 * edges: the key, the zoom buttons, the scope pill. Never past `max`. Never below `min` either, and then
 * `anchor` goes in the middle, so a large system opens readable on the contract that matters.
 */
export function fitBox(
  box: Box,
  size: { width: number; height: number },
  inset: Inset,
  { min = 0, max = 1, anchor, anchorBox, neighbors = [] }: { min?: number; max?: number; anchor?: Point; anchorBox?: Box; neighbors?: Box[] } = {},
) {
  const width = Math.max(1, size.width - inset.left - inset.right),
    height = Math.max(1, size.height - inset.top - inset.bottom),
    fitted = Math.min(width / Math.max(1, box.x2 - box.x1), height / Math.max(1, box.y2 - box.y1)),
    zoom = Math.max(min, Math.min(max, fitted)),
    middle = { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 }
  let center = zoom > fitted && anchor ? anchor : middle
  if (zoom > fitted && anchorBox) {
    const halfWidth = width / zoom / 2,
      halfHeight = height / zoom / 2,
      anchorX = (anchorBox.x1 + anchorBox.x2) / 2,
      anchorY = (anchorBox.y1 + anchorBox.y2) / 2
    const clamp = (value: number, low: number, high: number, fallback: number) =>
      low <= high ? Math.max(low, Math.min(value, high)) : fallback
    const x = clamp(middle.x, anchorBox.x2 - halfWidth, anchorBox.x1 + halfWidth, anchorX),
      visible = neighbors.filter((n) => n.x1 >= x - halfWidth && n.x2 <= x + halfWidth),
      minY = anchorBox.y2 - halfHeight,
      maxY = anchorBox.y1 + halfHeight,
      candidates = [anchorY, middle.y, ...visible.flatMap((n) => [n.y2 - halfHeight, n.y1 + halfHeight])]
    let y = anchorY,
      mostVisible = -1
    for (const candidate of candidates) {
      const at = clamp(candidate, minY, maxY, anchorY),
        count = visible.filter((n) => n.y1 >= at - halfHeight - 0.01 && n.y2 <= at + halfHeight + 0.01).length
      if (count > mostVisible || (count === mostVisible && Math.abs(at - middle.y) < Math.abs(y - middle.y))) {
        y = at
        mostVisible = count
      }
    }
    center = { x, y }
  }
  return { zoom, pan: { x: inset.left + width / 2 - center.x * zoom, y: inset.top + height / 2 - center.y * zoom } }
}

/** Shortens a name to the width it has on the node, measured in the font it is drawn in. */
export function fitText(text: string, width: number, font: string, measure = measurer()) {
  if (!measure) return text.length > 21 ? `${text.slice(0, 20)}…` : text
  if (measure(text, font) <= width) return text
  let end = text.length
  while (end > 1 && measure(`${text.slice(0, end).trimEnd()}…`, font) > width) end--
  return `${text.slice(0, end).trimEnd()}…`
}
const labels = new Map<string, string>()
/** `fitText` for the map's own labels, measured once per name. */
export function fitLabel(text: string, width: number, font: string) {
  const key = `${font}|${width}|${text}`
  if (!labels.has(key)) labels.set(key, fitText(text, width, font))
  return labels.get(key)!
}

/** Resolve colliding tile labels once per unfiltered map mode. */
export function fitNodeLabels(nodes: { id: string; name: string }[], width: number, font: string) {
  const names = new Map<string, string>(),
    groups = new Map<string, typeof nodes>()
  for (const node of nodes) {
    const label = fitLabel(node.name, width, font),
      group = groups.get(label) ?? []
    group.push(node)
    groups.set(label, group)
    names.set(node.id, label)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    let prefix = ''
    for (const match of group[0].name.matchAll(/\S+\s+/g)) {
      const next = group[0].name.slice(0, match.index + match[0].length)
      if (!group.every(({ name }) => name.startsWith(next) && name.length > next.length)) break
      prefix = next
    }
    if (!prefix) continue
    const alternatives = group.map(({ name }) => fitText(`…${name.slice(prefix.length)}`, width, font))
    if (new Set(alternatives).size === group.length) group.forEach(({ id }, i) => names.set(id, alternatives[i]))
  }
  return names
}

/** Long portrait links leave the rows through outer gutters, with a separate track for each overlap. */
export function portraitRoutes(links: { id: string; from: string; to: string }[], positions: Record<string, Point>) {
  const tiles = Object.values(positions),
    tracks = { left: [] as number[], right: [] as number[] },
    routed = new Map<string, { segmentWeights: string; segmentDistances: string }>()
  const skipping = links
    .map((link) => ({ id: link.id, from: positions[link.from], to: positions[link.to] }))
    .filter(({ from, to }) => Math.abs(to.y - from.y) > LAYOUT.row)
    .sort((a, b) => Math.min(a.from.y, a.to.y) - Math.min(b.from.y, b.to.y))
  for (const { id, from, to } of skipping) {
    const side = Math.sign(from.x + to.x) || Math.sign(to.y - from.y),
      used = side < 0 ? tracks.left : tracks.right,
      first = Math.min(from.y, to.y),
      available = used.findIndex((last) => last < first),
      track = available < 0 ? used.length : available
    used[track] = Math.max(from.y, to.y)
    routed.set(id, portraitSegments(from, to, tiles, side, track))
  }
  return routed
}

/** Cytoscape measures segment points along and perpendicular to the line between node centers. */
function portraitSegments(from: Point, to: Point, tiles: Point[], side: number, track: number) {
  const dx = to.x - from.x,
    dy = to.y - from.y,
    direction = Math.sign(dy),
    between = tiles.filter((p) => (p.y - from.y) * direction > 0 && (to.y - p.y) * direction > 0),
    gutter = side * (Math.max(from.x * side, to.x * side, ...between.map((p) => p.x * side)) + NODE.width / 2 + 12 * (track + 1)),
    // Leave or enter a tile from its side, unless another tile could be in the way on that row.
    fromY = from.x * side < 0 ? from.y + direction * LAYOUT.row / 2 : from.y,
    toY = to.x * side < 0 ? to.y - direction * LAYOUT.row / 2 : to.y,
    points = [
      ...(fromY === from.y ? [] : [{ x: from.x, y: fromY }]),
      { x: gutter, y: fromY },
      { x: gutter, y: toY },
      ...(toY === to.y ? [] : [{ x: to.x, y: toY }]),
    ],
    length = Math.hypot(dx, dy)
  return {
    segmentWeights: points.map(({ x, y }) => ((x - from.x) * dx + (y - from.y) * dy) / (length * length)).join(' '),
    segmentDistances: points.map(({ x, y }) => ((x - from.x) * -dy + (y - from.y) * dx) / length).join(' '),
  }
}
let context: CanvasRenderingContext2D | null | undefined
function measurer() {
  if (context === undefined) {
    try {
      context = document.createElement('canvas').getContext('2d')
    } catch {
      context = null
    }
  }
  const ctx = context
  if (!ctx) return undefined
  return (text: string, font: string) => {
    ctx.font = font
    return ctx.measureText(text).width
  }
}
