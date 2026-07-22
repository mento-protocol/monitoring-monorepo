#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/check-skills-mirror.sh

Verifies that .agents/skills/ and .claude/skills/ are byte-for-byte
identical. Docs and tooling reference both directories as an exact-mirror
pair (see docs/notes/codex-agent-skills.md); this script is the enforcement
for that contract. Exits nonzero and prints a drift report naming the
differing files if the trees diverge, executable bits differ, either tree
is missing, or either tree contains a symlink (byte comparison can't verify
a symlink's target, so symlinks are rejected outright rather than silently
trusted).

One documented exception (docs/context-standards.md): runtime-specific
provenance literals in the forensic-report skill — `source: "Codex"` in the
canonical tree versus `source: "claude"` in the Claude mirror — are
normalized before comparison, only inside forensic-report skill files.

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

# Normalize the documented runtime-specific provenance literals
# (docs/context-standards.md: forensic-report writes `source: "Codex"` in the
# canonical skill and `source: "claude"` in the Claude mirror) so that ONLY
# that documented difference, in forensic-report files only, is tolerated.
provenance_normalize() {
  sed -E 's/source: "(Codex|claude)"/source: "__RUNTIME__"/g' "$1"
}

drift=0
report() {
  if [[ "$drift" -eq 0 ]]; then
    echo "check-skills-mirror: $root_a and $root_b have drifted:" >&2
    drift=1
  fi
  echo "  $1" >&2
}

# Content comparison, file-by-file, so the provenance exception and the
# executable-bit check can both be applied per file.
while IFS= read -r rel; do
  a="$root_a/$rel"
  b="$root_b/$rel"
  if [[ ! -f "$b" ]]; then
    report "only in $root_a: $rel"
    continue
  fi
  if ! cmp -s "$a" "$b"; then
    case "$rel" in
      */forensic-report/* | forensic-report/*)
        if ! diff <(provenance_normalize "$a") <(provenance_normalize "$b") >/dev/null; then
          report "content drift (beyond documented provenance literals): $rel"
        fi
        ;;
      *)
        report "content drift: $rel"
        ;;
    esac
  fi
  x_a=0
  x_b=0
  [[ -x "$a" ]] && x_a=1
  [[ -x "$b" ]] && x_b=1
  if [[ "$x_a" -ne "$x_b" ]]; then
    report "executable-bit drift: $rel"
  fi
done < <(cd "$root_a" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)

while IFS= read -r rel; do
  if [[ ! -f "$root_a/$rel" ]]; then
    report "only in $root_b: $rel"
  fi
done < <(cd "$root_b" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)

if [[ "$drift" -ne 0 ]]; then
  exit 1
fi
echo "check-skills-mirror: $root_a and $root_b are identical"
exit 0
