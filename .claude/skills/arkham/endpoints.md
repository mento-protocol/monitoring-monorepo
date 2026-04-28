# Arkham API — Focused Endpoint Reference

Curated reference for the endpoints we'll touch in this repo. The full
catalogue (transfers, swaps, portfolios, flow, ARKM token, market data,
loans, networks) lives at <https://intel.arkm.com/api/docs>; pull from
there only when you have a concrete need it covers.

All requests:

```
Host: api.arkm.com
Header: API-Key: <key>
```

EVM addresses MUST be lowercase. Solana addresses are case-sensitive.

## 1. Address intelligence

### `GET /intelligence/address/{address}?chain={chain}`

Curated label for one address on one chain. Standard rate limit (20/s).

Response (200):

```json
{
  "address": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
  "chain": "ethereum",
  "depositServiceID": null,
  "arkhamEntity": {
    "id": "vitalik-buterin",
    "name": "Vitalik Buterin",
    "note": "",
    "type": "individual",
    "service": null,
    "website": null,
    "twitter": "https://twitter.com/VitalikButerin",
    "crunchbase": "https://www.crunchbase.com/person/vitalik-buterin",
    "linkedin": "https://www.linkedin.com/in/vitalik-buterin-267a7450"
  },
  "arkhamLabel": {
    "name": "vitalik.eth",
    "address": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
    "chainType": "evm"
  },
  "isUserAddress": false,
  "contract": false
}
```

Returns `404` for unlabeled addresses — that's normal in batch loops.

### `GET /intelligence/address/{address}/all`

Same shape, keyed by chain. One call covers every supported chain where
the address has data.

```json
{
  "ethereum": { /* Address object */ },
  "polygon":  { /* Address object */ },
  "arbitrum_one": { /* Address object */ }
}
```

Use this when you want a chain-agnostic global label for the address.

### `GET /intelligence/address_enriched/{address}?chain={chain}`

Adds three optional enrichment fields. All default to `true`; pass
`includeTags=false` etc. to drop them.

Extra fields beyond the base address shape:

- `tags: Array<{ id, name, slug, type, entityCount, description }>` —
  Arkham's curated category tags. `slug` is the stable machine
  identifier; use it for tag deduplication.
- `entityPredictions: Array<{ entityId, confidence, reason }>` — ML
  attribution. `confidence` ∈ [0, 1]. Use ≥ 0.85 as the high-confidence
  bar; below that, treat as advisory only.
- `clusterIds: Array<string>` — SHA-256 cluster identifiers (mostly
  Bitcoin input clustering). Rarely useful for EVM labeling — leave
  `includeClusters=false` unless investigating BTC.

### `GET /intelligence/address_enriched/{address}/all`

Multi-chain version. Same enrichment knobs as the single-chain variant.

## 2. Entity lookup

### `GET /intelligence/entity/{entitySlug}`

Read entity metadata by slug (e.g. `binance`, `vitalik-buterin`,
`jump-trading`). Returns name, type, social links, populated tags.

`type` enum: `individual`, `exchange`, `fund`, `protocol`, `dao`,
`custodian`, `market_maker`, `bridge`, plus others.

### `GET /intelligence/entity/{entitySlug}/summary`

Aggregate stats: `numAddresses`, `volumeUsd`, `balanceUsd`, `firstTx`,
`lastTx`. Precomputed for large Arkham entities; on-the-fly for user
entities.

### `GET /intelligence/entity_predictions/{entitySlug}`

Returns ML-predicted addresses for the entity (with USD balance). Useful
for expanding coverage beyond Arkham's hand-curated set, but treat as
advisory — predictions are not verified.

## 3. Contract metadata

### `GET /intelligence/contract/{chain}/{address}`

For contract addresses, returns deployer + internalDeployer (with their
own nested `arkhamEntity` / `arkhamLabel`), `isProxy`, `proxyAddress`,
deployment timestamp, and `functionSighashes`. Useful for surfacing
"this contract was deployed by Mento Labs" style labels.

