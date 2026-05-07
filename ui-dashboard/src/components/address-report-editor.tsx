"use client";

import { useState, useCallback } from "react";
import useSWR, { useSWRConfig } from "swr";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ADDRESS_REPORTS_INDEX_SWR_KEY } from "@/hooks/use-address-reports-index";
import {
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  type AddressReport,
} from "@/lib/address-reports-shared";
import type { Scope } from "@/lib/address-labels-shared";
import { isValidAddress, relativeTimeFromIso } from "@/lib/format";

type Props = {
  /** Address being edited. Empty string disables the form. */
  address: string;
  /**
   * Scope to use for NEW reports (the parent label tab's currently-selected
   * scope). Edits to existing reports preserve `data.scope` instead — see
   * `effectiveScope` in `handleSave` — so a report saved at "global" never
   * silently moves when the user opens the modal from a per-chain row.
   */
  scope: Scope;
};

type SingleReportResponse = AddressReport & { scope: Scope };

async function fetchSingleReport(
  address: string,
  scope: Scope,
): Promise<SingleReportResponse | null> {
  // Pass the row's scope so the server applies the same chain → global
  // fallback as the 📄 indicator. Without this, opening 0xABC from a Monad
  // row could load 0xABC's Celo report.
  const params = new URLSearchParams({
    address,
    scope: String(scope),
  });
  const res = await fetch(`/api/address-reports?${params.toString()}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to fetch report: ${res.status}`);
  }
  return (await res.json()) as SingleReportResponse;
}

