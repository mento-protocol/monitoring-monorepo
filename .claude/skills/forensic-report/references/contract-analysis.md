---
title: Forensic Report — Contract and EOA Analysis
status: active
owner: eng
canonical: true
last_verified: 2026-10-22
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Contract and EOA analysis

Deep procedure for Step 3 of [`SKILL.md`](../SKILL.md): storage reads, proxy
resolution, decompilation, behavioural fingerprints, and Safe ownership.

## Contract target — read public storage

Most arb / MEV contracts leave trivial getters in (router addresses,
allowlists, fee tiers, hardcoded principals). Use the chain's full-node RPC —
**not** HyperRPC, since `eth_call` requires a full node. `$ADDR`, `$RPC`, and
`$HEAD_BLOCK` come from Step 1 (see `chain-setup.md`).

```bash
cast call $ADDR "router()(address)" --block $HEAD_BLOCK --rpc-url $RPC
cast call $ADDR "routerSushi()(address)" --block $HEAD_BLOCK --rpc-url $RPC
cast call $ADDR "lastAddress()(address)" --block $HEAD_BLOCK --rpc-url $RPC
# … etc, try every name a typical arb contract uses. Pin --block $HEAD_BLOCK so these
# reads stay reproducible and match the provenance footer — without it you capture current state.
```

If the contract is verified (Sourcify or the chain explorer): pull source, name
the patterns. If unverified: look at the top selectors by frequency on the
explorer and OpenChain-decode any matching ones
(`https://openchain.xyz/signatures?function=0x…`).

Before concluding "no interesting getters", do three things.

### 1. Proxy check (zero new dependency)

Read the standard slots from [ERC-1967](https://eips.ethereum.org/EIPS/eip-1967)
and [ERC-1822](https://eips.ethereum.org/EIPS/eip-1822). Resolve the logic address
before analysing implementation code; keep state reads on the proxy address:

```bash
# EIP-1967 impl / admin / beacon, then the original EIP-1822 PROXIABLE slot.
# impl/PROXIABLE: last 20 bytes identify the logic contract, not the admin.
# admin: upgrade authority only; never substitute it for the implementation.
# beacon: consider only when the implementation slot is empty; resolve its implementation().
# Empty slots do not rule out other proxy families (for example minimal proxies).
cast storage $ADDR 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --block $HEAD_BLOCK --rpc-url $RPC  # impl
cast storage $ADDR 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103 --block $HEAD_BLOCK --rpc-url $RPC  # admin
cast storage $ADDR 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50 --block $HEAD_BLOCK --rpc-url $RPC  # beacon
cast storage $ADDR 0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7 --block $HEAD_BLOCK --rpc-url $RPC  # EIP-1822
# If implementation is empty and beacon is non-zero, resolve the logic from the beacon:
BEACON=0x…   # last 20 bytes of the beacon slot value above
cast call "$BEACON" "implementation()(address)" --block "$HEAD_BLOCK" --rpc-url "$RPC"
```

### 2. Verified source before decompiling

Exact source beats pseudo-source. Sourcify is multichain, free, no key:
`GET https://sourcify.dev/server/v2/contract/$CHAIN_ID/{addr}?fields=all` (use
`$CHAIN_ID` from Step 1 — `42220` for Celo, `143` Monad, etc.). Cross-check the
chain's explorer: Celoscan / Monadscan / Polygonscan / Etherscan.

### 3. Decompile if unverified

These are chain-agnostic — they operate on raw bytecode, so Celo non-indexing is
irrelevant:

- **Dedaub** for readable pseudo-Solidity when its current API and access
  terms permit. Check those terms before uploading bytecode.
- **heimdall-rs** locally (`heimdall decompile/cfg`, MIT, nothing leaves the
  machine — use for sensitive targets).
- **WhatsABI** (`@shazow/whatsabi`) to enumerate the full selector surface
  first. It autoloads over a provider on `$RPC` — the target chain's, not forno,
  or it reads bytecode/proxy slots on the wrong chain — and follows EIP-1967
  proxies. Resolve names via the OpenChain DB.

Treat decompiled output as a hypothesis. Confirm material behaviour against
bytecode, pinned state reads, and transaction traces.

## EOA target — behavioural profile

Top counterparties (`dune sim evm activity` filtered by counterparty), top
tokens held (`dune sim evm balances`), tx-time distribution if relevant. Add
these cheap, chain-native fingerprints (all free via the `dune` skill on
`<chain>.*` or `cast`):

```sql
-- ACTIVITY CLOCK: flat 24h = automated bot; a dead-hours gap = operator's local night.
-- Report as a UTC band, never a country. MUST be an EOA ("from"); a contract returns 0 rows (use <chain>.traces).
SELECT hour(block_time) utc_hour, count(*) FROM <chain>.transactions WHERE "from" = <eoa> GROUP BY 1 ORDER BY 1;

-- AGE / FIRST-SEEN: first + last activity on THIS chain. NOTE: do NOT infer cross-chain reuse from nonce —
--   EVM nonces are chain-LOCAL, so a key with Ethereum/Base history still starts at nonce 0 on its first
--   Celo tx (max_nonce ≈ count-1 given complete data; a gap just means missing/filtered rows, not other-chain
--   activity). To find the operator's other-chain footprint use the Arkham/Sim identity leg (Step 2), not nonce.
SELECT min(block_time) AS first_seen, max(block_time) AS last_seen, count(*) AS tx_count FROM <chain>.transactions WHERE "from" = <eoa>;

-- APPROVAL GRAPH: topic1=owner (delegation OUT → routers it trusts), topic2=spender (delegation IN → who can move its funds).
SELECT * FROM <chain>.logs
WHERE topic0 = 0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925   -- Approval
  AND topic1 = <32-byte left-padded owner> LIMIT 100;   -- events are grant HISTORY; for live use eth_call allowance()
```

## Gnosis Safe targets

If a cheap codehash/proxy check says the target is a Safe, pull the real human
signers and policy:

```bash
cast call "$ADDR" 'getOwners()(address[])'  --block "$HEAD_BLOCK" --rpc-url "$RPC"
cast call "$ADDR" 'getThreshold()(uint256)' --block "$HEAD_BLOCK" --rpc-url "$RPC"
```

Link Safes by intersecting owner sets; an owner can itself be a contract,
so do not equate the returned addresses with identified people. For optional
transaction history, discover the requested chain's current service and access
requirements in the [Safe Transaction Service documentation](https://docs.safe.global/core-api/transaction-service-overview).
Do not construct a service URL by substituting a chain slug. A missing service
is `NOT-COVERED`; a failed request is a tooling gap, not empty Safe history.
