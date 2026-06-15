# `0xADDRESS_CASE_PRESERVED` — Display Name (persona/ENS if known)

## TL;DR

One paragraph, plain language. Lead with what they are (`A proprietary multi-DEX arbitrage executor on Celo — an on-chain MEV bot —`), who's behind it (`operated by someone whose original Ethereum identity is...`), where it operates (`scans the Celo DEX landscape...`), and the rough scale (`fires roughly every 8.5 seconds`, `~$95k working capital`). Aim for ~80–120 words.

## Cast of characters

| Role                       | Address     | Confidence | Notes                                                              |
| -------------------------- | ----------- | ---------- | ------------------------------------------------------------------ |
| **Original identity**      | `0x…`       | PROBABLE   | Persona / ENS / opensea handle, age, multichain footprint          |
| **Bridge funder**          | `0x…`       | CONFIRMED  | Wormhole NTT (Mento's bridge) / LayerZero / etc. — name it         |
| **Operator EOA**           | `0x…`       | CONFIRMED  | Deployer of the target contract; age, multichain footprint         |
| **Hot relayer EOA**        | `0x…`       | CONFIRMED  | Single-purpose caller, age, what selector it hits                  |
| **Principal/treasury EOA** | `0x…`       | CONFIRMED  | Where the working capital sits                                     |
| **The target**             | `0xADDRESS` | —          | The investigation target — bytecode size + solc version (if known) |

Roles are descriptive, not fixed. Add or drop rows to match the topology. For an EOA target, "The target" IS the address being investigated; for a contract target add the deployer + relayer + principal rows above. Always include age (days since first activity), multichain footprint, a confidence tier (CONFIRMED / PROBABLE / POSSIBLE — see skill "Confidence tiers"), and a one-line "what it does" note for each.

## Related addresses / fleet

The operator's other contracts/EOAs surfaced by clustering (skill Step 2.5). Each link carries the evidence and a confidence tier — never a bare assertion. Omit this section only if clustering found nothing, and say so in one line rather than dropping the heading.

| Address | Link type                         | Evidence                                            | Confidence |
| ------- | --------------------------------- | --------------------------------------------------- | ---------- |
| `0x…`   | same deployer / codehash / funder | e.g. `keccak(runtime)=0x…` matches; funded by `0x…` | PROBABLE   |

## What it does

For a contract: read public storage directly (most arb / MEV contracts leave trivial getters in). Show the storage dump verbatim, then explain.

```
router()            = …
routerSushi()       = …
routerUniswap()     = …
mentoRouter()       = …
routersCurve(0..N)  = …
tokensAll(0..N)     = …
lastAddress()       = …  (hardcoded principal — note this)
```

Then prose: name the venues, the fee tiers, the hot pools, the patterns. Reference any internal routers / factories whose addresses match canonical deployments (Velodrome Slipstream, Uniswap V3, etc.) — "factory matches `0xafe208a3…` (official UniV3 on Celo)" is much more useful than "looks like Uniswap V3".

For an EOA: behavioural profile. Tx mix, top counterparties, time-of-day distribution if relevant, holdings composition.

## Transaction anatomy

A representative tx (`0x…`, block N):

```
in:  amount  TOKEN  from 0x…  (role)
out: amount  TOKEN  to   0x…  (role)
[atomic multi-hop bounces through routers]
status: ok / sometimes error
```

- Selector `0x…` (custom — not in 4byte/OpenChain — / matched on OpenChain → name it)
- Calldata shape: [N dynamic arrays of (tokens, pools, amounts, swap-data, dexIds, minOuts, deadline)] OR [structured args: …]
- Revert rate: ~N% (normal arb-sniping miss rate / unusual)
- Permissioning: [allowlist / open / signature-gated]

## Capital and scale

Principal wallet `0x…` holdings on chain `<CHAIN_ID>` (the chain you investigated):

- **`<amount>` `<TOKEN>`** (~$`<usd>` notional) — note any token with dual-native semantics (e.g. CELO is both native gas + ERC20)
- $`<usd>` stablecoin (split by stablecoin if it matters: USDC / USDT / DAI / chain-native cUSD-cEUR-etc.)
- `<list any meaningful additional holdings>`
- A handful of scam airdrops noted only to confirm they're noise (helps a future reader understand why the headline number is what it is — filter via DefiLlama price-presence / `confidence`, see skill Step 5.5, not by token name)

Estimated **operating capital ≈ $`<usd>`** (value time-sensitive flows at block time via DefiLlama historical prices — skill Step 5.5 — not current spot). Volume is `<N>` txs / `<D>` days ≈ one fire every `<T>`s. With $`<lo>`–$`<hi>` trade sizes, this is **`<high-frequency small-ticket arb / whale flows / dust-sized testing / etc.>`** activity — not `<the opposite category that would otherwise be a reasonable hypothesis>`.

## Why \_\_\_, why these venues

One paragraph. Don't just say "arbitrage" — name the structural mispricing for THIS chain and THESE venues:

- What's the price discovery mechanism on each venue (oracle-priced AMM, constant-product, concentrated liquidity, RFQ)?
- Which venues drift relative to which, and why (oracle lag, pegged-asset gap, bridge premium, fee-tier asymmetry)?
- What's the design pattern the contract uses, and what does it tell you about the operator (proprietary closed-source, allowlist-gated, signature-gated, MEV-share opt-out, etc.)?

Connect the behaviour to the on-chain economics — don't just describe, explain.

## Coverage and dead ends

One row per source attempted — `HIT` / `EMPTY` / `NOT-COVERED` / `NOT-ATTEMPTED` with a one-line why. The `EMPTY` (covers this chain, found nothing) vs `NOT-COVERED` (can't see this chain) distinction is the whole point — don't collapse them.

| Source                | Result      | Note                                                          |
| --------------------- | ----------- | ------------------------------------------------------------- |
| Arkham (cache / live) | NOT-COVERED | Celo/Monad not indexed; operator EOA on covered chains: `<…>` |
| Mento Envio indexer   | HIT / EMPTY | `<N SwapEvents, isProtocolActor=…>`                           |
| Sim / Dune            | HIT         | `<…>`                                                         |
| Sourcify / Celoscan   | EMPTY       | unverified — decompiled instead                               |
| Sanctions screen      | EMPTY       | not OFAC-listed (Celo oracle + static list)                   |
| `<…>`                 | `<…>`       | `<…>`                                                         |

**Top alternative hypothesis considered** (skill Step 8.5): `<e.g. MM rebalancer rather than arb bot>` — rejected because `<disconfirming evidence>`.

> "Arkham has `<some / no>` data on the target across the chains it covers. Attribution came from `<the curated entity / a high-confidence prediction / the funder graph on chains Arkham does index>`: `<the chain on which the surfacing happened>` showed `<persona / entity>` funded `<operator EOA>`, and `<bridge / direct funder>` funded them on `<upstream chain>`."

## Bottom line

Five bullets, one sentence each. The LITERAL placeholder text is below — replace every value with what you actually found. Do NOT ship the placeholders. The skill's worked-example section (`SKILL.md` → "Worked example") points at the seed report's real bottom line for tone calibration; this template stays placeholder-only so a fresh investigation that copy-pastes blindly doesn't accidentally persist seed facts about a different address.

- **Who**: `<persona / entity, one sentence — who's behind this address>` `[CONFIRMED / PROBABLE / POSSIBLE]`
- **What**: `<contract type / behavioural class, one sentence — what does it do>`
- **Where**: `<chain + venues, one sentence — target chain AND any other EVM chains the operator's key is active on>`
- **How much**: `<capital + op rate, one sentence — working-capital USD, tx volume, time period>`
- **Goal**: `<economic objective, one sentence — what's the strategy capturing>`

---

_Provenance: `<chain>` head block `<N>` (hash `0x…`), RPC `<endpoint>`, cast `<version>`. Sim/DefiLlama queried `<UTC ts>`._

_Investigation date: YYYY-MM-DD._
