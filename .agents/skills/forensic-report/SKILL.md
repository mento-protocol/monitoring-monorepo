---
name: forensic-report
description: Use this skill when investigating a specific on-chain address (operator EOA, contract, attacker, MEV bot, suspicious counterparty, etc.) and producing a forensic report for the Mento address book. Triggers on requests like "investigate 0x...", "produce a forensic report on this address", "who is 0x...", "/forensic-report", "/onchain-sleuth", "/detective", or any time you're asked to identify an unknown address that interacts with Mento and the answer needs to land in the address-book report editor. Apply whenever the goal is a long-form attribution + activity write-up that gets stored in the `reports` Upstash hash.
title: Forensic Report Skill
status: active
owner: eng
canonical: true
last_verified: 2026-06-15
---

# Forensic Report

Produce a structured investigation report for an on-chain address and (optionally) push it directly to the production `reports` hash in Upstash so it shows up in the address book without copy-paste.

## When to use this

You're looking at an address that matters to Mento — a counterparty pulling funds out of a Mento pool, an MEV bot whose pattern keeps showing up in swap traces, a deployer of a contract you don't recognise, a wallet flagged in an alert — and you want a durable attribution + activity write-up rather than a 500-char `notes` blurb. The output goes into the address book's Forensic Report tab and feeds the 📄 indicator on the address book index.

If the answer fits in `notes` (≤500 chars, single fact like "Binance hot 14"), use the label form instead.

## Inputs

- **address** (required): `0x…` (40 hex chars). Skill normalises to lowercase.
- **context** (optional, one line): why you started looking — "showed up in the breaker-trip post-mortem", "biggest counterparty on the Mento broker last month", etc. Used in the TL;DR.
- **chain hint** (optional): default Celo since that's where Mento lives. Used for the storage probe + tx-anatomy section. See the chain doctrine below — the _target_ chain is one thing, the operator's _cross-chain footprint_ is another.

## Chains & cross-chain doctrine

Two facts shape every tool choice in this skill:

1. **Mento is multi-chain and growing.** Celo (`42220`) is primary and where most targets live. **Monad (`143`) is live** (secondary). **Polygon and Ethereum are on the roadmap.** Never hardcode `42220`; thread the target chain id through every chain-scoped call.
2. **One key, many chains.** If someone controls a private key on Celo, the same EOA almost always has a history on other EVM chains (Ethereum, Base, Arbitrum, …). That cross-chain footprint is usually where the _identity_ lives — ENS, OpenSea, CEX deposits, prior bots — because the richest attribution tools (Arkham, Nansen, EigenPhi, MetaSleuth) index Ethereum/L2s but **not** Celo.

So split the work into two legs and pick tools per leg:

