---
title: Remove the autoreview machinery; keep a thin two-model closeout review
status: active
owner: eng
canonical: true
last_verified: 2026-09-03
supersedes: ADR-0079, ADR-0068
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0087 — Remove the autoreview machinery; keep a thin two-model closeout review

**Status:** Accepted (Sep 2026), in force.
**Scope:** ci/process

## Context

`pnpm agent:autoreview` was a 15,000-line trust root: a Bash wrapper that hashed
its own blob against protected `main`, a Node entry point and core that built a
review bundle, a sealed secret-suppression record, a native Darwin lineage
runtime, a 90-minute adversarial CI suite, and a separate Blacksmith job that
re-ran one guard as root. It existed to hand a fresh-context model a bundle it
could not tamper with.

Two screens on 2026-09-02 measured what the model half of that contributed. On
PRs 1990, 1995 and 1999, the two-model operating point found 14 of 22 known
defects and the solo point found 14; a second screen found 13 and 13. P1 counts
matched at 5 and 5, then 4 and 4. Autoreview's own pass returned 1, 0 and 1
findings across the three PRs, none of them new; on PR 1995 it reported that the
patch was correct while five defects went unfound. The bundle machinery was
carrying no measurable recall.

`codex exec review` is a first-party subcommand of a CLI the operator already
runs. It reads the working tree itself, needs no bundle, and reports findings
under a `Full review comments:` or `Review comment:` heading. Wrapping it takes
1,077 lines across three modules — 387 in `scripts/pr/closeout-review.mjs`, 400
in `closeout-review-exec.mjs` and 290 in `closeout-review-git.mjs` — against the
roughly 37,200 this removes. Same second model, a fraction of the surface.

## Decision

Delete the autoreview machinery. Its replacement is
[`scripts/pr/closeout-review.mjs`](../../scripts/pr/closeout-review.mjs)
(`pnpm agent:closeout-review`, added by the preceding PR), invoked from step 4
of [`pr-operating-card.md`](../notes/pr-operating-card.md) before the `review`
skill runs on the same diff.

### What is deleted

Ten tracked files:

| Path                                                | What it was                       |
| --------------------------------------------------- | --------------------------------- |
| `scripts/agent-autoreview.sh`                       | wrapper and trust root            |
| `scripts/agent-autoreview.mjs`                      | entry point                       |
| `scripts/agent-autoreview-core.mjs`                 | bundle builder and secret scanner |
| `scripts/agent-autoreview-core.test.mjs`            | core suite                        |
| `scripts/agent-autoreview-target-guard.test.mjs`    | root-runtime trust suite          |
| `scripts/agent-autoreview.test.sh`                  | adversarial suite                 |
| `scripts/agent-autoreview-secret-suppressions.json` | the sealed suppression record     |
| `.claude/commands/autoreview.md`                    | the Claude slash command          |
| `docs/notes/autoreview-runtime-trust.md`            | the trust-boundary runbook        |
| `scripts/sentry/fixture-scan-canary.test.mjs`       | the ADR 0068 drift canary         |

The sealed suppression file is named on purpose: deleting it retires the
exception [ADR 0079](0079-sealed-exact-file-patch-secret-suppression.md) granted
for issue #2114. The record, not only the scanner that read it, is gone.

Two CI jobs go with them — `autoreview-suite` (90 minutes, `ubuntu-latest`) and
`autoreview-root-runtime` — along with their path filters, their `changes`
outputs, their `ci` sentinel dependencies and their `allowed-skips` entries.

### The Sentry fixture-scan canary has no successor

[ADR 0068](0068-sentry-fixture-authoring-policy.md) enforced its
authored-to-scan-clean policy with two mechanisms: `secretLikeReason` in the
autoreview core, and `scripts/sentry/fixture-scan-canary.test.mjs`, which
re-scanned four Sentry suites carrying credential-shaped fixtures. Both are
gone.

Those canary routes fired on **Sentry fixture changes**, not on autoreview
changes: six routing arms and one CI step ran it whenever one of the four suites
was touched. Retiring it therefore removes a control the Sentry suites relied on
independently of autoreview, and nothing replaces it. What remains for
credential-shaped literals in tracked fixtures is Trunk's trufflehog check at
push time and GitHub secret scanning on the repository. ADR 0068 is archived and
superseded by this record.

### Protections removed, and what stands in for each

