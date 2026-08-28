// Regression tests for the adversarial-review findings + previously untested invariants.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  openDb,
  startCycle,
  finishCycle,
  countConsecutiveFailedCycles,
  getAlertedDeal,
  getRecentCycles,
  metaGet,
  type Db,
} from '../src/db.js'
import { parseConfig, ConfigError } from '../src/config.js'
import { detectOneways, candidateLeg } from '../src/deals/oneway.js'
import { detectRoundtrips } from '../src/deals/roundtrip.js'
import { normalizeAvailability, type AvailabilityRecord, type TripDetail } from '../src/types.js'
import { runCycle, type ClientLike } from '../src/poll.js'
import { SeatsAeroClient } from '../src/seatsAero.js'
import { Scheduler } from '../src/scheduler.js'
import { SmsNotifier } from '../src/notify/sms.js'
import type { DealDigest, Notifier } from '../src/notify/notifier.js'
import { startMockServer, type MockServer } from './mockServer.js'
import { makeAvailability, searchPage, type AvailabilityOverrides } from './helpers/fixtures.js'

const openServers: MockServer[] = []
after(async () => {
  await Promise.all(openServers.map((s) => s.close()))
})

function rec(over: AvailabilityOverrides, direction: 'outbound' | 'return' = 'outbound'): AvailabilityRecord {
  const r = normalizeAvailability(makeAvailability(over), direction)
  assert.ok(r)
  return r
}

const cfg = parseConfig({})

class CaptureNotifier implements Notifier {
  digests: DealDigest[] = []
  failures: string[] = []
  async sendDigest(d: DealDigest) {
    this.digests.push(d)
  }
  async sendFailureNotice(msg: string) {
    this.failures.push(msg)
  }
}

// --- detection fixes -------------------------------------------------------

test('schema rejects proxy-priced sources inside search.sources', () => {
  assert.throws(
    () => parseConfig({ search: { sources: ['aeroplan', 'american'] } }),
    (err: unknown) => err instanceof ConfigError && err.issues.some((i) => i.path === 'search.sources'),
  )
})

test('defense in depth: proxy branch wins even if a config object sneaks in overlap', () => {
  // Bypass the schema deliberately (hand-mutated object) — candidateLeg must
  // still refuse to price american with its own mileage cost.
  const sneaky = structuredClone(cfg)
  sneaky.search.sources = [...sneaky.search.sources, 'american']
  const aaRecord = rec({
    id: 'aa1',
    source: 'american',
    origin: 'LAX',
    destination: 'HND',
    distance: 5476,
    jDirect: true,
    jAirlines: 'JL',
    jDirectAirlines: 'JL',
    jMileageCost: 60_000,
  })
  const leg = candidateLeg(aaRecord, sneaky)
  assert.ok(leg)
  assert.equal(leg.isEstimate, true)
  assert.equal(leg.points, 77_250) // estimate, never AA's 60k
})

test('directOnly yields no deal when the direct cost is missing/zero', () => {
  const directCfg = parseConfig({ search: { directOnly: true } })
  const noDirectCost = rec({ id: 'd1', jDirect: true, jDirectMileageCost: '0', jMileageCost: 85_000 })
  assert.equal(detectOneways([noDirectCost], directCfg).length, 0)
})

test('non-directOnly deals are labeled nonstop only when priced at the direct cost', () => {
  const cheaperConnection = rec({
    id: 'c1',
    jDirect: true,
    jMileageCost: 70_000,
    jDirectMileageCost: 88_000,
  })
  const deals = detectOneways([cheaperConnection], cfg)
  assert.equal(deals.length, 1)
  assert.equal(deals[0]?.points, 70_000)
  assert.equal(deals[0]?.direct, false) // priced itinerary is not the nonstop
})

test('proxy eligibility requires JL/AA in the DIRECT airlines specifically', () => {
  const wrongDirectCarrier = rec({
    id: 'p1',
    source: 'american',
    origin: 'LAX',
    destination: 'HND',
    distance: 5476,
    jDirect: true,
    jAirlines: 'JL', // connection carriers include JL...
    jDirectAirlines: 'AS', // ...but the nonstop is Alaska metal
  })
  assert.equal(detectOneways([wrongDirectCarrier], cfg).length, 0)
})

