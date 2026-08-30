---
title: Adversarial fixtures are authored to scan clean; no value or line registry
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

# ADR 0068 — Adversarial fixtures are authored to scan clean; no value or line registry

**Status:** Accepted (Aug 2026), in force.
**Scope:** ci/process

**Current refinement:** [ADR 0079](0079-sealed-exact-file-patch-secret-suppression.md)
permits one sealed, complete, byte-exact Git file-patch record for issue #2114.
It does not permit a value or line registry and does not implement the deferred
source-provenance oracle below.

## Context

`pnpm agent:autoreview` builds a review bundle and refuses to send it when
`secretLikeReason` in `scripts/agent-autoreview-core.mjs` recognizes anything
credential-shaped in it. The scanner is fail-closed by design: it refuses on
recognition, it never asks where the text came from, and five rounds of
red-teaming have gone into keeping it that way.

Four Sentry suites carry adversarial fixtures — credential-shaped values whose
whole point is to prove the pipeline refuses to leak them:

- `scripts/sentry/autofix/sentry-autofix-finalize.test.mjs`
- `scripts/sentry/broker/sentry-mcp-broker.test.mjs`
- `scripts/sentry/triage/sentry-triage-agent-comment.test.mjs`
- `scripts/sentry/triage/sentry-triage-archive.test.mjs`

Written the wrong way, those fixtures make the suite file itself trip the
scanner. Every autoreview run whose bundle contains such a file then refuses
before a model sees the diff. That is issue #1943. Issue #1970 is the same
failure reached through a different door: git copies a fixture line into the
`@@` hunk-header funcname, so the trap text arrives in the bundle even when the
edit is nowhere near it.

The trap shape is narrow and was measured, not guessed: a **credential-named
identifier or key holding a realistic-shaped literal value**. The identifier is
usually the trigger, not the value. `SHELL_OWNER_TOKEN` held a shell parameter
expansion — no credential at all — and tripped the scanner purely because
`credentialAssignmentKey` recognizes `TOKEN` as a credential key. PR #1974 read
that as "shell-code fixtures cannot be renamed" and went looking for an
exemption mechanism instead; that was a misdiagnosis.

Measured surface, 60 days on `origin/main`, bound to an immutable tip:

| Measurement                                              | Value            |
| -------------------------------------------------------- | ---------------- |
| Tracked files that trip `secretLikeReason` as whole text | 73 of 2228       |
| Squash commits producing a refusing bundle               | 37 of 497 (7.4%) |
| Of those 37, attributable solely to the four suites      | 5                |
| Commits a correct provenance oracle would have cleared   | 9 of 37 (24%)    |
| Oracle yield against all commits                         | ≈1.8%            |

The file-count harness silently skipped unreadable files. Re-run fail-closed in
an independent environment it read 72 of 2228, not 73, against the same
denominator. Both figures are recorded; the harness fix (fail on an unreadable
file) is a precondition for the re-measurement below.

## Decision

**1. Fixtures are authored to scan clean.** New or edited adversarial fixtures
use placeholder vocabulary for the value (`example-…`, `placeholder-…`), or a
non-credential-named identifier for the binding, or both. A credential-named key
holding a realistic-shaped literal is the shape to avoid. Composition
(`"pre" + "fix"`) is not a general escape: `staticConcatenation` folds
concatenated literals back together before the credential-key rules run, so
composition only helps for **provider-prefix** patterns (`ghs_…`, `sk-ant-…`)
on keys the scanner does not read as credential names.

**2. No value registry and no line registry.** An allowlist of known-safe
credential-shaped values, or of file/line coordinates, was rejected. Both make
the scanner's answer depend on a list a PR can edit, in the one function with a
five-round bypass record, and both go stale the moment a fixture moves. #1974 is
the evidence: it pursued that class of fix, and the underlying problem turned
out to be a fixture-authoring problem an eight-identifier rename solved outright.

**3. The provenance oracle is the recorded design of record, deferred.** The
principled fix — clear a finding only when every byte of evidence supporting it
is already published on `origin/main` — survived adversarial review as a
principle. It is not being built now: its measured yield is ≈1.8% of commits,
and it would add a large exemption mechanism to the fail-closed scanner. Its
corrected invariants are recorded below so it can be built safely later.

**4. A drift canary keeps the rewrite from rotting.**
`scripts/sentry/fixture-scan-canary.test.mjs` asserts, for each of the four
paths, that the file exists and that its whole text scans clean, behind a
negative control that proves the scanner still refuses the trap shape. Its
basename deliberately does not start with `sentry-`: `findSentrySuites()`
reconciles that glob against `scripts/sentry/gate/sentry-suite-manifest.json`
by exact set equality, so a `sentry-*.test.mjs` here would have to become a
manifest-owned suite. It is routed by `scripts/agent-quality-gate.sh` and by the
`scripts` job in `.github/workflows/ci.yml` instead, and it runs when the scanner
changes as well as when any of the four suites change.

## Alternatives considered

- **Build the provenance oracle now.** Rejected on measurement: it clears 9 of
  the 37 refusing commits and 65 of 65 synthetic steady-state cases, but only
  ≈1.8% of all commits, against ~300 lines and ~40 new pinned invariants inside
  the scanner's most bypass-prone function.
