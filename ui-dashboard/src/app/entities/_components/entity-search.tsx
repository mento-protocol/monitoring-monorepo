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

export function EntitySearch({ slugs }: { slugs: string[] }) {
  // `useSearchParams` is used only for the SSR-pass fallback. The root layout
  // already wraps the tree in <Suspense> (`app/layout.tsx:56`), satisfying the
  // rule transitively — the static check just can't see across files.
  // react-doctor-disable-next-line react-doctor/nextjs-no-use-search-params-without-suspense
  const searchParams = useSearchParams();
  const initialParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : searchParams;
  const [query, setQuery] = useState<string>(() =>
    readQueryFromParams(initialParams),
  );
  const [page, setPage] = useState<number>(() =>
    readPageFromParams(initialParams),
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
  const visible = filtered.slice(
    (clampedPage - 1) * PAGE_SIZE,
    clampedPage * PAGE_SIZE,
  );

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateQuery(e.target.value);
  };

  return (
    <div>
      <input
        type="search"
        aria-label="Search entities"
        placeholder="Search entities…"
        value={query}
        onChange={handleQueryChange}
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
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            Page {clampedPage} of {totalPages}
          </span>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => updatePage(Math.max(1, clampedPage - 1))}
              disabled={clampedPage === 1}
              className="rounded border border-slate-600 px-2.5 py-1 text-xs text-slate-300 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-600 hover:border-indigo-500 hover:text-indigo-400"
            >
              &laquo; Prev
            </button>
            <button
              type="button"
              onClick={() => updatePage(Math.min(totalPages, clampedPage + 1))}
              disabled={clampedPage === totalPages}
              className="rounded border border-slate-600 px-2.5 py-1 text-xs text-slate-300 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-600 hover:border-indigo-500 hover:text-indigo-400"
            >
              Next &raquo;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
