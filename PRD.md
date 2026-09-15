# PRD — flight-deal-finder

Personal Tokyo business-class award deal watcher with a local web console.

## 1. Overview

flight-deal-finder is a single-user application that continuously searches for business-class award-seat availability between Toronto (YYZ), Chicago (ORD), Vancouver (YVR), Los Angeles (LAX) and Tokyo (NRT/HND), in both directions, priced in points across Aeroplan, British Airways Avios, Qatar Airways Privilege Club (Avios), and Air France/KLM Flying Blue. When it finds a qualifying deal — a one-way under 90,000 points or a roundtrip pairing under 180,000 points total — it texts the owner (SMS via Twilio), and it exposes a localhost web console for browsing deals and editing configuration. It is built for exactly one user, running on their own Mac.

## 2. Background & Motivation

Finding premium-cabin award space manually is a losing game: the search space is 8 airport pairs × 2 directions × up to 355 daily departure dates × 4+ loyalty programs, award inventory appears and vanishes hourly, and each program's website supports only one route/date query at a time. Good deals (saver-level business to Japan) are typically gone within hours of release.

The seats.aero Partner API is the only sanctioned, self-serve programmatic source for cross-program award availability (Pro subscription, ~US$10/month). Alternatives were evaluated and rejected: PointsYeah's API caches only ~61 days forward (vs. the 355-day requirement), AwardFares/Roame/point.me/AwardTool offer no usable API, and scraping airline sites directly violates their terms, fights active bot-detection, and rots constantly. This tool automates the search loop on top of seats.aero's cached-search API, applies the owner's exact thresholds, and pushes qualifying deals to their inbox.

## 3. Goals

Ranked:

1. **Never miss a qualifying deal** — every award that meets the thresholds inside the watch window is surfaced within one polling interval of appearing in the data source.
2. **Zero recurring manual effort** — after one-time setup, the service runs unattended, surviving reboots and crashes.
3. **At-a-glance visibility** — the owner can open a local web page and see current deals, a price calendar, and service health without reading logs.
4. **Configuration without editing files** — thresholds, routes, dates, and alert behavior are editable in the web UI with validation.

## 4. Non-Goals / Out of Scope

