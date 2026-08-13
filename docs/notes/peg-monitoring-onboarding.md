---
title: Peg monitoring onboarding and re-census
status: active
owner: eng
canonical: true
last_verified: 2026-08-13
doc_type: runbook
scope: metrics-bridge / alerts / ui-dashboard
review_interval_days: 90
garden_lane: operator-runbooks
---

# Peg monitoring onboarding and re-census

Onboard an oracle-less asset only after its identity, executable price sources,
independent structural coverage, policy, producer, dashboard, and alert paths
are verified. Use this runbook to verify measurement, alert delivery, and the
human response handoff.

The architecture is fixed by ADRs
[0042](../adr/0042-metrics-bridge-external-price-poller.md),
[0043](../adr/0043-peg-registry-service-local.md),
[0044](../adr/0044-peg-thresholds-gated-rules-plane.md),
[0045](../adr/0045-peg-paging-semantics.md),
[0049](../adr/0049-peg-decision-package-read-model.md),
[0054](../adr/0054-same-project-peg-policy-artifact.md), and
[0057](../adr/0057-peg-observation-advancement.md).

## Completion states

- **Blocked:** one or more mandatory identity, source, coverage-class, or policy
  fields is missing, contradictory, or unsupported by current evidence.
- **Configured:** source-controlled registry, policy, producer, rules, and
  dashboard changes exist, but live producer and alert proof is incomplete.
- **Live:** every gate below passes against the deployed producer, the
  dashboard shows the same current package, and the protected alert rules are
  applied afterward and report Normal.

Configuration or a closed issue is not production proof. Record the evidence
date, block or provider response identity, reviewer, and source for every
mutable value.

## 1. Bind the asset and issuer by identity

Start from the token contract and issuer, never a ticker search result. Create
one onboarding record containing:

| Required field      | Evidence contract                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| Internal asset slug | Stable non-ticker key used by the registry and metrics                                                          |
| Issuer legal entity | Current primary issuer or regulatory evidence, with retrieval date                                              |
| Token identity      | Chain ID, checksum address, decimals, name, symbol, and canonical shared-config entry                           |
| Peg and redemption  | Peg currency, legal redemption unit, minimum, eligibility, settlement time, suspension terms, and evidence date |
| Monitor identity    | Chain, FPMM address, monitored token, manual rate-feed ID, and current breaker contract                         |
| Source identities   | Provider-specific exact pair identifiers; ticker aliases are discovery hints only                               |

Reject the record when contract and issuer evidence conflict, the token is not
canonical in shared-config, or the pool/feed/token tuple does not resolve
on-chain and in the indexed pool model.

## 2. Census executable price discovery

Use aggregators only to find candidates. Prove each candidate against its own
live provider surface:

1. Search issuer materials and CoinGecko for venue names and pair aliases.
   Bind every result back to the exact token contract and issuer.
2. Query the venue's authoritative pair listing. Record the provider pair ID,
   listing status, response time, and response identity where supplied.
3. Fetch the live book repeatedly across representative periods. Measure the
   executable **sell** VWAP, filled fraction, spread, publication age, and
   sequence at the proposed reference size. Mid-price and reported volume do
   not prove executable depth.
4. Search DexScreener and GeckoTerminal by token contract, then verify every
   candidate pool on-chain. Record liquidity, recent swaps, counterpart asset,
   and why its price is or is not independent of the monitored FPMM.
5. Search supported oracle catalogs by feed identity and pair composition.
   Shared-config rate-feed IDs are Mento feed IDs; do not treat them as
   Chainlink aggregator addresses.
6. Record issuer redemption and attestation evidence as human decision inputs.
   They have no alert authority without a separately reviewed machine-readable
   adapter.

Classify each accepted source as deep, secondary, or display in the gated
policy, with matching registry topology. Record every rejected source in the
registry with a concrete reason such as stale book, insufficient executable
depth, circular pool, unsupported chain, or unvalidated identity. Keep raw
census evidence outside the registry; leave enough source-controlled detail
for the next reviewer to reproduce the rejection.

## 3. Pass the coverage-class gate

The declared class describes reachable independent evidence. For
`cex-book+indexed-pool`, all of these must pass:

- One policy-designated deep CEX source returns an authoritative exact-pair
  listing and a fresh, uncapped executable sell observation at the derived
  reference size.
- Every positive enforced FPMM trading limit bounds the configured
  reference-size cap. A smaller on-chain bound wins.
- The monitored FPMM resolves through Hasura, contains the monitored token,
  and exposes its live TradingLimitsV2 state.
- The structural signal comes from that indexed FPMM and is distinct from
  every price source. A DEX-primary price from the same pool is circular and
  fails this class.
- Source and monitor identities pass registry/policy compatibility and
  shared-config referential-integrity checks.
- The deep-source critical deviation path and blind-while-independent-stress
  path are both reachable under ADR 0045. A secondary or display source does
  not substitute for a missing deep source.

If the asset cannot meet an existing class, stop. A new class needs reviewed
policy and architecture before onboarding; do not weaken a validator or
relabel a source to make the declaration pass.

