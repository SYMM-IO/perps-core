import { ContractsTable } from '../src/components/ContractsTable'
import type { ContractNode } from '../src/types'
import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
const makeNode = (id: string, kind: string): ContractNode => ({ id, kind, name: id, address: '0x' + '1'.repeat(40), state: {}, status: 'observed' })
const nodes = [
  makeNode('Affiliate', 'affiliate'),
  makeNode('Verifier', 'verifier'),
  makeNode('ControlFacet', 'facet'),
  makeNode('Core', 'core'),
  makeNode('AccountLayer', 'accountLayer'),
]
function mount() {
  const onPrepare = vi.fn(),
    onInspect = vi.fn()
  render(
    <MantineProvider env="test">
      <ContractsTable nodes={nodes} comparison={{}} busy={false} onPrepare={onPrepare} onInspect={onInspect} />
    </MantineProvider>,
  )
  return { onPrepare, onInspect }
}
it('prioritizes upgrade targets and keeps implementation inventory available through the filter', () => {
  mount()
  const table = screen.getByRole('table')
  const rows = within(table).getAllByRole('row')
  expect(rows[1].textContent).toContain('Core')
  expect(rows[2].textContent).toContain('AccountLayer')
  expect(within(table).queryByRole('button', { name: 'Inspect ControlFacet' })).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include facets & libraries' }))
  expect(within(table).getByRole('button', { name: 'Inspect ControlFacet' })).toBeTruthy()
})
it('routes inspect and prepare to the exact selected contract and keeps unsupported contracts inspect-only', () => {
  const { onPrepare, onInspect } = mount()
  const table = within(screen.getByRole('table'))
  fireEvent.click(table.getByRole('button', { name: 'Prepare Verifier upgrade' }))
  expect(onPrepare).toHaveBeenCalledWith(nodes[1])
  fireEvent.click(table.getByRole('button', { name: 'Inspect Affiliate' }))
  expect(onInspect).toHaveBeenCalledWith(nodes[0])
  expect(table.queryByRole('button', { name: 'Prepare Affiliate upgrade' })).toBeNull()
})
it('searches by contract name and lets an empty result restore the complete inventory', () => {
  mount()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'not-found' } })
  expect(screen.queryByRole('table')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show all addresses' }))
  expect(within(screen.getByRole('table')).getByRole('button', { name: 'Inspect ControlFacet' })).toBeTruthy()
})
