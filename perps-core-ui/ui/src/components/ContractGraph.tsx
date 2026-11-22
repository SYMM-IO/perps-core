import { power, stackModel } from '../../../shared/graph-insight.js'
import { bundleEdges, EDGE_GROUPS, edgeKind, graphModel, isImplementation, LAYOUT, NODE, PORTRAIT_COLUMN, SYSTEM_LANES } from '../../../shared/graph-model.js'
import { changeView, filterView, findContracts, finishView, placeNodes, scopeKey, stacksOf } from '../../../shared/map-view.js'
import { FAMILIES, familyOf, familyTones, glyphFor, graphStyles, NODE_FONT, TEXT_WIDTH, type Family } from '../lib/graph-styles'
import { fitBox, fitLabel, fitNodeLabels, panToKeep, portraitRoutes, savedScrollMode, saveScrollMode, wheelReader, type ScrollMode } from '../lib/map-gesture'
import { short } from '../lib/state'
import type { PatchOptions } from '../lib/url'
import type { Connection, ContractNode, GraphFilters, Link, Profile, Snapshot } from '../types'
import { focusHeading, Inspector, LinkDetail } from './Inspector'
import { PowerDetail, StackDetail, type PowerResult, type StackNode } from './MapPanels'
import { ResizableSidebar } from './ResizableSidebar'
import {
  ActionIcon,
  Button,
  FocusTrap,
  Group,
  Modal,
  Popover,
  Stack,
  Select,
  Text,
  TextInput,
  Tooltip,
  useComputedColorScheme,
  VisuallyHidden,
  type ComboboxItem,
  type OptionsFilter,
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'
import {
  Check,
  CircleHelp,
  Expand,
  Focus,
  Info,
  LayoutGrid,
  Minimize,
  Minus,
  Move,
  Plus,
  Search,
  SlidersHorizontal,
  MoreHorizontal,
  X,
} from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

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
  onOpenSources?: (restoreFocus: () => void) => void
  sourcesOpened?: boolean
  /** Disables Prepare upgrade while another operation runs. */
  prepareDisabled?: boolean
  /** A new request moves keyboard focus from a workspace drill-down into its detail panel. */
  focusDetails?: number
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
const PORTRAIT_WIDTH = 600
const FIT_SIDE = 28
const COMPACT_LANE_PITCH = NODE.width + 36
const NUDGE = 10
const SEARCH_LABEL = 'Find contract, role or getter'
const NAME_FONT = `${NODE_FONT.weight} ${NODE_FONT.size}px ${NODE_FONT.family}`
const still = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const visible = (element: HTMLElement) => {
  for (let box: HTMLElement | null = element; box; box = box.parentElement) if (box.hidden || getComputedStyle(box).display === 'none') return false
  return true
}

const SHORTCUTS: { group: string; tasks: [string, ReactNode][] }[] = [
  {
    group: 'Move and zoom',
    tasks: [
      ['Move the map', 'Drag or use arrow keys. Scroll with “Scroll: move”.'],
      [
        'Move a contract',
        'Choose “Arrange contracts” in Tools. Drag a contract, or find it in search and press Enter to select it. Use the arrow keys to move it, Enter to finish, or Escape to cancel.',
      ],
      ['Zoom in or out', 'Pinch, ⌘-scroll, or +/−. Scroll at the pointer with “Scroll: zoom”.'],
      ['Fit to view', 'Press 0.'],
    ],
  },
  {
    group: 'Inspect',
    tasks: [
      ['Find a contract', 'With focus in the Map, press / to open search. Enter selects the best match.'],
      ['Inspect a contract and highlight its connections', 'Click or tap the contract.'],
      ['Open connection details', 'Click or tap the connection line.'],
      ['Focus the map on a contract', 'Double-click or double-tap the contract.'],
      ['Show grouped addresses separately', 'Double-click or double-tap the group.'],
    ],
  },
  {
    group: 'Back and help',
    tasks: [
      ['Step back on the map', <>Press Esc on the map, one step at a time.<br />Close connection details → dismiss “Who can change it” or “What it can change” → clear the highlight → exit fullscreen.</>],
      ['Open Gestures and shortcuts', 'With focus in the Map, press ?.'],
    ],
  },
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
  moreContrast: boolean,
  desktop: boolean,
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
      style: graphStyles(light, moreContrast, desktop),
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
      graph.stop(true)
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
    container.addEventListener('pointerdown', press, true)
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
      graph.stop(true)
      const action = read(e, live.current.scroll)
      if ('pan' in action) return void graph.panBy(action.pan)
      const box = container.getBoundingClientRect()
      graph.zoom({
        level: Math.min(ZOOM.max, Math.max(ZOOM.min, graph.zoom() * action.zoom)),
        renderedPosition: { x: e.clientX - box.left, y: e.clientY - box.top },
      })
    }
    wrap.addEventListener('wheel', wheel, { capture: true, passive: false })
    const renderer = (graph as Core & { renderer(): { render(): void } }).renderer()
    const observer = new ResizeObserver(() => {
      const size = { width: graph.width(), height: graph.height() }
      const next = { width: container.clientWidth, height: container.clientHeight }
      graph.resize()
      // The point at the canvas centre stays put as the inspector, the window or fullscreen resize it.
      if (size.width && size.height && next.width && next.height)
        graph.panBy({ x: (next.width - size.width) / 2, y: (next.height - size.height) / 2 })
      // Resize clears the canvas immediately. Paint the new frame before the browser presents it.
      if (window.innerWidth > 900 && next.width && next.height && graph.nodes().length) renderer.render()
    })
    observer.observe(container)
    return () => {
      wrap.removeEventListener('wheel', wheel, { capture: true })
      container.removeEventListener('mouseleave', leave)
      container.removeEventListener('pointerdown', press, true)
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
    cy.current?.style(graphStyles(light, moreContrast, desktop))
  }, [light, moreContrast, desktop])
  return { cy, instance }
}

