#!/usr/bin/env bash
# Shared guard sourced by deploy scripts. Deploy scripts must refuse dirty
# working trees before mutating external systems (scripts/AGENTS.md):
# uncommitted edits would ship unreviewed and make rollback/audit unreliable.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Working directory is not clean. Commit or stash your changes first."
  git status --short
  exit 1
fi
