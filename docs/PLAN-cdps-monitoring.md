# ROADMAP refresh + CDPs monitoring (Liquity v2 indexing & dashboard)

> **Naming convention.** User-facing surfaces (routes, nav, page titles, tile copy, headlines) use **CDPs** — Mento's product brand. Internal code (indexer handlers, ABIs, schema entities, GraphQL query exports) keeps **Liquity** since that's the protocol the contracts are forked from and the wire-level data shape we're indexing. Keeps Mento's brand clean without inventing a euphemism for what the contracts actually are.

## Context

Two coupled deliverables:

1. **ROADMAP refresh.** `docs/ROADMAP.md` was last updated 2026-04-24. Roughly 60 PRs have merged since then — Envio v3 migration, Lever 4 series (rebalance state derivation + BiPoolExchange + Pool Config + decimal-trust gates), leaderboard volume rollups + v2/v3 attribution, Slack/deviation-alert refinements, ratchet linting series (6 PRs), Clawpatch baseline, react-doctor 80→100, browser interaction tests, and infra hygiene (mutation testing, supply-chain gate, agent quality gate). The file's "Done" lists and "Next" hint are stale. Refreshing it before the Liquity work lands keeps the roadmap honest and means the next reader (or future agent) doesn't have to reverse-engineer recent state from git log.

2. **Liquity v2 CDP indexing + dashboard.** Backlog item flagged in `docs/ROADMAP.md:151-155`, `SPEC.md` §5.5, and `docs/BACKLOG.md:18-25`. Verification against `@mento-protocol/contracts@0.8.0` (see "Mento contracts verification" section below) revealed **three live Liquity instances on Celo mainnet** (GBPm + CHFm + JPYm), not the single GBPm instance BACKLOG implied. Each mints its own debt token against USDm collateral. We have zero indexer or dashboard visibility today. This plan adds the indexer entities + handlers for all three instances, then `/cdps` + `/cdps/[symbol]` routes with system KPIs + ICR distribution + trove/depositor tables + interest-rate brackets + CDP-pool linkage, all in **one deploy-sequenced PR**. `service=cdps` alert rules ship as a follow-up PR after sync.

**Constraints carried in.**

- Single PR: indexer + UI together, deploy-sequenced (indexer from branch tip → re-sync → merge → promote).
- All three Liquity instances in scope from day 1 (multi-collateral architecture is already live; ignoring CHFm/JPYm would leave half the system unmonitored).
- ICR percentiles via per-Trove scan at hourly rollup (simpler; revisit if active-trove count gets large).
- Alerts deferred to a follow-up PR.
- Celo mainnet only — Liquity v2 is not deployed on Monad. Multichain config still requires empty-address arrays on Monad to satisfy config validation.
- The BACKLOG "CDP strategy entity" item gets folded in as a side effect — `CDPLiquidityStrategy.PoolAdded` indexing replaces the runtime RPC probe in `ui-dashboard/src/lib/strategy-detection.ts`, retiring that stopgap.

**Two sections below — "Liquity upstream subgraph cross-check" and "Mento contracts verification" — establish ground truth on event signatures, addresses, and architecture before Part 2 dives into implementation.** Read those before the implementation phases; the BACKLOG entry's event list was speculative and is partially wrong.

---

## Liquity upstream subgraph cross-check (2026-05-18)

Cross-referenced against [`liquity/bold/subgraph`](https://github.com/liquity/bold/tree/main/subgraph). The official subgraph is the closest reference implementation of how to index this contract suite. Several findings overturn assumptions baked into `docs/BACKLOG.md` and require schema/event revisions before we vendor anything.

### Events — BACKLOG was speculative; upstream uses a unified TroveOperation event

The BACKLOG named `TroveOpened` / `TroveClosed` / `TroveUpdated` / `LiquidationEvent`. **None of those four are real** in Liquity v2. The actual contract emits a **single** `TroveOperation` event for every state change, plus state-snapshot events. Operation type is encoded in a `uint8` enum (decoded from `contracts/src/Interfaces/ITroveEvents.sol` per upstream comments):

```
0 = OPEN_TROVE
1 = CLOSE_TROVE
2 = ADJUST_TROVE
3 = ADJUST_TROVE_INTEREST_RATE
4 = APPLY_PENDING_DEBT
5 = LIQUIDATE
6 = REDEEM_COLLATERAL
7 = OPEN_TROVE_AND_JOIN_BATCH
8 = SET_INTEREST_BATCH_MANAGER
9 = REMOVE_FROM_BATCH
```

Real event signatures from upstream's `subgraph.yaml`:

```
TroveOperation(indexed uint256 troveId, uint8 operation,
               uint256 annualInterestRate, uint256 debtIncreaseFromRedist,
               uint256 debtIncreaseFromUpfrontFee, int256 debtChangeFromOperation,
               uint256 collIncreaseFromRedist, int256 collChangeFromOperation)  [receipt: true]
TroveUpdated(indexed uint256 troveId, uint256 debt, uint256 coll, uint256 stake,
             uint256 annualInterestRate, uint256 snapshotOfTotalDebtRedist,
             uint256 snapshotOfTotalCollRedist)
BatchedTroveUpdated(indexed uint256, address, uint256, uint256, uint256, uint256, uint256)  [receipt: true]
BatchUpdated(indexed address, uint8, uint256, uint256, uint256, uint256, uint256, uint256)
```

`TroveOperation` and `BatchedTroveUpdated` require **transaction receipts** so the handler can scan sibling logs:

- Liquidation `priceAtLiquidation` comes from a separate `Liquidation(...)` log in the same tx (decoded from data offset 9). It is NOT in the `TroveOperation` params.
- `BatchUpdated` arrives in the same tx as `BatchedTroveUpdated` but at `logIndex + 2`; upstream walks the receipt to correlate.
- Upstream's leverage inference scans for a `FlashLoan` topic in the receipt to flag `mightBeLeveraged=true`.

**This is significant for Envio**: confirm Envio's receipt/log-scanning support before relying on this. Envio's `field_selection.transaction_fields` exposes `hash` / `from` / `to` but receipt logs may or may not be accessible mid-handler. If they aren't, we cannot extract `priceAtLiquidation` directly — we'd have to recompute it from the FPMM USDm/USDC oracle's snapshot at the same block, which is approximate but usable for monitoring.

### Multi-collateral architecture

Liquity v2 is **multi-collateral by design**. `BoldToken.CollateralRegistryAddressChanged → CollateralRegistry.totalCollaterals()` discovers collateral types; each spawns a `TroveManager` + `TroveNFT` template. Mento runs three USDm-collateralized markets today (GBPm, CHFm, JPYm), each with its own registry/manager set. Plan should:

- Index `Collateral` + `CollateralAddresses` entities even with a single row, so adding a second instance is a config change not a schema migration.
- Drive contract registration off `CollateralRegistry` discovery rather than hardcoding `TroveManager` address. (Hardcoding is fine for the first deploy; flag as a follow-up if Mento adds another collateral.)

### Trove ownership is ERC721 via `TroveNFT.Transfer`

Each Trove is an NFT owned by the borrower. The Trove's "owner" changes via `TroveNFT.Transfer`, not via TroveManager events. Schema needs a `previousOwner` field. Handler set must include `TroveNFT.Transfer(indexed address, indexed address, indexed uint256)`. Without this, the `Trove.owner` field decays on NFT transfers — a real possibility now that NFT-backed CDP markets exist.

### Continuous interest model — `InterestRateBracket` is non-optional

Liquity v2 has **continuous interest** at a per-Trove annualized rate. There is no fixed redemption rate. Each Trove sits in an `InterestRateBracket` floored to 0.1% precision (3 decimals). Brackets track:

- `totalDebt` (sum of debt at that rate)
- `sumDebtTimesRateD36` (running Σ debt × rate for interest accrual)
- `pendingDebtTimesOneYearD36` (accumulated unrealized interest over time)
- `updatedAt`

Upstream re-computes these on **every** `TroveOperation` / `TroveUpdated` / `BatchUpdated` via a shared `updateRateBracketDebt(prevRate, newRate, prevDebt, newDebt, prevTime, newTime)` helper. Our `systemDebt` / `redemptionRateBps` fields oversimplify this.

For our monitoring use case we can defer the interest-bracket pre-roll if we live with stale interest accrual (e.g. compute systemDebt from `Σ Trove.debt` at snapshot time without applying pending interest). But:

- **TCR computation needs current debt with accrued interest**. Without bracket tracking the TCR drifts. For an alert that fires when `TCR < 1.1`, this drift could be 0.5–2% over a day depending on bracket distribution — material.
- **Redemption rate doesn't exist as a flat number**. The BACKLOG's `redemptionRate` field doesn't map to anything real. Drop it.

Recommendation: **include `InterestRateBracket` + `InterestBatch`**. Without them, every system-level metric is approximate. The bracket update logic is ~30 lines of TS but it's a hard requirement for correctness.

### `Trove` schema — adopt upstream shape

Upstream's `Trove` entity carries fields our plan missed:

- `interestRate: BigInt!` — per-Trove annualized rate (D18)
- `stake: BigInt!` — for pending rewards math
- `interestBatch: InterestBatch` — null unless joined to a batch
- `previousOwner: Bytes!` — for NFT-transfer attribution
- `redemptionCount: Int!`, `redeemedColl: BigInt!`, `redeemedDebt: BigInt!` — per-trove redemption accumulators
- `lastUserActionAt: BigInt!` — distinguishes user-driven adjusts from forced redemptions
- `mightBeLeveraged: Boolean!` — heuristic via FlashLoan log scan
- `liquidatedColl`, `liquidatedDebt`, `collSurplus`, `priceAtLiquidation` — only set on liquidation
- `status: TroveStatus!` enum: `active` | `closed` | `liquidated` | `redeemed`

Adopt all of these. The originally-planned `Trove` schema is missing too much to compute correct ICR / TCR.

### Stability Pool: upstream **does not index it**

Liquity's official subgraph has **no StabilityPool data source**. Depositor state, gains, and totals are read on-chain by the UI. Our plan diverges here because we need SP totals for headroom alerting + dashboard tiles, but the depositor leaderboard scope should be reconsidered:

- Index `StabilityPool.PoolBalanceUpdated` for the total deposits / collateral in SP (cheap, needed for headroom).
- Index `StabilityPool.UserDepositChanged` for the depositor leaderboard — but ONLY if we want this view on day 1. Defer if it's not load-bearing for the initial alert use case; users can read on-chain via the Liquity UI today.
- **Recommendation**: ship per-depositor tracking on day 1 — the alert-only use case wouldn't justify a `/cdps` route, and the dashboard's value-add over upstream's UI is the system-level + depositor-leaderboard view together. Cost is ~50 extra entity-row inserts on busy weeks.

### `spMinBufferGbpm` — likely a Mento-specific concept

Upstream Liquity has no "minimum buffer below which SP is undercapitalized" notion. The SP can drain to zero and liquidations simply redistribute. The BACKLOG entry assumes `spMinBufferGbpm` exists as a config read but doesn't say where it lives. Two possibilities:

1. Mento has a governance-defined buffer threshold stored on a custom contract (not in upstream Liquity).
2. The BACKLOG author was speculating about the metric, intending it as a dashboard-derived threshold (e.g. `5% of systemDebt`) not a contract-sourced value.

**Action**: confirm with the spec author / Mento protocol team. If it's (2), implement as a UI-side computation with the threshold in `shared-config/` rather than a chain-sourced view call. The plan currently codes for (1); needs revisiting.

### What we do NOT need from upstream

- `CollSurplusPool` mapping — user-claim flow, not load-bearing for monitoring.
- `Governance` / `GovernanceVotingPower` / `GovernanceAllocation*` / LQTY-staking entities — Mento doesn't ship LQTY governance (or if it does, it's out of scope for this initial deliverable).

---

## Mento contracts verification (2026-05-18)

Pulled ABIs + addresses from `@mento-protocol/contracts@0.8.0` (already an `indexer-envio` dependency at version `0.8.0`). This overturns several BACKLOG/spec assumptions.

### Three live Liquity instances on Celo mainnet (chain 42220), not one

