---
description: Monitor one existing Envio deployment through registration and sync
argument-hint: "[commit]"
---

# Babysit Indexer Deploy

This compatibility command owns no independent deployment logic. Read
`.claude/skills/deploy-indexer/SKILL.md` and `docs/deployment.md`, then apply
the deploy skill's current Phase 2 registration and sync contract to one
already-pushed commit.

Resolve one full target SHA. If `$ARGUMENTS` contains a commit, require exactly
one argument and resolve it with `git rev-parse --verify
"$ARGUMENTS^{commit}"`. Otherwise fetch `origin/envio` and resolve that ref:

```bash
git fetch origin envio
git rev-parse --verify "origin/envio^{commit}"
```

Run the canonical watcher in the foreground with the deploy skill's five-minute
registration ceiling:

```bash
ENVIO_REGISTRATION_TIMEOUT_SECONDS=300 \
  pnpm deploy:indexer:status <TARGET_COMMIT> --watch --compact
```

Pass the full SHA explicitly and keep the watcher attached to the active
session. When it reports registration and enters sync watching, arm a
90-minute wall-clock deadline with the current surface's task or monitor
facility. Interrupt the foreground watcher when that deadline fires, report
`SYNC_DEADLINE`, and stop. If the surface cannot enforce a deadline, do not
leave the watcher unattended; remain attached and stop it manually at the
deadline. Stop sooner on a registration failure or non-zero watcher exit.
Never infer success from a single status snapshot.

After a caught-up exit, run:

```bash
pnpm deploy:indexer:verify <TARGET_COMMIT>
```

Report `SYNCED_PENDING_DATA_VERIFY` until that verifier passes. Then return to
the active `/deploy-indexer` pipeline or its guarded
`--resume-preload <TARGET_COMMIT>` continuation. This command never pushes,
promotes, rolls back, or bypasses explicit production authorization.
