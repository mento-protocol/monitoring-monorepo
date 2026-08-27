---
title: One sanctioned merge wrapper gates merges locally, and the binding control stays human
status: active
owner: eng
canonical: true
last_verified: 2026-08-26
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

`gh pr merge` reaches GitHub's write API directly. No git hook, no CI job, and
no branch-protection rule observes the decision to press the button, so the
repository had no place to put a gate even in principle. A merge is
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
6. Append the consent record — login, timestamp, pull request, head commit,
   any override reason — to gitignored `.merge-consents.jsonl`, opened
   `O_NOFOLLOW | O_NONBLOCK` with an `fstat` regular-file and single-hard-link
   check, and a short-write refusal.
7. Refuse a pull request that already has an auto-merge request standing on it.
   GitHub is then already holding a merge that someone asked for outside these
   gates; merging over it or cancelling it are both wrong, and the wrapper
   cannot tell its own compensation from interference with another operator's
   state. Refusing also makes the post-merge cleanup provably its own.
8. Refuse a ruleset-declared merge-queue base before sending anything, and
   again after the confirmation. The check reads the branch's **ruleset** rules;
   a merge queue enabled through a classic branch-protection rule does not
   surface there, so this narrows the window rather than closing it — step 9's
   reconciliation still catches such an enqueue, reports it, and exits non-zero.
   `gh pr merge` enqueues
   such a base and returns success, and nothing the wrapper can call removes a
   queue entry — `--disable-auto` turns off auto-merge only — so merging first
   would leave a standing request it cannot take back, which GitHub could
   complete later outside every gate above. An unreadable branch-rules answer
   refuses too.
9. Merge with `--squash --match-head-commit`, then confirm with GitHub that the
   pull request actually reached `MERGED`, on the approved base and the
   approved head. Any other outcome — including a failed merge command, which
   may still have reached GitHub — cancels auto-merge and exits non-zero.

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
  — eight patterns, covering `-R` and `--repo`, separated and `=` joined,
  before and after `pr`. Six of those spellings were run against gh 2.96.0 and
  all six parse; the bare `-R` form was confirmed to bypass the original single
  pattern. It does not cover the same
  merge issued as `gh api --method PUT repos/{owner}/{repo}/pulls/{n}/merge`,
  through a `gh alias`, or with other global flags interleaved. No pattern list
  closes that space, and one that read as though it did would be worse than a
  documented gap.
- **A merge queue enabled in the final window still enqueues.** The base's rule
  types are read before the briefing and again after the confirmation, and a
  `merge_queue` rule refuses both times. Neither read closes the gap between the
  last one and GitHub handling the request: `gh pr merge` enqueues rather than
  merging, and `--disable-auto` cannot remove a queue entry, so the wrapper
  would be left unable to take back a request it created. Closing this needs a
  merge operation that cannot enqueue — the REST endpoint with the approved
  `sha` — which is a change to the wrapper's central call and is tracked in
  issue 2092. `main` has no `merge_queue` rule today, so the hazard is latent
  here rather than active.
- **The squash subject is not pinned.** A title edited in the same window can
  reach the merge commit. `gh pr merge --subject` would pin it, but this
  repository sets `squash_merge_commit_title=COMMIT_OR_PR_TITLE`: GitHub uses
  the single commit's subject when a PR has one, and appends `(#N)`. A fixed
  `--subject` would replace both behaviours on every merge, so the title is
  bound in the confirmation signature and the residual window is accepted
  rather than changing how every merge commit is titled.
- **The approved base cannot be bound atomically.** `--match-head-commit` pins
  the head, and the merge endpoint's only matching parameter is `sha`, for the
  head — there is no base equivalent. A retarget landing between the final gate
  read and GitHub processing the merge therefore cannot be prevented here. The
  wrapper re-reads the base afterwards, says plainly that the merge did not go
  where the operator approved, and exits non-zero. That is detection, not
  prevention, and the window is a few hundred milliseconds wide.

The durable boundary is on GitHub's side of the wire — branch protection, or
credentials that cannot merge — and is tracked separately as follow-up.

## Alternatives considered

- **A GitHub-native approval or merge-queue control instead of a wrapper.**
  This is the stronger control and it remains the intended destination, but it
  gates only the final write. It cannot show the operator a briefing, cannot
  record who approved which head locally, and cannot refuse before the request
  leaves the machine. Rejected as a replacement, kept as the follow-up.
- **A pre-push or pre-receive hook.** A merge is not a push. No local hook runs
  on `gh pr merge`, so there is nothing to hook.
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

## Consequences

- `pnpm pr:merge` is the only sanctioned merge entry point, and operating-card
  step 8 names it. The approval rule is unchanged: the wrapper mechanizes it
  and does not relax it. Agents remain forbidden from running it at all.
- Merging now depends on both PR projections. A pull request that is
  check-green but has unresolved review threads no longer merges without a
  recorded reason, which matches the repository's own two-projection all-clear.
- The merge method is fixed to `--squash`; `allow_merge_commit` and
  `allow_rebase_merge` are false on this repository. Changing it needs a
  re-check, because a rejected method fails at the API after consent is
  already recorded.
- `.merge-consents.jsonl` is local and gitignored. It is evidence for the
  operator, not an audit log anyone else can read, and an attacker with local
  write can still delete it. It is deliberately not pushed anywhere.
- The wrapper is split across `merge-pr.mjs` (ordering), `merge-pr-core.mjs`
  (pure decisions) and `merge-pr-io.mjs` (side effects) so each stays under the
  600-line soft cap, with a test asserting that.
- The `gh api` merge route and CI tokens remain outside this control's reach.

## Evidence

- `scripts/pr/merge-pr.mjs`, `scripts/pr/merge-pr-core.mjs`,
  `scripts/pr/merge-pr-io.mjs`, and `.claude/settings.json` enforce the
  decision; `docs/notes/pr-operating-card.md` step 8 routes to it. PR #2072.
- `scripts/pr/merge-pr.test.mjs` is offline — every GitHub and filesystem
  boundary is injected — and each refusal case asserts that no consent was
  recorded and no merge ran.
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
- `gh api repos/mento-protocol/monitoring-monorepo/rulesets` reports no
  `merge_queue` rule on `main` today; the post-merge verification exists because
  the wrapper accepts any `--repo`.
