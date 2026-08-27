# shellcheck shell=bash
# The caller owns the shared lock state read by this source-only module.
# shellcheck disable=SC2154
# Source-only helpers for identifying a gate run and its surviving commands.
# The caller owns shell options and initializes the shared lock state before
# invoking these functions.

# Every process this run starts for a mapped command carries this string in its
# own argv. It is the run's lock token, so it is unique per run and per machine,
# and it exists exactly as long as the process does — nothing to register, no
# file to keep in step with, and no window where a child exists untracked. A run
# that holds no lock (--no-lock, or a nested run) still tags, with its PID, so
# the pattern never matches something it should not.
gate_run_command_tag() {
  printf 'agentqg:%s' "${gate_lock_token:-nolock-$$}"
}

gate_run_request_tag() {
  printf 'agentqg:%s' "${gate_run_id:-${gate_lock_token:-nolock-$$}}"
}

# A file every mapped command of this run holds open. Descendants inherit open
# descriptors and keep them after their parent exits, so this is a handle on a
# process that no longer has a tagged ancestor to be walked down from. Its path
# carries the expected run token. Descriptor-bound snapshots and private
# hard-link witnesses prevent a mutable shared path from selecting a stranger.
gate_run_marker_path() {
  local token="${1:-${gate_run_id:-$gate_lock_token}}"
  [[ -n "$gate_lock_root_dir" && -n "$token" ]] || return 1
  printf '%s/holder.%s' "$gate_lock_root_dir" "$token"
}

gate_run_marker_file=""
gate_run_created_marker_file=""

gate_run_marker_matches_identity() {
  local token="$1"
  local marker="$2"
  local expected
  gate_lock_token_is_wellformed "$token" || return 1
  expected="$(gate_run_marker_path "$token")" || return 1
  [[ "$marker" == "$expected" ]] || return 1
  gate_run_marker_snapshot_is_exact "$marker" "$token"
}

