#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

fixture_dir="$(mktemp -d)"
output_file="$(mktemp)"
trap 'rm -rf "$fixture_dir"; rm -f "$output_file"' EXIT

fail() {
  echo "dev-janitor test failed: $*" >&2
  echo >&2
  echo "Last output:" >&2
  sed 's/^/  /' "$output_file" >&2
  exit 1
}

trunk_repos_dir="$fixture_dir/trunk-repos"
mkdir -p "$trunk_repos_dir"
old_dir="$trunk_repos_dir/old-repo"
fresh_dir="$trunk_repos_dir/fresh-repo"
mkdir -p "$old_dir" "$fresh_dir"
touch -t 202501010000 "$old_dir"
# fresh_dir keeps its just-created mtime (today).

if ! JANITOR_TRUNK_REPOS_DIR="$trunk_repos_dir" JANITOR_STALE_DAYS=30 JANITOR_SKIP_SYSTEM=1 \
  scripts/dev-janitor.sh > "$output_file"; then
  fail "dry-run exited nonzero, expected 0"
fi

grep -q "old-repo" "$output_file" || fail "dry-run output did not name the old repo cache"
grep -q "fresh-repo" "$output_file" && fail "dry-run output named the fresh repo cache as a candidate"
[[ -d "$old_dir" ]] || fail "dry-run deleted the old repo cache"
[[ -d "$fresh_dir" ]] || fail "dry-run deleted the fresh repo cache"

if scripts/dev-janitor.sh --bogus-flag > "$output_file" 2>&1; then
  fail "unknown flag exited 0, expected nonzero"
fi

# Re-create the fixture immediately before the apply run so this test stays
# order-independent (a prior test may have already deleted old_dir).
rm -rf "$old_dir" "$fresh_dir"
mkdir -p "$old_dir" "$fresh_dir"
touch -t 202501010000 "$old_dir"

if ! JANITOR_TRUNK_REPOS_DIR="$trunk_repos_dir" JANITOR_STALE_DAYS=30 JANITOR_SKIP_SYSTEM=1 \
  scripts/dev-janitor.sh --apply > "$output_file"; then
  fail "apply exited nonzero, expected 0"
fi

[[ ! -d "$old_dir" ]] || fail "apply did not delete the stale trunk repo cache"
[[ -d "$fresh_dir" ]] || fail "apply deleted the fresh trunk repo cache"

if JANITOR_TRUNK_REPOS_DIR="/" JANITOR_SKIP_SYSTEM=1 scripts/dev-janitor.sh --apply > "$output_file" 2>&1; then
  fail "apply against unsafe trunk cache root exited 0, expected nonzero"
fi

grep -q "refus" "$output_file" || fail "apply against unsafe trunk cache root did not explain the refusal"

# An ancestor of the repo root (not just an exact match) must also be
# refused, or --apply would delete depth-1 directories under it.
ancestor_of_repo_root="$(dirname "$repo_root")"
if JANITOR_TRUNK_REPOS_DIR="$ancestor_of_repo_root" JANITOR_SKIP_SYSTEM=1 \
  scripts/dev-janitor.sh --apply > "$output_file" 2>&1; then
  fail "apply against an ancestor-of-repo-root cache dir exited 0, expected nonzero"
fi

grep -q "refus" "$output_file" || fail "apply against an ancestor-of-repo-root cache dir did not explain the refusal"

echo "dev-janitor.test.sh: all checks passed"
