import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export const SIDEBAR_MIN = 320
const SIDEBAR_DEFAULT = 360
/** Below this viewport the inspector stacks under the map (see styles.css) and cannot be dragged. */
const NARROW = 900

/** 320px to 60% of the viewport, the room the inspector's content is laid out for. */
export function clampSidebarWidth(width: number, viewport: number): number {
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(viewport * 0.6, Number.isFinite(width) && width > 0 ? width : SIDEBAR_DEFAULT)))
}

/**
 * The map with its inspector beside it, the divider draggable between them. While a drag runs only a CSS
 * variable moves, once per animation frame; React, persistence and the map settle once on release, so
 * resizing never re-renders the inspector or writes storage for every pixel.
 */
export function ResizableSidebar({
  children,
  sidebar,
  storageKey,
  label,
}: {
  children: ReactNode
  sidebar?: ReactNode
  storageKey: string
  label: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; width: number; next: number; pointer: number } | null>(null)
  const frame = useRef<number | null>(null)
  const id = useId()
  // The host's own room, measured once it has any; until then the viewport bound alone applies.
  const [hostCap, setHostCap] = useState(Infinity)
  const [width, setWidth] = useState(() => {
    try {
      return clampSidebarWidth(Number(localStorage.getItem(storageKey)), window.innerWidth)
    } catch {
      return clampSidebarWidth(SIDEBAR_DEFAULT, window.innerWidth)
    }
  })
  const limit = Math.max(SIDEBAR_MIN, Math.min(window.innerWidth * 0.6, hostCap))
  const actualWidth = Math.max(SIDEBAR_MIN, Math.min(width, limit))
  const narrow = () => window.innerWidth <= NARROW

  useEffect(() => {
    const element = host.current!
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0) setHostCap(element.clientWidth - 328)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // The committed width only: a drag writes once, when it ends.
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width))
    } catch {
      /* Resizing works when storage is unavailable. */
    }
  }, [storageKey, width])

  const apply = (next: number) => host.current?.style.setProperty('--sidebar-width', `${next}px`)
  const finish = () => {
    const current = drag.current
    if (!current) return
    drag.current = null
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    apply(current.next)
    setWidth(current.next)
    delete document.body.dataset.inspectorResizing
  }
  useEffect(() => {
    const resize = () => {
      finish()
      setWidth((w) => clampSidebarWidth(w, window.innerWidth))
    }
    window.addEventListener('resize', resize)
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('resize', resize)
      window.removeEventListener('blur', finish)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      delete document.body.dataset.inspectorResizing
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (next: number) => setWidth(clampSidebarWidth(Math.min(next, hostCap), window.innerWidth))
  return (
    <div
      ref={host}
      className={`graph-workspace resizable-workspace${sidebar ? '' : ' without-inspector'}`}
      style={{ '--sidebar-width': `${actualWidth}px` } as CSSProperties}
    >
      {children}
      {sidebar && (
        <div
          className="sidebar-resizer"
          role="separator"
          tabIndex={0}
          aria-label={`Resize ${label}`}
          aria-orientation="vertical"
          aria-controls={id}
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={Math.round(limit)}
          aria-valuenow={actualWidth}
          aria-valuetext={`${Math.round(actualWidth)} pixels`}
          title="Drag to resize · Arrow keys to adjust · Double-click to reset"
          onDoubleClick={() => update(SIDEBAR_DEFAULT)}
          onKeyDown={(event) => {
            if (narrow()) return
            const step = event.shiftKey ? 50 : 10
            const next = {
              ArrowLeft: actualWidth + step,
              ArrowRight: actualWidth - step,
              Home: SIDEBAR_MIN,
              End: limit,
            }[event.key]
            if (next !== undefined) {
              event.preventDefault()
              update(next)
            }
          }}
          onPointerDown={(event) => {
            if (narrow() || event.button !== 0 || drag.current) return
            event.preventDefault()
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { x: event.clientX, width: actualWidth, next: actualWidth, pointer: event.pointerId }
            document.body.dataset.inspectorResizing = 'true'
          }}
          onPointerMove={(event) => {
            const current = drag.current
            if (!current || current.pointer !== event.pointerId) return
            current.next = clampSidebarWidth(Math.min(current.width + current.x - event.clientX, hostCap), window.innerWidth)
            if (frame.current === null)
              frame.current = requestAnimationFrame(() => {
                frame.current = null
                if (drag.current) apply(drag.current.next)
              })
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointer !== event.pointerId) return
            // The last position counts even when it arrives before the pending frame ran.
            drag.current.next = clampSidebarWidth(Math.min(drag.current.width + drag.current.x - event.clientX, hostCap), window.innerWidth)
            finish()
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
        />
      )}
      {sidebar && (
        <aside id={id} className="graph-inspector">
          {sidebar}
        </aside>
      )}
    </div>
  )
}