- **A value or line allowlist.** Rejected — see decision 2.
- **Widen the scanner instead of the fixtures.** A separate proposal to clear
  `0x` + 40 hex under any credential-named key was dropped in review: 40 hex
  digits prove a 160-bit value, not a public address, so a random bearer secret
  written that way would newly clear. The narrow `key === "token"` rule stands.
- **Accept the refusals.** Autoreview is a package script, not a pre-push hook,
  so a refusal costs the local pre-model review and not the push — but it costs
  it on 7.4% of commits, silently, and #1970 makes it reachable from edits that
  never touch the fixture.

## Consequences

- **A coupling to keep in view.** The renames rely on `cred` and `splice`
  staying outside `credentialAssignmentKey`'s vocabulary. Widening that
  vocabulary re-traps the fixtures. The gate routes the canary on any change to
  `scripts/agent-autoreview-core.mjs` for exactly this reason; a widening PR
  must re-run it and rewrite whatever it reds on.
- **A new path pin.** The canary hardcodes the four suite paths and the manifest
  path. A renamed or moved suite must be updated there in the same PR, and
  `scripts/AGENTS.md` records the pin.
- **One-time bootstrap cost.** The PR performing the rewrite cannot pass local
  autoreview: its own `-` lines carry the old fixture values. That refusal was
  waived once, pinned to a single head SHA, with cloud review (Codex,
  CodeRabbit), trunk trufflehog, and GitHub secret scanning still covering the
  push. The waiver is not reusable.
- **Residual.** Roughly 60 tracked files outside the Sentry suites still trip the
  scanner as whole text. This ADR does not clear them; it removes the four the
  Sentry pipeline owns and records the policy that stops new ones appearing.

## Deferred design of record — provenance oracle v2

Build only if the re-measurement justifies it. Trigger: re-run the 60-day trap
measurement about **2026-10-20** with `repowide-yield.mjs`, and build only if the
residual trap rate stays above ~3% of commits **and** the residual is dominated
by the steady-state class the oracle actually clears. `repowide-yield.mjs` is a
proxy, not an oracle replay — it matches identical lines instead of mapping
positions — so the denominator, the immutable tip, the unreadable-file behavior,
and the numeric meaning of "dominated" must be fixed in writing before that
measurement can authorize implementation.

Corrected invariants, merged from both review rounds (the v1 span rule was
broken; "span = the regex match" is narrower than the evidence the rule read for
at least 8 of 22 return sites):

- **Findings API.** `secretLikeFindings(text, oracle?)` returning
  `{reason, span, exemptible}`; `secretLikeReason` stays as a first-result
  wrapper. Every existing assertion runs on the legacy path, the oracle-threaded
  path with a null oracle, and with a nothing-published oracle — byte-identical.
- **Support envelope.** A conservative half-open enclosing interval covering
  every byte between the first evidence byte and the furthest byte consumed, not
  a union — a discontiguous union recreates the composition bypass through an
  unpublished gap. The whole interval must map to one contiguous old-side
  pre-image range in one file. Rules with no derivable span are never exemptible.
- **Eligibility.** git-generated context and `-` lines only, mapped positionally
  against the pre-image blob; `+` lines never exempt; unstaged-vs-index sections
  never exempt; merges and grafts fail closed.
- **Hunk headers.** Funcname bytes are exempt only when the entire finding sits
  inside the funcname payload; a published funcname fragment may never be
  combined with context from another collector part.
- **Boundaries.** Separators and collector boundaries are unpublished; any
  finding crossing a part or diff section refuses. Provenance is attached by the
  emitter per part, never by re-parsing the joined bundle.
- **Arming.** Canonical slug check, same-run fetch, public-visibility check, and
  `merge-base --is-ancestor` against the freshly fetched immutable OID. Snapshot
  worktree, index, and OIDs and recheck immediately before egress; the
  fetch-to-egress remote race is stated, not hidden. Any failure means today's
  behaviour exactly.
- **Diff grammar.** `--no-ext-diff`, `--no-textconv`, pinned prefixes and output
  indicators, bytes-only comparison, rename a-side attribution. Binary,
  submodule, malformed, and combined diffs fail closed.
- **Honest residual.** The gate would guarantee that no recognized finding
  supported by unpublished lines clears. It would not guarantee a secret-free
  bundle: a published fixture would no longer accidentally block an unrecognized
  secret sharing the bundle.
- **Mutation coverage.** Removing or inverting any exempt guard must fail at
  least one test, at all 22 return sites.

## Evidence

- Issues #1943 (fixtures trip the scanner) and #1970 (hunk-header funcname
  reaches the bundle), both closed by the rewrite PR.
- PR #1974 — the closed attempt whose misdiagnosis is decision 2's evidence.
- `scripts/sentry/fixture-scan-canary.test.mjs` — the canary that enforces
  decision 4, with its negative control and existence checks.
- `scripts/agent-quality-gate.sh` and `.github/workflows/ci.yml` — the two
  routes that run it.
- `scripts/agent-autoreview-core.mjs` — `secretLikeReason`,
  `credentialAssignmentKey`, and `staticConcatenation`, the functions the policy
  is written against.
- [ADR 0062](0062-sentry-suites-self-run-gate.md) — the manifest and
  `findSentrySuites()` set-equality rule the canary's name is chosen around.
