import { useEffect, useId, useRef } from 'react'
import { useTripDetail } from './hooks'
import { fmtPts, fmtDateShort, ageOf } from './api'
import type { BookingLinkDto, DealLegDto, SegmentDto, TripOptionDto } from '@shared/apiTypes'

/**
 * Snapshot of the clicked deal, captured in the row's click handler. The drawer
 * never re-derives legs from list state — the 60s poll can re-sort or drop the
 * deal underneath without touching an open drawer.
 */
export type OpenDeal =
  | { kind: 'oneway'; dealKey: string; leg: DealLegDto }
  | {
      kind: 'roundtrip'
      dealKey: string
      outbound: DealLegDto
      inbound: DealLegDto
      totalPoints: number
      stayNights: number
    }

// Times are airport-local ISO 8601 shown verbatim — a Date round-trip would
// silently convert them to the viewer's timezone.
function localTime(iso: string): string {
  return iso.slice(11, 16) || iso
}

function localDate(iso: string): string {
  return iso.slice(0, 10)
}

/** Calendar-day difference between two airport-local ISO strings ("+1" markers). */
function dayDiff(fromIso: string, toIso: string): number {
  const from = Date.parse(localDate(fromIso))
  const to = Date.parse(localDate(toIso))
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.round((to - from) / 86_400_000)
}

