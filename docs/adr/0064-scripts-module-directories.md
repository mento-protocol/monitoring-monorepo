---
title: scripts/ may use module subdirectories; basenames and pinned paths are the constraint
status: active
owner: eng
canonical: true
last_verified: 2026-08-20
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0064 — scripts/ may use module subdirectories; basenames and pinned paths are the constraint

**Status:** Accepted (Aug 2026), in force.
**Scope:** ci/process

## Context

`scripts/` holds 210 tracked files in one flat directory. They belong to
unrelated subsystems: deploy wrappers, the quality gate, the autoreview
adapter, Sentry triage and autofix, PR state projections, the documentation
catalog, supply-chain checks, and Terraform helpers. A flat listing gives an
agent no grouping to reason from, and a new file lands next to 209 unrelated
neighbours.

The obvious fix is subdirectories. The reason it has not happened is that many
mechanisms pin `scripts/` paths, and each pin fails differently when a file
moves. Some pins keep working. Some stop matching and fail closed. Some stop
matching and go quiet, which is the dangerous case. Without a written rule, each
move re-derives the same analysis and one of them eventually gets it wrong.

## Decision

`scripts/` may use module subdirectories. Three rules govern them.

**1. A subdirectory is warranted when a set of files is a module.** The set has
a shared subsystem, is read together, and is changed together. Grouping by file
type, by owner, or to shorten a listing is not a reason. A single file gets no
directory of its own.

**2. A basename that a literal-prefix glob matches stays byte-identical.**
Routing survives a subdirectory in three of the four discovery mechanisms:

- Bash `case` patterns match `/` with `*`, because they are pattern matches, not
  filesystem globs. The `scripts/*` arm in `scripts/agent-autoreview.sh` and the
  `scripts/*.sh` arm in `scripts/agent-quality-gate.sh` keep routing a file that
  moves into a subdirectory.
- `pnpm lint:scripts` runs `eslint scripts/`, and `eslint.config.mjs` scopes
  root scripts with `scripts/**/*.{mjs,js}` and `scripts/**/*.cjs`. ESLint
  recurses into the directory argument, so a moved file stays linted.
- The `rootScripts` paths-filter in `.github/workflows/ci.yml` is `scripts/**`,
  which matches every path under `scripts/` at any depth.

The fourth mechanism does not survive. A glob anchored on a literal prefix at
the top of `scripts/` stops matching once the file sits one directory down,
because the prefix now falls after a directory name. `scripts/deploy-*.sh` in
the quality gate does not match `scripts/deploy/deploy-bridge.sh`. The gate
already carries the paired arm `scripts/*/sentry-*.test.mjs` next to
`scripts/sentry-*.test.mjs` for this reason. So: keep the `sentry-` prefix on
all 53 `sentry-*` files wherever they land, keep the `deploy-` prefix on the
deploy wrappers, and add the paired one-level arm whenever a literal-prefix glob
is the routing.

Both deploy arms now carry that pair, added ahead of the move rather than with
it: `scripts/deploy-*.sh|scripts/*/deploy-*.sh` routes the root-anchor check in
`agent-quality-gate.sh`, and the same pair routes the Terraform/Cloud Run
checklist in `select_checklists()` in `agent-autoreview.sh`. Both stay
shell-scoped. The check behind the first has a `deploy-*.sh` subject set, and
the Node deploy helpers that land in the same directory drive Envio and own no
Cloud Run surface, so neither arm is the right home for them. Widening a routing
glob is separable from the move it protects, and doing it first means the move
cannot be the commit that goes quiet.

Because `*` matches `/`, the pair reaches a `deploy-*.sh` basename under any
`scripts/` subdirectory rather than one fixed directory. That is deliberate on
both arms: `collectDeployWrappers()` in `check-deploy-root-anchors.test.mjs`
walks `scripts/` recursively, so routing pinned to a single directory would once
again be narrower than the check it schedules. The one live path it newly
reaches is `scripts/lib/deploy-guard.sh`, the guard every wrapper sources before
it mutates anything, which is precisely when both the check and the Cloud Run
checklist should run. Both suites pin it. One consequence for later edits: a
`case` takes the first matching arm, so a new arm for a path of the shape
`scripts/<dir>/deploy-*.sh` goes ABOVE the pair or it never runs.

