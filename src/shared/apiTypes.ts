// Request/response DTOs for the local web API.
// Shared between the Node server and the web frontend — keep free of Node imports.
import type { AviosEstimate } from '../types.js'
import type { AppConfig } from './configSchema.js'

export interface ApiIssue {
  path: string
  message: string
}

export interface ApiError {
  error: string
  issues?: ApiIssue[]
}

export interface HealthResponse {
  ok: true
  version: string
}

export interface CycleDto {
  id: number
  trigger: 'scheduled' | 'manual'
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'ok' | 'error' | 'aborted_quota'
  callsUsed: number
  recordsFetched: number
  onewaysFound: number
  roundtripsFound: number
  alertsSent: number
  errorMessage: string | null
}

export interface StatusResponse {
  lastCycle: {
    at: string
    finishedAt: string | null
    status: string
    trigger: string
    durationMs: number | null
    alertsSent: number
    error: string | null
  } | null
  cycleInFlight: { startedAt: string; trigger: string } | null
  quota: {
    dayUtc: string
    used: number
    budget: number
    reserve: number
    headerRemaining: number | null
  }
  scheduler: { intervalHours: number; nextRunAt: string | null } | null
  db: { path: string; availabilityRows: number; newestApiUpdatedAt: string | null }
  env: { seatsAeroApiKey: boolean; twilioCreds: boolean }
}

export interface CyclesResponse {
  cycles: CycleDto[]
}

export interface RunStartedResponse {
  started: true
  trigger: 'manual'
}

export interface RunConflictResponse {
  error: 'cycle_in_flight'
  startedAt: string
  trigger: string
}

// --- deals (Phase 3 read APIs) ---

export interface DealLegDto {
  availabilityId: string
  source: string
  program: string
  origin: string
  destination: string
  date: string
  direction: 'outbound' | 'return'
  points: number
  isEstimate: boolean
  estimate?: AviosEstimate
  direct: boolean
  seats: number | null
  airlines: string
  apiUpdatedAt: string
}

export interface OneWayDealDto extends DealLegDto {
  key: string
}

export interface RoundtripDealDto {
  key: string
  outbound: DealLegDto
  inbound: DealLegDto
  totalPoints: number
  stayNights: number
  isEstimate: boolean
}

export interface OneWayDealsResponse {
  deals: OneWayDealDto[]
  total: number
}

export interface RoundtripDealsResponse {
  pairs: RoundtripDealDto[]
  total: number
}

export interface CalendarDay {
  date: string
  minPoints: number | null
  minPointsIsEstimate: boolean
  anyAvailable: boolean
  anyDirect: boolean
  cheapestSource: string | null
}

export interface CalendarResponse {
  days: CalendarDay[]
}

export interface AlertDto {
  dealKey: string
  kind: 'oneway' | 'roundtrip'
  bestPoints: number
  lastPoints: number
  isEstimate: boolean
  firstAlertedAt: string
  lastAlertedAt: string
  lastSeenAt: string
  alertCount: number
  detail: unknown
}

export interface AlertsResponse {
  alerts: AlertDto[]
}

// --- trips (deal detail view) ---

export interface BookingLinkDto {
  label: string
  link: string
  primary: boolean
}

export interface SegmentDto {
  flightNumber: string | null
  originAirport: string
  destinationAirport: string
  /** Airport-local ISO 8601, verbatim from upstream — never convert to viewer timezone. */
  departsAt: string
  arrivesAt: string
  aircraftName: string | null
  fareClass: string | null
  /** Ground time before the next segment; null on the last segment by contract. */
  layoverMinutesAfter: number | null
  order: number
}

export interface TripOptionDto {
  flightNumbers: string | null
  departsAt: string | null
  arrivesAt: string | null
  totalDurationMinutes: number | null
  stops: number | null
  carriers: string | null
  cabin: string | null
  /** Options without a parseable mileage cost are dropped upstream, so this stays sortable. */
  mileageCost: number
  /** Upstream RemainingSeats 0/null → null ("—" convention, matches DealLegDto.seats). */
  seats: number | null
  /** Cents, when known. 0 is a real value — null means unknown. */
  totalTaxes: number | null
  taxesCurrency: string | null
  segments: SegmentDto[]
}

/**
 * 200 body for GET /api/trips/:availabilityId. Failures use HTTP statuses with
 * ApiError bodies: 400 invalid_availability_id | no_api_key, 404 expired,
 * 502 upstream_error, 503 quota_exhausted.
 */
export interface TripDetailOkResponse {
  availabilityId: string
  options: TripOptionDto[]
  bookingLinks: BookingLinkDto[]
  fetchedAt: string
}

// --- config (Phase 4) ---

export interface ConfigResponse {
  config: AppConfig
  meta: {
    path: string
    /** Fields visible in the UI but not editable through it. */
    readOnlyPaths: string[]
  }
}

export interface ConfigPutResponse {
  config: AppConfig
  appliesAt: 'next-cycle'
}

