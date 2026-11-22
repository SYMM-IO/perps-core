import { isIssue, issueText } from '../lib/state'
import type { Connection, ContractNode, Profile, Snapshot } from '../types'
import { Button, Stack, Text, Title, UnstyledButton } from '@mantine/core'
import { ArrowUpRight, ChevronRight, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'

const COMPONENT_KINDS = ['core', 'accountLayer', 'instantLayer', 'express', 'gasless', 'partyB', 'verifier']

/** A small maintenance starting point. The complete address book and topology remain in their own views. */
export function MaintenanceOverview({
  profile,
  snapshot,
  inspectionLabel,
  partial,
  inspectDisabled,
  missingEndpoint,
  onInspectLive,
  onInspect,
  onIssue,
  onContracts,
}: {
  profile: Profile
  snapshot?: Snapshot
  inspectionLabel: string
  partial: boolean
  inspectDisabled: boolean
  missingEndpoint: boolean
  onInspectLive: () => void
  onInspect: (node: ContractNode) => void
  onIssue: (edge: Connection) => void
  onContracts: () => void
}) {
  const statusHeading = useRef<HTMLHeadingElement>(null)
  const inlineInspect = useRef<HTMLButtonElement>(null)
  const transferFocus = useRef(false)

  useEffect(() => {
    const relinquishFocus = (event: FocusEvent) => {
      if (event.target !== inlineInspect.current) transferFocus.current = false
    }
    document.addEventListener('focusin', relinquishFocus)
    return () => document.removeEventListener('focusin', relinquishFocus)
  }, [])

  useLayoutEffect(() => {
    // Disabling the pending button can return focus to the document body.
    if (snapshot && transferFocus.current && document.activeElement === document.body) {
      statusHeading.current?.focus({ preventScroll: true })
    }
    if (snapshot || !inspectDisabled) transferFocus.current = false
  }, [snapshot, inspectDisabled])

  const nodes = snapshot?.nodes || profile.nodes,
    edges = snapshot?.edges || [],
    issues = edges.filter(isIssue),
    unavailable = edges.filter((edge) => edge.status === 'unknown').length,
    declared = profile.nodes.filter((node) => COMPONENT_KINDS.includes(node.kind)),
    components = (declared.length ? declared : profile.nodes)
      .slice()
      .sort((a, b) => COMPONENT_KINDS.indexOf(a.kind) - COMPONENT_KINDS.indexOf(b.kind))
      .slice(0, 6)
      .map((node) => {
        const observed = snapshot?.nodes.find((candidate) => candidate.id === node.id)
        return { node: observed || node, paused: observed?.state?.paused === true }
      }),
    name = (id: string) => nodes.find((node) => node.id === id)?.name || id.replace(/^address:/, '')
  return (
    <div className="maintenance-overview">
      <section className="maintenance-status" aria-label="Maintenance status">
        <Title ref={statusHeading} order={1} size="h2" tabIndex={-1}>
          {!snapshot
            ? 'Start with a live inspection'
            : issues.length
              ? `${issues.length} ${issues.length === 1 ? 'connection needs' : 'connections need'} review`
              : 'No missing connections found'}
        </Title>
        <Text size="sm" c="dimmed">
          {snapshot
            ? `${inspectionLabel} · ${new Date(snapshot.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · Block ${snapshot.blockNumber.toLocaleString()}`
            : 'Inspect live to read this deployment, then choose a component to maintain.'}
        </Text>
        {!snapshot && (
          <>
            <Button
              ref={inlineInspect}
              variant="filled"
              size="sm"
              mt="sm"
              leftSection={<RefreshCw size={14} />}
              disabled={inspectDisabled}
              onClick={(event) => {
                transferFocus.current = event.currentTarget === document.activeElement
                onInspectLive()
              }}
            >
              Inspect live
            </Button>
            {missingEndpoint && (
              <Text size="sm" c="dimmed" mt="xs">
                Add a read-only RPC endpoint in Deployment settings.
              </Text>
            )}
          </>
        )}
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
          <Stack gap="xs" mt="sm">
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
          {components.map(({ node, paused }) => {
            return (
              <UnstyledButton
                key={node.id}
                className="maintenance-contract-row"
                aria-label={`Inspect ${node.name}${paused ? ', paused' : ''}`}
                onClick={() => onInspect(node)}
              >
                <span>{node.name}</span>
                <span>
                  {paused ? (
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
        <Button variant="subtle" color="gray" size="compact-sm" mt="md" className="maintenance-browse" onClick={onContracts}>
          Browse all contracts
        </Button>
      </section>
    </div>
  )
}
