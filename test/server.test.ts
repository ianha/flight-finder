import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  openDb,
  incrementApiCalls,
  startCycle,
  finishCycle,
  metaSet,
  upsertAvailability,
  recordAlertedDeals,
  type Db,
} from '../src/db.js'
import { parseConfig } from '../src/config.js'
import { buildApp, type SchedulerFacade } from '../src/server/app.js'
import type {
  StatusResponse,
  CyclesResponse,
  RunConflictResponse,
  OneWayDealsResponse,
  RoundtripDealsResponse,
  CalendarResponse,
  AlertsResponse,
} from '../src/shared/apiTypes.js'
import { Scheduler } from '../src/scheduler.js'
import type { CycleOutcome } from '../src/poll.js'
import { normalizeAvailability } from '../src/types.js'
import { makeAvailability, type AvailabilityOverrides } from './helpers/fixtures.js'
import { TripDetailService, type TripsFetcher } from '../src/server/tripDetails.js'
import { NotFoundError, type TripsFullResult } from '../src/seatsAero.js'
import { getCallsUsed, utcDay } from '../src/db.js'

function seed(
  db: Db,
  over: AvailabilityOverrides,
  direction: 'outbound' | 'return',
  seenAt = '2026-08-15T12:00:00Z',
): void {
  const rec = normalizeAvailability(makeAvailability(over), direction)
  assert.ok(rec)
  upsertAvailability(db, rec, seenAt)
}

function seededDb(): Db {
  const db = openDb(':memory:')
  seed(db, { id: 'a1', source: 'aeroplan', origin: 'YYZ', destination: 'NRT', date: '2026-11-05', jMileageCost: 62_500 }, 'outbound')
  seed(db, { id: 'a2', source: 'qatar', origin: 'ORD', destination: 'HND', date: '2026-11-06', jMileageCost: 85_000, jDirect: false }, 'outbound')
  seed(db, { id: 'a3', source: 'aeroplan', origin: 'LAX', destination: 'NRT', date: '2026-11-07', jMileageCost: 150_000 }, 'outbound')
  seed(
    db,
    { id: 'p1', source: 'american', origin: 'LAX', destination: 'HND', date: '2026-11-08', distance: 5476, jDirect: true, jAirlines: 'JL', jDirectAirlines: 'JL' },
    'outbound',
  )
  seed(db, { id: 'r1', source: 'aeroplan', origin: 'NRT', destination: 'YYZ', date: '2026-11-16', jMileageCost: 70_000 }, 'return')
  return db
}

/**
 * Default config: origins [YYZ,ORD,YVR,LAX], destinations [NRT,HND], window
 * [today, today+355]. Sibling of seededDb() with rows chosen to be out of
 * scope on one dimension each — keeps seededDb()'s exact-count assertions
 * untouched while giving the scope tests unambiguous signal.
 */
function scopeSeedDb(): Db {
  const db = seededDb() // a1 (62.5k), a2 (85k conn), a3 (150k, excluded by threshold), p1 (est), r1 (return)
  seed(db, { id: 'x1', source: 'aeroplan', origin: 'YYZ', destination: 'ICN', date: '2026-11-05', jMileageCost: 55_000 }, 'outbound') // wrong destination
  seed(db, { id: 'x2', source: 'aeroplan', origin: 'JFK', destination: 'NRT', date: '2026-11-05', jMileageCost: 55_000 }, 'outbound') // wrong origin
  seed(db, { id: 'x3', source: 'aeroplan', origin: 'YYZ', destination: 'NRT', date: '2026-11-12', jMileageCost: 55_000 }, 'return') // same pair as a1, but stored direction only matches outbound geometry
  seed(db, { id: 'x4', source: 'aeroplan', origin: 'YYZ', destination: 'NRT', date: '2026-08-01', jMileageCost: 55_000 }, 'outbound') // before window start
  seed(db, { id: 'x5', source: 'aeroplan', origin: 'YYZ', destination: 'NRT', date: '2027-09-01', jMileageCost: 55_000 }, 'outbound') // after window end (> +355d)
  return db
}

