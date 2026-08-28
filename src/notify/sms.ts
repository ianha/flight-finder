// SMS notifier: compact GSM-7-safe digest texts sent through the Twilio REST
// API with plain fetch (no SDK dependency).
import type { AppConfig } from '../shared/configSchema.js'
import type { DealLeg } from '../types.js'
import { log } from '../log.js'
import { fmtPtsShort, reasonLabel } from './render.js'
import type { DealDigest, Notifier } from './notifier.js'

// Concatenated GSM-7 SMS carries 153 chars per segment (160 for a single one).
const SINGLE_SEGMENT_CHARS = 160
const CONCAT_SEGMENT_CHARS = 153

/** True when the config has everything needed to actually send a text. */
export function smsConfigured(cfg: AppConfig): boolean {
  return cfg.sms.to.length > 0 && cfg.sms.from !== ''
}

export function maxSmsChars(maxSegments: number): number {
  return maxSegments <= 1 ? SINGLE_SEGMENT_CHARS : maxSegments * CONCAT_SEGMENT_CHARS
}

// Keep the body pure ASCII: one non-GSM character silently flips the whole
// message to UCS-2 and cuts capacity from 153 to 67 chars per segment.
function asciiSafe(s: string): string {
  return s
    .replace(/→/g, '-')
    .replace(/·/g, ' ')
    .replace(/—/g, '-')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e\n]/g, '?')
}

function shortDate(date: string): string {
  // 2027-03-17 -> 3/17/27 (window spans a year, so the year digit matters).
  const [y, m, d] = date.split('-')
  return `${Number(m)}/${Number(d)}/${(y ?? '').slice(2)}`
}

function shortReason(d: { reason: string; prevBestPoints?: number }): string {
  if (d.reason === 'improved' && d.prevBestPoints) return `DROP was ${fmtPtsShort(d.prevBestPoints)}`
  if (d.reason === 'returned') return 'BACK'
  return 'NEW'
}

function legLine(leg: DealLeg): string {
  const est = leg.isEstimate ? '~' : ''
  const bits = [
    `${leg.origin}-${leg.destination}`,
    shortDate(leg.date),
    `${est}${fmtPtsShort(leg.points)}`,
    leg.isEstimate ? 'Avios est' : leg.program,
  ]
  if (leg.direct) bits.push('NS')
  if (leg.seats !== null && leg.seats > 0) bits.push(`x${leg.seats}`)
  return bits.join(' ')
}

/**
 * Compact SMS body for a digest. Deal lines are added until the character
 * budget runs out; everything else is summarized as "+N more". The attribution
 * line always fits (seats.aero ToS requires visible attribution).
 */
export function renderSms(digest: DealDigest, maxSegments: number): string {
  const budget = maxSmsChars(maxSegments)
  const header: string[] = []
  if (digest.oneways.length > 0) {
    const min = Math.min(...digest.oneways.map((d) => d.deal.points))
    header.push(`${digest.oneways.length + digest.onewayOverflowCount} OW fr ${fmtPtsShort(min)}`)
  }
  if (digest.roundtrips.length > 0) {
    const min = Math.min(...digest.roundtrips.map((d) => d.deal.totalPoints))
    header.push(`${digest.roundtrips.length + digest.roundtripOverflowCount} RT fr ${fmtPtsShort(min)}`)
  }
  const lines: string[] = [`Tokyo J deals: ${header.join(', ') || 'update'}`]

  const footerLines = (extraCount: number): string[] => {
    const out: string[] = []
    if (extraCount > 0) out.push(`+${extraCount} more: see console`)
    if (digest.notes.length > 0) out.push('notes: see console')
    out.push('verify before booking. data: seats.aero')
    return out
  }

  const dealLines: string[] = []
  for (const d of digest.oneways) {
    dealLines.push(asciiSafe(`${legLine(d.deal)} ${shortReason(d)}`))
  }
  for (const d of digest.roundtrips) {
    const rt = d.deal
    dealLines.push(
      asciiSafe(
        `RT ${rt.isEstimate ? '~' : ''}${fmtPtsShort(rt.totalPoints)} ${rt.outbound.origin}-${rt.outbound.destination} ` +
          `${shortDate(rt.outbound.date)}>${shortDate(rt.inbound.date)} ${rt.stayNights}n ${shortReason(d)}`,
      ),
    )
  }
  const overflowBeyondCaps = digest.onewayOverflowCount + digest.roundtripOverflowCount

  // Fit as many deal lines as the budget allows, keeping room for the footer.
  let included = 0
  for (; included < dealLines.length; included++) {
    const candidate = [
      ...lines,
      ...dealLines.slice(0, included + 1),
      ...footerLines(overflowBeyondCaps + (dealLines.length - included - 1)),
    ].join('\n')
    if (candidate.length > budget) break
  }
  return [
    ...lines,
    ...dealLines.slice(0, included),
    ...footerLines(overflowBeyondCaps + (dealLines.length - included)),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Twilio transport
// ---------------------------------------------------------------------------

export interface TwilioCreds {
  accountSid: string
  authToken: string
}

/** Sends one message; throws on failure. Injectable for tests. */
export type SmsTransport = (to: string, from: string, body: string) => Promise<void>

export function twilioTransport(creds: TwilioCreds, fetchImpl: typeof fetch = fetch): SmsTransport {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`
  const auth = `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`
  return async (to, from, body) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    })
    if (!res.ok) {
      let detail = ''
      try {
        const payload = (await res.json()) as { message?: string; code?: number }
        detail = payload.message ? ` — ${payload.message} (code ${payload.code ?? '?'})` : ''
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`Twilio send to ${to} failed: HTTP ${res.status}${detail}`)
    }
  }
}

export class SmsNotifier implements Notifier {
  private readonly getCfg: () => AppConfig
  private readonly transport: SmsTransport
  private readonly retryDelayMs: number

  /**
   * Accepts a config getter so web-console edits (to/from numbers) apply to the
   * very next send without a restart.
   */
  constructor(
    cfg: AppConfig | (() => AppConfig),
    creds: TwilioCreds,
    opts: { retryDelayMs?: number; transport?: SmsTransport } = {},
  ) {
    this.getCfg = typeof cfg === 'function' ? cfg : () => cfg
    this.retryDelayMs = opts.retryDelayMs ?? 30_000
    this.transport = opts.transport ?? twilioTransport(creds)
  }

  private async sendWithRetry(body: string): Promise<void> {
    const cfg = this.getCfg()
    if (!smsConfigured(cfg)) {
      throw new Error('SMS is not configured — set sms.to and sms.from in config.yaml')
    }
    // All recipients, each with its own retry budget; the first hard failure
    // aborts (poll treats a throw as send-failed and retries next cycle).
    for (const to of cfg.sms.to) {
      let lastErr: unknown
      let sent = false
      for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
        try {
          await this.transport(to, cfg.sms.from, body)
          sent = true
        } catch (err) {
          lastErr = err
          log.warn(`SMS send failed (attempt ${attempt}/3): ${(err as Error).message}`)
          if (attempt < 3) await new Promise((r) => setTimeout(r, this.retryDelayMs))
        }
      }
      if (!sent) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
    }
  }

  async sendDigest(digest: DealDigest): Promise<void> {
    await this.sendWithRetry(renderSms(digest, this.getCfg().sms.maxSegments))
  }

  async sendFailureNotice(message: string): Promise<void> {
    await this.sendWithRetry(
      asciiSafe(`Deal Finder is failing: ${message} Check deal-finder status / the console. data: seats.aero`),
    )
  }
}
