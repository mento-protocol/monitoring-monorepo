"use client";

import Link from "next/link";
import { TagPills } from "@/components/tag-pills";
import { ChainIcon } from "@/components/chain-icon";
import { truncateAddress } from "@/lib/format";
import {
  ARKHAM_TAG,
  MINIPAY_SOURCE,
  isArkhamSourced,
  isMiniPaySourced,
} from "@/lib/address-labels-shared";
import type { Network } from "@/lib/networks";

// Short, locale-aware "yyyy-mm-dd hh:mm" for the Created at column. Full ISO
// timestamp lives on the <time> dateTime + title attrs for hover/screen
// readers. Falls back to the raw string if the timestamp is unparsable.
function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type AddressRowProps = {
  address: string;
  name: string;
  tags: string[];
  network: Network;
  notes?: string;
  isPublic?: boolean;
  isCustom: boolean;
  kind?: "contract" | "custom" | "report";
  source?: string;
  createdAt?: string;
  updatedAt?: string;
  canEdit: boolean;
  /** Pre-computed by the parent so the reports index hook isn't re-subscribed
   * per row — see AddressBookClient. */
  reportPresent: boolean;
  explorerUrl: string | null;
  /** When set, the whole row becomes a link to this href via an
   * absolutely-positioned overlay <Link>. Inner interactive elements
   * (explorer link, Edit button) take pointer events back via z-10. */
  detailHref?: string;
  onEdit: () => void;
};

