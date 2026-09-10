import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { SeatsAeroClient, BadRequestError, QuotaExhaustedError } from '../src/seatsAero.js'
import { startMockServer, type MockServer } from './mockServer.js'
import { makeAvailability, makeTrip, searchPage } from './helpers/fixtures.js'

const openServers: MockServer[] = []
after(async () => {
  await Promise.all(openServers.map((s) => s.close()))
})

function makeClient(url: string, onCall?: (endpoint: string, remaining: number | null) => void) {
  return new SeatsAeroClient({
    baseUrl: url,
    apiKey: 'pro_test',
    onCall,
    backoffBaseMs: 1,
    quotaRetryMs: 5,
    timeoutMs: 5_000,
  })
}

test('search paginates all pages, dedupes cross-page IDs, counts invalid records', async () => {
  const dup = makeAvailability({ id: 'dup-1', jMileageCost: 60000 })
  const server = await startMockServer({
    searchPages: [
      searchPage([makeAvailability({ id: 'a1', jMileageCost: 62500 }), dup], {
        hasMore: true,
        cursor: 1755111111,
      }),
      searchPage([dup, makeAvailability({ id: 'a2', jMileageCost: 88000 }), { garbage: true }], {
        hasMore: true,
      }),
      searchPage([makeAvailability({ id: 'a3', jAvailable: false })], { hasMore: false }),
    ],
  })
  openServers.push(server)

  const client = makeClient(server.url)
  const result = await client.search({
    origins: ['YYZ', 'ORD', 'YVR', 'LAX'],
    destinations: ['NRT', 'HND'],
    sources: ['aeroplan', 'flyingblue', 'qatar'],
    startDate: '2026-08-15',
    endDate: '2027-08-05',
    direction: 'outbound',
  })

  assert.equal(result.pages, 3)
  assert.equal(result.records.length, 4) // a1, dup-1, a2, a3 — dup only once
  assert.equal(result.invalidCount, 1)
  assert.equal(result.truncated, false)
  assert.equal(result.records[0]?.jMileageCost, 62500)
  assert.equal(result.records[0]?.direction, 'outbound')

  // Pagination contract: page 2+ carries skip and the first response's cursor.
  const searchReqs = server.requests.filter((r) => r.endpoint === 'search')
  assert.equal(searchReqs.length, 3)
  assert.ok(searchReqs[0]?.path.includes('origin_airport=YYZ,ORD,YVR,LAX'))
  assert.ok(searchReqs[0]?.path.includes('cabins=business'))
  assert.ok(!searchReqs[0]?.path.includes('skip='))
  assert.ok(searchReqs[1]?.path.includes('skip=2'))
  assert.ok(searchReqs[1]?.path.includes('cursor=1755111111'))
})

test('400 throws BadRequestError without retrying', async () => {
  const server = await startMockServer({})
  openServers.push(server)
  server.setMode('error400')
  const client = makeClient(server.url)
  await assert.rejects(
    client.search({
      origins: ['YYZ'],
      destinations: ['NRT'],
      sources: ['aeroplan'],
      startDate: '2026-08-15',
      endDate: '2026-09-15',
      direction: 'outbound',
    }),
    BadRequestError,
  )
  assert.equal(server.requests.length, 1)
})

test('persistent 429 throws QuotaExhaustedError after one retry', async () => {
  const server = await startMockServer({})
  openServers.push(server)
  server.setMode('error429')
  const client = makeClient(server.url)
  await assert.rejects(
    client.search({
      origins: ['YYZ'],
      destinations: ['NRT'],
      sources: ['aeroplan'],
      startDate: '2026-08-15',
      endDate: '2026-09-15',
      direction: 'outbound',
    }),
    QuotaExhaustedError,
  )
  assert.equal(server.requests.length, 2) // original + one retry
})

test('transient 5xx is retried until success', async () => {
  const server = await startMockServer({
    searchPages: [searchPage([makeAvailability({ id: 'ok-1' })])],
    flakyFailures: 2,
  })
  openServers.push(server)
  server.setMode('flaky500')
  const client = makeClient(server.url)
  const result = await client.search({
    origins: ['YYZ'],
    destinations: ['NRT'],
    sources: ['aeroplan'],
    startDate: '2026-08-15',
    endDate: '2026-09-15',
    direction: 'outbound',
  })
  assert.equal(result.records.length, 1)
  assert.equal(server.requests.length, 3)
})

