// Static Avios estimate table for proxy-source (american/alaska) records.
// Those sources surface oneworld (JAL/AA) award space whose bookable price for this
// user is a BA or Qatar Avios redemption, priced by segment distance — not the
// AA/AS mileage cost the record itself carries.
//
// Chart facts (researched 2026-08-15):
// - Qatar Privilege Club oneworld partner chart: flat, unchanged since June 2023.
//   (TPG 2024-09, Point Hacks 2025-02, Frequent Miler 2025-05, 10xTravel, AwardWallet)
// - BA Club partner pricing: flat (no peak/off-peak on partners). Dec 15 2025
//   devaluation: bands <=3,000mi exact per MileLion; longer bands "~+10%" — those
//   values are community ESTIMATES (BA no longer publishes a chart). The JAL/Cathay
//   surcharge tier applies only <=3,000mi, so NA<->Tokyo prices at standard rates.
// - Surcharges are NOT included in these numbers: JAL metal carries a fuel surcharge
//   of roughly US$370-440 per sector as of mid-2026; AA metal has none.
import type { AvailabilityRecord, AviosEstimate } from '../types.js'

export const AVIOS_CHART_LAST_VERIFIED = '2026-08-15'
export const AVIOS_CHART_SOURCES = [
  'https://milelion.com/2025/12/16/details-british-airways-avios-award-devaluation/',
  'https://thepointsguy.com/loyalty-programs/qatar-airways-privilege-club-program/',
  'https://frequentmiler.com/best-uses-of-avios/',
]

export interface AviosBand {
  /** Inclusive upper bound of the band in flown miles. */
  maxMiles: number
  /** Qatar Avios oneworld partner chart, one-way business (verified). */
  qatarAvios: number
  /** BA Club partner, one-way business (bands >3,000mi are ~+10% post-deval estimates). */
  baAvios: number
}

export let AVIOS_BANDS: AviosBand[] = [
  { maxMiles: 650, qatarAvios: 12_500, baAvios: 14_000 },
  { maxMiles: 1151, qatarAvios: 16_500, baAvios: 18_500 },
  { maxMiles: 2000, qatarAvios: 22_000, baAvios: 24_500 },
  { maxMiles: 3000, qatarAvios: 38_750, baAvios: 43_000 },
  { maxMiles: 4000, qatarAvios: 62_000, baAvios: 68_250 },
  { maxMiles: 5500, qatarAvios: 77_250, baAvios: 85_000 }, // YVR/LAX <-> Tokyo
  { maxMiles: 6500, qatarAvios: 92_750, baAvios: 102_000 }, // ORD/YYZ <-> Tokyo
  { maxMiles: 7000, qatarAvios: 108_250, baAvios: 119_000 },
  { maxMiles: Infinity, qatarAvios: 154_500, baAvios: 170_000 },
]

/** Fallback great-circle miles for grid routes when the API omits Route.Distance. */
const KNOWN_ROUTE_MILES: Record<string, number> = {
  'YYZ-NRT': 6400, 'YYZ-HND': 6429,
  'ORD-NRT': 6260, 'ORD-HND': 6291,
  'YVR-NRT': 4662, 'YVR-HND': 4697,
  'LAX-NRT': 5439, 'LAX-HND': 5476,
}

function routeMiles(rec: AvailabilityRecord): number | null {
  if (rec.routeDistance && rec.routeDistance > 0) return rec.routeDistance
  return (
    KNOWN_ROUTE_MILES[`${rec.origin}-${rec.destination}`] ??
    KNOWN_ROUTE_MILES[`${rec.destination}-${rec.origin}`] ??
    null
  )
}

export function estimateAviosForDistance(miles: number): AviosEstimate | null {
  const band = AVIOS_BANDS.find((b) => miles <= b.maxMiles)
  if (!band) return null
  return {
    qatarAvios: band.qatarAvios,
    baAvios: band.baAvios,
    best: Math.min(band.qatarAvios, band.baAvios),
    lastVerified: AVIOS_CHART_LAST_VERIFIED,
  }
}

const AVIOS_BOOKABLE_CARRIERS = ['JL', 'AA']

function airlinesInclude(list: string, codes: string[]): boolean {
  const tokens = list
    .split(/[,\s]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
  return codes.some((c) => tokens.includes(c))
}

/**
 * A proxy-source record is eligible only when it is a nonstop on JAL or AA metal —
 * space that BA/Qatar Avios can realistically book at chart rates. Connecting or
 * mixed-carrier proxy itineraries are unpriceable from cached data and excluded.
 */
export function isProxyEligible(rec: AvailabilityRecord): boolean {
  if (!rec.jAvailable || !rec.jDirect) return false
  const airlines = rec.jDirectAirlines || rec.jAirlines
  if (!airlinesInclude(airlines, AVIOS_BOOKABLE_CARRIERS)) return false
  return routeMiles(rec) !== null
}

/** Estimated Avios pricing for an eligible proxy record; null when ineligible. */
export function estimateForRecord(rec: AvailabilityRecord): AviosEstimate | null {
  if (!isProxyEligible(rec)) return null
  const miles = routeMiles(rec)
  if (miles === null) return null
  return estimateAviosForDistance(miles)
}

/** Test/maintenance hook: swap the chart (e.g. when re-verified values arrive). */
export function setAviosBands(bands: AviosBand[]): void {
  AVIOS_BANDS = bands
}
