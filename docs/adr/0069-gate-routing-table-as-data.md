---
title: The quality gate's routing table is data, compiled by the repo's own bash-case translator
status: active
owner: eng
canonical: true
last_verified: 2026-08-21
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0069 — the quality gate's routing table is data, compiled by the repo's own bash-`case` translator

**Status:** Active (Aug 2026). First implementation PR: the D5a step of
[issue 1877](https://github.com/mento-protocol/monitoring-monorepo/issues/1877)'s
deferred track.

**Scope:** ci/process

## Context

`scripts/agent-quality-gate.sh` is 5,878 lines and the largest file in the
repository. It is the subject of
[issue 1498](https://github.com/mento-protocol/monitoring-monorepo/issues/1498)
and the one hard-cap row [ADR 0065](0065-scripts-file-size-watchlist-scope.md)
deliberately refuses to exempt, on the ground that its split is expensive rather
than architecturally forbidden.

It is not one thing. The largest single region is routing: one `while IFS= read
-r path` loop over the changed set, holding **13 top-level `case` statements**,
**53 `case` statements** counting the nested ones, **232 arms**, **524 pattern
occurrences** (478 distinct), **29 effect verbs**, six inline guards, two global
flag mutations, and two pattern sets the gate computes from the tree at run
time. That is a table written as control flow.

Three properties the tree depends on are enforced by review alone once it is
written that way:

1. **Paired any-depth arms.** ADR 0064 requires that a literal-prefix glob
   anchored at the top of `scripts/` carries a companion `scripts/*/…` arm,
   because the first stops matching one directory down and **nothing reds** when
   it does. Two such globs exist today and both carry the pair; eleven further
   arms carry an any-depth sibling for an exact path. Nothing checks that the
   next one will.
2. **First-arm-wins ordering.** A new arm for `scripts/<dir>/deploy-*.sh` must
   sit above the widened pair or it never runs. The constraint lives in a
   comment.
3. **Literal freshness.** 362 distinct arm patterns name an exact path. A path
   that is deleted or moved leaves an arm that simply never matches. No check
   reds. This is the same failure class P0 fixed in
   `check-deploy-root-anchors.test.mjs`, which printed "All 0 deploy scripts…"
   and exited 0 over an empty subject list
   (`docs/adr/0064-scripts-module-directories.md:136-141`).

Meanwhile the routing is already consumed from Node in two places — a prewarm
tool that spawns the gate and parses its stdout
(`scripts/gate/agent-prewarm.mjs:37`) and a production-identity contract test
that does the same (`scripts/production-infra-identity-contract/routing.test.mjs:127`)
— and the gate already imports Node modules from `$script_source_dir` on every
run (`agent-quality-gate.sh:1963-1966`, `2747`).

## Decision

### 1. The routing table becomes data: an ES module tree at `scripts/gate/routing-table/`

An ordered, frozen array of rule groups. Each group is one of today's top-level
`case` statements; each group's `arms` array is ordered and first-match, so
precedence becomes an array index rather than a comment. Effects are a **closed**
verb set recorded under the gate's own bash function names; an unknown verb, a
duplicate group id, a malformed pattern, a bad guard or a wrong argument count
fails at import.

Validation runs at import and **fails closed**, and that direction is the point.
A malformed table must never produce a _smaller_ command plan, because a smaller
plan is a gate that passes while running fewer checks.

An ES module, not JSON, for four reasons. The arms carry load-bearing comments —
33 lines at the deploy pair alone (`agent-quality-gate.sh:3802-3834`), 76 at the
Sentry block (`:4440-4538`) — and a sidecar guarantees drift. `eslint.config.mjs`
already lints `scripts/**/*.mjs` and lints no JSON. Three arms need a path
template (`bash -n {path}`, `node --check {path}`) that a JSON literal cannot
express without an eval. And the gate already loads Node modules from
`$script_source_dir`, so this is an existing mechanism.

Two checks come with the data and are the point of the conversion:

- **A pairing lint**, at import. Any pattern of the shape
  `scripts/<literal-prefix>*…` must have its any-depth sibling in the same arm
  unless the arm carries `pairing: "deliberately-unpaired"` with a reason; and
  any arm that already carries a sibling must declare `pairing: "paired"`, so a
  later edit cannot delete one and leave a green table. ADR 0064's rule stops
  being prose.
- **A staleness check**, in the suite. Every glob-free pattern and every
  repo-relative path named inside a scheduled command must exist in the tree,
  with an `allowStale: "<reason>"` opt-out. One exemption exists today: the
  `.npmrc` / pnpmfile arm names package-manager configuration the repository
  does not carry, so that adding one routes an install on the commit that adds
  it rather than one commit later.

The two checks compose. An exact path is protected by staleness, which reds
loudly on a move; a prefix glob is protected by pairing, which is the case
staleness cannot see because a glob keeps matching something. The pairing rule
needs no opt-out on the table as it stands — every literal-prefix glob under
`scripts/` carries its sibling — and staleness needs the one named above.

Both opt-outs cost a stated reason. A bare flag would let the rule this table
exists to enforce be suppressed with one word, and leave the next reader unable
to tell a considered exception from a silenced check.

### 2. Patterns are compiled by the repo's own translator, never by a glob library

Bash `case` patterns are not filesystem globs. Verified on `/bin/bash`
3.2.57(1)-release, the repo's floor, and again on 5.3.15(1): `*` **and** `?` both
match `/`, and there is no globstar. `scripts/*/deploy-*.sh` matches
`scripts/deploy/a/b/deploy-bridge.sh`; `scripts/*.sh` matches `scripts/a/b/c.sh`;
`a?b` matches `a/b`.

Under `picomatch`, `minimatch`, or `fast-glob` defaults, `*` does not cross `/`,
so every arm would silently **narrow**: `*.md` would stop matching every `docs/**`
file, `scripts/*.sh` would stop matching `scripts/repo-health/dev-janitor.sh`,
and the gate would map fewer commands and still print "All mapped commands
passed."

So the matcher is a hand-written translator, and its test uses `/bin/bash` itself
as the oracle over every pattern in the table crossed with every literal path in
the table, every tracked repo path, one synthetic matching path per glob, and a
set of near misses per glob. The oracle runs on every bash the machine has, not
only the first on `PATH`, because 3.2 is what the pre-push hook runs on a Mac.
The machinery to run bash from Node already exists in
`scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-extract.mjs`
(`runProbeShell`, `probeDirs`).

The near misses are checked twice: the shell must agree that the synthetic match
matches and that at least one near miss does not. A control the shell rejects
controls nothing.

### 3. The bash arms stay, and an equality test holds the two together

Until the arms are retired, the table is a second copy of a routing authority,
and a second copy nobody compares is a copy that drifts. `gate-equality.test.mjs`
parses the gate's own routing region and asserts the two describe the same
routing — patterns, verbs, arguments, guards and order, with comments dropped on
both sides because rewording one is not a routing change.

The parser is narrow and **fails closed**: it recognises exactly the constructs
the routing region uses today and raises on anything else, naming the line. A
parser that skipped what it did not understand would report equality over the
subset it happened to read.

Because the arms are the code that runs, the equality test is also what makes a
`scripts/` move complete: it fails if only one side moved.

That is only true if it RUNS in both directions, so it is routed from both. A
change under `scripts/gate/routing-table/` schedules it, and so does a change to
`scripts/agent-quality-gate.sh` itself — the commoner drift, where somebody adds
or reorders an arm and does not touch the data. It also runs in the required
`ci` job, beside the routing regression suite and for the same stated reason:
the local pre-push gate is the thing a contributor can bypass, and a table that
has drifted from the arms fails nowhere at all.

### The new data is a pinned trust surface

Six pins land with the table:

1. **`implementation_signature()`** gains every module in the directory, suites
   included — the same treatment `scripts/agent-quality-gate.test.sh` and
   `scripts/terraform/terraform-fmt-check.test.mjs` already get, since a suite is
   part of what the gate proves about itself. An entry it cannot
   `stat` hashes as `__missing__`, which **freezes** the signature, so
   `--skip-if-fresh` reuses a stale stamp and skips real pre-push work
   (`docs/adr/0064-scripts-module-directories.md:273-275`). This is the one that
   must not be forgotten, and `routing-table.test.mjs` asserts it per module.
2. Two routing arms and one CI step, so the equality test runs in both drift
   directions: `scripts/gate/routing-table/*.mjs` schedules its suite and —
   because of pin 1 — the gate self-test; the gate's own arm schedules the
   routing-table suite; and the required `ci` job runs it too.
3. `turbo.json` inputs, beside the two existing gate entries in all three tasks.
4. Import-time schema validation and the pairing lint, failing closed.
5. The `scripts/AGENTS.md` pin registry, which ADR 0064 requires for any new pin.
6. ADR 0064's sweep-checklist item 9, so a `scripts/` move updates the data as
   well as the arms.

## Alternatives considered

**Keep the routing table as bash `case` arms.** Zero migration risk, and it is
what the repo did. Rejected: the three properties above are enforced by review
alone, and ADR 0064's consequences record four separate occasions where routing
went quiet rather than red. A table that is data can be linted; control flow
cannot.

**JSON plus a JSON Schema.** The obvious "table as data" answer, validated by a
standard tool. Rejected: the arms' comments are the reasoning that keeps the
pairing rule alive, JSON cannot hold them, and a sidecar for a hundred-plus
comments would drift within one phase. It also cannot express the templated
commands without an eval, and nothing in the repo lints JSON.

**YAML.** Holds comments. Rejected: it puts a YAML parser on the gate's hot
path, which runs on every pre-push, and the repo has already learned here that a
parse failure must fail closed rather than widen (`scripts/gate/lockfile-scope.mjs`
and `docs/notes/agent-quality-gate-mechanics.md:148-157`). A hand-checked module
has no parser to fail.

**Generate the data file from the bash source at build time.** Cheapest first
step and no duplication. Rejected as an end state: it makes the bash the source
of truth permanently, which is the thing this conversion exists to end. It is
however what the equality test does as a transitional check, in the opposite
direction — the table is authored, and the parse proves the arms agree.

**Compile patterns with `picomatch` or `minimatch`.** One dependency instead of
a translator and an oracle. Rejected on semantics, above: every arm would narrow
at once and the gate would stay green. This is the single largest correctness
hazard in the conversion and the reason the oracle test is not optional.

**Rewrite the whole gate in Node.** Rejected: the lock, drain and watchdog rest
on `mkdir`/`link`/`rename` atomicity, `ps -o lstart=` identity, `kill -0`, Bash
3.2 job-control PGIDs, argv tagging, and `/proc/<pid>/environ` plus `lsof`
scanning, with a safety argument made per crash boundary across ~300 lines of
runbook (`docs/notes/agent-quality-gate-mechanics.md:274-575`) and hardened as
recently as PRs 1916 and 1926. A Node rewrite re-derives all of it with no oracle
but a bash suite that itself drives bash fixtures.

**A bash entry point attesting a Node engine, as `agent-autoreview.sh` does.**
Rejected on threat model. Autoreview attests its runtime because it reviews a
possibly hostile branch and must not let that branch rewrite its own reviewer.
The gate's contract is the opposite: "The repo command itself is executable code
from the active checkout… Inspect a potentially hostile branch from a separate
trusted checkout rather than invoking that branch's package scripts"
(`docs/notes/agent-quality-gate-mechanics.md:799-803`). The gate exists to run
the checkout's own `pnpm` aliases and test suites; attesting its own runtime and
then executing the branch's suites buys nothing. ADR 0065 already ratifies the
asymmetry: all three exempt trust-root files are `agent-autoreview*`, and it
states that `agent-quality-gate.sh` "stays in the report".

**Adding the gate to `SCRIPTS_EXEMPTIONS` and closing 1498.** Would clear the
row. Rejected: it is the padding alternative ADR 0065 already rejected, and the
gate is not a trust root.

## Consequences

- **`scripts/gate/routing-table/` is a new pinned surface.** Every `scripts/`
  move must now update the data as well as the arms, and ADR 0064's sweep
  checklist gains it. A missing `implementation_signature()` entry freezes the
  signature and makes `--skip-if-fresh` reuse a stale stamp — the pin that must
  not be forgotten.
- **The table ships as eleven data modules plus five supporting ones**, cut on
  family boundaries, because the arms with the reasoning they carry are ~3,700
  formatted lines: ADR 0065 hard-caps a `scripts/` module at 1,000 and reports
  one at 600, and a table that lands as a size row on day one is a table whose
  first monthly triage is about its own layout. Size decided how many cuts;
  family decided where they fall. The index concatenates them in an explicit
  order and `routing-table.test.mjs` asserts the resulting group ids against a
  written-out list, because group order is routing.
- **The size row for `scripts/agent-quality-gate.sh` does not move in this step.**
  The table is additive; the arms stay. ADR 0065's exemption list does not
  change. `docs/notes/file-size-watch.md:49` records `3953 rough / 5665 raw` for
  the gate against a current 5,900 raw and is refreshed by its own monthly route,
  not here.
- **The routing-table suite is the slowest new check in `scripts/`.** The bash
  oracle runs ~473 patterns against ~4,900 paths on every installed bash, about
  8 seconds cold on this machine. It is routed by a change to the table, by a
  change to the gate, and by the required `ci` job, because it is the check the
  whole conversion rests on and a check that only runs on one side of a drift
  is no check at all.
- **The gate gains exactly one command on one existing arm.** Editing
  `scripts/agent-quality-gate.sh` now also schedules the routing-table suite.
  That is the one routing change in this step, and it is additive: for a changed
  set that does not name the gate, the dry-run plan is byte-identical to the
  plan before this decision.
- **Issue 1498 is not satisfied as written.** Its acceptance criteria name sourced
  `scripts/lib/gate-*.sh` helpers for the watchdog, stamps and executor —
  exactly the layers this decision keeps in bash. The criteria are rewritten
  rather than quietly satisfied: ADR 0065 cites 1498 by number as the reason the
  gate is not exempt, so the two records must stay consistent.
- **`check-sentry-suites-in-ci-gate-extract.mjs` gains a second consumer.** Its
  `runProbeShell` and `probeDirs` now back the routing oracle as well as the
  classifier probe, so a change to that module's shell plumbing reaches two
  checks. Its own routing arm already schedules its suite.
- **Reason strings are contract, not decoration.**
  `production-infra-identity-contract/routing.test.mjs` pins an arm by asserting
  its reason string, because `add_command` deduplicates on the command and keeps
  the first reason. The table carries reasons verbatim and preserves
  first-wins order; the equality test is what keeps that true.
- **The gate self-test still has no focus partition**, so any later step in this
  track pays it in full. Adding one is separate work.

## Evidence

- Routing region, measured at `4f8feaac`: `scripts/agent-quality-gate.sh:3157-4593`
  — 13 top-level `case` statements, 53 counting nested, 232 arms, 478 distinct
  patterns of which 362 are glob-free, 29 verbs.
- Paired-arm rationale, verbatim in the source: `agent-quality-gate.sh:3802-3834`.
- `implementation_signature()`: `agent-quality-gate.sh:4667`.
- Routing consumers: `scripts/gate/agent-prewarm.mjs:37`;
  `scripts/production-infra-identity-contract/routing.test.mjs:127`.
- Bash-from-Node machinery reused by the oracle:
  `scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-extract.mjs`.
- Gate threat model: `docs/notes/agent-quality-gate-mechanics.md:799-803`.
- Pin rules and silent-failure classes: [ADR 0064](0064-scripts-module-directories.md).
- Watchlist scope and the gate's deliberate non-exemption:
  [ADR 0065](0065-scripts-file-size-watchlist-scope.md);
  `scripts/repo-health/file-size-watchlist.mjs:19-45`.
- Bash `case` semantics: probed on `/bin/bash` 3.2.57(1)-release and
  `/opt/homebrew/bin/bash` 5.3.15(1)-release by
  `scripts/gate/routing-table/pattern-oracle.test.mjs`, which is the standing
  proof rather than a one-off measurement.
- Deferred-track queue: <https://github.com/mento-protocol/monitoring-monorepo/issues/1877>
- Gate-split owner: <https://github.com/mento-protocol/monitoring-monorepo/issues/1498>
