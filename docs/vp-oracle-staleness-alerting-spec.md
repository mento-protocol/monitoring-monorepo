# Spec: Close the virtual-pool oracle-staleness alerting gap

Status: investigation complete, implementable. No code changed yet.

## TL;DR decision

The gap is **larger than the indexer-only assumption in the brief**. There are
actually **two** independent blind spots, and the binding one is the metrics
layer, not `health.ts`:

1. **Indexer/UI health** short-circuits virtual pools to `"N/A"` _before_ the
   oracle-staleness check (`indexer-envio/src/pool/health.ts:211`,
   `ui-dashboard/src/lib/health.ts:244`). Even if we fix this, the indexer's
   `oracleExpiry` for a VP is the wrong window (1-week token expiry, not the
   360s `referenceRateResetFrequency`).
2. **Metrics-bridge hard-filters virtual pools out of Prometheus entirely**
   (`metrics-bridge/src/graphql.ts:8` `source _like "%fpmm%"` + `poller.ts:100`
   `data.Pool.filter(isFpmmPool)`). **No `mento_pool_*` series exists for any
   VirtualPool today.** No alert can fire on a series that is never published.

**Scenario decision (task 2): (A) with a caveat.** Virtual-pool `Pool` rows
_already_ get `oracleOk` / `lastOracleReportAt` / `oracleExpiry` populated by the
SortedOracles fan-out (proven below). So the indexer does **not** need new
freshness-population wiring. BUT `oracleExpiry` is populated from the wrong
source (1-week token expiry), so a new field carrying the 360s reset-frequency
window is required for the freshness predicate to be correct for VPs. And the
metrics-bridge needs a new VP code path because VPs are filtered out before any
gauge is emitted.

So the real change set is: **health.ts reorder (×2) + a new
`oracleFreshnessWindow` field on Pool fed from `referenceRateResetFrequency` +
a VP gauge path in metrics-bridge + a new alert rule + a testnet route + parity
test additions.**

---

## Findings (with file:line evidence)

### Task 1 — Pool data model & field lifecycle

`Pool` entity: `indexer-envio/schema.graphql:1-186`. Relevant freshness fields:

| Field                 | Schema         | Set by (FPMM)                                                                                                              | Set by (VP)                                                                                          |
| --------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `source`              | `:14`          | `"fpmm_*"` at FPMMDeployed                                                                                                 | `"virtual_pool_factory"` or `"virtual"` substring; healed VPs may keep `fpmm_*` (`helpers.ts:60-81`) |
| `wrappedExchangeId`   | `:181`         | always `""`                                                                                                                | bytes32 exchangeId, set at VirtualPoolDeployed / self-heal (`self-heal.ts:391`)                      |
| `referenceRateFeedID` | `:33` `@index` | set at FPMMDeployed                                                                                                        | **mirrored from BiPoolExchange** via `mirrorFeedIdToPool` (`self-heal.ts:412-428`, `:302-321`)       |
| `oracleOk`            | `:27`          | `true` on every OracleReported/MedianUpdated (`sortedOracles.ts:163,533`)                                                  | **same — VPs are in the fan-out**                                                                    |
| `oracleTimestamp`     | `:29`          | event report time / block time                                                                                             | same                                                                                                 |
| `oracleExpiry`        | `:31`          | `reportExpiryEffect` = `tokenReportExpirySeconds` (1 week for CAD) (`sortedOracles.ts:132-139`, `oracle-state.ts:263-319`) | **same — WRONG window for VPs**                                                                      |
| `lastOracleReportAt`  | `:70`          | advanced only in MedianUpdated, frozen on zero-median outage (`sortedOracles.ts:542-544`)                                  | same                                                                                                 |

`isVirtualPool(pool)` (`helpers.ts:77-81`) keys on
`source.includes("virtual") || Boolean(wrappedExchangeId)`. Disjoint from FPMMs
(FPMMs never carry `wrappedExchangeId`).

