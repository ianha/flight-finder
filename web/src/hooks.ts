import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet } from './api'

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

/** Fetch on an interval (background refresh keeps stale data visible). */
export function usePoll<T>(path: string, intervalMs: number): ApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let alive = true
    const fetchOnce = () => {
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
    }
    fetchOnce()
    timer.current = setInterval(fetchOnce, intervalMs)
    return () => {
      alive = false
      if (timer.current) clearInterval(timer.current)
    }
  }, [path, intervalMs, tick])

  const refetch = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, refetch }
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
