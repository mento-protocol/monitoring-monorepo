#!/bin/bash

set -euo pipefail

source_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/trunk-check-once.sh"
gate_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/agent-quality-gate.sh"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/agentqg-trunk-once-test.XXXXXX")"
handshake_dir="$fixture_root/repo/trunk-handshake"
handshake_pending="$handshake_dir/trunk-guardian.pending"
handshake_done="$handshake_dir/trunk-guardian.done"
handshake_signal_fifo="$handshake_dir/trunk-guardian.signal"

cleanup() {
  rm -f "$fixture_root/repo/tools/trunk" \
    "$fixture_root/repo/scripts/gate/trunk-check-once.sh" \
    "$fixture_root/repo/state" "$fixture_root/repo/log" \
    "$fixture_root/repo/shutdown-failures" \
    "$fixture_root/repo/status-count" \
    "$fixture_root/repo/marker-report" \
    "$fixture_root/repo/cleanup-error" \
    "$fixture_root/repo/check-ready" "$fixture_root/repo/check-release" \
    "$fixture_root/repo/check-finished" \
    "$handshake_pending" "$handshake_done" "${handshake_done}.tmp" \
    "$handshake_signal_fifo"
  rmdir "$handshake_dir" 2>/dev/null || true
  rmdir "$fixture_root/repo/tools" "$fixture_root/repo/scripts/gate" \
    "$fixture_root/repo/scripts" "$fixture_root/repo" "$fixture_root" \
    2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$fixture_root/repo/tools" "$fixture_root/repo/scripts/gate"
cp "$source_script" "$fixture_root/repo/scripts/gate/trunk-check-once.sh"

cat > "$fixture_root/repo/tools/trunk" <<'EOF_TRUNK_FIXTURE'
#!/bin/bash
set -u
state_file="$(pwd -P)/state"
log_file="$(pwd -P)/log"
state="$(cat "$state_file")"
case "$1 $2" in
  "daemon status")
    if [[ "${TRUNK_FIXTURE_HANG_STATUS:-0}" != 0 ]]; then
      exec /bin/sleep 30
    fi
    if [[ "${TRUNK_FIXTURE_LATE_STATUS:-0}" != 0 ]]; then
      status_count_file="$(pwd -P)/status-count"
      status_count=0
      [[ ! -f "$status_count_file" ]] || status_count="$(cat "$status_count_file")"
      status_count=$((status_count + 1))
      echo "$status_count" > "$status_count_file"
      if [[ "$status_count" -ge 3 ]]; then
        state=running
        echo running > "$state_file"
      fi
    fi
    if [[ "$state" == running ]]; then
      echo "✔ Daemon running (pid: 12345)"
      exit 0
    fi
    echo "✖ Daemon stopped"
    exit 1
    ;;
  "daemon shutdown")
    failures_file="$(pwd -P)/shutdown-failures"
    failures=0
    [[ ! -f "$failures_file" ]] || failures="$(cat "$failures_file")"
    if [[ "$failures" =~ ^[1-9][0-9]*$ ]]; then
      echo $((failures - 1)) > "$failures_file"
      echo shutdown-failed >> "$log_file"
      echo "error: synthetic shutdown failure" >&2
      exit 9
    fi
    echo shutdown >> "$log_file"
    echo stopped > "$state_file"
    echo "✔ Daemon stopped"
    exit 0
    ;;
  "check --ci")
    if [[ -p /dev/fd/25 ]]; then
      echo "error: Trunk check inherited the guardian completion capability" >&2
      exit 92
    fi
    if [[ -n "${TRUNK_FIXTURE_MARKER_REPORT:-}" ]]; then
      : > "$TRUNK_FIXTURE_MARKER_REPORT"
      for marker_fd in 6 8 9; do
        if [[ -f "/dev/fd/${marker_fd}" ]]; then
          printf '%s\n' "$marker_fd" >> "$TRUNK_FIXTURE_MARKER_REPORT"
        fi
      done
    fi
    echo check >> "$log_file"
    if [[ "${TRUNK_FIXTURE_STARTS_DAEMON:-1}" != 0 &&
      "${TRUNK_FIXTURE_START_AFTER_RELEASE:-0}" == 0 ]]; then
      echo running > "$state_file"
    fi
    if [[ -n "${TRUNK_FIXTURE_READY_FILE:-}" ]]; then
      printf 'ready\n' > "$TRUNK_FIXTURE_READY_FILE"
      waited=0
      while [[ ! -e "${TRUNK_FIXTURE_RELEASE_FILE:?}" ]]; do
        if [[ "$waited" -ge 500 ]]; then
          echo "error: fixture release file never appeared" >&2
          exit 91
        fi
        waited=$((waited + 1))
        sleep 0.01
      done
      if [[ "${TRUNK_FIXTURE_STARTS_DAEMON:-1}" != 0 &&
        "${TRUNK_FIXTURE_START_AFTER_RELEASE:-0}" != 0 ]]; then
        echo running > "$state_file"
      fi
      printf 'finished\n' > "${TRUNK_FIXTURE_FINISHED_FILE:?}"
    fi
    exit "${TRUNK_FIXTURE_CHECK_STATUS:-0}"
    ;;
