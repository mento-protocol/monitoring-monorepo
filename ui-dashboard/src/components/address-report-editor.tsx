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
import { isValidAddress } from "@/lib/format";

type Props = {
  /** Address being edited. Empty string disables the form. */
  address: string;
  /**
   * Scope to save the report under. Resolved by the parent: prior-report
   * scope > label scope > "global" default. Read-only here in v1.
   */
  scope: Scope;
};

type SingleReportResponse = AddressReport & { scope: Scope };

async function fetchSingleReport(
  address: string,
): Promise<SingleReportResponse | null> {
  const res = await fetch(
    `/api/address-reports?address=${encodeURIComponent(address)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to fetch report: ${res.status}`);
  }
  return (await res.json()) as SingleReportResponse;
}

export function AddressReportEditor({ address, scope }: Props) {
  const trimmed = address.trim();
  const isAddressValid = isValidAddress(trimmed);
  const swrKey = isAddressValid
    ? `address-reports:single:${trimmed.toLowerCase()}`
    : null;

  const { data, isLoading, mutate } = useSWR<SingleReportResponse | null>(
    swrKey,
    () => fetchSingleReport(trimmed),
    { revalidateOnFocus: false, revalidateOnReconnect: false },
  );
  const { mutate: globalMutate } = useSWRConfig();

  // Hydrate form state when the fetched report changes (or arrives for the
  // first time). `recordKey` changes only on identity moves of the underlying
  // record — SWR background refetches that return identical data don't reset
  // user edits.
  const recordKey = data
    ? `${data.scope}:${data.updatedAt}:${data.version}`
    : "empty";
  const [title, setTitle] = useState(data?.title ?? "");
  const [body, setBody] = useState(data?.body ?? "");
  const [previewMode, setPreviewMode] = useState(Boolean(data));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Render-phase state reset — the React-recommended replacement for
  // `useEffect(() => setState(...), [key])` (see "you might not need
  // useEffect"). Avoids the double-commit + stale-flash that an effect
  // would introduce.
  const [seenRecordKey, setSeenRecordKey] = useState(recordKey);
  if (recordKey !== seenRecordKey) {
    setSeenRecordKey(recordKey);
    setTitle(data?.title ?? "");
    setBody(data?.body ?? "");
    setPreviewMode(Boolean(data));
    setError(null);
  }

  const hasExisting = data !== undefined && data !== null;
  const dirty =
    hasExisting && data
      ? body !== data.body || title !== (data.title ?? "")
      : body.trim() !== "" || title.trim() !== "";

  const bodyLen = body.length;
  const overLimit = bodyLen > MAX_BODY_LENGTH;

  const handleSave = useCallback(async () => {
    if (!isAddressValid) {
      setError("Address must be valid before saving a report.");
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
      const res = await fetch("/api/address-reports", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
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
    trimmed,
    isAddressValid,
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
        body: JSON.stringify({ scope: data.scope, address: trimmed }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errBody.error ?? `Delete failed: ${res.status}`);
      }
      await mutate(null, { revalidate: false });
      await globalMutate(ADDRESS_REPORTS_INDEX_SWR_KEY);
      setTitle("");
      setBody("");
      setPreviewMode(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeleting(false);
    }
  }, [data, hasExisting, trimmed, mutate, globalMutate]);

  if (!isAddressValid) {
    return (
      <div className="px-5 py-4 text-sm text-slate-400">
        Enter a valid address on the <strong>Label &amp; Tags</strong> tab
        before adding a forensic report.
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
                ? `v${data.version} · last edited ${formatRelative(data.updatedAt)}${
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

        {/* Scope display */}
        <div className="text-xs text-slate-500">
          Saved to scope:{" "}
          <span className="text-slate-300">
            {scope === "global" ? "All chains" : `Chain ${scope}`}
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
            disabled={saving || deleting || overLimit || !dirty}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : hasExisting ? "Save changes" : "Save report"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
