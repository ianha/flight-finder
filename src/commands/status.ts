import type { GlobalOpts } from '../cli.js'
import { loadConfig, readEnvSecrets } from '../config.js'
import { openDb, getRecentAlerts } from '../db.js'
import { buildStatus, recentCycles } from '../server/queries.js'
import { ATTRIBUTION, ATTRIBUTION_URL } from '../shared/constants.js'

export async function statusCommand(g: GlobalOpts): Promise<void> {
  const cfg = loadConfig(g.config)
  const secrets = readEnvSecrets()
  const db = openDb(cfg.db.path)
  const status = buildStatus(
    db,
    cfg,
    null,
    {
      seatsAeroApiKey: Boolean(secrets.seatsAeroApiKey),
      smtpPassword: Boolean(secrets.smtpPassword),
    },
    new Date(),
  )

  console.log('— quota —')
  console.log(
    `  ${status.quota.used}/${status.quota.budget} calls used today (UTC ${status.quota.dayUtc}); ` +
      `reserve ${status.quota.reserve}; API-reported remaining: ${status.quota.headerRemaining ?? 'n/a'}`,
  )
  console.log('— last cycle —')
  if (status.lastCycle) {
    console.log(
      `  ${status.lastCycle.at} [${status.lastCycle.trigger}] ${status.lastCycle.status}` +
        `${status.lastCycle.durationMs !== null ? ` in ${Math.round(status.lastCycle.durationMs / 1000)}s` : ''}` +
        `, ${status.lastCycle.alertsSent} deals alerted` +
        `${status.lastCycle.error ? ` — ${status.lastCycle.error}` : ''}`,
    )
  } else {
    console.log('  no cycles recorded yet')
  }
  console.log('— data —')
  console.log(
    `  ${status.db.availabilityRows} availability rows in ${status.db.path}; ` +
      `freshest record updated ${status.db.newestApiUpdatedAt ?? 'never'}`,
  )
  console.log('— secrets —')
  console.log(
    `  SEATS_AERO_API_KEY ${status.env.seatsAeroApiKey ? '✓' : '✗'} · SMTP_PASSWORD ${status.env.smtpPassword ? '✓' : '✗'}`,
  )

  const cycles = recentCycles(db, 5)
  if (cycles.length > 0) {
    console.log('— recent cycles —')
    for (const c of cycles) {
      console.log(
        `  #${c.id} ${c.startedAt} [${c.trigger}] ${c.status} calls=${c.callsUsed} records=${c.recordsFetched} ` +
          `deals=${c.onewaysFound}/${c.roundtripsFound} alerted=${c.alertsSent}`,
      )
    }
  }

  const alerts = getRecentAlerts(db, 10)
  if (alerts.length > 0) {
    console.log('— recent alerts —')
    for (const a of alerts) {
      console.log(
        `  ${a.last_alerted_at} [${a.kind}] ${a.deal_key} ${a.last_points.toLocaleString('en-US')} pts` +
          `${a.is_estimate ? ' (est.)' : ''} ×${a.alert_count}`,
      )
    }
  }

  console.log(`\n${ATTRIBUTION} (${ATTRIBUTION_URL})`)
}