`referenceRateResetFrequency` (the correct VP freshness window, 360s for CAD)
is **NOT on Pool** — it lives on `BiPoolExchange` (`schema.graphql:615`),
linked to the VP via `Pool.wrappedExchangeId` ↔ `BiPoolExchange.id` and the
back-ref `BiPoolExchange.wrappedByPoolId` (`schema.graphql:631`). It is read
from `getPoolExchange` and stored at `handlers/biPoolManager.ts:113` and
`:344-345` (defaulting to `0n` on RPC-struct failure), and in the self-heal seed
`self-heal.ts:256`.

### Task 2 — Do VP Pool rows get freshness fields populated? **YES (scenario A).**

`SortedOracles.OracleReported` / `MedianUpdated` fan out over
`getPoolsByFeed(context, chainId, rateFeedID)` (`sortedOracles.ts:331,432`),
which queries `Pool.getWhere({ referenceRateFeedID: { _eq: rateFeedID } })`
(`rpc.ts:129-149`). Because the VP's `referenceRateFeedID` is mirrored from its
wrapped exchange (`self-heal.ts:302-321,412-428`), **a virtual pool IS returned
by `getPoolsByFeed` and IS processed by the per-pool worker**, which sets
`oracleOk=true`, `oracleTimestamp`, `oracleExpiry`, and (MedianUpdated only)
`lastOracleReportAt` — `sortedOracles.ts:158-172` and `:527-547`.

Note the per-pool workers gate the _breach/health/deviation_ pipeline behind
`isVirtualPool`-aware helpers (`priceDifferenceForOracleSample` skips VPs,
`sortedOracles.ts:50-58`). The oracle freshness cursor is written for VPs in the
normal path, but the implementation must also bypass the existing
`tokenDecimalsKnown` cursor-hold for VPs because VP median freshness does not
depend on token decimals. Without that exception, a decimal self-heal failure can
keep a VP looking stale after a fresh median. So freshness data is mostly present
today; the missing pieces are the VP exception to the cursor hold, the health
_classification_, and the _expiry window_.

→ **Conclusion: (A, with one implementation caveat).** No new oracle-event
source is needed, but the implementation must add (i) the correct window field,
(ii) the health reorder, and (iii) a VP exception to the token-decimal cursor
hold so median freshness can advance independently of decimal trust.

### Task 3 — `oracleExpiry` source & the correct VP window

`oracleExpiry` is `SortedOracles.tokenReportExpirySeconds(feed)` (falling back to
the global `reportExpirySeconds`), `oracle-state.ts:281-318`. For CAD this is
**1 week** — the per-token report expiry, which is the staleness bound for
`isOldestReportExpired`, NOT the bound that makes a _virtual pool price_. The
virtual pool reverts via `BiPoolManager.oracleHasValidMedian()` when
`medianTimestamp ≤ now − referenceRateResetFrequency` (360s for CAD). The
indexer already stores that 360s value on `BiPoolExchange.referenceRateResetFrequency`.

The freshness predicate that should now apply to VPs already exists for the
derive path: `lastOracleReportAt + window > now`
(`priceDifference.ts:316-318`). We need that predicate to use **360s**, not the
1-week `oracleExpiry`, for VPs.

**Recommended wiring:** add a new `Pool.oracleFreshnessWindow: BigInt!`
(defaults `0n` = unknown). Populate it:

- For VPs: from the wrapped exchange's `referenceRateResetFrequency`, mirrored
  alongside the existing `mirrorFeedIdToPool` call in `self-heal.ts`
  (`selfHealWrappedExchangeId`, and the BiPoolManager forward/reverse link
  paths), and explicitly refreshed when `BucketsUpdated` could change reset
  frequency. Do not rely only on existing stub-only `getPoolExchange` re-reads;
  already-populated exchanges need their mirrored Pool window refreshed too.
- For FPMMs: leave `0n`; the health code keeps using `oracleExpiry` for FPMMs.

Do **not** overload `oracleExpiry` itself — it is also surfaced as a gauge and
used by FPMM freshness; repurposing it for VPs would corrupt FPMM semantics.

### Task 4 — Health-status semantics for a stale-oracle VP