esac
exit 90
EOF_TRUNK_FIXTURE
chmod +x "$fixture_root/repo/tools/trunk"

run_wrapper() {
  (
    cd "$fixture_root/repo" &&
      TMPDIR="$fixture_root" /bin/bash scripts/gate/trunk-check-once.sh --all
  )
}

prepare_guardian_handshake() {
  mkdir "$handshake_dir"
  chmod 0700 "$handshake_dir"
  (umask 077 && printf 'pending\n' > "$handshake_pending")
  chmod 0400 "$handshake_pending"
}

cleanup_guardian_handshake() {
  rm -f "$handshake_pending" "$handshake_done" "${handshake_done}.tmp" \
    "$handshake_signal_fifo"
  rmdir "$handshake_dir"
}

run_wrapper_with_handshake() {
  local signal
  local wrapper_pid
  mkfifo "$handshake_signal_fifo"
  exec 27<> "$handshake_signal_fifo"
  exec 26< "$handshake_signal_fifo"
  exec 25> "$handshake_signal_fifo"
  exec 27>&-
  rm -f "$handshake_signal_fifo"
  AGENTQG_TRUNK_GUARDIAN_PENDING="$handshake_pending" \
    AGENTQG_TRUNK_GUARDIAN_DONE="$handshake_done" \
    AGENTQG_TRUNK_CHECK_TIMEOUT_SECONDS=10 \
    AGENTQG_TRUNK_GUARDIAN_SIGNAL_FD=25 \
    run_wrapper &
  wrapper_pid=$!
  exec 25>&-
  wait "$wrapper_pid"
  IFS= read -r -t 2 signal <&26
  exec 26<&-
  [[ "$signal" == "done" ]]
}

echo stopped > "$fixture_root/repo/state"
: > "$fixture_root/repo/log"
# The gate preserves the caller's locale. In the C locale, grep treats each
# byte of Trunk's UTF-8 status prefix separately.
LC_ALL=C run_wrapper >/dev/null
[[ "$(cat "$fixture_root/repo/state")" == stopped ]]
[[ "$(cat "$fixture_root/repo/log")" == $'check\nshutdown' ]]

# An unrelated descriptor 9 does not become a marker without mapped identity.
echo stopped > "$fixture_root/repo/state"
: > "$fixture_root/repo/log"
(
  exec 9< <(printf 'unrelated\n')
  run_wrapper >/dev/null
)
[[ "$(cat "$fixture_root/repo/state")" == stopped ]]
[[ "$(cat "$fixture_root/repo/log")" == $'check\nshutdown' ]]

