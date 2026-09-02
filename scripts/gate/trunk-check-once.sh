#!/bin/bash

set -euo pipefail

guardian_dir=""
guardian_pid=""
guardian_handshake_pending="${AGENTQG_TRUNK_GUARDIAN_PENDING:-}"
guardian_handshake_done="${AGENTQG_TRUNK_GUARDIAN_DONE:-}"
guardian_check_timeout_seconds="${AGENTQG_TRUNK_CHECK_TIMEOUT_SECONDS:-}"
guardian_signal_fd="${AGENTQG_TRUNK_GUARDIAN_SIGNAL_FD:-}"
unset AGENTQG_TRUNK_GUARDIAN_PENDING AGENTQG_TRUNK_GUARDIAN_DONE \
  AGENTQG_TRUNK_CHECK_TIMEOUT_SECONDS AGENTQG_TRUNK_GUARDIAN_SIGNAL_FD
exec 26<&-

guardian_pending_is_valid() {
  local first_line
  {
    IFS= read -r first_line && ! IFS= read -r _
  } <"$guardian_handshake_pending" || return 1
  [[ "$first_line" == pending ]]
}

validate_guardian_handshake() {
  local handshake_dir
  if [[ -z "$guardian_handshake_pending" && -z "$guardian_handshake_done" &&
    -z "$guardian_check_timeout_seconds" && -z "$guardian_signal_fd" ]]; then
    return 0
  fi
  [[ "$guardian_handshake_pending" == /* &&
    "$guardian_handshake_done" == /* &&
    "$guardian_check_timeout_seconds" =~ ^[1-9][0-9]*$ &&
    "$guardian_check_timeout_seconds" -le 86400 &&
    "$guardian_signal_fd" == 25 && -p /dev/fd/25 ]] || return 2
  handshake_dir="${guardian_handshake_pending%/*}"
  [[ "$guardian_handshake_pending" == "$handshake_dir/trunk-guardian.pending" &&
    "$guardian_handshake_done" == "$handshake_dir/trunk-guardian.done" &&
    -d "$handshake_dir" && ! -L "$handshake_dir" && -O "$handshake_dir" &&
    -f "$guardian_handshake_pending" &&
    ! -L "$guardian_handshake_pending" &&
    -O "$guardian_handshake_pending" ]] &&
    guardian_pending_is_valid &&
    [[
    ! -e "$guardian_handshake_done" && ! -L "$guardian_handshake_done" &&
    ! -e "${guardian_handshake_done}.tmp" &&
    ! -L "${guardian_handshake_done}.tmp" ]]
}

# Invoked indirectly by cleanup from the EXIT trap below.
# shellcheck disable=SC2329
publish_guardian_done() {
  local done_temp
  [[ -n "$guardian_handshake_done" ]] || return 0
  done_temp="${guardian_handshake_done}.tmp"
  (set -o noclobber && umask 077 &&
    printf 'done\n' >"$done_temp") || return 2
  if ! /bin/chmod 0400 "$done_temp" ||
    ! /bin/mv "$done_temp" "$guardian_handshake_done"; then
    /bin/rm -f -- "$done_temp"
    return 2
  fi
  printf 'done\n' >&25 || return 2
  exec 25>&-
}

if ! validate_guardian_handshake; then
  echo "error: Trunk guardian lifecycle handshake is invalid." >&2
  exit 2
fi

# Invoked indirectly by the EXIT trap below.
# shellcheck disable=SC2329
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$guardian_pid" ]]; then
    wait "$guardian_pid" || status=2
  fi
  if ! publish_guardian_done; then
    status=2
  fi
  if [[ -n "$guardian_dir" && "$guardian_dir" == "${TMPDIR:-/tmp}"/agentqg-trunk-guardian.* ]]; then
    /bin/rm -f -- \
      "$guardian_dir/ready"
    /bin/rmdir "$guardian_dir" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

start_owned_daemon_guardian() {
  local expected_parent_pid="$$"
  local node_bin

  guardian_dir="$(
    /usr/bin/mktemp -d \
      "${TMPDIR:-/tmp}/agentqg-trunk-guardian.XXXXXX"
  )" || return 2
  /bin/chmod 0700 "$guardian_dir" || return 2
  local ready_file="$guardian_dir/ready"

  node_bin="$(node -p 'process.execPath' 25>&-)" || return 2
  [[ "$node_bin" == /* && -x "$node_bin" && ! -L "$node_bin" ]] || return 2

  (
    exec "$node_bin" - \
      "$expected_parent_pid" \
      "$ready_file" \
      "$guardian_dir" \
      "$guardian_handshake_pending" \
      "$guardian_handshake_done" \
      "$guardian_check_timeout_seconds" \
      "$guardian_signal_fd" \
      "$@" <<'EOF_TRUNK_GUARDIAN'
const { spawnSync } = require("node:child_process");
const {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  writeSync,
} = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");

const [
  expectedParentText,
  readyPath,
  guardianDir,
  handshakePending,
  handshakeDone,
  checkTimeoutSecondsText,
  signalFdText,
  ...checkArgs
] = process.argv.slice(2);
const expectedParent = Number.parseInt(expectedParentText, 10);
const checkTimeoutSeconds = Number.parseInt(checkTimeoutSecondsText, 10);
const signalFd = Number.parseInt(signalFdText, 10);
const cleanupAttempts = 3;
const cleanupCommandTimeoutMs = 10_000;
const retryDelayMs = 1_000;

function validateHandshake() {
  if (
    !handshakePending &&
    !handshakeDone &&
    !checkTimeoutSecondsText &&
    !signalFdText
  ) {
    return null;
  }
  if (
    !handshakePending ||
    !handshakeDone ||
    signalFd !== 25 ||
    !fstatSync(signalFd).isFIFO() ||
    !Number.isSafeInteger(checkTimeoutSeconds) ||
    checkTimeoutSeconds <= 0 ||
    checkTimeoutSeconds > 86_400
  ) {
    throw new Error("invalid Trunk guardian lifecycle handshake arguments");
  }
  const directory = handshakePending.slice(0, handshakePending.lastIndexOf("/"));
  if (
    handshakePending !== `${directory}/trunk-guardian.pending` ||
    handshakeDone !== `${directory}/trunk-guardian.done`
  ) {
    throw new Error("invalid Trunk guardian lifecycle handshake paths");
  }
  const directoryStat = lstatSync(directory);
  const pendingStat = lstatSync(handshakePending);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.getuid() ||
    (directoryStat.mode & 0o7777) !== 0o700 ||
    !pendingStat.isFile() ||
    pendingStat.isSymbolicLink() ||
    pendingStat.uid !== process.getuid() ||
    (pendingStat.mode & 0o7777) !== 0o400 ||
    readFileSync(handshakePending, "utf8") !== "pending\n" ||
    existsSync(handshakeDone) ||
    existsSync(`${handshakeDone}.tmp`)
  ) {
    throw new Error("unsafe Trunk guardian lifecycle handshake state");
  }
  return { directory };
}

function publishDone(handshake) {
  if (handshake === null) return;
  const temporaryPath = `${handshakeDone}.tmp`;
  try {
    writeFileSync(temporaryPath, "done\n", { flag: "wx", mode: 0o400 });
    chmodSync(temporaryPath, 0o400);
    renameSync(temporaryPath, handshakeDone);
    const signal = Buffer.from("done\n", "utf8");
    if (writeSync(signalFd, signal) !== signal.length) {
      throw new Error("could not publish Trunk guardian completion signal");
    }
    closeSync(signalFd);
  } catch (error) {
    try {
      rmSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

function removePrivateState() {
  for (const path of [readyPath]) {
    try {
      rmSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  try {
    rmdirSync(guardianDir);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  }
}

function trunk(args, baseStdio = ["ignore", "pipe", "pipe"], timeout = 30_000) {
  const stdio = [...baseStdio];
  // Descriptors this call reopened. spawnSync leaves the parent's copies open,
  // and trunk() runs more than once per guardian, so they are closed below
  // rather than accrued across calls.
  const reopenedMarkers = [];
  const carriesGateIdentity = [
    process.env.AGENTQG_RUN,
    process.env.AGENTQG_REQUEST,
  ].some(
    (value) =>
      typeof value === "string" && /^agentqg:[A-Za-z0-9._:-]+$/u.test(value),
  );
  if (carriesGateIdentity) {
    // Keep this copy aligned with mapped-command-process-identity.mjs. The
    // guardian runs from trusted stdin and must not import a replaceable
    // module after the mapped command starts.
    const declaration = process.env.AGENTQG_MARKER_FDS ?? "";
    if (!/^(?:6|8|9)(?:,(?:6|8|9))*$/u.test(declaration)) {
      throw new Error("Trunk guardian has no valid gate marker declaration");
    }
    const descriptors = declaration.split(",").map(Number);
    if (new Set(descriptors).size !== descriptors.length) {
      throw new Error("Trunk guardian gate marker declaration is duplicated");
    }
    // A runtime between the gate and this guardian can take these low
    // descriptors for its own handles, so a declared path reopens the marker
    // the descriptor no longer holds (issue 2189).
    const markerPath = (descriptor) => {
      const value = process.env[`AGENTQG_MARKER_PATH_${descriptor}`];
      return typeof value === "string" && value !== "" ? value : undefined;
    };
    // Inspect every declared descriptor BEFORE reopening any path: an open
    // takes the lowest free descriptor, which can be one a later declaration
    // still names, and inspecting it afterwards would read the reopened
    // marker and call it a survivor.
    const inspections = descriptors.map((descriptor) => {
      try {
        return { descriptor, regular: fstatSync(descriptor).isFile() };
      } catch (error) {
        return { descriptor, error, regular: false };
      }
    });
    const descriptorStates = inspections.map((inspection) => {
      const { descriptor } = inspection;
      if (inspection.regular) return { ...inspection, source: descriptor };
      const path = markerPath(descriptor);
      if (path === undefined) return inspection;
      try {
        const reopened = openSync(path, "r");
        reopenedMarkers.push(reopened);
        return { descriptor, regular: true, source: reopened };
      } catch {
        return inspection;
      }
    });
    const unexpectedError = descriptorStates.find(
      ({ error, source }) =>
        source === undefined && error && error.code !== "EBADF",
    );
    if (unexpectedError) {
      throw new Error(
        `Trunk guardian marker ${unexpectedError.descriptor} could not be inspected`,
        { cause: unexpectedError.error },
      );
    }
    // Darwin captures the exact mapped-root lineage before START. If a nested
    // runtime closed every marker and reused a descriptor, the stale
    // declaration grants no signal authority. Linux keeps marker-only
    // containment, and every platform rejects a partially surviving set.
    const allStale = !descriptorStates.some(
      ({ source }) => source !== undefined,
    );
    if (process.platform !== "darwin" || !allStale) {
      for (const { descriptor, error, source } of descriptorStates) {
        if (source !== undefined) continue;
        if (error) {
          throw new Error(`Trunk guardian marker ${descriptor} is not open`, {
            cause: error,
          });
        }
        throw new Error(`Trunk guardian marker ${descriptor} is not regular`);
      }
    }
    if (!allStale) {
      for (const { descriptor, source } of descriptorStates) {
        while (stdio.length <= descriptor) stdio.push("ignore");
        stdio[descriptor] = source;
      }
    }
  }
  if (Number.isSafeInteger(signalFd)) {
    while (stdio.length <= signalFd) stdio.push("ignore");
    stdio[signalFd] = "ignore";
  }
  const options = {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio,
    killSignal: "SIGKILL",
  };
  if (timeout !== null) options.timeout = timeout;
  // Node can retain an existing high-numbered descriptor when its stdio entry
  // is "ignore" on Linux. Close the guardian capability in the exec process
  // before Trunk starts, while the guardian keeps its own writer open.
  try {
    return spawnSync(
      "/bin/bash",
      [
        "-c",
        'exec 25>&-; exec ./tools/trunk "$@"',
        "agentqg-trunk-guardian",
        ...args,
      ],
      options,
    );
  } finally {
    // spawnSync leaves the parent's copies open. trunk() runs several times
    // per guardian — daemonState() and stopOwnedDaemon() both call it — so
    // without this each call would accrue a descriptor per reopened marker,
    // and a later reopen could land on a slot an earlier call still held.
    for (const descriptor of reopenedMarkers) {
      try {
        closeSync(descriptor);
      } catch {
        // Already closed, or never ours to close.
      }
    }
  }
}

function daemonState() {
  const result = trunk(
    ["daemon", "status", "--ci", "--color=false"],
    undefined,
    cleanupCommandTimeoutMs,
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (
    !result.error &&
    result.status === 0 &&
    /^. Daemon running \(pid: [1-9][0-9]*\)$/mu.test(output)
  ) {
    return "running";
  }
  if (
    !result.error &&
    result.status === 1 &&
    /^. Daemon stopped$/mu.test(output)
  ) {
    return "stopped";
  }
  throw new Error(
    `could not classify Trunk daemon state: ${result.error?.message ?? output.trim()}`,
  );
}

async function stopOwnedDaemon(handshake) {
  let lastError = "";
  for (let attempt = 1; attempt <= cleanupAttempts; attempt += 1) {
    try {
      const state = daemonState();
      if (state === "stopped") return;
      const result = trunk(
        ["daemon", "shutdown", "--ci", "--color=false"],
        undefined,
        cleanupCommandTimeoutMs,
      );
      if (result.error || result.status !== 0) {
        throw new Error(
          `could not stop gate-owned Trunk daemon: ${result.error?.message ?? result.stderr ?? result.stdout}`,
        );
      }
      if (daemonState() === "stopped") return;
      throw new Error("gate-owned Trunk daemon remained live after shutdown");
    } catch (error) {
      if (error.message !== lastError) {
        console.error(
          `error: Trunk daemon cleanup attempt ${attempt}/${cleanupAttempts} failed: ${error.message}`,
        );
        lastError = error.message;
      }
      if (attempt < cleanupAttempts) await delay(retryDelayMs);
    }
  }
  const disposition =
    handshake === null
      ? "leaving it as the named trusted external service"
      : "handing remaining gate-owned descendants to exact mapped-command settlement";
  throw new Error(
    `could not confirm Trunk daemon shutdown after ${cleanupAttempts} attempts; ${disposition}: ${lastError}`,
  );
}

(async () => {
  if (
    !Number.isSafeInteger(expectedParent) ||
    expectedParent <= 1 ||
    process.ppid !== expectedParent ||
    lstatSync(guardianDir).isSymbolicLink()
  ) {
    throw new Error("invalid Trunk guardian parent or private state");
  }
  const handshake = validateHandshake();
  try {
    writeFileSync(readyPath, "ready\n", { flag: "wx", mode: 0o400 });
    chmodSync(readyPath, 0o400);
    const check = trunk(
      ["check", "--ci", ...checkArgs],
      ["inherit", "inherit", "inherit"],
      handshake === null ? null : checkTimeoutSeconds * 1_000,
    );
    let checkStatus = check.status;
    if (check.error || !Number.isInteger(checkStatus)) {
      console.error(
        `error: gate-owned Trunk check did not return a status: ${check.error?.message ?? `signal ${check.signal ?? "unknown"}`}`,
      );
      checkStatus = 2;
    }
    try {
      await stopOwnedDaemon(handshake);
      process.exitCode = checkStatus;
    } catch (error) {
      console.error(`error: ${error.message}`);
      process.exitCode = 2;
    }
  } finally {
    removePrivateState();
    if (process.ppid !== expectedParent) publishDone(handshake);
  }
})().catch((error) => {
  console.error(`error: Trunk daemon guardian failed: ${error.message}`);
  process.exitCode = 2;
});
EOF_TRUNK_GUARDIAN
  ) &
  guardian_pid=$!
  return 0
}

trunk_daemon_state() {
  node 25>&- <<'EOF_TRUNK_STATUS'
const { spawnSync } = require("node:child_process");
const {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const directory = mkdtempSync(join(tmpdir(), "agentqg-trunk-status."));
const outputPath = join(directory, "output");
try {
  const outputFd = openSync(outputPath, "wx", 0o600);
  let result;
  try {
    result = spawnSync(
      "./tools/trunk",
      ["daemon", "status", "--ci", "--color=false"],
      {
        cwd: process.cwd(),
        killSignal: "SIGKILL",
        stdio: ["ignore", outputFd, outputFd],
        timeout: 10_000,
      },
    );
  } finally {
    closeSync(outputFd);
  }
  const output = readFileSync(outputPath, "utf8");
  if (
    !result.error &&
    result.status === 0 &&
    /^. Daemon running \(pid: [1-9][0-9]*\)$/mu.test(output)
  ) {
    console.log("running");
  } else if (
    !result.error &&
    result.status === 1 &&
    /^. Daemon stopped$/mu.test(output)
  ) {
    console.log("stopped");
  } else {
    console.error(
      `error: could not classify Trunk daemon state: ${result.error?.message ?? output.trim()}`,
    );
    process.exitCode = 2;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
EOF_TRUNK_STATUS
}

initial_state="$(trunk_daemon_state)" || {
  echo "error: could not classify the Trunk daemon before the check." >&2
  exit 2
}

if [[ "$initial_state" == stopped ]]; then
  start_owned_daemon_guardian "$@" || {
    echo "error: could not start the Trunk daemon lifecycle guardian." >&2
    exit 2
  }
  if wait "$guardian_pid"; then
    check_status=0
  else
    check_status=$?
  fi
  guardian_pid=""
else
  if ./tools/trunk check --ci "$@" 25>&-; then
    check_status=0
  else
    check_status=$?
  fi
fi

# A daemon that existed before the gate is a named trusted external service.
# A daemon started from the stopped state is gate-owned. The direct guardian
# owns the check child, then shuts down the daemon after normal exit or hard
# wrapper death. The guardian keeps the mapped command lineage live until the
# check and shutdown complete, so the coordinator retains the `trunk-daemon`
# resource through crash recovery.
if [[ "$initial_state" == stopped ]]; then
  final_state="$(trunk_daemon_state)" || {
    echo "error: could not classify the Trunk daemon after the check." >&2
    exit 2
  }
  if [[ "$final_state" != stopped ]]; then
    echo "error: gate-owned Trunk daemon remained live after bounded cleanup; leaving it as the named trusted external service." >&2
    exit 2
  fi
fi

exit "$check_status"
