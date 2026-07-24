---
title: Peg monitoring onboarding and re-census
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
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
[0048](../adr/0048-private-gcs-peg-policy-artifact.md), and
[0049](../adr/0049-peg-decision-package-read-model.md).

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

- monitored-token decimals;
- positive enforced L0 and L1 limits in TradingLimitsV2's 15-decimal internal
  scale, converted to token units;
- each window duration and current `netflow` and `lastUpdated` state;
- pool reserves, manual rate, fee parameters, and the exact quote method;
- the approved end-to-end signer response SLA `S`; and
- the treasury/risk-approved survivable quote-asset loss budget `B`.

For each positive enforced window `i` with token limit `L_i` and duration
`W_i`, calculate the conservative unknown-boundary token-inflow bound:

```text
D_i(S) = L_i * (ceil(S / W_i) + 1)
D_token(S) = min(D_i(S) for every positive enforced window i)
```

The extra window is mandatory because an incident can begin immediately before
a lazy window reset and consume capacity on both sides of the boundary.
Disabled zero-valued windows do not constrain the minimum. If no positive
limit is enforced, onboarding fails.

Convert `D_token(S)` into quote-asset outflow with the deployed pool's exact
pricing and fee logic at the pinned block. Record the call or deterministic
calculation and cap only at liquidity that is provably unavailable to the
drain. If an exact quote cannot be reproduced, use the manual par purchase
value plus a documented conservative margin and keep the limitation explicit.
The gate passes only when:

```text
worst_case_quote_outflow(D_token(S)) <= B
```

The accountable treasury/risk owner must supply and approve `B`. Monitoring
engineers must not derive it from current TVL, trading limits, or intuition.
Recalculate after any signer-SLA, Safe, fee, pool, rate, reserve-access, or
trading-limit change.

## 6. Roll out producer first

Use this repeatable sequence only after the one-time activation hold and the
policy-only publication and runtime-pinning infrastructure tracked in
[Peg monitoring alert source validation and activation
hold](peg-monitoring.md) are live. Until then, the dormant policy has no
executable production publication path and these steps must not be presented
as available commands.

Use this order for a new asset or source topology:

1. Stage any adapter, parser, or poller support while the source-controlled
   registry and policy both remain at topology A. Deploy that code-only bridge
   revision and prove that it still serves the pinned A generation.
2. In one reviewed source change, define the additive A-to-B transition:
   registry B is the union topology needed to serve both versions, policy
   `active` exactly matches registry B, and `previous` is the exact A policy.
   Record rejected-source evidence in that change. Never merge a registry-only
   or policy-only source state; the integrity contract requires exact
   active-registry parity. Do not deploy the registry B image yet.
3. Through a separately reviewed protected alerts-rules apply whose diff
   contains the policy object and no Grafana consumers, publish B as the
   immutable private GCS generation described by ADR 0048. Keep the runtime
   pinned to A.
4. Deploy the bridge revision containing union registry B while the runtime
   remains pinned to A. The registry superset can serve A; verify that A keeps
   polling before changing the runtime pin.
5. Through the owning platform path, pin the runtime to the exact B generation
   and verify metadata authentication. During rollout, old A-registry replicas
   serve retained A while B-registry replicas serve active B and retained A.
   An unpinned `current.json` URL or a provider-CLI overwrite is forbidden.
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
   behavior against the same policy version.
9. Only after producer and dashboard proof, review and explicitly approve the
   protected follow-up that activates Grafana rules. Never apply it from an
   agent session. Confirm active and retained-previous rules are Normal and use
   the documented direct contact points.
10. Mark Live only after the dashboard version matches the producer and the
    registry-rot, critical-path, indexed-pool, blindness, and deviation paths
    are reachable.

Rollback reverses dependencies. Through a reviewed protected apply, remove the
Grafana consumers before withdrawing a producer metric. Then remove the
dashboard consumer and only afterward roll back the producer. Removing producer
metrics first can turn active no-data alerts into incidents or make retained
rules unevaluable.

The one-time identity bootstrap, dormant producer, and first alert activation
hold are tracked in [Peg monitoring alert source validation and activation
hold](peg-monitoring.md). Do not collapse those initial gates into this
repeatable onboarding sequence.

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
on source health, observation time, or the asset heartbeat. The exact retained
legacy policy omits `listingAbsentConsecutiveChecks` and has an effective
threshold of `2`; every newer policy must declare the bounded threshold.

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
5. Add the replacement through the Section 6 additive transition: source
   registry B contains the old and replacement sources, active policy B
   exactly matches that union, and `previous` retains exact A. Complete stages
   2 through 9, then, after acknowledgement, the full decision-history window,
   and active plus retained-previous rule proof, apply cleanup that sets
   `previous` to `null`. Active B still contains both sources.
6. Retire the old source in a separate B-to-C removal rollover after B cleanup.
   In one source change, make registry C and active policy C both omit the old
   source and retain exact B as `previous`. Do not deploy the registry C bridge
   image: keep the already deployed union registry B because it is the
   topology superset that can serve both active C and retained B.
7. Publish C through the policy-only protected apply, pin the runtime to C,
   prove the producer and dashboard, and activate the C plus retained-B
   Grafana consumers. After acknowledgement, the full decision-history window,
   and rule proof, apply cleanup that sets `previous` to `null`.
8. Only after that cleanup may the bridge image move from union registry B to
   registry C. Re-run coverage, signer-SLA, drain-budget, producer, dashboard,
   and rule checks before returning the asset to Live.

This order prevents a registry deploy from making both active and retained
policy incompatible and prevents policy cleanup from opening a monitoring gap.

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
