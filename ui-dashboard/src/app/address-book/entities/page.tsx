import { notFound } from "next/navigation";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import { getAllIntelEntities } from "@/lib/intel-entities";
import { AddressBookSectionNav } from "../_components/address-book-section-nav";
import { EntitySearch } from "./_components/entity-search";
import {
  buildEntityDirectoryItems,
  ENTITY_ADDRESS_SEARCH_LIMIT,
} from "./_lib/entity-directory";

export const metadata = {
  title: "Entities — Address Book — Mento Monitoring",
  description:
    "Browse enriched entity profiles and their known blockchain addresses.",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function EntitiesPage() {
  const session = await getAuthSession();
  const email = session?.user?.email?.toLowerCase();
  if (!email?.endsWith(ALLOWED_DOMAIN)) notFound();
  const items = buildEntityDirectoryItems(await getAllIntelEntities());

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Address Book</h1>
        <p className="mt-1 text-sm text-slate-400">
          Contract labels, custom records, and enriched entity profiles.
        </p>
      </div>
      <AddressBookSectionNav active="entities" />
      <div className="w-full">
        <EntitySearch
          items={items}
          addressSearchLimit={ENTITY_ADDRESS_SEARCH_LIMIT}
        />
      </div>
    </main>
  );
}
