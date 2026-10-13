import { changeOverlay, power, stackModel, withChanges } from '../../../shared/graph-insight.js'
import { bundleEdges, EDGE_GROUPS, graphModel, semanticLayout, isImplementation, SYSTEM_LANES } from '../../../shared/graph-model.js'
import { FAMILIES, familyOf, familyTones, graphStyles, NODE, NODE_FONT, TEXT_WIDTH, type Family } from '../lib/graph-styles'
import { fitText, panToKeep, savedScrollMode, saveScrollMode, wheelReader, type ScrollMode } from '../lib/map-gesture'
import { short } from '../lib/state'
import type { ContractNode, GraphFilters, Link, Profile, Snapshot } from '../types'
import { Inspector, LinkDetail } from './Inspector'
import { PowerDetail, StackDetail, type PowerResult, type StackNode } from './MapPanels'
import { ResizableSidebar } from './ResizableSidebar'
import {
  ActionIcon,
  Button,
  Group,
  Modal,
  Popover,
  Select,
  Text,
  TextInput,
  Tooltip,
  useComputedColorScheme,
  type ComboboxItem,
  type OptionsFilter,
} from '@mantine/core'
import cytoscape, { type Core } from 'cytoscape'
import { Check, Expand, Focus, Info, LayoutGrid, Minimize, Minus, Move, Plus, Scan, Search, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

interface Props {
  snapshot?: Snapshot
  profile: Profile
  selected: string
  link: string
  filters: GraphFilters
  onFilters: (next: GraphFilters) => void
  onSelect: (id: string) => void
  onLink: (id: string) => void
  onPrepare: (node: ContractNode) => void
  /** What changed between the previous inspection and this one, and which inspection that was. */
  delta?: any[]
  since?: { blockNumber: number; at?: string } | null
}
type Direction = 'over' | 'under'
const NO_CHANGES: any[] = []
type Point = { x: number; y: number }
const ZOOM = { min: 0.05, max: 2.5 }
const NAME_FONT = `${NODE_FONT.weight} ${NODE_FONT.size}px ${NODE_FONT.family}`
const still = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function ContractGraph(props: Props) {
  const [fullscreen, setFullscreen] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  const close = () => {
    setFullscreen(false)
    requestAnimationFrame(() => host.current?.querySelector<HTMLButtonElement>('[data-fullscreen-toggle]')?.focus())
  }
  const content = (
    <GraphSurface
      {...props}
      fullscreen={fullscreen}
      onFullscreen={() => (fullscreen ? close() : setFullscreen(true))}
      onPrepare={(node) => {
        setFullscreen(false)
        props.onPrepare(node)
      }}
    />
  )
  return (
    <div ref={host}>
      <Modal
        opened={fullscreen}
        onClose={close}
        returnFocus={false}
        fullScreen
        title="Contract wiring"
        transitionProps={{ duration: 0 }}
        styles={{ body: { padding: 0 }, header: { minHeight: 48 } }}
      >
        {fullscreen && content}
      </Modal>
      {!fullscreen && content}
    </div>
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
function GraphSurface({
  snapshot,
  profile,
  selected,
  link,
  filters,
  onFilters,
  onSelect,
  onLink,
  onPrepare,
  delta = NO_CHANGES,
  since,
  fullscreen,
  onFullscreen,
}: Props & { fullscreen: boolean; onFullscreen: () => void }) {
  const canvas = useRef<HTMLDivElement>(null),
    cy = useRef<Core | null>(null),
    handlers = useRef({ onSelect, onLink, focus: (_id: string) => {}, spot: (_id: string) => {}, pick: (_id: string) => {} })
  const color = useComputedColorScheme('dark')
  const [zoom, setZoom] = useState(100)
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
  const panel = useRef<HTMLElement>(null)
  const implementation = filters.mode === 'implementation'
  const source = useMemo(() => snapshot || { nodes: profile.nodes, edges: [] }, [snapshot, profile.nodes])
  const overlay = useMemo(() => changeOverlay(source, delta), [source, delta])
  const showChanges = changes && overlay.count > 0
  const drawn = useMemo(() => (showChanges ? withChanges(source, overlay) : source), [source, overlay, showChanges])
  const hidden = filters.hide.join()
  const plain = useMemo(() => graphModel(drawn, filters), [drawn, filters.mode, filters.focus, filters.query, filters.missingOnly, hidden])
  // Whatever is being looked at stays its own node, never folded into a stack.
  const kept = [selected, filters.focus, reach?.id].filter(Boolean).join()
  const stackable = useMemo(() => stackModel(plain, { keep: kept.split(',').filter(Boolean) }), [plain, kept])
  const model = useMemo(
    () =>
      !stacking
        ? { ...plain, stacks: new Map<string, StackNode>(), memberOf: new Map<string, string>() }
        : expanded.length
          ? stackModel(plain, { keep: kept.split(',').filter(Boolean), expanded })
          : stackable,
    [plain, stackable, stacking, expanded, kept],
  )
  // Drawn links follow the filters; the side panel always lists a contract's complete set.
  const links = useMemo(() => bundleEdges(model.edges) as Link[], [model])
  const every = useMemo(() => graphModel(drawn, { mode: implementation ? 'implementation' : 'all' }), [drawn, implementation])
  const allLinks = useMemo(() => bundleEdges(every.edges) as Link[], [every])
  const known = every.nodes as ContractNode[]
  const named = useMemo(() => [...known, ...model.stacks.values()] as ContractNode[], [known, model])
  const reached = useMemo(() => (reach ? (power(source, reach.id, reach.direction) as PowerResult) : null), [source, reach])
  // What a question or the change view lights up, in the ids the map is drawn with.
  const lit = useMemo(() => {
    const at = (id: string) => model.memberOf.get(id) ?? id
    if (reached)
      return {
        nodes: new Set([...reached.nodes].map(at)),
        links: new Set([...reached.links].map((id) => id.split('>').map(at).join('>'))),
      }
    if (!showChanges) return null
    const marked = links.filter((l) => l.diff)
    return {
      nodes: new Set([
        ...model.nodes.filter((n: any) => n.diff || n.removed).map((n: any) => n.id as string),
        ...marked.flatMap((l) => [l.from, l.to]),
      ]),
      links: new Set(marked.map((l) => l.id)),
    }
  }, [reached, showChanges, model, links])
  // The canvas's handlers are bound once, so they read the current choices from here.
  const live = useRef({ spot, family, arrange, scroll, lit, asking: !!reach })
  live.current = { spot, family, arrange, scroll, lit, asking: !!reach }
  const compact = !!filters.focus
  const layout = useMemo(() => semanticLayout(model.nodes, { implementation, compact }), [model.nodes, implementation, compact])
  const positions = useMemo(() => {
    const placed = layout.positions as Record<string, Point>,
      top = Math.min(0, ...Object.values(placed).map((p) => p.y)) - NODE.height / 2 - 26
    return { ...placed, ...Object.fromEntries(layout.sections.map((s: any) => [`lane:${s.name}`, { x: s.x, y: top }])) } as Record<string, Point>
  }, [layout])
  const selectedNode = source.nodes.find((n) => n.id === selected) || known.find((n) => n.id === selected),
    // A link to or from a stack exists only as drawn; every other link is looked up in the complete set.
    selectedLink = allLinks.find((l) => l.id === link) || links.find((l) => l.id === link),
    stack = model.stacks.get(selected) as StackNode | undefined
  const nameOf = (id: string) => named.find((n) => n.id === id)?.name || source.nodes.find((n) => n.id === id)?.name || 'this contract'
  const update = (patch: Partial<GraphFilters>) => onFilters({ ...filters, ...patch })
  const filtered = filters.hide.length > 0 || !!filters.query || filters.missingOnly
  // Lighting one contract and lighting a family are the same spotlight, so choosing either drops the other.
  const light = (id: string) => {
    setSpot(id)
    setFamily('')
  }
  /** Asks what a contract can change or who can change it, on the whole system where the answer can be seen. */
  const ask = (id: string, direction: Direction) => {
    setReach({ id, direction })
    light('')
    if (filters.focus || implementation) update({ focus: '', ...(implementation ? { mode: 'all', hide: [] } : {}) })
  }
  handlers.current = {
    onSelect,
    onLink,
    // Double-clicking a stack opens it; double-clicking a contract redraws the map around it.
    focus: (id) => (model.stacks.has(id) ? setExpanded([...expanded, id]) : update({ focus: id })),
    spot: light,
    // Choosing a contract ends a question about another one.
    pick: (id) => {
      setReach(null)
      onSelect(id)
      light(id)
    },
  }
  function fit() {
    const graph = cy.current
    if (!graph || !graph.nodes().length) return
    graph.stop()
    graph.resize()
    graph.fit(undefined, 28)
    // A small neighborhood should not be blown up past its natural size.
    if (graph.zoom() > 1) {
      graph.zoom(1)
      graph.center()
    }
    // On a phone-width canvas a full fit is too small to read, so open on the focused contract instead.
    if (canvas.current!.clientWidth < 600 && graph.zoom() < 0.5) {
      const anchor = graph.getElementById(filters.focus || selected)
      graph.zoom(0.5)
      graph.center(anchor.length ? anchor : undefined)
    }
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
  /** Lights one contract and what it touches, or every contract of one family; everything else steps back. */
  function highlight(id: string, group: Family | '' = '') {
    const graph = cy.current
    if (!graph) return
    graph.elements().removeClass('faded')
    const node = id ? graph.getElementById(id) : undefined
    if (node?.length) return void graph.elements().not(node.closedNeighborhood()).not('.lane').addClass('faded')
    // An answer to "who can change what", or the change view: light exactly those contracts and lines.
    const answer = live.current.lit
    if (answer)
      return void graph
        .elements()
        .filter((el) => !(el.isNode() ? answer.nodes.has(el.id()) : answer.links.has(el.id())))
        .not('.lane')
        .addClass('faded')
    if (!group) return
    const lit = graph.nodes().filter((n) => !n.hasClass('lane') && familyOf(n.data('kind')) === group)
    if (lit.length) graph.elements().not(lit).not(lit.connectedEdges()).not('.lane').addClass('faded')
  }
  useEffect(() => {
    if (!canvas.current) return
    const container = canvas.current
    const graph = cytoscape({
      container,
      elements: [],
      style: graphStyles(color === 'light'),
      layout: { name: 'preset' },
      minZoom: ZOOM.min,
      maxZoom: ZOOM.max,
      boxSelectionEnabled: false,
      selectionType: 'single',
    })
    cy.current = graph
    graph.on('tap', 'node', (e) => handlers.current.pick(e.target.id()))
    graph.on('dbltap', 'node', (e) => handlers.current.focus(e.target.id()))
    graph.on('tap', 'edge', (e) => handlers.current.onLink(e.target.id()))
    graph.on('tap', (e) => {
      if (e.target !== graph) return
      handlers.current.onLink('')
      handlers.current.spot('')
    })
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
    const rest = () => highlight(live.current.asking ? '' : live.current.spot, live.current.family)
    graph.on('mouseover', 'node', (e) => {
      if (e.target.hasClass('lane')) return
      point(live.current.arrange ? 'move' : 'pointer')
      const id = e.target.id()
      window.clearTimeout(hover)
      hover = window.setTimeout(() => !pressed && highlight(id), 140)
    })
    graph.on('mouseout', 'node', () => {
      point('')
      window.clearTimeout(hover)
      if (!pressed) rest()
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
      if (!pressed) rest()
    }
    container.addEventListener('mouseleave', leave)
    container.addEventListener('pointerdown', press)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    graph.on('zoom', () => setZoom(Math.round(graph.zoom() * 100)))
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
      if (!canvas.current) return
      const next = { width: canvas.current.clientWidth, height: canvas.current.clientHeight }
      graph.resize()
      // Preserve the point at the canvas center as the inspector and viewport resize.
      if (size.width && size.height && next.width && next.height) {
        graph.panBy({ x: (next.width - size.width) / 2, y: (next.height - size.height) / 2 })
      }
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
    }
  }, [])
  useEffect(() => {
    const graph = cy.current
    if (!graph) return
    const attention = new Set(links.filter((l) => l.missing).flatMap((l) => [l.from, l.to])),
      quiet = links.length > 28,
      degree = new Map<string, number>()
    for (const l of links) for (const id of [l.from, l.to]) degree.set(id, (degree.get(id) || 0) + 1)
    // Showing or hiding a kind of connection keeps the same contracts, so the view should not jump.
    const before = graph
        .nodes()
        .not('.lane')
        .map((n) => n.id())
        .sort()
        .join(),
      after = model.nodes
        .map((n: any) => n.id)
        .sort()
        .join(),
      view = before && before === after ? { zoom: graph.zoom(), pan: { ...graph.pan() } } : null,
      dragged = view ? Object.fromEntries(graph.nodes().map((n) => [n.id(), { ...n.position() }])) : {}
    graph.batch(() => {
      graph.elements().remove()
      graph.add([
        ...layout.sections.map((s: any) => ({
          data: { id: `lane:${s.name}`, label: s.name },
          position: positions[`lane:${s.name}`],
          classes: 'lane',
          selectable: false,
          grabbable: false,
        })),
        ...model.nodes.map((n: any) => ({
          data: {
            id: n.id,
            // A stack has no address of its own; its second line says what each of its members has.
            label: `${fitText(n.stack ? n.title : n.name, TEXT_WIDTH, NAME_FONT)}\n${n.stack ? fitText(n.summary, TEXT_WIDTH, NAME_FONT) : short(n.address)}`,
            kind: n.kind,
            ...(n.stack ? { count: n.members.length } : {}),
          },
          position: dragged[n.id] || positions[n.id],
          classes: [attention.has(n.id) && 'attention', n.stack && 'stack', n.diff && `diff-${n.diff}`, n.removed && 'diff-removed']
            .filter(Boolean)
            .join(' '),
          // A press on a contract drags the map like a press anywhere else, unless contracts are being arranged.
          grabbable: live.current.arrange,
          pannable: !live.current.arrange,
        })),
        ...links.map((l) => {
          // The count sits at the less connected end, away from the hub where every line converges.
          const atSource = degree.get(l.from)! <= degree.get(l.to)!,
            count = l.count > 1 ? String(l.count) : ''
          return {
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
      ])
    })
    if (view) graph.viewport(view)
    else fit()
    rest()
  }, [model, links, layout, positions])
  useEffect(() => {
    cy.current?.style(graphStyles(color === 'light'))
  }, [color])
  const rest = () => highlight(reach ? '' : spot, family)
  useEffect(rest, [spot, family, lit, reach])
  useEffect(() => {
    const nodes = cy.current?.nodes().not('.lane')
    if (!nodes) return
    if (arrange) nodes.unpanify().grabify()
    else nodes.ungrabify().panify()
  }, [arrange])
  // The canvas takes exactly the room left under the toolbar, so the page itself never needs to scroll
  // and a scroll over the map can only ever mean the map.
  useLayoutEffect(() => {
    const section = panel.current,
      wrap = canvas.current?.parentElement
    if (!section || !wrap || fullscreen) return
    const size = () => {
      // Everything that sits under the canvas: the bar below it, then each enclosing box's own padding and margin.
      let below = section.getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom
      for (let box: HTMLElement | null = section; box && box !== document.documentElement; box = box.parentElement) {
        const style = getComputedStyle(box)
        below += parseFloat(style.marginBottom) + (box === section ? 0 : parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth))
        for (let next = box.nextElementSibling as HTMLElement | null; next; next = next.nextElementSibling as HTMLElement | null)
          if (!['fixed', 'absolute'].includes(getComputedStyle(next).position)) below += next.offsetHeight || 0
      }
      const top = wrap.getBoundingClientRect().top + window.scrollY
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
  useEffect(() => {
    const graph = cy.current
    if (!graph) return
    graph.elements().unselect()
    const target = graph.getElementById(link && graph.getElementById(link).length ? link : selected)
    target.select()
    // Choosing a contract or connection in the side panel brings it into view when it is off the canvas.
    if (!target.length) return
    const box = target.renderedBoundingBox(),
      inside = box.x1 >= 0 && box.y1 >= 0 && box.x2 <= graph.width() && box.y2 <= graph.height()
    if (inside) return
    graph.stop()
    if (still()) graph.center(target)
    else graph.animate({ center: { eles: target }, duration: 220, easing: 'ease-out' })
  }, [selected, link, links])
  // The contract picker lists contracts under the same headings the map draws them in.
  const contracts = source.nodes.filter((n) => implementation || !isImplementation(n.kind)),
    addressOf = new Map(contracts.map((n) => [n.id, n.address])),
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
  const total = links.reduce((sum, l) => sum + l.count, 0)
  const reachedCount = reached ? new Set(reached.entries.map((e) => e.node)).size : 0
  // The key under the map lists only the families drawn now, each in the tone its contracts have.
  const tones = familyTones(color === 'light'),
    sizeOf = (n: any) => (n.stack ? n.members.length : 1),
    addresses = model.nodes.reduce((sum: number, n: any) => sum + sizeOf(n), 0),
    present = FAMILIES.map((f) => ({
      ...f,
      count: model.nodes.filter((n: any) => familyOf(n.kind) === f.id).reduce((sum: number, n: any) => sum + sizeOf(n), 0),
    })).filter((f) => f.count)
  const toggle = (group: string) =>
    update({ hide: filters.hide.includes(group) ? filters.hide.filter((g) => g !== group) : [...filters.hide, group] })
  return (
    <section ref={panel} className={`graph-panel ${fullscreen ? 'graph-fullscreen' : ''}`} aria-label="Contract wiring graph">
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
          aria-label="Find contract, role or dependency"
          placeholder="Find contract, role or getter"
          leftSection={<Search size={14} />}
          rightSection={
            filters.query && (
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Clear search" onClick={() => update({ query: '' })}>
                <X size={14} />
              </ActionIcon>
            )
          }
          value={filters.query}
          onChange={(e) => update({ query: e.currentTarget.value })}
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
            onClick={() => update({ missingOnly: !filters.missingOnly })}
          >
            Issues only
          </FilterChip>
          <span className="filter-sep" aria-hidden />
          <FilterChip on={implementation} onClick={() => update({ mode: implementation ? 'all' : 'implementation', hide: [] })}>
            Facets & libraries
          </FilterChip>
          <FilterChip
            on={stacking && stackable.stacks.size > 0}
            count={stackable.stacks.size}
            disabled={!stackable.stacks.size}
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
            <Button size="compact-sm" variant="subtle" onClick={() => update({ hide: [], query: '', missingOnly: false })}>
              Reset
            </Button>
          )}
        </div>
        <Group gap={4} ml="auto" wrap="nowrap">
          <Tooltip label="Fit to view (0)">
            <ActionIcon variant="default" size="lg" aria-label="Fit to view" onClick={fit}>
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
                cy.current?.nodes().positions((n) => positions[n.id()])
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
          <Tooltip label={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              onClick={onFullscreen}
              data-fullscreen-toggle
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
              onSelect={onSelect}
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
              onSelect={onSelect}
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
              onPrepare={onPrepare}
              onSelect={onSelect}
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
              aria-label="Interactive contract graph. Choose Whole system or One contract above to set what is drawn; a contract's connections are listed in the inspector. Arrow keys move the map, plus and minus zoom, zero fits, Escape clears the highlight."
              onKeyDown={(e) => {
                const graph = cy.current
                if (!graph) return
                if (e.key === 'Escape' && (reach || spot || family)) {
                  e.stopPropagation()
                  if (reach) setReach(null)
                  else light('')
                }
                if (['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                  e.preventDefault()
                  if (e.key === '0') fit()
                  else if (['+', '=', '-'].includes(e.key)) zoomBy(e.key === '-' ? 0.8 : 1.25)
                  else
                    graph.panBy({
                      x: e.key === 'ArrowLeft' ? 80 : e.key === 'ArrowRight' ? -80 : 0,
                      y: e.key === 'ArrowUp' ? 80 : e.key === 'ArrowDown' ? -80 : 0,
                    })
                }
              }}
            />
            {/* What the map is lit for, pinned to its corner with the way back out. */}
            {reached ? (
              <div className="graph-scope">
                <span>
                  {reached.direction === 'over' ? (
                    <>
                      <b>{nameOf(reached.root)}</b> can change{' '}
                      {reachedCount ? `${reachedCount} ${reachedCount === 1 ? 'contract' : 'contracts'}` : 'nothing'}
                    </>
                  ) : (
                    <>
                      {reachedCount ? `${reachedCount} ${reachedCount === 1 ? 'address' : 'addresses'}` : 'Nobody'} can change{' '}
                      <b>{nameOf(reached.root)}</b>
                    </>
                  )}
                </span>
                <button type="button" aria-label="Close this view" onClick={() => setReach(null)}>
                  <X size={13} aria-hidden />
                </button>
              </div>
            ) : !filters.focus && spot && model.nodes.some((n: any) => n.id === spot) ? (
              <div className="graph-scope">
                <span>
                  <b>{nameOf(spot)}</b> and its connections
                </span>
                {!model.stacks.has(spot) && (
                  <button type="button" onClick={() => update({ focus: spot })}>
                    <Focus size={13} aria-hidden /> Show only this
                  </button>
                )}
                <button type="button" aria-label="Clear highlight" onClick={() => light('')}>
                  <X size={13} aria-hidden />
                </button>
              </div>
            ) : showChanges ? (
              <div className="graph-scope">
                <span>
                  <b>
                    {overlay.count} {overlay.count === 1 ? 'change' : 'changes'}
                  </b>
                  {since ? ` since block ${since.blockNumber.toLocaleString()}` : ' since the previous inspection'}
                </span>
                <button type="button" aria-label="Hide changes" onClick={() => setChanges(false)}>
                  <X size={13} aria-hidden />
                </button>
              </div>
            ) : null}
            {!links.length && (
              <div className="graph-empty">
                <Text size="sm">{snapshot ? 'No connections match these filters.' : 'Inspect the deployment to verify its wiring.'}</Text>
                {snapshot && filtered && (
                  <Button mt="sm" variant="default" onClick={() => update({ hide: [], query: '', missingOnly: false })}>
                    Reset filters
                  </Button>
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
              <Text size="xs" w={36} ta="center">
                {zoom}%
              </Text>
              <ActionIcon variant="default" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
                <Plus size={14} />
              </ActionIcon>
            </Group>
          </div>
          <div className="graph-legend">
            <p className="graph-tip">
              {arrange ? 'Drag a contract to place it' : 'Drag to move'} ·{' '}
              {scroll === 'zoom' ? 'scroll to zoom' : 'scroll to move, pinch or ⌘-scroll to zoom'} · click a contract to light up its connections
            </p>
            <div className="legend-lines">
              {(showChanges ? (['added', 'changed', 'removed'] as const) : (['set', 'missing', 'unknown'] as const)).map((state) => (
                <span className="legend-key" data-state={state} key={state}>
                  <i aria-hidden />
                  {{ set: 'Set', missing: 'Missing', unknown: 'Unavailable', added: 'New', changed: 'Changed', removed: 'Gone' }[state]}
                </span>
              ))}
              <Text size="xs" c="dimmed" ml="auto">
                {addresses} addresses{model.stacks.size ? ` in ${model.nodes.length} nodes` : ''} · {total} of {plain.tally.total} connections
              </Text>
            </div>
          </div>
        </div>
      </ResizableSidebar>
    </section>
  )
}
