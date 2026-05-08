"use client";

import { useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAddressLabels } from "@/components/address-labels-provider";
import { AddressLabelForm } from "@/components/address-label-form";
import { AddressReportEditor } from "@/components/address-report-editor";
import { useAddressReportsIndex } from "@/hooks/use-address-reports-index";
import { isValidAddress } from "@/lib/format";
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

  const { getEntry } = useAddressLabels();
  const { hasReport } = useAddressReportsIndex();

  if (!valid) return null;

  const resolved = getEntry(address);
  const entry = resolved?.entry;
  const hasLabel = entry !== undefined;

  return (
    <div className="space-y-6">
      <AddressDetailHeader
        address={address}
        name={entry?.name}
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
          <AddressLabelForm
            address={address}
            initial={entry}
            // No onSaved/onDeleted callbacks — the provider's optimistic
            // update + SWR revalidate already refresh the page data. No
            // navigation on save; users stay on the page to keep editing.
          />
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
