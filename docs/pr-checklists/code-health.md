# Code Health PR Checklist

Triggered when your change touches lint configs, package boundaries, package
dependencies, or the `.dependency-cruiser.cjs` / `*/knip.json` files.

## Before pushing

- [ ] `pnpm code-health` is green (`code-health:knip` + `code-health:deps`).
      The agent quality gate runs this per-package on changed paths.
- [ ] If you added a new cross-package import, it goes via `shared-config`
      (or `@mento-protocol/contracts`), never indexer/dashboard/bridge ↔ each other.
- [ ] If you added a new top-level dependency, knip can see it being used.
      For peer-of-X-only deps (build-time, runtime-only) add to
      `ignoreDependencies` in that package's `knip.json` with a 1-line
      justification comment.
- [ ] If knip flags newly-unused exports/types, delete them. Don't add to
      `ignore` to "preserve API surface" unless there's a documented consumer
      outside this repo.
- [ ] If you needed to bypass a dep-cruiser rule, add a narrow `pathNot`
      exception with a comment explaining the data-vs-runtime distinction.
      Don't broaden a whole rule's scope.

## How the gates behave

| Gate                                 | Severity                        | What it catches                                                      | Fix                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependency-cruiser` cross-pkg       | **error**                       | dashboard/indexer/bridge cross-imports, shared-config upward imports | Refactor through `shared-config`, or — if it's data-only — narrow the allow list with `pathNot`                                                                                                          |
| `dependency-cruiser` cycles          | warn (baseline)                 | new circular deps anywhere                                           | Extract the shared piece into a third module                                                                                                                                                             |
| `knip` files / deps / unlisted       | **error**                       | unused files, unused listed deps, imports of unlisted deps           | Delete file / remove dep / `pnpm add` the missing dep                                                                                                                                                    |
| `knip` exports / types / enumMembers | warn                            | unused exports, types, enum entries                                  | Delete on touch; not auto-blocking                                                                                                                                                                       |
| ESLint complexity budgets            | **error** (suppressed baseline) | over-complex / long / nested / many-arg functions                    | Refactor; new violations fail the gate. To remove a baseline entry: fix the code, then `pnpm --filter <pkg> exec eslint . --prune-suppressions` and commit the updated `<pkg>/eslint-suppressions.json`. |
| `sonarjs/no-redundant-jump`          | **error**                       | dead control-flow jumps                                              | Trivial fix; never opt out                                                                                                                                                                               |
| `sonarjs/cognitive-complexity`       | **error** (suppressed baseline) | hard-to-read nested logic                                            | Extract sub-functions; new violations fail. Cleanup pattern: same as above (fix + prune suppression).                                                                                                    |
| `sonarjs/no-identical-functions`     | **error**                       | duplicate function bodies                                            | Extract a helper, or — if intentionally parallel — disable per-occurrence                                                                                                                                |
| Code-health history report           | advisory                        | hotspots, change coupling, ownership risk                            | Use the report to plan refactors; never gates merges                                                                                                                                                     |

## Ratchet pipeline (where this is going)

PR 1: blocking knip + dep-cruiser cross-pkg + advisory history report.

PR 2 (this PR): per-package ESLint complexity budgets (`complexity`,
`max-lines-per-function`, `max-depth`, `max-params`,
`sonarjs/cognitive-complexity` plus four other sonarjs rules) ship at
**`error` severity** with the pre-existing violations captured in each
package's `eslint-suppressions.json` (ESLint 9.24+ bulk suppressions).
**Any new violation not in the suppressions file fails the gate.**
Baseline sizes: shared-config 0, metrics-bridge ~11, ui-dashboard ~191,
indexer-envio ~63 suppressions. Cleanup PRs fix a violation and run
`pnpm --filter <pkg> exec eslint . --prune-suppressions` to drop the
entry. The `--max-warnings <N>` cap was the prior baseline mechanism;
it was insufficient because warning-count budgeting let a PR delete one
violation and add another without failing (codex P2 #3253043406).

PR 3: `jscpd` duplication check ships as a non-blocking CI job.

PR 5: weekly cron renders `reports/code-health-history.md` and posts the
hotspot/coupling delta to Slack.

PR 6: continue chipping at the suppression files via cleanup PRs. The
goal is `eslint-suppressions.json` shrinking commit-by-commit until each
package's file is empty (or removed) — at which point the rules behave
as plain `error` with no baseline carve-out. Promote dep-cruiser cycles
to `error` after the `indexer-envio/src/{pool,deviationBreach}.ts`
cycle is broken.

## Decision log

- `sonarjs/no-duplicate-string` is intentionally **off** — historically noisy.
  Literal duplication is covered by `jscpd` (PR 3).
- `max-statements` is **off** — overlaps with `max-lines-per-function` without
  adding signal.
- History report uses pure Node (no extra runtime deps) — spawns `git log`
  directly. Adding it doesn't grow the supply-chain surface.
- The known cycle `indexer-envio/src/pool.ts ↔ src/deviationBreach.ts` is the
  recorded warn-baseline. Breaking it requires extracting
  `recordBreachTransition` into a third module; tracked in `BACKLOG.md`.
