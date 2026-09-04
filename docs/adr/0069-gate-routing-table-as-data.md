---
title: The quality gate's routing table is data, compiled by the repo's own bash-case translator
status: active
owner: eng
canonical: true
last_verified: 2026-08-24
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0069 — the quality gate's routing table is data, compiled by the repo's own bash-`case` translator

**Status:** Active (Aug 2026), complete. Implemented across four PRs of
[issue 1877](https://github.com/mento-protocol/monitoring-monorepo/issues/1877)'s
deferred D5 track: D5a made the table data, D5b landed the Node mapping engine
and proved it at parity, D5b part 2 made it the routing behind an in-production
parity guard, and D5c retired the bash arms, that guard and the parity harness
once the soak was clean
([issue 2020](https://github.com/mento-protocol/monitoring-monorepo/issues/2020)).
Sections 3 and 4 below describe the transitional machinery and are kept for the
record; what is live is the table, the engine, and the checks in section 5.

**Scope:** ci/process

## Context

`scripts/agent-quality-gate.sh` was 6,100 lines and the largest file in the
repository when this decision began. It was the subject of
[issue 1498](https://github.com/mento-protocol/monitoring-monorepo/issues/1498)
and the one hard-cap row [ADR 0065](0065-scripts-file-size-watchlist-scope.md)
deliberately refuses to exempt, on the ground that its split is expensive rather
than architecturally forbidden. D5c later removed the routing arms and exposed
the residual process-control and execution layers governed by this decision.

It is not one thing. The largest single region is routing: one `while IFS= read
-r path` loop over the changed set, holding **13 top-level `case` statements**,
**55 `case` statements** counting the nested ones, **240 arms**, **829 pattern
occurrences** (761 distinct), **29 effect verbs**, six inline guards, two global
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
3. **Literal freshness.** 619 distinct arm patterns name an exact path. A path
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
- **A staleness check**, in the suite. Every glob-free pattern, every checklist
  an arm points a reviewer at, every `pathEquals` guard literal, and every
  repo-relative path named inside a scheduled command must exist in the tree.
  The opt-out is `allowStale`, a map from the exact pattern it exempts to that
  pattern's own reason — deliberately not a flag on the arm, because an arm-wide
  exemption covers every literal anyone adds to that arm later, including ones
  nobody decided to exempt. Three entries exist today, all on the same arm: the
  `.npmrc` and pnpmfile paths name package-manager configuration this repository
  does not carry, so that adding one routes an install on the commit that adds
  it rather than one commit later. Each entry is retirement-checked: an exempted
  path that has since appeared fails, so a dead exemption cannot sit there.

The two checks compose. An exact path is protected by staleness, which reds
loudly on a move; a prefix glob is protected by pairing, which is the case
staleness cannot see because a glob keeps matching something. The pairing rule
needs no opt-out on the table as it stands — every literal-prefix glob under
`scripts/` carries its sibling — and staleness needs the three named above.

Both opt-outs cost a stated reason. A bare flag would let the rule this table
exists to enforce be suppressed with one word, and leave the next reader unable
to tell a considered exception from a silenced check.

One routing family had an external data source. The indexer handler-invariant
classifier now sits beside the table, in
`gate/routing-table/indexer-handler-invariant-contract.mjs` (validation and the
two public exports) and `indexer-handler-invariant-families.mjs` (the data). The
contract exports a detached, deeply frozen family view and consumes that same
view for its `{path, route, owner}` decisions. It validates the family schema
before export: unknown fields, invalid types, overlapping exact owners, and
Bash-unsafe literal paths fail import. `scripts/agent-autoreview-core.mjs` held
a duplicate copy of the same data, kept in step by a parity test, until
[ADR 0086](0086-autoreview-removal-thin-two-model-review.md) deleted it. The contract is
now the single source, and an edit to it or to the family data routes the
handler-invariant checklist.

`arms-packages.mjs` derives two first-match arms from that view. Explicit
`route: false` families form the excluded arm. Routed exact paths form the
second arm. The live Bash case carries the same exact patterns, so the normal
equality test pins the derived table against the code that runs. Eighteen
future patterns cover `src|test` plus
`ts|tsx|mts|cts|js|jsx|mjs|cjs|json`. The four JavaScript extensions match the
package's `allowJs` TypeScript input set. JSON matches `resolveJsonModule`. Five
broad patterns cover `abis/`, `config/`, root `config*.yaml`, root `vitest*`,
and `scripts/test-*.mjs` inputs. These 23 broad patterns only trigger the
inventory check. They do not enter either checklist arm. The exact
`schema.graphql` and `stryker.config.mjs` patterns complete the 25-pattern
inventory. The module fallback returns `route: false`
until the adding PR gives the path an explicit owner. New ABI,
config-directory, root config YAML, root Vitest, and indexer test-wrapper files
also inherit no checklist route. Exact owners cover every current ABI,
config-directory, root config YAML, root Vitest input, and indexer test wrapper,
plus `schema.graphql` and the Stryker mutation-test configuration. The current
exact arms contain 253 routed paths and 12 excluded paths.
A source path routes when the production handler entrypoint, a registered
handler, an RPC facade or effect, or a self-heal stage executes it and the
module can change an entity identity or field, a rollup, an effect key or
target, freshness, or phase behavior. This rule includes ABI and address
sources, environment and instrumentation modules, and shared handler
calculations. A test routes when it enforces one of those behaviors or provides
the fixtures, harness, or HTTP mock boundary that makes the enforcing test
hermetic. Test-runner inputs route when they set its timeout, fail-closed
fixture, hermetic RPC boundary, or mutation-test and coverage scope. Type-only
context modules, warning-only helpers, the console-only RPC logger adapter, the
two vendored ABIs that no current runtime consumes, and tests limited to an
independent config-copy, script, or warning-format contract stay explicitly
excluded.
A focused parity test covers all current JS, JSON, and TypeScript module paths
below `src/` and `test/`, every current file below `abis/` and `config/`, every
current root `config*.yaml` file, Vitest input, indexer test wrapper, Stryker
configuration, `schema.graphql`, exact owners, exclusions, and synthetic future
extensions. The local indexer route runs it for these 25 inventory patterns,
and the indexer CI job runs it for every indexer change. A new module below
`src/` or `test/`, root config YAML, root Vitest input, indexer test wrapper,
ABI, or config file must gain an explicit owner in the PR that adds it.

Autoreview imported the classifier from its own attested runtime, and verified
that runtime's sealed identity and content manifest around every classifier
process. It loaded only the core copy of the family data, which
`scripts/indexer-handler-invariant-contract.test.mjs` kept in step with this
one. [ADR 0086](0086-autoreview-removal-thin-two-model-review.md) deleted the wrapper and
that copy, so the gate is the only consumer left. When a candidate
changes either `gate/routing-table/indexer-handler-invariant-*.mjs` module, the
classifier that decides still comes from the gate's own checkout and cannot see
a new owner or a false-to-true reclassification in the candidate revision. Both
paths therefore select the handler-invariant checklist. This source trigger
intentionally routes unrelated edits. Executing the candidate classifier would
break that trust boundary.

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

### 3. TRANSITIONAL (D5a–D5b): the bash arms stay, and an equality test holds the two together

**Retired at D5c.** `gate-equality.test.mjs` and the `gate-arms.mjs` parser it
rested on are deleted; the table is the only copy of the routing now, so there is
nothing left to compare it against. The routing-table suite kept every check that
was about the DATA — the schema, the pairing lint, staleness, the bash pattern
oracle — and gained the closed verb set, measured against
`scripts/gate/mapping/route.mjs` instead of against the gate's bash helpers.

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

### 4. D5b part 2: the engine becomes the routing, behind a guard that runs in production

**The guard is retired; the first paragraph is what stands.** The gate runs
`scripts/gate/mapping.mjs` once and executes its plan, and every refusal in the
paragraph beginning "Every failure around the seam" is still live. What went at
D5c is the arms, `plan_records_from_bash`, and the byte comparison between them.

The gate no longer builds its plan from the `case` arms. It runs
`scripts/gate/mapping.mjs` once per run, reads the plan back as the TSV
`write_command_plan` already emits, and uses that. The arms still execute, and
the gate **refuses the whole run if the two plans differ by one byte** — every
record, in order, including the two run-scoped flags the routing sets.

That guard is the point of the split. The parity harness proved agreement over
a corpus; this proves it over whatever a contributor actually changed, on every
run, on every machine. It is also what makes the step reversible without a
revert: a divergence stops the run rather than silently picking a winner, and
the arms are still sitting there.

Every failure around the seam is a refusal, because the failure mode this whole
track exists to remove is a plan that came out smaller and still exited 0: a
mapper that cannot be found, exits non-zero, emits nothing, emits a record the
gate cannot parse, or names a bucket that does not exist. Measured, each of
those refuses with exit 2 (evidence below).

**Why the arms stayed for a soak rather than going in the same PR.** The engine's
plan is hashed into the freshness stamp and executed. The arms cost nothing but
wall-clock, and while they ran, every gate invocation anyone made was another
parity sample on a path set nobody thought to put in a corpus. D5c deletes the
arms, the comparison, and the harness together, once the soak has produced no
refusal.

### 5. D5c: what the soak produced, and what routing correctness rests on now

The soak was clean. Measured on `3eb5ff55`, macOS, unsandboxed, against the live
gate's dry run — the guard executes before the dry-run exit, so a dry run is a
real sample:

- **399 real historical changed-path sets** (every commit on `main` for the last
  400, each against its true `sha^` base): 399/399 exit 0, zero refusals.
- The same corpus at a **30-commit-deep base** (120 sets): 120/120 clean.
- **40 sets on a dirty tree** (an untracked directory, a modified tracked file,
  and a directory symlink under `scripts/`): 40/40 clean.
- **Negative control**: changing one word in the engine's targeted-Trunk reason
  string made 12 of 20 sets refuse. The other 8 take the full-scan branch, where
  that string never appears — so the control discriminates rather than firing on
  everything. Restored, clean.
- **Linux**: the gate self-test invokes the real gate, so the guard ran inside
  its assertions; `pnpm agent:quality-gate:test` was green in 26 CI runs after
  the swap.

One initial refusal was traced to the operator's sandbox rather than to the
routing, and it is the reason **the gate must be run unsandboxed**: `stat` was
denied on `**/.env.*`, so bash's CWD-relative `[[ -e ]]` saw two `.env.*example`
files as missing and routed a full-repo Trunk scan, while the engine's
`existsSync(join(repoRoot, path))` saw them and routed a targeted one. Unsandboxed
the same corpus passes 399/399, and after D5c there is no second oracle for a
sandbox to disagree with.

**What routing correctness rests on now.** The arms were the oracle; deleting
them leaves two suites and nothing else, which is why both are routed from every
side that can change them and one of them is also in the required `ci` job:

- `pnpm gate:routing-table:test` — the schema, group order, ADR 0064's pairing
  lint, path staleness, the `/bin/bash` pattern oracle, and the closed verb set
  checked against `scripts/gate/mapping/route.mjs` in both directions and at the
  arity each implementation actually reads. It also holds the
  `implementation_signature()` pins, split into `pins.test.mjs` when D5c took
  `routing-table.test.mjs` to the 1,000-line cap.
- `node --test scripts/gate/mapping/engine.test.mjs` — dedupe and
  first-reason-wins, the alias pairs, prepend, bucket order, the six post-passes
  and the root-manifest classifier.

**One residual, deliberately kept.** The gate still runs the routing-sensitive
classifier itself, ahead of the engine, and validates that its answer is
`true`/`false`. The engine classifies routing-sensitivity too and decides the
`--check-fixtures` command from its own answer, so the bash block no longer feeds
routing — what it buys is a refusal that names
`scripts/docs/docs-navigation-eval-helpers.mjs` by path instead of surfacing as
`gate mapping engine failed (exit 3)`. Its literal is pinned and both its
messages are asserted by the gate self-test. Folding that pin onto the engine's
stderr is a separate change with its own fixture work.

### The new data is a pinned trust surface

Six pins land with the table:

1. **`implementation_signature()`** gains every module in the directory, suites
   included — the two handler-invariant classifier modules among them.
   `scripts/agent-autoreview-core.mjs` carried an entry too while it held the
   duplicate family copy;
   [ADR 0086](0086-autoreview-removal-thin-two-model-review.md) removed both the file and
   the entry. That is the same treatment `scripts/agent-quality-gate.test.sh`
   and
   `scripts/terraform/terraform-fmt-check.test.mjs` already get, since a suite is
   part of what the gate proves about itself. An entry it cannot
   `stat` hashes as `__missing__`, which **freezes** the signature, so
   `--skip-if-fresh` reuses a stale stamp and skips real pre-push work
   (`docs/adr/0064-scripts-module-directories.md:273-275`). This is the one that
   must not be forgotten, and `routing-table.test.mjs` asserts it per module.
   Runtime modules hash from the gate's `$script_source_dir`; suites and the
   parity harness hash from the target `$repo_root` where their commands run.
2. Routing arms and CI steps make the equality test run in both drift
   directions: `scripts/gate/routing-table/*.mjs` schedules its suite and —
   because of pin 1 — the gate self-test; the gate's own arm schedules the
   routing-table suite; and the required `ci` job runs it too. The indexer job
   runs the focused parity test. A core-only edit scheduled both gate suites
   until [ADR 0086](0086-autoreview-removal-thin-two-model-review.md) deleted the core.
3. `turbo.json` inputs, beside the two existing gate entries in all three tasks,
   include the table directory. Its external core source had an entry beside it
   until [ADR 0086](0086-autoreview-removal-thin-two-model-review.md) deleted that file.
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

**A bash entry point attesting a Node engine, as `agent-autoreview.sh` did.**
Rejected on threat model. Autoreview attested its runtime because it reviewed a
possibly hostile branch and could not let that branch rewrite its own reviewer.
The gate's contract is the opposite: "The repo command itself is executable code
from the active checkout… Inspect a potentially hostile branch from a separate
trusted checkout rather than invoking that branch's package scripts"
(`docs/notes/agent-quality-gate-mechanics.md:799-803`). The gate exists to run
the checkout's own `pnpm` aliases and test suites; attesting its own runtime and
then executing the branch's suites buys nothing. ADR 0065 already ratified the
asymmetry: all three exempt trust-root files were `agent-autoreview*`, and it
states that `agent-quality-gate.sh` "stays in the report".
[ADR 0086](0086-autoreview-removal-thin-two-model-review.md) deleted those three files, so
`SCRIPTS_EXEMPTIONS` is now empty and the gate still stays in the report.

**Adding the gate to `SCRIPTS_EXEMPTIONS` and closing 1498.** Would clear the
row. Rejected: it is the padding alternative ADR 0065 already rejected, and the
gate is not a trust root.

## Consequences

- **Routing is Node, and the pins moved with it.** `implementation_signature()`
  gained the seven engine modules and their two test files; `turbo.json` gained
  `scripts/gate/mapping.mjs` and `scripts/gate/mapping/**` at all three sites
  that already carried the table. D5c removed the entries for the harness, the
  equality test and `gate-arms.mjs`, and added `pins.test.mjs`. A missing entry
  freezes the stamp, which is the ADR 0064 failure, and it is load-bearing for
  code that decides what runs rather than for data nothing consumed.
- **The soak cost wall-clock; D5c paid it back.** Projected here by starving the
  bash loop in a throwaway copy: 11.1s with both routings running, 0.7s with the
  arms disabled. Measured after D5c landed, same machine, dry run over a 24-path
  multi-package set: **4.85s → 0.74s**, a 6.5× cut, and the 0.7s projection
  reproduces to within noise. (The 10.2s/11.1s figures above were taken on a
  slower baseline; what carries across is the post-D5c number, which was the
  prediction under test.) A single-path change goes 0.50s → 0.41s, where the
  difference is Node startup against a loop with one iteration.
- **The dry-run stdout did not move, at either step.** Byte-identical before and
  after the swap, and again before and after D5c: a single path, a 24-path
  multi-package set and a root-`package.json` escalation all hash the same after
  the `__CHANGED_PATHS_FILE__` substitution `write_command_plan` already applies.
  The freshness stamp therefore hashes identically and the two Node consumers
  that parse that stdout keep parsing it.

  Two change-set classes DO move at D5c, both deliberately, and both invalidate
  the stamp on purpose. A set naming `scripts/gate/mapping.mjs` loses the three
  `routing-parity.mjs --corpus …` commands and gains `pnpm gate:routing-table:test`,
  because the engine now implements the table's closed verb set and that suite is
  what checks it. And two reason strings change, because what they said stopped
  being true: on that same arm, `engine.test.mjs` is no longer "behaviour the arms
  will stop pinning" but the only suite pinning it; and on the arm for
  `scripts/agent-quality-gate.sh`, `pnpm gate:routing-table:test` no longer runs
  because "gate routing arms must still match the routing table" — there are no
  arms — but because the gate holds that table's `implementation_signature()` pin.
  A reason string is contract, so a set naming either path hashes differently and
  re-runs; that is the intended reading of a stamp moving at D5c.

- **The parity harness survived the swap and went at D5c.** The design had it
  deleted at the swap. It was kept because after the swap its own comparison was
  circular — the gate's plan IS the engine's — while its seven corpora were the
  only way to drive the _in-gate_ guard across 2,906 path sets in one command.
  With the guard gone there is nothing for it to drive, so it went with the arms.
- **The engine's behaviour is pinned by its own tests.**
  `scripts/gate/mapping/engine.test.mjs` covers dedupe and first-reason-wins, the
  alias pairs, prepend, bucket order, the six post-passes including the 15/16
  scoped-test threshold, every disqualifier and the dep-cruiser scope narrowing,
  and the root-manifest classifier's four classes. It was written at D5b
  precisely so that D5c would not delete the only thing pinning those rules in
  the same commit that removes the arms.
- **The root-manifest classifier became an import.**
  `check-sentry-suites-in-ci-gate-probe.mjs` used to lift the gate's
  `classify_root_package_json_changes` out of the script and re-run it under an
  empty `$PATH`, restricted mode, stubbed helpers and a DEBUG trap — ~700 lines
  of module and ~820 of test, all of it about making that safe. D5c points it at
  `classifyRootPackageJsonChanges` in `scripts/gate/mapping/facts.mjs`, which is
  the classifier now, and keeps the one guarantee that survives the change of
  mechanism: a verdict outside the four closed classes fails rather than being
  stored as a plausible string. The lifting machinery stays in
  `check-sentry-suites-in-ci-gate-extract.mjs`, because the routing-table suite
  reads `implementation_signature()` with it and drives `/bin/bash` as the
  pattern oracle through it.
- **`agent:prewarm` now has an end-to-end contract test.** It parses the gate's
  dry-run stdout and no-ops silently when the format drifts; the command lines
  are produced by a different program than the header literals it was pinned
  against, so the test now runs the real gate and requires a non-empty
  extraction.
- **`scripts/gate/routing-table/` is a pinned surface.** Every `scripts/` move
  must update the data, which since D5c is the only copy, and ADR 0064's sweep
  checklist names it. A missing `implementation_signature()` entry freezes the
  signature and makes `--skip-if-fresh` reuse a stale stamp — the pin that must
  not be forgotten.
- **The table ships as eleven data modules plus nine supporting ones**, cut on
  family boundaries, because the arms with the reasoning they carry are ~3,700
  formatted lines: ADR 0065 hard-caps a `scripts/` module at 1,000 and reports
  one at 600, and a table that lands as a size row on day one is a table whose
  first monthly triage is about its own layout. Size decided how many cuts;
  family decided where they fall. The index concatenates them in an explicit
  order and `routing-table.test.mjs` asserts the resulting group ids against a
  written-out list, because group order is routing.
- **The size row for `scripts/agent-quality-gate.sh` halved at D5c.** The table
  was additive while the arms stayed, so the row did not move at D5a or D5b. D5c
  took the gate from **6,070 raw to 3,327** (4,183 rough to 2,173): the thirteen
  `case` statements, the 71 verb and post-pass helpers only they called,
  `plan_records_from_bash`, the byte comparison, and the three preambles that fed
  the arms alone. ADR 0065's exemption list does not change and the gate stays in
  the report, still over the hard cap; its row and the deleted harness's row in
  `docs/notes/file-size-watch.md` were re-measured with the generator rather than
  waiting for the monthly route, because a stale baseline would read the drop as
  fresh drift next month.
- **The routing-table suite is the slowest new check in `scripts/`.** The bash
  oracle runs hundreds of patterns against ~4,900 paths on every installed
  bash, about 12 seconds cold on this machine. It is routed by a change to the table, by a
  change to the gate, and by the required `ci` job, because it is the check the
  whole conversion rests on and a check that only runs on one side of a drift
  is no check at all.
- **The commonest drift was the merge queue, not the author — and D5c ends it.**
  The equality test caught main moving under this decision's own implementing PR
  across three merges and five routing deltas: a Sentry fixture-scan canary arm
  and the same canary command added to two existing arms; then a fifth pattern on
  the PR ready-state arm; then a fifth pattern on the Sentry re-queue arm. None
  of those authors touched the table, and none had any reason to — the arms were
  where routing lived. With one copy left there is no drift class to reconcile:
  a branch that adds routing edits the table, and a branch that edits the table
  conflicts textually with another that does.
- **The gate keeps one command on one existing arm.** Editing
  `scripts/agent-quality-gate.sh` also schedules the routing-table suite. At D5a
  that arm was what kept the two copies in step; since D5c it is what proves
  `implementation_signature()` still lists every routing-table module, so the
  command stays and only its reason string changed.
- **The indexer family extension rides on the table.** It adds the focused
  parity command to JS and TypeScript indexer modules and focused external
  runtime or test-support inputs, and narrows the handler-invariant checklist to
  its owned paths. Other changed-path classes keep their prior plan. The
  autoreview-core source class received the checklist and both gate suites by
  design until [ADR 0086](0086-autoreview-removal-thin-two-model-review.md) deleted that
  source.
- **Issue 1498's original split is rejected.** Its acceptance criteria named sourced
  `scripts/lib/gate-*.sh` helpers for the watchdog, stamps and executor —
  exactly the residual layers this decision keeps together in bash. Moving
  those crash boundaries across files would provide no schema, test oracle, or
  checkable invariant. The issue now reconciles ADR 0065 with this rejection
  and needs no permanent ownership role for the measured row.
- **`check-sentry-suites-in-ci-gate-extract.mjs` outlived the check it was
  written for.** Its `runProbeShell`, `probeDirs` and `bashFunctionSource` backed
  the classifier probe; D5c made that probe an import, and what keeps the module
  alive is the routing-table suite — the `/bin/bash` pattern oracle and the
  `implementation_signature()` span. Its own routing arm schedules that suite.
- **Reason strings are contract, not decoration.**
  `production-infra-identity-contract/routing.test.mjs` pins an arm by asserting
  its reason string, because `add_command` deduplicates on the command and keeps
  the first reason. The table carries reasons verbatim and preserves
  first-wins order, and the schema's `MIN_REASON` rule keeps a reason from being
  emptied out.
- **The gate self-test still has no focus partition**, so any later step in this
  track pays it in full. Adding one is separate work.

## Evidence

- The current counts above flatten each normalized `arm.patterns` array.
  `pathEquals` guard literals and run-time pattern expansions are separate
  routing inputs, not arm-pattern occurrences.
- Routing region, measured at `4f8feaac`, before D5c deleted it:
  `scripts/agent-quality-gate.sh:3157-4593` — 13 top-level `case` statements, 53
  counting nested, 232 arms, 478 distinct patterns of which 362 are glob-free,
  29 verbs. The paired-arm rationale it carried is now the `why` on the
  corresponding arm in `scripts/gate/routing-table/arms-scripts.mjs`.
- Gate size across the track: 5,878 raw when this ADR was written, 6,070 at
  `3eb5ff55`, **3,327 after D5c** (2,173 rough). Re-measured with
  `node scripts/repo-health/file-size-watchlist.mjs`.
- D5c soak, on `3eb5ff55`: 399/399 historical changed-path sets clean, 120/120 at
  a 30-commit base, 40/40 on a dirty tree; a one-word mutation of the engine's
  targeted-Trunk reason refused 12 of 20 sets, the other 8 taking the full-scan
  branch where that string never appears.
- `implementation_signature()` locates by NAME in both suites, so no line
  citation here is a pin.
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
- Reconciled gate-split record: <https://github.com/mento-protocol/monitoring-monorepo/issues/1498>
