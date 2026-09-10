---
title: "feat: Deal detail view with booking links in web console"
type: feat
status: completed
date: 2026-09-10
---

# ✨ feat: Deal detail view with booking links in web console

## Enhancement Summary

**Deepened on:** 2026-09-10 via 9 parallel review agents (TypeScript, security, performance, architecture, simplicity, frontend-races, data-integrity, UX, pattern-consistency) after 3 research agents (repo, learnings, seats.aero API docs) and a SpecFlow analysis.

### Key changes from the first draft

1. **Simplified v1 (simplicity review, adopted):** cut the persistent `trip_details` SQLite table, the prune sweep, alert-enrichment cache seeding, both config knobs, and the "Re-check" button. v1 uses an **in-memory promise cache** in the server process — request coalescing falls out for free. Cuts ~300–400 LOC. Deferred items are documented at the bottom with the reviewers' guidance so they can be added later without re-research.
2. **Factual corrections:** the first draft wired a cleanup into a "prune path" that does not exist in `src/db.ts`, used `CREATE TABLE IF NOT EXISTS` where the codebase actually uses a `PRAGMA user_version`-gated append-only `MIGRATIONS` array, and placed config knobs under `server.*` — which `PUT /api/config` pins to `{port}` and would silently wipe. All three are moot in v1 (table and knobs cut) but recorded in Deferred so they don't bite later.
3. **Error model switched to repo-standard HTTP statuses** (`400/404/502/503` + `{error}` body) instead of a five-state union inside a 200 envelope — matches `POST /api/run`'s existing convention; the frontend still renders distinct copy per status.
4. **Quota accounting nailed down:** charge `api_calls` with endpoint label `'trips-web'` (the shared budget is a SUM across endpoints, so the reserve check includes it automatically); increment **before** the upstream fetch; extract the poller's private `estimatedRemaining` closure into a shared `src/quota.ts` so the two quota estimators can't drift.
5. **Security hardening:** validate `availabilityId` (`^[A-Za-z0-9_-]{1,64}$`) before it reaches the upstream URL; scheme-allowlist booking links (http/https only) server-side; Origin/Host middleware against cross-origin quota drain + DNS rebinding; `upstream_error` responses carry no upstream detail.
6. **Frontend race discipline specified:** drawer keyed by availability identity, AbortController in effect cleanup, per-leg isolated components for roundtrips, snapshot captured in the click handler, drawer mounted above the row `.map()`.
7. **UX specified to the copy level:** dialog a11y (focus trap, `role="dialog"`, focus return), no `role="button"` on `<tr>`, amber callout warning above the primary CTA, per-state copy, `+1` overnight notation, cheapest badge, bottom-sheet behavior.

---

## Overview

Every deal row in the Dashboard list view (one-way and roundtrip tables) gets a detail view showing the actual itinerary — flight numbers, segment times, layovers, aircraft, cabin, taxes — and "Book via …" links that deep-link the user into the loyalty program's booking flow.

**Scope decision (made per PRD):** "book the flight" means handing off via seats.aero booking deep links. In-app booking/payment is explicitly out of scope — `PRD.md:26` states booking is manual and alerts link out, and no award tool in this space (seats.aero, point.me, PointsYeah) books in-app because airlines expose no award-booking APIs to third parties. The differentiator is a good handoff: pre-filled deep links, all program options, and verify-before-transfer guidance.

## Problem Statement / Motivation

Deals in the web console are currently dead ends: a row shows route/date/points/seats, but to act on a deal the user must wait for an SMS alert (which already includes flight details and a booking link) or manually search the program site. The backend already knows how to fetch trip details — `SeatsAeroClient.getTrips()` exists and SMS alerts use it — but nothing exposes it to the browser. Roughly 80% of the plumbing exists; this feature closes the last mile.

## Proposed Solution

