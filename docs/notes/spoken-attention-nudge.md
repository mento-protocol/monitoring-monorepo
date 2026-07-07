---
title: Spoken Attention Nudge
status: active
owner: eng
canonical: true
last_verified: 2026-07-05
---

# Spoken Attention Nudge

When you need the user's attention and they are not actively responding, send a
brief spoken nudge with `sag` in addition to the normal chat message. Default to
doing this when blocked on a user decision, waiting on approval for a production
mutation, a long task has finished and needs user follow-up, or plan feedback is
required before meaningful progress can continue.

Use Charlie's voice with `sag` when it is installed and configured. Keep the
spoken message short and specific. Both Codex and Claude should prefer the
repo-standard key file path so behavior does not depend on shell startup files
or stripped environment variables:

```bash
sag --api-key-file ~/.config/elevenlabs_api_key -v Charlie "hey, i need your approval to deploy the Alloy collector"
```

`sag` needs network access to ElevenLabs, a readable ElevenLabs API key, and the
local audio device. Store the key for agent nudges in
`$HOME/.config/elevenlabs_api_key` with mode `0600`, then invoke `sag` with
`--api-key-file`. This is required for Codex because it does not reliably
inherit shell startup files, and its environment policy strips secret-like
variables such as `ELEVENLABS_API_KEY`, even when they exist in `.zshrc`. Claude
may inherit `.zshrc` in local shells, but should still use the same key-file
command so the two agents behave consistently.

Because `sag` is a third-party Homebrew package, it may not exist on every
developer machine. Use this fallback order:

```bash
msg="hey, i need your feedback on the deploy"
sent=0
if command -v sag >/dev/null 2>&1 && [ -r "$HOME/.config/elevenlabs_api_key" ]; then
  sag --api-key-file ~/.config/elevenlabs_api_key -v Charlie "$msg" && sent=1
fi
if [ "$sent" -eq 0 ] && command -v say >/dev/null 2>&1; then
  say "$msg" && sent=1
fi
if [ "$sent" -eq 0 ] && command -v spd-say >/dev/null 2>&1; then
  spd-say "$msg" && sent=1
fi
if [ "$sent" -eq 0 ]; then
  printf 'spoken nudge unavailable; falling back to chat only: %s\n' "$msg" >&2
fi
```

On macOS, `say` is the expected built-in fallback. Linux has no universal
built-in TTS command; `spd-say` is best-effort only when installed. In Codex,
request escalated execution for the nudge instead of trying to run it inside the
workspace sandbox. If every spoken path fails, report the failure in chat and
continue with the visible written request; do not silently assume the user heard
the nudge. Claude command pre-approvals should stay limited to literal,
low-information nudge messages. Do not pre-approve arbitrary `say`, `spd-say`,
or `sag` message arguments, because shell substitutions in those arguments could
disclose local file contents through speech or the ElevenLabs request.

Do not wire this into the existing SessionEnd hook. The current shared hook
events do not know whether the agent is genuinely waiting on the user versus
waiting on CI, bot review, deploy sync, or another external process, so a hook
would either miss the important decision point or create noisy false alarms.
Use the manual `sag` call at the moment the agent identifies a real user-input
blocker.
