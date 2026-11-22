import { power } from '../../../shared/graph-insight.js'
import { edgeKind, isImplementation, linkId } from '../../../shared/graph-model.js'
import { duration, groupRoles, relations, rolesOn, settingsOf, type Relation } from '../lib/inspect'
import { httpUrl, isIssue, issueText, kindName, pretty, short, UPGRADEABLE } from '../lib/state'
import type { Connection, ContractNode, Link, Profile } from '../types'
import { Address, Collection, JsonView, StatusBadge } from './Common'
import { PowerList, type PowerResult } from './MapPanels'
import { Accordion, Badge, Button, Group, Stack, Text, Title, UnstyledButton, VisuallyHidden } from '@mantine/core'
import { ArrowLeft, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

const nameOf = (nodes: ContractNode[], id: string) => nodes.find((n) => n.id === id)?.name || (id.startsWith('address:') ? short(id.slice(8)) : id)
// Moving between a contract and one of its links replaces the panel. The control that was
// activated disappears with it, so the heading of whatever renders next takes the focus.
let handoff = false
export const focusHeading = () => {
  handoff = true
  setTimeout(() => (handoff = false), 1000)
}
function useHeadingFocus(key: string) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!handoff) return
    handoff = false
    heading.current?.focus()
  }, [key])
  return heading
}

function IssueRow({ edge, nodes, onOpen }: { edge: Connection; nodes: ContractNode[]; onOpen: () => void }) {
  const unavailable = edge.status === 'unknown'
  const label = unavailable
    ? `${edge.label} read unavailable`
    : edge.status === 'missing' && edgeKind(edge) === 'pointer'
      ? `${edge.label} missing`
      : issueText(edge)
  return (
    <UnstyledButton className="issue-row" data-unavailable={unavailable || undefined} onClick={onOpen}>
      <TriangleAlert size={14} aria-hidden />
      <span>
        {label}
        <small>
          {nameOf(nodes, edge.from)} → {nameOf(nodes, edge.to)}
        </small>
      </span>
    </UnstyledButton>
  )
}

