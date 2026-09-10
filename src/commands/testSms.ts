import type { GlobalOpts } from '../cli.js'
import { loadConfig, readEnvSecrets, twilioCredsPresent } from '../config.js'
import { SmsNotifier, smsConfigured, renderSms } from '../notify/sms.js'
import type { DealDigest } from '../notify/notifier.js'
import type { OneWayDeal } from '../types.js'
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
    key: 'OW|avios-est|LAX|HND|2027-04-02',
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
  const digest = cannedDigest()
  log.info(`sending test SMS:\n---\n${renderSms(digest, cfg.sms.maxSegments, cfg.search.destinationLabel)}\n---`)
  const notifier = new SmsNotifier(cfg, {
    accountSid: secrets.twilioAccountSid,
    authToken: secrets.twilioAuthToken,
  })
  await notifier.sendDigest(digest)
  log.info(`test SMS sent to ${cfg.sms.to.join(', ')} — check your phone`)
}
