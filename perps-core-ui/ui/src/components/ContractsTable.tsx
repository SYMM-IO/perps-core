import { isImplementation } from '../../../shared/graph-model.js'
import { httpUrl, kindName } from '../lib/state'
import type { ContractNode } from '../types'
import { Address, Empty } from './Common'
import { Button, Checkbox, Group, Stack, Table, Text, TextInput } from '@mantine/core'
import { Search, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'

const LAYERS = ['core', 'accountLayer', 'instantLayer', 'express']
const reference = (node: ContractNode) =>
  !isImplementation(node.kind) &&
  !node.listed &&
  (node.status === 'referenced' || node.id.startsWith('address:') || ['authority', 'safe', 'timelock', 'proxyAdmin'].includes(node.kind))
const groupOf = (node: ContractNode) =>
  isImplementation(node.kind) ? 'code' : reference(node) ? 'references' : LAYERS.includes(node.kind) ? 'layers' : 'services'
const GROUPS = [
  { id: 'layers', label: 'Core & layers' },
  { id: 'services', label: 'Services & integrations' },
  { id: 'references', label: 'Wallets & references' },
  { id: 'code', label: 'Facets & libraries' },
]
function sourceState(comparison: any) {
  if (!comparison) return { label: '', changed: false }
  if (comparison.kind === 'diamond') {
    const changed = comparison.total - comparison.matching
    return changed ? { label: `${changed} of ${comparison.total} facets changed`, changed: true } : { label: 'Matches', changed: false }
  }
  return comparison.matching ? { label: 'Matches', changed: false } : { label: 'Changed', changed: true }
}
// Only say something when it tells the operator more than "this address was read".
function liveState(node: ContractNode) {
  if (node.state?.paused === true) return 'Paused'
  return (
    ({ observed: '', 'no-code': 'No contract code', referenced: 'Referenced, not read' } as Record<string, string>)[node.status || ''] ?? node.status
  )
}
export function ContractsTable({
  nodes,
  comparison,
  explorer,
  onInspect,
}: {
  nodes: ContractNode[]
  comparison: Record<string, any>
  explorer?: string
  busy: boolean
  onInspect: (node: ContractNode) => void
  onPrepare: (node: ContractNode) => void
}) {
  const [query, setQuery] = useState(''),
    [filtersOpen, setFiltersOpen] = useState(false),
    [includeImplementations, setIncludeImplementations] = useState(false),
    [includeReferences, setIncludeReferences] = useState(false)
  const activeFilters = Number(includeImplementations) + Number(includeReferences)
  const q = query.trim().toLowerCase()
  const matches = (node: ContractNode) => `${node.name} ${node.address} ${kindName(node.kind)} ${node.kind}`.toLowerCase().includes(q)
  const visible = nodes
    .filter((node) => (includeImplementations || !isImplementation(node.kind)) && (includeReferences || !reference(node)) && matches(node))
    .sort((a, b) => LAYERS.indexOf(a.kind) - LAYERS.indexOf(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const groups = GROUPS.map((group) => ({ ...group, nodes: visible.filter((node) => groupOf(node) === group.id) })).filter(
    (group) => group.nodes.length,
  )
  const hiddenMatch = !!q && !visible.length && nodes.some(matches)
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
    liveState(node) ? (
      <Text size="xs" c={node.state?.paused === true || node.status === 'no-code' ? 'orange' : 'dimmed'}>
        {liveState(node)}
      </Text>
    ) : null
  const source = (node: ContractNode) => {
    const s = sourceState(comparison[node.id])
    if (!s.changed) return null
    return (
      <Text size="xs" c="orange">
        {s.label}
      </Text>
    )
  }
  const normalized = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
  const identity = (node: ContractNode) => (
    <div className="contracts-identity">
      {name(node)}
      <Group gap="xs" className="contracts-description">
        {!['external', 'authority'].includes(node.kind) && !normalized(node.name).includes(normalized(kindName(node.kind))) && (
          <Text size="xs" c="dimmed">
            {kindName(node.kind)}
          </Text>
        )}
        {state(node)}
        {source(node)}
      </Group>
    </div>
  )
  const address = (node: ContractNode) => (
    <Address value={node.address} compact href={httpUrl(explorer) ? `${httpUrl(explorer)!.replace(/\/$/, '')}/address/${node.address}` : undefined} />
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
        <Button
          variant={activeFilters ? 'light' : 'default'}
          leftSection={<SlidersHorizontal size={14} />}
          aria-expanded={filtersOpen}
          aria-controls={filtersOpen ? 'contracts-filters' : undefined}
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          Filters{activeFilters ? ` · ${activeFilters}` : ''}
        </Button>
        <Text size="xs" c="dimmed" role="status" ml="auto" className={!q && !activeFilters ? 'sr-only' : undefined}>
          {visible.length} {visible.length === 1 ? 'address' : 'addresses'}
        </Text>
      </Group>
      {filtersOpen && (
        <Group className="contracts-filters" id="contracts-filters" gap="lg">
          <Checkbox
            label="Include wallets & references"
            checked={includeReferences}
            onChange={(e) => setIncludeReferences(e.currentTarget.checked)}
          />
          <Checkbox
            label="Include facets & libraries"
            checked={includeImplementations}
            onChange={(e) => setIncludeImplementations(e.currentTarget.checked)}
          />
        </Group>
      )}
      {visible.length ? (
        <>
          <div className="contracts-table-wrap" role="region" aria-label="Contracts inventory" tabIndex={0}>
            <Table highlightOnHover stickyHeader className="contracts-table" verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Contract</Table.Th>
                  <Table.Th>Address</Table.Th>
                </Table.Tr>
              </Table.Thead>
              {groups.map((group) => (
                <Table.Tbody key={group.id}>
                  <Table.Tr className="contracts-group">
                    <Table.Th colSpan={2} scope="rowgroup">
                      {group.label}
                    </Table.Th>
                  </Table.Tr>
                  {group.nodes.map((node) => (
                    <Table.Tr key={node.id}>
                      <Table.Td>{identity(node)}</Table.Td>
                      <Table.Td>{address(node)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              ))}
            </Table>
          </div>
          <div className="contract-cards">
            {groups.map((group) => (
              <section key={group.id} className="contract-card-group" aria-label={group.label}>
                <Text component="h3" className="contracts-group-label">
                  {group.label}
                </Text>
                {group.nodes.map((node) => (
                  <article className="contract-card" key={node.id}>
                    {identity(node)}
                    {address(node)}
                  </article>
                ))}
              </section>
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
                if (!hiddenMatch) setQuery('')
                setIncludeReferences(true)
                setIncludeImplementations(true)
              }}
            >
              {hiddenMatch ? 'Search all addresses' : 'Show all addresses'}
            </Button>
          }
        />
      )}
    </Stack>
  )
}
