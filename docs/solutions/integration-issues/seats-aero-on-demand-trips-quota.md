---
title: "Quota-safe on-demand seats.aero lookups from the web console"
category: integration-issues
tags: [seats-aero, quota, caching, hono, promise-cache, trips]
module: server/tripDetails
symptom: "User-triggered API calls (deal detail clicks) could starve the alert poller's daily quota or double-charge the ledger"
root_cause: "Quota accounting lived only inside the poll cycle; the client's onCall label is a closed union; browser clicks are unbounded"
---

# Quota-safe on-demand seats.aero lookups

When exposing a seats.aero call to browser clicks (`GET /api/trips/:id`), the things that actually matter:

1. **One estimator.** `estimatedRemaining` (ledger + `X-RateLimit-Remaining` header floor) lives in `src/quota.ts` and is shared by `poll.ts` and `TripDetailService`. Re-deriving it in a second place drifts — the header min is easy to forget.
2. **Charge the shared ledger yourself, before the fetch.** The client's `onCall` reports the closed `ApiEndpoint` union (`'trips'`), so the web path writes `incrementApiCalls(db, day, 'trips-web')` directly and the web client's `onCall` only refreshes the rate-limit meta — anything else double-charges. `getCallsUsed` SUMs all endpoints, so the reserve check includes web calls automatically. Charge *before* fetching: a crashed request still burned upstream quota.
3. **Cache the promise, not the value.** A `Map<availabilityId, {promise, expiresAt}>` where `expiresAt` is `Infinity` while in flight gives request coalescing for free. Two invariants: no `await` between cache check and insert (Node single thread ⇒ race-free), and the promise never rejects (map errors to outcome values inside the task, or a waiter leaks an unhandled rejection and the entry poisons).
4. **404 needs a typed error.** `request()` treated every non-OK as a generic `Error`; an `expired` UI state is unimplementable until 404 throws `NotFoundError`. Also: Hono path-normalizes `%2e%2e` before your handler — validate ids (`^[A-Za-z0-9_-]{1,64}$`) but don't assert a 400 for `..`; the router 404s it first.
5. **`getTrips` swallows everything except `QuotaExhaustedError` into `null` — by contract.** `poll.ts` enrichment depends on it; when layering a richer method underneath, keep the wrapper's exact error behavior and pin it with a regression test.
6. **Sanitize upstream booking links server-side** (http/https only via `new URL`) in the one DTO-mapping function — `rel="noopener"` does not stop `javascript:` hrefs.
7. **Loopback binding is not CSRF protection.** Any web page can fire quota-burning simple GETs at 127.0.0.1; an Origin/Host loopback middleware on `/api` closes it (Host check also kills DNS rebinding).

Frontend twin (drawer over a polling list): key the overlay by deal, mount it above the row `.map()`, snapshot legs in the click handler, AbortController in the effect cleanup — see `web/src/DealDetail.tsx`.
