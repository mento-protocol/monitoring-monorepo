"use client";

import { useRef, useState, useCallback } from "react";
import useSWR, { useSWRConfig } from "swr";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ADDRESS_REPORTS_INDEX_SWR_KEY } from "@/hooks/use-address-reports-index";
import {
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  type AddressReport,
} from "@/lib/address-reports-shared";
import { isValidAddress, relativeTimeFromIso } from "@/lib/format";

type Props = {
  /** Address being edited. Empty string disables the form. */
  address: string;
  /**
   * Fires when an in-flight report save begins / ends. Used by host
   * surfaces (detail page, AddressLabelEditor modal) to mark the
   * write in `AddressLabelsProvider`'s pending ledger so a second
   * surface mounted for the same address sees the in-flight state
   * and can block competing writes. `editorId` is a per-mount token
   * — same per-mount-token pattern as `AddressLabelForm`'s `formId`.
   * `address` is the editor's current `address` prop (which the modal
   * may swap as the user types into the new-address input on the
   * Label tab); the host uses it to mark the right pending entry.
   */
  onSavingChange?: (saving: boolean, editorId: string, address: string) => void;
  /** Same as `onSavingChange` but for the delete flow. */
  onDeletingChange?: (
    deleting: boolean,
    editorId: string,
    address: string,
  ) => void;
  /**
   * When true, all controls (title input, body textarea, view/edit
   * toggle, Save, Delete) are disabled. Used by the host when there's
   * already a pending report mutation for this address from another
   * surface — without this, the user could type into the inputs and
   * lose those edits the moment the in-flight request settles and
   * the SWR record-key updates.
   */
  externallyDisabled?: boolean;
};

