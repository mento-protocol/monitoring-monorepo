/**
 * Server-side Arkham Intelligence client.
 *
 * Hits `api.arkm.com` to enrich Mento counterparty addresses with curated
 * labels, entity attribution, and tag metadata. Only `address_enriched/{addr}`
 * is exercised — the `endpoints.md` reference in `.claude/skills/arkham/`
 * covers the full surface.
 *
 * NEVER import from a client component. The API key is server-only.
 */

import {
  ARKHAM_TAG,
  isArkhamSourced,
  sanitizeEntry,
  type AddressEntry,
} from "@/lib/address-labels-shared";

const ARKHAM_BASE = "https://api.arkm.com";
const REQUEST_TIMEOUT_MS = 10_000;

// Pacing for the standard rate-limit bucket (20 req/s). 60ms spacing leaves
// ~16 req/s sustained — comfortably under the limit even with clock jitter.
const REQ_SPACING_MS = 60;

// Confidence floor for ML-attributed addresses. Below this, treat predictions
// as advisory and don't persist them as labels.
const HIGH_CONFIDENCE = 0.85;

type ArkhamEntity = {
  id: string;
  name: string;
  note?: string;
  type: string | null;
  service: boolean | null;
  website?: string | null;
  twitter?: string | null;
  crunchbase?: string | null;
  linkedin?: string | null;
};

type ArkhamLabel = {
  name: string;
  address: string;
  chainType: string;
};

type ArkhamTag = {
  id: string;
  name: string;
  slug: string;
  type?: string;
  description?: string;
};

type ArkhamEntityPrediction = {
  entityId: string;
  confidence: number;
  reason: string;
};

export type ArkhamEnrichedAddress = {
  address: string;
  chain: string;
  depositServiceID: string | null;
  arkhamEntity: ArkhamEntity | null;
  arkhamLabel: ArkhamLabel | null;
  isUserAddress: boolean | null;
  contract: boolean | null;
  tags?: ArkhamTag[];
  entityPredictions?: ArkhamEntityPrediction[];
  clusterIds?: string[];
};

// Re-export so existing `from "@/lib/arkham"` import sites keep working.
// The canonical home is `address-labels-shared.ts` because client components
// (e.g. AddressBookClient) need these and this module is server-only.
export { ARKHAM_TAG, isArkhamSourced };

export class ArkhamRateLimitedError extends Error {
  constructor() {
    super("arkham_rate_limited");
    this.name = "ArkhamRateLimitedError";
  }
}

export class ArkhamAuthError extends Error {
  constructor() {
    super("arkham_unauthorized");
    this.name = "ArkhamAuthError";
  }
}

/**
 * Multi-chain Arkham response shape — `/intelligence/address_enriched/{addr}/all`.
 * Keys are chain slugs (`ethereum`, `polygon`, …); values are per-chain
 * enriched data. Chains where Arkham has no data return an entry with
 * `arkhamEntity` and `arkhamLabel` both null.
 *
 * Note: Arkham does NOT support Celo or Monad as of 2026-04. EVM addresses
 * are chain-agnostic so attribution from any covered chain (Ethereum, BSC,
 * Polygon, Arbitrum, Optimism, Base, Avalanche, Flare, HyperEVM) carries
 * over to the same address on Celo.
 */
type ArkhamMultiChainResponse = Record<string, ArkhamEnrichedAddress>;

/**
 * Fetch enriched intelligence for one address across every chain Arkham
 * covers. Returns the multi-chain map verbatim; `null` only on HTTP 404
 * (unknown to Arkham across all chains).
 */
