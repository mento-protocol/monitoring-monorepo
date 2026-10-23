---
title: Forensic Report — Tooling Matrix by Chain and Leg
status: active
owner: eng
canonical: true
last_verified: 2026-10-22
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Tooling matrix (by investigation leg)

Routing reference for [`SKILL.md`](../SKILL.md). Provider coverage, plans,
credentials, and session tools change. This matrix selects candidates; it does
not certify that a provider covers a chain or is available in this session.
Before relying on a result, verify the requested chain, endpoint, tool catalog,
and access terms. A transport failure is never an empty on-chain result.

## Repository-owned sources

| Leg                   | Source                   | Contract to verify                                                                                                                                                                             |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mento activity        | Envio Hasura             | Use `references/indexer-queries.md`; compare entities with `indexer-envio/schema.graphql`, chains with `indexer-envio/config.multichain.mainnet.yaml`, then probe liveness and chain coverage. |
| Chain state           | Full-node RPC and `cast` | Defaults are in `indexer-envio/src/rpc/client.ts`; require the RPC chain ID to match before pinned state reads. HyperSync is not an `eth_call` replacement.                                    |
| Cached identity       | Upstash intel hashes     | `references/chain-setup.md` and `ui-dashboard/src/lib/intel-*.ts` own keys, payloads, and legacy fallback. The skill's tool-catalog preflight decides whether reads are attempted.             |
| Bridge classification | NTT registry             | Match chain-scoped entries in `indexer-envio/config/nttAddresses.json` before treating bridge infrastructure as a funder.                                                                      |

## External candidates

| Leg                  | Candidates                                               | Before interpreting a result                                                                                                                                  |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activity and funding | Blockscout, Dune, Sim                                    | Verify chain/table coverage and pagination. Use the target chain for history; distinguish signer EOAs from contracts.                                         |
| Liquidity            | GeckoTerminal, DexScreener                               | Verify chain identifiers, pool addresses, and timestamp. A missing listing does not establish no liquidity.                                                   |
| USD valuation        | DefiLlama coins                                          | Follow `references/pricing.md`; verify coin namespace and price coverage, and use historical prices for historical flows.                                     |
| Contract source      | Sourcify, chain explorer                                 | Match chain and address; exact verified source precedes decompilation. See `references/contract-analysis.md`.                                                 |
| Bytecode             | heimdall-rs, WhatsABI, Dedaub                            | Confirm installed tool/API and access terms. Corroborate decompiler hypotheses with traces and pinned reads.                                                  |
| Cross-chain identity | Arkham, Nansen, MetaSleuth/BlockSec                      | Verify current chain coverage and access. For contract targets, enrich the evidenced operator EOA, not an unrelated same-address deployment on another chain. |
| MEV context          | EigenPhi, zeromev                                        | Check the chain and period covered; an Ethereum classification is not proof of Celo or Monad activity.                                                        |
| Other DEX history    | The Graph                                                | Verify the specific subgraph's chain, deployment, sync head, and query limits.                                                                                |
| Bridge history       | Wormholescan, LayerZeroScan, Across, deBridge            | Verify source/destination coverage and the provider's own chain IDs; never substitute EVM chain IDs blindly.                                                  |
| Risk and sanctions   | Chainalysis oracle, TRM, OFAC list, GoPlus, Scam Sniffer | Follow Step 7.5 of `SKILL.md`. Verify chain/oracle deployment or list freshness; a global flag does not prove activity on the target chain.                   |

## Record coverage honestly

Use the template's `HIT`, `EMPTY`, `NOT-COVERED`, and `NOT-ATTEMPTED` states.
`EMPTY` requires a working source that covers the requested chain and query.
A cache hit records its timestamp and provenance; it does not certify current
provider coverage. Do not buy access merely because a candidate appears here.
