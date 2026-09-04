---
title: The Markdown globs route to a small docs-checks CI job instead of the scripts job
status: active
owner: eng
canonical: true
last_verified: 2026-09-04
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0072 — the Markdown globs route to `docs-checks`, not the long-running `scripts` job

**Status:** Accepted (Aug 2026), amended 2026-09-04, in force.
**Scope:** ci/process

The 2026-09-04 M6 amendment removed `agent:quality-gate:test` from required CI.
The `docs-checks` split and its `gate:routing-table:test` coverage remain in
force. References below to keeping the legacy gate suite in `scripts` describe
the original decision and no longer define current CI behavior.

## Context

The `rootScripts` paths-filter carried `*.md` and `**/*.md`, so any Markdown
edit fired the `scripts` job: 52 steps, a long timeout, a full-history
checkout, and a whole-workspace `pnpm install`. A one-line typo fix in a note
under `docs/notes/` paid the same CI bill as a rewrite of the quality gate.

A review of 11 reflection-family PRs across the mento-protocol repos measured
what that bought. Ten of the eleven were Markdown-only; the exception also
touched a workflow file. Across all eleven, the full review and CI machinery
produced two actionable findings, both cosmetic wording fixes: a percentage
phrased as "faster" where it described a reduction, and an inclusive-timestamp
wording. Zero correctness defects. Every one of the eleven ran full-length CI.

The `scripts` job holds twelve documentation-related steps. Six read the live
tracked Markdown tree through `git ls-files`, so an added, renamed, removed or
edited document can change their verdict: `agent:context-check`,
`docs:index --check`, `agent:context-budget --strict`, `docs:audit --dry-run`,
`docs:navigation-eval -- --check-fixtures`, and the committed-baseline
`docs:navigation-eval -- --validate`.

Of the other six, three are unit suites that build their fixtures in a temporary
repository or stub their inputs, so no Markdown edit can change what they
report: `check-agent-context.test.mjs`, `docs:audit:test` and
`docs:garden:test`. The other three read this checkout despite looking like
fixture suites, and all three were misread as synthetic in earlier drafts of
this decision. Two are carried into the new job:

- `agent:context-budget:test` builds its last case from
  `trackedInstructionFiles(repoRoot)` against the real root and pins the result
  to the ten `AGENTS.md` route directories that exist today
  (`scripts/context/agent-context-budget.test.mjs:33,349`). Adding
  `docs/AGENTS.md`, or deleting `alerts/AGENTS.md`, is a Markdown-only diff
  that fails it. `agent:context-budget --strict` would not catch that: it
  enforces byte caps, not the route list.
- `docs:navigation-eval:test` loads the live inventory at module scope and
  asserts which accepted route is cheapest in real document bytes
  (`scripts/docs/docs-navigation-eval.test.mjs:42,63,440`). `quick-commands.md`
  is 13,084 bytes against a 24,556-byte alternative, so a content-only edit
  that grows it past that margin flips the assertion.
  `docs:navigation-eval -- --check-fixtures` would not catch that either: it
  rejects paths missing from the inventory, not a changed size ranking.

The third, `docs:index:test`, reads the live tree too — one case resolves the
real repository root, builds the inventory over every tracked Markdown file and
asserts `inventory.errors` is empty
(`scripts/context/docs-index.test.mjs:401-414`) — but it is not carried, for the
reason given under Alternatives: that assertion is a strict subset of what
`docs:index --check` already enforces in this job.

Two steps outside the documentation group also read the corpus. The first is
`gate:routing-table:test`, which checks
[ADR 0069](0069-gate-routing-table-as-data.md)'s routing data, and its staleness
assertion calls `existsSync` on all 799 path subjects the table names — 23 of
them Markdown, including eleven of the twelve `docs/pr-checklists/*.md` (all
but `review-prompt-exclusions.md`), `README.md`, `AGENTS.md`, `BACKLOG.md`,
`SPEC.md` and two ADRs. Renaming or deleting one of those documents is a
Markdown-only diff that breaks the gate.

