#!/usr/bin/env bash
set -euo pipefail

helper="${AUTOREVIEW_HELPER:-$HOME/.agents/skills/autoreview/scripts/autoreview}"

if [[ ! -x "$helper" ]]; then
  cat >&2 <<EOF
agent:autoreview requires the global autoreview skill helper:
  $helper

Install or restore ~/.agents/skills/autoreview, then retry.
EOF
  exit 127
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

prepare_bundle_dir=""
feedback_pr=""
forward_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prepare-bundle-dir)
      if [[ $# -lt 2 ]]; then
        echo "agent:autoreview: $1 requires a directory argument" >&2
        exit 2
      fi
      prepare_bundle_dir="$2"
      shift 2
      ;;
    --feedback-pr)
      if [[ $# -lt 2 ]]; then
        echo "agent:autoreview: --feedback-pr requires a PR number or 'auto'" >&2
        exit 2
      fi
      feedback_pr="$2"
      shift 2
      ;;
    --)
      shift
      forward_args+=("$@")
      break
      ;;
    *)
      forward_args+=("$1")
      shift
      ;;
  esac
done

set -- "${forward_args[@]}"

if [[ -n "$feedback_pr" && -z "$prepare_bundle_dir" ]]; then
  echo "agent:autoreview: --feedback-pr requires --prepare-bundle-dir" >&2
  exit 2
fi

running_inside_codex_sandbox() {
  [[ -n "${CODEX_SANDBOX:-}" || -n "${CODEX_THREAD_ID:-}" ]]
}

has_explicit_engine() {
  if [[ -n "${AUTOREVIEW_ENGINE:-}" ]]; then
    return 0
  fi

  local arg
  for arg in "$@"; do
    case "$arg" in
      --engine | --engine=*)
        return 0
        ;;
    esac
  done

  return 1
}

has_prepare_only() {
  local arg
  for arg in "$@"; do
    if [[ "$arg" == "--prepare-only" ]]; then
      return 0
    fi
  done

  return 1
}

has_bundle_output() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --bundle-output | --bundle-output=*)
        return 0
        ;;
    esac
  done

  return 1
}

