"use client";

import { useState } from "react";
import Link from "next/link";

const PAGE_SIZE = 100;

export function EntitySearch({ slugs }: { slugs: string[] }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

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
    setQuery(e.target.value);
    setPage(1);
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
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={clampedPage === 1}
              className="rounded border border-slate-600 px-2.5 py-1 text-xs text-slate-300 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-600 hover:border-indigo-500 hover:text-indigo-400"
            >
              &laquo; Prev
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
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
