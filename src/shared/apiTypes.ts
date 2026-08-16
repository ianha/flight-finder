// Request/response DTOs for the local web API.
// Shared between the Node server and the web frontend — keep free of Node imports.
import type { AviosEstimate } from '../types.js'

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
  env: { seatsAeroApiKey: boolean; smtpPassword: boolean }
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
