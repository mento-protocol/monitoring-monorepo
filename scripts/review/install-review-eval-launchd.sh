#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 1
}

repo_checkout="$(pwd -P)"
template="$repo_checkout/scripts/review/launchd/org.mento.review-eval.plist"
runner="$repo_checkout/scripts/review/run-eval.sh"
target_dir="$HOME/Library/LaunchAgents"
target="$target_dir/org.mento.review-eval.plist"
runtime_path="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
node_path=""
git_path=""

[[ -f $template && ! -L $template ]] ||
  fail "$template must be a regular, non-symlink plist template"
[[ -f $runner && -r $runner && ! -L $runner ]] ||
  fail "$runner must be a readable, regular, non-symlink script"

for command_name in node git codex claude; do
  if ! command_path="$(PATH="$runtime_path" command -v "$command_name")"; then
    fail "$command_name is not on PATH"
  fi
  [[ $command_path == /* ]] ||
    fail "$command_name must resolve to an absolute path"
  case "$command_name" in
    node) node_path="$command_path" ;;
    git) git_path="$command_path" ;;
  esac
done

checkout_root="$("$git_path" -C "$repo_checkout" rev-parse --show-toplevel 2>/dev/null)" ||
  fail "$repo_checkout is not a Git checkout"
checkout_root="$(cd "$checkout_root" && pwd -P)"
[[ $checkout_root == "$repo_checkout" ]] ||
  fail "run this installer from the checkout root: $checkout_root"
lock_root="$("$git_path" -C "$repo_checkout" rev-parse --absolute-git-dir 2>/dev/null)" ||
  fail "$repo_checkout has no Git directory for the review-eval run lock"

launchctl_path=/bin/launchctl
plutil_path=/usr/bin/plutil

rendered=""
previous=""
run_lock=""
lock_owner=""
install_lock=""
install_lock_owner=""
had_target=0
target_replaced=0
rollback_attempted=0
critical_transaction=0
pending_signal=0

rename_exact() {
  "$node_path" -e \
    'require("node:fs").renameSync(process.argv[1], process.argv[2])' \
    "$1" "$2"
}

release_owned_locks() {
  if [[ -n $install_lock_owner ]]; then
    if [[ -n $install_lock && -e $install_lock && $install_lock_owner -ef $install_lock ]]; then
      /bin/rm -f "$install_lock"
    fi
    /bin/rm -f "$install_lock_owner"
  fi
  if [[ -n $lock_owner ]]; then
    if [[ -n $run_lock && -e $run_lock && $lock_owner -ef $run_lock ]]; then
      /bin/rm -f "$run_lock"
    fi
    /bin/rm -f "$lock_owner"
  fi
  install_lock_owner=""
  install_lock=""
  lock_owner=""
  run_lock=""
}

rollback_target() {
  rollback_attempted=1
  if [[ $had_target -eq 1 ]]; then
    if rename_exact "$previous" "$target"; then
      previous=""
      target_replaced=0
      return 0
    fi
    recovery_copy="$previous"
    previous=""
    printf '%s\n' \
      "the new scheduler plist could not be rolled back; recovery copy: $recovery_copy" \
      >&2
    return 1
  fi
  if /bin/rm -f "$target"; then
    target_replaced=0
    return 0
  fi
  printf '%s\n' \
    "the new scheduler could not load and its plist could not be removed: $target" \
    >&2
  return 1
}

cleanup() {
  local status=$?
  set +e
  trap '' HUP INT TERM
  critical_transaction=1
  if [[ $target_replaced -eq 1 && $rollback_attempted -eq 0 ]]; then
    rollback_target
  fi
  [[ -z $rendered ]] || /bin/rm -f "$rendered"
  [[ -z $previous ]] || /bin/rm -f "$previous"
  release_owned_locks
  return "$status"
}

record_signal() {
  pending_signal="$1"
  if [[ $critical_transaction -eq 0 ]]; then
    exit "$pending_signal"
  fi
}

trap cleanup EXIT
trap 'record_signal 129' HUP
trap 'record_signal 130' INT
trap 'record_signal 143' TERM

lock_owner="$(/usr/bin/mktemp "$lock_root/.run.lock.owner.XXXXXX")" ||
  fail "could not prepare the scheduler install lock under $lock_root"
printf '%s\n' "$$" >"$lock_owner"
run_lock="$lock_root/run.lock"
if ! "$node_path" -e \
  'require("node:fs").linkSync(process.argv[1], process.argv[2])' \
  "$lock_owner" "$run_lock" 2>/dev/null; then
  /bin/rm -f "$lock_owner"
  lock_owner=""
  run_lock=""
  fail "the review-eval run lock already exists; wait for its owner and retry"
fi

/bin/mkdir -p "$target_dir"
install_lock_owner="$(/usr/bin/mktemp "$target_dir/.org.mento.review-eval.install.owner.XXXXXX")" ||
  fail "could not prepare the scheduler transaction lock under $target_dir"
printf '%s\n' "$$" >"$install_lock_owner"
install_lock="$target_dir/.org.mento.review-eval.install.lock"
if ! "$node_path" -e \
  'require("node:fs").linkSync(process.argv[1], process.argv[2])' \
  "$install_lock_owner" "$install_lock" 2>/dev/null; then
  /bin/rm -f "$install_lock_owner"
  install_lock_owner=""
  install_lock=""
  fail "another review-eval scheduler install holds the target transaction lock"
fi

"$git_path" -C "$repo_checkout" fetch --quiet origin main ||
  fail "could not fetch origin/main"
head_sha="$("$git_path" -C "$repo_checkout" rev-parse HEAD 2>/dev/null)" ||
  fail "could not resolve the checkout HEAD"
main_sha="$("$git_path" -C "$repo_checkout" rev-parse origin/main 2>/dev/null)" ||
  fail "could not resolve origin/main after fetch"
[[ $head_sha == "$main_sha" ]] ||
  fail "the scheduler checkout is not at the fetched origin/main; fast-forward it and retry"
checkout_status="$("$git_path" -C "$repo_checkout" status --porcelain=v1 --untracked-files=normal)" ||
  fail "could not inspect the scheduler checkout"
[[ -z $checkout_status ]] ||
  fail "the scheduler checkout has uncommitted or untracked files"

require_unloaded() {
  local output="" status=0
  if output="$($launchctl_path print "gui/$(/usr/bin/id -u)/org.mento.review-eval" 2>&1)"; then
    fail "the review-eval scheduler is loaded; confirm that no evaluation is running, boot it out separately, and retry"
  else
    status=$?
  fi
  [[ $status -eq 113 ]] ||
    fail "could not confirm that the review-eval scheduler is unloaded: $output"
}

# Check before creating install files. Check again after validation because an
# operator can load the label while this installer prepares the replacement.
require_unloaded

/bin/mkdir -p "$HOME/Library/Logs"
rendered="$(/usr/bin/mktemp "$target_dir/.org.mento.review-eval.plist.XXXXXX")"
/bin/cp "$template" "$rendered"
"$plutil_path" -remove ProgramArguments.5 "$rendered"
"$plutil_path" -insert ProgramArguments.5 -string "$runtime_path" "$rendered"
"$plutil_path" -remove ProgramArguments.6 "$rendered"
"$plutil_path" -insert ProgramArguments.6 -string "$runner" "$rendered"
"$plutil_path" -replace EnvironmentVariables.PATH -string "$runtime_path" "$rendered"
"$plutil_path" -replace StandardOutPath \
  -string "$HOME/Library/Logs/mento-review-eval.log" "$rendered"
"$plutil_path" -replace StandardErrorPath \
  -string "$HOME/Library/Logs/mento-review-eval.log" "$rendered"
"$plutil_path" -lint "$rendered"
rendered_path="$("$plutil_path" -extract ProgramArguments.5 raw -o - "$rendered")" ||
  fail "could not verify the rendered runtime PATH argument"
[[ $rendered_path == "$runtime_path" ]] ||
  fail "the rendered runtime PATH argument is incorrect"
rendered_runner="$("$plutil_path" -extract ProgramArguments.6 raw -o - "$rendered")" ||
  fail "could not verify the rendered review-eval runner"
[[ $rendered_runner == "$runner" ]] ||
  fail "the rendered review-eval runner is incorrect"
rendered_environment_path="$("$plutil_path" -extract EnvironmentVariables.PATH raw -o - "$rendered")" ||
  fail "could not verify the rendered environment PATH"
[[ $rendered_environment_path == "$runtime_path" ]] ||
  fail "the rendered environment PATH is incorrect"

if [[ -e $target || -L $target ]]; then
  [[ -f $target && ! -L $target ]] ||
    fail "$target must be a regular, non-symlink plist"
  previous="$(/usr/bin/mktemp "$target_dir/.org.mento.review-eval.previous.XXXXXX")"
  /bin/cp "$target" "$previous"
  "$plutil_path" -lint "$previous"
  prior_label="$("$plutil_path" -extract Label raw -o - "$previous")" ||
    fail "could not read the prior scheduler label from $target"
  [[ $prior_label == org.mento.review-eval ]] ||
    fail "$target does not contain the expected org.mento.review-eval label"
  had_target=1
fi

require_unloaded
critical_transaction=1
target_replaced=1
if ! rename_exact "$rendered" "$target"; then
  rollback_target || true
  critical_transaction=0
  [[ $pending_signal -eq 0 ]] || exit "$pending_signal"
  fail "could not replace the prior review-eval plist"
fi
rendered=""
if [[ $pending_signal -ne 0 ]]; then
  rollback_target || true
  critical_transaction=0
  exit "$pending_signal"
fi

domain="gui/$(/usr/bin/id -u)"
if ! "$launchctl_path" bootstrap "$domain" "$target"; then
  if rollback_target; then
    if [[ $had_target -eq 1 ]]; then
      printf '%s\n' \
        "the new scheduler could not load; the prior plist was restored" >&2
    else
      printf '%s\n' \
        "the new scheduler could not load; the new plist was removed" >&2
    fi
  fi
  critical_transaction=0
  [[ $pending_signal -eq 0 ]] || exit "$pending_signal"
  exit 1
fi

target_replaced=0
if [[ -n $previous ]]; then
  /bin/rm -f "$previous"
  previous=""
fi
critical_transaction=0
[[ $pending_signal -eq 0 ]] || exit "$pending_signal"
