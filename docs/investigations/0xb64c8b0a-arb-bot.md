# `0xb64c8b0a3F8008d5028D8F9323b858F17b18C3C4` — Arbitrage Executor (idontloseiwin.eth)

## TL;DR

A proprietary multi-DEX arbitrage executor on Celo — an on-chain MEV bot — operated by someone whose original Ethereum identity is **`idontloseiwin.eth`**. It scans the Celo DEX landscape (Mento, Uniswap V3, Sushi, Ubeswap, a Velodrome-style Slipstream fork, Curve, plus Moola Markets wrappers) and atomically routes trades to capture price differences. It fires a transaction roughly every 8.5 seconds, has executed ~3.4M txs in ~333 days, and is funded with ~$95k of working capital.

## Cast of characters

| Role                       | Address                                      | Notes                                                                                                                          |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Original identity**      | `0x260790b15bBAE85c85987CBB0a533E3c2ce9ca53` | **`idontloseiwin.eth`** (per Arkham). Owns the ENS, OpenSea user, contract deployer on Ethereum. Funded the Celo deployer EOA. |
| **Bridge funder**          | `0x19cFCE47eD54a88614648DC3f19A5980097007dD` | **Stargate Bridge `TokenMessaging`** (per Arkham). Operator bridges gas funds across chains.                                   |
| **Operator EOA (Celo)**    | `0xF1e744bd05C4Ae0Be90C77A6a1772737e4701cc1` | Deployed the arb contract. 2y260d old, $737 across 33 chains, also deploys on Base/Polygon. Multichain trader.                 |
| **Hot relayer EOA**        | `0xBbc43db9463BD5889af9C967de4394a3B3b106B5` | 90 days old, funded by operator. Single purpose: `0x49aa2402` calls into the contract.                                         |
| **Principal/treasury EOA** | `0x8ef15579466aD9440baBa3b8819ce3A29345495c` | Holds the working capital. The contract pulls/pushes funds from here.                                                          |
| **The arb contract**       | `0xb64c8b0a3F8008d5028D8F9323b858F17b18C3C4` | The investigation target. Unverified, ~19.7KB bytecode, solc 0.8.26.                                                           |

## What it does

Reading the contract's public storage directly (it has trivial getters left in):

```
router()            = Ubeswap V2 Router       (factory matches 0x62d5b84b…)
routerSushi()       = SushiSwap V2 Router     (factory 0xc35dadb6… — official Sushi V2)
routerUniswap()     = Uniswap V3 SwapRouter02 (factory 0xafe208a3… — official UniV3 on Celo)
mentoRouter()       = Mento Broker            (0x777a8255…ca72412f0d… — canonical)
routersCurve(0)     = Curve.fi axlUSDC/cUSD Factory Plain Pool
routersCurve(1)     = Curve.fi Tri-Pool
tokensAll(0..3)     = mcUSD, mCEUR, WETH, CELO  (Moola Markets wrappers + native)
lastAddress()       = 0x8ef15579…  (the principal — hardcoded)
```

Plus an internal `SwapRouter` whose factory matches the Velodrome Slipstream / `CLPool` deployer — a 4th DEX leg using concentrated-liquidity pools.

The hot pools it actually trades into are the CELO/USDC pairs at the **0.01% (UniV3)** and **0.02% (CLPool)** fee tiers — extremely tight stable-pair fees, exactly where MEV searchers hunt.

## Transaction anatomy

A representative tx (`0x36e90c…`, block 66261263):

```
in:  50.002 USDC  from 0x8ef15579 (principal)
out: 50.002 USDC  to   0xA1777e08 (Uniswap V3 CELO/USDC 0.01% pool)
[atomic multi-hop bounces through routers]
status: ok / sometimes error
```

- Selector `0x49aa2402` (custom, not in 4byte/OpenChain) with ~3.7KB calldata
- Calldata is a struct of 7 dynamic arrays (tokens, pools, amounts, swap-data, dexIds, minOuts, deadline) — the off-chain searcher computes the optimal route, and the contract is just an atomic executor
- ~40% of internal calls revert — normal arb-sniping miss rate
- 0 CELO value transferred per call (it's all token transfers via the routers)
- Permissioning via `addAllowedCaller` / `removeAllowedCaller` so only their relayer can trigger it

## Capital and scale

Principal wallet `0x8ef15579…` holdings:

- **236,381 CELO** (~$22k native) — actually overlaps with the ERC20 since CELO is dual-natured
- **$87,675 USDC**, **$6,832 USDT**
- Some cUSD, cEUR, WETH dust
- A handful of scam airdrops (CLAIM nodecoin, fake СELO, USDC voucher) — irrelevant noise

Estimated **operating capital ≈ $95–100k**. Volume is ~3.4M txs / 333 days ≈ one fire every 8.5 seconds. With $50–100 trade sizes, this is **high-frequency, small-ticket arb** — not whale flows.

## Why Celo, why these venues

Celo is structurally arbable because Mento is an oracle-priced AMM for cUSD/cEUR/cKES/etc. Whenever the external market price drifts from the Mento oracle, the Broker becomes mispriced vs Uniswap/Sushi/Curve, and a searcher who routes through both can extract the spread. Add:

- Two CELO/USDC pools at 0.01% and 0.02% fees that constantly drift relative to each other
- Moola Markets wrappers (mcUSD, mCEUR) which trade at slight premiums/discounts to the underlying
- axlUSDC↔cUSD on Curve — bridged-vs-Mento dollar arb
- Tri-Pool — three-way stable arb

…and Celo becomes a target-rich environment for a competent searcher. The bot's design (proprietary, unverified, custom selectors, hardcoded principal, allowlist of callers) is a typical "private MEV searcher" setup — keep the strategy private, capture the spread.

## Arkham coverage

Arkham has zero data on the target contract or its hot wallets across all 9 chains it covers (no entity, no label, no tags, no ML predictions). The contract is purely a Celo-native object and Celo isn't supported by Arkham. Attribution had to come from the funder graph on chains Arkham does index, which is how `idontloseiwin.eth` surfaced — they funded the Celo operator from Ethereum/Base, and Stargate funded them on Arbitrum.

## Bottom line

- **Who**: a sophisticated solo searcher / small team operating under the persona `idontloseiwin.eth`.
- **What**: a permissioned, custom on-chain arb executor.
- **Where**: Celo, integrating Mento + Uniswap V3 + Sushi V2 + Ubeswap V2 + Curve + a Velodrome-style Slipstream DEX + Moola.
- **How much**: ~$95k working capital, ~3.4M atomic attempts, ~1 every 8.5s, ~40% revert rate.
- **Goal**: extract MEV/arbitrage profit from price dislocations between Mento's oracle-priced stablepool and the rest of Celo's DEX ecosystem.

---

_Investigation date: 2026-05-07._
