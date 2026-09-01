#!/usr/bin/env bash
# Prepare a Claude Code on the web container for monitoring-monorepo agent work.
#
# Invoked from the SessionStart hook in .claude/settings.json (Claude Code on
# the web only, gated on $CLAUDE_CODE_REMOTE). Keeps the cloud checkout close
# to a fresh local worktree without requiring anything from a developer's home
# directory.
#
# Parallel to scripts/bootstrap/codex-cloud-setup.sh (Codex Cloud). The two share
# the install/codegen contract; this one additionally installs Playwright
# Chromium so the browser-fixture tests under
# `pnpm --filter @mento-protocol/ui-dashboard test:browser` work without an
# extra step.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/lib/install-marker.sh
source "$REPO_ROOT/scripts/lib/install-marker.sh"

echo "==> Marking repository safe for git"
git config --global --add safe.directory "$REPO_ROOT" || true

echo "==> Configuring repository git hooks"
git config core.hooksPath .trunk/hooks

echo "==> Activating package manager from package.json"
if command -v corepack >/dev/null 2>&1; then
  corepack enable
  PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")"
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
fi
pnpm --version

echo "==> Prewarming Trunk CLI and linters"
# Trunk powers the git pre-commit/pre-push hooks (.trunk/hooks) and `trunk fmt`.
# The launcher self-downloads the pinned CLI from trunk.io, which is NOT in the
# default Trusted allowlist for Claude Code on the web. The current operating
# allowlist beyond the Trusted defaults is trunk.io, *.trunk.io, and (optional,
# for the Playwright Chromium fallback download below when the image has no
# /opt/pw-browsers preinstall) cdn.playwright.dev. In the environment's network
# settings choose "Custom", keep "include defaults", and add:
#     trunk.io
#     *.trunk.io
#     cdn.playwright.dev   # optional; see the Playwright step below
# Measured in a live cloud container on 2026-08-26 with that allowlist in force
# (issue #2057): trunk.io, nodejs.org and registry.npmjs.org all answer 200, so
# Trunk's hermetic runtimes and its npm-sourced linters download normally.
# github.com does not — the platform's credential proxy intercepts it and gates
# it per session, answering 403 "GitHub access to this repository is not enabled
# for this session". No allowlist entry lifts that. It reaches Trunk's plugin
# archive (github.com/trunk-io/plugins) and its GitHub-release linters, so a
# COLD Trunk cache fails `trunk check` outright; the image ships a prewarmed
# cache holding both, which is what masks the block on a warm run. The prewarm
# below fills whichever cache tools/trunk resolves — $TRUNK_CACHE, else
# $XDG_CACHE_HOME/trunk, else ~/.cache/trunk.
# Non-fatal: if trunk.io is still blocked the hooks degrade gracefully (see
# .trunk/hooks) and CI still enforces Trunk on the PR, so warn and continue
# rather than aborting the whole bootstrap.
if trunk_ver=$(TRUNK_LAUNCHER_QUIET=true ./tools/trunk --version 2>/dev/null); then
  echo "$trunk_ver"
  if ! ./tools/trunk install; then
    echo "WARN: 'trunk install' could not preinstall all linters; hooks may run a reduced set." >&2
  fi
else
  echo "WARN: Trunk CLI could not be downloaded (is trunk.io allowlisted?)." >&2
  echo "WARN: git pre-commit/pre-push hooks will be skipped this session." >&2
  echo "WARN: Add 'trunk.io' and '*.trunk.io' to the env's Allowed domains (Custom" >&2
  echo "WARN: network access, keep defaults) to enable local Trunk fmt/lint hooks." >&2
fi

