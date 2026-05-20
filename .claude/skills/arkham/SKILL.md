---
name: arkham
description: Use this skill when interacting with the Arkham Intelligence API to fetch address labels, entities, tags, counterparties, transfers, or balances. Triggers on requests to enrich Mento address data with Arkham metadata, label addresses interacting with our pools, run backfills, or write code against `api.arkm.com`. Apply whenever you see references to Arkham, ARKM, `intel.arkm.com`, `api.arkm.com`, an `API-Key` header to that host, or fields like `arkhamEntity`, `arkhamLabel`.
title: Arkham Skill
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# Arkham Intelligence API

Quick reference for hitting Arkham's blockchain intelligence API. The full
endpoint reference lives in `endpoints.md`; load that when you need shapes
beyond the address-labeling core covered here.

## Auth + base URL

- **Base URL:** `https://api.arkm.com`
- **Auth:** every request needs `API-Key: <key>` header. No OAuth, no JWT.
- **Get a key:** apply at <https://intel.arkm.com/api>. Arkham gates access
  through a pilot/sales process; there is no self-serve signup.
- **Local dev:** read the key from `ARKHAM_API_KEY`. Never commit it. In
  this repo, store it via Terraform-managed env vars (mirror the
  `UPSTASH_REDIS_REST_*` pattern in `terraform/main.tf`).
- **Mock server:** `https://docs.intel.arkm.com/_mock/openapi` — useful when
  prototyping without burning rate-limit budget.

## Rate limits

| Bucket    | Limit                           | When                                                                                                        |
| --------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Standard  | **20 req/sec**                  | Most endpoints (intelligence, balances, history, portfolio, labels, tokens)                                 |
| Heavy     | **1 req/sec**                   | `/transfers`, `/swaps`, `/transfers/histogram`, `/counterparties/*`, `/token/top_flow/*`, `/token/volume/*` |
| 429 body  | `{"error":"too many requests"}` | Always back off, never retry tighter than the limit                                                         |
| WebSocket | 10k transfers/hr, 1M/month      | `wss://api.arkm.com/ws/transfers`                                                                           |

For batch jobs against the standard bucket, pace requests at ~50ms apart
(20/sec) with a small jitter. For heavy endpoints, 1.1s spacing leaves
headroom for clock drift.

## Supported chains (relevant to Mento)

**As of 2026-04, `GET /chains` returns:** `ethereum, polygon, bsc, optimism,
avalanche, arbitrum_one, base, bitcoin, tron, flare, solana, ton, dogecoin,
zcash, hyperevm`.

- ❌ **Celo NOT supported.** `?chain=celo` returns `400 {"message":"invalid chain"}`.
- ❌ **Monad NOT supported.**
- ✅ **EVM addresses are chain-agnostic.** A Binance hot-wallet on Celo (seen
  via a bridge inflow in `BridgeTransfer.sender`) is the same `0x` string
  Arkham labels on Ethereum/BSC. Use `/intelligence/address_enriched/{addr}/all`
  to pull cross-chain attribution that still applies on Celo.
- Always call `GET /chains` at startup to validate the live list — Arkham
  adds/removes coverage over time. The earlier (2025) doc snapshot listed
  Celo + Gnosis + zkSync; live API now drops them.

## Core data model

