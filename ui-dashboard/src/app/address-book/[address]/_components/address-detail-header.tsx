"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ARKHAM_TAG,
  MINIPAY_SOURCE,
  isArkhamSourced,
  isMiniPaySourced,
} from "@/lib/address-labels-shared";
import { truncateAddress } from "@/lib/format";

type Props = {
  address: string;
  /** Display name from the label entry. Falls back to truncated address. */
  name?: string | undefined;
  /** Tag list from the label entry — provenance tags filtered out. */
  tags?: string[] | undefined;
  /** Provenance: "arkham" | "minipay" | undefined for manual / no label. */
  source?: string | undefined;
  /** Whether the address has a forensic report attached. */
  hasReport: boolean;
  /** Whether a custom label already exists. Drives the empty-state hint. */
  hasLabel: boolean;
};

export function AddressDetailHeader({
  address,
  name,
  tags,
  source,
  hasReport,
  hasLabel,
}: Props) {
  const arkhamSourced = isArkhamSourced({ source, tags });
  const minipaySourced = isMiniPaySourced({ source });
  const displayName = name?.trim() || truncateAddress(address);
  // Strip provenance tag sentinels from the display list — the source pill
  // already conveys the same signal.
  const displayTags =
    tags?.filter((t) => t !== ARKHAM_TAG && t !== MINIPAY_SOURCE) ?? [];

  return (
    <header className="space-y-3">
      <nav aria-label="Breadcrumb" className="text-xs text-slate-500">
        <Link
          href="/address-book"
          className="hover:text-slate-300 transition-colors"
        >
          Address Book
        </Link>
        <span aria-hidden="true" className="mx-2 text-slate-700">
          /
        </span>
        <span className="text-slate-400">{truncateAddress(address)}</span>
      </nav>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <span className="truncate">{displayName}</span>
            {hasReport && (
              <span
                role="img"
                aria-label="Has forensic report"
                title="Forensic report attached"
                className="text-base"
              >
                📄
              </span>
            )}
          </h1>
          <div className="flex items-center gap-2 flex-wrap">
            <code className="font-mono text-xs text-slate-400 break-all">
              {address}
            </code>
            <CopyButton text={address} />
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {arkhamSourced && (
            <span className="inline-flex items-center rounded-full bg-teal-950 px-2 py-0.5 text-xs font-medium text-teal-300 ring-1 ring-inset ring-teal-800">
              arkham
            </span>
          )}
          {minipaySourced && (
            <span className="inline-flex items-center rounded-full bg-fuchsia-950 px-2 py-0.5 text-xs font-medium text-fuchsia-300 ring-1 ring-inset ring-fuchsia-800">
              minipay
            </span>
          )}
          {hasLabel && !arkhamSourced && !minipaySourced && (
            <span className="inline-flex items-center rounded-full bg-indigo-950 px-2 py-0.5 text-xs font-medium text-indigo-300 ring-1 ring-inset ring-indigo-800">
              custom
            </span>
          )}
          {/* Custom labels are address-keyed — chainless. The "All chains"
              pill mirrors the index table for visual consistency. */}
          {hasLabel && (
            <span className="inline-flex items-center rounded-full bg-purple-950 px-2 py-0.5 text-xs font-medium text-purple-300 ring-1 ring-inset ring-purple-800">
              All chains
            </span>
          )}
        </div>
      </div>

      {displayTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {displayTags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center rounded-full bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-300 ring-1 ring-inset ring-slate-700"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {!hasLabel && !hasReport && (
        <p className="text-xs text-slate-500">
          No label or report yet — fill in the form to save, or paste a markdown
          investigation into the report panel on the right.
        </p>
      )}
    </header>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // Older browsers / insecure contexts — silent fall-through is fine
          // since the address is already select-all-able next to the button.
        }
      }}
      aria-label={copied ? "Copied address" : "Copy address"}
      className="rounded border border-slate-700 px-2 py-0.5 text-[10px] font-medium text-slate-400 hover:border-slate-500 hover:text-slate-200 transition-colors"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
