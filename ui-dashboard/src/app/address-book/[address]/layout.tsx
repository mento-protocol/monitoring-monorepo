import type { Metadata } from "next";
import { findReport } from "@/lib/address-reports";
import { getLabel } from "@/lib/address-labels";
import { isValidAddress, truncateAddress } from "@/lib/format";

// 60s matches the labels SWR refresh; OG metadata that lags a label rename
// by ≤1min is acceptable and avoids per-request Redis hits on shared links.
export const revalidate = 60;

const FALLBACK_TITLE = "Address — Address Book — Mento Analytics";
const FALLBACK_DESCRIPTION = "Mento address book — labels and forensic reports";

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

  // Both helpers tolerate `null` for missing entries — return fallback
  // metadata when neither label nor report exists rather than 404ing the
  // page (the empty page is a valid input surface).
  const [label, report] = await Promise.all([
    getLabel(address).catch(() => null),
    findReport(address).catch(() => null),
  ]);

  const displayName = label?.name?.trim() || truncateAddress(address);
  const title = `${displayName} — Address Book — Mento Analytics`;
  const descParts: string[] = [];
  if (label?.tags?.length) descParts.push(`Tags: ${label.tags.join(", ")}`);
  if (label?.source) descParts.push(`Source: ${label.source}`);
  if (report?.title) descParts.push(`Report: ${report.title}`);
  else if (report) descParts.push("Forensic report attached");
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