`scripts/sentry/gate/sentry-suite-manifest.json` is stricter than a glob. Its keys are exact
repo-relative paths, and `scripts/sentry/gate/sentry-suite-gate.mjs` reconciles them against
`findSentrySuites()` by exact set equality in both directions.
`findSentrySuites()` recurses and matches on the `sentry-` basename prefix, so a
move is discovered but the manifest key is stale, and the gate fails closed with
the JSON patch to apply. Move a Sentry suite and update the manifest key in the
same commit.

**3. A `scripts/` subdirectory gets no `AGENTS.md` of its own.**
`scripts/context/agent-context-budget.mjs` treats every tracked `AGENTS.md` as
an instruction file, measures it against the 9,216-byte scoped cap, and charges
it to the route of every directory beneath it against the 18,944-byte route cap.
`scripts/context/docs-index-helpers.mjs` files it under the `agent-entry-points` garden
lane, which schedules it for re-verification. A per-subdirectory instruction
file therefore costs budget on every route through it and adds a document the
garden must keep true. `scripts/AGENTS.md` stays the single scoped instruction
file for the whole tree.

## Alternatives considered

**Keep `scripts/` flat.** Zero risk of breaking a pin, and it is what the repo
does today. Rejected: the listing is already unreadable at 210 entries and grows
with every new check. The cost lands on every agent that reads the tree, on
every PR.

**Move files and change basenames to match the new directory** — for example
`scripts/sentry/triage-brief.mjs`. Reads better. Rejected: it breaks
`findSentrySuites()` discovery outright, so a suite silently leaves the closed
set the Sentry gate enforces. The prefix is load-bearing, not decoration.

**Rewrite every pin to a recursive glob first, then move.** Removes the
basename constraint. Rejected for now: the enumerated paths-filters exist
because ADR 0010 keeps required checks unfiltered and advisory jobs narrow;
widening them to `scripts/**` would fire expensive advisory jobs on unrelated
edits. The narrow pins are a deliberate cost control, so moves adapt to them
rather than the reverse.

**One `AGENTS.md` per subdirectory.** Better locality for an agent already
inside the directory. Rejected: measured budget cost on every route plus a new
scheduled document, for context an agent gets from the directory map in
`scripts/AGENTS.md`.

## Consequences

- A move is a mechanical sweep, not a judgment call. `scripts/AGENTS.md` carries
  the checklist of every surface that pins a `scripts/` path, and any new pin
  must be added to that list in the PR that introduces it.
- `sentry-*` and `deploy-*` basenames are frozen. A rename is a separate,
  deliberate change that updates the manifest and the routing arms with it.
- `scripts/check-deploy-root-anchors.test.mjs` now walks `scripts/` recursively
  and asserts its subject list is non-empty and covers every mapped wrapper.
  Before this, a flat `readdirSync` that matched nothing exited 0 while printing
  "All 0 deploy scripts anchor repo commands after deploy-guard." — the contract
  passed without checking anything, and a move would have made it do so.
- The reorganization lands incrementally. Each phase moves one module and sweeps
  its pins, so a break is scoped to one subsystem and one PR.
- A file the lint config would lose stays flat even when another tree owns it.
  `redrive-onchain-deadletter.{mjs,test.mjs}` belongs to `alerts/infra/`, but
  `eslint.config.mjs` ignores `alerts/**`, so moving it there drops it out of
  `lint:scripts`. That ignore is config-relative, so `scripts/alerts/**` stays
  linted — the destination is what matters, not the name.
- A file whose only consumer is one package leaves `scripts/` instead of getting
  a subdirectory. P9 moved `check-react-doctor-{diff,score}.sh` to
  `ui-dashboard/scripts/`. An out-move drops the recursive `scripts/**` safety
  net, so it re-pins what the net covered: the `rootScripts` paths-filter now
  names both wrappers, because `agent-quality-gate.test.sh` copies and runs the
  diff wrapper in a stub repo, and the `.claude/settings.json` allowlist plus
  its verbatim copy in `context/check-settings-contract.mjs` carry the package
  path.
