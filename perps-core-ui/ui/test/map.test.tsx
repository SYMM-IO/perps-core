import book from '../../../addresses.json'
import { ContractGraph } from '../src/components/ContractGraph'
import { countGlyph, FAMILIES, familyOf, familyTones, graphStyles, mapPalette, MIRRORED, NODE_KINDS, nodeGlyph } from '../src/lib/graph-styles'
import { fitBox, fitText, panToKeep, wheelReader } from '../src/lib/map-gesture'
import type { GraphFilters } from '../src/types'
import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useState } from 'react'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

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

test('the colours the canvas copies from the theme match the theme, in both schemes', () => {
  // Each scheme is the base :root block with its own block on top.
  const css = readFileSync(resolve('perps-core-ui/ui/src/styles.css'), 'utf8')
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThanOrEqual(0)
    const body = css.slice(at, css.indexOf('}', at))
    return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim().toLowerCase()]))
  }
  const base = block(':root'),
    schemes = {
      light: { ...base, ...block(":root[data-mantine-color-scheme='light']") },
      dark: { ...base, ...block(":root[data-mantine-color-scheme='dark']") },
    }
  for (const light of [true, false]) {
    const palette = mapPalette(light),
      theme = schemes[light ? 'light' : 'dark']
    for (const [role, variable] of Object.entries(MIRRORED))
      expect(palette[role as keyof typeof MIRRORED], `${variable} (${light ? 'light' : 'dark'})`).toBe(theme[variable])
  }
  // Lines that say nothing either way, and lines that have gone, are drawn in the grey the key uses for them.
  const styles = graphStyles(true),
    line = (selector: string) => styles.find((s) => s.selector === selector).style['line-color']
  expect(line('edge[state="unknown"]')).toBe(mapPalette(true).idle)
  expect(line('edge.diff-removed')).toBe(mapPalette(true).idle)
})

test('a fit leaves room for what covers the canvas edges, and never opens too far out to read', () => {
  const box = { x1: 0, y1: 0, x2: 1000, y2: 500 },
    size = { width: 1100, height: 700 },
    inset = { top: 60, right: 28, bottom: 80, left: 28 }
  const fitted = fitBox(box, size, inset)
  expect(fitted.zoom).toBeCloseTo(1)
  // The map sits between the strip at the top and the key at the bottom.
  expect(fitted.pan.y + box.y1 * fitted.zoom).toBeGreaterThanOrEqual(inset.top)
  expect(fitted.pan.y + box.y2 * fitted.zoom).toBeLessThanOrEqual(size.height - inset.bottom)
  // A system too large to fit opens at the readable zoom, on the contract that matters.
  const large = fitBox({ x1: 0, y1: 0, x2: 5000, y2: 1000 }, size, inset, { min: 0.7, anchor: { x: 2500, y: 400 } })
  expect(large.zoom).toBe(0.7)
  expect(large.pan.x + 2500 * 0.7).toBeCloseTo(inset.left + (size.width - inset.left - inset.right) / 2)
  // A small one is not blown up past its natural size.
  expect(fitBox({ x1: 0, y1: 0, x2: 100, y2: 50 }, size, inset, { max: 1 }).zoom).toBe(1)
})

