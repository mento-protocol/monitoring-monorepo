---
title: An unconditional gate job runs the Sentry suites and proves from their output that they asserted
status: active
owner: eng
canonical: true
last_verified: 2026-08-11
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
job into a false-green no-op. The vector is live today: the `scripts` job's first
PR-authored step is `run: bash scripts/check-agent-quality-gate-package-scripts.sh`,
which executes before all ten suites. Reading invoked-script content is not a
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

| #   | Step                                                                                | Why it is where it is                                                                                              | Lands in  |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------- |
| 1   | `actions/checkout` (SHA-pinned, `persist-credentials: false`)                       | Upstream, one of exactly two non-PR-authored things trusted before the suites                                      | this PR   |
| 2   | `actions/setup-node` (SHA-pinned, `node-version-file: .node-version`)               | Same                                                                                                               | this PR   |
| 3   | `run: /usr/bin/env -u NODE_OPTIONS -u NODE_PATH node scripts/sentry-suite-gate.mjs` | The first and only PR-authored code before the suites; strips both vars, symmetric with the gate's per-child spawn | this PR   |
| 4   | `uses: ./.github/actions/pnpm-install`                                              | After the suites, so its `postinstall` cannot reach them                                                           | follow-up |
| 5   | `run: node scripts/check-sentry-suites-in-ci.test.mjs`                              | Needs `js-yaml`; after the suites for the same reason                                                              | follow-up |

Steps 1-3 are the security-critical core and land here: no PR-authored step runs
before the gate, so the R1 window is closed. The static checker keeps running in
the path-gated `scripts` job until the follow-up PR relocates it into steps 4-5
and removes the now-duplicated suite steps; redundant runs until then break
nothing that was green.

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
   `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH node <nodeArgs> <suite>` and
   asserts, per suite: child exit 0, parsed `fail == 0`, parsed `pass >=` the
   manifest floor, and parsed `pass ==` the number of per-case lines the suite
   emitted (lines matching `^ok` for the homegrown harness, `^✔` for `node:test`
   under a forced spec reporter). Any parse failure or missing suite fails closed;
4. re-verifies each exemption's route without running it — that
   `scripts/tf-stacks.test.mjs` still statically imports
   `scripts/sentry-provider-contract.test.mjs` and that a package.json script
   still routes there — since that suite runs in `production-infra-contract` via
   `pnpm tf:test` and carries import-time assertions with no counts;
5. writes a per-suite pass/floor/line table to stdout and `$GITHUB_STEP_SUMMARY`.

The committed manifest is the closed-world expected set. Per suite it carries
`path`, `reporter` (`count-line` | `node-test` | `exit-only`), optional
`nodeArgs` (the broker's `--test`), a pass-count `floor`, and — for the one
non-gate suite — an `exempt` route with its importer. Floors use `>=` semantics.

`scripts/sentry-suite-gate.test.mjs` is the runner's own suite, named `sentry-*`
so `findSentrySuites` enumerates it and the gate runs it — neutering the runner
now also requires faking its own suite's count and per-case lines. Because it is
enumerated, the still-in-place `scripts` job gains a direct step invoking it,
which keeps the #1754 coverage checker green until that checker relocates.

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
time. Compute is roughly flat: the suites take two wall-clock seconds and the job
costs one runner boot; on a public repository those GitHub-hosted minutes are
free.

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
1. **This PR (B).** Add the manifest, `scripts/sentry-suite-gate.mjs`, its own
   suite, and the unconditional `sentry-suites` job wired into `ci.needs` and out
   of `allowed-skips`; add a direct step to the `scripts` job invoking the gate's
   own suite so the #1754 coverage checker stays green. The suites briefly run in
   both jobs, so a mistake reds nothing that was green. The structural pin on the
   gate job ships here too, in the existing checker
   (`check-sentry-suites-in-ci-gate-job.test.mjs`) — deferring it would have left
   a window where deleting the job was green, which is the exact false-green the
   job exists to close. The local quality gate routes the gate for every
   manifest-owned suite, since editing any of them moves that suite's pass count
   against its committed floor.
2. **PR C.** Delete the suite steps and the checker step from `scripts`;
   relocate the #1754 checker into the gate job after `pnpm-install` (steps 4-5
   above) and narrow its charter to the gate's shape; update
   `docs/notes/agent-quality-gate-mechanics.md`. The gate-job pin moves with the
   checker rather than being written there.
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
- Dependency-freedom: `git grep -h 'from "' -- scripts/sentry-*.mjs` shows only `node:` and sibling `./sentry-*` imports; the checker's `js-yaml` import is why it stays a step 4-5 job.
- The gate green against the real suites: `node scripts/sentry-suite-gate.mjs` reconciles all twelve `scripts/sentry-*.test.mjs`, asserts the ten non-exempt suites from their output, and re-verifies the provider-contract exemption route.
- Each negative path reds the gate: `node scripts/sentry-suite-gate.test.mjs`.