function ContractIssues({ edges, nodes, open }: { edges: Connection[]; nodes: ContractNode[]; open: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const active = edges.filter((edge) => !edge.removed && edge.diff !== 'removed')
  const confirmed = active.filter(isIssue)
  const missing = confirmed.filter((edge) => edge.status === 'missing')
  const mismatched = confirmed.filter((edge) => edge.status === 'mismatch')
  const unavailable = active.filter((edge) => edge.status === 'unknown')
  const issues = [...missing, ...mismatched, ...unavailable]
  if (!issues.length) return null

  return (
    <Stack gap={6}>
      <Text size="xs" c="dimmed">
        {[missing.length && `${missing.length} missing`, mismatched.length && `${mismatched.length} mismatched`, unavailable.length && `${unavailable.length} unavailable`]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {(expanded ? issues : issues.slice(0, 3)).map((edge, i) => (
        <IssueRow edge={edge} nodes={nodes} key={i} onOpen={() => open(linkId(edge.from, edge.to))} />
      ))}
      {issues.length > 3 && (
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          className="inspector-issues-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show fewer issues' : `Show all ${issues.length} issues`}
        </Button>
      )}
    </Stack>
  )
}

/**
 * One contract, arranged by the questions asked of it: is anything wrong, who can change it, what can it
 * change, what does it depend on, how is it set up. Relationships are grouped by
 * what they mean, so a number beside a name never has to be decoded, and the raw read is kept last.
 */
export function Inspector({
  node,
  nodes,
  edges,
  profile,
  changes = [],
  onPrepare,
  prepareDisabled = false,
  onSelect,
  onLink,
  onPower,
}: {
  node?: ContractNode
  nodes: ContractNode[]
  edges: Connection[]
  links?: Link[]
  profile: Profile
  /** Entries from the change list that concern this contract. */
  changes?: any[]
  onPrepare: (node: ContractNode) => void
  /** Set while another operation runs, so a plan is not prepared from a snapshot being replaced. */
  prepareDisabled?: boolean
  onSelect: (id: string) => void
  onLink: (id: string) => void
  /** Lights the map with what this contract can change, or who can change it. */
  onPower?: (id: string, direction: 'over' | 'under') => void
}) {
  const heading = useHeadingFocus(node?.id || '')
  const [byRole, setByRole] = useState(false),
    [raw, setRaw] = useState(false)
  if (!node)
    return (
      <Text c="dimmed" p="md">
        Select a contract to inspect it.
      </Text>
    )
  const own = edges.filter((e) => e.from === node.id || e.to === node.id),
    internals = own.filter((e) => isImplementation(edgeKind(e)))
  const supported = UPGRADEABLE.includes(node.kind)
  const under = power({ nodes, edges }, node.id, 'under') as PowerResult,
    over = power({ nodes, edges }, node.id, 'over') as PowerResult,
    reach = (result: PowerResult) => new Set(result.entries.map((e) => e.node)).size,
    roles = rolesOn(node, edges),
    { pointsTo, referencedBy } = relations(node, edges),
    { settings, constants } = settingsOf(node, nodes)
  const explorer = `${(httpUrl(profile.explorer) || 'https://blockscan.com').replace(/\/$/, '')}/address/`
  const safeOwners = node.kind === 'safe' ? edges.filter((e) => e.to === node.id && e.label === 'Safe owner') : []
  const technical = (
    [
      ['Address', node.address],
      ['Type', `${kindName(node.kind)}${node.kind === 'authority' ? (node.codeSize === 0 ? ' · EOA' : node.codeSize ? ' · contract' : '') : ''}`],
      ['Upgrade path', node.strategy],
      ['Implementation', node.implementation],
      ['Facets', node.state?.facets],
      ['Functions', node.state?.functions],
      ['Address book', node.listed ? 'Listed' : undefined],
      ['Status', node.status],
      ['Code', node.codeSize === 0 ? 'none' : node.codeSize ? `${Number(node.codeSize).toLocaleString()} bytes` : undefined],
      ['Code hash', node.codeHash],
      ['Implementation code hash', node.implementationCodeHash],
      ['Read at block', node.observedAt ? Number(node.observedAt).toLocaleString() : undefined],
      ['Interface from', node.abiCoverage?.source],
      ['Linked libraries', node.libraryCoverage],
      ['Built from', node.artifact],
      ['Also known as', node.aliases?.join(', ')],
      ...constants.map(([key, value]) => [key, String(value)]),
    ] as [string, unknown][]
  ).filter(([, value]) => value !== undefined && value !== null && value !== '')
  const open = (id: string) => {
    onLink(id)
    focusHeading()
  }
  const related = (rows: Relation[]) => (
    <Stack gap={0} className="inspector-relations">
      <Collection unit="contracts" attention={rows.some((r) => r.state === 'missing')}>
        {rows.map((r) => (
          <UnstyledButton
            key={`${r.other} ${nameOf(nodes, r.other)} ${r.labels.join(' ')}`}
            className="link-row"
            data-state={r.state}
            onClick={() => open(r.link)}
          >
            <span className="link-dot" aria-hidden />
            <span className="link-name">{nameOf(nodes, r.other)}</span>
            <span className="link-count" title={r.labels.join(', ')}>
              {r.labels.join(', ')}
            </span>
          </UnstyledButton>
        ))}
      </Collection>
    </Stack>
  )
  const onMap = (direction: 'over' | 'under') =>
    onPower && (
      <Button size="compact-xs" variant="subtle" color="gray" onClick={() => onPower(node.id, direction)}>
        Show on map
      </Button>
    )
  return (
    <Stack p="md" gap="sm" className="inspector" aria-label="Contract inspector">
      <div>
        <Title order={3} size="h4" tabIndex={-1} className="inspector-heading" ref={heading}>
          {node.name}
        </Title>
      </div>
      <Address value={node.address} href={explorer + node.address} compact />
      {node.state?.paused === true && (
        <Text size="xs" className="inspector-exception">
          Paused
        </Text>
      )}
      {node.status === 'no-code' && (
        <Text size="xs" className="inspector-exception">
          No contract code
        </Text>
      )}
      <ContractIssues key={`issues:${node.id}`} edges={own} nodes={nodes} open={open} />
      {node.removed && (
        <Text size="sm" c="dimmed">
          Gone since the previous inspection. Shown because the map is drawing changes.
        </Text>
      )}
      {!!safeOwners.length && (
        <details className="inspector-safe-owners">
          <summary>
            Safe owners · {String(node.state.threshold ?? '?')} of {safeOwners.length}
          </summary>
          <Stack gap={0}>
            <Collection unit="owners">
              {safeOwners.map((e) => (
                <UnstyledButton
                  key={`${e.from} ${nameOf(nodes, e.from)}`}
                  className="link-row"
                  onClick={() => {
                    onSelect(e.from)
                    focusHeading()
                  }}
                >
                  <span className="link-dot" aria-hidden />
                  <span className="link-name">{nameOf(nodes, e.from)}</span>
                </UnstyledButton>
              ))}
            </Collection>
          </Stack>
        </details>
      )}
      {/* Remounted per contract, so its sections start collapsed. */}
      <Accordion key={node.id} multiple variant="default" className="inspector-accordion" defaultValue={[]}>
        {!!changes.length && (
          <Accordion.Item value="changes">
            <Accordion.Control>Recent changes</Accordion.Control>
            <Accordion.Panel>
              <Stack gap={6}>
                {changes.slice(0, 40).map((d, i) => (
                  <div key={i}>
                    <Text size="xs" c="dimmed" className="break">
                      {d.node === node.id ? d.field : `${nameOf(nodes, d.node)} · ${d.field}`}
                    </Text>
                    <Text size="xs" className="break">
                      {d.before === null ? 'new' : pretty(d.before?.value ?? d.before?.status ?? d.before)} →{' '}
                      {d.after === null ? 'gone' : pretty(d.after?.value ?? d.after?.status ?? d.after)}
                    </Text>
                  </div>
                ))}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        )}
        {(!!reach(under) || !!roles.length) && (
          <Accordion.Item value="under">
            <Accordion.Control>Who can change it</Accordion.Control>
            <Accordion.Panel>
              <Group justify="space-between" mb={8} wrap="nowrap">
                {!!roles.length && (
                  <div className="seg seg-small" role="group" aria-label="List by">
                    <button type="button" aria-pressed={!byRole} onClick={() => setByRole(false)}>
                      By address
                    </button>
                    <button type="button" aria-pressed={byRole} onClick={() => setByRole(true)}>
                      By role
                    </button>
                  </div>
                )}
                {onMap('under')}
              </Group>
              {byRole && roles.length ? (
                <Stack gap={10} className="inspector-roles">
                  {groupRoles(roles).map((g) => (
                    <div key={g.roles.join('|')} className="role-row">
                      <div className="role-names">
                        {g.roles.map((role) => (
                          <code key={role}>{role}</code>
                        ))}
                      </div>
                      <div>
                        {g.holders.length ? (
                          <Collection unit="holders" flow="inline" attention={g.holders.some((h) => h.missing)}>
                            {g.holders.map((h) => (
                              <UnstyledButton
                                key={`${h.id} ${nameOf(nodes, h.id)}`}
                                className="role-holder"
                                data-missing={h.missing || undefined}
                                onClick={() => open(linkId(h.id, node.id))}
                              >
                                {nameOf(nodes, h.id)}
                                {h.missing ? ' · not granted' : ''}
                              </UnstyledButton>
                            ))}
                          </Collection>
                        ) : (
                          <Text span size="xs" c="dimmed">
                            held by nobody
                          </Text>
                        )}
                      </div>
                      {!!g.admins.length && (
                        <Text size="xs" c="dimmed">
                          granted by {[...new Set(g.admins)].map((id) => nameOf(nodes, id)).join(', ')}
                        </Text>
                      )}
                    </div>
                  ))}
                </Stack>
              ) : reach(under) ? (
                <PowerList result={under} nodes={nodes} onLink={open} />
              ) : (
                <Text size="sm" c="dimmed">
                  No role holder or owner was confirmed on chain.
                </Text>
              )}
            </Accordion.Panel>
          </Accordion.Item>
        )}
        {!!reach(over) && (
          <Accordion.Item value="over">
            <Accordion.Control>What it can change</Accordion.Control>
            <Accordion.Panel>
              <Group justify="flex-end" mb={4}>
                {onMap('over')}
              </Group>
              <PowerList result={over} nodes={nodes} onLink={open} />
            </Accordion.Panel>
          </Accordion.Item>
        )}
        {!!pointsTo.length && (
          <Accordion.Item value="points">
            <Accordion.Control>Points to</Accordion.Control>
            <Accordion.Panel>{related(pointsTo)}</Accordion.Panel>
          </Accordion.Item>
        )}
        {!!referencedBy.length && (
          <Accordion.Item value="referenced">
            <Accordion.Control>Referenced by</Accordion.Control>
            <Accordion.Panel>{related(referencedBy)}</Accordion.Panel>
          </Accordion.Item>
        )}
        {!!internals.length && (
          <Accordion.Item value="internals">
            <Accordion.Control>Facets & libraries</Accordion.Control>
            <Accordion.Panel>
              <Stack gap={0}>
                {internals.map((e, i) => {
                  const other = e.from === node.id ? e.to : e.from
                  return (
                    <UnstyledButton
                      key={`${other}-${i}`}
                      className="link-row"
                      data-state={isIssue(e) ? 'missing' : 'set'}
                      onClick={() => {
                        onSelect(other)
                        focusHeading()
                      }}
                    >
                      <span className="link-dot" aria-hidden />
                      <span className="link-name">{nameOf(nodes, other)}</span>
                      <span className="link-count">{edgeKind(e)}</span>
                    </UnstyledButton>
                  )
                })}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        )}
        {!!settings.length && (
          <Accordion.Item value="settings">
            <Accordion.Control>Settings</Accordion.Control>
            <Accordion.Panel>
              <Stack gap="xs" className="inspector-settings">
                {settings.map(([key, value]) => {
                  const time = duration(key, value)
                  return (
                    <div key={key}>
                      <Text size="xs" c="dimmed">
                        {key}
                      </Text>
                      {typeof value === 'object' && value !== null && !time ? (
                        <JsonView value={value} />
                      ) : (
                        <Text size="sm" className="break">
                          {time || (typeof value === 'boolean' ? (value ? 'yes' : 'no') : pretty(value))}
                          {time && (
                            <Text span size="xs" c="dimmed">
                              {' '}
                              · {Array.isArray(value) ? value.join(', ') : String(value)} s
                            </Text>
                          )}
                        </Text>
                      )}
                    </div>
                  )
                })}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        )}
        <Accordion.Item value="technical">
          <Accordion.Control>Technical details</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              {technical.map(([key, value]) => (
                <div key={key}>
                  <Text size="xs" c="dimmed">
                    {key}
                  </Text>
                  <Text size="xs" className="break">
                    {String(value)}
                  </Text>
                </div>
              ))}
              {!!node.errors?.length && (
                <div>
                  <Text size="xs" c="dimmed">
                    Could not be read
                  </Text>
                  {node.errors.map((error, i) => (
                    <Text size="xs" className="break" key={i}>
                      {error}
                    </Text>
                  ))}
                </div>
              )}
              <Button size="compact-xs" variant="subtle" color="gray" w="fit-content" aria-expanded={raw} onClick={() => setRaw(!raw)}>
                {raw ? 'Hide raw data' : 'Show raw data'}
              </Button>
              {raw && <JsonView value={Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'diamond'))} />}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      {supported && (
        <Button size="compact-sm" variant="default" w="fit-content" disabled={prepareDisabled} onClick={() => onPrepare(node)}>
          Prepare upgrade
        </Button>
      )}
    </Stack>
  )
}

