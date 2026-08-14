---
title: Claude clean reviews use deterministic identity and run provenance
status: active
owner: eng
canonical: true
last_verified: 2026-08-14
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0064 — Claude clean reviews use deterministic identity and run provenance

**Status:** Accepted (Aug 2026), in force.
**Scope:** ci/process

## Context

`pr:feedback-state` needs one safe answer to a narrow question: did Claude
review this exact PR head and return no findings? Claude's ordinary review prose
cannot answer that mechanically. Its headings, wrappers, punctuation, Markdown,
and summary language have changed across PRs #1553, #1839, and #1848. A bounded
parser can reject unknown prose, but every newly observed clean shape prompts
another grammar or exact-digest exception. That cycle does not define a stable
producer contract.

The old automatic and on-demand paths also used different Action modes. In
successful Actions run `31754675314`, a static prompt selected the pinned
Claude Action's agent mode. The model completed without an inline finding, the
run stayed green, and no top-level review appeared. Agent mode does not own the
Action's sticky-comment transport. Supplying `github_token` also makes any
Action-owned write use the workflow token and `github-actions[bot]`, which
cannot satisfy a Claude App identity binding.

The pinned `anthropics/claude-code-action` revision
`be7b93b1907a4abad570368f3c74b6fe3807510b` (v1.0.183) does expose a smaller
contract we can rely on: `--json-schema` returns `structured_output`; its OIDC
exchange uses audience `claude-code-github-action`, issuer
`https://token.actions.githubusercontent.com`, endpoint
`https://api.anthropic.com/api/github/github-app-token-exchange`, a
`{permissions}` request, and exactly one `token` or `app_token` response field.
The Action source also revokes the installation token with
`DELETE /installation/token`.

That App identity is repository-wide, not producer-exclusive. The broker
requires the caller's workflow file to exist with identical content on the
default branch, but several same-repository PR plan jobs legitimately keep
unchanged workflow YAML, grant `id-token: write`, and execute PR-head code.
Compromised PR code in one of those jobs could call the same broker and post as
`claude[bot]`. Author identity and body bindings therefore need protected-run
provenance as well.

## Decision

Automatic and explicit `@claude review` requests share one protected-main
producer and publisher contract.

### Trusted event and review context

Automatic review starts with `.github/workflows/claude-review-request.yml`, an
unprivileged `pull_request` dispatcher with no checkout, effective repository
permission, secret, or PR-controlled output. Its completed run triggers
`.github/workflows/claude.yml` through `workflow_run`, so the consumer workflow
always comes from the
protected default branch. The consumer accepts only the named dispatcher at its
exact path, a successful pull-request run from the same repository, a human
non-Dependabot actor, and a non-`sentry-autofix/*` head. GitHub may leave the
run's `pull_requests` association empty, so protected code queries open PRs by
the run's repository owner and canonical head branch. Exactly one result must
have the run's head SHA and target the default branch; zero, multiple, or
mismatched results fail before inference.

On-demand issue, review, and review-comment events enter the same resolver.
They must be on a PR, contain `@claude review`, and come from a human GitHub
`OWNER` or `MEMBER`. Forks, non-PR comments, other associations, bots, drafts,
closed PRs, alternate bases, and machine-autofix heads fail before Claude runs.

### Finite model output and transport

Protected main is the workspace-root checkout because the pinned Action runs
startup Git and configuration discovery there. The PR head exists only under
`review-target`, with persisted checkout credentials disabled on both
checkouts. Before the model starts, protected-main code verifies the target
head and clean worktree, computes the merge base, and writes a 750,000-byte
maximum diff, log, and status packet to `review-input/review.txt` without a
shell, external diff, or text conversion.

Claude receives the exact PR and head, the credential-free target checkout, a
read-only workflow token, and the inference-only `CLAUDE_CODE_OAUTH_TOKEN`.
Because reviewed content is prompt-injection input, tool containment also
protects that credential. `--tools` exposes only `Read`, `Glob`, and `Grep`;
`--permission-mode dontAsk` permits them only for path-scoped rules covering
`review-target/**` and the trusted packet. Bare denies remove Bash, editing,
subagent, web, notebook, and MCP tools, and `--setting-sources user` prevents
future project settings from widening the declared surface. Claude cannot
read the process environment or files reached through an escaping symlink.
Its only accepted result is this closed JSON schema:

- `verdict`: `clean`, `needs_changes`, or `needs_discussion`;
- at most 12 findings, each with a `P1`/`P2`/`P3` severity, a 120-unit
  title, 400-unit detail, and optional 240-character ASCII
  repository-relative path and positive line;
- a nullable `follow_up` of at most 400 units.

`clean` requires zero findings and a null follow-up. A non-clean verdict
requires at least one finding or a follow-up. Missing output, extra keys,
malformed JSON, oversized strings, unsafe paths, and inconsistent verdicts fail
the workflow.

The trusted script canonicalizes the validated JSON into a mode-`0600`,
48,000-byte-bounded file under the runner temporary directory. Those schema
bounds also keep every rendered review below GitHub's 65,536-byte comment
limit; the publisher independently enforces that final UTF-8 byte bound before
requesting OIDC or an App token. A one-day
artifact carries that file to the publisher; review JSON is never interpolated
into a shell command or exposed as a job output. The publisher accepts only the
same canonical regular file and validates it again.

### Separate Claude App publisher

GitHub grants `id-token: write` at job scope, not step scope. The model job
therefore has no OIDC permission or OIDC request environment. A separate
publisher job has `needs: review`, repeats the full trusted-event guard, checks
out only protected main, and is the only OIDC-capable job. Every step in that
job technically receives the request-token environment; its pre-publish steps
are limited to immutable SHA-pinned checkout/download Actions, and the only
repository code it executes comes from protected main. No model process or
PR-head code runs in the job. The only values crossing from the model job are
validated bounded repository, PR, head, and workflow-ref strings plus the
canonical artifact.

Before exchange, the publisher requires its runtime `GITHUB_WORKFLOW_REF` to
equal
`mento-protocol/monitoring-monorepo/.github/workflows/claude.yml@refs/heads/main`.
It checks the GitHub-issued OIDC claims for issuer, audience, repository, exact
workflow ref, run ID, run attempt, and ten-minute maximum lifetime before the
Anthropic exchange verifies and consumes the token through the pinned
request/response contract above. The exchange requests only
`pull_requests: read` and `issues: write`. The short-lived Claude App token
stays inside that publisher process: it is never written to a file,
environment, output, artifact, checkout, model prompt, log, or child process.

Immediately before posting, the publisher re-reads the PR and requires its
head, base, state, draft flag, and repository identities to remain trusted. It
uses a non-cancelling per-PR concurrency group derived from the protected
review job's repository and PR outputs, while the inference job keeps its
separate head-bound cancellation group. The publisher
searches bounded REST pages for an exact `claude[bot]` / `Bot` body match,
reuses and re-verifies one match, posts only when none exists, and fails closed
when duplicates exist. This lets a retry after sentinel-upload failure bind the
original comment instead of posting another blocking protocol comment. The
publisher verifies both a POST or reused comment and an independent REST read
have the same comment ID and exact persisted body bytes, then revokes the App
token in `finally`. A publish, verification, or revocation failure fails
closed.

After successful readback and token revocation, a clean result creates a
90-day sentinel artifact. Its deterministic name binds the PR, head, persisted
comment ID, and SHA-256 digest of the exact body. The sentinel upload is the
last publisher step, so its workflow run cannot be successful until the
artifact exists. The body itself remains the finite PR/head envelope below.

### Exact clean attestation

Only `{verdict:"clean", findings:[], follow_up:null}` produces the clean
envelope:

```text
<!-- mento-claude-clean-review:v1 -->
MENTO CLAUDE CLEAN REVIEW v1
PR: <canonical decimal PR number>
HEAD: <40 lowercase hexadecimal characters>
VERDICT: CLEAN
FINDINGS: 0
FOLLOW-UP: NONE
END MENTO CLAUDE CLEAN REVIEW v1
```

`pr:feedback-state` accepts that envelope only as the entire untrimmed body,
with LF line endings, from `claude[bot]` whose REST type is `Bot`, when both
bindings equal the current PR and head, and when live artifact metadata proves
the matching sentinel belongs to a completed successful protected-main
`.github/workflows/claude.yml` run. The run must use one of the four review
triggers and have a human actor. `workflow_run` and `issue_comment` runs bind
to the current base branch and expose a canonical full head SHA.
`pull_request_review` and `pull_request_review_comment` runs bind to the exact
current PR head branch and head SHA. Missing, malformed, expired,
wrong-comment, or wrong-run sentinels block. A GitHub API failure leaves
readiness unknown and retriable; it is not persisted as blocker evidence.
Prefixes, suffixes, trailing newlines,
CRLF conversion, duplicate markers, secondary verdicts, prose, Markdown/HTML
contexts, altered fields, and a legacy `claude` login do not match. A
protocol-shaped current-head comment that is not exact blocks. A stale
prior-head comment remains stale and cannot override a current result.