test('american and alaska estimates for the same seats collapse to one deal', () => {
  const base = {
    origin: 'LAX',
    destination: 'HND',
    date: '2027-04-02',
    distance: 5476,
    jDirect: true,
    jAirlines: 'JL',
    jDirectAirlines: 'JL',
  }
  const deals = detectOneways(
    [rec({ ...base, id: 'am', source: 'american' }), rec({ ...base, id: 'as', source: 'alaska' })],
    cfg,
  )
  assert.equal(deals.length, 1)
  assert.equal(deals[0]?.key, 'OW|avios-est|LAX|HND|2027-04-02')
})

test('roundtrip key is stable across pairing/program changes for the same trip', () => {
  const mk = (source: string, outCost: number, inCost: number) => [
    rec({ id: `o-${source}`, source, origin: 'YYZ', destination: 'NRT', date: '2027-03-01', jMileageCost: outCost }),
    rec({ id: `i-${source}`, source, origin: 'NRT', destination: 'YYZ', date: '2027-03-12', jMileageCost: inCost }, 'return'),
  ]
  const aeroplanPair = detectRoundtrips(mk('aeroplan', 80_000, 70_000), cfg)
  const qatarPair = detectRoundtrips(mk('qatar', 78_000, 69_000), cfg)
  assert.equal(aeroplanPair[0]?.key, qatarPair[0]?.key) // same cities+dates = same deal
})

// --- state/quota fixes -----------------------------------------------------

test('aborted_quota cycles do not count toward the failure notice', () => {
  const db = openDb(':memory:')
  const add = (status: 'ok' | 'error' | 'aborted_quota', at: string) => {
    const id = startCycle(db, 'scheduled', at)
    finishCycle(db, id, {
      finishedAt: at,
      status,
      callsUsed: 0,
      recordsFetched: 0,
      onewaysFound: 0,
      roundtripsFound: 0,
      alertsSent: 0,
    })
  }
  add('ok', '2026-08-15T00:00:00Z')
  add('error', '2026-08-15T02:00:00Z')
  add('aborted_quota', '2026-08-15T04:00:00Z')
  add('error', '2026-08-15T06:00:00Z')
  assert.equal(countConsecutiveFailedCycles(db), 1) // stops at aborted_quota
})

function hangingClientFactory(): { factory: () => ClientLike; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const client: ClientLike = {
    async search() {
      await gate
      return { records: [], truncated: false, pageCapped: false, invalidCount: 0, pages: 1 }
    },
    async getTrips(): Promise<TripDetail | null> {
      return null
    },
  }
  return { factory: () => client, release }
}

test('cross-process cycle lock: a second concurrent cycle refuses to run', async () => {
  const db = openDb(':memory:')
  const notifier = new CaptureNotifier()
  const hung = hangingClientFactory()
  const deps = { db, cfg, clientFactory: hung.factory, notifier }

  const first = runCycle(deps, { trigger: 'manual' })
  await new Promise((r) => setTimeout(r, 20)) // let the first acquire the lock
  const second = await runCycle(deps, { trigger: 'manual' })
  assert.equal(second.status, 'error')
  assert.match(second.error ?? '', /already running/)

  hung.release()
  const firstOutcome = await first
  assert.equal(firstOutcome.status, 'ok')

  // Lock released: a new cycle runs fine.
  const third = await runCycle(deps, { trigger: 'manual' })
  assert.equal(third.status, 'ok')
})

test('pre-flight quota abort records last_cycle_at (no scheduler hot-loop)', async () => {
  const db = openDb(':memory:')
  const tight = parseConfig({ api: { dailyCallBudget: 40, reserveCalls: 50 } })
  const hung = hangingClientFactory()
  const startedAt = new Date('2026-08-15T12:00:00Z')
  const outcome = await runCycle(
    { db, cfg: tight, clientFactory: hung.factory, notifier: new CaptureNotifier(), now: () => startedAt },
    { trigger: 'scheduled' },
  )
  assert.equal(outcome.status, 'aborted_quota')
  assert.equal(metaGet(db, 'last_cycle_at'), startedAt.toISOString())
  // Drift-corrected scheduler now waits a full interval instead of firing again immediately.
  const scheduler = new Scheduler({
    runner: async () => outcome,
    getIntervalHours: () => 2,
    getLastCycleAt: () => metaGet(db, 'last_cycle_at'),
    now: () => startedAt,
  })
  assert.equal(scheduler.nextRunAt(), '2026-08-15T14:00:00.000Z')
})