- Booking or holding awards automatically (alerts link out; booking is manual).
- Live availability verification (Pro API is cached-only; final verification happens on the program's own site).
- Multi-user support, authentication, or remote/cloud hosting.
- Mobile apps or additional notification channels (SMS only in v1; the notifier is pluggable for later).
- Cabins other than business, or route sets other than the four cities ↔ Tokyo (the config permits other airports, but the product is not designed or tested around them).

## 5. Users & Operating Context

One user (the owner), one always-on Mac. The web server binds to 127.0.0.1 only; the machine itself is the authentication boundary. The service runs as a macOS LaunchAgent (`KeepAlive`), restarts on crash and reboot, and tolerates sleep (missed polls coalesce on wake). Secrets (seats.aero API key, Twilio credentials) live only in a local `.env` file, never in the config file, the database, or the UI.

## 6. Functional Requirements

### FR-1 Search & deal detection
- FR-1.1 Poll seats.aero cached search for business-class availability across the configured origins/destinations in both directions, all configured programs, within the configured date window, hard-capped at 355 days from today.
- FR-1.2 One-way deal: available business award with points cost strictly below the one-way threshold (default 90,000) and at least the configured seat minimum.
- FR-1.3 Roundtrip deal: an outbound and a return one-way whose combined points are strictly below the roundtrip threshold (default 180,000), with stay length inside a configurable nights window (default 3–21); individual legs may exceed the one-way threshold. Mixed origin/return cities and mixed programs are allowed (optionally restricted to same-city return).
- FR-1.4 Programs: Aeroplan, Flying Blue, and Qatar Avios natively. Because BA Avios is not a documented API source, oneworld space is additionally detected via the American and Alaska sources and priced with a clearly-labeled estimated Avios cost from a static distance-band table (config toggle, on by default).
- FR-1.5 All detection thresholds, routes, windows, and sources are configurable.

### FR-2 Alerting
- FR-2.1 At most one digest SMS per poll cycle, sent only when there is something new to say; the body is compact, ASCII-only (GSM-7-safe), and truncated to `sms.maxSegments` billed segments with a "+N more" summary.
- FR-2.2 Deduplication: a deal is alerted when first seen; re-alerted only if its price improves ≥15% versus the best previously-alerted price, or it reappears after being gone ≥7 days (both configurable).
- FR-2.3 Each alert shows route, date, program, points, seat count, operating airline(s), direct/connecting, data freshness, estimated-price flagging, and — when available — flight numbers, times, taxes, and a booking link.
- FR-2.4 Every SMS carries a verify-before-booking caveat and seats.aero attribution; full detail lives in the web console.

### FR-3 Web viewing
- FR-3.1 Dashboard listing current qualifying one-ways and roundtrip pairings with filtering (origin, destination, program, direct-only, include-estimates, max points) and sorting. The dashboard reflects the *current* configuration (geography, date window, programs, thresholds); rows outside it are never listed even if present in the database.
- FR-3.2 Calendar view: per-date minimum business points for the next 12 months, per direction.
- FR-3.3 Status view: API quota usage, scheduler state, cycle history, recent alerts, secret-presence indicators.
- FR-3.4 A visible "cycle running" indicator and seats.aero attribution on every screen.
- FR-3.5 Deal detail: any listed deal opens a detail view showing all business-cabin trip options (flight numbers, airport-local segment times, layovers, aircraft, fare class, taxes) and seats.aero booking links (primary program first), with data age and a verify-before-transferring-points caveat adjacent to the links. Roundtrips present two independent legs framed as separate one-way bookings. On-demand lookups share the daily API budget, are cached for 30 minutes, and are refused below the reserve floor; booking itself remains manual (FR-2.4, Non-goals).

### FR-4 Web configuration
- FR-4.1 View the full effective configuration (defaults applied, secrets excluded) in a form.
- FR-4.2 Edit and save configuration with client- and server-side validation from the same schema; per-field inline errors.
- FR-4.3 Saves preserve hand-written YAML comments and apply without restart. Read views (Dashboard, Calendar) apply the new configuration immediately; polling picks it up from the next cycle (polling-interval changes re-arm the scheduler immediately).
- FR-4.4 `db.path` and `server.port` are visible but read-only in the UI; secrets are shown only as present/absent.

### FR-5 Operations
- FR-5.1 Scheduled polling at a configurable interval (default 2 h) via an internal scheduler in a long-running service under launchd KeepAlive.
- FR-5.2 API-quota discipline: stay under a self-imposed daily call budget (default 900 of the 1,000/day limit); reserve headroom; degrade gracefully (skip detail enrichment, then skip cycles) rather than exhausting quota.
- FR-5.3 Manual "run now" from the web UI and CLI, guarded against overlapping a scheduled run.
- FR-5.4 A cycle history (trigger, duration, calls used, records, deals found, alerts sent, errors) is persisted and visible.
- FR-5.5 After ≥6 consecutive failed cycles, attempt a failure-notice SMS at most once per 24 h.

### FR-6 CLI
- FR-6.1 `serve` (service: web + scheduler), `search` (one-shot cycle, `--dry-run` prints the digest without sending or recording), `test-sms`, `routes-audit` (per-route crawl-horizon report), `probe-british` (empirically test the undocumented BA source), `status`.

## 7. Phased Delivery

Each phase ships a usable increment; later phases never rework earlier ones.

| Phase | Delivers | FRs | Acceptance |
|---|---|---|---|
| **1 — Deal Engine MVP** | Headless core: API client, SQLite state, detection, dedupe, SMS digest, `search`/`test-sms` CLI | FR-1, FR-2, FR-6 (partial) | A qualifying fixture deal produces exactly one alert; a second identical run produces none; full test suite passes without an API key |
| **2 — Always-On Service** | Scheduler + minimal service API, aux CLI, launchd KeepAlive | FR-5, FR-6 | Two consecutive scheduled cycles recorded with no duplicate alerts; `kill -9` auto-relaunches; concurrent run-now returns 409 |
| **3 — Web Viewing** | Read-only console: Dashboard, Calendar, Status at 127.0.0.1:8787 | FR-3 | All deals/cycles visible in browser; new deal appears within one interval; UI unreachable from LAN |
| **4 — Web Configuration** | Config editor with validated, comment-preserving, hot-applying saves; final docs | FR-4 | A UI config change alters the next cycle's behavior; invalid input blocked with inline errors; YAML comments survive |

## 8. Non-Functional Requirements

- **Quota compliance**: never exceed the API's 1,000 calls/day; self-cap at the configured budget.
- **Reliability**: all state in SQLite; crash or restart at any point loses no alert history and causes no duplicate alerts (alert state is committed only after a successful send).
- **Secrets**: env-only; never in config.yaml, the DB, logs, API responses, or the UI.
- **Network exposure**: web server binds 127.0.0.1 exclusively.
- **Honesty about staleness**: every surface (SMS, UI) shows data age and an estimated-price flag where applicable; cached data is never presented as bookable fact.
- **Attribution**: "Award availability data provided by seats.aero" on every SMS, UI screen, CLI output, and in the README (Pro API terms).
- **Lean dependencies**: 7 runtime npm packages; frontend compiles to static assets.
- **Keyless testability**: the entire pipeline is testable against a local mock API server with fixtures; no seats.aero key required for development.

## 9. Constraints & External Dependencies

- **seats.aero Pro** (~US$9.99/mo): Partner API access is included for personal use but granted at seats.aero's discretion (not all Pro accounts see the API tab) and revocable; verify on a monthly plan before annualizing.
- **Air Canada v. Localhost LLC (seats.aero)**, ongoing: Aeroplan data freshness is already degraded and the source could disappear; sources are config-driven and oneworld proxies provide fallback signal.
- **Twilio**: sending requires an account, a phone number (~US$1.15/mo), and per-message fees; A2P registration rules may apply to US-bound texts.
- **Platform**: macOS (launchd) for scheduling; Node ≥ 22. The `serve`/`search` commands themselves are portable (any OS with cron/systemd).
- **Data caveats**: cached prices exclude taxes/surcharges (the qatar source reports no tax data at all); AC-metal Aeroplan and Flying Blue prices are dynamic and stale quickly; phantom availability happens. Booking is always verified manually on the program site.

## 10. Success Criteria

- A qualifying fixture deal produces exactly one alert; repeat cycles stay silent until the deal improves ≥15% or reappears after ≥7 days.
- One week of scheduled operation stays under the daily call budget with zero duplicate alerts and zero missed cycles (excluding machine sleep).
- A configuration change made in the web UI (e.g. lowering the one-way threshold) changes what the next cycle alerts on, without a restart.
- A new qualifying deal in the data source is visible in the Dashboard and texted within one polling interval.
- The full test suite runs green with no API key on a fresh clone.

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Aeroplan source degraded/removed (lawsuit) | Config-driven sources; american/alaska proxies as backup signal; UI shows per-record freshness |
| BA Avios has no API source; estimates drift from real prices | `probe-british` command tests the source empirically; estimate table carries a lastVerified date; every estimate loudly flagged |
| Phantom/stale availability | Freshness shown everywhere; verify-before-booking caveat in every alert |
| API access revoked or quota tightened | Budget ledger + graceful degradation; the product still works read-only on existing data |
| Twilio/SMS failures | Retries; alert state only committed after send, so deals re-surface next cycle |

## 12. Future Considerations

Telegram/ntfy/push notifiers (Notifier interface is pluggable) · authentication + remote access · live verification if a commercial live-search agreement ever makes sense · connecting-itinerary Avios pricing · additional route sets/cabins · cents-per-point deal scoring · seats.aero Pro web alerts as a redundant channel.

---

*Award availability data provided by [seats.aero](https://seats.aero).*
