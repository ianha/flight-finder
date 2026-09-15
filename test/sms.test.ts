import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from '../src/config.js'
import { renderSms, maxSmsChars, smsConfigured, twilioTransport, SmsNotifier } from '../src/notify/sms.js'
import type { DealDigest, DigestOneway, DigestRoundtrip } from '../src/notify/notifier.js'
import type { OneWayDeal, RoundtripDeal, DealLeg } from '../src/types.js'

function leg(i: number, over: Partial<DealLeg> = {}): OneWayDeal {
  const base: OneWayDeal = {
    kind: 'oneway',
    key: `OW|aeroplan|YYZ|NRT|2027-03-${String((i % 27) + 1).padStart(2, '0')}`,
    availabilityId: `a${i}`,
    source: 'aeroplan',
    program: 'Aeroplan',
    origin: 'YYZ',
    destination: 'NRT',
    date: `2027-03-${String((i % 27) + 1).padStart(2, '0')}`,
    direction: 'outbound',
    points: 62_500 + i * 1000,
    isEstimate: false,
    direct: true,
    seats: 2,
    airlines: 'NH',
    apiUpdatedAt: '2026-08-16T00:00:00Z',
  }
  return { ...base, ...over } as OneWayDeal
}

function digestWith(oneways: DigestOneway[], roundtrips: DigestRoundtrip[] = [], notes: string[] = []): DealDigest {
  return {
    generatedAt: '2026-08-16T00:00:00Z',
    oneways,
    roundtrips,
    onewayOverflowCount: 0,
    roundtripOverflowCount: 0,
    roundtripOverflowFromPoints: null,
    notes,
  }
}

test('renderSms is ASCII-only, fits the segment budget, and always attributes seats.aero', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ deal: leg(i), reason: 'new' as const, detail: null }))
  for (const maxSegments of [1, 2, 3]) {
    const body = renderSms(digestWith(many), maxSegments)
    assert.ok(body.length <= maxSmsChars(maxSegments), `over budget at ${maxSegments} segments: ${body.length}`)
    assert.match(body, /data: seats\.aero/)
    assert.ok(!/[^\x20-\x7e\n]/.test(body), `non-ASCII chars in: ${body}`)
  }
  // Tight budget: the header + footer still communicate the counts.
  const tiny = renderSms(digestWith(many), 1)
  assert.match(tiny, /20 OW fr 62\.5k/)
  assert.match(tiny, /\+\d+ more: see console/)
})

test('renderSms includes deal lines, reasons, roundtrips, and estimate markers', () => {
  const ow: DigestOneway = { deal: leg(0), reason: 'improved', prevBestPoints: 75_000, detail: null }
  const est: DigestOneway = {
    deal: leg(1, {
      isEstimate: true,
      points: 77_250,
      program: 'BA/Qatar Avios (estimated)',
      origin: 'LAX',
      destination: 'HND',
    }),
    reason: 'new',
    detail: null,
  }
  const rt: DigestRoundtrip = {
    deal: {
      kind: 'roundtrip',
      key: 'RT|YYZ|2027-03-01|YYZ|2027-03-12',
      outbound: leg(2, { date: '2027-03-01' }),
      inbound: { ...leg(3, { date: '2027-03-12' }), origin: 'NRT', destination: 'YYZ', direction: 'return' },
      totalPoints: 148_000,
      stayNights: 11,
      isEstimate: false,
    } as RoundtripDeal,
    reason: 'new',
  }
  const body = renderSms(digestWith([ow, est], [rt], ['partial data']), 3)
  assert.match(body, /YYZ-NRT Mar\/01\/27 62\.5k Aeroplan NS x2 DROP was 75k/)
  assert.match(body, /LAX-HND Mar\/02\/27 ~77\.3k Avios est NS x2 NEW/)
  assert.match(body, /RT 148k YYZ-NRT Mar\/01\/27>Mar\/12\/27 11n NEW/)
  assert.match(body, /notes: see console/)
})

test('smsConfigured requires both to and from', () => {
  assert.equal(smsConfigured(parseConfig({})), false)
  assert.equal(smsConfigured(parseConfig({ sms: { to: ['+14165551234'] } })), false)
  assert.equal(smsConfigured(parseConfig({ sms: { from: '+16475550123' } })), false)
  assert.equal(
    smsConfigured(parseConfig({ sms: { to: ['+14165551234'], from: '+16475550123' } })),
    true,
  )
})

test('config schema rejects non-E.164 phone numbers', () => {
  assert.throws(() => parseConfig({ sms: { to: ['4165551234'] } }))
  assert.throws(() => parseConfig({ sms: { from: '+0123' } }))
})

test('twilioTransport posts form-encoded payload with basic auth and surfaces API errors', async () => {
  const seen: { url: string; init: RequestInit }[] = []
  const okFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init! })
    return new Response(JSON.stringify({ sid: 'SM123' }), { status: 201 })
  }) as typeof fetch
  const send = twilioTransport({ accountSid: 'AC123', authToken: 'secret' }, okFetch)
  await send('+14165551234', '+16475550123', 'hello deals')

  assert.equal(seen[0]?.url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json')
  const headers = seen[0]?.init.headers as Record<string, string>
  assert.equal(headers.Authorization, `Basic ${Buffer.from('AC123:secret').toString('base64')}`)
  const params = new URLSearchParams(String(seen[0]?.init.body))
  assert.equal(params.get('To'), '+14165551234')
  assert.equal(params.get('From'), '+16475550123')
  assert.equal(params.get('Body'), 'hello deals')

  const errFetch = (async () =>
    new Response(JSON.stringify({ message: 'Invalid To number', code: 21211 }), { status: 400 })) as typeof fetch
  const failing = twilioTransport({ accountSid: 'AC123', authToken: 'secret' }, errFetch)
  await assert.rejects(failing('+1', '+2', 'x'), /HTTP 400 — Invalid To number \(code 21211\)/)
})

test('SmsNotifier sends to every recipient and refuses when unconfigured', async () => {
  const cfg = parseConfig({ sms: { to: ['+14165551234', '+16045557890'], from: '+16475550123' } })
  const sent: string[] = []
  const notifier = new SmsNotifier(cfg, { accountSid: 'AC', authToken: 't' }, {
    retryDelayMs: 1,
    transport: async (to) => {
      sent.push(to)
    },
  })
  await notifier.sendDigest(digestWith([{ deal: leg(0), reason: 'new', detail: null }]))
  assert.deepEqual(sent, ['+14165551234', '+16045557890'])

  const unconfigured = new SmsNotifier(parseConfig({}), { accountSid: 'AC', authToken: 't' }, {
    retryDelayMs: 1,
    transport: async () => {},
  })
  await assert.rejects(
    unconfigured.sendDigest(digestWith([{ deal: leg(0), reason: 'new', detail: null }])),
    /not configured/,
  )
})

test('renderSms header uses the configured destination label, ASCII-sanitized', () => {
  const one = [{ deal: leg(0), reason: 'new' as const, detail: null }]
  assert.match(renderSms(digestWith(one), 3), /^Tokyo J deals: /)
  assert.match(renderSms(digestWith(one), 3, 'Osaka'), /^Osaka J deals: /)
  // A label with non-GSM-7 characters must not break the ASCII-only guarantee.
  const accented = renderSms(digestWith(one), 3, 'São Paulo')
  assert.ok(!/[^\x20-\x7e\n]/.test(accented), `non-ASCII chars in: ${accented}`)
})
