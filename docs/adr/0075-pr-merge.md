---
title: One sanctioned human-only merge path
status: active
owner: eng
canonical: true
last_verified: 2026-08-28
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0075 — The sanctioned merge wrapper, and what it does not prove

**Status:** Accepted (Aug 2026), in force.
**Scope:** ci/process

## Context

"Never merge a pull request without the user's explicit approval" was written
only in agent instructions. Nothing in the repository could refuse a merge.

GitHub's merge API accepts the write directly. No git hook or CI job observes
the decision to press the button, so the repository had no place to put a gate
even in principle. A merge is
irreversible in practice: one agent that reads "ship it" as approval, or one
operator merging a pull request that went red minutes ago, lands unreviewed
code on `main` with no record of who approved what.

The repository already had a readiness oracle (`pnpm pr:ready-state`) and a
feedback ledger (`pnpm pr:feedback-state`). Both were advisory — an operator or
agent could ignore either and merge anyway.

## Decision

**Route every merge through one wrapper, `pnpm pr:merge`, that runs the
repository's own gates in a fixed order and refuses by default. Keep the human
approval rule as the binding control, and state plainly that no local check can
replace it.**

The ordered gates in `scripts/pr/merge-pr.mjs`:

1. Refuse outside an interactive human terminal — both `stdin` and `stdout`
   must be TTYs, and any non-empty automation marker
   (`AUTOMATION_ENV_MARKERS`) refuses. The Codex pair mirrors
   `running_inside_codex_sandbox()` in `scripts/agent-autoreview.sh`, and a
   test fails when the two lists drift.
2. Resolve the repository and the target pull request unambiguously. Zero or
   several candidates refuse rather than guess. The host is carried from the
   repository URL onto every later `--repo` and `gh api` call, because `gh`
   defaults a bare reference to github.com.
3. Read `pr:ready-state` **and** the `pr:feedback-state` ledger. Both must be
   clean; either one dirty needs an explicit `--not-ready-reason "<why>"`,
   which is recorded rather than waved through.
4. Print a briefing and require the operator to type the pull-request number
   back. Every GitHub-sourced field is stripped of terminal control and
   bidirectional formatting characters first.
5. Re-read every gate after the confirmation. A moved head, a retargeted base,
   an edited title, a changed login, a merge queue that appeared, or any change
   to the blocker set, the required-check states, or the individual blocking
   feedback items refuses. The comparison uses identities, not counts, and
   serializes each record on its own so no field can spell another's value.
6. Refuse a pull request that already has an auto-merge request standing on
   it, or whose base has a merge queue. Read both before the briefing and again
   after the confirmation.

   A standing auto-merge request means GitHub is already holding a merge
   somebody asked for outside these gates. Merging over it or cancelling it
   would overwrite another operator's intent.

   The synchronous merge endpoint cannot enqueue, but it can bypass a merge
   queue enabled through classic branch protection and merge directly.
   `Repository.mergeQueue(branch:)` is therefore the authoritative queue gate;
   it detects queues from rulesets and classic branch protection. The wrapper
   also reads the branch's ruleset rule types as a second signal and a specific
   diagnostic. An unreadable answer from either queue read refuses. The final
   GraphQL read queries `Repository.mergeQueue` and returns `viewer.login` plus
   the pull request's current `baseRefName` and `autoMergeRequest`. A login or
   base mismatch refuses, so the credential observation and queue query still
   match the confirmed operator and current base. It is the last remote read
   before consent is recorded and the direct merge starts.

7. Append the consent record — login, timestamp, pull request, head commit,
   any override reason — to gitignored `.merge-consents.jsonl`, opened
   `O_NOFOLLOW | O_NONBLOCK` with an `fstat` regular-file and single-hard-link
   check, and a short-write refusal. This is deliberately the **last** step
   before the merge: every refusal above runs first, so no consent record
   exists for a run the gates turned away.
8. Call the synchronous REST endpoint
   `PUT /repos/{owner}/{repo}/pulls/{number}/merge` with the approved head in
   `sha` and `merge_method=squash`. Omit `commit_title` and `commit_message`, so
   GitHub uses the repository's configured squash defaults. Then confirm that
   the pull request reached `MERGED` on the approved base and head. Any other
   outcome exits non-zero. Reconciliation never enables or disables
   auto-merge, because this request cannot create deferred merge state.

