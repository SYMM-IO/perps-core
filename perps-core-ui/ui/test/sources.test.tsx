import { Sources } from '../src/components/Sources'
import type { Profile, Snapshot } from '../src/types'
import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
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
const text = () => document.body.textContent || ''

it('names the address book entry, the block, the subgraph that found the role holders, and what an issue is measured against', () => {
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
  expect(text()).toContain('addresses.json in this repository, deployment “Vibe Arbitrum”, last checked on chain on 2026-10-10')
  expect(text()).toContain('19 contracts and 17 possible role holders')
  expect(text()).toContain('Block 513,733,791')
  expect(text()).toContain('through arb1.arbitrum.io')
  expect(text()).toContain('102 more addresses were found')
  expect(text()).toContain('Nothing is being read now')
  expect(text()).toContain('Subgraph arbitrum-vibe-mainnet-events/stage')
  expect(text()).toContain('68 grants and 13 revocations')
  expect(text()).toContain('91 blocks behind the chain read')
  expect(text()).toContain('41 holders it named was then asked of the chain with hasRole')
  expect(text()).toContain('role events from 1 contract missing from the address list')
  expect(text()).toContain('13 required grants come from rules written in this repository')
  expect(text()).toContain('2 issues now.')
  expect((screen.getByRole('link', { name: /Open its source/ }) as HTMLAnchorElement).href).toBe('https://profiles.example.com/vibe')
})

it('says plainly when role holders came from an incomplete RPC scan, and still reads a snapshot saved before sources were recorded', () => {
  mount({ ...base, roleHistory: { complete: false, requests: 48, eventCount: 0, unreadRanges: 49 } }, false, 0)
  expect(text()).toContain('Event scan through the RPC')
  expect(text()).toContain('Incomplete: 49 block ranges could not be read')
  expect(text()).toContain('Inspect live again to find role holders through the events subgraph')
  expect(text()).toContain('addresses.json in this repository, deployment “Vibe Arbitrum”, last checked on chain on 2026-10-10')
  expect(text()).toContain('No disagreements now.')
})

it('explains what will be read before anything has been inspected, and never links a non-http source address', () => {
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
  expect(text()).toContain('Not read yet.')
  expect(text()).toContain('through the Events subgraph')
  expect(screen.queryByRole('link', { name: /Open its source/ })).toBeNull()
})
