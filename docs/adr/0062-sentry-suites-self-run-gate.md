---
title: An unconditional gate job runs the Sentry suites and proves from their output that they asserted
status: active
owner: eng
canonical: true
last_verified: 2026-08-12
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0062 — The Sentry suites prove they ran, from an unconditional gate job that runs them

**Status:** Accepted (Aug 2026), in force.
**Scope:** ci/process

## Context

PR #1754 added a static checker that proves CI _would_ run the Sentry test
suites and that the required `ci` gate cannot be silently disabled. Fourteen
review rounds hardened it against config-level bypasses. Two residuals survived,
and both are structural rather than fixable by more static analysis.

**R1 — env writes hidden in invoked-script content.** The checker matches
`GITHUB_ENV` / `GITHUB_PATH` against inline `run:` text and recurses into local
composite `action.yml` files. It never opens the content of a script a step
invokes. A trusted step `run: bash x.sh` whose script appends
`NODE_OPTIONS=--import=…` to `$GITHUB_ENV` neuters every later suite in the same
job into a false-green no-op. The vector was live when this was written: the
`scripts` job's first PR-authored step ran
`scripts/check-agent-quality-gate-package-scripts.mjs`, which executed before
all ten suites it then held. Reading invoked-script content is not a
fix — it false-positives on every legitimate script and regresses infinitely
through whatever those scripts invoke.

**R2 — "has a CI step" is not "the step ran meaningful assertions".** The checker
proves invocation, not execution. A suite that exits 0 for an environment reason
satisfies every static assertion. This was not hypothetical:
`scripts/sentry-triage-project.test.mjs` emitted 112 `ok` lines but reported
`110 passed`, because its summary and exit-code block sat before the file's last
two `await test(...)` calls. Those two tests' failures incremented the counter
after the exit-code decision was already made, so they could never fail the
build. PR #1787 moved that block to the end of the file; the count now reads 112,
and this gate's `pass == per-case-line` check is what keeps that class from
silently returning.

The load-bearing platform fact is narrow: a `$GITHUB_ENV` or `$GITHUB_PATH`
write reaches only _later steps in the same job_. R1 is therefore a window
problem, not an analysis problem.

## Decision

Add an unconditional `sentry-suites` job to `ci.yml` that runs the suites itself
and proves, from their own output, that they asserted. The job is unconditional
(no `if:`), added to the `ci` sentinel's `needs`, and deliberately absent from
its `allowed-skips` — the treatment `production-infra-contract` already gets.

The job's step list is closed-world and its order is load-bearing:

| #   | Step                                                                                | Why it is where it is                                                                                              | Lands in |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- |
| 1   | `actions/checkout` (SHA-pinned, `persist-credentials: false`)                       | Upstream, one of exactly two non-PR-authored things trusted before the suites                                      | this PR  |
| 2   | `actions/setup-node` (SHA-pinned, `node-version-file: .node-version`)               | Same                                                                                                               | this PR  |
| 3   | `run: /usr/bin/env -u NODE_OPTIONS -u NODE_PATH node scripts/sentry-suite-gate.mjs` | The first and only PR-authored code before the suites; strips both vars, symmetric with the gate's per-child spawn | this PR  |
| 4   | `uses: ./.github/actions/pnpm-install`                                              | After the suites, so its `postinstall` cannot reach them                                                           | PR C     |
| 5   | `run: node scripts/check-sentry-suites-in-ci.test.mjs`                              | Needs `js-yaml`; after the suites for the same reason                                                              | PR C     |

Steps 1-3 are the security-critical core: no PR-authored step runs before the
gate, so the R1 window is closed. Steps 4-5 landed in PR C, which also deleted
the duplicated suite steps from the `scripts` job and narrowed the checker's
charter — see "What PR C retired, and why" below.

`scripts/sentry-suite-gate.mjs` is dependency-free, which is what makes step 3
possible: every `scripts/sentry-*.mjs` imports only `node:` builtins, so running
the suites needs no install. It:

