import type { AppConfig } from '../shared/configSchema.js'
import { ESTIMATE_SOURCE_KEY } from '../shared/constants.js'
import type { AvailabilityRecord, DealLeg, OneWayDeal } from '../types.js'
import { estimateForRecord } from './avios.js'

const PROGRAM_NAMES: Record<string, string> = {
  aeroplan: 'Aeroplan',
  flyingblue: 'Flying Blue',
  qatar: 'Qatar Avios',
  british: 'BA Avios',
  finnair: 'Finnair Avios',
  american: 'AAdvantage',
  alaska: 'Alaska Mileage Plan',
}

export function programName(source: string): string {
  return PROGRAM_NAMES[source] ?? source
}

export function isProxySource(source: string, cfg: AppConfig): boolean {
  return cfg.search.proxySources.enabled && cfg.search.proxySources.sources.includes(source)
}

export function onewayKey(
  leg: Pick<DealLeg, 'source' | 'origin' | 'destination' | 'date' | 'isEstimate'>,
): string {
  // Proxy-estimate legs share one key namespace: american and alaska surface the
  // same physical JAL/AA seats at the same estimated price, and alerting them
  // twice would be pure noise.
  const keySource = leg.isEstimate ? ESTIMATE_SOURCE_KEY : leg.source
  return `OW|${keySource}|${leg.origin}|${leg.destination}|${leg.date}`
}

function seatsPass(seats: number | null, minSeats: number): boolean {
  // Sources that omit seat counts (or report 0 as "unknown") pass — `american`
  // only reports counts when low.
  if (seats === null || seats === 0) return true
  return seats >= minSeats
}

/**
 * Convert an availability record into a priced candidate leg, applying every rule
 * EXCEPT the points thresholds (callers apply oneway/roundtrip caps).
 * Returns null when the record cannot be a deal at any price.
 */
export function candidateLeg(rec: AvailabilityRecord, cfg: AppConfig): DealLeg | null {
  if (!rec.jAvailable) return null

  // Only sources currently enabled (directly or as proxies) can produce deals —
  // stale DB rows from disabled/removed sources are ignored. A proxy-listed
  // source is ALWAYS estimate-priced, never its own mileage cost — the proxy
  // branch wins even if a hand-edited config also lists it in search.sources
  // (the schema rejects that overlap, this is defense in depth).
  const enabledDirect = cfg.search.sources.includes(rec.source)
  const enabledProxy = isProxySource(rec.source, cfg)
  if (!enabledDirect && !enabledProxy) return null

  if (enabledProxy) {
    const estimate = estimateForRecord(rec)
    if (!estimate) return null
    const seats = rec.jDirectRemainingSeats ?? rec.jRemainingSeats
    if (!seatsPass(seats, cfg.search.minSeats)) return null
    return {
      availabilityId: rec.id,
      source: rec.source,
      program: 'BA/Qatar Avios (estimated)',
      origin: rec.origin,
      destination: rec.destination,
      date: rec.date,
      direction: rec.direction,
      points: estimate.best,
      isEstimate: true,
      estimate,
      direct: true,
      seats,
      airlines: rec.jDirectAirlines || rec.jAirlines,
      apiUpdatedAt: rec.apiUpdatedAt,
    }
  }

  if (cfg.search.directOnly) {
    // Strict: only the direct-itinerary fields count. A record with no usable
    // direct price is not a deal at any price — never borrow the any-itinerary
    // cost (typically a connection) and present it as a nonstop.
    if (!rec.jDirect || rec.jDirectMileageCost === null) return null
    const seats = rec.jDirectRemainingSeats
    if (!seatsPass(seats, cfg.search.minSeats)) return null
    return {
      availabilityId: rec.id,
      source: rec.source,
      program: programName(rec.source),
      origin: rec.origin,
      destination: rec.destination,
      date: rec.date,
      direction: rec.direction,
      points: rec.jDirectMileageCost,
      isEstimate: false,
      direct: true,
      seats,
      airlines: rec.jDirectAirlines || rec.jAirlines,
      apiUpdatedAt: rec.apiUpdatedAt,
    }
  }

  const points = rec.jMileageCost ?? rec.jDirectMileageCost
  if (points === null) return null
  const seats = rec.jRemainingSeats
  if (!seatsPass(seats, cfg.search.minSeats)) return null
  // Only claim "nonstop" when the priced cost is actually the direct itinerary's.
  const pricedIsDirect = rec.jDirect && rec.jDirectMileageCost === points

  return {
    availabilityId: rec.id,
    source: rec.source,
    program: programName(rec.source),
    origin: rec.origin,
    destination: rec.destination,
    date: rec.date,
    direction: rec.direction,
    points,
    isEstimate: false,
    direct: pricedIsDirect,
    seats,
    airlines: (pricedIsDirect ? rec.jDirectAirlines : rec.jAirlines) || rec.jAirlines,
    apiUpdatedAt: rec.apiUpdatedAt,
  }
}

/** One-way deals: candidate legs strictly under the one-way threshold, unique per key. */
export function detectOneways(records: AvailabilityRecord[], cfg: AppConfig): OneWayDeal[] {
  const byKey = new Map<string, OneWayDeal>()
  for (const rec of records) {
    const leg = candidateLeg(rec, cfg)
    if (!leg) continue
    if (leg.points >= cfg.thresholds.onewayMaxPoints) continue
    const key = onewayKey(leg)
    const existing = byKey.get(key)
    // Estimate legs from american and alaska share a key; keep the cheaper/first.
    if (!existing || leg.points < existing.points) {
      byKey.set(key, { ...leg, kind: 'oneway', key })
    }
  }
  const deals = [...byKey.values()]
  deals.sort((a, b) => a.points - b.points)
  return deals
}
