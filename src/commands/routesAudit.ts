import type { GlobalOpts } from '../cli.js'
import { loadConfig, readEnvSecrets } from '../config.js'
import { SeatsAeroClient } from '../seatsAero.js'
import { ATTRIBUTION, ATTRIBUTION_URL } from '../shared/constants.js'

/**
 * Setup-time audit: for every configured source, how far out does seats.aero
 * actually crawl each grid route (Route.NumDaysOut)? Warns where coverage falls
 * short of the configured window.
 */
export async function routesAuditCommand(g: GlobalOpts): Promise<void> {
  const cfg = loadConfig(g.config)
  const secrets = readEnvSecrets()
  if (!secrets.seatsAeroApiKey) {
    throw new Error('SEATS_AERO_API_KEY is not set — copy .env.example to .env and fill it in')
  }
  const client = new SeatsAeroClient({ baseUrl: cfg.api.baseUrl, apiKey: secrets.seatsAeroApiKey })

  const sources = [
    ...cfg.search.sources,
    ...(cfg.search.proxySources.enabled ? cfg.search.proxySources.sources : []),
  ]
  const gridPairs = new Set<string>()
  for (const o of cfg.search.origins) {
    for (const d of cfg.search.destinations) {
      gridPairs.add(`${o}-${d}`)
      gridPairs.add(`${d}-${o}`)
    }
  }

  const wantedDays = cfg.search.window.endOffsetDays
  let warnings = 0
  for (const source of sources) {
    console.log(`\n${source}:`)
    let routes
    try {
      routes = await client.getRoutes(source)
    } catch (err) {
      console.log(`  ERROR fetching routes: ${(err as Error).message}`)
      continue
    }
    const relevant = routes.filter((r) => gridPairs.has(`${r.origin}-${r.destination}`))
    if (relevant.length === 0) {
      console.log('  no grid routes crawled for this source')
      warnings++
      continue
    }
    for (const r of relevant.sort((a, b) => (a.origin + a.destination).localeCompare(b.origin + b.destination))) {
      const days = r.numDaysOut ?? 0
      const flag = days < wantedDays ? `  ⚠ short of the ${wantedDays}-day window` : ''
      if (days < wantedDays) warnings++
      console.log(`  ${r.origin} → ${r.destination}: crawled ${days} days out${flag}`)
    }
  }

  console.log(
    warnings > 0
      ? `\n${warnings} route(s) fall short of the configured window — deals beyond their horizon cannot be seen.`
      : '\nAll grid routes cover the configured window.',
  )
  console.log(`${ATTRIBUTION} (${ATTRIBUTION_URL})`)
}
