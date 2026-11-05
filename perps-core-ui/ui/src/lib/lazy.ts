import { lazy, type ComponentType } from 'react'

const RELOADED = 'perps-core-ui:reloaded-for-build'

/**
 * A lazily loaded view that survives a rebuild. Every build renames its chunks, so a tab left open
 * across `npm run ui:build` asks for a file that no longer exists. The first time that happens the
 * page reloads to pick up the new build; if the chunk is still missing after that, the error is real
 * and is shown.
 */
export function lazyView<T extends ComponentType<any>>(load: () => Promise<{ default: T }>, reload: () => void = () => location.reload()) {
  return lazy(async () => {
    try {
      const view = await load()
      sessionStorage.removeItem(RELOADED)
      return view
    } catch (error) {
      if (sessionStorage.getItem(RELOADED)) throw error
      sessionStorage.setItem(RELOADED, '1')
      reload()
      // The page is on its way out; keep the fallback on screen instead of flashing an error.
      return new Promise<{ default: T }>(() => {})
    }
  })
}
