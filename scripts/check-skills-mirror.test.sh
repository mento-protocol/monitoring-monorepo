#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

fixture_dir="$(mktemp -d)"
output_file="$(mktemp)"
trap 'rm -rf "$fixture_dir"; rm -f "$output_file"' EXIT

fail() {
  echo "check-skills-mirror test failed: $*" >&2
  echo >&2
  echo "Last output:" >&2
  sed 's/^/  /' "$output_file" >&2
  exit 1
}

root_a="$fixture_dir/agents-skills"
root_b="$fixture_dir/claude-skills"

reset_fixture() {
  rm -rf "$root_a" "$root_b"
  mkdir -p "$root_a/example-skill" "$root_b/example-skill"
  echo "hello" > "$root_a/example-skill/SKILL.md"
  echo "hello" > "$root_b/example-skill/SKILL.md"
}

# Identical trees exit 0.
reset_fixture
if ! SKILLS_MIRROR_ROOT_A="$root_a" SKILLS_MIRROR_ROOT_B="$root_b" \
  scripts/check-skills-mirror.sh > "$output_file" 2>&1; then
  fail "identical trees exited nonzero, expected 0"
fi

# Content drift: exit nonzero and name the differing file.
reset_fixture
echo "goodbye" > "$root_b/example-skill/SKILL.md"
if SKILLS_MIRROR_ROOT_A="$root_a" SKILLS_MIRROR_ROOT_B="$root_b" \
  scripts/check-skills-mirror.sh > "$output_file" 2>&1; then
  fail "content drift exited 0, expected nonzero"
fi
grep -q "SKILL.md" "$output_file" || fail "content drift output did not name the differing file"

# Missing file on one side: exit nonzero and name it.
reset_fixture
rm "$root_b/example-skill/SKILL.md"
if SKILLS_MIRROR_ROOT_A="$root_a" SKILLS_MIRROR_ROOT_B="$root_b" \
  scripts/check-skills-mirror.sh > "$output_file" 2>&1; then
  fail "missing file on one side exited 0, expected nonzero"
fi
grep -q "SKILL.md" "$output_file" || fail "missing-file output did not name the missing file"

# Extra file on one side: exit nonzero and name it.
reset_fixture
echo "extra" > "$root_a/example-skill/EXTRA.md"
if SKILLS_MIRROR_ROOT_A="$root_a" SKILLS_MIRROR_ROOT_B="$root_b" \
  scripts/check-skills-mirror.sh > "$output_file" 2>&1; then
  fail "extra file on one side exited 0, expected nonzero"
fi
grep -q "EXTRA.md" "$output_file" || fail "extra-file output did not name the extra file"

# Symlink in either tree: exit nonzero, even if it resolves to identical bytes.
reset_fixture
rm "$root_b/example-skill/SKILL.md"
ln -s "$root_a/example-skill/SKILL.md" "$root_b/example-skill/SKILL.md"
if SKILLS_MIRROR_ROOT_A="$root_a" SKILLS_MIRROR_ROOT_B="$root_b" \
  scripts/check-skills-mirror.sh > "$output_file" 2>&1; then
  fail "symlink in one tree exited 0, expected nonzero"
fi
grep -q "symlink" "$output_file" || fail "symlink output did not explain the failure"

# Documented provenance literals (docs/context-standards.md) may differ, but
# only inside forensic-report skill files.
reset_fixture
mkdir -p "$root_a/forensic-report" "$root_b/forensic-report"
printf 'writes source: "Codex" records\n' > "$root_a/forensic-report/SKILL.md"
printf 'writes source: "claude" records\n' > "$root_b/forensic-report/SKILL.md"
if ! SKILLS_MIRROR_ROOT_A="$root_a" SKILLS_MIRROR_ROOT_B="$root_b" \
  scripts/check-skills-mirror.sh > "$output_file" 2>&1; then
  fail "documented forensic-report provenance difference exited nonzero, expected 0"
fi

# Any other difference in a forensic-report file still fails.
reset_fixture
mkdir -p "$root_a/forensic-report" "$root_b/forensic-report"
printf 'writes source: "Codex" records\n' > "$root_a/forensic-report/SKILL.md"
printf 'writes source: "claude" records, plus drift\n' > "$root_b/forensic-report/SKILL.md"
if SKILLS_MIRROR_ROOT_A="$root_a" SKILLS_MIRROR_ROOT_B="$root_b" \
  scripts/check-skills-mirror.sh > "$output_file" 2>&1; then
  fail "non-provenance drift in forensic-report exited 0, expected nonzero"
fi
grep -q "beyond documented provenance" "$output_file" || fail "forensic drift output did not explain the failure"

# The provenance literal outside forensic-report is NOT exempt.
reset_fixture
printf 'writes source: "Codex" records\n' > "$root_a/example-skill/SKILL.md"
printf 'writes source: "claude" records\n' > "$root_b/example-skill/SKILL.md"
if SKILLS_MIRROR_ROOT_A="$root_a" SKILLS_MIRROR_ROOT_B="$root_b" \
  scripts/check-skills-mirror.sh > "$output_file" 2>&1; then
  fail "provenance-style difference outside forensic-report exited 0, expected nonzero"
fi

# Executable-bit drift: exit nonzero and name the file.
reset_fixture
chmod +x "$root_a/example-skill/SKILL.md"
if SKILLS_MIRROR_ROOT_A="$root_a" SKILLS_MIRROR_ROOT_B="$root_b" \
  scripts/check-skills-mirror.sh > "$output_file" 2>&1; then
  fail "executable-bit drift exited 0, expected nonzero"
fi
grep -q "executable-bit drift" "$output_file" || fail "mode-drift output did not name the drifted file"

# Missing directory: exit nonzero.
rm -rf "$root_a" "$root_b"
if SKILLS_MIRROR_ROOT_A="$root_a" SKILLS_MIRROR_ROOT_B="$root_b" \
  scripts/check-skills-mirror.sh > "$output_file" 2>&1; then
  fail "missing directories exited 0, expected nonzero"
fi
grep -q "missing directory" "$output_file" || fail "missing-directory output did not explain the failure"

echo "check-skills-mirror.test.sh: all checks passed"