The second is `agent:quality-gate:test`. The gate's Trunk mapping emits
`./tools/trunk check --ci <paths>` when every changed path still exists in the
worktree and `./tools/trunk check --ci --all` when one does not
(`scripts/gate/mapping/post-passes.mjs:38-55`), and the suite pins the first
branch on a real tracked document, `docs/deployment.md`
(`scripts/agent-quality-gate.test.sh:5372-5384`); the contrast case at
`:5506-5509` runs the gate over `docs/deleted.md` and expects `--all`, so the
branch turns on worktree existence alone. Deleting or renaming
`docs/deployment.md` is therefore a Markdown-only diff that fails this suite. It
is not carried into the new job, because that same file is one of the routing
table's staleness subjects (`scripts/gate/routing-table/groups-head.mjs:129`),
so `gate:routing-table:test` fails first on exactly that diff.

Eleven steps in the `scripts` job read the Markdown corpus, then. Nine move into
the new job. The other two — `docs:index:test` and `agent:quality-gate:test` —
fail only on a diff that also fails a check the new job carries, so they stay
where they are.

[ADR 0062](0062-sentry-suites-self-run-gate.md) split a check family out of this
same `scripts` job and reads as precedent, but the two decisions answer
different questions. ADR 0062 fixed a required-check availability bug: the
Sentry suites could go permanently un-run on a diff that missed the filter, so
its new job is unconditional and deliberately absent from `allowed-skips`. This
decision is cost-motivated. Nothing here is un-run today; the checks simply run
inside a job an order of magnitude larger than they need. So this job is
conditional and skippable, the opposite treatment, for the opposite reason.

## Decision

Move `*.md` and `**/*.md` out of `rootScripts` into a new `docs` paths-filter,
byte-identical, and add a `docs-checks` job gated on it.

- `docs-checks` runs `if: needs.changes.outputs.docs == 'true'` on
  `blacksmith-2vcpu-ubuntu-2404` with `timeout-minutes: 10` and only
  `contents: read` plus `actions: read` — none of its nine checks calls the
  GitHub API.
- It carries nine of the eleven corpus readers named in the Context above, each
  `run:` string byte-identical to its counterpart in `scripts`. The other two,
  `docs:index:test` and `agent:quality-gate:test`, stay behind; see
  Alternatives.
- The `docs` filter also lists `.github/workflows/ci.yml` and
  `.github/actions/pnpm-install/**`, the two files the job is built from. Every
  other filter in `ci.yml` lists `ci.yml` for the same reason: without it, a PR
  that edits this job's own definition sets only `rootScripts`, `docs-checks`
  skips, and the edited job ships without ever having run.
- Its checkout sets `fetch-depth: 0`. The committed navigation baseline names
  `repository_base_commit` `a82f8c58`, and the validate step reads source blobs
  at that commit with `git show`. On the default shallow checkout the object is
  absent and the step throws rather than degrading.
- `node scripts/check-agent-quality-gate-package-scripts.mjs` runs before
  `pnpm install`, as it does in `scripts`. This job invokes the same trusted
  `pnpm` aliases and runs the same root lifecycle hooks, so it needs its own
  copy of the pin validator — on a Markdown-only diff, the `scripts` copy never
  executes. That ordering is machine-pinned, not conventional:
  `check-sentry-suites-in-ci-lifecycle.test.mjs` hard-coded the job name
  `"scripts"` at its only call site of `pinValidationOrderBlockers`, and this
  change parameterizes it over `["scripts", "docs-checks"]`. Both of its probes
  — drop the validator, move it after install — work unchanged for either name,
  so a later PR that reorders this job fails required CI the same way it would
  in `scripts`.
- All nine steps stay in `scripts` as well. A change to the documentation
  tooling must still run them against the real corpus. A mixed diff sets both
  filters, runs both jobs, and pays for one duplicate pass.
- The three synthetic-fixture documentation suites, `docs:index:test` and
  `agent:quality-gate:test` stay in `scripts` only.
- The `ci` sentinel gains `docs-checks` in both `needs` and `allowed-skips`,
  the treatment every path-gated job gets. No branch-ruleset change: the split
  lives inside the already-required `ci.yml`.