- **Address** — a single blockchain address on a chain. May carry an
  `arkhamEntity` (the owning real-world entity) and an `arkhamLabel`
  (Arkham's curated short name like "Binance 14").
- **Entity** — slug-keyed real-world actor (e.g. `binance`, `vitalik-buterin`).
  Has a `type` (`exchange`, `individual`, `fund`, `protocol`, `dao`,
  `custodian`, `market_maker`, `bridge`, …) and may aggregate many
  addresses across chains.
- **Tag** — a category bucket (`smart-money`, `whale`, `kol`, `individual`).
  Multi-valued; surfaced via `address_enriched` endpoints with `slug`,
  `name`, `description`.
- **Cluster** — group of addresses linked by on-chain heuristics (mostly
  Bitcoin input clustering). Identified by SHA-256 hash.
- **EntityPrediction** — ML-inferred attribution with `confidence` (0–1)
  and `reason`. Treat ≥0.85 as high-confidence; anything lower needs
  manual review before treating as ground truth.

## Core endpoints for labeling addresses

When the goal is "given an address, get a high-quality label":

```bash
# Multi-chain enrichment — the right shape for Mento (Celo isn't supported,
# so we union attribution across every chain Arkham covers).
GET /intelligence/address_enriched/{address}/all
  ?includeTags=true&includeEntityPredictions=true&includeClusters=false

# Per-chain variants — useful only for chains Arkham actually covers.
# `?chain=celo` returns 400 invalid chain.
GET /intelligence/address/{address}?chain=ethereum
GET /intelligence/address_enriched/{address}?chain=ethereum
```

Quality filter — only treat the response as a "high-confidence" label when
**at least one** of these holds:

- `arkhamEntity != null` (curated)
- `arkhamLabel != null` (curated)
- some `entityPredictions[i].confidence >= 0.85` (ML-inferred)

If none hold, Arkham doesn't have meaningful data for that address — skip
writing a label rather than persisting `null`/empty entries.

## Quirks that bite you

- **EVM addresses must be lowercase.** Solana addresses are case-sensitive
  (Base58). Mixed case on EVM gives `400 Bad Request`.
- **Timestamps are Unix milliseconds**, not seconds. Convert before passing
  `time`, `timeGte`, `timeLte`.
- **Portfolio `time` is truncated to UTC midnight.** You can't ask for a
  mid-day snapshot.
- **`transfers/histogram` requires API tier auth**, not just an API key.
  The `simple` variant works on a normal key.
- **`orderByDesc` and `orderByPercent` on `/token/top` are STRINGS**
  (`"true"` / `"false"`), not booleans. Sending booleans returns 400.
- **`/intelligence/address_enriched` defaults all enrichments to `true`.**
  Explicitly set `includeClusters=false` when you don't need clusters —
  they bloat the response.
- **404 is normal** for `/intelligence/address/{addr}` — most addresses
  are unlabeled. Don't log it as an error in batch jobs.
- **No batch endpoint for intelligence lookups.** One address = one
  request. Plan throughput accordingly (20/sec standard).
- **Custom user labels (`/user/labels`) are private to the API key.**
  They are NOT visible to other consumers and don't enrich the public
  Arkham label graph.

## Minimal TypeScript client

```typescript
const ARKHAM_BASE = "https://api.arkm.com";

type Chain = "celo" | "ethereum" | "polygon" | "arbitrum_one" | /* … */ string;

type ArkhamEntity = {
  id: string;
  name: string;
  type: string | null;
  service: boolean | null;
  website: string | null;
  twitter: string | null;
};
type ArkhamLabel = { name: string; address: string; chainType: string };
type EntityPrediction = {
  entityId: string;
  confidence: number;
  reason: string;
};
type ArkhamTag = {
  id: string;
  name: string;
  slug: string;
  description: string;
};

type EnrichedAddress = {
  address: string;
  chain: string;
  arkhamEntity: ArkhamEntity | null;
  arkhamLabel: ArkhamLabel | null;
  contract: boolean | null;
  tags?: ArkhamTag[];
  entityPredictions?: EntityPrediction[];
  clusterIds?: string[];
};

async function fetchAddress(
  address: string,
  chain: Chain,
  apiKey: string,
): Promise<EnrichedAddress | null> {
  const url = new URL(
    `/intelligence/address_enriched/${address.toLowerCase()}`,
    ARKHAM_BASE,
  );
  url.searchParams.set("chain", chain);
  url.searchParams.set("includeTags", "true");
  url.searchParams.set("includeEntityPredictions", "true");
  url.searchParams.set("includeClusters", "false");

  const res = await fetch(url, {
    headers: { "API-Key": apiKey },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 404) return null;
  if (res.status === 429) {
    // Caller paces requests — surface so they can back off.
    throw new Error("arkham_rate_limited");
  }
  if (!res.ok) throw new Error(`arkham_${res.status}`);
  return res.json();
}

// Standard-bucket pacer: 20 req/s with 50ms spacing + jitter.
async function paced<T>(items: T[], fn: (t: T) => Promise<unknown>) {
  for (const item of items) {
    await fn(item);
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 20));
  }
}
```

## Labeling decision rule (Mento-specific)

Map an Arkham response to an `AddressEntry` (see
`ui-dashboard/src/lib/address-labels-shared.ts`):

| Arkham field                                               | `AddressEntry` field   |
| ---------------------------------------------------------- | ---------------------- |
| `arkhamLabel.name` / `entity.name` / `prediction.entityId` | `name`                 |
| Provenance ("this came from Arkham")                       | `source: "arkham"`     |
| `entity.type` + `tags[].slug`                              | `tags` (real metadata) |
| ML prediction confidence note                              | `notes`                |

```typescript
function toAddressEntry(data: EnrichedAddress): AddressEntry | null {
  const label = data.arkhamLabel?.name?.trim();
  const entity = data.arkhamEntity;
  const highConfidencePred = data.entityPredictions?.find(
    (p) => p.confidence >= 0.85,
  );

  // Quality gate — drop unlabeled addresses entirely
  if (!label && !entity && !highConfidencePred) return null;

  const name =
    label || entity?.name?.trim() || highConfidencePred?.entityId || "";
  // Tags carry real Arkham metadata only — entity type + behavioural slugs.
  // Provenance lives in `source` now (used to be the "arkham" sentinel tag).
  const tags = [
    ...(entity?.type ? [entity.type] : []),
    ...(data.tags?.map((t) => t.slug) ?? []),
  ].slice(0, 20); // shared-schema cap

  const note = highConfidencePred
    ? `Arkham prediction (${(highConfidencePred.confidence * 100).toFixed(0)}% confidence)`
    : undefined;

  return {
    name: name.slice(0, 200),
    tags,
    notes: note,
    isPublic: false,
    source: "arkham",
    updatedAt: new Date().toISOString(),
  };
}
```

Always preserve manual labels: before writing, check that the existing
entry doesn't already exist OR has `source === "arkham"` (i.e. was a
previous automated write). The `ARKHAM_TAG = "arkham"` constant is
retained as a backward-compat fallback for entries written before the
`source` field was introduced — `filterCandidates` and
`mergeRefreshEntry` accept either form.

