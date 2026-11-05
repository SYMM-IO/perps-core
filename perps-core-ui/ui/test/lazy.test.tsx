import { lazyView } from '../src/lib/lazy'
import { render, screen, waitFor } from '@testing-library/react'
import { Component, Suspense, type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'

class Boundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  render() {
    return this.state.error ? <p>failed: {this.state.error}</p> : this.props.children
  }
}
const mount = (View: ReturnType<typeof lazyView>) =>
  render(
    <Boundary>
      <Suspense fallback={<p>loading</p>}>
        <View />
      </Suspense>
    </Boundary>,
  )
const gone = () => Promise.reject(new Error('Failed to fetch dynamically imported module'))

it('reloads once when a view chunk is missing after a rebuild, and keeps the fallback up meanwhile', async () => {
  const reload = vi.fn()
  mount(lazyView(gone, reload))
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  expect(screen.getByText('loading')).toBeTruthy()
  expect(screen.queryByText(/failed/)).toBeNull()
})

it('shows the error when the chunk is still missing after that reload, instead of looping', async () => {
  const reload = vi.fn()
  mount(lazyView(gone, reload))
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  // The reloaded page tries again with the flag still set.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mount(lazyView(gone, reload))
  await waitFor(() => expect(screen.getByText(/failed: Failed to fetch/)).toBeTruthy())
  expect(reload).toHaveBeenCalledTimes(1)
})

it('clears the flag once a view loads, so the next rebuild gets its own reload', async () => {
  const reload = vi.fn()
  mount(lazyView(gone, reload))
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  mount(lazyView(async () => ({ default: () => <p>loaded</p> }), reload))
  await waitFor(() => expect(screen.getByText('loaded')).toBeTruthy())
  mount(lazyView(gone, reload))
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(2))
})
