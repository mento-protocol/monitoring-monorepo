# Auto Review

Run the repo-local structured closeout review helper. Normal shells default to
the Codex review engine; active Codex sandbox sessions default to the helper's
local deterministic engine only when no engine is passed explicitly. An
explicitly selected unavailable engine fails closed. Pass `--engine claude`
when the user explicitly asks for Claude review.

Arguments: `$ARGUMENTS`

## Steps

1. Freeze the original request, target/owner, changed files, and non-test
   changed-line count as the scope baseline. Classify later additions as
   in-scope, follow-up, or stop; create an issue before deferring valid
   follow-up work and warn near twice the baseline.
2. Run:

```bash
pnpm agent:autoreview $ARGUMENTS
```

For a fresh-context Codex handoff, pass
`--prepare-bundle-dir /tmp/autoreview-bundle` using a directory outside the repo
worktree. Add `--feedback-pr <number>` when reviewing a feedback-fix batch.
The bundle is published atomically after source validation and owns its
`autoreview-prompt.md`; do not combine this mode with `--bundle-output`.
Direct supplemental evidence must be repo-relative; the wrapper-generated
feedback dataset inside the trusted bundle directory is the exception. The
helper reviews the complete target without truncation. Direct semantic engines
fail closed if more than one prompt is required; prepared bundles retain
bounded lossless passes that one fresh-context reviewer must inspect
completely. Semantic engines use an isolated empty workspace, sensitive inputs
fail closed, and a quiet reviewer emits a 60-second heartbeat.
Do not pass the removed `--parallel-tests` option; run tests through the quality
gate.

3. Verify every accepted finding before editing. Do not blindly apply review
   output.
4. If fixes are made, rerun focused checks and autoreview for the fixed batch.
   Pause for scope reclassification after two review-triggered patch cycles
   rather than starting a third automatically.
5. Treat a clean result as source review, not UI, CLI/API, generated-artifact,
   or runtime proof. Keep every applicable browser, quality-gate, and runtime
   verification step.
6. For PR work, do not call the PR clean until
   `pnpm pr:ready-state --pr <number> --json` is ready.
