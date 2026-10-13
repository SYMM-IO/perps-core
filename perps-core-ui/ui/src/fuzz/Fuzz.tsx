import { useWorkbench } from '../api'
import css from './dashboard.css?inline'
import markup from './dashboard.html?raw'
import { mountFuzzDashboard } from './dashboard.js'
import { useComputedColorScheme } from '@mantine/core'
import { useEffect, useRef } from 'react'

/**
 * The fuzz report renders its own DOM and carries its own stylesheet. A shadow root keeps that
 * stylesheet and the app's from reaching into each other.
 */
export function Fuzz() {
  const { token } = useWorkbench()
  const host = useRef<HTMLDivElement>(null)
  const dashboard = useRef<{ redraw: () => void } | null>(null)
  const scheme = useComputedColorScheme('dark')
  useEffect(() => {
    const root = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' })
    // Both strings are build-time constants from this folder, never report data.
    const style = document.createElement('style')
    style.textContent = css
    root.replaceChildren(style, ...new DOMParser().parseFromString(markup, 'text/html').body.childNodes)
    const mounted = mountFuzzDashboard(root, { authorization: `Bearer ${token}` })
    dashboard.current = mounted
    return () => {
      mounted.dispose()
      dashboard.current = null
      root.replaceChildren()
    }
  }, [token])
  // The charts read their colours from CSS when they draw, so a theme switch needs a repaint.
  useEffect(() => dashboard.current?.redraw(), [scheme])
  return <div ref={host} className="fuzz-view" data-scheme={scheme} />
}
