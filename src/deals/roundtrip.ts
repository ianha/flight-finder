import type { AppConfig } from '../shared/configSchema.js'
import type { AvailabilityRecord, DealLeg, RoundtripDeal } from '../types.js'
import { candidateLeg } from './oneway.js'

export function roundtripKey(outbound: DealLeg, inbound: DealLeg): string {
  // Keyed by the TRIP (cities + dates), not the specific program pairing: when a
  // different source becomes the cheapest way to fly the same trip, that is the
  // same deal — the >=15% improvement rule decides whether it re-alerts. Pinning
  // the key to sources would re-alert on every pairing flicker and freeze the
  // gone-clock of keys that stop winning.
  return `RT|${outbound.origin}|${outbound.date}|${inbound.destination}|${inbound.date}`
}

function dateToEpochDay(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000)
}

function epochDayToDate(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Per-date cheapest legs. In sameCityReturn mode minima are kept per city
 * (outbound: departure city; inbound: arrival city) so pairing can match them up.
 */
function dailyMinima(
  legs: DealLeg[],
  cityOf: (leg: DealLeg) => string,
  perCity: boolean,
): Map<string, Map<string, DealLeg>> {
  const byDate = new Map<string, Map<string, DealLeg>>()
  for (const leg of legs) {
    const city = perCity ? cityOf(leg) : '*'
    let cities = byDate.get(leg.date)
    if (!cities) {
      cities = new Map()
      byDate.set(leg.date, cities)
    }
    const current = cities.get(city)
    if (!current || leg.points < current.points) cities.set(city, leg)
  }
  return byDate
}

/**
 * Roundtrip pairings under the total threshold.
 *
 * Stage 1: reduce to per-date (or per-date-per-city) minima — a global minimum
 * loses nothing when any origin/program mix is allowed.
 * Stage 2: sweep each outbound date's stay window. Volume control: only the
 * cheapest pair per outbound date is emitted, sorted by total.
 */
export function detectRoundtrips(records: AvailabilityRecord[], cfg: AppConfig): RoundtripDeal[] {
  const maxTotal = cfg.thresholds.roundtripMaxPoints
  const { minStayNights, maxStayNights, sameCityReturn } = cfg.roundtrip

  const legs: DealLeg[] = []
  for (const rec of records) {
    const leg = candidateLeg(rec, cfg)
    // A leg is pairable as long as it alone stays under the roundtrip total.
    if (leg && leg.points < maxTotal) legs.push(leg)
  }

  const outMinima = dailyMinima(
    legs.filter((l) => l.direction === 'outbound'),
    (l) => l.origin,
    sameCityReturn,
  )
  const inMinima = dailyMinima(
    legs.filter((l) => l.direction === 'return'),
    (l) => l.destination,
    sameCityReturn,
  )

  const pairs: RoundtripDeal[] = []
  for (const [outDate, outCities] of outMinima) {
    const outEpoch = dateToEpochDay(outDate)
    let bestForDate: RoundtripDeal | null = null

    for (const [city, outLeg] of outCities) {
      for (let stay = minStayNights; stay <= maxStayNights; stay++) {
        const inDate = epochDayToDate(outEpoch + stay)
        const inLeg = inMinima.get(inDate)?.get(city)
        if (!inLeg) continue
        const total = outLeg.points + inLeg.points
        if (total >= maxTotal) continue
        if (!bestForDate || total < bestForDate.totalPoints) {
          bestForDate = {
            kind: 'roundtrip',
            key: roundtripKey(outLeg, inLeg),
            outbound: outLeg,
            inbound: inLeg,
            totalPoints: total,
            stayNights: stay,
            isEstimate: outLeg.isEstimate || inLeg.isEstimate,
          }
        }
      }
    }
    if (bestForDate) pairs.push(bestForDate)
  }

  pairs.sort((a, b) => a.totalPoints - b.totalPoints)
  return pairs
}