// The map itself, mounted with Cytoscape drawing into a canvas that accepts every call and draws nothing.
const node = (id: string, kind: string, name: string) => ({
  id,
  kind,
  name,
  address: `0x${id.padStart(40, '0')}`,
  state: {},
  status: 'observed',
  errors: [],
})
const snapshot = {
  blockNumber: 100,
  nodes: [
    node('core', 'core', 'Symmio'),
    node('safe', 'safe', 'Main Multisig'),
    node('gov', 'authority', 'Admin authority'),
    node('verifier', 'verifier', 'Verifier'),
    node('idle', 'authority', 'Listed wallet'),
  ],
  edges: [
    { from: 'safe', to: 'core', label: 'owner', kind: 'ownership', status: 'verified' },
    { from: 'gov', to: 'safe', label: 'signer', kind: 'ownership', status: 'verified' },
    { from: 'gov', to: 'core', label: 'SETTER_ROLE', kind: 'role', status: 'verified' },
    { from: 'verifier', to: 'core', label: 'PAUSER_ROLE', kind: 'role', status: 'missing', actual: false, expected: true },
    { from: 'core', to: 'verifier', label: 'getSignatureVerifier', kind: 'pointer', status: 'verified', actual: '0xabc' },
  ],
}
const delta = [{ kind: 'connection', node: 'gov', to: 'core', edgeKind: 'role', label: 'SETTER_ROLE', before: null, after: { status: 'verified' } }]
const whole: GraphFilters = { mode: 'all', focus: '', query: '', missingOnly: false, hide: [] }
const spies = { filters: vi.fn(), select: vi.fn(), link: vi.fn() }
function Harness({ start = whole, startLink = '' }: { start?: GraphFilters; startLink?: string }) {
  const [filters, setFilters] = useState(start),
    [selected, setSelected] = useState('core'),
    [link, setLink] = useState(startLink)
  return (
    <MantineProvider env="test">
      <ContractGraph
        snapshot={snapshot as any}
        profile={{ id: 'p', name: 'P', chainId: 1, nodes: snapshot.nodes, explorer: 'https://arbiscan.io' } as any}
        selected={selected}
        link={link}
        filters={filters}
        delta={delta}
        onFilters={(next, options) => {
          spies.filters(next, options)
          setFilters(next)
        }}
        onSelect={(id) => {
          spies.select(id)
          setSelected(id)
          setLink('')
        }}
        onLink={(id) => {
          spies.link(id)
          setLink(id)
        }}
        onPrepare={vi.fn()}
      />
    </MantineProvider>
  )
}
describe('the map', () => {
  const getContext = HTMLCanvasElement.prototype.getContext
  beforeAll(() => {
    const context: any = new Proxy(
      {},
      {
        get: (target: any, key) => (key === 'measureText' ? () => ({ width: 10 }) : key in target ? target[key] : () => context),
        set: (target, key, value) => ((target[key] = value), true),
      },
    )
    HTMLCanvasElement.prototype.getContext = (() => context) as any
  })
  // Reduced motion makes zooming immediate, so the readout can be checked without waiting for an animation.
  beforeEach(() => {
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('reduce'),
          media: query,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
        }) as any,
    )
  })
  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = getContext
  })
  const section = () => document.querySelector<HTMLElement>('.graph-panel')!
  const escape = () => fireEvent.keyDown(screen.getByRole('group', { name: /Interactive contract graph/ }), { key: 'Escape' })

  test('fullscreen is the same map: the question, the change view, the zoom and the canvas all stay', async () => {
    render(<Harness />)
    fireEvent.click(within(screen.getByLabelText('Contract inspector')).getAllByRole('button', { name: 'Show on map' })[0])
    expect(screen.getByRole('heading', { name: 'Who can change Symmio' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Changes/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await waitFor(() => expect(section().querySelector('.graph-zoom')!.textContent).toContain('88%'))
    const drawing = section().querySelector('.graph-canvas canvas')
    expect(drawing).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
    expect(section().className).toContain('graph-fullscreen')
    expect(screen.getByRole('heading', { name: 'Who can change Symmio' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Changes/ }).getAttribute('aria-pressed')).toBe('true')
    expect(section().querySelector('.graph-zoom')!.textContent).toContain('88%')
    expect(section().querySelector('.graph-canvas canvas')).toBe(drawing)

    // Escape steps back one thing at a time: the question first, then fullscreen.
    escape()
    expect(screen.queryByRole('heading', { name: 'Who can change Symmio' })).toBeNull()
    expect(section().className).toContain('graph-fullscreen')
    escape()
    expect(section().className).not.toContain('graph-fullscreen')
    expect(section().querySelector('.graph-canvas canvas')).toBe(drawing)
  })

  test('Escape closes an open line before it closes fullscreen', () => {
    render(<Harness startLink="gov>core" />)
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
    expect(screen.getByLabelText('Connection detail')).toBeTruthy()
    escape()
    expect(spies.link).toHaveBeenLastCalledWith('')
    expect(screen.queryByLabelText('Connection detail')).toBeNull()
    expect(section().className).toContain('graph-fullscreen')
  })

  test('choosing a contract in a panel lights it on the map, with both questions one click away', () => {
    render(<Harness startLink="gov>core" />)
    fireEvent.click(within(screen.getByLabelText('Connection detail')).getByRole('button', { name: 'Admin authority' }))
    expect(spies.select).toHaveBeenLastCalledWith('gov')
    const pill = section().querySelector('.graph-scope') as HTMLElement
    expect(pill.textContent).toContain('Admin authority and its connections')
    fireEvent.click(within(pill).getByRole('button', { name: 'Who can change it' }))
    expect(screen.getByRole('heading', { name: 'Who can change Admin authority' })).toBeTruthy()
  })

  test('the search waits for a pause, rewrites history instead of adding to it, and Enter selects the best match', async () => {
    spies.filters.mockClear()
    render(<Harness />)
    const box = screen.getByRole('textbox', { name: 'Find contract, role or getter' })
    expect(box.getAttribute('placeholder')).toBe('Find contract, role or getter')
    for (const text of ['l', 'li', 'lis']) fireEvent.change(box, { target: { value: text } })
    expect(spies.filters).not.toHaveBeenCalled()
    await waitFor(() => expect(spies.filters).toHaveBeenCalledTimes(1))
    expect(spies.filters).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'lis' }), { replace: true })
    // A listed wallet with no connections is still found, and Enter selects it.
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(spies.select).toHaveBeenLastCalledWith('idle')
    // An address nobody has says so, rather than blaming the connections.
    fireEvent.change(box, { target: { value: '0xdeadbeef' } })
    await waitFor(() => expect(screen.getByText('No contract at 0xdeadbeef.')).toBeTruthy())
  })

  test('"/" finds and "?" lists the gestures and shortcuts', async () => {
    render(<Harness />)
    fireEvent.keyDown(document.body, { key: '/' })
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Find contract, role or getter' }))
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document.body, { key: '?' })
    await waitFor(() => expect(screen.getByText('Double-click')).toBeTruthy())
    expect(screen.getByText(/Close the open line, then the question or highlight, then fullscreen/)).toBeTruthy()
  })

  test('what is drawn is announced politely, and counts read as words', async () => {
    render(<Harness />)
    const status = section().querySelector<HTMLElement>('[role="status"]')!
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('Whole system · 5 nodes · 5 of 5 connections · 1 issue · Selected Symmio')
    fireEvent.click(screen.getByRole('button', { name: /Issues only/ }))
    expect(spies.filters).toHaveBeenLastCalledWith(expect.objectContaining({ missingOnly: true }), { replace: true })
    await waitFor(() => expect(status.textContent).toBe('Whole system · 2 nodes · 1 of 5 connections · 1 issue · Selected Symmio'))
    // A question is drawn whatever the filters say, and the pill says how much of it they would have hidden.
    act(() => void fireEvent.click(within(screen.getByLabelText('Contract inspector')).getAllByRole('button', { name: 'Show on map' })[0]))
    expect(section().querySelector('.graph-scope')?.textContent).toMatch(/2 addresses can change Symmio · 3 of 3 connections drawn past the filters/)
    expect(status.textContent).toContain('2 addresses can change Symmio')
    expect(section().querySelector('.graph-legend')?.textContent).toMatch(/\d+ address(es)? · /)
  })
})
