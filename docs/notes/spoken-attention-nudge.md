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
brief spoken nudge with `say` and a desktop notification in addition to the
normal chat message. Default to doing this when blocked on a user decision, waiting on approval for a production
mutation, a long task has finished and needs user follow-up, or plan feedback is
required before meaningful progress can continue.

`say` is the macOS built-in and the only spoken path on macOS. It speaks
locally: no network call, no API key, no third-party service.

```bash
say -v Aaron "hey, i need your approval in the agent chat"
```

## Pin the voice

Always pass `-v Aaron`. The default voice is not stable across macOS releases,
and the operator picked this one, so the pre-approved phrases in
`.claude/settings.json` carry the flag as part of the literal.

`say -v '?'` lists the voice as `Aaron (Enhanced)`. The short name resolves to
it: `-v Aaron` and `-v "Aaron (Enhanced)"` render byte-identical audio, and both
differ from the default. The pre-approval uses the short name so no permission
literal has to carry parentheses.

`say` does not fail on a voice it does not have: it exits 0 and speaks the
default instead, so a missing voice sounds like a working nudge in the wrong
voice. When `say -v '?'` does not list Aaron, install it under System Settings,
Accessibility, Spoken Content, System Voice, Manage Voices. Say so in chat
rather than re-pointing the pinned command at another voice.

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
and use both IDs to target the notification. Never speak those IDs. Do not
guess a title, and do not change focus or
titles. When that lookup is unavailable, use the working directory, branch, and
task context.

Type the label out as plain text, using letters, digits, spaces, `.`, `_`, and
`-` only. Never paste a pane title or a ref name into the command: `$(…)`, a
backtick, or a quote in that title runs before `say` does. When a title carries
anything outside that set, write a safe task label instead.

Pass the whole message as one safely quoted argument. Never build it from
command substitution, a file, or captured output.

**Known limit.** The pre-approved phrases live in `.claude/settings.json` and
cover Claude only. A labelled line is not one of them. In manual approval mode it prompts,
and an away operator cannot give approval. Speak the labelled line when
someone can approve it. Otherwise speak a pre-approved phrase, which tells the
operator that a session needs them but not which one, and name the session in
the written request. Codex has no equivalent literal pre-approval: its nudge goes
through escalated execution, which the runtime may approve automatically or
may prompt for in either form, and an
unanswered prompt is a failed spoken path — fall back to the written request.
Closing the gap needs a reviewed helper that derives the label itself.
Pre-approving `say` with a free message argument is not the way to close it: a
shell substitution in that argument reads local file contents aloud.

## Pair speech with a desktop notification

Send a desktop notification before each spoken attention nudge. Make it a
separate tool call so notification failure cannot prevent speech, and speech
failure cannot prevent the notification. Keep the written request in all cases.
Use the same safe session label and short reason in the notification and report.

In cmux, check that both caller environment variables are non-empty. Use the
CLI and socket of the cmux app that hosts this session, and target both IDs explicitly:

```bash
cmux notify --workspace "$CMUX_WORKSPACE_ID" --surface "$CMUX_SURFACE_ID" \
  --title "Monitoring, backlog sweep" \
  --body "The report is ready and needs your attention."
```

Clicking the cmux notification opens the target workspace and terminal pane.
Never substitute the focused pane, workspace indexes, another session's IDs,
or another app instance's socket. Do not focus the pane yourself.

If the tool shell lacks either caller ID, inspect its process ancestry and
identify the current agent's ancestor PID. Resolve that verified agent PID
through cmux's `agent.resolve_delivery_target` RPC with a numeric `pid` field.
Require a successful response with `source: "pid"` and both `workspace_id` and
`surface_id`. Use those returned IDs in `cmux notify`. Do not use the tool
shell's temporary PTY or another agent's PID. Never infer a target from the
working directory, pane title, or whichever pane has focus.

If neither caller IDs nor a verified process route are available, report that
session-targeted notification delivery is unavailable. Continue with speech
and the written report. Do not substitute `osascript display notification`:
clicking it opens Script Editor rather than the requesting terminal. Outside
cmux, use a notification mechanism only when it can open the verified calling
session. Never interpolate captured titles into shell code. Apply the spoken
text restrictions below to notification text too.

For unattended runs, use the existing permission mode. Automatic approval may
admit a safe notification without a literal allow-list entry. In manual or
allow-list-only modes, use an already approved notification capability. If none
is available, record notification delivery as unavailable; do not wait on a
prompt the away operator cannot answer. Do not change permission settings.

If the sandbox blocks the socket or notification service, use the runtime's
supported permission path. Keep notification and speech requests separate.
Do not add wildcard command approvals. A blocked notification approval is a
failed notification path; report it and continue with speech and the report.
A successful command proves submission, not that a desktop banner appeared.
Notification permissions, Focus settings, and cmux policy can suppress banners.

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
the manual notification and `say` calls at the moment the agent identifies a real user-input
blocker.
