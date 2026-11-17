import { ResizableSidebar } from '../src/components/ResizableSidebar'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const key = 'test:sidebar-width'
const room = () => document.querySelector('.resizable-workspace') as HTMLElement
function mount() {
  return render(
    <ResizableSidebar label="inspector" storageKey={key} sidebar={<p>Details</p>}>
      <div>Map</div>
    </ResizableSidebar>,
  )
}
// jsdom reports a 1024px viewport; the tests pin their own so the 60% bound is exact.
const viewport = (width: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
beforeEach(() => {
  viewport(1000)
  localStorage.removeItem(key)
})
afterEach(() => {
  viewport(1024)
  localStorage.removeItem(key)
  delete document.body.dataset.inspectorResizing
})

it('resizes within bounds with the keyboard and retains the width across remounts', () => {
  const view = mount()
  const handle = screen.getByRole('separator', { name: 'Resize inspector' })
  expect(handle.getAttribute('aria-valuenow')).toBe('360')
  fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
  expect(handle.getAttribute('aria-valuenow')).toBe('410')
  view.unmount()
  mount()
  const restored = screen.getByRole('separator')
  expect(restored.getAttribute('aria-valuenow')).toBe('410')
  fireEvent.keyDown(restored, { key: 'End' })
  fireEvent.keyDown(restored, { key: 'ArrowLeft' })
  expect(restored.getAttribute('aria-valuenow')).toBe('600')
  fireEvent.keyDown(restored, { key: 'Home' })
  fireEvent.keyDown(restored, { key: 'ArrowRight' })
  expect(restored.getAttribute('aria-valuenow')).toBe('320')
  fireEvent.doubleClick(restored)
  expect(restored.getAttribute('aria-valuenow')).toBe('360')
})

it('recovers from an invalid saved width', () => {
  localStorage.setItem(key, 'NaN')
  mount()
  expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('360')
})

it('moves only a CSS variable while dragging, and commits and saves once on release', async () => {
  mount()
  const handle = screen.getByRole('separator') as HTMLElement
  handle.setPointerCapture = vi.fn()
  handle.hasPointerCapture = vi.fn(() => true)
  handle.releasePointerCapture = vi.fn()
  await act(async () => {
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 })
  })
  expect(document.body.dataset.inspectorResizing).toBe('true')
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 460 })
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 440 })
  // No commit yet: the announced width and the saved one stand still mid-drag.
  expect(handle.getAttribute('aria-valuenow')).toBe('360')
  expect(localStorage.getItem(key)).toBe('360')
  await act(frames)
  expect(room().style.getPropertyValue('--sidebar-width')).toBe('420px')
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 440 })
  expect(handle.getAttribute('aria-valuenow')).toBe('420')
  expect(localStorage.getItem(key)).toBe('420')
  expect(document.body.dataset.inspectorResizing).toBeUndefined()
})

it('does not start a drag below the stacked breakpoint', () => {
  viewport(800)
  mount()
  const handle = screen.getByRole('separator') as HTMLElement
  handle.setPointerCapture = vi.fn()
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 })
  expect(document.body.dataset.inspectorResizing).toBeUndefined()
  fireEvent.keyDown(handle, { key: 'ArrowLeft' })
  expect(handle.getAttribute('aria-valuenow')).toBe('360')
})

it('lays the inspector out for its own width, tight when narrow and two-column when wide', () => {
  const css = readFileSync(resolve('perps-core-ui/ui/src/styles.css'), 'utf8')
  expect(css).toContain('container: inspector / inline-size')
  expect(css).toContain('@container inspector (width < 380px)')
  expect(css).toContain('@container inspector (width > 560px)')
})
