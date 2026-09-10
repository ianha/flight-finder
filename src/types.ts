import { z } from 'zod'

// ---------------------------------------------------------------------------
// seats.aero Partner API payloads (only the fields we consume; unknown keys
// are stripped by zod, so API additions never break parsing)
// ---------------------------------------------------------------------------

const mileage = z.union([z.string(), z.number()]).optional()

export const apiRouteSchema = z.object({
  ID: z.string().optional(),
  OriginAirport: z.string(),
  DestinationAirport: z.string(),
  NumDaysOut: z.number().optional(),
  Distance: z.number().nullish(),
  Source: z.string().optional(),
})

export const apiAvailabilitySchema = z.object({
  ID: z.string(),
  RouteID: z.string().optional(),
  Route: apiRouteSchema,
  Date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  Source: z.string(),
  UpdatedAt: z.string(),
  JAvailable: z.boolean().optional().default(false),
  JMileageCost: mileage,
  JDirect: z.boolean().optional().default(false),
  JDirectMileageCost: mileage,
  JRemainingSeats: z.number().nullish(),
  JDirectRemainingSeats: z.number().nullish(),
  JAirlines: z.string().nullish(),
  JDirectAirlines: z.string().nullish(),
})

export const searchResponseSchema = z.object({
  data: z.array(z.unknown()).default([]),
  count: z.number().optional(),
  hasMore: z.boolean().optional().default(false),
  cursor: z.union([z.number(), z.string()]).optional(),
})

export const apiSegmentSchema = z.object({
  FlightNumber: z.string().nullish(),
  OriginAirport: z.string(),
  DestinationAirport: z.string(),
  DepartsAt: z.string(),
  ArrivesAt: z.string(),
  AircraftName: z.string().nullish(),
  FareClass: z.string().nullish(),
  Order: z.number().nullish(),
})

export const apiTripSchema = z.object({
  ID: z.string(),
  AvailabilityID: z.string().optional(),
  TotalDuration: z.number().nullish(),
  Stops: z.number().nullish(),
  Carriers: z.string().nullish(),
  RemainingSeats: z.number().nullish(),
  MileageCost: mileage,
  TotalTaxes: z.number().nullish(),
  TaxesCurrency: z.string().nullish(),
  TaxesCurrencySymbol: z.string().nullish(),
  FlightNumbers: z.string().nullish(),
  DepartsAt: z.string().nullish(),
  ArrivesAt: z.string().nullish(),
  Cabin: z.string().nullish(),
  Source: z.string().optional(),
  AvailabilitySegments: z.array(z.unknown()).nullish(),
})

export const tripsResponseSchema = z.object({
  data: z.array(z.unknown()).default([]),
  booking_links: z
    .array(
      z.object({
        label: z.string(),
        link: z.string(),
        primary: z.boolean().optional().default(false),
      }),
    )
    .optional(),
})

export const routesResponseSchema = z.array(z.unknown()).default([])

export type ApiTrip = z.output<typeof apiTripSchema>
export type BookingLink = { label: string; link: string; primary: boolean }

// ---------------------------------------------------------------------------
// Normalized domain types
// ---------------------------------------------------------------------------

export type Direction = 'outbound' | 'return'

/** One availability record (route+date+source), business cabin, normalized. */
export interface AvailabilityRecord {
  id: string
  source: string
  origin: string
  destination: string
  date: string // YYYY-MM-DD departure
  direction: Direction
  jAvailable: boolean
  jMileageCost: number | null
  jDirect: boolean
  jDirectMileageCost: number | null
  jRemainingSeats: number | null
  jDirectRemainingSeats: number | null
  jAirlines: string
  jDirectAirlines: string
  routeDistance: number | null
  apiUpdatedAt: string
}

/** Avios estimates attached to proxy-source deals. Partner pricing is flat (no peak/off-peak). */
export interface AviosEstimate {
  qatarAvios: number
  baAvios: number
  /** The lowest bookable estimate — used against thresholds. */
  best: number
  lastVerified: string
}

/** A leg that can appear in an alert (either a one-way deal or half of a roundtrip). */
export interface DealLeg {
  availabilityId: string
  source: string
  /** Display name of the program the user would actually book with. */
  program: string
  origin: string
  destination: string
  date: string
  direction: Direction
  points: number
  isEstimate: boolean
  estimate?: AviosEstimate
  direct: boolean
  seats: number | null
  airlines: string
  apiUpdatedAt: string
}

export interface OneWayDeal extends DealLeg {
  kind: 'oneway'
  key: string
}

export interface RoundtripDeal {
  kind: 'roundtrip'
  key: string
  outbound: DealLeg
  inbound: DealLeg
  totalPoints: number
  stayNights: number
  isEstimate: boolean
}

export type Deal = OneWayDeal | RoundtripDeal

/** Flight-level enrichment from GET /trips/{id}. */
export interface TripDetail {
  flightNumbers: string | null
  departsAt: string | null
  arrivesAt: string | null
  stops: number | null
  carriers: string | null
  totalTaxes: number | null
  taxesCurrency: string | null
  bookingLinks: BookingLink[]
}

export function parseMileage(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null) return null
  const n = typeof v === 'number' ? v : parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/**
 * Normalize one raw cached-search record. Returns null when the record does not
 * match the expected shape (callers count these instead of crashing the cycle).
 */
export function normalizeAvailability(raw: unknown, direction: Direction): AvailabilityRecord | null {
  const parsed = apiAvailabilitySchema.safeParse(raw)
  if (!parsed.success) return null
  const r = parsed.data
  return {
    id: r.ID,
    source: r.Source,
    origin: r.Route.OriginAirport,
    destination: r.Route.DestinationAirport,
    date: r.Date,
    direction,
    jAvailable: r.JAvailable,
    jMileageCost: parseMileage(r.JMileageCost),
    jDirect: r.JDirect,
    jDirectMileageCost: parseMileage(r.JDirectMileageCost),
    jRemainingSeats: r.JRemainingSeats ?? null,
    jDirectRemainingSeats: r.JDirectRemainingSeats ?? null,
    jAirlines: r.JAirlines ?? '',
    jDirectAirlines: r.JDirectAirlines ?? '',
    routeDistance: r.Route.Distance ?? null,
    apiUpdatedAt: r.UpdatedAt,
  }
}