gate_run_marker_snapshot_is_exact() {
  local marker="$1"
  local expected_token_value="$2"
  gate_lock_token_is_wellformed "$expected_token_value" || return 1
  # The dollar expression below is a JavaScript template literal.
  # shellcheck disable=SC2016
  node -e '
    const fs = require("node:fs");
    const { constants } = fs;
    const [path, expectedToken, uidText] = process.argv.slice(1);
    const expectedUid = BigInt(uidText);
    const expectedBody = Buffer.from(`${expectedToken}\n`, "utf8");
    let descriptor;
    const sameInode = (left, right) =>
      left.dev === right.dev && left.ino === right.ino;
    const valid = (stat) =>
      stat.isFile() && !stat.isSymbolicLink() && stat.uid === expectedUid;
    try {
      descriptor = fs.openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const descriptorBefore = fs.fstatSync(descriptor, { bigint: true });
      const pathBefore = fs.lstatSync(path, { bigint: true });
      if (
        !valid(descriptorBefore) ||
        !valid(pathBefore) ||
        !sameInode(descriptorBefore, pathBefore)
      ) {
        throw new Error("unsafe marker snapshot");
      }
      const body = fs.readFileSync(descriptor);
      const descriptorAfter = fs.fstatSync(descriptor, { bigint: true });
      const pathAfter = fs.lstatSync(path, { bigint: true });
      if (
        !body.equals(expectedBody) ||
        !valid(descriptorAfter) ||
        !valid(pathAfter) ||
        !sameInode(descriptorBefore, descriptorAfter) ||
        !sameInode(descriptorAfter, pathAfter)
      ) {
        process.exitCode = 1;
      }
    } catch {
      process.exitCode = 1;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  ' "$marker" "$expected_token_value" "$(id -u)" 2>/dev/null
}

gate_run_create_marker_for_identity() {
  local token="$1"
  local work_verdict="${2:-No mapped command ran in this request}"
  local execution_state="${3:-Nothing has been executed.}"
  local report_no_work="${4:-1}"
  local marker
  gate_run_created_marker_file=""
  gate_lock_token_is_wellformed "$token" || return 2
  marker="$(gate_run_marker_path "$token")" || return 0
  # O_EXCL via noclobber. Refuse every occupied path, including symlinks.
  if ! (set -C && printf '%s\n' "$token" > "$marker") 2>/dev/null; then
    echo "error: could not create the run marker at ${marker} (it may already exist)." >&2
    echo "Without it, a command that outlives a killed gate cannot be found by the next run." >&2
    echo "${execution_state} Fix that path — permissions, free space, or a leftover file — then re-run." >&2
    if [[ "$report_no_work" -eq 1 ]]; then
      gate_report_coordinated_no_work_failure 2 "run-marker preparation" \
        "$work_verdict"
    fi
    return 2
  fi
  gate_run_created_marker_file="$marker"
}

gate_run_ensure_marker() {
  local work_verdict="${1:-No mapped command ran in this request}"
  local execution_state="${2:-Nothing has been executed.}"
  local token
  [[ -z "$gate_run_marker_file" ]] || return 0
  token="${gate_run_id:-$gate_lock_token}"
  [[ -n "$token" ]] || return 0
  # Fail closed, not best-effort. On a host without /proc this marker's
  # inherited descriptor is the only durable handle to a command that forks a
  # replacement and exits, so starting the command without it would quietly
  # forfeit the discovery the drain depends on. Same rule as the obligation
  # files: stop before the act, while stopping is still safe.
  # O_EXCL via noclobber, like the owner record: `>` would follow a symlink
  # another writer on a shared root pre-planted under this run's token and
  # truncate whatever it points at with this user's permissions. Exclusive
  # creation refuses an occupied path outright — symlinks, dangling ones
  # included, by kernel contract — and a token is unique to this run, so
  # anything already sitting at this name is not ours to replace.
  gate_run_create_marker_for_identity \
    "$token" "$work_verdict" "$execution_state" || exit $?
  gate_run_marker_file="$gate_run_created_marker_file"
}

# This barrier exists only for the lock-race fixture. It makes the otherwise
# tiny window after acquisition deterministic without changing an ordinary run:
# callers must opt in with both paths, and the ready file proves marker creation
# completed before the test replaces the owner record.
gate_lock_test_ready_and_wait_for_release() {
  local ready_file="$1"
  local release_file="$2"
  local started_at now
  local marker ready_body
  local wait_timeout_seconds=30

  if [[ -z "$ready_file" || -z "$release_file" ]]; then
    echo "error: AGENT_QUALITY_GATE_LOCK_TEST_READY_FILE and AGENT_QUALITY_GATE_LOCK_TEST_RELEASE_FILE must be set together." >&2
    echo "Nothing has been executed." >&2
    exit 2
  fi
  if [[ -e "$ready_file" || -L "$ready_file" ]]; then
    echo "error: test ready path ${ready_file} must be absent before the gate publishes it." >&2
    echo "Nothing has been executed." >&2
    exit 2
  fi
  if [[ -e "$release_file" || -L "$release_file" ]]; then
    echo "error: test release path ${release_file} must be absent before the gate waits for it." >&2
    echo "Nothing has been executed." >&2
    exit 2
  fi
  marker="$(gate_run_marker_path)" || {
    echo "error: could not resolve this run's marker before publishing the test ready file." >&2
    echo "Nothing has been executed." >&2
    exit 2
  }
  if [[ "$marker" != "$gate_run_marker_file" || -L "$marker" || ! -f "$marker" || ! -r "$marker" ]]; then
    echo "error: current run marker ${marker} is not a readable regular file before test synchronization." >&2
    echo "Nothing has been executed." >&2
    exit 2
  fi
  if [[ "$(cat "$marker")" != "$gate_lock_token" ]]; then
    echo "error: current run marker ${marker} does not contain this run's token before test synchronization." >&2
    echo "Nothing has been executed." >&2
    exit 2
  fi
  if ! (set -C && printf '%s\n' "$gate_lock_token" > "$ready_file") 2>/dev/null; then
    echo "error: could not publish the test ready file at ${ready_file}." >&2
    echo "Nothing has been executed." >&2
    exit 2
  fi
  if [[ -L "$ready_file" || ! -f "$ready_file" || ! -r "$ready_file" ]]; then
    echo "error: test ready path ${ready_file} is not a readable regular file." >&2
    echo "Nothing has been executed." >&2
    exit 2
  fi
  ready_body="$(cat "$ready_file")"
  if [[ "$ready_body" != "$gate_lock_token" ]]; then
    echo "error: test ready file ${ready_file} does not contain this run's token." >&2
    echo "Nothing has been executed." >&2
    exit 2
  fi

  started_at="$(date +%s)"
  while :; do
    if [[ -L "$release_file" ]]; then
      echo "error: test release path ${release_file} must be a regular file, not a symlink." >&2
      echo "Nothing has been executed." >&2
      exit 2
    fi
    if [[ -e "$release_file" ]]; then
      if [[ -f "$release_file" && -r "$release_file" ]]; then
        return 0
      fi
      echo "error: test release path ${release_file} is not a readable regular file." >&2
      echo "Nothing has been executed." >&2
      exit 2
    fi
    now="$(date +%s)"
    if [[ $((now - started_at)) -ge "$wait_timeout_seconds" ]]; then
      echo "error: timed out after ${wait_timeout_seconds}s waiting for test release file ${release_file}." >&2
      echo "Nothing has been executed." >&2
      exit 2
    fi
    sleep 1
  done
}

# Every process still carrying a run's handle. The argv tag names only the
# wrapper and dies with it, which is why two inherited handles back it up: the
# environment, readable on a host with /proc, and the open descriptor on the
# run's marker file, readable through Linux procfs or lsof. Both survive a command
# that forks a replacement and then exits — the replacement is reparented, has
# no tagged ancestor, and is invisible to a tree walk. The environment entry
# has the run's unique token. The marker scan binds and validates a private
# hard-link witness before lsof can select a process. The procfs scanner opens
# and validates the marker itself and holds that exact descriptor through its
# complete inode scan.
#
# The procfs path probes signal permission and also compares this process's real
# and effective UIDs with each target's real and saved-set UIDs. The signal
# probe includes `CAP_KILL`. The UID record keeps a policy-confined or set-ID
# descendant in scope when `kill -0` returns `EPERM`. `/proc/<pid>` ownership is
# not an authority because it follows the target's effective owner. The lsof
# fallback queries only the validated witnessed inode. Later PID/start checks
# still decide whether a process can receive a signal. Duplicates cost nothing:
# the capture records a PID once. Where neither inherited handle is readable
# the argv tag stands alone, which is the pre-existing behaviour.
# A token names processes (through a pgrep pattern) and files (holder.*,
# captured.*, condemned.d/*), and on a shared lock root it arrives from
# records other users can write. Only the gate-generated shape is accepted
# where one is read back: a bounded opaque prefix that starts with an
# alphanumeric character, then the final creator PID and epoch fields. The
# prefix can carry versioned Linux process-boundary evidence. No slash can pass,
# so no derived path can leave the lock root; no leading dash, so no value can
# read as an option.
gate_lock_token_is_wellformed() {
  local token="$1"
  # The full generated structure — bounded prefix, PID, and epoch — not merely
  # a path-safe string. A looser shape would let a crafted record carry a PREFIX
  # of a real token. Combined with an unanchored match, a prefix is enough to
  # select a live run's processes.
  [[ "$token" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,180}-[0-9]{1,10}-[0-9]{1,12}$ ]]
}

