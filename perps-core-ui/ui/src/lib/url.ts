import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Patches the page's search parameters. React Router works a functional update out from the URL as
 * it was at the last render, so two updates in one event would silently drop the first. Patches made
 * before the next render are composed here instead. A `null` value removes the parameter.
 */
export function useParamPatch() {
  const [params, setParams] = useSearchParams()
  const queued = useRef<URLSearchParams | null>(null)
  useEffect(() => {
    queued.current = null
  }, [params])
  return (values: Record<string, string | null>) => {
    const next = new URLSearchParams(queued.current ?? params)
    for (const [key, value] of Object.entries(values)) value === null ? next.delete(key) : next.set(key, value)
    queued.current = next
    setParams(next)
  }
}
