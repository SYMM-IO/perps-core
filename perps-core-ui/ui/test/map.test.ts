import book from '../../../addresses.json'
import { countGlyph, FAMILIES, familyOf, familyTones, graphStyles, NODE_KINDS, nodeGlyph } from '../src/lib/graph-styles'
import { fitText, panToKeep, wheelReader } from '../src/lib/map-gesture'
import { expect, test } from 'vitest'

const wheel = (change: Partial<Parameters<ReturnType<typeof wheelReader>>[0]> = {}) => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  timeStamp: 0,
  ...change,
})

test('every kind of contract in the address book has its own look, and an unknown kind is drawn as external', () => {
  const kinds = new Set(book.deployments.flatMap((d) => Object.keys(d.contracts)))
  for (const kind of kinds) expect(NODE_KINDS, `kind ${kind}`).toContain(kind)
  const styles = graphStyles(false),
    look = (kind: string) => styles.find((s) => s.selector === `node[kind="${kind}"]`).style
  // A solver, a frontend, a wallet and a piece of code are told apart by tone or outline, not by name alone.
  expect(new Set(['core', 'instantLayer', 'partyB', 'multiAccount', 'safe', 'token', 'external'].map((k) => look(k)['background-color'])).size).toBe(
    7,
  )
  expect(look('safe')['corner-radius']).toBeGreaterThan(look('partyB')['corner-radius'])
  expect(look('facet').shape).toBe('cut-rectangle')
  // Two contracts of one family share a tone and differ by icon.
  expect(look('instantLayer')['background-color']).toBe(look('verifier')['background-color'])
  expect(look('instantLayer')['background-image']).not.toBe(look('verifier')['background-image'])
  expect(familyOf('something-new')).toBe('external')
  expect(familyOf(undefined)).toBe('external')
  for (const light of [true, false]) expect(Object.keys(familyTones(light)).sort()).toEqual(FAMILIES.map((f) => f.id).sort())
})

test('a node icon is a complete drawing in the tone it was asked for', () => {
  for (const kind of NODE_KINDS) {
    const svg = decodeURIComponent(nodeGlyph(kind, familyTones(false).solver).replace('data:image/svg+xml;utf8,', ''))
    const drawn = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(drawn.querySelector('parsererror'), kind).toBeNull()
    expect(drawn.querySelectorAll('g > *').length, kind).toBeGreaterThan(0)
    expect(drawn.querySelector('circle')?.getAttribute('fill')).toBe('#2b5350')
    expect(svg).not.toContain('key=')
  }
})

test('a stack shows how many addresses it holds where a contract shows its icon', () => {
  const tone = familyTones(false).governance,
    drawn = (count: number) =>
      new DOMParser().parseFromString(decodeURIComponent(countGlyph(count, tone).replace('data:image/svg+xml;utf8,', '')), 'image/svg+xml')
  expect(drawn(5).querySelector('text')?.textContent).toBe('5')
  expect(drawn(5).querySelector('parsererror')).toBeNull()
  // The disc is filled in the icon's own colour, so a stack is told from a single address at a glance.
  expect(drawn(5).querySelector('circle')?.getAttribute('fill')).toBe(tone.glyph)
  expect(drawn(240).querySelector('text')?.textContent).toBe('99+')
  const stack = graphStyles(false).find((s) => s.selector === 'node.stack').style['background-image']
  expect(stack({ data: (key: string) => ({ count: 4, kind: 'authority' })[key] })).toBe(countGlyph(4, tone))
})

