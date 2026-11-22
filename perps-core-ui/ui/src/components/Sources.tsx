import { httpUrl, short } from '../lib/state'
import type { Profile, Snapshot } from '../types'
import { Accordion, Modal, Stack, Text } from '@mantine/core'
import type { ReactNode } from 'react'

const Line = ({ children, dim }: { children: ReactNode; dim?: boolean }) => (
  <Text size="sm" c={dim ? 'dimmed' : undefined} className="break">
    {children}
  </Text>
)
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

const scopeCaveat = 'External contracts without local ABIs and non-enumerable mapping keys may need additional inventory.'
const legacyLegend = 'Red = missing required connection; gray = unavailable or optional unset.'

function recordedCoverage(value: Snapshot['coverage'], hasRoleHistory: boolean) {
  if (typeof value !== 'string' || !value.trim()) return { scope: [], methodNote: '' }
  const text = value.trim().replace(legacyLegend, '').trim()
  const current = /^(Roles, role administrators, setup getters, hooks, allowlists, facets and proxy implementations) are read at block \d+\.\s*/.exec(text)
  if (!current || !text.endsWith(scopeCaveat)) return { scope: text ? [text] : [], methodNote: '' }

  const method = text.slice(current[0].length, -scopeCaveat.length).trim()
  const methodNote = !hasRoleHistory
    ? method
    : method.includes('scanned from genesis')
    ? 'Role event history scanned from genesis.'
    : method.includes('inventory and enumerable holders were still checked')
      ? 'Inventory and enumerable holders were still checked.'
      : ''
  return { scope: [`The scan reads ${current[1].toLowerCase()}.`, scopeCaveat], methodNote }
}

/** Read identity and coverage gaps first; the supporting evidence opens on request. */
export function Sources({
  opened,
  onClose,
  onExit,
  showScope = false,
  profile,
  snapshot,
  connected,
  issues,
}: {
  opened: boolean
  onClose: () => void
  onExit?: () => void
  showScope?: boolean
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
    events = profile.links?.find((l) => /event/i.test(l.label || '')),
    unavailable = snapshot?.edges.filter((edge) => edge.status === 'unknown').length || 0,
    partial = !!history && (history.complete === false || Object.values(history).some((entry: any) => entry?.complete === false))
  const { scope, methodNote } = recordedCoverage(snapshot?.coverage, !!history)
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      onExitTransitionEnd={onExit}
      returnFocus={!onExit}
      title="Inspection sources"
      size="lg"
      classNames={{ content: 'inspection-dialog-content' }}
    >
      <Stack gap="sm">
        <div aria-label="Inspection read">
          {snapshot ? (
            <>
              <Line>
                {connected ? 'Connected' : 'Saved inspection'} · Block {snapshot.blockNumber.toLocaleString()}
              </Line>
              <Line dim>
                {new Date(snapshot.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                {chain?.rpc ? ` · ${chain.rpc}` : ''}
              </Line>
            </>
          ) : (
            <Line dim>Not inspected yet. Inspect live to read this deployment.</Line>
          )}
        </div>
        {(unavailable > 0 || partial || history?.subgraph?.behind || history?.subgraph?.hasIndexingErrors || (snapshot && !history)) && (
          <Stack gap={4} aria-label="Coverage gaps">
            {unavailable > 0 && <Line>{count(unavailable, 'connection read')} unavailable.</Line>}
            {partial && (
              <Line>
                Role history incomplete{history.unreadRanges ? ` · ${count(history.unreadRanges, 'unread block range')}` : ''}. Unlisted holders may
                be missing.
              </Line>
            )}
            {!!history?.subgraph?.behind && <Line>Role events stop {count(history.subgraph.behind, 'block')} before this inspection.</Line>}
            {history?.subgraph?.hasIndexingErrors && <Line>The role indexer reports errors; its list may stop early.</Line>}
            {snapshot && !history && <Line>Role history coverage was not recorded.</Line>}
          </Stack>
        )}
        <Accordion multiple defaultValue={showScope && scope.length ? ['scope'] : []}>
          {!!scope.length && (
            <Accordion.Item value="scope">
              <Accordion.Control>What the scan read</Accordion.Control>
              <Accordion.Panel>
                <Stack gap={4}>
                  {scope.map((line) => <Line key={line}>{line}</Line>)}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          )}
          <Accordion.Item value="inventory">
            <Accordion.Control>Address list</Accordion.Control>
            <Accordion.Panel>
              <Stack gap={4}>
                <Line>
                  {inventory.entry ? `addresses.json · ${inventory.entry}` : 'Imported profile'} · {count(inventory.contracts, 'contract')}
                  {inventory.candidates ? ` · ${count(inventory.candidates, 'possible role holder')}` : ''}
                </Line>
                {inventory.checked && <Line dim>Last checked on chain: {inventory.checked}</Line>}
                {chain?.discovered ? (
                  <Line dim>{count(chain.discovered, 'additional address', 'additional addresses')} discovered on chain.</Line>
                ) : null}
                {sourceUrl && (
                  <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
                    View address list source ↗
                  </a>
                )}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="history">
            <Accordion.Control>Role holder evidence</Accordion.Control>
            <Accordion.Panel>
              <Stack gap={4}>
                {methodNote && <Line dim>{methodNote}</Line>}
                {!history ? (
                  <Line dim>Inspect live finds role holders{events ? ` through the ${events.label} subgraph` : ' through RPC events'}.</Line>
                ) : history.source === 'subgraph' ? (
                  <>
                    <Line>Subgraph {history.subgraph.name}</Line>
                    <Line dim>
                      {count(history.grants, 'grant')} · {count(history.revocations, 'revocation')} · through block {history.toBlock.toLocaleString()}
                    </Line>
                    <Line dim>{count(history.holdersToConfirm, 'candidate holder')} checked on chain with hasRole.</Line>
                    {!!history.contractsOutsideInventory?.length && (
                      <Line dim>
                        Events also reference {count(history.contractsOutsideInventory.length, 'unlisted contract')}:{' '}
                        {history.contractsOutsideInventory.map(short).join(', ')}
                      </Line>
                    )}
                  </>
                ) : (
                  <>
                    <Line>Event scan through the RPC{history.complete ? ' · complete' : ' · incomplete'}.</Line>
                    {history.subgraphError ? (
                      <Line dim>Subgraph unavailable: {history.subgraphError}</Line>
                    ) : (
                      <Line dim>{events ? 'Inspect live can retry the events subgraph.' : 'No events subgraph is configured.'}</Line>
                    )}
                  </>
                )}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
          {sources?.abis && (
            <Accordion.Item value="interfaces">
              <Accordion.Control>Contract interfaces</Accordion.Control>
              <Accordion.Panel>
                <Line dim>
                  {count(sources.abis.local, 'contract')} read with this checkout’s build · {sources.abis.verified} with verified Sourcify ABIs.
                </Line>
              </Accordion.Panel>
            </Accordion.Item>
          )}
          <Accordion.Item value="checks">
            <Accordion.Control>Review rules</Accordion.Control>
            <Accordion.Panel>
              <Stack gap={4}>
                <Line dim>
                  {sources?.checks ? count(sources.checks.expectedGrants, 'required grant') : 'Required grants'}: server/roles.js. Expected pointers:
                  the address list. A finding means the chain differs from those expectations.
                </Line>
                <Line>{snapshot ? `${count(issues, 'disagreement')} in this inspection.` : 'Inspect live to check these expectations.'}</Line>
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Stack>
    </Modal>
  )
}
