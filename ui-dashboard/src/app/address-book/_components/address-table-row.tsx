"use client";

import { TagPills } from "@/components/tag-pills";
import { ChainIcon } from "@/components/chain-icon";
import { useAddressReportsIndex } from "@/hooks/use-address-reports-index";
import { truncateAddress } from "@/lib/format";
import {
  ARKHAM_TAG,
  MINIPAY_SOURCE,
  isArkhamSourced,
  isMiniPaySourced,
  type Scope,
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
  scope: Scope;
  network: Network;
  notes?: string;
  isPublic?: boolean;
  isCustom: boolean;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
  canEdit: boolean;
  explorerUrl: string | null;
  onEdit: () => void;
};

export function AddressTableRow({
  address,
  name,
  tags,
  scope,
  network,
  notes,
  isPublic,
  isCustom,
  source,
  createdAt,
  updatedAt,
  canEdit,
  explorerUrl,
  onEdit,
}: AddressRowProps) {
  const arkhamSourced = isArkhamSourced({ source, tags });
  const minipaySourced = isMiniPaySourced({ source });
  // Strip server-provenance tags from the displayed list — the SOURCE badge
  // already conveys this, so showing them as pills duplicates the signal.
  const displayTags = tags.filter(
    (t) => t !== ARKHAM_TAG && t !== MINIPAY_SOURCE,
  );
  // Single SWR fetch shared across every row via the hook's stable key —
  // doesn't N+1 even when the table renders hundreds of rows.
  const { hasReport } = useAddressReportsIndex();
  const reportPresent = hasReport(address, scope);
  return (
    <tr className="border-b border-slate-800 hover:bg-slate-800/30 transition-colors">
      <td className="px-4 py-3 whitespace-nowrap">
        {scope === "global" ? (
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
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex items-center gap-1.5">
          {explorerUrl ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={address}
              className="font-mono text-xs text-slate-300 hover:text-indigo-300 transition-colors"
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
      <td className="px-4 py-3 max-w-[180px]">
        <span
          title={name}
          className={`block truncate text-sm ${isCustom ? "font-medium text-indigo-400" : "text-slate-300"}`}
        >
          {name || <span className="text-slate-600">—</span>}
        </span>
      </td>
      <td className="px-4 py-3">
        {displayTags.length > 0 ? (
          <TagPills tags={displayTags} />
        ) : (
          <span className="text-xs text-slate-600">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-slate-400 max-w-[180px] truncate">
        {notes ?? <span className="text-slate-600">—</span>}
      </td>
      <td className="px-4 py-3">
        {isCustom && arkhamSourced ? (
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
      <td className="px-4 py-3">
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
      <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">
        {createdAt ? (
          <time dateTime={createdAt} title={createdAt}>
            {formatCreatedAt(createdAt)}
          </time>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs whitespace-nowrap">
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
      <td className="px-4 py-3">
        {!canEdit ? null : isCustom ? (
          <button
            type="button"
            onClick={onEdit}
            className="text-xs text-slate-400 hover:text-indigo-300 transition-colors"
          >
            Edit
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
