import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'

const MIN_WIDTH = 260
const DEFAULT_WIDTH = 300

export function ResizableSidebar({
  children,
  sidebar,
  storageKey,
  label,
}: {
  children: ReactNode
  sidebar: ReactNode
  storageKey: string
  label: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const id = useId()
  const [limit, setLimit] = useState(640)
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey))
      return Number.isFinite(saved) && saved >= MIN_WIDTH ? Math.min(saved, 640) : DEFAULT_WIDTH
    } catch {
      return DEFAULT_WIDTH
    }
  })
  const [resizing, setResizing] = useState(false)
  const actualWidth = Math.max(MIN_WIDTH, Math.min(width, limit))
  useEffect(() => {
    const element = host.current!
    const observer = new ResizeObserver(() => setLimit(Math.max(MIN_WIDTH, Math.min(640, element.clientWidth - 328))))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width))
    } catch {
      /* Resizing works when storage is unavailable. */
    }
  }, [storageKey, width])
  const update = (next: number) => setWidth(Math.max(MIN_WIDTH, Math.min(next, limit)))
  return (
    <div
      ref={host}
      className={`graph-workspace resizable-workspace${resizing ? ' is-resizing' : ''}`}
      style={{ '--sidebar-width': `${actualWidth}px` } as CSSProperties}
    >
      {children}
      <div
        className="sidebar-resizer"
        role="separator"
        tabIndex={0}
        aria-label={`Resize ${label}`}
        aria-orientation="vertical"
        aria-controls={id}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={limit}
        aria-valuenow={actualWidth}
        aria-valuetext={`${Math.round(actualWidth)} pixels`}
        title="Drag to resize · Arrow keys to adjust · Double-click to reset"
        onDoubleClick={() => update(DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 40 : 10
          const next = { ArrowLeft: actualWidth + step, ArrowRight: actualWidth - step, Home: MIN_WIDTH, End: limit }[event.key]
          if (next !== undefined) {
            event.preventDefault()
            update(next)
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { x: event.clientX, width: actualWidth }
          setResizing(true)
        }}
        onPointerMove={(event) => {
          if (drag.current) update(drag.current.width + drag.current.x - event.clientX)
        }}
        onPointerUp={(event) => {
          drag.current = null
          setResizing(false)
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => {
          drag.current = null
          setResizing(false)
        }}
        onLostPointerCapture={() => {
          drag.current = null
          setResizing(false)
        }}
      />
      <aside id={id} className="graph-inspector">
        {sidebar}
      </aside>
    </div>
  )
}
