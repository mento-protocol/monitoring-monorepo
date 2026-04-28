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

import { sanitizeEntry, type AddressEntry } from "@/lib/address-labels-shared";

const ARKHAM_BASE = "https://api.arkm.com";
const REQUEST_TIMEOUT_MS = 10_000;

// Pacing for the standard rate-limit bucket (20 req/s). 60ms spacing leaves
// ~16 req/s sustained — comfortably under the limit even with clock jitter.
const REQ_SPACING_MS = 60;

// Confidence floor for ML-attributed addresses. Below this, treat predictions
// as advisory and don't persist them as labels — see Arkham docs §8.4.
const HIGH_CONFIDENCE = 0.85;

export type ArkhamEntity = {
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

export type ArkhamLabel = {
  name: string;
  address: string;
  chainType: string;
};

export type ArkhamTag = {
  id: string;
  name: string;
  slug: string;
  type?: string;
  description?: string;
};

export type ArkhamEntityPrediction = {
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

/** Provenance marker. Manual labels never carry this tag. */
export const ARKHAM_TAG = "arkham";

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
 * Fetch enriched intelligence for one address on one chain.
 *
 * Returns `null` when Arkham has no data (HTTP 404) — that's the common case
 * for unlabeled addresses. Throws on auth/rate-limit/5xx so the caller can
 * stop the batch rather than silently swallow a misconfiguration.
 */
export async function fetchEnrichedAddress(
  address: string,
  chain: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ArkhamEnrichedAddress | null> {
  const url = new URL(
    `/intelligence/address_enriched/${address.toLowerCase()}`,
    ARKHAM_BASE,
  );
  url.searchParams.set("chain", chain);
  url.searchParams.set("includeTags", "true");
  url.searchParams.set("includeEntityPredictions", "true");
  // Cluster IDs are bulky and almost always Bitcoin-only — skip on Celo.
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
  return (await res.json()) as ArkhamEnrichedAddress;
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
 * Decide whether an Arkham response carries a useful label.
 *
 * Skip persistence when Arkham has no curated entity, no curated label, AND
 * no high-confidence ML prediction. Persisting empty entries clutters the
 * address book and burns Redis storage.
 */
export function hasUsableLabel(data: ArkhamEnrichedAddress): boolean {
  if (data.arkhamLabel?.name) return true;
  if (data.arkhamEntity?.name) return true;
  return Boolean(
    data.entityPredictions?.some((p) => p.confidence >= HIGH_CONFIDENCE),
  );
}

/**
 * Map an Arkham response onto our `AddressEntry` schema.
 *
 * Returns `null` when nothing is worth persisting (caller should skip the
 * Redis write). The `arkham` tag is the provenance marker — code paths that
 * write manual labels MUST NOT include it, so a future refresh can tell
 * "manual" from "auto-enriched".
 */
export function toAddressEntry(
  data: ArkhamEnrichedAddress,
): AddressEntry | null {
  if (!hasUsableLabel(data)) return null;

  const label = data.arkhamLabel?.name?.trim();
  const entity = data.arkhamEntity;
  const topPrediction = data.entityPredictions
    ?.filter((p) => p.confidence >= HIGH_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence)[0];

  // Prefer the curated label, then the entity's display name, then the
  // predicted entity ID. Length/dedup/tag-cap is delegated to sanitizeEntry.
  const name = label ?? entity?.name ?? topPrediction?.entityId ?? "";

  const tagSet = new Set<string>([ARKHAM_TAG]);
  if (entity?.type) tagSet.add(entity.type);
  for (const t of data.tags ?? []) {
    if (t.slug) tagSet.add(t.slug);
  }

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

export type EnrichBatchOptions = {
  apiKey: string;
  chain: string;
  /** Optional pacer override for tests. Default: 60ms between calls. */
  spacingMs?: number;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Optional sleeper override for tests (default: setTimeout). */
  sleeper?: (ms: number) => Promise<void>;
};

/** 1.5s back-off on 429 — duplicated in tests as a constant to keep them in sync. */
export const RATE_LIMIT_BACKOFF_MS = 1500;

const defaultSleeper = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

async function tryEnrich(
  address: string,
  chain: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<EnrichmentResult> {
  const raw = await fetchEnrichedAddress(address, chain, apiKey, fetchImpl);
  return { address, entry: raw ? toAddressEntry(raw) : null };
}

export async function enrichBatch(
  addresses: string[],
  opts: EnrichBatchOptions,
): Promise<EnrichmentResult[]> {
  const {
    apiKey,
    chain,
    spacingMs = REQ_SPACING_MS,
    fetchImpl = fetch,
    sleeper = defaultSleeper,
  } = opts;

  const results: EnrichmentResult[] = [];

  for (let i = 0; i < addresses.length; i += 1) {
    const address = addresses[i]!;
    try {
      results.push(await tryEnrich(address, chain, apiKey, fetchImpl));
    } catch (err) {
      // Auth errors are fatal: the rest of the batch will all 401 too.
      if (err instanceof ArkhamAuthError) throw err;
      if (err instanceof ArkhamRateLimitedError) {
        // Back off and retry once. If it 429s twice in a row, surface the
        // error and let the caller decide.
        await sleeper(RATE_LIMIT_BACKOFF_MS);
        try {
          results.push(await tryEnrich(address, chain, apiKey, fetchImpl));
        } catch (retryErr) {
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
    if (i < addresses.length - 1) await sleeper(spacingMs);
  }

  return results;
}

/**
 * Filter candidate addresses against existing labels.
 *
 * Returns the subset of `candidates` we should actually call Arkham for:
 * - Addresses with an existing manual label (no `arkham` tag) are NEVER
 *   touched — manual labels win.
 * - In refresh mode, addresses with the `arkham` tag are re-enriched.
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
      if (!current) return true; // unlabeled — always enrich
      const isArkhamSourced = current.tags?.includes(ARKHAM_TAG) === true;
      if (isArkhamSourced) return mode === "refresh";
      return false; // manual label — skip
    });
}
