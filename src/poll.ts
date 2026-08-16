import type { AppConfig } from './shared/configSchema.js'
import {
  getAvailabilitySeenAt,
  upsertAvailability,
  startCycle,
  finishCycle,
  incrementApiCalls,
  getCallsUsed,
  metaGet,
  metaSet,
  recordAlertedDeals,
  touchAlertedDealsSeen,
  countConsecutiveFailedCycles,
  utcDay,
  type Db,
  type CycleTrigger,
  type CycleStatus,
} from './db.js'
import { deriveWindow } from './config.js'
import { detectOneways } from './deals/oneway.js'
import { detectRoundtrips } from './deals/roundtrip.js'
import { filterForAlert, type AlertableDeal } from './deals/dedupe.js'
import { QuotaExhaustedError, type ApiEndpoint, type SearchParams, type SearchResult } from './seatsAero.js'
import type { Deal, OneWayDeal, RoundtripDeal, TripDetail } from './types.js'
import type { DealDigest, DigestOneway, DigestRoundtrip, Notifier } from './notify/notifier.js'
import { log } from './log.js'

/** The subset of SeatsAeroClient poll needs (tests substitute their own). */
export interface ClientLike {
  search(params: SearchParams): Promise<SearchResult>
  getTrips(availabilityId: string): Promise<TripDetail | null>
}

export type OnApiCall = (endpoint: ApiEndpoint, rateLimitRemaining: number | null) => void

export interface CycleDeps {
  db: Db
  cfg: AppConfig
  /** Client construction gets the poll-owned accounting hook. */
  clientFactory: (onCall: OnApiCall) => ClientLike
  notifier: Notifier
  now?: () => Date
}

export interface CycleOptions {
  trigger: CycleTrigger
  /** Detect and render, but send nothing and write no alert state. */
  dryRun?: boolean
}

export interface CycleOutcome {
  status: CycleStatus
  digest: DealDigest | null
  recordsFetched: number
  invalidCount: number
  onewaysFound: number
  roundtripsFound: number
  alertsSent: number
  callsUsed: number
  error?: string
}

const FAILURE_NOTICE_THRESHOLD = 6
const FAILURE_NOTICE_MIN_INTERVAL_MS = 24 * 3_600_000

