# `0xADDRESS_CASE_PRESERVED` — Display Name (persona/ENS if known)

## TL;DR

One paragraph, plain language. Lead with what they are (`A proprietary multi-DEX arbitrage executor on Celo — an on-chain MEV bot —`), who's behind it (`operated by someone whose original Ethereum identity is...`), where it operates (`scans the Celo DEX landscape...`), and the rough scale (`fires roughly every 8.5 seconds`, `~$95k working capital`). Aim for ~80–120 words.

## Cast of characters

| Role                       | Address     | Notes                                                              |
| -------------------------- | ----------- | ------------------------------------------------------------------ |
| **Original identity**      | `0x…`       | Persona / ENS / opensea handle, age, multichain footprint          |
| **Bridge funder**          | `0x…`       | Stargate / LayerZero / Hop / Across — name the bridge              |
| **Operator EOA**           | `0x…`       | Deployer of the target contract; age, multichain footprint         |
| **Hot relayer EOA**        | `0x…`       | Single-purpose caller, age, what selector it hits                  |
| **Principal/treasury EOA** | `0x…`       | Where the working capital sits                                     |
| **The target**             | `0xADDRESS` | The investigation target — bytecode size + solc version (if known) |

Roles are descriptive, not fixed. Add or drop rows to match the topology. For an EOA target, "The target" IS the address being investigated; for a contract target add the deployer + relayer + principal rows above. Always include age (days since first activity), multichain footprint, and a one-line "what it does" note for each.

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

Principal wallet `0x…` holdings:

- **N TOKEN** (~$X notional) — actually overlaps with the ERC20 since CELO is dual-natured (note this for CELO specifically)
- $X stablecoin (USDC + USDT split)
- Some cUSD, cEUR, WETH dust
- A handful of scam airdrops (CLAIM nodecoin, fake СELO, USDC voucher) — irrelevant noise

Estimated **operating capital ≈ $X**. Volume is N txs / D days ≈ one fire every Ts. With $X–$Y trade sizes, this is **[high-frequency small-ticket arb / whale flows / dust-sized testing]** activity — not [the opposite category].

## Why \_\_\_, why these venues

One paragraph. Don't just say "arbitrage" — name the structural mispricing. For Celo: the Mento broker is oracle-priced for cUSD/cEUR/cKES/etc., so whenever the external market drifts from the Mento oracle, the Broker becomes mispriced vs Uniswap/Sushi/Curve and a searcher routing through both extracts the spread. List the specific venue combinations (CELO/USDC pools at 0.01% and 0.02% fees, Moola Markets wrappers trading at premiums/discounts, axlUSDC↔cUSD on Curve as bridged-vs-Mento dollar arb, Tri-Pool for three-way stable arb). The bot's design (proprietary, unverified, custom selectors, hardcoded principal, allowlist of callers) is a typical "private MEV searcher" setup — name the design pattern explicitly.

## Arkham coverage

What did Arkham return / not return? Run `address_enriched/all` for cross-chain. If Arkham has zero data on the target — common for Celo-native or Monad-native objects since Arkham doesn't index those chains — say so explicitly. Then walk the funder graph through chains Arkham DOES cover. Name how attribution was actually arrived at:

> "Arkham has zero data on the target contract or its hot wallets across all 9 chains it covers. The contract is purely a Celo-native object and Celo isn't supported by Arkham. Attribution had to come from the funder graph on chains Arkham does index, which is how `idontloseiwin.eth` surfaced — they funded the Celo operator from Ethereum/Base, and Stargate funded them on Arbitrum."

## Bottom line

- **Who**: a sophisticated solo searcher / small team operating under the persona `idontloseiwin.eth`.
- **What**: a permissioned, custom on-chain arb executor.
- **Where**: Celo, integrating Mento + Uniswap V3 + Sushi V2 + Ubeswap V2 + Curve + a Velodrome-style Slipstream DEX + Moola.
- **How much**: ~$95k working capital, ~3.4M atomic attempts, ~1 every 8.5s, ~40% revert rate.
- **Goal**: extract MEV/arbitrage profit from price dislocations between Mento's oracle-priced stablepool and the rest of Celo's DEX ecosystem.

---

_Investigation date: YYYY-MM-DD._
