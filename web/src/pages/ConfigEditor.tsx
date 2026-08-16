import { useEffect, useMemo, useState } from 'react'
import { useApi } from '../hooks'
import type { ConfigResponse, ConfigPutResponse, ApiError, StatusResponse } from '@shared/apiTypes'
import { configSchema, type AppConfig } from '@shared/configSchema'

type Issue = { path: string; message: string }

function issueFor(issues: Issue[], prefix: string): string | null {
  const hit = issues.find((i) => i.path === prefix || i.path.startsWith(`${prefix}.`))
  return hit ? hit.message : null
}

function Field({
  label,
  path,
  issues,
  children,
  hint,
}: {
  label: string
  path: string
  issues: Issue[]
  children: React.ReactNode
  hint?: string
}) {
  const error = issueFor(issues, path)
  return (
    <label style={{ display: 'block' }}>
      <span
        style={{
          display: 'block',
          fontFamily: 'var(--mono)',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: error ? 'var(--red)' : 'var(--text-faint)',
          marginBottom: 4,
        }}
      >
        {label}
      </span>
      {children}
      {error ? (
        <span style={{ display: 'block', color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11, marginTop: 3 }}>
          {error}
        </span>
      ) : hint ? (
        <span style={{ display: 'block', color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 10.5, marginTop: 3 }}>
          {hint}
        </span>
      ) : null}
    </label>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: 'none', padding: '16px', borderBottom: '1px solid var(--hairline)' }}>
      <legend
        style={{
          fontFamily: 'var(--sans)',
          fontWeight: 800,
          fontSize: 12,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--amber)',
          padding: 0,
          marginBottom: 12,
        }}
      >
        {title}
      </legend>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
        {children}
      </div>
    </fieldset>
  )
}

const codesToText = (codes: string[]) => codes.join(', ')
const textToCodes = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
const sourcesToCodes = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

