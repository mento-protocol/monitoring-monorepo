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

Check the PR's Validation section against what the run actually establishes.
Every claim names the evidence behind it and the nearest stronger claim that
evidence does not support. Raise an unexplained strengthening of a claim as a
finding.

Verify every accepted finding before editing. If fixes are made, rerun focused
checks and autoreview for that batch. Do not pause solely for cycle count before
five review-triggered patch cycles are complete; pause for scope
reclassification before starting a sixth. A clean source review is not test,
browser, generated-artifact, CLI/API, or runtime proof, so retain every
applicable gate.
If an autoreview runtime change triggers the owning adapter's self-review
refusal, keep it intact and follow the trusted pre-change sequence in the owner
note.
