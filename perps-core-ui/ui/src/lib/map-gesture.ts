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

type Box = { x1: number; y1: number; x2: number; y2: number }
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
  { min = 0, max = 1, anchor }: { min?: number; max?: number; anchor?: { x: number; y: number } } = {},
) {
  const width = Math.max(1, size.width - inset.left - inset.right),
    height = Math.max(1, size.height - inset.top - inset.bottom),
    fitted = Math.min(width / Math.max(1, box.x2 - box.x1), height / Math.max(1, box.y2 - box.y1)),
    zoom = Math.max(min, Math.min(max, fitted)),
    center = zoom > fitted && anchor ? anchor : { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 }
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
