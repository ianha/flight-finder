import {
  normalizeAvailability,
  searchResponseSchema,
  tripsResponseSchema,
  apiTripSchema,
  apiRouteSchema,
  parseMileage,
  type AvailabilityRecord,
  type Direction,
  type TripDetail,
} from './types.js'
import { log } from './log.js'

export type ApiEndpoint = 'search' | 'trips' | 'routes'

/** Thrown on HTTP 400 (empty body by API contract) — a request-construction bug; never retried. */
export class BadRequestError extends Error {
  constructor(readonly url: string) {
    super(`seats.aero returned 400 for ${url}`)
    this.name = 'BadRequestError'
  }
}

/** Thrown when 429 persists after the single long retry — the cycle should abort gracefully. */
export class QuotaExhaustedError extends Error {
  constructor() {
    super('seats.aero daily API quota exhausted (429)')
    this.name = 'QuotaExhaustedError'
  }
}

export interface SeatsAeroClientOptions {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  /** Called after every completed HTTP request with the X-RateLimit-Remaining header value (null if absent). */
  onCall?: (endpoint: ApiEndpoint, rateLimitRemaining: number | null) => void
  timeoutMs?: number
  /** Attempts for network/5xx errors. */
  maxAttempts?: number
  /** Base backoff (grows 1x, 4x, 16x + jitter). Tests pass a tiny value. */
  backoffBaseMs?: number
  /** Delay before the single 429 retry. */
  quotaRetryMs?: number
}

export interface SearchParams {
  origins: string[]
  destinations: string[]
  sources: string[]
  startDate: string
  endDate: string
  direction: Direction
  take?: number
}

export interface SearchResult {
  records: AvailabilityRecord[]
  /** True when pagination stopped early (quota exhausted mid-flight). */
  truncated: boolean
  invalidCount: number
  pages: number
}

export interface RouteInfo {
  origin: string
  destination: string
  numDaysOut: number | null
  distance: number | null
  source: string
}

const MAX_PAGES = 50 // hard safety stop; realistic result sets are well under this