1. **Client refactor:** `getTripsFull(availabilityId)` on `SeatsAeroClient` returning **all** business-cabin trip options with segment-level data, throwing typed errors. Existing `getTrips` becomes a thin wrapper preserving its exact contract so SMS alerting is untouched.
2. **Backend:** `GET /api/trips/:availabilityId` with an in-memory promise cache (30-min TTL), shared daily-quota accounting, reserve-floor refusal, and repo-standard HTTP error responses.
3. **Shared types:** `BookingLinkDto` / `SegmentDto` / `TripOptionDto` / `TripDetailOkResponse` in `src/shared/apiTypes.ts`.
4. **Frontend:** A detail drawer opened from any deal row in `Dashboard.tsx`, holding a click-time snapshot of the leg data so the 60-second list poll can't yank it away. Roundtrips show two independent leg sections (two availability IDs, two fetches, two sets of booking links) with explicit "two separate one-way award bookings" framing.

### Data flow

```
Row click → GET /api/trips/:id
  → invalid id?                → 400 {error:"invalid_availability_id"}
  → cache hit (< TTL)?         → replay cached outcome (0 quota)
  → no client (no API key)?    → 400 {error:"no_api_key"}   (UI disables rows up front via /api/status)
  → estimatedRemaining ≤ reserve? → 503 {error:"quota_exhausted"}
  → incrementApiCalls('trips-web')  ← charged BEFORE the fetch
  → seats.aero GET /trips/{id}
      → 200 with trips → sanitize links, map DTOs, cache → 200 {availabilityId, options[], bookingLinks[], fetchedAt}
      → 200, zero business options → 200 with options: []  (distinct empty-state copy in UI)
      → 404/empty      → 404 {error:"expired"}   (cached briefly so repeat clicks don't re-burn quota)
      → QuotaExhausted → 503 {error:"quota_exhausted"}
      → other error    → 502 {error:"upstream_error"}  (no upstream detail leaked; logged server-side)
```

## Technical Considerations

### Quota is the design constraint

seats.aero Pro allows **1,000 calls/day**; the app self-budgets 900 with a 50-call reserve. Today only the poller spends quota, via `onCall → incrementApiCalls(db, day, endpoint)` (`src/poll.ts:114-122`). Web-triggered trips calls must:

