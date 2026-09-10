import { incrementApiCalls, utcDay, type Db } from '../db.js'
import { estimatedRemaining } from '../quota.js'
import { NotFoundError, QuotaExhaustedError, type TripsFullResult } from '../seatsAero.js'
import type { AppConfig } from '../shared/configSchema.js'
import type { TripDetailOkResponse } from '../shared/apiTypes.js'
import { log } from '../log.js'

/** The subset of SeatsAeroClient the detail endpoint needs (tests substitute their own). */
export interface TripsFetcher {
  getTripsFull(availabilityId: string): Promise<TripsFullResult>
}

export type TripDetailOutcome =
  | { kind: 'ok'; body: TripDetailOkResponse }
  | { kind: 'no_api_key' }
  | { kind: 'quota_exhausted' }
  | { kind: 'expired' }
  | { kind: 'upstream_error' }

export interface TripDetailServiceDeps {
  db: Db
  /** Getter, not instance: null in UI-only mode; re-read per call so config hot-swaps apply. */
  getClient: () => TripsFetcher | null
  getConfig: () => AppConfig
  now?: () => Date
}

// Upstream data is already hours stale, so these are constants, not config knobs.
const OK_TTL_MS = 30 * 60_000
// expired/upstream_error: long enough that repeat clicks on a dead row don't
// re-burn quota, short enough that a transient failure clears itself.
const NEGATIVE_TTL_MS = 5 * 60_000
const MAX_CACHE_ENTRIES = 500

interface CacheEntry {
  promise: Promise<TripDetailOutcome>
  /** Infinity while in flight (concurrent requests coalesce onto the promise). */
  expiresAt: number
}

/**
 * On-demand trip details with an in-process cache. One entry per availability id;
 * the entry stores the outcome *promise*, so concurrent requests for the same id
 * share a single upstream call by construction. Invariants:
 * - get() is synchronous up to the cache insert (no await), so the
 *   check-then-insert sequence is race-free on Node's single thread;
 * - the cached promise never rejects — errors are mapped to outcome values
 *   inside the task, so no waiter can leak an unhandled rejection.
 */
export class TripDetailService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly nowFn: () => Date

  constructor(private readonly deps: TripDetailServiceDeps) {
    this.nowFn = deps.now ?? (() => new Date())
  }

  get(availabilityId: string): Promise<TripDetailOutcome> {
    const nowMs = this.nowFn().getTime()
    const cached = this.cache.get(availabilityId)
    if (cached && nowMs < cached.expiresAt) return cached.promise

    const client = this.deps.getClient()
    if (!client) return Promise.resolve({ kind: 'no_api_key' })

    const cfg = this.deps.getConfig()
    if (estimatedRemaining(this.deps.db, cfg, this.nowFn) <= cfg.api.reserveCalls) {
      return Promise.resolve({ kind: 'quota_exhausted' })
    }

    // Charge before the fetch: a crashed request has still burned upstream
    // quota, and overcounting on failure is the direction that preserves the
    // reserve guarantee for the alert poller.
    incrementApiCalls(this.deps.db, utcDay(this.nowFn()), 'trips-web')

    this.evictExpired(nowMs)
    const entry: CacheEntry = { promise: Promise.resolve({ kind: 'upstream_error' }), expiresAt: Infinity }
    entry.promise = this.fetchOutcome(client, availabilityId).then((outcome) => {
      entry.expiresAt = this.nowFn().getTime() + (outcome.kind === 'ok' ? OK_TTL_MS : NEGATIVE_TTL_MS)
      return outcome
    })
    this.cache.set(availabilityId, entry)
    return entry.promise
  }

  private async fetchOutcome(client: TripsFetcher, availabilityId: string): Promise<TripDetailOutcome> {
    try {
      const result = await client.getTripsFull(availabilityId)
      return {
        kind: 'ok',
        body: {
          availabilityId,
          options: result.options,
          bookingLinks: result.bookingLinks,
          fetchedAt: this.nowFn().toISOString(),
        },
      }
    } catch (err) {
      if (err instanceof NotFoundError) return { kind: 'expired' }
      if (err instanceof QuotaExhaustedError) return { kind: 'quota_exhausted' }
      // Upstream detail (URLs, statuses) stays in the server log only.
      log.warn(`web trips lookup failed for ${availabilityId}: ${(err as Error).message}`)
      return { kind: 'upstream_error' }
    }
  }

  private evictExpired(nowMs: number): void {
    if (this.cache.size < MAX_CACHE_ENTRIES) return
    for (const [id, entry] of this.cache) {
      if (nowMs >= entry.expiresAt) this.cache.delete(id)
    }
  }
}
