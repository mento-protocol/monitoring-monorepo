The new preview generally builds and passes its focused tests, but its stale-cache path produces an unavailable first unfurl after an idle period instead of refreshing the data in-band.

Review comment:

- [P2] Refresh snapshots that exceed the age limit — /Users/chapati/.cache/mento-review-eval/fx-2121-75cfaeb631ea/ui-dashboard/src/app/cdps/[symbol]/troves/[troveId]/_lib/trove-og-data.ts:273-274
  When this cache has been idle for more than five minutes, `unstable_cache` returns the stale entry immediately and starts revalidation in the background. This branch converts that entry to `null` instead of joining the coalesced refresh, so the first metadata request reports “indexed snapshot unavailable” despite a healthy upstream, and the image request can race the background fill. Await `fetchTroveOgDataForCache` when the cached value exceeds the age limit, as described in `docs/pr-checklists/recurring-review-patterns.md:65-67`.