# Exact surviving declarations pass through to the guardian's Trunk children.
echo stopped > "$fixture_root/repo/state"
: > "$fixture_root/repo/log"
marker_report="$fixture_root/repo/marker-report"
rm -f "$marker_report"
(
  exec 8< "$fixture_root/repo/state"
  exec 9< "$fixture_root/repo/state"
  AGENTQG_RUN=agentqg:trunk-marker-test \
    AGENTQG_MARKER_FDS=8,9 \
    TRUNK_FIXTURE_MARKER_REPORT="$marker_report" \
    run_wrapper >/dev/null
)
[[ "$(cat "$fixture_root/repo/state")" == stopped ]]
[[ "$(cat "$fixture_root/repo/log")" == $'check\nshutdown' ]]
[[ "$(cat "$marker_report")" == $'8\n9' ]]

if [[ "$(uname -s)" == Darwin ]]; then
  # Node test workers can close the full marker set and reuse descriptor 9 as
  # IPC. Darwin's exact lineage remains authoritative, so the stale pipe is
  # discarded instead of being inherited as a marker.
  echo stopped > "$fixture_root/repo/state"
  : > "$fixture_root/repo/log"
  (
    exec 9< <(printf 'reused\n')
    AGENTQG_RUN=agentqg:trunk-stale-marker-test \
      AGENTQG_MARKER_FDS=9 \
      run_wrapper >/dev/null
  )
  [[ "$(cat "$fixture_root/repo/state")" == stopped ]]
  [[ "$(cat "$fixture_root/repo/log")" == $'check\nshutdown' ]]

  # A surviving regular marker proves that the declaration is live. Every
  # other declared descriptor must then remain open and regular.
  echo stopped > "$fixture_root/repo/state"
  : > "$fixture_root/repo/log"
  rm -f "$fixture_root/repo/cleanup-error"
  set +e
  (
    exec 8< "$fixture_root/repo/state"
    exec 9< <(printf 'reused\n')
    AGENTQG_RUN=agentqg:trunk-partial-marker-test \
      AGENTQG_MARKER_FDS=8,9 \
      run_wrapper >/dev/null 2> "$fixture_root/repo/cleanup-error"
  )
  status=$?
  set -e
  [[ "$status" -eq 2 ]]
  grep -q 'Trunk guardian marker 9 is not regular' \
    "$fixture_root/repo/cleanup-error"
fi

# Every outer daemon-status call has the same hard 10-second limit as guardian
# cleanup. The fixture execs sleep, so the timed process has no child to leak.
echo stopped > "$fixture_root/repo/state"
: > "$fixture_root/repo/log"
SECONDS=0
set +e
TRUNK_FIXTURE_HANG_STATUS=1 \
  run_wrapper >/dev/null 2> "$fixture_root/repo/cleanup-error"
status=$?
set -e
[[ "$status" -eq 2 ]]
[[ "$SECONDS" -ge 10 && "$SECONDS" -le 15 ]]
grep -q 'ETIMEDOUT' "$fixture_root/repo/cleanup-error"
[[ -z "$(find "$fixture_root" -maxdepth 1 -name 'agentqg-trunk-status.*' -print)" ]]

echo running > "$fixture_root/repo/state"
: > "$fixture_root/repo/log"
rm -f "$fixture_root/repo/status-count"
TRUNK_FIXTURE_LATE_STATUS=1 run_wrapper >/dev/null
[[ "$(cat "$fixture_root/repo/state")" == running ]]
[[ "$(cat "$fixture_root/repo/log")" == check ]]
[[ "$(cat "$fixture_root/repo/status-count")" == 1 ]]

