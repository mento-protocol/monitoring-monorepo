"use client";

import { useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAddressLabels } from "@/components/address-labels-provider";
import { AddressLabelForm } from "@/components/address-label-form";
import { AddressReportEditor } from "@/components/address-report-editor";
import { useAddressReportsIndex } from "@/hooks/use-address-reports-index";
import { isValidAddress } from "@/lib/format";
import { findContractInitial } from "../_lib/address-book-rows";
import { AddressDetailHeader } from "./_components/address-detail-header";

export default function AddressDetailPage() {
  const params = useParams<{ address: string }>();
  const router = useRouter();
  // URL params come URI-encoded; the labels store + reports store both key
  // by lowercase, so normalize once here.
  const address = useMemo(() => {
    const raw = params?.address ?? "";
    return decodeURIComponent(raw).toLowerCase();
  }, [params?.address]);

  const valid = isValidAddress(address);
  useEffect(() => {
    // Silent redirect for user-typed garbage — no error UI flash, mirrors
    // the pool detail page's POOL_NOT_FOUND_DEST pattern.
    if (!valid) router.replace("/address-book");
  }, [valid, router]);

  const {
    getEntry,
    isLoading: labelsLoading,
    error: labelsError,
  } = useAddressLabels();
  const { hasReport } = useAddressReportsIndex();

  if (!valid) return null;

  const resolved = getEntry(address);
  const entry = resolved?.entry;
  const hasLabel = entry !== undefined;
  // Contract-row fallback: when no custom label exists, seed the form with
  // the static contract name (if any) so saving from this page doesn't
  // accidentally drop the registry-supplied display name. Mirrors the
  // modal flow in `AddressBookClient`.
  const formInitial = entry ?? findContractInitial(address);

  return (
    <div className="space-y-6">
      <AddressDetailHeader
        address={address}
        name={entry?.name ?? formInitial?.name}
        tags={entry?.tags}
        source={entry?.source}
        hasReport={hasReport(address)}
        hasLabel={hasLabel}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* Sticky sidebar keeps the label form in view while a long report
            scrolls in the main column. Stacks below `lg`. */}
        <aside
          aria-labelledby="label-panel-heading"
          className="rounded-xl border border-slate-800 bg-slate-900 lg:sticky lg:top-4 lg:self-start"
        >
          <div className="border-b border-slate-800 px-5 py-3">
            <h2
              id="label-panel-heading"
              className="text-sm font-semibold text-white"
            >
              {hasLabel ? "Edit label" : "Add label"}
            </h2>
          </div>
          {/* While SWR is still resolving the labels list (deep-link with no
              fallback in cache), defer rendering the form so we don't seed
              local state from `undefined` and silently overwrite an existing
              label on save. Errors fall through to the form so the user can
              still enter a fresh label even if the read path is degraded. */}
          {labelsLoading && !labelsError ? (
            <div
              aria-live="polite"
              aria-label="Loading label form"
              className="px-5 py-4 space-y-4"
            >
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="space-y-2">
                  <div className="h-3 w-20 animate-pulse rounded bg-slate-800/50" />
                  <div className="h-9 w-full animate-pulse rounded bg-slate-800/50" />
                </div>
              ))}
            </div>
          ) : (
            <AddressLabelForm
              // Remount the form when the resolved entry transitions between
              // states (loaded custom entry vs. contract fallback vs. fresh).
              // Prevents stale local state when a deep-link's SWR fetch
              // resolves after first paint.
              key={`${address}:${entry ? "custom" : formInitial ? "contract" : "new"}`}
              address={address}
              initial={formInitial}
              // No onSaved/onDeleted callbacks — the provider's optimistic
              // update + SWR revalidate already refresh the page data. No
              // navigation on save; users stay on the page to keep editing.
            />
          )}
        </aside>

        <section
          aria-labelledby="report-panel-heading"
          className="rounded-xl border border-slate-800 bg-slate-900"
        >
          <div className="border-b border-slate-800 px-5 py-3">
            <h2
              id="report-panel-heading"
              className="text-sm font-semibold text-white"
            >
              Forensic Report
            </h2>
          </div>
          <AddressReportEditor address={address} />
        </section>
      </div>
    </div>
  );
}