const NOW = new Date('2026-08-15T12:00:00Z')

function fakeOutcome(): CycleOutcome {
  return {
    status: 'ok',
    digest: null,
    recordsFetched: 0,
    invalidCount: 0,
    onewaysFound: 0,
    roundtripsFound: 0,
    alertsSent: 0,
    callsUsed: 0,
  }
}

function makeApp(db: Db, scheduler: SchedulerFacade | null) {
  return buildApp({
    db,
    getConfig: () => parseConfig({}),
    scheduler,
    envPresence: () => ({ seatsAeroApiKey: true, twilioCreds: false }),
    version: 'test',
    now: () => NOW,
  })
}

test('GET /api/health returns ok + version', async () => {
  const app = makeApp(openDb(':memory:'), null)
  const res = await app.request('/api/health')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, version: 'test' })
})

test('GET /api/status reports quota math, last cycle, and env presence', async () => {
  const db = openDb(':memory:')
  incrementApiCalls(db, '2026-08-15', 'search', 12)
  incrementApiCalls(db, '2026-08-15', 'trips', 3)
  incrementApiCalls(db, '2026-08-14', 'search', 500) // other day — must not count
  metaSet(db, 'rate_limit_remaining', '842')
  metaSet(db, 'rate_limit_seen_at', '2026-08-15T11:00:00Z')
  const id = startCycle(db, 'scheduled', '2026-08-15T10:00:00Z')
  finishCycle(db, id, {
    finishedAt: '2026-08-15T10:00:42Z',
    status: 'ok',
    callsUsed: 15,
    recordsFetched: 120,
    onewaysFound: 2,
    roundtripsFound: 1,
    alertsSent: 3,
  })

  const app = makeApp(db, null)
  const res = await app.request('/api/status')
  assert.equal(res.status, 200)
  const body = (await res.json()) as StatusResponse
  assert.equal(body.quota.used, 15)
  assert.equal(body.quota.budget, 900)
  assert.equal(body.quota.headerRemaining, 842)
  assert.equal(body.lastCycle?.status, 'ok')
  assert.equal(body.lastCycle?.durationMs, 42_000)
  assert.equal(body.lastCycle?.alertsSent, 3)
  assert.equal(body.env.seatsAeroApiKey, true)
  assert.equal(body.env.twilioCreds, false)
  assert.deepEqual(body.search, {
    origins: ['YYZ', 'ORD', 'YVR', 'LAX'],
    destinations: ['NRT', 'HND'],
    destinationLabel: 'Tokyo',
    sources: ['aeroplan', 'flyingblue', 'qatar'],
    estimatesEnabled: true,
    directOnly: false,
  })
  assert.deepEqual(body.thresholds, { onewayMaxPoints: 90_000, roundtripMaxPoints: 180_000 })
})

test('GET /api/status configRevision reflects search/thresholds/roundtrip, not sms', async () => {
  const app = makeApp(openDb(':memory:'), null)
  const base = (await (await app.request('/api/status')).json()) as StatusResponse

  const appSameConfig = makeApp(openDb(':memory:'), null)
  const same = (await (await appSameConfig.request('/api/status')).json()) as StatusResponse
  assert.equal(same.configRevision, base.configRevision)

  const appDifferentThreshold = buildApp({
    db: openDb(':memory:'),
    getConfig: () => parseConfig({ thresholds: { onewayMaxPoints: 95_000 } }),
    scheduler: null,
    envPresence: () => ({ seatsAeroApiKey: true, twilioCreds: false }),
    version: 'test',
    now: () => NOW,
  })
  const different = (await (await appDifferentThreshold.request('/api/status')).json()) as StatusResponse
  assert.notEqual(different.configRevision, base.configRevision)

  const appDifferentSms = buildApp({
    db: openDb(':memory:'),
    getConfig: () => parseConfig({ sms: { to: ['+14165551234'], from: '+14165550000' } }),
    scheduler: null,
    envPresence: () => ({ seatsAeroApiKey: true, twilioCreds: false }),
    version: 'test',
    now: () => NOW,
  })
  const differentSms = (await (await appDifferentSms.request('/api/status')).json()) as StatusResponse
  assert.equal(differentSms.configRevision, base.configRevision)
})

