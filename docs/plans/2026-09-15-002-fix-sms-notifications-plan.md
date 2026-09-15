---
title: "fix: cleaner SMS dates + locked-in config-honoring guarantees"
type: fix
status: planned
date: 2026-09-15
---

# 🐛 fix: cleaner SMS dates + locked-in config-honoring guarantees

## Overview

Two changes to the Twilio SMS deal alerts (`src/notify/sms.ts`):

1. Switch the date format used in SMS bodies from unpadded `M/D/YY` (e.g. `3/1/27`) to `MMM/DD/YY` (e.g. `Mar/01/27`), matching the more readable month-abbreviation style already used elsewhere in the app.
2. Make sure SMS notifications honor the constraints configured in `config.yaml` (origins, destinations, date window, point thresholds, direct-only, stay-length bounds, etc.) — and close the two concrete gaps that keep that guarantee from being verifiable and regression-proof, rather than "true by construction of two call sites agreeing."

## Problem Statement / Motivation

**Date format.** `shortDate()` (`src/notify/sms.ts:35-39`) hand-splits the ISO date string and emits unpadded numeric month/day: `2027-03-01` → `3/1/27`. This is harder to scan in a text message than a month abbreviation, and is inconsistent with the rest of the app: `src/notify/render.ts:16-24`'s `fmtDate` (console/dry-run output) and `web/src/api.ts:50-53`'s `fmtDateShort` (web UI) both already render month abbreviations via `Intl`/`toLocaleDateString`. SMS is the one place still doing raw numeric months.

**Config-honoring.** This item was prompted by the just-shipped fix in commit `329432e` ("scope the deals read model to the live configuration", `docs/plans/2026-09-15-001-fix-deals-tab-honors-config-plan.md`), which made the Deals tab (web) share one scoping predicate with the poller. Investigating whether SMS alerts still need an equivalent fix (research below) found that **the structural gap is already closed**: the poller and the SMS path apply the identical `scopeFor`/`isInScope` predicate and the identical `detectOneways`/`detectRoundtrips` detectors as the web read model, against a live (not snapshotted) config. There is no code path today where an SMS alert fires for a deal that violates the currently-configured origins, destinations, date window, point thresholds, direct-only flag, seat minimum, or stay-length bounds.

That said, two real gaps remain, and are the actual target of this plan:

- **No regression test locks in threshold/directOnly honoring at the alert-digest level.** `test/e2e.test.ts:183` only asserts geography scoping (`assert.ok(!digest.oneways.some((o) => o.deal.destination === 'ICN'))`); nothing asserts that a deal above `thresholds.onewayMaxPoints`, or a connecting itinerary under `search.directOnly: true`, is excluded from `notifier.digests`. A future change to the detector or poll pipeline could silently reintroduce a config bypass with nothing to catch it.
- **The manual SMS verification tool bypasses config entirely.** `src/commands/testSms.ts`'s `cannedDigest()` (lines 9-58) hardcodes two fixed deals; it never calls `detectOneways`/`detectRoundtrips` or reads `search`/`thresholds` for anything beyond SMS rendering knobs (`maxSegments`, `destinationLabel`) and Twilio recipient fields. There is currently no way to send a real test SMS and see it reflect what the live config would actually alert on — which is the practical way a user would ever notice a "config isn't honored" regression.

## Research Notes

Two Explore passes were run over `src/poll.ts`, `src/notify/sms.ts`, `src/commands/serve.ts`, `src/scheduler.ts`, `src/server/app.ts`, `src/deals/scope.ts`, `test/e2e.test.ts`, `test/sms.test.ts`, and `docs/plans/2026-09-15-001-fix-deals-tab-honors-config-plan.md`. Key findings:

- `src/poll.ts:242-243` filters every fresh availability snapshot through the same `scopeFor`/`isInScope` predicate (`src/deals/scope.ts`) the Deals tab now uses — an off-scope record cannot be alerted on without also being visible in the console, and vice versa.
- `detectOneways`/`detectRoundtrips` (`src/poll.ts:244`) run against the live `cfg` — `thresholds.onewayMaxPoints`/`roundtripMaxPoints`, `search.directOnly`, `search.minSeats`, `roundtrip.minStayNights`/`maxStayNights`/`sameCityReturn` — the same pure detectors the web read model uses.
- Config is read live, not snapshotted: `src/commands/serve.ts:29,57-66` keeps a `configRef` that `PUT /api/config` hot-swaps (`src/server/app.ts:187-224` → `configApi.apply`, `src/commands/serve.ts:103-109`). Both the poll `runner` closure and `SmsNotifier`'s config getter (`src/notify/sms.ts:154,167`, constructed at `serve.ts:38` as `() => configRef.current`) re-read `configRef.current` on every cycle/send, so a web-console edit reaches the very next alert without a restart.
- `test/e2e.test.ts` has geography-scoping coverage (line 183) but no threshold/directOnly coverage at the alert-digest level.
- `src/commands/testSms.ts` sends a fully canned, config-independent digest.

## Proposed Solution

### 1. Date format: `MMM/DD/YY`

Rewrite `shortDate()` in `src/notify/sms.ts:35-39` to emit a 3-letter capitalized month abbreviation instead of the numeric month. Keep the manual ISO-string split (no new dependency — input is always a `YYYY-MM-DD` string, and the day segment is already zero-padded):

```ts
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function shortDate(date: string): string {
  // 2027-03-01 -> Mar/01/27
  const [y, m, d] = date.split('-')
  return `${SHORT_MONTHS[Number(m) - 1]}/${d}/${(y ?? '').slice(2)}`
}
```

