#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/dev-janitor.sh [--apply]

Reports (and, with --apply, cleans up) stale local dev-machine disk usage:
trunk repo caches, the pnpm store, pruned git worktree metadata, and stale
/private/tmp scratch trees. Defaults to dry-run.

Options:
  --apply   Execute the cleanup actions instead of only reporting them.
  -h, --help  Show this help.

Environment:
  JANITOR_TRUNK_REPOS_DIR  Trunk repo cache directory to scan.
                           Default: $HOME/.cache/trunk/repos
  JANITOR_STALE_DAYS       Age in days before a trunk repo cache is stale.
                           Default: 30
  JANITOR_SKIP_SYSTEM      When set to 1, skip the pnpm store and git
                           worktree sections (used by tests to avoid
                           touching real system state).
USAGE
}

apply=0
case "${1:-}" in
  "") ;;
  --apply) apply=1 ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac

if [[ $# -gt 1 ]]; then
  usage >&2
  exit 1
fi

trunk_repos_dir="${JANITOR_TRUNK_REPOS_DIR:-$HOME/.cache/trunk/repos}"
stale_days="${JANITOR_STALE_DAYS:-30}"
skip_system="${JANITOR_SKIP_SYSTEM:-0}"

print_disk_free() {
  df -g / | awk 'NR==2 {print "Free disk: " $4 " GiB"}'
}

echo "== dev-janitor =="
if [[ $apply -eq 1 ]]; then
  echo "Mode: APPLY (destructive actions will run)"
else
  echo "Mode: DRY-RUN (nothing will be deleted)"
fi
print_disk_free
echo

echo "-- Trunk repo caches (older than ${stale_days}d, ${trunk_repos_dir}) --"
stale_repos=()
if [[ -d "$trunk_repos_dir" ]]; then
  while IFS= read -r -d '' dir; do
    stale_repos+=("$dir")
  done < <(find "$trunk_repos_dir" -maxdepth 1 -mindepth 1 -type d -mtime +"$stale_days" -print0)
fi
echo "Found ${#stale_repos[@]} stale trunk repo cache(s)"
for dir in "${stale_repos[@]+"${stale_repos[@]}"}"; do
  echo "  $dir"
done
if [[ $apply -eq 1 ]]; then
  for dir in "${stale_repos[@]+"${stale_repos[@]}"}"; do
    rm -rf "$dir"
  done
fi
echo

echo "-- pnpm store --"
if [[ "$skip_system" == "1" ]]; then
  echo "Skipped (JANITOR_SKIP_SYSTEM=1)"
elif [[ $apply -eq 1 ]]; then
  pnpm store prune
else
  echo "Would run: pnpm store prune"
fi
echo

echo "-- Git worktrees --"
if [[ "$skip_system" == "1" ]]; then
  echo "Skipped (JANITOR_SKIP_SYSTEM=1)"
else
  if [[ $apply -eq 1 ]]; then
    git worktree prune
  else
    echo "Would run: git worktree prune"
  fi
  echo "Current worktrees (never auto-deleted; they can hold uncommitted work):"
  git worktree list
fi
echo

echo "-- Stale /private/tmp trees (report only, never deleted) --"
tmp_count=0
if [[ -d /private/tmp ]]; then
  tmp_count="$(find /private/tmp -maxdepth 1 -mindepth 1 -type d \( -iname '*monitoring*' -o -iname '*autoreview*' \) 2>/dev/null | wc -l | tr -d ' ')"
fi
echo "Found ${tmp_count} monitoring/autoreview /private/tmp dir(s)"
echo

if [[ $apply -eq 1 ]]; then
  echo "== After cleanup =="
  print_disk_free
fi
