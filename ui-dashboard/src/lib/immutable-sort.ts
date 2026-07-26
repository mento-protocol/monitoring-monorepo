/**
 * ES2023 `Array.prototype.toSorted` is unavailable in Firefox 111–114, which
 * is inside the dashboard's browser floor (see `ui-dashboard/AGENTS.md`).
 * This is the single spread+sort implementation of that workaround — callers
 * should use it instead of hand-rolling `[...arr].sort(comparator)` at every
 * call site.
 */
export function sortedCopy<T>(
  arr: readonly T[],
  comparator: (a: T, b: T) => number,
): T[] {
  // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
  return [...arr].sort(comparator);
}