test('stale rate-limit header from a previous UTC day is ignored', async () => {
  const db = openDb(':memory:')
  metaSet(db, 'rate_limit_remaining', '5')
  metaSet(db, 'rate_limit_seen_at', '2026-08-14T23:00:00Z')
  const app = makeApp(db, null)
  const body = (await (await app.request('/api/status')).json()) as StatusResponse
  assert.equal(body.quota.headerRemaining, null)
})

test('GET /api/cycles returns newest first with limit', async () => {
  const db = openDb(':memory:')
  for (let i = 0; i < 5; i++) {
    const id = startCycle(db, 'scheduled', `2026-08-15T0${i}:00:00Z`)
    finishCycle(db, id, {
      finishedAt: `2026-08-15T0${i}:01:00Z`,
      status: 'ok',
      callsUsed: i,
      recordsFetched: 0,
      onewaysFound: 0,
      roundtripsFound: 0,
      alertsSent: 0,
    })
  }
  const app = makeApp(db, null)
  const body = (await (await app.request('/api/cycles?limit=3')).json()) as CyclesResponse
  assert.equal(body.cycles.length, 3)
  assert.equal(body.cycles[0]?.startedAt, '2026-08-15T04:00:00Z')
})

test('POST /api/run starts a cycle; concurrent request gets 409', async () => {
  const db = openDb(':memory:')
  let release!: () => void
  const pending = new Promise<void>((r) => {
    release = r
  })
  let runs = 0
  const scheduler = new Scheduler({
    runner: async () => {
      runs++
      await pending
      return fakeOutcome()
    },
    getIntervalHours: () => 2,
    getLastCycleAt: () => undefined,
    now: () => NOW,
  })
  const app = makeApp(db, scheduler)

  const first = await app.request('/api/run', { method: 'POST' })
  assert.equal(first.status, 202)
  assert.equal(runs, 1)

  const second = await app.request('/api/run', { method: 'POST' })
  assert.equal(second.status, 409)
  const conflict = (await second.json()) as RunConflictResponse
  assert.equal(conflict.error, 'cycle_in_flight')
  assert.equal(conflict.trigger, 'manual')

  release()
  await scheduler.cycleInFlight() // allow the finally to run
  await new Promise((r) => setImmediate(r))
  scheduler.stop()
  const third = await app.request('/api/run', { method: 'POST' })
  assert.equal(third.status, 202)
  assert.equal(runs, 2)
  scheduler.stop()
})

test('GET /api/deals/oneway applies config thresholds and filters', async () => {
  const app = makeApp(seededDb(), null)

  const all = (await (await app.request('/api/deals/oneway')).json()) as OneWayDealsResponse
  // a1 (62.5k out), r1 (70k return), p1 (77,250 est), a2 (85k). a3 is over 90k.
  assert.equal(all.total, 4)
  assert.equal(all.deals[0]?.points, 62_500) // sorted by points

  const outboundOnly = (await (
    await app.request('/api/deals/oneway?direction=outbound')
  ).json()) as OneWayDealsResponse
  assert.equal(outboundOnly.total, 3)

  const noEstimates = (await (
    await app.request('/api/deals/oneway?includeEstimates=false')
  ).json()) as OneWayDealsResponse
  assert.equal(noEstimates.total, 3)

  const tighter = (await (
    await app.request('/api/deals/oneway?maxPoints=70000')
  ).json()) as OneWayDealsResponse
  assert.equal(tighter.total, 1)

  const explore = (await (
    await app.request('/api/deals/oneway?maxPoints=200000&origin=LAX')
  ).json()) as OneWayDealsResponse
  assert.equal(explore.total, 2) // a3 (150k) + p1 estimate

  const direct = (await (
    await app.request('/api/deals/oneway?directOnly=true')
  ).json()) as OneWayDealsResponse
  assert.ok(direct.deals.every((d) => d.direct))
})