test('the wheel zooms or moves by the chosen mode, and never by a guess about the device', () => {
  const read = wheelReader()
  // The same scroll always does the same thing: a multiple of 120 is not special.
  expect(read(wheel({ deltaY: 40, timeStamp: 0 }), 'move')).toEqual({ pan: { x: 0, y: -40 } })
  expect(read(wheel({ deltaY: 120, timeStamp: 1000 }), 'move')).toEqual({ pan: { x: 0, y: -120 } })
  const out = read(wheel({ deltaY: 100, timeStamp: 2000 }), 'zoom'),
    back = read(wheel({ deltaY: -100, timeStamp: 3000 }), 'zoom')
  expect('zoom' in out && out.zoom).toBeCloseTo(0.8, 1)
  expect('zoom' in out && 'zoom' in back && out.zoom * back.zoom).toBeCloseTo(1)
  // One event from an accelerated wheel cannot jump further than a notch and a bit.
  const flung = read(wheel({ deltaY: 4000, timeStamp: 4000 }), 'zoom')
  expect('zoom' in flung && flung.zoom).toBeGreaterThan(0.75)
  // A pinch and ⌘-scroll zoom in either mode; a line-based wheel counts as about a notch.
  expect(read(wheel({ deltaY: -4, ctrlKey: true, timeStamp: 5000 }), 'move')).toEqual({ zoom: Math.exp(0.04) })
  expect('zoom' in read(wheel({ deltaY: 60, metaKey: true, timeStamp: 6000 }), 'move')).toBe(true)
  expect(read(wheel({ deltaY: 3, deltaMode: 1, timeStamp: 7000 }), 'zoom')).toEqual({ zoom: Math.exp(-96 * 0.0022) })
})

test('a sideways scroll moves the map even when scrolling zooms, and stays a move until the gesture ends', () => {
  const read = wheelReader()
  expect(read(wheel({ deltaX: 30, deltaY: 2, timeStamp: 0 }), 'zoom')).toEqual({ pan: { x: -30, y: -2 } })
  // Drifting towards vertical within the same gesture does not flip it into a zoom.
  expect(read(wheel({ deltaX: 2, deltaY: 30, timeStamp: 40 }), 'zoom')).toEqual({ pan: { x: -2, y: -30 } })
  // After a pause it is a new gesture, judged afresh.
  expect('zoom' in read(wheel({ deltaX: 2, deltaY: 30, timeStamp: 600 }), 'zoom')).toBe(true)
  // Shift makes a plain wheel go sideways, whether or not the browser already swapped the axes.
  expect(read(wheel({ deltaY: 100, shiftKey: true, timeStamp: 2000 }), 'zoom')).toEqual({ pan: { x: -100, y: 0 } })
  expect(read(wheel({ deltaX: 100, shiftKey: true, timeStamp: 4000 }), 'zoom')).toEqual({ pan: { x: -100, y: 0 } })
})

test('the map cannot be moved out of sight', () => {
  const box = { x1: 0, y1: 0, x2: 1000, y2: 400 },
    size = { width: 900, height: 600 }
  // In view: nothing to correct.
  expect(panToKeep(box, 1, { x: 0, y: 0 }, size)).toEqual({ x: 0, y: 0 })
  // Dragged far left and up: brought back until 140px of it shows.
  expect(panToKeep(box, 1, { x: -2000, y: -900 }, size)).toEqual({ x: 1140, y: 640 })
  // Dragged far right and down.
  expect(panToKeep(box, 1, { x: 5000, y: 5000 }, size)).toEqual({ x: -4240, y: -4540 })
  // Zoom is taken into account, and a small canvas keeps a third of itself rather than a fixed strip.
  expect(panToKeep(box, 0.5, { x: -600, y: 0 }, size)).toEqual({ x: 240, y: 0 })
  expect(panToKeep(box, 1, { x: -2000, y: 0 }, { width: 300, height: 600 })).toEqual({ x: 1100, y: 0 })
})

test('a long name is cut to the width it has on the node, in whole characters', () => {
  const measure = (text: string) => text.length * 7
  expect(fitText('Symmio', 148, 'f', measure)).toBe('Symmio')
  expect(fitText('Vibe · LP Profit Distributor', 148, 'f', measure)).toBe('Vibe · LP Profit Dis…')
  // No space is left hanging before the ellipsis.
  expect(fitText('Rasa (No Hedge) · PartyB 2', 119, 'f', measure)).toBe('Rasa (No Hedge)…')
  // Where text cannot be measured the name is still shortened.
  expect(fitText('Vibe · LP Profit Distributor', 148, 'f', undefined)).toHaveLength(21)
})
