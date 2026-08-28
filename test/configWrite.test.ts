import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { parseConfig, writeConfig, loadConfig, ConfigError } from '../src/config.js'
import { buildApp, type ConfigFacade } from '../src/server/app.js'
import type { ConfigResponse, ConfigPutResponse, ApiError } from '../src/shared/apiTypes.js'

const COMMENTED_CONFIG = `# my hand-written config
thresholds:
  # strict less-than, tuned by hand
  onewayMaxPoints: 90000
  roundtripMaxPoints: 180000

search:
  # my home airports
  origins: [YYZ, ORD, YVR, LAX]
`

function tempConfigPath(content = COMMENTED_CONFIG): string {
  const dir = mkdtempSync(join(tmpdir(), 'deal-finder-test-'))
  const path = join(dir, 'config.yaml')
  writeFileSync(path, content)
  return path
}

test('writeConfig preserves hand-written comments and applies changes', () => {
  const path = tempConfigPath()
  const cfg = parseConfig({
    ...({} as object),
    thresholds: { onewayMaxPoints: 80_000, roundtripMaxPoints: 170_000 },
  })
  writeConfig(path, cfg)
  const text = readFileSync(path, 'utf8')
  assert.match(text, /# my hand-written config/)
  assert.match(text, /# strict less-than, tuned by hand/)
  assert.match(text, /# my home airports/)
  assert.match(text, /onewayMaxPoints: 80000/)
  // Round-trips through the loader.
  const reloaded = loadConfig(path)
  assert.equal(reloaded.thresholds.onewayMaxPoints, 80_000)
  assert.equal(reloaded.thresholds.roundtripMaxPoints, 170_000)
})

function appWithConfig(path: string) {
  const configRef = { current: loadConfig(path) }
  const configApi: ConfigFacade = {
    path,
    apply: (raw) => {
      const parsed = parseConfig(raw)
      writeConfig(path, parsed)
      configRef.current = parsed
      return parsed
    },
  }
  const app = buildApp({
    db: openDb(':memory:'),
    getConfig: () => configRef.current,
    scheduler: null,
    configApi,
    envPresence: () => ({ seatsAeroApiKey: true, twilioCreds: true }),
    version: 'test',
  })
  return { app, configRef }
}

test('GET /api/config returns effective config with read-only paths', async () => {
  const { app } = appWithConfig(tempConfigPath())
  const res = await app.request('/api/config')
  assert.equal(res.status, 200)
  const body = (await res.json()) as ConfigResponse
  assert.equal(body.config.thresholds.onewayMaxPoints, 90_000)
  assert.equal(body.config.poll.intervalHours, 2) // default materialized
  assert.deepEqual(body.meta.readOnlyPaths, ['db.path', 'server.port'])
})

test('PUT /api/config validates, persists with comments, and hot-swaps', async () => {
  const path = tempConfigPath()
  const { app, configRef } = appWithConfig(path)

  const current = (await (await app.request('/api/config')).json()) as ConfigResponse
  const edited = structuredClone(current.config)
  edited.thresholds.onewayMaxPoints = 85_000
  edited.poll.intervalHours = 4

  const res = await app.request('/api/config', {
    method: 'PUT',
    body: JSON.stringify(edited),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as ConfigPutResponse
  assert.equal(body.appliesAt, 'next-cycle')
  assert.equal(body.config.thresholds.onewayMaxPoints, 85_000)

  // Hot-swapped in memory and persisted with comments intact.
  assert.equal(configRef.current.thresholds.onewayMaxPoints, 85_000)
  assert.equal(configRef.current.poll.intervalHours, 4)
  const text = readFileSync(path, 'utf8')
  assert.match(text, /# my hand-written config/)
  assert.match(text, /onewayMaxPoints: 85000/)
})

test('PUT /api/config surfaces zod issues with dotted field paths', async () => {
  const { app } = appWithConfig(tempConfigPath())
  const current = (await (await app.request('/api/config')).json()) as ConfigResponse
  const edited = structuredClone(current.config) as Record<string, any>
  edited.thresholds.onewayMaxPoints = -5

  const res = await app.request('/api/config', {
    method: 'PUT',
    body: JSON.stringify(edited),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as ApiError
  assert.equal(body.error, 'validation')
  assert.ok(body.issues?.some((i) => i.path === 'thresholds.onewayMaxPoints'))
})

test('PUT /api/config rejects read-only field changes', async () => {
  const { app, configRef } = appWithConfig(tempConfigPath())
  const current = (await (await app.request('/api/config')).json()) as ConfigResponse
  const edited = structuredClone(current.config)
  edited.server.port = 9999

  const res = await app.request('/api/config', {
    method: 'PUT',
    body: JSON.stringify(edited),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as ApiError
  assert.ok(body.issues?.some((i) => i.path === 'server.port'))
  assert.equal(configRef.current.server.port, 8787) // unchanged
})

test('parseConfig throws ConfigError with issues for bad input', () => {
  assert.throws(
    () => parseConfig({ poll: { intervalHours: 100 } }),
    (err: unknown) => err instanceof ConfigError && err.issues.some((i) => i.path === 'poll.intervalHours'),
  )
})
