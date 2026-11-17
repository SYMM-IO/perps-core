import { isIssue, issueText } from '../lib/state'
import type { Connection, ContractNode, Profile, Snapshot } from '../types'
import { Button, Stack, Text, Title, UnstyledButton } from '@mantine/core'
import { ArrowUpRight, ChevronRight, TriangleAlert } from 'lucide-react'

const COMPONENT_KINDS = ['core', 'accountLayer', 'instantLayer', 'express', 'gasless', 'partyB', 'verifier']

/** A small maintenance starting point. The complete address book and topology remain in their own views. */
export function MaintenanceOverview({
  profile,
  snapshot,
  partial,
  onInspect,
  onIssue,
  onContracts,
}: {
  profile: Profile
  snapshot?: Snapshot
  partial: boolean
  onInspect: (node: ContractNode) => void
  onIssue: (edge: Connection) => void
  onContracts: () => void
}) {
  const nodes = snapshot?.nodes || profile.nodes,
    edges = snapshot?.edges || [],
    issues = edges.filter(isIssue),
    unavailable = edges.filter((edge) => edge.status === 'unknown').length,
    declared = profile.nodes.filter((node) => COMPONENT_KINDS.includes(node.kind)),
    components = (declared.length ? declared : profile.nodes)
      .slice()
      .sort((a, b) => COMPONENT_KINDS.indexOf(a.kind) - COMPONENT_KINDS.indexOf(b.kind))
      .slice(0, 6)
      .map((node) => nodes.find((observed) => observed.id === node.id) || node),
    name = (id: string) => nodes.find((node) => node.id === id)?.name || id.replace(/^address:/, '')
  return (
    <div className="maintenance-overview">
      <section className="maintenance-status" aria-label="Maintenance status">
        <Title order={1} size="h2">
          {!snapshot
            ? 'Start with a live inspection'
            : issues.length
              ? `${issues.length} ${issues.length === 1 ? 'connection needs' : 'connections need'} review`
              : 'No missing connections found'}
        </Title>
        <Text size="sm" c="dimmed">
          {!snapshot
            ? 'Inspect live to read this deployment, then choose a component to maintain.'
            : issues.length
              ? 'Review the findings below, or choose a component to inspect.'
              : 'In this inspection. Choose a component to inspect its setup and permissions.'}
        </Text>
        {snapshot && (unavailable > 0 || partial) && (
          <Text size="sm" c="dimmed">
            {[
              unavailable > 0 && `${unavailable} connection ${unavailable === 1 ? 'read was' : 'reads were'} unavailable`,
              partial && 'Role history is incomplete',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        )}
      </section>
      {!!issues.length && (
        <details className="maintenance-review">
          <summary>
            <TriangleAlert size={15} aria-hidden /> Review {issues.length === 1 ? 'connection' : `${issues.length} connections`}
          </summary>
          <Stack gap={0} mt="sm">
            {issues.map((edge, index) => (
              <UnstyledButton key={`${edge.from}-${edge.to}-${edge.label}-${index}`} className="issue-row" onClick={() => onIssue(edge)}>
                <span>
                  {issueText(edge)}
                  <small>
                    {name(edge.from)} → {name(edge.to)}
                  </small>
                </span>
                <ArrowUpRight size={14} aria-hidden />
              </UnstyledButton>
            ))}
          </Stack>
        </details>
      )}
      <section className="maintenance-contracts" aria-label="Deployment components">
        <Title order={2} size="h4">
          Choose a component
        </Title>
        <Stack gap={0} mt="sm">
          {components.map((node) => {
            return (
              <UnstyledButton
                key={node.id}
                className="maintenance-contract-row"
                aria-label={`Inspect ${node.name}${node.state?.paused === true ? ', paused' : ''}`}
                onClick={() => onInspect(node)}
              >
                <span>{node.name}</span>
                <span>
                  {node.state?.paused === true ? (
                    <Text span size="xs" className="component-status">
                      Paused
                    </Text>
                  ) : null}
                  <ChevronRight size={16} aria-hidden />
                </span>
              </UnstyledButton>
            )
          })}
        </Stack>
        <Button variant="subtle" color="gray" size="compact-sm" mt="md" onClick={onContracts}>
          Browse all contracts
        </Button>
      </section>
    </div>
  )
}
