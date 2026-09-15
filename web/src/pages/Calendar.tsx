import { useMemo, useState } from 'react'
import { usePoll, useApi } from '../hooks'
import { qs, fmtPts, fmtDateShort } from '../api'
import { SCHEMA_DEFAULTS } from '../statusDefaults'
import type { CalendarResponse, CalendarDay, OneWayDealsResponse, StatusResponse } from '@shared/apiTypes'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

// Price bands relative to the configured one-way cap: hot (<80% of cap), good
// (80-100%), over (>=cap). The 90k default cap reproduces the original fixed
// 75k/90k bands (75k = 90k * 0.8333, close enough that the legend text below
// derives from the SAME cap rather than repeating a second hardcoded number).
const HOT_BAND_RATIO = 0.8333

function bandOf(day: CalendarDay, cap: number): string {
  if (day.minPoints === null) return ''
  if (day.minPoints < cap * HOT_BAND_RATIO) return 'band-hot'
  if (day.minPoints < cap) return 'band-good'
  return 'band-over'
}

function kFmt(n: number): string {
  return `${Math.round(n / 1000)}k`
}

interface MonthCells {
  label: string
  cells: Array<CalendarDay | null | { pad: true }>
}

function buildMonths(days: CalendarDay[]): MonthCells[] {
  const byDate = new Map(days.map((d) => [d.date, d]))
  if (days.length === 0) return []
  const first = days[0]!.date
  const last = days[days.length - 1]!.date
  const months: MonthCells[] = []
  const cursor = new Date(`${first.slice(0, 7)}-01T00:00:00`)
  const end = new Date(`${last.slice(0, 7)}-01T00:00:00`)
  while (cursor <= end) {
    const y = cursor.getFullYear()
    const m = cursor.getMonth()
    const label = cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    const firstDow = new Date(y, m, 1).getDay()
    const daysInMonth = new Date(y, m + 1, 0).getDate()
    const cells: MonthCells['cells'] = []
    for (let i = 0; i < firstDow; i++) cells.push({ pad: true })
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      cells.push(byDate.get(iso) ?? null)
    }
    months.push({ label, cells })
    cursor.setMonth(m + 1)
  }
  return months
}

