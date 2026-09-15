// Pure config-scoping rules for the availability snapshot — no Node imports.
// Shared by the poller (src/poll.ts) and the web read model (src/server/queries.ts)
// so "alerted" and "shown in the console" can never drift apart.
import { HARD_MAX_WINDOW_DAYS } from '../shared/constants.js'
import type { AppConfig } from '../shared/configSchema.js'
import type { AvailabilityRecord } from '../types.js'

export interface SearchWindow {
  startDate: string // YYYY-MM-DD, inclusive
  endDate: string // YYYY-MM-DD, inclusive
}

function fmtLocalDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

/** Derive the concrete search window (local calendar dates) from relative offsets. */
export function deriveWindow(cfg: AppConfig, today: Date = new Date()): SearchWindow {
  const startOffset = Math.min(cfg.search.window.startOffsetDays, HARD_MAX_WINDOW_DAYS)
  const endOffset = Math.min(cfg.search.window.endOffsetDays, HARD_MAX_WINDOW_DAYS)
  return {
    startDate: fmtLocalDate(addDays(today, startOffset)),
    endDate: fmtLocalDate(addDays(today, Math.max(endOffset, startOffset))),
  }
}

export interface SearchScope extends SearchWindow {
  origins: ReadonlySet<string>
  destinations: ReadonlySet<string>
}

export function scopeFor(
  search: Pick<AppConfig['search'], 'origins' | 'destinations'>,
  window: SearchWindow,
): SearchScope {
  return {
    ...window,
    origins: new Set(search.origins),
    destinations: new Set(search.destinations),
  }
}

/**
 * Direction-aware: a row is in scope only for the leg the CURRENT config would
 * fetch it as. Rows keep the direction of the config that fetched them — the
 * upsert rewrites `direction` on conflict (db.ts) — so a re-fetched route always
 * re-enters scope with the right direction; only never-re-seen stale rows keep a
 * stale one, and those are exactly the rows this predicate hides.
 */
export function isInScope(rec: AvailabilityRecord, s: SearchScope): boolean {
  if (rec.date < s.startDate || rec.date > s.endDate) return false
  return rec.direction === 'outbound'
    ? s.origins.has(rec.origin) && s.destinations.has(rec.destination)
    : s.origins.has(rec.destination) && s.destinations.has(rec.origin)
}
