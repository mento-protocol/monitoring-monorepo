import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isValidAddress } from "@/lib/format";
import { buildAddressOgMetadata } from "./_lib/og-metadata";
import { AddressDetailPageClient } from "./_components/address-detail-page-client";

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

// Allowlisted in `rsc-label-leak-guard.test.ts` via the helper file
// `_lib/og-metadata.ts` — the page itself does not import
// `@/lib/address-labels` directly.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address: raw } = await params;
  return buildAddressOgMetadata(raw);
}

function decodeAddressParam(raw: string): string {
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

export default async function AddressDetailPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address: raw } = await params;
  const address = decodeAddressParam(raw);
  // Server-side guard runs before any client JS ships — invalid input
  // (user-typed garbage, malformed percent-encoding) redirects to the
  // address-book index instead of crashing the error boundary.
  if (!isValidAddress(address)) redirect("/address-book");
  return <AddressDetailPageClient address={address} />;
}
