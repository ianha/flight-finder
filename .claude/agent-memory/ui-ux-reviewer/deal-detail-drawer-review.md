---
name: deal-detail-drawer-review
description: Key UX findings from reviewing the Phase 2 (DealDetail drawer) plan in docs/plans/2026-09-10-001-feat-deal-details-booking-links-plan.md
metadata:
  type: project
---

Reviewed 2026-09-10: `docs/plans/2026-09-10-001-feat-deal-details-booking-links-plan.md`, Phase 2 (DealDetail drawer). Plan not yet implemented at review time — recommendations only, no code existed for DealDetail.tsx.

Most load-bearing findings (worth checking if implementation follows through on these):

1. **Per-leg footer, not drawer-level footer.** Roundtrip legs fetch independently (separate cache entries, separate fetchedAt/state), but the plan's "Footer: Fetched Xm ago + Re-check" was written as if singular/drawer-level. Each leg section needs its own fetched-at + re-check control or the two legs' independent freshness is impossible to represent.
2. **`role="button"` on `<tr>` breaks table semantics for screen readers.** Recommended an `aria-label` summarizing the row instead, or a visually-hidden button per row, keeping native row/cell roles intact.
3. **No focus trap / initial focus / return-focus specified** for the drawer — plan only mentions ✕/backdrop/Escape to close. This is a real gap against WCAG 2.1 AA (focus management for dialogs).
4. **Amber is already semantically "estimate"** (`.badge.est`) in this design system — recommended NOT reusing amber inline text for the verify-before-transfer warning without a distinct treatment (proposed a new `.notice` callout class, bordered, sitting directly above the primary CTA, not buried in a footer alongside data-age text where it risks banner blindness).
5. **No "ok but zero trip options" state** — the plan's 5 typed states don't cover the case where the availability ID still resolves (`state: "ok"`) but zero business-cabin options come back. Flagged as a needed 6th soft-state / explicit empty treatment.

Full review was delivered as a prioritized chat response (not written to a file) — see conversation history if the plan doc itself gets amended and a re-review is needed.
