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

export function buildExternalLinks(entity: IntelEntityRecord): ExternalLink[] {
  const links: ExternalLink[] = [];
  const website = safeHttpUrl(entity.website);
  if (website) links.push({ label: "Website", href: website });
  if (entity.twitter && HANDLE_RE.test(entity.twitter)) {
    links.push({
      label: "Twitter",
      href: `https://twitter.com/${entity.twitter}`,
    });
  }
  if (entity.crunchbase && HANDLE_RE.test(entity.crunchbase)) {
    links.push({
      label: "Crunchbase",
      href: `https://www.crunchbase.com/organization/${entity.crunchbase}`,
    });
  }
  if (entity.linkedin && HANDLE_RE.test(entity.linkedin)) {
    links.push({
      label: "LinkedIn",
      href: `https://www.linkedin.com/company/${entity.linkedin}`,
    });
  }
  return links;
}
