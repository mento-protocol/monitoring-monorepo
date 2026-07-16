#!/usr/bin/env bash
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
script_parent="${script_path%/*}"
if [[ "$script_parent" == "$script_path" ]]; then
  script_parent="."
fi
script_dir="$(cd -- "$script_parent" && pwd -P)"
repo_root="$(cd -- "$script_dir/.." && pwd -P)"
default_helper="$repo_root/scripts/agent-autoreview.mjs"
helper="${AUTOREVIEW_HELPER:-$default_helper}"

checkout_root="$(pwd -P)"
while [[ ! -e "$checkout_root/.git" ]]; do
  checkout_parent="${checkout_root%/*}"
  if [[ -z "$checkout_parent" ]]; then
    checkout_parent="/"
  fi
  if [[ "$checkout_parent" == "$checkout_root" ]]; then
    break
  fi
  checkout_root="$checkout_parent"
done

rejected_command_roots=("$repo_root")
if [[ "$checkout_root" != "$repo_root" ]]; then
  rejected_command_roots+=("$checkout_root")
fi

path_is_rejected() {
  local candidate="${1%/}"
  local rejected_root
  for rejected_root in "${rejected_command_roots[@]}"; do
    case "$candidate" in
      "$rejected_root" | "$rejected_root"/*)
        return 0
        ;;
    esac
  done
  return 1
}

build_external_path() {
  local path_entries=()
  local path_entry
  local physical_entry
  local trusted_path=""
  IFS=: read -r -a path_entries <<<"${PATH:-}"
  path_entries+=(/usr/bin /bin /usr/sbin /sbin)
  for path_entry in "${path_entries[@]}"; do
    [[ "$path_entry" == /* && -d "$path_entry" ]] || continue
    path_is_rejected "$path_entry" && continue
    physical_entry="$(cd -P -- "$path_entry" 2>/dev/null && pwd -P)" || continue
    path_is_rejected "$physical_entry" && continue
    case ":$trusted_path:" in
      *":$physical_entry:"*) continue ;;
    esac
    if [[ -n "$trusted_path" ]]; then
      trusted_path+=":"
    fi
    trusted_path+="$physical_entry"
  done
  printf '%s\n' "$trusted_path"
}

PATH="$(build_external_path)"
export PATH

realpath_bin=""
for realpath_candidate in /usr/bin/realpath /bin/realpath; do
  if [[ -x "$realpath_candidate" ]]; then
    realpath_bin="$realpath_candidate"
    break
  fi
done
if [[ -z "$realpath_bin" ]]; then
  realpath_candidate="$(type -P realpath || true)"
  if [[ "$realpath_candidate" == /* && -x "$realpath_candidate" ]] &&
    ! path_is_rejected "$realpath_candidate"; then
    realpath_bin="$realpath_candidate"
  fi
fi

resolve_external_command() {
  local command_name="$1"
  local path_entries=()
  local path_entry
  local candidate
  local candidate_name
  local resolved
  IFS=: read -r -a path_entries <<<"$PATH"
  for path_entry in "${path_entries[@]}"; do
    candidate="$path_entry/$command_name"
    [[ "$candidate" == /* && -f "$candidate" && -x "$candidate" ]] || continue
    path_is_rejected "$candidate" && continue
    candidate_name="${candidate##*/}"
    if [[ -n "$realpath_bin" ]]; then
      resolved="$("$realpath_bin" "$candidate" 2>/dev/null)" || continue
    else
      [[ ! -L "$candidate" ]] || continue
      resolved="$path_entry/$candidate_name"
    fi
    [[ "$resolved" == /* && -f "$resolved" && -x "$resolved" ]] || continue
    path_is_rejected "$resolved" && continue
    printf '%s\n' "$resolved"
    return 0
  done
  return 1
}

git_bin="$(resolve_external_command git || true)"

if [[ ! -x "$helper" ]]; then
  cat >&2 <<EOF
agent:autoreview requires an executable autoreview helper:
  $helper

This repo vendors its default helper at:
  $default_helper

Restore that file, or set AUTOREVIEW_HELPER to an executable helper path.
EOF
  exit 127
fi
if [[ -z "$git_bin" || ! -x "$git_bin" ]]; then
  echo "agent:autoreview requires a trusted git executable" >&2
  exit 127
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

prepare_bundle_dir=""
feedback_pr=""
forward_args=()
prepare_staging_dir=""

cleanup_prepare_staging() {
  if [[ -n "$prepare_staging_dir" ]]; then
    rm -rf -- "$prepare_staging_dir"
  fi
}

trap cleanup_prepare_staging EXIT

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

detect_pr_base() {
  local repo="$1"
  local base_ref
  local gh_bin

  gh_bin="$(resolve_external_command gh || true)"
  if [[ -z "$gh_bin" ]]; then
    return 0
  fi

  base_ref="$(cd "$repo" && "$gh_bin" pr view --json baseRefName --jq .baseRefName 2>/dev/null || true)"
  if [[ -n "$base_ref" ]]; then
    printf 'origin/%s\n' "$base_ref"
  fi
}

branch_base_ref() {
  local repo="$1"
  shift
  local base_ref
  base_ref="$(arg_value --base "" "$@")"
  if [[ -z "$base_ref" ]]; then
    base_ref="$(detect_pr_base "$repo")"
  fi
  printf '%s\n' "${base_ref:-origin/main}"
}

git_output() {
  local repo="$1"
  shift
  "$git_bin" -c core.fsmonitor=false -c diff.renames=false -C "$repo" "$@"
}

worktree_dirty() {
  local repo="$1"
  [[ -n "$(git_output "$repo" status --porcelain)" ]]
}

source_snapshot() {
  local repo="$1"
  local snapshot
  if ! snapshot="$(cd "$repo" && "$helper" --source-snapshot-only)"; then
    echo "agent:autoreview: AUTOREVIEW_HELPER must implement --source-snapshot-only for prepared bundles" >&2
    return 1
  fi
  if [[ ! "$snapshot" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "agent:autoreview: AUTOREVIEW_HELPER --source-snapshot-only must print exactly one SHA-256 fingerprint" >&2
    return 1
  fi
  printf '%s\n' "$snapshot"
}

max_review_capture_bytes=$((512000 * 8))
review_capture_bytes=0

capture_output_file() {
  local output="$1"
  local label="$2"
  local allowed_status="$3"
  shift 3
  local remaining=$((max_review_capture_bytes - review_capture_bytes))
  local command_status
  local limiter_status
  local size
  local pipeline_status=()

  if ((remaining <= 0)); then
    echo "agent:autoreview: review input exceeds the ${max_review_capture_bytes}-byte capture budget while capturing $label" >&2
    return 1
  fi

  set +e
  "$@" | head -c "$((remaining + 1))" >"$output"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  command_status="${pipeline_status[0]:-1}"
  limiter_status="${pipeline_status[1]:-1}"
  size="$(wc -c <"$output")"
  size="${size//[[:space:]]/}"

  if ((size > remaining)); then
    echo "agent:autoreview: review input exceeds the ${max_review_capture_bytes}-byte capture budget while capturing $label" >&2
    return 1
  fi
  if [[ "$command_status" -ne 0 && "$command_status" -ne "$allowed_status" ]]; then
    echo "agent:autoreview: failed to capture $label (exit $command_status)" >&2
    return "$command_status"
  fi
  if [[ "$limiter_status" -ne 0 ]]; then
    echo "agent:autoreview: failed to bound $label (exit $limiter_status)" >&2
    return "$limiter_status"
  fi

  review_capture_bytes=$((review_capture_bytes + size))
}

capture_append_output() {
  local output="$1"
  local label="$2"
  local allowed_status="$3"
  shift 3
  local chunk
  chunk="$(mktemp "${output}.chunk.XXXXXX")"
  if ! capture_output_file "$chunk" "$label" "$allowed_status" "$@"; then
    rm -f "$chunk"
    return 1
  fi
  cat "$chunk" >>"$output"
  rm -f "$chunk"
}

emit_local_changed_paths() {
  local repo="$1"
  {
    git_output "$repo" diff --name-only --cached
    git_output "$repo" diff --name-only
    git_output "$repo" ls-files --others --exclude-standard
  } | sort -u
}

emit_branch_local_changed_paths() {
  local repo="$1"
  local target_ref="$2"
  {
    git_output "$repo" diff --name-only "$target_ref...HEAD"
    git_output "$repo" diff --name-only --cached
    git_output "$repo" diff --name-only
    git_output "$repo" ls-files --others --exclude-standard
  } | sort -u
}

emit_branch_changed_paths() {
  local repo="$1"
  local target_ref="$2"
  git_output "$repo" diff --name-only "$target_ref...HEAD" | sort -u
}

emit_commit_changed_paths() {
  local repo="$1"
  local target_ref="$2"
  git_output "$repo" show --name-only --format= "$target_ref" |
    sed '/^$/d' |
    sort -u
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
  review_capture_bytes=0

  local repo
  repo="$(git_output "$(pwd -P)" rev-parse --show-toplevel)"
  local repo_abs
  local bundle_parent
  local bundle_name
  local bundle_suffix
  local bundle_ancestor
  repo_abs="$(cd "$repo" && pwd -P)"
  case "$bundle_dir" in
    /*) ;;
    *) bundle_dir="$(pwd -P)/$bundle_dir" ;;
  esac
  bundle_parent="$(dirname "$bundle_dir")"
  bundle_name="$(basename "$bundle_dir")"
  bundle_suffix="$bundle_name"
  bundle_ancestor="$bundle_parent"
  while [[ ! -e "$bundle_ancestor" ]]; do
    bundle_suffix="$(basename "$bundle_ancestor")/$bundle_suffix"
    bundle_ancestor="$(dirname "$bundle_ancestor")"
  done
  if [[ ! -d "$bundle_ancestor" ]]; then
    echo "agent:autoreview: --prepare-bundle-dir parent is not a directory" >&2
    exit 2
  fi
  bundle_parent="$(cd "$bundle_ancestor" && pwd -P)"
  bundle_dir="$bundle_parent/$bundle_suffix"
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
  if has_bundle_output "$@"; then
    echo "agent:autoreview: --bundle-output cannot be combined with --prepare-bundle-dir; use the prompt inside the prepared bundle" >&2
    exit 2
  fi
  if [[ -e "$bundle_dir" && ! -d "$bundle_dir" ]]; then
    echo "agent:autoreview: --prepare-bundle-dir must be a directory path" >&2
    exit 2
  fi
  if [[ -d "$bundle_dir" ]]; then
    rmdir "$bundle_dir"
  fi
  mkdir -p "$(dirname "$bundle_dir")"
  prepare_staging_dir="$(mktemp -d "$(dirname "$bundle_dir")/.agent-autoreview-context.XXXXXX")"
  local staging_dir="$prepare_staging_dir"
  mkdir -p "$staging_dir/checklists"
  mkdir -p "$staging_dir/patches"

  local mode
  local target_mode
  local target_ref=""
  local target_display_ref=""
  local source_snapshot_before
  local source_snapshot_after
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
      target_ref="$(branch_base_ref "$repo" "$@")"
      ;;
    auto)
      if [[ -n "$branch" && "$branch" != "main" ]]; then
        target_ref="$(branch_base_ref "$repo" "$@")"
        if worktree_dirty "$repo"; then
          target_mode="branch-local"
        else
          target_mode="branch"
        fi
      elif worktree_dirty "$repo"; then
        target_mode="local"
      else
        echo "agent:autoreview: no review target: clean main checkout and no forced mode" >&2
        exit 2
      fi
      ;;
    *)
      echo "agent:autoreview: unsupported --mode for bundle prep: $mode" >&2
      exit 2
      ;;
  esac

  if [[ -n "$target_ref" ]]; then
    target_display_ref="$target_ref"
    if ! target_ref="$(git_output "$repo" rev-parse --verify --end-of-options "${target_ref}^{commit}")"; then
      echo "agent:autoreview: review ref does not resolve to a commit: $target_display_ref" >&2
      exit 2
    fi
    if [[ ! "$target_ref" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
      echo "agent:autoreview: review ref did not resolve to an object ID: $target_display_ref" >&2
      exit 2
    fi
  fi
  source_snapshot_before="$(source_snapshot "$repo")"

  case "$target_mode" in
    local)
      capture_output_file "$staging_dir/git-status.txt" "git status" 0 \
        git_output "$repo" status --short
      capture_output_file "$staging_dir/changed-paths.txt" "changed paths" 0 \
        emit_local_changed_paths "$repo"
      capture_output_file "$staging_dir/patches/staged.stat" "staged diff stat" 0 \
        git_output "$repo" diff --cached --stat --no-ext-diff --no-textconv
      capture_output_file "$staging_dir/patches/staged.diff" "staged diff" 0 \
        git_output "$repo" diff --cached --patch --no-renames --no-ext-diff --no-textconv
      capture_output_file "$staging_dir/patches/unstaged.stat" "unstaged diff stat" 0 \
        git_output "$repo" diff --stat --no-ext-diff --no-textconv
      capture_output_file "$staging_dir/patches/unstaged.diff" "unstaged diff" 0 \
        git_output "$repo" diff --patch --no-renames --no-ext-diff --no-textconv
      capture_output_file "$staging_dir/patches/untracked-paths.txt" "untracked paths" 0 \
        git_output "$repo" ls-files --others --exclude-standard
      : >"$staging_dir/patches/untracked.diff"
      while IFS= read -r untracked_path; do
        [[ -z "$untracked_path" ]] && continue
        if [[ -f "$repo/$untracked_path" ]]; then
          capture_append_output "$staging_dir/patches/untracked.diff" "untracked file $untracked_path" 1 \
            git_output "$repo" diff --no-index --no-ext-diff --no-textconv -- /dev/null "$untracked_path"
        else
          capture_append_output "$staging_dir/patches/untracked.diff" "untracked non-file $untracked_path" 0 \
            printf 'untracked non-file omitted: %s\n' "$untracked_path"
        fi
      done < "$staging_dir/patches/untracked-paths.txt"
      ;;
    branch)
      capture_output_file "$staging_dir/changed-paths.txt" "changed paths" 0 \
        emit_branch_changed_paths "$repo" "$target_ref"
      capture_output_file "$staging_dir/patches/branch.stat" "branch diff stat" 0 \
        git_output "$repo" diff --stat --no-ext-diff --no-textconv "$target_ref...HEAD"
      capture_output_file "$staging_dir/patches/branch.diff" "branch diff" 0 \
        git_output "$repo" diff --patch --no-renames --no-ext-diff --no-textconv "$target_ref...HEAD"
      ;;
    branch-local)
      capture_output_file "$staging_dir/git-status.txt" "git status" 0 \
        git_output "$repo" status --short
      capture_output_file "$staging_dir/changed-paths.txt" "changed paths" 0 \
        emit_branch_local_changed_paths "$repo" "$target_ref"
      capture_output_file "$staging_dir/patches/branch.stat" "branch diff stat" 0 \
        git_output "$repo" diff --stat --no-ext-diff --no-textconv "$target_ref...HEAD"
      capture_output_file "$staging_dir/patches/branch.diff" "branch diff" 0 \
        git_output "$repo" diff --patch --no-renames --no-ext-diff --no-textconv "$target_ref...HEAD"
      capture_output_file "$staging_dir/patches/staged.stat" "staged diff stat" 0 \
        git_output "$repo" diff --cached --stat --no-ext-diff --no-textconv
      capture_output_file "$staging_dir/patches/staged.diff" "staged diff" 0 \
        git_output "$repo" diff --cached --patch --no-renames --no-ext-diff --no-textconv
      capture_output_file "$staging_dir/patches/unstaged.stat" "unstaged diff stat" 0 \
        git_output "$repo" diff --stat --no-ext-diff --no-textconv
      capture_output_file "$staging_dir/patches/unstaged.diff" "unstaged diff" 0 \
        git_output "$repo" diff --patch --no-renames --no-ext-diff --no-textconv
      capture_output_file "$staging_dir/patches/untracked-paths.txt" "untracked paths" 0 \
        git_output "$repo" ls-files --others --exclude-standard
      : >"$staging_dir/patches/untracked.diff"
      while IFS= read -r untracked_path; do
        [[ -z "$untracked_path" ]] && continue
        if [[ -f "$repo/$untracked_path" ]]; then
          capture_append_output "$staging_dir/patches/untracked.diff" "untracked file $untracked_path" 1 \
            git_output "$repo" diff --no-index --no-ext-diff --no-textconv -- /dev/null "$untracked_path"
        else
          capture_append_output "$staging_dir/patches/untracked.diff" "untracked non-file $untracked_path" 0 \
            printf 'untracked non-file omitted: %s\n' "$untracked_path"
        fi
      done < "$staging_dir/patches/untracked-paths.txt"
      ;;
    commit)
      capture_output_file "$staging_dir/changed-paths.txt" "changed paths" 0 \
        emit_commit_changed_paths "$repo" "$target_ref"
      capture_output_file "$staging_dir/patches/commit.stat" "commit diff stat" 0 \
        git_output "$repo" show --stat --no-ext-diff --no-textconv --format=fuller "$target_ref"
      capture_output_file "$staging_dir/patches/commit.diff" "commit diff" 0 \
        git_output "$repo" show --patch --no-renames --no-ext-diff --no-textconv --format=fuller "$target_ref"
      ;;
  esac

  local selected_checklists=()
  local checklist
  while IFS= read -r checklist; do
    [[ -z "$checklist" ]] && continue
    selected_checklists+=("$checklist")
  done < <(select_checklists "$repo" "$staging_dir/changed-paths.txt")
  local helper_args=("$@")
  case "$target_mode" in
    branch | branch-local)
      helper_args+=(--base "$target_ref")
      ;;
    commit)
      helper_args+=(--commit "$target_ref")
      ;;
  esac
  for checklist in "${selected_checklists[@]}"; do
    capture_output_file "$staging_dir/checklists/$(basename "$checklist")" "checklist $checklist" 0 \
      cat "$repo/$checklist"
    helper_args+=(--prompt-file "$checklist")
  done
  printf '%s\n' "${selected_checklists[@]}" >"$staging_dir/selected-checklists.txt"

  if [[ "$pr_number" == "auto" ]]; then
    pr_number=""
    local gh_bin
    gh_bin="$(resolve_external_command gh || true)"
    if [[ -n "$gh_bin" ]]; then
      pr_number="$("$gh_bin" pr view --json number --jq .number 2>/dev/null || true)"
    fi
  fi

  if [[ -n "$pr_number" && "$pr_number" != "none" ]]; then
    capture_output_file "$staging_dir/feedback-state.json" "PR feedback state" 0 \
      pnpm --silent pr:feedback-state --pr "$pr_number" --json
    helper_args+=(
      --trusted-input-root "$staging_dir"
      --dataset "$staging_dir/feedback-state.json"
    )
  fi

  helper_args+=(
    --bundle-output "$staging_dir/autoreview-prompt.md"
    --bundle-output-display "$bundle_dir/autoreview-prompt.md"
  )
  if ! has_prepare_only "${helper_args[@]}"; then
    helper_args+=(--prepare-only)
  fi

  {
    printf '# Autoreview Context Bundle\n\n'
    printf -- '- Target: %s' "$target_mode"
    if [[ -n "$target_display_ref" ]]; then
      printf ' %s' "$target_display_ref"
    fi
    printf '\n'
    if [[ -n "$target_ref" ]]; then
      printf -- '- Frozen target commit: %s\n' "$target_ref"
    fi
    printf -- '- Branch: %s\n' "${branch:-detached}"
    printf -- '- Generated: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '## Contents\n\n'
    printf '%s\n' "- \`changed-paths.txt\`: changed files for the selected target."
    printf '%s\n' "- \`patches/\`: stat and patch files for read-only review."
    printf '%s\n' "- \`checklists/\`: repo-selected prompt/checklist context copied at generation time."
    printf '%s\n' "- \`selected-checklists.txt\`: source paths for the copied checklists."
    printf '%s\n' "- \`autoreview-prompt.md\`: full prompt emitted by the autoreview helper."
    printf '%s\n' "- \`helper-output.txt\`: helper metadata whose artifact paths identify this published bundle."
    if [[ -f "$staging_dir/feedback-state.json" ]]; then
      printf '%s\n' "- \`feedback-state.json\`: \`pr:feedback-state\` ledger for PR #$pr_number."
    fi
  } >"$staging_dir/README.md"

  (cd "$repo" && "$helper" "${helper_args[@]}") >"$staging_dir/helper-output.txt"
  source_snapshot_after="$(source_snapshot "$repo")"
  if [[ "$source_snapshot_after" != "$source_snapshot_before" ]]; then
    echo "agent:autoreview: source changed while the prepared bundle was being created; rerun autoreview" >&2
    exit 1
  fi
  if [[ -e "$bundle_dir" ]]; then
    echo "agent:autoreview: --prepare-bundle-dir appeared while the bundle was being prepared" >&2
    exit 1
  fi
  mv "$staging_dir" "$bundle_dir"
  prepare_staging_dir=""
  cat "$bundle_dir/helper-output.txt"
  printf 'agent:autoreview context bundle: %s\n' "$bundle_dir"
}

if [[ -n "$prepare_bundle_dir" ]]; then
  prepare_context_bundle "$prepare_bundle_dir" "$feedback_pr" "$@"
  exit 0
fi

if [[ "$helper" == "$default_helper" ]]; then
  direct_mode="$(arg_value --mode auto "$@")"
  direct_base="$(arg_value --base "" "$@")"
  if [[ -z "$direct_base" && "$direct_mode" != "local" && "$direct_mode" != "commit" ]]; then
    direct_branch="$(git_output "$repo_root" branch --show-current || true)"
    if [[ "$direct_mode" == "branch" || ( -n "$direct_branch" && "$direct_branch" != "main" ) ]]; then
      direct_base="$(branch_base_ref "$repo_root" "$@")"
      set -- "$@" --base "$direct_base"
    fi
  fi
fi

if running_inside_codex_sandbox && ! has_explicit_engine "$@" && ! has_prepare_only "$@"; then
  cat >&2 <<EOF
agent:autoreview: detected Codex sandbox; defaulting to --engine local because nested codex exec is unavailable here.
agent:autoreview: pass --engine codex, --engine claude, or AUTOREVIEW_ENGINE to override.
EOF
  set -- --engine local "$@"
fi

exec "$helper" "$@"