- An enumerated paths-filter fails silently rather than loudly: the job stops
  running, and the required `ci` sentinel stays green because a skipped job is
  not a failed one. Where a filter's whole file set is one module, replace the
  enumeration with `scripts/<module>/**` in the PR that moves it. The glob
  covers the same files, so it does not widen the advisory-job cost this ADR's
  rejected alternative was protecting, and it survives the next move within the
  module. P6 did this for `supply-chain.yml`, whose seven enumerated basenames
  became `scripts/supply-chain/**` plus two entries for a shared `lib/` module
  that sits outside the directory. Keep the enumeration where the filter is
  deliberately narrower than a module — `ci.yml`'s `versionSkew` runs one
  checker, and a module glob would fire it on every unrelated edit in that
  directory.
- A workflow that runs a script from the PR's base ref degrades rather than
  fails when that script moves. `pr-description.yml` checks the base ref out as
  `trusted-base/` and prefers it over the PR's own copy, so a PR cannot edit the
  rule it is judged by. With one probe path, every PR branched before the move
  finds nothing at the old path and falls through to its own copy behind a
  `::warning::` — the job stays green while the trusted-validator property is
  gone. P5 hit this and now probes both paths, new first. Keep the pre-move
  probe until no open PR bases on a pre-move tree.
- Moving a file can change a reviewed artifact's hash. A script that derives its
  repo root by walking up a fixed number of directories needs that count fixed
  in the same commit, which changes its bytes. When the file's SHA-256 is itself
  a pinned constant, recompute the constant, update every doc that records it,
  and treat operator regeneration as a release step. P6 hit this with
  `scripts/mcp/upstash-mcp-launcher.mjs`.
- A file read from `origin/main` rather than the working tree cannot move in one
  PR. `agent-autoreview.sh` materializes the `pr-*-state` helpers from the
  protected `origin/main` snapshot because the checked-out copies are not
  trusted, and a missing path there fails closed. The wrapper that runs is
  whichever one the developer has checked out, so any single PR that both moves
  the files and repoints the pin leaves one pairing broken: a pre-move wrapper
  reading a post-move `origin/main`, or a post-move wrapper reading the
  `origin/main` that still predates its own merge. D3 splits it across three
  merges — add the copies and teach the wrapper to accept either location; then
  repoint every consumer; then delete the pre-move copies and the fallback. The
  middle state keeps both locations live on `origin/main`, which is what lets a
  wrapper generation from either side of the move keep working. This is stricter
  than the `pr-description.yml` case above, which degrades to a warning; here
  there is no fallback to degrade to. Hold the last step until no wrapper old
  enough to need the pre-move paths is still in use. D3 completed the three
  merges on 2026-08-20; `scripts/pr/` is now the only pinned location. The
  residual is the one this shape is designed to make loud: a checkout whose
  wrapper predates the first merge resolves nothing and fails closed on
  materialization until it pulls, rather than silently reviewing against a
  runtime that is not there.
- Duplicated copies diverge through the merge queue, not through the PR that
  duplicates them. While both locations are live, an unrelated PR that edits one
  side is not a conflict for the copy PR, so git merges both cleanly and the two
  drift. D3 hit this immediately: #1967 rewrote the clean-evidence grammar in
  `scripts/pr-feedback-state-{core,claude}.mjs` while the copy PR was in flight,
  both merged without a conflict, and because the wrapper prefers the new
  location, `origin/main` then materialized the pre-#1967 logic. Pin the pair
  with a byte-identity test in the suite each side routes to, and route both
  locations to it — that is what caught this one merge later. A copy PR's own
  green run does not prove the pair still matches after it merges, so re-check
  identity at the start of the PR that repoints, and treat any edit to a
  duplicated file as an edit to every copy.

## Sweep checklist for a move

Run every item in the PR that moves a file. `scripts/AGENTS.md` points here
rather than carrying the list, because its scoped instruction budget is for
routing, not procedure.