test('GET /api/deals/roundtrip pairs from the snapshot with overrides', async () => {
  const app = makeApp(seededDb(), null)
  const body = (await (await app.request('/api/deals/roundtrip')).json()) as RoundtripDealsResponse
  assert.ok(body.total >= 1)
  const best = body.pairs[0]!
  assert.equal(best.totalPoints, 62_500 + 70_000)
  assert.equal(best.outbound.origin, 'YYZ')

  const shortStay = (await (
    await app.request('/api/deals/roundtrip?minStay=1&maxStay=2')
  ).json()) as RoundtripDealsResponse
  assert.equal(shortStay.total, 0) // no returns 1-2 nights after any outbound
})

test('GET /api/availability/calendar returns per-date minima', async () => {
  const app = makeApp(seededDb(), null)
  const body = (await (
    await app.request('/api/availability/calendar?direction=outbound')
  ).json()) as CalendarResponse
  assert.equal(body.days.length, 4)
  const nov5 = body.days.find((d) => d.date === '2026-11-05')
  assert.equal(nov5?.minPoints, 62_500)
  assert.equal(nov5?.cheapestSource, 'aeroplan')
  const nov8 = body.days.find((d) => d.date === '2026-11-08')
  assert.equal(nov8?.minPoints, 77_250)
  assert.equal(nov8?.minPointsIsEstimate, true)
})

// ---------------------------------------------------------------------------
// Config scoping (deals/scope.ts) — the read model must show exactly what the
// current search.origins/destinations/window/directOnly/thresholds allow, and
// nothing else, with no restart and no DB write.
// ---------------------------------------------------------------------------

test('deals read model is scoped to the configured geography and window', async () => {
  const app = makeApp(scopeSeedDb(), null)

  const oneway = (await (await app.request('/api/deals/oneway')).json()) as OneWayDealsResponse
  assert.equal(oneway.total, 4) // unchanged by x1-x5, all off-grid on some dimension
  assert.ok(!oneway.deals.some((d) => d.destination === 'ICN' || d.origin === 'JFK'))

  const roundtrip = (await (await app.request('/api/deals/roundtrip')).json()) as RoundtripDealsResponse
  assert.equal(roundtrip.pairs[0]?.totalPoints, 62_500 + 70_000) // still a1+r1

  const calendar = (await (
    await app.request('/api/availability/calendar?direction=outbound')
  ).json()) as CalendarResponse
  assert.ok(!calendar.days.some((d) => d.date === '2026-08-01' || d.date === '2027-09-01'))
})

