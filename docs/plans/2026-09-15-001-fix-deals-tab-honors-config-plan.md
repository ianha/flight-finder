---
title: "fix: Deals tab honors the current configuration"
type: fix
status: completed
date: 2026-09-15
---

# 🐛 fix: Deals tab honors the current configuration

## Enhancement Summary

**Deepened on:** 2026-09-15 via a SpecFlow analysis plus 11 parallel review agents (TypeScript, architecture, simplicity, performance, security, pattern-consistency, frontend races, data integrity, agent-native parity, UI/UX, frontend-design), after direct research of every file on the request path and the live `config.yaml` / `data/deals.db`.

### Key changes from the first draft

1. **Tiered scope (simplicity review, adopted).** The fix is now split into **Tier A — the bug** (server scope filter, ~40 LOC + tests), **Tier B — Dashboard defaults follow config** (~30 LOC), and **Tier C — "when they change" promptness + honest empty state** (recommended, separable). Everything else moved to Follow-ups.
2. **Parity made structural (architecture + data-integrity).** The poller applies the same `inScope` predicate to its fresh snapshot, so *alerted ⇒ visible in console* becomes an invariant instead of two call sites that happen to agree. `deriveWindow` moves next to the predicate.
3. **Three defects in the draft's own snippets fixed (TypeScript review):** deriving the Program filter from direct-only `sources` silently dropped the estimated-Avios selection; `DEFAULT_THRESHOLDS` hardcoded the very `90_000` the acceptance criteria forbid (now derived from `configSchema.parse({})`); the tri-state nonstop toggle had no path back to "follow config" (collapse on write).
4. **Schema overlap refine demoted to a follow-up (data-integrity).** The draft claimed pre-existing overlapping YAML "never crashes"; in fact `loadConfig` throws before `serve` binds, so the editor would be unreachable. Not needed for the bug — the predicate is total.
5. **Pre-existing drawer bug must be fixed first (frontend races):** `onClose={() => setOpenDeal(null)}` at `web/src/pages/Dashboard.tsx:369` is a new function every render and sits in `DealDetail`'s effect deps, so every 10 s status poll re-runs dialog setup and yanks focus to the drawer root. Any change that adds re-render sources (this plan does) makes it worse.
6. **Naming/contract hygiene (pattern review):** `SearchGeo` becomes `StatusResponse['search']` (no hand-copied DTO twin); `'avios-est'` becomes a shared constant; `proxyEstimates` → `estimatesEnabled`; `now` goes right after `cfg` in all three query signatures.
7. **Measured, not guessed (performance):** full-table load is 8.2 ms on the live 9,912-row DB; in-memory scoping is correct, a SQL geography filter is not worth it, but bounding the *date* range in SQL is one line on an existing index and caps growth from past-dated rows.
8. **`configRevision` hashes a projection** (`search`, `thresholds`, `roundtrip`) rather than the whole config — no secret-derived value on `/api/status`, and SMS-number edits don't trigger refetches (security + data-integrity).

---

## Overview

The Deals tab (and, through the same read model, the Calendar tab) keeps showing deals for airports, dates, and defaults that are no longer configured. Editing `search.origins` / `search.destinations` / the date window in the Config tab changes what the **poller** fetches and what **SMS alerts** say, but the web read model runs detection over every `availability` row ever stored, and the Dashboard hardcodes several values the config is supposed to own (program list, nonstop default, points cap). This plan scopes the read model to the live config, exposes the few config values the UI needs through `/api/status`, and makes the Dashboard's filter defaults follow the config — including when it changes while the page is open.

## Problem Statement / Motivation

**Reproduction (observed in the live `data/deals.db` on 2026-09-15):**

- `config.yaml` is now `origins: [NRT, HND, ICN]`, `destinations: [JFK, ORD]`, `destinationLabel: NorthAm`, `directOnly: true`, `onewayMaxPoints: 95000`.
- The `availability` table still holds rows from earlier configurations: outbound `YYZ→NRT` (23 rows), `LAX→HND` (267), return `HND→YYZ` (22), routes to `LAX/YVR/YYZ` from an intermediate config, and **314 rows with departure dates already in the past** (back to 2026-08-28).
- `GET /api/deals/oneway` and `/roundtrip` (`src/server/queries.ts:79`, `:127`) call `detectOneways(getAllAvailability(db), …)`, and `getAllAvailability` is a bare `SELECT * FROM availability` (`src/db.ts:202`). Nothing in `candidateLeg` / `detectOneways` / `detectRoundtrips` checks origins, destinations, or the date window — only sources, proxy sources, `minSeats`, `directOnly`, and thresholds (`src/deals/oneway.ts:45-145`). So the Deals tab lists `YYZ→NRT` under the "to NorthAm" direction label.
- Because `direction` is not part of the row key and the upsert rewrites it (`src/db.ts:118-120`), the same physical route exists under both directions from different config eras: `HND→JFK` is stored as **302 outbound rows (current config) and 44 return rows (an earlier config where JFK was a home)**. Any geography filter has to decide whether it trusts the stored direction — see Technical Considerations.
- The poller is correct: it detects only on the rows it just fetched (`getAvailabilitySeenAt`, `src/poll.ts:238`) for the configured grid (`src/poll.ts:192-195`). **The web console and the SMS alerts disagree about what qualifies.**

**Frontend symptoms in `web/src/pages/Dashboard.tsx`:**