# ERE-escape a token for pgrep: validation keeps a token benign as a path,
# but token dots would still match any character as a pattern, and only
# escaping makes the match literal.
gate_lock_token_pattern() {
  printf '%s' "$1" | sed 's/[][\.*^$+?(){}|\\]/\\&/g'
}

gate_run_private_marker_directory_is_safe() {
  local directory="$1"
  node -e '
    const fs = require("node:fs");
    const stat = fs.lstatSync(process.argv[1]);
    const expectedUid = Number(process.argv[2]);
    process.exit(
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === expectedUid &&
      (stat.mode & 0o777) === 0o700
        ? 0
        : 1,
    );
  ' "$directory" "$(id -u)" 2>/dev/null
}

gate_run_drop_lsof_marker_witness() {
  local witness_dir="$1"
  local witness="$2"
  local extra
  gate_run_private_marker_directory_is_safe "$witness_dir" || return 1
  if ! extra="$(find "$witness_dir" -mindepth 1 -maxdepth 1 \
    ! -name marker -print -quit 2>/dev/null)" || [[ -n "$extra" ]]; then
    return 1
  fi
  [[ -e "$witness" || -L "$witness" ]] || return 1
  /bin/rm -f "$witness" && /bin/rmdir "$witness_dir"
}

gate_run_lsof_marker_pids() {
  local token="$1"
  local marker="$2"
  local target_pid="${3:-}"
  local witness_dir witness found status
  if [[ -n "$target_pid" && ! "$target_pid" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  if [[ ! "${gate_lock_local_host_fingerprint:-}" =~ ^[0-9a-f]{64}$ ]]; then
    if ! declare -F gate_lock_ensure_local_host_fingerprint >/dev/null 2>&1 ||
      ! gate_lock_ensure_local_host_fingerprint; then
      printf '%s\n' "$gate_drain_scan_error"
      return 0
    fi
  fi
  if ! witness_dir="$(mktemp -d \
    "${gate_lock_root_dir}/.holder-lsof-witness.v1.${gate_lock_local_host_fingerprint}.$$.XXXXXX")"; then
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  if ! chmod 700 "$witness_dir" ||
    ! gate_run_private_marker_directory_is_safe "$witness_dir"; then
    /bin/rmdir "$witness_dir" 2>/dev/null || true
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  witness="${witness_dir}/marker"
  if ! /bin/ln -P "$marker" "$witness" 2>/dev/null; then
    if [[ -e "$marker" || -L "$marker" ]]; then
      printf '%s\n' "$gate_drain_scan_error"
    fi
    /bin/rmdir "$witness_dir" 2>/dev/null ||
      printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  if ! gate_run_marker_snapshot_is_exact "$witness" "$token"; then
    gate_run_drop_lsof_marker_witness "$witness_dir" "$witness" || true
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  if [[ -n "$target_pid" ]]; then
    found="$(lsof -w -a -p "$target_pid" -t -- "$witness" 2>/dev/null)" &&
      status=0 || status=$?
  else
    found="$(lsof -w -t -- "$witness" 2>/dev/null)" && status=0 || status=$?
  fi
  [[ "$status" -le 1 ]] || printf '%s\n' "$gate_drain_scan_error"
  [[ -z "$found" ]] || printf '%s\n' "$found"
  if ! gate_run_private_marker_directory_is_safe "$witness_dir" ||
    ! gate_run_marker_snapshot_is_exact "$witness" "$token" ||
    ! gate_run_drop_lsof_marker_witness "$witness_dir" "$witness"; then
    printf '%s\n' "$gate_drain_scan_error"
  fi
}

gate_run_proc_marker_scan_available() {
  [[ -d /proc/self/fd ]]
}

gate_run_marker_identity_prefix() {
  local fallback_prefix="$1"
  local linux_label="$2"
  local origin_hash="$3"
  local creator_pid="$4"
  local linux_prefix
  if ! gate_run_proc_marker_scan_available; then
    printf '%s\n' "$fallback_prefix"
    return 0
  fi
  [[ "$linux_label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,22}$ &&
    "$origin_hash" =~ ^[0-9a-f]{64}$ &&
    "$creator_pid" =~ ^[1-9][0-9]*$ ]] || return 2
  # The outer gate process exists before it can create or pass the related
  # Bash-created marker to a descendant. Its Linux start tick therefore bounds
  # every cooperative marker holder. Equal ticks remain in scope.
  # shellcheck disable=SC2016 # the single-quoted program contains JavaScript templates
  if linux_prefix="$(node -e '
    const { createHash } = require("node:crypto");
    const fs = require("node:fs");
    const [label, originHash, creatorPid] = process.argv.slice(1);
    if (!/^[1-9][0-9]*$/u.test(creatorPid ?? "")) process.exit(2);
    const bootId = fs
      .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
      .trim()
      .toLowerCase();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        bootId,
      )
    ) {
      process.exit(2);
    }
    const value = fs.readFileSync(`/proc/${creatorPid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    if (close < 0) process.exit(2);
    const fields = value.slice(close + 1).trim().split(/\s+/u);
    const start = fields[19];
    if (!/^[0-9]{1,20}$/u.test(start ?? "")) process.exit(2);
    const bootHash = createHash("sha256").update(bootId, "utf8").digest("hex");
    const prefix = `lp1.${bootHash}.${start}.${originHash}.${label}`;
    if (prefix.length > 181) process.exit(2);
    process.stdout.write(`${prefix}\n`);
  ' "$linux_label" "$origin_hash" "$creator_pid" 2>/dev/null)" &&
    [[ -n "$linux_prefix" ]]; then
    printf '%s\n' "$linux_prefix"
  else
    printf '%s\n' "$fallback_prefix"
  fi
}

gate_run_capture_proc_start_floor() {
  # The helper process starts after coordinator registration and before mapped
  # work. Its Linux start tick is therefore a conservative lower bound for
  # processes that could inherit a later command marker. Equal ticks stay in
  # scope because procfs start times have finite resolution.
  # shellcheck disable=SC2016 # the single-quoted program contains JavaScript templates
  node -e '
    const fs = require("node:fs");
    const value = fs.readFileSync("/proc/self/stat", "utf8");
    const close = value.lastIndexOf(")");
    if (close < 0) process.exit(2);
    const fields = value.slice(close + 1).trim().split(/\s+/u);
    const start = fields[19];
    if (!/^[0-9]+$/u.test(start ?? "")) process.exit(2);
    process.stdout.write(`${start}\n`);
  ' 2>/dev/null
}

gate_run_proc_argv_scan_available() {
  [[ -r /proc/self/cmdline ]]
}

gate_run_proc_pid_has_argv_tag() {
  local pid="$1"
  local expected_tag="$2"
  local argument=""
  local matched=1
  [[ "$pid" =~ ^[1-9][0-9]*$ && -n "$expected_tag" ]] || return 1
  if [[ ! -r "/proc/${pid}/cmdline" ]]; then
    [[ -d "/proc/${pid}" ]] && return 2
    return 1
  fi
  if ! {
    while IFS= read -r -d '' argument || [[ -n "$argument" ]]; do
      if [[ "$argument" == "$expected_tag" ]]; then
        matched=0
        break
      fi
      argument=""
    done < "/proc/${pid}/cmdline"
  } 2>/dev/null; then
    [[ -d "/proc/${pid}" ]] && return 2
    return 1
  fi
  return "$matched"
}

gate_run_proc_marker_pids() {
  local token="$1"
  local marker="$2"
  local target_pid="${3:-}"
  local full_scan_start_floor="${4:-}"
  local found status
  if [[ -n "$target_pid" && ! "$target_pid" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  if [[ -n "$target_pid" && -n "$full_scan_start_floor" ]]; then
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  elif [[ -n "$full_scan_start_floor" &&
    ! "$full_scan_start_floor" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  # shellcheck disable=SC2016 # the single-quoted program contains JavaScript templates
  found="$(node -e '
    const { createHash } = require("node:crypto");
    const fs = require("node:fs");
    const { constants } = fs;
    const [markerPath, expectedToken, uidText, targetPid, startFloor] =
      process.argv.slice(1);
    const expectedUid = BigInt(uidText);
    const signalScopeUids = new Set([
      BigInt(process.getuid()),
      BigInt(process.geteuid()),
    ]);
    const expectedBody = Buffer.from(`${expectedToken}\n`, "utf8");
    const ignoredRaceCodes = new Set(["EBADF", "ENOENT", "ESRCH"]);
    const provenancePattern =
      /^lp1\.([0-9a-f]{64})\.([0-9]{1,20})\.[0-9a-f]{64}\.([A-Za-z0-9][A-Za-z0-9._-]{0,22})-[0-9]{1,10}-[0-9]{1,12}$/u;
    let markerDescriptor;

    const sameInode = (left, right) =>
      left.dev === right.dev && left.ino === right.ino;
    const validMarker = (stat) =>
      stat.isFile() && !stat.isSymbolicLink() && stat.uid === expectedUid;
    const markerBodyIsExact = (descriptor, stat) => {
      if (stat.size !== BigInt(expectedBody.length)) return false;
      const body = Buffer.alloc(expectedBody.length);
      const read = fs.readSync(
        descriptor,
        body,
        0,
        body.length,
        0,
      );
      return read === body.length && body.equals(expectedBody);
    };
    const processRuntimeIdentity = (pid) => {
      let value;
      try {
        value = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch (error) {
        if (ignoredRaceCodes.has(error?.code)) return null;
        throw error;
      }
      const close = value.lastIndexOf(")");
      if (close < 0) throw new Error("malformed proc process identity");
      const open = value.indexOf("(");
      if (open < 0 || open >= close) {
        throw new Error("malformed proc process command identity");
      }
      const fields = value.slice(close + 1).trim().split(/\s+/u);
      const start = fields[19];
      if (!/^[0-9]+$/u.test(start ?? "")) {
        throw new Error("malformed proc process start identity");
      }
      return { start, commandName: value.slice(open + 1, close) };
    };
    const processStart = (pid) => processRuntimeIdentity(pid)?.start ?? null;
    const processUids = (pid, directoryOwner) => {
      let value;
      try {
        value = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      } catch (error) {
        if (ignoredRaceCodes.has(error?.code)) return null;
        if (error?.code === "EACCES" || error?.code === "EPERM") {
          if (directoryOwner !== expectedUid) {
            try {
              process.kill(Number(pid), 0);
            } catch (probeError) {
              if (probeError?.code === "ESRCH") return null;
              if (probeError?.code === "EPERM") return [];
              throw probeError;
            }
          }
          // A status that is unreadable for a process this user can signal is
          // ambiguous. It can be a credential-changing descendant that still
          // carries the marker descriptor.
        }
        throw error;
      }
      const match = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/mu.exec(
        value,
      );
      if (!match) throw new Error("malformed proc process UID identity");
      return match.slice(1).map((uid) => BigInt(uid));
    };
    const assertCompleteProcEnumeration = () => {
      const mounts = fs
        .readFileSync("/proc/mounts", "utf8")
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/u))
        .filter(
          (fields) => fields[1] === "/proc" && fields[2] === "proc",
        );
      if (mounts.length !== 1) {
        throw new Error("cannot identify the procfs mount policy");
      }
      const hidepid = mounts[0][3]
        .split(",")
        .find((option) => option.startsWith("hidepid="));
      if (hidepid && hidepid !== "hidepid=0" && hidepid !== "hidepid=off") {
        throw new Error("procfs PID enumeration is restricted");
      }
    };
    const tokenProvenance = () => {
      if (targetPid !== "") return null;
      const match = provenancePattern.exec(expectedToken);
      if (!match) return null;
      let bootId;
      try {
        bootId = fs
          .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
          .trim()
          .toLowerCase();
      } catch {
        return null;
      }
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
          bootId,
        )
      ) {
        return null;
      }
      const bootHash = createHash("sha256")
        .update(bootId, "utf8")
        .digest("hex");
      return bootHash === match[1]
        ? { start: match[2], label: match[3] }
        : null;
    };
    const isCoordinatorGateParent = (pid, commandName) => {
      // Linux truncates an executable script name to TASK_COMM_LEN - 1.
      // An explicit `/bin/bash scripts/agent-quality-gate.sh` launch keeps
      // `bash` as comm, so validate one complete NUL-delimited argv element.
      if (commandName === "agent-quality-g") return true;
      if (commandName !== "bash") return false;
      let commandLine;
      try {
        commandLine = fs.readFileSync(`/proc/${pid}/cmdline`);
      } catch (error) {
        if (ignoredRaceCodes.has(error?.code)) return false;
        throw error;
      }
      return commandLine
        .toString("utf8")
        .split("\0")
        .some(
          (argument) =>
            argument === "scripts/agent-quality-gate.sh" ||
            argument === "./scripts/agent-quality-gate.sh" ||
            argument.endsWith("/scripts/agent-quality-gate.sh"),
        );
    };

    try {
      markerDescriptor = fs.openSync(
        markerPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const markerBefore = fs.fstatSync(markerDescriptor, { bigint: true });
      const pathBefore = fs.lstatSync(markerPath, { bigint: true });
      if (
        !validMarker(markerBefore) ||
        !validMarker(pathBefore) ||
        !sameInode(markerBefore, pathBefore) ||
        !markerBodyIsExact(markerDescriptor, markerBefore)
      ) {
        throw new Error("unsafe marker snapshot");
      }
      assertCompleteProcEnumeration();
      fs.readdirSync("/proc/self/fd");
      const provenance = tokenProvenance();
      const provenanceFloor = provenance?.start ?? "";
      const effectiveStartFloor =
        provenanceFloor !== "" &&
        (startFloor === "" || BigInt(provenanceFloor) > BigInt(startFloor))
          ? provenanceFloor
          : startFloor;
      const found = [];
      const processIds =
        targetPid === "" ? fs.readdirSync("/proc") : [targetPid];
      for (const pid of processIds) {
        if (!/^[1-9][0-9]*$/u.test(pid) || pid === String(process.pid)) {
          continue;
        }
        let processIdentity;
        try {
          processIdentity = fs.lstatSync(`/proc/${pid}`, { bigint: true });
        } catch (error) {
          if (ignoredRaceCodes.has(error?.code)) continue;
          throw error;
        }
        if (!processIdentity.isDirectory()) {
          continue;
        }
        const runtimeBefore = processRuntimeIdentity(pid);
        if (runtimeBefore === null) continue;
        const startBefore = runtimeBefore.start;
        if (
          effectiveStartFloor !== "" &&
          BigInt(startBefore) < BigInt(effectiveStartFloor)
        ) {
          // A gate parent can predate a coordinator that it bootstraps or
          // joins, then open the generation marker before it forks a worker.
          // That descriptor is the launch anchor which closes the final-scan
          // to worker-fork gap. Retain this bounded class of older holders.
          // Other mapped processes for this generation start at or after the
          // coordinator or active-command boundary.
          if (
            provenance?.label !== "coordinator" ||
            processIdentity.uid !== expectedUid ||
            !isCoordinatorGateParent(pid, runtimeBefore.commandName)
          ) {
            continue;
          }
        }
        const processUidSet = processUids(pid, processIdentity.uid);
        if (processUidSet === null) continue;
        const identityStartAfter = processStart(pid);
        if (
          identityStartAfter === null ||
          identityStartAfter !== startBefore
        ) {
          continue;
        }
        const uidAuthorizesSignal = [processUidSet[0], processUidSet[2]].some(
          (uid) => signalScopeUids.has(uid),
        );
        let signalProbeSucceeded = false;
        try {
          process.kill(Number(pid), 0);
          signalProbeSucceeded = true;
        } catch (error) {
          if (ignoredRaceCodes.has(error?.code)) continue;
          if (error?.code !== "EPERM") throw error;
        }
        if (!signalProbeSucceeded && !uidAuthorizesSignal) {
          continue;
        }
        let descriptors;
        try {
          descriptors = fs.readdirSync(`/proc/${pid}/fd`);
        } catch (error) {
          if (ignoredRaceCodes.has(error?.code)) continue;
          throw error;
        }
        let matches = false;
        for (const descriptor of descriptors) {
          if (!/^[0-9]+$/u.test(descriptor)) continue;
          try {
            const heldPath = `/proc/${pid}/fd/${descriptor}`;
            const heldTarget = fs.readlinkSync(heldPath);
            // The marker is a regular file. Linux renders its proc-fd target
            // as an absolute path. Pipe, socket, and anon-inode targets are
            // non-absolute and cannot match its validated inode.
            if (!heldTarget.startsWith("/")) continue;
            const held = fs.statSync(heldPath, {
              bigint: true,
            });
            if (sameInode(markerBefore, held)) {
              matches = true;
              break;
            }
          } catch (error) {
            if (ignoredRaceCodes.has(error?.code)) continue;
            throw error;
          }
        }
        const startAfter = processStart(pid);
        if (matches && startAfter !== null && startAfter === startBefore) {
          found.push(pid);
        }
      }
      const markerAfter = fs.fstatSync(markerDescriptor, { bigint: true });
      const pathAfter = fs.lstatSync(markerPath, { bigint: true });
      if (
        !validMarker(markerAfter) ||
        !validMarker(pathAfter) ||
        !sameInode(markerBefore, markerAfter) ||
        !sameInode(markerAfter, pathAfter) ||
        !markerBodyIsExact(markerDescriptor, markerAfter)
      ) {
        throw new Error("marker changed during proc descriptor scan");
      }
      found
        .sort((left, right) => Number(left) - Number(right))
        .forEach((pid) => process.stdout.write(`${pid}\n`));
    } catch {
      process.exitCode = 2;
    } finally {
      if (markerDescriptor !== undefined) fs.closeSync(markerDescriptor);
    }
  ' "$marker" "$token" "$(id -u)" "$target_pid" \
    "$full_scan_start_floor" 2>/dev/null)" &&
    status=0 || status=$?
  if [[ "$status" -ne 0 ]]; then
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  [[ -z "$found" ]] || printf '%s\n' "$found"
}

gate_run_tagged_pids() {
  local token="$1"
  local target_pid="${2:-}"
  local full_scan_start_floor="${3:-}"
  local environ environ_entry environ_match pid marker found pattern status
  local -a environ_paths=()
  # A token read back from a lock record names processes (through this
  # pattern) and files (holder.*), and on a shared root it can be another
  # user's writing. One that does not have the gate-generated shape is never
  # matched with: a crafted '.*' would classify a stranger's processes as
  # remnants, and this path signals what it matches. Emitting the scan-error
  # sentinel keeps the obligation open and fails the run closed at the bound
  # instead.
  if ! gate_lock_token_is_wellformed "$token"; then
    echo "error: malformed run token in a lock record; refusing to match processes with it." >&2
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  if [[ -n "$target_pid" && ! "$target_pid" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: invalid target PID for the run-handle scan." >&2
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  if [[ -n "$target_pid" && -n "$full_scan_start_floor" ]]; then
    echo "error: a process-start floor cannot limit exact-PID revalidation." >&2
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  elif [[ -n "$full_scan_start_floor" &&
    ! "$full_scan_start_floor" =~ ^[0-9]+$ ]]; then
    echo "error: invalid process-start floor for the run-handle scan." >&2
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  # A scan that failed is not a scan that found nothing. `pgrep` exits 1 for no
  # match and above that for a real failure, and reading the second as the first
  # would discharge an obligation on the strength of a question never answered.
  # Anchored on both sides: the tag is one whole argv element, and an
  # unanchored match would let one token select another that merely extends
  # it. The escape keeps hostname dots literal inside the anchors.
  if [[ -n "$target_pid" ]] && gate_run_proc_argv_scan_available; then
    # Linux exact-PID revalidation must stay exact. A global pgrep here made
    # every candidate check repeat a host-wide argv census during descendant
    # cleanup. Read this process's NUL-delimited argv records directly instead.
    local argv_status=0
    if gate_run_proc_pid_has_argv_tag "$target_pid" "agentqg:${token}"; then
      printf '%s\n' "$target_pid"
    else
      argv_status=$?
      if [[ "$argv_status" -ne 1 ]]; then
        echo "error: could not scan /proc/${target_pid}/cmdline for the run token." >&2
        printf '%s\n' "$gate_drain_scan_error"
      fi
    fi
  else
    if ! pattern="$(gate_lock_token_pattern "$token")" || [[ -z "$pattern" ]]; then
      echo "error: could not build a match pattern for the run token; refusing to scan." >&2
      printf '%s\n' "$gate_drain_scan_error"
      return 0
    fi
    found="$(pgrep -f "(^| )agentqg:${pattern}( |\$)" 2>/dev/null)" && status=0 || status=$?
    [[ "$status" -le 1 ]] || printf '%s\n' "$gate_drain_scan_error"
    if [[ -n "$target_pid" ]]; then
      for pid in $found; do
        if [[ "$pid" == "$target_pid" ]]; then
          printf '%s\n' "$pid"
          break
        fi
      done
    elif [[ -n "$found" ]]; then
      printf '%s\n' "$found"
    fi
  fi
  if [[ -d /proc ]]; then
    if [[ -n "$target_pid" ]]; then
      environ_paths=("/proc/${target_pid}/environ")
    else
      environ_paths=(/proc/[0-9]*/environ)
    fi
    for environ in "${environ_paths[@]}"; do
      # A builtin test first, because this loop runs once per process on the
      # host: `-r` false means the read cannot succeed, and skipping there
      # costs nothing. It is not the whole guard — `-r` answers from the
      # permission bits, and the kernel refuses `/proc/<pid>/environ` for a
      # process that changed credentials whatever those say.
      [[ -r "$environ" ]] || continue
      # Read the kernel records with the shell builtin. Spawning `tr` and up to
      # two `grep` processes for every PID made each drain proportional to the
      # host process count in process launches. The group redirect is active
      # before the inner file redirect, so an unreadable or vanished record
      # stays quiet.
      environ_match=0
      environ_entry=""
      {
        while IFS= read -r -d '' environ_entry || [[ -n "$environ_entry" ]]; do
          if [[ "$environ_entry" == "AGENTQG_RUN=agentqg:${token}" ||
            "$environ_entry" == "AGENTQG_REQUEST=agentqg:${token}" ]]; then
            environ_match=1
            break
          fi
          environ_entry=""
        done < "$environ"
      } 2>/dev/null || environ_match=0
      if [[ "$environ_match" -ne 1 ]]; then
        # Past the `-r` test and still nothing: the kernel refused the read for
        # a process that changed credentials, the process exited between the
        # listing and the read, or its environment is genuinely empty. None
        # can be one of ours. Anything this run started carries this user's
        # credentials and this run's environment, so it stays readable to it
        # — and where a credential-changing descendant stretches that, the
        # argv-tag scan and marker-descriptor scan below still name it, because
        # neither reads the environment. Deliberately NOT the scan-error
        # sentinel: one unreadable process is ordinary — every GitHub runner
        # has one — and counting it as a failed scan would fail every crash
        # recovery on such a host closed, rather than only the ones with work
        # left to do.
        continue
      fi
      pid="${environ#/proc/}"
      printf '%s\n' "${pid%/environ}"
    done
  fi
  marker="${gate_lock_root_dir}/holder.${token}"
  if [[ -n "$gate_lock_root_dir" &&
    ( -e "$marker" || -L "$marker" ) ]]; then
    if gate_run_proc_marker_scan_available; then
      gate_run_proc_marker_pids \
        "$token" "$marker" "$target_pid" "$full_scan_start_floor"
    elif command -v lsof > /dev/null 2>&1; then
      gate_run_lsof_marker_pids "$token" "$marker" "$target_pid"
    else
      printf '%s\n' "$gate_drain_scan_error"
    fi
  fi
}