test('a config change is honored by the next read without restart', async () => {
  const db = seededDb()
  let cfg = parseConfig({})
  const app = buildApp({
    db,
    getConfig: () => cfg,
    scheduler: null,
    envPresence: () => ({ seatsAeroApiKey: true, twilioCreds: false }),
    version: 'test',
    now: () => NOW,
  })

  const initial = (await (await app.request('/api/deals/oneway')).json()) as OneWayDealsResponse
  assert.equal(initial.total, 4)

  cfg = parseConfig({ search: { origins: ['SFO'] } })
  const afterUnrelatedOrigin = (await (await app.request('/api/deals/oneway')).json()) as OneWayDealsResponse
  assert.equal(afterUnrelatedOrigin.total, 0)

  // Swap origins/destinations entirely. r1 (NRT->YYZ, stored as `return`) stays
  // hidden: as a return leg it needs origin(NRT) in the new destinations set,
  // which no longer contains NRT.
  cfg = parseConfig({ search: { origins: ['NRT', 'HND'], destinations: ['YYZ', 'ORD', 'LAX'] } })
  const afterSwap = (await (await app.request('/api/deals/oneway')).json()) as OneWayDealsResponse
  assert.equal(afterSwap.total, 0)

  // A threshold override never widens geography back into scope.
  const wideOverride = (await (
    await app.request('/api/deals/oneway?maxPoints=10000000')
  ).json()) as OneWayDealsResponse
  assert.equal(wideOverride.total, 0)

  // Re-fetching the SAME physical route as `outbound` (same PK as r1: source,
  // origin, destination, date) rewrites the stored direction on conflict, so it
  // re-enters scope under the new configuration.
  seed(db, { id: 'r1-refetched', source: 'aeroplan', origin: 'NRT', destination: 'YYZ', date: '2026-11-16', jMileageCost: 70_000 }, 'outbound')
  const afterRefetch = (await (await app.request('/api/deals/oneway')).json()) as OneWayDealsResponse
  assert.equal(afterRefetch.total, 1)
  assert.equal(afterRefetch.deals[0]?.origin, 'NRT')
})

test('roundtrip pairing never reaches outside the configured scope', async () => {
  const db = seededDb()
  // Cheap return from an out-of-config city, 10 nights after a1 — geometrically
  // ineligible (KIX is not a configured destination) even though it is cheaper
  // than r1 and would otherwise win the pairing.
  seed(db, { id: 'kix-return', source: 'aeroplan', origin: 'KIX', destination: 'YYZ', date: '2026-11-15', jMileageCost: 30_000 }, 'return')
  const app = makeApp(db, null)
  const body = (await (await app.request('/api/deals/roundtrip')).json()) as RoundtripDealsResponse
  assert.equal(body.pairs[0]?.totalPoints, 62_500 + 70_000)
})

test('GET /api/deals/oneway respects the configured date window', async () => {
  const db = openDb(':memory:')
  seed(db, { id: 'early', source: 'aeroplan', origin: 'YYZ', destination: 'NRT', date: '2026-08-10', jMileageCost: 50_000 }, 'outbound') // safely before window start in any timezone
  seed(db, { id: 'near', source: 'aeroplan', origin: 'YYZ', destination: 'NRT', date: '2026-08-16', jMileageCost: 50_000 }, 'outbound') // safely within the default (starts today) window in any timezone
  seed(db, { id: 'far', source: 'aeroplan', origin: 'YYZ', destination: 'NRT', date: '2028-01-01', jMileageCost: 50_000 }, 'outbound') // well beyond the 355-day cap

  const defaultApp = makeApp(db, null)
  const withDefaultWindow = (await (await defaultApp.request('/api/deals/oneway')).json()) as OneWayDealsResponse
  assert.equal(withDefaultWindow.total, 1)
  assert.equal(withDefaultWindow.deals[0]?.availabilityId, 'near')

  const shiftedApp = buildApp({
    db,
    getConfig: () => parseConfig({ search: { window: { startOffsetDays: 30 } } }),
    scheduler: null,
    envPresence: () => ({ seatsAeroApiKey: true, twilioCreds: false }),
    version: 'test',
    now: () => NOW,
  })
  const withShiftedWindow = (await (await shiftedApp.request('/api/deals/oneway')).json()) as OneWayDealsResponse
  assert.equal(withShiftedWindow.total, 0) // 'near' (~1 day out) is now before the shifted window start
})