async function fetchSingleReport(
  address: string,
): Promise<AddressReport | null> {
  const res = await fetch(
    `/api/address-reports?address=${encodeURIComponent(address)}`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to fetch report: ${res.status}`);
  }
  return (await res.json()) as AddressReport;
}

function fingerprintReportContent(report: AddressReport): string {
  const content = JSON.stringify([report.title ?? "", report.body]);
  let hash = 2166136261;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

// 6 useState calls — independent fields plus orthogonal flow flags;
// a reducer would just rename the setters. The component is intentionally kept
// together because save/delete ownership and preview state share one form.
// react-doctor-disable-next-line react-doctor/prefer-useReducer, react-doctor/no-giant-component
export function AddressReportEditor(props: Props) {
  const { address, onSavingChange, onDeletingChange, externallyDisabled } =
    props;
  const trimmed = address.trim();
  const normalizedAddress = trimmed.toLowerCase();
  const isAddressValid = isValidAddress(trimmed);
  const swrKey = isAddressValid
    ? `address-reports:single:${normalizedAddress}`
    : null;

  const {
    data,
    isLoading,
    error: loadError,
    mutate,
  } = useSWR<AddressReport | null>(swrKey, () => fetchSingleReport(trimmed), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
  const { mutate: globalMutate } = useSWRConfig();

  // Hydrate form state when the fetched report changes (or arrives for the
  // first time). `recordKey` changes only on identity moves of the underlying
  // record — SWR background refetches that return identical data don't reset
  // user edits. Include the normalized address and editable-content fingerprint
  // so a same-mounted editor never carries one address's draft into another
  // address whose existing report happens to share updatedAt/version.
  const recordKey = data
    ? `existing:${normalizedAddress}:${data.updatedAt}:${data.version}:${fingerprintReportContent(data)}`
    : `empty:${normalizedAddress}`;
  const [title, setTitle] = useState(data?.title ?? "");
  const [body, setBody] = useState(data?.body ?? "");
  const [previewMode, setPreviewMode] = useState(Boolean(data));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-mount identity used to scope `onSavingChange` / `onDeletingChange`
  // callbacks at the host level (mirrors `AddressLabelForm`'s formId
  // pattern). Counter-backed (not `useId`) so a fresh mount at the
  // same React tree slot gets a real per-mount token.
  const editorInstanceIdRef = useRef<string | null>(null);
  if (editorInstanceIdRef.current === null) {
    editorInstanceIdRef.current = `report-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
  const editorInstanceId = editorInstanceIdRef.current;
  // Synchronous in-flight guards. Without them a fast double-click
  // can fire `handleSave` / `handleDelete` twice from the same mount
  // (React's `setSaving(true)` is async); both calls would emit
  // `onSavingChange(true, editorId)` and the host's `${editorId}:save`
  // unmark slot would be overwritten after incrementing the provider
  // ledger twice — only one decrement runs and the address stays
  // permanently report-pending.
  const inFlightRef = useRef({ saving: false, deleting: false });
  const seenRecordKeyRef = useRef(recordKey);
  if (recordKey !== seenRecordKeyRef.current) {
    seenRecordKeyRef.current = recordKey;
    setTitle(data?.title ?? "");
    setBody(data?.body ?? "");
    setPreviewMode(Boolean(data));
    setError(null);
  }

  const hasExisting = data !== undefined && data !== null;
  const isLookupPending = data === undefined && !loadError;
  const dirty = isLookupPending
    ? false
    : hasExisting && data
      ? body !== data.body || title !== (data.title ?? "")
      : body.trim() !== "" || title.trim() !== "";

  const bodyLen = body.length;
  const overLimit = bodyLen > MAX_BODY_LENGTH;

  const handleSave = useCallback(async () => {
    if (!isAddressValid) {
      setError("Address must be valid before saving a report.");
      return;
    }
    if (isLookupPending) {
      setError("Still loading the existing report. Please wait a moment.");
      return;
    }
    if (overLimit) {
      setError(`Body is too long (${bodyLen} / ${MAX_BODY_LENGTH}).`);
      return;
    }
    if (body.trim() === "") {
      setError("Body cannot be empty.");
      return;
    }
    // Cross-op gate — same rationale as `AddressLabelForm`'s save
    // guard: a fast Save→Delete sequence would otherwise overlap
    // PUT and DELETE on the same record.
    if (inFlightRef.current.saving || inFlightRef.current.deleting) return;
    inFlightRef.current.saving = true;
    setSaving(true);
    onSavingChange?.(true, editorInstanceId, trimmed);
    setError(null);
    let saved = false;
    try {
      const res = await fetch("/api/address-reports", {
        method: "PUT",
        headers: reportSaveHeaders(data),
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({
          address: trimmed,
          body,
          title: title.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errBody.error ?? `Save failed: ${res.status}`);
      }
      const out = (await res.json()) as {
        ok: boolean;
        report: AddressReport;
      };
      await mutate(out.report, { revalidate: false });
      saved = true;
      setPreviewMode(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
      onSavingChange?.(false, editorInstanceId, trimmed);
      inFlightRef.current.saving = false;
    }

    // Failures here do NOT undo the save; transient SWR mutate failures
    // shouldn't be surfaced as "Save failed".
    if (saved) {
      try {
        // Refresh the index so the address-book 📄 indicator picks up the
        // new entry without waiting for the next poll cycle.
        await globalMutate(ADDRESS_REPORTS_INDEX_SWR_KEY);
      } catch (e) {
        console.warn(
          "[address-report-editor] post-save index refresh failed (save itself succeeded):",
          e,
        );
      }
    }
  }, [
    body,
    title,
    trimmed,
    data,
    isAddressValid,
    isLookupPending,
    overLimit,
    bodyLen,
    mutate,
    globalMutate,
    onSavingChange,
    editorInstanceId,
  ]);

  const handleDelete = useCallback(async () => {
    if (!hasExisting || !data) return;
    if (
      !window.confirm(
        "Delete this forensic report? This is permanent — no version history yet.",
      )
    ) {
      return;
    }
    if (inFlightRef.current.saving || inFlightRef.current.deleting) return;
    inFlightRef.current.deleting = true;
    setDeleting(true);
    onDeletingChange?.(true, editorInstanceId, trimmed);
    setError(null);
    let deleted = false;
    try {
      const res = await fetch("/api/address-reports", {
        method: "DELETE",
        headers: reportMutationHeaders(data),
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({ address: trimmed }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errBody.error ?? `Delete failed: ${res.status}`);
      }
      await mutate(null, { revalidate: false });
      deleted = true;
      setTitle("");
      setBody("");
      setPreviewMode(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeleting(false);
      onDeletingChange?.(false, editorInstanceId, trimmed);
      inFlightRef.current.deleting = false;
    }

    if (deleted) {
      try {
        await globalMutate(ADDRESS_REPORTS_INDEX_SWR_KEY);
      } catch (e) {
        console.warn(
          "[address-report-editor] post-delete index refresh failed (delete itself succeeded):",
          e,
        );
      }
    }
  }, [
    data,
    hasExisting,
    trimmed,
    mutate,
    globalMutate,
    onDeletingChange,
    editorInstanceId,
  ]);

  if (!isAddressValid) {
    return (
      <div className="px-5 py-4 text-sm text-slate-400">
        Enter a valid address on the <strong>Label &amp; Tags</strong> tab
        before adding a forensic report.
      </div>
    );
  }

  // Surface read failures explicitly. Without this, a Redis/Upstash hiccup
  // collapses into the same "No report yet" copy as a genuinely empty
  // record — the user might then type a fresh body and silently overwrite
  // the existing report on save (the Lua upsert preserves createdAt + bumps
  // version, so data isn't destroyed, but body content IS).
  if (loadError && !data) {
    return (
      <div className="px-5 py-4 space-y-3">
        <p role="alert" className="text-sm text-red-400">
          Could not load this report:{" "}
          <span className="font-mono text-xs">
            {loadError instanceof Error ? loadError.message : String(loadError)}
          </span>
        </p>
        <button
          type="button"
          onClick={() => mutate()}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500 hover:text-white transition-colors"
        >
          Retry
        </button>
        <p className="text-xs text-slate-500">
          The Forensic Report tab is disabled while the read fails — close and
          reopen the modal once the issue is resolved.
        </p>
      </div>
    );
  }

  return (
    <fieldset
      disabled={externallyDisabled || saving || deleting}
      className="flex flex-col border-0 p-0 m-0 disabled:opacity-60"
    >
      <div className="px-5 py-4 space-y-3">
        {/* Status row */}
        <div className="flex items-center justify-between text-xs">
          <div className="text-slate-400">
            {isLoading
              ? "Loading…"
              : hasExisting && data
                ? `v${data.version} · last edited ${relativeTimeFromIso(data.updatedAt)}${
                    data.authorEmail ? ` by ${data.authorEmail}` : ""
                  }`
                : "No report yet — write one below."}
          </div>
          {hasExisting && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPreviewMode(false)}
                disabled={!previewMode}
                className={`rounded px-2 py-1 transition-colors ${
                  !previewMode
                    ? "bg-slate-800 text-white"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode(true)}
                disabled={previewMode}
                className={`rounded px-2 py-1 transition-colors ${
                  previewMode
                    ? "bg-slate-800 text-white"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Preview
              </button>
            </div>
          )}
        </div>

        {/* Title */}
        {!previewMode && (
          <div>
            <label
              htmlFor="ar-title"
              className="block text-xs font-medium text-slate-400 mb-1"
            >
              Title <span className="text-slate-500">(optional)</span>
            </label>
            <input
              id="ar-title"
              type="text"
              maxLength={MAX_TITLE_LENGTH}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Multi-DEX arb bot (idontloseiwin.eth)"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
        )}

        {/* Body */}
        {previewMode ? (
          <div className="min-h-[200px] max-h-[60vh] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 px-4 py-3">
            {body.trim() ? (
              <MarkdownRenderer>{body}</MarkdownRenderer>
            ) : (
              <p className="text-sm text-slate-500">
                Empty — switch to Edit to write the report.
              </p>
            )}
            {title.trim() && (
              <p className="mt-3 border-t border-slate-800 pt-2 text-xs text-slate-500">
                Title: <span className="text-slate-400">{title}</span>
              </p>
            )}
          </div>
        ) : (
          <div>
            <label
              htmlFor="ar-body"
              className="block text-xs font-medium text-slate-400 mb-1"
            >
              Markdown body{" "}
              <span className={overLimit ? "text-red-400" : "text-slate-500"}>
                ({bodyLen.toLocaleString()} / {MAX_BODY_LENGTH.toLocaleString()}
                )
              </span>
            </label>
            <textarea
              id="ar-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={18}
              placeholder="# TL;DR&#10;&#10;Multi-DEX arb bot operated by …&#10;&#10;## Cast of characters&#10;…"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 placeholder-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
            />
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-slate-800 px-5 py-4">
        <div>
          {hasExisting && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting || saving}
              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
            >
              {deleting ? "Deleting…" : "Delete report"}
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSave}
            // Block while the initial lookup is pending — without this, the
            // user can type into the form before SWR returns and trigger
            // handleSave with `data === undefined`, which then takes the
            // new-report code path and overwrites the existing report.
            disabled={saving || deleting || overLimit || !dirty || isLoading}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : hasExisting ? "Save changes" : "Save report"}
          </button>
        </div>
      </div>
    </fieldset>
  );
}

function reportSaveHeaders(
  report: AddressReport | null | undefined,
): Record<string, string> {
  return reportMutationHeaders(report);
}

function reportMutationHeaders(
  report: AddressReport | null | undefined,
): Record<string, string> {
  return report === undefined || report === null
    ? { "Content-Type": "application/json" }
    : { "Content-Type": "application/json", "If-Match": `"${report.version}"` };
}