This is the only date formatter SMS uses (`legLine()` at line 51, the roundtrip line at lines 95-96), so both one-way and roundtrip lines pick it up automatically. `render.ts`'s `fmtDate` (console/dry-run) and `web/src/api.ts`'s `fmtDateShort` (web UI) are separate formatters, already month-abbreviated, and out of scope — this request is specifically about SMS.

**Tradeoff:** `MMM/DD/YY` (9 chars, e.g. `Mar/01/27`) is 3 chars longer than the current `M/D/YY` (6-7 chars, e.g. `3/1/27`). `renderSms()`'s budget-fitting loop (`src/notify/sms.ts:102-111`) already measures the actual rendered string length against `maxSmsChars(cfg.sms.maxSegments)`, so this self-adjusts — it just means marginally fewer deal lines fit before "+N more: see console" kicks in, at a given `maxSegments`. No code change needed for this; call it out in the PR description as a visible behavior shift.

### 2. Lock in config-honoring with a regression test

Add test cases to `test/e2e.test.ts`, alongside the existing geography-scoping assertion (line 183), which already runs a full `runCycle` against a fake `Notifier` and inspects `notifier.digests`:

- Seed availability rows that would form valid deals except for violating one non-geography constraint each: a one-way above `thresholds.onewayMaxPoints`, and a connecting itinerary when `search.directOnly: true`.
- Run a cycle and assert none of those rows appear in `notifier.digests[...].oneways`, mirroring the existing `assert.ok(!digest.oneways.some(...))` pattern.

This exercises the exact pipeline SMS goes through (`runCycle` → `filterForAlert` → `notifier.sendDigest`), turning "SMS notifications honor config constraints" into a concrete, permanent check instead of an emergent property of two call sites happening to agree.

### 3. Make manual SMS verification config-driven

Change `testSmsCommand` in `src/commands/testSms.ts` so it can build its digest from real, config-scoped detection instead of always using `cannedDigest()`:

- Reuse the same detection path `runCycle`/`poll.ts` already calls (`getAvailabilitySeenAt` + `scopeFor`/`isInScope` + `detectOneways`/`detectRoundtrips`, then `filterForAlert`) against the local DB, scoped by the currently-loaded `cfg`.
- If that produces an empty digest (e.g. no availability cached yet, or nothing currently matches config), fall back to `cannedDigest()` with a clear log line explaining it's canned and not config-verified — preserving today's "always works, sends something" behavior for a first-time user with an empty DB.
- Keep this behind the existing `test-sms` command; decide during implementation whether the dual-mode logic reads more clearly as automatic fallback or as an opt-in flag (e.g. `--real`) — pick whichever adds less branching to a currently simple command.

This turns `test-sms` into a genuine end-to-end check that what a user actually receives reflects `config.yaml`'s live constraints, closing the practical verification gap.

## Explicit Non-Goals

- Re-implementing or touching `scopeFor`/`isInScope` (`src/deals/scope.ts`) or the poll cycle's scoping logic — already correct per `329432e` and the research above.
- Hand-edited `config.yaml` changes while `serve` is running, made without going through `PUT /api/config` — a pre-existing, cross-process gap explicitly deferred in the prior plan (`docs/plans/2026-09-15-001-fix-deals-tab-honors-config-plan.md`, Follow-ups, line 317), and not SMS-specific.
- Date formatting in `render.ts` (console output) or `web/src/api.ts` (web UI) — this request is scoped to SMS.

## Acceptance Criteria

- [ ] SMS deal lines (one-way and roundtrip) render dates as `MMM/DD/YY` (e.g. `Mar/01/27`); `test/sms.test.ts`'s date assertions (currently expecting `3/1/27`-style strings around lines 81-83) are updated to match.
- [ ] `test/e2e.test.ts` has new cases proving a deal above `thresholds.onewayMaxPoints`, and a connecting itinerary under `search.directOnly: true`, never reach `notifier.digests`.
- [ ] `test-sms` can send a digest built from real config-scoped detection against the local DB, with a clear fallback (and log message) to the canned digest when there's nothing to alert on.
- [ ] `npm test` and `npm run typecheck` (or equivalent project scripts) pass.

## Test Plan

1. `test/sms.test.ts` — update date-format assertions to `MMM/DD/YY`.
2. `test/e2e.test.ts` — add threshold-exceeded and directOnly-violation cases near the existing geography-scoping assertion (line 183).
3. Manual: run the updated `test-sms` CLI against a local DB with cached availability and a config with tight constraints (e.g. a low `onewayMaxPoints`); confirm the sent SMS only contains deals within those constraints and that dates read as `Mar/01/27`-style.
4. Manual: re-run `test-sms` with an empty DB to confirm the canned-digest fallback still sends a recognizable test message.

## Sources & References

- `src/notify/sms.ts:35-39, :47-58, :65-117, :153-207`
- `src/notify/render.ts:16-24`, `web/src/api.ts:50-53`
- `src/poll.ts:71, :182-245, :268-318`
- `src/deals/scope.ts`
- `src/commands/serve.ts:28-38, :57-66, :100-109`
- `src/server/app.ts:187-224`
- `src/commands/testSms.ts`
- `test/e2e.test.ts:183`, `test/sms.test.ts:81-83`
- `docs/plans/2026-09-15-001-fix-deals-tab-honors-config-plan.md` (prior scoping fix; Follow-ups line 317 for the deferred hand-edit gap)
