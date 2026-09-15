import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveWindow, scopeFor, isInScope, type SearchScope } from '../src/deals/scope.js'
import { normalizeAvailability, type AvailabilityRecord } from '../src/types.js'
import { parseConfig } from '../src/config.js'
import { makeAvailability, type AvailabilityOverrides } from './helpers/fixtures.js'

function rec(over: AvailabilityOverrides = {}, direction: 'outbound' | 'return' = 'outbound'): AvailabilityRecord {
  const r = normalizeAvailability(makeAvailability(over), direction)
  assert.ok(r, 'fixture should normalize')
  return r
}

const SCOPE: SearchScope = scopeFor(
  { origins: ['YYZ', 'ORD'], destinations: ['NRT', 'HND'] },
  { startDate: '2026-08-15', endDate: '2027-08-05' },
)

test('outbound and return legs of a configured pair are both in scope', () => {
  assert.ok(isInScope(rec({ origin: 'YYZ', destination: 'NRT', date: '2026-11-05' }, 'outbound'), SCOPE))
  assert.ok(isInScope(rec({ origin: 'NRT', destination: 'YYZ', date: '2026-11-16' }, 'return'), SCOPE))
})

test('right airports, wrong stored direction is excluded', () => {
  // Same physical pair as the outbound case above, but stored as a return —
  // geometrically it only satisfies the outbound rule.
  assert.equal(isInScope(rec({ origin: 'YYZ', destination: 'NRT', date: '2026-11-05' }, 'return'), SCOPE), false)
  assert.equal(isInScope(rec({ origin: 'NRT', destination: 'YYZ', date: '2026-11-16' }, 'outbound'), SCOPE), false)
})

test('an airport outside the configured grid is excluded on either end', () => {
  assert.equal(isInScope(rec({ origin: 'YYZ', destination: 'ICN', date: '2026-11-05' }, 'outbound'), SCOPE), false)
  assert.equal(isInScope(rec({ origin: 'JFK', destination: 'NRT', date: '2026-11-05' }, 'outbound'), SCOPE), false)
})

test('date window is inclusive on both ends', () => {
  const inGrid = { origin: 'YYZ', destination: 'NRT' } satisfies AvailabilityOverrides
  assert.equal(isInScope(rec({ ...inGrid, date: '2026-08-14' }, 'outbound'), SCOPE), false)
  assert.ok(isInScope(rec({ ...inGrid, date: '2026-08-15' }, 'outbound'), SCOPE))
  assert.ok(isInScope(rec({ ...inGrid, date: '2027-08-05' }, 'outbound'), SCOPE))
  assert.equal(isInScope(rec({ ...inGrid, date: '2027-08-06' }, 'outbound'), SCOPE), false)
})

test('isInScope stays total when an airport appears in both origins and destinations', () => {
  const overlap = scopeFor(
    { origins: ['NRT'], destinations: ['NRT', 'YYZ'] },
    { startDate: '2026-08-15', endDate: '2027-08-05' },
  )
  assert.ok(isInScope(rec({ origin: 'NRT', destination: 'NRT', date: '2026-11-05' }, 'outbound'), overlap))
  assert.equal(isInScope(rec({ origin: 'YYZ', destination: 'NRT', date: '2026-11-05' }, 'outbound'), overlap), false)
  assert.ok(isInScope(rec({ origin: 'NRT', destination: 'NRT', date: '2026-11-05' }, 'return'), overlap))
})

test('deriveWindow formats local dates, respects offsets, and caps at 355 days', () => {
  const cfg = parseConfig({ search: { window: { startOffsetDays: 5, endOffsetDays: 20 } } })
  const w = deriveWindow(cfg, new Date(2026, 0, 1))
  assert.equal(w.startDate, '2026-01-06')
  assert.equal(w.endDate, '2026-01-21')

  const capped = parseConfig({ search: { window: { endOffsetDays: 9999 } } })
  const wCapped = deriveWindow(capped, new Date(2026, 0, 1))
  assert.equal(wCapped.endDate, '2026-12-22') // 355 days out from Jan 1
})