| Removed                                                           | What stands in                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle secret and sensitive-path scan before a model saw the diff | Trunk trufflehog at push time; GitHub secret scanning                                                                                                                                                                                                                                  |
| Sealed exact-file-patch suppression (ADR 0079)                    | nothing — the exception it carried is retired with it                                                                                                                                                                                                                                  |
| Empty-workspace isolation against third-party prompt injection    | `sandbox_mode="read-only"` plus an explicit environment allowlist in the new script                                                                                                                                                                                                    |
| Reviewer runtime pinned to protected `main`                       | nothing — see the residuals below                                                                                                                                                                                                                                                      |
| Root-runtime trust job                                            | nothing — the guard it re-ran is deleted                                                                                                                                                                                                                                               |
| Sequential 90-minute autoreview suite on `ubuntu-latest`          | the retained Sentry process-identity consumer in the required `Sentry suites` job and the local gate self-test cover the seven shared Darwin and mapped-command files it also exercised (#2296 moved the gate regression suite out of CI); the sequential `--jobs 1` execution is lost |
| Report files scanned before they were written                     | `.reviews/` is gitignored and the script refuses an `--out` path inside the repo that is not ignored                                                                                                                                                                                   |

### Accepted residuals

1. **Candidate-controlled reviewer instructions.** `codex` reads `AGENTS.md`,
   `CLAUDE.md`, `.codex` and `.agents` from the checkout under review. The
   retired flow pinned those to protected `main`. A diff that changes any of
   them must be read by a human before its report is trusted; card step 4 says
   so.
2. **The closeout runs the candidate's own review tool** when the diff changes
   `scripts/pr/closeout-review.mjs`.
3. **The reviewer runs under the operator's `codex` configuration** with a
   readable `HOME`, not an isolated runtime.
4. **A never-added file gets no review**, because `codex` diffs the working tree
   rather than the index-plus-untracked set.
5. **The report file is unscanned model output** that may quote
   credential-shaped diff content.
6. **No second model in Claude cloud sessions.** Where `codex` is absent, card
   step 4 runs the `review` skill alone and the PR discloses single-source
   coverage. Inside an active Codex session the script refuses, because nested
   `codex exec` is unavailable.
7. **The file handoff is an unmeasured deviation.** The measured pipeline
   (`docs/evals/review-skill.md`) inlined the second model's report into the
   reviewer prompt; card step 4 hands over a path instead.
8. **`sandbox_mode="read-only"` deviates from the pinned finder argv.** It is a
   deliberate addition so the reviewing model cannot write the tree it reviews.
9. **A name collision.** `~/.claude/bin/codex-review.sh` is a different operator
   tool with a different CLI and different exit codes. In this repo the closeout
   is `pnpm agent:closeout-review`.

### Mechanisms this voids

- [ADR 0065](0065-scripts-file-size-watchlist-scope.md)'s three `scripts/`
  file-size exemptions were all autoreview files. `SCRIPTS_EXEMPTIONS` is now
  empty; the mechanism stays and a new entry remains an ADR 0065 decision.
- [ADR 0069](0069-gate-routing-table-as-data.md)'s freshness-signature and Turbo
  input pins on the core and the suppression JSON are removed. The routing-table
  and mapping pins are unchanged.
- [ADR 0079](0079-sealed-exact-file-patch-secret-suppression.md) is archived: it
  described a runtime that no longer exists.
- [ADR 0064](0064-scripts-module-directories.md)'s sweep checklist, `case`
  routing bullets, `origin/main` materialization hazard, and evidence pointers
  named the wrapper and the two removed `ci.yml` filters. They are amended in
  place; the move procedure itself is unchanged.
- [ADR 0080](0080-merge-base-freshness-stamp.md)'s default-branch marker list
  had two commands. The autoreview suite was the second, so
  `docs:navigation-eval -- --validate` is now the only marker command, in the
  gate and in that ADR.
- [ADR 0073](0073-guardrail-prose-pinned-in-ci.md) rejected script digest pins
  partly because the wrapper already hashed its own blob. That protection is
  gone; the rejection stands on its reflex argument, and `.gitattributes` plus
  `UPSTASH_MCP_LAUNCHER_SHA256` remain the one byte-pinned artifact.
- [ADR 0076](0076-fair-quality-gate-coordinator.md) listed
  `scripts/agent-autoreview.test.sh` among the focused containment tests, and
  named the autoreview tests as the credential-forwarding case the mapped-command
  launcher scrubs. The suite is gone; the launcher still scrubs.
- [ADR 0078](0078-staged-verification-redesign.md)'s M4 move covered autoreview
  owner and schema assertions. `ci.yml` still runs both extraction suites, and
  `RETAINED_EXTRACTED_STEPS` still pins both steps; deleting the autoreview core
  leaves `scripts/indexer-handler-invariant-contract.test.mjs` checking one copy
  of the family data instead of two.

The frozen verification-evidence manifest keeps its scoped allowance for
`scripts/agent-autoreview.sh:.*gate_stat`, because
`scripts/docs/check-verification-redesign-evidence.mjs` computes the manifest
against a pinned baseline commit where that file still exists. The two safeguard
rows that described the autoreview review and provenance controls are amended to
`obsolete-with-evidence` rather than deleted.

## Alternatives considered

**Keep the bundle machinery and swap only the engine.** Rejected on
measurement: the screens found no recall attributable to the bundle, and the
bundle is where nearly all 15,000 lines live.

**Keep the canary by re-pointing it at a new scanner.** Rejected: writing a
second credential scanner to keep one drift canary alive reintroduces the
largest piece of what this removes, for a control trufflehog and GitHub secret
scanning already cover on the push path.

**Run the closeout from a detached worktree at the base OID.** This would close
residual 1. Rejected for now: `codex exec review` diffs the working tree, so a
detached-worktree flow means reconstructing the candidate diff outside the
checkout the agent is in, which is the bundle machinery again under a different
name. The residual is documented instead.

## Evidence

- Screens of 2026-09-02 on PRs 1990, 1995 and 1999, recorded in
  [`docs/evals/review-skill.md`](../evals/review-skill.md).
- The replacement and its suite:
  [`scripts/pr/closeout-review.mjs`](../../scripts/pr/closeout-review.mjs),
  [`scripts/pr/closeout-review.test.mjs`](../../scripts/pr/closeout-review.test.mjs).
- The operating flow: [`docs/notes/pr-operating-card.md`](../notes/pr-operating-card.md)
  step 4.
- The invariant contract that left the deleted core:
  [`scripts/gate/routing-table/indexer-handler-invariant-contract.mjs`](../../scripts/gate/routing-table/indexer-handler-invariant-contract.mjs)
  and its families module, with
  [`scripts/indexer-handler-invariant-contract.test.mjs`](../../scripts/indexer-handler-invariant-contract.test.mjs).
- Tracking issue
  [#2239](https://github.com/mento-protocol/monitoring-monorepo/issues/2239).
