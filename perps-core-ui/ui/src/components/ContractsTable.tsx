import { isImplementation } from '../../../shared/graph-model.js'
import { kindName, UPGRADEABLE } from '../lib/state'
import type { ContractNode } from '../types'
import { Address, Empty } from './Common'
import { Badge, Button, Checkbox, Group, Stack, Table, Text, TextInput } from '@mantine/core'
import { Search } from 'lucide-react'
import { useState } from 'react'

const rank = (node: ContractNode) => (UPGRADEABLE.includes(node.kind) ? UPGRADEABLE.indexOf(node.kind) : 10)
function sourceState(comparison: any) {
  if (!comparison) return { label: '—', changed: false }
  if (comparison.kind === 'diamond') {
    const changed = comparison.total - comparison.matching
    return changed ? { label: `${changed} of ${comparison.total} facets changed`, changed: true } : { label: 'Matches', changed: false }
  }
  return comparison.matching ? { label: 'Matches', changed: false } : { label: 'Changed', changed: true }
}
// Only say something when it tells the operator more than "this address was read".
function liveState(node: ContractNode) {
  if (node.state?.facets) return `${node.state.facets} facets · ${node.state.functions} functions`
  return (
    ({ observed: '', 'no-code': 'No contract code', referenced: 'Referenced, not read' } as Record<string, string>)[node.status || ''] ?? node.status
  )
}
export function ContractsTable({
  nodes,
  comparison,
  busy,
  onInspect,
  onPrepare,
}: {
  nodes: ContractNode[]
  comparison: Record<string, any>
  busy: boolean
  onInspect: (node: ContractNode) => void
  onPrepare: (node: ContractNode) => void
}) {
  const [query, setQuery] = useState(''),
    [includeImplementations, setIncludeImplementations] = useState(false)
  const compared = Object.keys(comparison || {}).length > 0
  const visible = nodes
    .filter(
      (node) =>
        (includeImplementations || !isImplementation(node.kind)) &&
        `${node.name} ${node.address} ${node.kind}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const upgradeable = (node: ContractNode) => UPGRADEABLE.includes(node.kind)
  const name = (node: ContractNode) => (
    <Button
      size="compact-sm"
      variant="subtle"
      color="gray"
      className="contract-name"
      onClick={() => onInspect(node)}
      aria-label={`Inspect ${node.name}`}
    >
      {node.name}
    </Button>
  )
  const state = (node: ContractNode) =>
    node.status === 'no-code' ? (
      <Badge variant="light" color="orange">
        No contract code
      </Badge>
    ) : (
      <Text size="sm" c={node.state?.facets ? undefined : 'dimmed'}>
        {liveState(node) || '—'}
      </Text>
    )
  const source = (node: ContractNode) => {
    const s = sourceState(comparison[node.id])
    return (
      <Text size="sm" c={s.changed ? 'orange' : 'dimmed'}>
        {s.label}
      </Text>
    )
  }
  const path = (node: ContractNode) => (
    <Text size="sm" c={upgradeable(node) ? undefined : 'dimmed'}>
      {node.strategy || 'Inspect only'}
    </Text>
  )
  const prepare = (node: ContractNode) =>
    upgradeable(node) && (
      <Button size="compact-sm" variant="default" disabled={busy} aria-label={`Prepare ${node.name} upgrade`} onClick={() => onPrepare(node)}>
        Prepare
      </Button>
    )
  return (
    <Stack className="contracts-view" gap="sm">
      <Group className="contracts-toolbar" gap="md">
        <TextInput
          type="search"
          aria-label="Find contract"
          placeholder="Find by name, address or type"
          leftSection={<Search size={15} />}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <Checkbox
          label="Include facets & libraries"
          checked={includeImplementations}
          onChange={(e) => setIncludeImplementations(e.currentTarget.checked)}
        />
        <Text size="xs" c="dimmed" role="status" ml="auto">
          {visible.length} of {nodes.length} addresses{compared ? '' : ' · Compare source to see what changed'}
        </Text>
      </Group>
      {visible.length ? (
        <>
          <div className="contracts-table-wrap" role="region" aria-label="Contracts inventory" tabIndex={0}>
            <Table highlightOnHover stickyHeader className="contracts-table" verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Contract</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Address</Table.Th>
                  <Table.Th>On chain</Table.Th>
                  {compared && <Table.Th>Checkout</Table.Th>}
                  <Table.Th>Upgrade path</Table.Th>
                  <Table.Th>
                    <span className="sr-only">Actions</span>
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visible.map((node) => (
                  <Table.Tr key={node.id}>
                    <Table.Td>{name(node)}</Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {kindName(node.kind)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Address value={node.address} />
                    </Table.Td>
                    <Table.Td>{state(node)}</Table.Td>
                    {compared && <Table.Td>{source(node)}</Table.Td>}
                    <Table.Td>{path(node)}</Table.Td>
                    <Table.Td className="contracts-action">{prepare(node)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
          <div className="contract-cards">
            {visible.map((node) => (
              <article className="contract-card" key={node.id}>
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  {name(node)}
                  <Text size="xs" c="dimmed">
                    {kindName(node.kind)}
                  </Text>
                </Group>
                <Address value={node.address} />
                <Group gap="md">
                  {state(node)}
                  {compared && source(node)}
                </Group>
                <Group justify="space-between" wrap="nowrap">
                  {path(node)}
                  {prepare(node)}
                </Group>
              </article>
            ))}
          </div>
        </>
      ) : (
        <Empty
          title="No matching contracts"
          action={
            <Button
              variant="default"
              onClick={() => {
                setQuery('')
                setIncludeImplementations(true)
              }}
            >
              Show all addresses
            </Button>
          }
        />
      )}
    </Stack>
  )
}
