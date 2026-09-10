import {
  normalizeAvailability,
  searchResponseSchema,
  tripsResponseSchema,
  apiTripSchema,
  apiSegmentSchema,
  apiRouteSchema,
  parseMileage,
  type AvailabilityRecord,
  type Direction,
  type TripDetail,
} from './types.js'
import type { BookingLinkDto, SegmentDto, TripOptionDto } from './shared/apiTypes.js'
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

/** Thrown on HTTP 404 — the resource (e.g. an availability id) no longer exists upstream. */
export class NotFoundError extends Error {
  constructor(readonly url: string) {
    super(`seats.aero returned 404 for ${url}`)
    this.name = 'NotFoundError'
  }
}

/** All business-cabin trip options for one availability, DTO-ready. */
export interface TripsFullResult {
  options: TripOptionDto[]
  bookingLinks: BookingLinkDto[]
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
  /** True when pagination stopped early because the API quota ran out. */
  truncated: boolean
  /** True when the MAX_PAGES safety stop fired (not a quota condition). */
  pageCapped: boolean
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
      if (res.status === 404) throw new NotFoundError(url)
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
          return { records, truncated: true, pageCapped: false, invalidCount, pages }
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
        const pageCapped = page.data.hasMore === true && pages >= MAX_PAGES
        if (pageCapped) log.warn(`search stopped at the ${MAX_PAGES}-page safety cap with more data available`)
        return { records, truncated: false, pageCapped, invalidCount, pages }
      }
    }
  }

  /**
   * All business-cabin trip options (with segments) for one availability record.
   * Throws typed errors: NotFoundError (availability gone upstream),
   * QuotaExhaustedError, BadRequestError, or Error for parse/transport failures.
   */
  async getTripsFull(availabilityId: string): Promise<TripsFullResult> {
    const raw = await this.request('trips', `/trips/${encodeURIComponent(availabilityId)}`)
    const parsed = tripsResponseSchema.safeParse(raw)
    if (!parsed.success) throw new Error('seats.aero trips response did not match expected envelope')

    const options: TripOptionDto[] = []
    for (const item of parsed.data.data) {
      const trip = apiTripSchema.safeParse(item)
      if (!trip.success) continue
      const t = trip.data
      if (t.Cabin && t.Cabin.toLowerCase() !== 'business') continue
      const mileageCost = parseMileage(t.MileageCost)
      if (mileageCost === null) continue
      options.push({
        flightNumbers: t.FlightNumbers ?? null,
        departsAt: t.DepartsAt ?? null,
        arrivesAt: t.ArrivesAt ?? null,
        totalDurationMinutes: t.TotalDuration ?? null,
        stops: t.Stops ?? null,
        carriers: t.Carriers ?? null,
        cabin: t.Cabin ?? null,
        mileageCost,
        seats: t.RemainingSeats ? t.RemainingSeats : null,
        totalTaxes: t.TotalTaxes ?? null,
        taxesCurrency: t.TaxesCurrency ?? null,
        segments: parseSegments(t.AvailabilitySegments ?? []),
      })
    }
    options.sort((a, b) => a.mileageCost - b.mileageCost || (a.departsAt ?? '').localeCompare(b.departsAt ?? ''))

    return {
      options: options.slice(0, MAX_TRIP_OPTIONS),
      bookingLinks: sanitizeBookingLinks(parsed.data.booking_links ?? []),
    }
  }

  /** Flight-level detail for one availability record. Returns null on any failure (best-effort enrichment). */
  async getTrips(availabilityId: string): Promise<TripDetail | null> {
    let full: TripsFullResult
    try {
      full = await this.getTripsFull(availabilityId)
    } catch (err) {
      if (err instanceof QuotaExhaustedError) throw err
      log.debug(`trips lookup failed for ${availabilityId}: ${(err as Error).message}`)
      return null
    }
    const best = full.options[0] // cheapest — options are sorted by mileage
    if (!best) return null
    return {
      flightNumbers: best.flightNumbers,
      departsAt: best.departsAt,
      arrivesAt: best.arrivesAt,
      stops: best.stops,
      carriers: best.carriers,
      totalTaxes: best.totalTaxes,
      taxesCurrency: best.taxesCurrency,
      bookingLinks: full.bookingLinks,
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

const MAX_TRIP_OPTIONS = 20
const MAX_SEGMENTS_PER_OPTION = 8

function parseSegments(raw: unknown[]): SegmentDto[] {
  const segments: Array<Omit<SegmentDto, 'layoverMinutesAfter'>> = []
  for (const item of raw) {
    const seg = apiSegmentSchema.safeParse(item)
    if (!seg.success) continue
    const s = seg.data
    segments.push({
      flightNumber: s.FlightNumber ?? null,
      originAirport: s.OriginAirport,
      destinationAirport: s.DestinationAirport,
      departsAt: s.DepartsAt,
      arrivesAt: s.ArrivesAt,
      aircraftName: s.AircraftName ?? null,
      fareClass: s.FareClass ?? null,
      order: s.Order ?? segments.length,
    })
  }
  segments.sort((a, b) => a.order - b.order)
  return segments.slice(0, MAX_SEGMENTS_PER_OPTION).map((s, i, all) => {
    const next = all[i + 1]
    let layoverMinutesAfter: number | null = null // last segment stays null by contract
    if (next) {
      const gap = Date.parse(next.departsAt) - Date.parse(s.arrivesAt)
      if (Number.isFinite(gap) && gap >= 0) layoverMinutesAfter = Math.round(gap / 60_000)
    }
    return { ...s, layoverMinutesAfter }
  })
}

/** Untrusted upstream URLs: only http(s) links survive (noopener does not stop javascript:/data: hrefs). */
function sanitizeBookingLinks(
  raw: Array<{ label: string; link: string; primary: boolean }>,
): BookingLinkDto[] {
  const links: BookingLinkDto[] = []
  for (const b of raw) {
    let protocol: string
    try {
      protocol = new URL(b.link).protocol
    } catch {
      continue
    }
    if (protocol !== 'http:' && protocol !== 'https:') continue
    links.push({ label: b.label, link: b.link, primary: b.primary })
  }
  return links
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
