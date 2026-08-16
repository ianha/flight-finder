import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono } from 'hono'
import { log } from '../log.js'

/**
 * Serve the built frontend (web/dist) when present. Runs from either src/ (tsx)
 * or dist/ (compiled) — web/dist sits two levels above this file's directory.
 */
export function registerStatic(app: Hono): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const webDist = join(here, '..', '..', 'web', 'dist')
  if (!existsSync(webDist)) {
    log.debug('web/dist not found — UI not built yet, API-only mode')
    app.get('/', (c) =>
      c.text('flight-deal-finder API is running. Build the UI with `npm run build` to serve it here.'),
    )
    return
  }
  // Paths are resolved relative to CWD by @hono/node-server; hand it a relative root.
  const rel = relativeToCwd(webDist)
  app.use('/*', serveStatic({ root: rel }))
}

function relativeToCwd(abs: string): string {
  const cwd = process.cwd()
  if (abs.startsWith(cwd)) {
    const rel = abs.slice(cwd.length).replace(/^\/+/, '')
    return rel === '' ? '.' : `./${rel}`
  }
  return abs
}
