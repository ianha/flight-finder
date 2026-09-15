import { createHash } from 'node:crypto'
import type { Db, CycleRow } from '../db.js'
import {
  getRecentCycles,
  getCallsUsed,
  metaGet,
  countAvailability,
  utcDay,
  getAvailabilityInWindow,
  getRecentAlerts,
} from '../db.js'
import type { AppConfig } from '../shared/configSchema.js'
import { statusConfigProjection } from '../shared/statusProjection.js'
import { ESTIMATE_SOURCE_KEY } from '../shared/constants.js'
import type {
  AlertDto,
  CalendarDay,
  CycleDto,
  DealLegDto,
  OneWayDealDto,
  RoundtripDealDto,
  StatusResponse,
} from '../shared/apiTypes.js'
import { candidateLeg, detectOneways } from '../deals/oneway.js'
import { detectRoundtrips } from '../deals/roundtrip.js'
import { deriveWindow, scopeFor, isInScope } from '../deals/scope.js'
import type { AvailabilityRecord, DealLeg, Direction } from '../types.js'

// ---------------------------------------------------------------------------
// Deals read-model: recompute from the latest availability snapshot with the
// SAME pure detection functions the poller uses, scoped to the SAME geography/
// window predicate (deals/scope.ts) the poller applies to its fresh fetch — so
// a deal alerted on can never be hidden here, and a stale row from a previous
// configuration can never appear. Query params can override thresholds for
// exploration; they narrow the scope, never widen it.
// ---------------------------------------------------------------------------

function legToDto(leg: DealLeg): DealLegDto {
  return {
    availabilityId: leg.availabilityId,
    source: leg.source,
    program: leg.program,
    origin: leg.origin,
    destination: leg.destination,
    date: leg.date,
    direction: leg.direction,
    points: leg.points,
    isEstimate: leg.isEstimate,
    ...(leg.estimate ? { estimate: leg.estimate } : {}),
    direct: leg.direct,
    seats: leg.seats,
    airlines: leg.airlines,
    apiUpdatedAt: leg.apiUpdatedAt,
  }
}

/** In-scope rows for the current config + window; bounded in SQL, geography/direction filtered in memory. */
function scopedAvailability(db: Db, cfg: AppConfig, now: Date): AvailabilityRecord[] {
  const window = deriveWindow(cfg, now)
  const scope = scopeFor(cfg.search, window)
  return getAvailabilityInWindow(db, window).filter((r) => isInScope(r, scope))
}

function matchesSource(recSource: string, isEstimate: boolean, q: string): boolean {
  // ESTIMATE_SOURCE_KEY is the Program filter's single option for proxy-priced
  // (american/alaska) legs — see onewayKey in deals/oneway.ts, which collapses
  // them into one deal-key namespace. Filtering on the raw proxy id would often
  // return nothing even when that source has rows (the cheaper one wins the key).
  return q === ESTIMATE_SOURCE_KEY ? isEstimate : recSource === q
}

export interface OneWayQuery {
  origin?: string
  destination?: string
  /** Home-city filter, direction-aware: matches the origin of outbound legs and the destination of return legs. */
  home?: string
  /** Destination-airport filter, direction-aware: matches the destination of outbound legs and the origin of return legs. */
  dest?: string
  /** A configured source id, or ESTIMATE_SOURCE_KEY ('avios-est') for proxy-priced estimate legs. */
  source?: string
  direction?: Direction
  maxPoints?: number
  directOnly?: boolean
  includeEstimates?: boolean
  from?: string
  to?: string
  sort?: 'points' | 'date'
  limit: number
  offset: number
}

