import { Hono } from 'hono'
import type { Db } from '../db.js'
import type { AppConfig } from '../shared/configSchema.js'
import { ConfigError } from '../config.js'
import type {
  HealthResponse,
  RunConflictResponse,
  RunStartedResponse,
  CyclesResponse,
  ApiError,
  TripDetailOkResponse,
} from '../shared/apiTypes.js'
import type { InFlightInfo } from '../scheduler.js'
import type { TripDetailService } from './tripDetails.js'
import {
  buildStatus,
  recentCycles,
  queryOneways,
  queryRoundtrips,
  queryCalendar,
  queryAlerts,
} from './queries.js'
import type { Direction } from '../types.js'

export interface SchedulerFacade {
  cycleInFlight(): InFlightInfo | null
  nextRunAt(): string | null
  intervalHours(): number
  /** Kick off a manual cycle; null when one is already in flight. */
  runExclusive(trigger: 'manual'): Promise<unknown> | null
  /** Re-arm after an interval change (config PUT). */
  rearm(): void
}

export interface ConfigFacade {
  path: string
  /** Validate + persist + hot-swap. Throws ConfigError on invalid input. */
  apply(raw: unknown): AppConfig
}

export interface AppDeps {
  db: Db
  getConfig: () => AppConfig
  scheduler: SchedulerFacade | null
  /** Present in serve mode; enables GET/PUT /api/config. */
  configApi?: ConfigFacade
  envPresence: () => { seatsAeroApiKey: boolean; twilioCreds: boolean }
  /** Present in serve mode; enables GET /api/trips/:availabilityId. */
  tripDetails?: TripDetailService
  version: string
  now?: () => Date
}

const READ_ONLY_PATHS = ['db.path', 'server.port'] as const

const AVAILABILITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function buildApp(deps: AppDeps): Hono {
  const now = deps.now ?? (() => new Date())
  const app = new Hono()

  // The server binds to 127.0.0.1, but that does not stop a malicious page in
  // the user's own browser from firing cross-origin "simple requests" that burn
  // API quota blind, and DNS rebinding can even make responses readable. A
  // foreign Origin or non-loopback Host has no business here.
  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host')
    if (host !== undefined && !isLoopbackHost(host)) {
      return c.json({ error: 'forbidden' } satisfies ApiError, 403)
    }
    const origin = c.req.header('origin')
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return c.json({ error: 'forbidden' } satisfies ApiError, 403)
    }
    await next()
  })

  app.get('/api/health', (c) => {
    return c.json({ ok: true, version: deps.version } satisfies HealthResponse)
  })

  app.get('/api/status', (c) => {
    const scheduler = deps.scheduler
      ? {
          intervalHours: deps.scheduler.intervalHours(),
          nextRunAt: deps.scheduler.nextRunAt(),
          cycleInFlight: deps.scheduler.cycleInFlight(),
        }
      : null
    return c.json(buildStatus(deps.db, deps.getConfig(), scheduler, deps.envPresence(), now()))
  })

  app.get('/api/cycles', (c) => {
    const limit = clampInt(c.req.query('limit'), 1, 200, 20)
    return c.json({ cycles: recentCycles(deps.db, limit) } satisfies CyclesResponse)
  })

  app.get('/api/deals/oneway', (c) => {
    const q = c.req.query.bind(c.req)
    return c.json(
      queryOneways(deps.db, deps.getConfig(), now(), {
        ...(q('origin') ? { origin: q('origin')!.toUpperCase() } : {}),
        ...(q('destination') ? { destination: q('destination')!.toUpperCase() } : {}),
        ...(q('home') ? { home: q('home')!.toUpperCase() } : {}),
        ...(q('dest') ? { dest: q('dest')!.toUpperCase() } : {}),
        ...(q('source') ? { source: q('source')! } : {}),
        ...(parseDirection(q('direction')) ? { direction: parseDirection(q('direction'))! } : {}),
        ...(parseIntOpt(q('maxPoints')) !== undefined ? { maxPoints: parseIntOpt(q('maxPoints'))! } : {}),
        ...(parseBool(q('directOnly')) !== undefined ? { directOnly: parseBool(q('directOnly'))! } : {}),
        ...(parseBool(q('includeEstimates')) !== undefined
          ? { includeEstimates: parseBool(q('includeEstimates'))! }
          : {}),
        ...(q('from') ? { from: q('from')! } : {}),
        ...(q('to') ? { to: q('to')! } : {}),
        ...(q('sort') === 'date' ? { sort: 'date' as const } : {}),
        limit: clampInt(q('limit'), 1, 1000, 100),
        offset: clampInt(q('offset'), 0, 100_000, 0),
      }),
    )
  })

  app.get('/api/deals/roundtrip', (c) => {
    const q = c.req.query.bind(c.req)
    return c.json(
      queryRoundtrips(deps.db, deps.getConfig(), now(), {
        ...(q('origin') ? { origin: q('origin')!.toUpperCase() } : {}),
        ...(q('destination') ? { destination: q('destination')!.toUpperCase() } : {}),
        ...(parseIntOpt(q('maxTotal')) !== undefined ? { maxTotal: parseIntOpt(q('maxTotal'))! } : {}),
        ...(parseIntOpt(q('minStay')) !== undefined ? { minStay: parseIntOpt(q('minStay'))! } : {}),
        ...(parseIntOpt(q('maxStay')) !== undefined ? { maxStay: parseIntOpt(q('maxStay'))! } : {}),
        ...(parseBool(q('sameCityReturn')) !== undefined
          ? { sameCityReturn: parseBool(q('sameCityReturn'))! }
          : {}),
        ...(parseBool(q('includeEstimates')) !== undefined
          ? { includeEstimates: parseBool(q('includeEstimates'))! }
          : {}),
        limit: clampInt(q('limit'), 1, 1000, 100),
        offset: clampInt(q('offset'), 0, 100_000, 0),
      }),
    )
  })

  app.get('/api/availability/calendar', (c) => {
    const direction = parseDirection(c.req.query('direction')) ?? 'outbound'
    const origin = c.req.query('origin')?.toUpperCase()
    const destination = c.req.query('destination')?.toUpperCase()
    return c.json(queryCalendar(deps.db, deps.getConfig(), now(), direction, origin, destination))
  })

  app.get('/api/alerts', (c) => {
    const limit = clampInt(c.req.query('limit'), 1, 500, 50)
    const kind = c.req.query('kind')
    return c.json({
      alerts: queryAlerts(deps.db, limit, kind === 'oneway' || kind === 'roundtrip' ? kind : undefined),
    })
  })

  app.get('/api/trips/:availabilityId', async (c) => {
    const id = c.req.param('availabilityId')
    if (!AVAILABILITY_ID_RE.test(id)) {
      return c.json({ error: 'invalid_availability_id' } satisfies ApiError, 400)
    }
    if (!deps.tripDetails) return c.json({ error: 'no_api_key' } satisfies ApiError, 400)
    const outcome = await deps.tripDetails.get(id)
    switch (outcome.kind) {
      case 'ok':
        return c.json(outcome.body satisfies TripDetailOkResponse)
      case 'no_api_key':
        return c.json({ error: 'no_api_key' } satisfies ApiError, 400)
      case 'expired':
        return c.json({ error: 'expired' } satisfies ApiError, 404)
      case 'quota_exhausted':
        return c.json({ error: 'quota_exhausted' } satisfies ApiError, 503)
      case 'upstream_error':
        return c.json({ error: 'upstream_error' } satisfies ApiError, 502)
    }
  })

  app.get('/api/config', (c) => {
    if (!deps.configApi) return c.json({ error: 'config API available in serve mode only' }, 400)
    return c.json({
      config: deps.getConfig(),
      meta: { path: deps.configApi.path, readOnlyPaths: [...READ_ONLY_PATHS] },
    })
  })

  app.put('/api/config', async (c) => {
    if (!deps.configApi) return c.json({ error: 'config API available in serve mode only' }, 400)
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }

    // Read-only fields may be present but must match the current values.
    const current = deps.getConfig()
    const issues: { path: string; message: string }[] = []
    if (isRecord(raw)) {
      const db = isRecord(raw.db) ? raw.db : undefined
      if (db && db.path !== undefined && db.path !== current.db.path) {
        issues.push({ path: 'db.path', message: 'read-only — edit config.yaml and restart' })
      }
      const server = isRecord(raw.server) ? raw.server : undefined
      if (server && server.port !== undefined && server.port !== current.server.port) {
        issues.push({ path: 'server.port', message: 'read-only — edit config.yaml and restart' })
      }
    }
    if (issues.length > 0) return c.json({ error: 'validation', issues }, 400)

    // Pin read-only sections to their current values so a body that omits them
    // cannot silently rewrite config.yaml with schema defaults.
    const pinned = isRecord(raw)
      ? { ...raw, db: { path: current.db.path }, server: { port: current.server.port } }
      : raw

    try {
      const applied = deps.configApi.apply(pinned)
      deps.scheduler?.rearm()
      return c.json({ config: applied, appliesAt: 'next-cycle' })
    } catch (err) {
      if (err instanceof ConfigError) {
        return c.json({ error: 'validation', issues: err.issues }, 400)
      }
      throw err
    }
  })

  app.post('/api/run', (c) => {
    if (!deps.scheduler) {
      const why = deps.envPresence().seatsAeroApiKey
        ? 'scheduler not running (serve mode only)'
        : 'scheduler disabled — SEATS_AERO_API_KEY is not set'
      return c.json({ error: why }, 400)
    }
    const inFlight = deps.scheduler.cycleInFlight()
    if (inFlight) {
      return c.json(
        {
          error: 'cycle_in_flight',
          startedAt: inFlight.startedAt,
          trigger: inFlight.trigger,
        } satisfies RunConflictResponse,
        409,
      )
    }
    const run = deps.scheduler.runExclusive('manual')
    if (run === null) {
      const racing = deps.scheduler.cycleInFlight()
      return c.json(
        {
          error: 'cycle_in_flight',
          startedAt: racing?.startedAt ?? now().toISOString(),
          trigger: racing?.trigger ?? 'scheduled',
        } satisfies RunConflictResponse,
        409,
      )
    }
    return c.json({ started: true, trigger: 'manual' } satisfies RunStartedResponse, 202)
  })

  return app
}

export function clampInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined) return fallback
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function parseIntOpt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return undefined
}

function parseDirection(raw: string | undefined): Direction | undefined {
  return raw === 'outbound' || raw === 'return' ? raw : undefined
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function isLoopbackHost(host: string): boolean {
  // Host header is "hostname" or "hostname:port"; IPv6 hostnames are bracketed.
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0]!
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())
}

function isLoopbackOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false // includes the literal "null" origin
  }
  return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())
}
