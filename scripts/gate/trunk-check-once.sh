#!/bin/bash

set -u

guardian_dir=""
guardian_pid=""

# Invoked indirectly by the EXIT trap below.
# shellcheck disable=SC2329
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$guardian_pid" ]]; then
    wait "$guardian_pid" || status=2
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

  node_bin="$(node -p 'process.execPath')" || return 2
  [[ "$node_bin" == /* && -x "$node_bin" && ! -L "$node_bin" ]] || return 2

  (
    exec "$node_bin" - \
      "$expected_parent_pid" \
      "$ready_file" \
      "$guardian_dir" \
      "$@" <<'EOF_TRUNK_GUARDIAN'
const { spawnSync } = require("node:child_process");
const {
  chmodSync,
  fstatSync,
  lstatSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");

const [expectedParentText, readyPath, guardianDir, ...checkArgs] =
  process.argv.slice(2);
const expectedParent = Number.parseInt(expectedParentText, 10);
const cleanupAttempts = 3;
const cleanupCommandTimeoutMs = 10_000;
const retryDelayMs = 1_000;

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
  const carriesGateIdentity = [
    process.env.AGENTQG_RUN,
    process.env.AGENTQG_REQUEST,
  ].some(
    (value) =>
      typeof value === "string" && /^agentqg:[A-Za-z0-9._:-]+$/u.test(value),
  );
  if (carriesGateIdentity) {
    const declaration = process.env.AGENTQG_MARKER_FDS ?? "";
    if (!/^(?:6|8|9)(?:,(?:6|8|9))*$/u.test(declaration)) {
      throw new Error("Trunk guardian has no valid gate marker declaration");
    }
    const descriptors = declaration.split(",").map(Number);
    if (new Set(descriptors).size !== descriptors.length) {
      throw new Error("Trunk guardian gate marker declaration is duplicated");
    }
    const descriptorStates = descriptors.map((descriptor) => {
      try {
        return { descriptor, regular: fstatSync(descriptor).isFile() };
      } catch (error) {
        return { descriptor, error, regular: false };
      }
    });
    const unexpectedError = descriptorStates.find(
      ({ error }) => error && error.code !== "EBADF",
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
    const allStale = !descriptorStates.some(({ regular }) => regular);
    if (process.platform !== "darwin" || !allStale) {
      for (const { descriptor, error, regular } of descriptorStates) {
        if (error) {
          throw new Error(`Trunk guardian marker ${descriptor} is not open`, {
            cause: error,
          });
        }
        if (!regular) {
          throw new Error(`Trunk guardian marker ${descriptor} is not regular`);
        }
      }
    }
    if (!allStale) {
      for (const { descriptor } of descriptorStates) {
        while (stdio.length <= descriptor) stdio.push("ignore");
        stdio[descriptor] = descriptor;
      }
    }
  }
  const options = {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio,
    killSignal: "SIGKILL",
  };
  if (timeout !== null) options.timeout = timeout;
  return spawnSync("./tools/trunk", args, options);
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

async function stopOwnedDaemon() {
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
  throw new Error(
    `could not confirm Trunk daemon shutdown after ${cleanupAttempts} attempts; leaving it as the named trusted external service: ${lastError}`,
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
  writeFileSync(readyPath, "ready\n", { flag: "wx", mode: 0o400 });
  chmodSync(readyPath, 0o400);
  const check = trunk(
    ["check", "--ci", ...checkArgs],
    ["inherit", "inherit", "inherit"],
    null,
  );
  let checkStatus = check.status;
  if (check.error || !Number.isInteger(checkStatus)) {
    console.error(
      `error: gate-owned Trunk check did not return a status: ${check.error?.message ?? `signal ${check.signal ?? "unknown"}`}`,
    );
    checkStatus = 2;
  }
  try {
    await stopOwnedDaemon();
    process.exitCode = checkStatus;
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 2;
  } finally {
    removePrivateState();
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
  node <<'EOF_TRUNK_STATUS'
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
  wait "$guardian_pid"
  check_status=$?
  guardian_pid=""
else
  ./tools/trunk check --ci "$@"
  check_status=$?
fi

# A daemon that existed before the gate is a named trusted external service.
# A daemon started from the stopped state is gate-owned. The direct guardian
# owns the check child, then shuts down the daemon after normal exit or hard
# wrapper death. The guardian keeps the mapped command lineage live until the
# check and shutdown complete, so the coordinator retains the `trunk-daemon`
# resource through crash recovery.
final_state="$(trunk_daemon_state)" || {
  echo "error: could not classify the Trunk daemon after the check." >&2
  exit 2
}
if [[ "$initial_state" == stopped && "$final_state" != stopped ]]; then
  echo "error: gate-owned Trunk daemon remained live after bounded cleanup; leaving it as the named trusted external service." >&2
  exit 2
fi

exit "$check_status"
