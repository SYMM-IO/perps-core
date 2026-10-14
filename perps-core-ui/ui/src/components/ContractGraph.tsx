import { power, stackModel } from '../../../shared/graph-insight.js'
import { bundleEdges, EDGE_GROUPS, isImplementation, SYSTEM_LANES } from '../../../shared/graph-model.js'
import { changeView, filterView, findContracts, finishView, looksLikeAddress, placeNodes, scopeKey, stacksOf } from '../../../shared/map-view.js'
import { FAMILIES, familyOf, familyTones, graphStyles, NODE_FONT, TEXT_WIDTH, type Family } from '../lib/graph-styles'
import { fitBox, fitLabel, panToKeep, savedScrollMode, saveScrollMode, wheelReader, type ScrollMode } from '../lib/map-gesture'
import { short } from '../lib/state'
import type { PatchOptions } from '../lib/url'
import type { ContractNode, GraphFilters, Link, Profile, Snapshot } from '../types'
import { Inspector, LinkDetail } from './Inspector'
import { PowerDetail, StackDetail, type PowerResult, type StackNode } from './MapPanels'
import { ResizableSidebar } from './ResizableSidebar'
import {
  ActionIcon,
  Button,
  FocusTrap,
  Group,
  Popover,
  Select,
  Text,
  TextInput,
  Tooltip,
  useComputedColorScheme,
  VisuallyHidden,
  type ComboboxItem,
  type OptionsFilter,
} from '@mantine/core'
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'
import { Check, CircleHelp, Expand, Focus, Info, LayoutGrid, Minimize, Minus, Move, Plus, Scan, Search, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

interface Props {
  snapshot?: Snapshot
  profile: Profile
  selected: string
  link: string
  filters: GraphFilters
  /** `replace` is set for typing and filter chips, which are not worth a step back. */
  onFilters: (next: GraphFilters, options?: PatchOptions) => void
  onSelect: (id: string) => void
  onLink: (id: string) => void
  onPrepare: (node: ContractNode) => void
  /** Disables Prepare upgrade while another operation runs. */
  prepareDisabled?: boolean
  /** What changed between the previous inspection and this one, and which inspection that was. */
  delta?: any[]
  since?: { blockNumber: number; at?: string } | null
}
type Direction = 'over' | 'under'
type Point = { x: number; y: number }
const NO_CHANGES: any[] = []
const ZOOM = { min: 0.05, max: 2.5 }
// Names are drawn at 13px. Further out than this they cannot be read, so the map never opens further out.
const READABLE = 0.7
const NAME_FONT = `${NODE_FONT.weight} ${NODE_FONT.size}px ${NODE_FONT.family}`
const still = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const visible = (element: HTMLElement) => {
  for (let box: HTMLElement | null = element; box; box = box.parentElement) if (box.hidden || getComputedStyle(box).display === 'none') return false
  return true
}

const SHORTCUTS: [string, string][] = [
  ['Drag', 'Move the map. With Arrange on, move a contract'],
  ['Scroll', 'Zoom at the pointer, or move the map: the Scroll switch decides'],
  ['Pinch, ⌘-scroll', 'Zoom'],
  ['Click', 'Light a contract and what it touches, or open a line'],
  ['Double-click', 'Draw the map around a contract, or open a stack'],
  ['Arrow keys', 'Move the map'],
  ['+  −  0', 'Zoom in, zoom out, fit'],
  ['/', 'Find a contract. Enter selects the best match'],
  ['Esc', 'Close the open line, then the question or highlight, then fullscreen'],
  ['?', 'This list'],
]

/** What the canvas's own events do. They are bound once, so they call through to the current render from here. */
interface Handlers {
  pick: (id: string) => void
  focus: (id: string) => void
  link: (id: string) => void
  clear: () => void
  preview: (id: string) => void
  rest: () => void
}
/**
 * One Cytoscape instance for the life of the map, with the gestures around it: tap and double-tap, the
 * hover preview, the wheel, keeping the map in sight, and keeping the centre still as the canvas resizes.
 */
function useCytoscape(
  canvas: RefObject<HTMLDivElement | null>,
  handlers: RefObject<Handlers>,
  live: RefObject<{ scroll: ScrollMode; arrange: boolean }>,
  light: boolean,
) {
  const cy = useRef<Core | null>(null)
  // The same instance as state, for parts that subscribe to it after it exists.
  const [instance, setInstance] = useState<Core | null>(null)
  useEffect(() => {
    if (!canvas.current) return
    const container = canvas.current
    const graph = cytoscape({
      container,
      elements: [],
      style: graphStyles(light),
      layout: { name: 'preset' },
      minZoom: ZOOM.min,
      maxZoom: ZOOM.max,
      boxSelectionEnabled: false,
      selectionType: 'single',
    })
    cy.current = graph
    setInstance(graph)
    graph.on('tap', 'node', (e) => handlers.current.pick(e.target.id()))
    graph.on('dbltap', 'node', (e) => handlers.current.focus(e.target.id()))
    graph.on('tap', 'edge', (e) => handlers.current.link(e.target.id()))
    graph.on('tap', (e) => e.target === graph && handlers.current.clear())
    const wrap = container.parentElement!
    // The pointer says what a press will do: move the map, open a contract, or (when arranging) move a contract.
    const point = (cursor: string) => (container.style.cursor = cursor)
    graph.on('mouseover', 'edge', (e) => {
      e.target.addClass('hover-edge')
      point('pointer')
    })
    graph.on('mouseout', 'edge', (e) => {
      e.target.removeClass('hover-edge')
      point('')
    })
    // Resting on a contract previews its neighbourhood. Passing over one on the way somewhere else does not,
    // and neither does dragging the map, so the picture holds still while the pointer moves.
    let hover = 0,
      pressed = false
    graph.on('mouseover', 'node', (e) => {
      if (e.target.hasClass('lane')) return
      point(live.current.arrange ? 'move' : 'pointer')
      const id = e.target.id()
      window.clearTimeout(hover)
      hover = window.setTimeout(() => !pressed && handlers.current.preview(id), 140)
    })
    graph.on('mouseout', 'node', () => {
      point('')
      window.clearTimeout(hover)
      if (!pressed) handlers.current.rest()
    })
    const press = () => {
      pressed = true
      window.clearTimeout(hover)
      wrap.dataset.pressed = ''
    }
    const release = () => {
      pressed = false
      delete wrap.dataset.pressed
    }
    // Leaving the canvas while over a contract ends the preview too; Cytoscape reports no mouseout for that.
    const leave = () => {
      window.clearTimeout(hover)
      point('')
      if (!pressed) handlers.current.rest()
    }
    container.addEventListener('mouseleave', leave)
    container.addEventListener('pointerdown', press)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    // The map cannot be scrolled or dragged out of sight: some of it always stays on the canvas.
    let extent: { x1: number; y1: number; x2: number; y2: number } | undefined,
      holding = false
    graph.on('add remove position', () => (extent = undefined))
    graph.on('pan zoom', () => {
      if (holding || !graph.nodes().length) return
      extent ??= graph.elements().boundingBox()
      const back = panToKeep(extent, graph.zoom(), graph.pan(), { width: graph.width(), height: graph.height() })
      if (!back.x && !back.y) return
      holding = true
      graph.panBy(back)
      holding = false
    })
    // Cytoscape's own wheel handling zooms in coarse steps, so the wheel is taken before it gets there.
    const read = wheelReader()
    const wheel = (e: WheelEvent) => {
      if (!container.contains(e.target as Node)) return
      e.preventDefault()
      e.stopPropagation()
      const action = read(e, live.current.scroll)
      if ('pan' in action) return void graph.panBy(action.pan)
      const box = container.getBoundingClientRect()
      graph.stop()
      graph.zoom({
        level: Math.min(ZOOM.max, Math.max(ZOOM.min, graph.zoom() * action.zoom)),
        renderedPosition: { x: e.clientX - box.left, y: e.clientY - box.top },
      })
    }
    wrap.addEventListener('wheel', wheel, { capture: true, passive: false })
    let size = { width: container.clientWidth, height: container.clientHeight }
    const observer = new ResizeObserver(() => {
      const next = { width: container.clientWidth, height: container.clientHeight }
      graph.resize()
      // The point at the canvas centre stays put as the inspector, the window or fullscreen resize it.
      if (size.width && size.height && next.width && next.height)
        graph.panBy({ x: (next.width - size.width) / 2, y: (next.height - size.height) / 2 })
      size = next
    })
    observer.observe(container)
    return () => {
      wrap.removeEventListener('wheel', wheel, { capture: true })
      container.removeEventListener('mouseleave', leave)
      container.removeEventListener('pointerdown', press)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.clearTimeout(hover)
      observer.disconnect()
      graph.destroy()
      cy.current = null
      setInstance(null)
    }
  }, [])
  useEffect(() => {
    cy.current?.style(graphStyles(light))
  }, [light])
  return { cy, instance }
}

// Classes the map sets from the model. Others ('faded', 'hover-edge') belong to the moment and are left alone.
const MODEL_CLASSES = ['lane', 'attention', 'stack', 'diff-added', 'diff-changed', 'diff-removed', 'quiet']
const FIXED = new Set(['id', 'source', 'target'])
/** Brings the canvas to `elements` by id: adds what is new, removes what has gone and updates the rest in place. */
function reconcile(graph: Core, elements: ElementDefinition[], arrange: boolean) {
  const wanted = new Set(elements.map((e) => e.data.id!))
  graph.batch(() => {
    graph
      .elements()
      .filter((el) => !wanted.has(el.id()))
      .remove()
    for (const group of ['nodes', 'edges'] as const)
      for (const definition of elements) {
        if (definition.group !== group) continue
        const el = graph.getElementById(definition.data.id!),
          classes = String(definition.classes || '')
            .split(' ')
            .filter(Boolean)
        if (!el.length) {
          const added = graph.add(definition)
          if (group === 'nodes' && !added.hasClass('lane')) arrange ? added.unpanify().grabify() : added.ungrabify().panify()
          continue
        }
        const now = el.data(),
          changed = Object.entries(definition.data).filter(([key, value]) => !FIXED.has(key) && now[key] !== value)
        if (changed.length) el.data(Object.fromEntries(changed))
        for (const name of MODEL_CLASSES) el.toggleClass(name, classes.includes(name))
        if (definition.position) el.position(definition.position)
      }
  })
}

/** The zoom level, read from the canvas at most once a frame, so zooming re-renders nothing else. */
function ZoomReadout({ graph }: { graph: Core | null }) {
  const [zoom, setZoom] = useState(100)
  useEffect(() => {
    if (!graph) return
    let frame = 0
    const read = () => {
      frame = 0
      setZoom(Math.round(graph.zoom() * 100))
    }
    const changed = () => (frame ||= requestAnimationFrame(read))
    graph.on('zoom', changed)
    read()
    return () => {
      cancelAnimationFrame(frame)
      if (!graph.destroyed()) graph.off('zoom', changed)
    }
  }, [graph])
  return (
    <Text size="xs" w={36} ta="center">
      {zoom}%
    </Text>
  )
}

/** A toggle that says what it controls and how much: on shows a tick, off shows what it would add. */
function FilterChip({
  on,
  count,
  tone,
  disabled,
  onClick,
  children,
}: {
  on: boolean
  count?: number
  tone?: 'bad' | 'warn'
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button type="button" className="filter-chip" aria-pressed={on} data-tone={tone} disabled={disabled} onClick={onClick}>
      {on && <Check size={13} aria-hidden />}
      <span>{children}</span>
      {count !== undefined && <b>{count}</b>}
    </button>
  )
}

export function ContractGraph({
  snapshot,
  profile,
  selected,
  link,
  filters,
  onFilters,
  onSelect,
  onLink,
  onPrepare,
  prepareDisabled = false,
  delta = NO_CHANGES,
  since,
}: Props) {
  const canvas = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLElement>(null),
    searchBox = useRef<HTMLInputElement>(null)
  const color = useComputedColorScheme('dark')
  // One map for the whole visit: fullscreen is the same map pinned over the page, so nothing on it is lost.
  const [fullscreen, setFullscreen] = useState(false)
  // The contract whose neighbours stay lit while the rest of the map steps back.
  const [spot, setSpot] = useState('')
  // Or a whole family of contracts, picked from the key under the map.
  const [family, setFamily] = useState<Family | ''>('')
  // Dragging moves the map wherever it starts, on a contract or between them. Arranging is a mode you turn on.
  const [arrange, setArrange] = useState(false)
  const [scroll, setScroll] = useState<ScrollMode>(savedScrollMode)
  // Addresses wired identically are drawn as one stack; `expanded` are the stacks opened by hand.
  const [stacking, setStacking] = useState(true)
  const [expanded, setExpanded] = useState<string[]>([])
  // Draws what changed since the previous inspection, with what has gone put back as a ghost.
  const [changes, setChanges] = useState(false)
  // The question being asked of one contract: what it can change, or who can change it.
  const [reach, setReach] = useState<{ id: string; direction: Direction } | null>(null)
  const [help, setHelp] = useState(false)
  // The search box answers each keystroke; the map and the URL follow once typing pauses.
  const [query, setQuery] = useState(filters.query)
  const [centerTick, setCenterTick] = useState(0)
  const implementation = filters.mode === 'implementation'

  const source = useMemo(() => snapshot || { nodes: profile.nodes, edges: [] }, [snapshot, profile.nodes])
  const { overlay, showChanges, drawn } = useMemo(() => changeView(source, delta, changes), [source, delta, changes])
  const reached = useMemo(() => (reach ? (power(source, reach.id, reach.direction) as PowerResult) : null), [source, reach])
  const hidden = filters.hide.join()
  const { plain, every, base, answer } = useMemo(
    () => filterView(drawn, filters, reached),
    [drawn, filters.mode, filters.focus, filters.query, filters.missingOnly, hidden, reached],
  )
  // Whatever is being looked at stays its own node, never folded into a stack.
  const kept = [selected, filters.focus, reach?.id].filter(Boolean).join()
  const stackable = useMemo(() => stackModel(base, { keep: kept.split(',').filter(Boolean) }), [base, kept])
  const model = useMemo(
    () => (!stacking ? base : expanded.length ? stackModel(base, { keep: kept.split(',').filter(Boolean), expanded }) : stackable),
    [base, stackable, stacking, expanded, kept],
  )
  const { stacks, memberOf } = stacksOf(model),
    stackCount = stacksOf(stackable).stacks.size
  const { links, lit, layout, positions, tally } = useMemo(
    () => finishView(model, { plain, reached, showChanges, filters: { mode: filters.mode, focus: filters.focus } }),
    [model, plain, reached, showChanges, filters.mode, filters.focus],
  ) as { links: Link[]; lit: { nodes: Set<string>; links: Set<string> } | null; layout: any; positions: Record<string, Point>; tally: any }
  // Drawn links follow the filters; the side panel always lists a contract's complete set.
  const allLinks = useMemo(() => bundleEdges(every.edges) as Link[], [every])
  const known = every.nodes as ContractNode[]
  const named = useMemo(() => [...known, ...stacks.values()] as ContractNode[], [known, stacks])
  const selectedNode = source.nodes.find((n) => n.id === selected) || known.find((n) => n.id === selected),
    // A link to or from a stack exists only as drawn; every other link is looked up in the complete set.
    selectedLink = allLinks.find((l) => l.id === link) || links.find((l) => l.id === link),
    stack = stacks.get(selected) as StackNode | undefined
  const nameOf = (id: string) => named.find((n) => n.id === id)?.name || source.nodes.find((n) => n.id === id)?.name || 'this contract'
  const update = (patch: Partial<GraphFilters>, options?: PatchOptions) => onFilters({ ...filters, ...patch }, options)
  const filtered = filters.hide.length > 0 || !!filters.query || filters.missingOnly
  const drawnIds = new Set(model.nodes.map((n: any) => n.id as string))

  // Lighting one contract and lighting a family are the same spotlight, so choosing either drops the other.
  const light = (id: string) => {
    setSpot(id)
    setFamily('')
  }
  /** Selecting a contract, from the canvas or any panel: it is lit, and a question about another one ends. */
  const pick = (id: string) => {
    setReach(null)
    onSelect(id)
    light(id)
  }
  /** Asks what a contract can change or who can change it, on the whole system where the answer can be seen. */
  const ask = (id: string, direction: Direction) => {
    setReach({ id, direction })
    light('')
    if (filters.focus || implementation) update({ focus: '', ...(implementation ? { mode: 'all', hide: [] } : {}) })
  }
  const close = () => {
    setFullscreen(false)
    requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('[data-fullscreen-toggle]')?.focus())
  }
  // Escape steps back one thing at a time: the open line, the question or highlight, then fullscreen.
  const escape = () => {
    if (link) onLink('')
    else if (reach) setReach(null)
    else if (spot || family) light('')
    else if (fullscreen) close()
    else return false
    return true
  }
  // The canvas's handlers are bound once, so they read the current choices from here.
  const live = useRef({ spot, family, arrange, scroll, lit, asking: !!reach })
  live.current = { spot, family, arrange, scroll, lit, asking: !!reach }
  const handlers = useRef<Handlers>(null!)
  const { cy, instance } = useCytoscape(canvas, handlers, live, color === 'light')

  /** Lights one contract and what it touches, or every contract of one family; everything else steps back. */
  function highlight(id: string, group: Family | '' = '') {
    const graph = cy.current
    if (!graph) return
    graph.elements().removeClass('faded')
    const node = id ? graph.getElementById(id) : undefined
    if (node?.length) return void graph.elements().not(node.closedNeighborhood()).not('.lane').addClass('faded')
    // An answer to "who can change what", or the change view: light exactly those contracts and lines.
    const marked = live.current.lit
    if (marked)
      return void graph
        .elements()
        .filter((el) => !(el.isNode() ? marked.nodes.has(el.id()) : marked.links.has(el.id())))
        .not('.lane')
        .addClass('faded')
    if (!group) return
    const lit = graph.nodes().filter((n) => !n.hasClass('lane') && familyOf(n.data('kind')) === group)
    if (lit.length) graph.elements().not(lit).not(lit.connectedEdges()).not('.lane').addClass('faded')
  }
  const rest = () => highlight(live.current.asking ? '' : live.current.spot, live.current.family)
  handlers.current = {
    pick,
    // Double-clicking a stack opens it; double-clicking a contract redraws the map around it.
    focus: (id) => (stacks.has(id) ? setExpanded([...expanded, id]) : update({ focus: id })),
    link: onLink,
    clear: () => {
      if (link) onLink('')
      light('')
    },
    preview: (id) => highlight(id),
    rest,
  }

  /** Fits the map to the room left between the overlays on its edges. The first view of a scope stays readable. */
  function fit(readable = false) {
    const graph = cy.current,
      wrap = canvas.current?.parentElement
    if (!graph || !wrap || !graph.nodes().length) return
    graph.stop()
    graph.resize()
    const height = (selector: string) => wrap.querySelector<HTMLElement>(selector)?.offsetHeight || 0,
      top = height('.graph-top'),
      bottom = Math.max(height('.graph-key'), height('.graph-zoom')),
      size = { width: graph.width(), height: graph.height() },
      anchor = graph.getElementById(filters.focus || selected || 'core')
    graph.viewport(
      fitBox(
        graph.elements().boundingBox(),
        size,
        { top: top ? top + 24 : 28, bottom: bottom ? bottom + 24 : 28, left: 28, right: 28 },
        {
          min: readable ? READABLE : size.width < 600 ? 0.5 : ZOOM.min,
          max: 1,
          anchor: anchor.length && !anchor.hasClass('lane') ? anchor.position() : undefined,
        },
      ),
    )
  }
  /** Zooms about the middle of the canvas, so what you are looking at stays where it is. */
  function zoomBy(factor: number) {
    const graph = cy.current
    if (!graph) return
    const target = {
      level: Math.min(ZOOM.max, Math.max(ZOOM.min, graph.zoom() * factor)),
      renderedPosition: { x: graph.width() / 2, y: graph.height() / 2 },
    }
    graph.stop()
    if (still()) graph.zoom(target)
    else graph.animate({ zoom: target, duration: 140, easing: 'ease-out' })
  }

  // The map is fitted when what it is drawn around changes, and laid out afresh when stacking is switched.
  // Otherwise every contract already drawn keeps its place, dragged or not, and the view holds still.
  const drawnScope = useRef<string | null>(null),
    drawnLayout = useRef<string | null>(null),
    drawnMembers = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    const graph = cy.current
    if (!graph) return
    const scope = scopeKey(filters),
      arrangement = `${scope}|${stacking}`,
      current = graph.nodes().not('.lane').nodes(),
      fresh = !current.length || drawnLayout.current !== arrangement,
      refit = !current.length || drawnScope.current !== scope
    const placed = placeNodes(
      model.nodes,
      layout.positions,
      fresh
        ? null
        : {
            positions: Object.fromEntries(current.map((n) => [n.id(), { ...n.position() }])),
            memberOf: drawnMembers.current,
            reserved: graph.nodes('.lane').map((n) => ({ ...n.position() })),
          },
    ) as Record<string, Point>
    const attention = new Set(links.filter((l) => l.missing).flatMap((l) => [l.from, l.to])),
      quiet = links.length > 28,
      degree = new Map<string, number>()
    for (const l of links) for (const id of [l.from, l.to]) degree.set(id, (degree.get(id) || 0) + 1)
    const elements: ElementDefinition[] = [
      ...layout.sections.map((s: any) => {
        const id = `lane:${s.name}`,
          was = graph.getElementById(id)
        return {
          group: 'nodes' as const,
          data: { id, label: s.name },
          position: !fresh && was.length ? { ...was.position() } : positions[id],
          classes: 'lane',
          selectable: false,
          grabbable: false,
        }
      }),
      ...model.nodes.map((n: any) => ({
        group: 'nodes' as const,
        data: {
          id: n.id,
          // A stack has no address of its own; its second line says what each of its members has.
          label: `${fitLabel(n.stack ? n.title : n.name, TEXT_WIDTH, NAME_FONT)}\n${n.stack ? fitLabel(n.summary, TEXT_WIDTH, NAME_FONT) : short(n.address)}`,
          kind: n.kind,
          ...(n.stack ? { count: n.members.length } : {}),
        },
        position: placed[n.id],
        classes: [attention.has(n.id) && 'attention', n.stack && 'stack', n.diff && `diff-${n.diff}`, n.removed && 'diff-removed']
          .filter(Boolean)
          .join(' '),
      })),
      ...links.map((l) => {
        // The count sits at the less connected end, away from the hub where every line converges.
        const atSource = degree.get(l.from)! <= degree.get(l.to)!,
          count = l.count > 1 ? String(l.count) : ''
        return {
          group: 'edges' as const,
          data: {
            id: l.id,
            source: l.from,
            target: l.to,
            label: l.label,
            sourceCount: atSource ? count : '',
            targetCount: atSource ? '' : count,
            state: l.state,
            width: 1.4 + Math.min(4, Math.log2(l.count)),
          },
          classes: [quiet && 'quiet', l.diff && `diff-${l.diff}`].filter(Boolean).join(' '),
        }
      }),
    ]
    reconcile(graph, elements, live.current.arrange)
    drawnScope.current = scope
    drawnLayout.current = arrangement
    drawnMembers.current = memberOf
    if (refit) fit(true)
    rest()
  }, [model, links, layout])
  useEffect(() => highlight(reach ? '' : spot, family), [spot, family, lit, reach])
  useEffect(() => {
    const nodes = cy.current?.nodes().not('.lane')
    if (!nodes) return
    if (arrange) nodes.unpanify().grabify()
    else nodes.ungrabify().panify()
  }, [arrange])
  // A highlight belongs to the view it was made in: drawing around another contract ends it, and a
  // selection made anywhere else (a panel, the URL, the Back button) moves it to what is now selected.
  const lastFocus = useRef(filters.focus)
  useEffect(() => {
    if (lastFocus.current !== filters.focus) {
      lastFocus.current = filters.focus
      return light('')
    }
    if (spot && spot !== selected) setSpot(drawnIds.has(selected) ? selected : '')
  }, [selected, filters.focus])

  // The canvas takes exactly the room left under the toolbar, so the page itself never needs to scroll
  // and a scroll over the map can only ever mean the map. In fullscreen it takes the window.
  useLayoutEffect(() => {
    const section = panel.current,
      wrap = canvas.current?.parentElement
    if (!section || !wrap) return
    const size = () => {
      const top = wrap.getBoundingClientRect().top
      if (fullscreen) {
        let below = 0
        for (let next = wrap.nextElementSibling as HTMLElement | null; next; next = next.nextElementSibling as HTMLElement | null)
          below += next.offsetHeight || 0
        return section.style.setProperty('--graph-fit', `${Math.floor(window.innerHeight - top - below)}px`)
      }
      // Everything that sits under the canvas: the bar below it, then each enclosing box's own padding and margin.
      let below = section.getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom
      for (let box: HTMLElement | null = section; box && box !== document.documentElement; box = box.parentElement) {
        const style = getComputedStyle(box)
        below += parseFloat(style.marginBottom) + (box === section ? 0 : parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth))
        for (let next = box.nextElementSibling as HTMLElement | null; next; next = next.nextElementSibling as HTMLElement | null)
          if (!['fixed', 'absolute'].includes(getComputedStyle(next).position)) below += next.offsetHeight || 0
      }
      section.style.setProperty('--graph-fit', `${Math.floor(window.innerHeight - top - below)}px`)
    }
    size()
    const observer = new ResizeObserver(size)
    for (const child of section.children) observer.observe(child)
    observer.observe(document.body)
    window.addEventListener('resize', size)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', size)
      section.style.removeProperty('--graph-fit')
    }
  }, [fullscreen])
  // Fullscreen covers the page, so the page underneath does not scroll.
  useEffect(() => {
    if (!fullscreen) return
    const before = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = before
    }
  }, [fullscreen])

  // Selecting re-applies after every redraw. The map only moves for a selection that changed (and then only
  // when it is off the canvas), or when the search asked for its match to be shown.
  const shown = useRef({ selected: '', link: '' }),
    centerOn = useRef('')
  useEffect(() => {
    const graph = cy.current
    if (!graph) return
    graph.elements().unselect()
    const target = graph.getElementById(link && graph.getElementById(link).length ? link : selected)
    target.select()
    const moved = shown.current.selected !== selected || shown.current.link !== link,
      asked = !!centerOn.current && centerOn.current === selected
    shown.current = { selected, link }
    if (!target.length || (!moved && !asked)) return
    centerOn.current = ''
    const box = target.renderedBoundingBox(),
      inside = box.x1 >= 0 && box.y1 >= 0 && box.x2 <= graph.width() && box.y2 <= graph.height()
    if (inside && !asked) return
    graph.stop()
    if (still()) graph.center(target)
    else graph.animate({ center: { eles: target }, duration: 220, easing: 'ease-out' })
  }, [selected, link, links, centerTick])

  // The search box: what is typed reaches the map and the URL 150 ms after the last key, as one history entry.
  const sent = useRef(filters.query),
    latest = useRef(filters)
  latest.current = filters
  const send = (text: string) => {
    sent.current = text
    onFilters({ ...latest.current, query: text }, { replace: true })
  }
  useEffect(() => {
    if (filters.query === sent.current) return
    sent.current = filters.query
    setQuery(filters.query)
  }, [filters.query])
  useEffect(() => {
    if (query === sent.current) return
    const timer = window.setTimeout(() => send(query), 150)
    return () => window.clearTimeout(timer)
  }, [query])
  const resetFilters = () => {
    sent.current = ''
    setQuery('')
    update({ hide: [], query: '', missingOnly: false }, { replace: true })
  }
  // The contracts a search can select. Within one contract's neighbourhood, the ones drawn come first.
  const contracts = source.nodes.filter((n) => implementation || !isImplementation(n.kind)),
    candidates = [...contracts, ...known.filter((n) => !contracts.some((c) => c.id === n.id))]
  const findBest = (text: string) => {
    const matches = findContracts(candidates, text) as ContractNode[]
    return (filters.focus && matches.find((n) => drawnIds.has(n.id) || memberOf.has(n.id))) || matches[0]
  }
  const missingAddress = looksLikeAddress(filters.query) && !findContracts(candidates, filters.query).length

  // "/" finds and "?" lists the shortcuts, from anywhere on the page while the map is showing.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || !['/', '?'].includes(e.key)) return
      const target = e.target as HTMLElement | null
      if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="combobox"]')) return
      if (!panel.current || !visible(panel.current)) return
      e.preventDefault()
      if (e.key === '/') searchBox.current?.focus()
      else setHelp((open) => !open)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [])

  // The contract picker lists contracts under the same headings the map draws them in.
  const addressOf = new Map(contracts.map((n) => [n.id, n.address])),
    lanes: string[] = [...SYSTEM_LANES.map((lane: { name: string }) => lane.name), 'Facets & libraries'],
    laneOf = (kind: string) =>
      SYSTEM_LANES.find((lane: { kinds: string[] }) => lane.kinds.includes(kind))?.name ||
      (isImplementation(kind) ? 'Facets & libraries' : SYSTEM_LANES[SYSTEM_LANES.length - 1].name)
  const contractGroups = lanes
    .map((group) => ({
      group,
      items: contracts
        .filter((n) => laneOf(n.kind) === group)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((n) => ({ value: n.id, label: n.name })),
    }))
    .filter((g) => g.items.length)
  const contractFilter: OptionsFilter = ({ options, search }) => {
    const text = search.trim().toLowerCase(),
      match = (o: ComboboxItem) => o.label.toLowerCase().includes(text) || (addressOf.get(o.value) || '').toLowerCase().includes(text)
    return options
      .map((o) => ('group' in o ? { ...o, items: (o.items as ComboboxItem[]).filter(match) } : o))
      .filter((o) => !('group' in o) || o.items.length)
  }
  const reachedCount = reached ? new Set(reached.entries.map((e) => e.node)).size : 0
  // The key under the map lists only the families drawn now, each in the tone its contracts have.
  const tones = familyTones(color === 'light'),
    sizeOf = (n: any) => (n.stack ? n.members.length : 1),
    present = FAMILIES.map((f) => ({
      ...f,
      count: model.nodes.filter((n: any) => familyOf(n.kind) === f.id).reduce((sum: number, n: any) => sum + sizeOf(n), 0),
    })).filter((f) => f.count)
  const toggle = (group: string) =>
    update({ hide: filters.hide.includes(group) ? filters.hide.filter((g) => g !== group) : [...filters.hide, group] }, { replace: true })
  const question = reached
    ? reached.direction === 'over'
      ? `${nameOf(reached.root)} can change ${reachedCount ? plural(reachedCount, 'contract') : 'nothing'}`
      : `${reachedCount ? plural(reachedCount, 'address', 'addresses') : 'Nobody'} can change ${nameOf(reached.root)}`
    : ''
  // Said to a screen reader whenever what is drawn changes: scope, filters, question, changes or selection.
  const announcement = [
    filters.focus ? `Around ${nameOf(filters.focus)}` : implementation ? 'Facets & libraries' : 'Whole system',
    plural(tally.nodes, 'node'),
    `${tally.connections.toLocaleString()} of ${plural(tally.of, 'connection')}`,
    tally.issues ? plural(tally.issues, 'issue') : '',
    question,
    showChanges ? `${plural(overlay.count, 'change')} marked` : '',
    selectedLink ? `Selected ${nameOf(selectedLink.from)} to ${nameOf(selectedLink.to)}` : selectedNode ? `Selected ${selectedNode.name}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const empty = !links.length
    ? !snapshot
      ? 'Inspect the deployment to verify its wiring.'
      : missingAddress
        ? `No contract at ${filters.query.trim().length === 42 ? short(filters.query.trim()) : filters.query.trim()}.`
        : model.nodes.length
          ? 'No connections match these filters.'
          : 'Nothing matches these filters.'
    : ''
  const spotted = !reached && !filters.focus && spot && drawnIds.has(spot) ? spot : ''

  return (
    <FocusTrap active={fullscreen} innerRef={panel}>
      <section
        className={`graph-panel ${fullscreen ? 'graph-fullscreen' : ''}`}
        aria-label="Contract wiring graph"
        {...(fullscreen ? { role: 'dialog', 'aria-modal': true } : {})}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || e.defaultPrevented) return
          const target = e.target as HTMLElement
          // A key pressed in an open dropdown or a popover belongs to it.
          if (!e.currentTarget.contains(target) || target.closest('[aria-expanded="true"]')) return
          if (escape()) {
            e.preventDefault()
            e.stopPropagation()
          }
        }}
      >
        <div className="graph-toolbar">
          {/* Two plain choices: the whole system, or one contract and what it touches. */}
          <div className="seg" role="group" aria-label="How much of the system the map shows">
            <button type="button" aria-pressed={!filters.focus} onClick={() => update({ focus: '' })}>
              Whole system
            </button>
            <button
              type="button"
              aria-pressed={!!filters.focus}
              onClick={() => {
                const id = contracts.some((n) => n.id === selected) ? selected : 'core'
                update({ focus: id })
                onSelect(id)
              }}
            >
              One contract
            </button>
          </div>
          {filters.focus && (
            <Select
              aria-label="Contract the map is drawn around"
              data={contractGroups}
              value={filters.focus}
              searchable
              allowDeselect={false}
              leftSection={<span className="graph-focus-label">Around</span>}
              leftSectionWidth={70}
              leftSectionPointerEvents="none"
              filter={contractFilter}
              renderOption={({ option }) => (
                <span className="contract-option">
                  <span>{option.label}</span>
                  <code>{short(addressOf.get(option.value) || '')}</code>
                </span>
              )}
              nothingFoundMessage="No contract matches"
              comboboxProps={{ width: 360, position: 'bottom-start' }}
              maxDropdownHeight={380}
              onChange={(value) => {
                if (!value) return
                update({ focus: value })
                onSelect(value)
              }}
              className="graph-focus"
            />
          )}
          <TextInput
            ref={searchBox}
            aria-label="Find contract, role or getter"
            placeholder="Find contract, role or getter"
            leftSection={<Search size={14} />}
            rightSection={
              query && (
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery('')
                    send('')
                  }}
                >
                  <X size={14} />
                </ActionIcon>
              )
            }
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              if (query !== sent.current) send(query)
              const best = findBest(query)
              if (!best) return
              centerOn.current = best.id
              pick(best.id)
              setCenterTick((n) => n + 1)
            }}
            className="graph-query"
          />
          <div className="graph-filters" role="group" aria-label="Connections shown">
            {!implementation &&
              EDGE_GROUPS.map((group: { id: string; label: string }) => {
                const count = plain.tally.groups[group.id] as number
                return (
                  <FilterChip
                    key={group.id}
                    on={!filters.hide.includes(group.id) && count > 0}
                    count={count}
                    disabled={!count}
                    onClick={() => toggle(group.id)}
                  >
                    {group.label}
                  </FilterChip>
                )
              })}
            <FilterChip
              on={filters.missingOnly}
              count={plain.tally.issues}
              tone="bad"
              disabled={!plain.tally.issues && !filters.missingOnly}
              onClick={() => update({ missingOnly: !filters.missingOnly }, { replace: true })}
            >
              Issues only
            </FilterChip>
            <span className="filter-sep" aria-hidden />
            <FilterChip on={implementation} onClick={() => update({ mode: implementation ? 'all' : 'implementation', hide: [] })}>
              Facets & libraries
            </FilterChip>
            <FilterChip
              on={stacking && stackCount > 0}
              count={stackCount}
              disabled={!stackCount}
              onClick={() => {
                setStacking(!stacking || expanded.length > 0)
                setExpanded([])
              }}
            >
              Stack look-alikes
            </FilterChip>
            {overlay.count > 0 && (
              <FilterChip on={showChanges} count={overlay.count} tone="warn" onClick={() => setChanges(!changes)}>
                Changes
              </FilterChip>
            )}
            {filtered && (
              <Button size="compact-sm" variant="subtle" onClick={resetFilters}>
                Reset
              </Button>
            )}
          </div>
          <Group gap={4} ml="auto" wrap="nowrap">
            <Tooltip label="Fit to view (0)">
              <ActionIcon variant="default" size="lg" aria-label="Fit to view" onClick={() => fit()}>
                <Scan size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={arrange ? 'Stop arranging: dragging moves the map again' : 'Arrange: drag contracts to new places'}>
              <ActionIcon
                variant={arrange ? 'filled' : 'default'}
                size="lg"
                aria-label="Arrange contracts by dragging"
                aria-pressed={arrange}
                onClick={() => setArrange(!arrange)}
              >
                <Move size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Reset layout">
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="Reset layout"
                onClick={() => {
                  cy.current?.nodes().positions((n) => positions[n.id()] || n.position())
                  fit()
                }}
              >
                <LayoutGrid size={16} />
              </ActionIcon>
            </Tooltip>
            <Popover width={380} position="bottom-end" withArrow>
              <Popover.Target>
                <Tooltip label="Scan coverage">
                  <ActionIcon variant="default" size="lg" aria-label="Scan coverage and limitations">
                    <Info size={16} />
                  </ActionIcon>
                </Tooltip>
              </Popover.Target>
              <Popover.Dropdown>
                <Text size="xs">{snapshot?.coverage ? String(snapshot.coverage) : 'Inspect the deployment to read its connections.'}</Text>
                {snapshot?.roleHistory && (
                  <Text size="xs" c="dimmed" mt="xs">
                    Role events: {snapshot.roleHistory.complete ? 'complete history' : 'incomplete history'}
                    {snapshot.roleHistory.unreadRanges ? ` · ${snapshot.roleHistory.unreadRanges} block ranges unread` : ''}
                  </Text>
                )}
                <Text size="xs" c="dimmed" mt="xs">
                  Left to right: {layout.sections.map((s: any) => s.name).join(' → ')}
                </Text>
              </Popover.Dropdown>
            </Popover>
            <Popover opened={help} onChange={setHelp} width={400} position="bottom-end" withArrow>
              <Popover.Target>
                <Tooltip label="Gestures and shortcuts (?)">
                  <ActionIcon variant="default" size="lg" aria-label="Gestures and shortcuts">
                    <CircleHelp size={16} />
                  </ActionIcon>
                </Tooltip>
              </Popover.Target>
              <Popover.Dropdown>
                <dl className="map-help" aria-label="Gestures and shortcuts">
                  {SHORTCUTS.map(([key, what]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{what}</dd>
                    </div>
                  ))}
                </dl>
              </Popover.Dropdown>
            </Popover>
            <Tooltip label={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}>
              <ActionIcon
                variant="default"
                size="lg"
                aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                onClick={() => (fullscreen ? close() : setFullscreen(true))}
                data-fullscreen-toggle
                data-autofocus={fullscreen || undefined}
              >
                {fullscreen ? <Minimize size={16} /> : <Expand size={16} />}
              </ActionIcon>
            </Tooltip>
          </Group>
        </div>
        <ResizableSidebar
          storageKey="workbench:inspector-width"
          label="contract inspector"
          sidebar={
            selectedLink ? (
              <LinkDetail
                link={selectedLink}
                nodes={named}
                block={snapshot?.blockNumber}
                back={selectedNode?.name}
                explorer={profile.explorer}
                onSelect={pick}
                onClose={() => onLink('')}
              />
            ) : reached ? (
              <PowerDetail
                result={reached}
                nodes={named}
                onLink={onLink}
                onDirection={(direction) => setReach({ id: reached.root, direction })}
                onClose={() => setReach(null)}
              />
            ) : stack ? (
              <StackDetail
                stack={stack}
                links={links}
                nodes={named}
                onSelect={pick}
                onLink={onLink}
                onExpand={() => setExpanded([...expanded, stack.id])}
              />
            ) : (
              <Inspector
                node={selectedNode}
                nodes={drawn.nodes}
                edges={drawn.edges}
                links={allLinks}
                profile={profile}
                changes={delta.filter((d) => d.node === selected || d.to === selected)}
                onPrepare={(node) => {
                  setFullscreen(false)
                  onPrepare(node)
                }}
                prepareDisabled={prepareDisabled}
                onSelect={pick}
                onLink={onLink}
                onPower={snapshot ? ask : undefined}
              />
            )
          }
        >
          <div className="graph-main">
            <div className="graph-canvas-wrap">
              <div
                className="graph-canvas"
                ref={canvas}
                tabIndex={0}
                role="group"
                aria-label="Interactive contract graph. Choose Whole system or One contract above to set what is drawn; a contract's connections are listed in the inspector. Arrow keys move the map, plus and minus zoom, zero fits, slash finds a contract, question mark lists the shortcuts, Escape closes the open line, then the highlight."
                onKeyDown={(e) => {
                  const graph = cy.current
                  if (!graph || !['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
                  e.preventDefault()
                  if (e.key === '0') fit()
                  else if (['+', '=', '-'].includes(e.key)) zoomBy(e.key === '-' ? 0.8 : 1.25)
                  else
                    graph.panBy({
                      x: e.key === 'ArrowLeft' ? 80 : e.key === 'ArrowRight' ? -80 : 0,
                      y: e.key === 'ArrowUp' ? 80 : e.key === 'ArrowDown' ? -80 : 0,
                    })
                }}
              />
              {/* What the map is lit for, and why it may be empty, pinned above it with the way back out. */}
              {(reached || spotted || showChanges || empty) && (
                <div className="graph-top">
                  {reached ? (
                    <div className="graph-scope">
                      <span>
                        {reached.direction === 'over' ? (
                          <>
                            <b>{nameOf(reached.root)}</b> can change {reachedCount ? plural(reachedCount, 'contract') : 'nothing'}
                          </>
                        ) : (
                          <>
                            {reachedCount ? plural(reachedCount, 'address', 'addresses') : 'Nobody'} can change <b>{nameOf(reached.root)}</b>
                          </>
                        )}
                        {/* The answer is drawn whatever the filters say; this says how much of it they would have hidden. */}
                        {answer.outside > 0 && ` · ${answer.outside} of ${plural(answer.total, 'connection')} drawn past the filters`}
                      </span>
                      <button type="button" aria-label="Close this view" onClick={() => setReach(null)}>
                        <X size={13} aria-hidden />
                      </button>
                    </div>
                  ) : spotted ? (
                    <div className="graph-scope">
                      <span>
                        <b>{nameOf(spotted)}</b> and its connections
                      </span>
                      {!stacks.has(spotted) && (
                        <>
                          <button type="button" onClick={() => update({ focus: spotted })}>
                            <Focus size={13} aria-hidden /> Show only this
                          </button>
                          {snapshot && (
                            <>
                              <button type="button" onClick={() => ask(spotted, 'under')}>
                                Who can change it
                              </button>
                              <button type="button" onClick={() => ask(spotted, 'over')}>
                                What it can change
                              </button>
                            </>
                          )}
                        </>
                      )}
                      <button type="button" aria-label="Clear highlight" onClick={() => light('')}>
                        <X size={13} aria-hidden />
                      </button>
                    </div>
                  ) : showChanges ? (
                    <div className="graph-scope">
                      <span>
                        <b>{plural(overlay.count, 'change')}</b>
                        {since ? ` since block ${since.blockNumber.toLocaleString()}` : ' since the previous inspection'}
                      </span>
                      <button type="button" aria-label="Hide changes" onClick={() => setChanges(false)}>
                        <X size={13} aria-hidden />
                      </button>
                    </div>
                  ) : null}
                  {empty && (
                    <div className="graph-empty">
                      <Text size="sm">{empty}</Text>
                      {snapshot && filtered && (
                        <Button size="compact-xs" variant="default" onClick={resetFilters}>
                          Reset filters
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="graph-key" role="group" aria-label="Kinds of contract on the map. Choose one to light it up.">
                {present.map((f) => (
                  <button
                    type="button"
                    className="legend-node"
                    key={f.id}
                    aria-pressed={family === f.id}
                    onClick={() => {
                      setSpot('')
                      setFamily(family === f.id ? '' : f.id)
                    }}
                  >
                    <i data-shape={f.shape} style={{ background: tones[f.id].bg, boxShadow: `inset 0 0 0 1px ${tones[f.id].ink}40` }} aria-hidden />
                    {f.label}
                    <b>{f.count}</b>
                  </button>
                ))}
              </div>
              <Group className="graph-zoom" gap={6}>
                <Tooltip
                  label={
                    scroll === 'zoom' ? 'Scrolling zooms the map. Click to make it move the map.' : 'Scrolling moves the map. Click to make it zoom.'
                  }
                >
                  <button
                    type="button"
                    className="graph-scroll"
                    aria-label={`Scrolling ${scroll === 'zoom' ? 'zooms' : 'moves'} the map. Switch to ${scroll === 'zoom' ? 'moving' : 'zooming'}.`}
                    onClick={() => {
                      const next = scroll === 'zoom' ? 'move' : 'zoom'
                      setScroll(next)
                      saveScrollMode(next)
                    }}
                  >
                    Scroll: {scroll}
                  </button>
                </Tooltip>
                <ActionIcon variant="default" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>
                  <Minus size={14} />
                </ActionIcon>
                <ZoomReadout graph={instance} />
                <ActionIcon variant="default" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
                  <Plus size={14} />
                </ActionIcon>
              </Group>
            </div>
            <div className="graph-legend">
              <p className="graph-tip">
                {arrange ? 'Drag a contract to place it' : 'Drag to move'} ·{' '}
                {scroll === 'zoom' ? 'scroll to zoom' : 'scroll to move, pinch or ⌘-scroll to zoom'} · click a contract to light up its connections,
                double-click to draw around it · ? for shortcuts
              </p>
              <div className="legend-lines">
                {(showChanges ? (['added', 'changed', 'removed'] as const) : (['set', 'missing', 'unknown'] as const)).map((state) => (
                  <span className="legend-key" data-state={state} key={state}>
                    <i aria-hidden />
                    {{ set: 'Set', missing: 'Missing', unknown: 'Unavailable', added: 'New', changed: 'Changed', removed: 'Gone' }[state]}
                  </span>
                ))}
                <Text size="xs" c="dimmed" ml="auto">
                  {plural(tally.addresses, 'address', 'addresses')}
                  {tally.stacks ? ` in ${plural(tally.nodes, 'node')}` : ''} · {tally.connections.toLocaleString()} of{' '}
                  {plural(tally.of, 'connection')}
                </Text>
              </div>
            </div>
            <VisuallyHidden role="status" aria-live="polite">
              {announcement}
            </VisuallyHidden>
          </div>
        </ResizableSidebar>
      </section>
    </FocusTrap>
  )
}