1. Root `package.json` — 74 entries reference `scripts/`.
2. `check-agent-quality-gate-package-scripts.mjs` — pinned alias map.
3. `.github/workflows/` — 22 of 32 files pin a `scripts/` path. `ci.yml`
   (`autoreviewSuite`, `autoreviewRootRuntime`, `versionSkew`; `rootScripts` is
   the recursive `scripts/**`), `infra.yml`, `alerts-rules.yml`,
   `peg-policy-publication.yml`, and `schema-diff.yml` list individual files.
   The three Terraform filters are the exception: `ci.yml` `terraform` plus
   `infra.yml` push and `pull_request` copy the broad
   `workflowAdmissionPatterns` boundary from `terraform.stacks.json`, including
   `scripts/**`. `routing.test.mjs` asserts exact equality and proves that
   boundary subsumes every stack pattern. A miss is silent without that
   contract — the job stops running while the required `ci` sentinel stays
   green. A module glob such as `supply-chain.yml`'s `scripts/supply-chain/**`
   is the safer pin where the job's subject really is the whole module; a
   filter deliberately narrower than a module, like `versionSkew`, is not.
   A workflow that runs a script from the PR's **base** ref must probe the new
   path and the pre-move path; see the trusted-validator consequence above.
4. `terraform.stacks.json` — each stack's `changedPathPatterns` enumerates
   exact `scripts/` paths. The registry's broad `workflowAdmissionPatterns`
   boundary admits `scripts/**`; `tf-stacks.test.mjs` proves it subsumes every
   stack pattern. A stale stack entry still stops that stack reacting to its
   own tooling.
5. `.trunk/trunk.yaml` pre-push hook, and `.gitattributes`.
6. `.claude/settings.json`, `.codex/hooks.json`,
   `.claude/hooks/session-start.sh`, and the verbatim copies and invocation
   regexes in `context/check-settings-contract.mjs`, which
   `context/check-agent-context.mjs` runs.
7. `.claude/skills/` and `.agents/skills/` — both mirrors.
8. `docs/notes/quick-commands.md`.
9. `agent-quality-gate.sh` routing arms — a literal-prefix glob such as
   `scripts/deploy-*.sh` or `scripts/sentry-*.test.mjs` stops matching one
   directory down. Keep the basename prefix; add the paired one-level arm. The
   `sentry-` and `deploy-` arms already carry theirs, so a move of those files
   verifies the pair rather than adding it. An arm naming an exact path is a
   literal, not a glob, and needs the same pairing for the same reason: the
   three on the deploy leg — the `deploy-indexer-logs.sh` and `deploy-bridge.sh`
   arms and the `deploy-*.sh` glob — carry it, so a moved wrapper keeps its
   whole command set. Leaving one unpaired below a widened glob is the worst
   case, not the safe one: the glob catches the moved path, the run still looks
   routed, and only the arm's extra commands go missing. A pattern is only half
   of it — an arm that also names a path in the command it schedules has to
   repoint both. The three Node deploy-helper arms are exact-path on both sides;
   P14 moved them into `scripts/deploy/` and repointed pattern and command
   together. A stale command path there fails loudly, a stale pattern silently.
   Changing a script's language breaks routing the same way a move does, and as
   quietly: P15 rewrote the status wrapper as
   `scripts/deploy/deploy-indexer-status.mjs`, and with the `.sh` gone no
   `deploy-*.sh` glob reaches it any more. A rewrite that does not add its own
   arm is routed by `pnpm lint:scripts` alone.
   Its
   contract-surface arm also names `scripts/lib/*.mjs`, which sets the
   `pnpm tf:test` reason; the unconditional sweep already runs the suite. Its
   `implementation_signature()` path list is stricter than a glob: an entry it
   cannot stat hashes as `__missing__`, so the signature freezes and
   `--skip-if-fresh` reuses a stale stamp. Repoint it in the same commit.
   The gate also resolves node helpers from `$script_source_dir`:
   `docs/docs-navigation-eval-helpers.mjs`, which classifies routing-sensitive
   paths, and `gate/lockfile-scope.mjs`. Those are differently-rooted literals,
   and the routing arms and the signature list name each helper again, so each
   appears three times in all — the import, its routing arm, and
   `implementation_signature()`. Repoint every occurrence. `$script_source_dir`
   is the required anchor: the gate runs against stub fixture repositories where
   `$repo_root` is a temp directory with no `scripts/` tree, so a repo-root
   anchor misses the helper on every fixture run. No CI job runs the gate for
   real, so `agent-quality-gate.test.sh` is the only place any of them is
   exercised outside a developer's pre-push. P11 moved `lockfile-scope.mjs` into
   `gate/`, added it to `implementation_signature()` (issue 1905), and made a
   helper the gate cannot find exit 2 instead of falling toward the full suite —
   its caller reads a nonzero exit as "cannot narrow", so the old behaviour
   silently widened every lockfile change and the run read as slow, not broken.
   Since ADR 0069 the same routing also exists as DATA in
   `scripts/gate/routing-table/`, and a move has to update both. The data is the
   easier half: its patterns are checked for staleness and its `scripts/`-anchored
   globs are checked for their any-depth pair, so a move that misses the table
   reds where a move that misses the arms goes quiet. The two are held together
   by `gate-equality.test.mjs`, which fails if only one side moved — so the sweep
   is not done until both are repointed. Every module in that directory is also
   an `implementation_signature()` entry, with the same `__missing__` freeze.
