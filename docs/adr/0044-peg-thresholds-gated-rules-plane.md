---
title: Peg alert thresholds stay in the gated alerts-rules plane, read from one JSON
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: alerts
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0044 — Peg alert thresholds stay in the gated alerts-rules plane, read from one JSON

**Status:** Accepted (Jul 2026), in force. PRs #1497 and #1568 landed
bridge-side policy validation, version-bound decision metrics, and producer
acknowledgment state. This change implements the source rule ladder and routing.
Protected policy publication and authentication, producer activation,
human-approved Grafana application, and live proof remain separate rollout
gates tracked by [`docs/PLAN-peg-monitoring.md`](../PLAN-peg-monitoring.md).
**Scope:** alerts

## Context

Peg monitoring adds a per-asset alert class (warn/critical deviation bps,
sustain windows, structural-saturation thresholds). Two governance designs
were considered. The first — export thresholds as metrics
(`mento_peg_critical_bps{asset}`) and let one static Grafana rule compare
`composite > threshold` — makes onboarding require no Terraform apply at
all.

Adversarial review rejected it as a governance regression: paging
thresholds would move from the `production-infra` human-approval gate
([ADR 0029](0029-ci-apply-production-infra-gate.md)) onto the ungated
service-deploy path (`pnpm bridge:deploy` needs no approval), a reviewer
would see no Terraform diff for a paging-policy change, and the repo's
threshold-parity machinery would be orphaned for the new class. Rule-level
concerns compound it: severity, routing, mute timings, and `no_data_state`
are deliberately per-rule in this stack, and a single series-join rule
auto-resolves a live page whenever the threshold series blips.

## Decision

Phase 3 must implement the following protected artifact and rules contract:

- Peg thresholds — and every declared parameter that changes whether a
  page can fire: warn/critical bps, sustain windows, per-source reference
  sizes, staleness gates, spread-envelope parameters, per-source poll
  cadences (the coverage predicate's expected cadence and the loop's
  actual cadence come from this same approved artifact, so an ungated
  cadence change can neither suppress nor cheapen coverage), and the
  deep-venue (primary) designation — are data in one repo-internal JSON
  (`alerts/rules/peg-thresholds.json`), consumed by the alerts stack via
  `jsondecode(file(...))` with `dynamic "rule"` / `for_each` generation —
  both established patterns in this repo. The service-local registry
  (ADR 0043) holds venue identity and topology only; it carries no
  page-affecting policy. Delivery to BOTH planes is gated: the
  `production-infra` apply regenerates the Grafana rules and publishes the
  same policy content as an IaC-owned versioned runtime artifact that the
  bridge polls — the bridge never bakes this JSON into its image, exports
  `mento_peg_policy_version`, and the rules assert version freshness, so
  an ordinary ungated bridge deploy cannot activate page-affecting policy
  ahead of approval. Each version ends with the first 32 hexadecimal
  characters of the SHA-256 digest of its canonical content (excluding the
  version field). Canonicalization recursively sorts object keys by Unicode
  code point, preserves array order, and then hashes the compact JSON encoding;
  runtime and CI verify that binding so a restarted replica cannot reuse one
  metric label for changed semantics. Activation is two-phase because
  artifact publish and bridge pickup cannot be atomic: the generated rules
  evaluate both the previous and new exact policy versions while `previous`
  is retained. Producer acknowledgment resolves the distinct rollover-stuck
  alert but never terminates old-version decisions by itself. After
  acknowledgment and a complete active decision-history window, a separately
  reviewed policy change sets `previous` to `null`; that apply removes the
  retained rules and artifact content. No wall-clock expiry can leave the
  rules without an accepted producer version, and deviation evaluation stays
  live on the previous policy through cleanup. CI also compares the candidate
  artifact with the current base policy: a changed active version must retain
  that exact prior active object as `previous`; an unchanged active version
  may only preserve or remove its retained predecessor. A second active
  rollover is rejected until that predecessor has been cleared after
  acknowledgment. There is no HCL mirror,
  so the existing mirror-drift check is unnecessary for this class; a sibling integrity
  check validates at source level: every threshold source key and the
  deep-venue designation must name an existing registry source id, every
  alert-authoritative source must carry complete policy (reference size,
  gates), and every registry asset must have a threshold entry and vice
  versa — a mistyped or renamed source id must fail the build, not
  silently leave an asset's critical path unreachable. Residual trust boundary, stated plainly: the gate protects
  declared policy data — bridge _code_ remains service-deployable and has
  always been able to change what any `mento_*` metric means; measurement
  code is governed by normal review, not the apply gate.
