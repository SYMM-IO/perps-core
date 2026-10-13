import { useWorkbench } from '../api'
import { download } from '../lib/state'
import type { PlanRecord } from '../types'
import { JsonView, StatusBadge } from './Common'
import { Accordion, Alert, Button, Code, Group, Modal, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import { toQuantity } from 'ethers'
import { useState } from 'react'

declare global {
  interface Window {
    ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<any> }
  }
}
export async function connectWallet() {
  if (!window.ethereum) throw new Error('No browser wallet found. Open this app in a browser with a wallet extension, or choose Ledger / Safe.')
  const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' })
  return address as string
}
export function WalletRequest() {
  const { engine, request, run, setError, refresh } = useWorkbench()
  const [signing, setSigning] = useState(false)
  const prompt = engine?.prompts?.[0]
  if (!prompt) return null
  async function sign() {
    if (!prompt || signing) return
    setSigning(true)
    setError('')
    try {
      const sender = await connectWallet()
      if (sender.toLowerCase() !== prompt.sender.toLowerCase()) throw new Error(`Switch your wallet to ${prompt.sender}`)
      const chainId = toQuantity(prompt.request.chainId)
      if ((await window.ethereum!.request({ method: 'eth_chainId' })).toLowerCase() !== chainId)
        await window.ethereum!.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
      const tx: Record<string, any> = { from: sender, data: prompt.request.data, ...(prompt.request.to ? { to: prompt.request.to } : {}) }
      for (const key of ['value', 'chainId', 'nonce', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'type'])
        if (prompt.request[key] !== undefined) tx[key] = toQuantity(prompt.request[key])
      tx.gas = toQuantity(prompt.request.gasLimit)
      await request('claim', { requestId: prompt.requestId })
      const hash = await window.ethereum!.request({ method: 'eth_sendTransaction', params: [tx] })
      sessionStorage.setItem(`workbench-tx-${prompt.id}`, hash)
      await request('respond', { requestId: prompt.requestId, hash })
    } catch (error: any) {
      if (error.code === 4001) {
        try {
          await request('respond', { requestId: prompt.requestId, rejected: true })
        } catch {}
      }
      setError(error.message || String(error))
    } finally {
      setSigning(false)
      await refresh()
    }
  }
  return (
    <Alert color="orange" title={prompt.label || 'Wallet signature required'}>
      <Stack gap="sm">
        <Text size="sm" className="break">
          Signer {prompt.sender} · Chain {prompt.request.chainId} · nonce {prompt.request.nonce}
        </Text>
        <Accordion>
          <Accordion.Item value="request">
            <Accordion.Control>Exact transaction</Accordion.Control>
            <Accordion.Panel>
              <JsonView value={prompt.request} />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
        <Group>
          <Button disabled={signing || prompt.claimed} onClick={sign}>
            {signing || prompt.claimed ? 'Waiting for wallet' : 'Review in wallet'}
          </Button>
          <Button variant="default" onClick={() => run('Pausing wallet request', () => request('pause-wallet', { requestId: prompt.requestId }))}>
            Stop waiting and recover
          </Button>
        </Group>
      </Stack>
    </Alert>
  )
}
export function Signing({ record, adapter }: { record: PlanRecord; adapter: 'diamond' | 'system' }) {
  const { engine, system, busy, run, request } = useWorkbench()
  const [deploymentMode, setDeploymentMode] = useState('browser'),
    [upgradeMode, setUpgradeMode] = useState('browser'),
    [ledgerPath, setLedgerPath] = useState("m/44'/60'/0'/0/0"),
    [confirmation, setConfirmation] = useState(''),
    [cancelOpen, setCancelOpen] = useState(false),
    [pending, setPending] = useState<string | null>(null),
    [hash, setHash] = useState('')
  const p = record.plan,
    prefix = adapter === 'system' ? 'system/' : '',
    chain = p.chainId || p.snapshot?.chainId,
    expected = `${chain}:${p.id.slice(0, 8)}`,
    active = adapter === 'system' ? system?.active : engine?.active,
    journal = Object.values(record.journal || {}),
    unresolved = journal.filter((j) => j.status !== 'confirmed')
  const ownActive = active?.input?.planId === p.id ? active : null
  const verified = record.status === 'verified',
    ready = record.rehearsal?.status === 'passed'
  return (
    <Stack>
      {!verified && ready && (
        <section className="panel">
          <Title order={3} size="h4" mb="md">
            Sign the reviewed upgrade
          </Title>
          <div className="two-columns">
            <Select
              label="Deploy with"
              data={[
                { value: 'browser', label: 'Browser wallet' },
                { value: 'ledger', label: 'Ledger' },
              ]}
              value={deploymentMode}
              onChange={(v) => setDeploymentMode(v || 'browser')}
              disabled={!!active}
            />
            <Select
              label="Authorize upgrade with"
              data={[
                { value: 'browser', label: 'Browser wallet' },
                { value: 'ledger', label: 'Ledger' },
                { value: 'safe', label: 'Safe · export batch' },
              ]}
              value={upgradeMode}
              onChange={(v) => setUpgradeMode(v || 'browser')}
              disabled={!!active}
            />
          </div>
          {[deploymentMode, upgradeMode].includes('ledger') && (
            <TextInput
              mt="md"
              label="Ledger derivation path"
              value={ledgerPath}
              onChange={(e) => setLedgerPath(e.currentTarget.value)}
              disabled={!!active}
            />
          )}
          <TextInput
            mt="md"
            label="Confirm chain and plan"
            description={`Type ${expected}. Each wallet transaction still requires your signature.`}
            value={confirmation}
            onChange={(e) => setConfirmation(e.currentTarget.value)}
            autoComplete="off"
            disabled={!!active}
          />
          <Button
            mt="md"
            disabled={busy || !!active || !!p.blockers?.length || confirmation.trim() !== expected}
            onClick={() =>
              run('Starting upgrade', () =>
                request(`${prefix}execute`, { id: p.id, deploymentMode, upgradeMode, ledgerPath, confirmation: confirmation.trim() }),
              )
            }
          >
            Start upgrade
          </Button>
        </section>
      )}
      <section className="panel">
        <Title order={3} size="h4">
          Transactions
        </Title>
        {journal.length ? (
          <div className="table-scroll">
            <Table>
              <Table.Tbody>
                {journal.map((j) => (
                  <Table.Tr key={j.id}>
                    <Table.Td>{j.component || p.actions?.find((a: any) => a.id === j.id)?.label || j.id}</Table.Td>
                    <Table.Td>
                      <Code className="break">{j.hash || 'Wallet outcome not recorded'}</Code>
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge status={j.status} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        ) : (
          <Text c="dimmed" size="sm" mt="sm">
            No transactions submitted.
          </Text>
        )}
        {active && !ownActive && <Alert mt="sm">Another task is active. Open its saved plan in History to continue it.</Alert>}
        {ownActive?.waitingFor && <Alert mt="sm">{ownActive.waitingFor}</Alert>}
        {ownActive?.lastError && (
          <Alert mt="sm" color="red">
            {ownActive.lastError}
          </Alert>
        )}
        <Group mt="md">
          {ownActive && (
            <>
              <Button
                variant="default"
                disabled={busy || active.runner?.running}
                onClick={() => run('Resuming upgrade', () => request(`${prefix}resume`, {}))}
              >
                Continue task
              </Button>
              <Button color="red" variant="subtle" disabled={busy || active.runner?.running} onClick={() => setCancelOpen(true)}>
                Cancel task
              </Button>
            </>
          )}
          {adapter === 'diamond' && record.safe && (
            <Button variant="default" onClick={() => download(record.safe!.transactionBuilder, `safe-${p.id.slice(0, 8)}.json`)}>
              Download Safe batch
            </Button>
          )}
          {adapter === 'system' && ready && (
            <Button
              variant="default"
              disabled={busy}
              onClick={() =>
                run('Exporting Safe calls', async () => {
                  download((await request(`system/safe?id=${p.id}`)).transactionBuilder, `safe-${p.scope}.json`)
                  return true
                })
              }
            >
              Export Safe calls
            </Button>
          )}
        </Group>
      </section>
      {!!unresolved.length && (
        <Accordion variant="contained">
          <Accordion.Item value="recovery">
            <Accordion.Control>Recover a pending transaction</Accordion.Control>
            <Accordion.Panel>
              <Stack>
                <Text size="sm" c="dimmed">
                  Attach the wallet hash. The signer, nonce, chain and exact calldata must match.
                </Text>
                <Select
                  label="Pending action"
                  data={unresolved.map((j) => ({ value: j.id, label: j.component || j.id }))}
                  value={pending || unresolved[0]?.id}
                  onChange={setPending}
                />
                <TextInput label="Transaction hash" value={hash} onChange={(e) => setHash(e.currentTarget.value)} placeholder="0x…" />
                <Button
                  disabled={!/^0x[\da-f]{64}$/i.test(hash) || busy}
                  onClick={() =>
                    run('Reconciling transaction', () => {
                      const actionId = pending || unresolved[0].id,
                        prompt = engine?.prompts.find((p) => p.id === actionId)
                      return prompt
                        ? request('respond', { requestId: prompt.requestId, hash })
                        : request(`${prefix}attach`, { id: p.id, actionId, hash })
                    })
                  }
                >
                  Reconcile transaction
                </Button>
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
      <Modal opened={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel this upgrade task?">
        <Text size="sm">This stops new work and reconciles submitted transactions. Confirmed transactions remain on chain.</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setCancelOpen(false)}>
            Keep task
          </Button>
          <Button
            color="red"
            onClick={() => {
              setCancelOpen(false)
              void run('Cancelling task', () => request(`${prefix}cancel`, {}))
            }}
          >
            Cancel task
          </Button>
        </Group>
      </Modal>
    </Stack>
  )
}
