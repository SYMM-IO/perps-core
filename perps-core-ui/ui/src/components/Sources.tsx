import { httpUrl, short } from '../lib/state'
import type { Profile, Snapshot } from '../types'
import { Modal, Stack, Text } from '@mantine/core'
import type { ReactNode } from 'react'

/** One place a kind of fact comes from: a status dot, what it is, and the specifics of this read. */
function Source({ state, title, children }: { state?: 'live' | 'saved'; title: string; children: ReactNode }) {
  return (
    <div className="source-row">
      <i className="dot" data-state={state} aria-hidden />
      <div>
        <Text fw={700} size="sm">
          {title}
        </Text>
        {children}
      </div>
    </div>
  )
}
const Line = ({ children, dim }: { children: ReactNode; dim?: boolean }) => (
  <Text size="sm" c={dim ? 'dimmed' : undefined} className="break">
    {children}
  </Text>
)
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * Says where everything on the workspace came from: the address list, the chain read, the indexer
 * that found the role holders, the interfaces used to read, and the rules a fact is judged against.
 */
export function Sources({
  opened,
  onClose,
  profile,
  snapshot,
  connected,
  issues,
}: {
  opened: boolean
  onClose: () => void
  profile: Profile
  snapshot?: Snapshot
  connected: boolean
  issues: number
}) {
  const sources = snapshot?.sources,
    inventory = sources?.inventory || { ...profile.source, contracts: profile.nodes.length },
    chain = sources?.chain,
    history = sources?.history || snapshot?.roleHistory,
    sourceUrl = httpUrl(inventory.url),
    events = profile.links?.find((l) => /event/i.test(l.label || ''))
  return (
    <Modal opened={opened} onClose={onClose} title="Where this data comes from" size="lg">
      <Stack gap="xs">
        <Source state="saved" title="Address list">
          <Line>
            {inventory.entry ? `addresses.json in this repository, deployment “${inventory.entry}”` : 'A profile imported in this app'}
            {inventory.checked ? `, last checked on chain on ${inventory.checked}` : ''}
          </Line>
          <Line dim>
            {count(inventory.contracts, 'contract')}
            {inventory.candidates ? ` and ${count(inventory.candidates, 'possible role holder')}` : ''}. The file is read when the app starts, so an
            edit takes effect after a restart.
          </Line>
          {sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
              Open its source ↗
            </a>
          )}
        </Source>
        <Source state={!snapshot ? undefined : connected ? 'live' : 'saved'} title="The chain">
          {snapshot ? (
            <>
              <Line>
                Block {snapshot.blockNumber.toLocaleString()}, read{' '}
                {new Date(snapshot.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                {chain?.rpc ? ` through ${chain.rpc}` : ''}
              </Line>
              <Line dim>
                Every connection, role and pointer shown was read at that one block.
                {chain?.discovered ? ` ${count(chain.discovered, 'more address', 'more addresses')} were found from the listed contracts.` : ''}
              </Line>
              <Line dim>
                {connected ? 'Connected now.' : 'This is the saved copy of that read. Nothing is being read now; Inspect live reads again.'}
              </Line>
            </>
          ) : (
            <Line dim>Not read yet. Inspect live reads every contract in the list at one block.</Line>
          )}
        </Source>
        <Source state={!history ? undefined : history.complete ? 'live' : 'saved'} title="Who holds roles">
          {!history ? (
            <Line dim>Found during Inspect live{events ? `, through the ${events.label} subgraph` : ''}.</Line>
          ) : history.source === 'subgraph' ? (
            <>
              <Line>Subgraph {history.subgraph.name}</Line>
              <Line dim>
                It indexed {count(history.grants, 'grant')} and {count(history.revocations, 'revocation')} up to block{' '}
                {history.toBlock.toLocaleString()}
                {history.subgraph.behind ? `, ${count(history.subgraph.behind, 'block')} behind the chain read` : ''}. It only says who to check: each
                of the {count(history.holdersToConfirm, 'holder')} it named was then asked of the chain with hasRole, and the chain’s answer is what
                is shown.
              </Line>
              {history.subgraph.hasIndexingErrors && <Line>The indexer reports an error, so its list may stop early.</Line>}
              {!!history.contractsOutsideInventory?.length && (
                <Line>
                  It also has role events from {count(history.contractsOutsideInventory.length, 'contract')} missing from the address list:{' '}
                  {history.contractsOutsideInventory.map(short).join(', ')}
                </Line>
              )}
            </>
          ) : (
            <>
              <Line>Event scan through the RPC</Line>
              <Line dim>
                {history.complete
                  ? 'Every block was read.'
                  : `Incomplete: ${count(history.unreadRanges || 0, 'block range')} could not be read, so a role holder outside the address list may be missing.`}
              </Line>
              <Line dim>
                {history.subgraphError
                  ? `The subgraph could not be used: ${history.subgraphError}`
                  : events
                    ? 'Inspect live again to find role holders through the events subgraph instead.'
                    : 'This deployment lists no events subgraph.'}
              </Line>
            </>
          )}
        </Source>
        {sources?.abis && (
          <Source state="live" title="How contracts are read">
            <Line dim>
              Function lists come from this checkout’s build for {count(sources.abis.local, 'contract')}, and from verified ABIs on Sourcify for{' '}
              {sources.abis.verified}.
            </Line>
          </Source>
        )}
        <Source state={issues ? 'saved' : 'live'} title="What counts as an issue">
          <Line dim>
            {sources?.checks ? `${count(sources.checks.expectedGrants, 'required grant')} come` : 'Required grants come'} from rules written in this
            repository (server/roles.js), and pointers are compared with the address list above. An issue means the chain disagrees with one of those
            two, not that the chain is wrong.
          </Line>
          <Line>{issues ? `${count(issues, 'issue')} now.` : 'No disagreements now.'}</Line>
        </Source>
      </Stack>
    </Modal>
  )
}
