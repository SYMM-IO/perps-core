import { ResizableSidebar } from '../src/components/ResizableSidebar'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

const key = 'test:sidebar-width'
function mount() {
  return render(
    <ResizableSidebar label="inspector" storageKey={key} sidebar={<p>Details</p>}>
      <div>Map</div>
    </ResizableSidebar>,
  )
}

it('resizes within bounds with the keyboard and retains the width across remounts', () => {
  localStorage.removeItem(key)
  const view = mount()
  const handle = screen.getByRole('separator', { name: 'Resize inspector' })
  fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
  expect(handle.getAttribute('aria-valuenow')).toBe('340')
  view.unmount()
  mount()
  const restored = screen.getByRole('separator')
  expect(restored.getAttribute('aria-valuenow')).toBe('340')
  fireEvent.keyDown(restored, { key: 'End' })
  fireEvent.keyDown(restored, { key: 'ArrowLeft' })
  expect(restored.getAttribute('aria-valuenow')).toBe('640')
  fireEvent.keyDown(restored, { key: 'Home' })
  fireEvent.keyDown(restored, { key: 'ArrowRight' })
  expect(restored.getAttribute('aria-valuenow')).toBe('260')
  fireEvent.doubleClick(restored)
  expect(restored.getAttribute('aria-valuenow')).toBe('300')
  localStorage.removeItem(key)
})

it('recovers from an invalid saved width', () => {
  localStorage.setItem(key, 'NaN')
  mount()
  expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('300')
  localStorage.removeItem(key)
})
