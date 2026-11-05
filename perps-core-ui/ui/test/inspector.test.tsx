import { bundleEdges, graphModel, linkId } from '../../shared/graph-model.js'
import { Inspector, LinkDetail } from '../src/components/Inspector'
import { httpUrl } from '../src/lib/state'
import type { ContractNode, Link } from '../src/types'
import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

const makeNode = (id: string, kind: string, name: string): ContractNode => ({
  id,
  kind,
  name,
  address: '0x' + '1'.repeat(40),
  state: {},
  status: 'observed',
})
const nodes = [makeNode('gov', 'authority', 'Admin authority'), makeNode('core', 'core', 'Symmio'), makeNode('facet', 'facet', 'ControlFacet')]
const edges = [
  { from: 'gov', to: 'core', label: 'SETTER_ROLE', kind: 'role', status: 'verified' },
  {
    from: 'gov',
    to: 'core',
    label: 'PAUSER_ROLE',
    kind: 'role',
    status: 'missing',
    actual: false,
    expected: true,
    basis: 'Expected integration grant',
  },
  { from: 'gov', to: 'core', label: 'Admin · SETTER_ROLE', kind: 'roleAdmin', status: 'verified' },
  { from: 'core', to: 'gov', label: 'owner', kind: 'pointer', status: 'verified', actual: '0xabc' },
  { from: 'core', to: 'facet', label: 'ControlFacet', kind: 'facet', status: 'verified' },
]
const links = bundleEdges(graphModel({ nodes, edges }, { mode: 'all' }).edges) as Link[]
const wrap = (ui: React.ReactNode) => render(<MantineProvider env="test">{ui}</MantineProvider>)

const inspect = (node: ContractNode, extra: Partial<Parameters<typeof Inspector>[0]> = {}) => {
  const onLink = vi.fn(),
    onPower = vi.fn()
  wrap(
    <Inspector
      node={node}
      nodes={nodes}
      edges={edges}
      profile={{ id: 'p', name: 'P', chainId: 1, nodes, explorer: 'https://arbiscan.io' }}
      onPrepare={vi.fn()}
      onSelect={vi.fn()}
      onLink={onLink}
      onPower={onPower}
      {...extra}
    />,
  )
  return { onLink, onPower }
}
const sections = () => [...document.querySelectorAll('.mantine-Accordion-control')].map((c) => c.textContent)

