---
title: scripts/ may use module subdirectories; basenames and pinned paths are the constraint
status: active
owner: eng
canonical: true
last_verified: 2026-08-17
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

`scripts/sentry-suite-manifest.json` is stricter than a glob. Its keys are exact
repo-relative paths, and `scripts/sentry-suite-gate.mjs` reconciles them against
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
- A file whose only consumer is one package leaves `scripts/` instead of getting
  a subdirectory. P9 moved `check-react-doctor-{diff,score}.sh` to
  `ui-dashboard/scripts/`. An out-move drops the recursive `scripts/**` safety
  net, so it re-pins what the net covered: the `rootScripts` paths-filter now
  names both wrappers, because `agent-quality-gate.test.sh` copies and runs the
  diff wrapper in a stub repo, and the `.claude/settings.json` allowlist plus
  its verbatim copy in `check-agent-context.mjs` carry the package path.
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
- Moving a file can change a reviewed artifact's hash. A script that derives its
  repo root by walking up a fixed number of directories needs that count fixed
  in the same commit, which changes its bytes. When the file's SHA-256 is itself
  a pinned constant, recompute the constant, update every doc that records it,
  and treat operator regeneration as a release step. P6 hit this with
  `scripts/mcp/upstash-mcp-launcher.mjs`.

## Sweep checklist for a move

Run every item in the PR that moves a file. `scripts/AGENTS.md` points here
rather than carrying the list, because its scoped instruction budget is for
routing, not procedure.

1. Root `package.json` — 74 entries reference `scripts/`.
2. `check-agent-quality-gate-package-scripts.sh` — pinned alias map.
3. `.github/workflows/` — 22 of 32 files, including the enumerated filters
   listed under "Why Files Stay Flat" in `scripts/AGENTS.md`.
4. `.trunk/trunk.yaml` pre-push hook, and `.gitattributes`.
5. `.claude/settings.json`, `.codex/hooks.json`,
   `.claude/hooks/session-start.sh`, and the verbatim copies and invocation
   regexes in `check-agent-context.mjs`.
6. `.claude/skills/` and `.agents/skills/` — both mirrors.
7. `docs/notes/quick-commands.md`.
8. `agent-quality-gate.sh` routing arms — a literal-prefix glob such as
   `scripts/deploy-*.sh` or `scripts/sentry-*.test.mjs` stops matching one
   directory down. Keep the basename prefix; add the paired one-level arm. Its
   contract-surface arm also names `scripts/lib/*.mjs`, which sets the
   `pnpm tf:test` reason; the unconditional sweep already runs the suite. Its
   `implementation_signature()` path list is stricter than a glob: an entry it
   cannot stat hashes as `__missing__`, so the signature freezes and
   `--skip-if-fresh` reuses a stale stamp. Repoint it in the same commit.
9. `terraform.stacks.json` — each stack's `changedPathPatterns` enumerates
   exact `scripts/` paths, and `tf-stacks.test.mjs` asserts three of them per
   stack. A stale entry stops the stack reacting to its own tooling.

A shared module under `scripts/lib/` is routed from every arm that reads it,
not only the arm of the consumer that happens to fail loudest.

## Evidence

- Flat-layout scale and prefix counts: `git ls-files scripts/` — 210 top-level
  files, 53 with the `sentry-` prefix, at 2026-08-17.
- Bash `case` routing: `scripts/agent-autoreview.sh` (`scripts/*` arm),
  `scripts/agent-quality-gate.sh` (`scripts/*.sh`, `scripts/deploy-*.sh`, and
  the paired `scripts/sentry-*.test.mjs` / `scripts/*/sentry-*.test.mjs` arms).
- Recursive lint: `package.json` `lint:scripts`, `eslint.config.mjs` `files`
  globs.
- Recursive CI filter: `.github/workflows/ci.yml`, `rootScripts` filter, whose
  in-file comment records that `scripts/**` matches every depth.
- Exact-set manifest: `scripts/sentry-suite-manifest.json`,
  `findSentrySuites()` in `scripts/sentry-suite-gate.mjs`, and
  [ADR 0062](0062-sentry-suites-self-run-gate.md).
- Instruction-file budget and lane: `INSTRUCTION_FILENAMES` and the route
  computation in `scripts/context/agent-context-budget.mjs`; the
  `agent-instructions` → `agent-entry-points` mapping in
  `scripts/context/docs-index-helpers.mjs`.
- Paths-filter policy: [ADR 0010](0010-required-checks-no-paths-filters.md).
- Programme tracking issue:
  <https://github.com/mento-protocol/monitoring-monorepo/issues/1877>.
