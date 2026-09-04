---
description: Run the repo-local structured closeout review
argument-hint: "[additional agent:closeout-review options]"
---

# Auto Review

Resolve the base in repository preflight. Freeze the request, owner, changed
files, and non-test changed-line count. Without a base integration, run:

```bash
pnpm agent:closeout-review --base <base-remote>/<baseRefName> $ARGUMENTS
```

Do not infer another base for a stacked or not-yet-open PR. After a base
integration, use both immutable axes from
[operating-card step 4](../../docs/notes/pr-operating-card.md). Read every report
and hand it to the `review` skill. That step owns the remaining rules.

Verify each accepted finding. After a fix, rerun its direct author checks and
the closeout. Source review does not prove tests, browser behavior, generated
artifacts, CLI/API behavior, or runtime behavior. Keep that evidence separate.
