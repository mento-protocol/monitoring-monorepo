# Auto Review

Run the global structured closeout review helper. Default engine is Codex;
pass `--engine claude` when the user explicitly asks for Claude review.

Arguments: `$ARGUMENTS`

## Steps

1. Read `~/.agents/skills/autoreview/SKILL.md` for the workflow contract.
2. Run:

```bash
pnpm agent:autoreview $ARGUMENTS
```

3. Verify every accepted finding before editing. Do not blindly apply review
   output.
4. If fixes are made, rerun focused checks and rerun autoreview once for the
   fixed batch.
5. For PR work, do not call the PR clean until
   `pnpm pr:ready-state --pr <number> --json` is ready.