function DayDetail({
  date,
  direction,
  home,
  dest,
  onewayMaxPoints,
}: {
  date: string
  direction: string
  home: string
  dest: string
  onewayMaxPoints: number
}) {
  const path = `/api/deals/oneway${qs({ from: date, to: date, direction, home, dest, maxPoints: 10_000_000, limit: 50, sort: 'points' })}`
  const detail = useApi<OneWayDealsResponse>(path)
  return (
    <div className="day-detail">
      <div className="panel-head">
        <span className="panel-title">
          {fmtDateShort(date)} · <b>{detail.data?.total ?? '…'}</b> priced option
          {detail.data?.total === 1 ? '' : 's'} (all price levels)
        </span>
      </div>
      {detail.error ? (
        <div className="error-box">{detail.error}</div>
      ) : (detail.data?.deals.length ?? 0) === 0 ? (
        <div className="empty">no priced availability recorded for this date</div>
      ) : (
        <table className="board">
          <thead>
            <tr>
              <th>Route</th>
              <th>Program</th>
              <th className="num">Points</th>
              <th>Seats</th>
              <th>Airline</th>
            </tr>
          </thead>
          <tbody>
            {detail.data!.deals.map((d) => (
              <tr key={d.key}>
                <td className="route">
                  {d.origin}
                  <span className="arrow">→</span>
                  {d.destination}
                </td>
                <td>
                  {d.program} {d.isEstimate && <span className="badge est">~est</span>}
                </td>
                <td className={d.points >= onewayMaxPoints ? 'pts over' : 'pts'}>{fmtPts(d.points)}</td>
                <td className="dim">{d.seats === null || d.seats === 0 ? '—' : d.seats}</td>
                <td className="dim">
                  {d.airlines || '?'} {d.direct ? <span className="badge direct">nonstop</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function Calendar({ status = null }: { status?: StatusResponse | null }) {
  const [direction, setDirection] = useState<'outbound' | 'return'>('outbound')
  const [home, setHome] = useState('')
  const [dest, setDest] = useState('')
  const geo = status?.search ?? SCHEMA_DEFAULTS.search
  const cap = (status?.thresholds ?? SCHEMA_DEFAULTS.thresholds).onewayMaxPoints
  const ready = status !== null
  const [selected, setSelected] = useState<string | null>(null)

  // The API's origin/destination are literal ends of the leg; the dropdowns are
  // home city and destination airport, so they swap roles with the direction.
  const homeSel = geo.origins.includes(home) ? home : ''
  const destSel = geo.destinations.includes(dest) ? dest : ''
  const path = `/api/availability/calendar${qs({
    direction,
    ...(direction === 'outbound' ? { origin: homeSel, destination: destSel } : { origin: destSel, destination: homeSel }),
  })}`
  const cal = usePoll<CalendarResponse>(path, 120_000, status?.configRevision)
  const months = useMemo(() => buildMonths(cal.data?.days ?? []), [cal.data])

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">
          Cheapest business award by date · <b>{direction === 'outbound' ? `to ${geo.destinationLabel}` : `from ${geo.destinationLabel}`}</b>
        </span>
      </div>
      <div className="filters">
        <div className="subtabs" style={{ marginLeft: 0 }}>
          <button className={direction === 'outbound' ? 'active' : ''} onClick={() => setDirection('outbound')}>
            To {geo.destinationLabel}
          </button>
          <button className={direction === 'return' ? 'active' : ''} onClick={() => setDirection('return')}>
            From {geo.destinationLabel}
          </button>
        </div>
        <label>
          Home
          <select value={homeSel} disabled={!ready} onChange={(e) => setHome(e.target.value)}>
            {['', ...geo.origins].map((o) => (
              <option key={o} value={o}>
                {o || 'any'}
              </option>
            ))}
          </select>
        </label>
        <label>
          {geo.destinationLabel}
          <select value={destSel} disabled={!ready} onChange={(e) => setDest(e.target.value)}>
            {['', ...geo.destinations].map((o) => (
              <option key={o} value={o}>
                {o || 'any'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {cal.error ? (
        <div className="error-box">{cal.error}</div>
      ) : !cal.data ? (
        <div className="empty">loading…</div>
      ) : cal.data.availabilityInScope === 0 ? (
        <div className="empty">no availability fetched yet for this configuration — run a cycle first</div>
      ) : months.length === 0 ? (
        <div className="empty">no priced availability in this window</div>
      ) : (
        <>
          <div className="cal-months">
            {months.map((m) => (
              <div className="cal-month" key={m.label}>
                <h4>{m.label}</h4>
                <div className="cal-grid">
                  {DOW.map((d, i) => (
                    <div className="cal-dow" key={`${d}-${i}`}>
                      {d}
                    </div>
                  ))}
                  {m.cells.map((cell, i) => {
                    if (cell && 'pad' in cell) return <div key={i} />
                    if (cell === null) return <div key={i} className="cal-day" />
                    const day = cell
                    const dayNum = parseInt(day.date.slice(8), 10)
                    return (
                      <div
                        key={day.date}
                        className={`cal-day ${bandOf(day, cap)} ${day.minPointsIsEstimate ? 'est-marker' : ''} ${
                          selected === day.date ? 'selected' : ''
                        }`}
                        title={
                          day.minPoints !== null
                            ? `${day.date}: from ${fmtPts(day.minPoints)} pts (${day.cheapestSource ?? '?'})${day.minPointsIsEstimate ? ' — estimated' : ''}`
                            : `${day.date}: no priced availability`
                        }
                        onClick={() =>
                          day.minPoints !== null && setSelected(selected === day.date ? null : day.date)
                        }
                      >
                        <span className="d">{dayNum}</span>
                        {day.minPoints !== null && <span className="p">{kFmt(day.minPoints)}</span>}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="cal-legend">
            <span>
              <span className="chip" style={{ background: 'rgba(61,220,132,0.28)' }} />
              under {kFmt(cap * HOT_BAND_RATIO)}
            </span>
            <span>
              <span className="chip" style={{ background: 'rgba(61,220,132,0.13)' }} />
              {kFmt(cap * HOT_BAND_RATIO)}–{kFmt(cap)}
            </span>
            <span>
              <span className="chip" style={{ background: 'rgba(255,255,255,0.045)' }} />
              {kFmt(cap)} and up
            </span>
            <span>
              <span className="chip" style={{ outline: '1px dashed var(--amber-dim)', outlineOffset: -1 }} />
              estimated pricing
            </span>
            <span className="faint">numbers show the cheapest program price that day · click a day for detail</span>
          </div>
        </>
      )}

      {selected && (
        <DayDetail date={selected} direction={direction} home={homeSel} dest={destSel} onewayMaxPoints={cap} />
      )}
    </div>
  )
}
