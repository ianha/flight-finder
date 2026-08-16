// Builders producing raw seats.aero API-shaped objects for tests and the mock server.

let seq = 0

export interface AvailabilityOverrides {
  id?: string
  source?: string
  origin?: string
  destination?: string
  date?: string
  jAvailable?: boolean
  jMileageCost?: string | number
  jDirect?: boolean
  jDirectMileageCost?: string | number
  jRemainingSeats?: number | null
  jAirlines?: string
  jDirectAirlines?: string
  distance?: number
  updatedAt?: string
}

export function makeAvailability(over: AvailabilityOverrides = {}): Record<string, unknown> {
  const id = over.id ?? `avail-${++seq}`
  const origin = over.origin ?? 'YYZ'
  const destination = over.destination ?? 'NRT'
  return {
    ID: id,
    RouteID: `route-${origin}-${destination}`,
    Route: {
      ID: `route-${origin}-${destination}`,
      OriginAirport: origin,
      DestinationAirport: destination,
      OriginRegion: 'North America',
      DestinationRegion: 'Asia',
      NumDaysOut: 355,
      Distance: over.distance ?? 6430,
      Source: over.source ?? 'aeroplan',
    },
    Date: over.date ?? '2026-11-05',
    ParsedDate: `${over.date ?? '2026-11-05'}T00:00:00Z`,
    Source: over.source ?? 'aeroplan',
    CreatedAt: '2026-08-15T10:00:00Z',
    UpdatedAt: over.updatedAt ?? '2026-08-15T12:00:00Z',
    JAvailable: over.jAvailable ?? true,
    // The real API returns mileage costs as strings.
    JMileageCost: over.jMileageCost !== undefined ? String(over.jMileageCost) : '87500',
    JDirect: over.jDirect ?? true,
    JDirectMileageCost:
      over.jDirectMileageCost !== undefined
        ? String(over.jDirectMileageCost)
        : over.jMileageCost !== undefined
          ? String(over.jMileageCost)
          : '87500',
    JRemainingSeats: over.jRemainingSeats === undefined ? 2 : over.jRemainingSeats,
    JDirectRemainingSeats: over.jRemainingSeats === undefined ? 2 : over.jRemainingSeats,
    JAirlines: over.jAirlines ?? 'NH',
    JDirectAirlines: over.jDirectAirlines ?? over.jAirlines ?? 'NH',
    YAvailable: true,
    YMileageCost: '55000',
    ExtraFutureField: 'ignored',
  }
}

export function makeTrip(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ID: `trip-${++seq}`,
    RouteID: 'route-YYZ-NRT',
    AvailabilityID: 'avail-1',
    TotalDuration: 815,
    Stops: 0,
    Carriers: 'ANA',
    RemainingSeats: 2,
    MileageCost: '62500',
    TotalTaxes: 11200,
    TaxesCurrency: 'CAD',
    TaxesCurrencySymbol: '$',
    FlightNumbers: 'NH116',
    DepartsAt: '2026-11-05T17:15:00Z',
    ArrivesAt: '2026-11-06T19:50:00Z',
    Cabin: 'business',
    Source: 'aeroplan',
    ...over,
  }
}

export function searchPage(
  data: Record<string, unknown>[],
  opts: { hasMore?: boolean; cursor?: number } = {},
): Record<string, unknown> {
  return {
    data,
    count: data.length,
    hasMore: opts.hasMore ?? false,
    cursor: opts.cursor ?? 1755230000,
  }
}