`.claude/settings.json` denies the raw `Bash(gh pr merge:*)` command, removing
the obvious shortcut past the wrapper for a Claude session.

**What this does not prove.** Neither layer is an unforgeable boundary, and the
wrapper says so in its own header rather than implying otherwise:

- A local process running as the operator can allocate a pseudo-terminal and
  clear the environment markers. Any local signal a local caller can synthesize
  is not proof of a human.
- The permission deny is a list of command patterns, so it covers the spellings
  someone enumerated. `gh pr merge` and its repository-qualified forms
  (`gh -R X pr merge`, `gh pr --repo X merge`, and the `=` variants) are denied
  — nine entries in all: the bare command plus eight qualified spellings
  covering `-R` and `--repo`, separated and `=` joined, before and after `pr`. Six of those spellings were run against gh 2.96.0 and
  all six parse; the bare `-R` form was confirmed to bypass the original single
  pattern. It does not cover the same
  merge issued as a raw REST call, through a `gh alias`, or with other global
  flags interleaved. The sanctioned wrapper now uses that REST form after its
  gates; agents remain forbidden from using the wrapper or the raw form. No
  pattern list closes that space, and one that read as though it did would be
  worse than a documented gap.
- **The confirmed login is not bound to the merge subprocess credential.** The
  final combined GraphQL response returns `viewer.login` with every final
  state. The wrapper compares that login with the operator confirmed before the
  briefing, then writes consent and starts a fresh `gh api` process. A
  `gh auth switch` after that response but before the REST child reads its
  credential can still make the child use another keyring or `hosts.yml`
  credential. The merge still targets the confirmed repository, pull request,
  base, and head, but the local ledger can name the wrong GitHub account. This
  does not apply when `GH_TOKEN` fixes the credential in the environment. The
  irreducible window is accepted because closing it would require the trust-root
  wrapper to capture a live token and inject it into a child environment, which
  creates a larger credential-handling surface. Issue 2099 records the decision.
- **Merge-queue and auto-merge absence are not bound atomically to the merge.**
  The wrapper checks both before the briefing and again in one final GraphQL
  response. A queue or auto-merge request enabled after that read but before
  GitHub handles the REST request can still be consumed or bypassed. The
  wrapper minimizes this interval, but GitHub's synchronous merge endpoint
  offers no parameter that binds either absence to the write.
- **The squash subject is not pinned.** A title edited in the same window can
  reach the merge commit. Sending `commit_title` would pin it, but this
  repository sets `squash_merge_commit_title=COMMIT_OR_PR_TITLE`: GitHub uses
  the single commit's subject when a PR has one, and appends `(#N)`. A fixed
  title would replace both behaviors on every merge, so the title is
  bound in the confirmation signature and the residual window is accepted
  rather than changing how every merge commit is titled.
- **The approved base cannot be bound atomically.** The request's `sha` pins the
  head, and the merge endpoint has no base equivalent. The final GraphQL read
  proves that the queue query still names the pull request's current base. A
  retarget landing after that read but before GitHub processes the merge still
  cannot be prevented here. The wrapper re-reads the base afterwards, says
  plainly that the merge did not go where the operator approved, and exits
  non-zero. That is detection, not prevention, and the window is a few hundred
  milliseconds wide.

The durable boundary is on GitHub's side of the wire — branch protection, or
credentials that cannot merge — and is tracked separately as follow-up.

## Alternatives considered

- **A GitHub-native approval or merge-queue control instead of a wrapper.**
  This is the stronger control and it remains the intended destination, but it
  gates only the final write. It cannot show the operator a briefing, cannot
  record who approved which head locally, and cannot refuse before the request
  leaves the machine. Rejected as a replacement, kept as the follow-up.
- **A pre-push or pre-receive hook.** A merge is not a push. No local hook runs
  on a merge API call, so there is nothing to hook.
- **Trusting the agent instructions alone.** This was the prior state. The rule
  was correct and unenforced; a rule with no default-refusing mechanism behind
  it fails exactly when an agent misreads intent.
