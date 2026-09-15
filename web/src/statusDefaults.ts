import { configSchema } from '@shared/configSchema'
import { statusConfigProjection } from '@shared/statusProjection'

/**
 * Schema defaults for the config-derived fields the console needs before
 * /api/status answers — the SAME projection function buildStatus uses
 * server-side, so this can never drift from what a real config would produce.
 * Controls that read these values stay `disabled` until real status data
 * arrives (Dashboard/Calendar `ready`), so this is a display fallback only,
 * never a value a user can act on.
 */
export const SCHEMA_DEFAULTS = statusConfigProjection(configSchema.parse({}))