# A pre-existing daemon does not need a guardian. The trusted wrapper still
# completes the authenticated handshake after the direct check exits.
echo running > "$fixture_root/repo/state"
: > "$fixture_root/repo/log"
prepare_guardian_handshake
run_wrapper_with_handshake >/dev/null
[[ "$(cat "$handshake_pending")" == pending ]]
[[ "$(cat "$handshake_done")" == "done" ]]
[[ "$(cat "$fixture_root/repo/log")" == check ]]
cleanup_guardian_handshake

# When the guardian runs normally, the live wrapper publishes completion only
# after its final daemon-state check.
echo stopped > "$fixture_root/repo/state"
: > "$fixture_root/repo/log"
prepare_guardian_handshake
run_wrapper_with_handshake >/dev/null
[[ "$(cat "$handshake_done")" == "done" ]]
[[ "$(cat "$fixture_root/repo/state")" == stopped ]]
[[ "$(cat "$fixture_root/repo/log")" == $'check\nshutdown' ]]
cleanup_guardian_handshake

echo stopped > "$fixture_root/repo/state"
: > "$fixture_root/repo/log"
set +e
TRUNK_FIXTURE_CHECK_STATUS=7 run_wrapper >/dev/null
status=$?
set -e
[[ "$status" -eq 7 ]]
[[ "$(cat "$fixture_root/repo/state")" == stopped ]]
[[ "$(cat "$fixture_root/repo/log")" == $'check\nshutdown' ]]

# A daemon that becomes visible only after the guardian's cleanup check is a
# failure. The final wrapper check classifies it as the named trusted service.
echo stopped > "$fixture_root/repo/state"
: > "$fixture_root/repo/log"
rm -f "$fixture_root/repo/status-count"
set +e
TRUNK_FIXTURE_STARTS_DAEMON=0 TRUNK_FIXTURE_LATE_STATUS=1 \
  run_wrapper >/dev/null 2> "$fixture_root/repo/cleanup-error"
status=$?
set -e
[[ "$status" -eq 2 ]]
[[ "$(cat "$fixture_root/repo/state")" == running ]]
[[ "$(cat "$fixture_root/repo/log")" == check ]]
grep -q 'remained live after bounded cleanup' \
  "$fixture_root/repo/cleanup-error"

echo stopped > "$fixture_root/repo/state"
: > "$fixture_root/repo/log"
echo 1 > "$fixture_root/repo/shutdown-failures"
run_wrapper >/dev/null 2> "$fixture_root/repo/cleanup-error"
[[ "$(cat "$fixture_root/repo/state")" == stopped ]]
[[ "$(cat "$fixture_root/repo/log")" == $'check\nshutdown-failed\nshutdown' ]]

# A permanent cleanup failure has a bounded result. The wrapper fails, and the
# still-running daemon becomes the named trusted external service.
echo stopped > "$fixture_root/repo/state"
: > "$fixture_root/repo/log"
echo 99 > "$fixture_root/repo/shutdown-failures"
set +e
run_wrapper >/dev/null 2> "$fixture_root/repo/cleanup-error"
status=$?
set -e
[[ "$status" -eq 2 ]]
[[ "$(cat "$fixture_root/repo/state")" == running ]]
[[ "$(cat "$fixture_root/repo/log")" == $'check\nshutdown-failed\nshutdown-failed\nshutdown-failed' ]]
grep -q 'leaving it as the named trusted external service' \
  "$fixture_root/repo/cleanup-error"

echo stopped > "$fixture_root/repo/state"
: > "$fixture_root/repo/log"
echo 99 > "$fixture_root/repo/shutdown-failures"
ready_file="$fixture_root/repo/check-ready"
release_file="$fixture_root/repo/check-release"
finished_file="$fixture_root/repo/check-finished"
prepare_guardian_handshake
mkfifo "$handshake_signal_fifo"
exec 27<> "$handshake_signal_fifo"
exec 26< "$handshake_signal_fifo"
exec 25> "$handshake_signal_fifo"
exec 27>&-
rm -f "$handshake_signal_fifo"
node - \
  "$fixture_root/repo" \
  "$ready_file" \
  "$release_file" \
  "$finished_file" \
  "$handshake_pending" \
  "$handshake_done" 25>&25 26<&26 <<'EOF_NODE_CRASH' &
