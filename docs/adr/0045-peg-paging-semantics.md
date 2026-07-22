---
title: Peg paging measures executable sell price; the deep venue pages alone
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
scope: metrics-bridge / alerts
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0045 — Peg paging measures executable sell price; the deep venue pages alone

**Status:** Accepted (Jul 2026), in force. Decided ahead of implementation;
mechanics land per [`docs/PLAN-peg-monitoring.md`](../PLAN-peg-monitoring.md).
**Scope:** metrics-bridge / alerts

## Context

For an oracle-less asset the FPMM pays par against a hardcoded feed, so the
protocol's risk is one-directional: what can the asset be _sold_ for
elsewhere while the pool buys it at par. Market structure for such assets
is hostile to naive monitoring — one or two market-maker order books,
tiny secondary venues, dead DEX pools. Two adversarial review rounds
established: mid-price is pinnable by a single MM; spread/staleness gates
silence the market exactly when it evacuates; "quorum of independent
sources" is fiction when one firm quotes every book; and requiring
corroboration before paging leaves a real depeg stuck at warn whenever the
corroborating signal is throttled (trading limits), absent (pool paused),
or structurally missing (thin second venue).

## Decision

- **Measurand.** Deviation is computed from the executable _sell_ price at
  a per-asset reference size tied to real exposure (bounded by the FPMM
  per-window trading limit, floored near the issuer redemption minimum) —
  never from the mid. Observations carry `{vwap, filledFraction, capped}`;
  an observation that cannot fill the reference size is `capped` and is
  excluded from deviation alerting entirely — it feeds depth/stress
  signals instead of printing phantom deviation.
- **The deep venue pages alone.** Sustained executable deviation beyond the
  critical threshold on the registry-designated deep venue pages by
  itself. Corroboration — structural drain saturation, or uncapped
  deviation on a second distinct venue — raises page annotation/priority
  but is never a precondition. Rationale: a false page costs one human
  look; a suppressed real depeg costs reserve drain at par.
- **Structural signal.** The un-pinnable anchor is the pool itself: net
  directional inflow measured against the trading-limit-implied maximum
  rate (saturation fraction). Counterparty diversity is advisory/dashboard
  only — it is sybil-inflatable, router-collapsible, and anti-correlated
  with the single-arb drain. The structural signal never pages alone (it
  is cheap to grief with benign par swaps); masking a real drain, by
  contrast, requires buying the depegged asset at par — real cost.
- **Market states are signals with benign-cause discrimination.** Spread
  widening on the deep venue counts as stress only beyond that venue's
  observed diurnal envelope; thin secondary venues' book-shape states
  (dust-flippable) never escalate; an empty book is classified as market
  evacuation only while the venue's live listing still carries the pair —
  otherwise it is registry rot. Blindness (no usable primary price) always
  alerts, and loss of the deep venue raises a distinct
  "critical path unreachable — re-onboard" alert requiring human ack.
- **Coverage classes.** Each registry asset declares which paging paths its
  source mix can reach (e.g. `cex-book+indexed-pool`). Onboarding an asset
  whose class leaves critical unreachable, or whose price and structural
  signals are the same venue (DEX-primary circularity), fails unless an
  explicit per-class policy is written and reviewed. Assets on chains or
  venues outside indexer coverage (XRPL books) have no structural plane
  and must say so.
- **Fatigue budget.** Warn is Slack-only, deduped, with a per-asset daily
  budget; source _health_ problems are ops-noise tier and never page.
  Pager trust is a design invariant: the critical channel stays quiet
  enough to be believed.

## Alternatives considered

- **Mid-price + spread/staleness gating (v1)** — rejected: pinnable, and
  gates silence evacuating markets — the review's Friday-night walkthrough
  showed the critical path structurally unable to fire.
- **Corroboration-required paging (v2)** — rejected: every corroborating
  branch can be unavailable during a genuine depeg (limit-throttled flow,
  paused pool, capped second venue); the lattice pinned real depegs at
  warn.
- **Multi-venue quorum as the false-positive defense** — rejected:
  venue-distinctness is necessary (two books on one exchange never count
  twice) but shared market-making makes truly independent N ≈ 1–2;
  honesty about that beats arithmetic theater.
- **Counterparty diversity as a paging input** — rejected for the reasons
  above; kept advisory.

## Consequences

- A single motivated actor pushing the deep venue's book can force a page
  (~tens of k€ sustained against an active MM); accepted — the page is a
  human review with the full decision package, not an automated halt.
- Truly unobservable depegs (books pinned at par, no pool flow, OTC-only
  price discovery) remain undetectable by construction; issuer-side
  signals (redemption status, attestations) are runbook inputs, not
  automated sources — this residual risk is documented, not hidden.
- Alert expressions, states, and the coverage-class gate are specified
  before implementation; changes to paging semantics are ADR-level, not
  tuning.

## Evidence

- `docs/PLAN-peg-monitoring.md` (both adversarial review rounds and the
  EUROP market-structure evidence: live-verified venue depth, spread, and
  volume figures, 2026-07-22)
- `docs/notes/polygon-monitoring.md` (EURm/EUROP pool, MANUAL feed,
  migration-multisig breaker path)
- ADRs 0042, 0043, 0044
