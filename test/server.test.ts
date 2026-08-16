import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, incrementApiCalls, startCycle, finishCycle, metaSet, type Db } from '../src/db.js'
import { parseConfig } from '../src/config.js'
import { buildApp, type SchedulerFacade } from '../src/server/app.js'
import type { StatusResponse, CyclesResponse, RunConflictResponse } from '../src/shared/apiTypes.js'
import { Scheduler } from '../src/scheduler.js'
import type { CycleOutcome } from '../src/poll.js'

const NOW = new Date('2026-08-15T12:00:00Z')

function fakeOutcome(): CycleOutcome {
  return {
    status: 'ok',
    digest: null,
    recordsFetched: 0,
    invalidCount: 0,
    onewaysFound: 0,
    roundtripsFound: 0,
    alertsSent: 0,
    callsUsed: 0,
  }
}

function makeApp(db: Db, scheduler: SchedulerFacade | null) {
  return buildApp({
    db,
    getConfig: () => parseConfig({}),
    scheduler,
    envPresence: () => ({ seatsAeroApiKey: true, smtpPassword: false }),
    version: 'test',
    now: () => NOW,
  })
}

test('GET /api/health returns ok + version', async () => {
  const app = makeApp(openDb(':memory:'), null)
  const res = await app.request('/api/health')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, version: 'test' })
})

test('GET /api/status reports quota math, last cycle, and env presence', async () => {
  const db = openDb(':memory:')
  incrementApiCalls(db, '2026-08-15', 'search', 12)
  incrementApiCalls(db, '2026-08-15', 'trips', 3)
  incrementApiCalls(db, '2026-08-14', 'search', 500) // other day — must not count
  metaSet(db, 'rate_limit_remaining', '842')
  metaSet(db, 'rate_limit_seen_at', '2026-08-15T11:00:00Z')
  const id = startCycle(db, 'scheduled', '2026-08-15T10:00:00Z')
  finishCycle(db, id, {
    finishedAt: '2026-08-15T10:00:42Z',
    status: 'ok',
    callsUsed: 15,
    recordsFetched: 120,
    onewaysFound: 2,
    roundtripsFound: 1,
    alertsSent: 3,
  })

  const app = makeApp(db, null)
  const res = await app.request('/api/status')
  assert.equal(res.status, 200)
  const body = (await res.json()) as StatusResponse
  assert.equal(body.quota.used, 15)
  assert.equal(body.quota.budget, 900)
  assert.equal(body.quota.headerRemaining, 842)
  assert.equal(body.lastCycle?.status, 'ok')
  assert.equal(body.lastCycle?.durationMs, 42_000)
  assert.equal(body.lastCycle?.alertsSent, 3)
  assert.equal(body.env.seatsAeroApiKey, true)
  assert.equal(body.env.smtpPassword, false)
})

test('stale rate-limit header from a previous UTC day is ignored', async () => {
  const db = openDb(':memory:')
  metaSet(db, 'rate_limit_remaining', '5')
  metaSet(db, 'rate_limit_seen_at', '2026-08-14T23:00:00Z')
  const app = makeApp(db, null)
  const body = (await (await app.request('/api/status')).json()) as StatusResponse
  assert.equal(body.quota.headerRemaining, null)
})

test('GET /api/cycles returns newest first with limit', async () => {
  const db = openDb(':memory:')
  for (let i = 0; i < 5; i++) {
    const id = startCycle(db, 'scheduled', `2026-08-15T0${i}:00:00Z`)
    finishCycle(db, id, {
      finishedAt: `2026-08-15T0${i}:01:00Z`,
      status: 'ok',
      callsUsed: i,
      recordsFetched: 0,
      onewaysFound: 0,
      roundtripsFound: 0,
      alertsSent: 0,
    })
  }
  const app = makeApp(db, null)
  const body = (await (await app.request('/api/cycles?limit=3')).json()) as CyclesResponse
  assert.equal(body.cycles.length, 3)
  assert.equal(body.cycles[0]?.startedAt, '2026-08-15T04:00:00Z')
})

test('POST /api/run starts a cycle; concurrent request gets 409', async () => {
  const db = openDb(':memory:')
  let release!: () => void
  const pending = new Promise<void>((r) => {
    release = r
  })
  let runs = 0
  const scheduler = new Scheduler({
    runner: async () => {
      runs++
      await pending
      return fakeOutcome()
    },
    getIntervalHours: () => 2,
    getLastCycleAt: () => undefined,
    now: () => NOW,
  })
  const app = makeApp(db, scheduler)

  const first = await app.request('/api/run', { method: 'POST' })
  assert.equal(first.status, 202)
  assert.equal(runs, 1)

  const second = await app.request('/api/run', { method: 'POST' })
  assert.equal(second.status, 409)
  const conflict = (await second.json()) as RunConflictResponse
  assert.equal(conflict.error, 'cycle_in_flight')
  assert.equal(conflict.trigger, 'manual')

  release()
  await scheduler.cycleInFlight() // allow the finally to run
  await new Promise((r) => setImmediate(r))
  scheduler.stop()
  const third = await app.request('/api/run', { method: 'POST' })
  assert.equal(third.status, 202)
  assert.equal(runs, 2)
  scheduler.stop()
})

test('scheduler computes drift-corrected next run from last cycle time', () => {
  const scheduler = new Scheduler({
    runner: async () => fakeOutcome(),
    getIntervalHours: () => 2,
    getLastCycleAt: () => '2026-08-15T11:00:00Z',
    now: () => NOW,
  })
  assert.equal(scheduler.nextRunAt(), '2026-08-15T13:00:00.000Z')

  const overdue = new Scheduler({
    runner: async () => fakeOutcome(),
    getIntervalHours: () => 2,
    getLastCycleAt: () => '2026-08-15T08:00:00Z',
    now: () => NOW,
  })
  // Overdue → next run is now, not in the past.
  assert.equal(overdue.nextRunAt(), NOW.toISOString())
})