1. enumerates `scripts/sentry-*.test.mjs` with a symlink-following, cycle-safe
   walker (a dependency-free port of the checker's `findSentrySuites`) and
   asserts exact set equality against `scripts/sentry-suite-manifest.json` in
   both directions, printing the JSON patch to apply on a miss;
2. refuses to start if `NODE_OPTIONS` or `NODE_PATH` is set in its own env,
   catching removal of the `env -u` prefix or an attempt to drive the gate under
   the very injection it defends against;
3. spawns each non-exempt manifest suite as
   `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH node <nodeArgs> <suite>`, from that
   suite's own snapshot, and asserts, per suite: child exit 0, parsed
   `fail == 0`, parsed `pass >=` the manifest floor, and parsed `pass ==` the
   number of per-case lines the suite emitted (lines matching `^ok` for the
   homegrown harness, `^✔` for `node:test` under a forced spec reporter). Any
   parse failure or missing suite fails closed;
4. re-verifies each exemption's route without running it — that
   `scripts/tf-stacks.test.mjs` still statically imports
   `scripts/sentry-provider-contract.test.mjs`, and that the exact package.json
   alias the owning job runs is nothing but `node scripts/tf-stacks.test.mjs` —
   since that suite runs in `production-infra-contract` via `pnpm tf:test` and
   carries import-time assertions with no counts;
5. writes a per-suite pass/floor/line table to stdout and `$GITHUB_STEP_SUMMARY`.

The committed manifest is the closed-world expected set. Per suite it carries
`path`, `reporter` (`count-line` | `node-test` | `exit-only`), optional
`nodeArgs` (the broker's `--test`), a pass-count `floor`, optional `reads` (the
repository files it opens rather than imports) and `readsDirs` (the directories
it enumerates, copied whole), and — for the one non-gate suite — an `exempt`
route with its importer. Floors use `>=` semantics.

`scripts/sentry-suite-gate.test.mjs` is the runner's own suite, named `sentry-*`
so `findSentrySuites` enumerates it and the gate runs it — neutering the runner
now also requires faking its own suite's count and per-case lines.

**Each suite runs from its own immutable snapshot of the derived input set, all
taken before the first child starts.** Without isolation an alphabetically
earlier suite rewrites a later one — or a helper it imports, or the manifest, or
the exemption's route evidence — and both report passing (each was measured green
before it was closed). Digests were the first answer and they could only ever
DETECT interference, and only interference that persisted: a suite that replaced
a watched helper with a module restoring the original bytes during import, then
exporting a forged value, left every digest matching its baseline and the gate at
exit 0. Before/after hashes cannot see a transient rewrite. Separate directories
can, because there is nothing to see.

The input set is derived, never listed: the manifest, this runner and its own
imports, every manifest-listed suite, each suite's transitive first-party import
closure, its declared non-module `reads`, and per exempt entry its importer plus
`package.json`. A hand-written list was wrong three times running.

**Snapshots are SPARSE, and that is a feature twice over.** Copying the tracked
tree (2,124 files, 29MB) measured 1.48s once and 18.8s for thirteen — more than
three times the gate's entire runtime. Copying the ~65-file derived set measured
20ms and 241ms. The sparseness also makes the `reads` declaration self-enforcing:
a suite that opens a repository file it did not declare finds it absent and
fails, so the list cannot silently rot. Review reported one such read; running
every suite from a sparse snapshot found six, across three suites.

**Sparseness is NOT self-enforcing for a suite that enumerates a directory, and
that asymmetry is the sharpest edge here.** A missing file makes a suite die; a
sparsely populated directory makes it pass, having checked almost nothing.
`sentry-triage-requeue.test.mjs` walks every non-test `scripts/*.mjs` to prove
one function has a single call site, and saw 25 of 92 — so a forbidden call in
any of the other 67 was invisible to the gate while failing in the checkout. A
mechanism that makes a suite quietly weaker is worse than one that breaks it
loudly, and this one was introduced by the fix for exactly that class. Hence
`readsDirs`, which copies a directory and every entry under it, and a floor
inside each enumerating suite so a partial view fails rather than passes. The two
enumerating suites were found by grepping the closure for the enumeration APIs
and then PROVING each one by planting a module it had to flag.

