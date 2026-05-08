import type { Metadata } from "next";
import { buildAddressOgMetadata } from "./_lib/og-metadata";

// Disable ISR caching — `generateMetadata` reads the live label and
// returns the fallback shape unless `isPublic === true`. With a
// non-zero `revalidate`, an editor toggling `Visible to public` from
// true → false would still see the prior (public) `<title>`/OG tags
// served from the edge cache for up to the cache window, leaking the
// label/tags/source after revocation. The privacy gate must be
// honoured immediately; per-request Redis cost is bounded by the
// helper's `withTimeout` and only fires when a crawler / shared-link
// preview hits the URL (regular page loads already read labels from
// the client-side SWR provider).
export const revalidate = 0;

// Layout body is a passthrough — the metadata builder lives in
// `_lib/og-metadata.ts` so the RSC leak guard can allowlist EXACTLY
// the helper file (sole non-API consumer of `@/lib/address-labels`)
// rather than the whole layout. A future edit that adds Redis usage
// inside this default render would now correctly trip the guard.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address: raw } = await params;
  return buildAddressOgMetadata(raw);
}

export default function AddressDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
