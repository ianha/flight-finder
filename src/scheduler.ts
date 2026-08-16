import type { CycleOutcome } from './poll.js'
import type { CycleTrigger } from './db.js'
import { log } from './log.js'

export type CycleRunner = (trigger: CycleTrigger) => Promise<CycleOutcome>

export interface SchedulerOptions {
  runner: CycleRunner
  /** Read live each time the timer is armed, so interval edits apply without restart. */
  getIntervalHours: () => number
  /** Last completed cycle start time (ISO), for drift-corrected scheduling. */
  getLastCycleAt: () => string | undefined
  now?: () => Date
}

export interface InFlightInfo {
  startedAt: string
  trigger: CycleTrigger
}

/**
 * Drift-corrected interval scheduler with a single in-process mutex shared by
 * scheduled runs and manual "run now" (HTTP/CLI) — at most one cycle at a time.
 */
export class Scheduler {
  private inFlight: (InFlightInfo & { promise: Promise<CycleOutcome> }) | null = null
  private timer: NodeJS.Timeout | null = null
  // Inert until start(): runExclusive() works standalone without beginning the loop.
  private stopped = true
  private readonly now: () => Date

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? (() => new Date())
  }

  cycleInFlight(): InFlightInfo | null {
    return this.inFlight ? { startedAt: this.inFlight.startedAt, trigger: this.inFlight.trigger } : null
  }

  intervalHours(): number {
    return this.opts.getIntervalHours()
  }

  nextRunAt(): string | null {
    if (this.inFlight) return null // next run is computed when the current one finishes
    return new Date(this.nextRunEpoch()).toISOString()
  }

  private nextRunEpoch(): number {
    const intervalMs = this.opts.getIntervalHours() * 3_600_000
    const last = this.opts.getLastCycleAt()
    const lastMs = last !== undefined ? Date.parse(last) : NaN
    if (!Number.isFinite(lastMs)) return this.now().getTime()
    return Math.max(this.now().getTime(), lastMs + intervalMs)
  }

  /**
   * Run a cycle now unless one is already in flight.
   * Returns the outcome promise, or null when busy (callers surface a 409).
   */
  runExclusive(trigger: CycleTrigger): Promise<CycleOutcome> | null {
    if (this.inFlight) return null
    const startedAt = this.now().toISOString()
    const promise = this.opts
      .runner(trigger)
      .catch((err: unknown) => {
        // The runner (runCycle) records its own failures; this guard keeps an
        // unexpected throw from killing the scheduler loop.
        log.error(`cycle runner threw: ${(err as Error).message}`)
        return {
          status: 'error',
          digest: null,
          recordsFetched: 0,
          invalidCount: 0,
          onewaysFound: 0,
          roundtripsFound: 0,
          alertsSent: 0,
          callsUsed: 0,
          error: (err as Error).message,
        } satisfies CycleOutcome
      })
      .finally(() => {
        this.inFlight = null
        this.arm()
      })
    this.inFlight = { startedAt, trigger, promise }
    return promise
  }

  /** Start the loop: run immediately if due, then keep re-arming. */
  start(): void {
    this.stopped = false
    this.arm()
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const delay = Math.max(this.nextRunEpoch() - this.now().getTime(), 0)
    this.timer = setTimeout(() => {
      const run = this.runExclusive('scheduled')
      // Busy (manual run in flight): re-arming happens in that run's finally.
      if (run === null) return
    }, delay)
    this.timer.unref?.()
    log.debug(`scheduler armed: next run in ${Math.round(delay / 1000)}s`)
  }

  /** Re-arm immediately (config interval changed). */
  rearm(): void {
    if (!this.inFlight) this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
