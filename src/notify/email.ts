import { createTransport, type Transporter } from 'nodemailer'
import type { AppConfig } from '../shared/configSchema.js'
import { ATTRIBUTION, ATTRIBUTION_URL } from '../shared/constants.js'
import type { DealLeg } from '../types.js'
import { log } from '../log.js'
import type { DealDigest, DigestOneway, DigestRoundtrip, Notifier } from './notifier.js'

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function fmtPts(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtPtsShort(n: number): string {
  const k = n / 1000
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`
}

function fmtDate(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function ageOf(iso: string, nowIso: string): string {
  const ms = Date.parse(nowIso) - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age'
  const hours = ms / 3_600_000
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m old`
  if (hours < 48) return `${Math.round(hours)}h old`
  return `${Math.round(hours / 24)}d old`
}

function reasonLabel(d: { reason: string; prevBestPoints?: number }): string {
  if (d.reason === 'improved' && d.prevBestPoints) {
    return `IMPROVED (was ${fmtPts(d.prevBestPoints)})`
  }
  if (d.reason === 'returned') return 'BACK AGAIN'
  return 'NEW'
}

function legLine(leg: DealLeg, nowIso: string): string {
  const seats = leg.seats === null || leg.seats === 0 ? 'seats n/a' : `${leg.seats} seat${leg.seats === 1 ? '' : 's'}`
  const stops = leg.direct ? 'nonstop' : 'connections'
  return (
    `${leg.origin} → ${leg.destination} · ${fmtDate(leg.date)} · ${leg.program} · ` +
    `${fmtPts(leg.points)} pts + taxes · ${seats} · ${leg.airlines || '?'} (${stops}) · data ${ageOf(leg.apiUpdatedAt, nowIso)}`
  )
}

function estimateNote(leg: DealLeg): string | null {
  if (!leg.isEstimate || !leg.estimate) return null
  return (
    `ESTIMATED Avios pricing — verify before booking. Found via ${leg.source} (${leg.airlines}): ` +
    `Qatar Avios ~${fmtPts(leg.estimate.qatarAvios)}, BA ~${fmtPts(leg.estimate.baAvios)}. ` +
    `Surcharges not included (JAL metal ≈ US$370-440/sector as of mid-2026; AA metal none).`
  )
}

export function subjectFor(digest: DealDigest): string {
  const parts: string[] = []
  if (digest.oneways.length > 0) {
    const min = Math.min(...digest.oneways.map((d) => d.deal.points))
    parts.push(`${digest.oneways.length} one-way${digest.oneways.length === 1 ? '' : 's'} from ${fmtPtsShort(min)}`)
  }
  if (digest.roundtrips.length > 0) {
    const min = Math.min(...digest.roundtrips.map((d) => d.deal.totalPoints))
    parts.push(`${digest.roundtrips.length} roundtrip${digest.roundtrips.length === 1 ? '' : 's'} from ${fmtPtsShort(min)}`)
  }
  return `[Deal Finder] ${parts.join(', ') || 'update'} — Tokyo J`
}

// ---------------------------------------------------------------------------
// Text rendering (also used by --dry-run)
// ---------------------------------------------------------------------------

function renderOnewayText(d: DigestOneway, nowIso: string): string {
  const lines = [`  [${reasonLabel(d)}] ${legLine(d.deal, nowIso)}`]
  const est = estimateNote(d.deal)
  if (est) lines.push(`    ⚠ ${est}`)
  if (d.detail) {
    const bits: string[] = []
    if (d.detail.flightNumbers) bits.push(d.detail.flightNumbers)
    if (d.detail.departsAt) bits.push(`dep ${d.detail.departsAt}`)
    if (d.detail.totalTaxes !== null) {
      bits.push(`taxes ${d.detail.totalTaxes} ${d.detail.taxesCurrency ?? ''}`.trim())
    } else if (d.deal.source === 'qatar') {
      bits.push('taxes unavailable for this source')
    }
    const primary = d.detail.bookingLinks.find((b) => b.primary) ?? d.detail.bookingLinks[0]
    if (primary) bits.push(`book: ${primary.link}`)
    if (bits.length > 0) lines.push(`    ${bits.join(' · ')}`)
  }
  return lines.join('\n')
}

function renderRoundtripText(d: DigestRoundtrip, nowIso: string): string {
  const rt = d.deal
  const lines = [
    `  [${reasonLabel(d)}] TOTAL ${fmtPts(rt.totalPoints)} pts · ${rt.stayNights} nights${rt.isEstimate ? ' · ESTIMATE' : ''}`,
    `    out:  ${legLine(rt.outbound, nowIso)}`,
    `    back: ${legLine(rt.inbound, nowIso)}`,
  ]
  for (const leg of [rt.outbound, rt.inbound]) {
    const est = estimateNote(leg)
    if (est) lines.push(`    ⚠ ${est}`)
  }
  return lines.join('\n')
}

export function renderText(digest: DealDigest): string {
  const out: string[] = []
  if (digest.oneways.length > 0) {
    out.push(`One-way deals (under threshold):`)
    for (const d of digest.oneways) out.push(renderOnewayText(d, digest.generatedAt))
    if (digest.onewayOverflowCount > 0) {
      out.push(`  … plus ${digest.onewayOverflowCount} more qualifying one-ways`)
    }
    out.push('')
  }
  if (digest.roundtrips.length > 0) {
    out.push(`Roundtrip pairings (booked as two one-ways):`)
    for (const d of digest.roundtrips) out.push(renderRoundtripText(d, digest.generatedAt))
    if (digest.roundtripOverflowCount > 0) {
      const from =
        digest.roundtripOverflowFromPoints !== null
          ? ` from ${fmtPts(digest.roundtripOverflowFromPoints)} pts`
          : ''
      out.push(`  … plus ${digest.roundtripOverflowCount} more outbound dates${from}`)
    }
    out.push('')
  }
  for (const note of digest.notes) out.push(`Note: ${note}`)
  out.push('')
  out.push('Cached award data can be stale — always verify on the program site before planning.')
  out.push(`${ATTRIBUTION} (${ATTRIBUTION_URL})`)
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function htmlLegRow(leg: DealLeg, nowIso: string, label?: string): string {
  const seats = leg.seats === null || leg.seats === 0 ? 'n/a' : String(leg.seats)
  return `<tr>
    <td style="padding:4px 8px">${label ? `<em>${label}</em> ` : ''}${leg.origin} → ${leg.destination}</td>
    <td style="padding:4px 8px">${esc(fmtDate(leg.date))}</td>
    <td style="padding:4px 8px">${esc(leg.program)}${leg.isEstimate ? ' <strong style="color:#b45309">~est</strong>' : ''}</td>
    <td style="padding:4px 8px;text-align:right"><strong>${fmtPts(leg.points)}</strong></td>
    <td style="padding:4px 8px;text-align:center">${seats}</td>
    <td style="padding:4px 8px">${esc(leg.airlines || '?')} ${leg.direct ? '(nonstop)' : '(conn.)'}</td>
    <td style="padding:4px 8px;color:#6b7280">${esc(ageOf(leg.apiUpdatedAt, nowIso))}</td>
  </tr>`
}

export function renderHtml(digest: DealDigest): string {
  const now = digest.generatedAt
  const sections: string[] = []
  const tableHead = `<tr style="text-align:left;border-bottom:1px solid #d1d5db">
    <th style="padding:4px 8px">Route</th><th style="padding:4px 8px">Date</th>
    <th style="padding:4px 8px">Program</th><th style="padding:4px 8px;text-align:right">Points</th>
    <th style="padding:4px 8px">Seats</th><th style="padding:4px 8px">Airline</th><th style="padding:4px 8px">Data</th>
  </tr>`

  if (digest.oneways.length > 0) {
    const rows = digest.oneways
      .map((d) => {
        const extra: string[] = []
        const est = estimateNote(d.deal)
        if (est) extra.push(`⚠ ${esc(est)}`)
        if (d.detail) {
          const bits: string[] = []
          if (d.detail.flightNumbers) bits.push(esc(d.detail.flightNumbers))
          if (d.detail.totalTaxes !== null) {
            bits.push(`taxes ${d.detail.totalTaxes} ${esc(d.detail.taxesCurrency ?? '')}`)
          } else if (d.deal.source === 'qatar') {
            bits.push('taxes unavailable for this source')
          }
          const primary = d.detail.bookingLinks.find((b) => b.primary) ?? d.detail.bookingLinks[0]
          if (primary) bits.push(`<a href="${esc(primary.link)}">${esc(primary.label)}</a>`)
          if (bits.length > 0) extra.push(bits.join(' · '))
        }
        const extraRow =
          extra.length > 0
            ? `<tr><td colspan="7" style="padding:0 8px 8px;color:#4b5563;font-size:13px">${extra.join('<br>')}</td></tr>`
            : ''
        return `<tr><td colspan="7" style="padding:8px 8px 0;font-size:12px;color:#059669"><strong>${reasonLabel(d)}</strong></td></tr>${htmlLegRow(d.deal, now)}${extraRow}`
      })
      .join('')
    const overflow =
      digest.onewayOverflowCount > 0
        ? `<p style="color:#6b7280">… plus ${digest.onewayOverflowCount} more qualifying one-ways</p>`
        : ''
    sections.push(
      `<h3>One-way deals</h3><table style="border-collapse:collapse;font-size:14px">${tableHead}${rows}</table>${overflow}`,
    )
  }

  if (digest.roundtrips.length > 0) {
    const rows = digest.roundtrips
      .map((d) => {
        const rt = d.deal
        const estNotes = [rt.outbound, rt.inbound]
          .map((leg) => estimateNote(leg))
          .filter((n): n is string => n !== null)
          .map((n) => `<div style="color:#4b5563;font-size:13px">⚠ ${esc(n)}</div>`)
          .join('')
        return `<tr><td colspan="7" style="padding:10px 8px 0">
            <span style="font-size:12px;color:#059669"><strong>${reasonLabel(d)}</strong></span>
            &nbsp; <strong>Total ${fmtPts(rt.totalPoints)} pts</strong> · ${rt.stayNights} nights
            ${rt.isEstimate ? ' · <strong style="color:#b45309">~est</strong>' : ''}
          </td></tr>${htmlLegRow(rt.outbound, now, 'out')}${htmlLegRow(rt.inbound, now, 'back')}
          ${estNotes ? `<tr><td colspan="7" style="padding:0 8px 8px">${estNotes}</td></tr>` : ''}`
      })
      .join('')
    const overflow =
      digest.roundtripOverflowCount > 0
        ? `<p style="color:#6b7280">… plus ${digest.roundtripOverflowCount} more outbound dates${
            digest.roundtripOverflowFromPoints !== null
              ? ` from ${fmtPts(digest.roundtripOverflowFromPoints)} pts`
              : ''
          }</p>`
        : ''
    sections.push(
      `<h3>Roundtrip pairings</h3><table style="border-collapse:collapse;font-size:14px">${tableHead}${rows}</table>${overflow}`,
    )
  }

  const notes = digest.notes.map((n) => `<p style="color:#6b7280;font-size:13px">Note: ${esc(n)}</p>`).join('')

  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#111827;max-width:720px">
    ${sections.join('')}
    ${notes}
    <p style="color:#6b7280;font-size:13px">Cached award data can be stale — always verify on the program site before planning.</p>
    <p style="color:#6b7280;font-size:12px">${ATTRIBUTION} — <a href="${ATTRIBUTION_URL}">${ATTRIBUTION_URL.replace('https://', '')}</a></p>
  </div>`
}

// ---------------------------------------------------------------------------
// SMTP notifier
// ---------------------------------------------------------------------------

export class EmailNotifier implements Notifier {
  private readonly getCfg: () => AppConfig
  private readonly retryDelayMs: number
  private readonly injectedTransporter: Transporter | undefined
  private cachedTransporter: { key: string; transporter: Transporter } | null = null

  /**
   * Accepts a config getter so web-console config edits (from/to/SMTP settings)
   * apply to the very next send without a restart.
   */
  constructor(
    cfg: AppConfig | (() => AppConfig),
    private readonly smtpPassword: string,
    opts: { retryDelayMs?: number; transporter?: Transporter } = {},
  ) {
    this.getCfg = typeof cfg === 'function' ? cfg : () => cfg
    this.retryDelayMs = opts.retryDelayMs ?? 30_000
    this.injectedTransporter = opts.transporter
  }

  private transporterFor(cfg: AppConfig): Transporter {
    if (this.injectedTransporter) return this.injectedTransporter
    const smtp = cfg.email.smtp
    const key = `${smtp.host}|${smtp.port}|${smtp.secure}|${smtp.user}`
    if (this.cachedTransporter?.key !== key) {
      this.cachedTransporter = {
        key,
        transporter: createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: { user: smtp.user, pass: this.smtpPassword },
        }),
      }
    }
    return this.cachedTransporter.transporter
  }

  private async sendWithRetry(subject: string, text: string, html?: string): Promise<void> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      const cfg = this.getCfg()
      try {
        await this.transporterFor(cfg).sendMail({
          from: cfg.email.from,
          to: cfg.email.to.join(', '),
          subject,
          text,
          ...(html ? { html } : {}),
        })
        return
      } catch (err) {
        lastErr = err
        log.warn(`SMTP send failed (attempt ${attempt}/3): ${(err as Error).message}`)
        if (attempt < 3) await new Promise((r) => setTimeout(r, this.retryDelayMs))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  async sendDigest(digest: DealDigest): Promise<void> {
    await this.sendWithRetry(subjectFor(digest), renderText(digest), renderHtml(digest))
  }

  async sendFailureNotice(message: string): Promise<void> {
    await this.sendWithRetry(
      '[Deal Finder] service is failing',
      `${message}\n\nCheck \`deal-finder status\` and data/deal-finder.err.log.\n\n${ATTRIBUTION} (${ATTRIBUTION_URL})`,
    )
  }
}