The BACKLOG named GBPm only. Mento actually runs **GBPm + CHFm + JPYm** Liquity instances side by side, all live today. Each instance has its own contract set; CollateralRegistry knits them together. The architecture is the multi-collateral pattern from upstream, instantiated three times.

| Instance | CollateralRegistry                           | TroveManager                                 | StabilityPool                                | BorrowerOperations                           | TroveNFT                                     | SortedTroves                                 | ActivePool                                   | DefaultPool                                  | CollSurplusPool                              | AddressesRegistry                            | SystemParams                                 |
| -------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| **GBPm** | `0x1bEDD4334335522B0a0e8e610d326B16B0a605Fb` | `0xb38aEf2bF4e34B997330D626EBCd7629De3885C9` | `0x06346c0fAB682dBde9f245D2D84677592E8aaa15` | `0x8ec9A81871F816F1EF007a82293703057A943B8A` | `0x46273A5792013973b64a42E760E6F81d0472C6b6` | `0x46D0C9e51e05D6ff38B2a19D6310488f3112Bf9b` | `0xa7873F4Bf2A1ea2EB20B1e8A992C4748e78473b2` | `0x95191e52d01eC060cEA753CDADfEEB07b78D0047` | `0xfFF48ee3bd2D534E35b54D538de30a9d7709d4B6` | `0xB3136DBadB14Ab587FFa91545538126938Fe0C6E` | `0x064D8bCC79711cF51dF7Ca0a7fe531A271Cd74E9` |
| **CHFm** | `0x8530ee22A4AdC37B02d1Cd37fC120508663fEdf8` | `0x4E105FEF015db26320C077427BD605AceAd9262E` | `0xc415cA43aB6Ab246E64559696b8DCAcdd08A39e8` | `0x7Fe90CF5A41473179fCE89Df55bc9afcd1c5c0be` | `0xBadB30028F9F5043Efd32b1C00E3B367E874a39E` | `0x06D9ac9912546E773884F4D965f6322278Bbd391` | `0x9947CEe121586fC31b0b0a162A40D6516979E7cB` | `0x542191E79732A4498f263e793Cc47942956f33f7` | `0xC45a4781609fA9BA1ad6D904630A2F92425715d4` | `0xCa70801D91576d069190d1D4CFDDEbdc237A4537` | `0x66cf2AA9FC91ffbf2CC8E8057E54e5Ea670029C1` |
| **JPYm** | `0x343815Db498D60a04ecf666F2FF9E5d6A2AC6d0E` | `0xD2E65Af47d927D5e84F384ae6bAC4F97C3dA65Df` | `0x62A519b4D0693E976b78b195E34a548BcF1D2355` | `0x4944Fc84D675a0Cc4758A8098C1619A2E4724a7F` | `0x411DB4F90088101c76A51413F2D668FC409cbDCF` | `0xf024701eDbE5d8A9869eFC8e01d7f95D3ef29A77` | `0x90b8A5Ad63bDB2a3DC636DA926aB5c039EA426a4` | `0x094C0cD42f21289AD7279285dD3793CD8C998916` | `0x52f659C562f5bA9668Ac71DB2ac860aF10040b15` | `0x8f99Aac2FE09A1390617D4AcDD1519f775eE931A` | `0xf68F400798329A3a2D312F010A96e4f2CC30aD4E` |

Shared registry contracts (one of each):

| Contract                | Address                                      | Purpose                                                                                |
| ----------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| CDPLiquidityStrategy    | `0x4e78BD9565341EAbe99cDC024acB044d9BDcB985` | Mento-specific: bridges FPMM pool reserves to Liquity Troves. Mirror of OLS.           |
| ReserveTroveFactory     | `0x02859465DCC7D7F2Bee183fC7FaC78544c9519e1` | Mento-specific: emits `ReserveTroveCreated` when the Reserve opens a Trove for a pool. |
| OracleAdapterCollateral | `0xEB23E1339b2119c0f4a0097Cb294E990C1fA6423` | Oracle adapter for USDm collateral pricing inside the Liquity instances.               |

**Implication**: the plan now indexes 30+ contracts across 3 instances. Schema must key entities by `{chainId}-{collIndex}-{...}` or `{chainId}-{troveManagerAddress}-{...}` to disambiguate. The `Collateral` entity is no longer future-proofing — it's load-bearing on day 1.

### BACKLOG event list was speculative — actual events differ

Verified from ABIs in `@mento-protocol/contracts@0.8.0/abis/`. Bolded events are the ones each handler must register.

**TroveManager** (per instance):

- **`TroveOperation(indexed uint256 _troveId, uint8 _operation, uint256 _annualInterestRate, uint256 _debtIncreaseFromRedist, uint256 _debtIncreaseFromUpfrontFee, int256 _debtChangeFromOperation, uint256 _collIncreaseFromRedist, int256 _collChangeFromOperation)`** — every state change
- **`TroveUpdated(indexed uint256 _troveId, uint256 _debt, uint256 _coll, uint256 _stake, uint256 _annualInterestRate, uint256 _snapshotOfTotalCollRedist, uint256 _snapshotOfTotalDebtRedist)`** — post-op state
- **`BatchedTroveUpdated(indexed uint256, address _interestBatchManager, uint256 _batchDebtShares, uint256 _coll, uint256 _stake, uint256 _snapshotOfTotalCollRedist, uint256 _snapshotOfTotalDebtRedist)`**
- **`BatchUpdated(indexed address _interestBatchManager, uint8 _operation, uint256 _debt, uint256 _coll, uint256 _annualInterestRate, uint256 _annualManagementFee, uint256 _totalDebtShares, uint256 _debtIncreaseFromUpfrontFee)`**
- **`Liquidation(uint256 _debtOffsetBySP, uint256 _debtRedistributed, uint256 _boldGasCompensation, uint256 _collGasCompensation, uint256 _collSentToSP, uint256 _collRedistributed, uint256 _collSurplus, uint256 _L_ETH, uint256 _L_boldDebt, uint256 _price)`** — TOP-LEVEL event including `_price`. **The upstream subgraph has to scan receipts for this; we don't — big win.**
- **`Redemption(uint256 _attemptedBoldAmount, uint256 _actualBoldAmount, uint256 _ETHSent, uint256 _ETHFee, uint256 _price, uint256 _redemptionPrice)`** — top-level
- **`RedemptionFeePaidToTrove(indexed uint256 _troveId, uint256 _ETHFee)`** — per-trove redemption fee record
- Skip: all `*AddressChanged` admin events (one-time wiring)

**StabilityPool** (per instance) — BACKLOG's `UserDepositChanged` / `PoolBalanceUpdated` names are wrong. Real events:

- **`DepositOperation(indexed address _depositor, uint8 _operation, uint256 _depositLossSinceLastOperation, int256 _topUpOrWithdrawal, uint256 _yieldGainSinceLastOperation, uint256 _yieldGainClaimed, uint256 _ethGainSinceLastOperation, uint256 _ethGainClaimed)`**
- **`DepositUpdated(indexed address _depositor, uint256 _newDeposit, uint256 _stashedColl, uint256 _snapshotP, uint256 _snapshotS, uint256 _snapshotB, uint256 _snapshotScale)`** — post-op state
- **`StabilityPoolBoldBalanceUpdated(uint256 _newBalance)`** — total deposits (the gauge we need for headroom)
- **`StabilityPoolCollBalanceUpdated(uint256 _newBalance)`** — total collateral in SP from liquidations
- **`RebalanceExecuted(uint256 amountCollIn, uint256 amountStableOut)`** — Mento-specific SP collateral-to-stables rebalance. Affects `spDepositsGbpm` accounting; must be modeled.
- Skip on day 1: `P_Updated` / `S_Updated` / `B_Updated` / `ScaleUpdated` (internal accumulators — needed for accurate per-depositor pending-gains math, defer until proven necessary)

**TroveNFT** (per instance):

- **`Transfer(indexed address from, indexed address to, indexed uint256 tokenId)`** — ERC721 ownership changes

**BorrowerOperations** (per instance):

- **`ShutDown(uint256 _tcr)`** — system shutdown event. **This is a load-bearing critical-alert source** that BACKLOG didn't list.
- Skip: `AddManagerUpdated` / `RemoveManagerAndReceiverUpdated` (manager delegation; not needed for monitoring v1)

**CollateralRegistry** (per market):

- **`LiquidityStrategyUpdated(indexed address _liquidityStrategy)`** — when the active CDPLiquidityStrategy changes
- **`BaseRateUpdated(uint256 _baseRate)`** — redemption-rate base before time decay. Needed to surface live redemption rate.
- **`LastFeeOpTimeUpdated(uint256 _lastFeeOpTime)`** — used in the redemption-rate decay formula

**CDPLiquidityStrategy** (shared) — Mento-specific FPMM ↔ Trove bridge:

- **`PoolAdded(indexed address pool, tuple params)`** — FPMM pool registered to CDP strategy
- **`PoolRemoved(indexed address pool)`**
- **`LiquidityMoved(indexed address pool, indexed uint8 direction, address tokenGivenToPool, uint256 amountGivenToPool, address tokenTakenFromPool, uint256 amountTakenFromPool)`** — reserves migrate between FPMM and Trove
- **`RebalanceCooldownSet(indexed address pool, uint32 cooldown)`**
- **`RedemptionShortfallSubsidized(indexed address pool, uint256 shortfall)`** — Mento-specific: protocol absorbs redemption shortfalls. Critical economic event.

**ReserveTroveFactory** (shared):

- **`ReserveTroveCreated(indexed address addressesRegistry, indexed uint256 troveId, uint256 debtAmount, uint256 collateralAmount)`** — canonical event when the Reserve opens a Trove for a pool. Links FPMM Pool → Liquity Trove.

**ActivePool** (per instance):

- `ActivePoolBoldDebtUpdated(uint256 _recordedDebtSum)` — system debt gauge
- `ActivePoolCollBalanceUpdated(uint256 _collBalance)` — system collateral gauge
- Optional — can also derive from TroveManager events alone. Indexing ActivePool gives a cheap sanity check on the derived totals (drift detection). Recommend **opt-in** for day 1; index if it's cheap, skip if it adds significant sync time.

### SystemParams resolves `spMinBufferGbpm`

The BACKLOG flagged `spMinBufferGbpm` as a "config read" but didn't say where. **It's `SystemParams.MIN_BOLD_IN_SP()`**, a view call. Per-instance `SystemParams` contracts:

- GBPm: `0x064D8bCC79711cF51dF7Ca0a7fe531A271Cd74E9`
- CHFm: `0x66cf2AA9FC91ffbf2CC8E8057E54e5Ea670029C1`
- JPYm: `0xf68F400798329A3a2D312F010A96e4f2CC30aD4E`

Full read surface (all view functions, no setters, no events except `Initialized`):

```
MIN_BOLD_IN_SP()                        -> uint256   // spMinBufferGbpm equivalent
MIN_BOLD_AFTER_REBALANCE()              -> uint256   // post-rebalance floor
MCR()                                   -> uint256   // minimum collateral ratio
CCR()                                   -> uint256   // critical collateral ratio (system-wide)
SCR()                                   -> uint256   // shutdown collateral ratio
BCR()                                   -> uint256   // batch collateral ratio
MIN_DEBT()                              -> uint256
MIN_ANNUAL_INTEREST_RATE()              -> uint256
SP_YIELD_SPLIT()                        -> uint256   // fraction of yield to SP depositors
LIQUIDATION_PENALTY_SP()                -> uint256
LIQUIDATION_PENALTY_REDISTRIBUTION()    -> uint256
ETH_GAS_COMPENSATION()                  -> uint256
COLL_GAS_COMPENSATION_CAP()             -> uint256
COLL_GAS_COMPENSATION_DIVISOR()         -> uint256
REDEMPTION_FEE_FLOOR()                  -> uint256
REDEMPTION_BETA()                       -> uint256
REDEMPTION_MINUTE_DECAY_FACTOR()        -> uint256
INITIAL_BASE_RATE()                     -> uint256
```

These are configured at deploy and SystemParams has no setter events — treat them as **immutable per instance**. Read once at indexer startup (or on first TroveManager event per instance) into the `Collateral` entity and never re-poll. Significantly simpler than the original "periodic poll" plan.

