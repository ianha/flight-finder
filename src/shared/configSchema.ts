// The single source of truth for configuration shape and defaults.
// Shared between the Node service and the web frontend — keep free of Node imports.
import { z } from 'zod'
import { HARD_MAX_WINDOW_DAYS, PROXY_PRICED_SOURCES } from './constants.js'

const airportCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be a 3-letter uppercase IATA code (e.g. YYZ)')

const sourceId = z
  .string()
  .regex(/^[a-z]+$/, 'must be a lowercase seats.aero source id (e.g. aeroplan)')

const e164Phone = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, 'must be an E.164 phone number (e.g. +14165551234)')

export const configSchema = z
  .object({
    api: z
      .object({
        baseUrl: z.url().default('https://seats.aero/partnerapi'),
        dailyCallBudget: z.number().int().min(1).max(1000).default(900),
        reserveCalls: z.number().int().min(0).max(500).default(50),
      })
      .prefault({}),
    search: z
      .object({
        origins: z.array(airportCode).min(1).default(['YYZ', 'ORD', 'YVR', 'LAX']),
        destinations: z.array(airportCode).min(1).default(['NRT', 'HND']),
        /** Friendly name for the destination, used in UI labels and the SMS header. */
        destinationLabel: z.string().trim().min(1).max(40).default('Tokyo'),
        window: z
          .object({
            startOffsetDays: z.number().int().min(0).default(0),
            // Hard product cap: award calendars only open ~330-360 days out.
            endOffsetDays: z
              .number()
              .int()
              .min(1)
              .transform((v) => Math.min(v, HARD_MAX_WINDOW_DAYS))
              .default(HARD_MAX_WINDOW_DAYS),
          })
          .prefault({}),
        sources: z.array(sourceId).min(1).default(['aeroplan', 'flyingblue', 'qatar']),
        proxySources: z
          .object({
            enabled: z.boolean().default(true),
            sources: z.array(sourceId).default(['american', 'alaska']),
          })
          .prefault({}),
        directOnly: z.boolean().default(false),
        minSeats: z.number().int().min(1).max(9).default(1),
      })
      .prefault({}),
    thresholds: z
      .object({
        // Both thresholds are strict less-than.
        onewayMaxPoints: z.number().int().min(1).default(90_000),
        roundtripMaxPoints: z.number().int().min(1).default(180_000),
      })
      .prefault({}),
    roundtrip: z
      .object({
        minStayNights: z.number().int().min(0).max(300).default(3),
        maxStayNights: z.number().int().min(1).max(300).default(21),
        sameCityReturn: z.boolean().default(false),
      })
      .prefault({}),
    alerts: z
      .object({
        mode: z.literal('digest').default('digest'),
        realertDropPct: z.number().min(0).max(100).default(15),
        realertGoneDays: z.number().int().min(1).default(7),
        // Per-alert caps sized for SMS: overflow is summarized as "+N more"
        // and un-alerted overflow resurfaces next cycle.
        maxOnewaysPerAlert: z.number().int().min(1).default(8),
        maxRoundtripsPerAlert: z.number().int().min(1).default(4),
        maxTripLookupsPerCycle: z.number().int().min(0).default(25),
      })
      .prefault({}),
    poll: z
      .object({
        intervalHours: z.number().min(0.25).max(24).default(2),
      })
      .prefault({}),
    sms: z
      .object({
        // Empty defaults = "not configured yet": the service still runs (deals
        // visible in the console) but sends nothing until both are set.
        to: z.array(e164Phone).default([]),
        from: z.union([e164Phone, z.literal('')]).default(''),
        // Twilio splits long texts into segments (billed each); the digest is
        // truncated with "+N more" to stay within this many.
        maxSegments: z.number().int().min(1).max(10).default(3),
      })
      .prefault({}),
    // Read-only via the web UI (require manual edit + restart).
    db: z.object({ path: z.string().min(1).default('./data/deals.db') }).prefault({}),
    server: z.object({ port: z.number().int().min(1).max(65535).default(8787) }).prefault({}),
  })
  .refine((c) => c.roundtrip.maxStayNights >= c.roundtrip.minStayNights, {
    message: 'maxStayNights must be >= minStayNights',
    path: ['roundtrip', 'maxStayNights'],
  })
  .refine((c) => c.thresholds.roundtripMaxPoints >= c.thresholds.onewayMaxPoints, {
    message: 'roundtripMaxPoints must be >= onewayMaxPoints',
    path: ['thresholds', 'roundtripMaxPoints'],
  })
  .refine(
    (c) =>
      !c.search.sources.some(
        (s) =>
          c.search.proxySources.sources.includes(s) ||
          (PROXY_PRICED_SOURCES as readonly string[]).includes(s),
      ),
    {
      message:
        'proxy-priced sources (american/alaska) must not appear in search.sources — their records are priced via estimated Avios, never their own mileage cost',
      path: ['search', 'sources'],
    },
  )

export type AppConfig = z.output<typeof configSchema>
export type AppConfigInput = z.input<typeof configSchema>
