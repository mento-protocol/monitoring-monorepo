---
title: Peg paging measures executable sell price; the deep venue pages alone
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: metrics-bridge / alerts
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0045 — Peg paging measures executable sell price; the deep venue pages alone

**Status:** Accepted (Jul 2026), in force. PRs #1497 and #1568 landed the
measurement and version-bound decision producer. PR #1581 implements the source
Grafana paging rules and routing. Protected policy publication and
authentication, producer activation, human-approved Grafana application, and
live proof remain rollout gates in
[`docs/PLAN-peg-monitoring.md`](../PLAN-peg-monitoring.md).
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

The bridge producer implements the measurement clauses below. The source rules
implement paging, blindness, and routing. The producer does not become
alert-authoritative until the remaining protected activation, application, and
live-proof gates pass.

- **Measurand.** Deviation is computed from the executable _sell_ price at
  a per-asset reference size tied to real exposure: the binding bound is
  `min(FPMM per-window trading limit, configured cap)`; the issuer
  redemption minimum is a default target only, and when the trading limit
  undercuts it the limit wins — refSize shrinks and the asset's coverage
  record notes the degraded comparability, never an ambiguous measurand.
  Deviation is never taken from the mid, and it is downside-only shortfall:
  `max(0, (target − executableSellPx) / target)` in bps, so a premium can
  never page the drain path and implementations cannot invert the sign. A
  sustained premium beyond the warn threshold surfaces as a warn-tier
  observation only — it stresses the reserve's opposite, bounded exposure,
  a different decision than the breaker trip. Observations carry `{vwap, filledFraction, capped}`;
  an observation that cannot fill the reference size is `capped` and is
  excluded from deviation alerting entirely — it feeds depth/stress
  signals instead of printing phantom deviation. A capped observation on
  the designated deep venue additionally counts as no usable primary
  price — it feeds `mento_peg_blind` — but blindness and stress must be
  independent conditions: the blind-while-stressed page requires a stress
  leg that is not the capped condition itself (structural saturation,
  envelope-excess spread, or a partial-fill VWAP shortfall at or beyond
  the critical threshold). A capped book still quoting par — benign depth
  thinning — stays warn-tier. Indexed-pool reachability never forces
  `mento_peg_blind`; a still-fresh usable deep-venue decision remains usable
  while the independent structural plane is unavailable. The version-bound
  `mento_peg_blind_consecutive_polls` gauge advances once per due deep-source
  cadence slot that produces no new usable uncapped decision, including a due
  slot where no structural reference size can be derived. It resets to zero
  on a usable decision, saturates at the approved `blindConsecutivePolls`
  threshold, and never advances on non-deep polls or intermediate loop ticks.
  A changed binding reference size also makes the deep source immediately due
  under the scheduler's existing semantics. This producer-side streak
  preserves a usable reset that occurs between Grafana evaluations.
- **The deep venue pages alone.** Sustained executable deviation beyond the
  critical threshold on the policy-designated deep venue (designated in
  the gated thresholds artifact, ADR 0044 — not in the registry) pages by
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
  explicit per-class policy is written and reviewed. Class semantics are
  deterministic, not declarative optimism: a validator maps every class to
  the independent capabilities it requires (e.g. `cex-book+indexed-pool`
  requires a policy-designated deep venue able to produce uncapped
  observations at reference size AND an indexed pool monitor distinct from
  every price source) and rejects declarations the source mix does not
  imply. Assets on chains or venues outside indexer coverage (XRPL books)
  have no structural plane and must say so.
- **Fatigue budget.** Warn is Slack-only with repeat suppression
  (alert-plane grouping and repeat-interval dedup); a hard per-asset daily
  notification cap is not expressible in the rules plane and, if ever
  needed, is stateful bridge-side work. Source _health_ problems are
  ops-noise tier and never page. Pager trust is a design invariant: the
  critical channel stays quiet enough to be believed.

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
- The bridge metric producer implements the executable-price, capped-depth,
  blindness, and coverage-class semantics. The source rules implement the
  alert expressions, states, and routing; production activation still requires
  the protected rollout gates. Changes to paging semantics remain ADR-level,
  not tuning.

## Evidence

- `docs/PLAN-peg-monitoring.md` (both adversarial review rounds and the
  EUROP market-structure evidence: live-verified venue depth, spread, and
  volume figures, 2026-07-22)
- `docs/notes/polygon-monitoring.md` (EURm/EUROP pool, MANUAL feed,
  migration-multisig breaker path)
- `metrics-bridge/src/peg/order-book.ts`,
  `metrics-bridge/src/peg/poller.ts`, and
  `metrics-bridge/src/peg/metrics.ts` (implemented measurement semantics)
- `metrics-bridge/src/peg/poll-cycle.ts` (version-bound decision scheduling
  and blind-streak state)
- `metrics-bridge/test/peg-order-book.test.ts`,
  `metrics-bridge/test/peg-poller.test.ts`, and
  `metrics-bridge/test/peg-metrics.test.ts`
- `alerts/rules/peg-thresholds.json` (dormant deep-venue and threshold policy)
- `alerts/rules/peg-promql-active.tf`, `peg-promql-previous.tf`,
  `peg-rule-definitions.tf`, and `peg-contact-points.tf` (implemented source
  rules and routing)
- ADRs 0042, 0043, 0044
