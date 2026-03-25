# Review: feat/global-pool-table

Base branch: `main`
Reviewed: 2026-03-25

---

## Pass 1

### Found and fixed

**Warning — `WORK.md` committed (development debris)**
`WORK.md` is an 85-line implementation work log (task tracking, phase notes) committed as part of the feature branch. Not documentation — not appropriate for `main`.
→ **Fixed**: deleted `WORK.md`.

**Warning — `anyVolume24hError` regression in `page.tsx`**
When any single chain's snapshot query fails, `anyVolume24hError = true` was being passed as `volume24hError={anyVolume24hError}` to `GlobalPoolsTable`. This caused every row — including rows from healthy chains — to display "N/A" for 24h volume.

The `volMap` already stores `null` per pool for chains with snapshot errors. The rendering logic `vol24h === null ? "N/A"` already handles per-pool N/A correctly without the global flag. Passing the global flag was strictly worse than the original per-chain behavior.
→ **Fixed**: removed `anyVolume24hError` from the `useMemo` return and removed it from the `GlobalPoolsTable` call site (`volume24hLoading` and `volume24hError` both now left as defaults).

---

## Pass 2

No new findings. The Pass 1 fixes are correct and introduce no regressions:

- `GlobalPoolsTableProps` has both `volume24hLoading` and `volume24hError` as optional with `false` defaults — removing them from the call site is type-safe.
- The `global-pools-table.test.tsx` tests for `volume24hError={true}` still exercise the prop correctly (the prop still exists, just not passed from `page.tsx`).
- The `page.test.tsx` mocks `GlobalPoolsTable` entirely, so prop changes don't affect those tests.

---

## Pass 3

Clean. No further findings.

---

## Remaining nits (not fixed)

1. **`perChainVolMap` built but unused in error path** (`page.tsx:126-129`): When `snapshotsError !== null`, an empty `Map` is constructed as `perChainVolMap` but never read (the loop body uses the `snapshotsError !== null` branch directly). Harmless but slightly noisy.

2. **Redundant double `?? 0` in volume24h sort** (`global-pools-table.tsx:154-156`): `volume24hByKey?.get(aKey) ?? 0` already produces a `number`; the outer `(aV ?? 0)` in `cmp = (aV ?? 0) - (bV ?? 0)` is then redundant.

3. **`isOracleStale` computed for non-CRITICAL paths** (`global-pools-table.tsx:57-59`): `isOracleStale` is computed whenever `status !== "N/A"` but only consumed in `status === "CRITICAL"` branch. Inconsequential.

4. **`SortDir` type duplicated** from `pools-table.tsx`. Not an issue for a standalone component but worth noting if a shared types module ever emerges.

---

## Verdict

**Ready to open as a PR.**

The implementation is clean, correct, and well-tested. The architecture decision (flat `GlobalPoolEntry[]` with explicit `network` per row, `${networkId}:${poolId}` keying) is sound. The 15 new tests cover the important paths. The two warnings found (debris file + volume error regression) are both fixed. No blockers remain.
