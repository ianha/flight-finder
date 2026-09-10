import type { GlobalOpts } from '../cli.js'
import { loadConfig, readEnvSecrets, twilioCredsPresent } from '../config.js'
import { openDb } from '../db.js'
import { SeatsAeroClient } from '../seatsAero.js'
import { runCycle } from '../poll.js'
import { renderText, subjectFor } from '../notify/render.js'
import { SmsNotifier, smsConfigured } from '../notify/sms.js'
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
    if (!twilioCredsPresent(secrets)) {
      throw new Error(
        'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set — copy .env.example to .env and fill them in',
      )
    }
    if (!smsConfigured(cfg)) {
      throw new Error('sms.to / sms.from are not configured — set them in config.yaml (E.164, e.g. +14165551234)')
    }
    notifier = new SmsNotifier(cfg, {
      accountSid: secrets.twilioAccountSid,
      authToken: secrets.twilioAuthToken,
    })
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
      console.log(`\nSubject: ${subjectFor(outcome.digest, cfg.search.destinationLabel)}\n`)
      console.log(renderText(outcome.digest))
    } else {
      console.log('No new or improved deals this cycle.')
      console.log(`${ATTRIBUTION} (${ATTRIBUTION_URL})`)
    }
  } else {
    log.info(
      outcome.alertsSent > 0
        ? `alert SMS sent (${outcome.alertsSent} deals)`
        : 'no new or improved deals — no SMS sent',
    )
    console.log(`${ATTRIBUTION} (${ATTRIBUTION_URL})`)
  }

  if (outcome.status === 'error') process.exitCode = 1
}