export function ConfigEditor() {
  const remote = useApi<ConfigResponse>('/api/config')
  const status = useApi<StatusResponse>('/api/status')
  const [draft, setDraft] = useState<AppConfig | null>(null)
  const [issues, setIssues] = useState<Issue[]>([])
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  // Bumped on Discard/Save so uncontrolled (defaultValue) inputs re-initialize.
  const [formRev, setFormRev] = useState(0)

  useEffect(() => {
    if (remote.data && draft === null) setDraft(structuredClone(remote.data.config))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote.data])

  const dirty = useMemo(
    () => draft !== null && remote.data !== null && JSON.stringify(draft) !== JSON.stringify(remote.data.config),
    [draft, remote.data],
  )

  if (remote.error) return <div className="error-box">{remote.error}</div>
  if (!draft || !remote.data) return <div className="empty">loading configuration…</div>

  const set = (fn: (d: AppConfig) => void) => {
    setDraft((cur) => {
      if (!cur) return cur
      const next = structuredClone(cur)
      fn(next)
      return next
    })
  }

  const showToast = (msg: string, err = false) => {
    setToast({ msg, err })
    setTimeout(() => setToast(null), 4000)
  }

  const save = async () => {
    // Client-side validation with the SAME schema the server uses.
    const parsed = configSchema.safeParse(draft)
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
      showToast('fix the highlighted fields', true)
      return
    }
    setSaving(true)
    setIssues([])
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const body = (await res.json()) as ConfigPutResponse | ApiError
      if (!res.ok) {
        const err = body as ApiError
        setIssues(err.issues ?? [])
        showToast(err.issues?.length ? 'fix the highlighted fields' : `save failed: ${err.error}`, true)
        return
      }
      const ok = body as ConfigPutResponse
      setDraft(structuredClone(ok.config))
      setFormRev((r) => r + 1)
      remote.refetch()
      showToast('saved — applies from the next cycle')
    } catch (e) {
      showToast(`save failed: ${(e as Error).message}`, true)
    } finally {
      setSaving(false)
    }
  }

  const discard = () => {
    setDraft(structuredClone(remote.data!.config))
    setIssues([])
    setFormRev((r) => r + 1) // remounts the fields so defaultValue inputs reset
  }

  const d = draft
  const numInput = (
    value: number,
    onChange: (n: number) => void,
    opts: { step?: number; width?: number } = {},
  ) => (
    <input
      type="number"
      value={Number.isFinite(value) ? value : ''}
      step={opts.step ?? 1}
      style={{ width: opts.width ?? 120 }}
      onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
    />
  )

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">
          Configuration · <b>{remote.data.meta.path}</b>
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="action ghost" onClick={discard} disabled={!dirty || saving}>
            Discard
          </button>
          <button className="action" onClick={save} disabled={!dirty || saving}>
            {saving ? 'saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div key={formRev}>
      <Section title="Search">
        <Field label="Home cities" path="search.origins" issues={issues} hint="comma-separated IATA codes">
          <input
            type="text"
            defaultValue={codesToText(d.search.origins)}
            onBlur={(e) => set((c) => (c.search.origins = textToCodes(e.target.value)))}
          />
        </Field>
        <Field label="Tokyo airports" path="search.destinations" issues={issues} hint="comma-separated IATA codes">
          <input
            type="text"
            defaultValue={codesToText(d.search.destinations)}
            onBlur={(e) => set((c) => (c.search.destinations = textToCodes(e.target.value)))}
          />
        </Field>
        <Field label="Window start (days out)" path="search.window.startOffsetDays" issues={issues}>
          {numInput(d.search.window.startOffsetDays, (n) => set((c) => (c.search.window.startOffsetDays = n)))}
        </Field>
        <Field label="Window end (days out)" path="search.window.endOffsetDays" issues={issues} hint="capped at 355">
          {numInput(d.search.window.endOffsetDays, (n) => set((c) => (c.search.window.endOffsetDays = n)))}
        </Field>
        <Field label="Programs (sources)" path="search.sources" issues={issues} hint="aeroplan, flyingblue, qatar — add british if probe succeeds">
          <input
            type="text"
            defaultValue={d.search.sources.join(', ')}
            onBlur={(e) => set((c) => (c.search.sources = sourcesToCodes(e.target.value)))}
          />
        </Field>
        <Field label="Min seats" path="search.minSeats" issues={issues}>
          {numInput(d.search.minSeats, (n) => set((c) => (c.search.minSeats = n)), { width: 70 })}
        </Field>
        <Field label="Oneworld proxy (Avios estimates)" path="search.proxySources" issues={issues} hint="JAL/AA space via american + alaska">
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input
                type="checkbox"
                checked={d.search.proxySources.enabled}
                onChange={(e) => set((c) => (c.search.proxySources.enabled = e.target.checked))}
              />
              enabled
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input
                type="checkbox"
                checked={d.search.directOnly}
                onChange={(e) => set((c) => (c.search.directOnly = e.target.checked))}
              />
              nonstop only
            </label>
          </span>
        </Field>
      </Section>

      <Section title="Thresholds">
        <Field label="One-way max points" path="thresholds.onewayMaxPoints" issues={issues} hint="strict less-than">
          {numInput(d.thresholds.onewayMaxPoints, (n) => set((c) => (c.thresholds.onewayMaxPoints = n)), { step: 5000 })}
        </Field>
        <Field label="Roundtrip max total" path="thresholds.roundtripMaxPoints" issues={issues} hint="legs may exceed the one-way cap">
          {numInput(d.thresholds.roundtripMaxPoints, (n) => set((c) => (c.thresholds.roundtripMaxPoints = n)), { step: 5000 })}
        </Field>
        <Field label="Min stay (nights)" path="roundtrip.minStayNights" issues={issues}>
          {numInput(d.roundtrip.minStayNights, (n) => set((c) => (c.roundtrip.minStayNights = n)), { width: 70 })}
        </Field>
        <Field label="Max stay (nights)" path="roundtrip.maxStayNights" issues={issues}>
          {numInput(d.roundtrip.maxStayNights, (n) => set((c) => (c.roundtrip.maxStayNights = n)), { width: 70 })}
        </Field>
        <Field label="Same-city return" path="roundtrip.sameCityReturn" issues={issues} hint="off = open-jaw allowed">
          <input
            type="checkbox"
            checked={d.roundtrip.sameCityReturn}
            onChange={(e) => set((c) => (c.roundtrip.sameCityReturn = e.target.checked))}
          />
        </Field>
      </Section>

      <Section title="Alerts">
        <Field label="Re-alert on price drop (%)" path="alerts.realertDropPct" issues={issues} hint="vs best price ever alerted">
          {numInput(d.alerts.realertDropPct, (n) => set((c) => (c.alerts.realertDropPct = n)), { width: 70 })}
        </Field>
        <Field label="Re-alert after gone (days)" path="alerts.realertGoneDays" issues={issues}>
          {numInput(d.alerts.realertGoneDays, (n) => set((c) => (c.alerts.realertGoneDays = n)), { width: 70 })}
        </Field>
        <Field label="Max one-ways per email" path="alerts.maxOnewaysPerEmail" issues={issues}>
          {numInput(d.alerts.maxOnewaysPerEmail, (n) => set((c) => (c.alerts.maxOnewaysPerEmail = n)), { width: 70 })}
        </Field>
        <Field label="Max roundtrips per email" path="alerts.maxRoundtripsPerEmail" issues={issues}>
          {numInput(d.alerts.maxRoundtripsPerEmail, (n) => set((c) => (c.alerts.maxRoundtripsPerEmail = n)), { width: 70 })}
        </Field>
        <Field label="Detail lookups per cycle" path="alerts.maxTripLookupsPerCycle" issues={issues} hint="flight numbers/taxes/links (API quota)">
          {numInput(d.alerts.maxTripLookupsPerCycle, (n) => set((c) => (c.alerts.maxTripLookupsPerCycle = n)), { width: 70 })}
        </Field>
      </Section>

      <Section title="Polling & API">
        <Field label="Poll interval (hours)" path="poll.intervalHours" issues={issues} hint="cache refreshes a few times/day — 1-6h is sensible">
          {numInput(d.poll.intervalHours, (n) => set((c) => (c.poll.intervalHours = n)), { step: 0.5, width: 70 })}
        </Field>
        <Field label="Daily call budget" path="api.dailyCallBudget" issues={issues} hint="hard API limit is 1,000/day">
          {numInput(d.api.dailyCallBudget, (n) => set((c) => (c.api.dailyCallBudget = n)), { step: 50 })}
        </Field>
        <Field label="Reserve calls" path="api.reserveCalls" issues={issues}>
          {numInput(d.api.reserveCalls, (n) => set((c) => (c.api.reserveCalls = n)), { width: 70 })}
        </Field>
        <Field label="API base URL" path="api.baseUrl" issues={issues} hint="only change for testing">
          <input
            type="text"
            defaultValue={d.api.baseUrl}
            style={{ width: '100%' }}
            onBlur={(e) => set((c) => (c.api.baseUrl = e.target.value))}
          />
        </Field>
      </Section>

      <Section title="Email">
        <Field label="From" path="email.from" issues={issues}>
          <input
            type="text"
            defaultValue={d.email.from}
            style={{ width: '100%' }}
            onBlur={(e) => set((c) => (c.email.from = e.target.value))}
          />
        </Field>
        <Field label="To" path="email.to" issues={issues} hint="comma-separated addresses">
          <input
            type="text"
            defaultValue={d.email.to.join(', ')}
            style={{ width: '100%' }}
            onBlur={(e) =>
              set((c) => (c.email.to = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)))
            }
          />
        </Field>
        <Field label="SMTP host" path="email.smtp.host" issues={issues}>
          <input
            type="text"
            defaultValue={d.email.smtp.host}
            onBlur={(e) => set((c) => (c.email.smtp.host = e.target.value))}
          />
        </Field>
        <Field label="SMTP port" path="email.smtp.port" issues={issues}>
          {numInput(d.email.smtp.port, (n) => set((c) => (c.email.smtp.port = n)), { width: 80 })}
        </Field>
        <Field label="SMTP user" path="email.smtp.user" issues={issues}>
          <input
            type="text"
            defaultValue={d.email.smtp.user}
            onBlur={(e) => set((c) => (c.email.smtp.user = e.target.value))}
          />
        </Field>
        <Field label="SMTP password" path="_env.smtp" issues={issues}>
          <span className={status.data?.env.smtpPassword ? 'ok' : 'warn'} style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
            {status.data?.env.smtpPassword ? 'set via SMTP_PASSWORD ✓' : 'missing — set SMTP_PASSWORD in .env'}
          </span>
        </Field>
      </Section>

      <Section title="Read-only (edit config.yaml + restart)">
        <Field label="Database path" path="db.path" issues={issues}>
          <span className="dim" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{d.db.path}</span>
        </Field>
        <Field label="Server port" path="server.port" issues={issues}>
          <span className="dim" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{d.server.port}</span>
        </Field>
      </Section>

      </div>
      <div style={{ padding: '14px 16px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>
        Saves preserve the comments in your config.yaml and apply from the next cycle — interval changes re-arm the
        scheduler immediately.
      </div>

      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.msg}</div>}
    </div>
  )
}
