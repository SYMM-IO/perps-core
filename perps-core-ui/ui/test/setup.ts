import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

// The UI fixtures assert English number formatting, independent of the host's locale.
const numberToLocaleString = Number.prototype.toLocaleString
beforeEach(() => {
  vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (this: number, locales, options) {
    return numberToLocaleString.call(this, locales ?? 'en-US', options)
  })
})

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  vi.restoreAllMocks()
})
Object.defineProperty(window, 'matchMedia', {
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  })),
})
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', Observer)
Element.prototype.scrollIntoView = vi.fn()
window.scrollTo = vi.fn()