- `scripts/sentry/ci-wiring/check-sentry-suites-in-ci-core.mjs` counts the
  sentinel's path-gated dependencies in prose; that count moves from fourteen
  to fifteen in the same change.

## Alternatives considered

**Leave it as it is.** Rejected: the measured return on a full `scripts` run
over a Markdown-only diff was two cosmetic wording findings across eleven PRs,
and neither came from a CI step.

**Make the `scripts` job faster instead.** Rejected: it is not slow by
accident. Its 52 steps are load-bearing regression suites for gate routing,
supply-chain policy, workflow trust, and alert rules, and its own comment
records that the quality-gate routing regression suite reached 39m02s in main
CI run `33535970973`, attempt 1, job `99950409872`. Cutting the job to fit
Markdown PRs would weaken it for the code PRs it exists to guard.

**Put a workflow-level `paths:` filter on `ci.yml`, or promote a separate
required `docs` workflow with one.** Rejected by
[ADR 0010](0010-required-checks-no-paths-filters.md) and by
[the CI workflow gates checklist](../pr-checklists/ci-workflow-gates.md): a
ruleset-required check that does not run stays pending forever and blocks the
merge. Path-conditional work runs on every PR and skips inside via `if:`, which
is what this decision does.

**Make `docs-checks` unconditional, as ADR 0062 did for `sentry-suites`.**
Rejected: that treatment costs every PR a full install to run checks most of
them cannot affect, and it buys nothing here. The availability gap 0062 closed
does not exist for these nine checks — they remain reachable through
`rootScripts` for every non-Markdown diff that can influence them.

**Move all six documentation unit suites into `docs-checks`.** Rejected for
four of them, on two different grounds. Three —
`check-agent-context.test.mjs`, `docs:audit:test` and `docs:garden:test` —
build their fixtures in a temporary repository or stub their inputs, so a
Markdown-only PR cannot change their result, and running them here would add
cost without adding a signal. The fourth, `docs:index:test`, does read the
tracked tree, but only to assert that `inventory.errors` is empty; the carried
`docs:index --check` fails on errors, warnings _or_ broken links
(`hasBlockingProblems`, `scripts/context/docs-index.mjs:74-80`), and a deleted
or non-regular runtime document is rejected by
`loadClaudeRuntimeDocumentRegistry`
(`scripts/context/claude-runtime-document-registry.mjs:312-333`), which both
`docs:index --check` and `agent:context-check` import. No Markdown-only diff
was found that fails `docs:index:test` while every check in this job stays
green, so it is subsumed rather than synthetic. The other two,
`agent:context-budget:test` and `docs:navigation-eval:test`, are carried: each
was verified to read this checkout, and each has a concrete Markdown-only diff
that fails it on `main` while every other check in this job stays green. Leaving
them out would let such a PR merge and break the `scripts` job for the next
unrelated code PR.

**Carry `agent:quality-gate:test` too.** Rejected: it is an 11,000-line shell
suite that drives the whole quality gate, and the single Markdown-only diff
that fails it — deleting or renaming `docs/deployment.md` — already fails
`gate:routing-table:test`, which this job does run. The cover is transitive,
which is why it is stated here and in the job comment rather than left implicit:
drop `docs/deployment.md` from the routing table in a later `scripts/**` PR —
which fires `rootScripts` and stays green at the time — and this gap opens with
nothing to announce it. A maintainer who does that should carry
`agent:quality-gate:test` into `docs-checks` in the same change.

**Leave `gate:routing-table:test` in `scripts` only and accept the gap.**
Rejected: renaming `docs/pr-checklists/mutation-testing.md` and regenerating
`docs/README.md` is a Markdown-only diff. Today it fails the staleness check;
without this step in `docs-checks` it would merge green with the gate naming a
document that no longer exists — the quietest failure the check exists to
prevent, and squarely the docs-gardening workload this change is meant to
speed up. The suite is offline and needs no extra permissions, so carrying it
costs a duplicate run on mixed diffs and nothing else.

## Consequences

