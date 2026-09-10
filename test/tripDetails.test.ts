import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, getCallsUsed, incrementApiCalls, utcDay, type Db } from '../src/db.js'
import { parseConfig } from '../src/config.js'
import { NotFoundError, type TripsFullResult } from '../src/seatsAero.js'
import { TripDetailService, type TripsFetcher } from '../src/server/tripDetails.js'

const START = new Date('2026-08-15T12:00:00Z')

function okResult(): TripsFullResult {
  return {
    options: [
      {
        flightNumbers: 'NH116',
        departsAt: '2026-11-05T17:15:00Z',
        arrivesAt: '2026-11-06T19:50:00Z',
        totalDurationMinutes: 815,
        stops: 0,
        carriers: 'ANA',
        cabin: 'business',
        mileageCost: 62_500,
        seats: 2,
        totalTaxes: 11_200,
        taxesCurrency: 'CAD',
        segments: [],
      },
    ],
    bookingLinks: [{ label: 'Book via Aeroplan', link: 'https://www.aircanada.com', primary: true }],
  }
}

interface Harness {
  db: Db
  service: TripDetailService
  clock: { now: Date }
  calls: string[]
}

function makeService(fetcher: TripsFetcher | null, opts: { fetchImpl?: TripsFetcher['getTripsFull'] } = {}): Harness {
  const db = openDb(':memory:')
  const clock = { now: START }
  const calls: string[] = []
  const wrapped: TripsFetcher | null = fetcher
    ? {
        getTripsFull: (id) => {
          calls.push(id)
          return (opts.fetchImpl ?? fetcher.getTripsFull)(id)
        },
      }
    : null
  const service = new TripDetailService({
    db,
    getClient: () => wrapped,
    getConfig: () => parseConfig({}),
    now: () => clock.now,
  })
  return { db, service, clock, calls }
}

const plainFetcher: TripsFetcher = { getTripsFull: async () => okResult() }

test('tripDetails: success is cached for the TTL and charged to the trips-web ledger', async () => {
  const { db, service, clock, calls } = makeService(plainFetcher)

  const first = await service.get('avail-1')
  assert.equal(first.kind, 'ok')
  assert.ok(first.kind === 'ok' && first.body.fetchedAt === START.toISOString())
  assert.equal(getCallsUsed(db, utcDay(START)), 1)

  // Within TTL: served from cache, no fetch, no charge.
  clock.now = new Date(START.getTime() + 29 * 60_000)
  const second = await service.get('avail-1')
  assert.equal(second.kind, 'ok')
  assert.equal(calls.length, 1)
  assert.equal(getCallsUsed(db, utcDay(START)), 1)

  // Past TTL: refetched and charged again.
  clock.now = new Date(START.getTime() + 31 * 60_000)
  await service.get('avail-1')
  assert.equal(calls.length, 2)
  assert.equal(getCallsUsed(db, utcDay(START)), 2)
})

test('tripDetails: concurrent requests coalesce onto one upstream call and one charge', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { db, service, calls } = makeService(plainFetcher, {
    fetchImpl: async () => {
      await gate
      return okResult()
    },
  })

  const a = service.get('avail-1')
  const b = service.get('avail-1')
  release()
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.kind, 'ok')
  assert.equal(rb.kind, 'ok')
  assert.equal(calls.length, 1)
  assert.equal(getCallsUsed(db, utcDay(START)), 1)
})

test('tripDetails: refuses at the reserve floor without incrementing the ledger', async () => {
  const { db, service, calls } = makeService(plainFetcher)
  // Defaults: budget 900, reserve 50 → 850 used leaves exactly the reserve.
  incrementApiCalls(db, utcDay(START), 'search', 850)

  const outcome = await service.get('avail-1')
  assert.equal(outcome.kind, 'quota_exhausted')
  assert.equal(calls.length, 0)
  assert.equal(getCallsUsed(db, utcDay(START)), 850)
})

test('tripDetails: upstream failure still charges (charge-before-fetch) and maps to upstream_error', async () => {
  const { db, service } = makeService(plainFetcher, {
    fetchImpl: async () => {
      throw new Error('seats.aero 500 for https://example.com/trips/x')
    },
  })
  const outcome = await service.get('avail-1')
  assert.equal(outcome.kind, 'upstream_error')
  assert.equal(getCallsUsed(db, utcDay(START)), 1)
})

test('tripDetails: 404 maps to expired and is negative-cached briefly', async () => {
  const { service, clock, calls } = makeService(plainFetcher, {
    fetchImpl: async () => {
      throw new NotFoundError('https://example.com/trips/gone')
    },
  })

  assert.equal((await service.get('gone')).kind, 'expired')
  // Within the negative TTL: no re-fetch.
  clock.now = new Date(START.getTime() + 4 * 60_000)
  assert.equal((await service.get('gone')).kind, 'expired')
  assert.equal(calls.length, 1)
  // Past the negative TTL: retried.
  clock.now = new Date(START.getTime() + 6 * 60_000)
  await service.get('gone')
  assert.equal(calls.length, 2)
})

test('tripDetails: no client (UI-only mode) yields no_api_key with no charge', async () => {
  const { db, service } = makeService(null)
  const outcome = await service.get('avail-1')
  assert.equal(outcome.kind, 'no_api_key')
  assert.equal(getCallsUsed(db, utcDay(START)), 0)
})
