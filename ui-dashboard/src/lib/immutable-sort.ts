/**
 * ES2023 `Array.prototype.toSorted` requires Safari 16+/Chrome 110+; the
 * dashboard's TS target is ES2017 with no polyfill (see the "Browser
 * target" section in `ui-dashboard/AGENTS.md`). This is the single
 * spread+sort implementation of that workaround — callers should use it
 * instead of hand-rolling `[...arr].sort(comparator)` at every call site.
 */
export function sortedCopy<T>(
  arr: readonly T[],
  comparator: (a: T, b: T) => number,
): T[] {
  // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
  return [...arr].sort(comparator);
}