| Line | What it does today | Config value it ignores |
|---|---|---|
| `:13` `SOURCES` | Hardcoded program dropdown `aeroplan, flyingblue, qatar, american, alaska, british` | `search.sources` + `search.proxySources` |
| `:43` `directOnly: false` | "nonstop only" checkbox starts unchecked and only sends `directOnly=true` when checked | `search.directOnly` (currently **true**, so the unchecked box lies and the user cannot turn it off from the UI) |
| `:209` `points >= 90_000` | Roundtrip leg "over" styling | `thresholds.onewayMaxPoints` (currently 95,000) |
| `:324` `placeholder="90000"` | Max-points input hint | `thresholds.onewayMaxPoints` |
| `:234` filter state | `f.home` / `f.dest` keep a selected airport after it disappears from the config-driven options → query filters on a value that no longer exists → empty table, no explanation | `search.origins` / `search.destinations` |

`web/src/pages/Calendar.tsx:9-15, :89, :202-218` has the same 75k/90k hardcoding for the price bands, the `DayDetail` "over" class, and — easy to miss — the **legend strings** themselves ("under 75k", "75–90k", "90k and up").

**"When they change":** the dropdown *options* already follow `/api/status` (10 s poll, `web/src/App.tsx:17`), and the Dashboard remounts when the user leaves the Config tab, so a save-then-return does refetch. But the deal lists only refresh on their own 60 s timer, so a config change from another tab is honored up to a minute late, and — because of the server bug — never fully.

This matters because PRD FR-1.5 promises "all detection thresholds, routes, windows, and sources are configurable" and FR-4.3 promises saves "apply without restart"; today the console silently breaks both.

## Proposed Solution

### Tier A — Scope the read model to the live config (the bug; ship alone if needed)

**A1. Pure scope predicate**, next to the other detection rules. `deriveWindow` is pure and moves here from `src/config.ts` (re-export it from `config.ts` so `src/poll.ts:21` and `src/commands/probeBritish.ts` keep working, or update those two imports).

```ts
// src/deals/scope.ts (new) — no Node imports
import type { AppConfig } from '../shared/configSchema.js'
import type { AvailabilityRecord } from '../types.js'

export type SearchWindow = { startDate: string; endDate: string } // YYYY-MM-DD, inclusive

/** Derive the concrete search window (local calendar dates) from relative offsets. (moved from config.ts) */
export function deriveWindow(cfg: AppConfig, today: Date): SearchWindow { /* unchanged */ }

export interface SearchScope extends SearchWindow {
  origins: ReadonlySet<string>
  destinations: ReadonlySet<string>
}

export function scopeFor(
  search: Pick<AppConfig['search'], 'origins' | 'destinations'>,
  window: SearchWindow,
): SearchScope {
  return { ...window, origins: new Set(search.origins), destinations: new Set(search.destinations) }
}

/**
 * Direction-aware: a row is in scope only for the leg the CURRENT config would
 * fetch it as. Rows keep the direction of the config that fetched them and the
 * upsert rewrites direction on conflict (db.ts:120), so a re-fetched route always
 * re-enters scope with the right direction; only never-re-seen stale rows keep
 * a stale one — and those are exactly the rows to hide.
 */
export function isInScope(rec: AvailabilityRecord, s: SearchScope): boolean {
  if (rec.date < s.startDate || rec.date > s.endDate) return false
  return rec.direction === 'outbound'
    ? s.origins.has(rec.origin) && s.destinations.has(rec.destination)
    : s.origins.has(rec.destination) && s.destinations.has(rec.origin)
}
```

