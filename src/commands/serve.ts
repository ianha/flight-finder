import { serve } from '@hono/node-server'
import type { GlobalOpts } from '../cli.js'
import { loadConfig, parseConfig, writeConfig, readEnvSecrets, twilioCredsPresent } from '../config.js'
import { openDb, metaGet } from '../db.js'
import { SeatsAeroClient } from '../seatsAero.js'
import { runCycle } from '../poll.js'
import { Scheduler } from '../scheduler.js'
import { buildApp } from '../server/app.js'
import { registerStatic } from '../server/static.js'
import { SmsNotifier, smsConfigured } from '../notify/sms.js'
import { nullNotifier, type Notifier } from '../notify/notifier.js'
import { ATTRIBUTION, ATTRIBUTION_URL, APP_VERSION } from '../shared/constants.js'
import { log } from '../log.js'

export async function serveCommand(g: GlobalOpts): Promise<void> {
  const secrets = readEnvSecrets()
  // No API key is not fatal: the console still serves existing data and config
  // editing (UI-only mode) — only the polling scheduler stays off.
  const apiKey = secrets.seatsAeroApiKey
  if (!apiKey) {
    log.warn(
      'SEATS_AERO_API_KEY is not set — running the console WITHOUT polling. ' +
        'Copy .env.example to .env and fill it in, then restart to enable search cycles.',
    )
  }

  // Mutable ref: PUT /api/config hot-swaps this without a restart (Phase 4).
  const configRef = { current: loadConfig(g.config), path: g.config }

  // Without Twilio credentials + configured numbers, cycles run in dry-run mode:
  // the UI still gets fresh data, but no alert state is recorded — so nothing is
  // silently "already alerted" once SMS is configured later.
  const twilioOk = twilioCredsPresent(secrets)
  let notifier: Notifier = nullNotifier
  if (twilioOk) {
    // Config getter, not snapshot: web-console edits reach the next send.
    notifier = new SmsNotifier(() => configRef.current, {
      accountSid: secrets.twilioAccountSid,
      authToken: secrets.twilioAuthToken,
    })
  } else {
    log.warn(
      'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — deals will be detected and shown in the UI but NOT texted',
    )
  }
  // Re-evaluated per cycle: sms.to/from can be added through the web console later.
  const alertsEnabled = () => twilioOk && smsConfigured(configRef.current)
  if (twilioOk && !smsConfigured(configRef.current)) {
    log.warn('sms.to / sms.from not configured — set them in config.yaml or the web console to enable texts')
  }

  const db = openDb(configRef.current.db.path)

  const scheduler = apiKey
    ? new Scheduler({
        runner: (trigger) =>
          runCycle(
            {
              db,
              cfg: configRef.current,
              clientFactory: (onCall) =>
                new SeatsAeroClient({ baseUrl: configRef.current.api.baseUrl, apiKey, onCall }),
              notifier,
            },
            { trigger, dryRun: !alertsEnabled() },
          ),
        getIntervalHours: () => configRef.current.poll.intervalHours,
        getLastCycleAt: () => metaGet(db, 'last_cycle_at'),
      })
    : null

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
      twilioCreds: twilioOk,
    }),
    version: APP_VERSION,
  })
  registerStatic(app)

  const port = configRef.current.server.port
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
  scheduler?.start()

  log.info(`deal-finder console: http://127.0.0.1:${port} (localhost only)`)
  log.info(
    scheduler
      ? `polling every ${configRef.current.poll.intervalHours}h — ${ATTRIBUTION} (${ATTRIBUTION_URL})`
      : `polling disabled (no API key) — ${ATTRIBUTION} (${ATTRIBUTION_URL})`,
  )

  const shutdown = () => {
    log.info('shutting down')
    scheduler?.stop()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Keep the process alive indefinitely.
  await new Promise(() => {})
}