**Snapshot addressing is a separate problem from snapshot isolation.** The first
implementation put every snapshot under one base with a name derived from the
suite's manifest path, and handed each child its own snapshot as `cwd` — so
`dirname(process.cwd())` plus the victim's sanitised name reached the victim's
inputs, and a victim that throws against committed code reported `ok` at exit 0.
Three layers now, in order of how much they are worth: the snapshot of the child
about to run is verified against its own baseline immediately before the spawn,
which is what actually closes it (a poisoner has by definition already exited, so
its write is on disk and cannot be taken back); names are random, so they cannot
be derived; and the base is mode `0111`, traversable but not listable, so they
cannot be enumerated either. The last two are defence in depth — a determined
child could still be handed a path — and the pre-spawn check is the guarantee.
Note this is not the model deleted above: that one hashed the shared checkout
after every child had finished, where a rewrite could be undone before the sweep
looked.

**Under UID 0 the mode bits are inert, and that is POSIX, not a defect.** Root
bypasses discretionary directory permissions, so in a root-owned container — an
ordinary shape for agent and CI images — a child can list the base and reach a
sibling's path. The guarantee is unaffected: the victim's snapshot is verified
immediately before its child runs, and the poisoner has already exited, so the
run reds with `TAMPERED` instead of accepting a forged pass. Only the layer that
was always defence in depth is lost. Chasing real isolation for UID 0 would mean
dropping to an unprivileged identity or per-suite containers, which is out of all
proportion to what it buys over the pre-spawn check. The isolation suite asserts
the claim that is true of the environment it runs in — enumeration refused when
unprivileged, poisoning caught when not — and asserts one in both, because a case
that skipped under root would leave root environments untested.

**The residual is a suite writing to the shared checkout.** A child cannot
address another child's snapshot, but in CI it knows the checkout —
`GITHUB_WORKSPACE` is in its environment — so it can still write there. Nothing
this run decides is read from the checkout once the snapshots are taken, so such
a write cannot forge a result; it would poison the NEXT run. The post-run digest
sweep and the re-enumeration remain for exactly that, demoted from the guarantee
to a tamper alarm, and the gate reds and names the file.

**The gate asks V8 what a module imports, and the shell what a script runs. It
does not match text for either.** `scripts/static-imports.mjs` returns
`vm.SourceTextModule(...).dependencySpecifiers` — the module record's own
dependency list — and both the gate and the #1754 checker call it, so there is
one implementation rather than two that drift. Regex was tried and failed in
three distinct ways: unanchored it counted `import` inside a string literal;
line-anchored to fix that it stopped seeing ordinary multiline imports, dropping
three suites' implementation modules out of the watch set; and either form
accepted `if (false) import("…")` as proof that an importer loads the exempt
suite. A module request is what makes code load, so the module record is the
right authority. The exemption's `via` alias is held to the same rule: it must
parse, through the checker's own simple-command grammar, as exactly
`node <importer>` and nothing else — a regex anchored on `&&`/`||`/`;` accepted
both `true || node …` (the importer never runs) and `node … || true` (its
failures are swallowed).

The cost is process spawns: `vm.SourceTextModule` needs
`--experimental-vm-modules`, so each parse happens in a child. A breadth-first
closure that parses each frontier in ONE child keeps this bounded — the real
manifest's 63-file closure takes 6 spawns and ~185ms, where parsing file by file
would take 63 spawns and ~1.75s.

## Alternatives considered

**Run-introspection gate** — a step in `ci` calling
`GET /actions/runs/{id}/attempts/{n}/jobs` and asserting the suite job's step
conclusions. Rejected on measured platform limits. A step object is exactly
`{completed_at, conclusion, name, number, started_at, status}`: no command text,
no output, no exit code, no log digest. Duration is a dead signal — on the
sampled run all nine Sentry steps reported `started_at == completed_at`, so a
no-op is indistinguishable from a real run at the API's one-second resolution.
Introspection therefore proves only that a step with a given name concluded
`success`, which is R2's premise restated, and contributes nothing to R1. Once
the suites run inside the gate's own process there is no sibling job left to
introspect.

**Full-tree snapshots, and the digest-only pair** — the two candidates weighed
against sparse snapshots. Copying the whole tracked tree per suite gives the same
isolation with nothing to declare, and was rejected on cost alone: 18.8s for
thirteen, against a 5.3s gate. Keeping digests and merely widening them —
verifying the entire input set before every spawn instead of the suite file, plus
declaring runtime reads — was rejected because it leaves the hole it is meant to
cover. A pre-spawn check catches a malicious helper that is still on disk when
the next child starts; it cannot catch one that restored the committed bytes
before exiting, which is the reproduction that prompted this. Declaring reads
under that design would also be unenforceable: nothing fails when a suite reads a
file it did not declare, so the list rots silently. Sparse snapshots cost 241ms,
close the transient case by construction, and make the declaration self-checking.

