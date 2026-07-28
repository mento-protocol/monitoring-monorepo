import { permanentRedirect } from "next/navigation";

export const metadata = {
  title: "Entities — Address Book — Mento Monitoring",
  description:
    "Browse enriched entity profiles and their known blockchain addresses.",
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function appendSearchParams(
  destination: string,
  values: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `${destination}?${query}` : destination;
}

export default async function LegacyEntitiesPage({ searchParams }: Props) {
  permanentRedirect(
    appendSearchParams("/address-book/entities", await searchParams),
  );
}
