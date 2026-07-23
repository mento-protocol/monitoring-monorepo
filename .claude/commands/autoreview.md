---
description: Run the repo-local structured closeout review
argument-hint: "[agent:autoreview options]"
---

# Auto Review

Freeze the request, owner, changed files, and non-test changed-line count, then
run:

```bash
pnpm agent:autoreview $ARGUMENTS
```

`docs/notes/agent-quality-gate-mechanics.md` owns engine selection, trusted
bundle preparation/verification, runtime-change refusal handling, and other
adapter mechanics. Follow it rather than duplicating those rules here.

Verify every accepted finding before editing. If fixes are made, rerun focused
checks and autoreview for that batch; pause for scope reclassification before a
third review-triggered patch cycle. A clean source review is not test, browser,
generated-artifact, CLI/API, or runtime proof, so retain every applicable gate.
If an autoreview runtime change triggers the owning adapter's self-review
refusal, keep it intact and follow the trusted pre-change sequence in the owner
note. For PR work, finish with
`pnpm pr:ready-state --pr <number> --repo <owner/name> --json`. When a Claude
cloud surface cannot run that probe, follow the MCP-emulation contract in the
`babysit-pr` skill and `docs/notes/github-tooling-surfaces.md`.