**Proof-artifact gate** — a shared counting harness stamps
`{suite, tests, assertions, hollow, nonce}` per suite, uploaded as an artifact
and verified in `ci`. Rejected as primary because it is forgeable by the vector
it defends against: the same `NODE_OPTIONS=--import` injection can write a stamp
reporting 999 tests with the suite never running, and repository secrets, OIDC
claims and attestations are all workflow-scoped and readable by any job in the
run. It also collapses nine independent copy-pasted harnesses into one file whose
edit false-greens all of them. Its counters are genuinely sharper than per-case-
line counting for a body that runs but asserts nothing, so that leg is retained
as scoped follow-up rather than discarded.

**Further static hardening of the #1754 checker** — rejected on the issue's own
terms. Reading invoked-script content false-positives on every legitimate script
invocation and regresses infinitely; neither R1 nor R2 is reachable from
configuration text at all.

**Running the suites behind `pnpm install` in the gate job** — rejected because
the composite action's `postinstall` is PR-authored code executing before the
suites, which is R1's window restored by the fix. Ordering the install after the
suite runner keeps the window closed and still gives the static checker its
`js-yaml` dependency.

## Consequences

The suites now run unconditionally on every push rather than when the
`rootScripts` paths filter matches, which retires the whole filter-narrowing
bypass class at runtime and makes the static drift net unskippable for the first
time. The gate takes about 7.6 wall-clock seconds — of which ~1.3s is its own
watch-set derivation, per-suite snapshots and their digests, and the rest is the
suites, two of which spawn the whole gate against ~30 fixture roots — and the job
costs one runner boot; on a public repository those GitHub-hosted minutes are
free.

**That runtime has roughly doubled across four review rounds, and each step was
chosen rather than accumulated.** 3.6s as first written; 5.3s when the import
scanner became V8's parser, which needs a child process; 5.7s when each suite
gained its own snapshot; 7.6s when declared directories began to be copied whole
and every snapshot digested. Every increase bought a hole closed, and the
alternatives were measured rather than assumed — full-tree snapshots would have
cost 18.8s, file-by-file parsing 1.75s. The record is here because a required
check that every PR pays is exactly the kind of cost that later reads as "CI got
slow" with the reason long forgotten.

The next round that would push it past roughly ten seconds should stop and decide
whether to bound it rather than pay it forever. The obvious first move is
parallelising the per-suite snapshot copies, which are independent by
construction; the second is that the suites now dominate, and the two that spawn
the whole gate against ~30 fixture roots are the largest single item. Neither is
worth doing mid-review, when correctness is still moving.

Manifest floors churn. A legitimate test deletion reds the gate until the JSON is
edited. Floors use `>=`, so adding tests never breaks anyone, and the runner
prints the exact patch to apply. A downward floor edit is a security-relevant
review signal and must be treated as one.

