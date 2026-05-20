import { notFound } from "next/navigation";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import { hkeysIntelEntities } from "@/lib/intel-entities";
import { EntitySearch } from "./_components/entity-search";

export const metadata = { title: "Entities — Mento Monitoring" };
export const dynamic = "force-dynamic";

export default async function EntitiesPage() {
  const session = await getAuthSession();
  const email = session?.user?.email?.toLowerCase();
  if (!email?.endsWith(ALLOWED_DOMAIN)) notFound();
  const slugs = await hkeysIntelEntities();

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">Entities</h1>
        <p className="mt-1 text-sm text-slate-400">Enriched entity profiles.</p>
      </div>
      <EntitySearch slugs={slugs} />
    </div>
  );
}
