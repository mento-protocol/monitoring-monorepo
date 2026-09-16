---
title: Spoken Attention Nudge
status: active
owner: eng
canonical: true
last_verified: 2026-09-16
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Spoken Attention Nudge

When you need the user's attention and they are not actively responding, send a
brief spoken nudge with `say` in addition to the normal chat message. Default to
doing this when blocked on a user decision, waiting on approval for a production
mutation, a long task has finished and needs user follow-up, or plan feedback is
required before meaningful progress can continue.

`say` is the macOS built-in and the only spoken path on macOS. It speaks
locally: no network call, no API key, no third-party service.

```bash
say "hey, i need your approval in the agent chat"
```

## Name the session

Several sessions can speak to one operator, so name the session before the
message:

```bash
say "In ci cost audit: I need your approval in the agent chat."
```

Take the label from the session or pane title when it describes the task,
otherwise from the repository and branch or a short task description. Avoid a
label several sessions share, such as `Claude` or `main`. Keep it short and easy
to say. Put the same label in the written request so the operator can match the
two.

Pass the whole message as one safely quoted argument. Never build it from
command substitution, a file, or captured output.

**Known limit.** A labelled line is not one of the pre-approved phrases in
`.claude/settings.json`, so it prompts for approval, and an away operator cannot
give it. Speak the labelled line when someone can approve it. Otherwise speak a
pre-approved phrase, which tells the operator that a session needs them but not
which one, and name the session in the written request. Closing that gap needs a
reviewed helper that derives the label itself. Pre-approving `say` with a free
message argument is not the way to close it: a shell substitution in that
argument reads local file contents aloud.

## Keep the spoken text low-information

Keep the message short and fixed. Never speak secrets, logs, identifiers,
hashes, addresses, filenames, paths, or copied local content. A label may carry
non-sensitive session, pane, workspace, repository, and branch names; when a
name holds sensitive text, use a safe task label instead.

Claude command pre-approvals stay limited to the literal phrases tracked in
`.claude/settings.json`. Do not pre-approve `say` or `spd-say` with a wildcard
or an arbitrary message argument, because a shell substitution in that argument
could read local file contents aloud.

## Fallback and failure

Linux has no universal built-in TTS command; `spd-say` is best-effort only when
installed:

```bash
spd-say "hey, i need your feedback in the agent chat"
```

The workspace sandbox can block the local audio service. Run the nudge with
escalated permissions when it does instead of retrying inside the sandbox; in
Codex, request escalated execution. If every spoken path fails, report the
failure in chat and continue with the visible written request; do not silently
assume the user heard the nudge.

## Do not hook it

Do not wire this into the existing SessionEnd hook. The current shared hook
events do not know whether the agent is genuinely waiting on the user versus
waiting on CI, bot review, deploy sync, or another external process, so a hook
would either miss the important decision point or create noisy false alarms. Use
the manual `say` call at the moment the agent identifies a real user-input
blocker.
