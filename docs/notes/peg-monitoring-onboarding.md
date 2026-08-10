---
title: Peg monitoring onboarding and re-census
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
doc_type: runbook
scope: metrics-bridge / alerts / ui-dashboard
review_interval_days: 90
garden_lane: operator-runbooks
---

# Peg monitoring onboarding and re-census

Admit an oracle-less asset only after its identity, executable price discovery,
independent structural coverage, breaker response, and worst-case drain budget
are evidenced. Unknown owner, signer, timing, or loss inputs block onboarding;
the monitoring repository must not invent them.

The architecture is fixed by ADRs
[0042](../adr/0042-metrics-bridge-external-price-poller.md),
[0043](../adr/0043-peg-registry-service-local.md),
[0044](../adr/0044-peg-thresholds-gated-rules-plane.md),
[0045](../adr/0045-peg-paging-semantics.md),
[0054](../adr/0054-same-project-peg-policy-artifact.md), and
[0049](../adr/0049-peg-decision-package-read-model.md), and
[0057](../adr/0057-peg-observation-advancement.md).

## Completion states

- **Blocked:** one or more mandatory identity, coverage, control, SLA, or loss
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
| Control identity    | Current on-chain owner or Safe for the rate and breaker path, read at a pinned block                            |
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

## 4. Prove breaker control and response SLA

Record current on-chain control at a pinned block, then obtain explicit owner
approval for:

| Mandatory field             | Required evidence                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| Breaker and rate-feed owner | On-chain read at the recorded chain and block                                                            |
| Safe address and threshold  | On-chain Safe owners and threshold at that block; list accountable role, not private signer details      |
| Signer coverage             | Coverage hours, holidays, fallback coverage, and the owner who attests it                                |
| End-to-end response SLA     | Worst approved time from alert delivery through diagnosis, proposal, signatures, execution, and finality |
| Escalation owner and route  | Named accountable team or role plus the maintained escalation runbook or channel                         |
| Execution proof             | Recent drill or transaction proving the required threshold can act inside the SLA                        |

The signer SLA is a safety input, not a monitoring default. Missing signer
coverage, escalation ownership, or execution proof leaves the asset Blocked.
Do not infer an SLA from a Safe threshold, a past fast transaction, or alert
delivery time alone.

## 5. Bound drain over the response interval

Read every trading-limit input live at one pinned block and record:

- `d_FPMM` from
  `FPMM.getTradingLimits(monitoredToken).config.decimals`, plus an independent
  `ERC20.decimals()` read; require an exact match or mark the asset **Blocked**;
- positive enforced L0 and L1 limits in TradingLimitsV2's 15-decimal internal
  scale, converted to token units;
- each window duration and pinned `netflow` and `lastUpdated` state for
  incident-specific diagnostics;
- pool reserves, manual rate, fee parameters, and the exact quote method;
- the approved end-to-end signer response SLA `S`; and
- the treasury/risk-approved survivable quote-asset loss budget `B`.

For persistent **Live** admission, prove the TradingLimitsV2 contract invariant
`-L_i <= n_i <= L_i` for every positive enforced window `i`; otherwise mark the
asset **Blocked**. Keep `L_i`, `n_i`, and window duration `W_i` in the contract's
fixed-15 internal scale. `D_net(S)` is a bound on fee-adjusted netflow, not a
raw monitored-token amount:

```text
D_live,i(S) = 2L_i + L_i * ceil(S / W_i)
D_net(S) = min(D_live,i(S) for every positive enforced window i)
```

`2L_i` covers the reachable active state `n_i = -L_i`; the ceiling term covers
a reset immediately after the incident begins. At equality the old window is
still active, and reset requires strict expiry. Pinned `n_i` and timestamps can
support incident-specific diagnostics, but must never reduce persistent
admission capacity. Disabled zero-valued windows do not constrain the minimum.
If no positive limit is enforced, onboarding fails.

`D_net(S)`, `A_max`, and `G_mono` bound only cumulative fee-adjusted FPMM swap
netflow. `FPMM.swap` applies TradingLimitsV2, while `FPMM.rebalance` does not.
Never use these values as a whole-system quote-asset loss cap. An Open strategy
contraction can transfer the debt token from the pool to its permissionless
caller, and a Reserve strategy expansion can mint the debt token into the pool.
Model each strategy rebalance as a separate transition and include its actual
protected-boundary transfers, even when its configured incentive is zero. A
strategy being unreachable at the pin because of its price threshold is a
pinned diagnostic, not a durable exclusion.

Read both fees at the same pin and set `F = lpFee + protocolFee` in basis
points. Require `0 <= F < Q`, use `C = D_net(S)`, `Q = 10,000`, and use only
the verified `d_FPMM` as `d`; never convert capacity through decimal floats or
apply the fee before fixed-15 scaling.

For `d <= 15`, calculate:

```text
A_max = floor(C * Q / (Q - F))
G_mono = floor(A_max / 10^(15 - d))
```

`G_mono` bounds monotone monitored-token inflow only. For `d > 15`, default to
**Blocked**. An exception needs a reviewed, independently enforceable bound
`N` on successful calls that covers every swap during `S`, including zero-netflow
and batched calls. With `k = 10^(d - 15)`, calculate
`G_N = k * A_max + N * (k - 1)`. Do not quote `G_N` as one swap; model every
successful transition sequentially.

Signed netflow permits counterflows to reopen capacity. Before relying on a
monotone bound, require either a proof that no reachable reverse swap,
rebalance, incentive-bearing transfer, or rate transition can leave the system
at the same or lower signed netflow with more accumulated net quote-asset loss
than the monotone path, or a bounded bidirectional sequential state model.
That model must start from every reachable pre-incident **Live** state, not
only the pin, and maximize loss across mutable pool reserve, rate, fee, limit,
enabled strategy, cooldown, and source-liquidity state. If a mutable state can
leave the modeled envelope without enforced fail-closed revocation or
reapproval, maximize across its reachable range or keep the asset **Blocked**.
Without that proof or model, or with a positive effective rebate, mark the asset
**Blocked**.

Bind either an enforced no-change or no-arbitrage rate condition while trading
remains bidirectional, or an enforced maximum number of successful rate
transitions during `S`. Without one, alternating tradable rates plus signed
counterflows can accumulate quote-asset loss while returning netflow to the same
state.

At the pin, enumerate every enabled strategy from
`LiquidityStrategyUpdated` history through that block; do not rely on one
`rebalancerAddress`.
For each strategy, record the per-pool
`liquiditySourceIncentiveExpansion`, `liquiditySourceIncentiveContraction`,
`protocolIncentiveExpansion`, `protocolIncentiveContraction`,
`protocolFeeRecipient`, cooldown, reachability, source liquidity, and actual
transfers. Mark the asset **Blocked** if any strategy cannot be conservatively
reproduced. `FPMM.rebalanceIncentive` is an exchange-rate discount/tolerance,
not a separate payout: model its effect through actual transfers and never
double-count it. A static pool-reserve snapshot caps loss only when every
enabled strategy proves unavailable during the response interval.

For each sequentially reachable swap, call
`FPMM.getAmountOut(amountIn, tokenIn)` from the modeled state, using that
transition's actual input amount and token. A monitored-to-quote leg uses the
monitored token; a reverse leg uses the quote token. Advance pool, limit, and
strategy state after every successful swap or rebalance. The quote already
applies the total fee; do not subtract `F` a second time. Define loss as
**net** quote-asset outflow across a documented protected-system boundary:
include quote inputs and outputs, mint/burn, and actual strategy transfers. Do
not use a gross output sum. The model must place flows across the relevant
window boundaries and cannot replace a sequence with one oversized swap when
reserves or a strategy can change state.

Record the calls or deterministic calculation. If an exact quote cannot be
reproduced, use the manual par purchase value plus a documented conservative
margin and keep the limitation explicit. The gate passes only when:

```text
worst_case_net_quote_outflow(sequential state model) <= B
```

The accountable treasury/risk owner must supply and approve `B`. Monitoring
engineers must not derive it from current TVL, trading limits, or intuition.
Persistent **Live** admission is a fail-closed certificate over the approved
Safe and signer coverage, escalation route, execution proof, `S`, `B`, and
modeled on-chain state ranges. Give every human attestation an explicit expiry.
Before serving **Live**, require every certificate input to remain within its
approved range and every attestation to remain current; otherwise serve
**Blocked** until reapproval repeats the pinned reads and loss calculation. If
that validity check cannot be enforced, onboarding remains **Blocked**.

## 6. Roll out the first activation producer-first

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
   with the protected publisher's exact quoted positive output and removing
   `template[0].revision` from `ignore_changes` in the same reviewed change,
   then verify metadata authentication.
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
reviewed platform change, keep `template[0].revision` removed, review and apply
the platform plan, then verify the new revision, producer acknowledgement,
`/health`, policy API, and Peg metrics. Never set the literal to `null` or edit
Cloud Run environment values manually.

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

## 7. Interpret scheduled re-census

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

## 8. Respond to registry rot and clean up policy

1. Acknowledge the alert and inspect the decision package plus Grafana history.
2. Query the provider's authoritative listing directly. Distinguish absent,
   halted, empty-book, and transport failure before changing configuration.
3. For a missing deep source, treat critical monitoring as unreachable. Engage
   the recorded escalation owner, assess current pool exposure and breaker
   readiness, and open the re-onboarding change. Do not delete the source only
   to silence the alert.
4. Census and validate a replacement. Stage and deploy its adapter support with
   registry and policy topology A unchanged, as in Section 6 stage 1.
