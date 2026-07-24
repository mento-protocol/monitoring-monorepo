---
title: "React Compiler annotation-mode pilot (archived)"
status: archived
owner: eng
canonical: false
last_verified: 2026-07-24
archived: 2026-07-23
archived_reason: "Pilot issue #709 closed 2026-06-17; retained as the evaluation record."
doc_type: note
scope: ui-dashboard
review_interval_days: 365
garden_lane: notes-plans-archive
---

# React Compiler annotation-mode pilot

Issue #709; implementation and evidence: PR #977.

## Current verification

- `ui-dashboard/next.config.ts` still uses annotation mode.
- `babel-plugin-react-compiler` remains a dashboard dependency.
- `PoolsContent` remains the only `"use memo"` source.
- The raw-address filter and sort-state browser regression still covers the
  annotated `/pools` surface.

## Historical result

The pilot chose `/pools` because it combined live data, URL-backed controls,
derived pool maps, sorting, and table rendering under existing browser
coverage. The compiler-enabled build took 26.30 seconds versus a 23.28-second
baseline: +3.02 seconds wall time and +1.4 seconds compile time. Functional and
trace-backed browser checks passed, but the experiment did not demonstrate a
repeatable render-count or responsiveness improvement.

## Decision record

At pilot close, the dashboard kept annotation mode and the single `/pools`
opt-in. Global compilation required a repeatable render or responsiveness gain
plus a green dashboard build and browser gate. No `"use no memo"` exclusion
was required at pilot close. Treat this as experiment history, not a current
rollout mandate.
