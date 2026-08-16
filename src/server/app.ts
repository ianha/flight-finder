import { Hono } from 'hono'
import type { Db } from '../db.js'
import type { AppConfig } from '../shared/configSchema.js'
import type {
  HealthResponse,
  RunConflictResponse,
  RunStartedResponse,
  CyclesResponse,
} from '../shared/apiTypes.js'
import type { InFlightInfo } from '../scheduler.js'
import { buildStatus, recentCycles } from './queries.js'

export interface SchedulerFacade {
  cycleInFlight(): InFlightInfo | null
  nextRunAt(): string | null
  intervalHours(): number
  /** Kick off a manual cycle; null when one is already in flight. */
  runExclusive(trigger: 'manual'): Promise<unknown> | null
  /** Re-arm after an interval change (config PUT). */
  rearm(): void
}

export interface AppDeps {
  db: Db
  getConfig: () => AppConfig
  scheduler: SchedulerFacade | null
  envPresence: () => { seatsAeroApiKey: boolean; smtpPassword: boolean }
  version: string
  now?: () => Date
}

export function buildApp(deps: AppDeps): Hono {
  const now = deps.now ?? (() => new Date())
  const app = new Hono()

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

  app.post('/api/run', (c) => {
    if (!deps.scheduler) {
      return c.json({ error: 'scheduler not running (serve mode only)' }, 400)
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
