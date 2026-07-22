#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/check-skills-mirror.sh

Verifies that .agents/skills/ and .claude/skills/ are byte-for-byte
identical. Docs and tooling reference both directories as an exact-mirror
pair (see docs/notes/codex-agent-skills.md); this script is the enforcement
for that contract. Exits nonzero and prints a drift report naming the
differing files if the trees diverge, either tree is missing, or either
tree contains a symlink (byte comparison can't verify a symlink's target,
so symlinks are rejected outright rather than silently trusted).

Environment:
  SKILLS_MIRROR_ROOT_A  First tree to compare. Default: .agents/skills
  SKILLS_MIRROR_ROOT_B  Second tree to compare. Default: .claude/skills
USAGE
}

case "${1:-}" in
  "") ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac

root_a="${SKILLS_MIRROR_ROOT_A:-.agents/skills}"
root_b="${SKILLS_MIRROR_ROOT_B:-.claude/skills}"

missing=0
if [[ ! -d "$root_a" ]]; then
  echo "check-skills-mirror: missing directory: $root_a" >&2
  missing=1
fi
if [[ ! -d "$root_b" ]]; then
  echo "check-skills-mirror: missing directory: $root_b" >&2
  missing=1
fi
if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

symlinks="$(find "$root_a" "$root_b" -type l 2>/dev/null)"
if [[ -n "$symlinks" ]]; then
  echo "check-skills-mirror: symlinks are not supported in the mirrored trees (diff can't verify a symlink's target):" >&2
  echo "$symlinks" >&2
  exit 1
fi

if diff_output="$(diff -r "$root_a" "$root_b" 2>&1)"; then
  echo "check-skills-mirror: $root_a and $root_b are identical"
  exit 0
fi

echo "check-skills-mirror: $root_a and $root_b have drifted:" >&2
echo "$diff_output" >&2
exit 1