const { spawn } = require("node:child_process");
const {
  closeSync,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");

const [repo, ready, release, finished, pending, done] = process.argv.slice(2);
(async () => {
  const childStdio = Array(26).fill("ignore");
  childStdio[2] = "pipe";
  childStdio[25] = 25;
  const child = spawn(
    "/bin/bash",
    ["scripts/gate/trunk-check-once.sh", "--all"],
    {
      cwd: repo,
      env: {
        ...process.env,
        TRUNK_FIXTURE_READY_FILE: ready,
        TRUNK_FIXTURE_RELEASE_FILE: release,
        TRUNK_FIXTURE_FINISHED_FILE: finished,
        TRUNK_FIXTURE_START_AFTER_RELEASE: "1",
        AGENTQG_TRUNK_GUARDIAN_PENDING: pending,
        AGENTQG_TRUNK_GUARDIAN_DONE: done,
        AGENTQG_TRUNK_CHECK_TIMEOUT_SECONDS: "10",
        AGENTQG_TRUNK_GUARDIAN_SIGNAL_FD: "25",
      },
      stdio: childStdio,
    },
  );
  closeSync(25);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  for (let attempt = 0; attempt < 500 && !existsSync(ready); attempt += 1) {
    await delay(10);
  }
  if (!existsSync(ready)) throw new Error("Trunk crash fixture did not start");
  if (!child.kill("SIGKILL")) throw new Error("Trunk wrapper was not live");
  if (existsSync(done)) {
    throw new Error("Trunk wrapper published completion before guardian cleanup");
  }
  if (readFileSync(`${repo}/state`, "utf8").trim() !== "stopped") {
    throw new Error("the crash fixture started its daemon before wrapper death");
  }
  writeFileSync(release, "release\n");
  for (let attempt = 0; attempt < 500 && !existsSync(finished); attempt += 1) {
    await delay(10);
  }
  if (!existsSync(finished)) throw new Error("Trunk child did not settle");
  if (existsSync(done)) {
    throw new Error("Trunk guardian published completion before named cleanup");
  }
  // The guardian inherits this stderr pipe. `close` therefore proves the
  // orphaned guardian finished its bounded cleanup, not only that the killed
  // wrapper was reaped.
  await closed;
  if (readFileSync(pending, "utf8") !== "pending\n") {
    throw new Error("Trunk guardian changed the pending receipt");
  }
  if (readFileSync(done, "utf8") !== "done\n") {
    throw new Error("Trunk guardian did not publish the done receipt");
  }
  if ((lstatSync(done).mode & 0o7777) !== 0o400) {
    throw new Error("Trunk guardian done receipt has an unsafe mode");
  }
  const logPath = `${repo}/log`;
  if (
    readFileSync(logPath, "utf8") !==
    "check\nshutdown-failed\nshutdown-failed\nshutdown-failed\n"
  ) {
    throw new Error("Trunk guardian cleanup was not bounded to three attempts");
  }
  if (readFileSync(`${repo}/state`, "utf8").trim() !== "running") {
    throw new Error("Trunk guardian did not leave the failed daemon classified");
  }
  if (
    !stderr.includes(
      "handing remaining gate-owned descendants to exact mapped-command settlement",
    )
  ) {
    throw new Error("Trunk guardian did not report its exact-settlement handoff");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
EOF_NODE_CRASH
crash_test_pid=$!
exec 25>&-
wait "$crash_test_pid"
guardian_signal=""
IFS= read -r -t 2 guardian_signal <&26
exec 26<&-
[[ "$guardian_signal" == "done" ]]
[[ "$(cat "$fixture_root/repo/state")" == running ]]
[[ "$(cat "$fixture_root/repo/log")" == $'check\nshutdown-failed\nshutdown-failed\nshutdown-failed' ]]
cleanup_guardian_handshake

# A successor sees the live trusted service and does not claim or stop it.
: > "$fixture_root/repo/log"
run_wrapper >/dev/null
[[ "$(cat "$fixture_root/repo/state")" == running ]]
[[ "$(cat "$fixture_root/repo/log")" == check ]]

node - "$gate_script" "$source_script" <<'EOF_HANDSHAKE_CONTRACT'
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const [gatePath, wrapperPath] = process.argv.slice(2);
const gate = readFileSync(gatePath, "utf8");
const wrapper = readFileSync(wrapperPath, "utf8");
const runStart = gate.indexOf("run_with_timeout() {");
const runEnd = gate.indexOf("run_mapped_command() {", runStart);
const run = gate.slice(runStart, runEnd);
const pending = run.indexOf("gate_trunk_guardian_prepare_handshake");
const capabilityAnchor = run.indexOf('exec 27<> "$trunk_guardian_signal_fifo"');
const capabilityRead = run.indexOf('exec 26< "$trunk_guardian_signal_fifo"');
const capabilityWrite = run.indexOf('exec 25> "$trunk_guardian_signal_fifo"');
const capabilityUnlink = run.indexOf(
  '/bin/rm -f -- "$trunk_guardian_signal_fifo"',
);
const start = run.indexOf("printf '%s\\n' start >&20");
const parentWriteClose = run.indexOf("exec 25>&-", start);
const wait = run.indexOf("gate_trunk_guardian_wait_done", start);
const settlement = run.indexOf("gate_coordinator_begin_command_settlement", wait);
assert.ok(runStart >= 0 && runEnd > runStart);
assert.ok(pending >= 0 && pending < capabilityAnchor);
assert.ok(capabilityAnchor < capabilityRead && capabilityRead < capabilityWrite);
assert.ok(capabilityWrite < capabilityUnlink && capabilityUnlink < start);
assert.ok(start < parentWriteClose && parentWriteClose < wait);
assert.ok(wait < settlement);
assert.match(
  run.slice(wait, settlement),
  /exec 26<&-[\s\S]*trunk_guardian_signal_read_open=0/u,
);
assert.match(gate, /read -r -t 1 signal <&26[\s\S]*signal_status.*-lt 128/u);
assert.match(run, /exec 26<&-[\s\S]*eval "\$2"/u);
assert.match(
  wrapper,
  /stdio\[signalFd\] = "ignore";[\s\S]*spawnSync\("\.\/tools\/trunk"/u,
);
assert.match(wrapper, /\.\/tools\/trunk check --ci "\$@" 25>&-/u);
assert.match(
  wrapper,
  /renameSync\(temporaryPath, handshakeDone\);[\s\S]*writeSync\(signalFd, signal\)/u,
);
assert.match(wrapper, /exec 26<&-/u);
EOF_HANDSHAKE_CONTRACT

# The parent has no writer after START. If every publisher dies, the read side
# observes EOF immediately instead of waiting for the full command deadline.
worker_loss_fifo="$fixture_root/worker-loss.signal"
mkfifo "$worker_loss_fifo"
exec 27<> "$worker_loss_fifo"
exec 26< "$worker_loss_fifo"
exec 25> "$worker_loss_fifo"
exec 27>&-
rm -f "$worker_loss_fifo"
/bin/sleep 30 &
worker_loss_pid=$!
exec 25>&-
kill -KILL "$worker_loss_pid"
wait "$worker_loss_pid" 2>/dev/null || true
worker_loss_signal=""
set +e
IFS= read -r -t 2 worker_loss_signal <&26
worker_loss_status=$?
set -e
exec 26<&-
[[ "$worker_loss_status" -lt 128 ]]
[[ -z "$worker_loss_signal" ]]

echo "trunk one-shot lifecycle tests passed"
