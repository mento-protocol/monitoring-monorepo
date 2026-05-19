# AGENTS.md — Envio Indexer

## What This Is

Envio HyperIndex indexer for Mento v3 FPMM (Fixed Product Market Maker) pools on Celo + Monad (multichain). Also indexes the Mento v2 Broker on Celo (legacy `Broker → BiPoolManager` swap path) for the homepage v2/v3 volume split.

## Before Opening PRs

If your indexer change propagates into Hasura/UI behavior — schema changes, entity additions, new fields on existing entities, degraded RPC/error handling, or any stateful dashboard behavior fed by indexer data — read and apply:

- `../docs/pr-checklists/stateful-data-ui.md`

This is mandatory for cross-layer/stateful data work. Do not assume the UI/query layer will “just catch up” later.

## Key Files

- `config.multichain.mainnet.yaml` — **Default** mainnet config (Celo + Monad)
- `config.multichain.testnet.yaml` — Testnet multichain config
- `schema.graphql` — Entity definitions (FPMM, Swap, Mint, Burn, UpdateReserves, Rebalanced, BrokerSwapEvent + BrokerDailySnapshot for the v2 path)
- `src/EventHandlers.ts` — Event processing logic
- `src/contractAddresses.ts` — Contract address resolution from `@mento-protocol/contracts`; also exports `CONTRACT_NAMESPACE_BY_CHAIN` (backed by `config/deployment-namespaces.json`)
- `config/deployment-namespaces.json` — Vendored copy of the chain ID → active namespace map used by Envio hosted builds
- `scripts/run-envio-with-env.mjs` — Wrapper that loads .env before running envio CLI
- `abis/` — Vendored ABIs, refreshed from `@mento-protocol/contracts` via `pnpm generate:abis`. ERC20 stub + Wormhole NTT minimal subsets are hand-vendored (excluded from the script — see `scripts/generateAbis.mjs` header).

## Commands

```bash
pnpm codegen   # Generate types from schema + config
pnpm dev       # Start indexer in dev mode (Docker: Postgres + Hasura)
pnpm start     # Start in production mode
pnpm stop      # Stop Docker containers
pnpm test      # Run tests (vitest)
```

## How It Works

1. Envio connects to Celo RPC and listens for events from configured contracts
2. Events are processed by `EventHandlers.ts` and stored in Postgres
3. Hasura auto-generates a GraphQL API over the Postgres tables
4. The dashboard queries Hasura for pool data

## Contract Types

- **Broker** — Legacy v2 settlement layer (`Broker → BiPoolManager`). Celo only (no Broker on Monad). Each `Swap` is denormalized with `routedViaV3Router` (`tx.to == Routerv300`) so the homepage chart can exclude router-driven sibling rows that are already counted via `VirtualPool.Swap`.
- **FPMMFactory** — Deploys new FPMM pools
- **FPMM** — Fixed Product Market Maker pools (Swap, Mint, Burn, UpdateReserves, Rebalanced events)
- **VirtualPoolFactory** — Deploys virtual pools
- **VirtualPool** — Virtual pool instances (same event set as FPMM)

## Dependencies

- **`@mento-protocol/contracts`** — Contract ABIs and addresses (published npm package).
- **`config/deployment-namespaces.json`** — Vendored namespace map for Envio hosted compatibility; keep it in sync with `../shared-config/deployment-namespaces.json`.
- **`src/feeToken.ts:buildKnownTokenMeta`** — Vendored mirror of `../shared-config/src/tokens.ts` (token filter: exclude `StableToken*`, canonicalize trailing `Spoke`). The indexer layers on a stricter policy at the call site (also exclude `Mock*`, require `decimals`) for the fee-token allowlist. This is a **deliberate mirror**, not dedup debt: Envio may build the indexer outside the pnpm workspace (see `src/contractAddresses.ts:14-18`), so the shared workspace package is unsafe here. When the filter policy changes in one place, update both.
- **`viem`** — Used for RPC calls (oracle reporter count via `readContract`).

## Environment

Copy `.env.example` → `.env` and set:

- `ENVIO_API_TOKEN` — required only for chains that default to HyperRPC (currently only Monad Testnet 10143). Not needed for mainnet if using the full-node defaults. ([create token](https://envio.dev/app/api-tokens))
- `ENVIO_RPC_URL_42220` — (optional) Celo Mainnet primary RPC override (default: `https://forno.celo.org`)
- `ENVIO_RPC_URL_143` — (optional) Monad Mainnet primary RPC override (default: `https://rpc2.monad.xyz`)
- `ENVIO_RPC_URL_10143` — (optional) Monad Testnet primary RPC override (default: HyperRPC — requires `ENVIO_API_TOKEN`)
- `ENVIO_RPC_FALLBACK_URL_<chainId>` — (optional) explicit per-chain fallback RPC for `readContractWithBlockFallback`. Used for **both** archive-depth and rate-limit failover, so the fallback must cover the full sync window. When unset, falls back to `RPC_CONFIG_BY_CHAIN[<chainId>].default` only if the primary differs from it; otherwise no fallback is used. Empty-string values are treated as unset. **Caveat:** swapping in a shallow-archive secondary as the fallback (e.g. a tokenized QuickNode URL behind `rpc2.monad.xyz`) only works when the deep-archive primary rarely rate-limits at the indexer's load — otherwise rate-limit failover can leak into archive-depth misses during catch-up.
- `ENVIO_START_BLOCK_CELO` — (optional) Celo start block, defaults to 60664500
- `ENVIO_START_BLOCK_MONAD` — (optional) Monad start block, defaults to 60710000

Do **not** set the generic `ENVIO_RPC_URL` in multichain mode — it would route all chains to the same endpoint and produce incorrect RPC reads for chain-specific calls.

> **Note:** These RPC URLs are only used for contract reads (`eth_call`). Envio's event syncing uses HyperSync, configured in the YAML files.

Mainnet (Celo + Monad): `pnpm indexer:codegen && pnpm indexer:dev`. Testnet (Celo Sepolia + Monad Testnet): `pnpm indexer:testnet:dev`.

## Indexer patterns the bots keep catching

These rules come from PRs #184 and #194 — Codex flagged both as P1.

### Composite IDs MUST be collision-resistant

- A composite ID built from `entityId + timestamp(seconds)` is **insufficient**. Two events in the same block (or adjacent blocks with identical timestamps) get the same ID; the second write silently overwrites the first
- Always include enough block-level entropy: `chainId + blockNumber + logIndex` is the minimum, or `txHash + logIndex` if you need cross-chain uniqueness
- Specifically: any "transition" entity (breach open/close, reserve update, status change) keyed solely on the parent entity + a coarse timestamp will lose history under bursts

### Cumulative counters belong on the entity

- Lifetime aggregates (cumulative critical seconds, total breach count, cumulative volume) MUST be incremented in handlers and stored on the entity, NOT computed client-side from a paginated list
- The dashboard reads from hosted Hasura which silently caps every query at 1000 rows; client-side aggregation will drop history for any active pool
- Pattern: when you add a new "incident" entity, also add a counter field on the parent entity and increment it in the close-path handler

### Time units

- FX-pool metrics use **trading-seconds** (weekend subtracted). Any duration field on a healthscore-related entity MUST be in trading-seconds
- Never store wall-clock durations alongside trading-second durations on the same entity — readers will mix them and produce nonsense
- The shared FX calendar lives in `shared-config/fx-calendar.json` so the indexer and UI stay in lockstep

### Bounded RPC caches

- Block-keyed RPC caches (oracle reads, etc.) MUST be size-bounded. PR #184 fixed an OOM where the indexer cached one entry per block forever
- Use an LRU or evict on block height advance; never an unbounded `Map`

### File-size budget

- Soft cap: 600 lines/file (advisory). Hard cap: 1,000 lines.
- `pnpm lint` enforces the 1,000-line hard cap for `src/**/*.ts`; tests are exempt. Apply the 600-line soft cap anyway because several files remain close to or slightly above it.
- Suggested seams when splitting: one helper per RPC/effect family under `src/rpc/`; per-event handlers under `src/handlers/<entity>/` for big handler files.
- Rationale + monthly drift detector: see `/AGENTS.md` §"File-size budget".

### Self-heal pipeline coordination

PR #369 (vp-phase2 follow-up) hit 7 rounds of codex review chasing edges of how the heal pipeline interacts with downstream consumers. When adding a new self-heal helper that updates Pool fields (or a similar multi-flag entity heal), the checklist:

- **Widen ALL gate-style predicates that read those fields.** Source-only checks like `pool.source?.includes("virtual")` exist in many places: `ui-dashboard/src/lib/health.ts` (`computeHealthStatus`, `computeLimitStatus`, `computeRebalancerLiveness`, `computePoolUptimePct`), `ui-dashboard/src/lib/pool-og.ts` (`computeHealthReasons`, `computeOracleFreshness`), every detail panel (`HealthPanel`, `LimitPanel`, `OracleTab`), `use-rebalance-check`, `global-pools-table.tsx`'s row `isVirtual` gate, `indexer-envio/src/handlers/sortedOracles.ts` (both `OracleReported` and `MedianUpdated`). If the new heal widens what counts as the entity-kind being healed, every such predicate must also widen, or healed rows get FPMM-only rendering / FPMM-only RPC probes downstream. Grep for the old shape of the predicate before calling the work done.
- **Plumb new fields into every GraphQL query that consumes them.** Detail queries (`POOL_DETAIL_WITH_HEALTH`) AND list queries (`ALL_POOLS_WITH_HEALTH`) AND OG metadata queries — a healed VP shows correctly on the detail page but as an unhealthy FPMM in the global pools table if the list query doesn't fetch the new field.
- **Decide cross-pass coordination semantics up front.** If a flag (e.g. `tokenDecimalsKnown`) requires both legs of a pair to be set, AND the legs may land in separate events, the helper must either (a) re-validate via cache:true effects on every call (cheap), or (b) coordinate via a separate cross-pass helper (`selfHealTokenDecimals`-style). Don't pin the flag based on `value > 0` truthy checks — schema defaults satisfy them.
- **Gate-vs-retry: the gate must not short-circuit on partial state.** A gate like `if (wrappedExchangeId && token0 && token1) return pool;` fires after a transient `poolExchangeEffect` failure leaves the row mid-state (token addresses pinned but no `BiPoolExchange` row + no `referenceRateFeedID` mirrored). The fully-healed condition must include downstream side effects, not just the entity's own fields. PR #369 ended up checking `BiPoolExchange.get(exchangeRowId)` in the gate — extra DB read per event is the cost of correct retry semantics.
- **Test setup must mock every RPC effect the merged-in heal pipeline can hit.** Upstream merges add new heal steps (e.g. `selfHealTokenDecimals` was added by PR #370 mid-PR-#369) — existing tests that drove `upsertPool` for an unmocked code path then time out in CI (locally fine because forno.celo.org is reachable from dev machines, not from blacksmith CI runners). When extending a heal-driven test, re-check what RPC paths the heal touches NOW, not when the test was written.

### Vitest timeout and RPC mocks

- `vitest.config.ts` sets the indexer timeout to 60s. Do not add Mocha-style `this.timeout(...)` calls or `/// <reference types="mocha" />` pragmas; this package now runs on Vitest.
- Multi-event integration tests should stay hermetic. If a handler path can hit RPC, seed the relevant test mock first or route through `test/helpers/indexerTestHarness.ts`, which awaits the local HTTP test RPC bridge before `processEvent`.
- For direct RPC-layer tests that clear in-memory mocks and intentionally fall through to the HTTP bridge, await `expectHttpRpcMockFallback()` from `test/helpers/httpRpc.ts` before the assertion so the test cannot race server startup or fall back to a live endpoint.

### Cross-checks before opening a PR

- Run the queries the dashboard depends on against your local Hasura with a representative pool (one with hundreds of events) to catch silent truncation
- Verify any new entity ID under the same-block-write scenario before merging

## Mento Liquity v2 (CDP) fork — what to know

We index Mento's fork of Liquity v2 (a.k.a. Bold) at https://github.com/mento-protocol/bold. The fork has a few divergences from upstream that materially affect indexing. Glue contracts (`CDPLiquidityStrategy`, `ReserveTroveFactory`) live outside `mento-protocol/bold` — likely in `mento-protocol/mento`.

### Don't trust `ActivePoolBoldDebtUpdated` / `DefaultPoolBoldDebtUpdated`

- The deployed `ActivePool` contracts **never emit** `ActivePoolBoldDebtUpdated`. Verified empirically on Celo: walking the GBPm ActivePool's full log history (`0xa7873F4Bf2A1ea2EB20B1e8A992C4748e78473b2` via Blockscout) returns 399 logs — 394 of them `ActivePoolCollBalanceUpdated`, the rest are one-time constructor events. Zero debt updates. This is upstream behavior (Liquity commit `2a695d42` "eliminate recordedDebtSum (G)"), not Mento-specific.
- `DefaultPoolBoldDebtUpdated` exists in the source and IS wired up to emit, but is dormant on Celo today (no liquidations have caused debt redistribution yet — first redistribution will trigger it).
- **Implication for `LiquityInstance.systemDebt`:** it is maintained by `applySystemDebtDelta` in `src/handlers/liquity/troves.ts` — running sum of open-trove debts (status ∈ {active, zombie}), updated in handlers via captured prev/next snapshots. Do NOT add `systemDebt = activePoolDebt + defaultPoolDebt` anywhere — that would clobber the delta-tracked value the first time DefaultPool fires.

### Delta-tracking pattern for trove handlers

When mutating trove status or debt:

1. Capture `prev = { status: trove.status, debt: trove.debt }` **immediately after** `getOrCreateTrove` — before bracket-debt move, debt overwrite, or any reclassified re-read. Single capture point.
2. Mutate the trove (status transition, debt assignment).
3. At the end of the handler, call `applySystemDebtDelta(instance, prev, { status: trove.status, debt: trove.debt })`. The helper is idempotent on no-op transitions.
4. For loop-based handlers (`BatchUpdated`, `reclassifyTrovesForLoadedParams`), capture prev **per row inside the loop** and apply per row — never aggregate-then-apply.

The two failure modes the pattern guards against are sign errors (open↔not-open flips) and double-applies. The `isOpenStatus` helper (`active` or `zombie`) is the source of truth for "contributes to systemDebt".

### Rebalance redemptions are conflated with user redemptions today

PR #31 in `mento-protocol/bold` adds `CollateralRegistry.redeemCollateralRebalancing` — callable only by the `liquidityStrategy` address, runs through `TroveManager.redeemCollateral`, fires `Redemption` + `TroveOperation(REDEEM_COLLATERAL)` indistinguishable from user redemptions. Discriminator: `event.transaction.to == cdpLiquidityStrategy address` (single shared strategy `0x4e78bd9565341eabe99cdc024acb044d9bdcb985` across all three Celo markets, in `config/liquity.json`).

On-chain reality (2026-05-19): 368 GBPm redemptions, 13 JPYm redemptions, ALL rebalance-driven (sampled tx.to → matches strategy address). If you ship a "redemption volume" KPI without separating these out, it will be 100% noise on production data today.

### Investigating "is this event actually being emitted?"

When an indexer field looks consistently wrong on production data (always 0, never changes, etc.), don't assume our handler is buggy. The deployed contract may simply not emit the event. To check:

```bash
python3 << 'EOF'
import json, urllib.request, collections
addr = "0x<contract>"
counts = collections.Counter()
seen = {}
params = ""
for _ in range(10):
    url = f"https://celo.blockscout.com/api/v2/addresses/{addr}/logs?items_count=50{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    d = json.loads(urllib.request.urlopen(req, timeout=15).read())
    for it in d.get('items', []):
        topic = (it.get('topics') or [None])[0]
        counts[topic] += 1
        seen.setdefault(topic, (it.get('decoded') or {}).get('method_call', '???'))
    n = d.get('next_page_params')
    if not n: break
    params = f"&block_number={n['block_number']}&index={n['index']}"
for t, c in counts.most_common(): print(f'{c:>5}  {seen[t]}')
EOF
```

If your event isn't in the topic histogram, the indexer can't see it no matter how correct the handler is. Switch to delta-tracking from a different signal or read state via `eth_call`.
