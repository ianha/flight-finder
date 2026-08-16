import type { AppConfig } from '../shared/configSchema.js'
import type { Deal } from '../types.js'
import { getAlertedDeal, type Db } from '../db.js'

export type AlertReason = 'new' | 'improved' | 'returned'

export interface AlertableDeal<D extends Deal = Deal> {
  deal: D
  reason: AlertReason
  /** Best points previously alerted (present for improved/returned). */
  prevBestPoints?: number
}

export interface DedupeResult {
  toAlert: AlertableDeal[]
  /** Keys of deals that still qualify but are not being re-alerted (refresh last_seen_at). */
  stillQualifyingKeys: string[]
}

function dealPoints(deal: Deal): number {
  return deal.kind === 'oneway' ? deal.points : deal.totalPoints
}

/**
 * Re-alert policy: alert when (1) never alerted, (2) price improved >= realertDropPct
 * vs the BEST ever alerted (anchoring to best prevents oscillation spam), or
 * (3) the deal reappears after being unseen >= realertGoneDays.
 */
export function filterForAlert(db: Db, deals: Deal[], cfg: AppConfig, now: Date): DedupeResult {
  const toAlert: AlertableDeal[] = []
  const stillQualifyingKeys: string[] = []
  const dropFactor = 1 - cfg.alerts.realertDropPct / 100
  const goneMs = cfg.alerts.realertGoneDays * 86_400_000

  for (const deal of deals) {
    const existing = getAlertedDeal(db, deal.key)
    if (!existing) {
      toAlert.push({ deal, reason: 'new' })
      continue
    }
    const points = dealPoints(deal)
    if (points <= existing.best_points * dropFactor) {
      toAlert.push({ deal, reason: 'improved', prevBestPoints: existing.best_points })
      continue
    }
    const lastSeen = Date.parse(existing.last_seen_at)
    if (Number.isFinite(lastSeen) && now.getTime() - lastSeen >= goneMs) {
      toAlert.push({ deal, reason: 'returned', prevBestPoints: existing.best_points })
      continue
    }
    stillQualifyingKeys.push(deal.key)
  }

  return { toAlert, stillQualifyingKeys }
}