- **Share the same ledger.** The service charges `incrementApiCalls(db, utcDay(now()), 'trips-web')` itself (it does not rely on the client's `onCall`, whose `ApiEndpoint` union is closed to `'search' | 'trips' | 'routes'` — `src/seatsAero.ts:14`). `getCallsUsed` SUMs across endpoints (`src/db.ts:431`), so the shared reserve arithmetic includes web calls automatically, while the distinct label keeps Status-page attribution clean.
- **Charge before the fetch.** A crashed/timed-out request has still burned seats.aero's quota; overcounting on failure is the safe direction and preserves the reserve guarantee.
- **Refuse below the reserve floor** using the *same* estimator as the poller. `estimatedRemaining` is currently a closure inside `runCycleLocked` (`src/poll.ts:124-133`) including the subtle `X-RateLimit-Remaining`-header min — extract it to `src/quota.ts` as `estimatedRemaining(db, cfg, now)` and use it from both call sites. Re-implementing it would drift.
- **Be cached and coalesced.** The in-memory cache stores the **promise** of the outcome, keyed by availabilityId: concurrent clicks share one upstream call by construction. TTL is a hardcoded constant (30 min for success, 5 min for `expired`/error outcomes so a dead row doesn't pin failure for half an hour but repeat-clicks don't re-burn quota either). No config knobs: upstream data is already 5–18h stale; nobody will ever tune these. Note the check-then-fetch gap between poller and web can overshoot the reserve by 1–2 calls worst-case — acceptable given the 50-call reserve; do not add locking.
- **Coalescing invariants:** the whole check-cache → insert-promise sequence contains no `await` (better-sqlite3 is synchronous; Node's single thread then makes it race-free). The cached promise **never rejects** — error mapping to outcomes happens inside the task, so waiters can't leak unhandled rejections. Failed outcomes are evicted on the short TTL.

*(A per-day web-lookup cap knob was considered and cut: the reserve floor alone already guarantees "the console can never starve alerting," which is the actual requirement, and a single human clicking 30-min-cached rows can't realistically burn hundreds of calls. See Deferred.)*

### Client construction & UI-only mode

`buildApp`'s `AppDeps` (`src/server/app.ts:38-47`) has no `SeatsAeroClient`; the console supports UI-only mode with no `SEATS_AERO_API_KEY` (`src/commands/serve.ts:19-25`). Design:

- `TripDetailService` takes `{ db, getClient: () => SeatsAeroClient | null, getConfig: () => AppConfig, now }`. **Getter functions, not `configRef`** — the getter is the established hot-swap seam (`AppDeps.getConfig` at `src/server/app.ts:40`, `SmsNotifier(() => configRef.current, …)` at `src/commands/serve.ts:37`); passing the ref would leak the config write side into the service.
- `serve` constructs the service **unconditionally** (both modes); `getClient` returns null without a key and the service answers `no_api_key`. All state mapping stays in one place — no split-brain branch in `app.ts`.
- `AppDeps.tripDetails` stays optional purely so existing tests compile; the route returns the `no_api_key` response when absent.
- The frontend reads `/api/status` env presence (already consumed) and renders rows non-clickable in UI-only mode, so users rarely see the 400 at all.

### seats.aero client changes

- `request()` currently throws a generic `Error` for any `!res.ok` (`src/seatsAero.ts:132`) — a 404 is indistinguishable. Add a typed `NotFoundError` (or `TripsNotFoundError`) thrown on 404 so the `expired` mapping is implementable.
- `getTripsFull` **throws** typed errors (`TripsNotFoundError`, and lets `QuotaExhaustedError`/`BadRequestError` propagate) — the codebase idiom is Error subclasses discriminated by `instanceof`, not result unions. Only the service maps exceptions → HTTP responses.
- `getTripsFull` `encodeURIComponent`s the id defensively (the endpoint has already regex-validated it).
- The `getTrips` wrapper must preserve its **exact** null-swallowing contract: rethrow only `QuotaExhaustedError`; convert `TripsNotFoundError`, `BadRequestError`, parse failures, and everything else to `null` — `src/poll.ts:284-296` depends on this to abort enrichment cleanly. Add a regression test asserting the rethrow-only-quota contract.
- Extend `apiTripSchema`/`tripsResponseSchema` (`src/types.ts:43-72`) with `AvailabilitySegments`, all cosmetic fields `.nullish()` per the file's stated permissive philosophy.

### Security (right-sized for a localhost single-user tool)

- **Validate `availabilityId`** against `^[A-Za-z0-9_-]{1,64}$` before any cache/quota/upstream work → 400 otherwise. Raw interpolation into `/trips/${id}` would otherwise let an encoded `..%2F`/`%3F` rewrite the upstream path (and cache the result under an arbitrary key) while still spending quota. With a fixed `baseUrl` plus one validated path segment, there is no SSRF surface.
- **Sanitize booking links server-side at DTO-mapping time:** parse with `new URL()`, drop any link whose protocol isn't `http:`/`https:` (`noopener` does not stop `javascript:`/`data:` hrefs). One mapping function, used by every path that produces `BookingLinkDto`. No `dangerouslySetInnerHTML` anywhere in the drawer.
- **Origin/Host middleware** on `/api`: reject requests whose `Origin` is present and foreign, or whose `Host` isn't `127.0.0.1:8787`/`localhost:8787`. Binding to 127.0.0.1 does not stop a malicious page in the user's own browser from firing CORS "simple requests" that burn quota blind (and DNS rebinding can even read them); the Host check closes rebinding. This incidentally protects the pre-existing `POST /api/run`.
- **`upstream_error` responses carry no upstream detail** — `BadRequestError.message` embeds the full upstream URL; log server-side, send only `{error:"upstream_error"}`. No response field is ever sourced from env/config secrets or raw upstream error objects.
- **Bound payloads:** cap options at 20 (post-sort) and segments per option at mapping time.

### Trips response realities (from seats.aero docs)

- `booking_links` is **top-level per availability** (not per trip option): `{label, link, primary}`. Primary = source program; secondary = alliance partners. Order primary-first (the SMS renderer already does, `src/notify/render.ts:87-88`).
- Deep-link quality varies: Aeroplan/United/Qantas get pre-filled URLs; LifeMiles gets a homepage link. Links land on a search page, never a specific seat.
- Layovers are derived from consecutive `AvailabilitySegments` (`Order`, `ArrivesAt`/`DepartsAt`); times are airport-local ISO 8601 — display as given, never convert to browser timezone.
- Some programs never expose seat counts; render "—" as the list view already does (map upstream 0/null → `null` at the DTO boundary so both views share one convention).
- Phantom availability is an acknowledged upstream phenomenon; the verify-before-transfer warning is required copy (`PRD.md:90,101`), not decoration.

## System-Wide Impact

- **Interaction graph:** Row click → validate → in-memory cache → (miss) quota check → ledger increment → `getTripsFull` → sanitize/map → cache → respond. Nothing else fires; `poll.ts` is untouched in v1.
- **Error propagation:** `QuotaExhaustedError`/`NotFoundError`/`BadRequestError` from the client map to `503/404/502` in the service; the endpoint never 500s for expected failures; only a malformed id yields 400 pre-flight. Statuses are pinned here so tests can assert them.
- **State lifecycle:** cache is process-local memory; a restart empties it (acceptable — worst case one extra quota call per row). Failed-outcome entries evict on a 5-min TTL; the map entry is written synchronously with the check, and outcomes never reject, so no entry can be permanently poisoned.
- **API surface parity:** SMS alerts already show details + a booking link; this brings the console to parity. `GET /api/alerts` and `alerted_deals.detail_json` are untouched.
- **Integration test scenarios (cross-layer, beyond unit mocks):**
  1. Two concurrent `GET /api/trips/:id` with a slow fake fetch → exactly one upstream call, both 200.
  2. Ledger at reserve floor → 503 and the counter does **not** increment.
  3. Upstream 5xx → 502 **and** the counter *did* increment (charge-before-fetch).
  4. Upstream 404 → 404 `expired`; a second click within the negative TTL makes no upstream call.
  5. App built without `tripDetails` dep (UI-only) → 400 `no_api_key`.
  6. `availabilityId` of `..%2Fsearch` or 65+ chars → 400, zero upstream calls, zero ledger increments.
  7. Upstream response containing a `javascript:` booking link → link absent from the DTO.

## Implementation Phases

### Phase 1: Backend — client, quota, service, endpoint

**Files:**

- `src/types.ts` — extend trips schemas with `AvailabilitySegments` (fields `.nullish()`); add a `TripsFullResult` domain type (named to avoid colliding with the existing `TripDetail` at `src/types.ts:151`, which remains the SMS cheapest-option shape).
- `src/seatsAero.ts` — `NotFoundError` on 404 in `request()`; `getTripsFull(availabilityId)` (all business-cabin options sorted by mileage then departure, segments included, typed throws); `getTrips` reimplemented on top with its contract preserved.
- `src/quota.ts` *(new)* — `estimatedRemaining(db, cfg, now)` extracted from `src/poll.ts:124-133` (ledger + `rate_limit_remaining`-header min); poller switches to it.
- `src/server/tripDetails.ts` *(new)* — `TripDetailService` (~60 lines): promise-cache Map, TTL constants (`30 min` ok / `5 min` negative), no-await coalescing invariant, reserve check, `incrementApiCalls(db, day, 'trips-web')` before fetch, exception→outcome mapping, booking-link scheme sanitization + option/segment caps in one DTO-mapping function.
- `src/server/app.ts` — Origin/Host middleware; `GET /api/trips/:availabilityId` with regex validation → `c.json(... satisfies TripDetailOkResponse)` on 200, `{error}` bodies with statuses 400/404/502/503 otherwise (matches the `ApiError`/`RunConflictResponse` precedent); `tripDetails?` added to `AppDeps`.
- `src/commands/serve.ts` — construct the service unconditionally with `getClient`/`getConfig` getters.
- `src/shared/apiTypes.ts` — in a `// --- trips ---` section:
  ```ts
  export interface BookingLinkDto { label: string; link: string; primary: boolean }
  export interface SegmentDto {
    flightNumber: string | null; originAirport: string; destinationAirport: string;
    departsAt: string; arrivesAt: string; aircraftName: string | null;
    fareClass: string | null;
    layoverMinutesAfter: number | null; // null on the last segment by contract
    order: number;
  }
  export interface TripOptionDto {
    flightNumbers: string | null; departsAt: string | null; arrivesAt: string | null;
    totalDurationMinutes: number | null; stops: number | null; carriers: string | null;
    cabin: string | null;
    mileageCost: number;          // options with null mileage are dropped (mirrors parseMileage contract)
    seats: number | null;         // upstream RemainingSeats 0/null → null ("—" convention, matches DealLegDto.seats)
    totalTaxes: number | null; taxesCurrency: string | null;
    segments: SegmentDto[];
  }
  export interface TripDetailOkResponse {
    availabilityId: string; options: TripOptionDto[];
    bookingLinks: BookingLinkDto[]; fetchedAt: string;
  }
  ```
  Nullability mirrors the zod schemas (`src/types.ts:43-59` is `.nullish()` throughout) — no invented `?? 0`/`?? ''` defaults; `totalTaxes: 0` must never mean "unknown".

**Success criteria:** integration scenarios 1–7 pass in `test/server.test.ts`/`test/tripDetails.test.ts`; `test/seatsAero.test.ts` covers `getTripsFull` (multi-option, segments, 404, quota, URL-encoding) and the `getTrips` rethrow-only-quota regression; `npm test` + `npm run build` pass.

### Phase 2: Frontend — detail drawer + booking links

**Files:** `web/src/DealDetail.tsx` *(new — root-level like `App.tsx`; `web/src/components/` doesn't exist and one file doesn't justify creating it)*, `web/src/pages/Dashboard.tsx`, `web/src/hooks.ts` (new `useTripDetail` hook — `api.ts` stays generic-transport-only per its convention; export `StaleAge` from where it lives or lift it), `web/src/app.css`.

**Race discipline (mandatory patterns):**

- Dashboard holds `openDeal: {kind:'oneway', leg} | {kind:'roundtrip', out, ret} | null`; the **snapshot is captured in the row's click handler** from render scope — the drawer never re-derives the leg from list state (which the 60s poll mutates).
- `<DealDetail>` is mounted **once at the top level of `Dashboard.tsx`**, above the row `.map()` — never inside it, or re-sorts/refreshes would remount/close it.
- Drawer keyed by availability identity (`key={leg.availabilityId}` / pair key): opening a different row is a fresh mount by construction — no stale-response-over-new-header race. Re-opening the same row is a no-op (same key).
- Fetch effect uses `AbortController`, aborts in cleanup, treats `AbortError` as silence. `useTripDetail` is one-shot (never `usePoll`, never URL-keyed `useApi` — a path-encoded flag would refetch on every render of that path).
- Roundtrip legs are **separate component instances** (`<LegDetail key={leg.availabilityId} leg={legSnapshot}/>`), each with its own state machine, fetch, and abort — no shared state, no `Promise.all`; partial failure falls out for free.
- Client state union per leg: `idle | loading | ok | empty | no_api_key | quota_exhausted | expired | upstream_error` (from HTTP status + body; `empty` = 200 with zero options). Retry (for `upstream_error`) disabled while a request is in flight.
- Escape listener added/removed in an effect; backdrop closes only when `e.target === e.currentTarget` (text-selection drag must not slam it shut); close is instant (no exit animation delaying unmount/abort).

**Dialog a11y (first overlay in this codebase — setting precedent):**

- `role="dialog" aria-modal="true" aria-labelledby={headingId}`; focus moves to the drawer on open, Tab is trapped, focus returns to the triggering cell on close; background scroll locked while open.
- Rows keep native table semantics — **no `role="button"` on `<tr>`**. A narrow chevron ("›") cell holds a real (visually minimal) `<button aria-label="View details: YYZ → HND, Aeroplan">`; whole-row click is a convenience on top. Row hover: `cursor: pointer` + 2px amber left-border accent (matches `.nav a.active`), since the existing row hover is too subtle to signal clickability.

**Content & copy spec:**

- Per leg section: options list sorted cheapest-first; cheapest gets a small green `cheapest` badge (consistent with `.badge.direct`) + green-tinted left border. Each option: flight numbers, per-segment rows (times as given, airport-local; `6:05 AM +1` trailing marker for next-day arrivals with a legend tooltip; aircraft; fare class; derived layover durations `2h 15m`), stops badge, seats ("—" when null), taxes formatted from cents with currency and an explicit `+ taxes` label so it can't read as points.
- Booking links: primary as the single prominent "Book via X" CTA; secondary links below in the same secondary treatment as homepage-only links (labeled "opens program site — search manually"); all `target="_blank" rel="noopener noreferrer"`. Empty links → fallback naming program, route, and date. Never render the literal word "primary".
- **Warning placement:** an amber-bordered callout (new class parallel to `.error-box`, amber not red) directly **above the primary CTA**: "Availability may be phantom — verify on *[program name]* before transferring points." Name the program; don't bury the warning next to the dim data-age line where it becomes wallpaper.
- Per-leg footer (roundtrips have two): "Fetched Xm ago" data age.
- State copy with distinct visual weight: `no_api_key` neutral/dim ("Running without a seats.aero key — live lookups are off."), `quota_exhausted` amber ("Daily lookup budget reached — the alert poller gets priority. Try again later."), `expired` neutral ("No longer available. The list will drop it on the next poll."), `upstream_error` red with Retry ("Couldn't reach seats.aero."), `empty` neutral ("No business-cabin options currently match — search the program site directly."), `loading` a `.pulse` line ("Fetching itinerary…"), no skeletons.
- Roundtrip sub-header pinned under the drawer title: "Booked as two separate one-way awards — each leg below has its own options and booking links." Outbound/Return as equal-weight cards so a failed leg doesn't visually vanish.
- UI-only mode: rows render non-clickable (no chevron button) based on `/api/status` env presence.
- Mobile: full-width bottom sheet, `max-height: 85vh`, internal scroll, sticky header with close button.

**Success criteria (manual, in `npm run dev`):** one-way and roundtrip details open; race drills with devtools throttling — open A then immediately B (B's data only), open-and-instantly-close (no console error, request aborted), roundtrip with one leg throttled and one erroring (independent settle); links open in new tabs; drawer survives a poll refresh including the deal leaving the snapshot; keyboard-only flow (Tab to chevron, Enter, Tab within, Escape, focus returns).

### Phase 3: Polish & docs

- README: "Deal details & booking" section (quota implications of clicking, cache behavior).
- PRD: FR addendum for the console detail view.
- `docs/solutions/` learning entry after implementation (per compound-engineering flow).
- Prefetch-on-hover: **rejected** — violates quota discipline.

## Alternative Approaches Considered

- **`include_trips=true` on cached search** — embeds trips in poll results at zero per-click cost, but multiplies poll payloads for data nobody clicks. Rejected; revisit if click volume grows.
- **Persistent `trip_details` table** — first draft had it; cut for v1 (see Deferred).
- **Five-state union in a 200 envelope** — first draft had it; replaced by repo-standard HTTP statuses (`app.ts` already models failures as status + `{error}`); a second parallel error convention for one endpoint wasn't worth it.
- **New `#/deal/:id` routed page** — a drawer preserves list context (filters, scroll). Rejected.
- **In-app booking** — impossible (no airline award APIs) and out of scope per `PRD.md:26`.

## Deferred (documented so they can be added without re-research)

1. **Persistent `trip_details` cache** (+ alert-enrichment seeding, UI-only cached details). If added: append as `MIGRATIONS[1]` in `src/db.ts` — plain `CREATE TABLE`, no `IF NOT EXISTS` (the `user_version` gate guarantees single execution; existing DBs at version 1 never re-run migration 0, so editing the bootstrap block would break every existing install). Upsert via `ON CONFLICT(availability_id) DO UPDATE` with a `WHERE excluded.fetched_at >= fetched_at` monotonic guard; zod-validate `detail_json` on read-back with delete-on-parse-failure; retention (~7 days) must be a *different* number from the TTL or UI-only mode loses everything in 30 minutes; the sweep needs a named call site (end of poll cycle or serve startup — **no prune path exists today**). Seeding requires `poll.ts` enrichment to switch to `getTripsFull` (same 1 quota unit) — seeding from `getTrips`'s one-option shape would serve degraded detail views as authoritative.
2. **Config knobs** (`tripCacheTtlMinutes`, `maxWebTripLookupsPerDay` — note the `max…Per…` naming convention per `alerts.maxTripLookupsPerCycle`). Must NOT live under `server.*`: `PUT /api/config` pins `server` to `{port}` (`src/server/app.ts:166-168`) and would silently wipe them. Put them under `api.*` next to `dailyCallBudget`/`reserveCalls`.
3. **"Re-check" button** (`?refresh=1`, parsed with the existing `parseBool`). Cut because a refetch only returns seats.aero's own crawler cache — the real verification step is clicking through to the program site, which the feature already provides. If added: refresh joins the in-flight map (never races a second upstream call), styled `button.ghost` so the costly action doesn't compete with the Book CTA.
4. **`getTrips`/`getTripsFull` merge** — once enrichment migrates to `getTripsFull` (item 1), delete `getTrips` and derive the SMS shape at the call site; two projections of one endpoint shouldn't live forever.

## Acceptance Criteria

- [ ] Every one-way and roundtrip row opens a detail view (mouse + keyboard; native table semantics preserved; focus trapped and returned).
- [ ] Detail shows all business-cabin options (≤20) with segments: flight numbers, airport-local times with `+1` overnight markers, derived layovers, aircraft, fare class, stops, seats ("—" when unknown), taxes with currency and `+ taxes` label.
- [ ] Booking links: primary-first CTA, secondary/homepage links visually secondary and labeled, `target="_blank" rel="noopener noreferrer"`, non-http(s) links stripped server-side, empty-links fallback names program/route/date.
- [ ] Amber verify-before-transfer callout naming the program sits directly above the primary CTA; per-leg data age shown.
- [ ] Roundtrip legs fetch, render, and fail independently; "two separate one-way awards" sub-header pinned.
- [ ] Endpoint statuses: 200 ok (incl. zero-option `empty`), 400 invalid-id/`no_api_key`, 404 `expired`, 502 `upstream_error` (no upstream detail in body), 503 `quota_exhausted`; distinct UI copy per state; never a 500 for these paths.
- [ ] Web calls charge `api_calls` (`'trips-web'`) **before** fetching, share the poller's `estimatedRemaining` from `src/quota.ts`, and are refused at the reserve floor.
- [ ] Two clicks on one availability within TTL → one upstream call; concurrent requests coalesce (asserted via counter + fake fetch).
- [ ] `availabilityId` regex-validated before any side effect; Origin/Host middleware rejects foreign-origin requests.
- [ ] Open detail survives the 60s poll refresh, aborts its fetch on close, and never shows one row's data under another row's header.
- [ ] UI-only mode renders rows non-clickable via `/api/status`; direct endpoint hit returns 400 `no_api_key`.
- [ ] `getTrips` regression test: rethrows only `QuotaExhaustedError`, returns `null` for everything else (SMS path untouched).
- [ ] `npm test` and `npm run build` pass.

## Success Metrics

- List row → program booking page in ≤ 3 clicks with zero manual data entry (when a deep link exists).
- Console usage cannot reduce poller quota below the reserve floor under any click pattern.

## Dependencies & Risks

- **seats.aero response drift:** permissive zod (`.nullish()` cosmetic fields); missing segments degrade to "N stops" without layover math.
- **Quota exhaustion mid-day:** typed 503 + reserve guard; alerting always wins over console browsing.
- **Stale list snapshots:** clicked IDs can 404 → `expired`, list reconciles on the next poll; negative caching stops repeat-click quota burn.
- **Non-commercial API terms:** Pro keys are personal-use only; this is a single-user personal tool, consistent with terms.

## Sources & References

### Internal References

- seats.aero client, errors, `getTrips`: `src/seatsAero.ts:14,17-30,102-144,204-242`
- Trips zod schemas + `TripDetail`/`BookingLink`: `src/types.ts:43-72,77,148-160`
- Routes + `AppDeps` + config pinning + parse helpers: `src/server/app.ts:38-47,51-216,166-168,218-245`
- Quota ledger: `src/db.ts:424-436`; migrations mechanism: `src/db.ts:8-99`; WAL: `src/db.ts:85`
- Poller quota closure + enrichment + reserve guard: `src/poll.ts:114-136,275-299`
- Shared DTOs (`DealLegDto.availabilityId`, `seats: number | null`): `src/shared/apiTypes.ts:75-103`
- Config schema + hot-swap + UI-only mode: `src/shared/configSchema.ts`, `src/commands/serve.ts:19-25,37,62,76-89`
- Deal list view: `web/src/pages/Dashboard.tsx` (LegCells 39-74, tables 76-162); hooks (`alive`-flag pattern, no abort): `web/src/hooks.ts:18-37,55-57`; styles: `web/src/app.css`
- SMS booking-link precedent: `src/notify/render.ts:87-88`
- Manual-booking scope + verify caveats: `PRD.md:26,48,90,101`; quota discipline: `README.md:104`
- Test patterns: `test/server.test.ts`, `test/seatsAero.test.ts:144-166`, `test/helpers/fixtures.ts`

### External References

- Get Trips endpoint: https://developers.seats.aero/reference/get-trips (`booking_links {label, link, primary}`, `AvailabilitySegments`)
- Cached Search `include_trips`: https://developers.seats.aero/reference/cached-search
- Program support table: https://developers.seats.aero/reference/concepts-copy
- Rate limits (1,000/day Pro, `X-RateLimit-Remaining`): https://developers.seats.aero/reference/getting-started-p, https://docs.seats.aero/article/68-seatsaero-pro-api-access-limits-and-usage
- Phantom availability: https://docs.seats.aero/article/15-what-does-phantom-availability-mean

### Related Work

- SpecFlow analysis + 9 review agents (TypeScript, security, performance, architecture, simplicity, frontend-races, data-integrity, UX, pattern-consistency), 2026-09-10; their conflicting guidance on cache persistence and error modeling was resolved in favor of the simplified v1, with the robustness guidance preserved verbatim in the Deferred section.
