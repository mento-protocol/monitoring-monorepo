#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web.
#
# Bootstraps a hosted Claude Code session so the agent inherits the same baseline
# a freshly-set-up worktree has: workspace deps installed, Envio codegen run,
# Playwright Chromium fetched, agent-context validated. Gated on
# $CLAUDE_CODE_REMOTE so local Claude Code sessions don't re-run a heavy install
# on every prompt — local devs already have a working tree.
#
# Synchronous (no `{"async": true, ...}` header): the session waits for the
# bootstrap so the agent never tries to run quality-gate / tests / lint commands
# before deps and codegen exist. Switch to async by emitting the JSON header
# below before the install steps if the latency cost matters more than the
# race-condition risk.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SETUP_SCRIPT="$REPO_ROOT/scripts/claude-code-web-setup.sh"

if [ ! -f "$SETUP_SCRIPT" ]; then
  echo "claude-code-web SessionStart: $SETUP_SCRIPT missing; skipping bootstrap." >&2
  exit 0
fi

# Invoke via `bash` so the executable bit on the script does not matter — the
# repo is sometimes checked out with mode 0644 (e.g. when pushed via the
# GitHub Contents API instead of `git push`).
#
# Redirect the setup script's stdout to stderr so Claude Code does not pull
# 10–20K tokens of pnpm install / codegen / Playwright output into the model
# session context. Setup progress still surfaces in the SessionStart hook log;
# only the final exit code matters to the agent.
exec bash "$SETUP_SCRIPT" >&2
