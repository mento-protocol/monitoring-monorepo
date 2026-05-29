---
title: File-size and lint-hygiene watch list
status: active
owner: eng
last_verified: 2026-05-29
---

# File-size and lint-hygiene watch list

Migrated off `BACKLOG.md` 2026-05-29 — this is passive guidance, not a task.
These files are near the ESLint `max-lines` budget. No action until one grows;
**refresh the counts before starting any split.** `raw` is physical lines;
`rough` approximates the ESLint count after skipping blanks and comments.

Counts last refreshed 2026-05-25:

| Raw | Rough | File                                            | Action                                                                      |
| --: | ----: | ----------------------------------------------- | --------------------------------------------------------------------------- |
| 847 |   616 | `indexer-envio/src/rpc/effects.ts`              | Watch; split if adding another effect family.                               |
| 759 |   520 | `ui-dashboard/src/lib/network-fetcher/fetch.ts` | Watch; split fetch orchestration if another network-wide data source lands. |
| 701 |   435 | `indexer-envio/src/handlers/sortedOracles.ts`   | Watch; split only with related oracle-handler work.                         |
| 627 |   330 | `ui-dashboard/src/lib/leaderboard-hero.ts`      | Watch; split if hero KPI fallback or overlap logic grows again.             |
| 628 |   478 | `ui-dashboard/src/lib/queries/leaderboard.ts`   | Watch; split leaderboard GraphQL fragments/queries if another surface lands.|
