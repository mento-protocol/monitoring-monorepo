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

| Gate                                 | Severity                        | What it catches                                                      | Fix                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependency-cruiser` cross-pkg       | **error**                       | dashboard/indexer/bridge cross-imports, shared-config upward imports | Refactor through `shared-config`, or — if it's data-only — narrow the allow list with `pathNot`                                                                                                       |
| `dependency-cruiser` cycles          | warn (baseline)                 | new circular deps anywhere                                           | Extract the shared piece into a third module                                                                                                                                                          |
| `knip` files / deps / unlisted       | **error**                       | unused files, unused listed deps, imports of unlisted deps           | Delete file / remove dep / `pnpm add` the missing dep                                                                                                                                                 |
| `knip` exports / types / enumMembers | warn                            | unused exports, types, enum entries                                  | Delete on touch; not auto-blocking                                                                                                                                                                    |
| ESLint complexity budgets            | **error** (diff-aware baseline) | over-complex / long / nested / many-arg functions                    | Refactor; any new `(file, ruleId, message)` tuple not in `<pkg>/eslint-baseline.json` fails the gate. After fixing: `pnpm --filter <pkg> lint:baseline:update`, then commit the regenerated baseline. |
| `sonarjs/no-redundant-jump`          | **error**                       | dead control-flow jumps                                              | Trivial fix; never opt out                                                                                                                                                                            |
| `sonarjs/cognitive-complexity`       | **error** (diff-aware baseline) | hard-to-read nested logic                                            | Extract sub-functions; new violations fail by tuple. Cleanup pattern: same as above (fix + regenerate baseline).                                                                                      |
| `sonarjs/no-identical-functions`     | **error**                       | duplicate function bodies                                            | Extract a helper, or — if intentionally parallel — disable per-occurrence                                                                                                                             |
| Code-health history report           | advisory                        | hotspots, change coupling, ownership risk                            | Use the report to plan refactors; never gates merges                                                                                                                                                  |

## Ratchet pipeline (where this is going)

PR 1: blocking knip + dep-cruiser cross-pkg + advisory history report.

PR 2 (this PR): per-package ESLint complexity budgets (`complexity`,
`max-lines-per-function`, `max-depth`, `max-params`,
`sonarjs/cognitive-complexity` plus four other sonarjs rules) ship at
**`error` severity** with a diff-aware baseline in each package's
`eslint-baseline.json`. The `pnpm --filter <pkg> lint` script runs
`scripts/eslint-baseline-diff.mjs`, which compares each current tuple
to the committed baseline and fails on any **new** tuple OR any
**stale** baseline entry (violation removed but not pruned).

Tuple identity is `(file, ruleId, message, linePreview)`, where
`linePreview` is a three-line window of trimmed source content
(`line-1 | line | line+1`, capped at 200 chars) around the violation's
reported line. This content fingerprint:

- Distinguishes anonymous-function collisions (e.g. two arrows with
  identical `}): Promise<void> => {` signatures in the same file are
  separated by the differing next-statement line).
- Absorbs pure line shifts: an unrelated edit above a baselined
  violation moves the line number, but the source content at that
  location is unchanged → same fingerprint → no diff to commit.
- Catches swap-in-place: fixing one violation and adding another at a
  different location yields different source content → different
  fingerprint → check fails.

`lint:baseline:update` is **prune-only**: it refuses to write a baseline
that adds new tuples relative to the existing baseline. New violations
must be fixed, not baselined. For a deliberate reseed (e.g. accepting a
new package), delete `eslint-baseline.json` first and re-run the update.

Cleanup workflow:

1. Fix a violation in the code.
2. Run `pnpm --filter <pkg> lint` → it reports the stale baseline entry
   and fails CI.
3. Run `pnpm --filter <pkg> lint:baseline:update` → prunes the stale
   entry from `eslint-baseline.json`.
4. Commit the regenerated baseline alongside the code fix.

Baseline sizes: shared-config 0, metrics-bridge 11, ui-dashboard 191,
indexer-envio 63 entries.

Six prior baseline mechanisms were rejected:

1. `--max-warnings <N>` (codex P2 #3253043406): total-count budgeting,
   so a PR could delete one warning and add another without failing.
2. ESLint 9.24+ bulk suppressions (codex P2 #3254553397): count-based
   per `(file, ruleId)`, so swapping one function's `complexity`
   violation for another's in the same file would still pass.
3. Permissive `update` mode (codex P2, round 3): re-running update with
   new violations silently grew the baseline. Now update is prune-only.
4. Warn-and-pass on stale entries (codex P2, round 3): let an unrelated
   fix leave the stale tuple committed, so a later PR could
   re-introduce the same violation without detection. Now stale entries
   fail CI.
5. `(file, ruleId, message)` keys (codex P2 round 4 #3254614043,
   #3254614044): collisions on anonymous-function violations (two
   arrows in the same file with identical signatures share the same
   message). Now keyed on `linePreview` content fingerprint instead.
6. `(file, ruleId, message, line)` keys (codex P2 round 4 #3254614042):
   pure line shifts (unrelated edit above a violation) treated as
   additions, forcing reseeds for non-substantive changes. Now keyed
   on source content, which is stable across shifts.

PR 3: `jscpd` duplication check ships as a non-blocking CI job.

PR 5: weekly cron renders `reports/code-health-history.md` and posts the
hotspot/coupling delta to Slack.

PR 6: continue chipping at the baseline files via cleanup PRs. The
goal is `eslint-baseline.json` shrinking commit-by-commit until each
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
