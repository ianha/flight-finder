import { useCallback, useMemo, useState } from 'react'
import { usePoll } from '../hooks'
import { qs, fmtPts, fmtDateShort, ageOf } from '../api'
import { DealDetail, type OpenDeal } from '../DealDetail'
import { useRunNow } from '../useRunNow'
import { SCHEMA_DEFAULTS } from '../statusDefaults'
import { ESTIMATE_SOURCE_KEY } from '@shared/constants'
import type {
  OneWayDealsResponse,
  RoundtripDealsResponse,
  DealLegDto,
  OneWayDealDto,
  RoundtripDealDto,
  StatusResponse,
} from '@shared/apiTypes'

interface Filters {
  home: string
  dest: string
  source: string
  direction: string
  /** null = follow the config default; a boolean is an explicit per-session override. */
  directOnly: boolean | null
  includeEstimates: boolean
  maxPoints: string
}

const DEFAULT_FILTERS: Filters = {
  home: '',
  dest: '',
  source: '',
  direction: '',
  directOnly: null,
  includeEstimates: true,
  maxPoints: '',
}

function StaleAge({ iso }: { iso: string }) {
  const age = ageOf(iso)
  const stale = Date.now() - Date.parse(iso) > 24 * 3_600_000
  return <span className={stale ? 'stale' : 'faint'}>{age}</span>
}

function LegCells({ leg }: { leg: DealLegDto }) {
  return (
    <>
      <td className="route">
        {leg.origin}
        <span className="arrow">→</span>
        {leg.destination}
      </td>
      <td className="dim">{fmtDateShort(leg.date)}</td>
      <td>
        {leg.program}{' '}
        {leg.isEstimate && (
          <span
            className="badge est"
            title={
              leg.estimate
                ? `Estimated: Qatar Avios ${fmtPts(leg.estimate.qatarAvios)} · BA ${fmtPts(leg.estimate.baAvios)} — surcharges not included; verify before booking`
                : 'Estimated pricing — verify before booking'
            }
          >
            ~est
          </span>
        )}
      </td>
      <td className="pts">{fmtPts(leg.points)}</td>
      <td className="dim">{leg.seats === null || leg.seats === 0 ? '—' : leg.seats}</td>
      <td>
        <span className="dim">{leg.airlines || '?'}</span>{' '}
        {leg.direct ? <span className="badge direct">nonstop</span> : <span className="badge conn">conn</span>}
      </td>
      <td>
        <StaleAge iso={leg.apiUpdatedAt} />
      </td>
    </>
  )
}

/** Real button inside a cell (not role="button" on the row — that would break table semantics for screen readers). */
function OpenDetailsCell({ label, onOpen }: { label: string; onOpen: (() => void) | null }) {
  return (
    <td className="row-open">
      {onOpen && (
        <button
          className="row-open-btn"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
        >
          ›
        </button>
      )}
    </td>
  )
}