it('arranges a contract by what is asked of it, and says each thing once', () => {
  const { onLink, onPower } = inspect(nodes[1])
  // Power, dependencies and code each have their own section; there is no single list of everything.
  expect(sections()).toEqual(['Who can change it (1)', 'Points to (1)', 'Facets & libraries (1)', 'Technical details'])
  expect(screen.queryByText(/Connections \(/)).toBeNull()
  expect(screen.queryByText('Role holders')).toBeNull()
  // The section on who can change it is open, and says how in words rather than in a bare number.
  const who = screen.getByRole('button', { name: /Admin authority.*holds 1.*can grant 1/ })
  fireEvent.click(who)
  expect(onLink).toHaveBeenLastCalledWith(linkId('gov', 'core'))
  fireEvent.click(screen.getByRole('button', { name: 'Show on map' }))
  expect(onPower).toHaveBeenCalledWith('core', 'under')
  // The same grants, turned round: each role with its holders, the missing one first and marked.
  fireEvent.click(screen.getByRole('button', { name: 'By role' }))
  expect([...document.querySelectorAll('.role-row code')].map((c) => c.textContent)).toEqual(['PAUSER_ROLE', 'SETTER_ROLE'])
  expect(screen.getByRole('button', { name: 'Admin authority · not granted' })).toBeTruthy()
  expect(screen.getByText('granted by Admin authority')).toBeTruthy()
  // The issue still opens the link that carries it, and the explorer link sits beside the address.
  fireEvent.click(screen.getByRole('button', { name: /PAUSER_ROLE not granted/ }))
  expect(onLink).toHaveBeenLastCalledWith(linkId('gov', 'core'))
  expect(screen.getByRole('link', { name: 'View on explorer' }).getAttribute('href')).toBe(`https://arbiscan.io/address/${nodes[1].address}`)
})

it('shows a wallet by what it can change and where it is referenced', async () => {
  inspect(nodes[0])
  expect(sections()).toEqual(['What it can change (1)', 'Referenced by (1)', 'Technical details'])
  expect(screen.getByRole('button', { name: /Symmio.*holds 1.*can grant 1/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Referenced by (1)' }))
  // A section opened by hand takes a moment to unfold.
  expect(await screen.findByRole('button', { name: /Symmio.*owner/ })).toBeTruthy()
})

it('keeps settings apart from connections and constants, and reads durations as time', async () => {
  const core: ContractNode = {
    ...nodes[1],
    codeSize: 184,
    listed: true,
    state: {
      verifier: nodes[0].address,
      deallocateCooldown: '259200',
      forceCloseCooldowns: ['300', '120'],
      isLegacyFundingDeprecated: true,
      signer: '0x' + '0'.repeat(40),
      DOMAIN_TYPEHASH: '0xabc',
      setup: { anything: 1 },
      facets: 33,
    },
  }
  inspect(core)
  expect(screen.getByText('33 facets · In the address book')).toBeTruthy()
  // The verifier is an address on the map, so it is a connection, not a setting; the typehash is a constant.
  fireEvent.click(screen.getByRole('button', { name: 'Settings (4)' }))
  expect(screen.getByText('3 d')).toBeTruthy()
  expect(screen.getByText('5 min, 2 min')).toBeTruthy()
  expect(screen.getByText('yes')).toBeTruthy()
  expect(screen.getByText('not set')).toBeTruthy()
  expect(screen.queryByText('verifier')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Technical details' }))
  expect(screen.getByText('DOMAIN_TYPEHASH')).toBeTruthy()
  expect(screen.getByText('184 bytes')).toBeTruthy()
  // The raw read is one deliberate step away, not part of the page.
  expect(document.querySelector('.json-code')).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: 'Show raw data' }))
  expect(document.querySelector('.json-code')?.textContent).toContain('"setup"')
})

it('lists every connection on a link with the failing one first and its read and expected values', () => {
  const onSelect = vi.fn()
  const link = links.find((l) => l.id === linkId('gov', 'core'))!
  wrap(<LinkDetail link={link} nodes={nodes} block={123456} back="Symmio" onSelect={onSelect} onClose={vi.fn()} />)
  expect(screen.getByText('3 connections')).toBeTruthy()
  expect(screen.getByText('1 needs attention')).toBeTruthy()
  const rows = document.querySelectorAll('.connection-detail')
  expect([...rows].map((r) => within(r as HTMLElement).getByText(/ROLE/).textContent)).toEqual(['PAUSER_ROLE', 'SETTER_ROLE', 'Admin · SETTER_ROLE'])
  expect(within(rows[0] as HTMLElement).getByText('Read: false')).toBeTruthy()
  expect(within(rows[0] as HTMLElement).getByText('Expected: true')).toBeTruthy()
  expect(within(rows[1] as HTMLElement).queryByText(/Read:/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Admin authority' }))
  expect(onSelect).toHaveBeenCalledWith('gov')
})

it('only turns plain http(s) profile values into links', () => {
  expect(httpUrl('https://arbiscan.io')).toBe('https://arbiscan.io/')
  expect(httpUrl('http://127.0.0.1:8545/x')).toBe('http://127.0.0.1:8545/x')
  for (const value of ['javascript:alert(1)', 'data:text/html,<script>1</script>', ' JaVaScRiPt:alert(1)', 'not a url', '', undefined, null])
    expect(httpUrl(value), String(value)).toBeUndefined()
})

it('disables Prepare upgrade while another operation runs', () => {
  const onPrepare = vi.fn()
  inspect(nodes[1], { onPrepare, prepareDisabled: true })
  const button = screen.getByRole('button', { name: 'Prepare upgrade' })
  expect((button as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(button)
  expect(onPrepare).not.toHaveBeenCalled()
})