export function AddressTableRow({
  address,
  name,
  tags,
  network,
  notes,
  isPublic,
  isCustom,
  kind,
  source,
  createdAt,
  updatedAt,
  canEdit,
  reportPresent,
  explorerUrl,
  detailHref,
  onEdit,
}: AddressRowProps) {
  const arkhamSourced = isArkhamSourced({ source, tags });
  const minipaySourced = isMiniPaySourced({ source });
  const isReportOnly = kind === "report";
  // Strip server-provenance tags from the displayed list — the SOURCE badge
  // already conveys this, so showing them as pills duplicates the signal.
  const displayTags = tags.filter(
    (t) => t !== ARKHAM_TAG && t !== MINIPAY_SOURCE,
  );
  return (
    <tr className="relative border-b border-slate-800 hover:bg-slate-800/30 transition-colors">
      {/* Card-link overlay: absolutely positions a <Link> against the
          row's `position: relative` context so cmd-click / middle-click /
          keyboard focus all behave like a real row-link. The <Link> sits
          inside the first <td> (HTML doesn't allow <a> as a direct child
          of <tr>) — its absolute positioning still resolves to the <tr>
          because the host <td> uses default static positioning. Visible
          cell contents stack above via `relative z-10`; pointer-events
          fall through to the link from text-only cells but are taken
          back by interactive children (explorer link, Edit button). */}
      <td className="px-4 py-3 whitespace-nowrap">
        {detailHref && (
          <Link
            href={detailHref}
            aria-label={`Open ${name || address}`}
            className="absolute inset-0 z-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500"
          />
        )}
        <div className="relative z-10 pointer-events-none">
          {isCustom || isReportOnly ? (
            <span className="inline-flex items-center rounded-full bg-purple-950 px-2 py-0.5 text-xs font-medium text-purple-300 ring-1 ring-inset ring-purple-800 whitespace-nowrap">
              All chains
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <ChainIcon network={network} />
              <span className="text-xs text-slate-400 whitespace-nowrap">
                {network.label.replace(/ \(.*\)$/, "")}
              </span>
            </div>
          )}
        </div>
      </td>
      <td className="relative z-10 px-4 py-3 whitespace-nowrap pointer-events-none">
        <div className="flex items-center gap-1.5">
          {explorerUrl ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={address}
              className="font-mono text-xs text-slate-300 hover:text-indigo-300 transition-colors pointer-events-auto"
            >
              {truncateAddress(address)}
              <span className="ml-1 text-slate-600" aria-hidden="true">
                ↗
              </span>
            </a>
          ) : (
            <span title={address} className="font-mono text-xs text-slate-500">
              {truncateAddress(address)}
            </span>
          )}
          {reportPresent && (
            <span
              role="img"
              aria-label="Has forensic report"
              title="Forensic report attached"
              className="text-xs leading-none"
            >
              📄
            </span>
          )}
        </div>
      </td>
      <td className="relative z-10 px-4 py-3 max-w-[180px] pointer-events-none">
        <span
          title={name}
          className={`block truncate text-sm ${isCustom ? "font-medium text-indigo-400" : "text-slate-300"}`}
        >
          {name || <span className="text-slate-600">—</span>}
        </span>
      </td>
      <td className="relative z-10 px-4 py-3 pointer-events-none">
        {displayTags.length > 0 ? (
          <TagPills tags={displayTags} />
        ) : (
          <span className="text-xs text-slate-600">—</span>
        )}
      </td>
      <td className="relative z-10 px-4 py-3 text-xs text-slate-400 max-w-[180px] truncate pointer-events-none">
        {notes ?? <span className="text-slate-600">—</span>}
      </td>
      <td className="relative z-10 px-4 py-3 pointer-events-none">
        {isReportOnly ? (
          <span className="inline-flex items-center rounded-full bg-sky-950 px-2 py-0.5 text-xs font-medium text-sky-300 ring-1 ring-inset ring-sky-800">
            report
          </span>
        ) : isCustom && arkhamSourced ? (
          <span className="inline-flex items-center rounded-full bg-teal-950 px-2 py-0.5 text-xs font-medium text-teal-300 ring-1 ring-inset ring-teal-800">
            arkham
          </span>
        ) : isCustom && minipaySourced ? (
          <span className="inline-flex items-center rounded-full bg-fuchsia-950 px-2 py-0.5 text-xs font-medium text-fuchsia-300 ring-1 ring-inset ring-fuchsia-800">
            minipay
          </span>
        ) : isCustom ? (
          <span className="inline-flex items-center rounded-full bg-indigo-950 px-2 py-0.5 text-xs font-medium text-indigo-300 ring-1 ring-inset ring-indigo-800">
            custom
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-400 ring-1 ring-inset ring-slate-700">
            contract
          </span>
        )}
      </td>
      <td className="relative z-10 px-4 py-3 pointer-events-none">
        {isCustom &&
          (isPublic === true ? (
            <span className="inline-flex items-center rounded-full bg-emerald-950 px-2 py-0.5 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-emerald-800">
              public
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-800">
              private
            </span>
          ))}
      </td>
      <td className="relative z-10 px-4 py-3 text-xs text-slate-400 whitespace-nowrap pointer-events-none">
        {createdAt ? (
          <time dateTime={createdAt} title={createdAt}>
            {formatCreatedAt(createdAt)}
          </time>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </td>
      <td className="relative z-10 px-4 py-3 text-xs whitespace-nowrap pointer-events-none">
        {updatedAt ? (
          // Highlight when we can confirm the row has been edited since
          // creation; render plain when `createdAt` is absent (legacy rows
          // where we can't compute the diff but still want to surface the
          // last-write timestamp). Em-dash only when there's no timestamp
          // at all (contract rows). Sky palette is distinct from the amber
          // "private" visibility badge to avoid semantic collision.
          createdAt && updatedAt !== createdAt ? (
            <time
              dateTime={updatedAt}
              title={updatedAt}
              className="rounded bg-sky-950/60 px-1.5 py-0.5 font-medium text-sky-300 ring-1 ring-inset ring-sky-900/60"
            >
              {formatCreatedAt(updatedAt)}
            </time>
          ) : createdAt && updatedAt === createdAt ? (
            <span className="text-slate-600">—</span>
          ) : (
            <time
              dateTime={updatedAt}
              title={updatedAt}
              className="text-slate-400"
            >
              {formatCreatedAt(updatedAt)}
            </time>
          )
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </td>
      <td className="relative z-10 px-4 py-3">
        {!canEdit ? null : isCustom ? (
          <button
            type="button"
            onClick={onEdit}
            className="text-xs text-slate-400 hover:text-indigo-300 transition-colors"
          >
            Edit
          </button>
        ) : isReportOnly ? (
          <button
            type="button"
            onClick={onEdit}
            title="Add a label to this report-only address"
            className="text-xs text-slate-600 hover:text-indigo-300 transition-colors"
          >
            + Label
          </button>
        ) : (
          <button
            type="button"
            onClick={onEdit}
            title="Add tags or notes to this contract"
            className="text-xs text-slate-600 hover:text-indigo-300 transition-colors"
          >
            + Tag
          </button>
        )}
      </td>
    </tr>
  );
}
