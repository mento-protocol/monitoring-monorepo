# Rebalance Failure Reason in Deviation Breach Alerts — Feasibility

**Question:** Can we surface the rebalance failure reason (e.g. "RLS_RESERVE_OUT_OF_COLLATERAL — Reserve has insufficient collateral to rebalance") in the v3 `Deviation Breach Critical` Slack alert?

**Conclusion:** Yes — the cheapest viable path is to vendor the existing `checkRebalanceStatus` probe into `metrics-bridge`, run it on a slower cadence for pools currently in critical breach, and emit a `mento_pool_rebalance_blocked{..., reason_code, reason_message}` gauge that the Slack template renders as a one-line annotation. Scope is contained (~300–400 LOC, all additive); no schema changes; no new RPC providers.

## 1. Where the probe runs

**Recommend `metrics-bridge`.** It already polls Hasura on a 30s cadence in a long-lived Cloud Run service, owns the existing pool gauges, and has a clear extension shape (just add a second gauge + a per-cycle probe). Adding `viem` + per-chain RPC URLs is the only real surface-area addition.

`indexer-envio` is the wrong host. The Envio model is event-driven — pulling in a "for every breach pool, simulate rebalance every 2 min" loop is a square-peg job that fights the runtime. We'd also pollute the indexer's RPC surface with non-event probes.

The dashboard's browser-side probe stays as-is for the pool-detail page. The metrics-bridge probe is operationally separate (different cadence, different cardinality) and mirrors the same `ERROR_MESSAGES` map by vendoring it.

## 2. Data needed

- `rebalancerAddress` — already on `Pool` (`indexer-envio/schema.graphql:95`). Add to the `BridgePools` GraphQL query + `PoolRow` type.
- Pool address — already in `pool.id` (we already strip the `chainId-` prefix via `poolIdAddress`).
- `chainId` — already on `PoolRow`.
- RPC URL per chain — **not** currently in `metrics-bridge/src/config.ts`. Add `RPC_URL_42220` (Celo), `RPC_URL_10143` (Monad testnet), `RPC_URL_143` (Monad mainnet), `RPC_URL_11142220` (Celo Sepolia). No HyperRPC tokens needed for `eth_call` probes — the indexer-envio already documents that HyperRPC doesn't support `eth_call`, so we use full-node RPCs (forno.celo.org, rpc2.monad.xyz, etc.).

## 3. Cardinality + cadence

Probing every pool every 30s is wasteful. Gating:

```
deviationBreachStartedAt > 0 AND Number(lastDeviationRatio) > 1.05
```

mirrors the `Deviation Breach Critical` rule's PromQL gate. At Mento's scale (30–50 pools, of which a small fraction sit in critical breach simultaneously), this is typically 0–3 probes per cycle — RPC load is trivial.

Cadence: every 5 polls (≈2.5 min wall-clock at the 30s base). The breach has to be sustained for 1h before the alert fires, so a 2.5 min probe cadence is well inside the noise floor.

Series cardinality: bounded by `pools × reason_codes`. The error enum has ~30 entries; in practice each pool emits at most one (its current revert) at a time. The series is RESET each cycle and only re-emitted for the current revert, so steady-state cardinality is bounded by `simultaneously-blocked pools` (~3–5), not the cross product.

## 4. How to expose the reason

**Recommend (a) — gauge with both `reason_code` and `reason_message` labels.** The Slack template can read `$labels.reason_message` directly, no sprig-dict lookup needed.

```text
mento_pool_rebalance_blocked{
  ...poolLabels,
  reason_code="RLS_RESERVE_OUT_OF_COLLATERAL",
  reason_message="Reserve has insufficient collateral to rebalance"
} 1
```

`reason_message` cardinality is bounded by the same enum as `reason_code` (one human string per code), so carrying it as a label costs nothing extra. Avoids an alert-template lookup table that would drift from `ERROR_MESSAGES` over time.

The gauge is `0` when the pool can rebalance, `1` when blocked. The alert's join uses `mento_pool_rebalance_blocked == 1` so absence/0 cleanly suppresses the annotation.

Considered (b) info-metric pattern — same cardinality, slightly fussier alert join. (a) wins on simplicity.

## 5. Decimals / enrichment — out of scope for v1

