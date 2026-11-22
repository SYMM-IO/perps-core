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
function mount(busy = false, changes: { nodes?: ContractNode[]; comparison?: Record<string, any> } = {}) {
  const onPrepare = vi.fn(),
    onInspect = vi.fn()
  render(
    <MantineProvider env="test">
      <ContractsTable nodes={changes.nodes || nodes} comparison={changes.comparison || {}} busy={busy} onPrepare={onPrepare} onInspect={onInspect} />
    </MantineProvider>,
  )
  return { onPrepare, onInspect }
}
it('prioritizes upgrade targets and keeps implementation inventory available through the filter', () => {
  mount()
  const table = screen.getByRole('table')
  const names = within(table).getAllByRole('button', { name: /^Inspect / })
  expect(names[0].textContent).toBe('Core')
  expect(names[1].textContent).toBe('AccountLayer')
  expect(within(table).queryByRole('button', { name: 'Inspect ControlFacet' })).toBeNull()
  expect(screen.queryByRole('checkbox', { name: 'Include facets & libraries' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include facets & libraries' }))
  expect(within(table).getByRole('button', { name: 'Inspect ControlFacet' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Filters · 1' }))
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.getByRole('button', { name: 'Filters · 1' }).getAttribute('aria-expanded')).toBe('false')
})
it('opens the exact selected component without repeating upgrade actions in the inventory', () => {
  const { onPrepare, onInspect } = mount()
  const table = within(screen.getByRole('table'))
  fireEvent.click(table.getByRole('button', { name: 'Inspect Verifier' }))
  expect(onInspect).toHaveBeenCalledWith(nodes[1])
  fireEvent.click(table.getByRole('button', { name: 'Inspect Affiliate' }))
  expect(onInspect).toHaveBeenCalledWith(nodes[0])
  expect(table.queryByRole('button', { name: /Prepare/ })).toBeNull()
  expect(onPrepare).not.toHaveBeenCalled()
})
it('clears a search without widening the contract inventory', () => {
  mount()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'not-found' } })
  expect(screen.queryByRole('table')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
  expect(within(screen.getByRole('table')).queryByRole('button', { name: 'Inspect ControlFacet' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
})
it('keeps read-only inspection available while a job runs', () => {
  const { onPrepare, onInspect } = mount(true)
  fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: 'Inspect Verifier' }))
  expect(onInspect).toHaveBeenCalledWith(nodes[1])
  expect(onPrepare).not.toHaveBeenCalled()
})
it('omits normal facet/function totals and strategy columns but keeps exceptional states and source differences', () => {
  mount(false, {
    nodes: [
      { ...nodes[3], state: { facets: 19, functions: 238 }, strategy: 'Diamond cut' },
      { ...nodes[1], status: 'no-code' },
      { ...nodes[0], state: { paused: true } },
    ],
    comparison: { Core: { kind: 'diamond', matching: 18, total: 19 }, Verifier: { matching: true } },
  })
  const table = within(screen.getByRole('table'))
  expect(table.queryByText(/^19 facets|238 functions|^Diamond cut$/)).toBeNull()
  expect(table.queryByRole('columnheader', { name: /Upgrade path|Type|On chain|Status/ })).toBeNull()
  expect(table.queryByText('Matches')).toBeNull()
  expect(table.getByText('No contract code')).toBeTruthy()
  expect(table.getByText('Paused')).toBeTruthy()
  expect(table.getByText('1 of 19 facets changed')).toBeTruthy()
})

it('keeps discovered wallets behind Filters while retaining deployment entries with missing code', () => {
  const wallet = { ...makeNode('wallet', 'authority'), status: 'referenced' }
  const receiver = { ...makeNode('receiver', 'external'), status: 'no-code', listed: true }
  mount(false, { nodes: [...nodes, wallet, receiver] })
  const table = within(screen.getByRole('table'))
  expect(table.queryByRole('button', { name: 'Inspect wallet' })).toBeNull()
  expect(table.getByRole('button', { name: 'Inspect receiver' })).toBeTruthy()
  expect(table.getByText('No contract code')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include wallets & references' }))
  expect(table.getByRole('button', { name: 'Inspect wallet' })).toBeTruthy()
  expect(table.queryByRole('button', { name: 'Inspect ControlFacet' })).toBeNull()
})

it('can find an excluded address without discarding the search when expanding its scope', () => {
  const wallet = { ...makeNode('wallet', 'authority'), address: '0x' + 'a'.repeat(40), status: 'referenced' }
  mount(false, { nodes: [...nodes, wallet] })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: wallet.address } })
  fireEvent.click(screen.getByRole('button', { name: 'Search all addresses' }))
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe(wallet.address)
  expect(within(screen.getByRole('table')).getByRole('button', { name: 'Inspect wallet' })).toBeTruthy()
  expect(within(screen.getByRole('table')).queryByRole('button', { name: 'Inspect Core' })).toBeNull()
})

it('puts the system layers before supporting services', () => {
  mount(false, { nodes: [...nodes, makeNode('Instant Layer', 'instantLayer'), makeNode('Express Provider', 'express')] })
  const table = within(screen.getByRole('table'))
  expect(
    table
      .getAllByRole('button', { name: /^Inspect / })
      .slice(0, 4)
      .map((button) => button.textContent),
  ).toEqual(['Core', 'AccountLayer', 'Instant Layer', 'Express Provider'])
})
