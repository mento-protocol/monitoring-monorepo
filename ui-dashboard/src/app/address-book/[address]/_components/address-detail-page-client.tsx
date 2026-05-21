"use client";

import { useCallback, useRef, useState } from "react";
import { useAddressLabels } from "@/components/address-labels-provider";
import { AddressLabelForm } from "@/components/address-label-form";
import { AddressReportEditor } from "@/components/address-report-editor";
import { useAddressReportsIndex } from "@/hooks/use-address-reports-index";
import {
  findContractInitial,
  hasAmbiguousContractMatches,
} from "../../_lib/address-book-rows";
import { AddressDetailHeader } from "./address-detail-header";
import { IntelPanels } from "./intel-panels";

// Intentional react-doctor suppression: label panel, report panel, and
// pending-ledger ownership are coupled on this detail page. Split only with a
// focused component-ownership refactor.
// react-doctor-disable-next-line react-doctor/no-giant-component
export function AddressDetailPageClient({ address }: { address: string }) {
  const {
    getEntry,
    hasLoaded: labelsLoaded,
    error: labelsError,
    markPendingMutation,
    isMutationPending,
    markPendingReportMutation,
    isReportMutationPending,
  } = useAddressLabels();
  const { hasReport } = useAddressReportsIndex();
  const [formSaving, setFormSaving] = useState(false);
  const [formDeleting, setFormDeleting] = useState(false);
  const latchedFormSuffixRef = useRef<string>("");
  // Pending mutations are tracked GLOBALLY in the labels provider so
  // they survive this page's mount/unmount lifecycle (a user who saves
  // → navigates to the index → re-enters the same address before the
  // request settles still sees the in-flight state). This component
  // just keeps a per-formInstanceId map of unmark callbacks so the
  // matching `false` event releases the right pending entry.
  const unmarkPendingRef = useRef<Map<string, () => void>>(new Map());
  // Separate map for report-mutation unmark callbacks — report writes
  // live in their own provider ledger so a label save doesn't block a
  // report save against the same address.
  const unmarkReportPendingRef = useRef<Map<string, () => void>>(new Map());
  const addressRef = useRef(address);
  addressRef.current = address;
  const handleReportSavingChange = useCallback(
    (saving: boolean, editorId: string, addr: string) => {
      const key = `${editorId}:save`;
      if (saving) {
        unmarkReportPendingRef.current.set(
          key,
          markPendingReportMutation(addr),
        );
      } else {
        const u = unmarkReportPendingRef.current.get(key);
        unmarkReportPendingRef.current.delete(key);
        u?.();
      }
    },
    [markPendingReportMutation],
  );
  const handleReportDeletingChange = useCallback(
    (deleting: boolean, editorId: string, addr: string) => {
      const key = `${editorId}:delete`;
      if (deleting) {
        unmarkReportPendingRef.current.set(
          key,
          markPendingReportMutation(addr),
        );
      } else {
        const u = unmarkReportPendingRef.current.get(key);
        unmarkReportPendingRef.current.delete(key);
        u?.();
      }
    },
    [markPendingReportMutation],
  );
  // Scope each latch to the *currently mounted* form instance, with
  // SEPARATE owner refs per flow. When the user navigates to another
  // `/address-book/<addr>` mid-write, the old form unmounts but its
  // in-flight Promise's `finally` still calls `onSavingChange(false,
  // oldFormId)` — without this guard, that stale callback would clear
  // the new form's latch mid-mutation. Save and delete need DISTINCT
  // owner refs: a single shared ref breaks when one flow starts on
  // form A, the user navigates to form B, and the OTHER flow starts
  // before A's request resolves. That second start would overwrite
  // the shared owner, so A's `false` callback would hit a mismatched
  // ID and never fire `setFormSaving(false)` — leaving `formSaving`
  // stuck true and the latch permanently held.
  const savingOwnerRef = useRef<string | null>(null);
  const deletingOwnerRef = useRef<string | null>(null);
  // Helpers wrap the provider's `markPendingMutation` (which returns
  // an `unmark` closure) so the matching `false` event can find and
  // call the right unmark. Updates BOTH the global pending ledger AND
  // the per-flow latch owner — owner is checked for stale-callback
  // dedup (round 7); ledger is checked on form mount for the
  // round-trip race (rounds 11 + 12). Both must move in lock-step.
  //
  // The unmark map is keyed by `${formId}:${op}` (not just formId)
  // because save and delete on the same mount can briefly overlap if
  // a fast double-click slips between React's state commit and the
  // button-disable render — using formId alone would let the second
  // op's `incPending` overwrite the first's unmark closure, leaking
  // a permanently-incremented count in the provider's ledger.
  const incPending = useCallback(
    (formId: string, op: "save" | "delete") => {
      const unmark = markPendingMutation(addressRef.current);
      unmarkPendingRef.current.set(`${formId}:${op}`, unmark);
    },
    [markPendingMutation],
  );
  const decPending = useCallback((formId: string, op: "save" | "delete") => {
    const key = `${formId}:${op}`;
    const unmark = unmarkPendingRef.current.get(key);
    unmarkPendingRef.current.delete(key);
    unmark?.();
  }, []);
  // The form passes its current address as the third arg —
  // identical to `addressRef.current` for the detail page (form
  // is keyed on URL param), so the helpers can use either. Add-new
  // modal callers in `AddressBookClient` use the parameter directly
  // because their `editTarget` is `null`.
  const handleSavingChange = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (saving: boolean, formId: string, _addr: string) => {
      if (saving) {
        savingOwnerRef.current = formId;
        setFormSaving(true);
        incPending(formId, "save");
      } else {
        // Always decrement pending — the request settled regardless of
        // whether the current latch owner matches.
        decPending(formId, "save");
        if (formId === savingOwnerRef.current) {
          savingOwnerRef.current = null;
          setFormSaving(false);
        }
      }
    },
    [incPending, decPending],
  );
  const handleDeletingChange = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (deleting: boolean, formId: string, _addr: string) => {
      if (deleting) {
        deletingOwnerRef.current = formId;
        setFormDeleting(true);
        incPending(formId, "delete");
      } else {
        decPending(formId, "delete");
        if (formId === deletingOwnerRef.current) {
          deletingOwnerRef.current = null;
          setFormDeleting(false);
        }
      }
    },
    [incPending, decPending],
  );

  // Reset the latch when the URL address changes. Prior round scoped
  // the OWNER refs per flow so stale callbacks couldn't release the
  // wrong latch — but the latch STATE itself (formSaving /
  // formDeleting / latchedFormSuffixRef) was global, so a save
  // started on form A kept `formMutating=true` after the user
  // navigated to B. When A's PUT eventually resolved, the legitimate
  // match cleared formSaving, the suffix latch refreshed from B's
  // data, and B's form remounted mid-edit (discarding in-progress
  // local state). Reset on address change: the new mount has no
  // in-flight mutations, so any old callbacks land on null owners
  // and are ignored. Uses React's "store information from previous
  // renders" pattern to avoid `setState`-in-useEffect.
  const prevAddressRef = useRef(address);
  if (prevAddressRef.current !== address) {
    prevAddressRef.current = address;
    if (formSaving) setFormSaving(false);
    if (formDeleting) setFormDeleting(false);
    savingOwnerRef.current = deletingOwnerRef.current = null;
    latchedFormSuffixRef.current = "";
  }

  const resolved = getEntry(address);
  const entry = resolved?.entry;
  const hasLabel = entry !== undefined;
  // Contract-row fallback: when no custom label exists, seed the form with
  // the static contract name (if any) so saving from this page doesn't
  // accidentally drop the registry-supplied display name. Mirrors the
  // modal flow in `AddressBookClient`.
  const formInitial = entry ?? findContractInitial(address);
  // When the address is registered under multiple disagreeing contract
  // names, `findContractInitial` returns undefined (skipping pre-fill),
  // but the form would otherwise treat the address as a non-contract
  // custom row and let the user save with only tags / notes — persisting
  // an empty global name that suppresses every disagreeing contract row
  // in the index. Force an explicit name for that case.
  const requireExplicitName = !entry && hasAmbiguousContractMatches(address);
  // Disable Save/Remove on this mount when there's a pending mutation
  // for THIS address from any prior mount — read from the provider so
  // the value survives this page's mount/unmount lifecycle (a user
  // who saved → bounced to /address-book → came back to /[A] before
  // the request settled would otherwise see a fresh empty ledger).
  const hasPendingForThisAddress = isMutationPending(address);

  // Pin the form's remount key during any in-flight local mutation
  // (save OR delete). Both `upsertEntry` and `deleteEntry` apply
  // optimistic SWR updates that flip the entry shape — saves bump
  // `entry.updatedAt`, deletes remove `entry` entirely — and the key
  // includes both signals (so teammate-side remote edits force a
  // remount that prevents a stale-state overwrite — codex round 4).
  // Without this latch, the in-flight form unmounts mid-PUT/DELETE and
  // a fresh one mounts with `saving=false`/`deleting=false`,
  // re-enabling Save / Remove for a window where a double-click could
  // submit overlapping writes despite the form's local guards.
  //
  // The latch is split: the address prefix always tracks the current
  // URL param, so navigating to a different address mid-save still
  // remounts the form (otherwise a wedged save on the previous
  // address could keep the sidebar editing it indefinitely). Only the
  // `entry`/`formInitial` suffix is latched. The ref is initialized to
  // `""` and populated on the first valid render — the empty initial
  // is never observed because `formSaving`/`formDeleting` both start
  // false, so `formKey` resolves to `liveFormSuffix` on first render.
  // Using a ref (vs. effect-synced state) avoids the
  // `setState`-in-`useEffect` derived-state anti-pattern — the
  // conditional write is idempotent within a frame, so concurrent
  // re-renders are safe.
  const formMutating = formSaving || formDeleting;
  // Suffix derivation. ALWAYS include a content fingerprint, not
  // just when `updatedAt` is empty. Reason: the import path can
  // preserve a non-empty `updatedAt` from a snapshot whose
  // name/tags/notes have since changed — a teammate restoring an
  // older backup, for example, hands SWR a row with the same
  // timestamp but different content. Without content in the key,
  // the form stays mounted with stale fields and a save overwrites
  // the imported data. The fingerprint uses `JSON.stringify` for
  // unambiguous encoding (collision-free vs. a free-form `|`/`,`
  // concat). Cost: an extra ~80 bytes in the key string per render —
  // imperceptible vs. the correctness gain.
  const liveFormSuffix = entry
    ? `custom:${entry.updatedAt}:${JSON.stringify([entry.name, entry.tags, entry.notes ?? "", entry.isPublic ?? false])}`
    : formInitial
      ? "contract"
      : "new";
  if (!formMutating) {
    latchedFormSuffixRef.current = liveFormSuffix;
  }
  const formKey = `${address}:${formMutating ? latchedFormSuffixRef.current : liveFormSuffix}`;

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
              SWR has resolved a real response (`hasLoaded`). The save path
              can't distinguish "no entry exists" from "we couldn't load
              the entry list", so a write during a never-loaded window is
              a data-loss footgun (would overwrite an existing entry with
              empty fields). Block the form in that pre-load error case.
              Same gating handles session-loading: the provider only
              fires SWR after `useSession()` reaches `authenticated`, so
              during session hydration `data` stays undefined →
              `hasLoaded === false` → form stays hidden.

              AFTER the first successful load, transient 30s-poll
              failures keep stale `data` in SWR (so `getEntry` still
              returns the prior entry) but flip `error`. We keep the
              form mounted in that case — unmounting would discard
              in-progress edits — and surface a non-destructive banner
              above it instead. The save path's optimistic update has
              the prior-known entry to merge against, same as it would
              between successful polls. */}
          {labelsError && !labelsLoaded ? (
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
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key
                <div key={`skel-${i}`} className="space-y-2">
                  <div className="h-3 w-20 animate-pulse rounded bg-slate-800/50" />
                  <div className="h-9 w-full animate-pulse rounded bg-slate-800/50" />
                </div>
              ))}
            </div>
          ) : (
            <>
              {labelsError && (
                <div
                  role="status"
                  aria-live="polite"
                  className="border-b border-amber-900/30 bg-amber-950/30 px-5 py-2 text-xs text-amber-300"
                >
                  {`Couldn't refresh labels (${labelsError.message}). Editing existing data — changes save against the last successful read.`}
                </div>
              )}
              <AddressLabelForm
                key={formKey}
                address={address}
                initial={formInitial}
                onSavingChange={handleSavingChange}
                onDeletingChange={handleDeletingChange}
                requireExplicitName={requireExplicitName}
                externallyDisabled={
                  !formSaving && !formDeleting && hasPendingForThisAddress
                }
              />
            </>
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
          <AddressReportEditor
            key={address}
            address={address}
            onSavingChange={handleReportSavingChange}
            onDeletingChange={handleReportDeletingChange}
            externallyDisabled={isReportMutationPending(address)}
          />
        </section>
      </div>

      <IntelPanels key={address} address={address} />
    </div>
  );
}