Deviation/reserve health genuinely doesn't apply to constant-sum VPs (correct
to keep `isInDeviationBreach`/`effectiveThreshold` out-of-scope:
`health.ts:246`). But **oracle staleness does** — a stale oracle is exactly the
failure that breaks USDm→CADm pricing.

**Recommendation: option (a) — reorder so the freshness check runs before the
`isVirtualPool → "N/A"` short-circuit, using the VP-correct window.** Keep all
deviation logic gated on `!isVirtualPool` so VPs never enter the deviation tier.
This keeps one health function, one parity test, and one metric semantic.

### Task 5 — UI / indexer parity

Three files mirror each other:

- `indexer-envio/src/pool/health.ts:207-237`
- `ui-dashboard/src/lib/health.ts:239-268`
- `indexer-envio/test/healthStatusParity.test.ts`

The UI already has weekend reclassification: `computeHealthStatus` returns
`"WEEKEND"` when `isOracleStale && isWeekend()` (`ui health.ts:249-254`). The UI
uses **wall-clock + `oracleExpiry`** (`isOracleFresh`, `ui health.ts:197-209`)
while the indexer uses the event-time `oracleOk` flag — this divergence is
explicitly **not** covered by the parity suite (`health.ts:192-205`, parity test
header `:5-19`). So the VP-freshness addition must be mirrored structurally in
both, but the parity test only needs new cases for the branches both share
(the new VP short-circuit ordering and the deviation tier staying out of scope
for VPs).

### Task 6 — Metric + alert rule + weekend gate + routing

- **Bridge is FPMM-only.** `metrics-bridge/src/graphql.ts:8,51,64,77` filter
  `source _like "%fpmm%"`; `poller.ts:100` further drops anything with a
  `wrappedExchangeId` via `isFpmmPool` (`types.ts:61-63`). Gauges are emitted in
  `recordOracleMetrics` (`metrics.ts:418-438`) — `mento_pool_oracle_ok`,
  `mento_pool_oracle_contract_ok`, `mento_pool_oracle_live_timestamp`,
  `mento_pool_oracle_expiry`, `mento_pool_health_status`. **None have a
  source/type/is_virtual label; `referenceRateResetFrequency` is never exposed.**
- **Weekend gate.** `alerts/rules/main.tf:99` `fx_weekend_gate_promql`
  (Sat all day, Sun <23:00, Fri ≥21:00 UTC). Pair selection is **exclusion-based**:
  `usd_pegged_pair_regex` (`main.tf:93-98`) — anything not USD-pegged↔USD-pegged
  is FX. **CADm/GHSm/AUDm/ZARm/COPm/BRLm/PHPm/NGNm/KESm/XOFm all match the FX
  side already; no per-pair regex edit needed for the bridge-side suppression.**
- **Consuming alerts** (FPMM-only, `service="fpmms"`): Oracle Liveness, Oracle
  Down, Oracle Liveness Critical, Oracle Contract Down
  (`alerts/rules/rules-fpmms.tf:21,164,251,345`). The composed FX-suppressed
  liveness lives in `fx_oracle_pause_promql` / `oracle_live_down_active_promql`
  (`main.tf:185-215`).
- **Trading-halt (GHS/USD) alert** is independent: `rules-trading-modes.tf:1-79`
  reads the Aegis `BreakerBox_getRateFeedTradingMode{chain="..."}` metric, keyed
  on the `chain` label (value `celo-sepolia`), iterating `local.chains`. This is
  why GHS halted but CAD did not page — and neither path covers the 6-min-to-
  1-week virtual-pool staleness band.
- **celo-sepolia** = chain id `11142220`, slug `celo-sepolia`
  (`shared-config/chain-metadata.json:12-13`). Metrics-bridge gauges carry
  `chain_name="celo-sepolia"` + `chain_id="11142220"`; Aegis/relayer alerts
  carry a `chain` label populated from the chain key (`celo-sepolia` for this
  specific staging case).
