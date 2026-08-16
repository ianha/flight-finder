import type { GlobalOpts } from '../cli.js'
import { loadConfig, readEnvSecrets } from '../config.js'
import { openDb } from '../db.js'
import { SeatsAeroClient } from '../seatsAero.js'
import { runCycle } from '../poll.js'
import { EmailNotifier, renderText, subjectFor } from '../notify/email.js'
import { nullNotifier, type Notifier } from '../notify/notifier.js'
import { ATTRIBUTION, ATTRIBUTION_URL } from '../shared/constants.js'
import { log } from '../log.js'

export async function searchCommand(
  g: GlobalOpts,
  opts: { dryRun: boolean; json: boolean },
): Promise<void> {
  const cfg = loadConfig(g.config)
  const secrets = readEnvSecrets()
  if (!secrets.seatsAeroApiKey) {
    throw new Error('SEATS_AERO_API_KEY is not set — copy .env.example to .env and fill it in')
  }
  let notifier: Notifier = nullNotifier
  if (!opts.dryRun) {
    if (!secrets.smtpPassword) {
      throw new Error('SMTP_PASSWORD is not set — copy .env.example to .env and fill it in')
    }
    notifier = new EmailNotifier(cfg, secrets.smtpPassword)
  }

  const db = openDb(cfg.db.path)
  const apiKey = secrets.seatsAeroApiKey
  const outcome = await runCycle(
    {
      db,
      cfg,
      clientFactory: (onCall) =>
        new SeatsAeroClient({ baseUrl: cfg.api.baseUrl, apiKey, onCall }),
      notifier,
    },
    { trigger: 'manual', dryRun: opts.dryRun },
  )

  if (opts.json) {
    console.log(JSON.stringify(outcome, null, 2))
  } else if (opts.dryRun) {
    if (outcome.digest) {
      console.log(`\nSubject: ${subjectFor(outcome.digest)}\n`)
      console.log(renderText(outcome.digest))
    } else {
      console.log('No new or improved deals this cycle.')
      console.log(`${ATTRIBUTION} (${ATTRIBUTION_URL})`)
    }
  } else {
    log.info(
      outcome.alertsSent > 0
        ? `alert email sent (${outcome.alertsSent} deals)`
        : 'no new or improved deals — no email sent',
    )
    console.log(`${ATTRIBUTION} (${ATTRIBUTION_URL})`)
  }

  if (outcome.status === 'error') process.exitCode = 1
}
