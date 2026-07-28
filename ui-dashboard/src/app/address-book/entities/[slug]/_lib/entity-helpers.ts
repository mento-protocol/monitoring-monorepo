import type { IntelEntityRecord } from "@/lib/intel-entities";

// Allow only alphanumeric handle shapes — guards against rendering crafted
// slugs into URL prefixes for twitter/crunchbase/linkedin.
export const HANDLE_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

export type ExternalLink = { label: string; href: string };

/**
 * The Arkham `/intelligence/entity/{slug}` response stores social fields as
 * full URLs (per the in-repo endpoint reference), but the legacy ingest path
 * historically supplied bare handles. Accept either: if the value parses as a
 * valid http(s) URL, use it verbatim; otherwise treat as a handle and prepend
 * the platform-specific prefix (rejecting on a HANDLE_RE miss to guard
 * against crafted slugs).
 */
function resolveSocialHref(
  value: string | null | undefined,
  handlePrefix: string,
): string | null {
  if (!value) return null;
  const asUrl = safeHttpUrl(value);
  if (asUrl) return asUrl;
  if (HANDLE_RE.test(value)) return `${handlePrefix}${value}`;
  return null;
}

export function buildExternalLinks(entity: IntelEntityRecord): ExternalLink[] {
  const links: ExternalLink[] = [];
  const website = safeHttpUrl(entity.website);
  if (website) links.push({ label: "Website", href: website });
  const twitter = resolveSocialHref(entity.twitter, "https://twitter.com/");
  if (twitter) links.push({ label: "Twitter", href: twitter });
  const crunchbase = resolveSocialHref(
    entity.crunchbase,
    "https://www.crunchbase.com/organization/",
  );
  if (crunchbase) links.push({ label: "Crunchbase", href: crunchbase });
  const linkedin = resolveSocialHref(
    entity.linkedin,
    "https://www.linkedin.com/company/",
  );
  if (linkedin) links.push({ label: "LinkedIn", href: linkedin });
  return links;
}
