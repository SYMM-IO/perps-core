import { bundleEdges, graphModel, linkId } from '../../shared/graph-model.js'
import { Collection } from '../src/components/Common'
import { Inspector, InspectorSummary, LinkDetail } from '../src/components/Inspector'
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

it('shows identity and outstanding issues above collapsed contract details', () => {
  inspect({ ...nodes[1], listed: true, state: { facets: 33, functions: 481 } })
  const panel = screen.getByLabelText('Contract inspector')
  const issue = within(panel).getByRole('button', { name: /PAUSER_ROLE not granted/ })
  const roles = within(panel).getByRole('button', { name: 'Who can change it' })
  expect(issue.compareDocumentPosition(roles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(roles.getAttribute('aria-expanded')).toBe('false')
  expect(panel.textContent).not.toMatch(/33 facets|481 functions|In the address book|Diamond cut/)
  expect(panel.querySelector('.address')?.textContent).not.toBe(nodes[1].address)
  expect(screen.getByRole('button', { name: 'Prepare upgrade' }).getAttribute('data-variant')).toBe('default')
})

it('arranges a contract by what is asked of it, and says each thing once', async () => {
  const { onLink, onPower } = inspect(nodes[1])
  // Power, dependencies and code each have their own section; there is no single list of everything.
  expect(sections()).toEqual(['Who can change it', 'Points to', 'Facets & libraries', 'Technical details'])
  expect(screen.queryByText(/Connections \(/)).toBeNull()
  expect(screen.queryByText('Role holders')).toBeNull()
  // Permission details open only when asked, and say how in words rather than in a bare number.
  expect(screen.queryByRole('button', { name: 'By role' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Who can change it' }))
  const who = await screen.findByRole('button', { name: /Admin authority.*holds 1.*can grant 1/ })
  fireEvent.click(who)
  expect(onLink).toHaveBeenLastCalledWith(linkId('gov', 'core'))
  fireEvent.click(screen.getByRole('button', { name: 'Show on map' }))
  expect(onPower).toHaveBeenCalledWith('core', 'under')
  // The same grants, turned round: each role with its holders, the missing one first and marked.
  fireEvent.click(await screen.findByRole('button', { name: 'By role' }))
  expect([...document.querySelectorAll('.role-row code')].map((c) => c.textContent)).toEqual(['PAUSER_ROLE', 'SETTER_ROLE'])
  expect(screen.getByRole('button', { name: 'Admin authority · not granted' })).toBeTruthy()
  expect(screen.getByText('granted by Admin authority')).toBeTruthy()
  // The issue still opens the link that carries it, and the explorer link sits beside the address.
  fireEvent.click(screen.getByRole('button', { name: 'Admin authority · not granted' }))
  expect(onLink).toHaveBeenLastCalledWith(linkId('gov', 'core'))
  expect(screen.getByRole('link', { name: 'View on explorer' }).getAttribute('href')).toBe(`https://arbiscan.io/address/${nodes[1].address}`)
})

it('shows a wallet by what it can change and where it is referenced', async () => {
  inspect(nodes[0])
  expect(sections()).toEqual(['What it can change', 'Referenced by', 'Technical details'])
  fireEvent.click(screen.getByRole('button', { name: 'What it can change' }))
  expect(await screen.findByRole('button', { name: /Symmio.*holds 1.*can grant 1/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Referenced by' }))
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
  expect(screen.queryByText('33 facets · In the address book')).toBeNull()
  // The verifier is an address on the map, so it is a connection, not a setting; the typehash is a constant.
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
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
  expect(within(rows[0] as HTMLElement).getByText('hasRole = false')).toBeTruthy()
  expect(within(rows[0] as HTMLElement).getByText('Expected: true')).toBeTruthy()
  expect(within(rows[1] as HTMLElement).queryByText(/Read:/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Admin authority' }))
  expect(onSelect).toHaveBeenCalledWith('gov')
})

it('shows the checked role membership and keeps a recorded grant behind history', () => {
  const source = links.find((link) => link.id === linkId('gov', 'core'))!
  const edge = {
    ...source.edges.find((edge) => edge.label === 'SETTER_ROLE')!,
    actual: true,
    basis: 'Observed role grant',
    grant: { tx: '0x' + 'a'.repeat(64), block: 100 },
  }
  const link = { ...source, count: 1, missing: 0, unknown: 0, edges: [edge] }
  wrap(<LinkDetail link={link} nodes={nodes} block={123456} onSelect={vi.fn()} onClose={vi.fn()} explorer="https://arbiscan.io" />)
  expect(screen.queryByText('Observed role grant')).toBeNull()
  expect(screen.getByText('hasRole = true')).toBeTruthy()
  expect(screen.getByText('1 role')).toBeTruthy()
  const history = screen.getByText('Grant transaction').closest('details')!
  expect(history.open).toBe(false)
  expect(screen.getByRole('link', { name: /0xaaaa/ }).closest('details')).toBe(history)
})

it('only turns plain http(s) profile values into links', () => {
  expect(httpUrl('https://arbiscan.io')).toBe('https://arbiscan.io/')
  expect(httpUrl('http://127.0.0.1:8545/x')).toBe('http://127.0.0.1:8545/x')
  for (const value of ['javascript:alert(1)', 'data:text/html,<script>1</script>', ' JaVaScRiPt:alert(1)', 'not a url', '', undefined, null])
    expect(httpUrl(value), String(value)).toBeUndefined()
})

it('says roles held by the same addresses once, with every name on the shared block', async () => {
  const shared = [
    { from: 'gov', to: 'core', label: 'SETTER_ROLE', kind: 'role', status: 'verified' },
    { from: 'gov', to: 'core', label: 'PAUSER_ROLE', kind: 'role', status: 'verified' },
    { from: 'gov', to: 'core', label: 'Admin · SETTER_ROLE', kind: 'roleAdmin', status: 'verified' },
    { from: 'gov', to: 'core', label: 'Admin · PAUSER_ROLE', kind: 'roleAdmin', status: 'verified' },
  ]
  const onLink = vi.fn()
  wrap(
    <Inspector
      node={nodes[1]}
      nodes={nodes}
      edges={shared}
      profile={{ id: 'p', name: 'P', chainId: 1, nodes, explorer: 'https://arbiscan.io' }}
      onPrepare={vi.fn()}
      onSelect={vi.fn()}
      onLink={onLink}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Who can change it' }))
  fireEvent.click(await screen.findByRole('button', { name: 'By role' }))
  const blocks = document.querySelectorAll('.role-row')
  expect(blocks).toHaveLength(1)
  expect([...blocks[0].querySelectorAll('code')].map((c) => c.textContent)).toEqual(['PAUSER_ROLE', 'SETTER_ROLE'])
  expect(screen.getByText('granted by Admin authority')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Admin authority' }))
  expect(onLink).toHaveBeenLastCalledWith(linkId('gov', 'core'))
})

it('collapses a long list behind its count, and filters it by key once opened', () => {
  const holders = Array.from({ length: 8 }, (_, i) => `0x${String(i).repeat(40)}`)
  wrap(
    <Collection unit="holders">
      {holders.map((h) => (
        <button key={h} type="button">
          {h}
        </button>
      ))}
    </Collection>,
  )
  expect(screen.getByText('8 holders')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Filter holders'), { target: { value: holders[3] } })
  const rows = [...document.querySelectorAll('.inspector-collection-items > div')]
  expect(rows.filter((r) => !(r as HTMLElement).hidden)).toHaveLength(1)
})

it('renders a short list as it always did, with no summary and no filter', () => {
  const holders = Array.from({ length: 3 }, (_, i) => `0x${String(i).repeat(40)}`)
  wrap(
    <Collection unit="holders">
      {holders.map((h) => (
        <button key={h} type="button">
          {h}
        </button>
      ))}
    </Collection>,
  )
  expect(screen.queryByLabelText('Filter holders')).toBeNull()
  expect(document.querySelector('.inspector-collection')).toBeNull()
})

it('names a Safe by its owners and threshold, each opening its owner', () => {
  const safe: ContractNode = { ...makeNode('safe', 'safe', 'Main Multisig'), state: { threshold: 2 } }
  const owners = [makeNode('o1', 'authority', 'Owner one'), makeNode('o2', 'authority', 'Owner two')]
  const ownership = owners.map((o) => ({ from: o.id, to: 'safe', label: 'Safe owner', kind: 'ownership', status: 'verified' }))
  const onSelect = vi.fn()
  wrap(
    <Inspector
      node={safe}
      nodes={[safe, ...owners]}
      edges={ownership}
      profile={{ id: 'p', name: 'P', chainId: 1, nodes, explorer: 'https://arbiscan.io' }}
      onPrepare={vi.fn()}
      onSelect={onSelect}
      onLink={vi.fn()}
    />,
  )
  const ownersBlock = screen.getByText('Safe owners · 2 of 2').parentElement as HTMLElement
  ;(ownersBlock as HTMLDetailsElement).open = true
  fireEvent.click(within(ownersBlock).getByRole('button', { name: 'Owner one' }))
  expect(onSelect).toHaveBeenCalledWith('o1')
})

it('tells a wallet authority from a contract one in technical details', async () => {
  inspect({ ...nodes[0], codeSize: 0 })
  expect(screen.queryByRole('region', { name: 'Technical details' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Technical details' }))
  expect(await screen.findByText('Authority · EOA')).toBeTruthy()
})

it('lists every problem with nothing selected, each opening the link that carries it', () => {
  const onSelect = vi.fn(),
    onLink = vi.fn()
  const missing = { from: 'gov', to: 'core', label: 'PAUSER_ROLE', kind: 'role', status: 'missing', actual: false, expected: true }
  wrap(<InspectorSummary issues={[missing]} nodes={nodes} onSelect={onSelect} onLink={onLink} />)
  expect(screen.getByRole('heading', { name: '1 needs attention' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /PAUSER_ROLE not granted/ }))
  expect(onSelect).toHaveBeenCalledWith('gov')
  expect(onLink).toHaveBeenCalledWith(linkId('gov', 'core'))
  wrap(<InspectorSummary issues={[]} nodes={nodes} onSelect={onSelect} onLink={onLink} />)
  expect(screen.getByRole('heading', { name: 'No missing connections found' })).toBeTruthy()
})

it('disables Prepare upgrade while another operation runs', () => {
  const onPrepare = vi.fn()
  inspect(nodes[1], { onPrepare, prepareDisabled: true })
  const button = screen.getByRole('button', { name: 'Prepare upgrade' })
  expect((button as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(button)
  expect(onPrepare).not.toHaveBeenCalled()
})
