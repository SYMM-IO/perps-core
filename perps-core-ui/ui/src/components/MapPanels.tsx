import { short } from '../lib/state'
import type { ContractNode, Link } from '../types'
import { Button, Stack, Text, Title, UnstyledButton } from '@mantine/core'
import { ArrowLeft } from 'lucide-react'

/** What `power()` in shared/graph-insight.js returns. */
export interface PowerResult {
  root: string
  direction: 'over' | 'under'
  entries: { node: string; via: string[]; holds: string[]; grants: string[]; owns: string[]; link: string }[]
  nodes: Set<string>
  links: Set<string>
}
export interface StackNode extends ContractNode {
  stack: true
  members: ContractNode[]
  summary: string
}
const nameOf = (nodes: ContractNode[], id: string) => nodes.find((n) => n.id === id)?.name || (id.startsWith('address:') ? short(id.slice(8)) : id)
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Several addresses drawn as one node because they are wired the same way: who they are and what each has. */
export function StackDetail({
  stack,
  links,
  nodes,
  onSelect,
  onLink,
  onExpand,
}: {
  stack: StackNode
  links: Link[]
  nodes: ContractNode[]
  onSelect: (id: string) => void
  onLink: (id: string) => void
  onExpand: () => void
}) {
  const own = links.filter((l) => l.from === stack.id || l.to === stack.id),
    size = stack.members.length,
    sameName = new Set(stack.members.map((m) => m.name)).size === 1
  return (
    <Stack p="md" gap="sm" className="inspector" aria-label="Stack of addresses">
      <div>
        <Title order={3} size="h4" className="inspector-heading">
          {stack.name}
        </Title>
        <Text size="xs" c="dimmed">
          {size} addresses with exactly the same connections, drawn as one
        </Text>
      </div>
      <Button variant="default" onClick={onExpand}>
        Show them separately
      </Button>
      <div>
        <Text size="xs" c="dimmed" mb={4}>
          Each one has
        </Text>
        <Stack gap={0}>
          {own.map((l) => {
            const outgoing = l.from === stack.id,
              each = l.count / size
            return (
              <UnstyledButton key={l.id} className="link-row" data-state={l.state} onClick={() => onLink(l.id)}>
                <span className="link-dot" aria-hidden />
                <span className="link-name">
                  <small>{outgoing ? 'to' : 'from'}</small> {nameOf(nodes, outgoing ? l.to : l.from)}
                </span>
                <span className="link-count">{each === 1 ? l.edges[0].label : each}</span>
              </UnstyledButton>
            )
          })}
        </Stack>
      </div>
      <div>
        <Text size="xs" c="dimmed" mb={4}>
          Addresses
        </Text>
        <Stack gap={0}>
          {stack.members.map((m) => (
            <UnstyledButton key={m.id} className="link-row" onClick={() => onSelect(m.id)}>
              <span className="link-name">
                <code>{short(m.address)}</code>
              </span>
              {!sameName && <span className="link-count">{m.name}</span>}
            </UnstyledButton>
          ))}
        </Stack>
        <Text size="xs" c="dimmed" mt={6}>
          Choosing one draws it on its own and opens it here.
        </Text>
      </div>
    </Stack>
  )
}

/** The rows of an answer: what is held directly first, then what comes through a Safe, timelock or proxy admin. */
export function PowerList({ result, nodes, onLink }: { result: PowerResult; nodes: ContractNode[]; onLink: (id: string) => void }) {
  const groups = new Map<string, PowerResult['entries']>()
  for (const entry of result.entries) {
    const key = entry.via.map((id) => nameOf(nodes, id)).join(' → ')
    groups.set(key, [...(groups.get(key) || []), entry])
  }
  return (
    <>
      {[...groups].map(([via, entries]) => (
        <div key={via}>
          {(via || groups.size > 1) && (
            <Text size="xs" c="dimmed" mb={4}>
              {via ? `Through ${via}` : 'Directly'}
            </Text>
          )}
          <Stack gap={0}>
            {entries.map((e) => (
              <UnstyledButton key={`${e.node}|${via}`} className="link-row" onClick={() => onLink(e.link)}>
                <span className="link-name">{nameOf(nodes, e.node)}</span>
                <span className="power-tags">
                  {!!e.owns.length && <b>owns</b>}
                  {!!e.holds.length && <span title={e.holds.join(', ')}>holds {e.holds.length}</span>}
                  {!!e.grants.length && <span title={e.grants.join(', ')}>can grant {e.grants.length}</span>}
                </span>
              </UnstyledButton>
            ))}
          </Stack>
        </div>
      ))}
    </>
  )
}

/** The answer to "what can this address change?" or "who can change this contract?", nearest first. */
export function PowerDetail({
  result,
  nodes,
  onLink,
  onDirection,
  onClose,
}: {
  result: PowerResult
  nodes: ContractNode[]
  onLink: (id: string) => void
  onDirection: (direction: 'over' | 'under') => void
  onClose: () => void
}) {
  const name = nameOf(nodes, result.root),
    over = result.direction === 'over',
    reached = new Set(result.entries.map((e) => e.node)).size
  return (
    <Stack p="md" gap="sm" className="inspector" aria-label="Who can change what">
      <Button variant="subtle" color="gray" size="compact-xs" w="fit-content" leftSection={<ArrowLeft size={13} />} onClick={onClose}>
        Back to {name}
      </Button>
      <Title order={3} size="h5" className="inspector-heading">
        {over ? `What ${name} can change` : `Who can change ${name}`}
      </Title>
      <div className="seg" role="group" aria-label="Which way to look">
        <button type="button" aria-pressed={over} onClick={() => onDirection('over')}>
          Can change
        </button>
        <button type="button" aria-pressed={!over} onClick={() => onDirection('under')}>
          Changed by
        </button>
      </div>
      <Text size="sm">
        {reached ? (over ? count(reached, 'contract') : count(reached, 'address', 'addresses')) : over ? 'Nothing' : 'Nobody'}
        <Text span c="dimmed" size="xs">
          {' '}
          · by roles held, roles it can grant, and ownership, as confirmed on chain
        </Text>
      </Text>
      <PowerList result={result} nodes={nodes} onLink={onLink} />
      <Text size="xs" c="dimmed">
        A role admin can give that role to any address, itself included, so it counts. The search continues through Safes, timelocks and proxy admins
        to whoever controls them. Roles that an expected grant is missing for do not count.
      </Text>
    </Stack>
  )
}
