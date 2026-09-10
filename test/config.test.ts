import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, deriveWindow, ConfigError } from '../src/config.js'

test('empty config yields full defaults', () => {
  const cfg = parseConfig({})
  assert.equal(cfg.thresholds.onewayMaxPoints, 90_000)
  assert.equal(cfg.thresholds.roundtripMaxPoints, 180_000)
  assert.deepEqual(cfg.search.origins, ['YYZ', 'ORD', 'YVR', 'LAX'])
  assert.deepEqual(cfg.search.destinations, ['NRT', 'HND'])
  assert.equal(cfg.search.destinationLabel, 'Tokyo')
  assert.equal(cfg.search.window.endOffsetDays, 355)
  assert.equal(cfg.search.proxySources.enabled, true)
  assert.equal(cfg.roundtrip.minStayNights, 3)
  assert.equal(cfg.alerts.realertDropPct, 15)
  assert.equal(cfg.poll.intervalHours, 2)
  assert.deepEqual(cfg.sms.to, [])
  assert.equal(cfg.sms.from, '')
  assert.equal(cfg.sms.maxSegments, 3)
  assert.equal(cfg.db.path, './data/deals.db')
  assert.equal(cfg.server.port, 8787)
})

test('partial config merges with defaults', () => {
  const cfg = parseConfig({ thresholds: { onewayMaxPoints: 75_000 }, search: { origins: ['YYZ'] } })
  assert.equal(cfg.thresholds.onewayMaxPoints, 75_000)
  assert.equal(cfg.thresholds.roundtripMaxPoints, 180_000)
  assert.deepEqual(cfg.search.origins, ['YYZ'])
  assert.deepEqual(cfg.search.destinations, ['NRT', 'HND'])
  assert.equal(cfg.search.destinationLabel, 'Tokyo')
})

test('endOffsetDays above 355 clamps to 355', () => {
  const cfg = parseConfig({ search: { window: { endOffsetDays: 500 } } })
  assert.equal(cfg.search.window.endOffsetDays, 355)
})

test('invalid airport code rejected with dotted issue path', () => {
  assert.throws(
    () => parseConfig({ search: { origins: ['Toronto'] } }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.ok(err.issues.some((i) => i.path === 'search.origins.0'))
      return true
    },
  )
})

test('maxStayNights below minStayNights rejected', () => {
  assert.throws(
    () => parseConfig({ roundtrip: { minStayNights: 10, maxStayNights: 5 } }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.ok(err.issues.some((i) => i.path === 'roundtrip.maxStayNights'))
      return true
    },
  )
})

test('deriveWindow formats local dates and respects offsets', () => {
  const cfg = parseConfig({ search: { window: { startOffsetDays: 10, endOffsetDays: 20 } } })
  const w = deriveWindow(cfg, new Date(2026, 0, 1))
  assert.equal(w.startDate, '2026-01-11')
  assert.equal(w.endDate, '2026-01-21')
})

test('deriveWindow caps end date at 355 days out', () => {
  const cfg = parseConfig({})
  const w = deriveWindow(cfg, new Date(2026, 0, 1))
  assert.equal(w.startDate, '2026-01-01')
  assert.equal(w.endDate, '2026-12-22') // 2026-01-01 + 355 days
})
