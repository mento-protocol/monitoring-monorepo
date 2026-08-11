---
title: Forensic Report — Chain Bootstrap and Cache Inventory
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Chain bootstrap, provenance, and cache inventory

Deep procedure for Steps 1 and 1.5 of [`SKILL.md`](../SKILL.md). The chain
doctrine and the contract-target identity rule live in `SKILL.md`; this file is
the mechanics.

## Transport branch

Run the tool-catalog preflight in `SKILL.md` before this file. When either
reviewed Upstash tool is unavailable, still run chain initialization and
provenance capture below, then skip production database discovery and all Step
1.5 cache reads. Continue at Step 1.6 without a `DATABASE_ID`; record every
skipped Upstash source as `NOT-ATTEMPTED`, not `EMPTY`. An attended local upload
must rerun the skipped reads before deriving CAS state.

## Step 1 — Bootstrap

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
#   DL_NS    → DefiLlama coin-price slug; may differ from the chain name — verify on DefiLlama
case "$CHAIN" in
  celo)     CHAIN_ID=42220; RPC=https://forno.celo.org;    DUNE_NS=celo;     DL_NS=celo ;;
  monad)    CHAIN_ID=143;   RPC=https://rpc2.monad.xyz;          DUNE_NS=monad;    DL_NS=monad ;;
  polygon)  CHAIN_ID=137;   RPC=https://polygon.drpc.org;        DUNE_NS=polygon;  DL_NS=polygon ;;
  ethereum) CHAIN_ID=1;     RPC=https://ethereum.publicnode.com; DUNE_NS=ethereum; DL_NS=ethereum ;;
  *) echo "Unsupported CHAIN=$CHAIN — add a case arm with its CHAIN_ID / RPC / DUNE_NS / DL_NS." >&2; exit 1 ;;
esac
```

## Provenance capture

Mutable-state reads (storage, balances, prices) are only reproducible if pinned
to a block. Record these and put them in the report's provenance footer:

```bash
HEAD_BLOCK=$(cast block-number --rpc-url $RPC)   # the block reads are "as of"
cast --version                                   # tool version, for the footer
# Note the RPC endpoint, $HEAD_BLOCK, and the UTC timestamp of each Sim/DefiLlama query.
```

Pin the attribution-anchoring storage reads with
`cast call "$ADDR" "<sig>" --block "$HEAD_BLOCK" --rpc-url "$RPC"` (quote the
`<sig>` placeholder so bash doesn't read it as a redirection) so a future reader
gets the same bytes.

## Production database discovery (only after the preflight passes)

Discover the production database with
`mcp__upstash__redis_database_list_databases`: require exactly one database
named `address-labels`, then carry its returned opaque id as `DATABASE_ID`.
Never hardcode or derive that id.

Check whether a report already exists (we may be updating, not creating), and
pull any existing label so the H1 nickname matches the address book:

```js
mcp__upstash__redis_database_run_redis_commands({
  database_id: DATABASE_ID,
  commands: [
    ["HGET", "reports", "<addrLower>"],
    ["HGET", "labels", "<addrLower>"],
  ],
});
```

If a report exists, parse it for `version` and `createdAt` — you'll preserve
them on upload.

## Step 1.5 — Check the Upstash caches first (only after the preflight passes)

Before making any live Arkham calls, check the five existing caches. Prefer a
current cache hit; use the live connector only when it is available and the
result needs refreshing. All five live in the same `address-labels` database
discovered above.

| Hash               | Key            | Contents                                                         |
| ------------------ | -------------- | ---------------------------------------------------------------- |
| `intel_deep`       | `<addrLower>`  | full enrichment: multi-chain `address_enriched` + counterparties |
| `intel_transfers`  | `<addrLower>`  | transfer history (`transfers?base=<addr>&limit=1000`)            |
| `intel_wealth`     | `<addrLower>`  | wealth snapshot: balances + portfolio 0d/30d/90d/180d            |
| `intel_entities`   | `<entitySlug>` | entity profile (`/intelligence/entity/{slug}`)                   |
| `intel_entity_cps` | `<entitySlug>` | entity counterparties (`/counterparties/entity/{slug}`)          |

```js
mcp__upstash__redis_database_run_redis_commands({
  database_id: DATABASE_ID,
  commands: [["HGET", "intel_deep", "<addrLower>"]], // same shape for each hash above
});
```

**If the three address-keyed caches hit:** use the cached data for Steps 2–5 and
skip the live Arkham API calls entirely. If an entry is stale and the live
connector is available, refresh it; otherwise record the cache timestamp and its
limitation.

**Entity cache path:** if `intel_deep` returns an entity slug (`arkhamEntity.id`
or a similar slug field), use it as the key into the two slug-keyed hashes —
they are not address-keyed.

## Reading the payloads

**These caches ARE the cross-chain identity leg**: they're populated from the
target's activity on chains Arkham covers — i.e. NOT Celo/Monad. For a
Celo-native address they're often empty, and that emptiness is itself the
finding ("no Ethereum/L2 footprint Arkham can see"). When they hit, they're the
fastest path to who's behind the address — subject to the contract-target
identity rule in `SKILL.md`: only consume a hit keyed on the target's own
address as identity for an **EOA** target.

Don't treat the payloads as opaque blobs — the typed accessors in
`ui-dashboard/src/lib/` give exact field paths:

- `intel_deep` (`intel-deep.ts`): `enriched[chain].arkhamEntity.id` is the
  **entity slug** — the join key into `intel_entities` / `intel_entity_cps`.
  `candidate.sources` tells you _why_ it was cached
  (`cluster-…-caller` / `top-trader` / `top-bridger` / `tier1-attested`) — a
  free prior classification. `counterparties[chain]` has the top USD
  counterparties per chain.
- Use `intel-legacy-fallback.ts` `hgetWithLegacy` semantics — older entries may
  sit under `arkham_*` legacy keys.
