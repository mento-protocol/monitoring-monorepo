---
title: Babysit PR Cloud Watch Loop
status: active
owner: eng
canonical: true
last_verified: 2026-08-21
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Cloud Watch Loop (Claude cloud sessions)

Use this loop when `CLAUDE_CODE_REMOTE` is set and the session does not pass the
gh capability gate in
[`docs/notes/github-tooling-surfaces.md`](../../../docs/notes/github-tooling-surfaces.md).
`pnpm pr:ready-state` cannot run there. Target resolution, checkout binding, and
blocker handling stay as written in [`SKILL.md`](SKILL.md).

Do not foreground-poll and never sleep-poll. Instead:

1. Subscribe to PR events (`subscribe_pr_activity`) so comments, reviews, and
   CI failures arrive as webhook activity.
2. Arm a scheduled self check-in (for example `send_later`) before ending the
   turn, every 15–20 minutes against the default one-hour deadline. Webhook
   events do not cover CI success, new pushes, or merge-conflict transitions,
   so a check-in that only fires at the deadline would miss a mid-window
   green. Re-arming is bounded by that same babysitting deadline (one hour
   unless the user set a different budget): at the deadline, report the current
   state and stop or escalate instead of re-arming silently. Stop when the PR
   is merged or closed.
3. On every event or check-in, run the MCP emulation of the readiness sweep
   using the tool mapping in
   [`docs/notes/github-tooling-surfaces.md`](../../../docs/notes/github-tooling-surfaces.md):
   PR state and head SHA, head check runs, unresolved review threads (page to
   the end), unreplied root review comments, and top-level comments. Two
   readings the mapping does not make for you:
   - The latest per-reviewer state from `get_reviews`: an outstanding
     `CHANGES_REQUESTED` is a required blocker until approved or dismissed —
     GitHub's aggregate review decision persists across new pushes, so do not
     discard it for being on an older commit. Whether an approval is required
     at all (`REVIEW_REQUIRED`) rides on branch protection, which MCP cannot
     read — name it unverified.
   - The Codex current-head signal from Codex's visible reviews/comments. The
     reaction-backed PR-description approval gate is not readable over MCP;
     report it as unverified rather than assumed.
   - The CodeRabbit current-head signal from `get_reviews`. Count only a
     CodeRabbit review whose body contains `**Run ID**` and whose review commit
     equals the current full head. Ignore empty reply-only review records. After
     the optional CodeRabbit check becomes terminal, refresh once. If the signal
     is missing or stale and no trusted top-level comment contains both
     `@coderabbitai review` and
     `<!-- coderabbit-final-head-review:<full-head-sha> -->`, use
     `add_issue_comment` to post `@coderabbitai review`, a blank line, and that
     exact marker. A marker comment is trusted only when its author association
     is `OWNER`, `MEMBER`, or `COLLABORATOR`, or its author login is `claude`,
     `claude[bot]`, `chatgpt-codex-connector`, or
     `chatgpt-codex-connector[bot]`. When the head-update time is available,
     require the request comment to be at or after it. Recheck the current full
     head immediately before the write.
     The marker detects completed requests and provides best-effort duplicate
     suppression; the issue-comment API does not provide an atomic claim.
4. Blocker handling, reply shapes, and Codex-request discipline are identical
   to the local path; use the MCP write tools named in the same mapping
   (`add_reply_to_pull_request_comment` for inline review comments,
   `add_issue_comment` for top-level PR conversation comments,
   `resolve_review_thread`, `update_pull_request`) in place of `gh` commands.
   Reply before resolving, always.
5. Label any all-clear as **MCP-emulated readiness**, never as probe-verified:
   `pnpm pr:ready-state` did not run, and the Codex approval gate plus
   required-context classification are approximations. An MCP-emulated
   all-clear is a status report, not a terminal state: keep the step-2 loop
   armed, name the gates the sweep could not verify (for example the Codex
   reaction approval) as unverified rather than clear, and hand the final
   probe-verified readiness decision to a gh-capable surface (local babysitter
   or CI).

Before reporting that status, rerun this checklist in full and label the result
MCP-emulated.
