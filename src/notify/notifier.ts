import type { AlertableDeal } from '../deals/dedupe.js'
import type { OneWayDeal, RoundtripDeal, TripDetail } from '../types.js'

export interface DigestOneway extends AlertableDeal<OneWayDeal> {
  detail?: TripDetail | null
}

export type DigestRoundtrip = AlertableDeal<RoundtripDeal>

export interface DealDigest {
  generatedAt: string
  oneways: DigestOneway[]
  roundtrips: DigestRoundtrip[]
  /** Qualifying deals beyond the per-email caps. */
  onewayOverflowCount: number
  roundtripOverflowCount: number
  /** Cheapest total among overflowed roundtrips, for the "+N more from X" line. */
  roundtripOverflowFromPoints: number | null
  /** Operational notes surfaced to the reader (partial data, invalid records, ...). */
  notes: string[]
}

export interface Notifier {
  sendDigest(digest: DealDigest): Promise<void>
  /** Optional operational alarm (repeated cycle failures). Best-effort. */
  sendFailureNotice?(message: string): Promise<void>
}

/** No-op notifier used by --dry-run. */
export const nullNotifier: Notifier = {
  async sendDigest() {
    /* dry-run: caller prints the rendered digest instead */
  },
}