arg_value() {
  local flag="$1"
  local default_value="$2"
  shift 2

  while [[ $# -gt 0 ]]; do
    case "$1" in
      "$flag")
        if [[ $# -ge 2 ]]; then
          printf '%s\n' "$2"
          return 0
        fi
        ;;
      "$flag="*)
        printf '%s\n' "${1#*=}"
        return 0
        ;;
    esac
    shift
  done

  printf '%s\n' "$default_value"
}

git_output() {
  local repo="$1"
  shift
  git -C "$repo" "$@"
}

worktree_dirty() {
  local repo="$1"
  [[ -n "$(git_output "$repo" status --porcelain)" ]]
}

add_checklist() {
  local repo="$1"
  local rel_path="$2"
  shift 2

  if [[ ! -f "$repo/$rel_path" ]]; then
    return 0
  fi

  local existing
  for existing in "$@"; do
    if [[ "$existing" == "$rel_path" ]]; then
      return 1
    fi
  done

  printf '%s\n' "$rel_path"
}

select_checklists() {
  local repo="$1"
  local changed_paths_file="$2"
  local checklists=()
  local candidate
  local path

  candidate="$(add_checklist "$repo" "docs/pr-checklists/recurring-review-patterns.md" "${checklists[@]}" || true)"
  [[ -n "$candidate" ]] && checklists+=("$candidate")
  candidate="$(add_checklist "$repo" "docs/pr-checklists/review-prompt-exclusions.md" "${checklists[@]}" || true)"
  [[ -n "$candidate" ]] && checklists+=("$candidate")

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue

    case "$path" in
      .github/workflows/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/ci-workflow-gates.md" "${checklists[@]}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      package.json|pnpm-lock.yaml|pnpm-workspace.yaml|.npmrc|patches/*|.dependency-cruiser.cjs|eslint.config.mjs|scripts/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/code-health.md" "${checklists[@]}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      indexer-envio/*|metrics-bridge/*|ui-dashboard/src/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/stateful-data-ui.md" "${checklists[@]}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      ui-dashboard/src/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/swr-polling-hasura.md" "${checklists[@]}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      ui-dashboard/src/app/*|ui-dashboard/src/components/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/keyboard-a11y-controlled-widgets.md" "${checklists[@]}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      ui-dashboard/src/app/*)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/dynamic-route-metadata.md" "${checklists[@]}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      terraform/*|aegis/terraform/*|alerts/rules/*|scripts/deploy-*.sh)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/terraform-cloudrun.md" "${checklists[@]}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac

    case "$path" in
      *stryker*|.github/workflows/mutation-testing.yml|docs/mutation-testing.md)
        candidate="$(add_checklist "$repo" "docs/pr-checklists/mutation-testing.md" "${checklists[@]}" || true)"
        [[ -n "$candidate" ]] && checklists+=("$candidate")
        ;;
    esac
  done < "$changed_paths_file"

  printf '%s\n' "${checklists[@]}"
}

prepare_context_bundle() {
  local bundle_dir="$1"
  local pr_number="$2"
  shift 2

  local repo
  repo="$(git rev-parse --show-toplevel)"
  local repo_abs
  local bundle_parent
  local bundle_name
  repo_abs="$(cd "$repo" && pwd -P)"
  bundle_parent="$(dirname "$bundle_dir")"
  bundle_name="$(basename "$bundle_dir")"
  mkdir -p "$bundle_parent"
  bundle_parent="$(cd "$bundle_parent" && pwd -P)"
  bundle_dir="$bundle_parent/$bundle_name"
  if [[ -L "$bundle_dir" ]]; then
    echo "agent:autoreview: --prepare-bundle-dir must not be a symlink" >&2
    exit 2
  fi
  case "$bundle_dir/" in
    "$repo_abs"/*)
      echo "agent:autoreview: --prepare-bundle-dir must be outside the repo worktree" >&2
      exit 2
      ;;
  esac
  if [[ -d "$bundle_dir" && -n "$(find "$bundle_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "agent:autoreview: --prepare-bundle-dir must be empty or absent" >&2
    exit 2
  fi
  mkdir -p "$bundle_dir/checklists" "$bundle_dir/patches"

  local mode
  local target_mode
  local target_ref=""
  local branch
  mode="$(arg_value --mode auto "$@")"
  branch="$(git_output "$repo" branch --show-current || true)"

  case "$mode" in
    local)
      target_mode="local"
      ;;
    commit)
      target_mode="commit"
      target_ref="$(arg_value --commit HEAD "$@")"
      ;;
    branch)
      target_mode="branch"
      target_ref="$(arg_value --base origin/main "$@")"
      ;;
    auto)
      if worktree_dirty "$repo"; then
        target_mode="local"
      else
        target_mode="branch"
        target_ref="$(arg_value --base origin/main "$@")"
      fi
      ;;
    *)
      echo "agent:autoreview: unsupported --mode for bundle prep: $mode" >&2
      exit 2
      ;;
  esac

  case "$target_mode" in
    local)
      git_output "$repo" status --short >"$bundle_dir/git-status.txt"
      {
        git_output "$repo" diff --name-only --cached
        git_output "$repo" diff --name-only
        git_output "$repo" ls-files --others --exclude-standard
      } | sort -u >"$bundle_dir/changed-paths.txt"
      git_output "$repo" diff --cached --stat >"$bundle_dir/patches/staged.stat"
      git_output "$repo" diff --cached --patch --find-renames >"$bundle_dir/patches/staged.diff"
      git_output "$repo" diff --stat >"$bundle_dir/patches/unstaged.stat"
      git_output "$repo" diff --patch --find-renames >"$bundle_dir/patches/unstaged.diff"
      git_output "$repo" ls-files --others --exclude-standard >"$bundle_dir/patches/untracked-paths.txt"
      : >"$bundle_dir/patches/untracked.diff"
      while IFS= read -r untracked_path; do
        [[ -z "$untracked_path" ]] && continue
        if [[ -f "$repo/$untracked_path" ]]; then
          git_output "$repo" diff --no-index -- /dev/null "$untracked_path" >>"$bundle_dir/patches/untracked.diff" || true
        else
          printf 'untracked non-file omitted: %s\n' "$untracked_path" >>"$bundle_dir/patches/untracked.diff"
        fi
      done < "$bundle_dir/patches/untracked-paths.txt"
      ;;
    branch)
      git_output "$repo" diff --name-only "$target_ref...HEAD" | sort -u >"$bundle_dir/changed-paths.txt"
      git_output "$repo" diff --stat "$target_ref...HEAD" >"$bundle_dir/patches/branch.stat"
      git_output "$repo" diff --patch --find-renames "$target_ref...HEAD" >"$bundle_dir/patches/branch.diff"
      ;;
    commit)
      git_output "$repo" show --name-only --format= "$target_ref" | sed '/^$/d' | sort -u >"$bundle_dir/changed-paths.txt"
      git_output "$repo" show --stat --format=fuller "$target_ref" >"$bundle_dir/patches/commit.stat"
      git_output "$repo" show --patch --find-renames --format=fuller "$target_ref" >"$bundle_dir/patches/commit.diff"
      ;;
  esac

  local selected_checklists=()
  local checklist
  while IFS= read -r checklist; do
    [[ -z "$checklist" ]] && continue
    selected_checklists+=("$checklist")
  done < <(select_checklists "$repo" "$bundle_dir/changed-paths.txt")
  local helper_args=("$@")
  for checklist in "${selected_checklists[@]}"; do
    cp "$repo/$checklist" "$bundle_dir/checklists/$(basename "$checklist")"
    helper_args+=(--prompt-file "$checklist")
  done
  printf '%s\n' "${selected_checklists[@]}" >"$bundle_dir/selected-checklists.txt"

  if [[ "$pr_number" == "auto" ]]; then
    pr_number=""
    if command -v gh >/dev/null 2>&1; then
      pr_number="$(gh pr view --json number --jq .number 2>/dev/null || true)"
    fi
  fi

  if [[ -n "$pr_number" && "$pr_number" != "none" ]]; then
    pnpm --silent pr:feedback-state --pr "$pr_number" --json >"$bundle_dir/feedback-state.json"
    helper_args+=(--dataset "$bundle_dir/feedback-state.json")
  fi

  local default_bundle_output=0
  if ! has_bundle_output "${helper_args[@]}"; then
    helper_args+=(--bundle-output "$bundle_dir/autoreview-prompt.md")
    default_bundle_output=1
  fi
  if ! has_prepare_only "${helper_args[@]}"; then
    helper_args+=(--prepare-only)
  fi

  {
    printf '# Autoreview Context Bundle\n\n'
    printf -- '- Target: %s' "$target_mode"
    if [[ -n "$target_ref" ]]; then
      printf ' %s' "$target_ref"
    fi
    printf '\n'
    printf -- '- Branch: %s\n' "${branch:-detached}"
    printf -- '- Generated: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '## Contents\n\n'
    printf '%s\n' "- \`changed-paths.txt\`: changed files for the selected target."
    printf '%s\n' "- \`patches/\`: stat and patch files for read-only review."
    printf '%s\n' "- \`checklists/\`: repo-selected prompt/checklist context copied at generation time."
    printf '%s\n' "- \`selected-checklists.txt\`: source paths for the copied checklists."
    if [[ "$default_bundle_output" -eq 1 ]]; then
      printf '%s\n' "- \`autoreview-prompt.md\`: full prompt emitted by the global autoreview helper."
    else
      printf '%s\n' "- The full prompt is written to the caller-provided \`--bundle-output\` path."
    fi
    if [[ -f "$bundle_dir/feedback-state.json" ]]; then
      printf '%s\n' "- \`feedback-state.json\`: \`pr:feedback-state\` ledger for PR #$pr_number."
    fi
  } >"$bundle_dir/README.md"

  (cd "$repo" && "$helper" "${helper_args[@]}") >"$bundle_dir/helper-output.txt"
  cat "$bundle_dir/helper-output.txt"
  printf 'agent:autoreview context bundle: %s\n' "$bundle_dir"
}

if [[ -n "$prepare_bundle_dir" ]]; then
  prepare_context_bundle "$prepare_bundle_dir" "$feedback_pr" "$@"
  exit 0
fi

if running_inside_codex_sandbox && ! has_explicit_engine "$@" && ! has_prepare_only "$@"; then
  cat >&2 <<EOF
agent:autoreview: detected Codex sandbox; defaulting to --engine local because nested codex exec is unavailable here.
agent:autoreview: pass --engine codex, --engine claude, or AUTOREVIEW_ENGINE to override.
EOF
  set -- --engine local "$@"
fi

exec "$helper" "$@"
