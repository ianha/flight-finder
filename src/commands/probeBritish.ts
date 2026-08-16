import type { GlobalOpts } from '../cli.js'
import { loadConfig, readEnvSecrets, deriveWindow } from '../config.js'
import { SeatsAeroClient, BadRequestError } from '../seatsAero.js'
import { ATTRIBUTION, ATTRIBUTION_URL } from '../shared/constants.js'

/**
 * BA Avios ('british') is a seats.aero website beta with no documented Partner API
 * source id. This probe answers empirically whether the API accepts it — if yes,
 * add 'british' to search.sources in config.yaml and BA pricing stops being an
 * estimate; if no, the american/alaska proxy estimates remain the fallback.
 */
export async function probeBritishCommand(g: GlobalOpts): Promise<void> {
  const cfg = loadConfig(g.config)
  const secrets = readEnvSecrets()
  if (!secrets.seatsAeroApiKey) {
    throw new Error('SEATS_AERO_API_KEY is not set — copy .env.example to .env and fill it in')
  }
  const client = new SeatsAeroClient({ baseUrl: cfg.api.baseUrl, apiKey: secrets.seatsAeroApiKey })
  const window = deriveWindow(cfg)

  console.log(`Probing sources=british on the configured grid (${window.startDate} → ${window.endDate})…`)
  try {
    const result = await client.search({
      origins: cfg.search.origins,
      destinations: cfg.search.destinations,
      sources: ['british'],
      startDate: window.startDate,
      endDate: window.endDate,
      direction: 'outbound',
    })
    if (result.records.length > 0) {
      console.log(
        `SUPPORTED: ${result.records.length} records returned (${result.pages} pages). ` +
          `Add 'british' to search.sources in config.yaml to track BA Avios directly.`,
      )
      const sample = result.records.slice(0, 5)
      for (const r of sample) {
        console.log(
          `  ${r.origin} → ${r.destination} ${r.date}: J ${r.jAvailable ? (r.jMileageCost ?? '?') : 'not available'}`,
        )
      }
    } else {
      console.log(
        'ACCEPTED BUT EMPTY: the API accepted sources=british but returned no records for the grid. ' +
          'BA data may not cover these routes (or the beta is not exposed to the API). Keep the proxy estimates.',
      )
    }
  } catch (err) {
    if (err instanceof BadRequestError) {
      console.log(
        "NOT SUPPORTED: the API rejected sources=british (400). BA Avios stays estimate-only via the american/alaska proxies.",
      )
    } else {
      console.log(`ERROR: ${(err as Error).message} — inconclusive, try again later.`)
    }
  }
  console.log(`${ATTRIBUTION} (${ATTRIBUTION_URL})`)
}
