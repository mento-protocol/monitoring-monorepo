import type { Metadata } from "next";
import { getLabel } from "@/lib/address-labels";
import { isValidAddress, truncateAddress } from "@/lib/format";

// Disable ISR caching — `generateMetadata` reads the live label and
// returns the fallback shape unless `isPublic === true`. With a
// non-zero `revalidate`, an editor toggling `Visible to public` from
// true → false would still see the prior (public) `<title>`/OG tags
// served from the edge cache for up to the cache window, leaking the
// label/tags/source after revocation. The privacy gate must be
// honoured immediately; per-request Redis cost is bounded by
// `withTimeout(METADATA_FETCH_TIMEOUT_MS)` and only fires when a
// crawler / shared-link preview hits the URL (regular page loads
// already read labels from the client-side SWR provider).
export const revalidate = 0;

const FALLBACK_TITLE = "Address — Address Book — Mento Analytics";
const FALLBACK_DESCRIPTION = "Mento address book — labels and forensic reports";

// Per-request timeout for upstream Redis calls. Without this a hung
// Upstash REST endpoint would block metadata generation until Vercel's
// function timeout (300s) fires, stalling crawler unfurls and shared-link
// previews. Mirrors the `AbortSignal.timeout(5000)` pattern in
// `bridge-flows-og.ts`. The Upstash SDK doesn't expose a per-call signal
// so we wrap each promise; the upstream still completes in the
// background but the wrapped promise resolves to `null` after 5s and
// `generateMetadata` falls through to the fallback shape.
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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address: raw } = await params;
  // Wrap `decodeURIComponent` — a malformed percent-encoding (e.g.
  // `/address-book/%zz`) throws `URIError`. `generateMetadata` running
  // during build / on-demand revalidation would otherwise propagate that
  // up and break OG generation for the whole route. Fall back to the raw
  // param; `isValidAddress` immediately rejects it and we return the
  // fallback metadata.
  let address: string;
  try {
    address = decodeURIComponent(raw).toLowerCase();
  } catch {
    address = raw.toLowerCase();
  }
  if (!isValidAddress(address)) {
    return {
      title: FALLBACK_TITLE,
      description: FALLBACK_DESCRIPTION,
    };
  }

  // Privacy gate: `generateMetadata` runs without a session and the
  // resulting <title>/<meta> tags are visible to any crawler / shared-link
  // preview that sees this URL. Labels default to private (`isPublic !==
  // true`) and reports are NEVER public per AGENTS.md, so include label
  // info ONLY when the user explicitly flagged the entry as public, and
  // never expose report titles. Private labels and report-attached
  // addresses fall through to the generic fallback metadata — a small
  // OG-preview UX downgrade in exchange for not leaking entity
  // attributions to anyone who guesses an address URL.
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

export default function AddressDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
