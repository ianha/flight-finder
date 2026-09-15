import { usePoll, useHashRoute } from './hooks'
import type { StatusResponse } from '@shared/apiTypes'
import { SCHEMA_DEFAULTS } from './statusDefaults'
import { Dashboard } from './pages/Dashboard'
import { Calendar } from './pages/Calendar'
import { Status } from './pages/Status'
import { ConfigEditor } from './pages/ConfigEditor'

const TABS = [
  { route: 'deals', label: 'Deals' },
  { route: 'calendar', label: 'Calendar' },
  { route: 'config', label: 'Config' },
  { route: 'status', label: 'Status' },
]

export function App() {
  const route = useHashRoute('deals')
  const status = usePoll<StatusResponse>('/api/status', 10_000)
  // Fallback covers the first render before /api/status answers — the schema's
  // own default, so it matches what a fresh config.yaml would actually produce.
  const destinationLabel = (status.data?.search ?? SCHEMA_DEFAULTS.search).destinationLabel

  const inFlight = status.data?.cycleInFlight ?? null
  const lastStatus = status.data?.lastCycle?.status
  const pulseClass = inFlight ? 'pulse running' : lastStatus === 'error' ? 'pulse error' : 'pulse'
  const pulseText = inFlight
    ? `cycle running (${inFlight.trigger})`
    : status.error
      ? 'api unreachable'
      : lastStatus
        ? `idle · last ${lastStatus}`
        : 'idle'

  return (
    <>
      <header className="masthead">
        <div className="wordmark">
          <span className="dot" aria-hidden="true" />
          <span>{destinationLabel}&nbsp;J</span>
          <span className="sub">DEAL FINDER</span>
        </div>
        <nav className="nav">
          {TABS.map((t) => (
            <a key={t.route} href={`#/${t.route}`} className={route === t.route ? 'active' : ''}>
              {t.label}
            </a>
          ))}
        </nav>
        <div className={pulseClass} title={pulseText}>
          <span className="lamp" aria-hidden="true" />
          <span>{pulseText}</span>
        </div>
      </header>

      {route === 'calendar' ? (
        <Calendar status={status.data} />
      ) : route === 'status' ? (
        <Status status={status} />
      ) : route === 'config' ? (
        <ConfigEditor />
      ) : (
        <Dashboard apiKeyPresent={status.data?.env.seatsAeroApiKey ?? true} status={status.data} />
      )}

      <footer className="attribution">
        <span>
          Award availability data provided by{' '}
          <a href="https://seats.aero" target="_blank" rel="noreferrer">
            seats.aero
          </a>
        </span>
        <span>cached data can be stale — verify on the program site before planning</span>
      </footer>
    </>
  )
}