test('onCall reports rate-limit remaining for every request', async () => {
  const server = await startMockServer({
    searchPages: [searchPage([makeAvailability({})])],
  })
  openServers.push(server)
  const calls: Array<{ endpoint: string; remaining: number | null }> = []
  const client = makeClient(server.url, (endpoint, remaining) => calls.push({ endpoint, remaining }))
  await client.search({
    origins: ['YYZ'],
    destinations: ['NRT'],
    sources: ['aeroplan'],
    startDate: '2026-08-15',
    endDate: '2026-09-15',
    direction: 'outbound',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.endpoint, 'search')
  assert.equal(typeof calls[0]?.remaining, 'number')
})

test('getTrips returns cheapest business trip with booking links; null when missing', async () => {
  const server = await startMockServer({
    trips: {
      'avail-x': {
        data: [
          makeTrip({ MileageCost: '75000', FlightNumbers: 'AC1' }),
          makeTrip({ MileageCost: '62500', FlightNumbers: 'NH116', TotalTaxes: 11200 }),
          makeTrip({ MileageCost: '10000', Cabin: 'economy', FlightNumbers: 'NH-ECO' }),
        ],
        booking_links: [{ label: 'Book on Aeroplan', link: 'https://www.aircanada.com', primary: true }],
      },
    },
  })
  openServers.push(server)
  const client = makeClient(server.url)

  const detail = await client.getTrips('avail-x')
  assert.ok(detail)
  assert.equal(detail.flightNumbers, 'NH116')
  assert.equal(detail.totalTaxes, 11200)
  assert.equal(detail.bookingLinks[0]?.primary, true)

  const missing = await client.getTrips('nope')
  assert.equal(missing, null)
})

test('getRoutes parses route horizon info', async () => {
  const server = await startMockServer({
    routes: {
      aeroplan: [
        {
          ID: 'r1',
          OriginAirport: 'YYZ',
          DestinationAirport: 'NRT',
          NumDaysOut: 340,
          Distance: 6430,
          Source: 'aeroplan',
        },
      ],
    },
  })
  openServers.push(server)
  const client = makeClient(server.url)
  const routes = await client.getRoutes('aeroplan')
  assert.equal(routes.length, 1)
  assert.equal(routes[0]?.numDaysOut, 340)
})

test('getTripsFull returns all business options sorted by mileage, with segments and layovers', async () => {
  const server = await startMockServer({
    trips: {
      'avail-full': {
        data: [
          makeTrip({
            MileageCost: '75000',
            FlightNumbers: 'AC5, AC6',
            Stops: 1,
            AvailabilitySegments: [
              {
                FlightNumber: 'AC6',
                OriginAirport: 'YVR',
                DestinationAirport: 'NRT',
                DepartsAt: '2026-11-05T13:30:00Z',
                ArrivesAt: '2026-11-06T01:50:00Z',
                AircraftName: '789',
                FareClass: 'I',
                Order: 1,
              },
              {
                FlightNumber: 'AC5',
                OriginAirport: 'YYZ',
                DestinationAirport: 'YVR',
                DepartsAt: '2026-11-05T08:00:00Z',
                ArrivesAt: '2026-11-05T10:05:00Z',
                AircraftName: '77W',
                FareClass: 'I',
                Order: 0,
              },
            ],
          }),
          makeTrip({ MileageCost: '62500', FlightNumbers: 'NH116', RemainingSeats: 0 }),
          makeTrip({ MileageCost: '10000', Cabin: 'economy' }),
          makeTrip({ MileageCost: null, FlightNumbers: 'NO-PRICE' }),
        ],
        booking_links: [
          { label: 'Book via LifeMiles', link: 'https://www.lifemiles.com/fly/find', primary: true },
          { label: 'Book via Aeroplan', link: 'https://www.aircanada.com/aeroplan', primary: false },
          { label: 'Evil', link: 'javascript:alert(1)', primary: false },
          { label: 'Broken', link: 'not a url', primary: false },
        ],
      },
    },
  })
  openServers.push(server)
  const client = makeClient(server.url)

  const full = await client.getTripsFull('avail-full')
  // economy and unpriced options are dropped; remaining sorted by mileage.
  assert.equal(full.options.length, 2)
  assert.equal(full.options[0]?.flightNumbers, 'NH116')
  assert.equal(full.options[0]?.seats, null) // RemainingSeats 0 → null ("—" convention)
  assert.equal(full.options[1]?.mileageCost, 75000)

  // Segments ordered by Order, layover derived, last segment null by contract.
  const segs = full.options[1]?.segments ?? []
  assert.equal(segs.length, 2)
  assert.equal(segs[0]?.flightNumber, 'AC5')
  assert.equal(segs[0]?.layoverMinutesAfter, 205) // 10:05 → 13:30
  assert.equal(segs[1]?.layoverMinutesAfter, null)
  assert.equal(segs[1]?.aircraftName, '789')

  // Non-http(s) and unparseable links are stripped; order preserved.
  assert.deepEqual(
    full.bookingLinks.map((b) => b.label),
    ['Book via LifeMiles', 'Book via Aeroplan'],
  )
})

test('getTripsFull throws NotFoundError on 404 and URL-encodes the id', async () => {
  const { NotFoundError } = await import('../src/seatsAero.js')
  const server = await startMockServer({ trips: {} })
  openServers.push(server)
  const client = makeClient(server.url)
  await assert.rejects(client.getTripsFull('gone-id'), NotFoundError)
  await assert.rejects(client.getTripsFull('../search?x'), NotFoundError)
  const tripReqs = server.requests.filter((r) => r.endpoint === 'trips')
  assert.ok(tripReqs[1]?.path.includes(encodeURIComponent('../search?x')))
})

test('getTrips rethrows only QuotaExhaustedError; every other failure returns null', async () => {
  // 404 → null (regression guard: poll enrichment depends on this contract).
  const server = await startMockServer({ trips: {} })
  openServers.push(server)
  const client = makeClient(server.url)
  assert.equal(await client.getTrips('gone'), null)

  // Persistent 429 → QuotaExhaustedError propagates.
  const quotaServer = await startMockServer({})
  quotaServer.setMode('error429')
  openServers.push(quotaServer)
  const quotaClient = makeClient(quotaServer.url)
  await assert.rejects(quotaClient.getTrips('any'), QuotaExhaustedError)
})
