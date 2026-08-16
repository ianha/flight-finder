import { useState } from 'react'
import { usePoll, type ApiState } from '../hooks'
import { apiPost, fmtPts, ageOf } from '../api'
import type {
  StatusResponse,
  CyclesResponse,
  AlertsResponse,
  RunStartedResponse,
} from '@shared/apiTypes'

function QuotaCard({ status }: { status: StatusResponse }) {
  const { used, budget, reserve, headerRemaining, dayUtc } = status.quota
  const pct = Math.min((used / budget) * 100, 100)
  const cls = pct > 85 ? 'crit' : pct > 60 ? 'warn' : ''
  const resetIn = (() => {
    const now = new Date()
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    const h = (midnight - now.getTime()) / 3_600_000
    return `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`
  })()
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">API quota</span>
      </div>
      <div className="stat-block">
        <div className="stat-label">calls used · UTC {dayUtc}</div>
        <div className="stat-value">
          {used} <small>/ {budget} budget · reserve {reserve}</small>
        </div>
        <div className="meter">
          <div className={`fill ${cls}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <dl className="kv">
        <dt>API-reported remaining</dt>
        <dd>{headerRemaining ?? '—'}</dd>
        <dt>quota resets</dt>
        <dd>in {resetIn}</dd>
      </dl>
    </div>
  )
}

function SchedulerCard({
  status,
  refetchStatus,
}: {
  status: StatusResponse
  refetchStatus: () => void
}) {
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null)
  const inFlight = status.cycleInFlight !== null

  const runNow = async () => {
    try {
      await apiPost<RunStartedResponse>('/api/run')
      setToast({ msg: 'cycle started', err: false })
    } catch (e) {
      const err = e as { status?: number; message: string }
      setToast({
        msg: err.status === 409 ? 'a cycle is already running' : `failed: ${err.message}`,
        err: true,
      })
    }
    refetchStatus()
    setTimeout(() => setToast(null), 3500)
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Scheduler</span>
        <div style={{ marginLeft: 'auto' }}>
          <button className="action" onClick={runNow} disabled={inFlight || !status.scheduler}>
            {inFlight ? 'running…' : 'Run now'}
          </button>
        </div>
      </div>
      <dl className="kv">
        <dt>state</dt>
        <dd className={inFlight ? 'ok' : ''}>
          {inFlight ? `cycle running (${status.cycleInFlight!.trigger})` : 'idle'}
        </dd>
        <dt>interval</dt>
        <dd>{status.scheduler ? `${status.scheduler.intervalHours}h` : 'not running (CLI mode)'}</dd>
        <dt>next scheduled run</dt>
        <dd>
          {status.scheduler?.nextRunAt ? new Date(status.scheduler.nextRunAt).toLocaleString() : '—'}
        </dd>
        <dt>last cycle</dt>
        <dd>
          {status.lastCycle ? (
            <>
              <span
                className={
                  status.lastCycle.status === 'ok'
                    ? 'ok'
                    : status.lastCycle.status === 'error'
                      ? 'err'
                      : 'warn'
                }
              >
                {status.lastCycle.status}
              </span>{' '}
              · {ageOf(status.lastCycle.at)} ago · {status.lastCycle.alertsSent} alerted
            </>
          ) : (
            'never'
          )}
        </dd>
        <dt>data rows</dt>
        <dd>{status.db.availabilityRows}</dd>
        <dt>freshest record</dt>
        <dd>{status.db.newestApiUpdatedAt ? `${ageOf(status.db.newestApiUpdatedAt)} ago` : '—'}</dd>
        <dt>SEATS_AERO_API_KEY</dt>
        <dd className={status.env.seatsAeroApiKey ? 'ok' : 'err'}>
          {status.env.seatsAeroApiKey ? 'set' : 'missing'}
        </dd>
        <dt>SMTP_PASSWORD</dt>
        <dd className={status.env.smtpPassword ? 'ok' : 'warn'}>
          {status.env.smtpPassword ? 'set' : 'missing — alerts disabled'}
        </dd>
      </dl>
      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.msg}</div>}
    </div>
  )
}

function CycleHistory() {
  const cycles = usePoll<CyclesResponse>('/api/cycles?limit=20', 15_000)
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Cycle history</span>
      </div>
      {cycles.error ? (
        <div className="error-box">{cycles.error}</div>
      ) : (cycles.data?.cycles.length ?? 0) === 0 ? (
        <div className="empty">no cycles yet</div>
      ) : (
        <table className="board">
          <thead>
            <tr>
              <th>#</th>
              <th>Started</th>
              <th>Trigger</th>
              <th>Status</th>
              <th className="num">Calls</th>
              <th className="num">Records</th>
              <th className="num">OW</th>
              <th className="num">RT</th>
              <th className="num">Alerted</th>
            </tr>
          </thead>
          <tbody>
            {cycles.data!.cycles.map((c) => (
              <tr key={c.id} title={c.errorMessage ?? undefined}>
                <td className="faint">{c.id}</td>
                <td className="dim">{new Date(c.startedAt).toLocaleString()}</td>
                <td className="dim">{c.trigger}</td>
                <td className={c.status === 'ok' ? 'ok' : c.status === 'error' ? 'err' : 'warn'}>
                  {c.status}
                </td>
                <td className="num dim">{c.callsUsed}</td>
                <td className="num dim">{c.recordsFetched}</td>
                <td className="num dim">{c.onewaysFound}</td>
                <td className="num dim">{c.roundtripsFound}</td>
                <td className="num">{c.alertsSent}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function RecentAlerts() {
  const alerts = usePoll<AlertsResponse>('/api/alerts?limit=25', 30_000)
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Alert history</span>
      </div>
      {alerts.error ? (
        <div className="error-box">{alerts.error}</div>
      ) : (alerts.data?.alerts.length ?? 0) === 0 ? (
        <div className="empty">nothing alerted yet</div>
      ) : (
        <table className="board">
          <thead>
            <tr>
              <th>Last alerted</th>
              <th>Kind</th>
              <th>Deal</th>
              <th className="num">Points</th>
              <th className="num">Times</th>
            </tr>
          </thead>
          <tbody>
            {alerts.data!.alerts.map((a) => (
              <tr key={a.dealKey}>
                <td className="dim">{new Date(a.lastAlertedAt).toLocaleString()}</td>
                <td className="dim">{a.kind}</td>
                <td className="route" style={{ whiteSpace: 'normal' }}>
                  {a.dealKey.replace(/^(OW|RT)\|/, '')}
                  {a.isEstimate && (
                    <>
                      {' '}
                      <span className="badge est">~est</span>
                    </>
                  )}
                </td>
                <td className="pts">{fmtPts(a.lastPoints)}</td>
                <td className="num dim">{a.alertCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function Status({ status }: { status: ApiState<StatusResponse> }) {
  if (status.error) return <div className="error-box">API unreachable: {status.error}</div>
  if (!status.data) return <div className="empty">loading…</div>
  return (
    <>
      <div className="grid-2">
        <QuotaCard status={status.data} />
        <SchedulerCard status={status.data} refetchStatus={status.refetch} />
      </div>
      <div style={{ height: 20 }} />
      <CycleHistory />
      <div style={{ height: 20 }} />
      <RecentAlerts />
    </>
  )
}
