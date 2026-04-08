/**
 * Info icon with a native tooltip explaining which pools are included
 * in the volume figures. Rendered inline next to "Volume" column headers.
 */
export function VolumeInfo() {
  return (
    <span
      title="Volume is only tracked for pools that have a USDm token pair. Pools without a USDm leg show '—'."
      className="inline-flex items-center text-slate-500 hover:text-slate-300 cursor-help"
    >
      <svg
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="size-3.5"
      >
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z"
          clipRule="evenodd"
        />
      </svg>
    </span>
  );
}
