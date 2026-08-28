// Human-readable digest rendering: full text form (console --dry-run, logs)
// plus small shared formatting helpers. The compact SMS form lives in sms.ts.
import { ATTRIBUTION, ATTRIBUTION_URL } from '../shared/constants.js'
import type { DealLeg } from '../types.js'
import type { DealDigest, DigestOneway, DigestRoundtrip } from './notifier.js'

export function fmtPts(n: number): string {
  return n.toLocaleString('en-US')
}

export function fmtPtsShort(n: number): string {
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

export function reasonLabel(d: { reason: string; prevBestPoints?: number }): string {
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
