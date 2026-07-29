---
title: Forensic Report — Capital, Scale, and Historical USD Valuation
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Capital, scale, and historical USD valuation

Deep procedure for Steps 5 and 5.5 of [`SKILL.md`](../SKILL.md).

## Step 5 — Capital and scale

Pass the chain hint through to Sim. `$CHAIN_ID` comes from Step 1's case switch
(see `chain-setup.md`); hardcoding `42220` would return empty or unrelated
holdings for a Monad (or other-chain) principal.

```bash
dune sim evm balances $PRINCIPAL --chain-ids $CHAIN_ID -o json | jq '.balances | length'
dune sim evm balances $PRINCIPAL --chain-ids $CHAIN_ID -o json | jq '.balances[] | {symbol, amount, value_usd}'
# For a scam/noise inventory, include unpriced assets instead of accepting the default exclusion:
dune sim evm balances $PRINCIPAL --chain-ids $CHAIN_ID --exclude-unpriced=false -o json | jq '.balances[]'
```

These responses are paginated. Collect the first page's `.balances`, then repeat
the same command with `--offset <next_offset>` and append each page until
`next_offset` is absent/null. Do this independently for the priced and
`--exclude-unpriced=false` runs before summing or classifying holdings.

Sum supported USD values and inventory unpriced assets separately. A missing or
low-confidence DefiLlama price is evidence that needs corroboration, not proof
that the token is a scam or has no liquidity. Confirm material holdings with
pool/liquidity and transfer evidence before including or excluding them from
operating capital. For tx volume, use a chain explorer or indexed history.

## Step 5.5 — Historical USD valuation (DefiLlama coins API)

Sim's `value_usd` is _current spot_. A forensic claim like "moved $2M in March"
is wrong if the token has since mooned or rugged — value flows **at the time
they happened**. DefiLlama's coin price oracle does this on the free
`coins.llama.fi` host; a DefiLlama Pro key adds nothing here (its Pro-only
endpoints are protocol-aggregate data, not address-level), so never gate this
behind one.

Key format is `$DL_NS:<lowercaseTokenAddress>`, where `$DL_NS` comes from Step 1
(including `monad`). Verify novel chains against DefiLlama. Do not hardcode
`celo:` for another chain. Native CELO uses its ERC20 wrapper, e.g.
`celo:0x471ece3750da237f93b8e339c536989b8978a438`.

**Historical price at a tx's block time** (Unix seconds — derive from the block:
`cast block <n> -f timestamp --rpc-url $RPC`):

```bash
TS=1742000000   # block timestamp, unix seconds
curl -s "https://coins.llama.fi/prices/historical/$TS/$DL_NS:<tokenLower>" | jq '.coins'
# -> { "celo:0x…": { "decimals": 18, "symbol": "…", "price": 0.0629, "confidence": 0.99, "timestamp": … } }
```

USD value of a raw transfer = `(rawAmount / 10^decimals) * price`. Batch tokens
in one call by comma-joining keys:
`…/historical/$TS/$DL_NS:0xAAA,$DL_NS:0xBBB`. Use this to put a defensible
dollar figure on the representative tx in Step 4 and on flow totals.

**Current price** (same response shape) for the Step 5 holdings snapshot:
`https://coins.llama.fi/prices/current/$DL_NS:<tokenLower>`. Treat `confidence`
as price-source reliability. Missing/low-confidence data requires
corroboration; it is not a deterministic scam or liquidity verdict.

## Caveats — surface them in the report when they bite

- Coverage is token-specific even on supported chains. If a key returns nothing,
  corroborate with Sim and venue liquidity and disclose the pricing gap rather
  than silently reporting zero.
- **`coins.llama.fi` is not on the default sandbox network allowlist.** It's a
  read-only public GET — allowlist the host or run the single command
  unsandboxed.
