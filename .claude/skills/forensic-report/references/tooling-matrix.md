---
title: Forensic Report — Tooling Matrix by Chain and Leg
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Tooling matrix (by chain + leg)

Coverage reference for [`SKILL.md`](../SKILL.md). Pick the tool that covers the
chain and the investigation leg. **A blank in the Celo column does not mean
"useless"** — it may still serve the cross-chain identity leg. Provider coverage
changes; re-check before relying on a negative.

## On-chain behaviour leg — Celo/Monad/Polygon-native (free, the workhorses)

| Source                       | Celo              | Monad | Access            | Answers                                                     |
| ---------------------------- | ----------------- | ----- | ----------------- | ----------------------------------------------------------- |
| Mento Envio indexer          | ✅                | ✅    | free, no key      | per-address Mento swaps/rebalances/LP/CDP/bridge (Step 1.6) |
| Blockscout v2 REST/MCP       | ✅                | —     | free, no key      | flat internal calls + raw state changes (Step 4)            |
| Dune `celo.*`/`monad.*`      | ✅                | ✅    | existing Dune key | funder graph, fleet clustering, fingerprints, `dex.trades`  |
| Sim (Dune Sim)               | ✅                | ✅    | existing key      | real-time balances/activity                                 |
| GeckoTerminal                | ✅                | ✅    | free, no key      | pool/token → dex, pair, TVL, volume (Step 6)                |
| DexScreener                  | ✅                | ✅    | free, no key      | token → all pairs, liquidity, volume                        |
| DefiLlama coins              | ✅                | ✅    | free, no key      | historical + current USD price when the token is covered    |
| Sourcify                     | ✅                | ✅    | free, no key      | verified source (Step 3)                                    |
| `cast` vs forno              | ✅                | n/a   | free              | storage/getter reads, codehash — **no trace methods**       |
| Dedaub / heimdall / WhatsABI | bytecode-agnostic |       | free / OSS        | decompile unverified contracts (Step 3)                     |

## Cross-chain identity leg — Celo-blind but valuable on the operator's other-chain footprint

| Source              | Celo | Where it works        | Access                      | Use                                               |
| ------------------- | ---- | --------------------- | --------------------------- | ------------------------------------------------- |
| Arkham (cache)      | ❌   | ETH + most L2s        | cache / live when available | entity/persona of operator EOA                    |
| Nansen              | ❌   | ETH/L2s; Monad labels | paid ($49+/mo)              | labels/Smart-Money on the identity leg + Monad    |
| EigenPhi / zeromev  | ❌   | ETH (+BSC)            | free/paid                   | MEV classification of operator's ETH strategy     |
| MetaSleuth/BlockSec | ✅   | many chains           | paid ($599/mo)              | labels incl. Celo — only if free paths fall short |
| The Graph subgraphs | ⚠️   | per-subgraph          | paid + free tier            | non-Mento DEX history (Envio covers Mento first)  |

## Bridge leg

| Source            | Celo | Monad | Access       | Use                                      |
| ----------------- | ---- | ----- | ------------ | ---------------------------------------- |
| Mento NTT cfg     | ✅   | ✅    | repo file    | classify NTT infra (`nttAddresses.json`) |
| Wormholescan      | ✅   | ✅    | free, no key | Mento's own bridge (NTT) by address      |
| LayerZeroScan     | ✅   | —     | free, no key | LZ/OFT funding paths by address          |
| Across / deBridge | ❌   | ✅    | free API     | bridge funder on the **Monad** leg only  |

## Risk / sanctions leg

| Source             | Celo | Access            | Use                                           |
| ------------------ | ---- | ----------------- | --------------------------------------------- |
| Chainalysis oracle | ✅   | free `cast call`  | OFAC screen (per-chain SDN set; Step 7.5)     |
| TRM screening      | any  | free, keyless     | chain-agnostic sanctions verdict              |
| OFAC static list   | any  | free GitHub fetch | offline 0x-membership backstop                |
| GoPlus             | ❌   | free (Monad 143)  | token/address risk on Monad+                  |
| Scam Sniffer list  | ❌†  | free GitHub fetch | EVM-wide drainer flag (a hit ≠ Celo activity) |

† Scam Sniffer's data is ~85% Ethereum; a hit is a global drainer flag, not
proof of Celo activity. Frame honestly.