10. `forbidden_sources` in `docs/evals/documentation-navigation-fixtures.json`
    names the navigation evaluation's own implementation, so a run cannot read
    the answers out of it. `validateFixtureSuite` checks those paths for
    uniqueness and never for existence, so a stale entry stops forbidding
    anything and no check reds. The paired
    `documentation-navigation-baseline-fixtures.json` is the frozen contract for
    the committed baseline result and is deliberately left alone; editing it
    would force a rebind of that result's `fixture_digest`.
11. File-size cap lists in `sentry/triage/sentry-triage-brief.test.mjs` — the
    1,000-line hard cap for the triage family's shared modules and the 600-line
    soft cap for the brief leg both enumerate exact repo-relative paths. No
    ESLint `max-lines` reaches this tree and the watchlist reports rather than
    blocks (ADR 0065), so these lists are the only thing that reds a file that
    crosses. A moved path stops matching and the file drops off its cap in
    silence — the same failure mode as a stale routing arm, with no red run to
    announce it. Add a module here in the PR that creates it, too: the split
    that puts a module under the cap is exactly when its entry is easiest to
    forget.

A shared module under `scripts/lib/` is routed from every arm that reads it,
not only the arm of the consumer that happens to fail loudest.

## Evidence

- Flat-layout scale and prefix counts: `git ls-files scripts/` — 210 top-level
  files, 53 with the `sentry-` prefix, measured at P0. The count falls with each
  phase; `scripts/AGENTS.md` carries the current one.
- Bash `case` routing: `scripts/agent-autoreview.sh` (`scripts/*` arm, and the
  paired `scripts/deploy-*.sh` / `scripts/*/deploy-*.sh` checklist arm),
  `scripts/agent-quality-gate.sh` (`scripts/*.sh`, and the paired
  `scripts/deploy-*.sh` / `scripts/*/deploy-*.sh` and
  `scripts/sentry-*.test.mjs` / `scripts/*/sentry-*.test.mjs` arms).
- Routing assertions for both deploy pairs, each with a negative control:
  `scripts/agent-quality-gate.test.sh` (the `scripts/deploy/` cases beside the
  flat ones) and `run_deploy_directory_checklist_routing_regression` in
  `scripts/agent-autoreview.test.sh`.
- Recursive lint: `package.json` `lint:scripts`, `eslint.config.mjs` `files`
  globs.
- Recursive CI filter: `.github/workflows/ci.yml`, `rootScripts` filter, whose
  in-file comment records that `scripts/**` matches every depth.
- Exact-set manifest: `scripts/sentry/gate/sentry-suite-manifest.json`,
  `findSentrySuites()` in `scripts/sentry/gate/sentry-suite-gate.mjs`, and
  [ADR 0062](0062-sentry-suites-self-run-gate.md).
- Instruction-file budget and lane: `INSTRUCTION_FILENAMES` and the route
  computation in `scripts/context/agent-context-budget.mjs`; the
  `agent-instructions` → `agent-entry-points` mapping in
  `scripts/context/docs-index-helpers.mjs`.
- Paths-filter policy: [ADR 0010](0010-required-checks-no-paths-filters.md).
- Shared-core readership, the census behind keeping `scripts/lib/` outside the
  domain directories: five files beyond `production-infra-identity-contract/`
  read `hcl.mjs`; the ADR 0053 deploy-staging contract reads
  `workflow-yaml.mjs`; the lockfile-lint gate and the override prune advisor
  both read `pnpm-override-selector.mjs`; the documentation garden and the
  navigation-eval scheduler both read `gh-issue-lifecycle.mjs`.
- Programme tracking issue:
  <https://github.com/mento-protocol/monitoring-monorepo/issues/1877>.
