---
description: Monitor one existing Envio deployment through registration and sync
argument-hint: "[commit]"
---

# Babysit Indexer Deploy

This compatibility command owns no independent deployment logic. Read
`.agents/skills/deploy-indexer/SKILL.md` and `docs/deployment.md`, then apply
the deploy skill's current Phase 2 registration and sync contract to one
already-pushed commit — its registration ceiling, sync deadline, watcher flags,
and post-sync handoff all live there.

Resolve one full target SHA. If `$ARGUMENTS` contains a commit, require exactly
one argument and resolve it with `git rev-parse --verify
"$ARGUMENTS^{commit}"`. Otherwise fetch `origin/envio` and resolve that ref:

```bash
git fetch origin envio
git rev-parse --verify "origin/envio^{commit}"
```

Run the canonical watcher in the foreground, passing the full SHA explicitly and
keeping the watcher attached to the active session:

```bash
ENVIO_REGISTRATION_TIMEOUT_SECONDS=300 \
  pnpm deploy:indexer:status <TARGET_COMMIT> --watch --compact
```

Arm the skill's wall-clock sync deadline with the current surface's task or
monitor facility; if the surface cannot enforce one, stay attached and stop the
watcher manually at that deadline. Interrupt the watcher when the deadline
fires, report `SYNC_DEADLINE`, and stop. Stop sooner on a registration failure
or non-zero watcher exit. Never infer success from a single status snapshot.

After a caught-up exit, run `pnpm deploy:indexer:verify <TARGET_COMMIT>`, then
follow the skill's Phase 3 handoff back to the active `/deploy-indexer` pipeline
or its guarded `--resume-preload <TARGET_COMMIT>` continuation. This command
never pushes, promotes, rolls back, or bypasses explicit production
authorization.