export function queryOneways(
  db: Db,
  cfg: AppConfig,
  now: Date,
  q: OneWayQuery,
): { deals: OneWayDealDto[]; total: number; availabilityInScope: number } {
  const scoped = scopedAvailability(db, cfg, now)
  const effectiveCfg: AppConfig = {
    ...cfg,
    thresholds: { ...cfg.thresholds, onewayMaxPoints: q.maxPoints ?? cfg.thresholds.onewayMaxPoints },
    search: { ...cfg.search, directOnly: q.directOnly ?? cfg.search.directOnly },
  }
  let deals = detectOneways(scoped, effectiveCfg)
  if (q.origin) deals = deals.filter((d) => d.origin === q.origin)
  if (q.destination) deals = deals.filter((d) => d.destination === q.destination)
  if (q.home) deals = deals.filter((d) => (d.direction === 'outbound' ? d.origin : d.destination) === q.home)
  if (q.dest) deals = deals.filter((d) => (d.direction === 'outbound' ? d.destination : d.origin) === q.dest)
  if (q.source) deals = deals.filter((d) => matchesSource(d.source, d.isEstimate, q.source!))
  if (q.direction) deals = deals.filter((d) => d.direction === q.direction)
  if (q.includeEstimates === false) deals = deals.filter((d) => !d.isEstimate)
  if (q.from) deals = deals.filter((d) => d.date >= q.from!)
  if (q.to) deals = deals.filter((d) => d.date <= q.to!)
  if (q.sort === 'date') deals = [...deals].sort((a, b) => a.date.localeCompare(b.date))
  const total = deals.length
  return {
    deals: deals.slice(q.offset, q.offset + q.limit).map((d) => ({ ...legToDto(d), key: d.key })),
    total,
    availabilityInScope: scoped.length,
  }
}

export interface RoundtripQuery {
  origin?: string
  /** Away-airport filter: matches the outbound's destination or the inbound's origin (covers destination-side open-jaws). */
  destination?: string
  maxTotal?: number
  minStay?: number
  maxStay?: number
  sameCityReturn?: boolean
  includeEstimates?: boolean
  limit: number
  offset: number
}

export function queryRoundtrips(
  db: Db,
  cfg: AppConfig,
  now: Date,
  q: RoundtripQuery,
): { pairs: RoundtripDealDto[]; total: number; availabilityInScope: number } {
  const scoped = scopedAvailability(db, cfg, now)
  const effectiveCfg: AppConfig = {
    ...cfg,
    thresholds: {
      ...cfg.thresholds,
      roundtripMaxPoints: q.maxTotal ?? cfg.thresholds.roundtripMaxPoints,
    },
    roundtrip: {
      minStayNights: q.minStay ?? cfg.roundtrip.minStayNights,
      maxStayNights: q.maxStay ?? cfg.roundtrip.maxStayNights,
      sameCityReturn: q.sameCityReturn ?? cfg.roundtrip.sameCityReturn,
    },
  }
  let pairs = detectRoundtrips(scoped, effectiveCfg)
  if (q.origin) pairs = pairs.filter((p) => p.outbound.origin === q.origin)
  if (q.destination) {
    pairs = pairs.filter(
      (p) => p.outbound.destination === q.destination || p.inbound.origin === q.destination,
    )
  }
  if (q.includeEstimates === false) pairs = pairs.filter((p) => !p.isEstimate)
  const total = pairs.length
  return {
    pairs: pairs.slice(q.offset, q.offset + q.limit).map((p) => ({
      key: p.key,
      outbound: legToDto(p.outbound),
      inbound: legToDto(p.inbound),
      totalPoints: p.totalPoints,
      stayNights: p.stayNights,
      isEstimate: p.isEstimate,
    })),
    total,
    availabilityInScope: scoped.length,
  }
}

export function queryCalendar(
  db: Db,
  cfg: AppConfig,
  now: Date,
  direction: Direction,
  origin?: string,
  destination?: string,
): { days: CalendarDay[]; availabilityInScope: number } {
  const scoped = scopedAvailability(db, cfg, now)
  let records = scoped.filter((r) => r.direction === direction)
  if (origin) records = records.filter((r) => r.origin === origin)
  if (destination) records = records.filter((r) => r.destination === destination)

  const byDate = new Map<string, CalendarDay>()
  for (const rec of records) {
    let day = byDate.get(rec.date)
    if (!day) {
      day = {
        date: rec.date,
        minPoints: null,
        minPointsIsEstimate: false,
        anyAvailable: false,
        anyDirect: false,
        cheapestSource: null,
      }
      byDate.set(rec.date, day)
    }
    if (rec.jAvailable) {
      day.anyAvailable = true
      if (rec.jDirect) day.anyDirect = true
    }
    const leg = candidateLeg(rec, cfg)
    if (leg && (day.minPoints === null || leg.points < day.minPoints)) {
      day.minPoints = leg.points
      day.minPointsIsEstimate = leg.isEstimate
      day.cheapestSource = leg.source
    }
  }
  return { days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)), availabilityInScope: scoped.length }
}

