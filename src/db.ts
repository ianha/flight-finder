import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AvailabilityRecord, Direction } from './types.js'

export type Db = Database.Database

// Append-only list; each entry runs once, tracked via PRAGMA user_version.
const MIGRATIONS: string[] = [
  `
  -- Latest snapshot per (source, route, date), business cabin only.
  -- Identity is the route/date/source triple; the seats.aero ID is stored but
  -- may be reissued by their crawler, so it is not the key.
  CREATE TABLE availability (
    source                  TEXT NOT NULL,
    origin                  TEXT NOT NULL,
    destination             TEXT NOT NULL,
    date                    TEXT NOT NULL,
    id                      TEXT NOT NULL,
    -- The leg AS FETCHED BY THE LAST CYCLE that saw this row, not geometry —
    -- upsertAvailability rewrites it on every conflict. A row a current config
    -- no longer fetches keeps a stale direction; see deals/scope.ts#isInScope,
    -- which relies on exactly that to hide rows outside the live configuration.
    direction               TEXT NOT NULL,
    j_available             INTEGER NOT NULL,
    j_mileage_cost          INTEGER,
    j_direct                INTEGER NOT NULL DEFAULT 0,
    j_direct_mileage_cost   INTEGER,
    j_remaining_seats       INTEGER,
    j_direct_remaining_seats INTEGER,
    j_airlines              TEXT NOT NULL DEFAULT '',
    j_direct_airlines       TEXT NOT NULL DEFAULT '',
    route_distance          INTEGER,
    api_updated_at          TEXT NOT NULL,
    first_seen_at           TEXT NOT NULL,
    last_seen_at            TEXT NOT NULL,
    PRIMARY KEY (source, origin, destination, date)
  );
  CREATE INDEX ix_avail_direction_date ON availability(direction, date);
  CREATE INDEX ix_avail_last_seen ON availability(last_seen_at);

  -- Everything ever alerted, for dedupe and the re-alert policy.
  CREATE TABLE alerted_deals (
    deal_key         TEXT PRIMARY KEY,
    kind             TEXT NOT NULL,
    best_points      INTEGER NOT NULL,
    last_points      INTEGER NOT NULL,
    is_estimate      INTEGER NOT NULL DEFAULT 0,
    first_alerted_at TEXT NOT NULL,
    last_alerted_at  TEXT NOT NULL,
    last_seen_at     TEXT NOT NULL,
    alert_count      INTEGER NOT NULL DEFAULT 1,
    detail_json      TEXT
  );

  -- Poll-cycle history (Status page + diagnostics).
  CREATE TABLE cycles (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_kind     TEXT NOT NULL,
    started_at       TEXT NOT NULL,
    finished_at      TEXT,
    status           TEXT NOT NULL DEFAULT 'running',
    calls_used       INTEGER NOT NULL DEFAULT 0,
    records_fetched  INTEGER NOT NULL DEFAULT 0,
    oneways_found    INTEGER NOT NULL DEFAULT 0,
    roundtrips_found INTEGER NOT NULL DEFAULT 0,
    alerts_sent      INTEGER NOT NULL DEFAULT 0,
    error_message    TEXT
  );

  -- Daily API budget ledger (UTC days — the API quota resets at midnight UTC).
  CREATE TABLE api_calls (
    day      TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, endpoint)
  );

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
]

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]!
    db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}

// ---------------------------------------------------------------------------
// availability
// ---------------------------------------------------------------------------

export function upsertAvailability(db: Db, rec: AvailabilityRecord, seenAt: string): void {
  db.prepare(
    `INSERT INTO availability (
       source, origin, destination, date, id, direction,
       j_available, j_mileage_cost, j_direct, j_direct_mileage_cost,
       j_remaining_seats, j_direct_remaining_seats, j_airlines, j_direct_airlines,
       route_distance, api_updated_at, first_seen_at, last_seen_at
     ) VALUES (
       @source, @origin, @destination, @date, @id, @direction,
       @jAvailable, @jMileageCost, @jDirect, @jDirectMileageCost,
       @jRemainingSeats, @jDirectRemainingSeats, @jAirlines, @jDirectAirlines,
       @routeDistance, @apiUpdatedAt, @seenAt, @seenAt
     )
     ON CONFLICT(source, origin, destination, date) DO UPDATE SET
       id = excluded.id,
       direction = excluded.direction,
       j_available = excluded.j_available,
       j_mileage_cost = excluded.j_mileage_cost,
       j_direct = excluded.j_direct,
       j_direct_mileage_cost = excluded.j_direct_mileage_cost,
       j_remaining_seats = excluded.j_remaining_seats,
       j_direct_remaining_seats = excluded.j_direct_remaining_seats,
       j_airlines = excluded.j_airlines,
       j_direct_airlines = excluded.j_direct_airlines,
       route_distance = excluded.route_distance,
       api_updated_at = excluded.api_updated_at,
       last_seen_at = excluded.last_seen_at`,
  ).run({
    source: rec.source,
    origin: rec.origin,
    destination: rec.destination,
    date: rec.date,
    id: rec.id,
    direction: rec.direction,
    jAvailable: rec.jAvailable ? 1 : 0,
    jMileageCost: rec.jMileageCost,
    jDirect: rec.jDirect ? 1 : 0,
    jDirectMileageCost: rec.jDirectMileageCost,
    jRemainingSeats: rec.jRemainingSeats,
    jDirectRemainingSeats: rec.jDirectRemainingSeats,
    jAirlines: rec.jAirlines,
    jDirectAirlines: rec.jDirectAirlines,
    routeDistance: rec.routeDistance,
    apiUpdatedAt: rec.apiUpdatedAt,
    seenAt,
  })
}

interface AvailabilityRow {
  source: string
  origin: string
  destination: string
  date: string
  id: string
  direction: string
  j_available: number
  j_mileage_cost: number | null
  j_direct: number
  j_direct_mileage_cost: number | null
  j_remaining_seats: number | null
  j_direct_remaining_seats: number | null
  j_airlines: string
  j_direct_airlines: string
  route_distance: number | null
  api_updated_at: string
}

function rowToRecord(row: AvailabilityRow): AvailabilityRecord {
  return {
    id: row.id,
    source: row.source,
    origin: row.origin,
    destination: row.destination,
    date: row.date,
    direction: row.direction as Direction,
    jAvailable: row.j_available === 1,
    jMileageCost: row.j_mileage_cost,
    jDirect: row.j_direct === 1,
    jDirectMileageCost: row.j_direct_mileage_cost,
    jRemainingSeats: row.j_remaining_seats,
    jDirectRemainingSeats: row.j_direct_remaining_seats,
    jAirlines: row.j_airlines,
    jDirectAirlines: row.j_direct_airlines,
    routeDistance: row.route_distance,
    apiUpdatedAt: row.api_updated_at,
  }
}

/** All records seen in the given cycle (fresh snapshot). */
export function getAvailabilitySeenAt(db: Db, seenAt: string): AvailabilityRecord[] {
  const rows = db
    .prepare('SELECT * FROM availability WHERE last_seen_at = ?')
    .all(seenAt) as AvailabilityRow[]
  return rows.map(rowToRecord)
}

/**
 * Latest snapshot, bounded to a date range (inclusive) — used by the web read
 * model, which then applies isInScope (deals/scope.ts) for the geography/
 * direction rule. Uses ix_avail_direction_date; unbounded rows outside any
 * config's window are excluded without a full scan.
 */
export function getAvailabilityInWindow(db: Db, window: { startDate: string; endDate: string }): AvailabilityRecord[] {
  const rows = db
    .prepare('SELECT * FROM availability WHERE date >= ? AND date <= ?')
    .all(window.startDate, window.endDate) as AvailabilityRow[]
  return rows.map(rowToRecord)
}

export function countAvailability(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM availability').get() as { n: number }).n
}

// ---------------------------------------------------------------------------
// alerted_deals
// ---------------------------------------------------------------------------

export interface AlertedDealRow {
  deal_key: string
  kind: string
  best_points: number
  last_points: number
  is_estimate: number
  first_alerted_at: string
  last_alerted_at: string
  last_seen_at: string
  alert_count: number
  detail_json: string | null
}

export function getAlertedDeal(db: Db, key: string): AlertedDealRow | undefined {
  return db.prepare('SELECT * FROM alerted_deals WHERE deal_key = ?').get(key) as
    | AlertedDealRow
    | undefined
}

export interface AlertUpsert {
  key: string
  kind: 'oneway' | 'roundtrip'
  points: number
  isEstimate: boolean
  detailJson: string
}

/** Record that these deals were included in a successfully-sent alert. Runs in one transaction. */
export function recordAlertedDeals(db: Db, deals: AlertUpsert[], now: string): void {
  const stmt = db.prepare(
    `INSERT INTO alerted_deals
       (deal_key, kind, best_points, last_points, is_estimate,
        first_alerted_at, last_alerted_at, last_seen_at, alert_count, detail_json)
     VALUES (@key, @kind, @points, @points, @isEstimate, @now, @now, @now, 1, @detailJson)
     ON CONFLICT(deal_key) DO UPDATE SET
       best_points = MIN(best_points, excluded.best_points),
       last_points = excluded.last_points,
       is_estimate = excluded.is_estimate,
       last_alerted_at = excluded.last_alerted_at,
       last_seen_at = excluded.last_seen_at,
       alert_count = alert_count + 1,
       detail_json = excluded.detail_json`,
  )
  db.transaction(() => {
    for (const d of deals) {
      stmt.run({
        key: d.key,
        kind: d.kind,
        points: d.points,
        isEstimate: d.isEstimate ? 1 : 0,
        now,
        detailJson: d.detailJson,
      })
    }
  })()
}

/** Refresh last_seen_at for known deals that still qualify this cycle (even when not re-alerted). */
export function touchAlertedDealsSeen(db: Db, keys: string[], now: string): void {
  const stmt = db.prepare('UPDATE alerted_deals SET last_seen_at = ? WHERE deal_key = ?')
  db.transaction(() => {
    for (const key of keys) stmt.run(now, key)
  })()
}

export function getRecentAlerts(db: Db, limit: number, kind?: string): AlertedDealRow[] {
  if (kind) {
    return db
      .prepare('SELECT * FROM alerted_deals WHERE kind = ? ORDER BY last_alerted_at DESC LIMIT ?')
      .all(kind, limit) as AlertedDealRow[]
  }
  return db
    .prepare('SELECT * FROM alerted_deals ORDER BY last_alerted_at DESC LIMIT ?')
    .all(limit) as AlertedDealRow[]
}

// ---------------------------------------------------------------------------
// cycles
// ---------------------------------------------------------------------------

export type CycleTrigger = 'scheduled' | 'manual'
export type CycleStatus = 'running' | 'ok' | 'error' | 'aborted_quota'

export interface CycleRow {
  id: number
  trigger_kind: string
  started_at: string
  finished_at: string | null
  status: string
  calls_used: number
  records_fetched: number
  oneways_found: number
  roundtrips_found: number
  alerts_sent: number
  error_message: string | null
}

export function startCycle(db: Db, trigger: CycleTrigger, startedAt: string): number {
  const info = db
    .prepare(`INSERT INTO cycles (trigger_kind, started_at, status) VALUES (?, ?, 'running')`)
    .run(trigger, startedAt)
  return Number(info.lastInsertRowid)
}

export function finishCycle(
  db: Db,
  id: number,
  patch: {
    finishedAt: string
    status: CycleStatus
    callsUsed: number
    recordsFetched: number
    onewaysFound: number
    roundtripsFound: number
    alertsSent: number
    errorMessage?: string
  },
): void {
  db.prepare(
    `UPDATE cycles SET finished_at = @finishedAt, status = @status, calls_used = @callsUsed,
       records_fetched = @recordsFetched, oneways_found = @onewaysFound,
       roundtrips_found = @roundtripsFound, alerts_sent = @alertsSent,
       error_message = @errorMessage
     WHERE id = @id`,
  ).run({ id, errorMessage: patch.errorMessage ?? null, ...patch })
}

export function getRecentCycles(db: Db, limit: number): CycleRow[] {
  return db
    .prepare('SELECT * FROM cycles ORDER BY id DESC LIMIT ?')
    .all(limit) as CycleRow[]
}

export function countConsecutiveFailedCycles(db: Db): number {
  // Only hard 'error' cycles count as failures: an 'aborted_quota' cycle is a
  // healthy service protecting its budget (and may even have sent a digest).
  const rows = db
    .prepare(`SELECT status FROM cycles WHERE status != 'running' ORDER BY id DESC LIMIT 20`)
    .all() as { status: string }[]
  let n = 0
  for (const row of rows) {
    if (row.status !== 'error') break
    n++
  }
  return n
}

/**
 * Mark cycles left in 'running' by a crashed/killed process as errors.
 * Called at process start (serve and one-shot search), when no cycle can be live.
 */
export function reconcileStuckCycles(db: Db, now: string): number {
  const info = db
    .prepare(
      `UPDATE cycles SET status = 'error', finished_at = ?,
         error_message = 'interrupted — process exited mid-cycle'
       WHERE status = 'running'`,
    )
    .run(now)
  return info.changes
}

// ---------------------------------------------------------------------------
// Cross-process cycle lock (CLI `search` vs the serve scheduler on one DB)
// ---------------------------------------------------------------------------

const CYCLE_LOCK_KEY = 'cycle_lock'
const CYCLE_LOCK_STALE_MS = 30 * 60_000

/** Returns true when acquired; false when another live process holds it. */
export function acquireCycleLock(db: Db, now: Date): boolean {
  return db.transaction(() => {
    const held = metaGet(db, CYCLE_LOCK_KEY)
    if (held !== undefined) {
      const [pid, ts] = held.split('|')
      const age = now.getTime() - Date.parse(ts ?? '')
      const alive = pid !== undefined && processAlive(parseInt(pid, 10))
      if (alive && Number.isFinite(age) && age < CYCLE_LOCK_STALE_MS) return false
    }
    metaSet(db, CYCLE_LOCK_KEY, `${process.pid}|${now.toISOString()}`)
    return true
  })()
}

export function releaseCycleLock(db: Db): void {
  const held = metaGet(db, CYCLE_LOCK_KEY)
  if (held !== undefined && held.startsWith(`${process.pid}|`)) {
    db.prepare('DELETE FROM meta WHERE key = ?').run(CYCLE_LOCK_KEY)
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// api_calls budget ledger
// ---------------------------------------------------------------------------

export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export function incrementApiCalls(db: Db, day: string, endpoint: string, n = 1): void {
  db.prepare(
    `INSERT INTO api_calls (day, endpoint, count) VALUES (?, ?, ?)
     ON CONFLICT(day, endpoint) DO UPDATE SET count = count + excluded.count`,
  ).run(day, endpoint, n)
}

export function getCallsUsed(db: Db, day: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS n FROM api_calls WHERE day = ?')
    .get(day) as { n: number }
  return row.n
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export function metaGet(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function metaSet(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}
