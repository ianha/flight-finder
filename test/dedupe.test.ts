import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, recordAlertedDeals, touchAlertedDealsSeen, getAlertedDeal } from '../src/db.js'
import { filterForAlert } from '../src/deals/dedupe.js'
import { parseConfig } from '../src/config.js'
import type { OneWayDeal } from '../src/types.js'

const cfg = parseConfig({})

function deal(points: number, key = 'OW|aeroplan|YYZ|NRT|2027-03-01'): OneWayDeal {
  return {
    kind: 'oneway',
    key,
    availabilityId: 'a1',
    source: 'aeroplan',
    program: 'Aeroplan',
    origin: 'YYZ',
    destination: 'NRT',
    date: '2027-03-01',
    direction: 'outbound',
    points,
    isEstimate: false,
    direct: true,
    seats: 2,
    airlines: 'NH',
    apiUpdatedAt: '2026-08-15T12:00:00Z',
  }
}

test('never-alerted deals are new', () => {
  const db = openDb(':memory:')
  const res = filterForAlert(db, [deal(85_000)], cfg, new Date('2026-08-15T12:00:00Z'))
  assert.equal(res.toAlert.length, 1)
  assert.equal(res.toAlert[0]?.reason, 'new')
})

test('already-alerted deals at the same price are silent but tracked', () => {
  const db = openDb(':memory:')
  const d = deal(85_000)
  recordAlertedDeals(db, [{ key: d.key, kind: 'oneway', points: 85_000, isEstimate: false, detailJson: '{}' }], '2026-08-15T10:00:00Z')
  const res = filterForAlert(db, [d], cfg, new Date('2026-08-15T12:00:00Z'))
  assert.equal(res.toAlert.length, 0)
  assert.deepEqual(res.stillQualifyingKeys, [d.key])
})

test('a >=15% drop below the best-ever price re-alerts as improved', () => {
  const db = openDb(':memory:')
  const key = deal(0).key
  recordAlertedDeals(db, [{ key, kind: 'oneway', points: 85_000, isEstimate: false, detailJson: '{}' }], '2026-08-15T10:00:00Z')

  const smallDrop = filterForAlert(db, [deal(78_000)], cfg, new Date('2026-08-15T12:00:00Z'))
  assert.equal(smallDrop.toAlert.length, 0) // ~8% — not enough

  const bigDrop = filterForAlert(db, [deal(72_000)], cfg, new Date('2026-08-15T12:00:00Z'))
  assert.equal(bigDrop.toAlert.length, 1) // 72,000 <= 85,000 * 0.85
  assert.equal(bigDrop.toAlert[0]?.reason, 'improved')
  assert.equal(bigDrop.toAlert[0]?.prevBestPoints, 85_000)
})

test('improvement anchors to best-ever, not last-alerted (no oscillation spam)', () => {
  const db = openDb(':memory:')
  const key = deal(0).key
  recordAlertedDeals(db, [{ key, kind: 'oneway', points: 85_000, isEstimate: false, detailJson: '{}' }], '2026-08-15T10:00:00Z')
  recordAlertedDeals(db, [{ key, kind: 'oneway', points: 70_000, isEstimate: false, detailJson: '{}' }], '2026-08-15T11:00:00Z')
  // Price back up to 85k, then "drops" to 75k — above best (70k), stays silent.
  const res = filterForAlert(db, [deal(75_000)], cfg, new Date('2026-08-15T12:00:00Z'))
  assert.equal(res.toAlert.length, 0)
  const row = getAlertedDeal(db, key)
  assert.equal(row?.best_points, 70_000)
})

test('a deal that reappears after >=7 days gone re-alerts as returned', () => {
  const db = openDb(':memory:')
  const d = deal(85_000)
  recordAlertedDeals(db, [{ key: d.key, kind: 'oneway', points: 85_000, isEstimate: false, detailJson: '{}' }], '2026-08-01T10:00:00Z')

  const soon = filterForAlert(db, [d], cfg, new Date('2026-08-05T10:00:00Z'))
  assert.equal(soon.toAlert.length, 0)

  const late = filterForAlert(db, [d], cfg, new Date('2026-08-09T10:00:00Z'))
  assert.equal(late.toAlert.length, 1)
  assert.equal(late.toAlert[0]?.reason, 'returned')
})

test('touching seen keys resets the gone clock', () => {
  const db = openDb(':memory:')
  const d = deal(85_000)
  recordAlertedDeals(db, [{ key: d.key, kind: 'oneway', points: 85_000, isEstimate: false, detailJson: '{}' }], '2026-08-01T10:00:00Z')
  touchAlertedDealsSeen(db, [d.key], '2026-08-07T10:00:00Z')
  const res = filterForAlert(db, [d], cfg, new Date('2026-08-09T10:00:00Z'))
  assert.equal(res.toAlert.length, 0) // only 2 days since last seen
})
