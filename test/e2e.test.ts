import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, getAlertedDeal, getRecentCycles, countAvailability, type Db } from '../src/db.js'
import { parseConfig } from '../src/config.js'
import { SeatsAeroClient } from '../src/seatsAero.js'
import { runCycle } from '../src/poll.js'
import type { DealDigest, Notifier } from '../src/notify/notifier.js'
import { renderText, subjectFor } from '../src/notify/render.js'
import { startMockServer, type MockServer } from './mockServer.js'
import { makeAvailability, searchPage } from './helpers/fixtures.js'

const openServers: MockServer[] = []
after(async () => {
  await Promise.all(openServers.map((s) => s.close()))
})

const OUTBOUND_KEY = 'YYZ,ORD,YVR,LAX'
const RETURN_KEY = 'NRT,HND'

function fixtureServerOptions() {
  return {
    searchPagesByOrigin: {
      [OUTBOUND_KEY]: [
        searchPage([
          // Qualifying one-way: Aeroplan YYZ->NRT 62.5k nonstop ANA.
          makeAvailability({ id: 'ob-1', source: 'aeroplan', origin: 'YYZ', destination: 'NRT', date: '2026-11-05', jMileageCost: 62_500, jAirlines: 'NH', jDirectAirlines: 'NH' }),
          // Above one-way cap but pairable: Qatar ORD->NRT 96k.
          makeAvailability({ id: 'ob-2', source: 'qatar', origin: 'ORD', destination: 'NRT', date: '2026-11-05', jMileageCost: 96_000, jDirect: false, jAirlines: 'QR' }),
          // Too expensive for anything: 200k.
          makeAvailability({ id: 'ob-3', source: 'aeroplan', origin: 'LAX', destination: 'HND', date: '2026-11-06', jMileageCost: 200_000 }),
        ]),
      ],
      [RETURN_KEY]: [
        searchPage([
          // Qualifying return: 70k -> pairs with ob-1 (11 nights, 132.5k total).
          makeAvailability({ id: 'rt-1', source: 'aeroplan', origin: 'NRT', destination: 'YYZ', date: '2026-11-16', jMileageCost: 70_000, jAirlines: 'AC', jDirectAirlines: 'AC' }),
        ]),
      ],
    },
    trips: {
      'ob-1': {
        data: [
          {
            ID: 'trip-1',
            AvailabilityID: 'ob-1',
            MileageCost: '62500',
            TotalTaxes: 11200,
            TaxesCurrency: 'CAD',
            FlightNumbers: 'NH116',
            DepartsAt: '2026-11-05T17:15:00Z',
            ArrivesAt: '2026-11-06T19:50:00Z',
            Stops: 0,
            Carriers: 'ANA',
            Cabin: 'business',
          },
        ],
        booking_links: [{ label: 'Book on Aeroplan', link: 'https://www.aircanada.com/aeroplan', primary: true }],
      },
    },
  }
}

class CaptureNotifier implements Notifier {
  digests: DealDigest[] = []
  failNext = false
  async sendDigest(digest: DealDigest): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('Twilio down (simulated)')
    }
    this.digests.push(digest)
  }
}

function deps(db: Db, url: string, notifier: Notifier) {
  const cfg = parseConfig({ api: { baseUrl: url } })
  return {
    db,
    cfg,
    clientFactory: (onCall: (endpoint: 'search' | 'trips' | 'routes', remaining: number | null) => void) =>
      new SeatsAeroClient({ baseUrl: url, apiKey: 'pro_test', onCall, backoffBaseMs: 1, quotaRetryMs: 5 }),
    notifier,
    now: () => new Date('2026-08-15T12:00:00Z'),
  }
}