- **A Markdown-only PR runs a ten-minute-capped job instead of the long-running
  `scripts` job.** The checks that can actually fail on a
  Markdown edit are exactly the ones that still run.
- **A new Markdown-triggered check now has two candidate jobs, not one.**
  Whoever adds one must decide where it belongs: if it reads the tracked
  Markdown tree it goes in `docs-checks`, and also in `scripts` when a tooling
  change must re-run it. The only ground for leaving such a check out of
  `docs-checks` is that a check already in the job strictly subsumes it — as
  `docs:index --check` subsumes `docs:index:test`'s live-tree case — and that
  reasoning must be written down where the exclusion is made. This is the
  constraint this ADR imposes.
- **The nine checks now exist in two jobs and must move together.** A step
  added to one and forgotten in the other silently narrows coverage for one
  class of diff. Nothing machine-checks that pairing today; the `run:` strings
  are kept byte-identical so a diff of the two step lists shows the drift.
- **Membership rests on reading each suite, and that reading is fallible.**
  Four of the eleven corpus readers — `agent:context-budget:test`,
  `docs:navigation-eval:test`, `docs:index:test` and `agent:quality-gate:test` —
  were missed in review across two rounds: three read as synthetic-fixture
  suites, and the fourth was not read as a corpus reader at all. Each was
  reclassified only after its assertions were traced to the live tree. A
  suite that looks like a fixture test can still read this checkout. Adding a
  step to `scripts` that does so, without also adding it here, reopens the gap
  this decision closes, and no check will say so.
- **One of the eleven is covered transitively, not structurally.**
  `agent:quality-gate:test` stays in `scripts`, and the diff that fails it —
  removing `docs/deployment.md` — is caught here only because that path is also
  a routing-table staleness subject. Removing it from the routing table would
  fire `rootScripts`, pass at the time, and silently open the gap.
- **A Markdown-only edit under a path that stays in `rootScripts` now costs
  more, not less.** `.agents/**`, `.claude/skills/**`, `alerts/infra/**` and
  the other non-Markdown globs keep routing their own Markdown to `scripts`,
  and such a diff now sets both filters: the long-running job runs
  exactly as today, plus a second runner repeating nine of its steps. That is
  about one tracked Markdown file in five — 43 of 201, of which 17 sit under
  `.agents/` and 15 under `.claude/skills/`, the skills mirror this repo
  gardens most often. For those PRs this change is pure added cost. Narrowing
  those globs to their non-Markdown contents would fix it and is deliberately
  out of scope here: it changes which job sees a skill edit, which is a
  separate decision from relocating the two Markdown globs.
- **A Markdown-only PR no longer runs the rest of the `scripts` job**, which
  includes the three synthetic-fixture documentation suites, `docs:index:test`,
  and every non-documentation step (ESLint on root scripts, the agent
  quality-gate routing suite, CodeRabbit config pin, notifier coverage, autofix
  trust, supply-chain suites). Every remaining step was read for reads of the
  real Markdown tree; outside the documentation group the two found were
  `gate:routing-table:test`, which is carried here, and
  `agent:quality-gate:test`, which is covered through it. The rest take their
  input from `scripts/**`, `.github/workflows/**`, config files, and their own
  fixtures, all of which stay in `rootScripts` unchanged, so a diff that can
  affect them still fires `scripts`.
- **A skipped `docs-checks` satisfies the `ci` sentinel**, exactly like a
  skipped `scripts`. Adding it to `needs` without `allowed-skips` would fail
  the required check on every non-Markdown PR. That pairing is convention
  plus alls-green semantics, not a machine check:
  `check-sentry-suites-in-ci-core.mjs` enforces `allowed-skips` membership only
  for entries in `TRUSTED_JOBS`, which holds one job mapped to `null`, and the
  guard reads `trusted.get(name) != null`. Removing `docs-checks` from
  `allowed-skips` would fail no test — it would fail the required `ci` context
  on every non-Markdown PR instead.

## Evidence

- `.github/workflows/ci.yml`: the `scripts` job carries 52 steps and
  `timeout-minutes: 55`; `docs-checks` carries 13 steps and
  `timeout-minutes: 10`.
