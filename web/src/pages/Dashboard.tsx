import { useMemo, useState } from 'react'
import { usePoll } from '../hooks'
import { qs, fmtPts, fmtDateShort, ageOf } from '../api'
import type {
  OneWayDealsResponse,
  RoundtripDealsResponse,
  DealLegDto,
  OneWayDealDto,
  RoundtripDealDto,
} from '@shared/apiTypes'

const ORIGINS = ['', 'YYZ', 'ORD', 'YVR', 'LAX', 'NRT', 'HND']
const SOURCES = ['', 'aeroplan', 'flyingblue', 'qatar', 'american', 'alaska', 'british']

interface Filters {
  origin: string
  source: string
  direction: string
  directOnly: boolean
  includeEstimates: boolean
  maxPoints: string
}

const DEFAULT_FILTERS: Filters = {
  origin: '',
  source: '',
  direction: '',
  directOnly: false,
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

function OnewayTable({ deals }: { deals: OneWayDealDto[] }) {
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
        </tr>
      </thead>
      <tbody>
        {deals.map((d) => (
          <tr key={d.key}>
            <LegCells leg={d} />
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RoundtripTable({ pairs }: { pairs: RoundtripDealDto[] }) {
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
        </tr>
      </thead>
      <tbody>
        {pairs.flatMap((p) => {
          const legs: Array<{ label: string; leg: DealLegDto }> = [
            { label: 'out', leg: p.outbound },
            { label: 'back', leg: p.inbound },
          ]
          return legs.map(({ label, leg }, i) => (
            <tr key={`${p.key}-${label}`}>
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
              <td className={leg.points >= 90_000 ? 'pts over' : 'pts'}>{fmtPts(leg.points)}</td>
              <td className="dim">{leg.airlines || '?'}</td>
              <td>
                <StaleAge iso={leg.apiUpdatedAt} />
              </td>
            </tr>
          ))
        })}
      </tbody>
    </table>
  )
}

export function Dashboard() {
  const [tab, setTab] = useState<'oneway' | 'roundtrip'>('oneway')
  const [f, setF] = useState<Filters>(DEFAULT_FILTERS)

  const onewayPath = useMemo(
    () =>
      `/api/deals/oneway${qs({
        origin: f.origin,
        source: f.source,
        direction: f.direction,
        directOnly: f.directOnly ? 'true' : undefined,
        includeEstimates: f.includeEstimates ? undefined : 'false',
        maxPoints: f.maxPoints,
        limit: 200,
      })}`,
    [f],
  )
  const roundtripPath = useMemo(
    () =>
      `/api/deals/roundtrip${qs({
        origin: f.origin && f.origin !== 'NRT' && f.origin !== 'HND' ? f.origin : undefined,
        includeEstimates: f.includeEstimates ? undefined : 'false',
        limit: 100,
      })}`,
    [f],
  )

  const oneways = usePoll<OneWayDealsResponse>(onewayPath, 60_000)
  const roundtrips = usePoll<RoundtripDealsResponse>(roundtripPath, 60_000)

  const set = (patch: Partial<Filters>) => setF((cur) => ({ ...cur, ...patch }))

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">
          Qualifying deals · <b>{tab === 'oneway' ? (oneways.data?.total ?? '…') : (roundtrips.data?.total ?? '…')}</b>
        </span>
      </div>
      <div className="filters">
        <label>
          City
          <select value={f.origin} onChange={(e) => set({ origin: e.target.value })}>
            {ORIGINS.map((o) => (
              <option key={o} value={o}>
                {o || 'any'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Program
          <select value={f.source} onChange={(e) => set({ source: e.target.value })}>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s || 'any'}
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
                <option value="outbound">to Tokyo</option>
                <option value="return">from Tokyo</option>
              </select>
            </label>
            <label>
              Max pts
              <input
                type="number"
                step={5000}
                min={0}
                placeholder="90000"
                value={f.maxPoints}
                onChange={(e) => set({ maxPoints: e.target.value })}
                style={{ width: 90 }}
              />
            </label>
          </>
        )}
        <label>
          <input type="checkbox" checked={f.directOnly} onChange={(e) => set({ directOnly: e.target.checked })} />
          nonstop only
        </label>
        <label>
          <input
            type="checkbox"
            checked={f.includeEstimates}
            onChange={(e) => set({ includeEstimates: e.target.checked })}
          />
          include estimates
        </label>
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
        ) : (
          <OnewayTable deals={oneways.data?.deals ?? []} />
        )
      ) : roundtrips.error ? (
        <div className="error-box">{roundtrips.error}</div>
      ) : (
        <RoundtripTable pairs={roundtrips.data?.pairs ?? []} />
      )}
    </div>
  )
}
