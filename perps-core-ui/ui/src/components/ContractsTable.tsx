import { isImplementation } from '../../../shared/graph-model.js'
import { httpUrl, kindName } from '../lib/state'
import type { ContractNode } from '../types'
import { Address, Empty } from './Common'
import { Box, Button, Checkbox, Group, Stack, Table, Text, TextInput } from '@mantine/core'
import { ChevronRight, Search, SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

const LAYERS = ['core', 'accountLayer', 'instantLayer', 'express']
const contractNameCollator = new Intl.Collator(undefined, { numeric: true })
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
    return changed
      ? { label: `${changed} of ${comparison.total} ${comparison.total === 1 ? 'facet' : 'facets'} changed`, changed: true }
      : { label: 'Matches', changed: false }
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
  const searchInput = useRef<HTMLInputElement>(null)
  const tableRegion = useRef<HTMLDivElement>(null)
  const [moreContracts, setMoreContracts] = useState(false)
  const activeFilters = Number(includeImplementations) + Number(includeReferences)
  const q = query.trim().toLowerCase()
  const matches = (node: ContractNode) => `${node.name} ${node.address} ${kindName(node.kind)} ${node.kind}`.toLowerCase().includes(q)
  const visible = nodes
    .filter((node) => (includeImplementations || !isImplementation(node.kind)) && (includeReferences || !reference(node)) && matches(node))
    .sort((a, b) => LAYERS.indexOf(a.kind) - LAYERS.indexOf(b.kind) || contractNameCollator.compare(a.name, b.name) || a.id.localeCompare(b.id))
  const groups = GROUPS.map((group) => ({ ...group, nodes: visible.filter((node) => groupOf(node) === group.id) })).filter(
    (group) => group.nodes.length,
  )
  const hiddenMatch = !!q && !visible.length && nodes.some(matches)
  const hasContracts = visible.length > 0
  useEffect(() => {
    const region = tableRegion.current
    if (!region) return
    const measure = () => setMoreContracts(region.scrollHeight - region.scrollTop - region.clientHeight > 2)
    const observer = new ResizeObserver(measure)
    observer.observe(region)
    const table = region.querySelector('table')
    if (table) observer.observe(table)
    region.addEventListener('scroll', measure, { passive: true })
    measure()
    return () => {
      observer.disconnect()
      region.removeEventListener('scroll', measure)
    }
  }, [hasContracts])
  const showAll = () => {
    setIncludeReferences(true)
    setIncludeImplementations(true)
  }
  const clearSearch = () => {
    setQuery('')
    searchInput.current?.focus()
  }
  const name = (node: ContractNode, inTable: boolean) => (
    <Button
      size="compact-sm"
      variant="subtle"
      color="gray"
      className="contract-name"
      rightSection={inTable ? <ChevronRight size={16} aria-hidden color="var(--mantine-color-dimmed)" /> : undefined}
      onClick={() => onInspect(node)}
      aria-label={`Inspect ${node.name}`}
    >
      {node.name}
    </Button>
  )
  const state = (node: ContractNode) =>
    liveState(node) ? (
      <Text size="xs" c={node.state?.paused === true || node.status === 'no-code' ? 'var(--warn)' : 'dimmed'}>
        {liveState(node)}
      </Text>
    ) : null
  const source = (node: ContractNode) => {
    const s = sourceState(comparison[node.id])
    if (!s.changed) return null
    return (
      <Text size="xs" c="var(--warn)">
        {s.label}
      </Text>
    )
  }
  const normalized = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
  const identity = (node: ContractNode, inTable: boolean, children?: ReactNode) => (
    <div className="contracts-identity">
      {name(node, inTable)}
      <Group gap="xs" className="contracts-description">
        {!['external', 'authority'].includes(node.kind) && !normalized(node.name).includes(normalized(kindName(node.kind))) && (
          <Text size="xs" c="dimmed">
            {kindName(node.kind)}
          </Text>
        )}
        {state(node)}
        {source(node)}
        {children}
      </Group>
    </div>
  )
  const address = (node: ContractNode) => (
    <Address value={node.address} compact href={httpUrl(explorer) ? `${httpUrl(explorer)!.replace(/\/$/, '')}/address/${node.address}` : undefined} />
  )
  return (
    <Stack className="contracts-view" gap="sm">
      <Group className="contracts-toolbar" gap="md" align="end">
        <TextInput
          ref={searchInput}
          type="search"
          label="Find by name, address or type"
          aria-label="Find by name, address or type"
          placeholder="Find by name, address or type"
          autoCapitalize="none"
          spellCheck={false}
          leftSection={<Search size={15} aria-hidden />}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <Button
          variant="default"
          className="inventory-filters-toggle"
          leftSection={<SlidersHorizontal size={14} aria-hidden />}
          aria-expanded={filtersOpen}
          aria-controls={filtersOpen ? 'contracts-filters' : undefined}
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          Filters{activeFilters ? ` · ${activeFilters}` : ''}
        </Button>
        <Text size="xs" c="dimmed" role="status" ml="auto">
          {visible.length} {visible.length === 1 ? 'contract' : 'contracts'} shown
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
          <div ref={tableRegion} className="contracts-table-wrap" role="region" aria-label="Contracts inventory" tabIndex={0}>
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
                      <Table.Td>{identity(node, true)}</Table.Td>
                      <Table.Td>{address(node)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              ))}
            </Table>
          </div>
          {moreContracts && (
            <Text className="contracts-scroll-cue" c="dimmed" size="xs">
              Scroll for more contracts
            </Text>
          )}
          <div className="contract-cards">
            {groups.map((group) => (
              <section key={group.id} className="contract-card-group" aria-label={group.label}>
                <Text component="h3" className="contracts-group-label">
                  {group.label}
                </Text>
                {group.nodes.map((node) => (
                  <article className="contract-card" key={node.id}>
                    {identity(node, false, <Box ml="auto" maw="100%">{address(node)}</Box>)}
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
            q && !hiddenMatch ? (
              <Button variant="default" className="contracts-recovery" onClick={clearSearch}>
                Clear search
              </Button>
            ) : nodes.length > 0 ? (
              <Button variant="default" className="contracts-recovery" onClick={showAll}>
                {hiddenMatch ? 'Search all addresses' : 'Show all addresses'}
              </Button>
            ) : undefined
          }
        >
          {q && !hiddenMatch && 'Nothing in this deployment matches, including facets and wallets.'}
        </Empty>
      )}
    </Stack>
  )
}