For live `getRedemptionRate()` and `getRedemptionRateWithDecay()` (CollateralRegistry), the rate is derived from `baseRate` + time decay. Two implementation options:

- Compute in-handler on every Redemption event using the upstream formula (deterministic, no RPC).
- Materialized via periodic view call on the snapshot tick.

Recommendation: compute in-handler from `BaseRateUpdated` + `LastFeeOpTimeUpdated` + the decay factor from `SystemParams` (`REDEMPTION_MINUTE_DECAY_FACTOR`). Pure deterministic math, no RPC, parity with on-chain.

### Receipt scanning is NOT needed for our use case

The upstream subgraph scans tx receipts to extract `priceAtLiquidation` from a sibling `Liquidation` log. **Mento's deployed `TroveManager` emits `Liquidation` as a top-level event including `_price`** — we register the event normally and read `event.params._price`. No Envio receipt-API workaround required.

The one remaining piece that upstream gets from receipts is the `BatchUpdated` event in a `BatchedTroveUpdated` tx. `BatchUpdated` IS in our TroveManager ABI as a top-level event, so we register both event handlers separately. Because `BatchedTroveUpdated` arrives before the later `BatchUpdated` totals, the first handler must persist pending batch-share state and the `BatchUpdated` handler must replay it.

### `FlashLoan` leverage inference — defer

Upstream marks `Trove.mightBeLeveraged = true` if a `FlashLoan` topic appears in the same tx receipt. Heuristic with high false-positive risk and not load-bearing for monitoring. **Defer**: leave the field off the schema or default to `false`. Re-evaluate if leverage attribution becomes a use case.

---

## Part 1 — ROADMAP refresh

File to edit: `docs/ROADMAP.md`

### Update "Last updated" header

Line 3: `2026-04-24` → `2026-05-18`.

### Add to `### Indexer` Done block

Insert these bullets in the existing Done indexer section (after line 34):

