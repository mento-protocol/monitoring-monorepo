import { permanentRedirect } from "next/navigation";

export const metadata = {
  title: "Entity — Address Book — Mento Monitoring",
  description:
    "Review an entity profile, known blockchain addresses, and counterparties.",
  robots: { index: false, follow: false },
};

type Props = {
  params: Promise<{ slug: string }>;
};

export default async function LegacyEntityDetailPage({ params }: Props) {
  const { slug } = await params;
  permanentRedirect(`/address-book/entities/${encodeURIComponent(slug)}`);
}
