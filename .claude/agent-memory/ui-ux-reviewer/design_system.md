---
name: design_system
description: Location and details of flight-deal-finder's "departures board" dark design system (tokens, classes, gaps)
metadata:
  type: project
---

## Where it lives

- Tokens + all global styles: `web/src/app.css` (single file, no CSS modules/Tailwind — plain CSS with CSS variables on `:root`).
- Main data view: `web/src/pages/Dashboard.tsx` (one-way + roundtrip deal tables).

## Design language: "departures board"

Dark flight-information-display aesthetic. Archivo (sans) for labels/UI chrome, IBM Plex Mono for every number/data value.

Key tokens (`:root` in app.css):
- `--bg` #0b0e13, `--panel` #131926, `--bg-raised` #10141c, `--panel-edge`/`--hairline` for borders
- `--amber` #ffb547 — used for **estimates** (`.badge.est`) and active/focus states. Don't overload amber for unrelated meanings (e.g. warnings) without checking for clashes with the "estimate" association.
- `--green` #3ddc84 — semantic "qualifying deal" signal (points values, `.badge.direct`, `button.action` primary CTA fill). Green = positive/actionable in this system.
- `--red` #e8404b — errors and staleness (`.stale`, `.error-box`, `.err`)
- `--blue` #5d9bff — general interactive (rarely used yet)

Reusable classes: `.panel`/`.panel-head`/`.panel-title`, `table.board` (dense mono rows, very subtle 0.02-alpha hover bg tuned for *scanning* not click-affordance), `.badge` variants, `.dim`/`.faint`/`.stale` text hierarchy, `button.action` (green filled primary) vs `button.ghost` (transparent bordered secondary), `.error-box` (red-tinted callout — no neutral/amber "notice" equivalent exists yet), `.kv` definition-list, `.meter` (quota/progress bar with warn/crit color states), `.toast`.

## Known gaps as of 2026-09-10

- **No modal/drawer/overlay CSS exists at all.** No backdrop, focus-trap, or bottom-sheet patterns anywhere in the codebase yet — first one introduced will set the precedent.
- **No `.notice`/callout class distinct from `.error-box`** for non-error but important copy (e.g. a "verify before you act" warning) — recommend adding one using the amber-bordered treatment rather than reusing `.error-box` red.
- Table rows are not currently clickable/interactive anywhere; only `:hover` background exists, calibrated to be subtle (scanning), not to signal affordance.
- Only breakpoint defined is `@media (max-width: 860px)` for `.grid-2`/`.grid-3` — no mobile nav or sheet patterns established.

See [[deal-detail-drawer-review]] for a concrete UX review of a plan (`docs/plans/2026-09-10-001-feat-deal-details-booking-links-plan.md`) that introduces the first drawer/overlay into this system.