echo "==> Checking Node major version against .node-version"
# The container image can ship an older Node than the repo pins (observed:
# container Node v22 vs. a repo .node-version of 24), which makes pnpm print
# engine-range warnings for indexer-envio and metrics-bridge (both declare
# "node": ">=24"). This is a warning, not a failure: no root .npmrc sets
# engine-strict, so pnpm continues past the mismatch. Investigated and
# rejected as unreliable for this bootstrap step:
#   - corepack only manages package-manager shims (pnpm/yarn/npm), never the
#     Node runtime itself, so it has no lever here.
#   - `pnpm env use --global <major>` downloads a full Node build from
#     nodejs.org. That host is reachable (see the Trunk section above), so the
#     download itself would work — the reason below is what rules it out.
#   - It installs that Node under PNPM_HOME rather than changing the running
#     interpreter, and a later shell picks it up only when its PATH carries the
#     pnpm-managed bin directory. Nothing here puts it there, so the agent's
#     later, separate Bash tool invocations — independent shells, not children
#     of this script — keep the image's Node, and a switch performed here would
#     not reach the place the mismatch actually matters.
# Given both levers are either absent or illusory for the surface that
# matters, attempting an automatic switch would be speculative rather than
# robust. Warn once with a precise, actionable message instead, and never
# fail the bootstrap over this.
if [ -f "$REPO_ROOT/.node-version" ]; then
  required_node_major="$(tr -dc '0-9' <<<"$(cut -d. -f1 "$REPO_ROOT/.node-version")")"
  running_node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "")"
  if [[ -n "$required_node_major" && -n "$running_node_major" && "$running_node_major" -lt "$required_node_major" ]]; then
    echo "WARN: container Node major is v${running_node_major}, but .node-version pins ${required_node_major}." >&2
    echo "WARN: pnpm will print (non-fatal) engine-range warnings for packages requiring" >&2
    echo "WARN: node >=${required_node_major} (indexer-envio, metrics-bridge). To fix env-side," >&2
    echo "WARN: rebuild/select the hosted container image with a Node ${required_node_major}.x base," >&2
    echo "WARN: or set the platform's Node-version override if one is offered — this bootstrap" >&2
    echo "WARN: script cannot switch the interpreter for the agent's later shell invocations." >&2
  fi
fi

echo "==> Installing workspace dependencies"
# Skip the (~15s) reinstall when neither the lockfile nor the shared-config build
# inputs changed since the last bootstrap. shared-config is built by the root
# postinstall, which other packages import from. A source, manifest, compiler
# config, or clean-build wrapper edit must bust the marker even when
# pnpm-lock.yaml is unchanged. The marker lives inside the gitignored node_modules, so it is
# discarded whenever the dependency tree is. Marker semantics are shared with
# scripts/setup.sh through scripts/lib/install-marker.sh: a hashing miss yields
# an empty hash, which never matches, so the work reruns.
deps_marker="node_modules/.web-bootstrap-deps.sha256"
deps_hash="$(
  install_marker_hash_inputs \
    pnpm-lock.yaml \
    shared-config/src \
    shared-config/package.json \
    shared-config/scripts/build.mjs \
    shared-config/tsconfig.json || true
)"
if [ -d node_modules ] &&
  install_marker_matches "$deps_marker" "$deps_hash"; then
  echo "deps + shared-config unchanged since last bootstrap; skipping pnpm install."
  deps_skipped=1
else
  CI=true pnpm install --frozen-lockfile
  # Rebuild shared-config explicitly: on a src-only change (lockfile unchanged)
  # the install above is a no-op that skips the postinstall build, leaving
  # shared-config/dist stale for the dashboard/bridge imports that resolve it.
  pnpm --filter @mento-protocol/config build
  deps_skipped=0
fi

echo "==> Verifying dashboard dependency resolution"
pnpm --filter @mento-protocol/ui-dashboard exec node -e "require.resolve('@sentry/nextjs/package.json')"

# Record the deps marker only AFTER the resolution check passes, so a successful
# install + failed verification never caches a broken state (a warm restart
# would otherwise skip install and re-hit the same failure).
if [ "$deps_skipped" = "0" ]; then
  install_marker_write "$deps_marker" "$deps_hash"
fi

