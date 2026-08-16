import type { Db, CycleRow } from '../db.js'
import { getRecentCycles, getCallsUsed, metaGet, countAvailability, utcDay } from '../db.js'
import type { AppConfig } from '../shared/configSchema.js'
import type { CycleDto, StatusResponse } from '../shared/apiTypes.js'

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

export function buildStatus(
  db: Db,
  cfg: AppConfig,
  scheduler: { intervalHours: number; nextRunAt: string | null; cycleInFlight: { startedAt: string; trigger: string } | null } | null,
  env: { seatsAeroApiKey: boolean; smtpPassword: boolean },
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
  }
}
