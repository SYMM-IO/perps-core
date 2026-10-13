import { useParamPatch } from '../src/lib/url'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { expect, it } from 'vitest'

function Probe() {
  const patch = useParamPatch()
  const location = useLocation()
  return (
    <>
      <output>{location.search}</output>
      <button
        onClick={() => {
          // One click, two patches: which contract the map is drawn around, then which one is selected.
          patch({ graphFocus: 'core' })
          patch({ node: 'core', link: null })
        }}
      >
        One contract
      </button>
      <button onClick={() => patch({ graphFocus: '' })}>Whole system</button>
    </>
  )
}
const search = () => new URLSearchParams(screen.getByRole('status').textContent!)

it('keeps both patches when one click makes two, and still starts from the latest URL on the next click', () => {
  render(
    <MemoryRouter initialEntries={['/?view=workspace&graphFocus=&link=gov%3Ecore']}>
      <Probe />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'One contract' }))
  expect(Object.fromEntries(search())).toEqual({ view: 'workspace', graphFocus: 'core', node: 'core' })
  fireEvent.click(screen.getByRole('button', { name: 'Whole system' }))
  expect(Object.fromEntries(search())).toEqual({ view: 'workspace', graphFocus: '', node: 'core' })
  fireEvent.click(screen.getByRole('button', { name: 'One contract' }))
  expect(search().get('graphFocus')).toBe('core')
})