- **On-chain behaviour leg** (what the address _does_ — swaps, storage, capital, venues): use Celo/Monad-native sources (the Mento Envio indexer, Blockscout, Dune `celo.*`/`monad.*`, GeckoTerminal (Celo; no Monad) / DexScreener, `cast` vs the chain's RPC). These are the only ones that actually see the target chain.
- **Cross-chain identity leg** (who is _behind_ the address): pivot the operator EOA onto the chains the heavyweight attributors cover and let them work there.

**Corollary — never drop a source just because it lacks Celo.** A Celo-blind tool (Nansen, EigenPhi, GoPlus, Across, …) is still the right tool for the identity leg, for Monad, and for Polygon/Ethereum once we deploy there. The **Tooling matrix** near the end of this file records what each source covers and which leg it serves — consult it instead of assuming "no Celo = useless".

## Output

Two artefacts:

1. **Local draft** at `.investigations/<address>-<slug>.md` (slug = first-3 words of derived display name, lowercase, kebab-cased). The `.investigations/` folder is gitignored — never commit drafts.
2. **Optional production upload**: an atomic Lua upsert (`EVAL`) against the `reports` hash in the `address-labels` Upstash database, called via `mcp__upstash__redis_database_run_redis_commands`. The script mirrors the atomic upsert pattern `upsertReport()` in `ui-dashboard/src/lib/address-reports.ts` uses — increments `version`, preserves `createdAt` from any prior record, and stamps `updatedAt` inside a single Redis execution — but is a **simplified, non-CAS variant**: the live route additionally takes an `expectedVersion` base-version precondition and returns an `{ok, report}` envelope, whereas this skill does a fire-and-forget always-wins write and returns the bare encoded payload (exact script in the Lua section below). Atomicity still matters: a split read-modify-write here would let two writers both observe `v=N` and both write `v=N+1`. The skill stamps `source: "claude"` so the editor can distinguish skill-produced from hand-typed reports.

## Output template

The literal shape every report follows lives at `template.md` next to this file. Read it once, then mirror its structure exactly: same named H2 sections in the same order (TL;DR, Cast of characters, Related addresses / fleet, What it does, Transaction anatomy, Capital and scale, Why \_\_\_, why these venues, Coverage and dead ends, Bottom line), same code-fenced storage / tx blocks, the confidence-tier tags on attribution claims, and the provenance + "Investigation date" footer. The template is the spec — don't invent new sections, don't drop existing ones, don't reorder. ("Related addresses / fleet" may be omitted only when clustering in Step 2.5 found nothing — say so in one line rather than dropping the heading silently.)

## Procedure (how to fill the template)

Run these in order. Each step maps onto a section of the template — fill that section as evidence comes in, don't wait until the end.

### Step 1 — Bootstrap

```bash
ADDR=$(echo "0x…" | tr 'A-Z' 'a-z')   # always lowercase the storage key
CHAIN=celo                            # default; override if user said otherwise
DATE=$(date -u +%F)
mkdir -p .investigations

# Derive EVERY chain-scoped knob from $CHAIN in ONE place so they never drift apart —
# a non-Celo investigation must not silently read Celo data. Thread these everywhere:
#   CHAIN_ID → Hasura `chainId` filters + Sim `--chain-ids`
#   RPC      → every `cast` call (head block, storage, codehash, sanctions oracle)
#   DUNE_NS  → value to hand-substitute for the `<chain>.` table prefix in the DuneSQL examples
#              (the dune CLI doesn't shell-interpolate inside a SQL string, so swap it in manually)
#   DL_NS    → DefiLlama coin-price slug (Step 5.5); may differ from the chain name — verify on DefiLlama
case "$CHAIN" in
  celo)     CHAIN_ID=42220; RPC=https://forno.celo.org;    DUNE_NS=celo;     DL_NS=celo ;;
  monad)    CHAIN_ID=143;   RPC=https://rpc2.monad.xyz;    DUNE_NS=monad;    DL_NS=monad ;;     # Monad full node (repo-canonical rpc2.monad.xyz); DefiLlama may not cover monad yet (Step 5.5 caveat)
  polygon)  CHAIN_ID=137;   RPC=https://polygon-rpc.com;   DUNE_NS=polygon;  DL_NS=polygon ;;
  ethereum) CHAIN_ID=1;     RPC=https://eth.llamarpc.com;  DUNE_NS=ethereum; DL_NS=ethereum ;;
  *) echo "Unsupported CHAIN=$CHAIN — add a case arm with its CHAIN_ID / RPC / DUNE_NS / DL_NS." >&2; exit 1 ;;
esac
```

**Capture provenance up front** — mutable-state reads (storage, balances, prices) are only reproducible if pinned to a block. Record these and put them in the report's provenance footer:

```bash
HEAD_BLOCK=$(cast block-number --rpc-url $RPC)   # $RPC from Step 1's case switch; the block reads are "as of"
cast --version                                   # tool version, for the footer
# Note the RPC endpoint, $HEAD_BLOCK, and the UTC timestamp of each Sim/DefiLlama query.
```

For the attribution-anchoring storage reads in Step 3, pin them with `cast call "$ADDR" "<sig>" --block "$HEAD_BLOCK" --rpc-url "$RPC"` (quote the `<sig>` placeholder so bash doesn't read it as a redirection) so a future reader gets the same bytes.

Check whether a report already exists (we may be UPDATING, not creating):

```js
mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [["HGET", "reports", "<addrLower>"]],
});
```

If a report exists, parse it for `version` and `createdAt` — you'll preserve them on upload.

Also pull any existing label so the H1 nickname matches what's in the address book:

```js
commands: [["HGET", "labels", "<addrLower>"]];
```

### Step 1.5 — Check Upstash caches first

Before making any live Arkham API calls, check the five caches populated by the 2026-05 extraction marathon. The API key expires ~2026-05-23; after that, cache is the only option.

```js
// All five caches live in the same address-labels database.
// database_id: c687bf0d-f61f-498e-879a-016de335b4ce

// 1. Full enrichment (multi-chain address_enriched + counterparties)
mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [["HGET", "intel_deep", "<addrLower>"]],
});

// 2. Transfer history (transfers?base=<addr>&limit=1000)
mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [["HGET", "intel_transfers", "<addrLower>"]],
});

// 3. Wealth snapshot (balances + portfolio 0d/30d/90d/180d)
mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [["HGET", "intel_wealth", "<addrLower>"]],
});
```

**If all three hit:** use the cached data for Steps 2–5 and skip the live Arkham API calls entirely.

**If the API key is still valid AND the cached entry is older than ~7 days**, you MAY refresh with a live call; otherwise prefer cache.

**Entity cache path:** if `intel_deep` returns an entity slug (look for `arkhamEntity.id` or a similar slug field in the payload), check the entity-level caches too:

```js
// 4. Entity profile (fetched from /intelligence/entity/{slug})
mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [["HGET", "intel_entities", "<entitySlug>"]],
});

// 5. Entity counterparties (/counterparties/entity/{slug})
mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [["HGET", "intel_entity_cps", "<entitySlug>"]],
});
```

Cache sizes (as of 2026-05-20): `intel_deep` 529 entries, `intel_transfers` 60, `intel_wealth` 80, `intel_entities` 161, `intel_entity_cps` 161.

**These caches ARE the cross-chain identity leg** (see the chain doctrine): they're populated from the target's activity on chains Arkham covers — i.e. NOT Celo/Monad. For a Celo-native address they're often empty, and that emptiness is itself the finding ("no Ethereum/L2 footprint Arkham can see"). When they hit, they're the fastest path to who's behind the address — **but only consume a hit keyed on the target's own address as identity for an EOA target.** For a CONTRACT target, the same 20-byte address on the chains these caches cover is usually an unrelated account, so a target-address cache hit would mis-attribute the report; run the identity leg on the deployer/operator EOA instead (Step 2), unless shared-deployment is proven.

**Don't treat the payloads as opaque blobs** — the typed accessors in `ui-dashboard/src/lib/` give exact field paths:

- `intel_deep` (`intel-deep.ts`): `enriched[chain].arkhamEntity.id` is the **entity slug** — the join key into `intel_entities` / `intel_entity_cps` (those hashes are slug-keyed, not address-keyed). `candidate.sources` tells you _why_ it was cached (`cluster-…-caller` / `top-trader` / `top-bridger` / `tier1-attested`) — a free prior classification. `counterparties[chain]` has the top USD counterparties per chain.
- Use `intel-legacy-fallback.ts` `hgetWithLegacy` semantics — older entries may sit under `arkham_*` legacy keys.

### Step 1.6 — Mento indexer fingerprint (our own Celo/Monad-native source)

**This is the primary on-chain-behaviour source for the target chain** — and it's the one the skill historically ignored. The repo runs its own Envio HyperIndex indexer of Mento protocol events with a **public, unauthenticated** Hasura GraphQL endpoint covering Celo (`42220`) and Monad (`143`). Because Arkham/Nansen are blind on both chains, this is where "what did this address do with Mento" actually gets answered. Query it _before_ the funder graph so you walk into Step 2 already knowing the target's Mento footprint.

```bash
HASURA=https://indexer.hyperindex.xyz/2f3dd15/v1/graphql   # public, no key, POST application/json
# Sanity-check the deployment is serving before trusting any EMPTY result — parallel Envio
# deploys can prune an entry mid-serve, so a 404/empty endpoint is NOT a "no activity" finding:
# (a) Liveness: confirm the endpoint serves at all.
curl -s "$HASURA" -H 'content-type: application/json' \
  --data '{"query":"{ SwapEvent(limit:1){ id } }"}' | jq .
# (b) Chain coverage: probe several core entity types for $CHAIN_ID — a quiet/new chain may have
#     bridge/CDP/supply activity but zero swaps, so DON'T equate 0 SwapEvent rows with NOT-COVERED.
curl -s "$HASURA" -H 'content-type: application/json' \
  --data "{\"query\":\"{ SwapEvent(where:{chainId:{_eq:$CHAIN_ID}},limit:1){id} LiquidityEvent(where:{chainId:{_eq:$CHAIN_ID}},limit:1){id} StableSupplyChangeEvent(where:{chainId:{_eq:$CHAIN_ID}},limit:1){id} }\"}" | jq .
# Mark the indexer NOT-COVERED for $CHAIN only if the FULL Step 1.6 battery (all entity types) is empty
# AND $CHAIN isn't in the indexer's configured chain list; otherwise an empty result is EMPTY (real signal).
```

Run a small battery keyed on the target address (all fields verified against `indexer-envio/schema.graphql`). `caller` = `tx.from` (the signing EOA — the volume-attribution primary key); `sender`/`brokerCaller` = `msg.sender` to the pool/broker (often a router); `txTo` = entry-point contract (identifies the aggregator router). All three are in each row, so you disambiguate EOA-vs-router on the spot.

**Scope every query to the target chain.** Add `chainId: { _eq: <CHAIN_ID> }` to the `where` of each entity that carries it (every swap/rollup/rebalance/LP entity below does; `BridgeTransfer` does not). Without it, a multi-chain address silently merges its Celo and Monad footprints and misreports volume/activity. Drop the filter only when you deliberately want the all-chain Mento footprint.

**Pick the filter field for the target type.** `caller` is `tx.from` — correct for an **EOA target**. For a **contract target** (router / aggregator / rebalancer / the bot contract itself), `tx.from` is the _operator EOA_, not the contract, so a `caller`-only filter returns a false-EMPTY even though the contract is all over the data. Filter on `sender` / `txTo` / `recipient` / `brokerCaller` instead, or `_in` across roles when the address could appear as either. The examples below show `caller`; swap the field to match the target.

```graphql
# Lifetime rollups (fast path — swap volume, cadence, routers, protocol-actor flag)
{
  TraderDailySnapshot(
    where: { trader: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }
    order_by: { timestamp: desc }
    limit: 1000
  ) {
    chainId
    timestamp
    swapCount
    uniquePools
    volumeUsdWei
    feesPaidUsdWei
    aggregatorKeys
    isProtocolActor
  }
}
{
  BrokerTraderDailySnapshot(
    where: { caller: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }
    order_by: { timestamp: desc }
    limit: 1000
  ) {
    chainId
    timestamp
    swapCount
    volumeUsdWei
    aggregatorKeys
    isProtocolActor
  }
} # v2 path, Celo only
# Raw per-swap detail (v3 pools + v2 broker)
{
  SwapEvent(
    where: { caller: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }
    order_by: [{ blockTimestamp: desc }, { id: desc }] # id tiebreaker → deterministic offset pagination
    limit: 1000
  ) {
    txHash
    blockTimestamp
    chainId
    poolId
    caller
    sender
    recipient
    txTo
    amount0In
    amount1In
    amount0Out
    amount1Out
    volumeUsdWei
  }
}
{
  BrokerSwapEvent(
    where: { caller: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> }, routedViaV3Router: { _eq: false } }
    order_by: [{ blockTimestamp: desc }, { id: desc }] # id tiebreaker → deterministic offset pagination
    limit: 1000
  ) {
    txHash
    blockTimestamp
    chainId
    caller
    brokerCaller
    txTo
    tokenIn
    tokenOut
    amountIn
    amountOut
    volumeUsdWei
    exchangeId
  }
}

# Role-specific: MEV keeper? CDP actor? LP? mint/burn? bridger?
{
  RebalanceEvent(where: { caller: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }, order_by: [{ blockTimestamp: desc }, { id: desc }], limit: 1000) {
    txHash
    poolId
    sender
    caller
    notionalUsd
    rewardUsd
    effectivenessRatio
  }
}
{
  Trove(where: { owner: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }) {
    id
    coll
    debt
    status
  }
}
{
  LiquidityPosition(where: { address: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }) {
    poolId
  }
}
{
  StableSupplyChangeEvent(where: { caller: { _eq: "0xtarget" }, chainId: { _eq: <CHAIN_ID> } }, limit: 1000) {
    txHash
    kind
    amount
  }
}
{
  # BridgeBridger is a cross-chain identity aggregate keyed by sender (sourceChainsUsed is a
  # JSON array) — it has NO chainId field, so do not add a chainId filter here.
  BridgeBridger(where: { sender: { _eq: "0xtarget" } }) {
    id
  }
}
{
  # BridgeTransfer carries sourceChainId/destChainId (not chainId). Scope to the target chain via either
  # endpoint AND keep the sender/recipient role predicate; drop the chain clause only for the all-chain view.
  BridgeTransfer(
    where: {
      _and: [
        { _or: [{ sender: { _eq: "0xtarget" } }, { recipient: { _eq: "0xtarget" } }] }
        { _or: [{ sourceChainId: { _eq: <CHAIN_ID> } }, { destChainId: { _eq: <CHAIN_ID> } }] }
      ]
    }
    limit: 1000
  ) {
    sentTxHash
    sender
    recipient
    amount
  }
}
```

Hard constraints (from `docs/pr-checklists/swr-polling-hasura.md`):

- **1000-row cap** per response; **no `_aggregate`** on hosted Hasura. For lifetime totals, page with `offset`/`limit` or narrow with `where`, then **sum client-side**. When paging, `order_by` must end in a unique tiebreaker (`{ id: desc }`) — ordering by `blockTimestamp`/`timestamp` alone is non-deterministic when rows share a block, so plain offset pagination would skip and duplicate rows.
- `volumeUsdWei` is 0 when neither leg is USD-pegged (non-stable FX pairs) — don't read that as "no volume".
- `BrokerSwapEvent` with `routedViaV3Router:true` are v3 siblings already counted in `SwapEvent` — filter them out (`_eq:false`) to avoid double-counting.
- `RebalanceEvent.notionalUsd`/`rewardUsd` use an empty-string sentinel when pre-reserve RPC failed — handle "" distinctly from "0".

A non-empty result here, scoped to the actual target chain, is far stronger than anything the Celo-blind attributors can give — and a verified-live **empty** result is a real signal ("never interacted with Mento v2/v3 on Celo or Monad"), not a tooling gap.

### Step 2 — Cast of characters (multi-chain attribution + funder graph)

**Known-infra check first.** Before walking the funder graph or decompiling anything, match the target and its counterparties against the repo's canonical registries so you never mislabel protocol infrastructure as a suspicious actor (prefer on-chain facts over behavioural guesses):

- `indexer-envio/config/aggregators.json` + shared-config `getAggregatorName(chainId, addr)` → instant match to `mento-router-v2` / `squid` / `lifi` / `0x` / `openocean`, **and** to any named MEV fleet cluster already documented there (those carry a pre-written narrative you can reuse verbatim in Steps 3/6/8).
- shared-config `chainAddressLabels(chainId)` / `tokenSymbol()` (from `@mento-protocol/contracts`) → labels broker / reserve / pools / stables / fee recipients, and gives correct explorer links via `explorerAddressUrl`.
- `indexer-envio/config/oracle-reporters.json` + `protocolActors.json` → flags Chainlink feeds / reporters / listed rebalancers as infra. If the target is a `Pool.rebalancerAddress`, it's an authorised protocol strategy contract, not an independent bot.

Then attribution. Use the `arkham` skill (project-scoped) for the **cross-chain identity leg** — Step 1.5 caches first; live calls only if the key is valid. Remember the doctrine: Arkham/Nansen don't cover Celo or Monad, so the play is:

1. Branch on target type before any cross-chain enrichment:
   - **EOA target** → run `address_enriched/all` on it. Zero hits for a Celo-native EOA is a signal, not a failure.
   - **CONTRACT target** → do **NOT** run `address_enriched/all` on the contract address as an identity source yet. The same 20-byte address on Ethereum/L2 is almost always an unrelated EOA/contract (addresses aren't shared across chains unless deployed deterministically), so an Arkham hit there would record a false identity. Identify the deployer/operator EOA first (item 5 below), then run the identity leg on THAT EOA. Only treat a same-address cross-chain hit as the target if CREATE2/bytecode evidence proves the address is intentionally shared.
2. Walk inbound funders on the target chain. Two pitfalls to handle explicitly:
   - **Sim's Activity API returns NEWEST first**, not oldest. Don't take the top result and call it the FIRST funder — paginate to the tail (or use a `block_time ASC` DuneSQL query) before treating any counterparty as the original funder. A recent counterparty mistaken for the original funder permanently mis-attributes the report.
   - **Sim's `--chain-ids` defaults to all configured chains** when omitted. For an EVM address that's been used on Ethereum / Base / Arbitrum / etc., the "first receive" without a chain filter can come from a totally different chain than the target. Always pass `--chain-ids $CHAIN_ID` so the funder graph is scoped to the chain the contract actually lives on.

   Example — first inbound transfer on Celo, oldest first via DuneSQL (Sim CLI doesn't expose an `--asc` flag at the time of writing):

   ```sql
   SELECT block_time, "from", value, hash
   FROM <chain>.transactions
   WHERE "to" = LOWER('<addr>') AND value > 0   -- value>0 skips zero-value relayer/user calls that aren't funding
   ORDER BY block_time ASC
   LIMIT 5;
   ```

   That funder is usually the operator EOA. **If funding arrived as an ERC20** (e.g. a stablecoin), this
   native-`value` query misses it — run the same oldest-first scan over token transfers (the chain's
   ERC20 `Transfer` logs in Dune, or Sim token transfers) before concluding who the funder is.

3. Run `address_enriched/all` on the operator EOA **across all chains** — this is the cross-chain identity leg, where personas (ENS / OpenSea / prior bots / CEX deposits) surface. The same key is usually active on Ethereum/L2s even when the target contract is Celo-native; that footprint is often the whole attribution.
4. Trace one more hop back: who funded the operator? **Mento's own bridge is Wormhole NTT**, not the generic Ethereum bridges:
   - Check the indexer `BridgeTransfer` / `BridgeBridger` from Step 1.6 first.
   - Confirm/extend via **Wormholescan** (free, no key): `GET https://api.wormholescan.io/api/v1/operations?address=0x…&appId=NATIVE_TOKEN_TRANSFER` — note Wormhole uses its own chain ids (Celo=14, Monad=48), NOT EVM chain ids.
   - Match any counterparty against `indexer-envio/config/nttAddresses.json` (`nttManagerProxy` / `transceiverProxy` / `helper` / `tokenAddress`) so a transfer to/from NTT infra is labelled a bridge flow, not a real funder.
   - For NON-Mento inbound bridges, reach for the right tracer per the Tooling matrix: **LayerZeroScan** covers Celo (`GET https://scan.layerzero-api.com/v1/messages/wallet/{eoa}`, Celo EID=30125); Across/deBridge cover **Monad only** (not Celo) so use them on the Monad leg.
5. For contracts: also pull the deployer (the `from` of the contract-creation tx) — it may differ from the operator. Note both rows in the table. (The deployer is the seed for the fleet clustering in Step 2.5.)
6. **ENS de-anon pivot** (the seed's `idontloseiwin.eth` is exactly this). A Celo address's ENS primary name lives in the **Ethereum L1** reverse registry, not on Celo — forno can't answer it. Resolve via `viem` `getEnsName({ address, coinType })` against an L1 RPC with the **chain-correct ENSIP-11 coinType** `0x80000000 | $CHAIN_ID` (Celo `42220` → `0x8000A4EC`, namespace `a4ec.reverse`; Monad `143` → `0x8000008F`; etc.). Watch out: a common doc example mis-states Celo as `0x8000A4DC`, which decodes to chain 42204 — wrong. Also try the default L1 reverse record (coinType `0`), which many owners set regardless of chain. Mostly negatives for bot EOAs; one hit is gold.

For each address you add to the Cast: include age (days since first activity), multichain footprint (which chains it's been seen on), a one-line "what it does" note, and a **confidence tier** on the attribution claim (see "Confidence tiers" below).

### Step 2.5 — Operator-fleet clustering (find the OTHER bots)

The skill historically walked exactly one hop to the funder and stopped. The highest-confidence attribution signal is **linkage**: what else did this operator deploy, fund, or run identical bytecode for. All three heuristics run on Dune `celo.*` (the existing `dune` skill — no new credential; identical on `monad.*` for Monad) plus `cast`. Feed the results into the "Related addresses / fleet" table.

```sql
-- (1) DEPLOYER FAN-OUT: every contract a deployer created.
--     For CREATE2 the trace "from" is the FACTORY — recurse to the factory's own deployer.
SELECT address, block_time, length(code) AS code_len, tx_hash
FROM <chain>.creation_traces WHERE "from" = <deployer> ORDER BY block_time ASC;

-- (2) COMMON-FUNDER CLUSTERING: every sibling EOA the operator's gas-refill EOA funded.
SELECT "to" AS funded, count(*) n, min(block_time) first_fund
FROM <chain>.transactions WHERE "from" = <funder> AND value > 0 GROUP BY 1 ORDER BY n DESC;
```

```bash
# (3) CODEHASH CLUSTERING: byte-identical bots, even across different deployers/factories.
CODE=$(cast code "$ADDR" --rpc-url "$RPC"); cast keccak "$CODE"   # runtime codehash ($ADDR/$RPC from Step 1, scoped to $CHAIN)
# Pre-filter candidates from creation_traces by length(code), then confirm by keccak match.
```

**Mandatory false-positive gates** — write these into the method, an unverified link is worse than none:

- `value > 0` on funder edges; **never** treat a CEX hot wallet or a public CREATE2 factory as a "funder" — they fan out to thousands and create a garbage super-cluster.
- EIP-1167 minimal-proxy clones share a codehash that differs only by the embedded impl address — cluster on the **impl**, not the clone shell.
- Require a **second independent signal** (codehash + funder, or + activity-clock from Step 3) before asserting a link. Tag each link with a confidence tier.
- **Never auto-merge.** Propose links a human ratifies; the report states the evidence, not a verdict.

### Step 3 — What it does

**For a contract target** — read public storage directly. Most arb / MEV contracts leave trivial getters in (router addresses, allowlists, fee tiers, hardcoded principals). Use the chain's full-node RPC (NOT HyperRPC — `eth_call` requires a full node):

```bash
# Reuse $RPC from Step 1 (already scoped to $CHAIN — full node, NOT HyperRPC, since eth_call needs one).
cast call $ADDR "router()(address)" --block $HEAD_BLOCK --rpc-url $RPC
cast call $ADDR "routerSushi()(address)" --block $HEAD_BLOCK --rpc-url $RPC
cast call $ADDR "lastAddress()(address)" --block $HEAD_BLOCK --rpc-url $RPC
# … etc, try every name a typical arb contract uses. Pin --block $HEAD_BLOCK (from Step 1) so these
# reads stay reproducible and match the provenance footer — without it you capture current state.
```

If the contract is verified (sourcify or Celoscan): pull source, name the patterns. If unverified: look at the top selectors by frequency on Celoscan / explorer; OpenChain-decode any matching ones (`https://openchain.xyz/signatures?function=0x…`).

Before concluding "no interesting getters", do three things:

1. **Proxy check** (zero new dependency). Read the standard slots — a non-zero value means you've been reading an empty shell and must analyse the _implementation_ instead:

   ```bash
   # EIP-1967 impl / admin / beacon, then EIP-1822 (UUPS). For impl/admin/EIP-1822, non-zero → last 20
   # bytes IS the address to analyse. The BEACON slot is different: its last 20 bytes are the BEACON
   # contract, not the impl — call beacon.implementation() and analyse THAT (see below).
   cast storage $ADDR 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $RPC  # impl
   cast storage $ADDR 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103 --rpc-url $RPC  # admin
   cast storage $ADDR 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50 --rpc-url $RPC  # beacon
   cast storage $ADDR 0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7 --rpc-url $RPC  # EIP-1822
   # If the beacon slot was non-zero, resolve the real implementation from the beacon contract:
   BEACON=0x…   # last 20 bytes of the beacon slot value above
   cast call "$BEACON" "implementation()(address)" --rpc-url "$RPC"
   ```

2. **Verified-source check before decompiling** — exact source beats pseudo-source. Sourcify is multichain, free, no key: `GET https://sourcify.dev/server/v2/contract/$CHAIN_ID/{addr}?fields=all` (use `$CHAIN_ID` from Step 1 — `42220` for Celo, `143` Monad, etc.; cross-check the chain's explorer: Celoscan / Monadscan / Polygonscan / Etherscan).
3. **Decompile if unverified** — these are chain-agnostic (they operate on raw bytecode, so Celo non-indexing is irrelevant): Dedaub API (`https://api.dedaub.com`, free tier, async POST→poll) for readable pseudo-Solidity, or local **heimdall-rs** (`heimdall decompile/cfg`, MIT, nothing leaves the machine — use for sensitive targets). Enumerate the full selector surface first with WhatsABI (`@shazow/whatsabi`, autoloads over a forno provider and follows EIP-1967 proxies), then resolve names via the OpenChain DB. This is the only way to describe what a closed-source proprietary bot actually does.

**For an EOA target** — behavioural profile. Top counterparties (`dune sim evm activity` filtered by counterparty), top tokens held (`dune sim evm balances`), tx-time distribution if relevant. Add these cheap, Celo-native behavioural fingerprints (all free via the `dune` skill on `celo.*` or `cast`):

```sql
-- ACTIVITY CLOCK: flat 24h = automated bot; a dead-hours gap = operator's local night.
-- Report as a UTC band, never a country. MUST be an EOA ("from"); a contract returns 0 rows (use <chain>.traces).
SELECT hour(block_time) utc_hour, count(*) FROM <chain>.transactions WHERE "from" = <eoa> GROUP BY 1 ORDER BY 1;

-- NONCE/ORIGIN: sequential nonces start at 0, so a chain-native key has max_nonce = count-1.
--   min_nonce=0 AND max_nonce = count-1 → Celo-native key (no gaps).  max_nonce >> count-1 → key reused on
--   OTHER chains (its first Celo tx is NOT its birth — pivot to Arkham/Sim there; the cross-chain identity lever).
SELECT min(nonce), max(nonce), count(*), min(block_time), max(block_time) FROM <chain>.transactions WHERE "from" = <eoa>;

-- APPROVAL GRAPH: topic1=owner (delegation OUT → routers it trusts), topic2=spender (delegation IN → who can move its funds).
SELECT * FROM <chain>.logs
WHERE topic0 = 0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925   -- Approval
  AND topic1 = <32-byte left-padded owner> LIMIT 100;   -- events are grant HISTORY; for live use eth_call allowance()
```

If the target is a **Gnosis Safe** (cheap codehash/proxy check), pull the real human signers — `cast call "$ADDR" 'getOwners()(address[])' --rpc-url "$RPC"` + `'getThreshold()(uint256)'` (use the in-scope `$ADDR`/`$RPC`, not a bare `<safe>` token) — and link Safes by intersecting owner sets. Free hosted Safe tx-service (keyless reads) is per-chain — `https://api.safe.global/tx-service/<safe-slug>/api/v1/safes/<safe>/`, where `<safe-slug>` is the chain's Safe short-name (celo→`celo`, polygon→`pol`, ethereum→`eth`); not every chain has one (Monad doesn't), so don't copy the `celo` slug for a non-Celo target. This exposes the people behind a treasury/managed-bot the proxy address would otherwise hide.

### Step 4 — Transaction anatomy

Pick a representative tx — preferably a recent successful one with the typical calldata shape. Use `cast tx <hash> --rpc-url $RPC` for the raw shape, then decode the top-level selector via OpenChain.

**For the call tree + asset flow, use Blockscout — not `cast`.** `forno.celo.org` (and most public full nodes) whitelists no trace methods (`debug_traceTransaction` / `trace_transaction` return `-32601 "method not whitelisted"`), so `cast` cannot produce a call tree. The free, no-key Blockscout v2 REST API gives both the decoded nested-call tree and the exact net asset flow — point `BS` at the target chain's Blockscout instance:

```bash
# Pick the Blockscout v2 base for $CHAIN. Not every chain has one (e.g. Monad — see fallback below).
case "$CHAIN" in
  celo)    BS=https://celo.blockscout.com/api/v2 ;;
  polygon) BS=https://polygon.blockscout.com/api/v2 ;;
  *)       BS=""; echo "No Blockscout instance mapped for $CHAIN — use the RPC-native debug_traceTransaction fallback below." >&2 ;;
esac
if [ -n "$BS" ]; then   # skip when no Blockscout for $CHAIN — use the RPC-native fallback below instead
  curl -s "$BS/transactions/$TX/internal-transactions" | jq '.items[] | {type, from:.from.hash, to:.to.hash, value, error}'  # decoded CALL/DELEGATECALL/CREATE tree
  curl -s "$BS/transactions/$TX/state-changes"        | jq '.items[] | {addr:.address.hash, type, change}'                  # per-address coin+token balance_before→after = net flow
fi
```

Reachable via plain `curl`/WebFetch or the bundled `mcp__claude_ai_Blockscout__*` tools (pass `chain_id: $CHAIN_ID`). Expect `internal-transactions` to be empty on simple transfers and rich on multi-hop / reverted txs; `state-changes` gives the dollar-accurate flow `cast` can't. Keep `cast tx` + OpenChain for the top-level selector. **Chains without a Blockscout instance (e.g. Monad):** fall back to RPC-native `debug_traceTransaction` against an archive endpoint that supports it (dRPC / QuickNode / Tenderly) — never `cast run` on Celo (CIP-64, below).

> **Do NOT use `cast run` on Celo.** It chokes on Celo's CIP-64 fee-currency tx type `0x7b` (the _dominant_ tx type since Gingerbread) with `unknown variant 0x7b`, failing on essentially every Mento-active block — and forno is non-archive anyway. For a full trace prefer Blockscout (above) or an RPC-native `debug_traceTransaction` against a Celo archive endpoint that understands CIP-64 (dRPC / QuickNode / Tenderly on `42220`).

**Revert rate — measure, don't assume.** The old "~30–50% reverts is normal for sniping" is Ethereum-PGA reasoning that does **not** transfer to Celo. Since 2025-03 Celo is an OP-Stack L2 with a single sequencer: no public mempool, no Flashbots/PBS bundle market, ordering is sequencer-internal priority-fee. So the revert mechanism is different (priority-fee "first-spammed-first-served" backrunning, not competitive sandwich PGA wars). Compute the actual revert rate for _this_ target from its tx history and interpret it against that model. Monad's ordering differs again (own consensus / FastLane) — don't copy Celo's framing onto Monad.

### Step 5 — Capital and scale

Pass the chain hint through to Sim — Mento is on Celo (`42220`) but the skill also runs against Monad (`143`) and any future chain. Hardcoding `--chain-ids 42220` would return empty / unrelated holdings for a Monad principal:

```bash
# $CHAIN_ID is from Step 1's case switch (Celo 42220 / Monad 143 / …) — do NOT re-hardcode it.
# Hardcoding 42220 would return empty / unrelated holdings for a Monad (or other-chain) principal.
dune sim evm balances $PRINCIPAL --chain-ids $CHAIN_ID -o json | jq '.balance_data | length'
dune sim evm balances $PRINCIPAL --chain-ids $CHAIN_ID -o json | jq '.balance_data[] | {symbol, amount, value_usd}'
```

Sum the USD value, drop scam airdrops. Rather than eyeballing names like `CLAIM` / `voucher`, use DefiLlama as a deterministic noise filter: a token DefiLlama won't price (no entry in the `current` response) or prices with low `confidence` (< ~0.9) has no real DEX liquidity — treat it as noise. Still list it per the template ("confirmed noise"), but keep only DefiLlama-priced, real-confidence holdings in the headline operating-capital number. See Step 5.5. For tx volume, hit the chain's block explorer API (Celoscan, MonadScan, etc.) or use the explorer UI count.

### Step 5.5 — Historical USD valuation (DefiLlama coins API — free, no Pro key)

Sim's `value_usd` is _current spot_. A forensic claim like "moved $2M in March" is wrong if the token has since mooned or rugged — value flows **at the time they happened**. DefiLlama's coin price oracle does this, and it lives on the FREE `coins.llama.fi` host: the DefiLlama **Pro** subscription adds nothing to this skill (its Pro-only endpoints — bridges, token-liquidity-by-slug, treasury, unlocks, active users — are protocol-aggregate data, not address-level), so do **not** gate any of this behind a Pro key.

Key format is `$DL_NS:<lowercaseTokenAddress>`, where `$DL_NS` is the DefiLlama slug set by Step 1's case switch (celo→`celo`, polygon→`polygon`, ethereum→`ethereum`; verify novel chains against DefiLlama — Monad may be absent, see the caveat below). Don't hardcode `celo:` for a non-Celo target — you'd query the wrong chain's namespace and price a different token. Native CELO uses its ERC20 wrapper, e.g. `celo:0x471ece3750da237f93b8e339c536989b8978a438`.

**Historical price at a tx's block time** (Unix seconds — derive from the block: `cast block <n> -f timestamp --rpc-url $RPC`):

```bash
TS=1742000000   # block timestamp, unix seconds
curl -s "https://coins.llama.fi/prices/historical/$TS/$DL_NS:<tokenLower>" | jq '.coins'
# -> { "celo:0x…": { "decimals": 18, "symbol": "…", "price": 0.0629, "confidence": 0.99, "timestamp": … } }
```

USD value of a raw transfer = `(rawAmount / 10^decimals) * price`. Batch tokens in one call by comma-joining keys: `…/historical/$TS/$DL_NS:0xAAA,$DL_NS:0xBBB`. Use this to put a defensible dollar figure on the representative tx in Step 4 and on flow totals.

**Current price** (same response shape) for the Step 5 holdings snapshot: `https://coins.llama.fi/prices/current/$DL_NS:<tokenLower>`. The `confidence` field (0–1) is the scam/illiquidity filter referenced in Step 5: a key that returns nothing, or returns `confidence < ~0.9`, has no real DEX liquidity behind it.

Caveats — surface them in the report when they bite:

- **Newer chains may be absent.** DefiLlama indexes Celo well; Monad and other recent chains may have no coin data. If a key returns nothing, fall back to Sim's spot `value_usd` and say so in the report rather than silently reporting a zero.
- `coins.llama.fi` is not on the default sandbox network allowlist. It's a read-only public GET — allowlist the host or run the single command unsandboxed.

### Step 6 — Why \_\_\_, why these venues

Free-form prose, but be specific. Don't say "arbitrage" — say which mispricing (`Mento broker is oracle-priced, Uniswap V3 is AMM-priced — the spread between them is the alpha`). Don't say "MEV" — say which kind (statistical arb / sandwich / liquidation / JIT).

**Name the venue, don't guess it.** Resolve any non-Mento pool or token the target touched via two free, no-key APIs — turns "an unknown pool" into "USDC/CELO 0.01% on Uniswap V3 Celo, $X TVL". GeckoTerminal covers Celo + many EVM chains but **not Monad** (its `$GT_NS` arm stays empty for Monad — that's correct, skip it); DexScreener is the broader fallback there:

```bash
# GeckoTerminal uses its own network slugs (NOT chain ids) — select per $CHAIN, like $BS in Step 4.
# Verify/extend against https://api.geckoterminal.com/api/v2/networks (a chain may have no GT coverage).
case "$CHAIN" in
  celo)     GT_NS=celo ;;
  polygon)  GT_NS=polygon_pos ;;
  ethereum) GT_NS=eth ;;
  *)        GT_NS=""; echo "No GeckoTerminal slug mapped for $CHAIN — verify at /api/v2/networks, then set GT_NS or skip." >&2 ;;
esac
[ -n "$GT_NS" ] && curl -s "https://api.geckoterminal.com/api/v2/networks/$GT_NS/pools/{poolAddr}"   # → pair, dex, reserve_usd, vol24h (30 req/min); skipped when no GT slug for $CHAIN
curl -s "https://api.dexscreener.com/latest/dex/tokens/{tokenAddr}"               # returns the token's pairs on ALL chains
# MUST filter to the target chain before using, or you may name a different chain's venue/TVL for an
# unrelated same-address token: ... | jq '[.pairs[] | select(.chainId == "<DexScreener slug for $CHAIN: celo/ethereum/polygon/base/…>")]'
```

(Use `networks/$GT_NS/tokens/{addr}` for token price/FDV in Steps 5/5.5 too. Set `GT_NS` to match `$CHAIN` — GeckoTerminal uses its own slugs, so confirm against `/api/v2/networks` rather than assuming the chain name.)

**MEV classification across chains.** The Celo MEV-detection ecosystem is thin (EigenPhi/zeromev are Ethereum-only). Two moves: (a) borrow their **taxonomy** (arb / sandwich / backrun / JIT / liquidation) as vocabulary and derive the classification yourself from the indexer + Dune `dex.trades` on Celo (group by `tx_hash`, detect ≥2-leg cycles, cross-project legs, sandwich via `block_number` ordering); (b) if the operator runs the same strategy on Ethereum/L2s, run it through EigenPhi/zeromev **there** (cross-chain identity leg) and cite the classification as corroboration. See the Tooling matrix.

### Step 7 — Coverage and dead ends

Generalise the old "Arkham coverage" candour into a per-source audit trail — a future reader needs to know not just what you found but what you _looked at_ and why a lead was dead. Render it as a table, one row per source attempted, marked `HIT` / `EMPTY` / `NOT-COVERED` / `NOT-ATTEMPTED` with a one-line why:

| Source               | Result      | Note                                                        |
| -------------------- | ----------- | ----------------------------------------------------------- |
| Arkham (cache/live)  | NOT-COVERED | Celo not indexed; operator EOA also clean on covered chains |
| Mento Envio indexer  | HIT         | 4.2k SwapEvents, isProtocolActor=false                      |
| Sim / Dune           | HIT         | …                                                           |
| Sourcify / Celoscan  | EMPTY       | unverified — decompiled instead                             |
| Sanctions (Step 7.5) | EMPTY       | not OFAC-listed on Celo oracle or static list               |
| …                    | …           | …                                                           |

The distinction between `EMPTY` (source covers this chain, found nothing) and `NOT-COVERED` (source can't see this chain) is the whole point — don't collapse them into "nothing found".

### Step 7.5 — Sanctions & risk screening

A forensic product should screen every target. Primary, zero new dependency — the Chainalysis OFAC oracle is live on Celo and reuses the `cast`/forno tooling already in Steps 3/4:

```bash
# The Chainalysis oracle lives at this address on Celo (and several other EVM chains) but is NOT
# guaranteed everywhere (e.g. Monad). Only call it where it's deployed on $CHAIN; elsewhere rely on the
# chain-agnostic TRM + static-OFAC paths below. Run on the target AND each Step-2 funder/counterparty.
if [ "$CHAIN" = celo ]; then   # extend once you've verified the oracle is deployed on another target chain
  cast call 0x40C57923924B5c5c5455c48D93317139ADDaC8fb 'isSanctioned(address)(bool)' "$ADDR" --rpc-url "$RPC"
  # repeat for each Step-2 funder/counterparty, e.g.: for a in "$ADDR" "${FUNDERS[@]}"; do cast call 0x40C5…c8fb 'isSanctioned(address)(bool)' "$a" --rpc-url "$RPC"; done
fi
```

Caveat to write into the report: the **per-chain Celo oracle's SDN set is not identical to Ethereum's** — a `false` on Celo is not an authoritative global negative. For a definitive verdict also hit the chain-agnostic free path (works for any `0x` address regardless of chain): TRM's keyless `POST https://api.trmlabs.com/public/v1/sanctions/screening` `[{"address":"0x…"}]`, or set-membership against the static OFAC list at `raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses`. For scam/phishing (not sanctions), cross-check counterparties against the Scam Sniffer blacklist and — on chains it covers (Monad `143`, not Celo) — GoPlus; see the Tooling matrix for coverage. Most Mento targets return clean; the value is the rare hit and a citable verified negative for the audit trail.

### Step 8 — Bottom line

Five bullets, one sentence each: Who / What / Where / How much / Goal. This is the section a Slack reader will copy-paste, so it has to stand alone without the rest of the report.

### Step 8.5 — Adversarial verification gate (before save/upload)

Invert your own confirmation bias right where this skill's own docs flag the most common error. Lightweight but mandatory — leave a one-line trace in the report ("Top alternative considered: …, rejected because …"):

- **State the top alternative hypothesis** and hunt disconfirming evidence (arb bot vs MM rebalancer vs exchange sweep vs protocol keeper). Does your evidence _entail_ the headline, or merely fail to contradict it?
- **Re-confirm the original funder** is genuinely the oldest inbound (Sim returns newest-first — the classic mis-attribution), and that `--chain-ids` was scoped to the target chain on every funder query.
- **Re-confirm each fleet link** in Step 2.5 has its required second signal.
- Downgrade any claim that can't survive this to a lower confidence tier, or cut it.

### Step 9 — Save the draft

Write the finished markdown to `.investigations/<addr>-<slug>.md`. Slug = first 3 words of the H1 display name, lowercased, kebab-cased. Example: H1 `Arbitrage Executor (idontloseiwin.eth)` → slug `arbitrage-executor`.

End the report with a **provenance footer** so mutable-state reads are reproducible (this lives in the markdown body — the report JSON has no field for it, and the API silently drops unknown keys):

```
_Provenance: <chain> head block <N> (hash <0x…>), RPC <endpoint>, cast <version>. Sim/DefiLlama queried <UTC ts>. Investigation date: YYYY-MM-DD._
```

### Step 10 — Push to production (only on user confirmation)

By default the skill stops at the local draft and asks the user to review. On `--upload` (or after the user explicitly says "ship it"), upload to Upstash via the same atomic Lua upsert pattern the API route uses (the simplified non-CAS variant — see the Output section) — never split-read-modify-write, which races the editor and any other skill invocation.

Keep `mcp__upstash__redis_database_run_redis_commands` out of repo-shared auto-allow lists. The MCP approval prompt is the production write guard for this path.

**Derive the uploader's email at runtime, not from a hardcoded value.** The skill is committed and runs from any teammate's checkout; hardcoding one email would mis-attribute every other person's reports and leak PII into git. Pull from `git config user.email`:

```bash
AUTHOR_EMAIL=$(git config --get user.email)
if [ -z "$AUTHOR_EMAIL" ]; then
  echo "git config user.email is unset — set it before uploading" >&2
  exit 1
fi
```

`git config user.email` is local + unauthenticated — a teammate with a stale or impersonated config could persist wrong audit metadata. The dashboard's editor route stamps `authorEmail` from the Google-Workspace-authenticated session for that reason; the skill bypasses the route to keep atomicity (see Lua section below) and so loses the session-auth check. Mitigation: **always show the derived email and ask the user to confirm it matches their workspace identity before sending the EVAL**. If the email is wrong, abort and tell them to fix `git config user.email` (or upload via the editor UI). For a stricter audit trail, route the upload through the editor instead.

**Validate inputs before building the payload.** The skill bypasses the API route, so it also bypasses `sanitizeReportInput` and `isValidAddress` — mirror their checks here or risk persisting a blank report or a Redis key that isn't an `0x` address (ENS, typo, truncation):

```js
// 1. Address — must match isValidAddress (`/^0x[a-fA-F0-9]{40}$/`)
const addrLower = String(addrInput).toLowerCase();
if (!/^0x[a-f0-9]{40}$/.test(addrLower)) {
  throw new Error("address must be a 0x-prefixed 40-hex string");
}

// 2. Body — non-empty after trim, ≤ 50KB. Mirrors `sanitizeReportInput`
//    in `ui-dashboard/src/lib/address-reports-shared.ts`.
const body = readFile(".investigations/<addr>-<slug>.md");
if (body.trim() === "")
  throw new Error("body is empty / whitespace-only — refusing to upload");
if (body.length > 50000) throw new Error("body exceeds 50KB cap");
```

**Build the partial payload** (Lua script stamps `createdAt` / `updatedAt` / `version`):

```js
const title = extractTitleFromH1(body); // text after the ` — ` separator, ≤200 chars
const partial = {
  body,
  ...(title ? { title: title.slice(0, 200) } : {}),
  authorEmail: AUTHOR_EMAIL, // from git config user.email at runtime
  source: "claude", // already in the AddressReport enum
};
```

**Write it via Lua EVAL** (atomic — the same upsert pattern as `upsertReport()` in `ui-dashboard/src/lib/address-reports.ts`, minus the optimistic-concurrency `expectedVersion` check; this skill always wins and returns the bare encoded payload):

```js
const UPSERT_SCRIPT = `
local key = KEYS[1]
local addr = ARGV[1]
local payload = cjson.decode(ARGV[2])
local now = ARGV[3]

local existing = redis.call('HGET', key, addr)
local prior = nil
if existing then
  prior = cjson.decode(existing)
end

payload.createdAt = (prior and prior.createdAt) or now
payload.updatedAt = now
-- Mirror upsertReport()'s read-side version normalization. A true first write
-- (no prior record) is version 1. cjson.decode maps JSON null to cjson.null
-- (truthy in Lua), so a legacy/partial {"version": null} must be normalized,
-- not propagated into arithmetic (which would crash the EVAL). Such records
-- read as version 1 in JS, so normalize missing/invalid/<=0 to 1 here too —
-- coercing to 0 would write version 1 over an existing record and regress the
-- version the editor's optimistic-concurrency (CAS) path expects.
local priorVersion = 0
if prior then
  priorVersion = prior.version
  if type(priorVersion) ~= 'number' or priorVersion <= 0 then
    priorVersion = 1
  else
    priorVersion = math.floor(priorVersion)
  end
end
payload.version = priorVersion + 1

local encoded = cjson.encode(payload)
redis.call('HSET', key, addr, encoded)
return encoded
`;

mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [
    [
      "EVAL",
      UPSERT_SCRIPT,
      "1",
      "reports",
      addrLower,
      JSON.stringify(partial),
      new Date().toISOString(),
    ],
  ],
});
```

The script returns the persisted record (already JSON-encoded). It handles every edge case the dashboard data layer handles:

- `createdAt` preserved when updating; stamped fresh on first write
- `updatedAt` always = now
- `version` — first write (no prior) is `1`; updates increment. A legacy/partial prior whose `version` is missing/non-numeric/≤0 normalizes to `1` (matching `upsertReport()`'s read-side normalization), so the next write is `2` — never regressing the version the editor's CAS path expects, and never crashing on `cjson.null`
- Atomic per write and version stays monotonic — **but it is last-writer-wins on the body** (this variant has no `expectedVersion` precondition), so an editor save made between this skill's Step-1 read and the EVAL is silently overwritten. The editor's own CAS path will reject ITS now-stale save, but this skill never loses the race. If a hand-edited report might be in flight, re-read immediately before upload, or upload via the editor route instead.

**Verify:**

```js
mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [["HGET", "reports", addrLower]],
});
```

The address-book index endpoint reads from the same hash on every request, so the 📄 indicator + the report editor will pick up the new content on the next page load — no SWR mutate hook needed from this side.

## Confidence tiers

Replace the old binary "skip if weak" with a per-claim grade on **load-bearing attribution claims only** (Cast of characters rows, fleet links, Bottom line) — not every sentence. This lets the report keep a useful "likely but unproven" lead instead of discarding it, as long as it's labelled honestly:

- **CONFIRMED** — a deterministic on-chain fact (creation-tx `from`, a storage read, a codehash match, a decoded selector) or external ground truth (an ENS reverse record). No hedging words.
- **PROBABLE** — a funder-graph or behavioural inference corroborated by **≥2 independent signals** (e.g. codehash + common-funder, or activity-clock + nonce-origin).
- **POSSIBLE** — a single uncorroborated heuristic. Allowed in the report, but must carry the tag so a reader never mistakes it for fact.

Tag inline, e.g. **Operator EOA** `0x…` **[PROBABLE: codehash + funder]**. A claim that can't reach POSSIBLE doesn't belong in the report at all.

## Schema invariants (mirror these — the API enforces the same rules)

- `body`: required, non-empty, ≤ 50,000 characters (50KB)
- `title`: optional, ≤ 200 characters, dropped if empty after trim
- `source`: always set `"claude"` from this skill; the API also accepts other provenance values
- `version`: starts at 1, increments on each write; preserve `createdAt` from the prior write if updating

These match `MAX_BODY_LENGTH` / `MAX_TITLE_LENGTH` in `ui-dashboard/src/lib/address-reports-shared.ts`. If those constants change, mirror the changes here — the skill must not write a payload the API would reject on a manual edit.

## Tooling matrix (by chain + leg)

Pick the tool that covers the chain you're on and the leg you're working. **A blank in the Celo column does not mean "useless"** — it means use that source on the cross-chain identity leg (operator EOA on Ethereum/L2s), on Monad, or on Polygon/Ethereum once Mento deploys there. Coverage notes below were web-verified 2026-06-15; re-check before relying on a negative.

**On-chain behaviour leg — Celo/Monad-native (free, the workhorses):**

| Source                       | Celo              | Monad | Access            | Answers                                                                        |
| ---------------------------- | ----------------- | ----- | ----------------- | ------------------------------------------------------------------------------ |
| Mento Envio indexer          | ✅                | ✅    | free, no key      | per-address Mento swaps/rebalances/LP/CDP/bridge (Step 1.6)                    |
| Blockscout v2 REST/MCP       | ✅                | —     | free, no key      | call tree + state-changes + tx/address data (Step 4)                           |
| Dune `celo.*`/`monad.*`      | ✅                | ✅    | existing Dune key | funder graph, fleet clustering, fingerprints, `dex.trades`                     |
| Sim (Dune Sim)               | ✅                | ✅    | existing key      | real-time balances/activity                                                    |
| GeckoTerminal                | ✅                | ❌    | free, no key      | pool/token → dex, pair, TVL, volume (Step 6); no Monad — use DexScreener there |
| DexScreener                  | ✅                | ✅    | free, no key      | token → all pairs, liquidity, volume                                           |
| DefiLlama coins              | ✅                | ⚠️    | free, no key      | historical + current USD price (Step 5.5)                                      |
| Sourcify                     | ✅                | ✅    | free, no key      | verified source (Step 3)                                                       |
| `cast` vs forno              | ✅                | n/a   | free              | storage/getter reads, codehash — **no trace methods**                          |
| Dedaub / heimdall / WhatsABI | bytecode-agnostic |       | free / OSS        | decompile unverified contracts (Step 3)                                        |

**Cross-chain identity leg — Celo-blind but valuable on the operator's other-chain footprint:**

| Source              | Celo | Where it works        | Access                     | Use                                               |
| ------------------- | ---- | --------------------- | -------------------------- | ------------------------------------------------- |
| Arkham (cache)      | ❌   | ETH + most L2s        | cache / live (key expired) | entity/persona of operator EOA                    |
| Nansen              | ❌   | ETH/L2s; Monad labels | paid ($49+/mo)             | labels/Smart-Money on the identity leg + Monad    |
| EigenPhi / zeromev  | ❌   | ETH (+BSC)            | free/paid                  | MEV classification of operator's ETH strategy     |
| MetaSleuth/BlockSec | ✅\* | many chains           | paid ($599/mo)             | labels incl. Celo — only if free paths fall short |
| The Graph subgraphs | ⚠️   | per-subgraph          | paid + free tier           | non-Mento DEX history (Envio covers Mento first)  |

**Bridge leg:**

| Source            | Celo | Monad | Access       | Use                                      |
| ----------------- | ---- | ----- | ------------ | ---------------------------------------- |
| Mento NTT cfg     | ✅   | ✅    | repo file    | classify NTT infra (`nttAddresses.json`) |
| Wormholescan      | ✅   | ✅    | free, no key | Mento's own bridge (NTT) by address      |
| LayerZeroScan     | ✅   | —     | free, no key | LZ/OFT funding paths by address          |
| Across / deBridge | ❌   | ✅    | free API     | bridge funder on the **Monad** leg only  |

**Risk / sanctions leg:**

| Source             | Celo | Access            | Use                                           |
| ------------------ | ---- | ----------------- | --------------------------------------------- |
| Chainalysis oracle | ✅   | free `cast call`  | OFAC screen (per-chain SDN set; Step 7.5)     |
| TRM screening      | any  | free, keyless     | chain-agnostic sanctions verdict              |
| OFAC static list   | any  | free GitHub fetch | offline 0x-membership backstop                |
| GoPlus             | ❌   | free (Monad 143)  | token/address risk on Monad+                  |
| Scam Sniffer list  | ❌†  | free GitHub fetch | EVM-wide drainer flag (a hit ≠ Celo activity) |

\* MetaSleuth/Tenderly/Phalcon/GoldRush etc. genuinely cover Celo but add a new paid/keyed dependency that overlaps the free workhorses — deferred, revisit per-target only if a free path proves inadequate.
† Scam Sniffer's data is ~85% Ethereum; a hit is a global drainer flag, not proof of Celo activity. Frame honestly.

## Reference: production database

The database id is non-secret. If the address-book database is replaced or
split, update this value from Terraform or the Upstash console before writing.

```
database_id: c687bf0d-f61f-498e-879a-016de335b4ce
hash:        reports
key shape:   <lowercase 0x address>
value shape: JSON-stringified AddressReport (see schema above)
```

The `address-labels` Upstash database also holds the `labels` hash (custom address labels) and `minipay:*` keys (the MiniPay tagging cron's bookkeeping). Don't touch those from this skill.

## Worked example

The seed report — `0xb64c8b0a3F8008d5028D8F9323b858F17b18C3C4` (Arbitrage Executor / `idontloseiwin.eth`) — is the canonical reference. If a section feels under-specified above, look at how that section is written in the production hash:

```js
mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [["HGET", "reports", "0xb64c8b0a3f8008d5028d8f9323b858f17b18c3c4"]],
});
```

Match its tone (specific, evidence-anchored, code-fenced for storage / tx data), structure (the nine named sections in order), and length (1500–2500 words for a meaty target; less is fine for a thin one).

## Rules

- **Never commit a draft.** `.investigations/` is gitignored for a reason. If a report belongs in the team's history, it lives in the production `reports` hash + the daily Vercel Blob backup, NOT in git.
- **Never write a label or the `labels` hash from this skill.** Labels are a separate concern; the `arkham` skill or the address-book modal handles those.
- **Never push to prod without explicit user confirmation.** Local draft is the default; upload only on `--upload` or after the user says "ship it" / "upload it" / equivalent.
- **Mirror the schema invariants.** Don't write a payload the API would reject — that includes the body length cap, title length cap, version monotonicity, and `createdAt` preservation on update.
- **Cite evidence.** Every claim about an address gets a tx hash, an Arkham response, a Sim balance snapshot, an indexer row, or a storage read backing it. "Probably MEV" is not enough; "selector `0x49aa2402` calls into a contract whose public `routerUniswap()` returns Uniswap V3 SwapRouter02 (factory `0xafe208a3…` matches official UniV3 on Celo)" is.
- **Grade, don't hedge.** Tag load-bearing attribution claims with a confidence tier (CONFIRMED / PROBABLE / POSSIBLE) instead of weasel words. A claim that can't reach POSSIBLE doesn't ship; if the whole attribution is sub-POSSIBLE, write a label + notes blurb instead of a durable report. Run the Step 8.5 adversarial gate before saving.
- **Think multi-chain; never disable a source just because it lacks Celo.** The target chain (Celo today; Monad live; Polygon/Ethereum soon) drives the behaviour leg; the operator's cross-chain footprint drives the identity leg. A Celo-blind tool is the right tool for the identity leg / Monad / future chains — consult the Tooling matrix instead of dropping it. Thread the target chain id through every chain-scoped call; never hardcode `42220`.