The dashboard's strategy-specific enrichment (e.g. "Reserve collateral: 0.00 USD₮") requires:

- Strategy-type detection (`getCDPConfig` vs `reserve()` vs `getPools()`).
- ERC20 symbol+decimals reads on the collateral or stability-pool token.
- BigInt → human-units conversion (`toHumanUnits` from `rebalance-check.ts:495`).

Replicating that in metrics-bridge means re-implementing token symbol resolution. **Drop for v1** — the operator can click through to the pool detail page (the alert already deep-links via `monitoring.mento.org/pool/{pool_id}`). State this scope cut explicitly in the PR description.

If a future iteration wants the collateral number in the alert body, the right path is the shared-package extraction (see §7), not bolting extra RPC calls into metrics-bridge.

## 6. Failure modes

| Mode                                                                    | Behaviour                                                                                                                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC down / 401 / timeout                                                | Emit no metric for that pool. Bridge logs `[REBALANCE_PROBE_FAILED]`. The underlying `Deviation Breach Critical` alert keeps firing — operator just doesn't see the reason annotation. |
| Strategy ABI decode fails (unknown error name)                          | `reason_code="unknown"`, `reason_message=<truncated raw revert>`. Alert still annotates, just with the raw selector.                                                                   |
| `LS_POOL_NOT_REBALANCEABLE` / `PriceDifferenceTooSmall` (healthy no-op) | Pool is below threshold — the gating in §3 already skips it. If we somehow probe and get this code, treat as not-blocked (don't emit the gauge).                                       |
| `getRpcClient` throws (unknown chain / missing token)                   | Logged once via `warnedUnknownChains` dedup; no metric emitted.                                                                                                                        |

The probe MUST NOT emit a misleading "ok" or "blocked" on transport-level failures — same invariant as the dashboard's SWR error state ("Diagnostics unavailable").

## 7. Reusing the UI logic — vendor for v1

`ui-dashboard/src/lib/rebalance-check.ts` is ~640 lines, but the bits we need are:

- The `STRATEGY_ABI` parseAbi block (errors only — we don't need `getCDPConfig` / `reserve()` / `getPools()` for detection in v1, see below).
- `ERROR_MESSAGES` (~60 lines).
- `decodeRevert` / `extractRevertData` / `isContractRevert` (~50 lines).
- `checkRebalanceStatus` (without strategy-type detection — see below).

We can simplify further: since we drop enrichment, **we don't need strategy-type detection**. Just call `rebalance(pool)` on the strategy address — for OLS strategies that always reverts (because `msg.sender == address(0)` fails the ERC20 transfer mid-execution), but the revert reason carries no useful signal anyway, so we'd want to skip OLS entirely. Simpler: add a comment + skip OLS detection by trying `rebalance(pool)`; if the decoded error is one of the OLS-token-transfer errors, treat as "probe inconclusive" and don't emit. The vendored code is then ~200 LOC.

**TODO future PR:** extract to `shared-config/rebalance-check` (or a new `shared-rebalance/` package) once metrics-bridge proves the contract is right. Adding a third consumer is the right time to invest in extraction.

## Recommended scope

Phase-2 implementation, contained PR:

1. **metrics-bridge:**
   - Add `viem` dep.
   - Vendor a slimmed `rebalance-check.ts` (probe + decode + ERROR_MESSAGES).
   - Add per-chain RPC URL config.
   - Add a separate `runRebalanceProbes()` cycle that runs every Nth poll (N=5).
   - Emit `mento_pool_rebalance_blocked` with `reason_code` + `reason_message` labels.
   - Vitest fixture-based tests for the decoder + cycle gating.

2. **terraform/alerts:**
   - Add a `B` data block to `Deviation Breach Critical` (and the `(anchored)` sibling) joining on `mento_pool_rebalance_blocked`.
   - New annotation `rebalance_reason` from `$labels.reason_message` + `$labels.reason_code`.
   - `slack_body_template` in `contact-points.tf`: `*Rebalance Blocked:*` line guarded by `{{ if .Annotations.rebalance_reason }}…{{ end }}`, rendered above the existing pool/started/links rows.

**Do NOT touch in this PR:** the linked pool title / "Open pool" link (separate PR), the `current_deviation` / `current_reserves` annotations (separate PR). The two parallel PRs and this one are designed to be additive and merge-conflict-free.
