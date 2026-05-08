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
  // by lowercase, so normalize once here. Wrap `decodeURIComponent` in a
  // try-catch — a malformed percent-encoding (e.g. `/address-book/%zz`)
  // throws `URIError` and would otherwise crash the page into the error
  // boundary instead of the soft redirect that `isValidAddress` triggers
  // for any other garbage path. Falling back to the raw param keeps that
  // path silent: `isValidAddress("%zz")` returns false, so the effect
  // below `router.replace("/address-book")`s.
  const address = useMemo(() => {
    const raw = params?.address ?? "";
    try {
      return decodeURIComponent(raw).toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  }, [params?.address]);

  const valid = isValidAddress(address);
  useEffect(() => {
    // Silent redirect for user-typed garbage — no error UI flash, mirrors
    // the pool detail page's POOL_NOT_FOUND_DEST pattern.
    if (!valid) router.replace("/address-book");
  }, [valid, router]);

  const {
    getEntry,
    hasLoaded: labelsLoaded,
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
          {/* Save-flow safety: never render a writable form until the labels
              SWR has resolved a real response (`hasLoaded`). On error we
              REPLACE the form with an error banner instead of falling
              through — saving an empty form into an existing entry would
              silently overwrite name/tags/notes. The save path can't
              distinguish "no entry exists" from "we couldn't load the
              entry list", so a write during a degraded read window is a
              data-loss footgun. Same gating handles session-loading: the
              provider only fires SWR after `useSession()` reaches
              `authenticated`, so during session hydration `data` stays
              undefined → `hasLoaded === false` → form stays hidden. */}
          {labelsError ? (
            <div role="alert" className="px-5 py-4 text-xs text-red-300">
              {`Couldn't load labels: ${labelsError.message}. Refresh the page to retry — saving while the read failed could overwrite an existing label.`}
            </div>
          ) : !labelsLoaded ? (
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
              // Remount on:
              //   - state transitions (custom / contract / new) — covers the
              //     deep-link-with-no-cache case where SWR resolves after
              //     first paint.
              //   - the loaded entry's `updatedAt` changing — covers the
              //     "another teammate edited this label, SWR refreshed it,
              //     and a save from this page would otherwise overwrite the
              //     newer remote value with my stale local state". The cost
              //     is losing in-progress local edits when a remote update
              //     lands; that's the right tradeoff vs. silently
              //     clobbering newer data without optimistic-concurrency.
              key={`${address}:${entry ? `custom:${entry.updatedAt}` : formInitial ? "contract" : "new"}`}
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