function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`
}

function fmtTaxes(cents: number | null, currency: string | null): string | null {
  if (cents === null) return null
  return `${currency ?? ''} ${(cents / 100).toFixed(2)}`.trim()
}

function PlusDays({ n }: { n: number }) {
  if (n <= 0) return null
  return <sup className="plus1">+{n}</sup>
}

function SegmentRow({ seg, departureIso }: { seg: SegmentDto; departureIso: string }) {
  return (
    <>
      <div className="seg">
        <span className="seg-flight">{seg.flightNumber ?? '——'}</span>
        <span className="route">
          {seg.originAirport}
          <span className="arrow">→</span>
          {seg.destinationAirport}
        </span>
        <span>
          {localTime(seg.departsAt)}
          <PlusDays n={dayDiff(departureIso, seg.departsAt)} />
          <span className="arrow">–</span>
          {localTime(seg.arrivesAt)}
          <PlusDays n={dayDiff(departureIso, seg.arrivesAt)} />
        </span>
        {seg.aircraftName && <span className="faint">{seg.aircraftName}</span>}
        {seg.fareClass && <span className="faint">fare {seg.fareClass}</span>}
      </div>
      {seg.layoverMinutesAfter !== null && (
        <div className="layover">{fmtDuration(seg.layoverMinutesAfter)} layover in {seg.destinationAirport}</div>
      )}
    </>
  )
}

function OptionCard({ opt, cheapest }: { opt: TripOptionDto; cheapest: boolean }) {
  const departureIso = opt.departsAt ?? opt.segments[0]?.departsAt ?? ''
  const taxes = fmtTaxes(opt.totalTaxes, opt.taxesCurrency)
  return (
    <div className={cheapest ? 'option cheapest' : 'option'}>
      <div className="option-head">
        <span className="pts">{fmtPts(opt.mileageCost)}</span>
        {taxes && <span className="dim"> + {taxes} taxes</span>}
        {cheapest && <span className="badge direct">cheapest</span>}
        {opt.stops !== null && (
          <span className={opt.stops === 0 ? 'badge direct' : 'badge conn'}>
            {opt.stops === 0 ? 'nonstop' : `${opt.stops} stop${opt.stops > 1 ? 's' : ''}`}
          </span>
        )}
        {opt.totalDurationMinutes !== null && <span className="faint">{fmtDuration(opt.totalDurationMinutes)}</span>}
        <span className="dim">seats {opt.seats === null ? '—' : opt.seats}</span>
      </div>
      {opt.segments.length > 0 ? (
        opt.segments.map((seg) => <SegmentRow key={`${seg.order}-${seg.departsAt}`} seg={seg} departureIso={departureIso} />)
      ) : (
        <div className="seg">
          <span className="seg-flight">{opt.flightNumbers ?? '——'}</span>
          {opt.departsAt && opt.arrivesAt && (
            <span>
              {localTime(opt.departsAt)}
              <span className="arrow">–</span>
              {localTime(opt.arrivesAt)}
              <PlusDays n={dayDiff(opt.departsAt, opt.arrivesAt)} />
            </span>
          )}
          {opt.carriers && <span className="faint">{opt.carriers}</span>}
        </div>
      )}
    </div>
  )
}

/** Pre-filled deep links carry a query string; bare program pages need a manual search. */
function isHomepageLink(link: string): boolean {
  try {
    return new URL(link).search === ''
  } catch {
    return true
  }
}

function BookingLinks({ links, leg }: { links: BookingLinkDto[]; leg: DealLegDto }) {
  if (links.length === 0) {
    return (
      <p className="dim booking-fallback">
        No booking link available — book directly with {leg.program}: search {leg.origin}→{leg.destination} on{' '}
        {fmtDateShort(leg.date)}.
      </p>
    )
  }
  const primary = links.find((l) => l.primary) ?? links[0]!
  const secondary = links.filter((l) => l !== primary)
  return (
    <div className="booking-links">
      <div className="verify-callout">
        Availability may be phantom — verify on {leg.program} before transferring points.
      </div>
      <a className="book-primary" href={primary.link} target="_blank" rel="noopener noreferrer">
        {primary.label}
        {isHomepageLink(primary.link) && <span className="book-hint"> · opens program site — search manually</span>}
      </a>
      {secondary.map((l) => (
        <a key={l.link} className="book-secondary" href={l.link} target="_blank" rel="noopener noreferrer">
          {l.label}
          {isHomepageLink(l.link) && <span className="book-hint"> · opens program site — search manually</span>}
        </a>
      ))}
    </div>
  )
}

function LegDetail({ leg, label }: { leg: DealLegDto; label?: string }) {
  const { state, retry } = useTripDetail(leg.availabilityId)
  return (
    <section className="leg-card">
      <h3 className="leg-title">
        {label && <span className="faint">{label} · </span>}
        <span className="route">
          {leg.origin}
          <span className="arrow">→</span>
          {leg.destination}
        </span>{' '}
        <span className="dim">{fmtDateShort(leg.date)}</span> <span className="dim">· {leg.program}</span>
      </h3>

      {state.kind === 'loading' && (
        <div className="pulse">
          <span className="lamp" aria-hidden="true" /> Fetching itinerary…
        </div>
      )}
      {state.kind === 'no_api_key' && (
        <p className="dim">Running without a seats.aero key — live itinerary lookups are off.</p>
      )}
      {state.kind === 'quota_exhausted' && (
        <p className="quota-note">Daily lookup budget reached — the alert poller gets priority. Try again later.</p>
      )}
      {state.kind === 'expired' && <p className="dim">No longer available. The list will drop it on the next poll.</p>}
      {state.kind === 'upstream_error' && (
        <p className="error-inline">
          Couldn't reach seats.aero.{' '}
          <button className="ghost" onClick={retry}>
            Retry
          </button>
        </p>
      )}
      {state.kind === 'empty' && (
        <p className="dim">No business-cabin options currently match — search the program site directly.</p>
      )}

      {(state.kind === 'ok' || state.kind === 'empty') && (
        <>
          {state.kind === 'ok' &&
            state.body.options.map((opt, i) => (
              <OptionCard key={`${opt.flightNumbers ?? i}-${opt.departsAt ?? i}`} opt={opt} cheapest={i === 0} />
            ))}
          <BookingLinks links={state.body.bookingLinks} leg={leg} />
          <div className="leg-footer">
            Fetched {ageOf(state.body.fetchedAt)} ago · availability data {ageOf(leg.apiUpdatedAt)} old
          </div>
        </>
      )}
    </section>
  )
}

export function DealDetail({ deal, onClose }: { deal: OpenDeal; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const headingId = useId()

  // Dialog plumbing: Escape closes; focus moves in on open and returns to the
  // trigger on close; Tab is trapped; background scroll is locked. All cleanup
  // runs in one effect so closing mid-fetch composes with the hook's abort.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
      previouslyFocused?.focus()
    }
  }, [onClose])

  return (
    <div
      className="drawer-backdrop"
      onClick={(e) => {
        // Only a click that starts and ends on the backdrop closes — a text
        // selection released over it must not slam the drawer shut.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="drawer-head">
          <h2 id={headingId} className="drawer-title">
            {deal.kind === 'oneway' ? (
              <>
                <span className="route">
                  {deal.leg.origin}
                  <span className="arrow">→</span>
                  {deal.leg.destination}
                </span>{' '}
                <span className="pts">{fmtPts(deal.leg.points)}</span>
              </>
            ) : (
              <>
                <span className="route">
                  {deal.outbound.origin}
                  <span className="arrow">⇄</span>
                  {deal.outbound.destination}
                </span>{' '}
                <span className="pts">{fmtPts(deal.totalPoints)}</span>{' '}
                <span className="dim">· {deal.stayNights}n stay</span>
              </>
            )}
          </h2>
          <button className="ghost drawer-close" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>

        {deal.kind === 'roundtrip' && (
          <p className="rt-note">
            Booked as two separate one-way awards — each leg below has its own options and booking links.
          </p>
        )}

        {deal.kind === 'oneway' ? (
          <LegDetail leg={deal.leg} />
        ) : (
          <>
            <LegDetail key={deal.outbound.availabilityId} leg={deal.outbound} label="Outbound" />
            <LegDetail key={deal.inbound.availabilityId} leg={deal.inbound} label="Return" />
          </>
        )}
      </div>
    </div>
  )
}