**A2. Read model uses it.** `now` goes immediately after `cfg` in all three signatures (`queryOneways(db, cfg, now, q)`, `queryRoundtrips(db, cfg, now, q)`, `queryCalendar(db, cfg, now, direction, origin?, destination?)`); `buildApp` passes `now()` per request (`src/server/app.ts:59` owns the clock as a thunk — call it, don't capture a `Date`). Threading `now` is not optional: an internal `new Date()` would make `test/server.test.ts` (fixed `NOW = 2026-08-15`, seeds dated 2026-11) start failing on 2026-11-06.

```ts
// src/server/queries.ts
function scopedAvailability(db: Db, cfg: AppConfig, now: Date): AvailabilityRecord[] {
  const window = deriveWindow(cfg, now)
  const scope = scopeFor(cfg.search, window)
  // Date range bounded in SQL on ix_avail_direction_date… (see A3); geography stays in the predicate.
  return getAvailabilityInWindow(db, window).filter((r) => isInScope(r, scope))
}
```

- Query-param overrides (`origin`, `home`, `dest`, `maxPoints`, …) still apply *after* scoping — they narrow, never widen. The Calendar day panel's `maxPoints=10_000_000` exploration keeps working inside the scope. An out-of-grid `home`/`dest` yields `total: 0`, never a 400 — that is what keeps the UI's fallback-to-"any" (Tier B) non-fatal.
- No rows are deleted. Out-of-scope rows stay in the DB (see Alternatives and Follow-ups).

**A3. Bound the date range in SQL** (one line, existing index). `getAvailabilityInWindow(db, { startDate, endDate })` = `SELECT * FROM availability WHERE date BETWEEN ? AND ?`; `getAllAvailability` is retired (its only caller is `queries.ts`). Measured: the full load is 8.2 ms on 9,912 rows, so this is not a bottleneck today — it exists to stop the read path scaling with DB *age* (past-dated rows are the only unbounded dimension). Geography stays in memory: the direction-aware pairing is awkward in SQL, dynamic `IN (…)` lists aren't indexable by `ix_avail_direction_date`, and the pure predicate should stay the single definition. `isInScope` still checks dates so the SQL bound is a pre-filter, not a second rule.

**A4. Poller parity, structurally.** In `src/poll.ts:238`, `const fresh = getAvailabilitySeenAt(db, seenAt).filter((r) => isInScope(r, scope))` where `scope` is built from the same `scopeFor(cfg.search, window)` the request grid was derived from (`src/poll.ts:182-195`). Today `normalizeAvailability` never checks that a returned row lies inside the requested grid; if seats.aero ever returned an off-grid row the poller would alert on it and the console would hide it — precisely the divergence this fix exists to remove. Note the read model deliberately shows a *superset* of the poller's snapshot (stale-but-in-scope rows from prior cycles, marked by the Data column); that is a documented divergence, not parity, and it is the right call under partial-quota cycles.

**A5. Document the column.** Add to the `availability` migration comment in `src/db.ts:11-13`: "`direction` is the leg *as fetched by the last cycle that saw the row*, not geometry — the upsert rewrites it." Future readers must not treat it as intrinsic.

### Tier B — Dashboard defaults follow the config (small; ships with A)

**B1. Status exposes what the UI needs.** `/api/status` is already the "frontend never hardcodes airports" channel (`src/shared/apiTypes.ts:56-57`); extend it rather than leaning on `/api/config` (serve-mode only, carries SMS numbers). Implement as one pure `statusConfigProjection(cfg)` in `src/shared/` used by `buildStatus`, so the projection has a name and the web can derive first-paint defaults from `statusConfigProjection(configSchema.parse({}))` instead of hand-synced constants (`web/src/pages/ConfigEditor.tsx:4` already imports `configSchema` in the browser).

```ts
// src/shared/apiTypes.ts — StatusResponse
search: {
  origins: string[]
  destinations: string[]
  destinationLabel: string
  /** Direct sources only — the Program filter's real-program options. */
  sources: string[]
  /** proxySources.enabled: whether the estimated-Avios option and the estimates toggle apply. */
  estimatesEnabled: boolean
  /** The console's default for "nonstop only"; the user may override per session. */
  directOnly: boolean
}
thresholds: { onewayMaxPoints: number; roundtripMaxPoints: number }
```

**B2. Dashboard consumes it.** Collapse the prop surface to `status: StatusResponse | null` (the `Status` page already takes the whole object, `web/src/pages/Status.tsx:137`); `Calendar` likewise. Delete the hand-copied `SearchGeo` interface (`Dashboard.tsx:15-19`) — if a local alias is wanted, `type SearchGeo = StatusResponse['search']`. First-paint policy, stated once: **schema defaults until status answers, with the Home/destination/Program selects and the nonstop checkbox `disabled` until then** so "any"-only reads as *not ready*, not as a valid selection. (The draft's "neutral" `DEFAULT_GEO` is dropped: it contradicted the schema-mirroring contract and a blank destination label would leave the `<select>` with no accessible name.)

```ts
const SCHEMA_DEFAULTS = statusConfigProjection(configSchema.parse({}))   // no 90_000 literal anywhere in web/src
const geo = status?.search ?? SCHEMA_DEFAULTS.search
const thresholds = status?.thresholds ?? SCHEMA_DEFAULTS.thresholds
const ready = status !== null

interface Filters {
  …
  /** null = follow the config default; a boolean is an explicit per-session override. */
  directOnly: boolean | null
}

// Effective filters are DERIVED, not synced with an effect: a selection the current
// config no longer offers falls back to "any" instead of filtering on a ghost airport.
const programOptions = [...geo.sources, ...(geo.estimatesEnabled ? [ESTIMATE_SOURCE_KEY] : [])]
const home = geo.origins.includes(f.home) ? f.home : ''
const dest = geo.destinations.includes(f.dest) ? f.dest : ''
const source = programOptions.includes(f.source) ? f.source : ''   // NOT geo.sources — that would drop the estimated option
const directOnly = f.directOnly ?? geo.directOnly

// Render value={home} etc. (derived), so DOM and URL agree. Memo the paths on the
// derived primitives — never on `geo`/`status` objects, which are new every 10 s poll
// and would turn 60 s deal polling into 10 s polling.
const onewayPath = useMemo(() => `/api/deals/oneway${qs({ home, dest, source, direction: f.direction,
  directOnly: f.directOnly ?? undefined,          // qs() already stringifies booleans; omitted = server applies config
  includeEstimates: f.includeEstimates ? undefined : 'false', maxPoints: f.maxPoints, limit: 200 })}`,
  [home, dest, source, f.direction, f.directOnly, f.includeEstimates, f.maxPoints])

// Nonstop toggle: selecting the config's own value means "follow config" again —
// an override is not a one-way door, and the (default) marker stays truthful.
onChange={(e) => set({ directOnly: e.target.checked === geo.directOnly ? null : e.target.checked })}
```

- Program `<select>`: options from `programOptions`; render `ESTIMATE_SOURCE_KEY` as `avios ~est` (lowercase raw-id convention, echoes the existing `.badge.est`). Hide "include estimates" when `estimatesEnabled` is false (it would be a no-op).
- "nonstop only": `checked={directOnly}`; when overridden (`f.directOnly !== null && f.directOnly !== geo.directOnly`) show a visible `.faint` suffix `override · config on|off` inside the label with `aria-describedby` — a `title` tooltip alone is invisible to touch and screen readers.
- Max-points `placeholder={String(thresholds.onewayMaxPoints)}`; `RoundtripTable` takes `onewayMaxPoints` for the "over" class.
- `ESTIMATE_SOURCE_KEY = 'avios-est' as const` goes in `src/shared/constants.ts` next to `PROXY_PRICED_SOURCES`, replacing the literals in `src/deals/oneway.ts:29` and `src/commands/testSms.ts:29`.

**B3. Fix the drawer re-render bug first.** `const close = useCallback(() => setOpenDeal(null), [])` in `Dashboard` (or hold `onClose` in a ref inside `DealDetail` and give the effect `[]` deps). Without it, every render — the 10 s status poll, each keystroke in Max pts, and every new prop this plan adds — tears down and rebuilds the dialog listeners and calls `previouslyFocused?.focus()` then `panelRef.current?.focus()`, stealing focus from a booking link the user tabbed to. Reproduce: open a drawer, tab into it, watch focus while the status poll ticks.

**B4. Copy.** `ConfigEditor.tsx:156` toast → `saved — deals & calendar updated`; footer `:363` → "Saves preserve the comments in your config.yaml. Deals and Calendar reflect the new settings immediately; polling uses them from the next cycle — interval changes re-arm the scheduler at once." (The `appliesAt: 'next-cycle'` API field stays; it describes the poller.)

### Tier C — "When they change" promptness and an honest empty state (recommended; separable)

The simplicity reviewer classes this tier as polish. It is kept because the bug report literally says *when they change*, and because the moment Tier A ships, a geography change makes the Deals tab legitimately empty until the next cycle (up to `poll.intervalHours`), and today's "no qualifying one-ways in the current snapshot" cannot say why.

**C1. `configRevision`.** `StatusResponse.configRevision: string` = short SHA-1 (`node:crypto`, server-side only — `src/shared/` must stay browser-safe) of `JSON.stringify({ search, thresholds, roundtrip })` — the projection that affects deals. Stateless (no `AppDeps` plumbing, no stub in every test `makeApp`), stable across restarts, a no-op save doesn't bump it, and SMS-number edits don't cause refetches. `usePoll(path, intervalMs, revision?: string)` adds `revision` to its effect deps; `App` passes `status.data?.configRevision` (a string — never `status.data`). Document in the hook that the `undefined → string` transition on first status arrival costs one extra fetch per list at mount. While here, harden `usePoll` cheaply: per-effect sequence counter (ignore out-of-order responses) and an `AbortController` aborted in cleanup. Net effect: ≤10 s after a save the lists refetch without remounting or closing an open drawer (which holds a click-time snapshot and never re-reads the list, `Dashboard.tsx:129-131, :366-369`).

**C2. Distinct empty state.** Both deals responses gain `availabilityInScope: number` — in-scope rows *before* detection and before user filters (so the message is truthful about config, and "filtered to nothing" still reads "no qualifying…"). Add it to `OneWayDealsResponse` / `RoundtripDealsResponse` in `apiTypes.ts` with a doc comment; `CalendarResponse` too for parity (Calendar's "no availability data yet — run a cycle first" has the same ambiguity). Dashboard renders a separate `NoScopedDataEmpty` component **only when `data` is present and `availabilityInScope === 0`** (never over a list that is about to be populated after a revision change; keep `.empty` "loading…" until data arrives):

```
.empty  role="status"
  no availability fetched yet for this configuration
  <span class="dim">next cycle <time dateTime={iso}>14:30</time></span>      ← Status-page fallbacks when scheduler is null
  <button class="action">Run now</button>                                    ← hidden when apiKeyPresent is false
```

Reuse `.empty` (not the red `.error-box` — this is not a failure), stack the three lines so it wraps at 400 px. Extract Run-now from `web/src/pages/Status.tsx:55-68` into a shared `useRunNow()` hook with a `busy` flag (`disabled={busy || inFlight}`), 409 → "a cycle is already running", and the toast timeout cleared on unmount — the current handler has no in-flight guard and writes state after unmount; do not copy-paste it. Decision: saving config does **not** auto-run a cycle — quota discipline (FR-5.2), collision with the in-flight mutex, and Run-now already exists.

**C3. Calendar thresholds.** `bandOf(day, cap)` with hot cutoff `cap × (75/90)` (reproduces today's 75k at the 90k default), legend spans built from `kFmt(hotCutoff)` / `kFmt(cap)` rather than string literals, `DayDetail` "over" class from the cap.

### Docs

- `README.md` manual UI checklist (`:137-145`): "change origins/destinations/nonstop/one-way cap in Config → Deals and Calendar show only the new geography and the new defaults without a reload; a geography change shows the 'not fetched yet' state with next-run time".
- `PRD.md` FR-3.1: append "The dashboard reflects the *current* configuration (geography, window, programs, thresholds); rows outside it are never listed even if present in the database." FR-4.3: read views apply immediately, polling from the next cycle.
- `src/shared/apiTypes.ts` is the de facto API contract: document `availabilityInScope`, `configRevision`, and `avios-est` as an accepted `OneWayQuery.source` value there.
- After shipping, `/ce:compound` a `docs/solutions/` note: "read models over append-only snapshot tables must be scoped by the live config, with the same predicate the writer uses".

## Technical Considerations

- **Strict rule: trust the stored `direction`, then check geometry.** Two alternatives were weighed: a *symmetric* check (`{origin,destination} ⊂ origins ∪ destinations`) would let a stale *return* `HND→YYZ` row pose as a new *outbound* and pair into roundtrips; a *derived* rule (ignore the column, classify by geometry) would "rescue" the 44 stale `return|HND→JFK` rows, but those are precisely rows the current config never fetched, `detectRoundtrips` reads `leg.direction`, and the console would diverge from what the poller alerted on. Verified against the live DB by the data-integrity review: with disjoint lists each physical pair is fetched in exactly one direction per config era, so last-writer direction is deterministic and `isInScope` admits a pair under only one direction.
- **Airport in both lists** is nonsensical (`X→X`) and makes the poller flip-flop a row's direction, but the predicate is still total (the stored direction decides) and neither the live config nor any fixture overlaps. A schema refine is a follow-up, not part of the fix — see Follow-ups for why it needs a deliberate startup-behaviour decision.
- **Date window.** `deriveWindow` uses the server's local calendar date; availability `date` is the departure's local date; both are zero-padded `YYYY-MM-DD` (regex-enforced at `src/types.ts:23`, 0 non-canonical dates in the live DB), so lexicographic comparison is valid. Inclusive on both ends. `startOffsetDays > 0` deliberately hides near-term dates from the console — parity with what the poller would alert on; called out in acceptance criteria so it isn't filed as a regression.
- **A cycle already in flight when config is saved** finishes under the old snapshot (`runCycle` destructures `cfg` once, `src/poll.ts:71`; `rearm()` is a no-op while in flight, `src/scheduler.ts:110`) and stamps old-geography rows with a fresh `last_seen_at`. Harmless with the scope filter — and the reason the read model must not key on "latest cycle" (Alternative 2).
- **Tri-state `directOnly`** keeps the server as the source of truth: while following config the UI sends nothing and the server applies `cfg.search.directOnly` exactly as today; an override sends an explicit boolean the server already parses (`parseBool`, `src/server/app.ts:283`). No server change. Collapsing on write (choosing the config's value → `null`) closes the "one-way door" and the "clicked before status answered" cells of the state matrix; disabling the checkbox until status arrives closes the rest.
- **Derived effective filters vs. `useEffect` reset.** Deriving avoids a render with the ghost value, a state write during render, and a race with the 10 s status poll. The raw selection stays in state, so if the airport comes back the user's choice reappears.
- **`includeEstimates`** has no config knob (estimates exist iff `proxySources.enabled`), so it keeps its UI default of `true` and is hidden when `estimatesEnabled` is false.
- **Flip-and-back.** Restoring a previous geography makes its old rows reappear immediately (never deleted), marked stale by the Data column, until the next cycle refreshes them. Alert dedupe keys carry no direction (`OW|src|O|D|date`), so the re-alert policy (`realertGoneDays`) applies as if tracking had been continuous — accepted; it is the existing FR-2.2 contract, and the same physical seat *is* the same deal.
- **Status page counts** (`db.availabilityRows`, "freshest record") still include out-of-scope rows; deferred.

## System-Wide Impact

- **Interaction graph:** `PUT /api/config` → `configApi.apply` (validate, write YAML, `configRef.current = parsed`, `src/commands/serve.ts:102-107`) → `scheduler.rearm()` (existing) → next `GET /api/status` (≤10 s) carries new `search` / `thresholds` / `configRevision` → `App` re-renders `Dashboard`/`Calendar` with the new `status` → `usePoll` sees the new revision and refetches `GET /api/deals/*` → those reads filter through `scopedAvailability` with the new config. The poller now filters its fresh snapshot with the same predicate; the SMS path is otherwise untouched.
- **Error propagation:** none new. The predicate is pure and total; a malformed `directOnly`/`source` query value is ignored or no-matches exactly as today; `/api/status` cannot fail on the hash (no I/O).
- **State lifecycle risks:** none — no writes. Partial-quota cycles remain safe: a cycle that only fetched outbound rows leaves the previous returns visible (still in scope).
- **API surface parity:** all three read endpoints go through the same helper, so UI and `curl` cannot drift. The CLI `search` uses the poller path (now scoped identically); `status` CLI calls `buildStatus` but does not print the new fields (optional: print `configRevision` + effective geography so CLI and console can be compared after an edit).
- **Integration test scenarios (HTTP-level, in-memory DB):**
  1. Seed rows for a configured route and for an unconfigured airport, a past date, and a date beyond `endOffsetDays`; only the configured, in-window rows appear in oneway, roundtrip, and calendar responses.
  2. Swap origins/destinations via the `getConfig` getter between two requests; the second request reflects the swap with no restart and no writes.
  3. Config `directOnly: true` + no query param → all results direct; `directOnly=false` query → non-direct results return (override works both ways).
  4. Two `/api/status` reads under different `search`/`thresholds`/`roundtrip` return different `configRevision`; identical configs — and configs differing only in `sms.*` — return the same value.
  5. A roundtrip cannot pair a fresh outbound with a stale opposite-direction row for the same physical route, nor with a cheaper out-of-config return leg.
  6. Two in-scope rows with different `last_seen_at` (a partial-quota cycle) are both visible — guards against "simplifying" the read model to the latest snapshot.
  7. `proxySources.enabled: false` removes estimate deals from oneway and calendar; `source=avios-est` returns exactly the estimate deals when enabled.
  8. Poller parity: a `runCycle` whose mock client returns an off-grid record neither alerts on it nor counts it in `onewaysFound`.

## Acceptance Criteria

**Tier A**
- [ ] `GET /api/deals/oneway`, `/api/deals/roundtrip`, and `/api/availability/calendar` never return a row whose `(direction, origin, destination)` is not in the current `search.origins × search.destinations` grid for that direction, or whose date is outside `deriveWindow(cfg, now)`.
- [ ] Changing `search.origins` / `search.destinations` / `search.window` / `search.directOnly` / `thresholds.*` through `PUT /api/config` is reflected by the very next read of every deals endpoint, with no restart and no DB writes.
- [ ] Threshold/stay/`directOnly` query overrides never widen geography or window (`?maxPoints=10000000` after a geography change still returns no old-geography rows).
- [ ] The poller applies the same predicate to its fresh snapshot; `getAllAvailability` is gone; all three queries take `now` from `AppDeps.now`.
- [ ] Tests: `test/scope.test.ts` unit tests; `test/server.test.ts` scenarios 1–3, 5, 6, 8; `npm test` and `npm run typecheck` clean.

**Tier B**
- [ ] `GET /api/status` exposes `search.sources`, `search.estimatesEnabled`, `search.directOnly`, `thresholds.onewayMaxPoints`, `thresholds.roundtripMaxPoints` via a named projection.
- [ ] Program dropdown lists exactly the configured direct sources plus `avios ~est` when estimates are enabled; "include estimates" is hidden when they are not; "nonstop only" starts checked iff `search.directOnly`, shows a visible override marker, and returns to "follow config" when set back to the config value; the max-points placeholder and the roundtrip "over" styling use `thresholds.onewayMaxPoints`; no `90_000` / `SOURCES` / Tokyo-airport literals remain in `web/src` (first-paint defaults come from `configSchema.parse({})`).
- [ ] Selects and the nonstop checkbox are disabled until `/api/status` has answered; a previously selected Home/destination/Program that the new config no longer offers falls back to "any" (in both the DOM and the request URL).
- [ ] Opening a drawer and tabbing into it, focus stays put across status polls (drawer `onClose` identity is stable).
- [ ] Config-tab toast/footer copy no longer claims the console waits for the next cycle.

**Tier C**
- [ ] `configRevision` is present, hashes only `{search, thresholds, roundtrip}`, and with the page open a config save in another tab updates the deal lists within 10 s without closing an open detail drawer; `usePoll` path/revision deps are primitives only.
- [ ] Deals and calendar responses carry `availabilityInScope`; when it is 0 (and data has loaded) the Deals tab shows the "not fetched yet for this configuration" state with next-run time and a Run-now button sharing one `useRunNow` hook with the Status page.
- [ ] Calendar bands, legend strings, and `DayDetail` "over" class derive from the configured cap (90k reproduces today's 75k/90k).
- [ ] Tests: scenarios 4 and 7; README checklist and PRD FR-3.1 / FR-4.3 updated.

## Test Plan

### `test/scope.test.ts` (new)

Build rows with the same helper as `test/oneway.test.ts` / `test/roundtrip.test.ts` (`normalizeAvailability(makeAvailability(over), direction)`), not literal `AvailabilityRecord`s. `scopeFor({origins:['YYZ','ORD'], destinations:['NRT','HND']}, {startDate:'2026-08-15', endDate:'2027-08-05'})`:

- outbound `YYZ→NRT` in window → true; return `NRT→YYZ` → true
- outbound `NRT→YYZ` (right airports, wrong direction) → false; return `YYZ→NRT` → false
- outbound `YYZ→ICN`, outbound `JFK→NRT` → false
- date `2026-08-14` → false; `2026-08-15` → true; `2027-08-05` → true; `2027-08-06` → false
- overlapping lists (`origins {NRT}`, `destinations {NRT, YYZ}`): outbound `NRT→NRT` → true, outbound `YYZ→NRT` → false, return `NRT→NRT` → true — this proves the predicate is *total* on overlapping input, nothing about runtime config acceptance
- `deriveWindow` boundary cases move here from wherever they live today (`startOffsetDays > endOffsetDays`, cap at 355), using the local `new Date(y, m, d)` style from `test/config.test.ts`

### `test/server.test.ts`

Use a **sibling seeder** rather than extending `seededDb()`: existing tests assert exact counts (`calendar days.length === 4`, `home=YYZ total 2`, `destination=NRT total === all.total`).

- **new** `deals read model is scoped to the configured geography and window` — seed the base five plus: outbound `YYZ→ICN`, outbound `JFK→NRT`, return `NRT→JFK`, outbound `YYZ→NRT` dated `2026-08-01`, outbound `YYZ→NRT` dated `2027-09-01`. Assert `/api/deals/oneway` total stays `4`, the best roundtrip is unchanged, and `/api/availability/calendar?direction=outbound` has no `2026-08-01` / `2027-09-01` day.
- **new** `a config change is honored by the next read without restart` — `makeApp` variant with `let cfg = parseConfig({})` and `getConfig: () => cfg`; read → reassign `cfg` to `origins: ['SFO']` → `total === 0` → reassign to swapped lists (`origins: ['NRT','HND'], destinations: ['YYZ','ORD','LAX']`) → seeded `r1` (`NRT→YYZ`, stored as *return*) stays hidden; `upsertAvailability` the same route as `outbound` → it appears.
- **new** `roundtrip pairing never reaches outside the configured scope` — under defaults seed a cheap *return* `KIX→YYZ` at 30k, 10 nights after `a1`; the best pair must remain `62_500 + 70_000`.
- **new** `window bounds follow deriveWindow` — with `NOW` fixed, seed in-scope rows at `NOW − 1d`, `NOW`, `NOW + 355d`, `NOW + 356d`; exactly the middle two are visible; `startOffsetDays: 30` hides the `NOW` row; `endOffsetDays: 30` hides `NOW + 355d`.
- **new** `partial cycles keep earlier in-scope rows visible` — seed two in-scope rows with different `seenAt` values (parameterize the `seed` helper); both appear.
- **new** `threshold override does not widen geography` — after the swap above, `?maxPoints=10000000` still returns `total: 0` for the old rows.
- **new** `availabilityInScope and source=avios-est` (Tier C) — `availabilityInScope` equals the number of seeded in-scope rows regardless of `home`/`dest` filters; `source=avios-est` returns only `p1`; `proxySources.enabled: false` removes `p1` from oneway and calendar.
- **extend** `GET /api/deals/oneway applies config thresholds and filters` — with `search.directOnly: true`: no param → every deal `direct`; `directOnly=false` → the connecting `a2` deal returns.
- **extend** `GET /api/status …` — update the existing `deepEqual` on `body.search` (don't loosen it) for `sources` (direct only), `estimatesEnabled`, `directOnly`; assert `thresholds`; (Tier C) `configRevision` differs between `parseConfig({})` and `parseConfig({thresholds:{onewayMaxPoints: 95_000}})`, is equal for identical configs, and is equal for configs differing only in `sms.to`.

### Poller (`test/e2e.test.ts` or a sibling)

- **new** `runCycle ignores off-grid records from the API` — mock client returns one record outside the configured grid; `onewaysFound` excludes it and no alert is sent for it.

### Manual (no frontend test harness in this repo)

Follow the updated README checklist against `npm run dev`: change destinations in Config, switch to Deals, confirm table, dropdowns, checkbox default, and placeholder; open a drawer in one tab, tab into a booking link, save config in another tab, confirm focus stays put, the drawer stays open, and the list refreshes; throttle to Slow 3G to provoke ordering issues in `usePoll`.

## Success Metrics

- With the current live `data/deals.db` and `config.yaml`, the Deals tab shows **zero** rows with a North-American origin under the outbound direction and **zero** rows dated before today (today it shows both).
- `npm test` passes with the new cases; `npm run typecheck` is clean.

## Dependencies & Risks

- **Hidden-but-present rows.** Out-of-scope and past-dated rows stay in SQLite, inflating `availabilityRows` on the Status page and DB size (~20–30 rows/day age out of the window). Low severity; see Follow-ups. This fix must be correct even for users who never run a cycle after editing config, so it cannot depend on a prune.
- **`search.window.startOffsetDays` hides near-term dates from the console.** By design (parity with alerts) — in acceptance criteria and PRD wording so it isn't filed as a regression.
- **Poller now filters its snapshot.** Behaviour-neutral for every record seats.aero has returned so far (all on-grid), but it is a change on the alerting path — covered by the new poller test.
- **No automated frontend tests.** Mitigated by `npm run typecheck`, the manual checklist, and keeping the Dashboard change mechanical (derive values; the only new effect dependency is the `usePoll` revision string).

## Follow-ups (deliberately out of scope)

- **Schema refine rejecting an airport in both `origins` and `destinations`.** Worth having (overlap wastes calls and flip-flops direction), but it makes `loadConfig` throw for an already-overlapping `config.yaml` — `serve` would exit before binding, the editor would be unreachable, and a launchd install would crash-loop. Decide deliberately: hard-fail with a field-pointing message plus "hand edit required" docs (consistent with the existing refines), or a load-time warning. `PUT /api/config` validation alone would be the safe first step.
- **Prune past-dated rows** at the end of a successful (not `aborted_quota`) cycle, inside the cycle transaction: `DELETE FROM availability WHERE date < ?` with "yesterday" computed by `fmtLocalDate` (not SQL `date('now')`, which is UTC). Never touch `alerted_deals`. Out-of-config rows are *not* pruned, so flipping a geography back shows data instantly.
- **Status page counts** still include out-of-config rows; add an in-config figure next to the total (the `availabilityInScope` field already exists once Tier C ships).
- **Roundtrip `origin` filter is not direction-aware** (`p.outbound.origin === q.origin`, `src/server/queries.ts:128`), unlike the one-way `home` filter — origin-side open-jaws are excluded when filtering by the return city. Pre-existing.
- **Calendar empty state** (`Calendar.tsx:160`) should adopt the same "not fetched yet" treatment as the Dashboard so the tabs agree.
- **`button:focus-visible`** has no rule in `app.css` (only `select:focus, input:focus`); a one-liner closes the accessibility gap.
- **Alert history** (`/api/alerts`, Status tab) shows keys from old geographies. Correct as history; a faint "not in current config" marker is a possible nicety.
- **Hand edits to `config.yaml` while `serve` runs** are invisible until restart (only `PUT /api/config` hot-swaps); `search` CLI reads the file fresh. Pre-existing cross-process inconsistency.
- **`buildStatus` runs `COUNT(*)` and `MAX(api_updated_at)`** (full scans, no index) every 10 s — 10× the cost of the new hash. Fine today; index `api_updated_at` if the status poll is ever tightened.

## Alternative Approaches Considered

1. **Delete out-of-scope rows when config is applied.** Destructive (flip config back and the data is gone until the next cycle), doesn't address past dates unless a second prune is added, and still leaves the read model wrong between apply and the next cycle. Rejected as the fix; fine as a later housekeeping prune.
2. **Read model = last cycle's snapshot (`last_seen_at = last cycle`).** Breaks under partial-quota cycles (only one direction fetched → the other blanks out) and in UI-only mode after a config edit with no cycles at all. Rejected.
3. **Filter in the browser.** Totals and pagination would be wrong, and every server consumer would still get out-of-scope deals. Rejected.
4. **Geography filter in SQL.** Measured 4 ms saving, still a full scan without a new composite `(direction, origin, destination, date)` index, and the direction-aware pairing becomes two UNIONed branches. Rejected; date range only.
5. **`<Dashboard key={configRevision}>` remount on change.** Simplest refetch, but resets filters and closes an open drawer on every save. Rejected in favor of the `usePoll` revision dep.
6. **Auto-run a cycle when geography/window/sources change.** Spends 2–4 API calls per edit, collides with the in-flight mutex, and contradicts the explicit Run-now affordance. Rejected; the empty state + next-run time covers it.
7. **Integer `configRevision` bumped in `configApi.apply`.** Equivalent, but needs a getter through `AppDeps` and a stub in every test `makeApp`. The stateless projection hash needs neither.
8. **Neutral (empty) first-paint defaults.** Contradicts the schema-mirroring contract and leaves the destination `<select>` without an accessible name. Rejected; schema defaults + disabled controls until status answers.

## Research Notes

Local research was done by reading every file on the request path (server routes → read model → detection → DB, and App → Dashboard/Calendar → hooks), the only `docs/solutions/` entry, the previous plan, and the live `config.yaml` / `data/deals.db`. No external research: the bug is internal read-model/UI state with no third-party API, security, or payment surface.

**SpecFlow analysis** contributed the direction-rule evidence, the distinct empty state, the `avios-est` dropdown issue, the `now`-injection rationale, and test scenarios 3–7; its open questions are answered inline (strict direction rule; no auto-run; hide-by-window is intended; no pruning in v1; tri-state nonstop toggle; single estimated-Avios option; status counts deferred; overlap refine deferred with a startup-behaviour decision).

**Review agents (11, parallel):** simplicity → tiering; architecture → structural poller parity, `deriveWindow` relocation, SQL date bound, named status projection, `avios-est` constant, column comment; TypeScript → three snippet defects, `StatusResponse['search']`, `status` prop, `qs()` boolean support, memo deps, `useRunNow` extraction; frontend races → drawer `onClose` identity bug, tri-state collapse-on-write and disable-until-ready, primitives-only poll deps, `usePoll` seq/abort hardening, Run-now in-flight guard, no empty-state flash before data; performance → live measurements, "never memo on `geo`"; security & data-integrity → hash a projection; data-integrity → overlap refine crashes startup, `now()` not a captured `Date`, prune guidance; pattern-consistency → naming, sibling seeder, `rec()` helper in unit tests, calendar parity; UI/UX & frontend-design → `.empty` container, visible override marker, legend strings, disabled selects, accessible names, `role="status"`, `button:focus-visible`; agent-native → parity satisfied by construction, document the contract in `apiTypes.ts`.

## Sources & References

- Read model and detection: `src/server/queries.ts:69-186`, `src/deals/oneway.ts:29, :45-145`, `src/deals/roundtrip.ts:53-105`, `src/db.ts:11-36, :105-131` (upsert rewrites `direction`), `src/db.ts:202` (`getAllAvailability`)
- Poller parity: `src/poll.ts:71, :182-195, :238-240`, `src/config.ts:62-72` (`deriveWindow`), `src/types.ts:23, :184`
- Hot-swap seam: `src/commands/serve.ts:28-29, :100-109`, `src/server/app.ts:40, :59, :187-227, :283`
- Frontend: `web/src/pages/Dashboard.tsx:13, :22-46, :129-131, :209, :233-266, :324, :366-369`, `web/src/pages/Calendar.tsx:9-15, :89, :160, :202-218`, `web/src/pages/Status.tsx:55-78, :137`, `web/src/App.tsx:16-20, :38`, `web/src/hooks.ts:45-79`, `web/src/api.ts:37`, `web/src/pages/ConfigEditor.tsx:4, :156, :363`, `web/src/DealDetail.tsx:220-252`, `web/src/app.css:405`
- Status contract: `src/shared/apiTypes.ts:35-58`, `src/server/queries.ts:233-293`, `src/shared/constants.ts:42`
- Tests/fixtures conventions: `test/server.test.ts:32-76, :190-236, :414-467`, `test/helpers/fixtures.ts`, `test/oneway.test.ts`, `test/config.test.ts`
- Prior art on getter-based config seams: `docs/plans/2026-09-10-001-feat-deal-details-booking-links-plan.md` (§ Client construction), `docs/solutions/integration-issues/seats-aero-on-demand-trips-quota.md`
- Requirements: `PRD.md` FR-1.1, FR-1.5, FR-2.2, FR-3.1, FR-4.3, FR-5.2; README `:106`, `:137-145`
- Related commit: `ac042e6` (home/destination filters — introduced the config-driven dropdowns this plan completes)