- **Routing gap.** Testnet routes in `notification-policies.tf` match
  `service` + `chain` over `local.staging_chains` and point at
  `grafana_contact_point.slack_alerts_testnet` (`protocol-contact-points.tf:69-78`,
  default `#alerts-testnet`). Existing routes cover `service="oracle-relayers"`
  and `service="exchanges"` (`notification-policies.tf:288-342,413-432`) — **not
  `service="fpmms"`**. A new VP-oracle alert must adopt a label scheme that an
  `#alerts-testnet` policy matches (see change set).

---

## Concrete change set

### 1. Indexer health: `indexer-envio/src/pool/health.ts`

Add a VP-aware freshness check that runs before the `isVirtualPool → "N/A"`
return, using the VP window. `computeHealthStatus` currently takes
`(pool, nowSeconds)`. Unknown-window VPs degrade to `N/A` even when the default
`oracleOk=false` has not been healed yet; once the window is known, the VP is
stale if `oracleOk=false`, the median timestamp is missing, or the median
timestamp has reached the inclusive expiry boundary.

```ts
export function computeHealthStatus(
  pool: Pool,
  nowSeconds: bigint,
): IndexerHealthStatus {
  // Oracle staleness applies to BOTH FPMM and virtual pools — it is the only
  // health axis that does. Check it before the VP "N/A" short-circuit.
  // VPs price via BiPoolManager.oracleHasValidMedian, whose window is the
  // wrapped exchange's referenceRateResetFrequency (mirrored to
  // oracleFreshnessWindow), NOT the 1-week token oracleExpiry.
  if (isVirtualPool(pool)) {
    if (pool.oracleFreshnessWindow === 0n) return "N/A";
    if (
      !pool.oracleOk ||
      pool.lastOracleReportAt === 0n ||
      pool.lastOracleReportAt + pool.oracleFreshnessWindow <= nowSeconds
    ) {
      return "CRITICAL";
    }
    return "N/A"; // deviation/reserve health genuinely doesn't apply
  }
  if (!pool.oracleOk) return "CRITICAL";
  // ... unchanged FPMM path
}
```

`isInDeviationBreach` / `effectiveThreshold` stay unchanged — they already
short-circuit VPs (`health.ts:246`).

### 2. New schema field: `indexer-envio/schema.graphql`

```graphql
  # Oracle freshness window for VIRTUAL pools, in seconds — the wrapped v2
  # exchange's `referenceRateResetFrequency`. Distinct from `oracleExpiry`
  # (SortedOracles tokenReportExpirySeconds, ~1 week) because a virtual pool
  # prices via BiPoolManager.oracleHasValidMedian, which reverts when
  # medianTimestamp <= now - referenceRateResetFrequency (~360s). 0n = unknown
  # (FPMM pools, or VP whose wrapped exchange isn't linked yet).
  oracleFreshnessWindow: BigInt!
```

Add `oracleFreshnessWindow: 0n` to the Pool defaults (wherever the entity is
constructed — `pool.ts` `getOrCreate`/defaults).

### 3. Window population: `indexer-envio/src/pool/self-heal.ts` + biPoolManager handlers

Mirror `referenceRateResetFrequency` onto the VP Pool wherever
`referenceRateFeedID` is already mirrored:

- In `selfHealWrappedExchangeId` (`self-heal.ts:287-321`), when `exchange` is
  resolved, also carry `oracleFreshnessWindow: exchange.referenceRateResetFrequency`
  into the returned healed pool (alongside `referenceRateFeedID`).
- In `mirrorFeedIdToPool` (or a sibling `mirrorResetFreqToPool`), set the window
  when it changes. Simplest: extend `mirrorFeedIdToPool` to also accept and write
  the reset frequency from the same `exchange` object, so both forward
  (VirtualPoolDeployed) and reverse (`BiPoolManager.ExchangeCreated`) link paths
  populate it. The seed path `self-heal.ts:256` already has the struct value.
- Add an explicit non-stub refresh path for governance changes to
  `referenceRateResetFrequency`: on `BucketsUpdated`, re-read `getPoolExchange`
  (or otherwise fetch the current struct even when `referenceRateFeedID` is
  already populated) and, if the exchange has a `wrappedByPoolId`, push the
  refreshed reset frequency to that Pool.