test('full cycle: fetch -> detect -> alert once -> silent second cycle', async () => {
  const server = await startMockServer(fixtureServerOptions())
  openServers.push(server)
  const db = openDb(':memory:')
  const notifier = new CaptureNotifier()

  const outcome = await runCycle(deps(db, server.url, notifier), { trigger: 'manual' })
  assert.equal(outcome.status, 'ok')
  assert.equal(outcome.recordsFetched, 4)
  assert.equal(countAvailability(db), 4)
  assert.equal(outcome.onewaysFound, 2) // ob-1 (62.5k) and rt-1 (70k)
  assert.ok(outcome.roundtripsFound >= 1)
  assert.equal(outcome.alertsSent, outcome.onewaysFound + outcome.roundtripsFound)
  assert.equal(notifier.digests.length, 1)

  // Digest content sanity.
  const digest = notifier.digests[0]!
  const text = renderText(digest)
  assert.match(subjectFor(digest), /one-ways from 62.5k/)
  assert.match(text, /YYZ → NRT/)
  assert.match(text, /Aeroplan/)
  assert.match(text, /62,500/)
  assert.match(text, /NH116/) // trips enrichment made it in
  assert.match(text, /Book on Aeroplan|aircanada/i)
  assert.match(text, /TOTAL 132,500 pts · 11 nights/)
  assert.match(text, /seats\.aero/) // attribution

  // Alert state recorded.
  assert.ok(getAlertedDeal(db, 'OW|aeroplan|YYZ|NRT|2026-11-05'))

  // Second cycle: nothing new — no alert.
  const second = await runCycle(deps(db, server.url, notifier), { trigger: 'manual' })
  assert.equal(second.status, 'ok')
  assert.equal(second.alertsSent, 0)
  assert.equal(notifier.digests.length, 1)

  const cycles = getRecentCycles(db, 10)
  assert.equal(cycles.length, 2)
  assert.ok(cycles.every((c) => c.status === 'ok'))
})

test('failed SMS send leaves alert state untouched (free retry next cycle)', async () => {
  const server = await startMockServer(fixtureServerOptions())
  openServers.push(server)
  const db = openDb(':memory:')
  const notifier = new CaptureNotifier()
  notifier.failNext = true

  const first = await runCycle(deps(db, server.url, notifier), { trigger: 'manual' })
  assert.equal(first.status, 'error')
  assert.equal(getAlertedDeal(db, 'OW|aeroplan|YYZ|NRT|2026-11-05'), undefined)

  // Next cycle re-detects and sends successfully.
  const second = await runCycle(deps(db, server.url, notifier), { trigger: 'manual' })
  assert.equal(second.status, 'ok')
  assert.ok(second.alertsSent > 0)
  assert.equal(notifier.digests.length, 1)
  assert.ok(getAlertedDeal(db, 'OW|aeroplan|YYZ|NRT|2026-11-05'))
})

test('dry run returns a digest but writes no alert state and sends nothing', async () => {
  const server = await startMockServer(fixtureServerOptions())
  openServers.push(server)
  const db = openDb(':memory:')
  const notifier = new CaptureNotifier()

  const outcome = await runCycle(deps(db, server.url, notifier), { trigger: 'manual', dryRun: true })
  assert.equal(outcome.status, 'ok')
  assert.ok(outcome.digest)
  assert.equal(notifier.digests.length, 0)
  assert.equal(getAlertedDeal(db, 'OW|aeroplan|YYZ|NRT|2026-11-05'), undefined)
  // Dry run also skips /trips enrichment (no quota burned on detail).
  assert.equal(server.requests.filter((r) => r.endpoint === 'trips').length, 0)
})

