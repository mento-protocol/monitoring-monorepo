The patch can bypass its quota reserve and an explicit limit, and it can silently continue after truncated discovery. The tier-2 tag-ordering change also does not preserve its intended tags through the final merge.

Full review comments:

- [P1] Keep the fallback quota count current between polls — /Users/chapati/.cache/mento-review-eval/fx-2035-297c65bf413d/ui-dashboard/scripts/intel-marathon/tier1-bulk-enrich.mjs:103-103
  When Arkham omits `X-Intel-Datapoints-Remaining`, the initial usage poll seeds `quota.remaining`, but subsequent Usage/Limit headers do not recompute it and the body is polled only every 500 addresses. With the default floor of 50, a run starting with 55 remaining can consume hundreds of quota-counted lookups instead of stopping after five. Derive remaining from current Usage/Limit headers or poll before the floor can be crossed.

- [P1] Reject numeric flags that omit their value — /Users/chapati/.cache/mento-review-eval/fx-2035-297c65bf413d/ui-dashboard/scripts/intel-marathon/tier1-bulk-enrich.mjs:112-116
  When an operator passes `--limit` without a value, including `--limit --quota-floor 50`, this returns `undefined`, so `numericFlag` treats the flag as absent and uses `Infinity`. The intended cap silently disappears and the full queue can run until another quota brake stops it. Distinguish an absent flag from a present flag with no operand and fail the latter.

- [P2] Prioritize forensic tags in the final tier-2 merge — /Users/chapati/.cache/mento-review-eval/fx-2035-297c65bf413d/ui-dashboard/scripts/intel-marathon/tier2-light-forensic.mjs:394-395
  For an address whose tier-1 entry already contains 20 Arkham tags, this ordering is undone by the final write: `mergedTags` inserts `existingEntry.tags` before `derived.tags` and then slices to 20. The tier-2 `ctp:` and `type:` tags therefore still disappear. Build the final merged set with forensic tags first or reserve space for them.

- [P2] Abort when discovery reaches the hard page cap — /Users/chapati/.cache/mento-review-eval/fx-2035-297c65bf413d/ui-dashboard/scripts/intel-marathon/tier1-bulk-enrich.mjs:284-287
  When a source exceeds 250,000 rows, `pageSource` returns `capped: true`, but this branch only logs a warning and does not add the source to `failedSources`. The run therefore spends quota and reports success over a truncated discovery set even without `--allow-partial-discovery`. Treat a capped source as an incomplete discovery failure.