echo "==> Running Envio codegen"
# Skip the (~6s) regen when the type facade already exists AND every input Envio
# codegen reads is byte-identical. This marker is private to hosted setup; CI
# has no .envio cache and always runs codegen. Keep this input set aligned with
# config*.yaml, schema.graphql, the indexer package manifest, abis/**, and
# scripts/**. The ABIs feed the generated event types. Hashing config*.yaml
# (real files) rather than the config.yaml symlink also survives checkouts that
# do not materialise symlinks. The marker lives in the gitignored .envio dir.
codegen_marker="indexer-envio/.envio/.web-bootstrap-codegen.sha256"
codegen_hash="$(install_marker_hash_inputs indexer-envio/config*.yaml indexer-envio/schema.graphql indexer-envio/package.json indexer-envio/abis indexer-envio/scripts || true)"
if [ -s "indexer-envio/.envio/types.d.ts" ] &&
  install_marker_matches "$codegen_marker" "$codegen_hash"; then
  echo "Envio types up to date for the current codegen inputs; skipping codegen."
else
  # Drop any stale type facade first: a reused/cached checkout may already carry
  # the gitignored .envio/types.d.ts, which would let the verification below pass
  # even if THIS codegen run silently wrote nothing — the exact miss we guard for.
  rm -f indexer-envio/.envio/types.d.ts
  pnpm indexer:codegen
fi

echo "==> Verifying Envio codegen output"
# `envio codegen` is quiet in CI/non-TTY mode and exits 0 even when it writes
# nothing, so the exit code alone is not a reliable signal. The agent typecheck
# and vitest loops resolve indexer types from .envio/types.d.ts (the `envio` npm
# package supplies the runtime); the ReScript `generated/` dir is only needed
# for `pnpm indexer:dev`/`start` (Docker + live RPC), which is not a hosted-agent
# flow. Assert the type facade exists so a silent codegen miss fails the
# bootstrap here instead of surfacing as confusing type errors mid-task.
if [ ! -s "indexer-envio/.envio/types.d.ts" ]; then
  cat >&2 <<'MSG'
error: Envio codegen did not produce indexer-envio/.envio/types.d.ts.
indexer typecheck and the vitest suites resolve types from this file and will
fail without it. Re-run 'pnpm indexer:codegen' and inspect the envio CLI
output for the underlying error.
MSG
  exit 1
fi
# Record the inputs that produced this verified facade so a later bootstrap with
# unchanged codegen inputs can skip the regen above. Written only after the
# existence check passes, so the marker never caches a failed/empty codegen.
install_marker_write "$codegen_marker" "$codegen_hash"

echo "==> Installing Playwright Chromium for dashboard browser tests"
# Prefer the container image's preinstalled Chromium under /opt/pw-browsers
# when present and non-empty: it avoids a network fetch entirely and works
# even when the download path is unavailable. Checked with `find`/`test`
# rather than `ls` so the detection stays robust under this repo's sandbox
# read-deny rules for directory listings (see the node_modules workaround
# note in docs/notes/worktree-and-web-setup.md — the same `test -d`/`test -f`
# preference applies here).
PW_PREINSTALLED_DIR="/opt/pw-browsers"
used_preinstalled_pw_dir=false
if [ -d "$PW_PREINSTALLED_DIR" ] &&
  find "$PW_PREINSTALLED_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q .; then
  export PLAYWRIGHT_BROWSERS_PATH="$PW_PREINSTALLED_DIR"
  used_preinstalled_pw_dir=true
  echo "Using preinstalled Playwright browsers at $PW_PREINSTALLED_DIR (PLAYWRIGHT_BROWSERS_PATH set)."
  echo "WARN: this PLAYWRIGHT_BROWSERS_PATH export covers only this bootstrap" >&2
  echo "WARN: subprocess (including the 'playwright install' verification below)." >&2
  echo "WARN: claude-code-web-setup.sh has no shell-profile persistence mechanism" >&2
  echo "WARN: (unlike codex-cloud-setup.sh's persist_user_path_entry for PATH), so a" >&2
  echo "WARN: later 'test:browser' run in a fresh Bash tool shell will not inherit it." >&2
  echo "WARN: If that shell's default Playwright cache is empty, prefix the command with" >&2
  echo "WARN: PLAYWRIGHT_BROWSERS_PATH=$PW_PREINSTALLED_DIR, or set it as a persistent env" >&2
  echo "WARN: var in the platform's environment settings if one is offered." >&2
