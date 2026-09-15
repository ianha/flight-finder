import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet } from './api'
import type { TripDetailOkResponse } from '@shared/apiTypes'

export interface ApiState<T> {
  data: T | null
  error: string | null
  loading: boolean
  refetch: () => void
}

/** Fetch once (and on demand). */
export function useApi<T>(path: string): ApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    apiGet<T>(path)
      .then((d) => {
        if (!alive) return
        setData(d)
        setError(null)
      })
      .catch((e: Error) => {
        if (!alive) return
        setError(e.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [path, tick])

  const refetch = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, refetch }
}

/**
 * Fetch on an interval (background refresh keeps stale data visible).
 * `revision`, when given, joins `path` in the effect deps — a config change
 * (surfaced via /api/status's configRevision) triggers an immediate refetch
 * and restarts the interval, without waiting out the rest of the current
 * `intervalMs`. Pass a primitive string, never an object — an object that is
 * freshly parsed on every status poll would itself retrigger this effect and
 * turn `intervalMs` polling into 10s polling.
 */
export function usePoll<T>(path: string, intervalMs: number, revision?: string): ApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let alive = true
    let seq = 0
    const controller = new AbortController()
    const fetchOnce = () => {
      const mySeq = ++seq
      apiGet<T>(path, controller.signal)
        .then((d) => {
          if (!alive || mySeq !== seq) return
          setData(d)
          setError(null)
        })
        .catch((e: Error) => {
          if (e.name === 'AbortError' || !alive || mySeq !== seq) return
          setError(e.message)
        })
        .finally(() => {
          if (alive && mySeq === seq) setLoading(false)
        })
    }
    fetchOnce()
    timer.current = setInterval(fetchOnce, intervalMs)
    return () => {
      alive = false
      controller.abort()
      if (timer.current) clearInterval(timer.current)
    }
  }, [path, intervalMs, tick, revision])

  const refetch = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, refetch }
}

// --- trip detail (deal drawer) ---

export type TripDetailState =
  | { kind: 'loading' }
  | { kind: 'ok'; body: TripDetailOkResponse }
  /** 200 but zero business-cabin options — the fare vanished between snapshot and click. */
  | { kind: 'empty'; body: TripDetailOkResponse }
  | { kind: 'no_api_key' }
  | { kind: 'quota_exhausted' }
  | { kind: 'expired' }
  | { kind: 'upstream_error' }

/**
 * One-shot fetch of /api/trips/:id (never polled — every upstream miss costs
 * API quota). The in-flight request is aborted on unmount/re-key so an
 * abandoned drawer can't write state, and AbortError is silence, not an error.
 */
export function useTripDetail(availabilityId: string): { state: TripDetailState; retry: () => void } {
  const [state, setState] = useState<TripDetailState>({ kind: 'loading' })
  const [tick, setTick] = useState(0)
  const inFlight = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    inFlight.current = true
    setState({ kind: 'loading' })
    fetch(`/api/trips/${encodeURIComponent(availabilityId)}`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as unknown
        if (res.ok) {
          const ok = body as TripDetailOkResponse
          setState(ok.options.length > 0 ? { kind: 'ok', body: ok } : { kind: 'empty', body: ok })
          return
        }
        const error =
          body !== null && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : ''
        if (error === 'no_api_key') setState({ kind: 'no_api_key' })
        else if (error === 'expired' || res.status === 404) setState({ kind: 'expired' })
        else if (error === 'quota_exhausted' || res.status === 503) setState({ kind: 'quota_exhausted' })
        else setState({ kind: 'upstream_error' })
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setState({ kind: 'upstream_error' })
      })
      .finally(() => {
        inFlight.current = false
      })
    return () => controller.abort()
  }, [availabilityId, tick])

  const retry = useCallback(() => {
    if (!inFlight.current) setTick((t) => t + 1)
  }, [])
  return { state, retry }
}

/** Tiny hash router: '#/deals' → 'deals'. */
export function useHashRoute(defaultRoute: string): string {
  const read = () => window.location.hash.replace(/^#\//, '') || defaultRoute
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onChange = () => setRoute(read())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return route
}
