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

Test the validation claims against what the run actually establishes. On a
re-run for an open PR, that is its Validation section. On the first pass there
is no PR yet — the operating card runs this at step 4 and opens the PR at
step 5 — so apply the same test to the claims you are about to write. Either
way: every claim names the evidence behind it and the nearest stronger claim
that evidence does not support, and an unexplained strengthening of a claim is
a finding.

Verify every accepted finding before editing. If fixes are made, rerun focused
checks and autoreview for that batch. Do not pause solely for cycle count before
five review-triggered patch cycles are complete; pause for scope
reclassification before starting a sixth. A clean source review is not test,
browser, generated-artifact, CLI/API, or runtime proof, so retain every
applicable gate.
If an autoreview runtime change triggers the owning adapter's self-review
refusal, keep it intact and follow the trusted pre-change sequence in the owner
note.