test('mid-flight quota exhaustion keeps partial data and marks aborted_quota', async () => {
  const server = await startMockServer({
    searchPagesByOrigin: {
      'YYZ,ORD,YVR,LAX': [
        searchPage(
          [makeAvailability({ id: 'q1', source: 'aeroplan', origin: 'YYZ', destination: 'NRT', date: '2026-11-05', jMileageCost: 62_500 })],
          { hasMore: true, cursor: 1755999999 },
        ),
      ],
    },
    quotaAfterRequests: 1, // page 1 succeeds, then everything 429s
  })
  openServers.push(server)
  const db = openDb(':memory:')
  const notifier = new CaptureNotifier()
  const outcome = await runCycle(
    {
      db,
      cfg: parseConfig({ api: { baseUrl: server.url } }),
      clientFactory: (onCall) =>
        new SeatsAeroClient({ baseUrl: server.url, apiKey: 'pro_test', onCall, backoffBaseMs: 1, quotaRetryMs: 2 }),
      notifier,
    },
    { trigger: 'scheduled' },
  )
  assert.equal(outcome.status, 'aborted_quota')
  assert.equal(outcome.recordsFetched, 1) // partial page persisted
  assert.equal(outcome.onewaysFound, 1) // detection still ran on partial data
  assert.equal(notifier.digests.length, 1) // digest still went out
})

test('overflowed deals are NOT marked alerted and resurface next cycle', async () => {
  const server = await startMockServer({
    searchPagesByOrigin: {
      'YYZ,ORD,YVR,LAX': [
        searchPage([
          makeAvailability({ id: 'v1', source: 'aeroplan', origin: 'YYZ', destination: 'NRT', date: '2026-11-05', jMileageCost: 60_000 }),
          makeAvailability({ id: 'v2', source: 'aeroplan', origin: 'ORD', destination: 'NRT', date: '2026-11-06', jMileageCost: 65_000 }),
          makeAvailability({ id: 'v3', source: 'aeroplan', origin: 'YVR', destination: 'NRT', date: '2026-11-07', jMileageCost: 70_000 }),
        ]),
      ],
    },
  })
  openServers.push(server)
  const db = openDb(':memory:')
  const notifier = new CaptureNotifier()
  const capped = parseConfig({ api: { baseUrl: server.url }, alerts: { maxOnewaysPerAlert: 1 } })
  const deps = {
    db,
    cfg: capped,
    clientFactory: (onCall: Parameters<typeof SeatsAeroClient.prototype.search>[0] extends never ? never : (endpoint: 'search' | 'trips' | 'routes', remaining: number | null) => void) =>
      new SeatsAeroClient({ baseUrl: server.url, apiKey: 'pro_test', onCall, backoffBaseMs: 1, quotaRetryMs: 2 }),
    notifier,
  }

  const first = await runCycle(deps, { trigger: 'manual' })
  assert.equal(first.alertsSent, 1) // only the emailed deal counts
  assert.equal(notifier.digests[0]?.oneways.length, 1)
  assert.equal(notifier.digests[0]?.onewayOverflowCount, 2)
  assert.equal(notifier.digests[0]?.oneways[0]?.deal.points, 60_000)
  assert.ok(getAlertedDeal(db, 'OW|aeroplan|YYZ|NRT|2026-11-05'))
  assert.equal(getAlertedDeal(db, 'OW|aeroplan|ORD|NRT|2026-11-06'), undefined) // overflow not recorded

  const second = await runCycle(deps, { trigger: 'manual' })
  assert.equal(second.alertsSent, 1)
  assert.equal(notifier.digests[1]?.oneways[0]?.deal.points, 65_000) // next-cheapest trickles through
})

test('failure notice fires at 6 consecutive errors, throttled to one per 24h', async () => {
  const db = openDb(':memory:')
  const notifier = new CaptureNotifier()
  const failing: ClientLike = {
    async search() {
      throw new Error('boom')
    },
    async getTrips() {
      return null
    },
  }
  let clock = Date.parse('2026-08-15T00:00:00Z')
  const deps = {
    db,
    cfg,
    clientFactory: () => failing,
    notifier,
    now: () => new Date((clock += 60_000)),
  }
  for (let i = 0; i < 5; i++) await runCycle(deps, { trigger: 'scheduled' })
  assert.equal(notifier.failures.length, 0)
  await runCycle(deps, { trigger: 'scheduled' }) // 6th failure
  assert.equal(notifier.failures.length, 1)
  await runCycle(deps, { trigger: 'scheduled' }) // 7th, inside 24h — throttled
  assert.equal(notifier.failures.length, 1)
  clock += 25 * 3_600_000 // beyond the 24h window
  await runCycle(deps, { trigger: 'scheduled' })
  assert.equal(notifier.failures.length, 2)
})