export async function runCycle(deps: CycleDeps, opts: CycleOptions): Promise<CycleOutcome> {
  const { db, cfg, notifier } = deps
  const now = deps.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const dryRun = opts.dryRun ?? false

  let callsUsed = 0
  const onCall: OnApiCall = (endpoint, remaining) => {
    callsUsed++
    incrementApiCalls(db, utcDay(now()), endpoint)
    if (remaining !== null) {
      metaSet(db, 'rate_limit_remaining', String(remaining))
      metaSet(db, 'rate_limit_seen_at', now().toISOString())
    }
  }
  const client = deps.clientFactory(onCall)

  const estimatedRemaining = (): number => {
    const used = getCallsUsed(db, utcDay(now()))
    let remaining = cfg.api.dailyCallBudget - used
    const seenAt = metaGet(db, 'rate_limit_seen_at')
    const headerRemaining = metaGet(db, 'rate_limit_remaining')
    if (seenAt !== undefined && headerRemaining !== undefined && seenAt.slice(0, 10) === utcDay(now())) {
      remaining = Math.min(remaining, parseInt(headerRemaining, 10))
    }
    return remaining
  }

  // Pre-flight quota gate.
  if (estimatedRemaining() <= cfg.api.reserveCalls) {
    const cycleId = startCycle(db, opts.trigger, startedAt)
    finishCycle(db, cycleId, {
      finishedAt: now().toISOString(),
      status: 'aborted_quota',
      callsUsed: 0,
      recordsFetched: 0,
      onewaysFound: 0,
      roundtripsFound: 0,
      alertsSent: 0,
      errorMessage: 'daily API budget exhausted before cycle start',
    })
    log.warn('cycle skipped: daily API budget exhausted')
    return {
      status: 'aborted_quota',
      digest: null,
      recordsFetched: 0,
      invalidCount: 0,
      onewaysFound: 0,
      roundtripsFound: 0,
      alertsSent: 0,
      callsUsed: 0,
    }
  }

  const cycleId = startCycle(db, opts.trigger, startedAt)
  const finish = (
    status: CycleStatus,
    stats: Partial<{
      recordsFetched: number
      onewaysFound: number
      roundtripsFound: number
      alertsSent: number
      errorMessage: string
    }>,
  ) => {
    finishCycle(db, cycleId, {
      finishedAt: now().toISOString(),
      status,
      callsUsed,
      recordsFetched: stats.recordsFetched ?? 0,
      onewaysFound: stats.onewaysFound ?? 0,
      roundtripsFound: stats.roundtripsFound ?? 0,
      alertsSent: stats.alertsSent ?? 0,
      ...(stats.errorMessage !== undefined ? { errorMessage: stats.errorMessage } : {}),
    })
    metaSet(db, 'last_cycle_at', startedAt)
    metaSet(db, 'last_cycle_status', status)
  }

  try {
    const window = deriveWindow(cfg, now())
    const sources = [
      ...cfg.search.sources,
      ...(cfg.search.proxySources.enabled ? cfg.search.proxySources.sources : []),
    ]
    const notes: string[] = []
    let quotaTruncated = false

    // Fetch both directions; on mid-flight quota exhaustion keep what we have.
    const results: SearchResult[] = []
    const directions: Array<{ origins: string[]; destinations: string[]; direction: 'outbound' | 'return' }> = [
      { origins: cfg.search.origins, destinations: cfg.search.destinations, direction: 'outbound' },
      { origins: cfg.search.destinations, destinations: cfg.search.origins, direction: 'return' },
    ]
    for (const dir of directions) {
      try {
        results.push(
          await client.search({
            origins: dir.origins,
            destinations: dir.destinations,
            sources,
            startDate: window.startDate,
            endDate: window.endDate,
            direction: dir.direction,
          }),
        )
      } catch (err) {
        if (err instanceof QuotaExhaustedError) {
          quotaTruncated = true
          notes.push('API quota ran out mid-fetch — this digest covers partial data.')
          break
        }
        throw err
      }
    }

    const seenAt = startedAt
    let recordsFetched = 0
    let invalidCount = 0
    db.transaction(() => {
      for (const result of results) {
        recordsFetched += result.records.length
        invalidCount += result.invalidCount
        if (result.truncated) quotaTruncated = true
        for (const rec of result.records) upsertAvailability(db, rec, seenAt)
      }
    })()
    if (invalidCount > 0) {
      log.warn(`${invalidCount} records failed validation and were skipped`)
      notes.push(`${invalidCount} malformed records were skipped.`)
    }

    // Detection runs on this cycle's fresh snapshot.
    const fresh = getAvailabilitySeenAt(db, seenAt)
    const oneways = detectOneways(fresh, cfg)
    const roundtrips = detectRoundtrips(fresh, cfg)

    // Dedupe/re-alert policy.
    const { toAlert, stillQualifyingKeys } = filterForAlert(
      db,
      [...oneways, ...roundtrips],
      cfg,
      now(),
    )
    if (!dryRun && stillQualifyingKeys.length > 0) {
      touchAlertedDealsSeen(db, stillQualifyingKeys, now().toISOString())
    }

    const alertOneways = toAlert.filter((a): a is AlertableDeal<OneWayDeal> => a.deal.kind === 'oneway')
    const alertRoundtrips = toAlert.filter(
      (a): a is AlertableDeal<RoundtripDeal> => a.deal.kind === 'roundtrip',
    )

    // Best-effort flight-level enrichment for the deals we are about to alert.
    const digestOneways: DigestOneway[] = []
    let tripLookups = 0
    for (const a of alertOneways.slice(0, cfg.alerts.maxOnewaysPerEmail)) {
      let detail: TripDetail | null = null
      if (
        !dryRun &&
        tripLookups < cfg.alerts.maxTripLookupsPerCycle &&
        estimatedRemaining() > cfg.api.reserveCalls
      ) {
        tripLookups++
        try {
          detail = await client.getTrips(a.deal.availabilityId)
        } catch (err) {
          if (err instanceof QuotaExhaustedError) {
            quotaTruncated = true
            notes.push('API quota ran out during detail lookups.')
          } else {
            throw err
          }
        }
      }
      digestOneways.push({ ...a, detail })
    }

    const digestRoundtrips: DigestRoundtrip[] = alertRoundtrips.slice(0, cfg.alerts.maxRoundtripsPerEmail)
    const rtOverflow = alertRoundtrips.slice(cfg.alerts.maxRoundtripsPerEmail)
    const digest: DealDigest = {
      generatedAt: startedAt,
      oneways: digestOneways,
      roundtrips: digestRoundtrips,
      onewayOverflowCount: Math.max(alertOneways.length - cfg.alerts.maxOnewaysPerEmail, 0),
      roundtripOverflowCount: rtOverflow.length,
      roundtripOverflowFromPoints:
        rtOverflow.length > 0 ? Math.min(...rtOverflow.map((d) => d.deal.totalPoints)) : null,
      notes,
    }

    // Alert + persist (alert state is written only after a successful send).
    let alertsSent = 0
    if (toAlert.length > 0 && !dryRun) {
      await notifier.sendDigest(digest)
      alertsSent = toAlert.length
      recordAlertedDeals(
        db,
        toAlert.map((a) => ({
          key: a.deal.key,
          kind: a.deal.kind,
          points: dealPoints(a.deal),
          isEstimate: a.deal.kind === 'oneway' ? a.deal.isEstimate : a.deal.isEstimate,
          detailJson: JSON.stringify(dealSummary(a)),
        })),
        now().toISOString(),
      )
    }

    const status: CycleStatus = quotaTruncated ? 'aborted_quota' : 'ok'
    finish(status, {
      recordsFetched,
      onewaysFound: oneways.length,
      roundtripsFound: roundtrips.length,
      alertsSent,
    })
    log.info(
      `cycle done: status=${status} records=${recordsFetched} oneways=${oneways.length} ` +
        `roundtrips=${roundtrips.length} alertable=${toAlert.length} emailed=${alertsSent} calls=${callsUsed}`,
    )
    return {
      status,
      digest: toAlert.length > 0 ? digest : null,
      recordsFetched,
      invalidCount,
      onewaysFound: oneways.length,
      roundtripsFound: roundtrips.length,
      alertsSent,
      callsUsed,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    finish('error', { errorMessage: message })
    log.error(`cycle failed: ${message}`)
    await maybeSendFailureNotice(db, notifier, now, message)
    return {
      status: 'error',
      digest: null,
      recordsFetched: 0,
      invalidCount: 0,
      onewaysFound: 0,
      roundtripsFound: 0,
      alertsSent: 0,
      callsUsed,
      error: message,
    }
  }
}

function dealPoints(deal: Deal): number {
  return deal.kind === 'oneway' ? deal.points : deal.totalPoints
}

function dealSummary(a: AlertableDeal): Record<string, unknown> {
  const d = a.deal
  if (d.kind === 'oneway') {
    return {
      route: `${d.origin}→${d.destination}`,
      date: d.date,
      program: d.program,
      points: d.points,
      seats: d.seats,
      direct: d.direct,
      isEstimate: d.isEstimate,
      reason: a.reason,
    }
  }
  return {
    route: `${d.outbound.origin}→${d.outbound.destination}→${d.inbound.destination}`,
    outDate: d.outbound.date,
    backDate: d.inbound.date,
    programs: [d.outbound.program, d.inbound.program],
    totalPoints: d.totalPoints,
    stayNights: d.stayNights,
    isEstimate: d.isEstimate,
    reason: a.reason,
  }
}

async function maybeSendFailureNotice(
  db: Db,
  notifier: Notifier,
  now: () => Date,
  lastError: string,
): Promise<void> {
  if (!notifier.sendFailureNotice) return
  const failures = countConsecutiveFailedCycles(db)
  if (failures < FAILURE_NOTICE_THRESHOLD) return
  const lastNotice = metaGet(db, 'failure_notice_at')
  if (lastNotice !== undefined && now().getTime() - Date.parse(lastNotice) < FAILURE_NOTICE_MIN_INTERVAL_MS) {
    return
  }
  try {
    await notifier.sendFailureNotice(
      `deal-finder has failed ${failures} consecutive cycles. Last error: ${lastError}`,
    )
    metaSet(db, 'failure_notice_at', now().toISOString())
  } catch (err) {
    log.warn(`failure-notice email also failed: ${(err as Error).message}`)
  }
}
