"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

const PAGE_SIZE = 100;

function readQueryFromParams(params: URLSearchParams): string {
  return params.get("q") ?? "";
}

function readPageFromParams(params: URLSearchParams): number {
  const raw = params.get("page");
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function writeUrl(nextQuery: string, nextPage: number): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (nextQuery) params.set("q", nextQuery);
  else params.delete("q");
  if (nextPage <= 1) params.delete("page");
  else params.set("page", String(nextPage));
  const qs = params.toString();
  const nextUrl =
    window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  window.history.replaceState(window.history.state, "", nextUrl);
}

// Read the current URL search params, preferring `window.location` once
// hydrated so our own `replaceState` writes are visible. Falls back to the
// SSR-snapshot `useSearchParams` value during the server pass.
function readInitParams(searchParams: URLSearchParams): URLSearchParams {
  if (typeof window !== "undefined") {
    return new URLSearchParams(window.location.search);
  }
  return searchParams;
}

export function EntitySearch({ slugs }: { slugs: string[] }) {
  // SSR-pass only; layout already wraps in <Suspense> (`app/layout.tsx:56`).
  // react-doctor-disable-next-line react-doctor/nextjs-no-use-search-params-without-suspense
  const searchParams = useSearchParams();
  // Lazy init via `readInitParams` (matches `intel-transfers.tsx`).
  const [query, setQuery] = useState<string>(() =>
    readQueryFromParams(readInitParams(searchParams)),
  );
  const [page, setPage] = useState<number>(() =>
    readPageFromParams(readInitParams(searchParams)),
  );

  const updateQuery = useCallback((next: string) => {
    setQuery(next);
    setPage(1);
    writeUrl(next, 1);
  }, []);

  const updatePage = useCallback(
    (next: number) => {
      setPage(next);
      writeUrl(query, next);
    },
    [query],
  );

  // `setQuery` and `setPage` below dispatch from a single popstate event, so
  // React's auto-batching collapses them to one re-render.
  // react-doctor-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      setQuery((prev) => {
        const next = readQueryFromParams(params);
        return prev === next ? prev : next;
      });
      setPage((prev) => {
        const next = readPageFromParams(params);
        return prev === next ? prev : next;
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const lower = query.toLowerCase();
  const filtered = query
    ? slugs.filter((s) => s.toLowerCase().includes(lower))
    : slugs;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.max(1, Math.min(page, totalPages));

  // Canonicalize the URL so deep links like `?page=999`, `?page=foo`, or
  // `?page=1` (default) don't leave the address bar advertising a different
  // view than the rendered one. Cursor PR #653 (review id 4381935282)
  // flagged this — refresh / share otherwise replay the stale params instead
  // of the visible state. Pattern mirrors `use-table-sort.ts:156-174` mount-
  // time canonicalization and the bridge-flows pager `page=1` URL-clearing
  // test. We don't touch `page` state — `clampedPage` is recomputed per
  // render, so a transient state.page > totalPages is harmless until the
  // next user action (typing, Next/Prev, popstate) re-syncs it. Avoids the
  // `effect/no-derived-state` lint that fires when a useEffect writes state
  // derivable in render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const rawQuery = params.get("q");
    const rawPage = params.get("page");
    const expectedQuery = query ? query : null;
    const expectedPage = clampedPage <= 1 ? null : String(clampedPage);
    if (rawQuery === expectedQuery && rawPage === expectedPage) return;
    writeUrl(query, clampedPage);
  }, [query, clampedPage]);
  const visible = filtered.slice(
    (clampedPage - 1) * PAGE_SIZE,
    clampedPage * PAGE_SIZE,
  );

  return (
    <div>
      <input
        type="search"
        aria-label="Search entities"
        placeholder="Search entities…"
        value={query}
        onChange={(e) => updateQuery(e.target.value)}
        className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
      />
      <p className="mb-2 text-xs text-slate-500">
        {filtered.length.toLocaleString()} entities
        {query ? ` matching "${query}"` : ""}
      </p>
      <ul className="space-y-1">
        {visible.map((slug) => (
          <li key={slug}>
            <Link
              href={`/entities/${slug}`}
              className="block rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
            >
              {slug}
            </Link>
          </li>
        ))}
      </ul>
      <EntityPager
        page={clampedPage}
        totalPages={totalPages}
        onChange={updatePage}
      />
    </div>
  );
}

function EntityPager({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (next: number) => void;
}) {
  if (totalPages <= 1) return null;
  const btn =
    "rounded border border-slate-600 px-2.5 py-1 text-xs text-slate-300 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-600 hover:border-indigo-500 hover:text-indigo-400";
  return (
    <div className="mt-4 flex items-center justify-between">
      <span className="text-xs text-slate-500">
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page === 1}
          className={btn}
        >
          &laquo; Prev
        </button>
        <button
          type="button"
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          className={btn}
        >
          Next &raquo;
        </button>
      </div>
    </div>
  );
}
