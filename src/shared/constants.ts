// Shared between the Node service and the web frontend — keep free of Node imports.

// Required visibly by the seats.aero Pro API terms of use.
export const ATTRIBUTION = 'Award availability data provided by seats.aero'
export const ATTRIBUTION_URL = 'https://seats.aero'

// Documented Partner API source identifiers (developers.seats.aero/reference/concepts-copy),
// plus 'british' which exists on the website in beta and is probed empirically (`deal-finder probe-british`).
export const KNOWN_SOURCES = [
  'aeroplan',
  'flyingblue',
  'qatar',
  'american',
  'alaska',
  'british',
  'finnair',
  'aeromexico',
  'azul',
  'connectmiles',
  'delta',
  'emirates',
  'ethiopian',
  'etihad',
  'eurobonus',
  'frontier',
  'jetblue',
  'lufthansa',
  'qantas',
  'saudia',
  'singapore',
  'smiles',
  'spirit',
  'turkish',
  'united',
  'velocity',
  'virginatlantic',
] as const

// Sources whose availability is priced in another program's currency by this app:
// american/alaska records surface oneworld (JAL/AA) space that is bookable with BA or
// Qatar Avios, so their own mileage cost is replaced by an estimated Avios price.
export const PROXY_PRICED_SOURCES = ['american', 'alaska'] as const

export const HARD_MAX_WINDOW_DAYS = 355

export const APP_VERSION = '0.1.0'