- `stalenessSubjects(ROUTING_GROUPS)` from `scripts/gate/routing-table/`
  returns 799 path subjects, 631 distinct, of which 23 are Markdown files —
  eleven `docs/pr-checklists/` entries, not all twelve tracked there;
  `docs/pr-checklists/review-prompt-exclusions.md` is not a subject.
  `scripts/gate/routing-table/routing-table.test.mjs` asserts each exists.
- `scripts/context/agent-context-budget.test.mjs:33` resolves `repoRoot` to the
  real repository root, and its case at line 349 pins
  `report.routes.map(({ route }) => route)` to the ten `AGENTS.md` directories
  `git ls-files` returns today. `scripts/docs/docs-navigation-eval.test.mjs:42`
  does the same and its case at line 440 pins two cheapest-route selections to
  `docs/notes/quick-commands.md`, chosen by live byte size (13,084 bytes,
  against 24,556 and 24,886 for the two alternatives). Both suites are
  therefore carried into `docs-checks`.
- `scripts/context/docs-index.test.mjs:401-414` resolves the real repository
  root, calls `trackedDocumentationFiles` on it, and asserts
  `inventory.errors` deep-equals `[]`. `hasBlockingProblems`
  (`scripts/context/docs-index.mjs:74-80`) fails on `errors`, `warnings` or
  `broken_links`, so `docs:index --check` is the stricter of the two, and
  `loadClaudeRuntimeDocumentRegistry`
  (`scripts/context/claude-runtime-document-registry.mjs:312-333`) — imported by
  `check-agent-context.mjs:21` and `docs-index-helpers.mjs:12` — rejects a
  deleted or non-regular runtime document. This is why the suite is left in
  `scripts`.
- `addTrunkCheckCommand` (`scripts/gate/mapping/post-passes.mjs:38-55`) selects
  `./tools/trunk check --ci --all` when any changed path is absent from the
  worktree. `scripts/agent-quality-gate.test.sh:5372-5384` pins the targeted
  branch on `docs/deployment.md` twice; `:5506-5509` pins the `--all` branch on
  `docs/deleted.md`. `scripts/gate/routing-table/groups-head.mjs:129` lists
  `docs/deployment.md` as a staleness subject, which is what makes
  `gate:routing-table:test` cover this suite for the diff that would break it.
- Matching the tracked `*.md` list against the non-Markdown `rootScripts`
  globs that this change leaves in place gives 43 of 201 files (21%): 17 under
  `.agents/`, 15 under `.claude/skills/`, 7 under `alerts/`, 2 under
  `scripts/`, 2 under `terraform/`. A filesystem walk of the checkout
  reproduces the two largest buckets exactly. Those PRs run both jobs.
- `pinValidationOrderBlockers` is called from exactly one place,
  `scripts/sentry/ci-wiring/check-sentry-suites-in-ci-lifecycle.test.mjs`, with
  the job name `"scripts"` hard-coded. Running it against the candidate with
  `"docs-checks"` returns `[]`, and both of its probes are rejected for that
  name, so parameterizing the test is sufficient to pin the new job's ordering.
- `docs/evals/documentation-navigation-baseline.json` records
  `run.repository_base_commit` `a82f8c580d145806865f031755c7b5411f89c976`,
  executed `2026-07-21T21:21:54Z` — over a month of commits behind `main` at
  the time of this change, so a depth-1 checkout does not hold that object.
  This is why `fetch-depth: 0` is not optional for this job.
- `scripts/production-infra-identity-contract/routing.test.mjs` pins
  `filters.rootScripts` content and the `scripts` job's
  `needs.changes.outputs.rootScripts == 'true'` condition. Neither Markdown glob
  appears in anything it requires, so relocating them keeps it green.
- `actionlint` 1.7.8 with `.trunk/configs/actionlint.yaml`, `yamllint` 1.38.0
  with `.trunk/configs/.yamllint.yaml`, and `prettier` 3.8.1 — the versions
  `.trunk/trunk.yaml` pins — all report clean on the edited workflow and on the
  parameterized lifecycle test.
