import { useParamPatch } from '../src/lib/url'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { expect, it } from 'vitest'

function Probe() {
  const patch = useParamPatch()
  const location = useLocation(),
    type = useNavigationType(),
    navigate = useNavigate()
  return (
    <>
      <output>{location.search}</output>
      <span data-testid="type">{type}</span>
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
      <button onClick={() => patch({ graphQuery: `${new URLSearchParams(location.search).get('graphQuery') || ''}v` }, { replace: true })}>
        Type
      </button>
      <button onClick={() => navigate(-1)}>Back</button>
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

it('rewrites the current entry while typing, so Back goes to the previous view and not the previous letter', () => {
  render(
    <MemoryRouter initialEntries={['/?view=workspace']}>
      <Probe />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Whole system' }))
  expect(screen.getByTestId('type').textContent).toBe('PUSH')
  fireEvent.click(screen.getByRole('button', { name: 'Type' }))
  fireEvent.click(screen.getByRole('button', { name: 'Type' }))
  expect(search().get('graphQuery')).toBe('vv')
  expect(screen.getByTestId('type').textContent).toBe('REPLACE')
  // One click that makes two patches still adds one entry.
  fireEvent.click(screen.getByRole('button', { name: 'One contract' }))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(Object.fromEntries(search())).toEqual({ view: 'workspace', graphFocus: '', graphQuery: 'vv' })
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(Object.fromEntries(search())).toEqual({ view: 'workspace' })
})
