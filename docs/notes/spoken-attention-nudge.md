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
say -v Aaron "hey, i need your approval in the agent chat"
```

## Pin the voice

Always pass `-v Aaron`. macOS 27 changed the default voice, and the operator
picked this one, so the pre-approved phrases in `.claude/settings.json` carry
the flag as part of the literal.

`say` does not fail on a voice it does not have: it exits 0 and speaks the
default instead, so a missing voice sounds like a working nudge in the wrong
voice. `say -v '?'` lists what is installed. When Aaron is not there, install it
under System Settings, Accessibility, Spoken Content, System Voice, Manage
Voices, and say so in chat rather than re-pointing the pinned command at another
voice.

## Name the session

Several sessions can speak to one operator, so name the session before the
message:

```bash
say -v Aaron "In ci cost audit: I need your approval in the agent chat."
```

Take the label from the session or pane title when it describes the task,
otherwise from the repository and branch or a short task description. Avoid a
label several sessions share, such as `Claude` or `main`. Keep it short and easy
to say. Put the same label in the written request so the operator can match the
two.

Use metadata tied to this session, not whichever pane holds focus. In cmux, look
the title up through the caller's own `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`,
and never speak those IDs. Do not guess a title, and do not change focus or
titles. When that lookup is unavailable, use the working directory, branch, and
task context.

Type the label out as plain text, using letters, digits, spaces, `.`, `_`, and
`-` only. Never paste a pane title or a ref name into the command: `$(…)`, a
backtick, or a quote in that title runs before `say` does. When a title carries
anything outside that set, write a safe task label instead.

Pass the whole message as one safely quoted argument. Never build it from
command substitution, a file, or captured output.

**Known limit.** The pre-approved phrases live in `.claude/settings.json` and
cover Claude only. A labelled line is not one of them, so it prompts for
approval, and an away operator cannot give it. Speak the labelled line when
someone can approve it. Otherwise speak a pre-approved phrase, which tells the
operator that a session needs them but not which one, and name the session in
the written request. Codex has no equivalent pre-approval: its nudge goes
through escalated execution, which can prompt for either form, and an
unanswered prompt is a failed spoken path — fall back to the written request.
Closing the gap needs a reviewed helper that derives the label itself.
Pre-approving `say` with a free message argument is not the way to close it: a
shell substitution in that argument reads local file contents aloud.

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
