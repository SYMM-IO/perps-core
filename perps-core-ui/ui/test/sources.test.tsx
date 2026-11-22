import { Sources } from '../src/components/Sources'
import type { Profile, Snapshot } from '../src/types'
import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

const profile: Profile = {
  id: 'arbitrum-vibe',
  name: 'Vibe Arbitrum',
  chainId: 42161,
  nodes: Array.from({ length: 19 }, (_, i) => ({
    id: `n${i}`,
    kind: 'external',
    name: `n${i}`,
    address: '0x' + '1'.repeat(40),
    state: {},
    status: 'observed',
  })),
  source: { url: 'https://profiles.example.com/vibe', entry: 'Vibe Arbitrum', checked: '2026-10-10' },
  links: [{ label: 'Events', url: 'https://api.example.com/subgraphs/events/gn' }],
}
const base = { nodes: [], edges: [], chainId: 42161, blockNumber: 513_733_791, at: '2026-10-11T05:57:07.299Z', fingerprint: 'f', profile }
const mount = (snapshot: Snapshot | undefined, connected = false, issues = 2) =>
  render(
    <MantineProvider env="test">
      <Sources opened onClose={() => {}} profile={profile} snapshot={snapshot} connected={connected} issues={issues} />
    </MantineProvider>,
  )
const evidence = (name: string) => screen.getByRole('button', { name })
const open = (name: string) => fireEvent.click(evidence(name))

it('starts with the read identity and gaps, with detailed evidence closed until requested', async () => {
  mount({
    ...base,
    sources: {
      inventory: { entry: 'Vibe Arbitrum', url: profile.source!.url, checked: '2026-10-10', contracts: 19, candidates: 17 },
      chain: { block: 513_733_791, discovered: 102, rpc: 'arb1.arbitrum.io' },
      history: {
        source: 'subgraph',
        complete: true,
        grants: 68,
        revocations: 13,
        holdersToConfirm: 41,
        toBlock: 513_733_700,
        contractsOutsideInventory: ['0x' + 'a'.repeat(40)],
        subgraph: { name: 'arbitrum-vibe-mainnet-events/stage', block: 513_733_700, behind: 91, hasIndexingErrors: false },
      },
      abis: { verified: 9, local: 14 },
      checks: { expectedGrants: 13, comparedPointers: 1 },
    },
  })
  expect(screen.getByText('Saved inspection · Block 513,733,791')).toBeTruthy()
  expect(screen.getByText(/arb1.arbitrum.io/)).toBeTruthy()
  expect(screen.getByText('Role events stop 91 blocks before this inspection.')).toBeTruthy()
  for (const name of ['Address list', 'Role holder evidence', 'Contract interfaces', 'Review rules'])
    expect(evidence(name).getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('link', { name: /View address list source/ })).toBeNull()

  open('Address list')
  expect(screen.getByText('addresses.json · Vibe Arbitrum · 19 contracts · 17 possible role holders')).toBeTruthy()
  expect(screen.getByText('Last checked on chain: 2026-10-10')).toBeTruthy()
  expect(screen.getByText('102 additional addresses discovered on chain.')).toBeTruthy()
  expect(((await screen.findByRole('link', { name: /View address list source/ })) as HTMLAnchorElement).href).toBe('https://profiles.example.com/vibe')
  open('Role holder evidence')
  expect(screen.getByText('Subgraph arbitrum-vibe-mainnet-events/stage')).toBeTruthy()
  expect(screen.getByText('68 grants · 13 revocations · through block 513,733,700')).toBeTruthy()
  expect(screen.getByText('41 candidate holders checked on chain with hasRole.')).toBeTruthy()
  expect(screen.getByText(/Events also reference 1 unlisted contract/)).toBeTruthy()
  open('Review rules')
  expect(screen.getByText(/13 required grants: server\/roles.js/)).toBeTruthy()
  expect(screen.getByText('2 disagreements in this inspection.')).toBeTruthy()
})

it('keeps incomplete RPC coverage and unavailable reads visible before opening evidence', () => {
  mount(
    {
      ...base,
      edges: [{ from: 'a', to: 'b', label: 'Owner', status: 'unknown' }],
      roleHistory: { complete: false, requests: 48, eventCount: 0, unreadRanges: 49 },
    },
    false,
    0,
  )
  expect(screen.getByText('Role history incomplete · 49 unread block ranges. Unlisted holders may be missing.')).toBeTruthy()
  expect(screen.getByText('1 connection read unavailable.')).toBeTruthy()
  expect(evidence('Role holder evidence').getAttribute('aria-expanded')).toBe('false')
  open('Role holder evidence')
  expect(screen.getByText('Event scan through the RPC · incomplete.')).toBeTruthy()
  expect(screen.getByText('Inspect live can retry the events subgraph.')).toBeTruthy()
  open('Review rules')
  expect(screen.getByText('0 disagreements in this inspection.')).toBeTruthy()
})

it('shows a role indexer error in the default coverage summary', () => {
  mount({
    ...base,
    sources: {
      history: {
        source: 'subgraph',
        complete: true,
        grants: 0,
        revocations: 0,
        holdersToConfirm: 0,
        toBlock: 123,
        subgraph: { name: 'events', hasIndexingErrors: true },
      },
    },
  })
  expect(screen.getByText('The role indexer reports errors; its list may stop early.')).toBeTruthy()
  expect(evidence('Role holder evidence').getAttribute('aria-expanded')).toBe('false')
})

it('marks missing historical coverage instead of treating a saved inspection as complete', () => {
  mount(base)
  expect(screen.getByText('Role history coverage was not recorded.')).toBeTruthy()
})

it('does not report disagreements before inspection or link a non-http source address', () => {
  render(
    <MantineProvider env="test">
      <Sources
        opened
        onClose={() => {}}
        profile={{ ...profile, source: { url: 'javascript:alert(1)', entry: 'X' } }}
        snapshot={undefined}
        connected={false}
        issues={0}
      />
    </MantineProvider>,
  )
  expect(screen.getByText('Not inspected yet. Inspect live to read this deployment.')).toBeTruthy()
  open('Address list')
  expect(screen.queryByRole('link', { name: /View address list source/ })).toBeNull()
  open('Review rules')
  expect(screen.getByText('Inspect live to check these expectations.')).toBeTruthy()
  expect(screen.queryByText('0 disagreements in this inspection.')).toBeNull()
})
