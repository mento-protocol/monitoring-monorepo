import { notFound } from "next/navigation";
import Link from "next/link";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import { getIntelEntity, type IntelEntityRecord } from "@/lib/intel-entities";
import { getIntelEntityCps } from "@/lib/intel-entity-cps";
import { CounterpartyChainTables } from "@/components/counterparty-chain-tables";
import type { CounterpartyEntry } from "@/components/counterparty-chain-tables";
import { buildExternalLinks, type ExternalLink } from "./_lib/entity-helpers";

export const metadata = { title: "Entity — Mento Monitoring" };

// Redis-backed data; bypass Next 16's default static-render attempt.
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
};

function EntityNotFound({ slug }: { slug: string }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center">
      <p className="text-lg font-semibold text-white">Entity not found</p>
      <p className="mt-2 text-sm text-slate-400">
        No entity with slug &ldquo;{slug}&rdquo; exists in the database.
      </p>
      <Link
        href="/entities"
        className="mt-6 inline-block text-sm text-indigo-400 hover:underline"
      >
        &larr; Back to entities
      </Link>
    </div>
  );
}

function EntityHeader({
  entity,
  slug,
  links,
}: {
  entity: IntelEntityRecord;
  slug: string;
  links: ExternalLink[];
}) {
  return (
    <div>
      <Link
        href="/entities"
        className="text-xs text-slate-500 hover:text-slate-300"
      >
        &larr; All entities
      </Link>
      <h1 className="mt-2 text-2xl font-semibold text-white">
        {entity.name ?? slug}
      </h1>
      {entity.type && (
        <p className="mt-1 text-sm text-slate-400">{entity.type}</p>
      )}
      {links.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-3">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-indigo-400 hover:underline"
            >
              {link.label} &rarr;
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function EntityTags({
  tags,
}: {
  tags: Array<{ label?: string; name?: string; slug?: string }>;
}) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag, i) => {
        const label = tag.label ?? tag.name ?? tag.slug ?? "";
        if (!label) return null;
        return (
          <span
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            key={`tag-${i}`}
            className="inline-block rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-300"
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

export default async function EntityDetailPage({ params }: Props) {
  // Defense in depth — middleware already gates /entities for @mentolabs.xyz,
  // but a server-side guard ensures the page never renders if the middleware
  // matcher drifts.
  const session = await getAuthSession();
  const email = session?.user?.email?.toLowerCase();
  if (!email?.endsWith(ALLOWED_DOMAIN)) notFound();

  const { slug } = await params;
  // Sequential reads: await entity, short-circuit on null, then await cps.
  // Avoids a floating promise on the 404 path; the extra hget on the happy
  // path is sub-ms keyed by the same slug.
  const entity = await getIntelEntity(slug);
  if (!entity) return <EntityNotFound slug={slug} />;
  const cps = await getIntelEntityCps(slug);

  const tags = (entity.populatedTags ?? []) as Array<{
    label?: string;
    name?: string;
    slug?: string;
  }>;
  const cpsByChain: Record<string, CounterpartyEntry[]> =
    (cps?.counterparties as Record<string, CounterpartyEntry[]> | null) ?? {};
  const links = buildExternalLinks(entity);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <EntityHeader entity={entity} slug={slug} links={links} />
      <EntityTags tags={tags} />
      {Object.keys(cpsByChain).length > 0 && (
        <section className="rounded-xl border border-slate-800 bg-slate-900">
          <div className="border-b border-slate-800 px-5 py-3">
            <h2 className="text-sm font-semibold text-white">
              Counterparties (30d)
            </h2>
          </div>
          <div className="p-5">
            <CounterpartyChainTables byChain={cpsByChain} />
          </div>
        </section>
      )}
    </div>
  );
}
