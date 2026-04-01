"use client";

interface PaginationProps {
  page: number; // 1-indexed
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const canPrev = page > 1;
  const canNext = page < totalPages;

  const btnBase =
    "px-2.5 py-1 text-xs font-medium rounded border transition-colors";
  const btnActive =
    "border-slate-600 text-slate-300 hover:border-indigo-500 hover:text-indigo-400";
  const btnDisabled = "border-slate-800 text-slate-600 cursor-not-allowed";

  return (
    <div className="flex items-center justify-between px-1 pt-2 pb-1">
      <span className="text-xs text-slate-500">
        {total.toLocaleString()} total &middot; page {page} of {totalPages}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          className={`${btnBase} ${canPrev ? btnActive : btnDisabled}`}
          onClick={() => canPrev && onPageChange(1)}
          disabled={!canPrev}
          aria-label="First page"
        >
          «
        </button>
        <button
          className={`${btnBase} ${canPrev ? btnActive : btnDisabled}`}
          onClick={() => canPrev && onPageChange(page - 1)}
          disabled={!canPrev}
          aria-label="Previous page"
        >
          ‹ Prev
        </button>
        <button
          className={`${btnBase} ${canNext ? btnActive : btnDisabled}`}
          onClick={() => canNext && onPageChange(page + 1)}
          disabled={!canNext}
          aria-label="Next page"
        >
          Next ›
        </button>
        <button
          className={`${btnBase} ${canNext ? btnActive : btnDisabled}`}
          onClick={() => canNext && onPageChange(totalPages)}
          disabled={!canNext}
          aria-label="Last page"
        >
          »
        </button>
      </div>
    </div>
  );
}