Output parsing is load-bearing across three summary dialects (`<n> passed`;
`<m> failed, <n> passed`; the autofix suites' `<n> passed, <m> failed`) and the
`node:test` spec report. A harness refactor that changes summary wording breaks
the parse — fail-closed, but noisy. Unifying the homegrown suites onto
`node:test` would collapse the parser and is worth a later pass.

Two upstream actions still execute before the suites. Their SHAs are PR-editable,
and the pin literals are the only thing stopping a fork swap; Dependabot bumps
now require a paired edit.

The gate cannot detect its own deletion, so the static checker carries that.
`scripts/check-sentry-suites-in-ci-gate-job.test.mjs` pins the job. Without it
every check in the repository stayed green with the whole job deleted.

### What PR C retired, and why

This ADR left the checker's narrowing open. PR C decided it per assertion. The
rule applied: an assertion goes only when the runtime gate makes a strictly
stronger claim about the same thing, or when its premise no longer exists.

**Retired — "every suite is invoked by the `scripts` job as a direct
`node <suite>`", with its pnpm-alias and `presentry:*:test` rejection probes.**
The gate spawns each non-exempt suite itself, as a `node` child under `env -u`,
from the manifest it reconciles by exact set equality, and asserts exit 0,
`fail == 0`, `pass >= floor` and `pass ==` per-case lines. No pnpm alias is on
that path for any non-exempt suite, so neither config-level fail-open the probes
covered is reachable, and "a step exists" is strictly weaker than "the suite ran
and asserted".

**Retired — the whole `rootScripts` reachability proof**
(`requiredPathsMissing`, `REQUIRED_ROOT_SCRIPT_PATHS`, `PROBE_INPUTS`,
`dropFilterPath`, `globToRegExp` and the four tests over them). It existed only
because the checker ran behind a paths filter: every file it read had to be
routed, or an edit to that file skipped the job silently. The job it runs in now
has no filter and no `if:`. Measured against the real filter with picomatch, the
old arrangement skipped the checker for dashboard-only, indexer-only and
non-Markdown doc-asset diffs; Markdown-only diffs did reach it, because the
filter lists `**/*.md`.

**Retired — "this check itself runs in the ci.yml `scripts` job".** The checker
step is now inside `CANONICAL_JOB`, asserted by exact equality, which also
rejects an appended `|| true`, an `if:`, a `working-directory:` and an `env:` on
that step — none of which the whole-command probe saw.

**Retired — the escaping-symlink rejection.** Its premise was that a suite
behind a directory symlink the paths filter cannot resolve ships unwired behind
a skipped job. The gate follows the same link, reconciles what it finds by set
equality, and runs the suite, from a job that never skips.

**Retired — `scripts` as a trusted job**, and `sentry-suites` deliberately not
added in its place. `scripts` runs no Sentry code any more. `sentry-suites` is
pinned key for key by `CANONICAL_JOB`, which rejects every construct
`jobBlockers` looks for and everything it does not; its only local composite is
`pnpm-install`, still scanned through `production-infra-contract`.

**Kept.** The gate-job pin, because a runtime gate cannot detect its own
deletion. The sentinel, trigger and check-run-ownership assertions, because a
gate whose result never reaches the required `ci` context proves nothing. The
exemption's CI half — the gate verifies the `via` alias's command, but only the
checker verifies that an unconditional job runs it. The env-mutation and
composite scan on `production-infra-contract`, whose install runs before the one
suite the gate does not. The alias-resolution and local-allowlist invariants and
the pin-validator ordering, which are outside the gate's world entirely.

**Residual PR C accepts.** The checker now runs after a PR-authored
`postinstall`. A `$GITHUB_ENV` `NODE_OPTIONS` poison written there silences the
checker, and the static composite scan cannot report a write that silences its
own detector. The gate runs before that install and is unaffected, which is the
whole reason for the ordering: the gate is the security-critical half, the
checker is the drift net.

**Both pins are allowlists, not blocklists, and that is load-bearing.** The job
is asserted by exact equality against a canonical structure — the exact set of
job-level keys, the exact number and order of steps, and per step the exact key
set and values — and the manifest against a strict schema, with `nodeArgs`
permitted only as the one supported invocation and `exempt` only for the single
provider-contract suite with the route recorded here, matched exactly rather
than by substring. Anything not listed is rejected whatever it is called.

The reason is empirical. Five review rounds of "reject the next bad property"
did not converge: workflow-level `env` (which survives the step's `env -u` and
can point the gate at a committed fake root), `working-directory` on the gate
step, a second `actions/checkout` pinned to `main`, an `if:` on the step rather
than the job, `container`, `defaults.run.shell`, a step-level `shell`, an
arbitrary `nodeArgs` that makes node never run the suite, and `exempt` on any
suite at all were each measured green against the blocklist. The space of
workflow keys and manifest fields is open and GitHub keeps extending it, so
enumerating rejections is structurally unable to finish. The suite set already
reconciles by exact set equality rather than "no suite is missing"; the pins
apply that same discipline one level up.

The cost is deliberate: a legitimate change to the job or the manifest schema
must update the canonical structure, which forces it to be re-proven in review
rather than absorbed silently. Dependabot bumps to either action SHA need a
paired edit. That is the same trade the suite-set equality already makes.

The residual that remains is narrower: `ci` is the only required Actions context,
so a diff that deletes both the job and its pin is still green. Adding
`Sentry suites` as a required status check in the branch ruleset is the only
close, and it is an out-of-repo settings change. If it is made, the job must
never acquire an `if:` — GitHub treats a skipped required check as satisfied.

Assertion count is not assertion strength. A suite of `assert(true)` calls
satisfies every leg. Closing that needs assertion-depth counting and, beyond it,
mutation testing of `scripts/sentry-*.mjs`; today `mutation-testing.yml` is
scoped to vitest packages only.

## Rollout

Sequenced after #1769, which added `scripts/sentry-triage-brief.test.mjs` and
reshaped several suites.

0. **PR #1787 (merged).** Move the misordered summary block in
   `scripts/sentry-triage-project.test.mjs` to the end of the file (reported
   count 110 → 112). Without it the gate's `pass == per-case-line` check reds on
   that suite, so it is a prerequisite of this PR, not part of it.
1. **PR B (merged).** Add the manifest, `scripts/sentry-suite-gate.mjs`, its own
   suite, and the unconditional `sentry-suites` job wired into `ci.needs` and out
   of `allowed-skips`; add a direct step to the `scripts` job invoking the gate's
   own suite so the #1754 coverage checker stays green. The suites briefly ran in
   both jobs, so a mistake could not red anything already green. The pin on the
   gate job ships here too, in the existing checker
   (`check-sentry-suites-in-ci-gate-job.test.mjs`) — deferring it would have left
   a window where deleting the job was green, which is the exact false-green the
   job exists to close. The local quality gate routes the gate for every
   manifest-owned suite, since editing any of them moves that suite's pass count
   against its committed floor.
2. **This PR (C).** Deletes the suite steps and the checker step from
   `scripts`; relocates the #1754 checker into the gate job after
   `pnpm-install` (steps 4-5 above) and narrows its charter to the gate's shape,
   recorded above.
3. **PR D.** Gate-probe robustness pass, with the manifest as the single source
   for `sentry:*` alias-to-suite resolution.
4. **Operator, out of repo.** Add `Sentry suites` to the branch ruleset's
   required checks.

Each red path is proven to fail before it is trusted. This PR ships those proofs
as `scripts/sentry-suite-gate.test.mjs`: an emptied suite fails the summary
parse; a hollow suite whose summary overcounts fails per-case-line equality; an
injected `NODE_OPTIONS=--import…process.exit(0)` neuters a plain `node` run yet
the `env -u` latch strips it so the suite really runs; a suite added or removed
without a manifest edit fails set equality; a suite under its floor reds; and
`NODE_OPTIONS`/`NODE_PATH` on the gate itself refuses the start.

## Evidence

- R2 defect and fix: `node scripts/sentry-triage-project.test.mjs | grep -c '^ok '` returned 112 against a reported `110 passed` before PR #1787 moved the summary block to the file's end; the count now reads 112, which the gate's floor requires.
- Dependency-freedom: the 34 modules the gate loads or spawns — itself, its imports, every non-exempt suite and their transitive first-party imports — import only `node:` builtins and repo-local siblings, checked by walking `staticImports` over that closure. (The exempt importer's own closure does reach `js-yaml`; the gate digests those files, it never loads them.) The checker's `js-yaml` import is why the checker stays a step 4-5 job.
- The gate green against the real suites: `node scripts/sentry-suite-gate.mjs` reconciles all thirteen `scripts/sentry-*.test.mjs`, asserts the twelve non-exempt suites from their output, and re-verifies the provider-contract exemption route.
- Each negative path reds the gate: `node scripts/sentry-suite-gate.test.mjs` and `node scripts/sentry-suite-gate-integrity.test.mjs`.
- Snapshot cost, measured on this repository: full tracked tree 1.48s each / 18.8s for thirteen; derived input set 20ms each / 241ms for thirteen. The gate's own overhead went 0.21s → 0.60s, its total 5.3s → 5.7s. Adding `readsDirs` for the two enumerating suites, per-snapshot digests and the pre-spawn verification took it to 7.6s.
- Declared reads are complete because incompleteness fails: running every suite from a sparse snapshot converged on six reads across three suites, one of which review had found by inspection.
- The enumerating suites really enumerate: planting `scripts/zz-round12-decoy.mjs` with a forbidden `buildRegressedComment(` call reds `sentry-triage-requeue.test.mjs` (`expected [], got ["zz-round12-decoy.mjs"]`), and the same file with a `BRIEF_COMMENT_MARKER` reference reds `sentry-triage-brief.test.mjs`. Both are clean again once it is removed.
