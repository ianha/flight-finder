import { getCallsUsed, metaGet, utcDay, type Db } from './db.js'
import type { AppConfig } from './shared/configSchema.js'

/**
 * Calls left in today's self-imposed budget, floored by the freshest
 * X-RateLimit-Remaining header seen today (upstream is the ground truth when it
 * disagrees with the ledger). Shared by the poll cycle and the web trips
 * endpoint so the two estimates cannot drift.
 */
export function estimatedRemaining(db: Db, cfg: AppConfig, now: () => Date): number {
  const used = getCallsUsed(db, utcDay(now()))
  let remaining = cfg.api.dailyCallBudget - used
  const seenAt = metaGet(db, 'rate_limit_seen_at')
  const headerRemaining = metaGet(db, 'rate_limit_remaining')
  if (seenAt !== undefined && headerRemaining !== undefined && seenAt.slice(0, 10) === utcDay(now())) {
    remaining = Math.min(remaining, parseInt(headerRemaining, 10))
  }
  return remaining
}