// --- SMS retry -------------------------------------------------------------

test('SmsNotifier retries transient failures and rethrows after 3 attempts', async () => {
  const smsCfg = parseConfig({ sms: { to: ['+14165551234'], from: '+16475550123' } })
  const creds = { accountSid: 'ACtest', authToken: 'tok' }
  const digest: DealDigest = {
    generatedAt: new Date().toISOString(),
    oneways: [],
    roundtrips: [],
    onewayOverflowCount: 0,
    roundtripOverflowCount: 0,
    roundtripOverflowFromPoints: null,
    notes: [],
  }
  let calls = 0
  const flaky = async () => {
    calls++
    if (calls < 2) throw new Error('carrier hiccup')
  }
  const notifier = new SmsNotifier(smsCfg, creds, { retryDelayMs: 1, transport: flaky })
  await notifier.sendDigest(digest) // fails once, succeeds on retry
  assert.equal(calls, 2)

  let always = 0
  const dead = async () => {
    always++
    throw new Error('Twilio down')
  }
  const failing = new SmsNotifier(smsCfg, creds, { retryDelayMs: 1, transport: dead })
  await assert.rejects(failing.sendDigest(digest), /Twilio down/)
  assert.equal(always, 3)
})

// --- scheduler live loop ---------------------------------------------------

test('scheduler loop runs, re-arms, and respects the manual-run mutex', async () => {
  let runs = 0
  let lastAt: string | undefined
  const scheduler = new Scheduler({
    runner: async () => {
      runs++
      lastAt = new Date().toISOString()
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
    },
    getIntervalHours: () => 0.00002, // 72ms
    getLastCycleAt: () => lastAt,
  })
  scheduler.start()
  await new Promise((r) => setTimeout(r, 350))
  scheduler.stop()
  assert.ok(runs >= 2, `expected >=2 scheduled runs, got ${runs}`)

  // Manual run works after stop; a second concurrent manual run is refused.
  const p = scheduler.runExclusive('manual')
  assert.ok(p)
  assert.equal(scheduler.runExclusive('manual'), null)
  await p
})

// --- config PUT pinning ----------------------------------------------------

test('PUT /api/config omitting read-only sections keeps current values (no default overwrite)', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadConfig, writeConfig, parseConfig: pc } = await import('../src/config.js')
  const { buildApp } = await import('../src/server/app.js')

  const dir = mkdtempSync(join(tmpdir(), 'deal-finder-pin-'))
  const path = join(dir, 'config.yaml')
  writeFileSync(path, 'db:\n  path: "./custom/deals.db"\nserver:\n  port: 9123\n')
  const configRef = { current: loadConfig(path) }
  const app = buildApp({
    db: openDb(':memory:'),
    getConfig: () => configRef.current,
    scheduler: null,
    configApi: {
      path,
      apply: (raw) => {
        const parsed = pc(raw)
        writeConfig(path, parsed)
        configRef.current = parsed
        return parsed
      },
    },
    envPresence: () => ({ seatsAeroApiKey: true, twilioCreds: true }),
    version: 'test',
  })

  const res = await app.request('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ thresholds: { onewayMaxPoints: 80_000, roundtripMaxPoints: 180_000 } }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 200)
  assert.equal(configRef.current.db.path, './custom/deals.db')
  assert.equal(configRef.current.server.port, 9123)
  assert.equal(configRef.current.thresholds.onewayMaxPoints, 80_000)
})

// --- stuck cycle reconciliation --------------------------------------------

test('a crashed cycle left running is reconciled by the next cycle', async () => {
  const db = openDb(':memory:')
  startCycle(db, 'scheduled', '2026-08-15T10:00:00Z') // never finished (simulated crash)
  const hung = hangingClientFactory()
  hung.release()
  const outcome = await runCycle(
    { db, cfg, clientFactory: hung.factory, notifier: new CaptureNotifier() },
    { trigger: 'manual' },
  )
  assert.equal(outcome.status, 'ok')
  const cycles = getRecentCycles(db, 10)
  const stale = cycles.find((c) => c.started_at === '2026-08-15T10:00:00Z')
  assert.equal(stale?.status, 'error')
  assert.match(stale?.error_message ?? '', /interrupted/)
})
