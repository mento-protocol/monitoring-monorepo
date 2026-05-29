#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web.
#
# Bootstraps a hosted Claude Code session so the agent inherits the same baseline
# a freshly-set-up worktree has: workspace deps installed, Envio codegen run,
# Playwright Chromium fetched, agent-context validated. Gated on
# $CLAUDE_CODE_REMOTE so local Claude Code sessions don't re-run a heavy install
# on every prompt — local devs already have a working tree.
#
# SessionStart fires on `startup`, `resume`, `clear`, and `compact` unless the
# settings.json entry pins a `matcher`. We only want the heavy install on
# `startup` — a hosted container that has already booted, run install/codegen,
# and is just resuming or compacting context does not need 60s+ of pnpm work
# again. Read the JSON `source` from stdin and skip non-startup events.
#
# Synchronous (no `{"async": true, ...}` header): the script runs to completion
# before the agent receives control. Note that SessionStart's exit code is
# advisory in Claude Code — a failed bootstrap surfaces in the hook log but
# does not by itself block the agent from running tools. Pair this with
# explicit dependency checks in the gates that consume them.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Inspect SessionStart payload on stdin (best-effort: if stdin is not present
# or the payload is unparsable, default to running the bootstrap rather than
# silently skipping). Only `startup` triggers the heavy install/codegen path.
HOOK_INPUT=""
if [ ! -t 0 ]; then
  HOOK_INPUT="$(cat || true)"
fi
if [ -n "$HOOK_INPUT" ]; then
  SOURCE="$(printf '%s' "$HOOK_INPUT" |
    node -e "let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).source||'')}catch{process.stdout.write('')}})" \
    2>/dev/null || true)"
  case "$SOURCE" in
    startup | "") ;;
    *)
      echo "claude-code-web SessionStart: skipping bootstrap on source=$SOURCE." >&2
      exit 0
      ;;
  esac
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