## When to use which endpoint

| Goal                                     | Endpoint                                     | Bucket           |
| ---------------------------------------- | -------------------------------------------- | ---------------- |
| Tag a single address (label only)        | `/intelligence/address/{a}?chain=…`          | Standard         |
| Tag with full enrichment                 | `/intelligence/address_enriched/{a}?chain=…` | Standard         |
| Tag across all EVM chains                | `/intelligence/address_enriched/{a}/all`     | Standard         |
| Lookup an entity by slug                 | `/intelligence/entity/{slug}`                | Standard         |
| Find addresses Mento interacts with most | `/counterparties/address/{mentoPool}`        | **Heavy (1/s)**  |
| Stream new whale-tier transfers          | `wss://api.arkm.com/ws/transfers`            | WebSocket quotas |
| Manage personal labels                   | `/user/labels` (GET/POST/PUT/DELETE)         | Standard         |
| Verify chain support                     | `/chains`                                    | Standard         |
| Health check                             | `/health`                                    | Standard         |

## See also

- `endpoints.md` — full reference for the address/entity/counterparty
  endpoints we'll touch in this repo.
- Official docs: <https://intel.arkm.com/api/docs> — gated behind
  Cloudflare; if WebFetch fails with 403, mirror via the GitHub-hosted
  copy at
  <https://raw.githubusercontent.com/Vyntral/arkham-intelligence-Codex-skill/main/ARKHAM_API_DOCUMENTATION.md>
  (community mirror, treat as best-effort).