Edge: when `referenceRateResetFrequency === 0n` (RPC-struct failure default,
`biPoolManager.ts:345`), leave `oracleFreshnessWindow` at `0n` — the health
check's `> 0n` guard then declines to fire (no false page on unknown window).

### 4. UI health: `ui-dashboard/src/lib/health.ts`

Add the VP staleness branch before the `isVirtualPool → "N/A"` return, with
weekend reclassification, using the UI's wall-clock model and the new window.
Add `oracleFreshnessWindow` to `PoolHealthState`, but fetch it with the same
schema-lag-safe companion-query/degraded-mode pattern used for other newer Pool
fields. Do not add it directly to the primary pool list/detail queries until the
hosted indexer schema has rolled everywhere, or a schema-lag window can blank the
primary dashboard response.

```ts
export function computeHealthStatus(pool, chainId?, nowSeconds = ...): HealthStatus {
  if (isVirtualPool(pool)) {
    const window = Number(pool.oracleFreshnessWindow ?? "0");
    const medianTs = Number(pool.lastOracleReportAt ?? "0");
    const stale =
      window > 0 &&
      (pool.oracleOk === false ||
        medianTs === 0 ||
        medianTs + window <= nowSeconds);
    if (stale) return isWeekend() ? "WEEKEND" : "CRITICAL";
    return "N/A";
  }
  // ... unchanged FPMM path
}
```

So a weekend-stale CADm VP renders `WEEKEND`, a weekday-stale one renders
`CRITICAL`. `computeEffectiveStatus` / `worstStatus` already handle the result.

### 5. Parity test: `indexer-envio/test/healthStatusParity.test.ts`

Add a shared block (and mirror in `ui-dashboard/src/lib/__tests__/health.test.ts`):

- VP with unknown window (`oracleFreshnessWindow=0n`) and `oracleOk=false` → `N/A`
  (degraded mode, no false page before the reset-frequency window is known).
- VP with fresh oracle (`oracleOk=true`, `lastOracleReportAt + window > now`) → `N/A`.
- VP with known window and `oracleOk=false` → `CRITICAL`.
- VP with known window but `lastOracleReportAt=0n` → `CRITICAL`.
- VP with `oracleOk=true` but `lastOracleReportAt + window <= now` (e.g.
  window=360, report 10h ago) → `CRITICAL` (indexer) / `WEEKEND` on weekend (UI).
- Existing "returns N/A for virtual pools" cases (`:24-38`) should keep asserting
  the unknown-window degraded mode: `oracleFreshnessWindow=0n` stays `N/A`, even
  if `oracleOk=false`. Add separate known-window fixtures for the critical path.

`test/helpers/makePool.ts` needs an `oracleFreshnessWindow` default (`0n`).

### 6. Metrics-bridge: publish VP oracle gauges

This is the load-bearing addition — without it no series exists to alert on.

- **GraphQL** (`metrics-bridge/src/graphql.ts`): add a VP query (or relax the
  filter). Cleanest is a **companion** `BRIDGE_VP_POOLS_QUERY` selecting
  `source _like "%virtual%"` OR `wrappedExchangeId _neq ""`, with fields
  `id, chainId, token0, token1, source, wrappedExchangeId, oracleOk,
oracleTimestamp, lastOracleReportAt, oracleFreshnessWindow`. Companion so a
  schema-mismatch only drops VP gauges, not all FPMM gauges (mirrors the
  existing companion-query rationale at `graphql.ts:1-7`).
- **Poller** (`poller.ts:100`): in addition to `data.Pool.filter(isFpmmPool)`,
  process the VP rows through a new `recordVpOracleMetrics`.
