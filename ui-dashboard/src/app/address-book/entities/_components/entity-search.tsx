"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { TagPills } from "@/components/tag-pills";
import type { EntityDirectoryItem } from "../_lib/entity-directory";

const PAGE_SIZE = 100;
const TABLE_HEADERS = ["Entity", "Type", "Tags", "Addresses", "Slug"] as const;

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

function EntityDirectoryRow({ item }: { item: EntityDirectoryItem }) {
  return (
    <tr
      data-entity-slug={item.slug}
      className="group relative border-b border-slate-800 transition-colors last:border-b-0 hover:bg-slate-800/30"
    >
      <td className="px-4 py-3">
        <Link
          href={`/address-book/entities/${item.slug}`}
          aria-label={`Open ${item.name}`}
          className="absolute inset-0 z-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500"
        />
        <span className="relative z-10 block max-w-[240px] truncate font-medium text-slate-300 pointer-events-none group-hover:text-white">
          {item.name}
        </span>
      </td>
      <td className="relative z-10 px-4 py-3 pointer-events-none">
        {item.type ? (
          <span className="inline-flex items-center rounded-full bg-slate-700 px-2 py-0.5 text-xs font-medium text-slate-300 whitespace-nowrap">
            {item.type}
          </span>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </td>
      <td className="relative z-10 max-w-[280px] px-4 py-3 pointer-events-none">
        {item.tags.length > 0 ? (
          <TagPills tags={item.tags} />
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </td>
      <td className="relative z-10 px-4 py-3 text-right tabular-nums text-slate-300 pointer-events-none">
        {item.addressCount.toLocaleString()}
      </td>
      <td className="relative z-10 max-w-[240px] truncate px-4 py-3 font-mono text-xs text-slate-400 pointer-events-none">
        {item.slug}
      </td>
    </tr>
  );
}

function EntityDirectoryResults({ items }: { items: EntityDirectoryItem[] }) {
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-slate-800 px-4 py-8 text-center text-sm text-slate-400">
        No entities match your search.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/50">
            {TABLE_HEADERS.map((header) => (
              <th
                key={header}
                className={`px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 ${
                  header === "Addresses" ? "text-right" : ""
                }`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <EntityDirectoryRow key={item.slug} item={item} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EntitySearch({
  items,
  addressSearchLimit,
}: {
  items: EntityDirectoryItem[];
  addressSearchLimit: number;
}) {
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
  const normalizedQuery = query.trim();

  const updateQuery = useCallback((next: string) => {
    setQuery(next);
    setPage(1);
    writeUrl(next.trim(), 1);
  }, []);

  const updatePage = useCallback(
    (next: number) => {
      setPage(next);
      writeUrl(normalizedQuery, next);
    },
    [normalizedQuery],
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

  const lower = normalizedQuery.toLowerCase();
  const filtered = lower
    ? items.filter((item) => item.searchText.includes(lower))
    : items;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.max(1, Math.min(page, totalPages));

  // Canonicalize the URL so deep links like `?page=999`, `?page=foo`, or
  // `?page=1` (default) don't leave the address bar advertising a different
  // view than the rendered one — refresh / share would otherwise replay the
  // stale params instead of the visible state. Pattern mirrors
  // `use-table-sort.ts:156-174` mount-time canonicalization and the
  // bridge-flows pager `page=1` URL-clearing test. We don't touch `page`
  // state — `clampedPage` is recomputed per render, so a transient
  // state.page > totalPages is harmless until the next user action
  // (typing, Next/Prev, popstate) re-syncs it. Avoids `effect/no-derived-
  // state` which fires when a useEffect writes state derivable in render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const rawQuery = params.get("q");
    const rawPage = params.get("page");
    const expectedQuery = normalizedQuery || null;
    const expectedPage = clampedPage <= 1 ? null : String(clampedPage);
    if (rawQuery === expectedQuery && rawPage === expectedPage) return;
    writeUrl(normalizedQuery, clampedPage);
  }, [normalizedQuery, clampedPage]);
  const visible = filtered.slice(
    (clampedPage - 1) * PAGE_SIZE,
    clampedPage * PAGE_SIZE,
  );

  return (
    <div>
      <div className="mb-4">
        <input
          type="search"
          aria-label="Search entities"
          placeholder="Search by name, slug, type, tag, or address…"
          value={query}
          onChange={(e) => updateQuery(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>
      <p className="mb-2 text-xs text-slate-400">
        {filtered.length.toLocaleString()} entities
        {normalizedQuery ? ` matching "${normalizedQuery}"` : ""}
        <span className="block sm:inline">
          {" "}
          · Address search covers up to {addressSearchLimit.toLocaleString()}{" "}
          addresses per entity.
        </span>
      </p>
      <EntityDirectoryResults items={visible} />
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
      <span className="text-xs text-slate-400">
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
