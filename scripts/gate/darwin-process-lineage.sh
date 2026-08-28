# shellcheck shell=bash disable=SC2034,SC2154

# macOS has no public process namespace that a mapped command can enter. The
# libproc unique-ID census closes that gap in the safe direction. It terminates
# only a process whose kernel identity and lineage are exact. A broken lineage
# is never signalled and keeps the scheduler obligation fail-closed.

gate_darwin_lineage_state_file=""
gate_darwin_lineage_active=0
gate_darwin_exact_identity=""
gate_darwin_controller_exact_identity=""
gate_darwin_lineage_host_platform=""
gate_darwin_node_bin=""
gate_darwin_watcher_action_file=""
gate_darwin_watcher_armed_file=""
gate_darwin_watcher_output_file=""
gate_darwin_watcher_stderr_file=""

gate_darwin_lineage_module() {
  printf '%s/gate/darwin-process-lineage.mjs\n' "$script_source_dir"
}

gate_darwin_lineage_root() {
  local user_id root
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active && [[ -n "${gate_coordinator_root:-}" ]]; then
    root="${gate_coordinator_root}/lineage-v1"
  else
    user_id="$(id -u)" || return 2
    [[ "$user_id" =~ ^[0-9]+$ && -n "$gate_lock_root_dir" ]] || return 2
    root="${gate_lock_root_dir}/lineage-v1-u${user_id}"
  fi
  if [[ -L "$root" ]]; then
    echo "error: Darwin lineage root is a symbolic link: ${root}" >&2
    return 2
  fi
  if [[ ! -d "$root" ]]; then
    (umask 077 && mkdir "$root") || {
      [[ ! -L "$root" && -d "$root" ]] || return 2
    }
  fi
  [[ ! -L "$root" && -d "$root" && -O "$root" ]] || return 2
  chmod 700 "$root" || return 2
  printf '%s\n' "$root"
}

gate_darwin_lineage_state_path() {
  local token="$1"
  local root
  gate_lock_token_is_wellformed "$token" || return 2
  root="$(gate_darwin_lineage_root)" || return 2
  printf '%s/lineage.%s.json\n' "$root" "$token"
}

gate_darwin_lineage_classify_host() {
  local detected
  if [[ -n "$gate_darwin_lineage_host_platform" ]]; then
    case "$gate_darwin_lineage_host_platform" in
      Darwin|Linux) return 0 ;;
      *)
        echo "error: cached host kernel classification is invalid." >&2
        return 2
        ;;
    esac
  fi
  detected="$(/usr/bin/uname -s 2>/dev/null)" || {
    echo "error: could not classify the host kernel safely." >&2
    return 2
  }
  case "$detected" in
    Darwin|Linux) ;;
    *)
      echo "error: unsupported host kernel for process cleanup: ${detected:-missing}." >&2
      return 2
      ;;
  esac
  gate_darwin_lineage_host_platform="$detected"
}

gate_darwin_lineage_host_is_darwin() {
  gate_darwin_lineage_classify_host || return 2
  [[ "$gate_darwin_lineage_host_platform" == Darwin ]]
}