test('two in-scope rows fetched by different cycles are both visible (partial-quota safety)', async () => {
  const db = openDb(':memory:')
  seed(db, { id: 'cycle-1', source: 'aeroplan', origin: 'YYZ', destination: 'NRT', date: '2026-11-05', jMileageCost: 60_000 }, 'outbound', '2026-08-15T10:00:00Z')
  seed(db, { id: 'cycle-2', source: 'qatar', origin: 'ORD', destination: 'HND', date: '2026-11-06', jMileageCost: 70_000 }, 'outbound', '2026-08-15T14:00:00Z')
  const app = makeApp(db, null)
  const body = (await (await app.request('/api/deals/oneway')).json()) as OneWayDealsResponse
  assert.equal(body.total, 2)
})

test('search.directOnly config default is honored by default and overridable per request', async () => {
  const app = buildApp({
    db: seededDb(),
    getConfig: () => parseConfig({ search: { directOnly: true } }),
    scheduler: null,
    envPresence: () => ({ seatsAeroApiKey: true, twilioCreds: false }),
    version: 'test',
    now: () => NOW,
  })
  const byDefault = (await (await app.request('/api/deals/oneway')).json()) as OneWayDealsResponse
  assert.ok(byDefault.deals.every((d) => d.direct))
  assert.ok(!byDefault.deals.some((d) => d.origin === 'ORD')) // a2 (a connection) excluded by the config default

  const overridden = (await (
    await app.request('/api/deals/oneway?directOnly=false')
  ).json()) as OneWayDealsResponse
  assert.ok(overridden.deals.some((d) => d.origin === 'ORD' && !d.direct))
})

test('availabilityInScope counts in-scope rows before user filters; source=avios-est filters estimates', async () => {
  const app = makeApp(seededDb(), null)
  const all = (await (await app.request('/api/deals/oneway')).json()) as OneWayDealsResponse
  assert.equal(all.availabilityInScope, 5) // a1, a2, a3, p1, r1 — all in scope regardless of the 90k threshold

  const filtered = (await (await app.request('/api/deals/oneway?home=YYZ')).json()) as OneWayDealsResponse
  assert.equal(filtered.availabilityInScope, 5) // unaffected by the user's own filters

  const estimateOnly = (await (
    await app.request('/api/deals/oneway?source=avios-est')
  ).json()) as OneWayDealsResponse
  assert.equal(estimateOnly.total, 1)
  assert.ok(estimateOnly.deals[0]?.isEstimate)

  const noProxyApp = buildApp({
    db: seededDb(),
    getConfig: () => parseConfig({ search: { proxySources: { enabled: false } } }),
    scheduler: null,
    envPresence: () => ({ seatsAeroApiKey: true, twilioCreds: false }),
    version: 'test',
    now: () => NOW,
  })
  const withoutEstimates = (await (
    await noProxyApp.request('/api/deals/oneway')
  ).json()) as OneWayDealsResponse
  assert.equal(withoutEstimates.total, 3) // p1 dropped entirely — american is neither a direct source nor a proxy now
})

test('GET /api/alerts returns parsed detail JSON', async () => {
  const db = seededDb()
  recordAlertedDeals(
    db,
    [{ key: 'OW|aeroplan|YYZ|NRT|2026-11-05', kind: 'oneway', points: 62_500, isEstimate: false, detailJson: '{"route":"YYZ→NRT"}' }],
    '2026-08-15T12:00:00Z',
  )
  const app = makeApp(db, null)
  const body = (await (await app.request('/api/alerts')).json()) as AlertsResponse
  assert.equal(body.alerts.length, 1)
  assert.deepEqual(body.alerts[0]?.detail, { route: 'YYZ→NRT' })
})

test('scheduler computes drift-corrected next run from last cycle time', () => {
  const scheduler = new Scheduler({
    runner: async () => fakeOutcome(),
    getIntervalHours: () => 2,
    getLastCycleAt: () => '2026-08-15T11:00:00Z',
    now: () => NOW,
  })
  assert.equal(scheduler.nextRunAt(), '2026-08-15T13:00:00.000Z')

  const overdue = new Scheduler({
    runner: async () => fakeOutcome(),
    getIntervalHours: () => 2,
    getLastCycleAt: () => '2026-08-15T08:00:00Z',
    now: () => NOW,
  })
  // Overdue → next run is now, not in the past.
  assert.equal(overdue.nextRunAt(), NOW.toISOString())
})

