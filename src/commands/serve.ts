import { serve } from '@hono/node-server'
import type { GlobalOpts } from '../cli.js'
import { loadConfig, parseConfig, writeConfig, readEnvSecrets } from '../config.js'
import { openDb, metaGet } from '../db.js'
import { SeatsAeroClient } from '../seatsAero.js'
import { runCycle } from '../poll.js'
import { Scheduler } from '../scheduler.js'
import { buildApp } from '../server/app.js'
import { registerStatic } from '../server/static.js'
import { EmailNotifier } from '../notify/email.js'
import { nullNotifier, type Notifier } from '../notify/notifier.js'
import { ATTRIBUTION, ATTRIBUTION_URL, APP_VERSION } from '../shared/constants.js'
import { log } from '../log.js'

export async function serveCommand(g: GlobalOpts): Promise<void> {
  const secrets = readEnvSecrets()
  if (!secrets.seatsAeroApiKey) {
    throw new Error('SEATS_AERO_API_KEY is not set — copy .env.example to .env and fill it in')
  }
  const apiKey = secrets.seatsAeroApiKey

  // Mutable ref: PUT /api/config hot-swaps this without a restart (Phase 4).
  const configRef = { current: loadConfig(g.config), path: g.config }

  // Without SMTP, cycles run in dry-run mode: the UI still gets fresh data, but no
  // alert state is recorded — so nothing is silently "already alerted" once email
  // is configured later.
  const alertsEnabled = Boolean(secrets.smtpPassword)
  let notifier: Notifier = nullNotifier
  if (alertsEnabled) {
    // Config getter, not snapshot: web-console edits reach the next send.
    notifier = new EmailNotifier(() => configRef.current, secrets.smtpPassword!)
  } else {
    log.warn('SMTP_PASSWORD not set — deals will be detected and shown in the UI but NOT emailed')
  }

  const db = openDb(configRef.current.db.path)

  const scheduler = new Scheduler({
    runner: (trigger) =>
      runCycle(
        {
          db,
          cfg: configRef.current,
          clientFactory: (onCall) =>
            new SeatsAeroClient({ baseUrl: configRef.current.api.baseUrl, apiKey, onCall }),
          notifier,
        },
        { trigger, dryRun: !alertsEnabled },
      ),
    getIntervalHours: () => configRef.current.poll.intervalHours,
    getLastCycleAt: () => metaGet(db, 'last_cycle_at'),
  })

  const app = buildApp({
    db,
    getConfig: () => configRef.current,
    scheduler,
    configApi: {
      path: configRef.path,
      apply: (raw) => {
        const parsed = parseConfig(raw) // throws ConfigError with field issues
        writeConfig(configRef.path, parsed) // comment-preserving, atomic
        configRef.current = parsed // hot-swap: next cycle uses the new values
        log.info('configuration updated via web UI')
        return parsed
      },
    },
    envPresence: () => ({
      seatsAeroApiKey: Boolean(secrets.seatsAeroApiKey),
      smtpPassword: Boolean(secrets.smtpPassword),
    }),
    version: APP_VERSION,
  })
  registerStatic(app)

  const port = configRef.current.server.port
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
  scheduler.start()

  log.info(`deal-finder console: http://127.0.0.1:${port} (localhost only)`)
  log.info(`polling every ${configRef.current.poll.intervalHours}h — ${ATTRIBUTION} (${ATTRIBUTION_URL})`)

  const shutdown = () => {
    log.info('shutting down')
    scheduler.stop()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Keep the process alive indefinitely.
  await new Promise(() => {})
}
