// Minimal seats.aero Partner API stand-in for keyless end-to-end testing.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type MockMode = 'ok' | 'error400' | 'error429' | 'flaky500'

export interface MockServerOptions {
  /** Sequential pages returned by /search (one per call, in order). Key by direction via originsOf first param. */
  searchPages?: Record<string, unknown>[]
  /** Pages keyed by origin_airport param value — used when outbound and return need different data. */
  searchPagesByOrigin?: Record<string, Record<string, unknown>[]>
  trips?: Record<string, unknown>
  routes?: Record<string, unknown[]>
  /** Number of leading requests that fail with 500 in flaky500 mode. */
  flakyFailures?: number
}

export interface RequestLogEntry {
  path: string
  endpoint: 'search' | 'trips' | 'routes' | 'other'
}

export interface MockServer {
  url: string
  requests: RequestLogEntry[]
  setMode(mode: MockMode): void
  close(): Promise<void>
}

export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  let mode: MockMode = 'ok'
  let flakyRemaining = opts.flakyFailures ?? 2
  let rateLimitRemaining = 900
  const requests: RequestLogEntry[] = []
  const searchCallsByKey = new Map<string, number>()

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const endpoint = path.startsWith('/search')
      ? 'search'
      : path.startsWith('/trips')
        ? 'trips'
        : path.startsWith('/routes')
          ? 'routes'
          : 'other'
    requests.push({ path: `${path}${url.search}`, endpoint })
    rateLimitRemaining--

    const json = (status: number, body: unknown) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-ratelimit-remaining': String(Math.max(rateLimitRemaining, 0)),
      })
      res.end(JSON.stringify(body))
    }

    if (mode === 'error400') return json(400, {})
    if (mode === 'error429') return json(429, {})
    if (mode === 'flaky500' && flakyRemaining > 0) {
      flakyRemaining--
      return json(503, { error: 'flaky' })
    }

    if (endpoint === 'search') {
      const originKey = url.searchParams.get('origin_airport') ?? ''
      const pages = opts.searchPagesByOrigin?.[originKey] ?? opts.searchPages ?? []
      const call = searchCallsByKey.get(originKey) ?? 0
      searchCallsByKey.set(originKey, call + 1)
      const page = pages[Math.min(call, Math.max(pages.length - 1, 0))] ?? {
        data: [],
        count: 0,
        hasMore: false,
      }
      return json(200, page)
    }

    if (endpoint === 'trips') {
      const id = path.split('/')[2] ?? ''
      const trip = opts.trips?.[id]
      if (!trip) return json(404, {})
      return json(200, trip)
    }

    if (endpoint === 'routes') {
      const source = url.searchParams.get('source') ?? ''
      return json(200, opts.routes?.[source] ?? [])
    }

    return json(404, {})
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setMode: (m) => {
      mode = m
    },
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}