// --- trips detail endpoint ---

function tripsResult(): TripsFullResult {
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

function makeTripsApp(db: Db, fetcher: TripsFetcher | null) {
  const tripDetails = new TripDetailService({
    db,
    getClient: () => fetcher,
    getConfig: () => parseConfig({}),
    now: () => NOW,
  })
  return buildApp({
    db,
    getConfig: () => parseConfig({}),
    scheduler: null,
    envPresence: () => ({ seatsAeroApiKey: fetcher !== null, twilioCreds: false }),
    tripDetails,
    version: 'test',
    now: () => NOW,
  })
}

test('GET /api/trips/:id returns detail body and charges the trips-web ledger', async () => {
  const db = openDb(':memory:')
  const app = makeTripsApp(db, { getTripsFull: async () => tripsResult() })
  const res = await app.request('/api/trips/avail-1')
  assert.equal(res.status, 200)
  const body = (await res.json()) as import('../src/shared/apiTypes.js').TripDetailOkResponse
  assert.equal(body.availabilityId, 'avail-1')
  assert.equal(body.options[0]?.flightNumbers, 'NH116')
  assert.equal(body.bookingLinks[0]?.primary, true)
  assert.equal(body.fetchedAt, NOW.toISOString())
  assert.equal(getCallsUsed(db, utcDay(NOW)), 1)
})

test('GET /api/trips/:id maps typed failures to statuses', async () => {
  const gone = makeTripsApp(openDb(':memory:'), {
    getTripsFull: async () => {
      throw new NotFoundError('https://example.com/trips/gone')
    },
  })
  assert.equal((await gone.request('/api/trips/gone')).status, 404)
  assert.deepEqual(await (await gone.request('/api/trips/gone')).json(), { error: 'expired' })

  const broken = makeTripsApp(openDb(':memory:'), {
    getTripsFull: async () => {
      throw new Error('seats.aero 500 for https://internal.example/trips/x')
    },
  })
  const res = await broken.request('/api/trips/x')
  assert.equal(res.status, 502)
  // No upstream detail leaks into the body.
  assert.deepEqual(await res.json(), { error: 'upstream_error' })

  const keyless = makeTripsApp(openDb(':memory:'), null)
  const keylessRes = await keyless.request('/api/trips/avail-1')
  assert.equal(keylessRes.status, 400)
  assert.deepEqual(await keylessRes.json(), { error: 'no_api_key' })
})

test('GET /api/trips/:id rejects malformed ids before any side effect', async () => {
  const db = openDb(':memory:')
  let fetches = 0
  const app = makeTripsApp(db, {
    getTripsFull: async () => {
      fetches++
      return tripsResult()
    },
  })
  for (const bad of ['..%2Fsearch', 'a b', 'x'.repeat(65)]) {
    const res = await app.request(`/api/trips/${bad}`)
    assert.equal(res.status, 400, `expected 400 for ${bad}`)
    assert.deepEqual(await res.json(), { error: 'invalid_availability_id' })
  }
  // Router path-normalizes '%2e%2e' ('..') away before the handler — rejected
  // upstream of us; the invariant is only that no side effect happens.
  assert.equal((await app.request('/api/trips/%2e%2e')).status, 404)
  assert.equal(fetches, 0)
  assert.equal(getCallsUsed(db, utcDay(NOW)), 0)
})

test('GET /api/trips without the serve-mode dep returns no_api_key', async () => {
  const app = makeApp(openDb(':memory:'), null) // no tripDetails
  const res = await app.request('/api/trips/avail-1')
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: 'no_api_key' })
})