- Changing any peg threshold or onboarding an asset's rules is therefore a
  reviewed PR plus a human-approved `alerts-rules` apply through the
  `production-infra` gate. That apply-per-asset cost is deliberate: paging
  policy for a breaker-tripping decision deserves the same review as every
  other threshold in the stack.
- Per-rule semantics follow stack conventions:
  - Every peg rule is freshness-gated on `mento_peg_observation_at` /
    heartbeat using the established `time() - *_at` idiom — a stalled
    poller must never satisfy or suppress a rule with stale gauge values.
    `mento_peg_observation_at` advances only on an authoritative
    venue-data timestamp or sequence from the venue payload, never on mere
    HTTP fetch success; a source whose venue-side signal stops advancing
    fails closed to unhealthy, so a frozen at-par book behind a healthy
    endpoint cannot certify freshness or coverage during a real depeg.
  - Blindness and heartbeat rules set `no_data_state = "Alerting"` with the
    documented justification and ~5-minute grace, following the
    bridge-down/pool-coverage precedent: for these rules, absence of data
    is the signal. The producer publishes a policy-versioned consecutive-blind
    poll count and resets it on each usable uncapped deep-venue decision. Rules
    compare that count directly with `blindConsecutivePolls`; Grafana's
    evaluation interval never stands in for a faster producer cadence.
  - Deviation sustain uses a duration-fraction window
    (`quantile_over_time`) rather than the rule `for` clock alone, so a
    single favorable sample on a thin, flapping book cannot reset a real
    breach; this is a new idiom in the stack, adopted deliberately for
    thin-market series and documented in the rule file banner. Range
    functions ignore gaps, so the quantile counts as a duration fraction
    only when two sample-coverage predicates also pass: `increase` over the
    monotonic per-source poll-success counter
    (`mento_peg_poll_success_total`) and over the monotonic uncapped
    decision counter (`mento_peg_usable_decision_total`), each compared
    against the expected poll cadence. A timestamp-gauge `changes`
    undercounts polls that land between scrapes, and raw `count_over_time`
    counts scrapes of a retained gauge. Requiring both counters prevents
    capped or unchanged successes plus one deviated sample from being read
    as a sustained breach.
  - Severity and routing stay per-rule: warn → Slack, critical → page, each
    with its own contact-point wiring.

## Alternatives considered

- **Thresholds-as-metrics + one static rule** — rejected: bypasses the
  production-infra gate, invisible paging-policy diffs, no_data/auto-resolve
  hazards (detailed above).
- **Hand-written HCL per asset with TS mirror + drift check** — rejected:
  the mirror exists today only because two code planes both need the
  constants; for peg rules the JSON is the single consumer-facing source,
  so `jsondecode` removes the mirror instead of policing it.
- **Thresholds inside the peg registry
  ([ADR 0043](0043-peg-registry-service-local.md))** — rejected: the bridge
  does not evaluate alert thresholds (rules do), and placing paging policy
  in a service-deployable file recreates the governance bypass through the
  back door. The registry and the thresholds JSON are cross-checked
  instead.

## Consequences

- Onboarding an asset touches exactly two reviewed data files (registry +
  thresholds JSON) and requires one gated apply — a feature, preserving
  human sign-off on anything that can page or justify a breaker trip.
- The alerts stack gains its first `jsondecode`-driven rule group; the
  pattern is available for future per-asset rule classes.
- The integrity check joins the quality gate and CI, so a registry/threshold
  mismatch fails before review.

## Evidence

- `docs/PLAN-peg-monitoring.md` (review findings that reversed the
  thresholds-as-metrics lean)
- `alerts/rules/peg-thresholds.json` (dormant source policy)
- `metrics-bridge/src/peg/policy.ts`,
  `metrics-bridge/src/peg/compatibility.ts`, and
  `metrics-bridge/src/peg/runtime.ts` (implemented bridge-side policy
  validation and activation path)
- `metrics-bridge/src/peg/poll-cycle.ts` and
  `metrics-bridge/src/peg/metrics.ts` (version-bound producer decisions and
  acknowledgment telemetry)
- `metrics-bridge/Dockerfile` (gated policy excluded from the service image)
- `scripts/check-peg-registry-integrity.mjs` (cross-plane source contract)
- `alerts/rules/rules-reserve-balances.tf`, `rules-oracle-relayers.tf`
  (per-key `for_each` threshold precedents)
- `alerts/rules/rules-metrics-bridge.tf` (deliberate `no_data_state =
"Alerting"` precedent)
- `scripts/check-deviation-threshold-drift.mjs` (the mirror-drift pattern
  this class deliberately avoids needing)
- ADRs 0029, 0043, 0045
