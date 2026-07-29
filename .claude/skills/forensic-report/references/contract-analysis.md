---
title: Forensic Report — Contract and EOA Analysis
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
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

Read the standard slots — a non-zero value means you've been reading an empty
shell and must analyse the _implementation_ instead:

```bash
# EIP-1967 impl / admin / beacon, then EIP-1822 (UUPS). For impl/admin/EIP-1822, non-zero → last 20
# bytes IS the address to analyse. The BEACON slot is different: its last 20 bytes are the BEACON
# contract, not the impl — call beacon.implementation() and analyse THAT (see below).
cast storage $ADDR 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --block $HEAD_BLOCK --rpc-url $RPC  # impl
cast storage $ADDR 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103 --block $HEAD_BLOCK --rpc-url $RPC  # admin
cast storage $ADDR 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50 --block $HEAD_BLOCK --rpc-url $RPC  # beacon
cast storage $ADDR 0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7 --block $HEAD_BLOCK --rpc-url $RPC  # EIP-1822
# If the beacon slot was non-zero, resolve the real implementation from the beacon contract:
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

- **Dedaub API** (`https://api.dedaub.com`, free tier, async POST→poll) for
  readable pseudo-Solidity.
- **heimdall-rs** locally (`heimdall decompile/cfg`, MIT, nothing leaves the
  machine — use for sensitive targets).
- **WhatsABI** (`@shazow/whatsabi`) to enumerate the full selector surface
  first. It autoloads over a provider on `$RPC` — the target chain's, not forno,
  or it reads bytecode/proxy slots on the wrong chain — and follows EIP-1967
  proxies. Resolve names via the OpenChain DB.

This is the only way to describe what a closed-source proprietary bot actually
does.

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

Link Safes by intersecting owner sets. The free hosted Safe tx-service (keyless
reads) is per-chain: `https://api.safe.global/tx-service/<safe-slug>/api/v1/safes/<safe>/`,
where `<safe-slug>` is the chain's Safe short-name (celo→`celo`, polygon→`pol`,
ethereum→`eth`). Not every chain has one (Monad doesn't), so don't copy the
`celo` slug for a non-Celo target. This exposes the people behind a
treasury/managed-bot the proxy address would otherwise hide.