## 4. Counterparties (HEAVY — 1 req/sec)

### `GET /counterparties/address/{address}`

Top counterparties for a single address by USD volume. Aggregates
in/out flows over a time window.

Key params:

- `flow`: `in` | `out` | `either`
- `limit`: 1–1000 (default 100)
- `chains`: comma-separated (e.g. `celo,ethereum`)
- `tokens`: comma-separated CoinGecko IDs or contract addresses
- `timeLast`: `24h` | `7d` | `30d` (mutually exclusive with `timeGte`/`timeLte`)
- `timeGte` / `timeLte`: Unix ms

Response groups by `in` / `out` arrays of `{ address, usd,
transactionCount, flow, chains[] }`. Each `address` carries the same
nested `arkhamEntity` / `arkhamLabel` as the intelligence endpoints —
so this single call doubles as a label discovery tool for everyone an
address has touched.

### `GET /counterparties/entity/{entitySlug}`

Same shape, aggregated across every address Arkham knows for the
entity. Useful for "show me Binance's top counterparties on Celo".

## 5. User labels (private to your API key)

### `GET /user/labels`

List your private labels.

### `POST /user/labels`

Body: array of `{ name, note?, address, chainType }`. Bulk create.
`name` ≤ 256 chars, `note` ≤ 1024 chars.

### `PUT /user/labels/{address}:{chainType}`

Update a single label. Path is `address:chainType` (e.g.
`0xabc...:evm`). Body keys: `name`, `note?`, `address`, `chainType`.

### `DELETE /user/labels/{address}:{chainType}`

Delete one label.

### `DELETE /user/labels?labels=addr1:evm,addr2:bitcoin`

Bulk delete.

`chainType` enum (note: this is broader than the chain enum — it
collapses every EVM chain into one bucket): `evm`, `bitcoin`, `tron`,
`ton`, `solana`, `dogecoin`.

User labels are **not** visible in the public Arkham label graph and
don't enrich `/intelligence` responses for other consumers. They're a
personal annotation layer scoped to your API key.

## 6. Plumbing

### `GET /health`

Returns `ok` (text/plain). Use for liveness probes.

### `GET /chains`

Returns `string[]` of supported chain identifiers. Run this once at
startup to validate any chain string you pass downstream — Arkham adds
chains over time.

## Error taxonomy

| Status | Meaning | Action |
| --- | --- | --- |
| `400` | Malformed input (often: mixed-case EVM address, wrong chain, conflicting `timeLast` + `timeGte`) | Fix input; don't retry |
| `401` | Missing/invalid `API-Key` | Check env var; rotate if compromised |
| `404` | Address/entity/cluster has no Arkham data | Skip, don't escalate |
| `429` | Rate-limited (`{"error":"too many requests"}`) | Back off ≥ 1 s; lower concurrency |
| `5xx` | Arkham server problem | Retry with exponential backoff (max 3 attempts) |

## Address shape (returned everywhere)

The same `Address` object appears in `/intelligence`, `/counterparties`,
`/contract`, `/transfers`, etc. — learn it once:

```typescript
type Address = {
  address: string;             // lowercase EVM, base58 BTC, etc.
  chain: string;               // chain enum, e.g. "celo"
  depositServiceID: string | null;
  arkhamEntity: ArkhamEntity | null;
  arkhamLabel: ArkhamLabel | null;
  isUserAddress: boolean | null;  // true if the API key's user owns it
  contract: boolean | null;
};
```

`arkhamEntity` carries `id`, `name`, `note`, `type`, `service`,
`addresses`, `website`, `twitter`, `crunchbase`, `linkedin`.

`arkhamLabel` carries `name` (human-readable, e.g. "Binance 14"),
`address`, `chainType` (`evm` | `bitcoin` | `tron` | `ton` | `solana` |
`dogecoin`).