test('runCycle ignores off-grid records from the API (poller/console parity)', async () => {
  const opts = fixtureServerOptions()
  // Simulate an API anomaly: an extra record outside the configured grid comes
  // back on the outbound page (destination ICN is not in cfg.search.destinations).
  // detects should exclude it exactly as the web read model would (deals/scope.ts).
  opts.searchPagesByOrigin[OUTBOUND_KEY] = [
    searchPage([
      ...opts.searchPagesByOrigin[OUTBOUND_KEY]![0]!.data,
      makeAvailability({ id: 'off-grid', source: 'aeroplan', origin: 'YYZ', destination: 'ICN', date: '2026-11-05', jMileageCost: 40_000 }),
    ]),
  ]
  const server = await startMockServer(opts)
  openServers.push(server)
  const db = openDb(':memory:')
  const notifier = new CaptureNotifier()

  const outcome = await runCycle(deps(db, server.url, notifier), { trigger: 'manual' })
  assert.equal(outcome.status, 'ok')
  assert.equal(outcome.recordsFetched, 5) // the off-grid row is stored...
  assert.equal(outcome.onewaysFound, 2) // ...but never detected as a deal
  const digest = notifier.digests[0]!
  assert.ok(!digest.oneways.some((o) => o.deal.destination === 'ICN'))
})

test('runCycle respects onewayMaxPoints threshold (config-honoring regression check)', async () => {
  const opts = fixtureServerOptions()
  // Add a deal that exceeds the default onewayMaxPoints (90k).
  opts.searchPagesByOrigin[OUTBOUND_KEY] = [
    searchPage([
      ...opts.searchPagesByOrigin[OUTBOUND_KEY]![0]!.data,
      makeAvailability({ id: 'over-cap', source: 'qatar', origin: 'YYZ', destination: 'NRT', date: '2026-11-05', jMileageCost: 95_000, jAirlines: 'QR' }),
    ]),
  ]
  const server = await startMockServer(opts)
  openServers.push(server)
  const db = openDb(':memory:')
  const notifier = new CaptureNotifier()

  const outcome = await runCycle(deps(db, server.url, notifier), { trigger: 'manual' })
  assert.equal(outcome.status, 'ok')
  assert.equal(outcome.recordsFetched, 5) // stored including the over-cap row
  const digest = notifier.digests[0]!
  // The over-cap Qatar deal must not appear in the digest, even though it's stored.
  assert.ok(!digest.oneways.some((o) => o.deal.points === 95_000 && o.deal.program.includes('Qatar')))
})

test('runCycle respects directOnly constraint (config-honoring regression check)', async () => {
  const opts = fixtureServerOptions()
  // Add a connecting (non-direct) deal that would be filtered out when directOnly is true.
  opts.searchPagesByOrigin[OUTBOUND_KEY] = [
    searchPage([
      ...opts.searchPagesByOrigin[OUTBOUND_KEY]![0]!.data,
      makeAvailability({ id: 'connecting', source: 'aeroplan', origin: 'ORD', destination: 'NRT', date: '2026-11-05', jMileageCost: 75_000, jDirect: false, jAirlines: 'AC+NH' }),
    ]),
  ]
  const server = await startMockServer(opts)
  openServers.push(server)
  const db = openDb(':memory:')
  const notifier = new CaptureNotifier()
  const d = deps(db, server.url, notifier)
  // Override config to enable directOnly.
  d.cfg = parseConfig({ api: { baseUrl: server.url }, search: { directOnly: true } })

  const outcome = await runCycle(d, { trigger: 'manual' })
  assert.equal(outcome.status, 'ok')
  assert.equal(outcome.recordsFetched, 5) // stored including the connecting row
  const digest = notifier.digests[0]!
  // The connecting deal must not appear when directOnly is true.
  assert.ok(!digest.oneways.some((o) => o.deal.direct === false))
})

test('cycle aborts before any API call when the budget is exhausted', async () => {
  const server = await startMockServer(fixtureServerOptions())
  openServers.push(server)
  const db = openDb(':memory:')
  const notifier = new CaptureNotifier()
  const d = deps(db, server.url, notifier)
  d.cfg = parseConfig({ api: { baseUrl: server.url, dailyCallBudget: 40, reserveCalls: 50 } })

  const outcome = await runCycle(d, { trigger: 'scheduled' })
  assert.equal(outcome.status, 'aborted_quota')
  assert.equal(server.requests.length, 0)
})
