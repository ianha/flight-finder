import type { GlobalOpts } from '../cli.js'
import { loadConfig, readEnvSecrets } from '../config.js'
import { EmailNotifier } from '../notify/email.js'
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
    key: 'OW|american|LAX|HND|2027-04-02',
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
    notes: ['This is a test email from `deal-finder test-email` — not a real deal.'],
  }
}

export async function testEmailCommand(g: GlobalOpts): Promise<void> {
  const cfg = loadConfig(g.config)
  const secrets = readEnvSecrets()
  if (!secrets.smtpPassword) {
    throw new Error('SMTP_PASSWORD is not set — copy .env.example to .env and fill it in')
  }
  const notifier = new EmailNotifier(cfg, secrets.smtpPassword)
  await notifier.sendDigest(cannedDigest())
  log.info(`test digest sent to ${cfg.email.to.join(', ')} — check the inbox`)
}
