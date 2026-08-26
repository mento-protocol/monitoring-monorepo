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
# where one is read back: an alphanumeric start, then hostname characters,
# digits, dots and dashes. No slash can pass, so no derived path can leave
# the lock root; no leading dash, so no value can read as an option.
gate_lock_token_is_wellformed() {
  local token="$1"
  # The full generated structure — host, dash, PID, dash, epoch — not merely
  # a path-safe string. A looser shape would let a crafted record carry a
  # PREFIX of a real token, and combined with an unanchored match a prefix
  # is enough to select a live run's processes.
  [[ "$token" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,180}-[0-9]{1,10}-[0-9]{1,12}$ ]]
}

# ERE-escape a token for pgrep: validation keeps a token benign as a path,
# but hostname dots would still match any character as a pattern, and only
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
  local witness_dir witness found status
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
  found="$(lsof -w -t -- "$witness" 2>/dev/null)" && status=0 || status=$?
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

gate_run_proc_marker_pids() {
  local token="$1"
  local marker="$2"
  local found status
  found="$(node -e '
    const fs = require("node:fs");
    const { constants } = fs;
    const [markerPath, expectedToken, uidText] = process.argv.slice(1);
    const expectedUid = BigInt(uidText);
    const signalScopeUids = new Set([
      BigInt(process.getuid()),
      BigInt(process.geteuid()),
    ]);
    const expectedBody = Buffer.from(`${expectedToken}\n`, "utf8");
    const ignoredRaceCodes = new Set(["EBADF", "ENOENT", "ESRCH"]);
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
    const processStart = (pid) => {
      let value;
      try {
        value = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch (error) {
        if (ignoredRaceCodes.has(error?.code)) return null;
        throw error;
      }
      const close = value.lastIndexOf(")");
      if (close < 0) throw new Error("malformed proc process identity");
      const fields = value.slice(close + 1).trim().split(/\s+/u);
      const start = fields[19];
      if (!/^[0-9]+$/u.test(start ?? "")) {
        throw new Error("malformed proc process start identity");
      }
      return start;
    };
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
      const found = [];
      for (const pid of fs.readdirSync("/proc")) {
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
        const startBefore = processStart(pid);
        if (startBefore === null) continue;
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
            const held = fs.statSync(`/proc/${pid}/fd/${descriptor}`, {
              bigint: true,
            });
            if (sameInode(markerBefore, held)) matches = true;
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
  ' "$marker" "$token" "$(id -u)" 2>/dev/null)" && status=0 || status=$?
  if [[ "$status" -ne 0 ]]; then
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  [[ -z "$found" ]] || printf '%s\n' "$found"
}

gate_run_tagged_pids() {
  local token="$1"
  local environ environ_entries pid marker found pattern status
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
  # A scan that failed is not a scan that found nothing. `pgrep` exits 1 for no
  # match and above that for a real failure, and reading the second as the first
  # would discharge an obligation on the strength of a question never answered.
  # Anchored on both sides: the tag is one whole argv element, and an
  # unanchored match would let one token select another that merely extends
  # it. The escape keeps hostname dots literal inside the anchors.
  if ! pattern="$(gate_lock_token_pattern "$token")" || [[ -z "$pattern" ]]; then
    echo "error: could not build a match pattern for the run token; refusing to scan." >&2
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  found="$(pgrep -f "(^| )agentqg:${pattern}( |\$)" 2>/dev/null)" && status=0 || status=$?
  [[ "$status" -le 1 ]] || printf '%s\n' "$gate_drain_scan_error"
  [[ -z "$found" ]] || printf '%s\n' "$found"
  if [[ -d /proc ]]; then
    for environ in /proc/[0-9]*/environ; do
      # A builtin test first, because this loop runs once per process on the
      # host: `-r` false means the read cannot succeed, and skipping there
      # costs nothing. It is not the whole guard — `-r` answers from the
      # permission bits, and the kernel refuses `/proc/<pid>/environ` for a
      # process that changed credentials whatever those say.
      [[ -r "$environ" ]] || continue
      # The redirection is inside a group with its own stderr redirect. A
      # redirection that cannot open its target is reported by the shell
      # itself, before the `2>/dev/null` beside it applies, so the bare form
      # printed `/proc/<pid>/environ: Permission denied` into the output of
      # every drain on a runner (GitHub issue 1919); the group's redirect is
      # already in place when the inner one is attempted. NULs are translated
      # before the capture because command substitution cannot hold them, and
      # the exact-entry match below depends on the separators surviving.
      environ_entries="$({ tr '\0' '\n' < "$environ"; } 2>/dev/null)" ||
        environ_entries=""
      if [[ -z "$environ_entries" ]]; then
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
      # Exact entry, not substring: environ is NUL-separated, and a substring
      # match would let one token select an environment carrying a longer one.
      if ! printf '%s\n' "$environ_entries" |
        grep -qxF "AGENTQG_RUN=agentqg:${token}" &&
        ! printf '%s\n' "$environ_entries" |
          grep -qxF "AGENTQG_REQUEST=agentqg:${token}"; then
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
      gate_run_proc_marker_pids "$token" "$marker"
    elif command -v lsof > /dev/null 2>&1; then
      gate_run_lsof_marker_pids "$token" "$marker"
    else
      printf '%s\n' "$gate_drain_scan_error"
    fi
  fi
}