- **Metrics** (`metrics.ts`): add a dedicated gauge, e.g.
  `mento_pool_vp_oracle_fresh` with the existing `poolLabels` set
  (`chain_id, chain_name, pair, pool_id, pool_address_short`). Value `1` when
  `oracleOk` is true, `lastOracleReportAt > 0`, and
  `lastOracleReportAt + oracleFreshnessWindow > now`; otherwise `0`. Skip
  emission when
  `oracleFreshnessWindow == 0` (unknown — avoids false `0`).
  Optionally also emit `mento_pool_vp_oracle_freshness_window` (the 360s value)
  for dashboards. The `pair` label (e.g. `CADm/USD`) is what the FX weekend gate
  matches on.

### 7. Alert rule: new `alerts/rules/rules-vp-oracles.tf`

Prefer a separate rule group that iterates `local.chains`, filters the metric by
the per-chain `chain_name`, and labels the alert with that same chain key. Do
not stamp a literal `chain="celo-sepolia"` on a generic alert, or production
series could route as staging. Also do not rely on the root notification policy
from inside `rules-fpmms.tf` unless this new rule omits rule-level
`notification_settings`; that file's existing direct notification settings
bypass the policy tree. If the rule uses direct `notification_settings`, the
contact point must be selected from `rule.value.env` explicitly.

```hcl
# Virtual-pool oracle staleness: the wrapped exchange's median is older than
# its referenceRateResetFrequency, so BiPoolManager.oracleHasValidMedian
# reverts and the swap app can't price the pair (e.g. USDm->CADm). FX-weekend
# gated so closed-market staleness is expected, not paged.
expr = <<-EOT
(
  mento_pool_vp_oracle_fresh{chain_name="${rule.key}"} < 0.5
)
unless on(chain_id, pool_id, pair) (
  mento_pool_vp_oracle_fresh{chain_name="${rule.key}", pair!~"${local.usd_pegged_pair_regex}", pair=~".+/.+"}
  and on() ${local.fx_oracle_pause_gate_promql}
)
EOT
for  = "5m"
labels = {
  service  = "vp-oracles"
  chain    = rule.key
  severity = rule.value.env == "prod" ? "page" : "warning"
}
annotations = {
  summary = "Virtual pool {{ $labels.pair }} on {{ $labels.chain_name }} has a stale oracle (older than its reset frequency); swaps for this pair will revert with \"no valid median\"."
}
```

The RHS reuses the existing time gate (`main.tf:101`) but first selects only FX
VP series and then matches back on `chain_id, pool_id, pair`. This mirrors the
existing FPMM suppressor shape and prevents the label-less weekend gate from
suppressing USD-pegged/non-FX VP incidents.

### 8. Testnet routing: `alerts/rules/notification-policies.tf`

If the rule omits rule-level `notification_settings`, add an `#alerts-testnet`
policy that matches `service="vp-oracles"` plus the preserved per-series chain
identity. The preferred shape is a `local.staging_chains` fan-out matching
`service` + `chain` where the rule label sets `chain = rule.key`; alternatively
match the existing metric label `chain_name` directly. Either way, the route must
preserve chain identity from the firing series. It must never hard-code
`celo-sepolia` on a generic rule.

---

## Test plan

**Existing tests that must change**

- `indexer-envio/test/healthStatusParity.test.ts:24-38` — keep coverage for
  "virtual pool → N/A" when `oracleFreshnessWindow=0n`, then add the new
  known-window VP-staleness cases (task-5 list).
- `ui-dashboard/src/lib/__tests__/health.test.ts` — mirror.
- `metrics-bridge/test/*` — any snapshot of emitted gauge names will change;
  add coverage for `mento_pool_vp_oracle_fresh` (fresh=1, stale=0, unknown-window
  skipped).
- `metrics-bridge/test/deviation-alert-state.test.ts` enforces the
  `USD_PEGGED_SYMBOLS` ↔ `main.tf` drift guard — no change needed (we reuse the
  exclusion-based FX classifier), but re-run it.

**New test cases**

- Indexer parity: VP fresh / known-window `oracleOk=false` / known-window
  missing median timestamp / window-exceeded / unknown-window degraded mode
  (above).
- Indexer handler integration: feed an `OracleReported` + `MedianUpdated` for a
  CAD VP and assert `oracleFreshnessWindow` is populated from the wrapped
  exchange's `referenceRateResetFrequency`, and that a synthetic "report 10h ago,
  window 360s, now" yields `healthStatus="CRITICAL"`.
