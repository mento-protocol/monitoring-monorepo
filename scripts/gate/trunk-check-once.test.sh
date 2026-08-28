#!/bin/bash

set -euo pipefail

source_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/trunk-check-once.sh"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/agentqg-trunk-once-test.XXXXXX")"

cleanup() {
  rm -f "$fixture_root/repo/tools/trunk" \
    "$fixture_root/repo/scripts/gate/trunk-check-once.sh" \
    "$fixture_root/repo/state" "$fixture_root/repo/log" \
    "$fixture_root/repo/shutdown-failures" \
    "$fixture_root/repo/status-count" \
    "$fixture_root/repo/cleanup-error" \
    "$fixture_root/repo/check-ready" "$fixture_root/repo/check-release" \
    "$fixture_root/repo/check-finished"
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
    echo check >> "$log_file"
    if [[ "${TRUNK_FIXTURE_STARTS_DAEMON:-1}" != 0 &&
      "${TRUNK_FIXTURE_START_AFTER_RELEASE:-0}" == 0 ]]; then
      echo running > "$state_file"
    fi
    if [[ -n "${TRUNK_FIXTURE_READY_FILE:-}" ]]; then
      printf 'ready\n' > "$TRUNK_FIXTURE_READY_FILE"
      while [[ ! -e "${TRUNK_FIXTURE_RELEASE_FILE:?}" ]]; do
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
(
  exec 8< "$fixture_root/repo/state"
  exec 9< "$fixture_root/repo/state"
  AGENTQG_RUN=agentqg:trunk-marker-test \
    AGENTQG_MARKER_FDS=8,9 \
    run_wrapper >/dev/null
)
[[ "$(cat "$fixture_root/repo/state")" == stopped ]]
[[ "$(cat "$fixture_root/repo/log")" == $'check\nshutdown' ]]

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
run_wrapper >/dev/null
[[ "$(cat "$fixture_root/repo/state")" == running ]]
[[ "$(cat "$fixture_root/repo/log")" == check ]]

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
node - \
  "$fixture_root/repo" \
  "$ready_file" \
  "$release_file" \
  "$finished_file" <<'EOF_NODE_CRASH'
const { spawn } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");

const [repo, ready, release, finished] = process.argv.slice(2);
(async () => {
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
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
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
  if (readFileSync(`${repo}/state`, "utf8").trim() !== "stopped") {
    throw new Error("the crash fixture started its daemon before wrapper death");
  }
  writeFileSync(release, "release\n");
  // The guardian inherits this stderr pipe. `close` therefore proves the
  // orphaned guardian finished its bounded cleanup, not only that the killed
  // wrapper was reaped.
  await closed;
  for (let attempt = 0; attempt < 500 && !existsSync(finished); attempt += 1) {
    await delay(10);
  }
  if (!existsSync(finished)) throw new Error("Trunk child did not settle");
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
  if (!stderr.includes("leaving it as the named trusted external service")) {
    throw new Error("Trunk guardian did not report its bounded exception");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
EOF_NODE_CRASH
[[ "$(cat "$fixture_root/repo/state")" == running ]]
[[ "$(cat "$fixture_root/repo/log")" == $'check\nshutdown-failed\nshutdown-failed\nshutdown-failed' ]]

# A successor sees the live trusted service and does not claim or stop it.
: > "$fixture_root/repo/log"
run_wrapper >/dev/null
[[ "$(cat "$fixture_root/repo/state")" == running ]]
[[ "$(cat "$fixture_root/repo/log")" == check ]]

echo "trunk one-shot lifecycle tests passed"
