import type { GlobalOpts } from '../cli.js'
import { loadConfig, readEnvSecrets, twilioCredsPresent, deriveWindow } from '../config.js'
import { openDb } from '../db.js'
import { SmsNotifier, smsConfigured, renderSms } from '../notify/sms.js'
import { getAvailabilitySeenAt } from '../db.js'
import { scopeFor, isInScope } from '../deals/scope.js'
import { detectOneways } from '../deals/oneway.js'
import { detectRoundtrips } from '../deals/roundtrip.js'
import { filterForAlert } from '../deals/dedupe.js'
import type { DealDigest, DigestOneway, DigestRoundtrip } from '../notify/notifier.js'
import type { OneWayDeal, RoundtripDeal } from '../types.js'
import { ESTIMATE_SOURCE_KEY } from '../shared/constants.js'
import { log } from '../log.js'

function cannedDigest(): DealDigest {
  const nowIso = new Date().toISOString()
  const aeroplan: OneWayDeal = {
    kind: 'oneway',
    key: 'OW|aeroplan|YYZ|HND|2027-03-17',
    availabilityId: 'test-1',
    source: 'aeroplan',
    program: 'Aeroplan',
    origin: 'YYZ',
    destination: 'HND',
    date: '2027-03-17',
    direction: 'outbound',
    points: 62_500,
    isEstimate: false,
    direct: true,
    seats: 2,
    airlines: 'NH',
    apiUpdatedAt: nowIso,
  }
  const proxy: OneWayDeal = {
    kind: 'oneway',
    key: `OW|${ESTIMATE_SOURCE_KEY}|LAX|HND|2027-04-02`,
    availabilityId: 'test-2',
    source: 'american',
    program: 'BA/Qatar Avios (estimated)',
    origin: 'LAX',
    destination: 'HND',
    date: '2027-04-02',
    direction: 'outbound',
    points: 77_250,
    isEstimate: true,
    estimate: { qatarAvios: 77_250, baAvios: 85_000, best: 77_250, lastVerified: '2026-08-15' },
    direct: true,
    seats: 1,
    airlines: 'JL',
    apiUpdatedAt: nowIso,
  }
  return {
    generatedAt: nowIso,
    oneways: [
      { deal: aeroplan, reason: 'new', detail: null },
      { deal: proxy, reason: 'new', detail: null },
    ],
    roundtrips: [],
    onewayOverflowCount: 0,
    roundtripOverflowCount: 0,
    roundtripOverflowFromPoints: null,
    notes: ['test message from deal-finder test-sms - not a real deal'],
  }
}

function buildDigestFromConfig(db: ReturnType<typeof openDb>, cfg: ReturnType<typeof loadConfig>, now: Date): DealDigest | null {
  const nowIso = now.toISOString()
  const window = deriveWindow(cfg, now)
  const scope = scopeFor(cfg.search, window)

  // Get the most recent availability (simulating what the poller would use).
  // If the DB is empty, bail out gracefully.
  const availability = getAvailabilitySeenAt(db, nowIso)
  if (availability.length === 0) {
    return null
  }

  const fresh = availability.filter((r) => isInScope(r, scope))
  if (fresh.length === 0) {
    return null
  }

  const oneways = detectOneways(fresh, cfg)
  const roundtrips = detectRoundtrips(fresh, cfg)

  const { toAlert } = filterForAlert(db, [...oneways, ...roundtrips], cfg, now)

  if (toAlert.length === 0) {
    return null
  }

  const digestOneways: DigestOneway[] = toAlert
    .filter((a) => a.deal.kind === 'oneway')
    .slice(0, cfg.alerts.maxOnewaysPerAlert)
    .map((a) => ({ deal: a.deal as OneWayDeal, reason: a.reason, detail: null }))

  const digestRoundtrips: DigestRoundtrip[] = toAlert
    .filter((a) => a.deal.kind === 'roundtrip')
    .slice(0, cfg.alerts.maxRoundtripsPerAlert)
    .map((a) => ({ deal: a.deal as RoundtripDeal, reason: a.reason }))

  return {
    generatedAt: nowIso,
    oneways: digestOneways,
    roundtrips: digestRoundtrips,
    onewayOverflowCount: Math.max(
      toAlert.filter((a) => a.deal.kind === 'oneway').length - cfg.alerts.maxOnewaysPerAlert,
      0,
    ),
    roundtripOverflowCount: Math.max(
      toAlert.filter((a) => a.deal.kind === 'roundtrip').length - cfg.alerts.maxRoundtripsPerAlert,
      0,
    ),
    roundtripOverflowFromPoints: null,
    notes: [],
  }
}

export async function testSmsCommand(g: GlobalOpts): Promise<void> {
  const cfg = loadConfig(g.config)
  const secrets = readEnvSecrets()
  if (!twilioCredsPresent(secrets)) {
    throw new Error(
      'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set — copy .env.example to .env and fill them in',
    )
  }
  if (!smsConfigured(cfg)) {
    throw new Error('sms.to / sms.from are not configured — set them in config.yaml (E.164, e.g. +14165551234)')
  }

  let digest: DealDigest
  const now = new Date()

  try {
    const db = openDb(cfg.db.path)
    const configDrivenDigest = buildDigestFromConfig(db, cfg, now)
    if (configDrivenDigest) {
      digest = configDrivenDigest
      log.info('sending test SMS with real config-scoped deals from your database...')
    } else {
      digest = cannedDigest()
      log.info('no config-scoped deals found in database; sending canned test SMS instead')
    }
  } catch (err) {
    log.warn(`database read failed: ${err instanceof Error ? err.message : String(err)}; sending canned test SMS`)
    digest = cannedDigest()
  }

  log.info(`sending test SMS:\n---\n${renderSms(digest, cfg.sms.maxSegments, cfg.search.destinationLabel)}\n---`)
  const notifier = new SmsNotifier(cfg, {
    accountSid: secrets.twilioAccountSid,
    authToken: secrets.twilioAuthToken,
  })
  await notifier.sendDigest(digest)
  log.info(`test SMS sent to ${cfg.sms.to.join(', ')} — check your phone`)
}
