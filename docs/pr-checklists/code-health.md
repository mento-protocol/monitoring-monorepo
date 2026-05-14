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

| Gate                                 | Severity        | What it catches                                                      | Fix                                                                                             |
| ------------------------------------ | --------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `dependency-cruiser` cross-pkg       | **error**       | dashboard/indexer/bridge cross-imports, shared-config upward imports | Refactor through `shared-config`, or — if it's data-only — narrow the allow list with `pathNot` |
| `dependency-cruiser` cycles          | warn (baseline) | new circular deps anywhere                                           | Extract the shared piece into a third module                                                    |
| `knip` files / deps / unlisted       | **error**       | unused files, unused listed deps, imports of unlisted deps           | Delete file / remove dep / `pnpm add` the missing dep                                           |
| `knip` exports / types / enumMembers | warn            | unused exports, types, enum entries                                  | Delete on touch; not auto-blocking                                                              |
| ESLint complexity budgets            | warn (baseline) | over-complex / long / nested / many-arg functions                    | Refactor or `// eslint-disable-next-line <rule>` with 1-line justification                      |
| `sonarjs/no-redundant-jump`          | **error**       | dead control-flow jumps                                              | Trivial fix; never opt out                                                                      |
| `sonarjs/cognitive-complexity`       | warn (baseline) | hard-to-read nested logic                                            | Extract sub-functions; per-line disable with 1-line "why" otherwise                             |
| `sonarjs/no-identical-functions`     | warn (mostly)   | duplicate function bodies                                            | Extract a helper, or — if intentionally parallel — disable per-occurrence                       |
| Code-health history report           | advisory        | hotspots, change coupling, ownership risk                            | Use the report to plan refactors; never gates merges                                            |

## Ratchet pipeline (where this is going)

PR 1: blocking knip + dep-cruiser cross-pkg + advisory history report.

PR 2 (this PR): per-package ESLint complexity budgets (`complexity`,
`max-lines-per-function`, `max-depth`, `max-params`,
`sonarjs/cognitive-complexity` plus four other sonarjs rules) ship as `warn`,
with the baseline recorded in `reports/eslint-health-baseline.json`. **Don't
add NEW warnings — fix or per-line disable with a 1-line "why".** Baseline
counts: shared-config 0w, metrics-bridge 11w, ui-dashboard 191w,
indexer-envio 63w. Intra-package layer rules in `dependency-cruiser` are
deferred to a separate follow-up.

PR 3: `jscpd` duplication check ships as a non-blocking CI job.

PR 5: weekly cron renders `reports/code-health-history.md` and posts the
hotspot/coupling delta to Slack.

PR 6: ratchet PR 2's `warn` rules to `error` where the baseline is clean.
Promote dep-cruiser cycles to `error` after the
`indexer-envio/src/{pool,deviationBreach}.ts` cycle is broken.

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
