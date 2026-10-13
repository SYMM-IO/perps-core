import { power } from '../../../shared/graph-insight.js'
import { edgeKind, isImplementation, linkId } from '../../../shared/graph-model.js'
import { duration, relations, rolesOn, settingsOf, type Relation } from '../lib/inspect'
import { httpUrl, isIssue, issueText, kindName, pretty, short, UPGRADEABLE } from '../lib/state'
import type { Connection, ContractNode, Link, Profile } from '../types'
import { Address, JsonView, StatusBadge } from './Common'
import { PowerList, type PowerResult } from './MapPanels'
import { Accordion, Badge, Button, Group, Stack, Text, Title, UnstyledButton } from '@mantine/core'
import { ArrowLeft, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

const nameOf = (nodes: ContractNode[], id: string) => nodes.find((n) => n.id === id)?.name || (id.startsWith('address:') ? short(id.slice(8)) : id)
// Moving between a contract and one of its links replaces the panel. The control that was
// activated disappears with it, so the heading of whatever renders next takes the focus.
let handoff = false
const focusHeading = () => {
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

/**
 * One contract, arranged by the questions asked of it: is anything wrong, who can change it, what can it
 * change, what does it depend on, how is it set up. Each fact appears once. Relationships are grouped by
 * what they mean, so a number beside a name never has to be decoded, and the raw read is kept last.
 */
export function Inspector({
  node,
  nodes,
  edges,
  profile,
  changes = [],
  onPrepare,
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
    internals = own.filter((e) => isImplementation(edgeKind(e))),
    issues = own.filter(isIssue)
  const supported = UPGRADEABLE.includes(node.kind)
  const under = power({ nodes, edges }, node.id, 'under') as PowerResult,
    over = power({ nodes, edges }, node.id, 'over') as PowerResult,
    reach = (result: PowerResult) => new Set(result.entries.map((e) => e.node)).size,
    roles = rolesOn(node, edges),
    { pointsTo, referencedBy } = relations(node, edges),
    { settings, constants } = settingsOf(node, nodes)
  const explorer = `${(httpUrl(profile.explorer) || 'https://blockscan.com').replace(/\/$/, '')}/address/`
  const facts = [
    node.state?.paused === true && 'Paused',
    node.state?.facets && `${node.state.facets} facets`,
    node.state?.functions && `${node.state.functions} functions`,
    node.codeSize === 0 && 'A wallet, not a contract',
    node.listed && 'In the address book',
  ].filter(Boolean)
  const technical = (
    [
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
    <Stack gap={0}>
      {rows.map((r) => (
        <UnstyledButton key={r.other} className="link-row" data-state={r.state} onClick={() => open(r.link)}>
          <span className="link-dot" aria-hidden />
          <span className="link-name">{nameOf(nodes, r.other)}</span>
          <span className="link-count" title={r.labels.join(', ')}>
            {r.labels.join(', ')}
          </span>
        </UnstyledButton>
      ))}
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
        <Text size="xs" c="dimmed">
          {kindName(node.kind)}
          {node.strategy && node.strategy !== 'Inspect only' ? ` · ${node.strategy}` : ''}
        </Text>
      </div>
      <Address value={node.address} href={explorer + node.address} />
      {node.implementation && (
        <div>
          <Text size="xs" c="dimmed">
            Implementation
          </Text>
          <Address value={node.implementation} href={explorer + node.implementation} />
        </div>
      )}
      {!!facts.length && (
        <Text size="xs" c="dimmed">
          {facts.join(' · ')}
        </Text>
      )}
      {node.removed && (
        <Text size="sm" c="dimmed">
          Gone since the previous inspection. Shown because the map is drawing changes.
        </Text>
      )}
      {issues.map((e, i) => (
        <UnstyledButton key={i} className="issue-row" onClick={() => open(linkId(e.from, e.to))}>
          <TriangleAlert size={14} aria-hidden />
          <span>
            {issueText(e)}
            <small>
              {nameOf(nodes, e.from)} → {nameOf(nodes, e.to)}
            </small>
          </span>
        </UnstyledButton>
      ))}
      {supported && <Button onClick={() => onPrepare(node)}>Prepare upgrade</Button>}
      {/* Remounted per contract, so each one opens on the section that matters for it. */}
      <Accordion
        key={node.id}
        multiple
        variant="default"
        className="inspector-accordion"
        defaultValue={[
          changes.length ? 'changes' : '',
          reach(under) ? 'under' : reach(over) ? 'over' : pointsTo.length ? 'points' : 'referenced',
        ].filter(Boolean)}
      >
        {!!changes.length && (
          <Accordion.Item value="changes">
            <Accordion.Control>Changed since the previous inspection ({changes.length})</Accordion.Control>
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
            <Accordion.Control>Who can change it ({reach(under)})</Accordion.Control>
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
                <Stack gap={10}>
                  {roles.map((r) => (
                    <div key={r.role} className="role-row">
                      <code>{r.role}</code>
                      <div>
                        {r.holders.length ? (
                          r.holders.map((h) => (
                            <UnstyledButton
                              key={h.id}
                              className="role-holder"
                              data-missing={h.missing || undefined}
                              onClick={() => open(linkId(h.id, node.id))}
                            >
                              {nameOf(nodes, h.id)}
                              {h.missing ? ' · not granted' : ''}
                            </UnstyledButton>
                          ))
                        ) : (
                          <Text span size="xs" c="dimmed">
                            held by nobody
                          </Text>
                        )}
                      </div>
                      {!!r.admins.length && (
                        <Text size="xs" c="dimmed">
                          granted by {[...new Set(r.admins)].map((id) => nameOf(nodes, id)).join(', ')}
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
            <Accordion.Control>What it can change ({reach(over)})</Accordion.Control>
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
            <Accordion.Control>Points to ({pointsTo.length})</Accordion.Control>
            <Accordion.Panel>{related(pointsTo)}</Accordion.Panel>
          </Accordion.Item>
        )}
        {!!referencedBy.length && (
          <Accordion.Item value="referenced">
            <Accordion.Control>Referenced by ({referencedBy.length})</Accordion.Control>
            <Accordion.Panel>{related(referencedBy)}</Accordion.Panel>
          </Accordion.Item>
        )}
        {!!internals.length && (
          <Accordion.Item value="internals">
            <Accordion.Control>Facets & libraries ({internals.length})</Accordion.Control>
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
            <Accordion.Control>Settings ({settings.length})</Accordion.Control>
            <Accordion.Panel>
              <Stack gap="xs">
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
    </Stack>
  )
}

/** Every individual connection carried by one drawn link. */
export function LinkDetail({
  link,
  nodes,
  block,
  back,
  explorer,
  onSelect,
  onClose,
}: {
  link: Link
  nodes: ContractNode[]
  block?: number
  back?: string
  explorer?: string
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const heading = useHeadingFocus(link.id)
  const endpoint = (id: string) => (
    <Button
      size="compact-sm"
      variant="default"
      onClick={() => {
        onSelect(id)
        focusHeading()
      }}
    >
      {nameOf(nodes, id)}
    </Button>
  )
  return (
    <Stack p="md" gap="sm" className="inspector" aria-label="Connection detail">
      <Button
        variant="subtle"
        color="gray"
        size="compact-xs"
        w="fit-content"
        leftSection={<ArrowLeft size={13} />}
        onClick={() => {
          onClose()
          focusHeading()
        }}
      >
        {back ? `Back to ${back}` : 'Back'}
      </Button>
      <Title order={3} size="h5" tabIndex={-1} className="inspector-heading" ref={heading}>
        {nameOf(nodes, link.from)} → {nameOf(nodes, link.to)}
      </Title>
      <Group gap={6}>
        {endpoint(link.from)}
        <Text size="xs" c="dimmed">
          grants or points to
        </Text>
        {endpoint(link.to)}
      </Group>
      <Group gap="xs">
        <Text size="sm">
          {link.count} {link.count === 1 ? 'connection' : 'connections'}
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
        {link.edges.map((e, i) => (
          <div key={`${e.label}-${i}`} className="connection-detail">
            <Group gap="xs" wrap="nowrap" align="start">
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
            {e.basis && (
              <Text size="xs" c="dimmed">
                {e.basis}
              </Text>
            )}
            {/* An indexer recorded when this role was granted; the chain read above is what says it is still held. */}
            {e.grant?.tx && (
              <Text size="xs" c="dimmed" className="break">
                Granted{e.grant.timestamp ? ` ${new Date(e.grant.timestamp * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : ''} in{' '}
                {httpUrl(explorer) ? (
                  <a href={`${httpUrl(explorer)!.replace(/\/$/, '')}/tx/${e.grant.tx}`} target="_blank" rel="noopener noreferrer">
                    {short(e.grant.tx)} ↗
                  </a>
                ) : (
                  short(e.grant.tx)
                )}
              </Text>
            )}
            {(isIssue(e) || typeof e.actual === 'string') && e.actual !== undefined && (
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
      </Stack>
      {block !== undefined && (
        <Text size="xs" c="dimmed">
          Read at block {block.toLocaleString()}
        </Text>
      )}
    </Stack>
  )
}
