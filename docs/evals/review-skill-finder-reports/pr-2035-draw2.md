The new quota safeguards can fail in supported header conditions or after a malformed CLI invocation. Discovery can also proceed with a known truncated source.

Full review comments:

- [P1] Poll quota before the fallback can cross the floor — /Users/chapati/.cache/mento-review-eval/fx-2035-297c65bf413d/ui-dashboard/scripts/intel-marathon/tier1-bulk-enrich.mjs:1058-1058
  When Arkham omits the `X-Intel-Datapoints-Remaining` header, `quota.remaining` is refreshed only at startup and every 500 addresses. For example, with 60 remaining and a floor of 50, the loop can issue hundreds of consuming requests instead of stopping after 10. Poll based on the distance to the floor or derive remaining from per-response Usage and Limit headers.

- [P1] Reject numeric flags that have no value — /Users/chapati/.cache/mento-review-eval/fx-2035-297c65bf413d/ui-dashboard/scripts/intel-marathon/tier1-bulk-enrich.mjs:125-126
  When `--limit` or `--quota-floor` is followed by another flag or no argument, `flagValue` returns `undefined` and this path silently uses the fallback. For example, `--limit --no-refresh` becomes an unlimited sweep instead of failing, which can consume the full trial quota. Distinguish an absent flag from a present flag with a missing value.

- [P2] Abort on capped discovery sources — /Users/chapati/.cache/mento-review-eval/fx-2035-297c65bf413d/ui-dashboard/scripts/intel-marathon/tier1-bulk-enrich.mjs:284-287
  If a source reaches `HARD_PAGE_CAP`, this code only prints a warning and the run continues without `--allow-partial-discovery`. The resulting inventory is truncated even though source errors otherwise abort to prevent spending quota on incomplete discovery. Treat `capped` as an incomplete source unless the caller explicitly permits partial discovery.
