# Auto Review

Run the repo-local structured closeout review helper. Normal shells default to
the Codex review engine; active Codex sandbox sessions default to the helper's
local deterministic engine unless an engine is passed explicitly. Pass
`--engine claude` when the user explicitly asks for Claude review.

Arguments: `$ARGUMENTS`

## Steps

1. Run:

```bash
pnpm agent:autoreview $ARGUMENTS
```

For a fresh-context Codex handoff, pass
`--prepare-bundle-dir /tmp/autoreview-bundle` using a directory outside the repo
worktree. Add `--feedback-pr <number>` when reviewing a feedback-fix batch.

2. Verify every accepted finding before editing. Do not blindly apply review
   output.
3. If fixes are made, rerun focused checks and rerun autoreview once for the
   fixed batch.
4. For PR work, do not call the PR clean until
   `pnpm pr:ready-state --pr <number> --json` is ready.