test('api middleware rejects foreign Origin and non-loopback Host', async () => {
  const app = makeApp(seededDb(), null)

  const foreignOrigin = await app.request('/api/health', {
    headers: { origin: 'https://evil.example' },
  })
  assert.equal(foreignOrigin.status, 403)

  const rebound = await app.request('/api/health', {
    headers: { host: 'evil.example:8787' },
  })
  assert.equal(rebound.status, 403)

  const nullOrigin = await app.request('/api/health', { headers: { origin: 'null' } })
  assert.equal(nullOrigin.status, 403)

  const local = await app.request('/api/health', {
    headers: { host: 'localhost:5173', origin: 'http://127.0.0.1:5173' },
  })
  assert.equal(local.status, 200)
})

test('GET /api/deals/oneway home/dest filters are direction-aware', async () => {
  const app = makeApp(seededDb(), null)

  // home=YYZ: outbound legs FROM YYZ (a1) plus return legs TO YYZ (r1).
  const home = (await (await app.request('/api/deals/oneway?home=YYZ')).json()) as OneWayDealsResponse
  assert.equal(home.total, 2)
  assert.ok(
    home.deals.every((d) => (d.direction === 'outbound' ? d.origin : d.destination) === 'YYZ'),
  )

  // dest=HND: outbound legs TO HND (a2, p1); no return legs from HND seeded.
  const dest = (await (await app.request('/api/deals/oneway?dest=HND')).json()) as OneWayDealsResponse
  assert.equal(dest.total, 2)
  assert.ok(dest.deals.every((d) => (d.direction === 'outbound' ? d.destination : d.origin) === 'HND'))

  // Both ends: the YYZ↔NRT city pair in either direction.
  const pairQ = (await (
    await app.request('/api/deals/oneway?home=YYZ&dest=NRT')
  ).json()) as OneWayDealsResponse
  assert.equal(pairQ.total, 2) // a1 outbound YYZ→NRT + r1 return NRT→YYZ

  const none = (await (
    await app.request('/api/deals/oneway?home=YYZ&dest=HND')
  ).json()) as OneWayDealsResponse
  assert.equal(none.total, 0)
})

test('GET /api/deals/roundtrip destination filters the away airport (incl. open-jaws)', async () => {
  const app = makeApp(seededDb(), null)
  const all = (await (await app.request('/api/deals/roundtrip')).json()) as RoundtripDealsResponse

  // HND: only pairs touching HND on the away side (LAX→HND out / NRT→YYZ back open-jaw).
  const hnd = (await (
    await app.request('/api/deals/roundtrip?destination=HND')
  ).json()) as RoundtripDealsResponse
  assert.ok(hnd.total >= 1)
  assert.ok(hnd.total < all.total)
  assert.ok(
    hnd.pairs.every((p) => p.outbound.destination === 'HND' || p.inbound.origin === 'HND'),
  )

  // NRT matches pairs whose outbound lands NRT or whose inbound departs NRT.
  const nrt = (await (
    await app.request('/api/deals/roundtrip?destination=NRT')
  ).json()) as RoundtripDealsResponse
  assert.equal(nrt.total, all.total) // every seeded pair touches NRT on at least one leg

  const kix = (await (
    await app.request('/api/deals/roundtrip?destination=KIX')
  ).json()) as RoundtripDealsResponse
  assert.equal(kix.total, 0)
})

test('GET /api/availability/calendar filters by origin and destination together', async () => {
  const app = makeApp(seededDb(), null)
  const body = (await (
    await app.request('/api/availability/calendar?direction=outbound&origin=LAX&destination=HND')
  ).json()) as CalendarResponse
  assert.equal(body.days.length, 1)
  assert.equal(body.days[0]?.date, '2026-11-08')

  const none = (await (
    await app.request('/api/availability/calendar?direction=outbound&origin=YYZ&destination=HND')
  ).json()) as CalendarResponse
  assert.equal(none.days.length, 0)
})
