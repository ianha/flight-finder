import { useMemo, useState } from 'react'
import { usePoll, useApi } from '../hooks'
import { qs, fmtPts, fmtDateShort } from '../api'
import type { CalendarResponse, CalendarDay, OneWayDealsResponse } from '@shared/apiTypes'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

// Price bands relative to the one-way threshold: hot (<75k), good (75-90k), over (>=90k).
function bandOf(day: CalendarDay): string {
  if (day.minPoints === null) return ''
  if (day.minPoints < 75_000) return 'band-hot'
  if (day.minPoints < 90_000) return 'band-good'
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

function DayDetail({ date, direction }: { date: string; direction: string }) {
  const path = `/api/deals/oneway${qs({ from: date, to: date, direction, maxPoints: 10_000_000, limit: 50, sort: 'points' })}`
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
                <td className={d.points >= 90_000 ? 'pts over' : 'pts'}>{fmtPts(d.points)}</td>
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

export function Calendar() {
  const [direction, setDirection] = useState<'outbound' | 'return'>('outbound')
  const [origin, setOrigin] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const path = `/api/availability/calendar${qs({
    direction,
    ...(direction === 'outbound' ? { origin } : { destination: origin }),
  })}`
  const cal = usePoll<CalendarResponse>(path, 120_000)
  const months = useMemo(() => buildMonths(cal.data?.days ?? []), [cal.data])

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">
          Cheapest business award by date · <b>{direction === 'outbound' ? 'to Tokyo' : 'from Tokyo'}</b>
        </span>
      </div>
      <div className="filters">
        <div className="subtabs" style={{ marginLeft: 0 }}>
          <button className={direction === 'outbound' ? 'active' : ''} onClick={() => setDirection('outbound')}>
            To Tokyo
          </button>
          <button className={direction === 'return' ? 'active' : ''} onClick={() => setDirection('return')}>
            From Tokyo
          </button>
        </div>
        <label>
          City
          <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
            {['', 'YYZ', 'ORD', 'YVR', 'LAX'].map((o) => (
              <option key={o} value={o}>
                {o || 'any'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {cal.error ? (
        <div className="error-box">{cal.error}</div>
      ) : months.length === 0 ? (
        <div className="empty">no availability data yet — run a cycle first</div>
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
                        className={`cal-day ${bandOf(day)} ${day.minPointsIsEstimate ? 'est-marker' : ''} ${
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
              under 75k
            </span>
            <span>
              <span className="chip" style={{ background: 'rgba(61,220,132,0.13)' }} />
              75–90k
            </span>
            <span>
              <span className="chip" style={{ background: 'rgba(255,255,255,0.045)' }} />
              90k and up
            </span>
            <span>
              <span className="chip" style={{ outline: '1px dashed var(--amber-dim)', outlineOffset: -1 }} />
              estimated pricing
            </span>
            <span className="faint">numbers show the cheapest program price that day · click a day for detail</span>
          </div>
        </>
      )}

      {selected && <DayDetail date={selected} direction={direction} />}
    </div>
  )
}