export function AddressReportEditor({ address, scope }: Props) {
  const trimmed = address.trim();
  const normalizedAddress = trimmed.toLowerCase();
  const isAddressValid = isValidAddress(trimmed);
  // Include scope in the SWR key so opening the same address from a global
  // row vs a per-chain row doesn't share a stale cache entry pointing at
  // the wrong scope's report.
  const swrKey = isAddressValid
    ? `address-reports:single:${normalizedAddress}:${scope}`
    : null;

  const {
    data,
    isLoading,
    error: loadError,
    mutate,
  } = useSWR<SingleReportResponse | null>(
    swrKey,
    () => fetchSingleReport(trimmed, scope),
    { revalidateOnFocus: false, revalidateOnReconnect: false },
  );
  const { mutate: globalMutate } = useSWRConfig();

  // Hydrate form state when the fetched report changes (or arrives for the
  // first time). `recordKey` changes only on identity moves of the underlying
  // record — SWR background refetches that return identical data don't reset
  // user edits. The empty-state key includes the normalized address so a
  // user typing in the new-address flow doesn't carry a draft from one
  // address into the next when both happen to be empty.
  const recordKey = data
    ? `${data.scope}:${data.updatedAt}:${data.version}`
    : `empty:${normalizedAddress}`;
  const [title, setTitle] = useState(data?.title ?? "");
  const [body, setBody] = useState(data?.body ?? "");
  const [previewMode, setPreviewMode] = useState(Boolean(data));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seenRecordKey, setSeenRecordKey] = useState(recordKey);
  if (recordKey !== seenRecordKey) {
    setSeenRecordKey(recordKey);
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
    setSaving(true);
    setError(null);
    try {
      // Edits preserve the report's existing scope; new reports go to the
      // parent label tab's selected scope. Without this, editing a global
      // report from a per-chain row (where the indicator surfaces it via
      // the chain → global fallback) would silently move it to the chain
      // scope on the first save.
      const effectiveScope = data?.scope ?? scope;
      const res = await fetch("/api/address-reports", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({
          scope: effectiveScope,
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
        report: SingleReportResponse;
      };
      await mutate(out.report, { revalidate: false });
      // Invalidate OTHER per-scope SWR aliases for this address (not the
      // current key — the local mutate above already set that to fresh
      // data, and including it would clobber back to undefined). The same
      // record can be cached under multiple keys (e.g. `:global` from the
      // global row and `:42220` from a chain row via the chain → global
      // fallback). Without this, opening a different row after save would
      // serve a stale body until the local SWR revalidates.
      // Pass the editor's `scope` prop (matches the local SWR key suffix),
      // NOT `effectiveScope` (the report's persisted scope). When a global
      // report is opened from a chain row via the chain→global fallback,
      // these differ — using `effectiveScope` would exclude `:global` from
      // the predicate while the actual local key is `:42220`, clobbering
      // the just-saved local cache to undefined and stranding the editor.
      await invalidateOtherAddressAliases(
        globalMutate,
        normalizedAddress,
        scope,
      );
      // Refresh the index so the address-book 📄 indicator picks up the new
      // entry without waiting for the next poll cycle.
      await globalMutate(ADDRESS_REPORTS_INDEX_SWR_KEY);
      setPreviewMode(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [
    body,
    title,
    scope,
    data,
    trimmed,
    normalizedAddress,
    isAddressValid,
    isLookupPending,
    overLimit,
    bodyLen,
    mutate,
    globalMutate,
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
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/address-reports", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({ scope: data.scope, address: trimmed }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errBody.error ?? `Delete failed: ${res.status}`);
      }
      await mutate(null, { revalidate: false });
      // Same alias-invalidation key choice as save — use the editor's
      // `scope` prop (matches the local SWR key) to exclude the just-set
      // null. `data.scope` would point at the persisted scope, which can
      // differ from the local key when the report was viewed via the
      // chain→global fallback.
      await invalidateOtherAddressAliases(
        globalMutate,
        normalizedAddress,
        scope,
      );
      await globalMutate(ADDRESS_REPORTS_INDEX_SWR_KEY);
      setTitle("");
      setBody("");
      setPreviewMode(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeleting(false);
    }
  }, [data, hasExisting, trimmed, normalizedAddress, mutate, globalMutate]);

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
    <div className="flex flex-col">
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

        {/* Scope display — mirrors the save logic so the user sees the
            actual destination (existing report's scope, or label tab's scope
            for new reports). */}
        <div className="text-xs text-slate-500">
          Saved to scope:{" "}
          <span className="text-slate-300">
            {(() => {
              const s = data?.scope ?? scope;
              return s === "global" ? "All chains" : `Chain ${s}`;
            })()}
          </span>
        </div>

        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
      </div>

      {/* Footer actions */}
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
            // new-report code path (parent prop scope) and overwrites the
            // existing report on save.
            disabled={
              saving || deleting || overLimit || !dirty || isLookupPending
            }
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : hasExisting ? "Save changes" : "Save report"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Invalidate every OTHER per-scope SWR alias for a given address (the caller's
 * current scope is excluded — they've already updated that key with the
 * authoritative new value via the local `mutate`, so including it here would
 * clobber back to undefined).
 *
 * The single-report SWR key encodes scope
 * (`address-reports:single:${addr}:${scope}`), so the same persisted record
 * can be cached under multiple keys when the user opens it from different
 * rows. Call this after any write/delete so future re-mounts of a different
 * scope row never serve a stale alias.
 *
 * Note for reviewers: passing `undefined` as the second arg with
 * `{ revalidate: false }` IS a real cache clear in SWR v2.4 — the
 * `populateCache: true` default routes through `set({ data: undefined, … })`
 * (see `config-context-12s-CCVTDPOP.mjs` ~line 355). It is NOT the
 * "do nothing" no-op some SWR docs imply for two-arg `mutate(key, undefined)`.
 */
function invalidateOtherAddressAliases(
  globalMutate: ReturnType<typeof useSWRConfig>["mutate"],
  normalizedAddress: string,
  currentScope: Scope,
): Promise<unknown> {
  const prefix = `address-reports:single:${normalizedAddress}:`;
  const currentKey = `${prefix}${currentScope}`;
  return globalMutate(
    (key) =>
      typeof key === "string" && key.startsWith(prefix) && key !== currentKey,
    undefined,
    { revalidate: false },
  );
}