- **Envio v3 migration** — handler API, vitest, ESM; quarantined tests migrated; sync path optimized (PRs #348 / #401 / #405)
- **BiPoolExchange entity** — v2 exchange registry indexed; VirtualPools join via `wrappedExchangeId` (Lever 4 PR 2)
- **Rebalance state derived from entity store** — replaces per-event RPC `getRebalancingState` call; safe-by-construction freshness gate on `lastOracleReportAt` (Lever 4 PR 1, #358)
- **Asymmetric-pool entry threshold + decimals-unknown freshness gate** — splits `rebalanceThresholdAbove` / `rebalanceThresholdBelow`; `tokenDecimalsKnown` / `rebalanceThresholdsKnown` self-heal flags; `-2` sentinel halts retry loop (Lever 4 PR 1.5–1.7)
- **Median-jump lineage** — `lastMedianPrice` / `lastMedianAt` / `medianLive` / `prevMedianPrice` / `lastOracleJumpBps` on Pool; unblocks Oracle Jump Exceeds Swap Fee alert
- **BreakerBox event indexing** — `BreakerAdded` / `BreakerStatusUpdated` / `BreakerTripped` / `TradingModeUpdated` and per-breaker config events; foundation for the Breaker tile follow-up
- **`rebalanceReward` indexed** — closes the Pool Config panel's last missing fee field (PR #222)
- **Leaderboard volume rollups** — daily aggregator + v3 aggregator flows + v2 trader route attribution + virtual-pool exchange volume rollup (PRs #390 / #391 / #395 / #415)
- **Indexer perf** — preloaded trading-limit reads + grouped swap effects; block-depth-aware rate-limit fallback dispatch; medium-tier caching + revert-signature retry coverage (PRs #353 / #356 / #413 / #417)
- **`pnpm --filter @mento-protocol/indexer-envio generate:abis`** — refresh vendored Mento ABIs from `@mento-protocol/contracts/abis/` (already mentioned in BACKLOG; surface here too)

### Add to `### Dashboard` Done block

Insert after line 62 (`Chain icon prefix`):

- **Pool Config panel** — consolidated thresholds tile (rebalance threshold, LP/protocol fees, rebalance reward, oracle expiry, trading-limit windows, rebalancer address) (PR #222)
- **Pool detail Phase 2** — v2 BiPoolExchange wrapper view on VirtualPool detail pages (Lever 4)
- **Untrusted-decimals trust gates** — pool amount tabs / homepage volume views gate on `tokenDecimalsKnown` to prevent rendering bogus USD figures (Lever 4 PR 1.5–1.7)
- **Volume leaderboard rollups + flow insights** — homepage Trader/Router/Source breakdowns (PRs #390 / #391 / #395)
- **WAI-ARIA keyboard contracts** — radiogroup + tablist patterns; shared roving tabindex helper (PRs #350 / #377)
- **react-doctor at 100** — score driven 80→100 with the full backlog closed; CI now runs react-doctor as a PR-only diff gate (PRs #367 / #371 / #382)
- **Browser interaction test suite** — dashboard end-to-end smoke via Playwright (PR #403)
- **Live uptime fix during oracle outages** — corrects `healthBinarySeconds` accrual when oracle has not reported in window (PR #406)
- **Hide raw rebalance error codes in tooltip** — bot-friendlier copy + matching Slack alert annotation (PRs #414 / #399 / #410 / #416)

### Replace `### Next` section (lines 139–143)

The standalone CDP strategy entity work folds into the bigger CDPs initiative — `CDPLiquidityStrategy.PoolAdded` indexing is part of the new handler set. New section:

```
## Next

### CDPs monitoring (Liquity v2 indexing + dashboard)

End-to-end visibility for Mento's CDP markets (GBPm, CHFm, JPYm — all
backed by USDm collateral via Liquity v2 forks). Adds Trove /
StabilityPool / LiquityInstance / LiquityInstanceSnapshot indexer
entities plus per-instance dashboard at `/cdps` and `/cdps/[symbol]`
with system KPIs, ICR distribution, trove/depositor tables,
interest-rate brackets, and CDP-pool linkage. Alerts (`service=cdps`
Stability Pool Headroom rule) ship as a follow-up PR once sync is
verified.

See SPEC.md §5.5 and BACKLOG.md "Liquity v2 CDP indexing" for full requirements.
```

### Update `### Backlog → Indexer Enhancements` (lines 149–161)

- **Remove** the Liquity entry (it moves up to "Next").
- **Re-insert** the CDP strategy entity bullet (was in `Next`).
- Add new bullets for items now in the backlog from Done-elsewhere churn:
  - `breakerBoxConfig` / `BreakerTripEvent` UI tile — schema is already there, just no consumer.
  - `RateFeed` entity + reporter list (replaces the `USDM_SYMBOLS` Oracle Source heuristic in pool detail).
  - `oracleOk` derivation from expiry (today's `oracleOk` is a "has-ever-reported" flag — see BACKLOG tech-debt §).

### Update `### Backlog → Alerting Backlog`

After Liquity v2 indexing lands, add a follow-up bullet:

- **`service=cdps` Stability Pool Headroom alert** — metrics-bridge gauges (`mento_liquity_*`) + Terraform rule. Critical when `spHeadroomGbpm ≤ 0`; warning when `tcr < 1.15`. Blocked on Phase A indexing landing.

### Update SPEC.md §11 "Future Plans → Next" (lines 458–459)

Mirror the ROADMAP "Next" change: Liquity v2 replaces CDP strategy entity as the top Next item. Keep §5.5 status as "Phase 2 — in progress" once the PR is opened.

---

## Part 2 — Liquity v2 implementation

### Phase A — Indexer (lives in same PR as Phase B)

#### A.1 — Vendor ABIs (use the already-vendored Mento package)

`@mento-protocol/contracts@0.8.0` ships every ABI we need. Existing pattern: `indexer-envio/scripts/generateAbis.mjs` copies subsets from the npm package into `indexer-envio/abis/` and commits them so Envio Cloud builds don't depend on `node_modules`. **Extend that script** rather than hand-copying.

New ABI files (committed under `indexer-envio/abis/liquity/`):

- `TroveManager.json`
- `StabilityPool.json`
- `TroveNFT.json`
- `BorrowerOperations.json`
- `CollateralRegistry.json`
- `CDPLiquidityStrategy.json`
- `ReserveTroveFactory.json`
- `SystemParams.json` (for view-call effects)
- `AddressesRegistry.json` (for instance-discovery view calls)

`ActivePool.json` is optional (see verification note above — only useful as a drift-check). Skip on day 1.

No source-from-bytecode work needed. Update `indexer-envio/scripts/generateAbis.mjs` to add a `LIQUITY_ABIS` array and copy them into `abis/liquity/`. Add to the "Done" pattern documented in BACKLOG line 175.

#### A.2 — Schema additions

File: `indexer-envio/schema.graphql`. ID convention: `{chainId}-{collateralAddress}-{...}` where `collateralAddress` = the per-instance TroveManager address (acts as the stable instance identifier). All Trove/Batch/Bracket entities live under that namespace.

```graphql
# One row per Liquity instance (GBPm, CHFm, JPYm). Loaded from
# CollateralRegistry at startup or on first event observation.
type LiquityCollateral @index(fields: ["chainId"]) {
  id: ID! # "{chainId}-{troveManager}"
  chainId: Int! @index
  collIndex: Int! # index in CollateralRegistry
  symbol: String! # "GBPm" | "CHFm" | "JPYm" (debt token symbol)
  debtToken: String! # debt token address (GBPm/CHFm/JPYm)
  collToken: String! # collateral token address (USDm)
  # Contract set (denormalized from AddressesRegistry; reads are O(1) at query time)
  collateralRegistry: String!
  troveManager: String!
  stabilityPool: String!
  borrowerOperations: String!
  troveNFT: String!
  sortedTroves: String!
  activePool: String!
  defaultPool: String!
  collSurplusPool: String!
  addressesRegistry: String!
  systemParams: String!
  # SystemParams snapshot (immutable per instance — read once at startup)
  mcrBps: Int! # MCR in bps (e.g. 11000 = 110%)
  ccrBps: Int! # CCR in bps
  scrBps: Int! # SCR in bps
  bcrBps: Int!
  minDebt: BigInt!
  minBoldInSp: BigInt! # spMinBufferGbpm equivalent
  minBoldAfterRebalance: BigInt!
  minAnnualInterestRate: BigInt!
  spYieldSplitBps: Int! # SP_YIELD_SPLIT in bps
  liquidationPenaltySpBps: Int!
  liquidationPenaltyRedistributionBps: Int!
  ethGasCompensation: BigInt!
  redemptionFeeFloorBps: Int!
  redemptionBeta: BigInt!
  redemptionMinuteDecayFactor: BigInt!
  initialBaseRateBps: Int!
  systemParamsLoaded: Boolean! # mirrors invertRateFeedKnown pattern; false until view calls succeed
  createdAtBlock: BigInt!
  createdAtTimestamp: BigInt!
}

# Per-CDP state. Mirrors upstream Liquity subgraph's Trove entity.
# status enum: stored as string for Envio compatibility ("active" | "closed" | "liquidated" | "redeemed").
type Trove
  @index(fields: ["collateralId", "status"])
  @index(fields: ["collateralId", "icrBps"]) {
  id: ID! # "{chainId}-{troveManager}-{troveIdHex}"
  chainId: Int! @index
  collateralId: String! @index # "{chainId}-{troveManager}"
  troveId: String! @index # bytes32 hex
  owner: String! @index
  previousOwner: String! # last ERC721 owner; defaults to ZERO_ADDRESS
  status: String! @index # active | closed | liquidated | redeemed
  debt: BigInt! # current debt incl. accrued interest snapshot
  coll: BigInt! # current collateral (USDm wei)
  stake: BigInt!
  interestRate: BigInt! # annualized, D18; 0 if in a batch
  interestBatchId: String # null unless joined to a batch
  icrBps: Int! @index # current ICR in bps; 0 once closed
  # Liquidation/redemption denormalization (null while active)
  liquidatedColl: BigInt
  liquidatedDebt: BigInt
  collSurplus: BigInt
  priceAtLiquidation: BigInt
  redemptionCount: Int!
  redeemedColl: BigInt!
  redeemedDebt: BigInt!
  # Timestamps
  openedAt: BigInt!
  openedAtBlock: BigInt!
  openedTxHash: String!
  closedAt: BigInt
  closedAtBlock: BigInt
  closedTxHash: String
  lastUserActionAt: BigInt!
  lastUpdatedAt: BigInt!
  lastUpdatedBlock: BigInt!
}

# Interest rate brackets — required for accurate system interest accrual.
# Floored to 3 decimals (0.1% precision) per upstream pattern.
type InterestRateBracket @index(fields: ["collateralId", "rate"]) {
  id: ID! # "{collateralId}-{rateFloored}"
  collateralId: String! @index
  rate: BigInt! # annualized D18, floored to 3 decimals
  totalDebt: BigInt!
  sumDebtTimesRateD36: BigInt!
  pendingDebtTimesOneYearD36: BigInt!
  updatedAt: BigInt!
}

# Batch interest manager — Troves can delegate interest management.
type InterestBatch {
  id: ID! # "{collateralId}-{batchManager}"
  collateralId: String! @index
  batchManager: String! @index
  debt: BigInt!
  coll: BigInt!
  annualInterestRate: BigInt!
  annualManagementFee: BigInt!
  updatedAt: BigInt!
}

# Temporary correlation record for BatchedTroveUpdated logs that arrive before
# the matching BatchUpdated log in the same tx.
type PendingBatchedTroveUpdate @index(fields: ["collateralId", "txHash"]) {
  id: ID! # "{chainId}-{txHash}-{batchManager}-{troveId}"
  collateralId: String! @index
  txHash: String! @index
  batchManager: String! @index
  troveId: String!
  batchDebtShares: BigInt!
  coll: BigInt!
  stake: BigInt!
  timestamp: BigInt!
  blockNumber: BigInt!
}

# Per-address aggregate (depositor leaderboard, trove count).
type BorrowerInfo {
  id: ID! # "{chainId}-{address}"
  chainId: Int! @index
  address: String! @index
  troves: Int! # total troves across all collateral
  trovesByCollateral: [String!]! # parallel arrays: "{collateralId}:{count}"
}

# StabilityPool depositor state. One per (collateralId, address).
type StabilityPoolDepositor @index(fields: ["collateralId", "deposit"]) {
  id: ID! # "{collateralId}-{address}"
  chainId: Int!
  collateralId: String! @index
  address: String! @index
  deposit: BigInt! # current debt-token deposit
  stashedColl: BigInt! # accumulated USDm collateral gain not yet claimed
  yieldGainClaimedCum: BigInt!
  ethGainClaimedCum: BigInt!
  firstDepositAt: BigInt!
  lastUpdatedAt: BigInt!
  cumulativeDeposited: BigInt!
  cumulativeWithdrawn: BigInt!
}

# Latest-value system state per instance. Updated on every relevant event.
type LiquityInstance {
  id: ID! # "{chainId}-{troveManager}"
  collateralId: String! @index
  chainId: Int! @index
  # System totals (event-sourced from TroveManager / ActivePool / DefaultPool)
  systemColl: BigInt!
  systemDebt: BigInt!
  tcrBps: Int! # derived; -1 if oracle USD price unavailable
  # Stability pool latest values (from StabilityPoolBoldBalanceUpdated /
  # StabilityPoolCollBalanceUpdated)
  spDeposits: BigInt!
  spColl: BigInt!
  # Derived
  spHeadroom: BigInt! # spDeposits - LiquityCollateral.minBoldInSp; -1 if collateral params not loaded
  # Redemption state (computed in-handler from BaseRateUpdated + decay)
  baseRate: BigInt!
  lastFeeOpTime: BigInt!
  currentRedemptionRateBps: Int! # re-derived per snapshot tick
  # ICR distribution (refreshed at hourly rollup tick, NOT per event)
  activeTroveCount: Int!
  icrP1Bps: Int!
  icrP5Bps: Int!
  icrP50Bps: Int!
  icrFracBelowMcrBps: Int!
  # Cumulative-since-T0
  liqCountCum: Int!
  liqDebtOffsetCum: BigInt!
  liqDebtRedistributedCum: BigInt!
  liqCollSentToSpCum: BigInt!
  liqCollRedistributedCum: BigInt!
  redemptionCountCum: Int!
  redemptionDebtCum: BigInt!
  redemptionFeeCum: BigInt!
  spRebalanceCount: Int!
  spRebalanceCollInCum: BigInt!
  spRebalanceStableOutCum: BigInt!
  shortfallSubsidyCum: BigInt! # CDPLiquidityStrategy.RedemptionShortfallSubsidized
  # System status
  isShutDown: Boolean!
  shutDownAt: BigInt # null unless shut down
  shutDownTcrBps: Int # captured at ShutDown event
  lastEventBlock: BigInt!
  lastEventTimestamp: BigInt!
}

# Hourly rollup per instance.
type LiquityInstanceSnapshot @index(fields: ["instanceId", "timestamp"]) {
  id: ID! # "{instanceId}-{timestamp}"
  chainId: Int!
  instanceId: String! @index
  timestamp: BigInt! @index # UTC hour boundary
  # Point-in-time (latest values at end of bucket)
  systemColl: BigInt!
  systemDebt: BigInt!
  tcrBps: Int!
  spDeposits: BigInt!
  spColl: BigInt!
  spHeadroom: BigInt!
  currentRedemptionRateBps: Int!
  activeTroveCount: Int!
  icrP1Bps: Int!
  icrP5Bps: Int!
  icrP50Bps: Int!
  icrFracBelowMcrBps: Int!
  isShutDown: Boolean!
  # Per-bucket flow
  troveOpenedCount: Int!
  troveClosedCount: Int!
  liqCount: Int!
  liqDebtOffsetBucket: BigInt!
  redemptionCount: Int!
  redemptionDebtBucket: BigInt!
  spRebalanceCount: Int!
  shortfallSubsidyBucket: BigInt!
  # Running cumulatives (snapshot of LiquityInstance at this hour)
  liqCountCum: Int!
  redemptionCountCum: Int!
  blockNumber: BigInt!
}

# Daily rollup (same shape, UTC-day-bucketed).
type LiquityInstanceDailySnapshot @index(fields: ["instanceId", "timestamp"]) {
  id: ID!
  chainId: Int!
  instanceId: String! @index
  timestamp: BigInt! @index
  # ... same fields as LiquityInstanceSnapshot ...
}

# Per-event history entities. Each immutable (insert-only).

type LiquidationEvent @index(fields: ["instanceId", "timestamp"]) {
  id: ID! # "{chainId}-{txHash}-{logIndex}"
  chainId: Int!
  instanceId: String! @index
  debtOffsetBySP: BigInt!
  debtRedistributed: BigInt!
  boldGasCompensation: BigInt!
  collGasCompensation: BigInt!
  collSentToSP: BigInt!
  collRedistributed: BigInt!
  collSurplus: BigInt!
  L_ETH: BigInt!
  L_boldDebt: BigInt!
  priceAtLiquidation: BigInt! # _price from event
  timestamp: BigInt! @index
  blockNumber: BigInt!
  txHash: String!
}

type RedemptionEvent @index(fields: ["instanceId", "timestamp"]) {
  id: ID! # "{chainId}-{txHash}-{logIndex}"
  chainId: Int!
  instanceId: String! @index
  attemptedBoldAmount: BigInt!
  actualBoldAmount: BigInt!
  ETHSent: BigInt!
  ETHFee: BigInt!
  price: BigInt!
  redemptionPrice: BigInt!
  timestamp: BigInt! @index
  blockNumber: BigInt!
  txHash: String!
}

type SpRebalanceEvent @index(fields: ["instanceId", "timestamp"]) {
  id: ID! # "{chainId}-{txHash}-{logIndex}"
  chainId: Int!
  instanceId: String! @index
  amountCollIn: BigInt!
  amountStableOut: BigInt!
  timestamp: BigInt! @index
  blockNumber: BigInt!
  txHash: String!
}

# CDPLiquidityStrategy → FPMM pool linkage (mirror of OlsPool pattern).
# This unblocks the BACKLOG "CDP strategy entity" item as a side effect of
# Liquity indexing — index CDP-backed FPMMs via PoolAdded events instead of
# the runtime RPC probe in ui-dashboard/src/lib/strategy-detection.ts.
type CdpPool {
  id: ID! # "{chainId}-{poolAddress}"
  chainId: Int! @index
  collateralId: String! @index # "{chainId}-{troveManager}" market identity from PoolAdded params.debtToken
  debtToken: String! @index
  poolId: String! @index # foreign key to Pool entity (same id)
  strategyAddress: String! # CDPLiquidityStrategy address
  rebalanceCooldownSec: Int!
  addedAtBlock: BigInt!
  addedAtTimestamp: BigInt!
  updatedAtBlock: BigInt!
  updatedAtTimestamp: BigInt!
  removed: Boolean!
}

# Reserve-opened Troves bind FPMM pools to a Liquity Trove.
type ReserveTrove {
  id: ID! # "{chainId}-{addressesRegistry}-{troveId}"
  chainId: Int!
  collateralId: String! @index
  addressesRegistry: String!
  troveId: String!
  initialDebt: BigInt!
  initialColl: BigInt!
  createdAtBlock: BigInt!
  createdAtTimestamp: BigInt!
  createdTxHash: String!
}

# Per-event CDPLiquidityStrategy liquidity moves (FPMM ↔ Trove flows).
type CdpLiquidityMove @index(fields: ["poolId", "timestamp"]) {
  id: ID! # "{chainId}-{txHash}-{logIndex}"
  chainId: Int!
  poolId: String! @index
  direction: Int! # uint8 from event
  tokenGivenToPool: String!
  amountGivenToPool: BigInt!
  tokenTakenFromPool: String!
  amountTakenFromPool: BigInt!
  timestamp: BigInt! @index
  blockNumber: BigInt!
  txHash: String!
}
```

> **Per-Trove scan at rollup**: with three instances and ~hundreds of active troves each, the per-Trove scan stays cheap. Use `Trove.getWhere.collateralId.eq(collateralId)` + JS filter on `status === "active"`. This requires a single-field `@index` on `collateralId`; if Envio codegen does not expose the desired helper from the composite indexes above, add the explicit single-field index or fall back to paginated reads.
>
> **Schema-required field reuse**: the `Pool.lpFee` / `protocolFee` / `rebalanceReward` sentinel pattern (`-1` = unknown, `-2` = halt-retry) carries over to `LiquityInstance.tcrBps` and `LiquityInstance.spHeadroom`. Use `-1` for "data unavailable" but **never use `-2`** for any field that drives an alert gauge — the metrics-bridge follow-up needs `-1` only as the no-data sentinel.

#### A.3 — Contracts wired into multichain config

File: `indexer-envio/config.multichain.mainnet.yaml`. Global `contracts:` block additions (verified event signatures from `@mento-protocol/contracts@0.8.0` ABIs):

```yaml
- name: LiquityTroveManager
  abi_file_path: abis/liquity/TroveManager.json
  handler: src/EventHandlers.ts
  events:
    - event: TroveOperation(indexed uint256 _troveId, uint8 _operation, uint256 _annualInterestRate, uint256 _debtIncreaseFromRedist, uint256 _debtIncreaseFromUpfrontFee, int256 _debtChangeFromOperation, uint256 _collIncreaseFromRedist, int256 _collChangeFromOperation)
    - event: TroveUpdated(indexed uint256 _troveId, uint256 _debt, uint256 _coll, uint256 _stake, uint256 _annualInterestRate, uint256 _snapshotOfTotalCollRedist, uint256 _snapshotOfTotalDebtRedist)
    - event: BatchedTroveUpdated(indexed uint256 _troveId, address _interestBatchManager, uint256 _batchDebtShares, uint256 _coll, uint256 _stake, uint256 _snapshotOfTotalCollRedist, uint256 _snapshotOfTotalDebtRedist)
    - event: BatchUpdated(indexed address _interestBatchManager, uint8 _operation, uint256 _debt, uint256 _coll, uint256 _annualInterestRate, uint256 _annualManagementFee, uint256 _totalDebtShares, uint256 _debtIncreaseFromUpfrontFee)
    - event: Liquidation(uint256 _debtOffsetBySP, uint256 _debtRedistributed, uint256 _boldGasCompensation, uint256 _collGasCompensation, uint256 _collSentToSP, uint256 _collRedistributed, uint256 _collSurplus, uint256 _L_ETH, uint256 _L_boldDebt, uint256 _price)
    - event: Redemption(uint256 _attemptedBoldAmount, uint256 _actualBoldAmount, uint256 _ETHSent, uint256 _ETHFee, uint256 _price, uint256 _redemptionPrice)
    - event: RedemptionFeePaidToTrove(indexed uint256 _troveId, uint256 _ETHFee)

- name: LiquityStabilityPool
  abi_file_path: abis/liquity/StabilityPool.json
  handler: src/EventHandlers.ts
  events:
    - event: DepositOperation(indexed address _depositor, uint8 _operation, uint256 _depositLossSinceLastOperation, int256 _topUpOrWithdrawal, uint256 _yieldGainSinceLastOperation, uint256 _yieldGainClaimed, uint256 _ethGainSinceLastOperation, uint256 _ethGainClaimed)
    - event: DepositUpdated(indexed address _depositor, uint256 _newDeposit, uint256 _stashedColl, uint256 _snapshotP, uint256 _snapshotS, uint256 _snapshotB, uint256 _snapshotScale)
    - event: StabilityPoolBoldBalanceUpdated(uint256 _newBalance)
    - event: StabilityPoolCollBalanceUpdated(uint256 _newBalance)
    - event: RebalanceExecuted(uint256 amountCollIn, uint256 amountStableOut)

- name: LiquityTroveNFT
  abi_file_path: abis/liquity/TroveNFT.json
  handler: src/EventHandlers.ts
  events:
    - event: Transfer(indexed address from, indexed address to, indexed uint256 tokenId)

- name: LiquityBorrowerOperations
  abi_file_path: abis/liquity/BorrowerOperations.json
  handler: src/EventHandlers.ts
  events:
    - event: ShutDown(uint256 _tcr)

- name: LiquityCollateralRegistry
  abi_file_path: abis/liquity/CollateralRegistry.json
  handler: src/EventHandlers.ts
  events:
    - event: BaseRateUpdated(uint256 _baseRate)
    - event: LastFeeOpTimeUpdated(uint256 _lastFeeOpTime)
    - event: LiquidityStrategyUpdated(indexed address _liquidityStrategy)

- name: CDPLiquidityStrategy
  abi_file_path: abis/liquity/CDPLiquidityStrategy.json
  handler: src/EventHandlers.ts
  events:
    - event: PoolAdded(indexed address pool, tuple params)
    - event: PoolRemoved(indexed address pool)
    - event: LiquidityMoved(indexed address pool, indexed uint8 direction, address tokenGivenToPool, uint256 amountGivenToPool, address tokenTakenFromPool, uint256 amountTakenFromPool)
    - event: RebalanceCooldownSet(indexed address pool, uint32 cooldown)
    - event: RedemptionShortfallSubsidized(indexed address pool, uint256 shortfall)

- name: ReserveTroveFactory
  abi_file_path: abis/liquity/ReserveTroveFactory.json
  handler: src/EventHandlers.ts
  events:
    - event: ReserveTroveCreated(indexed address addressesRegistry, indexed uint256 troveId, uint256 debtAmount, uint256 collateralAmount)
```

Note: I use the `Liquity` prefix on shared upstream names (`LiquityTroveManager` etc.) to avoid collision with `TroveManager` if Mento ever ships a re-named v2 contract; matches our existing `WormholeNttManager` / `WormholeTransceiver` naming.

Under `chains:` → Celo (42220) block, append (one entry per contract type, all three instance addresses listed under the same name — Envio supports multi-address subscriptions on a single contract):

```yaml
- name: LiquityTroveManager
  address:
    - 0xb38aEf2bF4e34B997330D626EBCd7629De3885C9 # GBPm
    - 0x4E105FEF015db26320C077427BD605AceAd9262E # CHFm
    - 0xD2E65Af47d927D5e84F384ae6bAC4F97C3dA65Df # JPYm
- name: LiquityStabilityPool
  address:
    - 0x06346c0fAB682dBde9f245D2D84677592E8aaa15 # GBPm
    - 0xc415cA43aB6Ab246E64559696b8DCAcdd08A39e8 # CHFm
    - 0x62A519b4D0693E976b78b195E34a548BcF1D2355 # JPYm
- name: LiquityTroveNFT
  address:
    - 0x46273A5792013973b64a42E760E6F81d0472C6b6 # GBPm
    - 0xBadB30028F9F5043Efd32b1C00E3B367E874a39E # CHFm
    - 0x411DB4F90088101c76A51413F2D668FC409cbDCF # JPYm
- name: LiquityBorrowerOperations
  address:
    - 0x8ec9A81871F816F1EF007a82293703057A943B8A # GBPm
    - 0x7Fe90CF5A41473179fCE89Df55bc9afcd1c5c0be # CHFm
    - 0x4944Fc84D675a0Cc4758A8098C1619A2E4724a7F # JPYm
- name: LiquityCollateralRegistry
  address:
    - 0x1bEDD4334335522B0a0e8e610d326B16B0a605Fb # GBPm
    - 0x8530ee22A4AdC37B02d1Cd37fC120508663fEdf8 # CHFm
    - 0x343815Db498D60a04ecf666F2FF9E5d6A2AC6d0E # JPYm
- name: CDPLiquidityStrategy
  address:
    - 0x4e78BD9565341EAbe99cDC024acB044d9BDcB985 # shared
- name: ReserveTroveFactory
  address:
    - 0x02859465DCC7D7F2Bee183fC7FaC78544c9519e1 # shared
```

> **Per-handler instance routing**: every event arrives with `event.srcAddress` (Envio v3 API). Handlers route to the correct `LiquityCollateral` row by matching `srcAddress` against `collateral.collateralRegistry` / `troveManager` / `stabilityPool` / etc. The router table is seeded from `shared-config/liquity.ts` with the verified per-market contract set above, then refreshed opportunistically by `bootstrapCollaterals`. Cache the map in module-scope state (mirrors the existing `feeToken` registry pattern).

Under Monad (143) block, add empty arrays for all seven contracts:

```yaml
- name: LiquityTroveManager
  address: [] # No Liquity v2 on Monad
- name: LiquityStabilityPool
  address: []
- name: LiquityTroveNFT
  address: []
- name: LiquityBorrowerOperations
  address: []
- name: LiquityCollateralRegistry
  address: []
- name: CDPLiquidityStrategy
  address: []
- name: ReserveTroveFactory
  address: []
```

> **`start_block` on Celo**: the Liquity instances were deployed after the existing FPMM start block (60664500). For backfill performance, set per-contract `start_block` overrides on the Liquity contracts to the earliest deploy block among the three instances. Find it via `cast publication-block` (or read `BorrowerOperations.deploymentTimestamp` if available) for `0x8ec9A81871F816F1EF007a82293703057A943B8A` (GBPm BorrowerOps), then take min across all three instances. Plan TBD until block discovery — flag for the implementer.

#### A.4 — Handlers

New directory: `indexer-envio/src/handlers/liquity/`. Wire-up: `src/EventHandlers.ts` adds side-effect imports.

```ts
import "./handlers/liquity/collateralRegistry";
import "./handlers/liquity/troveManager";
import "./handlers/liquity/stabilityPool";
import "./handlers/liquity/troveNFT";
import "./handlers/liquity/borrowerOperations";
import "./handlers/liquity/cdpLiquidityStrategy";
import "./handlers/liquity/reserveTroveFactory";
```

**Files:**

`collateralRegistry.ts` — discovers instances on startup. Handlers for `BaseRateUpdated`, `LastFeeOpTimeUpdated`, `LiquidityStrategyUpdated`. On first event, runs `bootstrapCollaterals` (see below) if not already loaded. `BaseRateUpdated` and `LastFeeOpTimeUpdated` are **per collateral registry**, not global: route by `event.srcAddress` to the matching `LiquityCollateral`, update only that `LiquityInstance.baseRate` / `lastFeeOpTime`, and recompute only that instance's `currentRedemptionRateBps`.

`bootstrap.ts` — helper module. `bootstrapCollaterals(context)`:

1. Seed the three known markets from `shared-config/liquity.ts`: `collateralRegistry`, `troveManager`, `addressesRegistry`, `systemParams`, debt token, collateral token, and UI slug. This static map is the fallback when a deployed ABI lacks a discovery accessor.
2. For each market, optionally verify the mapping by reading its CollateralRegistry (`totalCollaterals()` + `getToken(i)` / `getTroveManager(i)`) and its AddressesRegistry pools (`stabilityPool()` / `troveNFT()` / `sortedTroves()` / `activePool()` / `defaultPool()` / `collSurplusPool()` / `borrowerOperations()`).
3. **Do not read `systemParams()` from AddressesRegistry** unless the ABI proves that accessor exists. The verified plan table already carries the per-market SystemParams address; treat that static address as canonical until an accessor is confirmed.
4. Read full `SystemParams` config (MCR/CCR/SCR/BCR/MIN_BOLD_IN_SP/MIN_DEBT/etc.) from the per-market SystemParams contract.
5. Read debt token `symbol()` to derive `LiquityCollateral.symbol` (GBPm/CHFm/JPYm), with the shared-config slug as fallback.
6. Write `LiquityCollateral` row with `systemParamsLoaded=true`.

Idempotent — re-run on `LiquidityStrategyUpdated` to refresh the strategy linkage. Use the `experimental_createEffect` pattern from `selfHealRebalanceThresholds` (the existing implementation in `indexer-envio/src/rpc/effects.ts`); these are full-node RPC calls, not HyperRPC.

`troveManager.ts` — handlers for the 7 TroveManager events. Operation-enum dispatch from `TroveOperation`:

```ts
const OP = {
  OPEN_TROVE: 0,
  CLOSE_TROVE: 1,
  ADJUST_TROVE: 2,
  ADJUST_TROVE_INTEREST_RATE: 3,
  APPLY_PENDING_DEBT: 4,
  LIQUIDATE: 5,
  REDEEM_COLLATERAL: 6,
  OPEN_TROVE_AND_JOIN_BATCH: 7,
  SET_INTEREST_BATCH_MANAGER: 8,
  REMOVE_FROM_BATCH: 9,
} as const;
```

Per-event logic (mirrors the upstream subgraph mapping at `liquity/bold/subgraph/src/TroveManager.mapping.ts`):

- **`TroveOperation`** — primary source of Trove status/cumulative updates. Identify by `srcAddress → collateralId`. On `OPEN_TROVE` / `OPEN_TROVE_AND_JOIN_BATCH`: create or update a placeholder Trove with `status=active`, `openedAt=block.timestamp`, `owner=ZERO_ADDRESS`, and `previousOwner=ZERO_ADDRESS`; do **not** update `BorrowerInfo` here because the event does not include the borrower address. On `CLOSE_TROVE`: `status=closed`, `closedAt=block.timestamp`. On `LIQUIDATE`: `status=liquidated`, set `liquidatedColl=-_collChangeFromOperation`, `liquidatedDebt=-_debtChangeFromOperation`. On `REDEEM_COLLATERAL`: `status=redeemed`, increment `redemptionCount`, accumulate `redeemedColl/redeemedDebt` (subtract the negative `_*ChangeFromOperation` values per upstream convention). On `APPLY_PENDING_DEBT`: no status change; just timestamps. Don't bump `lastUserActionAt` on `REDEEM_COLLATERAL` / `LIQUIDATE` / `APPLY_PENDING_DEBT` (forced ops, per upstream).
- **`TroveUpdated`** — write authoritative `debt`, `coll`, `stake`, `interestRate` onto the Trove. Compute `icrBps` using the per-market collateral/debt price, not a single USDm/USD price (see TCR helper). Update interest-rate bracket via `updateRateBracketDebt(prevRate, newRate, prevDebt, newDebt, ...)` per upstream pattern. Also update `LiquityInstance.systemColl` and `systemDebt` by applying the delta between the previous Trove row and the new row; because ActivePool / DefaultPool indexing is out of scope, this delta path is the source of latest system totals.
- **`BatchedTroveUpdated`** + **`BatchUpdated`** — Envio v3 processes events in log-index order within a tx; `BatchUpdated` arrives after one or more `BatchedTroveUpdated` logs. The first handler cannot read the future batch totals. Persist a short-lived `PendingBatchedTroveUpdate` record keyed by `{chainId}-{txHash}-{batchManager}-{troveId}` (or a JSON list on a tx-scoped pending entity), then have `BatchUpdated` replay every pending trove for that batch using `trove.debt = batchUpdated.debt * batchDebtShares / batchUpdated.totalDebtShares`, update collateral/stake, update brackets, update `LiquityInstance` system total deltas, and delete the pending records.
- **`Liquidation`** — append immutable `LiquidationEvent` row. Bump `LiquityInstance.liqCountCum`, `liqDebtOffsetCum`, `liqCollSentToSpCum`, etc.
- **`Redemption`** — append immutable `RedemptionEvent` row. Bump `LiquityInstance.redemptionCountCum`, `redemptionDebtCum`, `redemptionFeeCum`.
- **`RedemptionFeePaidToTrove`** — per-trove fee record; bump `Trove.redeemedColl` if not already accounted by the matching `TroveOperation` (upstream's pattern uses `TroveOperation` as the canonical source and treats `RedemptionFeePaidToTrove` as a fee-amount detail).

`stabilityPool.ts` — handlers for the 5 StabilityPool events. Routes via `srcAddress → collateralId`:

- **`StabilityPoolBoldBalanceUpdated`** — `LiquityInstance.spDeposits = _newBalance`. Recompute `spHeadroom = spDeposits - collateral.minBoldInSp`. This is the single source of truth for SP totals; no need to sum from individual deposits.
- **`StabilityPoolCollBalanceUpdated`** — `LiquityInstance.spColl = _newBalance`.
- **`DepositOperation`** + **`DepositUpdated`** — same-tx pair. `DepositUpdated` carries the authoritative new state. Upsert `StabilityPoolDepositor`: `deposit=_newDeposit`, `stashedColl=_stashedColl`. From `DepositOperation`: accumulate `cumulativeDeposited` / `cumulativeWithdrawn` from `_topUpOrWithdrawal` (positive=deposit, negative=withdraw), accumulate `yieldGainClaimedCum` / `ethGainClaimedCum`.
- **`RebalanceExecuted`** — append immutable `SpRebalanceEvent`. Bump `LiquityInstance.spRebalanceCount`, `spRebalanceCollInCum`, `spRebalanceStableOutCum`. Note: this is Mento-specific; SP collateral gets converted back to debt-token. Affects `spDeposits` indirectly but `StabilityPoolBoldBalanceUpdated` fires immediately after in the same tx, so no manual reconciliation needed.

`troveNFT.ts` — handles `Transfer(from, to, tokenId)`:

- Route via `srcAddress → collateralId`.
- If `from == ZERO_ADDRESS`: mint event during trove open. Upsert the Trove if `TroveOperation` has not run yet, set `owner = to`, then increment `BorrowerInfo` for `to` exactly once. If `TroveOperation` already created a placeholder with `owner=ZERO_ADDRESS`, this mint fills the owner.
- If `to == ZERO_ADDRESS`: burn event during trove close; no-op (Trove handler already flipped `status=closed`).
- Otherwise: ownership transfer. Set `Trove.previousOwner = current owner`, `Trove.owner = to`.

`borrowerOperations.ts` — handles `ShutDown(_tcr)`:

- Route via `srcAddress → collateralId` (find the LiquityCollateral row whose `borrowerOperations` matches).
- Set `LiquityInstance.isShutDown = true`, `shutDownAt = block.timestamp`, `shutDownTcrBps = _tcr * 10000 / 1e18` (TCR is D18 in the event but our schema uses bps).
- **This is the canonical input for the critical "Liquity Instance Shut Down" alert.**

`cdpLiquidityStrategy.ts` — handles 5 events. **This is the existing CDP strategy entity backlog item folded into this PR** (mentioned in `docs/BACKLOG.md:5-12` as the "Next" backlog item before Liquity):

- **`PoolAdded`** — upsert `CdpPool` for the pool (mirrors the existing OLS `PoolAdded` handler at `indexer-envio/src/handlers/openLiquidityStrategy.ts`). Persist the market identity from `params.debtToken` by resolving it to `LiquityCollateral.id`; store both `collateralId` and `debtToken` on `CdpPool` so UI queries and shortfall accounting do not depend on brittle Pool/reference-feed inference.
- **`PoolRemoved`** — set `CdpPool.removed = true`.
- **`LiquidityMoved`** — append `CdpLiquidityMove` event row.
- **`RebalanceCooldownSet`** — update `CdpPool.rebalanceCooldownSec`.
- **`RedemptionShortfallSubsidized`** — increment the matching `LiquityInstance.shortfallSubsidyCum` by reading `CdpPool.collateralId` for the pool. If `CdpPool` is missing because the event stream starts after `PoolAdded`, fall back to the `shared-config/liquity.ts` pool → instance map and repair the missing `CdpPool` row.

`reserveTroveFactory.ts` — handles `ReserveTroveCreated(addressesRegistry, troveId, debtAmount, collateralAmount)`:

- Lookup `LiquityCollateral` via `addressesRegistry` field (one-shot map lookup).
- Write `ReserveTrove` entity.
- Defensively re-trigger `bootstrapCollaterals` if not yet loaded for this addressesRegistry (handles cold-start ordering).

`instance.ts` — helper module:

- `recomputeRedemptionRate(instance, collateral, blockTimestamp)`: deterministic in-handler computation. Formula = `min(1, baseRate + REDEMPTION_FEE_FLOOR)` adjusted by minute decay since `lastFeeOpTime`. Use `REDEMPTION_MINUTE_DECAY_FACTOR` from `LiquityCollateral`. Set `currentRedemptionRateBps`. Call from `BaseRateUpdated` / `LastFeeOpTimeUpdated` / on the snapshot tick.
- `rollLiquityInstanceSnapshot(context, instance, hourBucket)`:
  1. Pull active Troves for this instance via `Trove.getWhere.collateralId.eq(collateralId)` then JS-filter `status === "active"`; verify a single-field index exposes the helper, with pagination as fallback.
  2. Compute `[icrP1Bps, icrP5Bps, icrP50Bps]` by sorting `icrBps` array; `icrFracBelowMcrBps` from count below `LiquityCollateral.mcrBps`.
  3. Compute system TCR via `tcr.ts` helper.
  4. Write `LiquityInstanceSnapshot` for hour bucket + roll to `LiquityInstanceDailySnapshot` on day-boundary crossings.

`tcr.ts` — helper module:

- `collateralDebtPriceD18(context, collateral)`: return the USDm collateral price denominated in the market's debt token, D18. Prefer the market's own Mento FX pool / SortedOracles feed (`USDm/GBPm`, `USDm/CHFm`, `USDm/JPYm`) or the Liquity oracle adapter source the contract uses; do **not** price all markets from the USDm/USDC pool. Returns `null` if the market-specific oracle is unavailable or stale during early backfill.
- `computeTcrBps(systemColl, systemDebt, collateralDebtPriceD18)`: `(systemColl * collateralDebtPriceD18 / 1e18 * 10000) / systemDebt`, with `0`-debt guard returning `-1`. Returns `-1` if the market-specific price is unavailable.
- `computeIcrBps(troveColl, troveDebt, collateralDebtPriceD18)`: same shape, per-trove.

> **Multi-handler-in-one-tx ordering**: a liquidation tx emits TroveOperation (op=LIQUIDATE) + TroveUpdated + Liquidation (from TroveManager) + DepositUpdated + StabilityPoolBoldBalanceUpdated + StabilityPoolCollBalanceUpdated (from StabilityPool) all in the same tx, plus TroveNFT.Transfer if the burn fires. Envio processes them in log-index order. **Critical**: every handler must use the "read-modify-write the full entity" pattern — no incremental updates that depend on ordering. The `pool.ts` upsert helper is the precedent; mirror it.
>
> **Hourly rollup trigger**: every event handler in `instance.ts` (after applying its own writes) checks if `block.timestamp` has crossed an hour boundary since the LiquityInstance's `lastEventTimestamp`. If so, call `rollLiquityInstanceSnapshot` for the prior hour bucket before processing the new event. Same per-tick pattern as `appendPoolSnapshot` in `pool.ts`.

#### A.5 — Unit tests

New: `indexer-envio/src/handlers/liquity/*.test.ts`. Use the existing pure-function unit-test pattern for stateful handler helpers: the Envio test harness can hide intra-handler `set()` calls, so test helpers in `instance.ts` / `tcr.ts` / `troveManager.ts`'s operation-enum dispatch directly, not only event-shaped handlers.

Test cases:

- **TroveOperation enum dispatch**: OPEN_TROVE → placeholder status=active without borrower attribution; CLOSE_TROVE → status=closed; LIQUIDATE → status=liquidated + liquidatedColl/Debt set; REDEEM_COLLATERAL → status=redeemed + redemption accumulators bump; APPLY_PENDING_DEBT → no status change.
- **InterestRateBracket update math**: applies prevRate=0/newRate=5% on a fresh trove → bracket created with `totalDebt=debt`, `sumDebtTimesRateD36` correct. Rate switch from 5% → 6% → debt moves between brackets with correct `pendingDebtTimesOneYearD36` accumulation per upstream formula (cross-check against the upstream reference at `liquity/bold/subgraph/src/TroveManager.mapping.ts:updateRateBracketDebt`).
- **Batch math**: BatchedTroveUpdated with `batchDebtShares=100` persists pending state; later BatchUpdated with `totalDebtShares=400`, `debt=1000e18` replays pending state → per-trove debt = `1000e18 * 100 / 400 = 250e18`, system totals update, pending row removed.
- **ICR computation**: coll=200e18 USDm, debt=100e18 GBPm, `collateralDebtPriceD18=0.75e18` (USDm/GBPm) → known expected bps. Include CHFm and JPYm cases so unit conversion cannot regress to USDm/USD-only math.
- **TCR sentinel**: market-specific price null → tcrBps = -1; debt=0 → tcrBps = -1; happy path matches floor(coll·price/debt·10000).
- **Headroom**: spDeposits=1000e18, minBoldInSp=200e18 → spHeadroom=800e18; systemParamsLoaded=false → spHeadroom=-1.
- **Percentile computation**: 10 troves with known ICRs [110, 120, 130, 140, 150, 160, 170, 180, 190, 200] → p1=110, p5=110, p50=155 (or whichever sort + nearest convention chosen — pin in test).
- **Redemption-rate decay**: baseRate=0.05, REDEMPTION_FEE_FLOOR=0.005, lastFeeOpTime=t-1m, MINUTE_DECAY=0.999 → expected rate matches the upstream `getRedemptionRateWithDecay` reference.
- **CDPLiquidityStrategy.PoolAdded** → CdpPool row created with `removed=false`, `debtToken`, and `collateralId`; subsequent PoolRemoved → `removed=true`.
- **Borrower attribution**: TroveOperation open followed by TroveNFT mint sets owner and increments BorrowerInfo; TroveNFT mint followed by TroveOperation open preserves the owner instead of resetting it to ZERO_ADDRESS.
- **ShutDown handler** → LiquityInstance.isShutDown flips true, shutDownAt set.
- **TroveNFT.Transfer**: from!=ZERO and to!=ZERO → previousOwner updates, owner updates.

### Phase B — Dashboard (same PR)

UI scope spans all three CDP markets (GBPm + CHFm + JPYm — each a Liquity v2 instance under the hood, but **never call them "Liquity instances" in UI copy**). Routes use a `[symbol]` segment to switch between them — pattern mirrors how `/pool/[poolId]` works today. All user-visible strings use "CDP" / "CDPs"; "Liquity" only appears inside code identifiers that reference the underlying protocol.

#### B.1 — GraphQL queries

New file: `ui-dashboard/src/lib/queries/liquity.ts`. Re-export from `ui-dashboard/src/lib/queries.ts`.

Queries (all parameterized by `collateralId` = `{chainId}-{troveManager}`):

- `LIQUITY_COLLATERALS_LIST(chainId)` — all `LiquityCollateral` rows with their `LiquityInstance` joined; powers the index page.
- `LIQUITY_INSTANCE_LATEST(collateralId)` — full latest state.
- `LIQUITY_INSTANCE_SNAPSHOTS(collateralId, from, to)` — time-series for TCR / headroom / ICR percentiles. Use `LiquityInstanceDailySnapshot` for windows >7d to avoid Hasura's 1000-row cap.
- `LIQUITY_TROVES_BY_ICR(collateralId, status, limit, offset)` — paginated trove table. Default `status="active"`, `limit=100`.
- `LIQUITY_DEPOSITORS_TOP(collateralId, limit)` — top SP depositors by `deposit` descending.
- `LIQUITY_LIQUIDATIONS_RECENT(collateralId, limit)` — last 50 `LiquidationEvent` rows.
- `LIQUITY_REDEMPTIONS_RECENT(collateralId, limit)` — last 50 `RedemptionEvent` rows.
- `LIQUITY_SP_REBALANCES_RECENT(collateralId, limit)` — Mento-specific SP rebalance event history.
- `LIQUITY_INTEREST_BRACKETS(collateralId)` — for the interest-rate distribution chart.
- `CDP_POOLS_FOR_INSTANCE(collateralId)` — FPMM pools backed by Liquity (joins `CdpPool` ↔ `Pool` ↔ `ReserveTrove`).

Reuse `ui-dashboard/src/lib/network-fetcher/fetch.ts` for the GraphQL transport. Pool-detail's multi-query orchestration with isolated error boundaries is the right precedent.

#### B.2 — New routes

- `/cdps` — landing page listing all three markets (GBPm/CHFm/JPYm) with headline KPIs per market and a side-by-side comparison row.
- `/cdps/[symbol]` — per-market deep-dive (`/cdps/gbpm`, `/cdps/chfm`, `/cdps/jpym`). Slug → collateralId via `shared-config` lookup.

Files:

- `ui-dashboard/src/app/cdps/page.tsx` — server entry, metadata.
- `ui-dashboard/src/app/cdps/_components/cdps-index-client.tsx` — `'use client'` wrapper; renders per-market tile rows.
- `ui-dashboard/src/app/cdps/[symbol]/page.tsx` — server entry, metadata per symbol.
- `ui-dashboard/src/app/cdps/[symbol]/_components/cdp-market-client.tsx` — per-market dashboard layout.
- `ui-dashboard/src/app/cdps/loading.tsx` + `error.tsx` — skeleton + error boundary.

#### B.3 — Components

New files under `ui-dashboard/src/components/cdps/`:

- `cdp-market-header.tsx` — KPI tile row (per market):
  - **TCR** — color thresholds keyed to the market's own `ccrBps` (warn at 1.2× CCR, critical at CCR). Pull from `LiquityCollateral`, not hardcoded.
  - **System Debt** (in the market's debt token: GBPm / CHFm / JPYm).
  - **System Collateral (USDm)**.
  - **Active Troves**.
  - **SP Headroom** — red when negative, amber when < 10% of `spDeposits`. Sentinel `-1` renders "Loading config…".
  - **Redemption Rate** — current rate in bps.
  - **Status** — `LIVE` / `SHUT DOWN`. Shutdown shows the at-shutdown TCR.
- `cdps-overview.tsx` — landing-page summary cards (TCR + headroom + active troves per market side-by-side).
- `icr-distribution-chart.tsx` — Plotly histogram of active Trove ICRs. Overlay vertical lines at `mcrBps` and 1.2× MCR (warn line). Per market.
- `icr-percentile-chart.tsx` — line chart of p1/p5/p50 ICR over time from `LiquityInstanceSnapshot`.
- `trove-table.tsx` — sortable: troveId, owner, status, debt, coll, ICR, interestRate, batch. Default sort: ICR ascending. Status filter dropdown. Owner column uses the existing address-book label hook. UI strings use "trove" (industry-standard CDP term, no Liquity brand attached).
- `interest-rate-distribution-chart.tsx` — `InterestRateBracket` rows for the market; renders total debt per rate bracket as bars.
- `stability-pool-tile.tsx` — deposits, stashedColl, headroom, minBoldInSp; `Loading…` until `systemParamsLoaded=true`.
- `stability-pool-depositors-list.tsx` — top SP depositors table with address-book labels.
- `liquidation-history-chart.tsx` — daily counts + cumulative line from `LiquityInstanceDailySnapshot.liqCount` / `liqCountCum`. Never use Hasura `_aggregate` for dashboard lifetime metrics; sum client-side or read a rollup entity.
- `redemption-history-chart.tsx` — same shape as liquidation.
- `sp-rebalance-history-tile.tsx` — Mento-specific: shows recent SP→stable rebalances with running totals from `LiquityInstance.spRebalanceStableOutCum`.
- `tcr-history-chart.tsx` — time series of `tcrBps` with reference lines at MCR/CCR/SCR.
- `cdp-pool-link-tile.tsx` — for each FPMM pool with a `CdpPool` row, a card linking to the pool's detail page; shows the linked `ReserveTrove` ID and most recent `CdpLiquidityMove` event.

#### B.4 — Cross-links from existing pages

- **Pool detail page for any FPMM pool with a `CdpPool` row** — currently uses `ui-dashboard/src/lib/strategy-detection.ts` to RPC-probe strategy type. **Replace** with `CdpPool` query. Pool detail then renders a "CDP Market" link tile (mirrors OLS panel cross-link) pointing to `/cdps/[symbol]` for the underlying market.
- **Global homepage `/`**: add a "CDPs" entry under the existing header nav.
- **Revenue page `/revenue`**: wire `LiquityInstance.redemptionFeeCum` across all three markets into the existing "CDP Borrowing Fees" placeholder tile (sum-across-markets; show the breakdown on hover).
- **Global pools table**: the existing `CDP strategy badge` (PR #214 stopgap) gets re-pointed at the `CdpPool` query instead of the RPC probe. Delete `ui-dashboard/src/lib/strategy-detection.ts` once the indexer is verified live — keep the deletion in the same PR since the indexer side ships the entity that replaces it.

#### B.5 — Chart conventions to reuse

- `chart-gap-fill.ts` — not yet built (still on dashboard backlog). Liquity charts can use the same per-snapshot "drop missing buckets" approach the existing charts use; do not block on the gap-fill helper. Document the choice in a one-line comment.
- Plotly setup matches `oracle-chart.tsx` / `snapshot-chart.tsx`.
- Use `shared-config`'s `CHAIN_NAMES` + `BLOCK_EXPLORER_BASE_URLS` for any tx-link / chain-icon enrichment.

#### B.6 — Authentication / authz

The `/cdps` route inherits the existing middleware-enforced `@mentolabs.xyz` allowlist + CSP via the Next.js layout — no changes needed.

#### B.7 — Tests

- `ui-dashboard/src/app/cdps/page.test.tsx` — render with mocked fetch; assert KPI tiles render with finite values.
- Component-level tests for `icr-distribution-chart.tsx` and `trove-table.tsx` only — match existing test sparseness; broader coverage tracked in BACKLOG.

### Phase C — Alerts (follow-up PR, NOT in this scope)

For completeness; do not implement now. Follow-up PR:

- `metrics-bridge` adds `mento_liquity_*` gauges by polling `LIQUITY_INSTANCE_LATEST` on the same 30s tick.
- `terraform/alerts/rules-cdps.tf` with `service=cdps` rules:
  - **Stability Pool Headroom Critical** — `mento_liquity_sp_headroom < 0` for 5m.
  - **TCR Low Warning** — `mento_liquity_tcr_bps < 11500` for 15m.
  - **TCR Critical** — `mento_liquity_tcr_bps < 11000` for 5m.
  - **ICR Below MCR Spike** — `mento_liquity_icr_frac_below_mcr_bps > 500` (5% of troves underwater) for 10m.

---

## Critical files to modify

| Path                                                                                                                                                                                  | Change                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/ROADMAP.md`                                                                                                                                                                     | Refresh Done lists per Part 1; move Liquity to Next                                                                                                                                                                                                                                                                                        |
| `SPEC.md` (§5.5, §11)                                                                                                                                                                 | Liquity status → "Phase 2 in progress"; Next swap                                                                                                                                                                                                                                                                                          |
| `docs/BACKLOG.md`                                                                                                                                                                     | Drop the Liquity entry + CDP-strategy entry (both ship in this PR); add `service=cdps` alerts follow-up                                                                                                                                                                                                                                    |
| `indexer-envio/scripts/generateAbis.mjs`                                                                                                                                              | EDIT — extend to copy 9 Liquity ABIs from `@mento-protocol/contracts`                                                                                                                                                                                                                                                                      |
| `indexer-envio/abis/liquity/{TroveManager,StabilityPool,TroveNFT,BorrowerOperations,CollateralRegistry,CDPLiquidityStrategy,ReserveTroveFactory,SystemParams,AddressesRegistry}.json` | NEW — vendored ABIs (committed)                                                                                                                                                                                                                                                                                                            |
| `indexer-envio/schema.graphql`                                                                                                                                                        | Append `LiquityCollateral`, `Trove`, `InterestRateBracket`, `InterestBatch`, `PendingBatchedTroveUpdate`, `BorrowerInfo`, `StabilityPoolDepositor`, `LiquityInstance`, `LiquityInstanceSnapshot`, `LiquityInstanceDailySnapshot`, `LiquidationEvent`, `RedemptionEvent`, `SpRebalanceEvent`, `CdpPool`, `ReserveTrove`, `CdpLiquidityMove` |
| `indexer-envio/config.multichain.mainnet.yaml`                                                                                                                                        | Add 7 contracts (global + Celo addresses + Monad empties); set per-Liquity-contract `start_block` overrides                                                                                                                                                                                                                                |
| `indexer-envio/src/EventHandlers.ts`                                                                                                                                                  | 7 side-effect imports for new handlers                                                                                                                                                                                                                                                                                                     |
| `indexer-envio/src/handlers/liquity/bootstrap.ts`                                                                                                                                     | NEW — CollateralRegistry discovery, SystemParams snapshot, AddressesRegistry reads                                                                                                                                                                                                                                                         |
| `indexer-envio/src/handlers/liquity/collateralRegistry.ts`                                                                                                                            | NEW — `BaseRateUpdated` / `LastFeeOpTimeUpdated` / `LiquidityStrategyUpdated`                                                                                                                                                                                                                                                              |
| `indexer-envio/src/handlers/liquity/troveManager.ts`                                                                                                                                  | NEW — 7-event handler set incl. operation-enum dispatch                                                                                                                                                                                                                                                                                    |
| `indexer-envio/src/handlers/liquity/stabilityPool.ts`                                                                                                                                 | NEW — 5-event handler set                                                                                                                                                                                                                                                                                                                  |
| `indexer-envio/src/handlers/liquity/troveNFT.ts`                                                                                                                                      | NEW — Transfer handler                                                                                                                                                                                                                                                                                                                     |
| `indexer-envio/src/handlers/liquity/borrowerOperations.ts`                                                                                                                            | NEW — ShutDown handler                                                                                                                                                                                                                                                                                                                     |
| `indexer-envio/src/handlers/liquity/cdpLiquidityStrategy.ts`                                                                                                                          | NEW — PoolAdded/Removed/LiquidityMoved/RebalanceCooldownSet/RedemptionShortfallSubsidized                                                                                                                                                                                                                                                  |
| `indexer-envio/src/handlers/liquity/reserveTroveFactory.ts`                                                                                                                           | NEW — ReserveTroveCreated handler                                                                                                                                                                                                                                                                                                          |
| `indexer-envio/src/handlers/liquity/instance.ts`                                                                                                                                      | NEW — rollup, redemption-rate decay, headroom                                                                                                                                                                                                                                                                                              |
| `indexer-envio/src/handlers/liquity/tcr.ts`                                                                                                                                           | NEW — TCR / ICR math                                                                                                                                                                                                                                                                                                                       |
| `indexer-envio/src/handlers/liquity/*.test.ts`                                                                                                                                        | NEW — unit tests per A.5                                                                                                                                                                                                                                                                                                                   |
| `indexer-envio/src/rpc/effects.ts`                                                                                                                                                    | EDIT — add `readSystemParamsEffect`, `readAddressesRegistryEffect` (mirror `selfHealRebalanceThresholds`)                                                                                                                                                                                                                                  |
| `shared-config/liquity.ts`                                                                                                                                                            | NEW — symbol → collateralId map (gbpm/chfm/jpym → chain+troveManager); slug helpers; pool→instance fallback map if cdpLiquidityStrategy resolution proves brittle                                                                                                                                                                          |
| `ui-dashboard/src/lib/queries/liquity.ts`                                                                                                                                             | NEW — 10 GraphQL queries per B.1                                                                                                                                                                                                                                                                                                           |
| `ui-dashboard/src/lib/queries.ts`                                                                                                                                                     | EDIT — re-export liquity queries                                                                                                                                                                                                                                                                                                           |
| `ui-dashboard/src/lib/strategy-detection.ts`                                                                                                                                          | DELETE — replaced by CdpPool query                                                                                                                                                                                                                                                                                                         |
| `ui-dashboard/src/app/cdps/page.tsx`                                                                                                                                                  | NEW — CDPs landing                                                                                                                                                                                                                                                                                                                         |
| `ui-dashboard/src/app/cdps/_components/cdps-index-client.tsx`                                                                                                                         | NEW — landing client                                                                                                                                                                                                                                                                                                                       |
| `ui-dashboard/src/app/cdps/[symbol]/page.tsx`                                                                                                                                         | NEW — per-market entry                                                                                                                                                                                                                                                                                                                     |
| `ui-dashboard/src/app/cdps/[symbol]/_components/cdp-market-client.tsx`                                                                                                                | NEW — per-market dashboard client                                                                                                                                                                                                                                                                                                          |
| `ui-dashboard/src/app/cdps/{loading,error}.tsx`                                                                                                                                       | NEW                                                                                                                                                                                                                                                                                                                                        |
| `ui-dashboard/src/components/cdps/*`                                                                                                                                                  | NEW — 13 components per B.3                                                                                                                                                                                                                                                                                                                |
| `ui-dashboard/src/components/global-pools-table.tsx`                                                                                                                                  | EDIT — swap RPC-probed `cdp` badge to `CdpPool` join                                                                                                                                                                                                                                                                                       |
| `ui-dashboard/src/app/pool/[poolId]/_components/*`                                                                                                                                    | EDIT — add "CDP Market" link tile for any pool with a CdpPool row                                                                                                                                                                                                                                                                          |
| `ui-dashboard/src/app/layout.tsx` (or nav file)                                                                                                                                       | EDIT — add "CDPs" nav entry                                                                                                                                                                                                                                                                                                                |
| `ui-dashboard/src/app/revenue/_components/*`                                                                                                                                          | EDIT — wire `redemptionFeeCum` sum into "CDP Borrowing Fees" tile                                                                                                                                                                                                                                                                          |
| `ui-dashboard/src/__tests__/dashboard-flows.test.ts`                                                                                                                                  | EDIT — update existing CDP-related mocks that reference `stabilityPoolBalance` / `stabilityPoolTokenSymbol`                                                                                                                                                                                                                                |

## Existing utilities to reuse

- **RPC effects pattern**: `indexer-envio/src/rpc/effects.ts` — model `selfHealSpMinBuffer` on `selfHealRebalanceThresholds` / `selfHealTokenDecimals`. Same retry semantics, sentinel values, `*Known` flag pattern.
- **Hourly rollup pattern**: `indexer-envio/src/handlers/fpmm/*` — `appendPoolSnapshot` writes `PoolSnapshot`; mirror for `LiquityInstanceSnapshot`. Daily rollup pattern: `PoolDailySnapshot`.
- **GraphQL fetch**: `ui-dashboard/src/lib/network-fetcher/fetch.ts` — multi-query orchestration with isolated error boundaries per query (used by pool detail).
- **Data table primitives**: same row/sort helpers as `ui-dashboard/src/components/global-pools-table.tsx`.
- **Chart Plotly setup**: copy from `oracle-chart.tsx` (dual y-axis) and `snapshot-chart.tsx` (bars + line).
- **Address label enrichment**: existing address-book lookup hook (used in `stability-pool-depositors-list.tsx`).
- **Chain icon + pool-pair labels**: from `shared-config`.
- **Skeletons + error boundary primitives**: `ui-dashboard/src/components/skeletons.tsx`.

## Deploy sequencing

Deploy indexer schema and dashboard together so the UI never points at a schema-mismatched production endpoint:

1. Open PR with all indexer + UI changes.
2. From the PR branch tip, run `pnpm deploy:indexer --yes`. This pushes the current HEAD to the `envio` deploy branch and starts a new hosted deployment for the multichain mainnet indexer.
3. Wait for full sync with `pnpm deploy:indexer:status "$COMMIT" --watch`. Verify via Hasura console + `pnpm exec envio-cloud deployment info mento "$COMMIT" mento-protocol -o json` that `LiquityInstance` is populated and `LiquityInstanceSnapshot` rows are accumulating hourly. Expect first-pass sync to take a few minutes since TroveManager block range is small (Liquity v2 is a relatively recent deployment).
4. Once sync verified, merge the PR.
5. Promote the same caught-up commit with `pnpm deploy:indexer:promote "$COMMIT"`. The production GraphQL endpoint is static, so no `NEXT_PUBLIC_HASURA_URL` update is required unless the Envio project itself changes.
6. Let Vercel deploy `main` for dashboard code changes, or trigger a redeploy only if the Git integration skipped unexpectedly.
7. Verify dashboard `/cdps` route is live and per-market tiles populate.

## Verification

End-to-end:

1. **Indexer-local**: `pnpm indexer:dev` scoped to a Celo block range that includes the GBPm deployment block + at least one TroveOperation + one Liquidation + one Redemption. Hit local Hasura: `SELECT * FROM "LiquityCollateral"` (expect 3 rows), `SELECT * FROM "LiquityInstance"` (expect 3 rows), `SELECT * FROM "Trove" WHERE status='active' LIMIT 10`. Cross-check ICR values against Celoscan-decoded TroveUpdated logs.
2. **Unit tests**: `pnpm --filter @mento-protocol/indexer-envio test` — Phase A.5 tests must pass.
3. **TCR sanity check**: pick a recent TroveOperation tx; compute expected TCR from on-chain `TroveManager.getTCR(price)` view; compare to our derived `LiquityInstance.tcrBps`. Tolerance ±100 bps (interest accrual drift); investigate if larger.
4. **Hasura prod**: post-deploy curl-verify each query before the UI relies on it:
   ```bash
   curl 'https://<endpoint>/v1/graphql' -H 'content-type: application/json' \
     -d '{"query":"{ LiquityCollateral { id symbol mcrBps minBoldInSp } LiquityInstance { id collateralId systemDebt tcrBps spDeposits spHeadroom isShutDown } }"}'
   ```
   Also verify `LIQUITY_INSTANCE_SNAPSHOTS` paginates correctly under the 1000-row cap.
5. **Browser** (chrome-devtools MCP): hit `/cdps`, then `/cdps/gbpm`, `/cdps/chfm`, `/cdps/jpym`. Assert KPI tiles render finite values, ICR chart loads, trove table sorts by ICR ascending, address-book labels render on the depositors list.
6. **Cross-instance**: confirm the homepage `CDP strategy badge` swaps from RPC-probe to indexer query without behavior regression on existing CDP-backed pools.
7. **Typecheck + lint**: `pnpm agent:quality-gate --run` and the mapped package checks. Re-run after merging if the dashboard diff touches react-doctor-gated files.
8. **PR review**: ship via `/ship`; address human and automated review comments, and reply to every inline PR comment with the commit that fixed it or a technical won't-fix reason.

## Risks + things to verify before starting code

The bulk of the original risk list (event signature uncertainty, MCR view-call name, etc.) has been **resolved** by the verification pass against `@mento-protocol/contracts@0.8.0`. The remaining open risks:

1. **Envio v3 multi-address subscription**. The plan registers three TroveManager addresses under a single contract name. Confirm Envio v3 dispatches each event with `event.srcAddress` populated so handlers can route per instance. If it doesn't, fall back to separate contract definitions per instance (more YAML, same semantics).
2. **`AddressesRegistry` / `SystemParams` discovery accessors**. The implementation must not assume `AddressesRegistry.systemParams()` exists. Verify the deployed ABIs before using discovery calls; otherwise use the static per-market contract table in `shared-config/liquity.ts` for AddressesRegistry and SystemParams.
3. **`Trove.id` collision across CHFm/JPYm reusing the same troveId integer.** Liquity v2 emits `_troveId: uint256` per instance. Two instances can independently emit `_troveId=0`. The schema's `id` key uses `{chainId}-{troveManager}-{troveIdHex}` to disambiguate; verify the upstream subgraph's `troveFullId = collId + ":" + troveId.toHexString()` convention matches. Cross-instance NFT transfers are not possible (TroveNFT is per-instance) so the chain+troveManager+troveId triple is sound.
4. **CDPLiquidityStrategy `params` tuple decoding**. The `PoolAdded(indexed address pool, tuple params)` event uses an inline-struct tuple and includes the debt token that identifies the CDP market. Envio codegen should handle this; if not, decode manually from `event.params.params` ABI. Verify shape by reading the contract source on Celoscan.
5. **`previousOwner` initial value on Trove**. ERC721 mints fire `Transfer(0x0, owner, tokenId)`. The plan defaults `previousOwner = ZERO_ADDRESS` until a real transfer; the upstream subgraph schema is non-null so make sure our schema marks it `String!` with the ZERO_ADDRESS default rather than nullable.
6. **Interest-bracket rate flooring precision**. Upstream floors at 3 decimals (0.1%). Implementations use D18 floor. Cross-check with a unit test against a known mainnet TroveOperation rate value to confirm bracket assignment.
7. **`SP_YIELD_SPLIT` interpretation**. SystemParams returns this as uint256 — bps or fraction? Read the deployed value (likely 7500 = 75% if bps) before using.
8. **Start-block discovery**. The TroveManager + StabilityPool deployment block must be set per-contract or backfill will scan from FPMM start (60664500), wasting time. Action: query Celoscan for the deploy tx of `0xb38aEf2bF4e34B997330D626EBCd7629De3885C9` (GBPm TroveManager), `0x4E105FEF015db26320C077427BD605AceAd9262E` (CHFm), `0xD2E65Af47d927D5e84F384ae6bAC4F97C3dA65Df` (JPYm); use the min.
9. **CDPLiquidityStrategy ↔ instance resolution**. `RedemptionShortfallSubsidized(pool, shortfall)` doesn't include the instance. The primary key is `CdpPool.collateralId` persisted at `PoolAdded` from `params.debtToken`; if historical ordering or a missing PoolAdded row leaves it absent, fall back to a `pool → collateralId` map in `shared-config/liquity.ts` and repair the row.
10. **Cross-handler bracket update race**. The same Trove can fire `TroveOperation` (state change) and `TroveUpdated` (new state) in the same tx. Both call `updateRateBracketDebt`. **Must apply only once** — pick `TroveUpdated` as the canonical "rate/debt changed" source and have `TroveOperation` skip bracket updates. Match upstream's pattern.

## What this plan does NOT include

- `service=cdps` alert rules + metrics-bridge gauges (follow-up PR).
- A "CDPs" homepage KPI tile / cross-protocol view — the routes are the only new surface.
- Multichain deployment of Liquity (no Monad addresses; Monad config has empty arrays).
- A `RateFeed` entity to fix the Oracle Source heuristic (separate BACKLOG item).
- The `mightBeLeveraged` heuristic via FlashLoan-log scanning (deferred per upstream-cross-check section).
- StabilityPool internal accumulators (`P_Updated`, `S_Updated`, etc.) — defer until a use case needs accurate per-depositor pending-gains math.
- ActivePool / DefaultPool event indexing — TroveManager events are sufficient; revisit if drift detection becomes a use case.
- LQTY governance entities (`GovernanceVotingPower` etc.) — Mento doesn't ship them.
- CollSurplusPool user-claim flow — not load-bearing for monitoring.
- Streamlit / ClickHouse access (future).
