import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectRoundtrips } from '../src/deals/roundtrip.js'
import { normalizeAvailability, type AvailabilityRecord } from '../src/types.js'
import { parseConfig } from '../src/config.js'
import { makeAvailability, type AvailabilityOverrides } from './helpers/fixtures.js'

function rec(over: AvailabilityOverrides, direction: 'outbound' | 'return'): AvailabilityRecord {
  const r = normalizeAvailability(makeAvailability(over), direction)
  assert.ok(r)
  return r
}

const cfg = parseConfig({})

test('legs above 90k pair when the total stays under 180k', () => {
  const records = [
    rec({ id: 'o', origin: 'YYZ', destination: 'NRT', date: '2027-03-01', jMileageCost: 100_000 }, 'outbound'),
    rec({ id: 'i', origin: 'NRT', destination: 'YYZ', date: '2027-03-12', jMileageCost: 75_000 }, 'return'),
  ]
  const pairs = detectRoundtrips(records, cfg)
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0]?.totalPoints, 175_000)
  assert.equal(pairs[0]?.stayNights, 11)
})

test('totals at or above 180k are excluded', () => {
  const records = [
    rec({ id: 'o', origin: 'YYZ', destination: 'NRT', date: '2027-03-01', jMileageCost: 100_000 }, 'outbound'),
    rec({ id: 'i', origin: 'NRT', destination: 'YYZ', date: '2027-03-12', jMileageCost: 80_000 }, 'return'),
  ]
  assert.equal(detectRoundtrips(records, cfg).length, 0)
})

test('stay window bounds are inclusive', () => {
  const out = rec({ id: 'o', date: '2027-03-01', jMileageCost: 70_000 }, 'outbound')
  const mkReturn = (date: string, id: string) =>
    rec({ id, origin: 'NRT', destination: 'YYZ', date, jMileageCost: 70_000 }, 'return')

  // min 3 nights: return on +2 is out of window, +3 is in.
  assert.equal(detectRoundtrips([out, mkReturn('2027-03-03', 'r2')], cfg).length, 0)
  assert.equal(detectRoundtrips([out, mkReturn('2027-03-04', 'r3')], cfg).length, 1)
  // max 21 nights: +21 in, +22 out.
  assert.equal(detectRoundtrips([out, mkReturn('2027-03-22', 'r21')], cfg).length, 1)
  assert.equal(detectRoundtrips([out, mkReturn('2027-03-23', 'r22')], cfg).length, 0)
})

test('cheapest pair per outbound date wins across programs and cities', () => {
  const records = [
    rec({ id: 'o1', origin: 'YYZ', destination: 'NRT', date: '2027-03-01', jMileageCost: 85_000 }, 'outbound'),
    rec({ id: 'o2', source: 'qatar', origin: 'ORD', destination: 'HND', date: '2027-03-01', jMileageCost: 80_000 }, 'outbound'),
    rec({ id: 'i1', origin: 'NRT', destination: 'YYZ', date: '2027-03-10', jMileageCost: 78_000 }, 'return'),
    rec({ id: 'i2', source: 'flyingblue', origin: 'HND', destination: 'LAX', date: '2027-03-15', jMileageCost: 60_000 }, 'return'),
  ]
  const pairs = detectRoundtrips(records, cfg)
  assert.equal(pairs.length, 1) // one outbound date → one best pair
  assert.equal(pairs[0]?.totalPoints, 140_000) // 80k qatar out + 60k flyingblue back (open jaw)
  assert.equal(pairs[0]?.outbound.origin, 'ORD')
  assert.equal(pairs[0]?.inbound.destination, 'LAX')
})

test('sameCityReturn restricts pairing to the departure city', () => {
  const sameCityCfg = parseConfig({ roundtrip: { sameCityReturn: true } })
  const records = [
    rec({ id: 'o1', origin: 'YYZ', destination: 'NRT', date: '2027-03-01', jMileageCost: 80_000 }, 'outbound'),
    rec({ id: 'i-lax', origin: 'HND', destination: 'LAX', date: '2027-03-10', jMileageCost: 60_000 }, 'return'),
    rec({ id: 'i-yyz', origin: 'NRT', destination: 'YYZ', date: '2027-03-10', jMileageCost: 75_000 }, 'return'),
  ]
  const pairs = detectRoundtrips(records, sameCityCfg)
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0]?.inbound.destination, 'YYZ')
  assert.equal(pairs[0]?.totalPoints, 155_000)
})

test('mixing an estimate leg marks the pair as an estimate', () => {
  const records = [
    rec(
      {
        id: 'o1',
        source: 'american',
        origin: 'LAX',
        destination: 'HND',
        date: '2027-03-01',
        distance: 5476,
        jDirect: true,
        jAirlines: 'JL',
        jDirectAirlines: 'JL',
      },
      'outbound',
    ),
    rec({ id: 'i1', origin: 'HND', destination: 'LAX', date: '2027-03-10', jMileageCost: 65_000 }, 'return'),
  ]
  const pairs = detectRoundtrips(records, cfg)
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0]?.isEstimate, true)
  assert.equal(pairs[0]?.totalPoints, 77_250 + 65_000)
})