## 4. Roll out the first activation producer-first

Use this sequence for the one-time first activation. It starts while
`local.peg_alerts_enabled` is `false` and ends with step 9's reviewed source
flip. The verified current boundary is in [Peg monitoring alert source
validation and activation](peg-monitoring.md). The manual `Peg Policy
Publication` workflow publishes policy only; runtime attachment and Grafana
consumers remain separate steps.

Use this order for the first activation topology:

1. Stage any adapter, parser, or poller support while the source-controlled
   registry and policy both remain at topology A. Deploy that code-only bridge
   revision and prove that it still serves the pinned A generation.
2. In one reviewed source change, define the additive A-to-B transition:
   registry B is the union topology needed to serve both versions, policy
   `active` exactly matches registry B, and `previous` is the exact A policy.
   Record rejected-source evidence in that change. Never merge a registry-only
   or policy-only source state; the integrity contract requires exact
   active-registry parity. Do not deploy the registry B image yet.
3. Through the separately reviewed `Peg Policy Publication` workflow, inspect
   its read-only `main` plan and then approve its `production-infra` apply to
   publish B as the immutable private GCS generation described by
   [ADR 0054](../adr/0054-same-project-peg-policy-artifact.md). Keep the runtime
   pinned to A.
4. Deploy the bridge revision containing union registry B while the runtime
   remains pinned to A. The registry superset can serve A; verify that A keeps
   polling before changing the runtime pin.
5. Through the owning platform path, pin the runtime to the exact B generation
   by replacing the current source-controlled
   `local.peg_policy_runtime_generation` literal (`null` for first activation)
   with the protected publisher's exact quoted positive output. In that same
   rollout, set `metrics_bridge_template_rollout_active = true` and remove
   `template[0].revision` from `ignore_changes`, then verify metadata
   authentication. After the approved apply and runtime proof, use a separate
   stabilization change to restore the marker to `false` and the ignore. Pause
   unrelated full platform applies while the marker is `true`.
   During rollout, old A-registry replicas serve retained A while B-registry
   replicas serve active B and retained A. An unpinned `current.json` URL, a
   `-var` override, or a provider-CLI overwrite is forbidden.
6. Verify that Metrics Bridge selects and acknowledges the exact policy
   version. Prove authoritative listing state, producer-side bounded absence
   streak, executable-price metrics, structural metrics, and the ADR-0049
   decision package from the production revision. Accumulate the complete
   policy decision-history window before enabling consumers.
7. Confirm the package reports the intended monitor, coverage class, deep
   source, reference size, listing confirmation threshold, and freshness.
   Keep the asset Configured while producer evidence is absent or stale.
8. Provision the dashboard's server-only bridge URL through IaC, deploy the
   dashboard, and browser-verify current, stale-last-confirmed, and unavailable
   behavior against the same policy version. For this first activation,
   `https://monitoring.mento.org/peg-monitoring` has a live current package and
   no console errors. The focused Playwright flow proves the retained-stale
   transition, and the page-client regression covers unavailable state and
   recovery.
9. Only after producer and dashboard proof, merge a reviewed source change that
   sets `local.peg_alerts_enabled` to `true`. Do not open the consumers through
   a workflow, Terraform variable, GitHub variable, or policy artifact. After
   that source flip reaches protected `main`, review and explicitly approve the
   protected apply. Never apply it from an agent session. Confirm active and
   retained-previous rules are Normal and use the documented direct contact
   points.
10. Mark Live only after the dashboard version matches the producer and the
    registry-rot, critical-path, indexed-pool, blindness, and deviation paths
    are reachable.

Rollback reverses dependencies. Through a reviewed protected apply, remove the
Grafana consumers before withdrawing a producer metric. Then remove the
dashboard consumer and only afterward roll back the producer. Removing producer
metrics first can turn active no-data alerts into incidents or make retained
rules unevaluable.

For a failed active runtime pin, keep the runtime pinned and select the last
known-good published generation with recorded producer, API, and metric proof.
Replace the concrete source literal with that exact quoted generation in a
reviewed platform change, set `metrics_bridge_template_rollout_active = true`,
remove `template[0].revision` from `ignore_changes`, review and apply the
platform plan, then verify the new revision, producer acknowledgement,
`/health`, policy API, and Peg metrics. Restore the marker to `false` and the
ignore in a separate stabilization change. Never set the literal to `null` or
edit Cloud Run environment values manually.

If a runtime-pin apply or proof fails, keep the rollout marker `true` and the
revision ignore absent. Inspect the live revision and state, then use a new
reviewed plan to complete the pin or explicitly roll back its template change.
Restore steady state only after the live template matches the reviewed result;
pause unrelated full platform applies until then.

Do not reuse steps 2–9 after the first activation sets
`local.peg_alerts_enabled` to `true`. A later policy change currently changes
the private artifact and the enabled Grafana rule definitions in the same full
`alerts-rules` plan. That can install new fail-closed rules before the producer
selects the new policy. Turning the global guard back off would remove every
live Peg consumer, and a targeted apply is forbidden.