// Classes the map sets from the model. Others ('faded', 'hover-edge') belong to the moment and are left alone.
const MODEL_CLASSES = ['lane', 'attention', 'stack', 'diff-added', 'diff-changed', 'diff-removed', 'quiet', 'portrait-route']
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
function MapContinuation({ graph }: { graph: Core | null }) {
  const [continues, setContinues] = useState(false)
  useEffect(() => {
    if (!graph) return
    let frame = 0
    const read = () => {
      frame = 0
      const right = graph.width()
      setContinues(right > 900 && graph.nodes('node:not(.lane)').toArray().some((node) => node.renderedPosition().x >= right))
    }
    const changed = () => (frame ||= requestAnimationFrame(read))
    const events = 'pan zoom resize add remove position'
    graph.on(events, changed)
    read()
    return () => {
      cancelAnimationFrame(frame)
      if (!graph.destroyed()) graph.off(events, changed)
    }
  }, [graph])
  if (!continues) return null
  return (
    <Text size="xs" c="dimmed">
      More contracts to the right. Drag the map or use Fit.
    </Text>
  )
}

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
  onOpenSources,
  sourcesOpened = false,
  prepareDisabled = false,
  focusDetails = 0,
  delta = NO_CHANGES,
  since,
}: Props) {
  const canvas = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLElement>(null),
    mapKeyBar = useRef<HTMLDivElement>(null),
    zoomControls = useRef<HTMLDivElement>(null),
    inspectorBody = useRef<HTMLDivElement>(null),
    searchBox = useRef<HTMLInputElement>(null),
    filterButton = useRef<HTMLButtonElement>(null),
    toolsButton = useRef<HTMLButtonElement>(null)
  const color = useComputedColorScheme('dark')
  const moreContrast = useMediaQuery('(prefers-contrast: more)')
  const desktop = useMediaQuery('(min-width: 1024px)')
  useEffect(() => {
    if (!focusDetails) return
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('.graph-inspector .inspector-heading')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [focusDetails])
  // One map for the whole visit: fullscreen is the same map pinned over the page, so nothing on it is lost.
  const [fullscreen, setFullscreen] = useState(false)
  const [portraitCapacity, setPortraitCapacity] = useState(0)
  const [mapWidth, setMapWidth] = useState(0)
  // The contract whose neighbours stay lit while the rest of the map steps back.
  const [spot, setSpot] = useState('')
  // Or a whole family of contracts, picked from the key under the map.
  const [family, setFamily] = useState<Family | ''>('')
  // Dragging moves the map wherever it starts, on a contract or between them. Arranging is a mode you turn on.
  const [arrange, setArrange] = useState(false)
  const [placement, setPlacement] = useState('')
  const placementTarget = useRef('')
  const [placementMessage, setPlacementMessage] = useState('')
  const originalPosition = useRef<Point | null>(null)
  const [inspectorContinues, setInspectorContinues] = useState(false)
  const [scroll, setScroll] = useState<ScrollMode>(savedScrollMode)
  // Addresses wired identically are drawn as one stack; `expanded` are the stacks opened by hand.
  const [stacking, setStacking] = useState(true)
  const [expanded, setExpanded] = useState<string[]>([])
  // Draws what changed since the previous inspection, with what has gone put back as a ghost.
  const [changes, setChanges] = useState(false)
  // The question being asked of one contract: what it can change, or who can change it.
  const [reach, setReach] = useState<{ id: string; direction: Direction } | null>(null)
  const [help, setHelp] = useState(false)
  const helpReturnFocus = useRef<HTMLElement | null>(null)
  const helpId = useId()
  const [filterPanel, setFilterPanel] = useState(false)
  const [tools, setTools] = useState(false)
  const [restoreToolsFocus, setRestoreToolsFocus] = useState(false)
  const [legend, setLegend] = useState(false)
  const filterId = useId()
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
  const nodeLabels = useMemo(() => {
    const { nodes } = graphModel(drawn, { mode: filters.mode })
    return fitNodeLabels(nodes, TEXT_WIDTH, NAME_FONT)
  }, [drawn, filters.mode])
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
    () => finishView(model, {
      plain,
      reached,
      showChanges,
      filters: { mode: filters.mode, focus: filters.focus },
      orientation: portraitCapacity ? 'portrait' : 'landscape',
      rowCapacity: portraitCapacity || 1,
    }),
    [model, plain, reached, showChanges, filters.mode, filters.focus, portraitCapacity],
  ) as { links: Link[]; lit: { nodes: Set<string>; links: Set<string> } | null; layout: any; positions: Record<string, Point>; tally: any }
  const compactLanes =
    mapWidth >= PORTRAIT_WIDTH && mapWidth <= 900 && !filters.focus && !implementation &&
    layout.sections.length > 1 && layout.sections.every((lane: { width: number }) => lane.width === LAYOUT.column) &&
    (NODE.width + 4 + (layout.sections.length - 1) * COMPACT_LANE_PITCH) * READABLE <= mapWidth - 2 * FIT_SIDE
  // Sparse maps can use the tablet width without shrinking the tiles or changing their lane order.
  const initialPositions = useMemo(() => {
    if (!compactLanes) return positions
    const left = layout.sections[0].x
    return Object.fromEntries(Object.entries(positions).map(([id, { x, y }]) => [
      id,
      { x: left + ((x - left) * COMPACT_LANE_PITCH) / (LAYOUT.column + LAYOUT.gap), y },
    ]))
  }, [compactLanes, layout, positions])
  // Drawn links follow the filters; the side panel always lists a contract's complete set.
  const allLinks = useMemo(() => bundleEdges(drawn.edges.map((edge: Connection) => ({ ...edge, kind: edgeKind(edge) }))) as Link[], [drawn.edges])
  const known = every.nodes as ContractNode[]
  const named = useMemo(() => {
    const knownIds = new Set(known.map((node) => node.id))
    return [...known, ...drawn.nodes.filter((node: ContractNode) => !knownIds.has(node.id)), ...stacks.values()] as ContractNode[]
  }, [known, drawn.nodes, stacks])
  const selectedNode = source.nodes.find((n) => n.id === selected) || known.find((n) => n.id === selected),
    // A link to or from a stack exists only as drawn; every other link is looked up in the complete set.
    selectedLink = allLinks.find((l) => l.id === link) || links.find((l) => l.id === link),
    stack = stacks.get(selected) as StackNode | undefined
  const nameOf = (id: string) => named.find((n) => n.id === id)?.name || source.nodes.find((n) => n.id === id)?.name || 'this contract'
  const update = (patch: Partial<GraphFilters>, options?: PatchOptions) => onFilters({ ...filters, ...patch }, options)
  const filterCount = filters.hide.length + Number(filters.missingOnly) + Number(!!filters.focus) + Number(implementation)
  const filtered = filterCount > 0
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
    requestAnimationFrame(() => toolsButton.current?.focus())
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
  const { cy, instance } = useCytoscape(canvas, handlers, live, color === 'light', moreContrast, desktop)
  const startPlacement = (id: string) => {
    placementTarget.current = id
    originalPosition.current = null
    setPlacement(id)
    setPlacementMessage('')
    requestAnimationFrame(() => canvas.current?.focus({ preventScroll: true }))
  }
  const finishArrangement = (cancel = false) => {
    const node = cy.current?.getElementById(placementTarget.current)
    if (cancel && node?.length && originalPosition.current) {
      node.position(originalPosition.current)
      node.emit('placement')
    }
    originalPosition.current = null
    placementTarget.current = ''
    setPlacement('')
    setArrange(false)
    setPlacementMessage(cancel ? 'Placement canceled.' : 'Arrangement finished.')
    requestAnimationFrame(() => toolsButton.current?.focus({ preventScroll: true }))
  }
  useLayoutEffect(() => {
    const container = canvas.current
    if (!container) return
    const measure = () => {
      const width = container.clientWidth
      if (!width) return
      setMapWidth(width >= PORTRAIT_WIDTH && width <= 900 ? width : 0)
      setPortraitCapacity(width >= PORTRAIT_WIDTH ? 0 : width - 2 * FIT_SIDE >= (NODE.width + PORTRAIT_COLUMN) * READABLE ? 2 : 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

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
    link: (id) => {
      if (id !== link) focusHeading()
      onLink(id)
    },
    // Tapping empty canvas steps back to the summary: the problems first, then the way back to the map.
    clear: () => {
      if (link) onLink('')
      light('')
      if (selected) onSelect('')
    },
    preview: (id) => highlight(id),
    rest,
  }

  /** Both Fit and selection use the same space left clear by the floating detail panel. */
  function availableRoom() {
    const graph = cy.current,
      canvasBox = canvas.current?.getBoundingClientRect(),
      detailBox = panel.current?.querySelector<HTMLElement>('.graph-inspector')?.getBoundingClientRect()
    const width = graph?.width() || 0,
      height = graph?.height() || 0
    return {
      width: detailBox?.width && canvasBox && window.innerWidth > 900 ? Math.max(120, Math.min(width, detailBox.left - canvasBox.left - 24)) : width,
      height:
        detailBox?.height && canvasBox && window.innerWidth <= 900
          ? Math.max(portraitCapacity ? 1 : 100, Math.min(height, detailBox.top - canvasBox.top - (portraitCapacity ? 8 : 24)))
          : height,
    }
  }

  function fitGeometry(graph: Core) {
    const wrap = canvas.current?.parentElement
    const top = wrap?.querySelector<HTMLElement>('.graph-top')?.offsetHeight || 0
    const bottom = Math.max(
      wrap?.querySelector<HTMLElement>('.graph-key')?.offsetHeight || 0,
      wrap?.querySelector<HTMLElement>('.graph-zoom')?.offsetHeight || 0,
    )
    const size = { width: graph.width(), height: graph.height() }
    const room = availableRoom()
    const insets = {
      top: top ? top + (portraitCapacity ? 20 : 24) : portraitCapacity ? 12 : 28,
      bottom: Math.max(bottom ? bottom + (portraitCapacity ? 20 : 24) : 28, size.height - room.height),
      left: FIT_SIDE,
      right: Math.max(FIT_SIDE, size.width - room.width),
    }
    return { size, insets }
  }

  /** Fits the map to the room left between the overlays on its edges. The first view of a scope stays readable. */
  function fit(readable = false) {
    const graph = cy.current
    if (!graph || !graph.nodes().length) return
    graph.stop(true)
    graph.resize()
    const { size, insets } = fitGeometry(graph)
    const tileNodes = graph.nodes().not('.lane').nodes(),
      tiles = tileNodes.toArray(),
      preferred = portraitCapacity ? [filters.focus, selected, graph.getElementById(link).data('source'), 'core'] : [filters.focus || selected || 'core'],
      anchor = preferred.map((id) => tiles.find((node) => node.id() === id)).find(Boolean) ?? (portraitCapacity ? tiles[0] : undefined),
      anchorBox = portraitCapacity ? anchor?.boundingBox() : undefined,
      neighbors = anchorBox && anchor ? anchor.connectedEdges().connectedNodes().not(anchor).map((node) => node.boundingBox()) : []
    const options = { min: readable || portraitCapacity ? READABLE : ZOOM.min, max: 1, anchor: anchor?.position(), anchorBox, neighbors }
    const bounds = (portraitCapacity ? graph.nodes() : graph.elements()).boundingBox()
    graph.viewport(fitBox(bounds, size, insets, options))
  }
  /** Zooms about the middle of the canvas, so what you are looking at stays where it is. */
  function zoomBy(factor: number, immediate = false) {
    const graph = cy.current
    if (!graph) return
    const target = {
      level: Math.min(ZOOM.max, Math.max(ZOOM.min, graph.zoom() * factor)),
      renderedPosition: { x: graph.width() / 2, y: graph.height() / 2 },
    }
    graph.stop(true)
    if (immediate || still()) graph.zoom(target)
    else graph.animate({ zoom: target, duration: 140, easing: 'ease-out' })
  }

  // The map is fitted when what it is drawn around changes, and laid out afresh when stacking is switched.
  // Otherwise every contract already drawn keeps its place, dragged or not, and the view holds still.
  const drawnScope = useRef<string | null>(null),
    drawnLayout = useRef<string | null>(null),
    drawnCompact = useRef(false),
    drawnMembers = useRef<Map<string, string>>(new Map()),
    rememberedPositions = useRef<Record<string, Point>>({}),
    rememberedHeadings = useRef<Record<string, Point>>({}),
    drawnFullscreen = useRef(false)
  useEffect(() => {
    const graph = cy.current
    if (!graph) return
    const scope = scopeKey(filters),
      layoutScope = portraitCapacity ? `${filters.mode}|${filters.focus}` : scope,
      arrangement = `${layoutScope}|${stacking}|${portraitCapacity}|${compactLanes}`,
      current = graph.nodes().not('.lane').nodes(),
      fresh = drawnLayout.current !== arrangement,
      refit = !current.length || drawnScope.current !== scope || drawnCompact.current !== compactLanes ||
        (portraitCapacity && (fresh || drawnFullscreen.current !== fullscreen))
    const previousPositions = Object.fromEntries(current.map((n) => [n.id(), { ...n.position() }])),
      previousHeadings = Object.fromEntries(graph.nodes('.lane').map((n) => [n.id(), { ...n.position() }]))
    if (fresh) {
      rememberedPositions.current = {}
      rememberedHeadings.current = {}
    } else if (portraitCapacity) {
      Object.assign(rememberedPositions.current, previousPositions)
      Object.assign(rememberedHeadings.current, previousHeadings)
    }
    const placed = placeNodes(
      model.nodes,
      initialPositions,
      fresh
        ? null
        : {
            positions: previousPositions,
            remembered: portraitCapacity ? rememberedPositions.current : undefined,
            memberOf: drawnMembers.current,
            reserved: Object.values(previousHeadings),
            portrait: !!portraitCapacity,
          },
    ) as Record<string, Point>
    const attention = new Set(links.filter((l) => l.missing).flatMap((l) => [l.from, l.to])),
      quiet = links.length > 28,
      degree = new Map<string, number>(),
      routes = portraitCapacity ? portraitRoutes(links, placed) : null
    for (const l of links) for (const id of [l.from, l.to]) degree.set(id, (degree.get(id) || 0) + 1)
    const elements: ElementDefinition[] = [
      ...layout.sections.map((s: any) => {
        const id = `lane:${s.name}`,
          was = graph.getElementById(id)
        return {
          group: 'nodes' as const,
          data: { id, label: s.label || s.name },
          position: !fresh && was.length ? { ...was.position() } : rememberedHeadings.current[id] ?? initialPositions[id],
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
          label: `${nodeLabels.get(n.id) ?? fitLabel(n.stack ? n.title : n.name, TEXT_WIDTH, NAME_FONT)}\n${n.stack ? fitLabel(n.summary, TEXT_WIDTH, NAME_FONT) : short(n.address)}`,
          kind: n.kind,
          glyph: glyphFor(n),
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
          count = l.count > 1 ? String(l.count) : '',
          route = routes?.get(l.id)
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
            ...(route || {}),
          },
          classes: [quiet && 'quiet', l.diff && `diff-${l.diff}`, route && 'portrait-route'].filter(Boolean).join(' '),
        }
      }),
    ]
    reconcile(graph, elements, live.current.arrange)
    drawnScope.current = scope
    drawnLayout.current = arrangement
    drawnCompact.current = compactLanes
    drawnMembers.current = memberOf
    drawnFullscreen.current = fullscreen
    if (refit) fit(true)
    rest()
  }, [model, links, layout, nodeLabels, portraitCapacity, compactLanes, initialPositions, fullscreen])
  useEffect(() => {
    if (!instance || !portraitCapacity) return
    const updateRoutes = () => {
      const tiles = Object.fromEntries(instance.nodes().not('.lane').nodes().map((n) => [n.id(), n.position()])),
        edges = instance.edges(),
        routes = portraitRoutes(edges.map((edge) => ({ id: edge.id(), from: edge.source().id(), to: edge.target().id() })), tiles)
      instance.batch(() => edges.forEach((edge) => {
        const route = routes.get(edge.id())
        if (route) edge.data(route)
        edge.toggleClass('portrait-route', !!route)
      }))
    }
    instance.on('dragfree placement', 'node', updateRoutes)
    return () => { instance.off('dragfree placement', 'node', updateRoutes) }
  }, [instance, portraitCapacity])
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
      const key = mapKeyBar.current
      if (key?.parentElement) {
        const footerHeight = key.parentElement.getBoundingClientRect().bottom - key.getBoundingClientRect().top
        section.style.setProperty('--graph-footer-height', `${Math.ceil(footerHeight)}px`)
      }
      const zoomHeight = zoomControls.current?.offsetHeight
      if (zoomHeight) section.style.setProperty('--graph-zoom-height', `${zoomHeight}px`)
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
    if (mapKeyBar.current) observer.observe(mapKeyBar.current)
    if (zoomControls.current) observer.observe(zoomControls.current)
    observer.observe(document.body)
    window.addEventListener('resize', size)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', size)
      section.style.removeProperty('--graph-fit')
      section.style.removeProperty('--graph-footer-height')
      section.style.removeProperty('--graph-zoom-height')
    }
  }, [fullscreen, legend, filterPanel])
  useLayoutEffect(() => {
    const details = inspectorBody.current
    const inspector = details?.closest<HTMLElement>('.graph-inspector')
    if (!details || !inspector) return
    const measure = () => setInspectorContinues(inspector.scrollHeight - inspector.scrollTop - inspector.clientHeight > 2)
    const observer = new ResizeObserver(measure)
    observer.observe(inspector)
    observer.observe(details)
    inspector.addEventListener('scroll', measure)
    measure()
    return () => {
      observer.disconnect()
      inspector.removeEventListener('scroll', measure)
    }
  }, [selectedLink?.id, selectedNode?.id, reach, stack?.id])
  useLayoutEffect(() => {
    if (!fullscreen || !panel.current) return
    const background: { element: HTMLElement; inert: boolean }[] = []
    // Only isolate app branches outside the graph. Dialogs portaled to body still need focus.
    const root = panel.current.closest('#root')
    for (let branch: HTMLElement | null = panel.current; root && branch?.parentElement && branch !== root; branch = branch.parentElement) {
      for (const element of branch.parentElement.children) {
        if (element !== branch && element instanceof HTMLElement) {
          background.push({ element, inert: element.inert })
          element.inert = true
        }
      }
    }
    const before = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      for (const { element, inert } of background) element.inert = inert
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
    const closed = (shown.current.selected || shown.current.link) && !selected && !link
    const moved = shown.current.selected !== selected || shown.current.link !== link,
      asked = !!centerOn.current && centerOn.current === selected
    shown.current = { selected, link }
    if (portraitCapacity && closed) return fit(true)
    if (!target.length || (!moved && !asked)) return
    centerOn.current = ''
    if (window.innerWidth > 900 && (target.isEdge() || asked || filters.focus) && !(placement && placement === selected)) {
      const neighbors = target.group() === 'nodes' ? target.neighborhood().nodes() : target.edges().connectedNodes()
      if (neighbors.length) {
        // Keep the selected contract and its visible connections together beside the inspector.
        graph.stop(true)
        const cluster = target.union(neighbors)
        const { size, insets } = fitGeometry(graph)
        const max = Math.max(READABLE, graph.zoom())
        const bounds = cluster.renderedBoundingBox()
        if (
          bounds.x1 >= insets.left &&
          bounds.y1 >= insets.top &&
          bounds.x2 <= size.width - insets.right &&
          bounds.y2 <= size.height - insets.bottom
        )
          return
        const targetBox = target.boundingBox()
        // Connection details keep the current scope in view whenever it fits at a readable zoom.
        const scopeView = target.isEdge() ? fitBox(graph.elements().boundingBox(), size, insets, { max }) : null
        const viewport = scopeView && scopeView.zoom >= READABLE ? scopeView : fitBox(cluster.boundingBox(), size, insets, {
          min: READABLE,
          max,
          anchor: { x: (targetBox.x1 + targetBox.x2) / 2, y: (targetBox.y1 + targetBox.y2) / 2 },
          anchorBox: targetBox,
          neighbors: neighbors.map((node) => node.boundingBox()),
        })
        if (still()) graph.viewport(viewport)
        else graph.animate(viewport, { duration: 220, easing: 'ease-out' })
        return
      }
    }
    const box = target.renderedBoundingBox(),
      { width, height } = availableRoom(),
      inside = box.x1 >= 0 && box.y1 >= 0 && box.x2 <= width && box.y2 <= height
    if (inside && (!asked || placement === selected)) return
    if (portraitCapacity) return fit(true)
    graph.stop(true)
    const position = target.boundingBox(),
      pan = { x: width / 2 - ((position.x1 + position.x2) / 2) * graph.zoom(), y: height / 2 - ((position.y1 + position.y2) / 2) * graph.zoom() }
    if (placement === selected || still()) graph.pan(pan)
    else graph.animate({ pan, duration: 220, easing: 'ease-out' })
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
    const timer = window.setTimeout(() => {
      // Enter may already have committed this query and selected a contract.
      if (query !== sent.current) send(query)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [query])
  const clearSearch = () => {
    setQuery('')
    send('')
  }
  const resetFilters = () => {
    update({ mode: 'all', focus: '', hide: [], missingOnly: false }, { replace: true })
  }
  // The contracts a search can select. Within one contract's neighbourhood, the ones drawn come first.
  const contracts = source.nodes.filter((n) => implementation || !isImplementation(n.kind)),
    candidates = [...contracts, ...known.filter((n) => !contracts.some((c) => c.id === n.id))]
  const findBest = (text: string) => {
    const matches = findContracts(candidates, text) as ContractNode[]
    return (filters.focus && matches.find((n) => drawnIds.has(n.id) || memberOf.has(n.id))) || matches[0]
  }

  // Single-character shortcuts belong to the focused map, including when it is fullscreen.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || !['/', '?'].includes(e.key)) return
      if (help || sourcesOpened || !panel.current?.contains(document.activeElement)) return
      const target = e.target as HTMLElement | null
      if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="combobox"]')) return
      e.preventDefault()
      if (e.key === '/') {
        searchBox.current?.focus()
      } else {
        helpReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setRestoreToolsFocus(fullscreen && helpReturnFocus.current === toolsButton.current)
        setHelp(true)
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [fullscreen, help, sourcesOpened])

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
  const tones = familyTones(color === 'light', desktop),
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
  const scopeText = [implementation ? 'Facets & libraries' : '', filters.focus ? `Around ${nameOf(filters.focus)}` : '']
    .filter(Boolean)
    .join(' · ')
  // Said to a screen reader whenever what is drawn changes: scope, filters, question, changes or selection.
  const announcement = [
    scopeText || 'Whole system',
    plural(tally.nodes, 'node'),
    `${tally.connections.toLocaleString()} of ${plural(tally.of, 'connection')}`,
    tally.issues ? plural(tally.issues, 'issue') : '',
    question,
    showChanges ? `${plural(overlay.count, 'change')} marked` : '',
    selectedLink ? `Selected ${nameOf(selectedLink.from)} to ${nameOf(selectedLink.to)}` : selectedNode ? `Selected ${selectedNode.name}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const searchText = filters.query.trim()
  const noQueryMatches = !links.length && !!searchText && !findContracts(candidates, searchText).length &&
    !(['all', 'implementation'] as const).some((mode) => graphModel(drawn, { mode, query: searchText }).nodes.length)
  const empty = !links.length
    ? !snapshot
      ? 'Inspect the deployment to verify its wiring.'
      : noQueryMatches
        ? `No matches for ‘${searchText}’.`
        : model.nodes.length
          ? 'No connections match these filters.'
          : 'Nothing matches these filters.'
    : ''
  const spotted = !reached && !filters.focus && spot && drawnIds.has(spot) ? spot : ''

  return (
    <FocusTrap active={fullscreen && !sourcesOpened && !help} innerRef={panel}>
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
          <TextInput
            ref={searchBox}
            label={SEARCH_LABEL}
            placeholder={SEARCH_LABEL}
            aria-label={SEARCH_LABEL}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            leftSection={<Search size={14} />}
            rightSection={
              query && (
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label="Clear search"
                  onClick={clearSearch}
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
              if (arrange) startPlacement(best.id)
            }}
            className="graph-query"
          />
          <Button
            ref={filterButton}
            variant="default"
            className="inventory-filters-toggle"
            leftSection={<SlidersHorizontal size={15} aria-hidden />}
            aria-expanded={filterPanel}
            aria-controls={filterId}
            onClick={() => setFilterPanel(!filterPanel)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && filterPanel) {
                event.preventDefault()
                setFilterPanel(false)
              }
            }}
          >
            Filters{filterCount ? ` · ${filterCount}` : ''}
          </Button>
          {filtered && (
            <Button variant="default" className="map-clear-filters" onClick={resetFilters}>
              Clear filters
            </Button>
          )}
          <div className="map-toolbar-actions">
            <Tooltip label="Fit to view (0)">
              <Button variant="default" aria-label="Fit to view" onClick={() => fit()}>
                Fit
              </Button>
            </Tooltip>
            <Popover opened={tools} onChange={setTools} position="bottom-end" width="min(240px, calc(100vw - 24px))" transitionProps={{ exitDuration: 0 }}>
              <Popover.Target>
                <Button
                  ref={toolsButton}
                  data-autofocus={restoreToolsFocus || undefined}
                  variant="default"
                  leftSection={<MoreHorizontal size={16} aria-hidden />}
                  onClick={() => setTools(!tools)}
                >
                  Tools
                </Button>
              </Popover.Target>
              <Popover.Dropdown className="map-tools-menu">
                <Stack gap={4}>
                  <Button
                    variant="subtle"
                    color="gray"
                    leftSection={<Move size={15} />}
                    aria-pressed={arrange}
                    onClick={() => {
                      setTools(false)
                      if (arrange) finishArrangement()
                      else {
                        setArrange(true)
                        setPlacementMessage('')
                        requestAnimationFrame(() => searchBox.current?.focus({ preventScroll: true }))
                      }
                    }}
                  >
                    {arrange ? 'Stop arranging' : 'Arrange contracts'}
                  </Button>
                  <Button
                    variant="subtle"
                    color="gray"
                    leftSection={<LayoutGrid size={15} />}
                    onClick={() => {
                      originalPosition.current = null
                      cy.current?.nodes().positions((n) => initialPositions[n.id()] || n.position())
                      fit()
                      setTools(false)
                    }}
                  >
                    Reset layout
                  </Button>
                  <Button
                    variant="subtle"
                    color="gray"
                    leftSection={<Info size={15} />}
                    onClick={() => {
                      setRestoreToolsFocus(fullscreen)
                      setTools(false)
                      onOpenSources?.(() => toolsButton.current?.focus({ preventScroll: true }))
                    }}
                  >
                    Inspection sources
                  </Button>
                  <Button
                    variant="subtle"
                    color="gray"
                    leftSection={<CircleHelp size={15} />}
                    onClick={() => {
                      helpReturnFocus.current = toolsButton.current
                      setRestoreToolsFocus(fullscreen)
                      setHelp(true)
                      setTools(false)
                    }}
                  >
                    Gestures and shortcuts
                  </Button>
                  {!fullscreen && (
                    <Button
                      variant="subtle"
                      color="gray"
                      leftSection={<Expand size={15} aria-hidden />}
                      onClick={() => {
                        setRestoreToolsFocus(false)
                        setFullscreen(true)
                        setTools(false)
                      }}
                    >
                      Fullscreen
                    </Button>
                  )}
                </Stack>
              </Popover.Dropdown>
            </Popover>
            {fullscreen && (
              <Button variant="default" leftSection={<Minimize size={15} aria-hidden />} onClick={close} data-fullscreen-toggle>
                Exit fullscreen
              </Button>
            )}
          </div>
        </div>
        {filterPanel && (
          <div
            id={filterId}
            className="graph-filter-panel"
            role="region"
            aria-label="Map filters"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !(event.target as HTMLElement).closest('[aria-expanded="true"]')) {
                event.preventDefault()
                event.stopPropagation()
                setFilterPanel(false)
                filterButton.current?.focus()
              }
            }}
          >
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
                  if (arrange) startPlacement(value)
                }}
                className="graph-focus"
              />
            )}
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
              <div className="graph-view-filters" role="group" aria-label="Map display">
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
              </div>
            </div>
          </div>
        )}
        <Modal
          opened={help}
          onClose={() => setHelp(false)}
          onExitTransitionEnd={() => {
            const opener = helpReturnFocus.current
            const target = opener && opener !== document.body && opener.isConnected && visible(opener) ? opener : toolsButton.current
            target?.focus({ preventScroll: true })
          }}
          returnFocus={false}
          title="Gestures and shortcuts"
          size="md"
          classNames={{ body: 'map-help-body' }}
        >
          {SHORTCUTS.map(({ group, tasks }, i) => (
            <section key={group} aria-labelledby={`${helpId}-${i}`}>
              <Text id={`${helpId}-${i}`} size="xs" c="dimmed" mb={4}>
                {group}
              </Text>
              <dl className="map-help">
                {tasks.map(([task, binding]) => (
                  <div key={task}>
                    <dt>{task}</dt>
                    <dd>{binding}</dd>
                  </div>
                ))}
              </dl>
              {i === 0 && <Text className="map-help-note" size="xs" c="dimmed">Arrow keys, +/− and 0 require focus on the map canvas.</Text>}
            </section>
          ))}
        </Modal>
        <ResizableSidebar
          storageKey="workbench:inspector-width"
          label="contract inspector"
          sidebar={
            selectedLink || reached || stack || selectedNode ? (
              <>
                <div className="inspector-close">
                  {inspectorContinues && <Text size="xs" c="dimmed" className="inspector-scroll-hint">Scroll for more <span aria-hidden>↓</span></Text>}
                  <ActionIcon
                    size={30}
                    aria-label="Close details"
                    variant="subtle"
                    color="gray"
                    onClick={() => {
                      onLink('')
                      onSelect('')
                      setReach(null)
                      light('')
                      canvas.current?.focus()
                    }}
                  >
                    <X size={16} aria-hidden />
                  </ActionIcon>
                </div>
                <div ref={inspectorBody}>
                  {selectedLink ? (
                    <LinkDetail
                      link={selectedLink}
                      nodes={named}
                      block={snapshot?.blockNumber}
                      back={selectedNode?.name}
                      backId={selectedNode?.id}
                      explorer={profile.explorer}
                      onSelect={pick}
                      onClose={() => {
                        onLink('')
                        if (!selectedNode) canvas.current?.focus({ preventScroll: true })
                      }}
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
                  ) : selectedNode ? (
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
                  ) : null}
                </div>
              </>
            ) : null
          }
        >
          <div className="graph-main">
            <div className="graph-canvas-wrap">
              <div
                className="graph-canvas"
                ref={canvas}
                tabIndex={0}
                role="group"
                aria-describedby={arrange ? `${helpId}-placement` : undefined}
                aria-label="Interactive contract graph. Open Filters to choose the whole system or one contract; a contract's connections are listed in the inspector. Arrow keys move the map, plus and minus zoom, zero fits, slash finds a contract, question mark lists the shortcuts, Escape closes the open line, then the highlight."
                onKeyDown={(e) => {
                  const graph = cy.current
                  if (!graph) return
                  const node = graph.getElementById(placementTarget.current)
                  if (arrange && node.length && (e.key === 'Enter' || e.key === 'Escape')) {
                    e.preventDefault()
                    finishArrangement(e.key === 'Escape')
                    return
                  }
                  if (!['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
                  e.preventDefault()
                  if (e.key === '0') fit()
                  else if (['+', '=', '-'].includes(e.key)) zoomBy(e.key === '-' ? 0.8 : 1.25, true)
                  else {
                    graph.stop(true)
                    const x = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
                    const y = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
                    if (arrange && node.length) {
                      const position = node.position()
                      originalPosition.current ??= { ...position }
                      node.position({ x: position.x + x * NUDGE, y: position.y + y * NUDGE })
                      node.emit('placement')
                    } else graph.panBy({ x: x * -80, y: y * -80 })
                  }
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
                      {snapshot && searchText ? (
                        <Button
                          size="compact-xs"
                          variant="default"
                          onClick={() => {
                            clearSearch()
                            searchBox.current?.focus()
                          }}
                        >
                          Clear search
                        </Button>
                      ) : snapshot && filtered ? (
                        <Button size="compact-xs" variant="default" onClick={resetFilters}>
                          Reset filters
                        </Button>
                      ) : null}
                    </div>
                  )}
                </div>
              )}
              <Group className="graph-zoom" gap={6} ref={zoomControls}>
                <Tooltip
                  label={
                    scroll === 'zoom' ? 'Scrolling zooms the map. Click to make it move the map.' : 'Scrolling moves the map. Click to make it zoom.'
                  }
                  events={{ hover: true, focus: true, touch: false }}
                >
                  <button
                    type="button"
                    className="graph-scroll"
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
            <div className="map-key-bar" ref={mapKeyBar}>
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                aria-expanded={legend}
                onClick={() => {
                  setLegend(!legend)
                  if (legend) setFamily('')
                }}
              >
                {legend ? 'Hide map key' : 'Map key'}
              </Button>
              {scopeText && (
                <Text size="xs" c="dimmed">
                  {scopeText}
                </Text>
              )}
              <MapContinuation graph={instance} />
              {arrange && (
                <div className="map-placement">
                  <Text id={`${helpId}-placement`} size="xs" role="status">
                    {drawnIds.has(placement)
                      ? `Moving ${nameOf(placement)}. Use the arrow keys, Enter to finish, or Escape to cancel.`
                      : 'Drag a contract, or select one using Find contract, role or getter.'}
                  </Text>
                  <Button size="compact-sm" variant="default" onClick={() => finishArrangement()}>
                    Finish arranging
                  </Button>
                  {drawnIds.has(placement) && (
                    <Button size="compact-sm" variant="subtle" color="gray" onClick={() => finishArrangement(true)}>
                      Cancel placement
                    </Button>
                  )}
                </div>
              )}
            </div>
            {legend && (
              <div className="graph-legend">
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
                <p className="graph-tip">
                  {arrange ? 'Drag a contract to move it' : 'Drag to move the map'} ·{' '}
                  {scroll === 'zoom' ? 'Scroll to zoom' : 'Scroll to move'} · Click a contract to inspect it. Double-click to focus the map. · ? for shortcuts
                </p>
                <div className="legend-lines">
                  {(showChanges ? (['added', 'changed', 'removed'] as const) : (['set', 'missing', 'unknown'] as const)).map((state) => (
                    <span className="legend-key" data-state={state} key={state}>
                      <i aria-hidden />
                      {{ set: 'Set', missing: 'Missing', unknown: 'Unavailable', added: 'New', changed: 'Changed', removed: 'Gone' }[state]}
                    </span>
                  ))}
                  {tally.stacks > 0 && (
                    <span className="legend-key" data-state="stack" title="Several identically wired addresses drawn as one node">
                      <i aria-hidden />
                      Stack
                    </span>
                  )}
                  <Text size="xs" c="dimmed" ml="auto">
                    {plural(tally.addresses, 'address', 'addresses')}
                    {tally.stacks ? ` in ${plural(tally.nodes, 'node')}` : ''} · {tally.connections.toLocaleString()} of{' '}
                    {plural(tally.of, 'connection')}
                  </Text>
                </div>
              </div>
            )}
            <VisuallyHidden role="status" aria-live="polite">
              {announcement}
            </VisuallyHidden>
            <VisuallyHidden role="status">{placementMessage}</VisuallyHidden>
          </div>
        </ResizableSidebar>
      </section>
    </FocusTrap>
  )
}
