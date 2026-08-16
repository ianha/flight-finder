import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectOneways } from '../src/deals/oneway.js'
import { normalizeAvailability, type AvailabilityRecord } from '../src/types.js'
import { parseConfig } from '../src/config.js'
import { makeAvailability, type AvailabilityOverrides } from './helpers/fixtures.js'

function rec(over: AvailabilityOverrides = {}, direction: 'outbound' | 'return' = 'outbound'): AvailabilityRecord {
  const r = normalizeAvailability(makeAvailability(over), direction)
  assert.ok(r, 'fixture should normalize')
  return r
}

const cfg = parseConfig({})

test('one-way threshold is strict less-than 90k', () => {
  const deals = detectOneways(
    [
      rec({ id: 'a', jMileageCost: 89_999 }),
      rec({ id: 'b', jMileageCost: 90_000, origin: 'ORD' }),
      rec({ id: 'c', jMileageCost: 90_001, origin: 'YVR' }),
    ],
    cfg,
  )
  assert.equal(deals.length, 1)
  assert.equal(deals[0]?.points, 89_999)
})

test('string mileage costs from the API are parsed to integers', () => {
  const raw = makeAvailability({ jMileageCost: '62500' })
  const r = normalizeAvailability(raw, 'outbound')
  assert.equal(r?.jMileageCost, 62_500)
})

test('unavailable and unparseable records are dropped', () => {
  const noJ = rec({ jAvailable: false, jMileageCost: 50_000 })
  const garbagePrice = normalizeAvailability(
    makeAvailability({ id: 'g', jMileageCost: 'N/A' }),
    'outbound',
  )
  assert.ok(garbagePrice) // record normalizes; price becomes null
  assert.equal(garbagePrice.jMileageCost, null)
  const deals = detectOneways([noJ, garbagePrice], cfg)
  assert.equal(deals.length, 0)
})

test('directOnly filters connections and prices from the direct cost', () => {
  const directCfg = parseConfig({ search: { directOnly: true } })
  const connection = rec({ id: 'conn', jDirect: false, jMileageCost: 60_000 })
  const nonstop = rec({ id: 'ns', jDirect: true, jMileageCost: 80_000, jDirectMileageCost: 85_000 })
  const deals = detectOneways([connection, nonstop], directCfg)
  assert.equal(deals.length, 1)
  assert.equal(deals[0]?.points, 85_000)
})

test('minSeats filters low counts but missing/zero counts pass', () => {
  const seatCfg = parseConfig({ search: { minSeats: 2 } })
  const oneSeat = rec({ id: 's1', jRemainingSeats: 1, jMileageCost: 60_000 })
  const twoSeats = rec({ id: 's2', jRemainingSeats: 2, jMileageCost: 61_000, origin: 'ORD' })
  const unknownSeats = rec({ id: 's3', jRemainingSeats: 0, jMileageCost: 62_000, origin: 'YVR' })
  const deals = detectOneways([oneSeat, twoSeats, unknownSeats], seatCfg)
  assert.deepEqual(
    deals.map((d) => d.points),
    [61_000, 62_000],
  )
})

test('proxy source substitutes estimated Avios pricing', () => {
  const jalSpace = rec({
    id: 'p1',
    source: 'american',
    origin: 'LAX',
    destination: 'HND',
    distance: 5476,
    jDirect: true,
    jAirlines: 'JL',
    jDirectAirlines: 'JL',
    jMileageCost: 120_000, // AA's own price — must NOT be used
  })
  const deals = detectOneways([jalSpace], cfg)
  assert.equal(deals.length, 1)
  assert.equal(deals[0]?.points, 77_250) // Qatar Avios 4,001-5,500mi band
  assert.equal(deals[0]?.isEstimate, true)
  assert.equal(deals[0]?.estimate?.baAvios, 85_000)
})

test('proxy records that are not JL/AA nonstops are ineligible', () => {
  const connecting = rec({
    id: 'p2',
    source: 'american',
    jDirect: false,
    jAirlines: 'JL',
    jMileageCost: 60_000,
  })
  const wrongCarrier = rec({
    id: 'p3',
    source: 'alaska',
    jDirect: true,
    jAirlines: 'UA',
    jDirectAirlines: 'UA',
    jMileageCost: 60_000,
  })
  assert.equal(detectOneways([connecting, wrongCarrier], cfg).length, 0)
})

test('proxy toggle off removes proxy deals entirely', () => {
  const noProxyCfg = parseConfig({ search: { proxySources: { enabled: false } } })
  const jalSpace = rec({
    id: 'p4',
    source: 'american',
    origin: 'YVR',
    destination: 'NRT',
    distance: 4662,
    jDirect: true,
    jAirlines: 'JL',
    jDirectAirlines: 'JL',
  })
  assert.equal(detectOneways([jalSpace], noProxyCfg).length, 0)
})

test('ORD proxy space prices at the 5,501-6,500 band and misses the one-way cap', () => {
  const ordJal = rec({
    id: 'p5',
    source: 'american',
    origin: 'ORD',
    destination: 'HND',
    distance: 6291,
    jDirect: true,
    jAirlines: 'JL',
    jDirectAirlines: 'JL',
  })
  // 92,750 Qatar Avios >= 90k → not a one-way deal (but pairable in roundtrips).
  assert.equal(detectOneways([ordJal], cfg).length, 0)
})
