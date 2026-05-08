import type { Metadata } from "next";
import { getLabel } from "@/lib/address-labels";
import { isValidAddress, truncateAddress } from "@/lib/format";

// Centralised metadata builder for `/address-book/[address]`. Lives in a
// dedicated file (rather than inline in `layout.tsx`) so the RSC label-leak
// guard test can allowlist EXACTLY this file as the sole non-API consumer
// of `@/lib/address-labels`. Allowlisting `layout.tsx` itself would let a
// future edit add Redis usage outside `generateMetadata` (e.g. inside the
// default layout render) without tripping the guard, silently shipping
// private label data into the RSC payload.

const FALLBACK_TITLE = "Address — Address Book — Mento Analytics";
const FALLBACK_DESCRIPTION = "Mento address book — labels and forensic reports";

// Per-request timeout for upstream Redis calls. Without this a hung
// Upstash REST endpoint would block metadata generation until Vercel's
// function timeout (300s) fires, stalling crawler unfurls and shared-link
// previews. Mirrors the `AbortSignal.timeout(5000)` pattern in
// `bridge-flows-og.ts`. The Upstash SDK doesn't expose a per-call signal
// so we wrap each promise; the upstream still completes in the
// background but the wrapped promise resolves to `null` after 5s and
// the caller falls through to the fallback shape.
const METADATA_FETCH_TIMEOUT_MS = 5000;
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    handle = setTimeout(() => resolve(null), ms);
  });
  try {
    return (await Promise.race([promise, timeout])) ?? null;
  } finally {
    if (handle) clearTimeout(handle);
  }
}

/**
 * Build the OG / Twitter / `<title>` metadata for an `/address-book/[addr]`
 * page given the raw URL param. Privacy-gated: only labels explicitly
 * flagged `isPublic === true` get attribution in the rendered tags;
 * everything else falls through to a generic fallback shape so an
 * unauthenticated crawler / shared-link preview can't extract entity
 * attributions by guessing addresses.
 */
export async function buildAddressOgMetadata(
  rawAddressParam: string,
): Promise<Metadata> {
  // Wrap `decodeURIComponent` — a malformed percent-encoding (e.g.
  // `/address-book/%zz`) throws `URIError`. `generateMetadata` running
  // during build / on-demand revalidation would otherwise propagate that
  // up and break OG generation for the whole route. Fall back to the raw
  // param; `isValidAddress` immediately rejects it and we return the
  // fallback metadata.
  let address: string;
  try {
    address = decodeURIComponent(rawAddressParam).toLowerCase();
  } catch {
    address = rawAddressParam.toLowerCase();
  }
  if (!isValidAddress(address)) {
    return {
      title: FALLBACK_TITLE,
      description: FALLBACK_DESCRIPTION,
    };
  }

  // Privacy gate: this runs without a session and the resulting
  // <title>/<meta> tags are visible to any crawler / shared-link
  // preview that sees this URL. Labels default to private (`isPublic !==
  // true`) and reports are NEVER public per AGENTS.md, so include label
  // info ONLY when the user explicitly flagged the entry as public, and
  // never expose report titles.
  const label = await withTimeout(
    getLabel(address),
    METADATA_FETCH_TIMEOUT_MS,
  ).catch(() => null);

  if (!label || label.isPublic !== true) {
    return {
      title: FALLBACK_TITLE,
      description: FALLBACK_DESCRIPTION,
    };
  }

  const displayName = label.name?.trim() || truncateAddress(address);
  const title = `${displayName} — Address Book — Mento Analytics`;
  const descParts: string[] = [];
  if (label.tags?.length) descParts.push(`Tags: ${label.tags.join(", ")}`);
  if (label.source) descParts.push(`Source: ${label.source}`);
  const description = descParts.join(" · ") || FALLBACK_DESCRIPTION;

  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary", title, description },
  };
}
