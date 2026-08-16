import type { AppConfig } from '../shared/configSchema.js'
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

export function onewayKey(leg: Pick<DealLeg, 'source' | 'origin' | 'destination' | 'date'>): string {
  return `OW|${leg.source}|${leg.origin}|${leg.destination}|${leg.date}`
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
  // source is never priced with its own mileage cost.
  const enabledDirect = cfg.search.sources.includes(rec.source)
  const enabledProxy = isProxySource(rec.source, cfg)
  if (!enabledDirect && !enabledProxy) return null

  if (!enabledDirect && enabledProxy) {
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

  const direct = rec.jDirect
  if (cfg.search.directOnly && !direct) return null
  const points =
    cfg.search.directOnly && rec.jDirectMileageCost !== null
      ? rec.jDirectMileageCost
      : (rec.jMileageCost ?? rec.jDirectMileageCost)
  if (points === null) return null
  const seats =
    cfg.search.directOnly && rec.jDirectRemainingSeats !== null
      ? rec.jDirectRemainingSeats
      : rec.jRemainingSeats
  if (!seatsPass(seats, cfg.search.minSeats)) return null

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
    direct,
    seats,
    airlines: (cfg.search.directOnly ? rec.jDirectAirlines : rec.jAirlines) || rec.jAirlines,
    apiUpdatedAt: rec.apiUpdatedAt,
  }
}

/** One-way deals: candidate legs strictly under the one-way threshold. */
export function detectOneways(records: AvailabilityRecord[], cfg: AppConfig): OneWayDeal[] {
  const deals: OneWayDeal[] = []
  for (const rec of records) {
    const leg = candidateLeg(rec, cfg)
    if (!leg) continue
    if (leg.points >= cfg.thresholds.onewayMaxPoints) continue
    deals.push({ ...leg, kind: 'oneway', key: onewayKey(leg) })
  }
  deals.sort((a, b) => a.points - b.points)
  return deals
}