export class SeatsAeroClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly backoffBaseMs: number
  private readonly quotaRetryMs: number

  constructor(private readonly opts: SeatsAeroClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.maxAttempts = opts.maxAttempts ?? 3
    this.backoffBaseMs = opts.backoffBaseMs ?? 1_000
    this.quotaRetryMs = opts.quotaRetryMs ?? 60_000
  }

  private async request(endpoint: ApiEndpoint, path: string): Promise<unknown> {
    const url = `${this.opts.baseUrl}${path}`
    let attempt = 0
    let quotaRetried = false
    for (;;) {
      attempt++
      let res: Response
      try {
        res = await this.fetchImpl(url, {
          headers: {
            'Partner-Authorization': this.opts.apiKey,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (err) {
        if (attempt >= this.maxAttempts) throw err
        await this.backoff(attempt)
        continue
      }

      const remainingHeader = res.headers.get('x-ratelimit-remaining')
      const remaining = remainingHeader !== null ? parseInt(remainingHeader, 10) : null
      this.opts.onCall?.(endpoint, Number.isFinite(remaining as number) ? remaining : null)

      if (res.status === 400) throw new BadRequestError(url)
      if (res.status === 429) {
        if (quotaRetried) throw new QuotaExhaustedError()
        quotaRetried = true
        log.warn(`429 from seats.aero — waiting ${this.quotaRetryMs}ms before one retry`)
        await sleep(this.quotaRetryMs)
        continue
      }
      if (res.status >= 500) {
        if (attempt >= this.maxAttempts) {
          throw new Error(`seats.aero ${res.status} for ${url} after ${attempt} attempts`)
        }
        await this.backoff(attempt)
        continue
      }
      if (!res.ok) throw new Error(`seats.aero unexpected ${res.status} for ${url}`)
      return res.json()
    }
  }

  private async backoff(attempt: number): Promise<void> {
    const base = this.backoffBaseMs * Math.pow(4, attempt - 1)
    await sleep(base + Math.random() * base)
  }

  /**
   * Cached search over the full airport grid, fully paginated.
   * On mid-pagination quota exhaustion, returns what was fetched with truncated=true.
   */
  async search(params: SearchParams): Promise<SearchResult> {
    const take = params.take ?? 1000
    const base =
      `/search?origin_airport=${params.origins.join(',')}` +
      `&destination_airport=${params.destinations.join(',')}` +
      `&cabins=business&sources=${params.sources.join(',')}` +
      `&start_date=${params.startDate}&end_date=${params.endDate}` +
      `&take=${take}&order_by=lowest_mileage`

    const seen = new Set<string>()
    const records: AvailabilityRecord[] = []
    let invalidCount = 0
    let skip = 0
    let cursor: number | string | undefined
    let pages = 0

    for (;;) {
      let path = base
      if (pages > 0) {
        path += `&skip=${skip}`
        if (cursor !== undefined) path += `&cursor=${cursor}`
      }
      let raw: unknown
      try {
        raw = await this.request('search', path)
      } catch (err) {
        if (err instanceof QuotaExhaustedError && pages > 0) {
          log.warn('quota exhausted mid-pagination — continuing with partial results')
          return { records, truncated: true, invalidCount, pages }
        }
        throw err
      }
      pages++
      const page = searchResponseSchema.safeParse(raw)
      if (!page.success) throw new Error('seats.aero search response did not match expected envelope')

      for (const item of page.data.data) {
        const rec = normalizeAvailability(item, params.direction)
        if (!rec) {
          invalidCount++
          continue
        }
        if (seen.has(rec.id)) continue
        seen.add(rec.id)
        records.push(rec)
      }

      skip += page.data.data.length
      if (page.data.cursor !== undefined && cursor === undefined) cursor = page.data.cursor
      if (!page.data.hasMore || page.data.data.length === 0 || pages >= MAX_PAGES) {
        return { records, truncated: pages >= MAX_PAGES, invalidCount, pages }
      }
    }
  }

  /** Flight-level detail for one availability record. Returns null on any failure (best-effort enrichment). */
  async getTrips(availabilityId: string): Promise<TripDetail | null> {
    let raw: unknown
    try {
      raw = await this.request('trips', `/trips/${availabilityId}`)
    } catch (err) {
      if (err instanceof QuotaExhaustedError) throw err
      log.debug(`trips lookup failed for ${availabilityId}: ${(err as Error).message}`)
      return null
    }
    const parsed = tripsResponseSchema.safeParse(raw)
    if (!parsed.success) return null

    // Pick the cheapest business-cabin trip (the availability's headline record).
    let best: TripDetailCandidate | null = null
    for (const item of parsed.data.data) {
      const trip = apiTripSchema.safeParse(item)
      if (!trip.success) continue
      const t = trip.data
      if (t.Cabin && t.Cabin.toLowerCase() !== 'business') continue
      const cost = parseMileage(t.MileageCost) ?? Number.MAX_SAFE_INTEGER
      if (!best || cost < best.cost) best = { cost, trip: t }
    }
    if (!best) return null
    const t = best.trip
    return {
      flightNumbers: t.FlightNumbers ?? null,
      departsAt: t.DepartsAt ?? null,
      arrivesAt: t.ArrivesAt ?? null,
      stops: t.Stops ?? null,
      carriers: t.Carriers ?? null,
      totalTaxes: t.TotalTaxes ?? null,
      taxesCurrency: t.TaxesCurrency ?? null,
      bookingLinks: (parsed.data.booking_links ?? []).map((b) => ({
        label: b.label,
        link: b.link,
        primary: b.primary,
      })),
    }
  }

  /** All routes crawled for one source (setup-time horizon audit). */
  async getRoutes(source: string): Promise<RouteInfo[]> {
    const raw = await this.request('routes', `/routes?source=${source}`)
    if (!Array.isArray(raw)) return []
    const routes: RouteInfo[] = []
    for (const item of raw) {
      const r = apiRouteSchema.safeParse(item)
      if (!r.success) continue
      routes.push({
        origin: r.data.OriginAirport,
        destination: r.data.DestinationAirport,
        numDaysOut: r.data.NumDaysOut ?? null,
        distance: r.data.Distance ?? null,
        source: r.data.Source ?? source,
      })
    }
    return routes
  }
}

interface TripDetailCandidate {
  cost: number
  trip: import('./types.js').ApiTrip
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