gate_darwin_node_runtime_prepare() {
  local resolved
  if [[ -n "$gate_darwin_node_bin" ]]; then
    [[ "$gate_darwin_node_bin" == /* &&
      -f "$gate_darwin_node_bin" && ! -L "$gate_darwin_node_bin" &&
      -x "$gate_darwin_node_bin" ]] || return 2
    return 0
  fi
  resolved="$(node -p 'process.execPath')" || return 2
  if [[ "$resolved" != /* || ! -f "$resolved" || -L "$resolved" ||
    ! -x "$resolved" ]]; then
    echo "error: Node did not resolve to an executable real runtime." >&2
    return 2
  fi
  gate_darwin_node_bin="$resolved"
}

gate_darwin_exact_identity_prepare() {
  local module prepared host_status
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0) ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  if [[ -L "$module" || ! -f "$module" || ! -r "$module" ]]; then
    echo "error: Darwin process-lineage helper is unavailable: ${module}" >&2
    return 2
  fi
  prepared="$(
    "$gate_darwin_node_bin" "$module" prepare-exact --scratch "$scratch_dir"
  )" || return 2
  if [[ "$prepared" != ready ]]; then
    echo "error: Darwin exact-identity authority returned malformed evidence." >&2
    return 2
  fi
}

gate_darwin_exact_parent_capture() {
  local expected_parent_pid="$1"
  local module output_file captured host_status
  gate_darwin_exact_identity=""
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0) ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
  [[ "$expected_parent_pid" =~ ^[1-9][0-9]*$ ]] || return 2
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  if [[ -L "$module" || ! -f "$module" || ! -r "$module" ]]; then
    echo "error: Darwin process-lineage helper is unavailable: ${module}" >&2
    return 2
  fi
  output_file="$(mktemp "$scratch_dir/exact-parent.XXXXXX")" || return 2
  chmod 600 "$output_file" || {
    rm -f "$output_file"
    return 2
  }
  # Keep the trusted Node probe as this shell's direct child. A command
  # substitution would insert another Bash process and bind the wrong parent.
  if ! "$gate_darwin_node_bin" "$module" capture-exact-parent \
    --scratch "$scratch_dir" --pid "$expected_parent_pid" >"$output_file" ||
    ! IFS= read -r captured <"$output_file"; then
    rm -f "$output_file"
    return 2
  fi
  rm -f "$output_file"
  case "$captured" in
    agentqg-darwin-exact-v1:pid1-*:*) ;;
    *)
      echo "error: Darwin exact parent capture returned malformed evidence." >&2
      return 2
      ;;
  esac
  gate_darwin_exact_identity="$captured"
}

gate_darwin_watcher_control_prepare() {
  local control_dir cancel_file cancel_staged_file settle_staged_file
  local armed_file armed_pending_file output_file stderr_file

  gate_darwin_watcher_action_file=""
  gate_darwin_watcher_armed_file=""
  gate_darwin_watcher_output_file=""
  gate_darwin_watcher_stderr_file=""
  control_dir="$(mktemp -d "$scratch_dir/deadline-recovery.XXXXXX")" ||
    return 2
  chmod 700 "$control_dir" || return 2
  cancel_file="$control_dir/action"
  cancel_staged_file="$control_dir/action.cancel.staged"
  settle_staged_file="$control_dir/action.settle.staged"
  armed_file="$control_dir/armed"
  armed_pending_file="$control_dir/armed.pending"
  output_file="$control_dir/result"
  stderr_file="$control_dir/stderr"
  gate_darwin_watcher_action_file="$cancel_file"
  gate_darwin_watcher_armed_file="$armed_file"
  gate_darwin_watcher_output_file="$output_file"
  gate_darwin_watcher_stderr_file="$stderr_file"
  printf 'cancel\n' >"$cancel_staged_file" || return 2
  printf 'settle\n' >"$settle_staged_file" || return 2
  : >"$armed_pending_file" || return 2
  : >"$output_file" || return 2
  : >"$stderr_file" || return 2
  chmod 0400 "$cancel_staged_file" "$settle_staged_file" || return 2
  chmod 0600 "$armed_pending_file" "$output_file" "$stderr_file" || return 2
}

gate_darwin_watcher_action_publish() {
  local action_file="$1"
  local action="$2"
  local control_dir="${action_file%/*}"
  local staged_file

  [[ "$action" == cancel || "$action" == settle ]] || return 2
  staged_file="$action_file.$action.staged"
  [[
    "$control_dir" == "$scratch_dir"/deadline-recovery.* &&
      "$action_file" == "$control_dir/action" &&
      -d "$control_dir" && ! -L "$control_dir" &&
      ! -e "$action_file" && ! -L "$action_file" &&
      -f "$staged_file" && ! -L "$staged_file"
  ]] || return 2
  ln "$staged_file" "$action_file" || return 2
  /usr/bin/perl -Mstrict -Mwarnings \
    -MFcntl=O_NOFOLLOW,O_NONBLOCK,O_RDONLY,S_ISDIR \
    -MIO::Handle -e '
      my ($directory) = @ARGV;
      sysopen(my $handle, $directory, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        or exit 1;
      my @before = stat($handle);
      my @path_before = lstat($directory);
      exit 1 unless @before && @path_before && S_ISDIR($before[2]) &&
        $before[0] == $path_before[0] && $before[1] == $path_before[1];
      $handle->sync() or exit 1;
      my @after = stat($handle);
      my @path_after = lstat($directory);
      close($handle) or exit 1;
      exit 1 unless @after && @path_after &&
        $before[0] == $after[0] && $before[1] == $after[1] &&
        $before[0] == $path_after[0] && $before[1] == $path_after[1];
    ' "$control_dir"
}

gate_darwin_watcher_armed_status() {
  local armed_file="$1"
  local control_dir="${armed_file%/*}"

  [[
    "$control_dir" == "$scratch_dir"/deadline-recovery.* &&
      "$armed_file" == "$control_dir/armed"
  ]] || return 2
  /usr/bin/perl - "$scratch_dir" "$control_dir" "$armed_file" <<'PERL'
use strict;
use warnings;
use Errno qw(ENOENT);
use Fcntl qw(O_NOFOLLOW O_NONBLOCK O_RDONLY S_ISDIR S_ISREG);
use IO::Handle ();

my ($scratch, $directory, $armed) = @ARGV;
sub fail { die "unsafe Darwin watcher armed marker\n"; }
sub same_stat {
  my ($left, $right) = @_;
  for my $index (0, 1, 2, 3, 4, 5, 6, 7, 9, 10) {
    return 0 if $left->[$index] != $right->[$index];
  }
  return 1;
}
for my $path ($scratch, $directory) {
  my @stat = lstat($path);
  fail() unless @stat && S_ISDIR($stat[2]) && $stat[4] == $< &&
    ($stat[2] & 07777) == 0700;
}
fail() unless $directory =~ /^\Q$scratch\E\/deadline-recovery\.[^\/]+$/;
sub read_marker {
  my ($path, $mode, $links, $expected) = @_;
  sysopen(my $handle, $path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or fail();
  my @before = stat($handle);
  my @path_before = lstat($path);
  fail() unless @before && @path_before && S_ISREG($before[2]) &&
    $before[4] == $< && $before[3] == $links &&
    ($before[2] & 07777) == $mode && same_stat(\@before, \@path_before);
  my $bytes = "";
  while (length($bytes) <= 7) {
    my $chunk = "";
    my $read = sysread($handle, $chunk, 8 - length($bytes));
    fail() unless defined $read;
    last if $read == 0;
    $bytes .= $chunk;
  }
  my @after = stat($handle);
  my @path_after = lstat($path);
  close($handle) or fail();
  fail() unless same_stat(\@before, \@after) &&
    same_stat(\@before, \@path_after) && $bytes eq $expected;
  return \@after;
}
my $pending = "$armed.pending";
my $staged = "$armed.staged";
my @armed_stat;
for (my $attempt = 0; $attempt < 400; $attempt += 1) {
  @armed_stat = lstat($armed);
  last if @armed_stat;
  fail() unless $! == ENOENT;
  read_marker($pending, 0600, 1, "");
  select(undef, undef, undef, 0.025);
}
fail() unless @armed_stat;
my $pending_before = read_marker($pending, 0600, 1, "");
my $staged_before = read_marker($staged, 0400, 2, "armed\n");
my $armed_before = read_marker($armed, 0400, 2, "armed\n");
fail() unless same_stat($staged_before, $armed_before);
sysopen(my $directory_handle, $directory, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  or fail();
my @directory_before = stat($directory_handle);
my @directory_path_before = lstat($directory);
fail() unless @directory_before && @directory_path_before &&
  S_ISDIR($directory_before[2]) && $directory_before[4] == $< &&
  ($directory_before[2] & 07777) == 0700 &&
  same_stat(\@directory_before, \@directory_path_before);
$directory_handle->sync() or fail();
my @directory_after = stat($directory_handle);
my @directory_path_after = lstat($directory);
close($directory_handle) or fail();
fail() unless same_stat(\@directory_before, \@directory_after) &&
  same_stat(\@directory_before, \@directory_path_after);
my $pending_after = read_marker($pending, 0600, 1, "");
my $staged_after = read_marker($staged, 0400, 2, "armed\n");
my $armed_after = read_marker($armed, 0400, 2, "armed\n");
fail() unless same_stat($pending_before, $pending_after) &&
  same_stat($staged_before, $staged_after) &&
  same_stat($armed_before, $armed_after) &&
  same_stat($staged_after, $armed_after);
print "armed\n";
PERL
}

gate_darwin_watcher_wait_armed() {
  local exact_identity="$1"
  local armed_file="$2"
  local marker_status watcher_status
  marker_status="$(gate_darwin_watcher_armed_status "$armed_file")" || return 2
  [[ "$marker_status" == armed ]] || return 2
  watcher_status="$(gate_darwin_exact_identity_status "$exact_identity")" ||
    return 2
  [[ "$watcher_status" == live ]]
}

gate_darwin_watcher_control_cleanup() {
  local action_file="$1"
  local control_dir="${action_file%/*}"
  [[
    "$control_dir" == "$scratch_dir"/deadline-recovery.* &&
      "$action_file" == "$control_dir/action" &&
      -d "$control_dir" && ! -L "$control_dir"
  ]] || return 2
  rm -f \
    "$control_dir/action" \
    "$control_dir/action.cancel.staged" \
    "$control_dir/action.settle.staged" \
    "$control_dir/armed" \
    "$control_dir/armed.pending" \
    "$control_dir/armed.staged" \
    "$control_dir/result" \
    "$control_dir/stderr" || return 2
  rmdir "$control_dir"
}

gate_darwin_exact_child_capture() {
  local pid="$1"
  local parent_pid="$2"
  local module captured host_status
  gate_darwin_exact_identity=""
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0) ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 2
  [[ "$parent_pid" =~ ^[1-9][0-9]*$ ]] || return 2
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  if [[ -L "$module" || ! -f "$module" || ! -r "$module" ]]; then
    echo "error: Darwin process-lineage helper is unavailable: ${module}" >&2
    return 2
  fi
  captured="$(
    "$gate_darwin_node_bin" "$module" capture-exact-child \
      --scratch "$scratch_dir" --pid "$pid" --parent-pid "$parent_pid"
  )" || return 2
  case "$captured" in
    agentqg-darwin-exact-v1:pid1-*:*) ;;
    *)
      echo "error: Darwin exact child capture returned malformed evidence." >&2
      return 2
      ;;
  esac
  gate_darwin_exact_identity="$captured"
}

gate_darwin_exact_identity_signal() {
  local exact_identity="$1"
  local signal_name="$2"
  local module result host_status
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  [[ "$host_status" -eq 0 ]] || return 2
  [[ "$signal_name" == TERM || "$signal_name" == KILL ]] || return 2
  case "$exact_identity" in
    agentqg-darwin-exact-v1:pid1-*:*) ;;
    *) return 2 ;;
  esac
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  result="$(
    "$gate_darwin_node_bin" "$module" signal-exact \
      --scratch "$scratch_dir" --identity "$exact_identity" \
      --signal "$signal_name"
  )" || return 2
  [[ "$result" == signalled || "$result" == gone ]]
}

gate_darwin_exact_identity_status() {
  local exact_identity="$1"
  local module result host_status
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  [[ "$host_status" -eq 0 ]] || return 2
  case "$exact_identity" in
    agentqg-darwin-exact-v1:pid1-*:*) ;;
    *) return 2 ;;
  esac
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  result="$(
    "$gate_darwin_node_bin" "$module" status-exact \
      --scratch "$scratch_dir" --identity "$exact_identity"
  )" || return 2
  [[ "$result" == live || "$result" == zombie || "$result" == gone ]] ||
    return 2
  printf '%s\n' "$result"
}

gate_darwin_exact_identity_terminate() {
  local exact_identity="$1"
  local pid="$2"
  local attempt status
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 2
  gate_darwin_exact_identity_signal "$exact_identity" TERM || return 2
  for ((attempt = 0; attempt < 30; attempt++)); do
    status="$(gate_darwin_exact_identity_status "$exact_identity")" || return 2
    [[ "$status" == live ]] || return 0
    sleep 0.1
  done
  gate_darwin_exact_identity_signal "$exact_identity" KILL
}

gate_darwin_lineage_prepare() {
  local token="$1"
  local module state host_status
  gate_darwin_lineage_active=0
  gate_darwin_lineage_state_file=""
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0) ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  state="$(gate_darwin_lineage_state_path "$token")" || return 2
  if [[ -L "$module" || ! -f "$module" || ! -r "$module" ]]; then
    echo "error: Darwin process-lineage helper is unavailable: ${module}" >&2
    return 2
  fi
  if ! "$gate_darwin_node_bin" "$module" prepare \
    --state "$state" --scratch "$scratch_dir" --token "$token" >/dev/null; then
    echo "error: could not record the pre-command Darwin process baseline." >&2
    return 2
  fi
  gate_darwin_lineage_state_file="$state"
  gate_darwin_lineage_active=1
}

gate_darwin_lineage_resume_owner() {
  local token="$1"
  local module state host_status
  gate_darwin_lineage_active=0
  gate_darwin_lineage_state_file=""
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0) ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  state="$(gate_darwin_lineage_state_path "$token")" || return 2
  if [[ -L "$module" || ! -f "$module" || ! -r "$module" ]]; then
    echo "error: Darwin process-lineage helper is unavailable: ${module}" >&2
    return 2
  fi
  if ! "$gate_darwin_node_bin" "$module" resume-owner \
    --state "$state" --scratch "$scratch_dir" >/dev/null; then
    echo "error: the durable Darwin owner lineage cannot start another mapped command." >&2
    return 2
  fi
  gate_darwin_lineage_state_file="$state"
  gate_darwin_lineage_active=1
}

gate_darwin_lineage_refresh() {
  local module host_status
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0) ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
  [[ "$gate_darwin_lineage_active" -eq 1 &&
    -n "$gate_darwin_lineage_state_file" ]] || {
    echo "error: cannot refresh a missing Darwin process baseline." >&2
    return 2
  }
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  if [[ -L "$module" || ! -f "$module" || ! -r "$module" ]]; then
    echo "error: Darwin process-lineage helper is unavailable: ${module}" >&2
    return 2
  fi
  if ! "$gate_darwin_node_bin" "$module" refresh \
    --state "$gate_darwin_lineage_state_file" \
    --scratch "$scratch_dir" >/dev/null; then
    echo "error: could not refresh the granted command's Darwin process baseline." >&2
    return 2
  fi
}

gate_darwin_lineage_bind_root() {
  local pid="$1"
  local parent_pid="$2"
  local module
  [[ "$gate_darwin_lineage_active" -eq 1 ]] || return 0
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 2
  [[ "$parent_pid" =~ ^[1-9][0-9]*$ ]] || return 2
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  if [[ -L "$module" || ! -f "$module" || ! -r "$module" ]]; then
    echo "error: Darwin process-lineage helper is unavailable: ${module}" >&2
    return 2
  fi
  "$gate_darwin_node_bin" "$module" bind \
    --state "$gate_darwin_lineage_state_file" \
    --scratch "$scratch_dir" --pid "$pid" \
    --parent-pid "$parent_pid" >/dev/null
}

gate_darwin_lineage_state_exists() {
  local state
  state="$(gate_darwin_lineage_state_path "$1")" || return 1
  [[ -e "$state" || -L "$state" ]]
}

gate_darwin_lineage_abandon_unstarted() {
  local token="$1"
  local module state host_status
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0) ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  state="$(gate_darwin_lineage_state_path "$token")" || return 2
  if [[ ! -e "$state" && ! -L "$state" ]]; then
    echo "error: required Darwin process-lineage state is missing: ${state}" >&2
    return 2
  fi
  if [[ -L "$module" || ! -f "$module" || ! -r "$module" ]]; then
    echo "error: Darwin process-lineage helper is unavailable: ${module}" >&2
    return 2
  fi
  if ! "$gate_darwin_node_bin" "$module" abandon-unstarted \
    --state "$state" >/dev/null; then
    echo "error: Darwin unstarted-lineage abandonment rejected non-empty evidence." >&2
    return 2
  fi
  if [[ "$state" == "$gate_darwin_lineage_state_file" ]]; then
    gate_darwin_lineage_state_file=""
    gate_darwin_lineage_active=0
  fi
}

gate_darwin_lineage_retire_owner() {
  local token="$1"
  local module state host_status
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0) ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  state="$(gate_darwin_lineage_state_path "$token")" || return 2
  if [[ ! -e "$state" && ! -L "$state" ]]; then
    echo "error: required Darwin owner-lineage state is missing: ${state}" >&2
    return 2
  fi
  if [[ -L "$module" || ! -f "$module" || ! -r "$module" ]]; then
    echo "error: Darwin process-lineage helper is unavailable: ${module}" >&2
    return 2
  fi
  if ! "$gate_darwin_node_bin" "$module" retire-owner \
    --state "$state" >/dev/null; then
    echo "error: the Darwin owner lineage is neither exact unbound state nor durable settlement." >&2
    return 2
  fi
  if [[ "$state" == "$gate_darwin_lineage_state_file" ]]; then
    gate_darwin_lineage_state_file=""
    gate_darwin_lineage_active=0
  fi
}

gate_darwin_lineage_settle() {
  local token="$1"
  local retain_state="${2:-0}"
  local module state host_status
  [[ "$retain_state" == 0 || "$retain_state" == 1 ]] || return 2
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0) ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  state="$(gate_darwin_lineage_state_path "$token")" || return 2
  if [[ ! -e "$state" && ! -L "$state" ]]; then
    echo "error: required Darwin process-lineage state is missing: ${state}" >&2
    return 2
  fi
  if [[ -L "$module" || ! -f "$module" || ! -r "$module" ]]; then
    echo "error: Darwin process-lineage helper is unavailable: ${module}" >&2
    return 2
  fi
  if ! "$gate_darwin_node_bin" "$module" settle \
    --state "$state" --scratch "$scratch_dir" \
    --timeout-seconds "$gate_lock_orphan_drain_bound_seconds" \
    --retain-state "$retain_state" >/dev/null; then
    echo "error: Darwin process-lineage recovery did not reach an empty exact identity set." >&2
    return 2
  fi
  if [[ "$retain_state" == 0 && "$state" == "$gate_darwin_lineage_state_file" ]]; then
    gate_darwin_lineage_state_file=""
    gate_darwin_lineage_active=0
  fi
}

gate_darwin_lineage_settle_cohort() {
  local retain_state="${1:-}"
  shift || return 2
  local module root token tokens_csv="" host_status
  [[ "$retain_state" == 0 || "$retain_state" == 1 ]] || return 2
  [[ "$#" -gt 0 ]] || return 2
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0) ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
  for token in "$@"; do
    gate_lock_token_is_wellformed "$token" || return 2
    case ",$tokens_csv," in
      *",$token,"*) return 2 ;;
    esac
    tokens_csv="${tokens_csv:+${tokens_csv},}${token}"
  done
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  root="$(gate_darwin_lineage_root)" || return 2
  if [[ -L "$module" || ! -f "$module" || ! -r "$module" ]]; then
    echo "error: Darwin process-lineage helper is unavailable: ${module}" >&2
    return 2
  fi
  if ! "$gate_darwin_node_bin" "$module" settle-cohort \
    --state-directory "$root" --tokens "$tokens_csv" \
    --scratch "$scratch_dir" \
    --timeout-seconds "$gate_lock_orphan_drain_bound_seconds" \
    --retain-state "$retain_state" >/dev/null; then
    echo "error: Darwin process-lineage cohort recovery did not reach empty exact identity sets." >&2
    return 2
  fi
}

gate_darwin_lineage_discard_settled() {
  local token="$1"
  local module state host_status
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0) ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
  gate_darwin_node_runtime_prepare || return 2
  module="$(gate_darwin_lineage_module)" || return 2
  state="$(gate_darwin_lineage_state_path "$token")" || return 2
  if [[ ! -e "$state" && ! -L "$state" ]]; then
    echo "error: discharged Darwin lineage state is missing: ${state}" >&2
    return 2
  fi
  if [[ -L "$module" || ! -f "$module" || ! -r "$module" ]]; then
    echo "error: Darwin process-lineage helper is unavailable: ${module}" >&2
    return 2
  fi
  if ! "$gate_darwin_node_bin" "$module" discard-settled \
    --state "$state" --scratch "$scratch_dir" >/dev/null; then
    echo "error: could not retire the discharged Darwin lineage state." >&2
    return 2
  fi
  if [[ "$state" == "$gate_darwin_lineage_state_file" ]]; then
    gate_darwin_lineage_state_file=""
    gate_darwin_lineage_active=0
  fi
}
