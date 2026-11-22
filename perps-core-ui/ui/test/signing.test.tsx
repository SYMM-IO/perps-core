import { Signing } from '../src/components/Signing'
import type { PlanRecord } from '../src/types'
import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ api: {} as any }))
vi.mock('../src/api', () => ({ useWorkbench: () => mock.api }))
const address = '0x1111111111111111111111111111111111111111'
const hash = (digit: string) => '0x' + digit.repeat(64)
const phases = ['confirmed', 'failed', 'submitted', 'awaiting-signature', 'pending']
function plan(): PlanRecord {
  return {
    status: 'prepared',
    plan: {
      kind: 'peripheral',
      id: 'a'.repeat(64),
      scope: 'verifier',
      chainId: 31337,
      authority: address,
      deployer: address,
      blockers: [],
      actions: phases.map((state, index) => ({
        id: `step-${index}`,
        label: `${state} action`,
        phase: 'configure',
        sender: address,
        data: '0x',
        value: '0',
      })),
    },
    journal: Object.fromEntries(
      phases
        .slice(0, 4)
        .map((status, index) => [`step-${index}`, { id: `step-${index}`, status, sender: address, hash: hash(String(index + 1)), request: {} }]),
    ),
  } as unknown as PlanRecord
}
function open(record = plan()) {
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <Signing record={record} adapter="system" />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

beforeEach(() => {
  window.ethereum = undefined
  localStorage.clear()
  mock.api = {
    busy: false,
    engine: { prompts: [] },
    system: { profile: { chainId: 31337, nodes: [] }, profiles: [{ id: 'local', chainId: 31337, explorer: 'https://explorer.example' }] },
    request: vi.fn(),
    run: vi.fn(),
  }
})

it('collapses completed work while every unconfirmed outcome stays in the main execution list', () => {
  open()
  const completed = screen.getByText('Completed steps (1)').closest('details')!
  expect(completed.open).toBe(false)
  expect(screen.getByText('confirmed action').closest('details')).toBe(completed)
  expect(screen.getByText(hash('1')).closest('details')).toBe(completed)
  for (const state of ['failed', 'submitted', 'awaiting-signature', 'pending'])
    expect(screen.getByText(`${state} action`).closest('details')).toBeNull()
  for (const label of ['Reverted', 'Awaiting confirmation', 'Outcome not recorded', 'Pending'])
    expect(screen.getByText(label).closest('details')).toBeNull()
  expect(screen.getByText(hash('2')).closest('details')).toBeNull()
  expect(screen.getByText(hash('3')).closest('details')).toBeNull()
  expect(screen.getByText(hash('4')).closest('details')).toBeNull()
  expect(screen.getByRole('button', { name: 'Recover a pending transaction' })).toBeTruthy()
  const current = screen.getByText('failed action').closest('li')!
  expect(current.getAttribute('data-step')).toBe('2')
  expect(current.textContent).toContain(address)
  const links = screen.getAllByRole('link', { name: /^View .* transaction on explorer$/, hidden: true })
  expect(links.map((link) => (link as HTMLAnchorElement).href)).toContain(`https://explorer.example/tx/${hash('1')}`)
})

it('keeps a live wallet request visible rather than grouping it with completed work', () => {
  mock.api.engine.prompts = [{ id: 'step-3', planId: 'a'.repeat(64) }]
  open()
  expect(screen.getByText('Waiting for wallet').closest('details')).toBeNull()
  expect(screen.getByText('Completed steps (1)').closest('details')!.open).toBe(false)
})

it('retains confirmed work in the disclosure when all steps are complete', () => {
  const record = plan()
  record.status = 'verified'
  record.journal = Object.fromEntries(
    phases.map((_, index) => [
      `step-${index}`,
      {
        id: `step-${index}`,
        status: 'confirmed',
        sender: address,
        hash: hash(String(index + 1)),
        request: {} as any,
      },
    ]),
  )
  open(record)
  expect(screen.getByText('Completed steps (5)').closest('details')!.open).toBe(false)
  expect(screen.getByText('5 of 5 steps done')).toBeTruthy()
  expect(screen.getByText('confirmed action')).toBeTruthy()
  expect(screen.getByText(hash('1'))).toBeTruthy()
})

it('connects and rechecks a browser wallet beside the plan checks', async () => {
  let connected = false
  const provider = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') {
        connected = true
        return [address]
      }
      return method === 'eth_accounts' ? (connected ? [address] : []) : '0x7a69'
    }),
  }
  window.ethereum = provider
  mock.api.run = vi.fn(async (_label: string, operation: () => Promise<unknown>) => operation())
  const record = plan()
  record.rehearsal = { status: 'passed' } as PlanRecord['rehearsal']
  open(record)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet' }))
  expect(await screen.findByText(/Connected wallet .* is the deployer/)).toBeTruthy()
  expect(provider.request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' })
  expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
})