The attestation clears only its top-level Claude review surface. Unresolved
review threads, unreplied inline comments, requested changes, and every other
feedback gate remain independent blockers. When multiple current attestations
exist, every one is classified; one malformed or non-clean comment cannot hide
beside a valid clean comment.

The bounded legacy LGTM grammar remains only for comments whose canonical
GitHub `createdAt` is strictly before `2026-08-14T00:00:00Z`; a present
`updatedAt` must also be canonical and before that cutoff. Missing, malformed,
offset-form, impossible, at-cutoff, and post-cutoff timestamps block. The small
historical compatibility registry remains exact and timestamp-independent: its
entries bind author, PR, comment ID, head, and raw-body digest. Both routes are
frozen history, not templates for new shapes. New Claude clean reviews must use
the provenance-verified producer; do not add per-PR digest bindings or broaden
free-form prose parsing.

## Alternatives considered

- **Keep expanding the prose parser.** Rejected. CommonMark contexts,
  negation, examples, passive findings, and format drift make prose an
  unbounded protocol. More rules enlarge the false-clean surface.
- **Register each newly observed clean comment by digest.** Retained only for
  frozen history. It binds bytes safely but turns each format change into a
  code change and cannot make future review output deterministic.
- **Ask agent mode to post a sticky summary.** Rejected by observed run
  `31754675314` and the pinned Action source. Agent mode's structured turn can
  succeed without the sticky-comment transport.
- **Let the Action publish with `github_token`.** Rejected. It yields the
  workflow bot identity, gives the model lane write capability, and cannot bind
  the result to the intended Claude App author.
- **Give the model job OIDC and publish in a later step.** Rejected. OIDC
  permission is job-wide, so the model process would inherit the request-token
  capability even if the workflow text placed publication later.
- **Run the secret-bearing review directly on `pull_request`.** Rejected. The
  workflow revision is PR-controlled and its OIDC `workflow_ref` is not the
  protected-main ref. The unprivileged dispatcher plus `workflow_run` preserves
  the repo's ban on `pull_request_target` while fixing both facts.
- **Trust `claude[bot]` identity without run provenance.** Rejected. The App
  identity is shared across repository workflows, and default-branch workflow
  validation does not prove which trusted workflow produced a comment. The
  sentinel binds the immutable comment ID without enlarging the comment body.
- **Use `pull_request_target`.** Rejected by the repository-wide CI trust
  policy: that trigger hands trusted context to a PR-triggered lane and is
  refused by `check-autofix-ci-trust.mjs`.

## Consequences

- Automatic review still runs only on PR open and draft-to-ready transitions;
  later reviews are explicit `@claude review` requests. Both now exercise the
  same producer, transport, publisher, and parser.
- A clean review is short and machine-owned. Human review detail appears only
  for non-clean results in the deterministic blocking JSON envelope.
- The introductory PR cannot exercise the new remote path against itself:
  protected main lacks the dispatcher and producer until merge. Its local
  workflow, parser, gate, and review tests are the bootstrap proof. Subsequent
  PRs provide live transport evidence.
- `CLAUDE_CODE_OAUTH_TOKEN` remains an inference credential in the model job.
  The App installation token is a separate, shorter-lived publishing authority
  that the model never receives.
- The one-day structured-review artifact can contain review findings. It is
  bounded, contains no credential, and is consumed only after canonical
  revalidation. The separate clean-provenance sentinel contains no finding and
  expires after 90 days; an older still-open PR needs a fresh review.

## Evidence

- `.github/workflows/claude-review-request.yml`
- `.github/workflows/claude.yml`
- `scripts/claude-review-contract.mjs`
- `scripts/claude-review-context.mjs`
- `scripts/claude-review-publisher.mjs`
- `scripts/claude-review-workflow.mjs`
- `scripts/claude-review-workflow.test.mjs`
- `scripts/pr-feedback-state-core.mjs`
- `scripts/pr-feedback-state-claude.mjs`
- `scripts/pr-feedback-state.test.mjs`
- `scripts/agent-quality-gate.sh`
- GitHub issue #1567; PRs #1553, #1839, and #1848; Actions run
  `31754675314`
