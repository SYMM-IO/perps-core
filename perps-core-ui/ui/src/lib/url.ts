import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'

export interface PatchOptions {
  /** Rewrite the current history entry instead of adding one: for typing and toggles, not for going somewhere. */
  replace?: boolean
}
/**
 * Patches the page's search parameters. React Router works a functional update out from the URL as
 * it was at the last render, so two updates in one event would silently drop the first. Patches made
 * before the next render are composed here instead, into one history entry. A `null` value removes the
 * parameter.
 */
export function useParamPatch() {
  const [params, setParams] = useSearchParams()
  const queued = useRef<{ params: URLSearchParams; pushed: boolean } | null>(null)
  useEffect(() => {
    queued.current = null
  }, [params])
  return (values: Record<string, string | null>, options: PatchOptions = {}) => {
    const pending = queued.current,
      next = new URLSearchParams(pending?.params ?? params)
    for (const [key, value] of Object.entries(values)) value === null ? next.delete(key) : next.set(key, value)
    // Once one patch of this event has added an entry, the rest rewrite that entry rather than add more.
    const replace = pending?.pushed || !!options.replace
    queued.current = { params: next, pushed: !!pending?.pushed || !replace }
    setParams(next, { replace })
  }
}