- Alert rule unit test (if the repo has promtool/terraform alert tests): assert
  the VP-oracle expr fires for a stale FX VP, is suppressed for that FX VP during
  the weekend window, and still fires for a stale non-FX/US-dollar VP during the
  weekend.

**Live validation against celo-sepolia CAD**

- Exchange `referenceRateResetFrequency = 360s`, rate feed
  `0xc9dbD89FCe5710C91c35Ed9af1dc93fA090A28B0`.
- After deploy, query Hasura for the CADm VP `Pool` row and confirm
  `oracleFreshnessWindow == 360`, `referenceRateFeedID` matches the feed, and
  `wrappedExchangeId` is set.
- Confirm `mento_pool_vp_oracle_fresh{pair="CADm/USD",chain_name="celo-sepolia"}`
  is published and reads `0` while the CAD/USD oracle is the ~10h-stale state, and
  `1` after a fresh median.
- Confirm the alert preserves the chain label and routes the celo-sepolia case to
  `#alerts-testnet` (fire a test/silence check), and that it is suppressed during
  the FX weekend window.

---

## Risks / edge cases

- **Weekend false-positives and false-suppression.** The VP staleness alert MUST
  wrap FX pairs in `fx_oracle_pause_gate_promql`, and the suppressor RHS MUST
  restrict itself to FX pairs (`pair!~usd_pegged_pair_regex`). Without the weekend
  gate, CAD/GHS/etc. would page every Saturday when the FX oracle legitimately
  stops reporting; without the FX-only RHS, non-FX VP incidents would be hidden
  during the weekend too. The UI's `WEEKEND` reclassification (`isWeekend()`)
  handles the dashboard side.
- **`referenceRateResetFrequency = 0` (unknown / backfill).** Default on RPC
  failure (`biPoolManager.ts:345,468`). Both the health check (`window === 0n`
  returns `N/A`) and the gauge (skip when `0`) must decline to fire — never page
  on an unknown window. Self-heal will populate it on a later event; until then
  the VP stays `N/A`, which is the safe pre-fix behaviour.
- **Self-heal timing.** A pre-start_block VP whose `wrappedExchangeId` /
  `referenceRateFeedID` aren't linked yet won't be in `getPoolsByFeed` and won't
  have a window. It will surface `N/A` until self-heal lands
  (`self-heal.ts:183-399`) — acceptable; the alert simply doesn't exist for that
  pool yet rather than mis-firing.
- **`lastOracleReportAt` under-bound.** It advances only on `MedianUpdated`
  (`sortedOracles.ts:542-544`) and freezes on zero-median outages. This is the
  _correct_ anchor for VP staleness (it mirrors the contract's median timestamp),
  and using it under-bounds freshness safely — a single-reporter feed that
  refreshes without a `MedianUpdated` won't falsely read fresh. (The FPMM gauge
  deliberately uses `oracleTimestamp` instead, `metrics.ts:425-430`; for the VP
  path use `lastOracleReportAt` because the median timestamp is what the VP
  contract checks.)
- **Mainnet vs testnet.** Reset frequencies differ per exchange/chain; the field
  is read per-exchange so this is handled. Severity should be env-aware
  (`var.env`/staging → `warning` to `#alerts-testnet`; prod CAD/GHS → `page`),
  matching the existing trading-mode rule's pattern
  (`rules-trading-modes.tf` `severity = env=="prod" ? "page" : "warning"`).
- **`oracleExpiry` must not be repurposed.** It is emitted as
  `mento_pool_oracle_expiry` and used for FPMM freshness; the new VP window is a
  separate field by design.
- **Parity-test scope.** The indexer (event-time `oracleOk`) and UI (wall-clock)
  staleness models already diverge intentionally; the parity suite only pins the
  shared branches. Don't try to assert wall-clock staleness in the indexer parity
  test — assert the `oracleOk` / window-vs-`nowSeconds` branches the indexer
  actually implements.