- **Claiming the deny covers the API form too.** Rejected. An overstated
  control is worse than a modest one: it would retire scrutiny of a path that
  is still open.
- **Making the wrapper prove humanity.** Rejected as impossible rather than
  expensive. The autoreview pass raised this and it is correct — so the claim
  was narrowed in the script header, the operating card, and the PR
  description instead of being left standing.
- **Capture one token and pass it to the merge child.** This would bind the
  final combined viewer read, consent record, and merge to one credential.
  Rejected because it makes the trust-root wrapper read a live GitHub token and
  inject it into a child environment. The accepted misattribution window has
  less impact and does not change what merge the operator approved.

## Consequences

- `pnpm pr:merge` is the only sanctioned merge entry point, and operating-card
  step 8 names it. The approval rule is unchanged: the wrapper mechanizes it
  and does not relax it. Agents remain forbidden from running it at all.
- Merging now depends on both PR projections. A pull request that is
  check-green but has unresolved review threads no longer merges without a
  recorded reason, which matches the repository's own two-projection all-clear.
- The merge method is fixed to `squash`; `allow_merge_commit` and
  `allow_rebase_merge` are false on this repository. Changing it needs a
  re-check, because a rejected method fails at the API after consent is
  already recorded.
- The request omits `commit_title` and `commit_message`. The live repository
  settings verified on 2026-08-28 are
  `squash_merge_commit_title=COMMIT_OR_PR_TITLE` and
  `squash_merge_commit_message=COMMIT_MESSAGES`, so GitHub keeps the existing
  squash subject and message behavior.
- `.merge-consents.jsonl` is local and gitignored. It is evidence for the
  operator, not an audit log anyone else can read, and an attacker with local
  write can still delete it. It is deliberately not pushed anywhere.
- The wrapper is split across `merge-pr.mjs` (ordering), `merge-pr-core.mjs`
  (pure decisions), `merge-pr-io.mjs` (local side effects) and
  `merge-pr-github.mjs` (GitHub calls) so each stays under the 600-line soft
  cap. The suite asserts the cap over all four, which is the only per-PR
  enforcement: `scripts/` has no `max-lines` rule.
- Raw merge API calls and CI tokens remain outside this local control's reach.

## Evidence

- `scripts/pr/merge-pr.mjs`, `scripts/pr/merge-pr-core.mjs`,
  `scripts/pr/merge-pr-io.mjs`, and `.claude/settings.json` enforce the
  decision; `docs/notes/pr-operating-card.md` step 8 routes to it. PR #2072.
- `scripts/pr/merge-pr.test.mjs` is offline. Every GitHub and filesystem
  boundary is injected. It asserts the exact synchronous REST route, approved
  `sha`, squash method, omitted title and message fields, and the absence of
  any auto-merge compensation call on failed or unreadable outcomes. It also
  asserts queue-object, null-queue, and unreadable-queue responses for
  `Repository.mergeQueue`.
- Every gate above was verified by a negative control: removing the
  base-retarget check, the gate-signature check, the feedback gate, the
  hard-link check, the short-write check, the terminal sanitizer, the
  post-merge verification, or the host preservation each reds exactly its own
  case, and the suite returns green when restored.
- The CI half of the "an agent can merge anyway" concern was measured, not
  assumed: the `claude.yml` jobs grant `pull-requests: write` with
  `contents: read`, and merging a pull request requires `contents: write`, so
  that token cannot merge. The residual is a local session using the operator's
  own `gh` credentials.
- `gh api repos/mento-protocol/monitoring-monorepo` reports squash-only merge
  settings with `COMMIT_OR_PR_TITLE` and `COMMIT_MESSAGES`. Post-merge
  verification remains required because the wrapper accepts any `--repo` and
  a lost response can hide a completed merge.
- A read-only GraphQL control on 2026-08-28 returned a queue object and
  `https://github.com/github/docs/queue/main` for the queue-managed
  `github/docs` `main` branch. The same `Repository.mergeQueue(branch:)` query
  returned null for this repository's `main` branch. This verifies the signal
  without merging either repository.