The separate policy-publication boundary is now available for staged A-to-B
rollovers. Per-policy consumer activation remains out of scope: when Grafana
consumers are already enabled, do not combine a policy rollover with consumer
changes or bypass the protected publication and runtime-pinning sequence.

## 5. Respond to a critical peg page

Critical Peg alerts page Splunk On-Call and mention `@support-engineer` in
`#alerts-critical`. The current support engineer coordinates the response until
another responder explicitly takes over. The alert starts a human decision
process; it does not authorize a protocol change by itself.

1. Acknowledge the page in `#alerts-critical`, start or link the incident
   thread, and state who is coordinating.
2. Capture the alert, current decision package, and Grafana history. Check the
   exact policy and source, executable price, fill, spread, structural flow,
   freshness, and source health. Query the deep venue directly and compare the
   independent sources so stale or partial data is not mistaken for a de-peg.
   Do not edit policy or silence the alert during triage.
3. Read the affected rate and breaker contracts at a current safely confirmed
   block. Record the chain, block, contract addresses, current on-chain control
   owner, and whether that owner is the operative Safe. Do not rely on a saved
   owner address.
4. Give the evidence and proposed response to the current on-chain control
   owner. The humans controlling the Safe decide whether to change the breaker
   or trading state; `@support-engineer` coordinates and records the decision.
   Execute an approved action only through the normal Safe proposal and signing
   flow. If the control path is unclear or unavailable, keep escalating in the
   incident thread and make no control change.
5. After execution, wait for the chain's normal finality and record the Safe
   proposal or transaction link, transaction hash, chain, block, action,
   decision owner, and time in the incident thread.
6. Keep the incident open until direct on-chain reads match the decision, the
   producer package is fresh, the dashboard shows the same current state, and
   the critical alert resolves for the expected reason. Record those recovery
   checks. Route any lasting source, policy, or alert change through the normal
   reviewed deployment path.

## 6. Interpret scheduled re-census

The scheduled re-census is the authoritative exact-pair listing lookup at the
start of every policy-due configured-source poll. It validates configured
pairs only; it never discovers markets, adds sources, or mutates registry or
policy topology.

The producer owns confirmation. It increments
`mento_peg_listing_absent_consecutive_checks` only on a successful
authoritative `absent` response, resets the bounded streak on authoritative
`listed` or `halted`, and preserves it across unknown failures. Grafana reads
the instant streak and current one-hot state. It must not reconstruct checks
from scrape counts, range minima, or timestamp changes because resets may occur
between scrapes.

| Result                                                    | Meaning and action                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Listed with usable book                                   | Continue normal executable-price evaluation                                                                      |
| Listed with empty book                                    | Market evacuation; preserve listing evidence and use blindness/stress semantics                                  |
| Halted but present                                        | Trading interruption; source health/blindness may fire, but do not call it registry rot                          |
| Exact pair absent from a successful authoritative listing | Increment the bounded absence streak; alert only at the effective exact-version policy threshold                 |
| Timeout, rate limit, transport, or schema failure         | Unknown; preserve the last authoritative state, timestamp, and streak while health/staleness handles the failure |

Only an authoritative response advances `mento_peg_listing_checked_at`.
Unknown, missing, or stale evidence is not delisting. Listing confirmation can
still succeed when the later book fetch fails, so listing alerts do not gate
on source health, observation time, or the asset heartbeat. Source validators
require every policy source to declare its bounded listing-confirmation
threshold. During the production transition only, Metrics Bridge accepts the
omission from the exact legacy retained version
`europ-2026-07-22-v1-a69b99aad61649957a2639dc8348b05f` and normalizes it to
`2` in decision packages. Remove that runtime shim in a follow-up PR after the
`previous: null` generation is published, pinned, and live-verified;
[#1750](https://github.com/mento-protocol/monitoring-monorepo/issues/1750)
tracks that removal.

A source restoration is not enough by itself. Repeat the executable-depth and
coverage gates before restoring alert authority.

## 7. Respond to registry rot and clean up policy

1. Acknowledge the alert and inspect the decision package plus Grafana history.
2. Query the provider's authoritative listing directly. Distinguish absent,
   halted, empty-book, and transport failure before changing configuration.
3. For a missing deep source, treat critical monitoring as unreachable and
   open the re-onboarding change. Do not delete the source only to silence the
   alert.
4. Census and validate a replacement. Stage and deploy its adapter support with
   registry and policy topology A unchanged, as in Section 4 stage 1.
5. Keep registry and policy topology A unchanged until the replacement's
   additive A-to-B publication, runtime pin, and producer proof are scheduled.
   Do not change Grafana consumers through the publication workflow.
6. Keep the monitoring incident open until the replacement source is live and
   the affected alerts have recovered. Do not delete the old source only to
   silence the alert.

The replacement path adds the replacement through an additive A-to-B rollover,
clears `previous` only after acknowledgement and a full decision-history
window, and retires the old source through a later B-to-C rollover. Use the
protected publication and runtime-pinning sequence in Section 4; consumer
activation stays a separate reviewed change.
