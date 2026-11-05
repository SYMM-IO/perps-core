import { duration, relations, rolesOn, settingsOf } from '../src/lib/inspect'
import type { ContractNode } from '../src/types'
import { expect, test } from 'vitest'

const node = (id: string, kind = 'external', address = `0x${id.padEnd(40, '0')}`): ContractNode => ({ id, kind, name: id, address, state: {} })
const edge = (from: string, to: string, label: string, kind: string, status = 'verified') => ({ from, to, label, kind, status })

test('dependencies are one row per contract, and power and code are not among them', () => {
  const edges = [
    edge('core', 'pool', 'getInvalidBridgedAmountsPool', 'pointer'),
    edge('core', 'pool', 'getSoftLiquidationPenaltyCollector', 'pointer'),
    edge('core', 'token', 'getCollateral', 'pointer', 'mismatch'),
    edge('core', 'partyB', 'Registered solver', 'membership'),
    edge('partyB', 'core', 'symmioAddress', 'pointer'),
    edge('admin', 'core', 'PAUSER_ROLE', 'role'),
    edge('admin', 'core', 'Diamond owner', 'ownership'),
    edge('core', 'facet', 'ControlFacet', 'facet'),
    { ...edge('core', 'old', 'getOld', 'pointer', 'removed'), removed: true },
  ]
  const { pointsTo, referencedBy } = relations(node('core', 'core'), edges)
  // The one that disagrees with the address book comes first.
  expect(pointsTo.map((r) => [r.other, r.labels, r.state, r.link])).toEqual([
    ['token', ['getCollateral'], 'missing', 'core>token'],
    ['pool', ['getInvalidBridgedAmountsPool', 'getSoftLiquidationPenaltyCollector'], 'set', 'core>pool'],
    ['partyB', ['Registered solver'], 'set', 'core>partyB'],
  ])
  expect(referencedBy.map((r) => [r.other, r.labels])).toEqual([['partyB', ['symmioAddress']]])
})

test('roles are listed with who holds each and who can grant it, a missing grant first', () => {
  const edges = [
    edge('admin', 'core', 'SETTER_ROLE', 'role'),
    edge('bot', 'core', 'SETTER_ROLE', 'role'),
    edge('admin', 'core', 'Admin · SETTER_ROLE', 'roleAdmin'),
    edge('admin', 'core', 'Admin · IDLE_ROLE', 'roleAdmin'),
    edge('layer', 'core', 'REGISTRAR_ROLE', 'role', 'missing'),
    edge('core', 'other', 'OUTGOING_ROLE', 'role'),
  ]
  expect(rolesOn(node('core', 'core'), edges)).toEqual([
    { role: 'REGISTRAR_ROLE', holders: [{ id: 'layer', missing: true }], admins: [] },
    // A role with an admin and no holder is still a role someone can hand out.
    { role: 'IDLE_ROLE', holders: [], admins: ['admin'] },
    {
      role: 'SETTER_ROLE',
      holders: [
        { id: 'admin', missing: false },
        { id: 'bot', missing: false },
      ],
      admins: ['admin'],
    },
  ])
})

test('a duration is only read as one when the name says it is, and the number allows it', () => {
  expect(duration('deallocateCooldown', '259200')).toBe('3 d')
  expect(duration('liquidationTimeout', 9000)).toBe('2 h 30 min')
  expect(duration('forceCloseCooldowns', ['300', '45'])).toBe('5 min, 45 s')
  expect(duration('forceCloseMinSigPeriod', '90061')).toBe('1 d 1 h')
  // Zero is "off", not a length of time, and an amount is not seconds whatever its size.
  expect(duration('deallocateCooldown', '0')).toBeUndefined()
  expect(duration('getBalanceLimitPerUser', '259200')).toBeUndefined()
  expect(duration('coolDownsOfMA', ['300', 'never'])).toBeUndefined()
})

test('settings leave out what the map already shows and what the code fixed', () => {
  const token = node('token', 'token', '0x' + 'a'.repeat(40))
  const core = {
    ...node('core', 'core'),
    state: {
      collateral: token.address.toUpperCase().replace('0X', '0x'),
      treasury: '0x' + 'b'.repeat(40),
      signer: '0x' + '0'.repeat(40),
      paused: false,
      roles: {},
      setup: {},
      UPGRADE_INTERFACE_VERSION: '5.0.0',
    },
  }
  expect(settingsOf(core, [core, token])).toEqual({
    // The treasury is an address nothing on the map stands for, so it stays; an unset address says so.
    settings: [
      ['treasury', '0x' + 'b'.repeat(40)],
      ['signer', 'not set'],
      ['paused', false],
    ],
    constants: [['UPGRADE_INTERFACE_VERSION', '5.0.0']],
  })
})