/**
 * What the sidebar shows with nothing selected: every connection that needs attention, each opening the
 * link that carries it — or confirmation that everything is set, with the way back to the map.
 */
export function InspectorSummary({
  issues,
  nodes,
  onSelect,
  onLink,
}: {
  issues: Connection[]
  nodes: ContractNode[]
  onSelect: (id: string) => void
  onLink: (id: string) => void
}) {
  const heading = useHeadingFocus('summary')
  const open = (e: Connection) => {
    const anchor = nodes.some((n) => n.id === e.from) ? e.from : e.to
    onSelect(anchor)
    onLink(linkId(e.from, e.to))
    focusHeading()
  }
  return (
    <Stack p="md" gap="sm" className="inspector" aria-label="Deployment summary">
      <Title order={3} size="h4" tabIndex={-1} className="inspector-heading" ref={heading}>
        {issues.length ? `${issues.length} ${issues.length === 1 ? 'needs' : 'need'} attention` : 'No missing connections found'}
      </Title>
      {issues.length ? (
        <Stack gap={6}>
          {issues.map((e, i) => <IssueRow edge={e} nodes={nodes} key={i} onOpen={() => open(e)} />)}
        </Stack>
      ) : (
        <Text size="sm" c="dimmed">
          No missing connections were found in this inspection. Choose a contract to review its connections and read coverage.
        </Text>
      )}
    </Stack>
  )
}