export function queryAlerts(db: Db, limit: number, kind?: string): AlertDto[] {
  return getRecentAlerts(db, limit, kind).map((a) => {
    let detail: unknown = null
    if (a.detail_json !== null) {
      try {
        detail = JSON.parse(a.detail_json)
      } catch {
        detail = null
      }
    }
    return {
      dealKey: a.deal_key,
      kind: a.kind as AlertDto['kind'],
      bestPoints: a.best_points,
      lastPoints: a.last_points,
      isEstimate: a.is_estimate === 1,
      firstAlertedAt: a.first_alerted_at,
      lastAlertedAt: a.last_alerted_at,
      lastSeenAt: a.last_seen_at,
      alertCount: a.alert_count,
      detail,
    }
  })
}

export function cycleToDto(row: CycleRow): CycleDto {
  return {
    id: row.id,
    trigger: row.trigger_kind as CycleDto['trigger'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as CycleDto['status'],
    callsUsed: row.calls_used,
    recordsFetched: row.records_fetched,
    onewaysFound: row.oneways_found,
    roundtripsFound: row.roundtrips_found,
    alertsSent: row.alerts_sent,
    errorMessage: row.error_message,
  }
}

export function recentCycles(db: Db, limit: number): CycleDto[] {
  return getRecentCycles(db, limit).map(cycleToDto)
}

/**
 * Fingerprint of the fields that affect what Deals/Calendar show — deliberately
 * NOT the whole config (sms.* carries phone numbers, and unrelated fields
 * bumping the revision would cause pointless refetches). Stateless: no plumbing
 * through AppDeps, no stub needed in test makeApp helpers.
 */
function configRevisionOf(cfg: AppConfig): string {
  const relevant = { search: cfg.search, thresholds: cfg.thresholds, roundtrip: cfg.roundtrip }
  return createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 12)
}

export function buildStatus(
  db: Db,
  cfg: AppConfig,
  scheduler: { intervalHours: number; nextRunAt: string | null; cycleInFlight: { startedAt: string; trigger: string } | null } | null,
  env: { seatsAeroApiKey: boolean; twilioCreds: boolean },
  now: Date,
): StatusResponse {
  const finished = getRecentCycles(db, 10).find((c) => c.status !== 'running')
  const day = utcDay(now)

  let headerRemaining: number | null = null
  const seenAt = metaGet(db, 'rate_limit_seen_at')
  const remaining = metaGet(db, 'rate_limit_remaining')
  if (seenAt !== undefined && remaining !== undefined && seenAt.slice(0, 10) === day) {
    const parsed = parseInt(remaining, 10)
    headerRemaining = Number.isFinite(parsed) ? parsed : null
  }

  const newest = db
    .prepare('SELECT MAX(api_updated_at) AS m FROM availability')
    .get() as { m: string | null }

  return {
    lastCycle: finished
      ? {
          at: finished.started_at,
          finishedAt: finished.finished_at,
          status: finished.status,
          trigger: finished.trigger_kind,
          durationMs:
            finished.finished_at !== null
              ? Date.parse(finished.finished_at) - Date.parse(finished.started_at)
              : null,
          alertsSent: finished.alerts_sent,
          error: finished.error_message,
        }
      : null,
    cycleInFlight: scheduler?.cycleInFlight ?? null,
    quota: {
      dayUtc: day,
      used: getCallsUsed(db, day),
      budget: cfg.api.dailyCallBudget,
      reserve: cfg.api.reserveCalls,
      headerRemaining,
    },
    scheduler: scheduler
      ? { intervalHours: scheduler.intervalHours, nextRunAt: scheduler.nextRunAt }
      : null,
    db: {
      path: cfg.db.path,
      availabilityRows: countAvailability(db),
      newestApiUpdatedAt: newest.m,
    },
    env,
    ...statusConfigProjection(cfg),
    configRevision: configRevisionOf(cfg),
  }
}