5. Keep registry and policy topology A unchanged until the replacement's
   additive A-to-B publication, runtime pin, and producer proof are scheduled.
   Do not change Grafana consumers through the publication workflow.
6. Use the recorded escalation, breaker, and exposure controls while monitoring
   stays degraded. Do not delete the old source only to silence the alert.

The replacement path adds the replacement through an additive A-to-B rollover,
clears `previous` only after acknowledgement and a full decision-history
window, and retires the old source through a later B-to-C rollover. Use the
protected publication and runtime-pinning sequence in Section 6; consumer
activation stays a separate reviewed change.

## EUROP seeded record and mandatory blockers

The repository currently declares the following configuration. These values
identify what to verify; they do not prove that live venue, signer, or
trading-limit state is unchanged.

| Field                      | Repository evidence                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset and peg              | `europ-schuman`, EUR                                                                                                                                                                   |
| Token                      | Polygon `137`, `0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51`                                                                                                                            |
| Monitor                    | EURm/EUROP pool `0xcd8c6811d975981f57e7fb32e59f0bee66af3201`; manual feed `0xc22418a83dfc262b10a1f57e25309db83e7ea79e`                                                                 |
| Coverage class             | `cex-book+indexed-pool`                                                                                                                                                                |
| Deep source                | Bitvavo `EUROP-EUR` (`bitvavo_eur`)                                                                                                                                                    |
| Non-deep sources           | Kraken `EUROP/EUR` (`kraken_eur`) and display-only `EUROP/USD` (`kraken_usd`) with the configured Polygon EUR/USD conversion feed                                                      |
| Rejected sources           | Bit2Me `EUROP/EUR` for tiny/frequently stale book; Curve `EUROP/EURC` for zero observed volume; XRPL `XRP/EUROP` and `EUROP/RLUSD` for unsupported indexer/canonical identity coverage |
| Documented control address | Polygon migration multisig `0x58099B74F4ACd642Da77b4B7966b4138ec5Ba458`; re-read current ownership before relying on it                                                                |

### Dated verification snapshot

The implementation census collected the following candidate evidence on
2026-07-22 at Polygon block `90702630` (`2026-07-22T22:22:22Z`). Re-read every
mutable value before production activation.

- [Schuman's legal center](https://schuman.io/legal-center/) identified Salvus
  SAS, trading as Schuman Financial, as the issuer, with registration
  `920 017 134` and ACPR register number `739803`. The then-current
  [white paper](https://schuman.io/wp-content/uploads/EUROP-White-Paper.pdf),
  redemption policy, and
  [official contract list](https://schuman.io/smart-contracts/) described par
  redemption with no minimum and matched the Polygon token address.
- `SortedOracles.owner()`, `BreakerBox.owner()`, and
  `ValueDeltaBreaker.owner()` returned the documented migration Safe. The Safe
  had threshold `4` and these six owners at the pinned block:
  `0xb1074D0F9E54763e073C7Fdb25B622B4326327Cb`,
  `0x95be2b73D313768D3B2DfEeca3213Ed0a6434060`,
  `0x66B94446F5fF3f0d8673C1f502A298B50ba2f0ce`,
  `0x6Dec25D7bE9BF6C6Fc302977629f2E801e98611c`,
  `0x7A678c8F9E8a7ac08c8c6f34d38126F3219958f2`, and
  `0x628FFA32ab958c5b9Ce74D8b81D73F335c3776B0`.
- The EUROP/EUR ValueDeltaBreaker was enabled in trading mode `0`, with a
  50-bps effective threshold and `1e24` reference value.
- `getTradingLimits(EUROP)` returned 50,000 EUROP per five minutes and 250,000
  EUROP per day in token units. Both last-updated values were outside their
  windows at the pinned block and positive-inflow saturation was zero.

This snapshot closes identity, control-address, Safe owner-set and threshold,
and live-limit discovery only for that dated block. EUROP remains **Blocked**
until accountable owners supply and approve:

- **Signer coverage and end-to-end response SLA:** coverage hours, fallback,
  holidays, and a worst approved diagnosis-to-finality time.
- **Escalation owner and maintained route:** a named accountable team or role
  and the route responders will use.
- **Execution proof:** a recent drill or transaction showing that four current
  signers can complete the breaker path inside the approved SLA.
- **Boundary-aligned drain calculation:** after `S` is approved, refresh the
  pool, fee, rate, reserve-access, and trading-limit reads, then calculate the
  exact worst-case quote outflow.
- **Approved survivable quote-asset loss budget:** treasury/risk must supply
  `B`; monitoring must not infer it from pool liquidity or trading limits.

Do not copy the dated market-depth figures from
[`docs/PLAN-peg-monitoring.md`](../PLAN-peg-monitoring.md) into an approval.
Repeat the census and attach current evidence.
