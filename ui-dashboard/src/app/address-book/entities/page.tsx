import { notFound } from "next/navigation";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import {
  getIntelEntityDirectorySource,
  INTEL_ENTITY_DIRECTORY_MAX_BYTES,
  INTEL_ENTITY_DIRECTORY_MAX_RECORDS,
} from "@/lib/intel-entities";
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
  const source = await getIntelEntityDirectorySource();
  const items = source.limited
    ? null
    : buildEntityDirectoryItems(source.entities);

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
        {items ? (
          <EntitySearch
            items={items}
            addressSearchLimit={ENTITY_ADDRESS_SEARCH_LIMIT}
          />
        ) : (
          <div
            className="rounded-lg border border-amber-800/70 bg-amber-950/30 px-5 py-4"
            role="status"
          >
            <p className="text-sm font-medium text-amber-100">
              Entity directory temporarily unavailable
            </p>
            <p className="mt-1 text-sm text-amber-200/80">
              The Redis dataset exceeds the safe directory read limit of{" "}
              {INTEL_ENTITY_DIRECTORY_MAX_RECORDS.toLocaleString()} records or{" "}
              {Math.floor(
                INTEL_ENTITY_DIRECTORY_MAX_BYTES / (1024 * 1024),
              ).toLocaleString()}{" "}
              MiB.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