/** Every individual connection carried by one drawn link. */
export function LinkDetail({
  link,
  nodes,
  block,
  back,
  backId,
  explorer,
  onSelect,
  onClose,
}: {
  link: Link
  nodes: ContractNode[]
  block?: number
  back?: string
  backId?: string
  explorer?: string
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const heading = useHeadingFocus(link.id)
  const rolesOnly = link.edges.every((edge) => edge.kind === 'role')
  const backIsEndpoint = backId === link.from || backId === link.to
  const endpoint = (id: string) => (
    <UnstyledButton
      className="connection-endpoint"
      onClick={() => {
        onSelect(id)
        focusHeading()
      }}
    >
      {nameOf(nodes, id)}
    </UnstyledButton>
  )
  return (
    <Stack className="inspector connection-inspector" aria-label="Connection detail">
      <Button
        variant="subtle"
        color="gray"
        size="compact-xs"
        w="fit-content"
        className="connection-nav-button connection-back"
        leftSection={<ArrowLeft size={13} aria-hidden />}
        aria-label={back && backIsEndpoint ? `Back to ${back}` : undefined}
        onClick={() => {
          onClose()
          if (back) focusHeading()
        }}
      >
        {back && !backIsEndpoint ? `Back to ${back}` : 'Back'}
      </Button>
      <Title order={3} size="h5" tabIndex={-1} className="inspector-heading" ref={heading}>
        {endpoint(link.from)}{' '}
        {rolesOnly ? (
          <span className="connection-relation">roles checked on</span>
        ) : (
          <>
            <span className="connection-relation" aria-hidden>→</span>
            <VisuallyHidden>to</VisuallyHidden>
          </>
        )}{' '}
        {endpoint(link.to)}
      </Title>
      <Group gap="xs">
        <Text size="sm">
          {link.count} {rolesOnly ? (link.count === 1 ? 'role' : 'roles') : link.count === 1 ? 'connection' : 'connections'}
        </Text>
        {!!link.missing && (
          <Badge variant="light" color="red">
            {link.missing} {link.missing === 1 ? 'needs' : 'need'} attention
          </Badge>
        )}
        {!!link.unknown && (
          <Badge variant="light" color="gray">
            {link.unknown} unavailable
          </Badge>
        )}
      </Group>
      <Stack gap={0}>
        <Collection unit={rolesOnly ? 'roles' : 'connections'} attention={link.missing > 0}>
          {link.edges.map((e, i) => (
            <div key={`${e.label}-${i}`} className="connection-detail">
              <Group gap="xs" align="start" className="connection-detail-status">
                <StatusBadge status={e.status} />
                <Text size="xs" className="break" fw={600}>
                  {e.label}
                </Text>
                {e.diff && (
                  <Badge variant="light" color={e.diff === 'removed' ? 'gray' : 'yellow'}>
                    {{ added: 'new', changed: 'changed', removed: 'gone' }[e.diff as string]}
                  </Badge>
                )}
              </Group>
              {/* On a link to a stack, each connection says which of the stacked addresses it belongs to. */}
              {(e.fromMember || e.toMember) && (
                <Text size="xs" c="dimmed">
                  {short(nodes.find((n) => n.id === (e.fromMember || e.toMember))?.address || '')}
                </Text>
              )}
              {e.kind === 'role' && typeof e.actual === 'boolean' ? (
                <Text size="xs" c="dimmed">
                  hasRole = {String(e.actual)}
                </Text>
              ) : (
                e.basis && (
                  <Text size="xs" c="dimmed">
                    {e.basis}
                  </Text>
                )
              )}
              {/* A recorded grant is optional history; hasRole above is the membership evidence. */}
              {e.grant?.tx && (
                <details className="role-grant-history">
                  <summary>Grant transaction</summary>
                  <Text size="xs" c="dimmed" className="break">
                    Granted{e.grant.timestamp ? ` ${new Date(e.grant.timestamp * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : ''}{' '}
                    in{' '}
                    {httpUrl(explorer) ? (
                      <a
                        href={`${httpUrl(explorer)!.replace(/\/$/, '')}/tx/${e.grant.tx}`}
                        aria-label={`View grant transaction ${e.grant.tx} on explorer`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {short(e.grant.tx)} ↗
                      </a>
                    ) : (
                      short(e.grant.tx)
                    )}
                  </Text>
                </details>
              )}
              {!(e.kind === 'role' && typeof e.actual === 'boolean') && (isIssue(e) || typeof e.actual === 'string') && e.actual !== undefined && (
                <Text size="xs" className="break">
                  Read: {String(e.actual)}
                </Text>
              )}
              {isIssue(e) && e.expected !== undefined && (
                <Text size="xs" className="break">
                  Expected: {String(e.expected)}
                </Text>
              )}
            </div>
          ))}
        </Collection>
      </Stack>
      {block !== undefined && (
        <Text size="xs" c="dimmed">
          Read at block {block.toLocaleString()}
        </Text>
      )}
    </Stack>
  )
}