else
  echo "No usable preinstalled Playwright browsers at $PW_PREINSTALLED_DIR; falling back to download."
fi
# Non-fatal: even with cdn.playwright.dev now allowlisted in this environment
# (see the network-access comment above), hosted sessions may still run
# without sudo (so `--with-deps` cannot install OS packages), or the fallback
# download itself may be blocked in a given environment variant. Browser
# tests are optional for most agent flows; warn and continue so the rest of
# the bootstrap (codegen, context-check) still completes. `--with-deps`
# mirrors the repo CI workflows (`.github/workflows/ci.yml` and
# `update-snapshots.yml`) so a successful bootstrap leaves the container
# actually able to run the browser fixtures. With a preinstalled dir already
# exported above, this call is expected to verify/no-op rather than download.
if ! pnpm --filter @mento-protocol/ui-dashboard exec playwright install --with-deps chromium; then
  pw_install_failed=true
  if [ "$used_preinstalled_pw_dir" = true ]; then
    # The preinstalled dir only proved non-empty above, not that it holds the
    # revision this Playwright package expects, and it is typically
    # image-owned (not writable by this session). A missing revision there
    # turns a viable download-to-default-cache fallback into a nonfatal
    # failure; unset the override and retry against the normal (writable)
    # cache before giving up.
    echo "WARN: install against the preinstalled dir failed (missing revision and/or" >&2
    echo "WARN: read-only image path); retrying against the default Playwright cache." >&2
    unset PLAYWRIGHT_BROWSERS_PATH
    if pnpm --filter @mento-protocol/ui-dashboard exec playwright install --with-deps chromium; then
      pw_install_failed=false
    fi
  fi
  if [ "$pw_install_failed" = true ]; then
    echo "WARN: Playwright Chromium install failed." >&2
    echo "WARN: 'pnpm --filter @mento-protocol/ui-dashboard test:browser' will not work" >&2
    echo "WARN: until the environment provides a usable /opt/pw-browsers preinstall or" >&2
    echo "WARN: allows access to cdn.playwright.dev, and can install OS dependencies" >&2
    echo "WARN: (sudo apt-get) for Chromium." >&2
  fi
fi

echo "==> Validating repo-visible agent context"
pnpm agent:context-check