export async function fetchEnrichedAddress(
  address: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ArkhamMultiChainResponse | null> {
  const url = new URL(
    `/intelligence/address_enriched/${address.toLowerCase()}/all`,
    ARKHAM_BASE,
  );
  url.searchParams.set("includeTags", "true");
  url.searchParams.set("includeEntityPredictions", "true");
  // Cluster IDs are bulky and almost always Bitcoin-only — skip.
  url.searchParams.set("includeClusters", "false");

  const res = await fetchImpl(url.toString(), {
    headers: { "API-Key": apiKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 404) return null;
  if (res.status === 401) throw new ArkhamAuthError();
  if (res.status === 429) throw new ArkhamRateLimitedError();
  if (!res.ok) {
    throw new Error(`arkham_http_${res.status}`);
  }
  return (await res.json()) as ArkhamMultiChainResponse;
}

/**
 * Verify the key + reachability. Cheap (text/plain "ok"), use it as a
 * smoke-test before kicking off a batch.
 */
export async function fetchHealth(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const res = await fetchImpl(`${ARKHAM_BASE}/health`, {
    headers: { "API-Key": apiKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401) throw new ArkhamAuthError();
  return res.ok;
}

/**
 * Decide whether any per-chain Arkham response carries a useful label.
 *
 * Skip persistence when no chain has a curated entity, a curated label, OR
 * a high-confidence ML prediction. Persisting empty entries clutters the
 * address book and burns Redis storage.
 */
export function hasUsableLabel(data: ArkhamMultiChainResponse): boolean {
  for (const perChain of Object.values(data)) {
    // Trim before checking — `"   "` is JS-truthy but not a usable label.
    // Aligns with `toAddressEntry`'s post-trim falsy-check downstream.
    if (perChain.arkhamLabel?.name?.trim()) return true;
    if (perChain.arkhamEntity?.name?.trim()) return true;
    if (
      perChain.entityPredictions?.some((p) => p.confidence >= HIGH_CONFIDENCE)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Map an Arkham response onto our `AddressEntry` schema.
 *
 * Returns `null` when nothing is worth persisting (caller should skip the
 * Redis write). Provenance is recorded as `source: "arkham"`; manual labels
 * never carry that source, so a future refresh can tell "manual" from
 * "auto-enriched".
 */
export function toAddressEntry(
  data: ArkhamMultiChainResponse,
): AddressEntry | null {
  if (!hasUsableLabel(data)) return null;

  // EVM addresses are chain-agnostic, so the same `arkhamEntity`/`arkhamLabel`
  // typically appears on every covered chain. Pick the strongest signal once;
  // union tags across all chains.
  let label: string | undefined;
  let entity: ArkhamEntity | null = null;
  let topPrediction: ArkhamEntityPrediction | undefined;
  // Tags carry real Arkham metadata only (entity type, behavioural slugs).
  // Provenance lives in `AddressEntry.source` now.
  const tagSet = new Set<string>();

  for (const perChain of Object.values(data)) {
    const trimmed = perChain.arkhamLabel?.name?.trim();
    if (!label && trimmed) label = trimmed;
    if (!entity && perChain.arkhamEntity?.name?.trim())
      entity = perChain.arkhamEntity;
    if (entity?.type) tagSet.add(entity.type);
    for (const t of perChain.tags ?? []) {
      if (t.slug) tagSet.add(t.slug);
    }
    for (const p of perChain.entityPredictions ?? []) {
      if (p.confidence < HIGH_CONFIDENCE) continue;
      if (!topPrediction || p.confidence > topPrediction.confidence) {
        topPrediction = p;
      }
    }
  }

  // Prefer the curated label, then entity name, then the predicted entity ID.
  const name = label || entity?.name?.trim() || topPrediction?.entityId || "";
  if (!name) return null;

  // Notes only when the label rests on an ML prediction — flags lower
  // certainty so a human reviewing the address book can spot it.
  const note =
    !label && !entity && topPrediction
      ? `Arkham prediction (${Math.round(topPrediction.confidence * 100)}% confidence)`
      : undefined;

  return sanitizeEntry({
    name,
    tags: Array.from(tagSet),
    notes: note,
    isPublic: false,
    source: "arkham",
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Process a batch of addresses against Arkham, paced for the standard
 * 20 req/s rate limit.
 *
 * Stops early on auth errors (misconfiguration — no point continuing).
 * Slows down on rate-limit errors (back off + retry once). Other errors are
 * collected and returned alongside results so the caller can decide whether
 * to fail the run.
 */
export type EnrichmentResult = {
  address: string;
  entry: AddressEntry | null;
  error?: string;
};

type EnrichBatchOptions = {
  apiKey: string;
  /** Test-only: override fetch + sleeper to avoid real network and timers. */
  fetchImpl?: typeof fetch;
  sleeper?: (ms: number) => Promise<void>;
};

/** 1.5s back-off on 429 — duplicated in tests as a constant to keep them in sync. */
export const RATE_LIMIT_BACKOFF_MS = 1500;

const defaultSleeper = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

async function tryEnrich(
  address: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<EnrichmentResult> {
  const raw = await fetchEnrichedAddress(address, apiKey, fetchImpl);
  return { address, entry: raw ? toAddressEntry(raw) : null };
}

export async function enrichBatch(
  addresses: string[],
  opts: EnrichBatchOptions,
): Promise<EnrichmentResult[]> {
  const { apiKey, fetchImpl = fetch, sleeper = defaultSleeper } = opts;
  const results: EnrichmentResult[] = [];

  for (let i = 0; i < addresses.length; i += 1) {
    const address = addresses[i]!;
    try {
      results.push(await tryEnrich(address, apiKey, fetchImpl));
    } catch (err) {
      // Auth errors are fatal: the rest of the batch will all 401 too.
      if (err instanceof ArkhamAuthError) throw err;
      if (err instanceof ArkhamRateLimitedError) {
        // Back off and retry once. Auth errors during retry are still fatal
        // (e.g. key rotated mid-batch); other errors record + continue.
        await sleeper(RATE_LIMIT_BACKOFF_MS);
        try {
          results.push(await tryEnrich(address, apiKey, fetchImpl));
        } catch (retryErr) {
          if (retryErr instanceof ArkhamAuthError) throw retryErr;
          results.push({
            address,
            entry: null,
            error:
              retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
        }
      } else {
        results.push({
          address,
          entry: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (i < addresses.length - 1) await sleeper(REQ_SPACING_MS);
  }

  return results;
}

/**
 * In refresh mode, merge a fresh Arkham result into an existing Arkham-sourced
 * entry. Lets Arkham update `name` and add new tags, but preserves user-edited
 * `notes` (unless they're our auto-generated prediction note) and `isPublic`.
 *
 * Recognises both new entries (`source === "arkham"`) and legacy entries
 * (`tags` contains `ARKHAM_TAG`). The legacy sentinel is filtered out of the
 * merged tag set — provenance now lives in `source`.
 *
 * Returns `fresh` unchanged when the existing entry isn't Arkham-sourced.
 */
export function mergeRefreshEntry(
  existing: AddressEntry | undefined,
  fresh: AddressEntry,
): AddressEntry {
  if (!existing || !isArkhamSourced(existing)) return fresh;

  const isAutoNote = existing.notes?.startsWith("Arkham prediction (");
  const tags = Array.from(new Set([...fresh.tags, ...existing.tags])).filter(
    (t) => t !== ARKHAM_TAG,
  );

  return sanitizeEntry({
    name: fresh.name,
    tags,
    notes: isAutoNote ? fresh.notes : (existing.notes ?? fresh.notes),
    isPublic: existing.isPublic ?? fresh.isPublic,
    source: "arkham",
    updatedAt: fresh.updatedAt,
  });
}

/**
 * Filter candidate addresses against existing labels.
 *
 * Returns the subset of `candidates` we should actually call Arkham for:
 * - Addresses with an existing manual label (not Arkham-sourced) are NEVER
 *   touched — manual labels win.
 * - In refresh mode, only Arkham-sourced addresses are re-enriched.
 *   Detection accepts both new entries (`source === "arkham"`) and legacy
 *   pre-source-field entries that still carry the `ARKHAM_TAG` sentinel.
 * - In default mode, only unlabeled addresses are enriched (one-shot
 *   backfill semantics).
 */
export function filterCandidates(
  candidates: string[],
  existing: Record<string, AddressEntry>,
  mode: "new" | "refresh" = "new",
): string[] {
  return candidates
    .map((a) => a.toLowerCase())
    .filter((address) => {
      const current = existing[address];
      if (!current) return mode !== "refresh"; // unlabeled: enrich in new mode only
      if (isArkhamSourced(current)) return mode === "refresh";
      return false; // manual label — skip
    });
}
