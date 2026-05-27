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
- [ ] If you added a new `_components/` or `_tabs/` directory under
      `ui-dashboard/src/app/<new-route>/`, add a matching
      `dashboard-route-private-<new-route>` rule to `.dependency-cruiser.cjs`
      so that directory stays private to its route.

## How the gates behave

| Gate                                                      | Severity                                     | What it catches                                                                                                                              | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependency-cruiser` cross-pkg                            | **error**                                    | dashboard/indexer/bridge cross-imports, shared-config upward imports                                                                         | Refactor through `shared-config`, or — if it's data-only — narrow the allow list with `pathNot`                                                                                                                                                                                                                                                                                                                                                                  |
| `dependency-cruiser` cycles                               | **error**                                    | new circular deps anywhere                                                                                                                   | Extract the shared piece into a third module                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `dashboard-lib-no-components` (dep-cruiser)               | **error**                                    | `lib/` importing from `components/`                                                                                                          | Move the shared piece to `lib/`, or convert it to a hook / util if it has no render dependency                                                                                                                                                                                                                                                                                                                                                                   |
| `dashboard-route-private-*` (dep-cruiser)                 | **error**                                    | cross-route imports of `_components/` or `_tabs/`                                                                                            | Extract the shared component to `src/components/` (global), or create a shared `_lib/` inside the shared ancestor route. Adding a new route with private dirs requires a matching rule in `.dependency-cruiser.cjs`                                                                                                                                                                                                                                              |
| `indexer-handlers-no-rpc-internals` (dep-cruiser)         | **error**                                    | handler importing from `rpc/pool-state`, `rpc/client`, etc. directly                                                                         | Wrap the fetcher in a new effect in `rpc/effects.ts`, then call the effect from the handler; or use the `rpc.ts` barrel for DB-only helpers                                                                                                                                                                                                                                                                                                                      |
| `knip` files / deps / unlisted                            | **error**                                    | unused files, unused listed deps, imports of unlisted deps                                                                                   | Delete file / remove dep / `pnpm add` the missing dep                                                                                                                                                                                                                                                                                                                                                                                                            |
| `knip` exports / types / enumMembers                      | warn                                         | unused exports, types, enum entries                                                                                                          | Delete on touch; not auto-blocking                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ESLint complexity budgets                                 | **error** (diff-aware baseline)              | over-complex / long / nested / many-arg functions                                                                                            | Refactor; any new `(file, ruleId, message)` tuple not in `<pkg>/eslint-baseline.json` fails the gate. After fixing: `pnpm --filter <pkg> lint:baseline:update`, then commit the regenerated baseline.                                                                                                                                                                                                                                                            |
| `sonarjs/no-redundant-jump`                               | **error**                                    | dead control-flow jumps                                                                                                                      | Trivial fix; never opt out                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `sonarjs/cognitive-complexity`                            | **error** (diff-aware baseline)              | hard-to-read nested logic                                                                                                                    | Extract sub-functions; new violations fail by tuple. Cleanup pattern: same as above (fix + regenerate baseline).                                                                                                                                                                                                                                                                                                                                                 |
| `sonarjs/no-identical-functions`                          | **error**                                    | duplicate function bodies                                                                                                                    | Extract a helper, or — if intentionally parallel — disable per-occurrence                                                                                                                                                                                                                                                                                                                                                                                        |
| `@typescript-eslint/no-floating-promises`                 | **error** (diff-aware baseline)              | missing `await` on a side-effect promise                                                                                                     | Add `await`, or `void doSomething()` for an intentional fire-and-forget; never bypass                                                                                                                                                                                                                                                                                                                                                                            |
| `@typescript-eslint/no-misused-promises`                  | **error** (diff-aware baseline)              | passing an async callback where a void return is expected                                                                                    | Wrap in a sync closure: `() => { void doAsync(); }`. UI-dashboard has a baselined-debt cleanup task in BACKLOG                                                                                                                                                                                                                                                                                                                                                   |
| `@typescript-eslint/switch-exhaustiveness-check`          | **error**                                    | switch on enum/union missing a case (even when there's a `default:`)                                                                         | Add an explicit `case "X":` branch for the missing union member; the default is fine but the rule wants intent                                                                                                                                                                                                                                                                                                                                                   |
| `noUncheckedIndexedAccess` (tsconfig)                     | **error** (3/4 packages)                     | `arr[i]` assumed defined when it could be `undefined`                                                                                        | Add a guard `if (item === undefined) continue` or destructure with `?? defaultValue`. Dashboard deferred — see BACKLOG.                                                                                                                                                                                                                                                                                                                                          |
| `exactOptionalPropertyTypes` (tsconfig)                   | **error**                                    | `{ x?: T }` vs `{ x: T \| undefined }` conflated                                                                                             | Omit optional keys instead of assigning `undefined`: `...(val !== undefined && { key: val })`, or widen the destination type to `?: T \| undefined` when the value really can be present-and-undefined.                                                                                                                                                                                                                                                          |
| Bundle size (`pnpm dashboard:size-limit`)                 | **error**                                    | client JS or CSS brotli size exceeds budget in `.size-limit.cjs`                                                                             | Audit what grew (run `pnpm dashboard:build && size-limit --json`), reduce deps or use dynamic imports. Budgets = baseline × 1.10; update `.size-limit.cjs` comment when tightening.                                                                                                                                                                                                                                                                              |
| `pnpm lockfile:lint`                                      | **error**                                    | missing/invalid sha512 hash, custom registry config in .npmrc                                                                                | Re-run `pnpm install` from a known-good registry; remove `registry=` overrides from `.npmrc` / `registries:` from `pnpm-workspace.yaml` (exact host check — lookalikes rejected)                                                                                                                                                                                                                                                                                 |
| Lighthouse CI (`.github/workflows/lighthouse.yml`)        | accessibility + INP **error**, perf **warn** | CWV regression (LCP, CLS), INP regression on /pools filter interaction, accessibility score drop, or bypass regression (SSO interstitial)    | Fix the regressed component or interaction pattern. Accessibility is blocking (minScore 0.94, matches current prod baseline). INP is blocking at ≤ 200 ms via `ui-dashboard/scripts/measure-inp.mjs` (Playwright + web-vitals against /pools); same script also fails the gate if it lands on the Vercel SSO interstitial. Other performance assertions are advisory until a stable percentile baseline is established — see BACKLOG "Lighthouse CI Follow-Ups". |
| GraphQL schema diff (`.github/workflows/schema-diff.yml`) | advisory                                     | field removal, type narrowing, required arg additions, enum value removal — any change that breaks existing Hasura queries or dashboard code | Review the sticky PR comment; update Hasura queries + dashboard Zod schemas before merging if the change is intentional. Runs only when `indexer-envio/schema.graphql` changed. Local: `pnpm code-health:schema-diff`.                                                                                                                                                                                                                                           |
| Code-health history report                                | advisory                                     | hotspots, change coupling, ownership risk                                                                                                    | Use the report to plan refactors; never gates merges                                                                                                                                                                                                                                                                                                                                                                                                             |

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

`lint:baseline:update` is **prune-only with line-proximity absorption**:

- An added tuple whose stripped key `(file, ruleId, message)` doesn't
  exist in the baseline → rejected.
- An added tuple whose stripped key matches a baseline entry AND whose
  `line` is within `ABSORB_LINE_DISTANCE` (currently 30) of that entry
  → absorbed as a legitimate refactor (comment edit, signature
  reformat, small insert above a baselined function, or natural drift
  from sibling PRs landing on main).
- An added tuple whose stripped key matches but `line` is farther than
  the proximity window → rejected. Larger jumps are likely a different
  violation introduced under the same rule, not the same one moved.
- Removing tuples → always allowed.

For a deliberate reseed (e.g. accepting a new package, or after a
large refactor that moves a violation farther than the proximity
window), delete `eslint-baseline.json` first and re-run the update.

CI also runs a **merge-base growth check** (PRs only): the same
line-proximity rule applied to the diff between HEAD's
`eslint-baseline.json` and main's. Hand-editing or reseeding the
baseline file to admit new violations alongside the introducing code
gets caught here even when local `update` was bypassed.

**Known gap.** A swap-in-place within `ABSORB_LINE_DISTANCE` lines
(fix one violation, add a different one with the same
`(file, ruleId, message)` nearby) still absorbs. The line-proximity
heuristic prefers refactor UX over catching this narrow attack —
codex has flip-flopped on the trade-off across rounds; this is the
current compromise. The PR diff makes the baseline rewrite visible
to human reviewers, which is the actual safety net.

Cleanup workflow:

1. Fix a violation in the code.
2. Run `pnpm --filter <pkg> lint` → it reports the stale baseline entry
   and fails CI.
3. Run `pnpm --filter <pkg> lint:baseline:update` → prunes the stale
   entry from `eslint-baseline.json`.
4. Commit the regenerated baseline alongside the code fix.

Baseline sizes: shared-config 0, metrics-bridge 11, ui-dashboard 188,
indexer-envio 63 entries (as of PR 4 / 425). The ui-dashboard count
dropped from 191 → 188 in PR 4's `handleSnapshot` refactor.

Eight prior baseline mechanisms were rejected:

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
7. Strict update mode (codex P2 round 5 #3254674897): adjacent edits
   that shift the linePreview window around an existing violation
   reported as forbidden additions, breaking the documented prune
   workflow. Now `update` absorbs 1-for-1 swaps within the same
   `(file, ruleId, message)` stripped key.
8. No CI-side baseline-diff check (codex P2 round 5 #3254674887):
   `update`'s prune-only guarantee didn't cover hand-edits or
   `rm + update` reseeds. CI now runs a merge-base growth check on
   PRs — same stripped-key rule applied to HEAD baseline vs main
   baseline. Lint can be green locally while CI rejects baseline
   growth that wasn't matched by removals.

PR 3 (this PR): `jscpd` duplication check ships as a non-blocking CI job
(`.github/workflows/code-health-duplication.yml`) with the HTML+JSON report
uploaded as an artifact. Tests, handlers, route entry pages, layouts,
opengraph images, and pure type modules are excluded (they're
intentionally repetitive). Initial baseline: **218 clones** at min-tokens=50,
min-lines=5. Run locally via `pnpm code-health:duplication`. The report
is intended as an extract-helper-refactor backlog — non-blocking so PRs
aren't gated on historical copy-paste, but visible so contributors can
plan deduplication when they touch an affected file.

PR 5: weekly cron renders `reports/code-health-history.md` and posts the
hotspot/coupling delta to Slack.

PR 6: continue chipping at the baseline files via cleanup PRs. The
goal is `eslint-baseline.json` shrinking commit-by-commit until each
package's file is empty (or removed) — at which point the rules behave
as plain `error` with no baseline carve-out.

## Decision log

- `sonarjs/no-duplicate-string` is intentionally **off** — historically noisy.
  Literal duplication is covered by `jscpd` (PR 3).
- `max-statements` is **off** — overlaps with `max-lines-per-function` without
  adding signal.
- History report uses pure Node (no extra runtime deps) — spawns `git log`
  directly. Adding it doesn't grow the supply-chain surface.
- The historical `indexer-envio/src/pool.ts ↔ src/deviationBreach.ts`
  cycle was broken by importing health predicates directly from
  `pool/health.js` instead of through the `pool.js` barrel re-export.
  `no-circular` is now `error` with no baseline carve-out.