echo "==> Configuring GitHub integration mode"
# In Claude Code on the web, git transport is proxied through a local credential
# proxy (origin is http://local_proxy@127.0.0.1:.../git/...) that authenticates
# git only. GitHub API access is NOT generally available: the platform's GitHub
# credential proxy intercepts github.com/api.github.com independently of the
# environment network allowlist (GitHub-host allowlist entries are inert),
# overrides any client Authorization header (a GH_TOKEN is ignored), serves
# only /user and /rate_limit reliably, and blocks GraphQL — REST /repos/*
# behavior has been observed to vary by session and is not a fixed blanket
# block (empirical map: docs/notes/github-tooling-surfaces.md). Either way,
# `gh auth status` succeeds while pr:ready-state still cannot work, because it
# rides on GraphQL. The GitHub MCP server
# is the supported API path in these sessions. The token-gated gh install below
# is kept as a best-effort for environment variants whose proxy does serve repo
# API paths; the capability gate that matters is REST + GraphQL + --slurp
# (see docs/notes/github-tooling-surfaces.md), never `gh auth status`.
#
# Install source is the official github.com release tarball, NOT apt: the default
# Ubuntu build is gh 2.45.0, which lacks `gh api --slurp` that pr:ready-state
# relies on, and the cli.github.com apt repo is not allowlisted. Note the
# credential proxy scopes github.com to session-attached repos, so the cli/cli
# release download may 403 — the `|| gh_tag=""` guard below degrades to the MCP
# fallback. We deliberately do NOT run `gh auth setup-git`: the credential proxy
# already owns git auth and overriding it would break pushes. `gh` is used
# purely for the API (pr:ready-state / ship / babysit).
#
# Remote caveat: the git origin is the proxy URL, which gh does not recognise as
# a GitHub host, so gh cannot infer the repo. Pass `--repo <owner/name>` (the
# probe accepts it) or set a GH_REPO env var in the environment settings.
#
# The token is read inline as a presence check and never bound to a local
# variable: this file's whole body is new text to the autoreview secret scanner
# after the move, and a bare token assignment reads as a literal credential.
if [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]]; then
  # Reinstall unless a gh that already supports `--slurp` is on PATH.
  if ! { command -v gh >/dev/null 2>&1 && gh api --help 2>/dev/null | grep -q -- '--slurp'; }; then
    echo "==> GH_TOKEN detected; installing current gh from the GitHub release tarball"
    gh_tmp="$(mktemp -d)"
    gh_arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
    # `|| gh_tag=""` keeps a blocked/timed-out lookup from tripping `set -e` and
    # aborting the whole bootstrap — the optional gh install must degrade to the
    # MCP fallback, never fail setup. The pipe runs under pipefail, so the bare
    # assignment's non-zero status would otherwise terminate the script here.
    gh_tag="$(curl -fsS -o /dev/null -w '%{redirect_url}' --max-time 20 \
      https://github.com/cli/cli/releases/latest | sed -E 's@.*/tag/@@')" || gh_tag=""
    if [[ -n "$gh_tag" ]] &&
      curl -fsSL --max-time 90 -o "$gh_tmp/gh.tgz" \
        "https://github.com/cli/cli/releases/download/${gh_tag}/gh_${gh_tag#v}_linux_${gh_arch}.tar.gz" &&
      tar -xzf "$gh_tmp/gh.tgz" -C "$gh_tmp"; then
      sudo install -m755 "$gh_tmp/gh_${gh_tag#v}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh ||
        echo "WARN: gh install step failed; falling back to the GitHub MCP server." >&2
    else
      echo "WARN: gh download failed (github.com release blocked?); falling back to the GitHub MCP server." >&2
    fi
    rm -rf "$gh_tmp"
    hash -r 2>/dev/null || true
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo "WARN: gh is not installed (download failed above); using the GitHub MCP server for PR/API work." >&2
  elif ! gh api --help 2>/dev/null | grep -q -- '--slurp'; then
    # An older gh may still be on PATH if the tarball upgrade failed (no sudo,
    # blocked download). pr:ready-state calls `gh api --paginate --slurp`, which
    # that binary lacks, so do NOT advertise availability — force the MCP fallback.
    echo "WARN: gh on PATH is too old (no 'gh api --slurp'); the release-tarball upgrade did not apply." >&2
    echo "WARN: pr:ready-state needs --slurp; using the GitHub MCP server for PR/API work meanwhile." >&2
  elif gh auth status >/dev/null 2>&1; then
    echo "gh is installed and 'gh auth status' passes — but that only proves /user is served."
    echo "Before relying on gh-backed flows (pr:ready-state), verify the full capability gate:"
    echo "    gh api repos/<owner>/<repo> --jq .full_name"
    echo "    gh api graphql -f query='query{viewer{login}}'"
    echo "    gh api --help | grep -- --slurp"
    echo "In Claude cloud sessions the credential proxy blocks GraphQL regardless of GH_TOKEN, and"
    echo "REST /repos/* behavior varies by session; if either call fails, use the GitHub MCP server"
    echo "(docs/notes/github-tooling-surfaces.md)."
    echo "Reminder: pass --repo <owner/name> (or set GH_REPO) — the git remote is the local proxy, not a GitHub host."
  else
    echo "WARN: gh is installed but not authenticated — check the GH_TOKEN scopes/org approval." >&2
    echo "WARN: using the GitHub MCP server for PR/API work meanwhile." >&2
  fi
else
  echo "No GH_TOKEN set: using the GitHub MCP server for PR/API work (the supported path here)."
  echo "Note: setting GH_TOKEN does NOT enable gh-backed flows in Claude cloud sessions — the"
  echo "credential proxy overrides Authorization and blocks GraphQL either way; REST /repos/*"
  echo "behavior varies by session (docs/notes/github-tooling-surfaces.md)."
  echo "See docs/notes/github-tooling-surfaces.md for the gh->MCP mapping."
fi

echo "Claude Code on the web setup complete."
