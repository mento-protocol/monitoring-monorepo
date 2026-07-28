import { notFound } from "next/navigation";
import Link from "next/link";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import { getIntelEntity, type IntelEntityRecord } from "@/lib/intel-entities";
import { getIntelEntityCps } from "@/lib/intel-entity-cps";
import { CounterpartyChainTables } from "@/components/counterparty-chain-tables";
import type { CounterpartyEntry } from "@/components/counterparty-chain-tables";
import {
  parseEntityAddresses,
  type EntityAddress,
} from "../_lib/entity-addresses";
import { buildExternalLinks, type ExternalLink } from "./_lib/entity-helpers";

export const metadata = {
  title: "Entity — Address Book — Mento Monitoring",
  description:
    "Review an entity profile, known blockchain addresses, and counterparties.",
  robots: { index: false, follow: false },
};

// Redis-backed data; bypass Next 16's default static-render attempt.
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
};

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
        href="/address-book/entities"
        className="text-xs text-slate-400 hover:text-slate-200"
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

const MAX_VISIBLE_ADDRESSES = 50;

function KnownAddresses({ addresses }: { addresses: EntityAddress[] }) {
  if (addresses.length === 0) return null;

  const visible = addresses.slice(0, MAX_VISIBLE_ADDRESSES);
  const hiddenCount = addresses.length - visible.length;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex items-center justify-between gap-4 border-b border-slate-800 px-5 py-3">
        <h2 className="text-sm font-semibold text-white">Known addresses</h2>
        <span className="text-xs tabular-nums text-slate-400">
          {addresses.length.toLocaleString()}
        </span>
      </div>
      <ul className="divide-y divide-slate-800">
        {visible.map((entry) => (
          <li
            key={`${entry.address.toLowerCase()}:${entry.chain?.toLowerCase() ?? "unknown"}`}
            className="flex min-w-0 items-center justify-between gap-4 px-5 py-3"
          >
            <div className="min-w-0">
              {entry.canOpenInAddressBook ? (
                <Link
                  href={`/address-book/${entry.address.toLowerCase()}`}
                  className="break-all font-mono text-xs text-indigo-400 hover:text-indigo-300 hover:underline"
                >
                  {entry.address}
                </Link>
              ) : (
                <span className="break-all font-mono text-xs text-slate-300">
                  {entry.address}
                </span>
              )}
            </div>
            {entry.chain && (
              <span className="shrink-0 text-xs text-slate-400">
                {entry.chain}
              </span>
            )}
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <p className="border-t border-slate-800 px-5 py-3 text-xs text-slate-400">
          Showing the first {MAX_VISIBLE_ADDRESSES.toLocaleString()} addresses.{" "}
          {hiddenCount.toLocaleString()} more are stored in this entity profile.
        </p>
      )}
    </section>
  );
}

export default async function EntityDetailPage({ params }: Props) {
  // Defense in depth: middleware already gates /address-book for
  // @mentolabs.xyz, but a server-side guard ensures the page never renders if
  // the middleware matcher drifts.
  const session = await getAuthSession();
  const email = session?.user?.email?.toLowerCase();
  if (!email?.endsWith(ALLOWED_DOMAIN)) notFound();

  const { slug } = await params;
  // Sequential reads: await entity, short-circuit on null, then await cps.
  // Avoids a floating promise on the 404 path; the extra hget on the happy
  // path is sub-ms keyed by the same slug.
  const entity = await getIntelEntity(slug);
  if (!entity) notFound();
  const cps = await getIntelEntityCps(slug);

  const tags = (entity.populatedTags ?? []) as Array<{
    label?: string;
    name?: string;
    slug?: string;
  }>;
  const cpsByChain: Record<string, CounterpartyEntry[]> =
    (cps?.counterparties as Record<string, CounterpartyEntry[]> | null) ?? {};
  const links = buildExternalLinks(entity);
  const addresses = parseEntityAddresses(entity.addresses);

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <EntityHeader entity={entity} slug={slug} links={links} />
      <EntityTags tags={tags} />
      <KnownAddresses addresses={addresses} />
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
    </main>
  );
}
