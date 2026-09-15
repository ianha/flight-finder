// The slice of AppConfig the web console needs to stop hardcoding airports,
// programs, thresholds, and defaults — named so it has one definition instead of
// drifting across buildStatus (server) and first-paint fallbacks (web). No Node
// imports: used by both src/server/queries.ts and the browser bundle.
import type { AppConfig } from './configSchema.js'
import type { StatusResponse } from './apiTypes.js'

export function statusConfigProjection(
  cfg: AppConfig,
): Pick<StatusResponse, 'search' | 'thresholds'> {
  return {
    search: {
      origins: cfg.search.origins,
      destinations: cfg.search.destinations,
      destinationLabel: cfg.search.destinationLabel,
      sources: cfg.search.sources,
      estimatesEnabled: cfg.search.proxySources.enabled,
      directOnly: cfg.search.directOnly,
    },
    thresholds: {
      onewayMaxPoints: cfg.thresholds.onewayMaxPoints,
      roundtripMaxPoints: cfg.thresholds.roundtripMaxPoints,
    },
  }
}