function OnewayTable({ deals, onOpen }: { deals: OneWayDealDto[]; onOpen: ((deal: OpenDeal) => void) | null }) {
  if (deals.length === 0) return <div className="empty">no qualifying one-ways in the current snapshot</div>
  return (
    <table className="board">
      <thead>
        <tr>
          <th>Route</th>
          <th>Date</th>
          <th>Program</th>
          <th className="num">Points</th>
          <th>Seats</th>
          <th>Airline</th>
          <th>Data</th>
          <th className="row-open" aria-label="Details" />
        </tr>
      </thead>
      <tbody>
        {deals.map((d) => {
          // Snapshot captured here, in the click scope — the drawer must never
          // re-derive the leg from list state the poll keeps replacing.
          const open = onOpen ? () => onOpen({ kind: 'oneway', dealKey: d.key, leg: d }) : null
          return (
            <tr key={d.key} className={open ? 'clickable' : ''} onClick={open ?? undefined}>
              <LegCells leg={d} />
              <OpenDetailsCell
                label={`View details: ${d.origin} to ${d.destination}, ${d.program}, ${fmtPts(d.points)} pts`}
                onOpen={open}
              />
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function RoundtripTable({
  pairs,
  onOpen,
  onewayMaxPoints,
}: {
  pairs: RoundtripDealDto[]
  onOpen: ((deal: OpenDeal) => void) | null
  onewayMaxPoints: number
}) {
  if (pairs.length === 0) return <div className="empty">no qualifying roundtrip pairings in the current snapshot</div>
  return (
    <table className="board">
      <thead>
        <tr>
          <th>Total</th>
          <th>Stay</th>
          <th>Leg</th>
          <th>Route</th>
          <th>Date</th>
          <th>Program</th>
          <th className="num">Points</th>
          <th>Airline</th>
          <th>Data</th>
          <th className="row-open" aria-label="Details" />
        </tr>
      </thead>
      <tbody>
        {pairs.flatMap((p) => {
          const legs: Array<{ label: string; leg: DealLegDto }> = [
            { label: 'out', leg: p.outbound },
            { label: 'back', leg: p.inbound },
          ]
          // Either row of the rowSpan pair opens the pair's detail.
          const open = onOpen
            ? () =>
                onOpen({
                  kind: 'roundtrip',
                  dealKey: p.key,
                  outbound: p.outbound,
                  inbound: p.inbound,
                  totalPoints: p.totalPoints,
                  stayNights: p.stayNights,
                })
            : null
          return legs.map(({ label, leg }, i) => (
            <tr key={`${p.key}-${label}`} className={open ? 'clickable' : ''} onClick={open ?? undefined}>
              {i === 0 ? (
                <>
                  <td className="pts-total" rowSpan={2}>
                    {fmtPts(p.totalPoints)}
                    {p.isEstimate && (
                      <>
                        {' '}
                        <span className="badge est">~est</span>
                      </>
                    )}
                  </td>
                  <td className="dim" rowSpan={2}>
                    {p.stayNights}n
                  </td>
                </>
              ) : null}
              <td className="faint">{label}</td>
              <td className="route">
                {leg.origin}
                <span className="arrow">→</span>
                {leg.destination}
              </td>
              <td className="dim">{fmtDateShort(leg.date)}</td>
              <td>{leg.program}</td>
              <td className={leg.points >= onewayMaxPoints ? 'pts over' : 'pts'}>{fmtPts(leg.points)}</td>
              <td className="dim">{leg.airlines || '?'}</td>
              <td>
                <StaleAge iso={leg.apiUpdatedAt} />
              </td>
              <OpenDetailsCell
                label={`View details: roundtrip ${p.outbound.origin} to ${p.outbound.destination}, ${fmtPts(p.totalPoints)} pts total`}
                onOpen={open}
              />
            </tr>
          ))
        })}
      </tbody>
    </table>
  )
}

/**
 * Shown when the current configuration's geography/window has zero fetched
 * availability rows (availabilityInScope === 0) — distinct from "nothing
 * qualifies": the console hasn't looked yet, not that nothing is there.
 */
function NoScopedDataEmpty({ status }: { status: StatusResponse | null }) {
  const { run, busy, toast } = useRunNow()
  const hasApiKey = status?.env.seatsAeroApiKey ?? true
  const scheduler = status?.scheduler ?? null
  const inFlight = status?.cycleInFlight != null
  return (
    <div className="empty empty-action" role="status">
      <div>no availability fetched yet for this configuration</div>
      <div className="dim">
        {scheduler ? (
          scheduler.nextRunAt ? (
            <>
              next cycle{' '}
              <time dateTime={scheduler.nextRunAt}>
                {new Date(scheduler.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
            </>
          ) : (
            'next cycle pending'
          )
        ) : hasApiKey ? (
          'scheduler not running (CLI mode)'
        ) : (
          'disabled — no API key'
        )}
      </div>
      {hasApiKey && scheduler && (
        <button className="action" onClick={run} disabled={busy || inFlight}>
          {inFlight ? 'running…' : busy ? 'starting…' : 'Run now'}
        </button>
      )}
      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.msg}</div>}
    </div>
  )
}

export function Dashboard({
  apiKeyPresent = true,
  status = null,
}: {
  apiKeyPresent?: boolean
  status?: StatusResponse | null
}) {
  const [tab, setTab] = useState<'oneway' | 'roundtrip'>('oneway')
  const [f, setF] = useState<Filters>(DEFAULT_FILTERS)
  const [openDeal, setOpenDeal] = useState<OpenDeal | null>(null)
  // UI-only mode (no API key): rows stay plain — a details click would only dead-end.
  const onOpen = apiKeyPresent ? setOpenDeal : null
  // Stable identity: DealDetail's dialog-plumbing effect depends on onClose —
  // a fresh function every render (the old inline arrow) would tear it down and
  // rebuild it (re-adding the keydown listener, re-grabbing focus) on every
  // status/deal poll tick, stealing focus from wherever the user tabbed to.
  const closeDrawer = useCallback(() => setOpenDeal(null), [])

  const ready = status !== null
  const geo = status?.search ?? SCHEMA_DEFAULTS.search
  const thresholds = status?.thresholds ?? SCHEMA_DEFAULTS.thresholds

  // Effective filters are DERIVED, not synced with an effect: a selection the
  // current config no longer offers falls back to "any" instead of filtering
  // on a ghost airport/program. The nonstop checkbox is disabled until ready,
  // so a user can never lock in an override before the real config default is
  // known.
  const programOptions = useMemo(
    () => [...geo.sources, ...(geo.estimatesEnabled ? [ESTIMATE_SOURCE_KEY] : [])],
    [geo.sources, geo.estimatesEnabled],
  )
  const home = geo.origins.includes(f.home) ? f.home : ''
  const dest = geo.destinations.includes(f.dest) ? f.dest : ''
  const source = programOptions.includes(f.source) ? f.source : ''
  const directOnly = f.directOnly ?? geo.directOnly
  const directOnlyOverridden = f.directOnly !== null

  const set = (patch: Partial<Filters>) => setF((cur) => ({ ...cur, ...patch }))

  // Paths depend only on primitives derived above (never on `geo`/`status`,
  // which are new objects every 10s status poll and would otherwise reset the
  // 60s interval on every tick).
  const onewayPath = useMemo(
    () =>
      `/api/deals/oneway${qs({
        home,
        dest,
        source,
        direction: f.direction,
        directOnly: f.directOnly ?? undefined,
        includeEstimates: f.includeEstimates ? undefined : 'false',
        maxPoints: f.maxPoints,
        limit: 200,
      })}`,
    [home, dest, source, f.direction, f.directOnly, f.includeEstimates, f.maxPoints],
  )
  const roundtripPath = useMemo(
    () =>
      `/api/deals/roundtrip${qs({
        origin: home,
        destination: dest,
        includeEstimates: f.includeEstimates ? undefined : 'false',
        limit: 100,
      })}`,
    [home, dest, f.includeEstimates],
  )

  const oneways = usePoll<OneWayDealsResponse>(onewayPath, 60_000, status?.configRevision)
  const roundtrips = usePoll<RoundtripDealsResponse>(roundtripPath, 60_000, status?.configRevision)

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">
          Qualifying deals · <b>{tab === 'oneway' ? (oneways.data?.total ?? '…') : (roundtrips.data?.total ?? '…')}</b>
        </span>
      </div>
      <div className="filters">
        <label>
          Home
          <select value={home} disabled={!ready} onChange={(e) => set({ home: e.target.value })}>
            {['', ...geo.origins].map((o) => (
              <option key={o} value={o}>
                {o || 'any'}
              </option>
            ))}
          </select>
        </label>
        <label>
          {geo.destinationLabel}
          <select value={dest} disabled={!ready} onChange={(e) => set({ dest: e.target.value })}>
            {['', ...geo.destinations].map((o) => (
              <option key={o} value={o}>
                {o || 'any'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Program
          <select value={source} disabled={!ready} onChange={(e) => set({ source: e.target.value })}>
            <option value="">any</option>
            {programOptions.map((s) => (
              <option key={s} value={s}>
                {s === ESTIMATE_SOURCE_KEY ? 'avios ~est' : s}
              </option>
            ))}
          </select>
        </label>
        {tab === 'oneway' && (
          <>
            <label>
              Direction
              <select value={f.direction} onChange={(e) => set({ direction: e.target.value })}>
                <option value="">both</option>
                <option value="outbound">to {geo.destinationLabel}</option>
                <option value="return">from {geo.destinationLabel}</option>
              </select>
            </label>
            <label>
              Max pts
              <input
                type="number"
                step={5000}
                min={0}
                placeholder={String(thresholds.onewayMaxPoints)}
                value={f.maxPoints}
                onChange={(e) => set({ maxPoints: e.target.value })}
                style={{ width: 90 }}
              />
            </label>
          </>
        )}
        <label>
          <input
            type="checkbox"
            checked={directOnly}
            disabled={!ready}
            onChange={(e) =>
              set({ directOnly: e.target.checked === geo.directOnly ? null : e.target.checked })
            }
            aria-describedby={directOnlyOverridden ? 'nonstop-override' : undefined}
          />
          nonstop only{' '}
          {directOnlyOverridden && (
            <span id="nonstop-override" className="faint">
              override · config {geo.directOnly ? 'on' : 'off'}
            </span>
          )}
        </label>
        {geo.estimatesEnabled && (
          <label>
            <input
              type="checkbox"
              checked={f.includeEstimates}
              onChange={(e) => set({ includeEstimates: e.target.checked })}
            />
            include estimates
          </label>
        )}
        <div className="subtabs">
          <button className={tab === 'oneway' ? 'active' : ''} onClick={() => setTab('oneway')}>
            One-ways
          </button>
          <button className={tab === 'roundtrip' ? 'active' : ''} onClick={() => setTab('roundtrip')}>
            Roundtrips
          </button>
        </div>
      </div>

      {tab === 'oneway' ? (
        oneways.error ? (
          <div className="error-box">{oneways.error}</div>
        ) : !oneways.data ? (
          <div className="empty">loading…</div>
        ) : oneways.data.availabilityInScope === 0 ? (
          <NoScopedDataEmpty status={status} />
        ) : (
          <OnewayTable deals={oneways.data.deals} onOpen={onOpen} />
        )
      ) : roundtrips.error ? (
        <div className="error-box">{roundtrips.error}</div>
      ) : !roundtrips.data ? (
        <div className="empty">loading…</div>
      ) : roundtrips.data.availabilityInScope === 0 ? (
        <NoScopedDataEmpty status={status} />
      ) : (
        <RoundtripTable pairs={roundtrips.data.pairs} onOpen={onOpen} onewayMaxPoints={thresholds.onewayMaxPoints} />
      )}

      {/* Mounted above the row mapping and keyed by the deal: poll refreshes can
          re-render the tables but can never remount or close an open drawer,
          and opening a different row is a fresh mount by construction. */}
      {openDeal && <DealDetail key={openDeal.dealKey} deal={openDeal} onClose={closeDrawer} />}
    </div>
  )
}
