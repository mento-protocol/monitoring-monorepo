---
description: Run the repo-local structured closeout review
argument-hint: "[additional agent:closeout-review options]"
---

# Auto Review

Freeze the request, owner, changed files, and non-test changed-line count, then
run:

```bash
pnpm agent:closeout-review --base <base-remote>/<baseRefName> $ARGUMENTS
```

Pass the base that repository preflight bound. Do not infer a different default
branch for a stacked or not-yet-open PR.

Read the complete report. Hand it to the `review` skill for the verifier pass
over the same target. Inside an active Codex session, run the closeout from a
Claude session or an operator shell. With no `codex` on `PATH`, run the
`review` skill alone and disclose the single-source coverage.

Test the validation claims as operating-card step 4 requires; that step owns
the rule, so every review engine gets it.

Verify every accepted finding before editing. If fixes are made, rerun the
applicable direct author checks and the closeout for that batch. Do not pause
solely for cycle count before five review-triggered patch cycles are complete;
pause for scope reclassification before starting a sixth. A clean source
review is not test, browser, generated-artifact, CLI/API, or runtime proof.
Retain every applicable author check from step 3 of the
[operating card](../../docs/notes/pr-operating-card.md). Card step 4 owns the
target, exit, trust, fallback, and report-handoff contracts.
