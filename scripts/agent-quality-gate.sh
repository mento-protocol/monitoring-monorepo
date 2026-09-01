#!/bin/bash -p
unset BASH_ENV ENV BASH_COMPAT CDPATH GLOBIGNORE
set +o posix
unset POSIXLY_CORRECT POSIX_PEDANTIC
set -euo pipefail
# Bash `-p` blocks startup files, imported functions, and inherited shell
# options. The explicit reset above also removes startup controls that Bash can
# still import or use after startup. It runs before path resolution or parsing.

gate_start_ts="$(date +%s)"

usage() {
  cat <<'USAGE'
Usage: scripts/agent-quality-gate.sh [--dry-run|--run] [--base <ref>] [--head <ref>] [--changed-paths-file <file>] [--allow-package-script-changes] [--fail-fast|--keep-going] [--skip-if-fresh] [--pre-push] [--parallel <n>] [--full-local-tests]

Maps changed paths to the local commands and PR checklists an agent should run
before opening or updating a PR. Defaults to dry-run.

Options:
  --dry-run      Print the mapped commands/checklists without running them.
  --run          Execute the mapped safe local commands.
  --base <ref>   Base ref for changed-path detection. Default: origin/main.
  --head <ref>   Head ref for changed-path detection. Default: HEAD.
  --changed-paths-file <file>
                 Read changed paths from a newline-delimited file instead of git.
  --allow-package-script-changes
                 With --run, acknowledge that changed package manifests may
                 alter lifecycle/package scripts before they execute.
  --fail-fast    With --run, stop after the first failed mapped command.
  --keep-going   With --run, continue after failures and report the total.
  --skip-if-fresh
                 With --run, skip execution when the previous successful run
                 used the same base, changed paths, command plan, gate
                 implementation, validated file content, toolchain, material
                 environment, runtime, and scheduler policy. Intended for the
                 pre-push hook only.
  --pre-push     Mark this invocation as the git pre-push hook. Hosted setup
                 uses this to refuse a cold gate inside a blocking git push.
  --parallel <n> With --run, execute independent quality commands with up to
                 n concurrent jobs. Default: auto, capped at 4. Fail-fast mode
                 stays sequential so it still stops before starting the next
                 mapped command.
  --full-local-tests
                 Force full per-package `test:coverage` locally instead of the
                 scoped `vitest related` optimization. CI always runs the full
                 coverage floors regardless of this flag.
  --command-timeout <n>
                 With --run, kill any single mapped command that runs longer
                 than n seconds and report it as a failure. Default: 1500. The
                 gate self-test uses 2100 unless this option overrides it. A
                 timeout is per command, never for the whole run.
  --lock-wait <n>
                 With --run, wait at most n seconds for scheduler admission,
                 a command lease, a coalesced result, or a legacy holder.
                 Default: 1800.
  --no-lock      With --run, bypass the scheduler and legacy compatibility
                 lock. Mapped commands then run without machine coordination.
  -h, --help     Show this help.

Environment:
  AGENT_QUALITY_BASE  Override the default base ref.
  AGENT_QUALITY_HEAD  Override the default head ref.
  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES
                      Same acknowledgement as --allow-package-script-changes
                      when set to 1 or true.
  AGENT_QUALITY_FAIL_FAST
                      Same behavior as --fail-fast when set to 1 or true.
  AGENT_QUALITY_PARALLELISM
                      Same behavior as --parallel. Use auto for the default.
  AGENT_GATE_FULL_TESTS
                      Same behavior as --full-local-tests when set to 1 or true.
  AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS
                      Same behavior as --command-timeout. Default: 1500; an
                      explicit value also overrides the 2100-second gate
                      self-test default.
  AGENT_QUALITY_GATE_LOCK
                      Set to 0 or false for the same effect as --no-lock.
  AGENT_QUALITY_GATE_LOCK_WAIT_SECONDS
                      Same behavior as --lock-wait. Default: 1800.
  AGENT_QUALITY_GATE_COORDINATOR
                      Internal compatibility switch. Set to 0, false, or no
                      only in legacy-lock tests. The serialized lock remains.
  AGENT_QUALITY_GATE_CAPACITY
                      Global coordinator capacity. Default: 3. Range: 1-64.
  AGENT_QUALITY_GATE_LOCK_DIR
                      Directory holding the cross-run lock. Default:
                      $HOME/.cache/agent-quality-gate, falling back to
                      $TMPDIR/agent-quality-gate-<uid>. Give each machine its
                      own: on a root the filesystem reports as network storage
                      the gate reclaims nothing, so a lock left behind there is
                      waited out rather than healed.
  AGENT_QUALITY_GATE_LOCK_MACHINE_ID
                      Names the machine a lock record belongs to, in place of
                      the hardware identity the gate reads for itself. Set it
                      where that identity is unreadable and the lock root is
                      shared between machines.
  AGENT_QUALITY_GATE_LOCK_UNVERIFIED_MACHINE_GRACE_SECONDS
                      How old a lock record whose machine cannot be
                      established must be before a dead holder in it is
                      reclaimed. Default: 600.
  AGENT_QUALITY_GATE_LOCK_DIR_IS_PER_MACHINE
                      Declares whether only this machine reaches the lock root,
                      in place of what the filesystem says about it. Unset,
                      every root is asked of the filesystem (df -l), and off
                      local storage no lock record is reclaimed at all; on
                      local storage a record that cannot be tied to this
                      machine is reclaimed only where the root is not an
                      AGENT_QUALITY_GATE_LOCK_DIR, which is assumed shared. Set
                      1 for a directory this machine alone reaches; set 0 where
                      this machine exports the lock root and another machine's
                      gate locks in it.
USAGE
}

mode="dry-run"
base_ref="${AGENT_QUALITY_BASE:-origin/main}"
head_ref="${AGENT_QUALITY_HEAD:-HEAD}"
changed_paths_input_file=""
allow_package_script_changes="${AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES:-}"
fail_fast="${AGENT_QUALITY_FAIL_FAST:-false}"
skip_if_fresh="${AGENT_QUALITY_SKIP_IF_FRESH:-false}"
pre_push="false"
quality_parallelism="${AGENT_QUALITY_PARALLELISM:-auto}"
full_local_tests="${AGENT_GATE_FULL_TESTS:-false}"
# The gate self-test is the only mapped command that needs more than the
# ordinary 1500-second watchdog. The current exact-head suite passed in 1710
# seconds after the old watchdog stopped an earlier run at 1504 seconds. Give
# that command 390 seconds of measured headroom. An explicit global override
# still applies to every command, including the self-test.
command_timeout_overridden=false
if [[ -n "${AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS:-}" ]]; then
  command_timeout_overridden=true
fi
command_timeout_seconds="${AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS:-1500}"
gate_selftest_timeout_seconds=2100
gate_lock_enabled="${AGENT_QUALITY_GATE_LOCK:-1}"
gate_coordinator_enabled="${AGENT_QUALITY_GATE_COORDINATOR-1}"
gate_coordinator_capacity="${AGENT_QUALITY_GATE_CAPACITY-3}"
if [[ ! "$gate_coordinator_capacity" =~ ^(0|[1-9][0-9]*)$ ||
  "$gate_coordinator_capacity" -lt 1 ||
  "$gate_coordinator_capacity" -gt 64 ]]; then
  echo "error: AGENT_QUALITY_GATE_CAPACITY must be an integer from 1 through 64." >&2
  exit 2
fi
case "$gate_coordinator_enabled" in
  0|false|no|1|true|yes) ;;
  *)
    echo "error: AGENT_QUALITY_GATE_COORDINATOR must be 0, false, no, 1, true, or yes." >&2
    exit 2
    ;;
esac

# The coordinator reserves fd 7 as the original stdout before it can enter a
# no-work failure path. Legacy runs never reserve it. This guard lets shared
# legacy-drain helpers report a coordinated refusal without changing their
# legacy output contract or failing when the descriptor is closed.
gate_coordinator_stdout_reserved=0
gate_report_coordinated_no_work_failure() {
  local status="$1" phase="$2" work_verdict="$3"
  declare -F gate_coordinator_report_no_work_failure >/dev/null 2>&1 || return 0
  if [[ "$gate_coordinator_stdout_reserved" -eq 1 ]] &&
    { : >&7; } 2>/dev/null; then
    gate_coordinator_report_no_work_failure "$status" "$phase" "$work_verdict"
  fi
}

# Reads one of the lock's tunable numbers. An override that is set but EMPTY is
# an error rather than a silent fall back to the default: `${VAR:-default}`
# treats empty and unset alike, so a caller that meant to pass a small test
# value and passed nothing would quietly get the production one — which is
# exactly how a fixture ends up holding a thirty-minute budget. Unset means the
# default; empty means somebody's argument went missing, and that should say so
# rather than look like it worked.
gate_lock_seconds_knob() {
  local name="$1"
  local default="$2"
  local value
  eval "value=\${${name}-__gate_unset__}"
  if [[ "$value" == "__gate_unset__" ]]; then
    printf '%s' "$default"
    return 0
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "error: ${name} must be a whole number of seconds; got '${value}'." >&2
    echo "Unset it to use the default (${default})." >&2
    exit 2
  fi
  printf '%s' "$value"
}

gate_lock_wait_seconds="$(gate_lock_seconds_knob AGENT_QUALITY_GATE_LOCK_WAIT_SECONDS 1800)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      mode="dry-run"
      shift
      ;;
    --run)
      mode="run"
      shift
      ;;
    --base)
      base_ref="${2:-}"
      if [[ -z "$base_ref" ]]; then
        echo "error: --base requires a ref" >&2
        exit 2
      fi
      shift 2
      ;;
    --head)
      head_ref="${2:-}"
      if [[ -z "$head_ref" ]]; then
        echo "error: --head requires a ref" >&2
        exit 2
      fi
      shift 2
      ;;
    --changed-paths-file)
      changed_paths_input_file="${2:-}"
      if [[ -z "$changed_paths_input_file" ]]; then
        echo "error: --changed-paths-file requires a file path" >&2
        exit 2
      fi
      shift 2
      ;;
    --allow-package-script-changes)
      allow_package_script_changes="true"
      shift
      ;;
    --fail-fast)
      fail_fast="true"
      shift
      ;;
    --keep-going)
      fail_fast="false"
      shift
      ;;
    --skip-if-fresh)
      skip_if_fresh="true"
      shift
      ;;
    --pre-push)
      pre_push="true"
      shift
      ;;
    --full-local-tests)
      full_local_tests="true"
      shift
      ;;
    --command-timeout)
      command_timeout_seconds="${2:-}"
      if [[ -z "$command_timeout_seconds" ]]; then
        echo "error: --command-timeout requires a positive integer" >&2
        exit 2
      fi
      command_timeout_overridden=true
      shift 2
      ;;
    --lock-wait)
      gate_lock_wait_seconds="${2:-}"
      if [[ -z "$gate_lock_wait_seconds" ]]; then
        echo "error: --lock-wait requires a non-negative integer" >&2
        exit 2
      fi
      shift 2
      ;;
    --no-lock)
      gate_lock_enabled="0"
      shift
      ;;
    --parallel|--jobs)
      quality_parallelism="${2:-}"
      if [[ -z "$quality_parallelism" ]]; then
        echo "error: $1 requires a positive integer" >&2
        exit 2
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

auto_quality_parallelism() {
  local cpu_count
  cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
  if [[ ! "$cpu_count" =~ ^[0-9]+$ || "$cpu_count" -lt 1 ]]; then
    cpu_count="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  fi
  if [[ ! "$cpu_count" =~ ^[0-9]+$ || "$cpu_count" -lt 1 ]]; then
    cpu_count=2
  fi
  if [[ "$cpu_count" -gt 4 ]]; then
    echo 4
  else
    echo "$cpu_count"
  fi
}

if [[ "$quality_parallelism" == "auto" ]]; then
  quality_parallelism="$(auto_quality_parallelism)"
fi

if [[ ! "$quality_parallelism" =~ ^[0-9]+$ || "$quality_parallelism" -lt 1 ]]; then
  echo "error: --parallel requires a positive integer" >&2
  exit 2
fi

if [[ ! "$command_timeout_seconds" =~ ^[0-9]+$ || "$command_timeout_seconds" -lt 1 ]]; then
  echo "error: --command-timeout requires a positive integer" >&2
  exit 2
fi
if [[ "$command_timeout_overridden" == true ]]; then
  gate_selftest_timeout_seconds="$command_timeout_seconds"
fi

if [[ ! "$gate_lock_wait_seconds" =~ ^[0-9]+$ ]]; then
  echo "error: --lock-wait requires a non-negative integer" >&2
  exit 2
fi

# Resolve runtime helpers from this script's checkout before fixture runs change
# directory. A $repo_root anchor would miss them in every temporary fixture repo.
script_source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run_handles_path="$script_source_dir/gate/run-handles.sh"
if [[ -L "$run_handles_path" || ! -f "$run_handles_path" || ! -r "$run_handles_path" ]]; then
  echo "error: gate run-handle helper is missing or not a readable regular file: ${run_handles_path}" >&2
  echo "Nothing has been executed." >&2
  exit 2
fi
# shellcheck source=scripts/gate/run-handles.sh
source "$run_handles_path"

darwin_lineage_path="$script_source_dir/gate/darwin-process-lineage.sh"
if [[ -L "$darwin_lineage_path" || ! -f "$darwin_lineage_path" || ! -r "$darwin_lineage_path" ]]; then
  echo "error: Darwin process-lineage helper is missing or not a readable regular file: ${darwin_lineage_path}" >&2
  echo "Nothing has been executed." >&2
  exit 2
fi
# shellcheck source=scripts/gate/darwin-process-lineage.sh
source "$darwin_lineage_path"
if ! gate_darwin_lineage_classify_host; then
  echo "Nothing has been executed." >&2
  exit 2
fi

darwin_broker_preflight_path="$script_source_dir/gate/darwin-broker-launch-preflight.mjs"
if [[ -L "$darwin_broker_preflight_path" ||
  ! -f "$darwin_broker_preflight_path" ||
  ! -r "$darwin_broker_preflight_path" ]]; then
  echo "error: Darwin broker preflight is missing or not a readable regular file: ${darwin_broker_preflight_path}" >&2
  echo "Nothing has been executed." >&2
  exit 2
fi
darwin_broker_preflight_bound=0
darwin_broker_preflight_binding=""

gate_darwin_broker_preflight_bind() {
  local host_status copy_dir copy_path initial_binding bound_binding
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
  [[ "$darwin_broker_preflight_bound" -eq 0 ]] || return 2
  gate_darwin_node_runtime_prepare || return 2
  copy_dir="$(mktemp -d "$scratch_dir/darwin-broker-preflight.XXXXXX")" ||
    return 2
  copy_path="$copy_dir/preflight.mjs"
  if ! chmod 700 "$copy_dir"; then
    rmdir "$copy_dir" 2>/dev/null || true
    return 2
  fi
  initial_binding="$({
    "$gate_darwin_node_bin" -e '
      const {
        closeSync,
        constants,
        fstatSync,
        fsyncSync,
        lstatSync,
        openSync,
        readSync,
        writeSync,
      } = require("node:fs");
      const { createHash } = require("node:crypto");

      const sourcePath = process.argv[1];
      const destinationPath = process.argv[2];
      const destinationDirectory = process.argv[3];
      const maximumBytes = 1024 * 1024;
      const fields = [
        "dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size",
        "mtimeNs", "ctimeNs",
      ];
      const snapshot = (stat) => Object.fromEntries(
        fields.map((field) => [field, stat[field].toString()]),
      );
      const same = (left, right) => fields.every(
        (field) => left[field] === right[field],
      );
      const fail = (message) => { throw new Error(message); };
      const readPositionally = (descriptor, size) => {
        const length = Number(size);
        if (!Number.isSafeInteger(length) || length < 1 || length > maximumBytes) {
          fail("helper size is outside the stable snapshot limit");
        }
        const bytes = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          const count = readSync(descriptor, bytes, offset, length - offset, offset);
          if (count === 0) fail("helper ended before its recorded size");
          offset += count;
        }
        return bytes;
      };
      const directory = lstatSync(destinationDirectory, { bigint: true });
      if (!directory.isDirectory() || directory.isSymbolicLink() ||
          directory.uid !== BigInt(process.getuid()) ||
          (directory.mode & 0o7777n) !== 0o700n) {
        fail("private helper snapshot directory is unsafe");
      }
      const pathBefore = lstatSync(sourcePath, { bigint: true });
      const source = openSync(
        sourcePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let bytes;
      let sourceBefore;
      try {
        sourceBefore = fstatSync(source, { bigint: true });
        if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink() ||
            sourceBefore.uid !== BigInt(process.getuid()) ||
            sourceBefore.nlink !== 1n || (sourceBefore.mode & 0o22n) !== 0n ||
            !same(snapshot(sourceBefore), snapshot(pathBefore))) {
          fail("helper source is not one stable private regular file");
        }
        bytes = readPositionally(source, sourceBefore.size);
        const sourceAfter = fstatSync(source, { bigint: true });
        const pathAfter = lstatSync(sourcePath, { bigint: true });
        if (!same(snapshot(sourceBefore), snapshot(sourceAfter)) ||
            !same(snapshot(sourceBefore), snapshot(pathAfter))) {
          fail("helper source changed while it was copied");
        }
      } finally {
        closeSync(source);
      }
      const destination = openSync(
        destinationPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o400,
      );
      try {
        let offset = 0;
        while (offset < bytes.length) {
          offset += writeSync(
            destination,
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
        }
        fsyncSync(destination);
      } finally {
        closeSync(destination);
      }
      const copied = lstatSync(destinationPath, { bigint: true });
      if (!copied.isFile() || copied.isSymbolicLink() ||
          copied.uid !== BigInt(process.getuid()) || copied.nlink !== 1n ||
          (copied.mode & 0o7777n) !== 0o400n || copied.size !== BigInt(bytes.length)) {
        fail("private helper snapshot is unsafe");
      }
      process.stdout.write(JSON.stringify({
        source: snapshot(sourceBefore),
        copy: snapshot(copied),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }));
    ' "$darwin_broker_preflight_path" "$copy_path" "$copy_dir"
  } 2>/dev/null)" || {
    rm -f "$copy_path" 2>/dev/null || true
    rmdir "$copy_dir" 2>/dev/null || true
    echo "error: could not create one stable Darwin broker preflight snapshot." >&2
    return 2
  }
  if ! exec 24< "$copy_path"; then
    rm -f "$copy_path" 2>/dev/null || true
    rmdir "$copy_dir" 2>/dev/null || true
    echo "error: could not retain the Darwin broker preflight snapshot." >&2
    return 2
  fi
  bound_binding="$({
    "$gate_darwin_node_bin" -e '
      const {
        fstatSync,
        lstatSync,
        readSync,
        rmdirSync,
        unlinkSync,
      } = require("node:fs");
      const { createHash } = require("node:crypto");

      const descriptor = 24;
      const copyPath = process.argv[1];
      const copyDirectory = process.argv[2];
      const binding = JSON.parse(process.argv[3]);
      const fields = [
        "dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size",
        "mtimeNs", "ctimeNs",
      ];
      const snapshot = (stat) => Object.fromEntries(
        fields.map((field) => [field, stat[field].toString()]),
      );
      const same = (left, right) => fields.every(
        (field) => left[field] === right[field],
      );
      const fail = (message) => { throw new Error(message); };
      const before = fstatSync(descriptor, { bigint: true });
      const path = lstatSync(copyPath, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() ||
          !same(snapshot(before), binding.copy) ||
          !same(snapshot(path), binding.copy)) {
        fail("opened helper snapshot does not match its private path");
      }
      const length = Number(before.size);
      const bytes = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const count = readSync(descriptor, bytes, offset, length - offset, offset);
        if (count === 0) fail("opened helper snapshot ended early");
        offset += count;
      }
      if (createHash("sha256").update(bytes).digest("hex") !== binding.sha256) {
        fail("opened helper snapshot hash changed");
      }
      unlinkSync(copyPath);
      rmdirSync(copyDirectory);
      const after = fstatSync(descriptor, { bigint: true });
      if (!after.isFile() || after.nlink !== 0n ||
          after.dev.toString() !== binding.copy.dev ||
          after.ino.toString() !== binding.copy.ino ||
          after.uid.toString() !== binding.copy.uid ||
          after.gid.toString() !== binding.copy.gid ||
          after.mode.toString() !== binding.copy.mode ||
          after.size.toString() !== binding.copy.size) {
        fail("unlinked helper snapshot identity changed");
      }
      binding.copy = snapshot(after);
      process.stdout.write(JSON.stringify(binding));
    ' "$copy_path" "$copy_dir" "$initial_binding"
  } 2>/dev/null)" || {
    exec 24<&-
    rm -f "$copy_path" 2>/dev/null || true
    rmdir "$copy_dir" 2>/dev/null || true
    echo "error: could not bind the Darwin broker preflight snapshot." >&2
    return 2
  }
  darwin_broker_preflight_binding="$bound_binding"
  darwin_broker_preflight_bound=1
}

gate_darwin_broker_preflight() {
  local host_status
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0)
      [[ "$darwin_broker_preflight_bound" -eq 1 &&
        -n "$darwin_broker_preflight_binding" ]] || return 2
      # The embedded module is literal source. Shell expansion would corrupt it.
      # shellcheck disable=SC2016
      "$gate_darwin_node_bin" --input-type=module -e '
        import { createHash } from "node:crypto";
        import {
          closeSync,
          constants,
          fstatSync,
          lstatSync,
          openSync,
          readSync,
        } from "node:fs";

        const sourcePath = process.argv[1];
        const binding = JSON.parse(process.argv[2]);
        const root = process.argv[3];
        const policyRoot = process.argv[4];
        const fields = [
          "dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size",
          "mtimeNs", "ctimeNs",
        ];
        const snapshot = (stat) => Object.fromEntries(
          fields.map((field) => [field, stat[field].toString()]),
        );
        const same = (left, right) => fields.every(
          (field) => left[field] === right[field],
        );
        const fail = (message) => { throw new Error(message); };
        const readPositionally = (descriptor, size) => {
          const length = Number(size);
          if (!Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024) {
            fail("helper size is outside the stable snapshot limit");
          }
          const bytes = Buffer.alloc(length);
          let offset = 0;
          while (offset < length) {
            const count = readSync(descriptor, bytes, offset, length - offset, offset);
            if (count === 0) fail("helper snapshot ended early");
            offset += count;
          }
          return bytes;
        };
        const stableSource = () => {
          const pathBefore = lstatSync(sourcePath, { bigint: true });
          const descriptor = openSync(
            sourcePath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const before = fstatSync(descriptor, { bigint: true });
            if (!before.isFile() || before.isSymbolicLink() ||
                !same(snapshot(before), binding.source) ||
                !same(snapshot(pathBefore), binding.source)) {
              fail("helper source identity changed after binding");
            }
            const bytes = readPositionally(descriptor, before.size);
            const after = fstatSync(descriptor, { bigint: true });
            const pathAfter = lstatSync(sourcePath, { bigint: true });
            if (!same(snapshot(before), snapshot(after)) ||
                !same(snapshot(before), snapshot(pathAfter)) ||
                createHash("sha256").update(bytes).digest("hex") !== binding.sha256) {
              fail("helper source bytes changed after binding");
            }
          } finally {
            closeSync(descriptor);
          }
        };
        try {
          stableSource();
          const before = fstatSync(24, { bigint: true });
          if (!before.isFile() || before.nlink !== 0n ||
              !same(snapshot(before), binding.copy)) {
            fail("bound helper descriptor identity changed");
          }
          const bytes = readPositionally(24, before.size);
          const after = fstatSync(24, { bigint: true });
          if (!same(snapshot(before), snapshot(after)) ||
              createHash("sha256").update(bytes).digest("hex") !== binding.sha256) {
            fail("bound helper descriptor bytes changed");
          }
          const moduleUrl = `data:text/javascript;base64,${bytes.toString("base64")}`;
          const policy = await import(moduleUrl);
          if (typeof policy.runDarwinBrokerPreflight !== "function") {
            fail("bound helper exports no preflight runner");
          }
          const status = policy.runDarwinBrokerPreflight(root, policyRoot);
          if (!Number.isInteger(status) || (status !== 0 && status !== 2)) {
            fail("bound helper returned an invalid status");
          }
          process.exitCode = status;
        } catch (error) {
          console.error(`error: bound Darwin broker preflight: ${error.message}`);
          process.exitCode = 2;
        }
      ' "$darwin_broker_preflight_path" "$darwin_broker_preflight_binding" \
        "$repo_root" "$script_source_dir/.."
      ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
}

gate_lifecycle_contract_for_host() {
  local host_status
  if gate_darwin_lineage_host_is_darwin; then
    host_status=0
  else
    host_status=$?
  fi
  case "$host_status" in
    0) printf '%s\n' "darwin-coherent-lineage-v2" ;;
    1) printf '%s\n' "portable-marker-v1" ;;
    *) return 2 ;;
  esac
}

gate_lifecycle_contract_is_supported() {
  case "${1:-}" in
    darwin-coherent-lineage-v2|portable-marker-v1) return 0 ;;
    *) return 1 ;;
  esac
}

gate_recovery_lifecycle_contract_is_supported() {
  gate_lifecycle_contract_is_supported "${1:-}" && return 0
  case "${1:-}" in
    darwin-unique-lineage-v1|request-marker-empty-v1) return 0 ;;
    *) return 1 ;;
  esac
}

gate_host_lifecycle_contract="$(gate_lifecycle_contract_for_host)" || {
  echo "error: could not select a mapped-command lifecycle contract." >&2
  echo "Nothing has been executed." >&2
  exit 2
}

# Caller-controlled Bash startup state, Git controls, and test-only validator
# injections must not affect a parent Git probe, internal control shell, or the
# mapped-command tree. Keep every ordinary environment value, but remove
# startup files, inherited option sets, compatibility controls, Git controls,
# test overrides, and exported function records. Privileged mode makes the
# receiving Bash ignore the same startup controls while it starts. The filtered
# environment then propagates to every mapped-command descendant. Prepare this
# launcher before the first Git probe so parent and mapped commands use the same
# policy. Legacy and explicit no-lock runs also use this boundary.
if [[ ! -x /usr/bin/env || ! -x /usr/bin/awk || ! -x /bin/bash ]]; then
  echo "error: the quality gate requires /usr/bin/env, /usr/bin/awk, and /bin/bash." >&2
  exit 2
fi
gate_sanitized_bash_launcher=(
  /usr/bin/env
  -u BASH_ENV
  -u ENV
  -u SHELLOPTS
  -u BASHOPTS
  -u BASH_COMPAT
  -u CDPATH
  -u GLOBIGNORE
  -u POSIXLY_CORRECT
  -u POSIX_PEDANTIC
)
gate_environment_helper="$script_source_dir/gate/quality-gate-coordinator-environment.mjs"
if [[ -L "$gate_environment_helper" || ! -f "$gate_environment_helper" ||
  ! -r "$gate_environment_helper" ]]; then
  echo "error: the quality-gate environment policy is unavailable: ${gate_environment_helper}" >&2
  exit 2
fi
gate_scrub_environment_scan_complete=0
gate_mapped_child_scrub_policy_hash=""
while IFS= read -r -d '' gate_scrub_environment_name; do
  if [[ "$gate_scrub_environment_name" == agent-quality-gate-scrub-end ]]; then
    gate_scrub_environment_scan_complete=1
    continue
  fi
  if [[ "$gate_scrub_environment_name" == agent-quality-gate-scrub-policy=* ]]; then
    [[ -z "$gate_mapped_child_scrub_policy_hash" ]] || {
      echo "error: the quality-gate environment policy returned duplicate identity." >&2
      exit 2
    }
    gate_mapped_child_scrub_policy_hash="${gate_scrub_environment_name#*=}"
    continue
  fi
  gate_sanitized_bash_launcher+=(
    -u "$gate_scrub_environment_name"
  )
  if [[ "$gate_scrub_environment_name" == GIT_* ]]; then
    unset "$gate_scrub_environment_name"
  fi
done < <(
  node "$gate_environment_helper" --mapped-child-scrubbed-names
)
if [[ "$gate_scrub_environment_scan_complete" -ne 1 ||
  ! "$gate_mapped_child_scrub_policy_hash" =~ ^[a-f0-9]{64}$ ]]; then
  echo "error: could not inspect caller controls for the quality gate." >&2
  exit 2
fi
gate_bash_environment_scan_complete=0
while IFS= read -r -d '' gate_bash_environment_record; do
  if [[ "$gate_bash_environment_record" == agent-quality-gate-env-end ]]; then
    gate_bash_environment_scan_complete=1
    continue
  fi
  [[ "$gate_bash_environment_record" == *=* ]] || continue
  gate_bash_environment_name="${gate_bash_environment_record%%=*}"
  gate_bash_environment_value="${gate_bash_environment_record#*=}"
  case "$gate_bash_environment_name" in
    BASH_FUNC_*%%|BASH_FUNC_*'()')
      gate_sanitized_bash_launcher+=(
        -u "$gate_bash_environment_name"
      )
      ;;
    *)
      if [[ "$gate_bash_environment_name" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ &&
        "$gate_bash_environment_value" == '() {'* ]]; then
        gate_sanitized_bash_launcher+=(
          -u "$gate_bash_environment_name"
        )
      fi
      ;;
  esac
done < <(
  set -- "${LC_ALL+x}" "${LC_ALL-}"
  LC_ALL=C /usr/bin/env \
    "agent-quality-gate-env-scan-lc-all-set=$1" \
    "agent-quality-gate-env-scan-lc-all-value=$2" \
    /usr/bin/awk '
    BEGIN {
      for (name in ENVIRON) {
        if (name == "LC_ALL" ||
            name == "agent-quality-gate-env-scan-lc-all-set" ||
            name == "agent-quality-gate-env-scan-lc-all-value") {
          continue
        }
        printf "%s=%s%c", name, ENVIRON[name], 0
      }
      if (ENVIRON["agent-quality-gate-env-scan-lc-all-set"] != "") {
        printf "LC_ALL=%s%c", \
          ENVIRON["agent-quality-gate-env-scan-lc-all-value"], 0
      }
      printf "%s%c", "agent-quality-gate-env-end", 0
    }
  '
)
if [[ "$gate_bash_environment_scan_complete" -ne 1 ]]; then
  echo "error: could not inspect Bash startup controls for the quality gate." >&2
  exit 2
fi
# Terraform must not inherit a CLI configuration with provider development
# overrides, an external provider reattachment, or a checksum-breaking cache
# policy. /dev/null is a fixed empty CLI configuration. The mapped launcher
# also removes TF_PLUGIN_CACHE_DIR because Terraform can install cached
# providers through symlinks, which this narrow provider attestation rejects.
gate_sanitized_bash_launcher+=(
  TF_CLI_CONFIG_FILE=/dev/null
  /bin/bash -p
)
unset gate_bash_environment_record gate_bash_environment_name
unset gate_bash_environment_value gate_bash_environment_scan_complete
unset gate_environment_helper gate_scrub_environment_name
unset gate_scrub_environment_scan_complete

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
if [[ -z "$allow_package_script_changes" ]]; then
  allow_package_script_changes="$(git config --bool --get agent.qualityGate.allowPackageScriptChanges 2>/dev/null || true)"
fi

# Use a repo-local scratch dir for tmpfiles so we don't depend on TMPDIR
# being writable — pre-push hooks fork off trunk's daemon, which may carry
# a TMPDIR that's outside a host sandbox's writable allowlist. Select and
# export the effective directory before the coordinator adapter copy so the
# default coordinator and dry-run paths use the same validated fallback.
# Mapped subprocesses (e.g. agent-quality-gate.test.sh's bare `mktemp -d`)
# inherit this path instead of falling back to an unwritable system default.
scratch_dir="$repo_root/.tmp/agent-quality-gate"
mkdir -p "$scratch_dir"
if [[ -L "$scratch_dir" || ! -d "$scratch_dir" || ! -O "$scratch_dir" ]] ||
  ! chmod 700 "$scratch_dir"; then
  echo "error: quality-gate scratch is not a private current-user directory: ${scratch_dir}" >&2
  echo "Nothing has been executed." >&2
  exit 2
fi
# Avoid overriding a usable TMPDIR: Terraform providers use go-plugin grpc on
# a socket in TMPDIR, and repo-local paths can be blocked by agent seatbelts.
# Trunk hooks can strip TMPDIR entirely, so prefer the system temp directory
# before falling back to the repo scratch dir.
tmpdir_candidate="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"
if [[ -d "$tmpdir_candidate" && -w "$tmpdir_candidate" ]]; then
  export TMPDIR="$tmpdir_candidate"
else
  export TMPDIR="$scratch_dir"
fi

# Print the current changed-path set. Capture each Git probe before printing
# any output so one failed probe cannot be hidden by a later successful probe.
collect_current_changed_paths() {
  local committed_paths unstaged_paths staged_paths untracked_paths
  if [[ -n "$changed_paths_input_file" ]]; then
    sed '/^$/d' "$changed_paths_input_file"
    return
  fi
  if ! committed_paths="$(git diff --name-only --no-renames "${base_ref}...${head_ref}" 2>/dev/null)"; then
    committed_paths="$(git diff --name-only --no-renames "$base_ref" "$head_ref")" || return 1
  fi
  printf '%s\n' "$committed_paths"
  if [[ "$head_ref" == "HEAD" ]]; then
    unstaged_paths="$(git diff --name-only --no-renames)" || return 1
    staged_paths="$(git diff --cached --name-only --no-renames)" || return 1
    untracked_paths="$(git ls-files --others --exclude-standard --exclude='.tmp/agent-quality-gate/')" || return 1
    printf '%s\n' "$unstaged_paths" "$staged_paths" "$untracked_paths"
  fi
}

gate_coordinator_helper="$script_source_dir/gate/quality-gate-coordinator.sh"
gate_coordinator_entry="$script_source_dir/gate/quality-gate-coordinator.mjs"
gate_coordinator_adapter_copy_dir=""

cleanup_gate_coordinator_adapter_copy() {
  local copy_dir="${gate_coordinator_adapter_copy_dir:-}"
  [[ -n "$copy_dir" ]] || return 0
  /bin/rm -f -- \
    "$copy_dir/quality-gate-coordinator.sh" \
    "$copy_dir/quality-gate-coordinator-support.sh" || return 1
  /bin/rmdir -- "$copy_dir" || return 1
  gate_coordinator_adapter_copy_dir=""
}

materialize_gate_coordinator_adapter() {
  local before after copied copy_parent main_hash support_hash extra
  before="$(node "$gate_coordinator_entry" adapter-hashes)" || return 1
  copy_parent="${TMPDIR:-/tmp}"
  copy_parent="${copy_parent%/}"
  gate_coordinator_adapter_copy_dir="$(
    mktemp -d "$copy_parent/agent-quality-gate-adapter.XXXXXX"
  )" || return 1
  chmod 700 "$gate_coordinator_adapter_copy_dir" || return 1
  cp "$gate_coordinator_helper" \
    "$gate_coordinator_adapter_copy_dir/quality-gate-coordinator.sh" || return 1
  cp "$script_source_dir/gate/quality-gate-coordinator-support.sh" \
    "$gate_coordinator_adapter_copy_dir/quality-gate-coordinator-support.sh" || return 1
  chmod 600 \
    "$gate_coordinator_adapter_copy_dir/quality-gate-coordinator.sh" \
    "$gate_coordinator_adapter_copy_dir/quality-gate-coordinator-support.sh" || return 1
  # `${...}` below is JavaScript template interpolation.
  # shellcheck disable=SC2016
  copied="$(node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
    process.stdout.write(`${digest(process.argv[1])} ${digest(process.argv[2])}`);
  ' "$gate_coordinator_adapter_copy_dir/quality-gate-coordinator.sh" \
    "$gate_coordinator_adapter_copy_dir/quality-gate-coordinator-support.sh")" || return 1
  after="$(node "$gate_coordinator_entry" adapter-hashes)" || return 1
  [[ "$before" == "$copied" && "$copied" == "$after" ]] || return 1
  read -r main_hash support_hash extra <<< "$copied"
  [[ -z "${extra:-}" && "$main_hash" =~ ^[a-f0-9]{64}$ &&
    "$support_hash" =~ ^[a-f0-9]{64}$ ]] || return 1
  gate_coordinator_loaded_adapter_main_hash="$main_hash"
  gate_coordinator_loaded_adapter_support_hash="$support_hash"
  gate_coordinator_helper="$gate_coordinator_adapter_copy_dir/quality-gate-coordinator.sh"
  gate_coordinator_support="$gate_coordinator_adapter_copy_dir/quality-gate-coordinator-support.sh"
}

case "$gate_coordinator_enabled" in
  0|false|no)
    ;;
  1|true|yes)
    if [[ ! -r "$gate_coordinator_helper" ]]; then
      echo "error: quality-gate coordinator adapter is missing: ${gate_coordinator_helper}" >&2
      echo "Set AGENT_QUALITY_GATE_COORDINATOR=0 only to run the legacy lock compatibility tests." >&2
      exit 2
    fi
    if ! materialize_gate_coordinator_adapter; then
      cleanup_gate_coordinator_adapter_copy || true
      echo "error: could not load one stable quality-gate coordinator adapter." >&2
      exit 2
    fi
    # shellcheck source=scripts/gate/quality-gate-coordinator.sh
    if ! source "$gate_coordinator_helper"; then
      cleanup_gate_coordinator_adapter_copy || true
      echo "error: could not source the verified quality-gate coordinator adapter." >&2
      exit 2
    fi
    if ! cleanup_gate_coordinator_adapter_copy; then
      echo "error: could not remove the private coordinator adapter copy." >&2
      exit 2
    fi
    gate_coordinator_helper="$script_source_dir/gate/quality-gate-coordinator.sh"
    gate_coordinator_support="$script_source_dir/gate/quality-gate-coordinator-support.sh"
    ;;
esac
durations_file="$scratch_dir/durations.jsonl"
success_stamp_file="$scratch_dir/last-success.stamp"
# Per-command success stamps (GitHub issue #1410): lets a killed run or a run
# that lost one flaky check resume the commands that already passed instead of
# re-executing everything. Bounded by prune_command_stamps below.
command_stamps_file="$scratch_dir/command-stamps.tsv"
# An exact-signature success may cover the manual-run-to-pre-push interval even
# for the slowest mapped suites. Keep this fixed rather than environment-
# configurable so callers cannot extend validation reuse beyond two hours.
success_stamp_ttl_seconds=$((2 * 60 * 60))
# Trunk's pre-push hook callback runs the gate without a TTY and strips most
# env vars from the calling shell. Re-assert non-interactive markers so the
# mapped commands (e.g. pnpm install) take the CI codepath instead of asking
# for TTY confirmation.
export CI="${CI:-true}"

# Shared Turbo cache across worktrees (GitHub issue #1411): a fresh per-PR
# worktree otherwise starts with a 100% cold Turbo cache and re-runs every
# typecheck/lint/knip/build from scratch even when inputs match main. Point
# Turbo's local filesystem cache at one stable per-repo location outside any
# worktree so warm entries carry across worktrees. Turbo 2.9.x writes every
# cache artifact (.tar.zst, manifest, meta) via temp-file + atomic rename with
# PID-namespaced temp names, and its GC only removes orphaned .tmp files older
# than an hour, so concurrent gate runs sharing this dir cannot corrupt it.
# Respect a caller-provided TURBO_CACHE_DIR; set AGENT_TURBO_SHARED_CACHE=0 to
# opt out and fall back to Turbo's per-worktree default. Also fall back when
# the candidate directory cannot be created or written to: sandboxed/agent
# environments can have a restricted writable allowlist that excludes paths
# outside the repo, same reasoning as the TMPDIR check above.
if [[ -z "${TURBO_CACHE_DIR:-}" &&
  "${AGENT_TURBO_SHARED_CACHE:-1}" != "0" &&
  "${AGENT_TURBO_SHARED_CACHE:-1}" != "false" &&
  -n "${HOME:-}" ]]; then
  turbo_cache_candidate="${HOME}/.cache/turbo-monitoring-monorepo"
  if mkdir -p "$turbo_cache_candidate" 2>/dev/null && [[ -w "$turbo_cache_candidate" ]]; then
    export TURBO_CACHE_DIR="$turbo_cache_candidate"
  fi
fi

tmpfiles=()
# Set by run_with_timeout for the most recent mapped command so callers can tell
# a timeout apart from an ordinary non-zero exit. Read only right after the call.
last_command_timed_out=false
last_command_execution_seconds=0
last_command_infrastructure_failed=false
last_command_trunk_provisioning_blocked=false
# Typed dispatch result for the parallel parent. `unstarted` means the mapped
# wrapper never crossed its private START barrier. The parent can then abandon
# the exact deferred lease only after it drains the retained lineage state.
last_command_launch_state=unstarted
# Monotonic counter for unique per-command timeout marker paths.
timeout_seq=0
# Monotonic across all parallel phases so no command drain identity is reused
# within one gate invocation.
parallel_command_sequence=0
# PIDs (command + watchdog) of any in-flight timed command in THIS process, so a
# wrapper SIGINT/SIGTERM tears them down instead of leaking the watchdog's
# background sleeps. Sequential commands run in the gate process; parallel
# members run in their own process-group worker subshells, each maintaining its
# own copy — which the parent's signal traps cannot see.
# Each entry is PID|exact-start for one direct command/watchdog child. One
# array assignment publishes the complete registry to the signal trap.
active_timeout_records=()
active_timeout_exact_identities=()
active_timeout_drain_identity=""
active_timeout_lifecycle_contract=""
# Set only inside a parallel worker. Darwin sentinels use this path as the
# parent's positive settlement acknowledgement after they close fd18.
parallel_worker_command_marker=""
# A bounded Darwin settlement keeps its state for another process to recover.
# Retrying the same state from EXIT only repeats the full bound and delays the
# preserved failure without adding a new recovery owner.
gate_darwin_failed_settlement_tokens=""
# A failed multi-state attempt blocks only the same canonical cohort. A later
# request-level cohort can add sibling state whose lineage supplies exact
# ownership evidence that the smaller attempt could not see.
gate_darwin_failed_settlement_cohorts=""

# Process-group IDs of the in-flight parallel workers. Non-interactive Bash job
# control gives each worker a dedicated group whose ID equals its leader PID.
# Group tracking survives the leader exiting and descendants reparenting, unlike
# a process-tree walk rooted at that leader.
active_worker_pgids=()
# Drain identities align one-for-one with active_worker_pgids. A parallel
# command can detach into a new process group, so the group alone is not a
# complete cleanup handle.
active_worker_drain_identities=()
# Exact leader start identities align with the same registry. They let the
# active parent validate a live no-lock sentinel without trusting a bare PGID.
active_worker_start_identities=()
# Lifecycle contracts align with every parallel worker registry. Recovery must
# use the contract that was selected before the worker started. It must not
# infer a contract from mutable state-file presence.
active_worker_lifecycle_contracts=()

# A signal can arrive after Bash creates a parallel worker but before the parent
# records its process group. Defer INT/TERM handling across that short registry
# update, then replay the first pending signal after the group is reachable.
worker_registration_in_progress=0
worker_settlement_in_progress=0
pending_terminating_signal=""
worker_registration_test_barrier="${AGENT_QUALITY_GATE_TEST_WORKER_REGISTRATION_BARRIER:-}"
if [[ -n "$worker_registration_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_WORKER_REGISTRATION_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
drain_refresh_test_barrier="${AGENT_QUALITY_GATE_TEST_DRAIN_REFRESH_BARRIER:-}"
if [[ -n "$drain_refresh_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_DRAIN_REFRESH_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
parallel_release_failure_at="${AGENT_QUALITY_GATE_TEST_PARALLEL_RELEASE_FAILURE_AT:-}"
parallel_release_attempt=0
if [[ -n "$parallel_release_failure_at" ]] && {
  [[ "${NODE_ENV:-}" != "test" ]] ||
    [[ ! "$parallel_release_failure_at" =~ ^[1-9][0-9]*$ ]];
}; then
  echo "AGENT_QUALITY_GATE_TEST_PARALLEL_RELEASE_FAILURE_AT: test-only override requires NODE_ENV=test and a positive integer" >&2
  exit 2
fi
owner_discard_test_barrier="${AGENT_QUALITY_GATE_TEST_OWNER_DISCARD_BARRIER:-}"
if [[ -n "$owner_discard_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_OWNER_DISCARD_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
owner_quarantined_test_barrier="${AGENT_QUALITY_GATE_TEST_OWNER_QUARANTINED_BARRIER:-}"
if [[ -n "$owner_quarantined_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_OWNER_QUARANTINED_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
owner_witness_test_barrier="${AGENT_QUALITY_GATE_TEST_OWNER_WITNESS_BARRIER:-}"
if [[ -n "$owner_witness_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_OWNER_WITNESS_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
marker_witness_test_barrier="${AGENT_QUALITY_GATE_TEST_MARKER_WITNESS_BARRIER:-}"
if [[ -n "$marker_witness_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_MARKER_WITNESS_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
owner_quarantine_before_claim_test_barrier="${AGENT_QUALITY_GATE_TEST_QUARANTINE_BEFORE_CLAIM_BARRIER:-}"
if [[ -n "$owner_quarantine_before_claim_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_QUARANTINE_BEFORE_CLAIM_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
owner_quarantine_claim_open_test_barrier="${AGENT_QUALITY_GATE_TEST_QUARANTINE_CLAIM_OPEN_BARRIER:-}"
if [[ -n "$owner_quarantine_claim_open_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_QUARANTINE_CLAIM_OPEN_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
owner_quarantine_after_claim_test_barrier="${AGENT_QUALITY_GATE_TEST_QUARANTINE_AFTER_CLAIM_BARRIER:-}"
if [[ -n "$owner_quarantine_after_claim_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_QUARANTINE_AFTER_CLAIM_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
owner_restore_link_failure="${AGENT_QUALITY_GATE_TEST_OWNER_RESTORE_LINK_FAILURE:-}"
if [[ -n "$owner_restore_link_failure" ]] && {
  [[ "${NODE_ENV:-}" != "test" ]] || [[ "$owner_restore_link_failure" != "1" ]];
}; then
  echo "AGENT_QUALITY_GATE_TEST_OWNER_RESTORE_LINK_FAILURE: test-only override requires NODE_ENV=test and value 1" >&2
  exit 2
fi
release_validated_test_barrier="${AGENT_QUALITY_GATE_TEST_RELEASE_VALIDATED_BARRIER:-}"
if [[ -n "$release_validated_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_RELEASE_VALIDATED_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
release_private_test_barrier="${AGENT_QUALITY_GATE_TEST_RELEASE_PRIVATE_BARRIER:-}"
if [[ -n "$release_private_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_RELEASE_PRIVATE_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
broker_preflight_bound_test_barrier="${AGENT_QUALITY_GATE_TEST_BROKER_PREFLIGHT_BOUND_BARRIER:-}"
if [[ -n "$broker_preflight_bound_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_BROKER_PREFLIGHT_BOUND_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
lock_taken_test_barrier="${AGENT_QUALITY_GATE_TEST_LOCK_TAKEN_BARRIER:-}"
if [[ -n "$lock_taken_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_LOCK_TAKEN_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
if [[ -n "$worker_registration_test_barrier" ]] &&
  ! gate_darwin_exact_identity_prepare; then
  echo "error: could not establish Darwin identity authority for the worker registration test control." >&2
  echo "Nothing has been executed." >&2
  exit 2
fi

kill_process_tree() {
  local pid="$1"
  local sig="$2"
  local child
  [[ -n "$pid" ]] || return 0
  while IFS= read -r child; do
    [[ -n "$child" ]] && kill_process_tree "$child" "$sig"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill "-${sig}" "$pid" 2>/dev/null || true
}

# Print pid plus every live descendant, one per line, deepest first.
collect_process_tree() {
  local pid="$1"
  local child
  [[ -n "$pid" ]] || return 0
  while IFS= read -r child; do
    [[ -n "$child" ]] && collect_process_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  echo "$pid"
}

# Return 0 only while PID still names the recorded runtime generation and is
# still this shell's direct child. Return 1 after that generation is gone or the
# PID was recycled. Return 2 when a live process cannot be identified safely.
gate_active_timeout_direct_child_status() {
  local pid="$1"
  local expected_runtime="$2"
  local parent_before parent_after current_runtime signal_probe
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 2
  if [[ -z "$expected_runtime" ]]; then
    signal_probe="$(gate_lock_process_signal_probe "$pid")" ||
      signal_probe="error"
    [[ "$signal_probe" == "gone" ]] && return 1
    return 2
  fi
  parent_before="$(
    ps -o ppid= -p "$pid" 2>/dev/null |
      awk 'NF { print $1; exit }' || true
  )"
  current_runtime="$(gate_lock_process_runtime_start "$pid")"
  parent_after="$(
    ps -o ppid= -p "$pid" 2>/dev/null |
      awk 'NF { print $1; exit }' || true
  )"
  if [[ "$current_runtime" != "$expected_runtime" ]]; then
    if [[ -z "$current_runtime" ]]; then
      signal_probe="$(gate_lock_process_signal_probe "$pid")" ||
        signal_probe="error"
      [[ "$signal_probe" == "gone" ]] || return 2
    fi
    return 1
  fi
  [[ "$parent_before" == "$$" && "$parent_after" == "$$" ]] || return 2
}

# Best-effort settlement for an explicit no-lock run after its complete
# inherited-handle drain fails. Each argument group is KIND PID START. A root
# must still be this shell's direct child. A worker must also remain the leader
# of its recorded process group. The fallback snapshots exact start identities
# before TERM and rechecks each identity before KILL. It never proves that an
# unobserved detached descendant is absent, so its caller still returns the
# original drain failure.
teardown_no_lock_settle_known_processes() {
  local kind pid expected_start
  local current_start current_runtime current_parent verified_parent current_pgid
  local snapshot candidate candidate_pgid candidate_start
  local record signal_probe state
  local attempt unsettled=0 fallback_status=0
  local -a captured_records=()
  local -a captured_runtime_records=()
  local -a direct_children=()
  [[ "$#" -gt 0 ]] || return 2
  if [[ "$gate_darwin_lineage_host_platform" == Darwin ]]; then
    echo "error: the portable no-lock process fallback is unsafe on Darwin." >&2
    return 2
  fi

  while [[ "$#" -ge 3 ]]; do
    kind="$1"
    pid="$2"
    expected_start="$3"
    shift 3
    if [[ ! "$pid" =~ ^[1-9][0-9]*$ || -z "$expected_start" ]]; then
      fallback_status=2
      continue
    fi
    if [[ "$kind" == "captured" ]]; then
      current_runtime="$(gate_lock_process_runtime_start "$pid")"
      if [[ "$current_runtime" == "$expected_start" ]]; then
        captured_runtime_records+=("${pid}|${expected_start}")
      elif [[ -z "$current_runtime" ]]; then
        signal_probe="$(gate_lock_process_signal_probe "$pid")" ||
          signal_probe="error"
        [[ "$signal_probe" == "gone" ]] || fallback_status=2
      fi
      continue
    fi
    current_parent="$(
      ps -o ppid= -p "$pid" 2>/dev/null |
        awk 'NF { print $1; exit }' || true
    )"
    current_start="$(gate_lock_process_runtime_start "$pid")"
    verified_parent="$(
      ps -o ppid= -p "$pid" 2>/dev/null |
        awk 'NF { print $1; exit }' || true
    )"
    if [[ "$current_start" != "$expected_start" ]]; then
      # A different generation is not ours. An empty read is safe only when
      # the process is confirmed gone.
      if [[ -z "$current_start" ]]; then
        signal_probe="$(gate_lock_process_signal_probe "$pid")" ||
          signal_probe="error"
        [[ "$signal_probe" == "gone" ]] || fallback_status=2
      fi
      continue
    fi
    if [[ "$current_parent" != "$$" || "$verified_parent" != "$$" ]]; then
      fallback_status=2
      continue
    fi
    case "$kind" in
      root)
        # Register this exact direct child in the signal set before it can
        # enter the reap set. A direct child is waitable only after the
        # fallback has also recorded the generation that it will signal.
        captured_records+=("${pid}|${expected_start}")
        direct_children+=("$pid")
        while IFS= read -r candidate; do
          [[ "$candidate" =~ ^[1-9][0-9]*$ ]] || continue
          [[ "$candidate" != "$pid" ]] || continue
          candidate_start="$(gate_lock_process_runtime_start "$candidate")"
          if [[ -n "$candidate_start" ]]; then
            captured_records+=("${candidate}|${candidate_start}")
          else
            signal_probe="$(gate_lock_process_signal_probe "$candidate")" ||
              signal_probe="error"
            [[ "$signal_probe" == "gone" ]] || fallback_status=2
          fi
        done < <(collect_process_tree "$pid")
        ;;
      worker)
        current_pgid="$(
          ps -o pgid= -p "$pid" 2>/dev/null |
            awk 'NF { print $1; exit }' || true
        )"
        if [[ "$current_pgid" != "$pid" ]]; then
          fallback_status=2
          continue
        fi
        if ! snapshot="$(ps -axo pid=,pgid= 2>/dev/null)"; then
          fallback_status=2
          continue
        fi
        # The PGID and complete snapshot are prerequisites for treating this
        # direct child as a worker-group anchor. Do not wait on a rejected or
        # unverifiable worker that this fallback did not record for signalling.
        captured_records+=("${pid}|${expected_start}")
        direct_children+=("$pid")
        while read -r candidate candidate_pgid; do
          [[ "$candidate" =~ ^[1-9][0-9]*$ &&
            "$candidate_pgid" == "$pid" ]] || continue
          [[ "$candidate" != "$pid" ]] || continue
          candidate_start="$(gate_lock_process_runtime_start "$candidate")"
          if [[ -n "$candidate_start" ]]; then
            captured_records+=("${candidate}|${candidate_start}")
          else
            signal_probe="$(gate_lock_process_signal_probe "$candidate")" ||
              signal_probe="error"
            [[ "$signal_probe" == "gone" ]] || fallback_status=2
          fi
        done <<< "$snapshot"
        ;;
      *)
        fallback_status=2
        ;;
    esac
  done
  [[ "$#" -eq 0 ]] || fallback_status=2

  for record in "${captured_records[@]+"${captured_records[@]}"}"; do
    pid="${record%%|*}"
    expected_start="${record#*|}"
    current_start="$(gate_lock_process_runtime_start "$pid")"
    [[ -n "$current_start" && "$current_start" == "$expected_start" ]] ||
      continue
    kill -TERM "$pid" 2>/dev/null || {
      signal_probe="$(gate_lock_process_signal_probe "$pid")" ||
        signal_probe="error"
      [[ "$signal_probe" == "gone" ]] || fallback_status=2
    }
  done
  for record in "${captured_runtime_records[@]+"${captured_runtime_records[@]}"}"; do
    pid="${record%%|*}"
    expected_start="${record#*|}"
    current_runtime="$(gate_lock_process_runtime_start "$pid")"
    [[ -n "$current_runtime" && "$current_runtime" == "$expected_start" ]] ||
      continue
    kill -TERM "$pid" 2>/dev/null || {
      signal_probe="$(gate_lock_process_signal_probe "$pid")" ||
        signal_probe="error"
      [[ "$signal_probe" == "gone" ]] || fallback_status=2
    }
  done
  sleep 1
  for record in "${captured_records[@]+"${captured_records[@]}"}"; do
    pid="${record%%|*}"
    expected_start="${record#*|}"
    current_start="$(gate_lock_process_runtime_start "$pid")"
    [[ -n "$current_start" && "$current_start" == "$expected_start" ]] ||
      continue
    state="$(
      ps -o stat= -p "$pid" 2>/dev/null |
        awk 'NF { print $1; exit }' || true
    )"
    [[ "$state" == Z* ]] && continue
    current_start="$(gate_lock_process_runtime_start "$pid")"
    [[ "$current_start" == "$expected_start" ]] || continue
    kill -KILL "$pid" 2>/dev/null || {
      signal_probe="$(gate_lock_process_signal_probe "$pid")" ||
        signal_probe="error"
      [[ "$signal_probe" == "gone" ]] || fallback_status=2
    }
  done
  for record in "${captured_runtime_records[@]+"${captured_runtime_records[@]}"}"; do
    pid="${record%%|*}"
    expected_start="${record#*|}"
    current_runtime="$(gate_lock_process_runtime_start "$pid")"
    [[ -n "$current_runtime" && "$current_runtime" == "$expected_start" ]] ||
      continue
    state="$(
      ps -o stat= -p "$pid" 2>/dev/null |
        awk 'NF { print $1; exit }' || true
    )"
    [[ "$state" == Z* ]] && continue
    current_runtime="$(gate_lock_process_runtime_start "$pid")"
    [[ "$current_runtime" == "$expected_start" ]] || continue
    kill -KILL "$pid" 2>/dev/null || {
      signal_probe="$(gate_lock_process_signal_probe "$pid")" ||
        signal_probe="error"
      [[ "$signal_probe" == "gone" ]] || fallback_status=2
    }
  done

  for ((attempt = 0; attempt < 40; attempt++)); do
    unsettled=0
    for record in "${captured_records[@]+"${captured_records[@]}"}"; do
      pid="${record%%|*}"
      expected_start="${record#*|}"
      current_start="$(gate_lock_process_runtime_start "$pid")"
      [[ -n "$current_start" && "$current_start" == "$expected_start" ]] ||
        continue
      state="$(
        ps -o stat= -p "$pid" 2>/dev/null |
          awk 'NF { print $1; exit }' || true
      )"
      [[ "$state" == Z* ]] && continue
      unsettled=1
      break
    done
    if [[ "$unsettled" -eq 0 ]]; then
      for record in "${captured_runtime_records[@]+"${captured_runtime_records[@]}"}"; do
        pid="${record%%|*}"
        expected_start="${record#*|}"
        current_runtime="$(gate_lock_process_runtime_start "$pid")"
        [[ -n "$current_runtime" && "$current_runtime" == "$expected_start" ]] ||
          continue
        state="$(
          ps -o stat= -p "$pid" 2>/dev/null |
            awk 'NF { print $1; exit }' || true
        )"
        [[ "$state" == Z* ]] && continue
        unsettled=1
        break
      done
    fi
    [[ "$unsettled" -eq 1 ]] || break
    sleep 0.05
  done
  [[ "$unsettled" -eq 0 ]] || fallback_status=2
  if [[ "$unsettled" -eq 0 ]]; then
    for pid in "${direct_children[@]+"${direct_children[@]}"}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi
  [[ "$fallback_status" -eq 0 ]] || {
    echo "error: the no-lock fallback could not settle every recorded process identity." >&2
  }
  return "$fallback_status"
}

teardown_active_timeouts() {
  local pid
  local pgid
  local drain_identity
  local drain_status=0
  local record root_runtime captured_pid _captured_legacy captured_runtime
  local worker_start
  local clear_request_marker=0
  local darwin_timeout_settled=0
  local darwin_workers_settled=0
  local timeout_drain_identity="$active_timeout_drain_identity"
  local timeout_lifecycle_contract="$active_timeout_lifecycle_contract"
  local -a timeout_records=("${active_timeout_records[@]+"${active_timeout_records[@]}"}")
  local -a timeout_exact_identities=("${active_timeout_exact_identities[@]+"${active_timeout_exact_identities[@]}"}")
  local -a roots=()
  local -a worker_pgids=("${active_worker_pgids[@]+"${active_worker_pgids[@]}"}")
  local -a worker_drain_identities=("${active_worker_drain_identities[@]+"${active_worker_drain_identities[@]}"}")
  local -a worker_start_identities=("${active_worker_start_identities[@]+"${active_worker_start_identities[@]}"}")
  local -a worker_lifecycle_contracts=("${active_worker_lifecycle_contracts[@]+"${active_worker_lifecycle_contracts[@]}"}")
  local -a darwin_cohort_tokens=()
  local -a fallback_args=()
  for record in "${timeout_records[@]+"${timeout_records[@]}"}"; do
    pid="${record%%|*}"
    root_runtime="${record#*|}"
    if [[ "$record" != *"|"* || ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
      echo "error: direct-child cleanup registry is inconsistent." >&2
      return 2
    fi
    roots+=("$record")
    fallback_args+=(root "$pid" "$root_runtime")
  done
  [[ -n "${timeout_records[*]-}" || -n "${worker_pgids[*]-}" ||
    -n "${worker_drain_identities[*]-}" ||
    -n "${worker_start_identities[*]-}" ||
    -n "${worker_lifecycle_contracts[*]-}" ||
    -n "$timeout_drain_identity" ]] || return 0
  if ! [[ "${#worker_pgids[@]}" -eq "${#worker_drain_identities[@]}" &&
    "${#worker_pgids[@]}" -eq "${#worker_start_identities[@]}" &&
    "${#worker_pgids[@]}" -eq "${#worker_lifecycle_contracts[@]}" ]]; then
    echo "error: parallel worker cleanup registry is inconsistent." >&2
    case "$gate_lock_enabled" in
      0|false|no)
        teardown_no_lock_settle_known_processes \
          "${fallback_args[@]+"${fallback_args[@]}"}" || true
        ;;
    esac
    return 2
  fi
  local worker_index=0
  for pgid in "${worker_pgids[@]+"${worker_pgids[@]}"}"; do
    gate_lifecycle_contract_is_supported \
      "${worker_lifecycle_contracts[$worker_index]}" || {
      echo "error: parallel worker cleanup registry has an invalid lifecycle contract." >&2
      return 2
    }
    fallback_args+=(worker "$pgid" "${worker_start_identities[$worker_index]}")
    worker_index=$((worker_index + 1))
  done

  if [[ "$gate_darwin_lineage_host_platform" == Darwin ]]; then
    if [[ -n "$timeout_drain_identity" &&
      "$timeout_lifecycle_contract" == darwin-coherent-lineage-v2 ]]; then
      darwin_cohort_tokens+=("$timeout_drain_identity")
      darwin_timeout_settled=1
    fi
    worker_index=0
    for drain_identity in "${worker_drain_identities[@]+"${worker_drain_identities[@]}"}"; do
      if [[ "${worker_lifecycle_contracts[$worker_index]}" == \
        darwin-coherent-lineage-v2 ]]; then
        case " ${darwin_cohort_tokens[*]-} " in
          *" ${drain_identity} "*) ;;
          *) darwin_cohort_tokens+=("$drain_identity") ;;
        esac
        darwin_workers_settled=1
      fi
      worker_index=$((worker_index + 1))
    done
    if [[ "${#darwin_cohort_tokens[@]}" -gt 0 ]]; then
      drain_completed_darwin_command_cohort \
        "${darwin_cohort_tokens[@]}" || return $?
    fi
  fi

  # Persist and drain every exact command identity before any signal can
  # destroy its last discoverable ancestor. A failed drain retains
  # its recovery evidence. In that case, leave all remaining processes to the
  # preserved legacy owner or coordinator obligations.
  if [[ -n "$timeout_drain_identity" && "$darwin_timeout_settled" -eq 0 ]]; then
    gate_lifecycle_contract_is_supported "$timeout_lifecycle_contract" || {
      echo "error: active command cleanup has no supported lifecycle contract." >&2
      return 2
    }
    if [[ "$timeout_drain_identity" == "${gate_run_id:-$gate_lock_token}" ]]; then
      clear_request_marker=1
    fi
    drain_completed_command_identity \
      "$timeout_drain_identity" "$clear_request_marker" "" "" 0 \
      "$timeout_lifecycle_contract" || drain_status=$?
    if [[ "$drain_status" -ne 0 ]]; then
      case "$gate_lock_enabled" in
        0|false|no)
          if [[ "$gate_darwin_lineage_host_platform" != Darwin ]]; then
            while IFS='|' read -r captured_pid _captured_legacy captured_runtime; do
              [[ "$captured_pid" =~ ^[1-9][0-9]*$ &&
                -n "$captured_runtime" ]] || continue
              fallback_args+=(captured "$captured_pid" "$captured_runtime")
            done <<< "$gate_drain_capture"
            teardown_no_lock_settle_known_processes \
              "${fallback_args[@]+"${fallback_args[@]}"}" || true
          fi
          ;;
      esac
      return "$drain_status"
    fi
  fi
  worker_index=0
  for drain_identity in "${worker_drain_identities[@]+"${worker_drain_identities[@]}"}"; do
    pgid="${worker_pgids[$worker_index]}"
    worker_start="${worker_start_identities[$worker_index]}"
    if [[ "$darwin_workers_settled" -eq 1 &&
      "${worker_lifecycle_contracts[$worker_index]}" == \
        darwin-coherent-lineage-v2 ]]; then
      worker_index=$((worker_index + 1))
      continue
    fi
    worker_index=$((worker_index + 1))
    drain_completed_parallel_command \
      "$drain_identity" "$pgid" "$worker_start" \
      "${worker_lifecycle_contracts[$((worker_index - 1))]}" || drain_status=$?
    if [[ "$drain_status" -ne 0 ]]; then
      case "$gate_lock_enabled" in
        0|false|no)
          if [[ "$gate_darwin_lineage_host_platform" != Darwin ]]; then
            while IFS='|' read -r captured_pid _captured_legacy captured_runtime; do
              [[ "$captured_pid" =~ ^[1-9][0-9]*$ &&
                -n "$captured_runtime" ]] || continue
              fallback_args+=(captured "$captured_pid" "$captured_runtime")
            done <<< "$gate_drain_capture"
            teardown_no_lock_settle_known_processes \
              "${fallback_args[@]+"${fallback_args[@]}"}" || true
          fi
          ;;
      esac
      return "$drain_status"
    fi
  done
  if [[ "$gate_darwin_lineage_host_platform" == Darwin ]]; then
    local exact_identity exact_status=0 timeout_index=0
    if [[ "${#timeout_records[@]}" -ne "${#timeout_exact_identities[@]}" ]]; then
      echo "error: Darwin exact child cleanup registry is inconsistent." >&2
      return 2
    fi
    for record in "${timeout_records[@]+"${timeout_records[@]}"}"; do
      pid="${record%%|*}"
      exact_identity="${timeout_exact_identities[$timeout_index]}"
      timeout_index=$((timeout_index + 1))
      if [[ -z "$exact_identity" ]]; then
        if kill -0 "$pid" 2>/dev/null; then
          echo "error: a live Darwin administrative child has no exact kernel identity." >&2
          exact_status=2
        fi
        continue
      fi
      gate_darwin_exact_identity_terminate "$exact_identity" "$pid" ||
        exact_status=2
    done
    [[ "$exact_status" -eq 0 ]] || return 2
    for record in "${timeout_records[@]+"${timeout_records[@]}"}"; do
      pid="${record%%|*}"
      wait "$pid" 2>/dev/null || true
    done
    active_timeout_records=()
    active_timeout_exact_identities=()
    active_timeout_drain_identity=""
    active_timeout_lifecycle_contract=""
    active_worker_pgids=()
    active_worker_drain_identities=()
    active_worker_start_identities=()
    active_worker_lifecycle_contracts=()
    return 0
  fi
  # Snapshot every descendant BEFORE signalling: TERM kills intermediate
  # subshells first, which reparents a SIGTERM-ignoring survivor away from the
  # tree, so a post-TERM re-walk would miss it. The KILL pass targets the
  # saved pid list, not a fresh walk. Parallel worker groups were already
  # folded into each command identity's durable capture above.
  local -a tree=()
  local -a tree_identities=()
  local -a tree_direct_roots=()
  local teardown_idx=0
  local teardown_recorded teardown_current teardown_root_status
  local teardown_validation_status=0
  local signal_probe
  for record in "${roots[@]+"${roots[@]}"}"; do
    pid="${record%%|*}"
    root_runtime="${record#*|}"
    if gate_active_timeout_direct_child_status "$pid" "$root_runtime"; then
      :
    else
      teardown_root_status=$?
      [[ "$teardown_root_status" -eq 1 ]] || teardown_validation_status=2
      continue
    fi
    while IFS= read -r child_pid; do
      if [[ -n "$child_pid" ]]; then
        teardown_current="$(gate_lock_process_runtime_start "$child_pid")"
        if [[ -z "$teardown_current" ]]; then
          signal_probe="$(gate_lock_process_signal_probe "$child_pid")" ||
            signal_probe="error"
          [[ "$signal_probe" == "gone" ]] || teardown_validation_status=2
          continue
        fi
        tree+=("$child_pid")
        if [[ "$child_pid" == "$pid" ]]; then
          # Bind the root to the registry generation, not to a PID that could
          # have been recycled while the process-tree walk ran.
          tree_identities+=("$root_runtime")
          tree_direct_roots+=(1)
        else
          tree_identities+=("$teardown_current")
          tree_direct_roots+=(0)
        fi
      fi
    done < <(collect_process_tree "$pid")
  done
  for teardown_idx in "${!tree[@]}"; do
    pid="${tree[$teardown_idx]}"
    teardown_recorded="${tree_identities[$teardown_idx]-}"
    if [[ "${tree_direct_roots[$teardown_idx]-}" -eq 1 ]]; then
      if gate_active_timeout_direct_child_status \
        "$pid" "$teardown_recorded"; then
        :
      else
        teardown_root_status=$?
        [[ "$teardown_root_status" -eq 1 ]] || teardown_validation_status=2
        continue
      fi
    else
      teardown_current="$(gate_lock_process_runtime_start "$pid")"
      if [[ -z "$teardown_recorded" ||
        "$teardown_current" != "$teardown_recorded" ]]; then
        if [[ -z "$teardown_current" ]]; then
          signal_probe="$(gate_lock_process_signal_probe "$pid")" ||
            signal_probe="error"
          [[ "$signal_probe" == "gone" ]] || teardown_validation_status=2
        fi
        continue
      fi
    fi
    kill "-TERM" "$pid" 2>/dev/null || true
  done
  # Same TERM-then-KILL grace as run_with_timeout's watchdog: a manual
  # interrupt (Ctrl-C/TERM to the gate) must not leave a SIGTERM-ignoring
  # mapped command (or descendant) running just because it wasn't the
  # timeout path that tore it down.
  if [[ -n "${tree[0]+x}" ]]; then
    sleep 3
  fi
  for teardown_idx in "${!tree[@]}"; do
    pid="${tree[$teardown_idx]}"
    teardown_recorded="${tree_identities[$teardown_idx]-}"
    if [[ "${tree_direct_roots[$teardown_idx]-}" -eq 1 ]]; then
      if gate_active_timeout_direct_child_status \
        "$pid" "$teardown_recorded"; then
        :
      else
        teardown_root_status=$?
        [[ "$teardown_root_status" -eq 1 ]] || teardown_validation_status=2
        continue
      fi
    else
      teardown_current="$(gate_lock_process_runtime_start "$pid")"
      if [[ -z "$teardown_recorded" ||
        "$teardown_current" != "$teardown_recorded" ]]; then
        if [[ -z "$teardown_current" ]]; then
          signal_probe="$(gate_lock_process_signal_probe "$pid")" ||
            signal_probe="error"
          [[ "$signal_probe" == "gone" ]] || teardown_validation_status=2
        fi
        continue
      fi
    fi
    kill "-KILL" "$pid" 2>/dev/null || true
  done
  # Every worker group was folded into its command identity's durable capture
  # and drained above. A bare PGID is reusable and has no start identity, so do
  # not signal it after the exact drain has proved the group empty.
  for pgid in "${worker_pgids[@]+"${worker_pgids[@]}"}"; do
    wait "$pgid" 2>/dev/null || true
  done
  if [[ "$teardown_validation_status" -ne 0 ]]; then
    echo "error: active direct-child cleanup could not revalidate every recorded process identity." >&2
    return 2
  fi
  # Clear the shared registries only after every exact drain and fallback tree
  # teardown succeeds. A failed active drain can return through run_with_timeout
  # and reach the EXIT trap. Retaining the same identities lets that trap retry
  # the drain. This is required for --no-lock, which has no durable owner that a
  # later gate can use to recover leaked descendants.
  active_timeout_records=()
  active_timeout_exact_identities=()
  active_timeout_drain_identity=""
  active_timeout_lifecycle_contract=""
  active_worker_pgids=()
  active_worker_drain_identities=()
  active_worker_start_identities=()
  active_worker_lifecycle_contracts=()
}

# ---------------------------------------------------------------------------
# Legacy compatibility and crash-recovery lock (GitHub issue #1802).
#
# The original remedy for machine oversubscription and fixed-port collisions
# allowed one complete `--run` gate at a time. The coordinator now schedules
# commands from multiple worktrees under weighted capacity and named resources.
# It retains this lock as a mixed-version barrier, and this Bash path remains
# the election and recovery mechanism for legacy holders and dead coordinators.
#
# mkdir(2), link(2), O_EXCL, and rename(2) are the atomic primitives. flock(1)
# does not exist on macOS, and the repo's floor is Bash 3.2. Owner records move
# by exact file rename. Recovery freezes a dead private quarantine with one
# Node rename over a verified empty placeholder; it never uses `mv src dir`,
# whose directory-destination behavior is not a conditional claim. The
# invariant is: at most one process believes it holds the lock, and no waiter
# deletes a shared owner pathname. A holder wins `mkdir`, then publishes its
# owner with O_EXCL. A reclaimer binds each record or quarantine inode before it
# can retire private evidence.
# ---------------------------------------------------------------------------
gate_lock_dir=""
gate_lock_token=""
# The request token identifies one gate invocation. The lock token identifies
# the legacy owner. They are the same in legacy mode. Coordinator mode keeps
# them separate so every worker inherits both the request handle and the shared
# coordinator handle that an older gate knows how to drain.
gate_run_id=""
# An active sequential-command drain keeps the marker for a successor until it
# confirms every descendant is gone. If a legacy run cannot first persist that
# recovery obligation, it also leaves its owner record in place so the next run
# must reclaim and condemn it before executing work.
gate_active_command_drain_in_progress=0
gate_cleanup_preserve_legacy_lock=0
# Locals holding a record's token field are named *_token_value, not *_token:
# the repo's review scanner reads a name ending in _token as a credential key
# and refuses to bundle the diff. Keep the suffix if you rename these.
# Path a reclaim moves a dead owner record to, and the slot it came from. The
# temp name carries this process's PID, so it can be registered with the exit
# trap BEFORE it is created: cleanup can never race the rename that creates it,
# and it can never name another run's file.
gate_lock_reclaim_tmp=""
gate_lock_reclaim_origin=""
# Owner records are never unlinked through a shared pathname. A discard first
# creates a hard-link witness in a fresh mode-0700 directory beside the record,
# establishes a canonical-owner or condemned-run fallback, then atomically
# moves the shared name beside that witness. Only those private names are
# removed. These globals join the two phases without passing delimiter-bearing
# record content through positional arguments.
gate_lock_quarantine_dir=""
gate_lock_quarantine_origin=""
gate_lock_quarantine_anchor=""
gate_lock_quarantine_taken=""
gate_lock_quarantine_fallback=""
gate_lock_quarantine_authority_value=""
gate_lock_quarantine_raw_marker_token=""
gate_lock_quarantine_retention_state="Nothing has been executed."
gate_lock_active_quarantine_pid=""
gate_lock_active_quarantine_host=""
gate_lock_local_host_name=""
gate_lock_local_host_fingerprint=""
gate_lock_local_machine_source=""
gate_lock_local_machine_fingerprint=""
gate_lock_no_machine_fingerprint=""
gate_lock_claimed_quarantine=""
# A marker cleanup that failed its exact-inode check must not be retried during
# EXIT teardown. A later attempt could bind the changed inode as a new witness
# and delete the evidence that the first attempt restored or retained.
gate_run_marker_cleanup_refused_tokens=""
# Private file a claim builds its record in before publishing it. Same rule:
# PID-suffixed, so registering it before creation is safe.
gate_lock_claim_tmp=""

# A reclaim that is SIGKILLed between taking a record and judging it leaves
# that record parked under owner.reclaiming.*, where nothing looks for it. If
# the record it took belongs to a LIVE holder — which happens when its verdict
# was formed before another run took the lock over — the lock reads as
# ownerless and the next waiter starts beside a running holder. So a lock with
# no record is not evidence of an absent holder until the remnants have been
# read: a remnant naming a live process IS the owner record, misfiled.
# A record about to be thrown away may name a run whose commands are still
# running, and the token inside it is the only handle to them. Record that
# obligation before the evidence goes — never after, because "after" is a
# window a signal can land in. Same failure direction as the rest of this path:
# condemning a run with nothing left alive costs one drain that finds nothing.
gate_lock_record_is_readable_regular() {
  local record="$1"
  [[ ! -L "$record" && -f "$record" && -r "$record" ]]
}

gate_lock_refuse_unsafe_owner_record() {
  local record="$1"
  echo "error: the quality-gate owner record at ${record} is not a readable regular file." >&2
  echo "The record was retained. Nothing has been executed." >&2
  gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
    "No mapped command ran in this request"
  exit 2
}

gate_lock_require_safe_existing_owner_record() {
  local record="$1"
  gate_lock_record_is_readable_regular "$record" && return 0
  # A legitimate owner can release the lock between the existence and type
  # checks. A dangling symlink remains unsafe because -L stays true.
  [[ ! -e "$record" && ! -L "$record" ]] && return 0
  gate_lock_refuse_unsafe_owner_record "$record"
}

gate_lock_clear_quarantine_state() {
  gate_lock_quarantine_dir=""
  gate_lock_quarantine_origin=""
  gate_lock_quarantine_anchor=""
  gate_lock_quarantine_taken=""
  gate_lock_quarantine_fallback=""
  gate_lock_quarantine_authority_value=""
  gate_lock_quarantine_recovery_contract=""
  gate_lock_quarantine_raw_marker_token=""
  gate_lock_quarantine_retention_state="Nothing has been executed."
}

gate_lock_quarantine_authority_and_contract_from_record() {
  local record="$1"
  if [[ -n "$gate_lock_quarantine_raw_marker_token" ]]; then
    gate_run_marker_snapshot_is_exact \
      "$record" "$gate_lock_quarantine_raw_marker_token" || return 1
    printf '%s\n%s\n' \
      "$gate_lock_quarantine_raw_marker_token" "$gate_host_lifecycle_contract"
    return 0
  fi
  gate_lock_current_user_authority_and_recovery_contract_from_record "$record"
}

gate_lock_quarantine_authority_from_record() {
  local authority_and_contract
  authority_and_contract="$(
    gate_lock_quarantine_authority_and_contract_from_record "$1"
  )" || return 1
  [[ "$authority_and_contract" == *$'\n'* ]] || return 1
  printf '%s\n' "${authority_and_contract%%$'\n'*}"
}

gate_lock_private_quarantine_directory_is_safe() {
  local directory="$1"
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const expectedUid = Number(process.argv[2]);
    const stat = fs.lstatSync(path);
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

gate_lock_current_host_fingerprint() {
  local host_name="$1"
  [[ -n "$host_name" && "$host_name" != *$'\n'* &&
    "$host_name" != *$'\r'* ]] || return 2
  node -e '
    const { createHash } = require("node:crypto");
    process.stdout.write(
      createHash("sha256").update(process.argv[1], "utf8").digest("hex"),
    );
  ' "$host_name" 2>/dev/null
}

gate_lock_ensure_local_host_fingerprint() {
  local host_fingerprint host_name machine_fingerprint no_machine_fingerprint
  local machine_identity machine_source
  if [[ -n "$gate_lock_local_host_name" &&
    "$gate_lock_local_host_fingerprint" =~ ^[0-9a-f]{64}$ &&
    "$gate_lock_local_machine_source" =~ ^(none|override|machineid|ioplatform|kernuuid)$ &&
    "$gate_lock_local_machine_fingerprint" =~ ^[0-9a-f]{64}$ &&
    "$gate_lock_no_machine_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
    return 0
  fi
  if ! host_name="$(uname -n 2>/dev/null)" ||
    [[ -z "$host_name" || "$host_name" == *$'\n'* ||
      "$host_name" == *$'\r'* ]] ||
    ! host_fingerprint="$(gate_lock_current_host_fingerprint "$host_name")" ||
    [[ ! "$host_fingerprint" =~ ^[0-9a-f]{64}$ ]] ||
    ! no_machine_fingerprint="$(
      gate_lock_current_host_fingerprint "<no-machine-identity>"
    )" || [[ ! "$no_machine_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
    gate_lock_local_host_name=""
    gate_lock_local_host_fingerprint=""
    gate_lock_local_machine_source=""
    gate_lock_local_machine_fingerprint=""
    gate_lock_no_machine_fingerprint=""
    return 2
  fi
  gate_lock_resolve_machine_id
  machine_identity="$gate_lock_machine_id_cached"
  if [[ -n "$machine_identity" ]]; then
    machine_source="${machine_identity%%:*}"
  else
    machine_source=none
    machine_identity="<no-machine-identity>"
  fi
  if [[ ! "$machine_source" =~ ^(none|override|machineid|ioplatform|kernuuid)$ ]] ||
    ! machine_fingerprint="$(gate_lock_current_host_fingerprint "$machine_identity")" ||
    [[ ! "$machine_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
    gate_lock_local_host_name=""
    gate_lock_local_host_fingerprint=""
    gate_lock_local_machine_source=""
    gate_lock_local_machine_fingerprint=""
    gate_lock_no_machine_fingerprint=""
    return 2
  fi
  gate_lock_local_host_name="$host_name"
  gate_lock_local_host_fingerprint="$host_fingerprint"
  gate_lock_local_machine_source="$machine_source"
  gate_lock_local_machine_fingerprint="$machine_fingerprint"
  gate_lock_no_machine_fingerprint="$no_machine_fingerprint"
}

# Owner quarantines name the process that CREATED the quarantine. That process
# can differ from the owner whose record is inside it, so recovery must never
# derive the creator's machine from the quarantined record. v2 binds the
# creator's tagged machine source and identity digest, hostname digest,
# creation time, and PID into the directory name. The digest keeps the stable
# identity out of a pathname while preserving exact comparisons.
gate_lock_owner_quarantine_template() {
  local parent="$1"
  local created_at
  [[ -n "$parent" &&
    "$gate_lock_local_machine_source" =~ ^(none|override|machineid|ioplatform|kernuuid)$ &&
    "$gate_lock_local_machine_fingerprint" =~ ^[0-9a-f]{64}$ &&
    "$gate_lock_local_host_fingerprint" =~ ^[0-9a-f]{64}$ ]] || return 2
  if ! created_at="$(date +%s 2>/dev/null)" ||
    [[ ! "$created_at" =~ ^[0-9]{1,12}$ ]]; then
    return 2
  fi
  printf '%s/owner.reclaiming.quarantine.v2.%s.%s.%s.%s.%s.XXXXXX\n' \
    "$parent" "$gate_lock_local_machine_source" \
    "$gate_lock_local_machine_fingerprint" \
    "$gate_lock_local_host_fingerprint" "$created_at" "$$"
}

# Node parses the quarantine creator PID as one JavaScript safe integer. Keep
# Bash on the same positive range without feeding an attacker-sized decimal to
# shell arithmetic. Equal-length ASCII decimal strings compare numerically.
gate_lock_quarantine_pid_is_safe_integer() {
  local value="$1"
  local LC_ALL=C
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || return 1
  if [[ "${#value}" -lt 16 ]]; then
    return 0
  fi
  [[ "${#value}" -eq 16 ]] || return 1
  # shellcheck disable=SC2071
  [[ "$value" == 9007199254740991 ||
    "$value" < 9007199254740991 ]]
}

# Compare the creator metadata in a v2 quarantine with this process. This is
# the digest form of gate_lock_machine_verdict. A matching machine digest on a
# possibly shared root still needs the hostname digest to match because cloned
# machine IDs are common in containers.
gate_lock_quarantine_creator_machine_verdict() {
  local creator_machine_source="$1"
  local creator_machine_fingerprint="$2"
  local creator_host_fingerprint="$3"
  local root_is_per_machine="$4"
  if [[ "$creator_machine_source" != none &&
    "$gate_lock_local_machine_source" != none ]]; then
    if [[ "$creator_machine_source" == "$gate_lock_local_machine_source" &&
      "$creator_machine_fingerprint" == "$gate_lock_local_machine_fingerprint" ]]; then
      if [[ "$root_is_per_machine" -eq 1 ||
        "$creator_host_fingerprint" == "$gate_lock_local_host_fingerprint" ]]; then
        printf 'same\n'
      else
        printf 'unverified\n'
      fi
    elif [[ "$creator_machine_source" == "$gate_lock_local_machine_source" &&
      "$root_is_per_machine" -ne 1 ]]; then
      printf 'other\n'
    else
      printf 'unverified\n'
    fi
    return 0
  fi
  if [[ "$creator_host_fingerprint" == "$gate_lock_local_host_fingerprint" ]]; then
    printf 'same\n'
  else
    printf 'unverified\n'
  fi
}

# v1 owner quarantines do not carry a creation epoch. Read the directory mtime
# only after validating the same current-user mode-0700 directory contract used
# by recovery. An unreadable timestamp returns no age and therefore cannot
# authorize an unverified reclaim.
gate_lock_private_directory_started_at() {
  # shellcheck disable=SC2016
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const expectedUid = Number(process.argv[2]);
    const stat = fs.lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== expectedUid ||
      (stat.mode & 0o777) !== 0o700 ||
      !Number.isFinite(stat.mtimeMs)
    ) process.exit(1);
    process.stdout.write(`${Math.floor(stat.mtimeMs / 1000)}\n`);
  ' "$1" "$(id -u)" 2>/dev/null
}

gate_lock_path_matches_open_descriptor() {
  local path="$1"
  local descriptor="$2"
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const descriptor = Number(process.argv[2]);
    const expectedUid = Number(process.argv[3]);
    const pathStat = fs.lstatSync(path, { bigint: true });
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    process.exit(
      pathStat.isFile() &&
      !pathStat.isSymbolicLink() &&
      descriptorStat.isFile() &&
      pathStat.uid === BigInt(expectedUid) &&
      descriptorStat.uid === BigInt(expectedUid) &&
      pathStat.dev === descriptorStat.dev &&
      pathStat.ino === descriptorStat.ino
        ? 0
        : 1,
    );
  ' "$path" "$descriptor" "$(id -u)" 2>/dev/null
}

gate_lock_retain_quarantine() {
  local reason="$1"
  local retention_state="$gate_lock_quarantine_retention_state"
  echo "error: ${reason}" >&2
  if [[ -n "$gate_lock_quarantine_dir" ]]; then
    echo "The owner quarantine was retained at ${gate_lock_quarantine_dir}. ${retention_state}" >&2
  else
    echo "The owner evidence was retained. ${retention_state}" >&2
  fi
  gate_lock_clear_quarantine_state
  return 2
}

gate_lock_prepare_owner_quarantine() {
  local record="$1"
  local retention_state="${2:-Nothing has been executed.}"
  local raw_marker_token="${3:-}"
  local authority_and_contract authority_status=0
  local parent quarantine quarantine_template
  local quarantine_prefix="owner.reclaiming.quarantine.v1"
  gate_lock_clear_quarantine_state
  gate_lock_quarantine_retention_state="$retention_state"
  if [[ -n "$raw_marker_token" ]]; then
    if ! gate_lock_token_is_wellformed "$raw_marker_token"; then
      gate_lock_clear_quarantine_state
      return 2
    fi
    gate_lock_quarantine_raw_marker_token="$raw_marker_token"
    quarantine_prefix="holder.reclaiming.quarantine.v1"
  fi
  parent="${record%/*}"
  if [[ -z "$parent" || "$parent" == "$record" ||
    ! "$gate_lock_local_host_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
    gate_lock_clear_quarantine_state
    return 2
  fi
  if [[ -n "$raw_marker_token" ]]; then
    quarantine_template="${parent}/${quarantine_prefix}.${gate_lock_local_host_fingerprint}.$$.XXXXXX"
  elif ! quarantine_template="$(gate_lock_owner_quarantine_template "$parent")"; then
    gate_lock_clear_quarantine_state
    return 2
  fi
  if ! quarantine="$(mktemp -d "$quarantine_template")"; then
    gate_lock_clear_quarantine_state
    return 2
  fi
  if ! chmod 700 "$quarantine" ||
    ! gate_lock_private_quarantine_directory_is_safe "$quarantine"; then
    rmdir "$quarantine" 2>/dev/null || true
    gate_lock_clear_quarantine_state
    return 2
  fi
  gate_lock_quarantine_dir="$quarantine"
  gate_lock_quarantine_origin="$record"
  gate_lock_quarantine_anchor="${quarantine}/anchor"
  gate_lock_quarantine_taken="${quarantine}/record"
  gate_lock_quarantine_fallback="${quarantine}/fallback-ready"
  # `-P` is required on macOS. Without it, ln follows a source symlink and the
  # witness can name the symlink target instead of the shared directory entry.
  if ! /bin/ln -P "$record" "$gate_lock_quarantine_anchor" 2>/dev/null; then
    rmdir "$quarantine" 2>/dev/null || true
    gate_lock_clear_quarantine_state
    [[ ! -e "$record" && ! -L "$record" ]] && return 1
    return 2
  fi
  authority_and_contract="$(
    gate_lock_quarantine_authority_and_contract_from_record \
      "$gate_lock_quarantine_anchor"
  )" || authority_status=$?
  if [[ "$authority_status" -eq 2 ]]; then
    gate_lock_retain_quarantine \
      "Darwin coordinator-owner recovery requires exact per-command lineage evidence"
    return 2
  fi
  if [[ "$authority_status" -ne 0 ||
    "$authority_and_contract" != *$'\n'* ]]; then
    gate_lock_report_foreign_owner_recovery \
      "$record" "$gate_lock_quarantine_retention_state"
    gate_lock_retain_quarantine \
      "the quality-gate owner witness is foreign or unsafe"
    return 2
  fi
  gate_lock_quarantine_authority_value="${authority_and_contract%%$'\n'*}"
  gate_lock_quarantine_recovery_contract="${authority_and_contract#*$'\n'}"
  gate_recovery_lifecycle_contract_is_supported \
    "$gate_lock_quarantine_recovery_contract" || {
    gate_lock_retain_quarantine \
      "the quality-gate owner witness has an unsupported recovery contract"
    return 2
  }
  if ! gate_lock_wait_for_test_barrier "$owner_witness_test_barrier"; then
    gate_lock_retain_quarantine \
      "the quality-gate owner witness barrier failed"
    return 2
  fi
  gate_lock_test_crash after-owner-quarantine-anchor
}

gate_lock_mark_quarantine_fallback() {
  [[ -n "$gate_lock_quarantine_fallback" ]] || return 2
  if ! gate_lock_private_quarantine_directory_is_safe "$gate_lock_quarantine_dir" ||
    ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_anchor" ||
    ! printf '%s\n' "$gate_lock_quarantine_authority_value" \
      > "$gate_lock_quarantine_fallback" ||
    ! chmod 600 "$gate_lock_quarantine_fallback"; then
    gate_lock_retain_quarantine \
      "could not record the quality-gate owner quarantine fallback"
    return 2
  fi
  gate_lock_test_crash after-owner-quarantine-fallback
}

gate_lock_quarantine_fallback_is_valid() {
  local value
  [[ -f "$gate_lock_quarantine_fallback" &&
    ! -L "$gate_lock_quarantine_fallback" &&
    -O "$gate_lock_quarantine_fallback" ]] || return 1
  value="$(sed -n '1p' "$gate_lock_quarantine_fallback" 2>/dev/null)" ||
    return 1
  [[ "$value" == "$gate_lock_quarantine_authority_value" ]]
}

gate_lock_cancel_prepared_quarantine() {
  if ! gate_lock_private_quarantine_directory_is_safe "$gate_lock_quarantine_dir" ||
    [[ -e "$gate_lock_quarantine_taken" || -L "$gate_lock_quarantine_taken" ]] ||
    [[ -e "$gate_lock_quarantine_fallback" || -L "$gate_lock_quarantine_fallback" ]] ||
    ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_origin" ||
    ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_anchor" ||
    [[ ! "$gate_lock_quarantine_origin" -ef "$gate_lock_quarantine_anchor" ]] ||
    ! /bin/rm -f "$gate_lock_quarantine_anchor" ||
    ! /bin/rmdir "$gate_lock_quarantine_dir"; then
    gate_lock_retain_quarantine \
      "could not cancel the prepared quality-gate owner quarantine"
    return 2
  fi
  gate_lock_clear_quarantine_state
}

gate_lock_take_prepared_quarantine() {
  local observed_authority_value
  [[ -n "$gate_lock_quarantine_dir" &&
    -n "$gate_lock_quarantine_origin" &&
    -n "$gate_lock_quarantine_anchor" &&
    -n "$gate_lock_quarantine_taken" &&
    -n "$gate_lock_quarantine_fallback" ]] || return 2
  gate_lock_quarantine_fallback_is_valid || return 2
  if ! gate_lock_wait_for_test_barrier "$owner_discard_test_barrier"; then
    gate_lock_retain_quarantine \
      "the quality-gate owner discard barrier failed"
    return 2
  fi
  gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_DISCARD_DELAY_SECONDS:-}"
  if ! gate_lock_private_quarantine_directory_is_safe "$gate_lock_quarantine_dir" ||
    ! gate_lock_quarantine_fallback_is_valid ||
    [[ -e "$gate_lock_quarantine_taken" || -L "$gate_lock_quarantine_taken" ]]; then
    gate_lock_retain_quarantine \
      "the quality-gate owner path could not enter its private quarantine"
    return 2
  fi
  if ! /bin/mv "$gate_lock_quarantine_origin" \
    "$gate_lock_quarantine_taken" 2>/dev/null; then
    # An active releaser can move a recovery-visible remnant after this gate
    # hard-links its exact inode and establishes the canonical fallback. The
    # missing source is a completed competing move, not changed evidence.
    [[ ! -e "$gate_lock_quarantine_origin" &&
      ! -L "$gate_lock_quarantine_origin" ]] && return 1
    gate_lock_retain_quarantine \
      "the quality-gate owner path could not enter its private quarantine"
    return 2
  fi
  gate_lock_test_crash after-owner-quarantine-take
  if ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_taken" ||
    [[ ! "$gate_lock_quarantine_taken" -ef "$gate_lock_quarantine_anchor" ]]; then
    gate_lock_retain_quarantine \
      "the quality-gate owner inode changed before quarantine"
    return 2
  fi
  if ! observed_authority_value="$(
    gate_lock_quarantine_authority_from_record "$gate_lock_quarantine_taken"
  )" || [[ "$observed_authority_value" != "$gate_lock_quarantine_authority_value" ]]; then
    gate_lock_retain_quarantine \
      "the quality-gate owner authority changed before quarantine"
    return 2
  fi
  if ! gate_lock_wait_for_test_barrier "$owner_quarantined_test_barrier"; then
    gate_lock_retain_quarantine \
      "the quarantined quality-gate owner barrier failed"
    return 2
  fi
  if [[ -e "$gate_lock_quarantine_origin" || -L "$gate_lock_quarantine_origin" ]]; then
    gate_lock_retain_quarantine \
      "replacement quality-gate owner evidence appeared after quarantine"
    return 2
  fi
}

gate_lock_drop_private_quarantine() {
  local observed_authority_value
  if ! gate_lock_private_quarantine_directory_is_safe "$gate_lock_quarantine_dir" ||
    ! gate_lock_quarantine_fallback_is_valid ||
    ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_anchor" ||
    ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_taken" ||
    [[ ! "$gate_lock_quarantine_taken" -ef "$gate_lock_quarantine_anchor" ]] ||
    ! observed_authority_value="$(
      gate_lock_quarantine_authority_from_record "$gate_lock_quarantine_taken"
    )" || [[ "$observed_authority_value" != "$gate_lock_quarantine_authority_value" ]]; then
    gate_lock_retain_quarantine \
      "the private quality-gate owner evidence changed before deletion"
    return 2
  fi
  if ! /bin/rm -f "$gate_lock_quarantine_taken" ||
    ! /bin/rm -f "$gate_lock_quarantine_anchor" ||
    ! /bin/rm -f "$gate_lock_quarantine_fallback" ||
    ! /bin/rmdir "$gate_lock_quarantine_dir"; then
    gate_lock_retain_quarantine \
      "could not remove the private quality-gate owner quarantine"
    return 2
  fi
  gate_lock_clear_quarantine_state
}

gate_lock_drop_prepared_quarantine_without_taken() {
  local observed_authority_value
  if ! gate_lock_private_quarantine_directory_is_safe "$gate_lock_quarantine_dir" ||
    ! gate_lock_quarantine_fallback_is_valid ||
    ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_anchor" ||
    [[ -e "$gate_lock_quarantine_taken" || -L "$gate_lock_quarantine_taken" ]] ||
    [[ -e "$gate_lock_quarantine_origin" || -L "$gate_lock_quarantine_origin" ]] ||
    ! observed_authority_value="$(
      gate_lock_quarantine_authority_from_record "$gate_lock_quarantine_anchor"
    )" || [[ "$observed_authority_value" != "$gate_lock_quarantine_authority_value" ]]; then
    gate_lock_retain_quarantine \
      "the moved quality-gate owner evidence changed before private cleanup"
    return 2
  fi
  if ! /bin/rm -f "$gate_lock_quarantine_anchor" ||
    ! /bin/rm -f "$gate_lock_quarantine_fallback" ||
    ! /bin/rmdir "$gate_lock_quarantine_dir"; then
    gate_lock_retain_quarantine \
      "could not remove the prepared quality-gate owner quarantine"
    return 2
  fi
  gate_lock_clear_quarantine_state
}

gate_run_restore_quarantined_marker() {
  local marker="$1"
  local taken="$2"
  local quarantine="$3"
  local expected_token_value="$4"
  if [[ ! -e "$taken" && ! -L "$taken" ]]; then
    echo "error: run-marker cleanup retained ${quarantine}; no moved marker was available to restore." >&2
    return 2
  fi
  if ! gate_run_marker_snapshot_is_exact "$taken" "$expected_token_value"; then
    echo "error: the moved run marker is unsafe or has changed bytes; it remains only in ${quarantine}." >&2
    return 2
  fi
  if /bin/ln -P "$taken" "$marker" 2>/dev/null; then
    if [[ "$marker" -ef "$taken" ]] &&
      gate_run_marker_snapshot_is_exact "$taken" "$expected_token_value" &&
      gate_run_marker_snapshot_is_exact "$marker" "$expected_token_value"; then
      echo "error: a changed run marker was restored at ${marker}; its quarantine was retained at ${quarantine}." >&2
      return 2
    fi
    echo "error: run-marker cleanup published an unverified canonical link at ${marker}; ${quarantine} was retained." >&2
    return 2
  fi
  if [[ -e "$marker" || -L "$marker" ]]; then
    if [[ "$marker" -ef "$taken" ]]; then
      echo "error: a changed run marker remains visible at ${marker}; its quarantine was retained at ${quarantine}." >&2
    else
      echo "error: could not restore the changed run marker at ${marker} because that path is occupied; ${quarantine} was retained." >&2
    fi
  else
    echo "error: could not restore the changed run marker at ${marker}; ${quarantine} was retained." >&2
  fi
  return 2
}

gate_run_marker_cleanup_was_refused() {
  local expected_token_value="$1"
  case " ${gate_run_marker_cleanup_refused_tokens} " in
    *" ${expected_token_value} "*) return 0 ;;
  esac
  return 1
}

gate_run_stop_marker_cleanup_retries() {
  local marker="$1"
  local expected_token_value="$2"
  if ! gate_run_marker_cleanup_was_refused "$expected_token_value"; then
    if [[ -n "$gate_run_marker_cleanup_refused_tokens" ]]; then
      gate_run_marker_cleanup_refused_tokens="${gate_run_marker_cleanup_refused_tokens} ${expected_token_value}"
    else
      gate_run_marker_cleanup_refused_tokens="$expected_token_value"
    fi
  fi
  if [[ "$marker" == "$gate_run_marker_file" ]]; then
    gate_run_marker_file=""
  fi
}

gate_run_discard_marker_exact() {
  local expected_token_value="$1"
  local retention_state="${2:-Nothing has been executed.}"
  local marker prepare_status take_status drop_status
  local quarantine anchor taken
  gate_lock_token_is_wellformed "$expected_token_value" || return 2
  gate_run_marker_cleanup_was_refused "$expected_token_value" && return 2
  marker="$(gate_run_marker_path "$expected_token_value")" || return 0
  if gate_lock_prepare_owner_quarantine \
    "$marker" "$retention_state" "$expected_token_value"; then
    :
  else
    prepare_status=$?
    [[ "$prepare_status" -eq 1 && ! -e "$marker" && ! -L "$marker" ]] &&
      return 0
    gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
    return 2
  fi
  quarantine="$gate_lock_quarantine_dir"
  anchor="$gate_lock_quarantine_anchor"
  taken="$gate_lock_quarantine_taken"
  if ! gate_run_marker_snapshot_is_exact "$anchor" "$expected_token_value"; then
    gate_lock_retain_quarantine \
      "the run-marker witness has unsafe ownership, changed bytes, or a changed inode" || true
    gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
    return 2
  fi
  if [[ -n "$marker_witness_test_barrier" &&
    "$marker" == "$gate_run_marker_file" ]]; then
    if ! gate_lock_wait_for_test_barrier "$marker_witness_test_barrier"; then
      gate_lock_retain_quarantine \
        "the run-marker witness barrier failed" || true
      gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
      return 2
    fi
  fi
  gate_lock_test_crash after-run-marker-quarantine-anchor
  if ! gate_lock_mark_quarantine_fallback; then
    gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
    return 2
  fi
  if gate_lock_take_prepared_quarantine; then
    if ! gate_run_marker_snapshot_is_exact "$taken" "$expected_token_value"; then
      gate_lock_retain_quarantine \
        "the run marker changed after its exact witness was bound" || true
      gate_run_restore_quarantined_marker \
        "$marker" "$taken" "$quarantine" "$expected_token_value" || true
      gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
      return 2
    fi
    if gate_lock_drop_private_quarantine; then
      return 0
    else
      drop_status=$?
    fi
    gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
    return "$drop_status"
  else
    take_status=$?
  fi
  if [[ "$take_status" -eq 1 ]]; then
    if ! gate_run_marker_snapshot_is_exact "$anchor" "$expected_token_value"; then
      gate_lock_retain_quarantine \
        "the run-marker witness changed after a competing cleanup" || true
      gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
      return 2
    fi
    if gate_lock_drop_prepared_quarantine_without_taken; then
      return 0
    else
      drop_status=$?
    fi
    gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
    return "$drop_status"
  fi
  if [[ -e "$taken" || -L "$taken" ]]; then
    gate_run_restore_quarantined_marker \
      "$marker" "$taken" "$quarantine" "$expected_token_value" || true
  fi
  gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
  return 2
}

gate_lock_finish_canonical_quarantine() {
  local canonical="$1"
  local expected_token_value="$2"
  local canonical_authority_value take_status quarantine_has_taken=0
  if gate_lock_take_prepared_quarantine; then
    quarantine_has_taken=1
  else
    take_status=$?
    [[ "$take_status" -eq 1 ]] || return 2
  fi
  if ! canonical_authority_value="$(
    gate_lock_current_user_authority_token_from_record "$canonical"
  )" || [[ "$canonical_authority_value" != "$expected_token_value" ]] ||
    [[ ! "$canonical" -ef "$gate_lock_quarantine_anchor" ]]; then
    gate_lock_retain_quarantine \
      "the canonical quality-gate owner changed during private cleanup"
    return 2
  fi
  if [[ "$quarantine_has_taken" -eq 1 ]]; then
    gate_lock_drop_private_quarantine
  else
    gate_lock_drop_prepared_quarantine_without_taken
  fi
}

gate_lock_discard_inert_owner_stage() {
  local record="$1"
  local publisher_pid="$2"
  local retention_state="${3:-Nothing has been executed.}"
  local prepare_status take_status
  if gate_lock_prepare_owner_quarantine "$record" "$retention_state"; then
    :
  else
    prepare_status=$?
    [[ "$prepare_status" -eq 1 && ! -e "$record" && ! -L "$record" ]] &&
      return 0
    return 2
  fi
  # Bind the stage inode before the final PID check. A reused publisher PID can
  # replace the same stage pathname after an earlier liveness verdict. A live
  # publisher keeps its stage; a replacement inode is retained by the take.
  if gate_lock_holder_is_live "$publisher_pid" ""; then
    gate_lock_cancel_prepared_quarantine
    return $?
  fi
  gate_lock_mark_quarantine_fallback || return 2
  if gate_lock_take_prepared_quarantine; then
    gate_lock_drop_private_quarantine
  else
    take_status=$?
    [[ "$take_status" -eq 1 ]] || return 2
    gate_lock_drop_prepared_quarantine_without_taken
  fi
}

gate_lock_condemn_prepared_quarantine() {
  local obligation_status take_status
  if [[ -n "$gate_lock_quarantine_authority_value" ]]; then
    if record_condemned_run \
      "$gate_lock_quarantine_authority_value" \
      "$gate_lock_quarantine_recovery_contract"; then
      :
    else
      obligation_status=$?
      gate_lock_cancel_prepared_quarantine || return 2
      return "$obligation_status"
    fi
  fi
  gate_lock_mark_quarantine_fallback || return 2
  if gate_lock_take_prepared_quarantine; then
    gate_lock_drop_private_quarantine
  else
    take_status=$?
    [[ "$take_status" -eq 1 ]] || return 2
    gate_lock_drop_prepared_quarantine_without_taken
  fi
}

gate_lock_condemn_and_discard() {
  local record="$1"
  if ! gate_lock_prepare_owner_quarantine "$record"; then
    [[ -z "$gate_lock_quarantine_dir" ]] || gate_lock_clear_quarantine_state
    return 2
  fi
  gate_lock_condemn_prepared_quarantine
}

gate_lock_discard_matching_duplicate() {
  local record="$1"
  local expected_token_value="$2"
  local canonical="$3"
  local canonical_authority_value
  gate_lock_prepare_owner_quarantine "$record" || return 2
  if ! canonical_authority_value="$(
    gate_lock_current_user_authority_token_from_record "$canonical"
  )" || [[ "$canonical_authority_value" != "$expected_token_value" ]] ||
    [[ "$gate_lock_quarantine_authority_value" != "$expected_token_value" ]] ||
    [[ ! "$canonical" -ef "$gate_lock_quarantine_anchor" ]]; then
    gate_lock_retain_quarantine \
      "the canonical quality-gate owner does not match the duplicate inode"
    return 2
  fi
  gate_lock_mark_quarantine_fallback || return 2
  gate_lock_finish_canonical_quarantine "$canonical" "$expected_token_value"
}

gate_lock_report_foreign_owner_recovery() {
  local record="$1"
  local retention_state="${2:-Nothing has been executed.}"
  echo "error: the stale quality-gate owner record at ${record} belongs to another user or has inconsistent uid metadata." >&2
  echo "This gate can wait on that shared owner, but it cannot safely inspect or signal the prior user's surviving commands." >&2
  echo "The owner and generation evidence were retained. ${retention_state}" >&2
  echo "Have the owning user or an administrator recover the stale generation." >&2
}

gate_lock_refuse_foreign_owner_recovery() {
  gate_lock_report_foreign_owner_recovery "$1"
  gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
    "No mapped command ran in this request"
  exit 2
}

gate_lock_regular_file_link_count() {
  # The dollar expression below is a JavaScript template literal.
  # shellcheck disable=SC2016
  node -e '
    const fs = require("node:fs");
    const stat = fs.lstatSync(process.argv[1]);
    if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
    process.stdout.write(`${stat.nlink}\n`);
  ' "$1" 2>/dev/null
}

gate_lock_recover_owner_quarantine() {
  local quarantine="$1"
  local anchor="${quarantine}/anchor"
  local taken="${quarantine}/record"
  local fallback="${quarantine}/fallback-ready"
  local extra authority_value taken_authority_value fallback_value link_count
  if ! gate_lock_private_quarantine_directory_is_safe "$quarantine"; then
    [[ ! -e "$quarantine" && ! -L "$quarantine" ]] && return 0
    echo "error: the quality-gate owner quarantine at ${quarantine} is not a current-user mode-0700 directory." >&2
    return 2
  fi
  extra="$(
    find "$quarantine" -mindepth 1 -maxdepth 1 \
      ! -name anchor ! -name record ! -name fallback-ready \
      -print -quit 2>/dev/null
  )"
  if [[ -n "$extra" ]]; then
    echo "error: the quality-gate owner quarantine at ${quarantine} contains unexpected evidence: ${extra}." >&2
    return 2
  fi
  if [[ ! -e "$anchor" && ! -L "$anchor" ]]; then
    if [[ -e "$taken" || -L "$taken" ]]; then
      echo "error: the quality-gate owner quarantine at ${quarantine} lost its inode witness." >&2
      return 2
    fi
    if [[ -e "$fallback" || -L "$fallback" ]]; then
      [[ -f "$fallback" && ! -L "$fallback" && -O "$fallback" ]] || return 2
      /bin/rm -f "$fallback" || return 2
    fi
    /bin/rmdir "$quarantine"
    return
  fi
  if ! authority_value="$(
    gate_lock_current_user_authority_token_from_record "$anchor"
  )"; then
    gate_lock_report_foreign_owner_recovery "$anchor"
    return 2
  fi
  if [[ ! -e "$fallback" && ! -L "$fallback" ]]; then
    [[ ! -e "$taken" && ! -L "$taken" ]] || {
      echo "error: the quality-gate owner quarantine at ${quarantine} moved evidence before it recorded a fallback." >&2
      return 2
    }
    link_count="$(gate_lock_regular_file_link_count "$anchor")" || return 2
    if [[ ! "$link_count" =~ ^[0-9]+$ ]] || [[ "$link_count" -lt 2 ]]; then
      echo "error: the pre-fallback quality-gate owner witness at ${anchor} has no visible sibling link." >&2
      return 2
    fi
    /bin/rm -f "$anchor" || return 2
    /bin/rmdir "$quarantine"
    return
  fi
  if [[ ! -f "$fallback" || -L "$fallback" || ! -O "$fallback" ]]; then
    echo "error: the quality-gate owner quarantine fallback at ${fallback} is unsafe." >&2
    return 2
  fi
  fallback_value="$(sed -n '1p' "$fallback" 2>/dev/null)" || return 2
  [[ "$fallback_value" == "$authority_value" ]] || {
    echo "error: the quality-gate owner quarantine fallback at ${fallback} names different authority." >&2
    return 2
  }
  if [[ -e "$taken" || -L "$taken" ]]; then
    if ! taken_authority_value="$(
      gate_lock_current_user_authority_token_from_record "$taken"
    )" || [[ "$taken_authority_value" != "$authority_value" ]] ||
      [[ ! "$taken" -ef "$anchor" ]]; then
      echo "error: the quality-gate owner quarantine at ${quarantine} retained an inode replacement." >&2
      return 2
    fi
    /bin/rm -f "$taken" || return 2
  fi
  /bin/rm -f "$anchor" || return 2
  /bin/rm -f "$fallback" || return 2
  /bin/rmdir "$quarantine"
}

gate_lock_claim_owner_quarantine() {
  local source="$1"
  local parent claimed claim_status quarantine_template
  gate_lock_claimed_quarantine=""
  parent="${source%/*}"
  [[ -n "$parent" && "$parent" != "$source" ]] || return 2
  [[ "$gate_lock_local_host_fingerprint" =~ ^[0-9a-f]{64}$ ]] || return 2
  quarantine_template="$(gate_lock_owner_quarantine_template "$parent")" ||
    return 2
  claimed="$(mktemp -d "$quarantine_template")" ||
    return 2
  if ! chmod 700 "$claimed" ||
    ! gate_lock_private_quarantine_directory_is_safe "$claimed"; then
    /bin/rmdir "$claimed" 2>/dev/null || true
    return 2
  fi
  gate_lock_claimed_quarantine="$claimed"
  # The dollar expressions below are JavaScript template literals.
  # shellcheck disable=SC2016
  if node -e '
    const fs = require("node:fs");
    const { constants } = fs;
    const [source, target, parent, uidText, claimOpenBarrier] =
      process.argv.slice(1);
    const expectedUid = BigInt(uidText);
    let sourceDescriptor;
    let targetDescriptor;
    let parentDescriptor;
    let claimedDescriptor;
    let status = 0;

    function sameInode(first, second) {
      return first.dev === second.dev && first.ino === second.ino;
    }

    function requirePrivateDirectory(stat, label) {
      if (
        !stat.isDirectory() ||
        stat.uid !== expectedUid ||
        (stat.mode & 0o777n) !== 0o700n
      ) {
        throw new Error(`${label} is not a current-user mode-0700 directory`);
      }
    }

    function requirePathIdentity(path, expected, label) {
      const observed = fs.lstatSync(path, { bigint: true });
      requirePrivateDirectory(observed, label);
      if (observed.isSymbolicLink() || !sameInode(observed, expected)) {
        throw new Error(`${label} pathname changed before its atomic claim`);
      }
    }

    function pathEntryExists(path) {
      try {
        fs.lstatSync(path);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }

    function waitForTestBarrierInstance(barrier) {
      if (!barrier) return;
      const ready = `${barrier}.ready.${process.pid}`;
      const release = `${barrier}.release`;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      fs.writeFileSync(ready, "", { flag: "wx", mode: 0o600 });
      for (let waited = 0; !pathEntryExists(release); waited += 1) {
        if (waited >= 600) {
          throw new Error("quarantine claim open barrier timed out");
        }
        Atomics.wait(sleeper, 0, 0, 50);
      }
    }

    try {
      if (
        !Number.isInteger(constants.O_DIRECTORY) ||
        !Number.isInteger(constants.O_NOFOLLOW)
      ) {
        throw new Error("directory no-follow support is unavailable");
      }
      try {
        sourceDescriptor = fs.openSync(
          source,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (error.code === "ENOENT") {
          status = 3;
        } else {
          throw error;
        }
      }
      if (status === 0) {
        targetDescriptor = fs.openSync(
          target,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const sourceStat = fs.fstatSync(sourceDescriptor, { bigint: true });
        const targetStat = fs.fstatSync(targetDescriptor, { bigint: true });
        requirePrivateDirectory(sourceStat, "source quarantine");
        requirePrivateDirectory(targetStat, "claim placeholder");
        waitForTestBarrierInstance(claimOpenBarrier);
        try {
          requirePathIdentity(source, sourceStat, "source quarantine");
        } catch (error) {
          if (error.code === "ENOENT" && !pathEntryExists(source)) {
            status = 3;
          } else {
            throw error;
          }
        }
        if (status === 0) {
          requirePathIdentity(target, targetStat, "claim placeholder");
          if (fs.readdirSync(target).length !== 0) {
            throw new Error("claim placeholder is not empty");
          }
          parentDescriptor = fs.openSync(
            parent,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            fs.renameSync(source, target);
          } catch (error) {
            if (error.code === "ENOENT" && !pathEntryExists(source)) {
              status = 3;
            } else {
              throw error;
            }
          }
          if (status === 0) {
            fs.fsyncSync(parentDescriptor);
            claimedDescriptor = fs.openSync(
              target,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            const claimedStat = fs.fstatSync(claimedDescriptor, { bigint: true });
            requirePrivateDirectory(claimedStat, "claimed quarantine");
            if (!sameInode(claimedStat, sourceStat)) {
              throw new Error("claimed quarantine does not match the source inode");
            }
            requirePathIdentity(target, claimedStat, "claimed quarantine");
            fs.fsyncSync(claimedDescriptor);
          }
        }
      }
    } catch (error) {
      process.stderr.write(`quality-gate quarantine claim failed: ${error.message}\n`);
      status = 2;
    } finally {
      if (claimedDescriptor !== undefined) fs.closeSync(claimedDescriptor);
      if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
      if (targetDescriptor !== undefined) fs.closeSync(targetDescriptor);
      if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
    }
    process.exitCode = status;
  ' "$source" "$claimed" "$parent" "$(id -u)" \
    "$owner_quarantine_claim_open_test_barrier"; then
    if ! gate_lock_wait_for_test_barrier "$owner_quarantine_after_claim_test_barrier"; then
      echo "error: the claimed quality-gate owner quarantine barrier failed." >&2
      return 2
    fi
    return 0
  else
    claim_status=$?
  fi
  if [[ "$claim_status" -eq 3 ]]; then
    if gate_lock_recover_owner_quarantine "$claimed"; then
      gate_lock_claimed_quarantine=""
      return 1
    fi
  fi
  echo "error: could not atomically claim the quality-gate owner quarantine at ${source}." >&2
  echo "The source and claim evidence were retained. Nothing has been executed." >&2
  return 2
}

gate_lock_recover_hidden_record() {
  local lock="$1"
  local this_host="$2"
  local remnant remnant_name creator_version creator_machine_source
  local creator_machine_fingerprint creator_host_fingerprint creator_started_at
  local creator_pid creator_nonce creator_machine_verdict creator_age
  local creator_pid_is_local
  local dead_quarantine claim_status pid host machine start started_at
  local machine_verdict record_age prepare_status recovered=1
  local active_quarantine=0
  # Settle private quarantines before ordinary remnants. A crash after the
  # hard-link witness leaves both paths. Processing the ordinary remnant first
  # can retire that inode and reduce the older witness to one link before its
  # pre-fallback recovery check. A dead creator can still have an orphaned
  # `/bin/mv` child in flight. Rename the whole directory to this waiter's
  # identity before reading a phase. The directory rename orders recovery with
  # that child and with every other waiter.
  while :; do
    active_quarantine=0
    dead_quarantine=""
    gate_lock_active_quarantine_pid=""
    gate_lock_active_quarantine_host=""
    for remnant in "$lock"/owner.reclaiming.quarantine.*; do
      [[ -e "$remnant" || -L "$remnant" ]] || continue
      remnant_name="${remnant##*/}"
      creator_version=""
      creator_machine_source=none
      creator_machine_fingerprint=""
      creator_host_fingerprint=""
      creator_started_at=""
      creator_pid=""
      creator_nonce=""
      if [[ "$remnant_name" =~ ^owner\.reclaiming\.quarantine\.v2\.(none|override|machineid|ioplatform|kernuuid)\.([0-9a-f]+)\.([0-9a-f]+)\.([0-9]{1,12})\.([1-9][0-9]*)\.([A-Za-z0-9][A-Za-z0-9.-]*)$ ]]; then
        creator_version=v2
        creator_machine_source="${BASH_REMATCH[1]}"
        creator_machine_fingerprint="${BASH_REMATCH[2]}"
        creator_host_fingerprint="${BASH_REMATCH[3]}"
        creator_started_at="${BASH_REMATCH[4]}"
        creator_pid="${BASH_REMATCH[5]}"
        creator_nonce="${BASH_REMATCH[6]}"
      elif [[ "$remnant_name" =~ ^owner\.reclaiming\.quarantine\.v1\.([0-9a-f]+)\.([1-9][0-9]*)\.([A-Za-z0-9][A-Za-z0-9.-]*)$ ]]; then
        creator_version=v1
        creator_host_fingerprint="${BASH_REMATCH[1]}"
        creator_pid="${BASH_REMATCH[2]}"
        creator_nonce="${BASH_REMATCH[3]}"
      else
        echo "error: the quality-gate owner quarantine has an invalid recovery name: ${remnant}." >&2
        echo "The quarantine was retained. Nothing has been executed." >&2
        gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
      if [[ "${#creator_host_fingerprint}" -ne 64 ||
        ( "$creator_version" == v2 && "${#creator_machine_fingerprint}" -ne 64 ) ||
        ( "$creator_version" == v2 && "$creator_started_at" == 0* ) ||
        ( "$creator_version" == v2 && "$creator_machine_source" == none &&
          "$creator_machine_fingerprint" != "$gate_lock_no_machine_fingerprint" ) ||
        "${#creator_nonce}" -lt 6 || "${#creator_nonce}" -gt 80 ]] ||
        ! gate_lock_quarantine_pid_is_safe_integer "$creator_pid"; then
        echo "error: the quality-gate owner quarantine has an invalid recovery name: ${remnant}." >&2
        echo "The quarantine was retained. Nothing has been executed." >&2
        gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
      if ! gate_lock_private_quarantine_directory_is_safe "$remnant"; then
        echo "error: the quality-gate owner quarantine at ${remnant} is not a current-user mode-0700 directory." >&2
        echo "The quarantine was retained. Nothing has been executed." >&2
        gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
      if [[ "$creator_version" == v1 ]]; then
        creator_machine_source=none
        creator_machine_fingerprint="$gate_lock_local_machine_fingerprint"
        creator_started_at="$(gate_lock_private_directory_started_at "$remnant" || true)"
      fi
      creator_machine_verdict="$(
        gate_lock_quarantine_creator_machine_verdict \
          "$creator_machine_source" "$creator_machine_fingerprint" \
          "$creator_host_fingerprint" "$gate_lock_root_is_per_machine"
      )"
      creator_age="$(gate_lock_record_age_seconds "$creator_started_at")"
      creator_pid_is_local=0
      if [[ "$creator_machine_verdict" == same ]]; then
        creator_pid_is_local=1
      elif [[ "$creator_machine_verdict" == unverified &&
        "$gate_lock_root_is_per_machine" -eq 1 &&
        -n "$creator_age" &&
        "$creator_age" -ge "$gate_lock_unverified_machine_grace_seconds" ]]; then
        creator_pid_is_local=1
      fi
      if [[ "$creator_pid_is_local" -eq 1 ]] &&
        ! gate_lock_holder_is_live "$creator_pid" ""; then
        [[ -n "$dead_quarantine" ]] || dead_quarantine="$remnant"
        # Recover one dead quarantine at a time. Every other dead quarantine is
        # also inactive, so it cannot turn this scan into a false busy verdict.
        continue
      fi
      # `other` and shared-root `unverified` evidence never leads to a local PID
      # lookup. Young or age-unknown unverified evidence on a per-machine root
      # also remains active until the grace can establish a reclaimable case.
      active_quarantine=1
      [[ -n "$gate_lock_active_quarantine_pid" ]] ||
        gate_lock_active_quarantine_pid="$creator_pid"
      if [[ -z "$gate_lock_active_quarantine_host" ]]; then
        if [[ "$creator_machine_verdict" == same ]]; then
          gate_lock_active_quarantine_host="$this_host"
        elif [[ "$creator_machine_verdict" == other ]]; then
          gate_lock_active_quarantine_host="other machine ${creator_machine_source}:${creator_machine_fingerprint:0:12}"
        else
          gate_lock_active_quarantine_host="unverified machine ${creator_host_fingerprint:0:12}"
        fi
      fi
    done
    # Never mutate one quarantine while another live or non-local creator can
    # still advance its phase in the same lock directory.
    [[ "$active_quarantine" -eq 0 ]] || return 4
    [[ -n "$dead_quarantine" ]] || break
    if ! gate_lock_wait_for_test_barrier_instance "$owner_quarantine_before_claim_test_barrier"; then
      echo "error: the quality-gate owner quarantine claim barrier failed." >&2
      gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
        "No mapped command ran in this request"
      exit 2
    fi
    if gate_lock_claim_owner_quarantine "$dead_quarantine"; then
      if gate_lock_recover_owner_quarantine "$gate_lock_claimed_quarantine"; then
        gate_lock_claimed_quarantine=""
        recovered=0
        continue
      fi
      echo "The claimed quarantine was retained. Nothing has been executed." >&2
      gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
        "No mapped command ran in this request"
      exit 2
    else
      claim_status=$?
    fi
    if [[ "$claim_status" -eq 1 ]]; then
      # Another waiter claimed the old basename. Restart the glob so this pass
      # sees and waits on that waiter's new basename before ordinary recovery.
      recovered=0
      continue
    fi
    echo "The quarantine was retained. Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
      "No mapped command ran in this request"
    exit 2
  done
  for remnant in "$lock"/owner.reclaiming.*; do
    [[ -e "$remnant" || -L "$remnant" ]] || continue
    [[ "${remnant##*/}" == owner.reclaiming.quarantine.* ]] && continue
    if ! gate_lock_record_is_readable_regular "$remnant"; then
      # Another waiter can restore or remove this remnant after the glob saw
      # it. Treat that release race as absent, while retaining dangling links.
      [[ ! -e "$remnant" && ! -L "$remnant" ]] && continue
      # A shared root can expose another user's mode-0600 record. Empty field
      # reads are not evidence that its holder is dead. Unknown file types are
      # equally unsafe because legitimate remnants are regular files.
      echo "error: the hidden quality-gate owner record at ${remnant} is not a readable regular file." >&2
      echo "The record was retained. Nothing has been executed." >&2
      gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
        "No mapped command ran in this request"
      exit 2
    fi
    if gate_lock_prepare_owner_quarantine "$remnant"; then
      :
    else
      prepare_status=$?
      if [[ "$prepare_status" -eq 1 &&
        ! -e "$remnant" && ! -L "$remnant" ]]; then
        continue
      fi
      if [[ "$prepare_status" -eq 2 ]]; then
        # The witness path already diagnosed and retained unsafe evidence.
        # This includes the Darwin exact-lineage boundary for a current-user
        # coordinator owner. Do not relabel that owner as foreign here.
        echo "error: hidden quality-gate owner recovery stopped at its evidence boundary; retained ${remnant}." >&2
      else
        gate_lock_report_foreign_owner_recovery "$remnant"
      fi
      gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
        "No mapped command ran in this request"
      exit 2
    fi
    pid="$(gate_lock_field_from_file "$gate_lock_quarantine_anchor" pid)"
    host="$(gate_lock_field_from_file "$gate_lock_quarantine_anchor" host)"
    machine="$(gate_lock_field_from_file "$gate_lock_quarantine_anchor" machine)"
    start="$(gate_lock_field_from_file "$gate_lock_quarantine_anchor" start_utc)"
    started_at="$(gate_lock_field_from_file "$gate_lock_quarantine_anchor" started_at)"
    machine_verdict="$(
      gate_lock_machine_verdict \
        "$machine" "$host" "$gate_lock_machine_id_cached" "$this_host" \
        "$gate_lock_root_is_per_machine"
    )"
    record_age="$(gate_lock_record_age_seconds "$started_at")"
    # Only same-machine evidence reaches an immediate local PID lookup. An
    # unverified record on per-machine storage reaches it after the grace.
    # Other-machine and possibly-shared unverified evidence stays live without
    # interpreting its PID in this process table.
    if [[ "$machine_verdict" == other ]] ||
      [[ "$machine_verdict" == unverified &&
        ( "$gate_lock_root_is_per_machine" -ne 1 || -z "$record_age" ||
          "$record_age" -lt "$gate_lock_unverified_machine_grace_seconds" ) ]] ||
      gate_lock_holder_is_live "$pid" "$start"; then
      # `ln` refuses an occupied path, so a record published while we were
      # reading loses nothing: ours is then the stale copy and just goes away.
      if [[ "$owner_restore_link_failure" != "1" ]] &&
        /bin/ln -P "$gate_lock_quarantine_anchor" "$lock/owner" 2>/dev/null; then
        if ! gate_lock_mark_quarantine_fallback ||
          ! gate_lock_finish_canonical_quarantine \
            "$lock/owner" "$gate_lock_quarantine_authority_value"; then
          gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
            "No mapped command ran in this request"
          exit 2
        fi
        echo "Recovered retained holder evidence for pid ${pid} from an interrupted reclaim." >&2
        recovered=0
      elif [[ ! -e "$lock/owner" && ! -L "$lock/owner" ]]; then
        # A shared root can expose another user's mode-0600 remnant while the
        # platform's protected-hardlink policy refuses our link. With no
        # canonical owner, continuing would turn that access error into an
        # ownerless claim beside a live holder.
        echo "error: could not restore the live quality-gate owner record at ${remnant}." >&2
        echo "The canonical owner is still absent. Nothing has been executed." >&2
        gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
          "No mapped command ran in this request"
        exit 2
      elif ! gate_lock_cancel_prepared_quarantine; then
        gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
      # If the link failed the canonical path already holds something. This
      # copy still names a live process, so it stays: a record naming a live
      # holder is evidence, and only a verified-dead one may be deleted.
    elif [[ "$gate_lock_root_is_local_storage" -ne 1 ]]; then
      # Off storage this machine mounts itself, "dead" above is not a verdict:
      # the PID was looked up in this kernel, and the process may be running on
      # another machine that reaches the same root (GitHub issue #2061).
      # Deleting the remnant would destroy the only copy of a live holder's
      # record and leave the lock ownerless — and an ownerless lock is exactly
      # what a root like this can no longer reclaim, so the wedge would be
      # permanent rather than healed after the owner grace. The remnant stays
      # where it is: waiters refuse this lock anyway, and the record is what
      # the holder that owns it, and the operator who has to clean up, need.
      :
    else
      # Dead holder — but "dead run" is not the same as "nothing running". Its
      # commands outlive it, and this record is the last thing that names them.
      # So the delete happens only once the obligation is written down.
      if gate_lock_condemn_prepared_quarantine; then
        :
      else
        recovered=$?
        [[ "$recovered" -ne 1 ]] || gate_lock_obligation_unwritable
        gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
    fi
  done
  return "$recovered"
}

# Put a record we took back where it came from, then drop our name for it.
# `ln` refuses an occupied path, so a record written while we held this copy is
# never clobbered — ours is simply the stale one, and it goes away.
restore_gate_lock_record() {
  [[ -n "$gate_lock_reclaim_tmp" ]] || return 0
  if [[ -e "$gate_lock_reclaim_tmp" && -n "$gate_lock_reclaim_origin" ]]; then
    if gate_lock_prepare_owner_quarantine "$gate_lock_reclaim_tmp"; then
      :
    else
      # A mismatched recorded uid is untrusted input, but restoring an exact
      # hard link is non-destructive. Keep the recovery-visible remnant and any
      # private witness as evidence; only publish the same inode back into an
      # empty canonical slot.
      if /bin/ln -P "$gate_lock_reclaim_tmp" \
        "$gate_lock_reclaim_origin" 2>/dev/null; then
        echo "error: restored untrusted quality-gate owner evidence at ${gate_lock_reclaim_origin}; retained ${gate_lock_reclaim_tmp}." >&2
      elif [[ -e "$gate_lock_reclaim_origin" || -L "$gate_lock_reclaim_origin" ]]; then
        echo "error: retained untrusted quality-gate owner evidence at ${gate_lock_reclaim_tmp}; the canonical slot is occupied." >&2
      else
        echo "error: retained changed or foreign evidence at ${gate_lock_reclaim_tmp}; could not restore it safely." >&2
      fi
      gate_lock_reclaim_tmp=""
      gate_lock_reclaim_origin=""
      return 1
    fi
    if /bin/ln -P "$gate_lock_quarantine_anchor" \
      "$gate_lock_reclaim_origin" 2>/dev/null; then
      if ! gate_lock_mark_quarantine_fallback ||
        ! gate_lock_finish_canonical_quarantine \
          "$gate_lock_reclaim_origin" "$gate_lock_quarantine_authority_value"; then
        echo "error: restored ${gate_lock_reclaim_origin}, but retained changed or foreign evidence at ${gate_lock_reclaim_tmp}." >&2
        gate_lock_reclaim_tmp=""
        gate_lock_reclaim_origin=""
        return 1
      fi
    elif [[ -e "$gate_lock_reclaim_origin" || -L "$gate_lock_reclaim_origin" ]]; then
      # The slot is occupied, so this copy is superseded and about to be
      # dropped rather than put back. It can still name a run whose commands
      # are alive, so the obligation is written down before it goes.
      if ! gate_lock_condemn_prepared_quarantine; then
        # Nowhere to write it down, so the record itself has to survive: it is
        # the only thing naming that run's commands, and the next run's
        # hidden-record recovery reads it from exactly where it lies. This runs
        # while unwinding, so it reports and leaves rather than exiting again.
        echo "error: could not record ${gate_lock_reclaim_tmp} as outstanding; left in place for the next run." >&2
        gate_lock_reclaim_tmp=""
        gate_lock_reclaim_origin=""
        return 1
      fi
    else
      echo "error: could not restore ${gate_lock_reclaim_tmp}; retained its private witness." >&2
      gate_lock_retain_quarantine \
        "the canonical quality-gate owner remained absent during restoration" || true
      gate_lock_reclaim_tmp=""
      gate_lock_reclaim_origin=""
      return 1
    fi
  fi
  gate_lock_reclaim_tmp=""
  gate_lock_reclaim_origin=""
}
# A lock directory whose owner file never appeared belongs to a run stalled or
# killed between mkdir and the write. Wait this long before treating it as
# abandoned. Correctness no longer rests on this number: a creator that resumes
# after its lock was reclaimed fails its own O_EXCL owner write and queues
# instead of running. The grace only keeps churn down.
gate_lock_owner_grace_seconds="$(gate_lock_seconds_knob AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS 30)"
# Whole seconds: the wait budget is accounted in integer seconds. Tunable for
# the same reason as the grace — the self-test asserts that waiting happens,
# not that it takes five seconds a round.
gate_lock_poll_seconds="$(gate_lock_seconds_knob AGENT_QUALITY_GATE_LOCK_POLL_SECONDS 5)"
# How old a record whose machine cannot be established has to be before a dead
# holder in it may be reclaimed. Only records this gate did not write reach it:
# one from a gate that predates the machine field, or one whose identity source
# this run cannot reach. Ten minutes is long enough that a real run on a shared
# lock root is never judged on this rule while it is starting up, and short
# enough that a machine rename costs one wait of this length instead of the
# whole 1800-second budget, every run, forever (GitHub issue #2055).
gate_lock_unverified_machine_grace_seconds="$(
  gate_lock_seconds_knob AGENT_QUALITY_GATE_LOCK_UNVERIFIED_MACHINE_GRACE_SECONDS 600
)"
# Whether this lock root sits on storage this machine mounts itself. It decides
# how far a local PID lookup may be trusted, so it is established by evidence
# rather than by where the path came from: `$HOME` is as likely to be a network
# home directory as a local disk, and assuming otherwise would let a run
# reclaim a lock whose holder is alive on another machine. Resolved against the
# filesystem in acquire_gate_run_lock once the root is known; unanswerable
# means "may be shared", which is the direction that keeps waiting.
#
# What this establishes is that the storage is not mounted FROM somewhere else,
# which is the configuration a network home directory creates and the one a
# developer machine can fall into without choosing it. It does not establish
# that the directory is unreachable — a machine can export its own disk over
# NFS or SMB and point another machine's gate at it. That is a deliberate act
# of sharing, and the declaration below is how it is told: setting it to 0
# keeps every reclaim on this path refused. Nothing in this repo asks for that
# configuration; concurrent validation from another machine is documented as
# running against its OWN checkout and its own lock.
gate_lock_root_is_per_machine=0
gate_lock_root_per_machine_override="${AGENT_QUALITY_GATE_LOCK_DIR_IS_PER_MACHINE:-}"
case "$gate_lock_root_per_machine_override" in
  "") ;;
  1 | true | yes) gate_lock_root_per_machine_override=1 ;;
  0 | false | no) gate_lock_root_per_machine_override=0 ;;
  *)
    echo "error: AGENT_QUALITY_GATE_LOCK_DIR_IS_PER_MACHINE must be 1 or 0; got '${gate_lock_root_per_machine_override}'." >&2
    exit 2
    ;;
esac
# Whether the storage under the lock root is this machine's own, kept apart
# from the question above because the two authorise different things. This one
# is the weaker claim and the wider gate: without it, no reclaim on this root
# is sound at all, because every reason a record looks reclaimable is read
# through this kernel and this client (GitHub issue #2061). Resolved in
# acquire_gate_run_lock once the root is known; 0 until then, which is the
# direction that keeps waiting.
gate_lock_root_is_local_storage=0
# Test-only, gated like the other lock-test hooks. The refusal this drives
# turns on what `df -l` says about the lock root, and a self-test cannot mount
# a network filesystem to make it say the interesting thing, so this makes the
# probe answer "not local" for every path. It only ever withdraws a reclaim —
# there is no setting of it that authorises one — so the failure it can cause
# is a wait, not an overlap. Refused outside NODE_ENV=test all the same, so it
# is never a quiet way to change how a real run behaves.
gate_lock_test_force_not_local="${AGENT_QUALITY_GATE_LOCK_TEST_FORCE_NOT_LOCAL:-}"
if [[ -n "$gate_lock_test_force_not_local" && "${NODE_ENV:-}" != "test" ]]; then
  echo "error: AGENT_QUALITY_GATE_LOCK_TEST_FORCE_NOT_LOCAL is a test-only override and requires NODE_ENV=test." >&2
  exit 2
fi
# The lock root, kept once resolved: outstanding obligations live beside the
# lock rather than inside it, because the lock directory is what gets reclaimed
# and the obligation has to outlive that.
gate_lock_root_dir=""
gate_lock_drained_tokens=""
# A staged obligation this shell has written but not yet published. mktemp
# gives parallel coordinator clients distinct names even though Bash 3.2 gives
# their subshells the same $$ value.
gate_lock_condemn_tmp=""

# One file per outstanding run rather than one shared list. A shared list has
# to be deleted by whoever drains it, and there is no way in this shell to
# establish that every process which opened it by name has finished writing —
# an appender descheduled between its open and its write would have its line
# deleted unread. Here nobody writes to a published file: each is created by
# one process under a private name and moved into place whole, and the drainer
# deletes only the files it has read to the end. Late arrivals are new files,
# which are either seen by this drain or inherited by the next.
gate_lock_condemned_dir() {
  [[ -n "$gate_lock_root_dir" ]] || return 1
  printf '%s/condemned.d' "$gate_lock_root_dir"
}

# Write down that a dead run's commands are somebody's problem now, BEFORE
# taking over from it. Holding that only in a shell variable makes it a promise
# this process cannot keep: a run killed between publishing its record and
# draining leaves the previous run's survivors with nobody who knows about
# them. On disk, the next run inherits the obligation instead.
#
# Legacy reclaim serializes this write. Coordinator recovery holds an atomic
# token claim before it writes. A private mktemp name also keeps an interrupted
# write invisible; the published token path is stable across retries.
#
# The write failing is a different matter from crashing after it. A crash still
# leaves the record this obligation was derived from, because that record is
# deleted only once this returns, so the next run's recovery re-derives it. A
# failed write with the caller carrying on leaves nothing anywhere. So this
# reports failure and every caller stops. The reachable case is not a full disk
# but a shared lock root, where the directory belongs to another user.
record_condemned_run() {
  local token="$1"
  local lifecycle_contract="${2:-}"
  local dir
  [[ -n "$token" ]] || return 2
  # Validated HERE, not only at the read boundaries, because the token
  # becomes a path component below: a crafted '../x' from a shared-root
  # remnant would land the record outside condemned.d. Failing returns the
  # caller to its unwritable-obligation path — stop, record left in place.
  gate_lock_token_is_wellformed "$token" || return 1
  gate_recovery_lifecycle_contract_is_supported "$lifecycle_contract" || return 1
  dir="$(gate_lock_condemned_dir)" || return 1
  mkdir -p "$dir" 2>/dev/null || return 1
  gate_lock_condemn_tmp="$(mktemp "${dir}/.staging.XXXXXX")" || return 1
  printf 'agentqg-condemned-v2|%s|%s\n' \
    "$token" "$lifecycle_contract" > "$gate_lock_condemn_tmp" 2>/dev/null || {
    rm -f "$gate_lock_condemn_tmp"
    gate_lock_condemn_tmp=""
    return 1
  }
  # Published by rename, which is atomic: the drainer never reads a partial
  # token, and re-condemning the same run simply replaces an identical file.
  if ! mv "$gate_lock_condemn_tmp" "${dir}/${token}" 2>/dev/null; then
    rm -f "$gate_lock_condemn_tmp"
    gate_lock_condemn_tmp=""
    return 1
  fi
  gate_lock_condemn_tmp=""
}

gate_condemned_record_token=""
gate_condemned_record_lifecycle_contract=""

gate_lock_token_from_claimed_obligation_path() {
  local token_name
  token_name="${1##*/}"
  while [[ "$token_name" =~ ^(.+)\.draining\.[0-9]+$ ]]; do
    token_name="${BASH_REMATCH[1]}"
  done
  printf '%s\n' "$token_name"
}

# New records bind the token to an explicit recovery lifecycle contract. A
# command record carries the contract selected before work started. An
# aggregate request record carries its non-signalling marker-empty contract.
# An old token-only record remains readable. Its contract comes only from the
# verified host classifier, never from state-file presence.
gate_read_condemned_record() {
  local path="$1"
  local value byte_count expected_bytes version obligation_identity lifecycle_contract extra
  gate_condemned_record_token=""
  gate_condemned_record_lifecycle_contract=""
  [[ -f "$path" && ! -L "$path" && -r "$path" ]] || return 2
  value="$(cat "$path" 2>/dev/null)" || return 2
  byte_count="$(LC_ALL=C wc -c < "$path" 2>/dev/null | tr -d '[:space:]')" ||
    return 2
  [[ "$byte_count" =~ ^[0-9]+$ ]] || return 2
  if [[ "$byte_count" -eq 0 ]]; then
    # A drainer can die after it renames an empty legacy obligation. Later
    # drainers add more claim suffixes. Recover the token from that claim chain.
    obligation_identity="$(gate_lock_token_from_claimed_obligation_path "$path")"
    lifecycle_contract="$(gate_lifecycle_contract_for_host)" || return 2
  else
    expected_bytes=$((${#value} + 1))
    [[ "$byte_count" -eq "$expected_bytes" ]] || return 2
    case "$value" in
      agentqg-condemned-v2\|*)
        IFS='|' read -r version obligation_identity lifecycle_contract extra <<< "$value"
        [[ "$version" == "agentqg-condemned-v2" && -z "$extra" ]] || return 2
        ;;
      *)
        obligation_identity="$value"
        lifecycle_contract="$(gate_lifecycle_contract_for_host)" || return 2
        ;;
    esac
  fi
  gate_lock_token_is_wellformed "$obligation_identity" || return 2
  gate_recovery_lifecycle_contract_is_supported "$lifecycle_contract" || return 2
  gate_condemned_record_token="$obligation_identity"
  gate_condemned_record_lifecycle_contract="$lifecycle_contract"
}

# These files are the only thing that tells the next holder a dead run's
# commands are still outstanding. Losing one means taking the lock over and
# starting mapped commands beside those commands — the cross-run overlap this
# whole path exists to prevent — so a run that cannot record the obligation
# stops here, with the record it was about to discard left in place.
gate_lock_obligation_unwritable() {
  echo "error: could not record the previous run's commands as outstanding in ${gate_lock_root_dir:-unknown}/condemned.d." >&2
  echo "Nothing would drain them, so this run would execute alongside them." >&2
  echo "Nothing has been executed. Fix that path — permissions, or free space — then re-run." >&2
  gate_report_coordinated_no_work_failure 2 "stale-obligation recovery" \
    "No mapped command ran in this request"
  exit 2
}

gate_lock_obligation_unreadable() {
  echo "error: the outstanding-commands record at ${1} exists but cannot be read." >&2
  echo "It names commands a dead run left behind, and skipping it would start this run alongside them." >&2
  echo "Nothing has been executed. Fix that path — permissions — then re-run." >&2
  gate_report_coordinated_no_work_failure 2 "stale-obligation recovery" \
    "No mapped command ran in this request"
  exit 2
}

gate_drain_fail_for_context() {
  local drain_context="${1:-stale-run}"
  if [[ "$drain_context" == "active-command" ]]; then
    return 2
  fi
  exit 2
}

gate_drain_obligation_unreadable() {
  local path="$1"
  local drain_context="${2:-stale-run}"
  if [[ "$drain_context" != "active-command" ]]; then
    gate_lock_obligation_unreadable "$path"
  fi
  echo "error: the command-descendant record at ${path} exists but cannot be read." >&2
  echo "It names processes from a completed mapped command. Releasing the scheduler lease without it could start conflicting work." >&2
  echo "The mapped command finished, but descendant cleanup did not complete. Fix that path — permissions — then re-run." >&2
  gate_drain_fail_for_context "$drain_context"
  return $?
}

# Every run drains the whole outstanding set before executing anything, not
# just the holder it personally condemned. That is what makes a chain of
# crashes safe: a third run inherits both the run it reclaimed and whatever
# that run had not finished clearing.
#
# Nothing is deleted unread. Each file is claimed by rename before it is read,
# so the name it was published under is free again immediately and the copy
# being drained is one nobody else can replace: a second condemnation of the
# same run publishes a fresh file rather than swapping the one in hand. The
# claimed copy is removed only once its own processes are confirmed gone, and a
# drainer killed part way leaves it in the directory for the next run, which
# reads a non-empty record's token from its contents. For an empty legacy
# record, it removes every completed claim suffix from the filename first.
#
# The scan repeats until a pass finds nothing, because obligations are still
# being published while this one drains — a waiter condemning a remnant of some
# third run does not wait for the lock. What it cannot close is the gap between
# the last empty pass and the first mapped command: publishing and holding the
# lock are not ordered against each other, and no arrangement of files in this
# shell makes them so.
drain_condemned_runs() {
  local dir entry claimed entry_token_value entry_lifecycle_contract drained_any
  dir="$(gate_lock_condemned_dir)" || return 0
  [[ -d "$dir" ]] || return 0
  [[ -r "$dir" && -x "$dir" ]] || gate_lock_obligation_unreadable "$dir"
  while :; do
    drained_any=0
    for entry in "$dir"/*; do
      # The glob skips staging files, whose names begin with a dot. That is
      # what they are named for: a run that died mid-write leaves one behind,
      # and the record it was derived from is still there, so the obligation
      # reaches us through the recovery pass rather than as a half-written
      # token here.
      [[ -e "$entry" ]] || continue
      [[ -r "$entry" ]] || gate_lock_obligation_unreadable "$entry"
      claimed="${entry}.draining.$$"
      if ! mv "$entry" "$claimed" 2>/dev/null; then
        # Gone between the glob and here is fine — nothing else deletes these,
        # so it was replaced, and the replacement is picked up by the next
        # pass. Still there and unclaimable is not fine: an obligation this run
        # cannot take is one it cannot promise to discharge.
        [[ -e "$entry" ]] || continue
        gate_lock_obligation_unreadable "$entry"
      fi
      # Owned by us, or not an obligation: only this uid's runs write these,
      # and a fabricated entry would steer the drain by another writer's
      # chosen token. Refused loudly, like a malformed one.
      if [[ ! -O "$claimed" ]]; then
        echo "error: obligation record ${claimed} is not owned by this user." >&2
        echo "Nothing has been executed. Inspect and remove that record, then re-run." >&2
        gate_report_coordinated_no_work_failure 2 "stale-obligation recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
      if ! gate_read_condemned_record "$claimed"; then
        # On a shared lock root this is a crafted or corrupt record. Guessing
        # what it binds could match a stranger's processes; discarding it
        # could discharge a real obligation. Refusing to run is the only move
        # that does neither.
        echo "error: obligation record ${claimed} names a malformed run token." >&2
        echo "Nothing has been executed. Inspect and remove that record, then re-run." >&2
        gate_report_coordinated_no_work_failure 2 "stale-obligation recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
      entry_token_value="$gate_condemned_record_token"
      entry_lifecycle_contract="$gate_condemned_record_lifecycle_contract"
      drain_condemned_run_commands \
        "$entry_token_value" stale-run "" "" 0 \
        "$entry_lifecycle_contract"
      gate_lock_drained_tokens="${gate_lock_drained_tokens} ${entry_token_value}"
      # Removed only here, with every process confirmed gone, and by a name
      # only this drainer can have created. A drain that cannot confirm exits
      # instead, leaving the rest for whoever comes next.
      gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_DRAIN_UNLINK_DELAY_SECONDS:-}"
      rm -f "$claimed" || return 2
      case "$entry_lifecycle_contract" in
        darwin-unique-lineage-v1|darwin-coherent-lineage-v2)
          gate_darwin_lineage_discard_settled "$entry_token_value" || return $?
          ;;
        request-marker-empty-v1)
          gate_run_discard_marker_exact "$entry_token_value" \
            "The recovered request marker was empty, but its cleanup failed." ||
            return $?
          ;;
      esac
      drained_any=1
    done
    [[ "$drained_any" -eq 1 ]] || break
  done
}

# Upper bound on confirming a dead run's commands are gone — a bound on the
# check, not the mechanism. The check itself is positive: look for processes
# carrying that run's tag and wait until there are none. A fixed delay cannot
# make that promise, because the thing it waits for (each command's watchdog
# noticing its gate died) can itself be descheduled by the same host pressure
# that killed the gate, or suspended with the laptop.
gate_lock_orphan_drain_bound_seconds="$(gate_lock_seconds_knob AGENT_QUALITY_GATE_LOCK_ORPHAN_DRAIN_SECONDS 120)"

# Test-only. The self-test sets these to widen otherwise sub-millisecond
# windows so the interleavings they permit can be exercised deterministically.
# Nothing in normal operation sets them, and none of them changes lock
# semantics: they only decide how long a process sits at a point it already
# passes through.
gate_lock_test_delay() {
  local seconds="${1:-}"
  [[ "$seconds" =~ ^[1-9][0-9]*$ ]] || return 0
  sleep "$seconds"
}

gate_lock_wait_for_test_barrier() {
  local barrier="${1:-}"
  local waited=0
  [[ -n "$barrier" ]] || return 0
  : > "${barrier}.ready" || return 2
  while [[ ! -e "${barrier}.release" ]]; do
    [[ "$waited" -lt 600 ]] || return 2
    sleep 0.05
    waited=$((waited + 1))
  done
}

gate_lock_wait_for_test_barrier_instance() {
  local barrier="${1:-}"
  local waited=0
  [[ -n "$barrier" ]] || return 0
  : > "${barrier}.ready.$$" || return 2
  while [[ ! -e "${barrier}.release" ]]; do
    [[ "$waited" -lt 600 ]] || return 2
    sleep 0.05
    waited=$((waited + 1))
  done
}

# Test-only. Names the write boundaries a crash can land between, so the
# self-test can kill a run at each one and assert the next run recovers. Use
# SIGKILL rather than exit to skip the exit trap, as `kill -9` or an OOM kill
# does. This hook tests process-death recovery only. Unset in normal operation.
gate_lock_test_crash() {
  [[ "${AGENT_QUALITY_GATE_LOCK_CRASH_AT:-}" == "$1" ]] || return 0
  kill -9 $$
}

gate_drain_test_refresh_barrier() {
  local barrier="$drain_refresh_test_barrier"
  local attempt
  [[ -n "$barrier" && ! -e "${barrier}.used" ]] || return 0
  : > "${barrier}.used" || return 2
  : > "${barrier}.ready" || return 2
  for ((attempt = 0; attempt < 1000; attempt++)); do
    [[ ! -e "${barrier}.release" ]] || return 0
    sleep 0.02
  done
  return 2
}

resolve_gate_lock_root() {
  local candidates=()
  local candidate
  if [[ -n "${AGENT_QUALITY_GATE_LOCK_DIR:-}" ]]; then
    # An explicit lock directory is a coordination contract, not a
    # preference: runs configured to share it MUST share it. Falling back
    # when it is unusable would quietly split them onto separate locks — the
    # exact overlap this lock exists to prevent — so the override resolves
    # to itself or the run fails closed.
    candidate="$AGENT_QUALITY_GATE_LOCK_DIR"
    if mkdir -p "$candidate" 2>/dev/null && [[ -w "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    return 1
  fi
  [[ -n "${HOME:-}" ]] && candidates+=("$HOME/.cache/agent-quality-gate")
  # Both fallbacks are per-user, so by default no two users share a lock. The
  # explicit override can point anywhere, including a directory two users
  # share, which is why the liveness probe answers existence with `ps` rather
  # than trusting `kill -0` — that call cannot tell another user's live
  # process from one that has exited.
  candidates+=("${TMPDIR:-/tmp}/agent-quality-gate-$(id -u)")
  for candidate in "${candidates[@]}"; do
    if mkdir -p "$candidate" 2>/dev/null && [[ -w "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

gate_lock_field_from_file() {
  local record="$1"
  local field="$2"
  [[ -r "$record" ]] || return 0
  # `|| true` for the same reason as everywhere else on this path, and here it
  # matters most: this reads records that other runs rename out from under it
  # by design. The file can vanish between the test above and the read below,
  # and under `set -e` with `pipefail` that failure would propagate out of the
  # command substitution every caller uses and kill the gate silently.
  sed -n "s/^${field}=//p" "$record" 2>/dev/null | head -n1 || true
}

gate_lock_authority_token_from_record() {
  local record="$1"
  local value
  value="$(gate_lock_field_from_file "$record" coordinator_token)"
  if [[ -z "$value" ]]; then
    value="$(gate_lock_field_from_file "$record" token)"
  fi
  printf '%s\n' "$value"
}

gate_lock_field_from_text() {
  local text="$1"
  local field="$2"
  printf '%s\n' "$text" | sed -n "s/^${field}=//p" | head -n1 || true
}

gate_lock_current_user_authority_token_from_snapshot() {
  local snapshot="$1"
  local recorded_uid current_uid uid_count coordinator_count token_count value
  uid_count="$(printf '%s\n' "$snapshot" | grep -c '^uid=' || true)"
  coordinator_count="$(printf '%s\n' "$snapshot" | grep -c '^coordinator_token=' || true)"
  token_count="$(printf '%s\n' "$snapshot" | grep -c '^token=' || true)"
  [[ "$uid_count" =~ ^[0-9]+$ && "$coordinator_count" =~ ^[0-9]+$ &&
    "$token_count" =~ ^[0-9]+$ ]] || return 1
  [[ "$uid_count" -le 1 && "$coordinator_count" -le 1 && "$token_count" -le 1 ]] ||
    return 1
  if [[ "$uid_count" -eq 1 ]]; then
    recorded_uid="$(gate_lock_field_from_text "$snapshot" uid)"
    [[ "$recorded_uid" =~ ^[0-9]+$ ]] || return 1
    current_uid="$(id -u 2>/dev/null)" || return 1
    [[ "$current_uid" =~ ^[0-9]+$ && "$recorded_uid" == "$current_uid" ]] ||
      return 1
  fi
  value="$(gate_lock_field_from_text "$snapshot" coordinator_token)"
  if [[ -z "$value" ]]; then
    value="$(gate_lock_field_from_text "$snapshot" token)"
  fi
  printf '%s\n' "$value"
}

gate_lock_recovery_contract_from_owner_snapshot() {
  local snapshot="$1"
  local coordinator_count coordinator_start_count token_count
  local coordinator_start owner_identity
  coordinator_count="$(printf '%s\n' "$snapshot" | grep -c '^coordinator_token=' || true)"
  coordinator_start_count="$(printf '%s\n' "$snapshot" | grep -c '^coordinator_start_utc=' || true)"
  token_count="$(printf '%s\n' "$snapshot" | grep -c '^token=' || true)"
  [[ "$coordinator_count" == 1 && "$coordinator_start_count" == 1 &&
    "$token_count" == 1 ]] || {
    printf '%s\n' "$gate_host_lifecycle_contract"
    return 0
  }
  coordinator_start="$(
    gate_lock_field_from_text "$snapshot" coordinator_start_utc
  )"
  owner_identity="$(gate_lock_field_from_text "$snapshot" token)"
  if [[ -n "$coordinator_start" &&
    "$owner_identity" == "coordinator-owner-v1" &&
    "$gate_host_lifecycle_contract" == "darwin-coherent-lineage-v2" ]]; then
    # A stale coordinator owner has no exact per-command Darwin lineage in this
    # owner snapshot. Its aggregate marker can look empty after a descendant
    # closes descriptors and removes tags. Retain the owner evidence instead of
    # authorising recovery from that marker alone.
    echo "error: Darwin coordinator-owner recovery has no exact per-command lineage evidence under this policy." >&2
    return 2
  fi
  printf '%s\n' "$gate_host_lifecycle_contract"
}

gate_lock_current_user_authority_and_recovery_contract_from_snapshot() {
  local snapshot="$1"
  local authority recovery_contract recovery_status
  authority="$(
    gate_lock_current_user_authority_token_from_snapshot "$snapshot"
  )" || return 1
  if recovery_contract="$(
    gate_lock_recovery_contract_from_owner_snapshot "$snapshot"
  )"; then
    :
  else
    recovery_status=$?
    return "$recovery_status"
  fi
  printf '%s\n%s\n' "$authority" "$recovery_contract"
}

gate_lock_current_user_authority_token_from_record() {
  local record="$1"
  local snapshot
  gate_lock_record_is_readable_regular "$record" || return 1
  if ! exec 15< "$record"; then
    return 1
  fi
  if [[ ! -f /dev/fd/15 || ! -O /dev/fd/15 ]]; then
    exec 15<&-
    return 1
  fi
  snapshot="$(cat <&15)" || {
    exec 15<&-
    return 1
  }
  if [[ ! -f /dev/fd/15 || ! -O /dev/fd/15 ]]; then
    exec 15<&-
    return 1
  fi
  exec 15<&-
  gate_lock_current_user_authority_token_from_snapshot "$snapshot"
}

gate_lock_current_user_authority_and_recovery_contract_from_record() {
  local record="$1"
  local snapshot
  gate_lock_record_is_readable_regular "$record" || return 1
  if ! exec 15< "$record"; then
    return 1
  fi
  if [[ ! -f /dev/fd/15 || ! -O /dev/fd/15 ]]; then
    exec 15<&-
    return 1
  fi
  snapshot="$(cat <&15)" || {
    exec 15<&-
    return 1
  }
  if [[ ! -f /dev/fd/15 || ! -O /dev/fd/15 ]]; then
    exec 15<&-
    return 1
  fi
  exec 15<&-
  gate_lock_current_user_authority_and_recovery_contract_from_snapshot \
    "$snapshot"
}

gate_lock_current_user_authority_token_from_release_descriptor() {
  local snapshot
  # Linux exposes /dev/fd/N as a symlink. Duplicate the already-open release
  # descriptor instead of sending that pseudo-path through the shared-path
  # no-symlink guard. The descriptor target must still be a current-user
  # regular file before and after its bytes are read.
  if ! exec 15<&14; then
    return 1
  fi
  if [[ ! -f /dev/fd/15 || ! -O /dev/fd/15 ]]; then
    exec 15<&-
    return 1
  fi
  snapshot="$(cat <&15)" || {
    exec 15<&-
    return 1
  }
  if [[ ! -f /dev/fd/15 || ! -O /dev/fd/15 ]]; then
    exec 15<&-
    return 1
  fi
  exec 15<&-
  gate_lock_current_user_authority_token_from_snapshot "$snapshot"
}

gate_lock_owner_field() {
  if [[ "$2" == "token" ]]; then
    gate_lock_authority_token_from_record "$1/owner"
    return
  fi
  gate_lock_field_from_file "$1/owner" "$2"
}

# Wall-clock milliseconds. Two whole-second `date +%s` reads carry up to a
# second of error between them, because each truncates to the second boundary it
# landed in: a wait that starts at X.99 and lasts 1.05s reads as two seconds.
# The lock wait then reports that measurement error as elapsed time, which is
# how `--lock-wait 1` announced a two-second timeout on a loaded CI runner and
# flaked the suite's budget assertion (GitHub issue 1919). EPOCHREALTIME renders
# its fraction with the locale's decimal separator, so both forms are read; a
# shell too old to have it degrades to whole seconds, which is exactly the
# behaviour this replaces.
gate_wall_millis() {
  local now="${EPOCHREALTIME:-}"
  local seconds fraction
  case "$now" in
    *[.,]*)
      seconds="${now%%[.,]*}"
      fraction="${now#*[.,]}000"
      printf '%s%s\n' "$seconds" "${fraction:0:3}"
      return 0
      ;;
  esac
  printf '%s000\n' "$(date +%s)"
}

# Older gates persist and compare `ps -o lstart=` output byte-for-byte. Keep
# that padded wire value when publishing owner and captured-process records so
# an old worktree can identify a live new run. Current readers normalize only
# at comparison boundaries.
gate_lock_process_start_legacy_wire() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | head -n1 || true
}

# A machine identity that survives a rename, recorded beside the hostname so a
# waiter can tell "the same machine under a new name" from "another machine on
# shared storage". The hostname alone could not: renaming a Mac from
# `Workbook.local` to `Mac` made every later run read its own dead holder as a
# live foreign one and wait out the whole `--lock-wait` budget with no
# self-healing (GitHub issue #2055).
#
# The value is stored as `<source>:<id>`, and the source tag is load-bearing.
# Two ids from the same source can be compared as machine identities: equal
# means the same machine, different means a different one. Two ids from
# DIFFERENT sources cannot — a run that read `ioplatform` and a run that fell
# back to `kernuuid` are almost certainly the same machine, and reading their
# unequal values as "another machine" would invent exactly the wedge this
# exists to remove. So a source mismatch is not a verdict at all; it degrades
# to the same unverified handling as a record with no machine field.
#
# The id is validated against the record's alphabet, never rewritten into it.
# Rewriting would be lossy, and a lossy transform on an identity is a way to
# make two machines look like one: stripping the unrepresentable characters
# maps `machine/a` and `machinea` onto the same value, and truncating maps
# every pair that first differs past the limit onto the same value too. Either
# collision reads as `same` and authorises a reclaim on a PID lookup that
# belongs to the other machine. So a value outside the alphabet is refused
# instead, which costs an identity nobody can compare — the defined,
# conservative state — rather than inventing one that compares equal to
# somebody else's. `:` is outside the alphabet, so the split on the first `:`
# is unambiguous; so is a newline, which would otherwise let an id forge a
# second field in a record read line by line.
gate_lock_machine_id_cached=""
gate_lock_machine_id_resolved=0

gate_lock_tag_machine_id() {
  local source_tag="$1"
  local value="$2"
  # One rule, and nothing before it. Any normalisation here — trimming
  # whitespace, deleting line breaks, truncating — is a many-to-one map, and a
  # many-to-one map on an identity is exactly how two machines come to compare
  # equal: deleting the break in `machine<LF>a` yields `machinea`, which is
  # another machine's legitimate id. Distinct valid inputs must stay distinct,
  # so the value is accepted as written or not at all. Every source below
  # already yields a bare token; one that does not is a source this run cannot
  # use, which is the defined conservative state.
  [[ "$value" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || return 1
  printf '%s:%s\n' "$source_tag" "$value"
}

# Resolves into `gate_lock_machine_id_cached` rather than onto stdout, so the
# answer survives: a function that printed it would be called through command
# substitution, the cache would be set in a subshell, and every caller would
# pay for the probe again. Sources are tried in a fixed order so one machine
# cannot answer differently between two runs that both reach the same source.
# An unavailable source is not an error: no identity at all is a defined state
# that falls back to the hostname, which is what the gate did before this.
gate_lock_resolve_machine_id() {
  local raw=""
  [[ "$gate_lock_machine_id_resolved" -eq 0 ]] || return 0
  gate_lock_machine_id_resolved=1
  gate_lock_machine_id_cached=""
  # An explicit override first, so a container that hides every hardware
  # identity — and the self-test, which has to simulate two machines on one —
  # can still name the machine its lock root belongs to. A value this record
  # cannot carry stops the run rather than falling through to a probed
  # identity: the operator set this to name a machine, and continuing under a
  # different identity than they asked for is how two machines end up comparing
  # equal. Loud and refused, so it is fixed rather than silently ignored.
  if [[ -n "${AGENT_QUALITY_GATE_LOCK_MACHINE_ID:-}" ]]; then
    if ! gate_lock_machine_id_cached="$(
      gate_lock_tag_machine_id override "${AGENT_QUALITY_GATE_LOCK_MACHINE_ID}"
    )"; then
      echo "error: AGENT_QUALITY_GATE_LOCK_MACHINE_ID must be 1-128 characters of A-Z a-z 0-9 . _ - and nothing else." >&2
      echo "It names one machine in the lock records this gate writes, so it is never rewritten to fit — two values that differ must stay different." >&2
      echo "Nothing has been executed. Fix that value, or unset it to let the gate read this machine's own identity." >&2
      exit 2
    fi
  fi
  if [[ -z "$gate_lock_machine_id_cached" ]]; then
    # Linux. `/var/lib/dbus/machine-id` is conventionally the same file, so
    # both carry one tag: reading either yields the same identity.
    for raw in /etc/machine-id /var/lib/dbus/machine-id; do
      [[ -r "$raw" ]] || continue
      gate_lock_machine_id_cached="$(
        gate_lock_tag_machine_id machineid "$(head -n1 "$raw" 2>/dev/null || true)" || true
      )"
      [[ -z "$gate_lock_machine_id_cached" ]] || break
    done
  fi
  if [[ -z "$gate_lock_machine_id_cached" ]] && command -v ioreg > /dev/null 2>&1; then
    # macOS. IOPlatformUUID is burned into the hardware and is what a rename
    # cannot touch.
    raw="$(
      ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null |
        awk -F'"' '/IOPlatformUUID/ { print $4; exit }' || true
    )"
    gate_lock_machine_id_cached="$(gate_lock_tag_machine_id ioplatform "$raw" || true)"
  fi
  if [[ -z "$gate_lock_machine_id_cached" ]] && command -v sysctl > /dev/null 2>&1; then
    raw="$(sysctl -n kern.uuid 2>/dev/null || true)"
    gate_lock_machine_id_cached="$(gate_lock_tag_machine_id kernuuid "$raw" || true)"
  fi
}

# Which machine wrote a record, as far as this run can tell:
#
#   same        — this machine. PIDs in the record mean something here, so the
#                 liveness rules decide, and a dead holder is reclaimed at once.
#   other       — definitively a different machine. Its PIDs mean nothing here
#                 and its holder may well be running, so this is never
#                 reclaimed on any evidence available locally.
#   unverified  — the machine cannot be established: a record from a gate that
#                 predates the machine field, a source mismatch, or a host with
#                 no identity source. Handled by the aged-and-dead rule at the
#                 call site, never by a straight reclaim.
#
# The hostname decides only where a machine identity is missing on one side or
# the other, which keeps the pre-existing behaviour intact for records this
# gate did not write.
#
# `other` is reachable only where the root may be shared, and that restriction
# is what keeps this from re-creating the wedge it exists to remove. A machine
# identity is not immutable — `/etc/machine-id` is regenerated by an OS
# reinstall or an image rebuild, and the override can simply be changed — so on
# storage this machine mounts itself, a disagreeing identity is far more likely
# to be this machine's own identity having moved, exactly as a rename moved its
# hostname, than a second machine writing into the same directory. Reading it
# as another machine would leave the record unreclaimable forever. Where the
# root is on network storage there is no such reasoning available, and a
# disagreeing identity has to be believed.
#
# The converse does not hold, and that asymmetry is why an AGREEING identity is
# not by itself enough on a root that may be shared. A disagreeing id is proof
# of two machines; an agreeing one is not proof of one, because ids are not
# guaranteed unique. Containers built from a single base image famously carry
# the same baked-in `/etc/machine-id`, so two of them mounting one lock
# directory agree on their identity while having separate PID namespaces —
# where a local `kill -0` on the other's holder reads "gone" and would reclaim
# a live lock. So off proven-local storage the hostname has to agree as well;
# where it does not, the pair is unverified and this path never reclaims it.
# On storage this machine mounts itself no second machine is writing records in
# the first place, and the hostname is the field the rename moved, so requiring
# it there would refuse the very case this exists to fix.
gate_lock_machine_verdict() {
  local owner_machine="$1"
  local owner_host="$2"
  local this_machine="$3"
  local this_host="$4"
  local root_is_per_machine="$5"
  if [[ -n "$owner_machine" && -n "$this_machine" ]]; then
    if [[ "$owner_machine" == "$this_machine" ]]; then
      if [[ "$root_is_per_machine" -eq 1 || -z "$owner_host" ||
        "$owner_host" == "$this_host" ]]; then
        printf 'same\n'
      else
        printf 'unverified\n'
      fi
    elif [[ "${owner_machine%%:*}" == "${this_machine%%:*}" &&
      "$root_is_per_machine" -ne 1 ]]; then
      printf 'other\n'
    else
      printf 'unverified\n'
    fi
    return 0
  fi
  # No machine identity on one side. A matching hostname is the same evidence
  # the gate has always run on, and an absent hostname was never treated as
  # foreign either.
  if [[ -z "$owner_host" || "$owner_host" == "$this_host" ]]; then
    printf 'same\n'
  else
    printf 'unverified\n'
  fi
}

# Is this directory on a filesystem only this machine can reach? `df -l` lists
# local filesystems and omits network ones — NFS, SMB, AFS, an autofs map — on
# both the BSD and GNU implementations, so a path that still produces a row is
# on local storage. The row, not the exit status, is the answer: both
# implementations exit 0 for a remote path and simply print no row for it.
#
# Every failure means "no", because the question only ever widens what a local
# PID lookup is allowed to conclude. No `df`, an unreadable path, an
# implementation without `-l`: all of them leave the root treated as possibly
# shared, which is the answer that keeps mutual exclusion across machines.
gate_lock_path_is_local_filesystem() {
  local dir="$1"
  local row
  [[ -z "$gate_lock_test_force_not_local" ]] || return 1
  [[ -n "$dir" ]] || return 1
  command -v df > /dev/null 2>&1 || return 1
  row="$(df -l -- "$dir" 2>/dev/null | tail -n +2 | tr -d '[:space:]' || true)"
  [[ -n "$row" ]]
}

# Test-only, and gated the same way as the other lock-test hooks. This probe
# decides whether a local PID lookup may authorise a reclaim, so the self-test
# has to exercise it in BOTH directions — a check that only ever answers "local"
# would pass every case above while proving nothing. Answering "not-local"
# needs a path on a filesystem `df -l` omits, which the suite discovers from
# the mount table rather than fabricates, so the probe is reachable here on its
# own. Nothing else runs on this path: it answers and exits.
if [[ -n "${AGENT_QUALITY_GATE_LOCK_PROBE_PATH:-}" ]]; then
  if [[ "${NODE_ENV:-}" != "test" ]]; then
    echo "error: the gate lock locality probe is allowed only with NODE_ENV=test." >&2
    exit 2
  fi
  if gate_lock_path_is_local_filesystem "$AGENT_QUALITY_GATE_LOCK_PROBE_PATH"; then
    printf 'local\n'
  else
    printf 'not-local\n'
  fi
  exit 0
fi

# How long ago a record was written, in whole seconds, or nothing when that
# cannot be established. Nothing is the fail-closed answer: age only ever
# unlocks a reclaim, so an unreadable or future-dated stamp keeps this run
# waiting rather than letting an unknown age pass for an old one.
gate_lock_record_age_seconds() {
  local started_at="$1"
  local now
  [[ "$started_at" =~ ^[0-9]{1,12}$ ]] || return 0
  now="$(date +%s)"
  [[ "$now" -ge "$started_at" ]] || return 0
  printf '%s\n' $((now - started_at))
}

# Read the kernel's start-time string and process state in one snapshot.
# Comparing the start string avoids date parsing. Pin the formatting
# environment because `ps` renders lstart in the caller's time zone and locale.
# The state field also identifies an exited child that its parent has not reaped.
gate_lock_process_snapshot() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  # Asking about a process is allowed to come back empty, and must not be an
  # error: every caller here is racing the process it asks about, so `ps` fails
  # the moment that process exits. Under `set -e` with `pipefail` this pipeline
  # would then abort the whole gate from inside a command substitution.
  # macOS pads these fields. Normalize both edges so Bash and Node compare the
  # same snapshot.
  TZ=UTC LC_ALL=C ps -o lstart= -o stat= -p "$pid" 2>/dev/null |
    head -n1 | sed 's/^[[:blank:]]*//; s/[[:blank:]]*$//' || true
}

gate_lock_normalize_process_start() {
  printf '%s\n' "$1" |
    sed 's/^[[:blank:]]*//; s/[[:blank:]]*$//'
}

gate_lock_process_start() {
  local snapshot
  snapshot="$(gate_lock_process_snapshot "$1")"
  [[ "$snapshot" == *" "* ]] || return 0
  gate_lock_normalize_process_start "${snapshot% *}"
}

# Use the kernel start tick for live in-process relations on Linux. Persisted
# records keep the historical lstart wire value for mixed-version readers.
# macOS has no procfs, so it retains the narrow lstart check used by the signal
# path and fails closed when that identity is unreadable.
gate_lock_process_runtime_start() {
  local pid="$1"
  local stat_line remainder start_tick
  local -a stat_fields
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  if [[ -e /proc/self/stat ]]; then
    stat_line="$(cat "/proc/${pid}/stat" 2>/dev/null || true)"
    [[ -n "$stat_line" && "$stat_line" == *") "* ]] || return 0
    remainder="${stat_line##*) }"
    read -r -a stat_fields <<< "$remainder"
    start_tick="${stat_fields[19]:-}"
    [[ "$start_tick" =~ ^[0-9]+$ ]] || return 0
    printf 'proc:%s\n' "$start_tick"
    return 0
  fi
  gate_lock_process_start "$pid"
}

gate_lock_process_runtime_start_pgid_snapshot() {
  local pid="$1"
  local start_before start_after pgid
  start_before="$(gate_lock_process_runtime_start "$pid")"
  [[ -n "$start_before" ]] || return 0
  pgid="$(TZ=UTC LC_ALL=C ps -o pgid= -p "$pid" 2>/dev/null |
    head -n1 | tr -d '[:space:]' || true)"
  [[ "$pgid" =~ ^[1-9][0-9]*$ ]] || return 0
  start_after="$(gate_lock_process_runtime_start "$pid")"
  [[ "$start_after" == "$start_before" ]] || return 0
  printf '%s|%s\n' "$start_after" "$pgid"
}

gate_lock_process_signal_probe() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 2
  node -e '
    const pid = Number(process.argv[1]);
    try {
      process.kill(pid, 0);
      process.stdout.write("live");
    } catch (error) {
      if (error?.code === "ESRCH") process.stdout.write("gone");
      else if (error?.code === "EPERM") process.stdout.write("denied");
      else process.stdout.write("error");
    }
  ' "$pid" 2>/dev/null
}

gate_lock_process_state() {
  local snapshot
  snapshot="$(gate_lock_process_snapshot "$1")"
  [[ "$snapshot" == *" "* ]] || return 0
  printf '%s\n' "${snapshot##* }"
}

# A zombie has exited and cannot execute, fork, or retain file descriptors. PID
# 1 can keep its process-table record indefinitely, so kill -0 and lstart alone
# cannot decide whether a condemned command can still overlap the next run.
# Read state and start time from one snapshot. Empty or unreadable state remains
# fail-closed because only a confirmed matching zombie returns success.
gate_lock_process_is_confirmed_zombie() {
  local pid="$1"
  local recorded_start="$2"
  local snapshot current_start current_state
  recorded_start="$(gate_lock_normalize_process_start "$recorded_start")"
  [[ -n "$pid" && -n "$recorded_start" ]] || return 1
  snapshot="$(gate_lock_process_snapshot "$pid")"
  [[ "$snapshot" == *" "* ]] || return 1
  current_state="${snapshot##* }"
  [[ "$current_state" == Z* ]] || return 1
  current_start="$(gate_lock_normalize_process_start "${snapshot% *}")"
  [[ -n "$current_start" && "$current_start" == "$recorded_start" ]]
}

# Is this PID still the process that recorded itself? `kill -0` alone cannot
# say: PIDs are reused, and a recycled one would make every later run wait on
# an unrelated process until --lock-wait expired — the opposite of unattended
# recovery. When a start time is unavailable on either side (a sandbox without
# ps, a lock written before `start_utc` existed), this falls back to PID
# existence, which is the safe direction: we keep waiting rather than evict a
# run that may be alive. That fallback is also what makes a mixed-version
# window safe in both directions — neither gate can read the other's
# start-time field, so each degrades to "assume live" and times out, and a
# false stale on a live holder stays impossible.
gate_lock_holder_is_live() {
  local pid="$1"
  local recorded_start="$2"
  local snapshot current_start current_state
  recorded_start="$(gate_lock_normalize_process_start "$recorded_start")"
  [[ -n "$pid" ]] || return 1
  # `kill -0` fails two ways that mean opposite things: no such process, and a
  # live process this user may not signal. A lock root shared between users
  # makes the second ordinary, and reading it as "gone" would reclaim a lock
  # whose holder is still running. `ps` answers existence across users, so it
  # decides, and `kill -0` only spares the `ps` call in the common case.
  snapshot="$(gate_lock_process_snapshot "$pid")"
  if [[ -z "$snapshot" ]]; then
    if ! kill -0 "$pid" 2>/dev/null; then
      ps -p "$pid" > /dev/null 2>&1 || return 1
    fi
    return 0
  fi
  [[ "$snapshot" == *" "* ]] || return 0
  current_state="${snapshot##* }"
  [[ "$current_state" != Z* ]] || return 1
  [[ -n "$recorded_start" ]] || return 0
  current_start="$(gate_lock_normalize_process_start "${snapshot% *}")"
  [[ "$current_start" == "$recorded_start" ]]
}

# Is the record a reclaimer just took away the exact one it judged stale, and
# is it still dead? The verdict was formed before the rename won it, so this is
# what stops a waiter acting on a decision that has since gone obsolete.
gate_lock_record_still_stale() {
  local record="$1"
  local decided_pid="$2"
  local decided_token="$3"
  local decided_start="$4"
  local decided_host="$5"
  local decided_machine="$6"
  local decided_started_at="$7"
  local current_pid current_token_value current_start
  local current_host current_machine current_started_at
  if ! gate_lock_record_is_readable_regular "$record"; then
    [[ ! -e "$record" && ! -L "$record" ]] && return 3
    return 2
  fi
  current_pid="$(gate_lock_field_from_file "$record" pid)"
  current_token_value="$(gate_lock_authority_token_from_record "$record")"
  current_start="$(gate_lock_field_from_file "$record" start_utc)"
  current_host="$(gate_lock_field_from_file "$record" host)"
  current_machine="$(gate_lock_field_from_file "$record" machine)"
  current_started_at="$(gate_lock_field_from_file "$record" started_at)"
  if ! gate_lock_record_is_readable_regular "$record"; then
    [[ ! -e "$record" && ! -L "$record" ]] && return 3
    return 2
  fi
  [[ "$current_pid" == "$decided_pid" ]] || return 1
  [[ "$current_token_value" == "$decided_token" ]] || return 1
  [[ "$current_start" == "$decided_start" ]] || return 1
  [[ "$current_host" == "$decided_host" ]] || return 1
  [[ "$current_machine" == "$decided_machine" ]] || return 1
  [[ "$current_started_at" == "$decided_started_at" ]] || return 1
  # A record with no token never finished being written, so it is not a claim
  # at all and its PID field may itself be a truncated value — asking whether
  # that PID is alive would be asking about a number nobody wrote. The grace
  # this record already outlived is what makes discarding it safe.
  [[ -n "$current_token_value" ]] || return 0
  ! gate_lock_holder_is_live "$current_pid" "$current_start"
}

# The only way a process comes to hold the lock. The record is built in a
# private file and published with `ln`, so a reader never sees a half-written
# one: either the complete record is there or nothing is. `ln` refuses an
# occupied path, which is what makes a stalled creator safe — if a reclaimer
# published while this process sat descheduled between `mkdir` and here, this
# publish fails and the caller never believes it holds anything. Reading the
# token back turns any residual displacement into a failed claim instead of a
# second concurrent run.
claim_gate_run_lock() {
  local lock="$1"
  local token="$2"
  local claim_uid="$3"
  local staged="$lock/owner.claiming.$$"
  local published=0
  local lineage_prepared=0
  local readback_token
  [[ -n "$gate_lock_local_host_name" ]] || return 2
  [[ "$claim_uid" =~ ^[0-9]+$ ]] || return 2
  gate_lock_token_is_wellformed "$token" || return 2
  # Idempotent, and free after the first call. Here as well as in the wait loop
  # so the record can never be published without the field a later reader needs.
  gate_lock_resolve_machine_id
  # Registered before it exists, like every other file this path creates. Any
  # file already there was left by a dead process that happened to share our
  # PID, so it is ours to remove.
  gate_lock_claim_tmp="$staged"
  rm -f "$staged"
  if {
    printf 'pid=%s\n' "$$"
    printf 'uid=%s\n' "$claim_uid"
    printf 'host=%s\n' "$gate_lock_local_host_name"
    # Additive on purpose. A gate that predates this field ignores it and reads
    # the record exactly as it always did, and this gate reads a record without
    # it through the unverified path — so the two versions coexist on one
    # machine without either misjudging the other's locks.
    printf 'machine=%s\n' "$gate_lock_machine_id_cached"
    printf 'started_at=%s\n' "$(date +%s)"
    printf 'start_utc=%s\n' "$(gate_lock_process_start_legacy_wire $$)"
    printf 'worktree=%s\n' "$repo_root"
    # Written last on purpose: a record without a token is one whose write did
    # not finish, and readers below treat it as no record at all.
    printf 'token=%s\n' "$token"
  } > "$staged" 2>/dev/null; then
    gate_lock_test_crash after-staged
    if ! gate_darwin_lineage_prepare "$token"; then
      rm -f "$staged"
      gate_lock_claim_tmp=""
      return 2
    fi
    lineage_prepared="$gate_darwin_lineage_active"
    ln "$staged" "$lock/owner" 2>/dev/null && published=1
  fi
  gate_lock_test_crash after-link
  rm -f "$staged"
  gate_lock_claim_tmp=""
  if [[ "$published" -ne 1 ]]; then
    if [[ "$lineage_prepared" -eq 1 ]] &&
      ! gate_darwin_lineage_abandon_unstarted "$token"; then
      return 2
    fi
    return 1
  fi
  readback_token="$(gate_lock_owner_field "$lock" token)"
  # A changed canonical owner can leave this exact record in hidden recovery
  # state. Keep its Darwin evidence and stop this claim. Reusing the same token
  # for another publication could bind two owner generations to one lineage.
  [[ "$readback_token" == "$token" ]] || return 2
  gate_lock_dir="$lock"
  gate_lock_token="$token"
  [[ -n "$gate_run_id" ]] || gate_run_id="$token"
  export AGENT_QUALITY_GATE_LOCK_HELD="$token"
  return 0
}

# The backstop, and the only rule here that does not depend on getting an
# interleaving right. Everything above tries to make displacement impossible;
# this makes it detectable. Acquiring the lock and reaching the first mapped
# command are separated by real work, and anything that unseats this run's
# record in between — a waiter acting on a verdict formed before we published,
# a hand-deleted lock — leaves us believing we hold a lock we do not. Reading
# our own record back here turns that into one loud abort instead of two runs
# on one machine. Release stays token-guarded, so stopping here cannot delete
# the lock of whoever holds it now.
# Confirm a dead run's mapped commands are gone, and make them gone if they are
# not. Its processes carry its token in their argv, so this asks the machine
# directly rather than trusting a timer: nothing tagged means nothing to wait
# for — including the common case where the run died before starting a command,
# which now costs no wait at all. Anything still tagged is signalled and then
# waited for, because a signal delivered is not a process reaped.
# Everything under a process, children first, each with the start string that
# identifies it. Children first is also the order to signal in, and capturing
# the identity now is what lets the drain tell "this PID is still the process
# we condemned" from "this PID was reused while we worked".
gate_drain_capture=""
# Exact live generations paired with the legacy capture lines. The on-disk
# journal keeps `pid|lstart` for old readers and follows it with a metadata line
# whose first field is not a PID, so those readers skip it safely.
gate_drain_capture_runtime_prefix="runtime-v2"
# Exact PID/runtime generations already recorded this drain. A re-walk can
# distinguish a new generation from the same process tree.
gate_drain_seen=""
# Where the captured tree is written down, if anywhere. Set before capturing
# starts, so each process is recorded as it is discovered.
gate_drain_capture_file=""
# Set when the drain could not publish a complete valid identity pair. This
# includes an append failure and a legacy/runtime pair that fails validation.
# The drain refuses to signal without valid durable evidence.
gate_drain_capture_unpersisted=0
# Set when a discovery scan failed rather than came back empty, so an
# unanswered question is never read as "nothing left running". The scan itself
# runs in a command substitution, so it cannot set this — a subshell's
# assignments die with it. It emits the marker below in its output instead, and
# the wrapper that reads that output is what sets the flag.
gate_drain_scan_failed=0
gate_drain_scan_error="agentqg-scan-failed"
# Linux active-command full scans add a boundary captured before mapped work.
# Stale recovery leaves this explicit value empty and derives its conservative
# boundary from a same-boot marker token. Exact-PID checks stay unbounded.
gate_active_command_proc_start_floor=""
# The PIDs this run's handles named on the current pass, read by the
# membership check deep inside the recursive walk.
gate_drain_tagged_now=""
# A live parallel parent can also seed the drain from its registered worker
# process group. This captures a same-group descendant that closed every
# inherited identity handle before the first signal destroys its ancestor.
gate_drain_seed_pgid=""
# The active parent records the worker leader's start identity at fork time.
# This lets a no-lock drain validate its live group anchor without handles.
gate_drain_seed_start=""
# Set only while a snapshot tied to a live token holder is being folded into
# the durable capture. It lets sibling group members prove membership without
# treating a bare, reusable PGID as an identity on later passes.
gate_drain_capture_group_pgid=""
# The group leader whose exact start identity authorised the current group
# snapshot. Every candidate membership check revalidates this anchor after it
# observes the candidate. This prevents a dead group ID from being reused
# between the snapshot and capture.
gate_drain_capture_group_anchor_pid=""
gate_drain_capture_group_anchor_start=""
# Set when a group membership check cannot distinguish exit from an unreadable
# identity. A confirmed out-of-group PID can be skipped; an ambiguous one must
# remain as fail-closed evidence.
gate_drain_membership_unverified=0
gate_drain_membership_token=""

gate_drain_capture_set_entry() {
  local target_pid="$1"
  local legacy_start="$2"
  local runtime_start="$3"
  local line line_pid filtered=""
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    line_pid="${line%%|*}"
    [[ "$line_pid" == "$target_pid" ]] && continue
    filtered="${filtered}${line}
"
  done << EOF
$gate_drain_capture
EOF
  gate_drain_capture="${filtered}${target_pid}|${legacy_start}|${runtime_start}
"
}

gate_drain_seen_has_identity() {
  local target_pid="$1"
  local target_runtime="$2"
  local seen_pid seen_runtime extra
  while IFS='|' read -r seen_pid seen_runtime extra; do
    [[ -z "$extra" && "$seen_pid" == "$target_pid" &&
      "$seen_runtime" == "$target_runtime" ]] && return 0
  done << EOF
$gate_drain_seen
EOF
  return 1
}

gate_drain_runtime_identity_matches_wire() {
  local legacy_start="$1"
  local runtime_start="$2"
  local normalized_legacy
  if [[ "$legacy_start" == "$gate_lock_identity_unavailable" ||
    "$runtime_start" == "$gate_lock_identity_unavailable" ]]; then
    [[ "$legacy_start" == "$gate_lock_identity_unavailable" &&
      "$runtime_start" == "$gate_lock_identity_unavailable" ]]
    return $?
  fi
  [[ -n "$legacy_start" && -n "$runtime_start" ]] || return 1
  if [[ -e /proc/self/stat ]]; then
    [[ "$runtime_start" =~ ^proc:[0-9]+$ ]]
    return $?
  fi
  normalized_legacy="$(gate_lock_normalize_process_start "$legacy_start")"
  [[ -n "$normalized_legacy" && "$runtime_start" == "$normalized_legacy" ]]
}

# Recorded in place of a start time on a host that cannot produce one at all —
# a sandbox without `ps`. It has to be distinguishable from an empty identity,
# because the two mean opposite things: this one says "nobody here can be
# identified, the tag is the only selector", while an empty one says "this
# particular read failed", and reads that fail must never authorise a signal.
gate_lock_identity_unavailable="<no-identity-source>"
gate_lock_identity_source=""

# Can this host identify processes at all? Asked about our own PID, which is
# alive by construction, so an empty answer means the source is missing rather
# than the process being gone. Cached: the answer cannot change mid-run.
gate_lock_identity_source_available() {
  if [[ -z "$gate_lock_identity_source" ]]; then
    if [[ -n "$(gate_lock_process_start $$)" ]]; then
      gate_lock_identity_source="yes"
    else
      gate_lock_identity_source="no"
    fi
  fi
  [[ "$gate_lock_identity_source" == "yes" ]]
}

# The captured tree is obligation-evidence too, and the same rule applies to it
# as to the condemned token: the moment the first signal goes out, this process
# is the only one that knows what it was about to kill. Written down before
# that, a successor inherits the list; without it, the successor's tag scan
# finds nothing — the first pass killed the tag carrier — and reads that as
# nothing left to do while an untagged descendant keeps running.
#
# Recorded by appending one short line per process, never by rewriting the
# file. A `>` redirection truncates the moment it opens, so a rewrite has a
# window where the snapshot on disk is empty — and this is exactly the file a
# successor consults when nothing carries the tag any more. Appending removes
# that window rather than narrowing it: the list can only grow, so an
# interrupted drain leaves fewer entries than it eventually would have, never
# Refresh the set of PIDs this run's handles name, in the caller's shell, and
# remember whether the scan behind it failed. Everything that reads that set
# goes through here, so a failure cannot be lost by being noticed inside a
# subshell.
gate_drain_refresh_tagged() {
  local token="$1"
  local full_scan_start_floor="${2:-}"
  local raw candidate normalized=""
  raw="$(gate_run_tagged_pids "$token" "" "$full_scan_start_floor")"
  for candidate in $raw; do
    if [[ "$candidate" == "$gate_drain_scan_error" ]]; then
      gate_drain_scan_failed=1
      continue
    fi
    normalized="${normalized}${candidate} "
  done
  gate_drain_tagged_now="$normalized"
}

# Is this PID still one of ours, asked after its identity was read? Two answers
# count: it still carries one of the run's handles, or it is still a child of
# the process the walk reached it through. Either is enough, and both are
# needed — a reparented descendant has lost its parent but keeps the inherited
# handle, while a handle-less descendant is still reachable through its parent.
gate_drain_membership_holds() {
  local pid="$1"
  local parent="${2:-}"
  local recorded_start="${3:-}"
  local recorded_parent_start="${4:-}"
  local candidate candidate_snapshot candidate_start candidate_pgid
  local candidate_probe
  local tagged_after=""
  local parent_before parent_after parent_children parent_scan_status
  local anchor_snapshot anchor_start anchor_pgid
  gate_drain_membership_unverified=0

  if [[ "$gate_drain_capture_group_pgid" =~ ^[1-9][0-9]*$ ]]; then
    # A group snapshot is authorised by one live, exact group leader. Do not
    # accept the cached numeric tag or parent relation until both this
    # candidate and that leader are revalidated. The leader can otherwise exit
    # and its PID/PGID can be reused between the snapshot and this capture.
    if [[ "$recorded_start" == "$gate_lock_identity_unavailable" ]]; then
      gate_lock_identity_source_available && return 1
      candidate_pgid="$(ps -o pgid= -p "$pid" 2>/dev/null |
        head -n1 | tr -d '[:space:]' || true)"
    else
      candidate_snapshot="$(
        gate_lock_process_runtime_start_pgid_snapshot "$pid"
      )"
      if [[ "$candidate_snapshot" != *"|"* ]]; then
        candidate_probe="$(gate_lock_process_signal_probe "$pid")" ||
          candidate_probe="error"
        [[ "$candidate_probe" == "gone" ]] ||
          gate_drain_membership_unverified=1
        return 1
      fi
      candidate_start="${candidate_snapshot%|*}"
      candidate_pgid="${candidate_snapshot##*|}"
      recorded_start="$(gate_lock_normalize_process_start "$recorded_start")"
      [[ -n "$recorded_start" && "$candidate_start" == "$recorded_start" ]] ||
        return 1
    fi

    # Group recovery covers only current members of the pinned worker group.
    # A child relation through a snapshot PID is not enough here: that parent
    # PID can exit and be reused before the recursive walk observes its child.
    # Descendants outside the group remain discoverable through inherited
    # command/request handles; a detached process that drops every handle is
    # outside this recovery guarantee.
    [[ "$candidate_pgid" == "$gate_drain_capture_group_pgid" ]] || return 1

    if [[ "$gate_drain_capture_group_anchor_start" == "$gate_lock_identity_unavailable" ]]; then
      gate_lock_identity_source_available && return 1
      if ! kill -0 "$gate_drain_capture_group_anchor_pid" 2>/dev/null; then
        gate_drain_membership_unverified=1
        return 1
      fi
      anchor_pgid="$(ps -o pgid= \
        -p "$gate_drain_capture_group_anchor_pid" 2>/dev/null |
        head -n1 | tr -d '[:space:]' || true)"
      if [[ "$anchor_pgid" != "$gate_drain_capture_group_pgid" ]]; then
        gate_drain_membership_unverified=1
        return 1
      fi
    else
      anchor_snapshot="$(gate_lock_process_runtime_start_pgid_snapshot \
        "$gate_drain_capture_group_anchor_pid")"
      if [[ "$anchor_snapshot" != *"|"* ]]; then
        gate_drain_membership_unverified=1
        return 1
      fi
      anchor_start="${anchor_snapshot%|*}"
      anchor_pgid="${anchor_snapshot##*|}"
      if [[ "$anchor_start" != "$gate_drain_capture_group_anchor_start" ||
        "$anchor_pgid" != "$gate_drain_capture_group_pgid" ]]; then
        gate_drain_membership_unverified=1
        return 1
      fi
    fi
    return 0
  fi

  # Re-scan exact inherited handles after reading this PID's start identity.
  # A cached numeric match can exit and be reused between discovery and this
  # check. The replacement would then be recorded under its own valid start
  # identity and could pass every later signal guard. This is an exact-PID
  # revalidation. Full refreshes on both sides still discover new descendants.
  if [[ -n "$gate_drain_membership_token" ]]; then
    tagged_after="$(
      gate_run_tagged_pids "$gate_drain_membership_token" "$pid"
    )"
    for candidate in $tagged_after; do
      if [[ "$candidate" == "$gate_drain_scan_error" ]]; then
        gate_drain_scan_failed=1
        gate_drain_membership_unverified=1
        continue
      fi
      [[ "$candidate" == "$pid" ]] && return 0
    done
  else
    for candidate in ${gate_drain_tagged_now}; do
      [[ "$candidate" == "$pid" ]] && return 0
    done
  fi
  if [[ -n "$parent" && -n "$recorded_parent_start" ]]; then
    if [[ "$recorded_parent_start" == "$gate_lock_identity_unavailable" ]]; then
      gate_drain_membership_unverified=1
      return 1
    fi
    recorded_parent_start="$(
      gate_lock_normalize_process_start "$recorded_parent_start"
    )"
    parent_before="$(gate_lock_process_runtime_start "$parent")"
    [[ -n "$recorded_parent_start" &&
      "$parent_before" == "$recorded_parent_start" ]] || return 1
    parent_children="$(pgrep -P "$parent" 2>/dev/null)" &&
      parent_scan_status=0 || parent_scan_status=$?
    if [[ "$parent_scan_status" -gt 1 ]]; then
      gate_drain_scan_failed=1
      gate_drain_membership_unverified=1
      return 1
    fi
    parent_after="$(gate_lock_process_runtime_start "$parent")"
    [[ "$parent_after" == "$recorded_parent_start" ]] || return 1
    for candidate in $parent_children; do
      [[ "$candidate" == "$pid" ]] && return 0
    done
  fi
  return 1
}

# Append each identity before any signal. A crash cannot truncate an earlier
# entry or leave fewer identities than the drain already committed to. Since a
# capture completes before the first signal, anything already signalled is on
# disk.
capture_process_tree() {
  local root_pid="$1"
  local from_parent="${2:-}"
  local from_parent_start="${3:-}"
  local child children child_scan_status entry runtime_entry start
  local membership_start capture_runtime seen_runtime identity_probe
  local root_start_for_children
  # Children first, and always re-walked even for a process already recorded:
  # a command that survives TERM can fork again afterwards, so discovery has to
  # keep looking as long as anything is alive to fork. Only the recording is
  # skipped for a PID already in the list, which is what lets a pass that adds
  # nothing be recognised as one.
  root_start_for_children="$(gate_lock_process_runtime_start "$root_pid")"
  if [[ -z "$root_start_for_children" ]] &&
    ! gate_lock_identity_source_available; then
    root_start_for_children="$gate_lock_identity_unavailable"
  fi
  if [[ -n "$root_start_for_children" ]]; then
    children="$(pgrep -P "$root_pid" 2>/dev/null)" &&
      child_scan_status=0 || child_scan_status=$?
    if [[ "$child_scan_status" -gt 1 ]]; then
      gate_drain_scan_failed=1
    else
      for child in $children; do
        capture_process_tree \
          "$child" "$root_pid" "$root_start_for_children"
      done
    fi
  fi
  start="$(gate_lock_process_start_legacy_wire "$root_pid")"
  membership_start="$(gate_lock_process_runtime_start "$root_pid")"
  if [[ -z "$start" ]]; then
    if gate_lock_identity_source_available; then
      # The walk saw it, the identity read did not: it exited in between. A
      # process that is already gone is nothing to signal and nothing to wait
      # for, and recording it without an identity would later authorise a
      # signal at whatever inherits its PID.
      return 0
    fi
    start="$gate_lock_identity_unavailable"
    membership_start="$gate_lock_identity_unavailable"
  elif [[ -z "$membership_start" ]]; then
    # The legacy read succeeded and the exact runtime read did not. If the PID
    # is still live, retain the legacy identity as an unverified obligation. It
    # lets a later census discharge a confirmed zombie, but the missing runtime
    # identity still forbids signalling a live process. If it exited, a later
    # exact-handle scan can rediscover any replacement that belongs to the run.
    identity_probe="$(gate_lock_process_signal_probe "$root_pid")" ||
      identity_probe="error"
    [[ "$identity_probe" == "gone" ]] && return 0
  fi
  if [[ -n "$start" && "$start" != "$gate_lock_identity_unavailable" ]] &&
    ! gate_drain_membership_holds \
      "$root_pid" "$from_parent" "$membership_start" \
      "$from_parent_start"; then
    # Enumeration and identity are two reads with a gap between them, and a PID
    # recycled inside it would be recorded under a stranger's identity that
    # every later check then confirms. Re-asking whether this PID is still one
    # of ours closes that in the direction the rest of this path uses: an
    # answer that cannot be confirmed is recorded with no identity, which is
    # never signalled and holds the drain open rather than discharging it.
    if [[ "$gate_drain_capture_group_pgid" =~ ^[1-9][0-9]*$ &&
      "$gate_drain_membership_unverified" -eq 0 ]]; then
      return 0
    fi
    # Keep a readable legacy identity when the exact runtime read itself was
    # the ambiguous step. The entry remains unsignalable without runtime
    # metadata, but a confirmed zombie can later be discharged. If this capture
    # had an exact runtime identity and then lost membership, retain no identity
    # because that evidence now belongs to an unconfirmed process.
    [[ -z "$membership_start" ]] || start=""
  fi
  if [[ "$start" == "$gate_lock_identity_unavailable" ]]; then
    capture_runtime="$gate_lock_identity_unavailable"
  elif [[ -n "$start" ]]; then
    capture_runtime="$membership_start"
  else
    capture_runtime=""
  fi
  seen_runtime="${capture_runtime:-<runtime-unverified>}"
  gate_drain_seen_has_identity "$root_pid" "$seen_runtime" && return 0
  gate_drain_seen="${gate_drain_seen}${root_pid}|${seen_runtime}
"
  gate_drain_capture_set_entry "$root_pid" "$start" "$capture_runtime"
  entry="${root_pid}|${start}"
  runtime_entry="${gate_drain_capture_runtime_prefix}|${root_pid}|${capture_runtime}"
  # One `printf` of a short line through an append-mode descriptor is a single
  # write, so concurrent or interrupted appends cannot interleave a half line.
  # An append failure or invalid identity pair is remembered. The caller checks
  # it before signalling, because signalling destroys the alternative handle.
  if [[ -n "$gate_drain_capture_file" ]]; then
    if ! printf '%s\n' "$entry" >> "$gate_drain_capture_file" 2>/dev/null; then
      gate_drain_capture_unpersisted=1
    fi
    if [[ -n "$capture_runtime" ]] && {
      ! gate_drain_runtime_identity_matches_wire "$start" "$capture_runtime" ||
        ! printf '%s\n' "$runtime_entry" >> "$gate_drain_capture_file" 2>/dev/null
    }; then
      gate_drain_capture_unpersisted=1
    fi
  fi
}

gate_drain_capture_seed_group() {
  local token="$1"
  local snapshot pid pgid remainder tagged tagged_pgid groups="" group
  local group_anchor_start group_anchors=""
  local seed_current seed_snapshot_pgid
  local tagged_start tagged_current tagged_after tagged_after_clean=""
  local tagged_probe tagged_confirmed
  local tagged_candidate tagged_identities=""
  local identity_source_available=0
  [[ "$gate_drain_seed_pgid" =~ ^[1-9][0-9]*$ ||
    -n "${gate_drain_tagged_now//[[:space:]]/}" ]] || return 0
  if gate_lock_identity_source_available; then
    identity_source_available=1
  fi
  # Pin each tagged PID before the process-group snapshot. A tag scan and a
  # later `ps` row are independent observations. Without the start identity
  # between them, PID reuse can make an unrelated group leader look like the
  # recovery anchor.
  for tagged in $gate_drain_tagged_now; do
    [[ "$tagged" =~ ^[1-9][0-9]*$ ]] || continue
    tagged_start="$(gate_lock_process_runtime_start "$tagged")"
    if [[ -z "$tagged_start" ]]; then
      [[ "$identity_source_available" -eq 0 ]] || continue
      tagged_start="$gate_lock_identity_unavailable"
    fi
    tagged_identities="${tagged_identities}${tagged}|${tagged_start}
"
  done
  if ! snapshot="$(TZ=UTC LC_ALL=C ps -axo pid=,pgid= 2>/dev/null)"; then
    gate_drain_scan_failed=1
    return 0
  fi
  # Re-read the observed PIDs' handles after the group snapshot. A tagged PID
  # can seed a group only if the same process held the token on both sides of
  # the snapshot. Linux exact-PID scans avoid a second full procfs census. The
  # lsof fallback keeps one witnessed scan because lsof still performs a host
  # census for each PID filter. The caller captures new roots on its next full
  # refresh.
  if gate_run_proc_marker_scan_available; then
    for tagged in $gate_drain_tagged_now; do
      [[ "$tagged" =~ ^[1-9][0-9]*$ ]] || continue
      tagged_confirmed=0
      tagged_probe="$(gate_run_tagged_pids "$token" "$tagged")"
      for tagged_candidate in $tagged_probe; do
        if [[ "$tagged_candidate" == "$gate_drain_scan_error" ]]; then
          gate_drain_scan_failed=1
          continue
        fi
        [[ "$tagged_candidate" == "$tagged" ]] && tagged_confirmed=1
      done
      if [[ "$tagged_confirmed" -eq 1 ]]; then
        tagged_after_clean="${tagged_after_clean}${tagged} "
      fi
    done
  else
    tagged_probe="$(gate_run_tagged_pids "$token")"
    for tagged_candidate in $tagged_probe; do
      if [[ "$tagged_candidate" == "$gate_drain_scan_error" ]]; then
        gate_drain_scan_failed=1
        continue
      fi
      tagged_after_clean="${tagged_after_clean}${tagged_candidate} "
    done
  fi
  tagged_after="$tagged_after_clean"
  if [[ "$gate_drain_seed_pgid" =~ ^[1-9][0-9]*$ &&
    -n "$gate_drain_seed_start" ]]; then
    seed_snapshot_pgid="$(awk -v target="$gate_drain_seed_pgid" \
      '$1 == target && NF == 2 { print $2; exit }' <<< "$snapshot")"
    if [[ "$seed_snapshot_pgid" == "$gate_drain_seed_pgid" ]]; then
      seed_current="$(gate_lock_process_runtime_start "$gate_drain_seed_pgid")"
      if [[ "$seed_current" == "$gate_drain_seed_start" ]] || {
        [[ "$gate_drain_seed_start" == "$gate_lock_identity_unavailable" ]] &&
          ! gate_lock_identity_source_available &&
          kill -0 "$gate_drain_seed_pgid" 2>/dev/null
      }; then
        groups="${gate_drain_seed_pgid} "
        group_anchors="${gate_drain_seed_pgid}|${gate_drain_seed_start}
"
      fi
    fi
  fi
  # Crash recovery has no parent registry, so it derives a group only from a
  # tagged group leader whose PID/start identity survived the complete
  # snapshot. The active parent uses the separately validated explicit seed.
  while IFS='|' read -r tagged tagged_start; do
    [[ "$tagged" =~ ^[1-9][0-9]*$ && -n "$tagged_start" ]] || continue
    case " ${tagged_after} " in
      *" ${tagged} "*) : ;;
      *) continue ;;
    esac
    tagged_pgid="$(awk -v target="$tagged" \
      '$1 == target && NF == 2 { print $2; exit }' <<< "$snapshot")"
    [[ "$tagged_pgid" =~ ^[1-9][0-9]*$ ]] || continue
    tagged_current="$(gate_lock_process_runtime_start "$tagged")"
    if [[ "$tagged_start" == "$gate_lock_identity_unavailable" ]]; then
      [[ "$identity_source_available" -eq 0 ]] || continue
    elif [[ -z "$tagged_current" || "$tagged_current" != "$tagged_start" ]]; then
      continue
    fi
    if [[ "$tagged_pgid" == "$tagged" ]]; then
      case " ${groups} " in
        *" ${tagged_pgid} "*) : ;;
        *)
          groups="${groups}${tagged_pgid} "
          group_anchors="${group_anchors}${tagged_pgid}|${tagged_start}
"
          ;;
      esac
    fi
  done << EOF
$tagged_identities
EOF
  while IFS='|' read -r group group_anchor_start; do
    [[ "$group" =~ ^[1-9][0-9]*$ && -n "$group_anchor_start" ]] || continue
    gate_drain_capture_group_pgid="$group"
    gate_drain_capture_group_anchor_pid="$group"
    gate_drain_capture_group_anchor_start="$group_anchor_start"
    while read -r pid pgid remainder; do
      [[ -z "$remainder" && "$pid" =~ ^[1-9][0-9]*$ &&
        "$pgid" == "$group" ]] || continue
      capture_process_tree "$pid"
    done <<< "$snapshot"
    gate_drain_capture_group_pgid=""
    gate_drain_capture_group_anchor_pid=""
    gate_drain_capture_group_anchor_start=""
  done << EOF
$group_anchors
EOF
}

gate_darwin_settlement_failed_in_process() {
  local token="$1"
  case "|${gate_darwin_failed_settlement_tokens}|" in
    *"|${token}|"*) return 0 ;;
  esac
  return 1
}

gate_darwin_remember_failed_settlement() {
  local token="$1"
  gate_lock_token_is_wellformed "$token" || return 2
  gate_darwin_settlement_failed_in_process "$token" && return 0
  gate_darwin_failed_settlement_tokens="${gate_darwin_failed_settlement_tokens:+${gate_darwin_failed_settlement_tokens}|}${token}"
}

gate_darwin_lineage_cohort_signature() {
  local token existing inserted duplicate
  local -a canonical=()
  local -a next=()
  [[ "$#" -gt 0 ]] || return 2
  for token in "$@"; do
    gate_lock_token_is_wellformed "$token" || return 2
    inserted=0
    duplicate=0
    next=()
    for existing in "${canonical[@]+"${canonical[@]}"}"; do
      if [[ "$token" == "$existing" ]]; then
        duplicate=1
      elif [[ "$inserted" -eq 0 && "$token" < "$existing" ]]; then
        next+=("$token")
        inserted=1
      fi
      next+=("$existing")
    done
    [[ "$duplicate" -eq 0 ]] || return 2
    if [[ "$inserted" -eq 0 ]]; then
      next+=("$token")
    fi
    canonical=("${next[@]}")
  done
  local IFS=,
  printf '%s' "${canonical[*]}"
}

gate_darwin_cohort_settlement_failed_in_process() {
  local signature="$1"
  [[ -n "$signature" ]] || return 2
  case "|${gate_darwin_failed_settlement_cohorts}|" in
    *"|${signature}|"*) return 0 ;;
  esac
  return 1
}

gate_darwin_remember_failed_cohort_settlement() {
  local signature="$1"
  [[ -n "$signature" ]] || return 2
  gate_darwin_cohort_settlement_failed_in_process "$signature" && return 0
  gate_darwin_failed_settlement_cohorts="${gate_darwin_failed_settlement_cohorts:+${gate_darwin_failed_settlement_cohorts}|}${signature}"
}

gate_drain_settle_darwin_lineage() {
  local token="$1"
  local drain_context="$2"
  local drain_failure_prefix="$3"
  local drain_failure_phase="$4"
  local drain_failure_verdict="$5"
  # Keep the verified-empty state until the coordinator lease or recovery
  # obligation is durably discharged. A successor must be able to repeat the
  # exact scan if this process dies before that journal transition.
  if gate_darwin_settlement_failed_in_process "$token"; then
    echo "error: this process already reached the bounded Darwin settlement failure for ${token}." >&2
    echo "The retained lineage state is reserved for successor recovery." >&2
  elif gate_darwin_lineage_settle "$token" 1; then
    return 0
  else
    gate_darwin_remember_failed_settlement "$token" || return 2
  fi
  echo "${drain_failure_prefix} A Darwin process identity remained live or could not be classified safely." >&2
  if [[ "$drain_context" == "stale-run" ]]; then
    gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
      "$drain_failure_verdict"
  fi
  gate_drain_fail_for_context "$drain_context"
}

gate_drain_settle_darwin_lineage_cohort() {
  local drain_context="${1:-stale-run}"
  shift || return 2
  local token cohort_signature
  local drain_failure_prefix="Nothing has been executed."
  local drain_failure_phase="stale-obligation recovery"
  local drain_failure_verdict="No mapped command ran in this request"
  local -a tokens=("$@")
  [[ "${#tokens[@]}" -gt 0 ]] || return 0
  cohort_signature="$(gate_darwin_lineage_cohort_signature "${tokens[@]}")" ||
    return 2
  if [[ "$drain_context" == "active-command" ]]; then
    drain_failure_prefix="The mapped command finished, but descendant cleanup did not complete."
    drain_failure_phase="command descendant cleanup"
    drain_failure_verdict="A mapped command ran, but its descendants were not confirmed gone"
  fi
  for token in "${tokens[@]}"; do
    gate_lock_token_is_wellformed "$token" || return 2
    if ! gate_darwin_lineage_state_exists "$token"; then
      echo "error: required Darwin process-lineage evidence is missing for ${token}." >&2
      echo "${drain_failure_prefix} The scheduler barrier remains active." >&2
      if [[ "$drain_context" == "stale-run" ]]; then
        gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
          "$drain_failure_verdict"
      fi
      gate_drain_fail_for_context "$drain_context"
      return $?
    fi
  done
  if gate_darwin_cohort_settlement_failed_in_process "$cohort_signature"; then
    echo "error: this process already reached the bounded Darwin cohort settlement failure for ${cohort_signature}." >&2
    echo "The retained lineage state is reserved for successor recovery." >&2
    echo "${drain_failure_prefix} A Darwin process identity remained live or could not be classified safely." >&2
    if [[ "$drain_context" == "stale-run" ]]; then
      gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
        "$drain_failure_verdict"
    fi
    gate_drain_fail_for_context "$drain_context"
    return $?
  fi
  if ! gate_darwin_lineage_settle_cohort 1 "${tokens[@]}"; then
    gate_darwin_remember_failed_cohort_settlement "$cohort_signature" ||
      return 2
    echo "${drain_failure_prefix} A Darwin process identity remained live or could not be classified safely." >&2
    if [[ "$drain_context" == "stale-run" ]]; then
      gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
        "$drain_failure_verdict"
    fi
    gate_drain_fail_for_context "$drain_context"
    return $?
  fi
  for token in "${tokens[@]}"; do
    gate_drain_finish_exact_darwin_lineage \
      "$token" "$drain_context" "$drain_failure_prefix" \
      "$drain_failure_phase" "$drain_failure_verdict" || return $?
  done
}

gate_drain_finish_exact_darwin_lineage() {
  local token="$1"
  local drain_context="$2"
  local drain_failure_prefix="$3"
  local drain_failure_phase="$4"
  local drain_failure_verdict="$5"
  local captured_file=""

  [[ -z "$gate_lock_root_dir" ]] ||
    captured_file="${gate_lock_root_dir}/captured.${token}"
  if [[ -n "$captured_file" && ( -e "$captured_file" || -L "$captured_file" ) ]]; then
    if [[ -L "$captured_file" || ! -f "$captured_file" || ! -O "$captured_file" ]]; then
      echo "error: exact Darwin lineage settlement found unsafe portable evidence at ${captured_file}." >&2
      echo "${drain_failure_prefix} The scheduler barrier remains active." >&2
      if [[ "$drain_context" == "stale-run" ]]; then
        gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
          "$drain_failure_verdict"
      fi
      gate_drain_fail_for_context "$drain_context"
      return $?
    fi
    rm -f "$captured_file" || return 2
  fi
  gate_run_discard_marker_exact "$token" \
    "The exact Darwin command identity was drained, but its marker cleanup failed." ||
    return $?
}

gate_drain_settle_request_marker() {
  local token="$1"
  local drain_context="${2:-stale-run}"
  local drain_failure_prefix="$3"
  local drain_failure_phase="$4"
  local drain_failure_verdict="$5"
  local marker raw candidate live scan_failed
  local drain_started_at waited=0 empty_scans=0

  gate_lock_token_is_wellformed "$token" || return 2
  marker="$(gate_run_marker_path "$token")" || return 2
  if ! gate_run_marker_snapshot_is_exact "$marker" "$token"; then
    echo "error: request-marker recovery found missing, unsafe, or changed marker evidence for ${token}." >&2
    echo "${drain_failure_prefix} No process was signalled; the scheduler barrier remains active." >&2
    if [[ "$drain_context" == "stale-run" ]]; then
      gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
        "$drain_failure_verdict"
    fi
    gate_drain_fail_for_context "$drain_context"
    return $?
  fi

  drain_started_at="$(date +%s)"
  while :; do
    live=""
    scan_failed=0
    if raw="$(gate_run_tagged_pids "$token")"; then
      :
    else
      raw=""
      scan_failed=1
    fi
    for candidate in $raw; do
      if [[ "$candidate" == "$gate_drain_scan_error" ]]; then
        scan_failed=1
      elif [[ "$candidate" =~ ^[1-9][0-9]*$ ]]; then
        case " ${live} " in
          *" ${candidate} "*) : ;;
          *) live="${live}${candidate} " ;;
        esac
      else
        scan_failed=1
      fi
    done

    if [[ -z "$live" && "$scan_failed" -eq 0 ]]; then
      empty_scans=$((empty_scans + 1))
      # A holder can fork while the first lsof or procfs census runs. Require a
      # second empty snapshot after a quiet interval before the direct recovery
      # obligation can be removed.
      [[ "$empty_scans" -lt 2 ]] || return 0
      sleep 0.2
      continue
    fi
    empty_scans=0
    waited=$(($(date +%s) - drain_started_at))
    if [[ "$waited" -ge "$gate_lock_orphan_drain_bound_seconds" ]]; then
      [[ -z "$live" ]] ||
        echo "error: request-marker holders are still alive after ${waited}s: ${live}" >&2
      [[ "$scan_failed" -eq 0 ]] ||
        echo "error: the request-marker holder scan kept failing after ${waited}s." >&2
      echo "${drain_failure_prefix} No process was signalled; the scheduler barrier remains active." >&2
      if [[ "$drain_context" == "stale-run" ]]; then
        gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
          "$drain_failure_verdict"
      fi
      gate_drain_fail_for_context "$drain_context"
      return $?
    fi
    sleep 1
  done
}

drain_condemned_run_commands() {
  local token="$1"
  local drain_context="${2:-stale-run}"
  local seed_pgid="${3:-}"
  local seed_start="${4:-}"
  local quiet_seed_only="${5:-0}"
  local lifecycle_contract="${6:-}"
  local wrapper entry pid recorded current runtime_recorded runtime_current
  local signal_probe
  local alive alive_identities recycled unverified captured_file
  local captured_pid
  local raw_capture captured_line captured_line_pid captured_line_start
  local captured_line_extra pending_pid="" pending_start=""
  local waited=0
  local drain_started_at
  local announced=0
  local escalated=0
  local drain_subject="previous run"
  local drain_start_message="The run this lock was taken from left commands running; stopping them before starting anything."
  local drain_done_message="Previous run's commands are gone; continuing."
  local drain_failure_prefix="Nothing has been executed."
  local drain_failure_phase="stale-obligation recovery"
  local drain_failure_verdict="No mapped command ran in this request"
  local full_scan_start_floor=""
  if ! gate_recovery_lifecycle_contract_is_supported "$lifecycle_contract"; then
    echo "error: mapped-command drain received a missing or unsupported lifecycle contract." >&2
    gate_drain_fail_for_context "$drain_context"
    return $?
  fi
  if [[ "$drain_context" == "active-command" ]]; then
    drain_subject="completed mapped command"
    drain_start_message="A completed mapped command left descendants running; stopping them before releasing its scheduler lease."
    drain_done_message="The completed mapped command's descendants are gone; releasing its scheduler lease."
    drain_failure_prefix="The mapped command finished, but descendant cleanup did not complete."
    drain_failure_phase="command descendant cleanup"
    drain_failure_verdict="A mapped command ran, but its descendants were not confirmed gone"
    full_scan_start_floor="${gate_active_command_proc_start_floor:-}"
  fi
  [[ -n "$token" ]] || return 0
  if [[ -n "$seed_pgid" && ! "$seed_pgid" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: mapped-command drain received an invalid worker process group." >&2
    gate_drain_fail_for_context "$drain_context"
    return $?
  fi
  if [[ "$quiet_seed_only" != 0 && "$quiet_seed_only" != 1 ]]; then
    echo "error: mapped-command drain received an invalid quiet-sentinel flag." >&2
    gate_drain_fail_for_context "$drain_context"
    return $?
  fi
  gate_drain_seed_pgid="$seed_pgid"
  gate_drain_seed_start="$seed_start"
  gate_drain_membership_token="$token"
  drain_started_at="$(date +%s)"

  # A request marker is an aggregate discovery barrier. Per-command recovery
  # already owns every destructive action. This recovery-only contract waits
  # for two exact empty marker scans and never treats a reusable PID or PGID as
  # signal authority.
  if [[ "$lifecycle_contract" == "request-marker-empty-v1" ]]; then
    gate_drain_settle_request_marker \
      "$token" "$drain_context" "$drain_failure_prefix" \
      "$drain_failure_phase" "$drain_failure_verdict"
    return $?
  fi

  # Darwin lineage settlement owns destructive recovery for both the current
  # coherent contract and a persisted legacy contract. The lineage helper
  # migrates old state before it settles anything. An ambiguous lineage fails
  # here and keeps the scheduler barrier active.
  if [[ "$lifecycle_contract" == "darwin-coherent-lineage-v2" ||
    "$lifecycle_contract" == "darwin-unique-lineage-v1" ]]; then
    if ! gate_darwin_lineage_state_exists "$token"; then
      echo "error: required Darwin process-lineage evidence is missing for ${token}." >&2
      echo "${drain_failure_prefix} The scheduler barrier remains active." >&2
      if [[ "$drain_context" == "stale-run" ]]; then
        gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
          "$drain_failure_verdict"
      fi
      gate_drain_fail_for_context "$drain_context"
      return $?
    fi
    gate_drain_settle_darwin_lineage \
      "$token" "$drain_context" "$drain_failure_prefix" \
      "$drain_failure_phase" "$drain_failure_verdict" || return $?
    gate_drain_finish_exact_darwin_lineage \
      "$token" "$drain_context" "$drain_failure_prefix" \
      "$drain_failure_phase" "$drain_failure_verdict"
    return $?
  fi

  # Enumerate before signalling anything. Only the wrapper carries the tag, so
  # killing it first would destroy the one handle to its descendants: a command
  # that ignores TERM would outlive its wrapper, the next search for the tag
  # would come back empty, and "no tagged process" would be read as "nothing
  # running". The captured set, not a re-scan, is what the drain confirms
  # against.
  gate_drain_capture=""
  # Per token, not per run: the dedup set is what stops a PID being recorded
  # twice, and carrying it across tokens would skip a PID that has since been
  # recycled by a process belonging to the next one — recording it under no
  # identity check at all.
  gate_drain_seen=""
  captured_file=""
  [[ -z "$gate_lock_root_dir" ]] || captured_file="${gate_lock_root_dir}/captured.${token}"
  if [[ -n "$captured_file" ]]; then
    # A symlink here is not ours — this gate only ever creates these as
    # regular files, and appending through a planted link would write
    # whatever it points at with this user's permissions.
    if [[ -L "$captured_file" ]]; then
      gate_drain_obligation_unreadable "$captured_file" "$drain_context" ||
        return $?
    fi
    if [[ ! -e "$captured_file" ]]; then
      # Created exclusively before the first append, so every later >> lands
      # in a regular file this run made; noclobber refuses a path planted
      # between the check above and here, symlinks included.
      if ! (set -C && : > "$captured_file") 2>/dev/null; then
        gate_drain_obligation_unreadable "$captured_file" "$drain_context" ||
          return $?
      fi
    fi
  fi
  # Every process found from here on is appended as it is discovered.
  gate_drain_capture_file="$captured_file"
  gate_drain_capture_unpersisted=0
  gate_drain_scan_failed=0
  # Start from what an earlier drain wrote down before it was interrupted. Its
  # tagged processes are very likely already gone — killing them is what the
  # first pass does — so a fresh tag scan on its own would come back empty and
  # call the job finished while an untagged descendant carried on.
  if [[ -n "$captured_file" && -e "$captured_file" ]]; then
    # Owned by us, or not evidence. The identity strings inside are public
    # (ps shows any process's start time), so another writer on a shared
    # root could fabricate a snapshot naming a victim PID with its genuine
    # identity — and this run would kill by it. What cannot be fabricated is
    # the file's owner: only this uid's runs write these, so an inherited
    # snapshot someone else owns is refused, run stopped, file named.
    if [[ ! -O "$captured_file" ]]; then
      echo "error: ${captured_file} is not owned by this user, so it is not this gate's evidence." >&2
      echo "On a shared lock root that is a fabricated snapshot; killing by it could signal a stranger." >&2
      echo "${drain_failure_prefix} Inspect and remove that file, then re-run." >&2
      if [[ "$drain_context" == "stale-run" ]]; then
        gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
          "$drain_failure_verdict"
      fi
      gate_drain_fail_for_context "$drain_context"
      return $?
    fi
    # Unreadable is not empty. Starting from nothing here would lose the
    # descendants an interrupted drain recorded, and their tagged wrapper is
    # already dead by then — so the tag scan below would come back empty and
    # this run would call the job done with those processes still running.
    if [[ ! -r "$captured_file" ]]; then
      gate_drain_obligation_unreadable "$captured_file" "$drain_context" ||
        return $?
    fi
    raw_capture="$(cat "$captured_file" 2>/dev/null)" || {
      gate_drain_obligation_unreadable "$captured_file" "$drain_context" ||
        return $?
    }
    while IFS= read -r captured_line; do
      [[ -n "$captured_line" ]] || continue
      if [[ "$captured_line" =~ ^[1-9][0-9]*\|[^\|]*$ ]]; then
        if [[ -n "$pending_pid" ]]; then
          gate_drain_capture_set_entry "$pending_pid" "$pending_start" ""
        fi
        captured_line_pid="${captured_line%%|*}"
        captured_line_start="${captured_line#*|}"
        pending_pid="$captured_line_pid"
        pending_start="$captured_line_start"
        continue
      fi
      if [[ "$captured_line" =~ ^${gate_drain_capture_runtime_prefix}\|[1-9][0-9]*\|[^\|]+$ ]]; then
        # shellcheck disable=SC2034 # the validated prefix is intentionally discarded
        IFS='|' read -r captured_line_extra captured_line_pid captured_line_start << EOF
$captured_line
EOF
        if [[ -z "$pending_pid" || "$captured_line_pid" != "$pending_pid" ]]; then
          gate_drain_obligation_unreadable "$captured_file" "$drain_context" ||
            return $?
        fi
        if ! gate_drain_runtime_identity_matches_wire \
          "$pending_start" "$captured_line_start"; then
          gate_drain_obligation_unreadable "$captured_file" "$drain_context" ||
            return $?
        fi
        gate_drain_capture_set_entry \
          "$pending_pid" "$pending_start" "$captured_line_start"
        pending_pid=""
        pending_start=""
        continue
      fi
      gate_drain_obligation_unreadable "$captured_file" "$drain_context" ||
        return $?
    done << EOF
$raw_capture
EOF
    if [[ -n "$pending_pid" ]]; then
      gate_drain_capture_set_entry "$pending_pid" "$pending_start" ""
    fi
  fi
  # Walked twice, with a pause between. A tree walk is a snapshot, and a
  # snapshot can catch a wrapper in the instant before its child is visible —
  # observed, once, as a capture holding only the two tagged processes and none
  # of their descendants. Missing a descendant here is expensive, because the
  # first signal kills the tagged wrapper and with it the only handle to
  # anything the walk did not already record. Two walks are not a proof, but
  # they cost 200ms on a path that runs only after a crash.
  gate_drain_refresh_tagged "$token" "$full_scan_start_floor"
  for wrapper in $gate_drain_tagged_now; do
    capture_process_tree "$wrapper"
  done
  gate_drain_capture_seed_group "$token"
  sleep 0.2
  gate_drain_refresh_tagged "$token" "$full_scan_start_floor"
  for wrapper in $gate_drain_tagged_now; do
    capture_process_tree "$wrapper"
  done
  gate_drain_capture_seed_group "$token"
  if [[ -z "${gate_drain_capture//[[:space:]]/}" && "$gate_drain_scan_failed" -eq 0 ]]; then
    [[ -z "$captured_file" ]] || rm -f "$captured_file"
    gate_run_discard_marker_exact "$token" \
      "The prior command identity was drained, but its marker cleanup failed." ||
      return $?
    return 0
  fi

  # The tag is the only handle on these processes that this run did not write
  # itself, and the first signal kills the tag carrier. Signalling with the
  # captured list unwritten would leave a run that dies mid-drain with neither:
  # an empty tag scan reads as "nothing running" to whoever comes next. So a
  # capture that could not be persisted stops the run here, before the handle
  # is destroyed and while the processes are still findable by tag.
  if [[ "$gate_drain_capture_unpersisted" -ne 0 ]]; then
    echo "error: could not publish a complete valid captured process list at ${captured_file}." >&2
    echo "Signalling now would destroy the tag those processes are still findable by, without valid durable evidence to hand on." >&2
    echo "${drain_failure_prefix} Check the process identities and that path, then re-run." >&2
    if [[ "$drain_context" == "stale-run" ]]; then
      gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
        "$drain_failure_verdict"
    fi
    gate_drain_fail_for_context "$drain_context"
    return $?
  fi

  # The portable path can observe marker state on Darwin, but its PID/start
  # and PGID witnesses are reusable. Never use them as signal authority. A
  # non-empty portable capture on Darwin keeps the scheduler barrier active.
  if [[ "$gate_darwin_lineage_host_platform" == Darwin ]]; then
    echo "error: portable marker recovery found a live process on Darwin without a non-reusable kernel identity." >&2
    echo "${drain_failure_prefix} No process was signalled; the scheduler barrier remains active." >&2
    if [[ "$drain_context" == "stale-run" ]]; then
      gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
        "$drain_failure_verdict"
    fi
    gate_drain_fail_for_context "$drain_context"
    return $?
  fi

  # A parallel worker's durable capture can include a short-lived helper from
  # its sentinel. Defer quiet-sentinel diagnostics to the live census below.
  if [[ "$quiet_seed_only" -eq 0 ]]; then
    echo "$drain_start_message"
    announced=1
  fi
  recycled=""

  while :; do
    alive=""
    alive_identities=""
    unverified=""
    gate_drain_scan_failed=0
    gate_drain_refresh_tagged "$token" "$full_scan_start_floor"
    # A tagged replacement can appear after the previous bottom-of-loop walk
    # and after its captured parent exits. Persist every fresh tagged root
    # before deciding that the old capture is empty.
    for wrapper in $gate_drain_tagged_now; do
      capture_process_tree "$wrapper"
    done
    gate_drain_capture_seed_group "$token"
    while IFS='|' read -r pid recorded runtime_recorded; do
      [[ -n "$pid" ]] || continue
      # Only signal something that reads as a PID. Appends are single short
      # writes so a half-written line should be impossible, and this is the
      # backstop for that being wrong: a truncated line could otherwise name
      # some unrelated process, and killing a stranger is worse than missing a
      # survivor the tag scan would find anyway.
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      if ! kill -0 "$pid" 2>/dev/null; then
        signal_probe="$(gate_lock_process_signal_probe "$pid")" ||
          signal_probe="error"
        [[ "$signal_probe" == "gone" ]] && continue
        # `kill -0` also returns EPERM for a live process. Never read that as
        # exit. A credential-changing or policy-confined descendant stays an
        # unverifiable drain obligation and is never signalled by PID alone.
        [[ "$signal_probe" == "denied" || "$signal_probe" == "live" ]] ||
          gate_drain_scan_failed=1
        case " ${unverified} " in
          *" ${pid} "*) : ;;
          *) unverified="${unverified}${pid} " ;;
        esac
        continue
      fi
      if [[ "$recorded" == "$gate_lock_identity_unavailable" ]]; then
        # This host cannot identify processes at all, so a handle it still
        # carries is the only selector there is. Signalling on PID alone would
        # kill whatever inherited the number; a PID that no longer answers to
        # any of this run's handles is therefore left alone and named, and it
        # keeps the drain open rather than discharging it.
        if gate_drain_membership_holds "$pid" ""; then
          if [[ "$runtime_recorded" != "$gate_lock_identity_unavailable" ]]; then
            case " ${unverified} " in
              *" ${pid} "*) : ;;
              *) unverified="${unverified}${pid} " ;;
            esac
            continue
          fi
          alive="${alive}${pid} "
          # Queued for the signal loop too — it consumes alive_identities, and
          # an entry only in `alive` would be waited on but never signalled,
          # holding the drain to its bound for nothing. The loop re-checks
          # membership under the sentinel before sending anything.
          alive_identities="${alive_identities}${pid}|${gate_lock_identity_unavailable}|${gate_lock_identity_unavailable}
"
        else
          case " ${unverified} " in
            *" ${pid} "*) : ;;
            *) unverified="${unverified}${pid} " ;;
          esac
        fi
        continue
      fi
      recorded="$(gate_lock_normalize_process_start "$recorded")"
      current="$(gate_lock_process_start "$pid")"
      if [[ -z "$recorded" || -z "$current" ]]; then
        # An identity we cannot read is not an identity that matches. Empty
        # must mean "cannot verify, never signal" — read as "matches anything"
        # it would authorise killing whatever inherited this PID. It still
        # counts as outstanding, so the drain keeps waiting on it rather than
        # calling the run clear, and fails closed at the bound if it persists.
        case " ${unverified} " in
          *" ${pid} "*) : ;;
          *) unverified="${unverified}${pid} " ;;
        esac
        continue
      fi
      if [[ "$current" != "$recorded" ]]; then
        # The PID exists but is somebody else now. Signalling it would be
        # killing a stranger's process, so it is left alone and named below.
        # Nothing of the dead run survives under it, so it does not hold the
        # drain open either.
        case " ${recycled} " in
          *" ${pid} "*) : ;;
          *) recycled="${recycled}${pid} " ;;
        esac
        continue
      fi
      if gate_lock_process_is_confirmed_zombie "$pid" "$recorded"; then
        continue
      fi
      if [[ -z "$runtime_recorded" ]]; then
        case " ${unverified} " in
          *" ${pid} "*) : ;;
          *) unverified="${unverified}${pid} " ;;
        esac
        continue
      fi
      runtime_current="$(gate_lock_process_runtime_start "$pid")"
      if [[ -z "$runtime_current" || "$runtime_current" != "$runtime_recorded" ]]; then
        if [[ -n "$runtime_current" ]]; then
          case " ${recycled} " in
            *" ${pid} "*) : ;;
            *) recycled="${recycled}${pid} " ;;
          esac
          continue
        fi
        case " ${unverified} " in
          *" ${pid} "*) : ;;
          *) unverified="${unverified}${pid} " ;;
        esac
        continue
      fi
      alive="${alive}${pid} "
      alive_identities="${alive_identities}${pid}|${recorded}|${runtime_recorded}
"
    done << EOF
$gate_drain_capture
EOF

    # A no-lock sentinel polls its exact parent identity. A short-lived ps
    # helper can enter the durable capture and be gone by this census. Report a
    # leaked descendant only when a live or unverifiable non-sentinel process
    # remains; the persisted capture and signal checks stay unchanged.
    if [[ "$quiet_seed_only" -eq 1 && "$announced" -eq 0 ]]; then
      for captured_pid in $alive $unverified $gate_drain_tagged_now; do
        [[ "$captured_pid" == "$seed_pgid" ]] && continue
        echo "$drain_start_message"
        announced=1
        break
      done
      if [[ "$announced" -eq 0 && "$gate_drain_scan_failed" -ne 0 ]]; then
        echo "$drain_start_message"
        announced=1
      fi
    fi

    # The crash fixture pauses after the durable refresh and live census but
    # before any signal. This ordering preserves the liveness diagnostic
    # before the recovery hand-off.
    if ! gate_drain_test_refresh_barrier; then
      echo "error: the test-only drain refresh barrier did not release." >&2
      gate_drain_fail_for_context "$drain_context"
      return $?
    fi

    # Unverifiable entries keep the drain open even though nothing is sent to
    # them: "we could not check" is not "it is gone". A scan that failed counts
    # the same way — an unanswered question is not an empty answer.
    [[ -n "$alive" || -n "$unverified" || -n "$gate_drain_tagged_now" ||
      "$gate_drain_scan_failed" -ne 0 ]] || break

    if [[ "$waited" -ge "$gate_lock_orphan_drain_bound_seconds" ]]; then
      # Refusing to run is the whole point: proceeding here is exactly the
      # cross-run overlap the lock exists to prevent.
      [[ -z "$alive" ]] ||
        echo "error: commands from the ${drain_subject} are still alive after ${waited}s: ${alive}" >&2
      [[ -z "$unverified" ]] ||
        echo "error: processes from the ${drain_subject} could not be identified after ${waited}s, so none were signalled: ${unverified}" >&2
      [[ "$gate_drain_scan_failed" -eq 0 ]] ||
        echo "error: the scan for the ${drain_subject}'s processes kept failing after ${waited}s, so it is not known whether any are left." >&2
      echo "${drain_failure_prefix} Investigate those processes, then re-run." >&2
      if [[ "$drain_context" == "stale-run" ]]; then
        gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
          "$drain_failure_verdict"
      fi
      gate_drain_fail_for_context "$drain_context"
      return $?
    fi

    # Same rule between passes: a re-walk that found a forked child but could
    # not write it down must not be followed by another signal round, which
    # would kill that child's parent and leave it unrecorded.
    if [[ "$gate_drain_capture_unpersisted" -ne 0 ]]; then
      echo "error: could not publish a complete valid captured process list at ${captured_file} while draining." >&2
      echo "error: still alive: ${alive:-none}${unverified:+, unverified: ${unverified}}" >&2
      echo "${drain_failure_prefix} Investigate those processes and that path, then re-run." >&2
      if [[ "$drain_context" == "stale-run" ]]; then
        gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
          "$drain_failure_verdict"
      fi
      gate_drain_fail_for_context "$drain_context"
      return $?
    fi

    # Identity is re-read here rather than trusted from the census above. The
    # two are separated by the whole census, the bound check and the persist
    # check, and a PID recycled inside that gap would be signalled on the
    # strength of a check that passed for a process which no longer exists.
    while IFS='|' read -r pid recorded runtime_recorded; do
      [[ -n "$pid" ]] || continue
      if [[ "$recorded" != "$gate_lock_identity_unavailable" ]]; then
        recorded="$(gate_lock_normalize_process_start "$recorded")"
        current="$(gate_lock_process_start "$pid")"
        if [[ -z "$current" || "$current" != "$recorded" ]]; then
          # Gone, or somebody else now. Either way this signal is not ours to
          # send; the next census re-classifies it.
          continue
        fi
      elif ! gate_drain_membership_holds "$pid" ""; then
        continue
      fi
      if [[ "$runtime_recorded" == "$gate_lock_identity_unavailable" ]]; then
        gate_drain_membership_holds "$pid" "" || continue
      else
        # Keep the exact Linux start tick as the last generation check before
        # the portable numeric signal. macOS falls back to its lstart identity.
        runtime_current="$(gate_lock_process_runtime_start "$pid")"
        if [[ -z "$runtime_recorded" ||
          "$runtime_current" != "$runtime_recorded" ]]; then
          continue
        fi
      fi
      if [[ "$escalated" -eq 1 ]]; then
        kill -KILL "$pid" 2>/dev/null || true
      else
        kill -TERM "$pid" 2>/dev/null || true
      fi
    done << EOF
$alive_identities
EOF
    # After the first pass the tag carrier is usually dead, which is exactly
    # the state a successor has to be able to inherit.
    [[ "$waited" -ne 0 ]] || gate_lock_test_crash after-drain-term
    if [[ "$quiet_seed_only" -eq 1 && "$announced" -eq 0 ]]; then
      # A completed parallel worker stays alive only as the exact group anchor.
      # TERM should end that single blocked shell immediately. Poll quickly so
      # the safety sentinel does not add one second to every mapped command.
      sleep 0.05
    else
      sleep 1
    fi
    # Clock, not the sum of requested sleeps: a drain that is descheduled
    # should notice that its budget went with the time, and should print the
    # time that actually passed.
    waited=$(($(date +%s) - drain_started_at))
    # Give TERM a few seconds to be honoured before insisting.
    [[ "$waited" -lt 4 ]] || escalated=1

    # Re-walk after every signal pass, not once. A command that ignores TERM
    # can fork a child at any point before the KILL escalation reaches it, and
    # a child discovered after its parent was recorded is exactly the one that
    # would otherwise outlive this drain. Repeating the walk drives discovery
    # to a fixpoint. Each pass either adds an exact PID/runtime generation or
    # does not. The append-only journal grows, and each exact generation is
    # recorded once. A recycled PID can add a new generation. The bounded loop
    # ends when a pass adds nothing and everything found is gone, or it fails
    # closed at the bound.
    #
    # Re-asked of the token as well, not only of the survivors: a command that
    # forks a replacement and then exits leaves nothing to walk down from, and
    # the replacement is discoverable only by the token it inherited.
    gate_drain_refresh_tagged "$token" "$full_scan_start_floor"
    for pid in $alive $gate_drain_tagged_now; do
      capture_process_tree "$pid"
    done
    gate_drain_capture_seed_group "$token"
  done

  # Discharged: every process in the captured set is gone or belongs to
  # somebody else now, so the list has nothing left to hand on.
  [[ -z "$captured_file" ]] || rm -f "$captured_file"
  gate_run_discard_marker_exact "$token" \
    "The prior command identity was drained, but its marker cleanup failed." ||
    return $?

  if [[ -n "$recycled" ]]; then
    echo "Left alone: pid(s) ${recycled}now belong to unrelated processes."
  fi
  if [[ "$announced" -eq 1 ]]; then
    echo "$drain_done_message"
    echo
  fi
}

drain_completed_command_identity() {
  local token="$1"
  local clear_request_marker="${2:-0}"
  local seed_pgid="${3:-}"
  local seed_start="${4:-}"
  local quiet_seed_only="${5:-0}"
  local lifecycle_contract="${6:-}"
  local condemned_dir=""
  local coordinator_active=0
  local legacy_lock_active=0
  [[ -n "$token" ]] || return 0
  gate_lifecycle_contract_is_supported "$lifecycle_contract" || {
    echo "error: completed-command drain has no supported lifecycle contract." >&2
    return 2
  }

  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active; then
    coordinator_active=1
  fi
  if [[ -n "$gate_lock_dir" && -n "$gate_lock_root_dir" &&
    -n "$gate_lock_token" ]]; then
    legacy_lock_active=1
  fi
  if [[ "$legacy_lock_active" -eq 1 ]]; then
    # One assignment-only command closes the signal window between the two
    # guards: cleanup must preserve both the marker and the legacy owner until
    # the recovery obligation exists on disk.
    gate_active_command_drain_in_progress=1 gate_cleanup_preserve_legacy_lock=1
    if ! record_condemned_run "$token" "$lifecycle_contract"; then
      echo "error: could not record the completed command's descendants in ${gate_lock_root_dir:-unknown}/condemned.d." >&2
      echo "The legacy lock stays in place so a later run must reclaim and drain this run before executing work." >&2
      echo "The mapped command finished, but descendant cleanup did not start. Fix that path — permissions, or free space — then re-run." >&2
      return 2
    fi
    condemned_dir="$(gate_lock_condemned_dir)" || {
      echo "error: could not resolve the completed command's recovery directory." >&2
      return 2
    }
    gate_cleanup_preserve_legacy_lock=0
  elif [[ "$coordinator_active" -eq 1 ]]; then
    # The coordinator journal already contains this request's drain token and
    # lease. Preserve its marker until normal cleanup or recovery succeeds.
    gate_active_command_drain_in_progress=1
  else
    # An explicit --no-lock run has no durable recovery owner. It still drains
    # its exact live identity before returning, but it has no lock record to
    # preserve or obligation directory to publish into.
    gate_active_command_drain_in_progress=1
  fi

  # The active drain stays in the gate process. A second drainer for the same
  # token must never race this one over its append-only capture file.
  drain_condemned_run_commands \
    "$token" active-command "$seed_pgid" "$seed_start" \
    "$quiet_seed_only" "$lifecycle_contract" || return $?
  if [[ "$legacy_lock_active" -eq 1 ]]; then
    rm -f "${condemned_dir}/${token}" || return 2
  fi
  if [[ "$lifecycle_contract" == "darwin-coherent-lineage-v2" &&
    "$coordinator_active" -eq 0 ]]; then
    # A legacy sequential run uses its owner token for every command. Retain
    # the exact settlement as the recovery proof between commands and through
    # final lock release. Unique no-lock identities retire immediately.
    if [[ "$legacy_lock_active" -ne 1 || "$token" != "$gate_lock_token" ]]; then
      gate_darwin_lineage_discard_settled "$token" || return $?
    fi
  fi
  # The drain removes holder.<token>. A sequential command uses the request
  # marker itself, so clear that cached path. Parallel commands use their own
  # markers and leave the request-wide recovery marker in place.
  if [[ "$clear_request_marker" -eq 1 ]]; then
    gate_run_marker_file=""
  fi
  gate_active_command_drain_in_progress=0
}

drain_completed_darwin_command_cohort() {
  local token condemned_dir=""
  local coordinator_active=0
  local legacy_lock_active=0
  local -a tokens=("$@")
  [[ "${#tokens[@]}" -gt 0 ]] || return 0
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active; then
    coordinator_active=1
  fi
  if [[ -n "$gate_lock_dir" && -n "$gate_lock_root_dir" &&
    -n "$gate_lock_token" ]]; then
    legacy_lock_active=1
  fi
  gate_active_command_drain_in_progress=1
  if [[ "$legacy_lock_active" -eq 1 ]]; then
    gate_cleanup_preserve_legacy_lock=1
    for token in "${tokens[@]}"; do
      if ! record_condemned_run "$token" "darwin-coherent-lineage-v2"; then
        echo "error: could not record the Darwin command cohort in ${gate_lock_root_dir:-unknown}/condemned.d." >&2
        echo "The legacy lock stays in place so a later run must reclaim and drain this cohort before executing work." >&2
        return 2
      fi
    done
    condemned_dir="$(gate_lock_condemned_dir)" || return 2
    gate_cleanup_preserve_legacy_lock=0
  fi
  gate_drain_settle_darwin_lineage_cohort \
    active-command "${tokens[@]}" || return $?
  if [[ "$legacy_lock_active" -eq 1 ]]; then
    for token in "${tokens[@]}"; do
      rm -f "${condemned_dir}/${token}" || return 2
    done
  fi
  if [[ "$coordinator_active" -eq 0 ]]; then
    for token in "${tokens[@]}"; do
      if [[ "$legacy_lock_active" -ne 1 || "$token" != "$gate_lock_token" ]]; then
        gate_darwin_lineage_discard_settled "$token" || return $?
      fi
    done
  fi
  gate_active_command_drain_in_progress=0
}

drain_completed_sequential_command() {
  local token="${gate_run_id:-$gate_lock_token}"
  local clear_request_marker=1
  local lifecycle_contract="${active_timeout_lifecycle_contract:-}"
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active &&
    [[ -n "${gate_coordinator_active_drain_identity:-}" ]]; then
    token="$gate_coordinator_active_drain_identity"
    clear_request_marker=0
  fi
  drain_completed_command_identity \
    "$token" "$clear_request_marker" "" "" 0 "$lifecycle_contract"
}

drain_completed_parallel_command() {
  local drain_identity="$1"
  local worker_pgid="${2:-}"
  local worker_start="${3:-}"
  local lifecycle_contract="${4:-}"
  drain_completed_command_identity \
    "$drain_identity" 0 "$worker_pgid" "$worker_start" 1 \
    "$lifecycle_contract"
}

assert_gate_run_lock_still_ours_legacy() {
  local recorded
  [[ -n "$gate_lock_dir" ]] || return 0
  recorded="$(gate_lock_owner_field "$gate_lock_dir" token)"
  [[ "$recorded" == "$gate_lock_token" ]] && return 0
  echo "error: this run no longer holds the gate run lock at ${gate_lock_dir}." >&2
  echo "Another run took it over before this one reached its mapped commands." >&2
  echo "Nothing has been executed. Re-run, and it will queue behind the current holder." >&2
  exit 2
}

release_gate_run_lock_legacy() {
  local recorded release_dir release_taken release_owner moved_owner_identity moved_owner_matches
  local private_owner_identity private_owner_matches inert_stage inert_name inert_pid
  local release_prepare_status release_take_status restored_owner_identity
  [[ -n "$gate_lock_dir" ]] || return 0
  recorded="$(gate_lock_owner_field "$gate_lock_dir" token)"
  # A token check followed by recursive deletion is not an ownership proof.
  # Another run can publish between those two operations. Take the exact owner
  # record by atomic rename, validate the copy, and remove only an empty lock
  # directory. A successor owner makes rmdir fail and remains untouched.
  if [[ "$recorded" != "$gate_lock_token" ]]; then
    gate_lock_dir=""
    return 0
  fi
  release_dir="$(mktemp -d "${gate_lock_root_dir}/owner-release.XXXXXX")" || {
    echo "error: could not create private state for quality-gate lock release; leaving the lock for stale recovery." >&2
    gate_lock_dir=""
    return 2
  }
  chmod 700 "$release_dir" || {
    rmdir "$release_dir" 2>/dev/null || true
    echo "error: could not protect private state for quality-gate lock release; leaving the lock for stale recovery." >&2
    gate_lock_dir=""
    return 2
  }
  # Keep the original owner inode open across the test delay and atomic take.
  # A replacement can copy this run's token, so token equality alone does not
  # authorize release. Node compares the moved path to this descriptor's
  # device and inode because macOS exposes /dev/fd on a different st_dev.
  if ! exec 14< "$gate_lock_dir/owner"; then
    rmdir "$release_dir" 2>/dev/null || true
    gate_lock_dir=""
    return 0
  fi
  if ! recorded="$(
    gate_lock_current_user_authority_token_from_release_descriptor
  )" || [[ "$recorded" != "$gate_lock_token" ]]; then
    exec 14<&-
    rmdir "$release_dir" 2>/dev/null || true
    echo "error: the quality-gate owner changed or became unsafe before release; leaving it in place." >&2
    gate_lock_dir=""
    return 2
  fi
  # The unique private-directory basename also gives the in-lock take a name
  # no other releaser can own. Keep the record recovery-visible until its token
  # is validated. A SIGKILL before that check must not hide a live successor in
  # private state where the next waiter cannot find it.
  release_taken="${gate_lock_dir}/owner.reclaiming.release.${release_dir##*/}"
  release_owner="$release_dir/owner"
  gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_RELEASE_BEFORE_TAKE_DELAY_SECONDS:-}"
  if ! mv "$gate_lock_dir/owner" "$release_taken" 2>/dev/null; then
    exec 14<&-
    rmdir "$release_dir" 2>/dev/null || true
    gate_lock_dir=""
    return 0
  fi
  gate_lock_test_crash after-release-visible-take
  moved_owner_identity="$(gate_lock_current_user_authority_token_from_record "$release_taken")" ||
    moved_owner_identity=""
  moved_owner_matches=0
  gate_lock_path_matches_open_descriptor "$release_taken" 14 &&
    moved_owner_matches=1
  if [[ "$moved_owner_identity" != "$gate_lock_token" ||
    "$moved_owner_matches" -ne 1 ]]; then
    exec 14<&-
    if /bin/ln -P "$release_taken" "$gate_lock_dir/owner" 2>/dev/null; then
      if ! gate_lock_discard_matching_duplicate \
        "$release_taken" "$moved_owner_identity" "$gate_lock_dir/owner"; then
        echo "error: the displaced quality-gate owner changed before duplicate cleanup; retained ${release_taken}." >&2
        gate_lock_dir=""
        return 2
      fi
    elif gate_lock_condemn_and_discard "$release_taken"; then
      :
    else
      echo "error: could not restore or preserve the displaced quality-gate owner; retained ${release_taken}." >&2
      gate_lock_dir=""
      return 2
    fi
    rmdir "$release_dir" 2>/dev/null || true
    gate_lock_dir=""
    return 0
  fi
  if ! gate_lock_wait_for_test_barrier "$release_validated_test_barrier"; then
    exec 14<&-
    echo "error: the quality-gate release validation barrier failed; retained ${release_taken}." >&2
    gate_lock_dir=""
    return 2
  fi
  if ! mv "$release_taken" "$release_owner" 2>/dev/null; then
    exec 14<&-
    # Recovery can restore a live record while this process is descheduled.
    # Yield to the canonical owner if that happened. Otherwise retain the
    # in-lock remnant so the next waiter can recover it.
    rmdir "$release_dir" 2>/dev/null || true
    if [[ -e "$gate_lock_dir/owner" || -L "$gate_lock_dir/owner" ]]; then
      gate_lock_dir=""
      return 0
    fi
    echo "error: could not move the validated quality-gate owner into private release state; retained ${release_taken}." >&2
    gate_lock_dir=""
    return 2
  fi
  private_owner_identity="$(
    gate_lock_current_user_authority_token_from_record "$release_owner"
  )" || private_owner_identity=""
  private_owner_matches=0
  gate_lock_path_matches_open_descriptor "$release_owner" 14 &&
    private_owner_matches=1
  if [[ "$private_owner_identity" != "$gate_lock_token" ||
    "$private_owner_matches" -ne 1 ]]; then
    exec 14<&-
    if /bin/ln -P "$release_owner" "$gate_lock_dir/owner" 2>/dev/null; then
      echo "error: restored a replacement quality-gate owner after the private release move; retained ${release_owner}." >&2
    elif [[ -e "$gate_lock_dir/owner" || -L "$gate_lock_dir/owner" ]]; then
      echo "error: a successor owns the canonical quality-gate path; retained replacement evidence at ${release_owner}." >&2
    else
      echo "error: the private quality-gate owner changed during release; retained ${release_owner}." >&2
    fi
    gate_lock_dir=""
    return 2
  fi
  # A gate killed while it built or published an owner can leave a private
  # staging link in run.lock. These exact names never grant authority and no
  # reader consumes them. Remove them only after the canonical owner has been
  # taken and validated and their publishing PID is gone. A live handoff or
  # rollback still needs its stage, so it must block rmdir and make this
  # release restore or yield its owner.
  for inert_stage in \
    "$gate_lock_dir"/owner.claiming.* \
    "$gate_lock_dir"/owner.coordinator.* \
    "$gate_lock_dir"/owner.rollback.*; do
    inert_name="${inert_stage##*/}"
    [[ "$inert_name" =~ ^owner\.(claiming|coordinator|rollback)\.[1-9][0-9]*$ ]] || continue
    [[ -f "$inert_stage" && ! -L "$inert_stage" && -O "$inert_stage" ]] || continue
    inert_pid="${inert_name##*.}"
    if ! gate_lock_discard_inert_owner_stage "$inert_stage" "$inert_pid" \
      "Mapped work passed, but exact lock release did not complete."; then
      echo "error: could not remove stale quality-gate owner stage ${inert_stage}; restoring the owner." >&2
      break
    fi
  done

  # Bind the exact private owner before the release delay. A same-token inode
  # can replace the predictable `owner` path while this process is paused. The
  # quarantine anchor remains the original descriptor-bound inode. After the
  # delay, the quarantine take moves the current pathname into private state
  # and rejects it unless it is that same inode.
  if gate_lock_prepare_owner_quarantine "$release_owner" \
    "Mapped work passed, but exact lock release did not complete."; then
    :
  else
    release_prepare_status=$?
    exec 14<&-
    echo "error: could not witness the exact private quality-gate owner before release cleanup (status ${release_prepare_status}); retained ${release_dir}." >&2
    gate_lock_dir=""
    return 2
  fi
  if [[ "$gate_lock_quarantine_authority_value" != "$gate_lock_token" ]] ||
    ! gate_lock_path_matches_open_descriptor \
      "$gate_lock_quarantine_anchor" 14 ||
    [[ ! "$release_owner" -ef "$gate_lock_quarantine_anchor" ]]; then
    exec 14<&-
    gate_lock_retain_quarantine \
      "the private quality-gate owner witness does not match the released inode" || true
    gate_lock_dir=""
    return 2
  fi
  exec 14<&-

  gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_RELEASE_AFTER_TAKE_DELAY_SECONDS:-}"
  if ! gate_lock_wait_for_test_barrier "$release_private_test_barrier"; then
    gate_lock_retain_quarantine \
      "the private quality-gate owner release barrier failed" || true
    gate_lock_dir=""
    return 2
  fi
  if ! gate_lock_mark_quarantine_fallback; then
    gate_lock_dir=""
    return 2
  fi
  if gate_lock_take_prepared_quarantine; then
    :
  else
    release_take_status=$?
    [[ -z "$gate_lock_quarantine_dir" ]] ||
      gate_lock_retain_quarantine \
        "the private quality-gate owner changed before exact release cleanup" || true
    gate_lock_dir=""
    [[ "$release_take_status" -eq 1 ]] && return 2
    return "$release_take_status"
  fi

  if rmdir "$gate_lock_dir" 2>/dev/null; then
    if ! gate_lock_drop_private_quarantine; then
      gate_lock_dir=""
      return 2
    fi
    if ! rmdir "$release_dir" 2>/dev/null; then
      echo "error: private quality-gate release state changed after exact lock removal; retained ${release_dir}." >&2
      gate_lock_dir=""
      return 2
    fi
    if [[ "$gate_active_command_drain_in_progress" -eq 0 ]]; then
      if ! gate_darwin_lineage_retire_owner "$gate_lock_token"; then
        echo "error: the legacy lock was removed, but its Darwin owner lineage could not be retired." >&2
        gate_lock_dir=""
        return 2
      fi
    fi
    gate_lock_dir=""
    return 0
  fi
  if [[ -e "$gate_lock_dir/owner" || -L "$gate_lock_dir/owner" ]]; then
    # A successor published while this release held the old record. Its
    # canonical owner blocks rmdir, so only our private record is obsolete.
    if ! gate_lock_drop_private_quarantine; then
      gate_lock_dir=""
      return 2
    fi
  elif /bin/ln -P "$gate_lock_quarantine_anchor" \
    "$gate_lock_dir/owner" 2>/dev/null; then
    if ! restored_owner_identity="$(
      gate_lock_current_user_authority_token_from_record \
        "$gate_lock_dir/owner"
    )" || [[ "$restored_owner_identity" != "$gate_lock_token" ]] ||
      [[ ! "$gate_lock_dir/owner" -ef "$gate_lock_quarantine_anchor" ]]; then
      gate_lock_retain_quarantine \
        "the restored quality-gate owner does not match the exact release inode" || true
      gate_lock_dir=""
      return 2
    fi
    if ! gate_lock_drop_private_quarantine; then
      gate_lock_dir=""
      return 2
    fi
  elif [[ -e "$gate_lock_dir/owner" || -L "$gate_lock_dir/owner" ]]; then
    # A successor won the canonical path between the check and exclusive link.
    # Preserve it and discard only this run's private release record.
    if ! gate_lock_drop_private_quarantine; then
      gate_lock_dir=""
      return 2
    fi
  else
    gate_lock_retain_quarantine \
      "could not restore the exact quality-gate owner after lock release failed" || true
    gate_lock_dir=""
    return 2
  fi
  if ! rmdir "$release_dir" 2>/dev/null; then
    echo "error: private quality-gate release state changed during cleanup; retained ${release_dir}." >&2
    gate_lock_dir=""
    return 2
  fi
  gate_lock_dir=""
  return 0
}

gate_lock_refuse_owner_publication() {
  echo "error: could not publish a complete, validated legacy owner identity." >&2
  echo "Nothing has been executed." >&2
  gate_report_coordinated_no_work_failure 2 "legacy owner publication" \
    "No mapped command ran in this request"
  exit 2
}

acquire_gate_run_lock_legacy() {
  local root lock owner_pid owner_host owner_worktree owner_token_value owner_start
  local owner_machine owner_started_at machine_verdict record_age unverified_detail
  local stale_reason owner_state nap remaining now_millis
  local coordinator_join_status owner_record taken_record record_status
  local hidden_recovery_status hidden_recovery_busy
  local claim_uid claim_epoch claim_prefix claim_token claim_status
  # Elapsed time comes from the clock, never from adding up requested sleeps.
  # A shell that is descheduled or SIGSTOPped sleeps far longer than it asked
  # to, and counting the request would let a run outlive the budget it printed
  # while reporting a smaller number than it actually took. Read in
  # milliseconds and reported in whole seconds: measuring in whole seconds
  # instead charges the wait up to a second it never spent.
  local waited=0
  local wait_started_at
  local last_beat=0
  local announced=0
  local ownerless_since=""
  local unverified_warned=0
  local nonlocal_root_warned=0
  # Why THIS pass refused to act on the record it is looking at now, or empty.
  # Re-decided every pass, unlike the warned flag beside it: that one is sticky
  # because its job is to say the thing once, and this one feeds the timeout
  # diagnosis, which has to describe the lock as it stands when the budget runs
  # out. A refusal early in the wait says nothing about a record published
  # afterwards — a stalled creator can leave the lock ownerless past the grace,
  # be refused, and then publish a perfectly live record — and a sticky flag
  # would answer for that live holder with "remove it by hand".
  local nonlocal_refusal_reason=""
  local this_host this_machine
  case "$gate_lock_enabled" in
    0|false|no) return 0 ;;
  esac
  if [[ -n "${AGENT_QUALITY_GATE_LOCK_HELD:-}" ]]; then
    # A gate running inside a gate — the self-test drives the gate against
    # fixture repos — already holds this machine's lock through its parent.
    # Waiting for our own ancestor would deadlock.
    return 0
  fi
  if ! root="$(resolve_gate_lock_root)"; then
    # Defence in depth rather than a reachable state today: the last candidate
    # is the repo scratch directory, and a run whose scratch directory is
    # unwritable has already failed before reaching this. It is written to fail
    # closed anyway, because running on would silently give an ordinary `--run`
    # the semantics of the explicit escape hatch, which is how the port
    # conflicts and mutual starvation this lock exists for come back. Exclusion
    # is the default, so losing it is the caller's decision to make out loud.
    echo "error: no writable lock directory, so this run cannot take the gate run lock." >&2
    echo "Set AGENT_QUALITY_GATE_LOCK_DIR to a writable path, or re-run with --no-lock to accept the contention." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "startup" \
      "No mapped command ran in this request"
    exit 2
  fi
  lock="$root/run.lock"
  owner_record="$lock/owner"
  gate_lock_root_dir="$root"
  if ! gate_lock_ensure_local_host_fingerprint; then
    echo "error: could not derive the local host identity for safe owner quarantine recovery." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
      "No mapped command ran in this request"
    exit 2
  fi
  this_host="$gate_lock_local_host_name"
  if ! claim_uid="$(id -u 2>/dev/null)" ||
    [[ ! "$claim_uid" =~ ^[0-9]+$ ]]; then
    echo "error: could not derive the current user identity for safe legacy owner publication." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "legacy owner publication" \
      "No mapped command ran in this request"
    exit 2
  fi
  if ! claim_epoch="$(date +%s 2>/dev/null)" ||
    [[ ! "$claim_epoch" =~ ^[0-9]{1,12}$ ]]; then
    echo "error: could not derive a safe legacy owner claim token." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "legacy owner publication" \
      "No mapped command ran in this request"
    exit 2
  fi
  if ! claim_prefix="$(
    gate_run_marker_identity_prefix \
      "$this_host" "legacy" "$gate_lock_local_host_fingerprint" "$$"
  )"; then
    echo "error: could not derive a safe legacy owner claim token." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "legacy owner publication" \
      "No mapped command ran in this request"
    exit 2
  fi
  printf -v claim_token '%s-%s-%s' "$claim_prefix" "$$" "$claim_epoch"
  if ! gate_lock_token_is_wellformed "$claim_token"; then
    echo "error: could not derive a safe legacy owner claim token." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "legacy owner publication" \
      "No mapped command ran in this request"
    exit 2
  fi
  gate_lock_resolve_machine_id
  this_machine="$gate_lock_machine_id_cached"
  # Prepare the native runtime before a claim creates an ownerless run.lock.
  # The later state snapshot is then short and remains before owner publication.
  if ! gate_darwin_exact_identity_prepare; then
    echo "error: could not prepare Darwin owner-lineage authority before legacy lock publication." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "legacy owner publication" \
      "No mapped command ran in this request"
    exit 2
  fi
  # Two questions about the root, answered from different evidence.
  #
  # Is the storage under it this machine's own? Every reason a record can look
  # reclaimable is read through this kernel and this client, so nothing on this
  # root is safe to take away without it, and the filesystem is what answers —
  # for the root an operator named as much as for the one the gate chose,
  # because the question is about the storage rather than about who picked the
  # path. Unanswerable means "may be shared", the direction that keeps waiting.
  # `df -l` narrows the answer without proving it: it says the storage is not
  # mounted FROM elsewhere, not that nothing else reaches it. A machine can
  # export its own disk, and a host bind mount or Docker volume reads local
  # inside every container sharing it. Those are deliberate acts of sharing,
  # and the declaration below is how they are told; nothing readable from here
  # can detect them.
  #
  # Is the root established as this machine's alone? That is strictly stronger,
  # and it is what the unverified-record rule below needs, because that rule
  # reclaims a record it cannot attribute at all. An
  # AGENT_QUALITY_GATE_LOCK_DIR cannot earn it from the filesystem: a machine
  # can export its own local disk, and resolve_gate_lock_root treats the
  # override as a coordination contract precisely because it can name a
  # directory more than one machine reaches. So an override stays
  # possibly-shared until its owner says otherwise.
  #
  # The declaration answers both, since "only this machine reaches it" implies
  # "this machine mounts the storage".
  if [[ -n "$gate_lock_root_per_machine_override" ]]; then
    gate_lock_root_is_local_storage="$gate_lock_root_per_machine_override"
  elif gate_lock_path_is_local_filesystem "$root"; then
    gate_lock_root_is_local_storage=1
  else
    gate_lock_root_is_local_storage=0
  fi
  if [[ -n "$gate_lock_root_per_machine_override" ]]; then
    gate_lock_root_is_per_machine="$gate_lock_root_per_machine_override"
  elif [[ -n "${AGENT_QUALITY_GATE_LOCK_DIR:-}" ]]; then
    gate_lock_root_is_per_machine=0
  else
    gate_lock_root_is_per_machine="$gate_lock_root_is_local_storage"
  fi
  wait_started_at="$(gate_wall_millis)"

  while :; do
    hidden_recovery_busy=0
    # A coordinator can finish adopting the legacy owner while this waiter is
    # in the legacy loop. Probe before each claim attempt so a new client joins
    # it instead of waiting for its intentionally long-lived compatibility
    # lock. Legacy-only runs never define this function.
    if declare -F gate_coordinator_try_join_existing >/dev/null 2>&1; then
      if gate_coordinator_try_join_existing; then
        return 0
      else
        coordinator_join_status=$?
        [[ "$coordinator_join_status" -eq 1 ]] || return "$coordinator_join_status"
      fi
    fi
    now_millis="$(gate_wall_millis)"
    # A clock stepped backwards mid-wait — this is a wall clock, and NTP steps
    # it — would otherwise make every later delta smaller than the budget, so
    # the wait would outlive the budget it announced. Re-anchoring costs the
    # step's worth of waiting and keeps the budget reachable; clamping the
    # delta to zero would only tidy the number printed.
    [[ "$now_millis" -ge "$wait_started_at" ]] || wait_started_at="$now_millis"
    waited=$(((now_millis - wait_started_at) / 1000))
    if mkdir "$lock" 2>/dev/null; then
      gate_lock_test_crash after-mkdir
      gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_CLAIM_DELAY_SECONDS:-}"
      if claim_gate_run_lock "$lock" "$claim_token" "$claim_uid"; then
        if [[ "$announced" -eq 1 ]]; then
          echo "Acquired the gate run lock after ${waited}s."
          echo
        fi
        return 0
      else
        claim_status=$?
        [[ "$claim_status" -ne 2 ]] || gate_lock_refuse_owner_publication
      fi
      # We created the directory but never recorded ownership: a waiter
      # reclaimed it while this process was descheduled, and it is that run's
      # lock now. Touch nothing and queue like any other waiter.
      echo "Another run recorded ownership of ${lock} first; queueing behind it." >&2
    fi

    gate_lock_require_safe_existing_owner_record "$owner_record"
    owner_pid="$(gate_lock_owner_field "$lock" pid)"
    owner_host="$(gate_lock_owner_field "$lock" host)"
    owner_machine="$(gate_lock_owner_field "$lock" machine)"
    owner_worktree="$(gate_lock_owner_field "$lock" worktree)"
    owner_token_value="$(gate_lock_owner_field "$lock" token)"
    owner_start="$(gate_lock_owner_field "$lock" start_utc)"
    owner_started_at="$(gate_lock_owner_field "$lock" started_at)"
    gate_lock_require_safe_existing_owner_record "$owner_record"
    if [[ -z "$owner_token_value" ]]; then
      # Before believing there is no holder, read the remnants of any reclaim
      # that was killed mid-take. One of them may be the holder's own record.
      if gate_lock_recover_hidden_record "$lock" "$this_host"; then
        gate_lock_require_safe_existing_owner_record "$owner_record"
        owner_pid="$(gate_lock_owner_field "$lock" pid)"
        owner_host="$(gate_lock_owner_field "$lock" host)"
        owner_machine="$(gate_lock_owner_field "$lock" machine)"
        owner_worktree="$(gate_lock_owner_field "$lock" worktree)"
        owner_token_value="$(gate_lock_owner_field "$lock" token)"
        owner_start="$(gate_lock_owner_field "$lock" start_utc)"
        owner_started_at="$(gate_lock_owner_field "$lock" started_at)"
        gate_lock_require_safe_existing_owner_record "$owner_record"
      else
        hidden_recovery_status=$?
        if [[ "$hidden_recovery_status" -eq 4 ]]; then
          hidden_recovery_busy=1
          owner_pid="${gate_lock_active_quarantine_pid:-unknown}"
          owner_host="${gate_lock_active_quarantine_host:-$this_host}"
          owner_worktree="owner cleanup"
        fi
      fi
    fi
    machine_verdict="$(
      gate_lock_machine_verdict \
        "$owner_machine" "$owner_host" "$this_machine" "$this_host" \
        "$gate_lock_root_is_per_machine"
    )"

    stale_reason=""
    nonlocal_refusal_reason=""
    [[ -n "$owner_token_value" ]] && ownerless_since=""
    if [[ -z "$owner_token_value" && "$hidden_recovery_busy" -eq 1 ]]; then
      ownerless_since=""
    elif [[ -z "$owner_token_value" ]]; then
      # No complete record: either no file at all, or one a run was killed
      # part-way through writing. The token is written last, so its absence
      # means the write never finished and nothing in the file can be trusted
      # — not even the PID, which may itself be a truncated value. Timed from
      # our own first sighting rather than a filesystem timestamp, because the
      # holder is exactly the process that has not published a record yet.
      [[ -n "$ownerless_since" ]] || ownerless_since="$(date +%s)"
      if [[ $(($(date +%s) - ownerless_since)) -ge "$gate_lock_owner_grace_seconds" ]]; then
        stale_reason="its holder never recorded a complete identity"
      fi
    elif [[ "$machine_verdict" == other ]]; then
      # Two machine identities from the same source that disagree, on a root
      # this run could not prove local. There is no evidence available here
      # that could overturn it — another machine's PIDs mean nothing locally —
      # so this record is waited out however old it gets, and the wait expiry
      # names the holder.
      :
    elif ! gate_lock_token_is_wellformed "$owner_token_value"; then
      # A token this gate would never generate. Reclaiming would later drain
      # by that token — matching processes with a value another writer chose
      # — so the holder is assumed live and waited out; the timeout fails
      # closed with the holder line naming the record.
      :
    elif [[ "$machine_verdict" == unverified ]]; then
      # An unverified record does not authorize a local PID lookup on storage
      # that may be shared. On per-machine storage, age must pass first. Only
      # then can a dead local PID complete the reclaim verdict.
      record_age="$(gate_lock_record_age_seconds "$owner_started_at")"
      unverified_detail="it records host '${owner_host:-unknown}' machine '${owner_machine:-none}', and this run is host '${this_host}' machine '${this_machine:-none}'"
      if [[ "$gate_lock_root_is_per_machine" -ne 1 ]]; then
        if [[ "$unverified_warned" -eq 0 ]]; then
          unverified_warned=1
          echo "warning: the gate run lock record at ${lock} cannot be tied to this machine: ${unverified_detail}." >&2
          echo "  This lock root is not established as storage only this machine reaches, so it may be shared and that record may belong to a live run elsewhere. Its PID is not read locally. This run waits it out." >&2
          echo "  If that directory is this machine's alone, set AGENT_QUALITY_GATE_LOCK_DIR_IS_PER_MACHINE=1 to let an aged dead holder in it be reclaimed." >&2
        fi
        # This pass deliberately did not read the record's PID in the local
        # namespace. Keep that refusal as the timeout diagnosis so the fallback
        # does not claim that an unverified holder was seen alive.
        nonlocal_refusal_reason="its record cannot be tied to this machine, so its PID was not used as local liveness evidence"
      elif [[ -n "$record_age" &&
        "$record_age" -ge "$gate_lock_unverified_machine_grace_seconds" ]] &&
        ! gate_lock_holder_is_live "$owner_pid" "$owner_start"; then
        owner_state="$(gate_lock_process_state "$owner_pid")"
        if [[ "$owner_state" == Z* ]]; then
          stale_reason="holder pid ${owner_pid} has exited and is awaiting reap"
        elif kill -0 "$owner_pid" 2>/dev/null; then
          stale_reason="pid ${owner_pid} now belongs to a different process"
        else
          stale_reason="holder pid ${owner_pid} is gone"
        fi
        if [[ "$unverified_warned" -eq 0 ]]; then
          unverified_warned=1
          echo "warning: the gate run lock record at ${lock} cannot be tied to this machine: ${unverified_detail}." >&2
          echo "  This lock root is on storage this machine mounts itself, its ${stale_reason}, and it was written ${record_age}s ago (grace ${gate_lock_unverified_machine_grace_seconds}s), so this run reads it as this machine's own under a name or identity it has since changed, and reclaims it." >&2
          echo "  If this directory is exported to other machines, set AGENT_QUALITY_GATE_LOCK_DIR_IS_PER_MACHINE=0 to refuse this reclaim." >&2
        fi
        stale_reason="${stale_reason}; its record cannot be tied to this machine and is ${record_age}s old on per-machine storage"
      fi
    elif ! gate_lock_holder_is_live "$owner_pid" "$owner_start"; then
      owner_state="$(gate_lock_process_state "$owner_pid")"
      if [[ "$owner_state" == Z* ]]; then
        stale_reason="holder pid ${owner_pid} has exited and is awaiting reap"
      elif kill -0 "$owner_pid" 2>/dev/null; then
        stale_reason="pid ${owner_pid} now belongs to a different process"
      else
        stale_reason="holder pid ${owner_pid} is gone"
      fi
    fi

    # The last word on every reclaim above, and the one that does not depend on
    # reading the record right. Each of those reasons is evidence gathered
    # locally — a PID looked up in this kernel, a record this client cannot see
    # — and each is worth only as much as the claim that the record was written
    # here. That claim rests on the record's own machine identity and hostname,
    # and both can be cloned: two containers built from one image carry the
    # same `/etc/machine-id` and the same hostname, so on a root they share
    # each reads the other's record as its own, finds the holder's PID absent
    # from its own PID namespace, and reclaims a lock whose holder is running
    # next door — the overlap the lock exists to prevent (GitHub issue #2061).
    # Nothing available locally tells those two apart, so the reclaim is
    # refused wherever the storage is not this machine's own, and the run waits
    # out its lock budget instead. Refusing the reclaim rather than the lock is
    # deliberate: waiting is still correct on a shared root, and a run that
    # simply queued is a run that still validated.
    #
    # This covers the record with no holder at all as well. A network client's
    # view of a directory is cached, so "no complete record here" is as local a
    # reading as a PID lookup: NFS attribute caching can hide a freshly written
    # owner file from another client for longer than the grace that authorises
    # taking it.
    if [[ -n "$stale_reason" && "$gate_lock_root_is_local_storage" -ne 1 ]]; then
      if [[ "$nonlocal_root_warned" -eq 0 ]]; then
        nonlocal_root_warned=1
        echo "warning: the gate run lock at ${lock} looks reclaimable (${stale_reason}), and this run refuses to reclaim it." >&2
        echo "  Its root ${root} is not established as storage only this machine reaches, and on a shared root that evidence proves nothing: a machine identity and a hostname can both be cloned — two containers built from one image carry the same values — so a holder alive on another machine reads as a dead PID here. Self-healing is disabled on such a root; this run waits out its lock budget instead." >&2
        echo "  Give each machine its own AGENT_QUALITY_GATE_LOCK_DIR on that machine's local storage. If this root really is this machine's alone, declare it with AGENT_QUALITY_GATE_LOCK_DIR_IS_PER_MACHINE=1." >&2
      fi
      nonlocal_refusal_reason="$stale_reason"
      stale_reason=""
    fi

    if [[ -n "$stale_reason" ]]; then
      gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_RECLAIM_DELAY_SECONDS:-}"
      # The verdict above was formed before the delay; re-settle the remnants
      # right here, because a record in flight under a remnant means an empty
      # canonical path is not evidence that the lock is free. If that restores
      # a live holder, this verdict is void and we go back to waiting.
      gate_lock_require_safe_existing_owner_record "$owner_record"
      hidden_recovery_status=1
      if gate_lock_recover_hidden_record "$lock" "$this_host"; then
        hidden_recovery_status=0
        gate_lock_require_safe_existing_owner_record "$owner_record"
        owner_pid="$(gate_lock_owner_field "$lock" pid)"
        owner_host="$(gate_lock_owner_field "$lock" host)"
        owner_worktree="$(gate_lock_owner_field "$lock" worktree)"
      else
        hidden_recovery_status=$?
        if [[ "$hidden_recovery_status" -eq 4 ]]; then
          owner_pid="${gate_lock_active_quarantine_pid:-unknown}"
          owner_host="${gate_lock_active_quarantine_host:-$this_host}"
          owner_worktree="owner cleanup"
        fi
      fi
      if [[ "$hidden_recovery_status" -eq 4 ]]; then
        :
      elif [[ "$hidden_recovery_status" -eq 0 ]]; then
        :
      elif [[ ! -e "$owner_record" && ! -L "$owner_record" ]]; then
        # Nothing in the way: publishing the record is the whole contest.
        # Whoever links it into place first holds the lock; everyone else,
        # including the creator that stalled, finds their publish refused.
        if claim_gate_run_lock "$lock" "$claim_token" "$claim_uid"; then
          echo "Gate run lock at ${lock} is stale (${stale_reason}); reclaiming it." >&2
          if [[ "$announced" -eq 1 ]]; then
            echo "Acquired the gate run lock after ${waited}s."
            echo
          fi
          return 0
        else
          claim_status=$?
          [[ "$claim_status" -ne 2 ]] || gate_lock_refuse_owner_publication
        fi
      else
        # Something is in the way: a dead holder's record, or one a killed run
        # left half-written. Either has to be taken away by rename before a
        # claim can publish, because `ln` refuses an occupied path. rename(2)
        # is atomic and the source vanishes with it, so exactly one waiter can
        # win a given record and everyone arriving later fails with ENOENT —
        # no waiter can act on a verdict another has already acted on.
        # Registered with the exit trap before it exists: the path carries our
        # PID, so cleanup can never race the rename, nor name another run.
        gate_lock_reclaim_origin="$lock/owner"
        gate_lock_reclaim_tmp="${lock}/owner.reclaiming.$$"
        gate_lock_require_safe_existing_owner_record "$owner_record"
        if [[ -e "$owner_record" || -L "$owner_record" ]] &&
          [[ ! -O "$owner_record" ]]; then
          gate_lock_reclaim_tmp=""
          gate_lock_reclaim_origin=""
          gate_lock_refuse_foreign_owner_recovery "$owner_record"
        fi
        if mv "$owner_record" "$gate_lock_reclaim_tmp" 2>/dev/null; then
          gate_lock_test_crash after-take
          if ! gate_lock_wait_for_test_barrier "$lock_taken_test_barrier"; then
            restore_gate_lock_record || true
            gate_report_coordinated_no_work_failure 2 \
              "legacy owner recovery" \
              "No mapped command ran in this request"
            exit 2
          fi
          gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_TAKEN_DELAY_SECONDS:-}"
          taken_record="$gate_lock_reclaim_tmp"
          if [[ ! -e "$taken_record" && ! -L "$taken_record" ]]; then
            gate_lock_reclaim_tmp=""
            gate_lock_reclaim_origin=""
          elif ! gate_lock_record_is_readable_regular "$taken_record"; then
            gate_lock_reclaim_tmp=""
            gate_lock_reclaim_origin=""
            gate_lock_refuse_unsafe_owner_record "$taken_record"
          elif gate_lock_record_still_stale \
            "$taken_record" "$owner_pid" "$owner_token_value" "$owner_start" \
            "$owner_host" "$owner_machine" "$owner_started_at"; then
            echo "Gate run lock at ${lock} is stale (${stale_reason}); reclaiming it." >&2
            # The holder is gone, but a gate killed mid-command leaves that
            # command running. Write down whose it was — on disk, before taking
            # over, so the obligation survives this process — and confirm they
            # are gone just before this run's own commands. Not here: draining
            # between judging the record and publishing would hand another
            # waiter the same verdict and the same window to act on it.
            # Nothing below this line is reversible: the record is deleted and
            # this run publishes its own. So the obligation is written first,
            # and a write that fails puts the record back and stops the run
            # rather than taking over with no successor for those commands.
            if gate_lock_condemn_and_discard "$taken_record"; then
              :
            else
              record_status=$?
              restore_gate_lock_record || true
              [[ "$record_status" -ne 1 ]] || gate_lock_obligation_unwritable
              gate_report_coordinated_no_work_failure 2 \
                "legacy owner recovery" \
                "No mapped command ran in this request"
              exit 2
            fi
            gate_lock_reclaim_tmp=""
            gate_lock_reclaim_origin=""
            if claim_gate_run_lock "$lock" "$claim_token" "$claim_uid"; then
              if [[ "$announced" -eq 1 ]]; then
                echo "Acquired the gate run lock after ${waited}s."
                echo
              fi
              return 0
            else
              claim_status=$?
              [[ "$claim_status" -ne 2 ]] || gate_lock_refuse_owner_publication
            fi
          else
            record_status=$?
            if [[ "$record_status" -eq 2 ]]; then
              gate_lock_reclaim_tmp=""
              gate_lock_reclaim_origin=""
              gate_lock_refuse_unsafe_owner_record "$taken_record"
            elif [[ "$record_status" -eq 3 ]]; then
              gate_lock_reclaim_tmp=""
              gate_lock_reclaim_origin=""
            else
              # We took a record that is not the one we judged — another run
              # reclaimed the lock while we decided. Put it back and wait. If
              # it could not be put back or written down it stays where it is,
              # named in the output, for the next hidden-record recovery.
              restore_gate_lock_record || true
            fi
          fi
        fi
        gate_lock_reclaim_tmp=""
        gate_lock_reclaim_origin=""
      fi
      # Whatever happened above, the holder of record may have changed.
      owner_pid="$(gate_lock_owner_field "$lock" pid)"
      owner_host="$(gate_lock_owner_field "$lock" host)"
      owner_worktree="$(gate_lock_owner_field "$lock" worktree)"
    fi

    if [[ "$announced" -eq 0 ]]; then
      echo
      echo "Waiting for the agent quality gate run lock: ${lock}"
      echo "  held by pid ${owner_pid:-unknown} on ${owner_host:-unknown} in ${owner_worktree:-unknown}"
      echo "  one gate run executes mapped commands at a time so runs cannot starve each other (GitHub issue #1802)."
      echo "  waiting up to ${gate_lock_wait_seconds}s; interrupt to abort, or re-run with --no-lock."
      announced=1
    elif [[ $((waited - last_beat)) -ge 30 ]]; then
      echo "  … still waiting after ${waited}s (holder pid ${owner_pid:-unknown})."
      last_beat="$waited"
    fi

    if [[ "$waited" -ge "$gate_lock_wait_seconds" ]]; then
      echo "error: timed out after ${waited}s waiting for the gate run lock at ${lock}." >&2
      if [[ -n "$nonlocal_refusal_reason" ]]; then
        # This wait ended on a record this run refused to act on, not on a
        # holder it saw running. Repeating the line below would send the
        # operator to wait for a process this pass already read as gone, and
        # that wait never ends. The refusal names the lock's state rather than
        # its holder, because the state it covers includes a lock with no
        # holder recorded at all.
        echo "Nothing was reclaimed: this run refused to act on the lock (${nonlocal_refusal_reason}), because its root is not established as storage only this machine reaches." >&2
        # Deliberately not "delete it and move on". Removing the directory
        # removes the record, and the record's token is the handle the next run
        # would have used to find and stop the dead holder's mapped commands —
        # which outlive their gate shell. So a delete on a still-running holder
        # both starts this run beside that work and throws away the only way to
        # notice. Name the checks, and point at the note that owns them.
        echo "Clearing it by hand is not a plain delete: on the machine that wrote the record, confirm its holder pid is gone AND that its mapped commands are gone with it — they carry the tag agentqg:<the record's token> — because deleting the record discards that token and the next run then starts beside whatever it named." >&2
        echo "docs/notes/agent-quality-gate-mechanics.md has the full procedure. Then give each machine its own AGENT_QUALITY_GATE_LOCK_DIR on that machine's local storage, or declare this root with AGENT_QUALITY_GATE_LOCK_DIR_IS_PER_MACHINE=1." >&2
      else
        echo "Holder pid ${owner_pid:-unknown} is still alive; let it finish, then retry." >&2
      fi
      echo "Running the gate directly? --no-lock starts anyway and accepts the contention." >&2
      # The pre-push hook passes a fixed command line and Trunk strips the
      # environment, so neither escape hatch is reachable from a failed push.
      echo "Pushing? Warm the stamps with 'pnpm agent:quality-gate --run' first, then push: --skip-if-fresh cache-hits and exits before this lock." >&2
      # GitHub issue #1894. Every other outcome states itself on stdout — a green
      # run ends "All mapped commands passed." — but this one used to speak on
      # stderr alone, so a caller reading the gate's stdout saw the reassuring
      # "waiting up to Ns" banner and then nothing. Pair that with a pipeline,
      # whose status is the READER's unless the caller set `pipefail`, and a run
      # that executed nothing reads as a pass on both signals at once. So the
      # verdict goes to stdout too, and names the status a pipeline hides.
      # SIGPIPE is ignored and the writes are optional because they come after
      # the stderr diagnosis and must never displace it: a stdout that closes
      # while this verdict is being written costs the caller the stdout copy,
      # never the stderr copy and never the exit status. A reader that closed
      # earlier still kills the run on the wait banner above, which is a
      # SIGPIPE death — non-zero, so still not a pass, which is the invariant
      # this path owes its caller.
      trap '' PIPE
      echo "Gate run lock wait expired after ${waited}s. No mapped command ran; this gate exits 2." 2>/dev/null || true
      echo "Piped? A pipeline reports the reader's status: read \${PIPESTATUS[0]} or set -o pipefail." 2>/dev/null || true
      exit 2
    fi
    # Never sleep past the budget: with a wait shorter than — or not divisible
    # by — the poll interval, a full-interval sleep would overshoot and then
    # report the overshoot as the elapsed time. Capping keeps `--lock-wait 1`
    # honest at one second, and leaves ordinary waits at a full interval.
    nap="$gate_lock_poll_seconds"
    remaining=$((gate_lock_wait_seconds - waited))
    [[ "$nap" -le "$remaining" ]] || nap="$remaining"
    [[ "$nap" -ge 1 ]] || nap=1
    sleep "$nap"
  done
}

gate_coordinator_requested() {
  case "$gate_coordinator_enabled" in
    1|true|yes) ;;
    *) return 1 ;;
  esac
  case "$gate_lock_enabled" in
    0|false|no) return 1 ;;
  esac
  [[ -z "${AGENT_QUALITY_GATE_LOCK_HELD:-}" ]]
}

gate_run_ensure_token() {
  local token_prefix
  if [[ -z "$gate_run_id" ]]; then
    if [[ -z "$gate_lock_local_host_name" ]] &&
      ! gate_lock_ensure_local_host_fingerprint; then
      echo "error: this gate could not create a safe scheduler drain token." >&2
      return 2
    fi
    if ! token_prefix="$(
      gate_run_marker_identity_prefix \
        "$gate_lock_local_host_name" "request" \
        "$gate_lock_local_host_fingerprint" "$$"
    )"; then
      echo "error: this gate could not create a safe scheduler drain token." >&2
      return 2
    fi
    gate_run_id="${token_prefix}-$$-$(date +%s)"
  fi
  if ! gate_lock_token_is_wellformed "$gate_run_id"; then
    echo "error: this gate could not create a safe scheduler drain token." >&2
    return 2
  fi
}

prepare_uncoordinated_run_handles() {
  local handle_root="${scratch_dir}/no-lock-handles"
  case "$gate_lock_enabled" in
    0 | false | no) ;;
    *)
      [[ -n "${AGENT_QUALITY_GATE_LOCK_HELD:-}" ]] || return 0
      ;;
  esac

  # An explicit no-lock run has no legacy or coordinator root. A nested gate
  # reuses its ancestor's exclusion but must not reuse the ancestor's token.
  # Both still need an inherited marker and an independent Darwin lineage for
  # their own mapped-command cleanup. Keep those handles in a private
  # repo-local directory. This also prevents an unusable configured lock root
  # from disabling the explicit escape hatch.
  if [[ ! -e "$handle_root" && ! -L "$handle_root" ]]; then
    (umask 077 && mkdir "$handle_root") 2>/dev/null || true
  fi
  if ! gate_run_private_marker_directory_is_safe "$handle_root"; then
    echo "error: could not prepare the private uncoordinated handle directory at ${handle_root}." >&2
    return 2
  fi
  gate_lock_root_dir="$handle_root"
  gate_run_ensure_token
}

acquire_gate_run_lock() {
  local coordinator_join_status
  if ! gate_coordinator_requested; then
    acquire_gate_run_lock_legacy
    return
  fi

  if ! gate_lock_ensure_local_host_fingerprint; then
    echo "error: could not derive the local host identity for safe coordinator marker recovery." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "coordinator startup" \
      "No mapped command ran in this request"
    return 2
  fi
  gate_run_ensure_token || return 2
  if gate_coordinator_try_join_existing; then
    return 0
  else
    coordinator_join_status=$?
    [[ "$coordinator_join_status" -eq 1 ]] || return "$coordinator_join_status"
  fi

  acquire_gate_run_lock_legacy
  # The legacy wait loop probes again on every pass. Another gate can finish
  # coordinator startup while this request waits, in which case that probe has
  # already registered this request and no second bootstrap is permitted.
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active; then
    return 0
  fi
  if ! gate_coordinator_bootstrap_from_legacy; then
    echo "error: the quality-gate coordinator could not adopt the legacy run lock." >&2
    echo "No mapped command ran. Re-run after the current coordinator or legacy holder exits." >&2
    return 2
  fi
}

assert_gate_run_lock_still_ours() {
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active; then
    gate_coordinator_assert_authority
    return
  fi
  assert_gate_run_lock_still_ours_legacy
}

release_gate_run_lock() {
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active; then
    # The coordinator retains and releases the legacy lock after all requests,
    # leases, and drain obligations settle. A client must never delete it.
    gate_lock_dir=""
    return 0
  fi
  if [[ "$gate_cleanup_preserve_legacy_lock" -eq 1 ]]; then
    return 0
  fi
  release_gate_run_lock_legacy
}

cleanup_tmpfiles() {
  local original_status=$?
  local teardown_status=0
  local marker_status=0
  local release_status=0
  teardown_active_timeouts || teardown_status=$?
  if [[ "$darwin_broker_preflight_bound" -eq 1 ]]; then
    exec 24<&- 2>/dev/null || true
    darwin_broker_preflight_bound=0
  fi
  if [[ ${#tmpfiles[@]} -gt 0 ]]; then
    rm -f "${tmpfiles[@]+"${tmpfiles[@]}"}"
  fi
  # A reclaim in flight is milliseconds long, but a signal can still land in
  # it. The temp path is registered before the rename that creates it, so this
  # sees it whether or not it exists — and it restores rather than deletes,
  # because a record taken but not yet judged may still name a live holder.
  # A restore that could not write the obligation down has already reported it
  # and kept the record; teardown continues either way, because skipping the
  # release below would leave the lock behind.
  restore_gate_lock_record || true
  # A half-built claim record is private to this process and was never linked
  # into place, so it is simply dropped.
  if [[ -n "$gate_lock_claim_tmp" ]]; then
    rm -f "$gate_lock_claim_tmp"
    gate_lock_claim_tmp=""
  fi
  # Same for a staged obligation: it was never published, and the record it
  # was derived from is still where it was, so nothing is lost by dropping it.
  if [[ -n "$gate_lock_condemn_tmp" ]]; then
    rm -f "$gate_lock_condemn_tmp"
    gate_lock_condemn_tmp=""
  fi
  if declare -F gate_coordinator_cleanup >/dev/null 2>&1; then
    gate_coordinator_cleanup || true
  fi
  # Dropped after the workers are down, so it is gone only once nothing of ours
  # is left holding it. A run that dies before this leaves it behind on
  # purpose: that is the handle its successor needs.
  if [[ -n "$gate_run_marker_file" &&
    "$gate_active_command_drain_in_progress" -eq 0 ]]; then
    if gate_run_discard_marker_exact \
      "${gate_run_id:-$gate_lock_token}" \
      "This gate stopped, but its run-marker cleanup failed."; then
      gate_run_marker_file=""
    else
      marker_status=$?
    fi
  fi
  # Released last: the lock must outlive worker teardown, or the next run
  # starts while this one's mapped commands are still dying.
  if release_gate_run_lock; then
    release_status=0
  else
    release_status=$?
  fi
  if [[ "$original_status" -eq 0 ]] && {
    [[ "$teardown_status" -ne 0 ]] ||
      [[ "$marker_status" -ne 0 ]] || [[ "$release_status" -ne 0 ]]
  }; then
    trap - EXIT
    exit 2
  fi
}
trap cleanup_tmpfiles EXIT

on_terminating_signal() {
  local signal="$1"
  local teardown_status=0
  if [[ "$worker_registration_in_progress" -eq 1 ||
    "$worker_settlement_in_progress" -eq 1 ]]; then
    [[ -n "$pending_terminating_signal" ]] ||
      pending_terminating_signal="$signal"
    return 0
  fi
  trap '' INT TERM
  teardown_active_timeouts || teardown_status=$?
  if [[ "$teardown_status" -ne 0 ]]; then
    echo "error: active process teardown returned ${teardown_status}; forwarding ${signal} after the no-lock fallback and durable recovery handling." >&2
  fi
  trap - "$signal"
  kill "-${signal}" "$$" 2>/dev/null || exit 143
}

finish_worker_registration() {
  local signal
  worker_registration_in_progress=0
  if [[ -n "$pending_terminating_signal" ]]; then
    signal="$pending_terminating_signal"
    pending_terminating_signal=""
    on_terminating_signal "$signal"
  fi
}

finish_worker_settlement() {
  local signal
  worker_settlement_in_progress=0
  if [[ -n "$pending_terminating_signal" ]]; then
    signal="$pending_terminating_signal"
    pending_terminating_signal=""
    on_terminating_signal "$signal"
  fi
}

trap 'on_terminating_signal INT' INT
trap 'on_terminating_signal TERM' TERM

make_tmpfile() {
  local tmpfile
  tmpfile="$(mktemp "$scratch_dir/agentqg.XXXXXX")"
  tmpfiles+=("$tmpfile")
  echo "$tmpfile"
}

changed_paths_file="$(make_tmpfile)"

if [[ -n "$changed_paths_input_file" ]]; then
  if [[ ! -r "$changed_paths_input_file" ]]; then
    echo "error: changed paths file not found: ${changed_paths_input_file}" >&2
    exit 2
  fi
fi
if ! collect_current_changed_paths |
  sed '/^$/d' | LC_ALL=C sort -u > "$changed_paths_file"; then
  echo "error: failed to collect the current changed paths." >&2
  exit 2
fi

if [[ ! -s "$changed_paths_file" ]]; then
  echo "No changed paths detected against ${base_ref}...${head_ref}."
  exit 0
fi

# The routing-sensitive classifier's own preflight. The mapping engine reads
# this module too, and decides the `--check-fixtures` command from it; what runs
# here is the contract check, ahead of the engine, so a stale path or a
# classifier that stopped exporting `isRoutingSensitivePath` is named by module
# rather than reported as `gate mapping engine failed (exit 3)`.
#
# Routing classification runs from the gate's own source tree, not the repo
# under test, so a `scripts/` move must repoint this literal in the same commit.
# Nothing in CI runs the gate for real; the gate self-test is what exercises this
# import there, and a developer's pre-push is where a stale path bites first.
# The loader below therefore exits 3 and names the module it could not resolve,
# instead of letting the failure read as a generic classifier fault. The verdict
# is validated for the same reason: a classifier that answered something other
# than `true`/`false` would be a broken contract, not a routing result.
routing_classifier_path="$script_source_dir/docs/docs-navigation-eval-helpers.mjs"
routing_sensitive_paths_changed=""
routing_classifier_status=0
routing_sensitive_paths_changed="$(
  node --input-type=module - \
    "$routing_classifier_path" \
    "$changed_paths_file" <<'NODE'
import { readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [classifierPath, changedPathsPath] = process.argv.slice(2);
let isRoutingSensitivePath;
try {
  ({ isRoutingSensitivePath } = await import(
    pathToFileURL(classifierPath).href
  ));
} catch (error) {
  // writeSync, not process.stderr.write: process.exit() drops whatever is still
  // queued on an async stderr, which is what stderr is whenever the gate runs
  // under a pipe rather than a terminal.
  //
  // Nothing in this heredoc, code or prose, may leave a quote, backtick, or
  // paren unbalanced. bash 3.2 mis-scans one inside a heredoc nested in $( ),
  // which is how the gate runs this snippet, and
  // check-sentry-suites-in-ci-gate-probe parses the gate with /bin/bash — 3.2
  // on macOS. A lone apostrophe in a comment reds three of its cases.
  writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(3);
}
if (typeof isRoutingSensitivePath !== "function") {
  writeSync(2, `${classifierPath} does not export isRoutingSensitivePath\n`);
  process.exit(3);
}
const changedPaths = readFileSync(changedPathsPath, "utf8")
  .split(/\r?\n/)
  .filter(Boolean);
process.stdout.write(
  changedPaths.some(isRoutingSensitivePath) ? "true" : "false",
);
NODE
)" || routing_classifier_status=$?
if [[ "$routing_classifier_status" -ne 0 ]]; then
  if [[ "$routing_classifier_status" -eq 3 ]]; then
    echo "error: routing-sensitive path classifier could not be loaded from ${routing_classifier_path}" >&2
    echo "       scripts/agent-quality-gate.sh imports this module at pre-push time; moving it requires repointing that path in the same commit." >&2
  fi
  echo "error: failed to classify routing-sensitive changed paths" >&2
  exit 2
fi
case "$routing_sensitive_paths_changed" in
  true|false) ;;
  *)
    echo "error: routing-sensitive path classifier returned an invalid result" >&2
    exit 2
    ;;
esac

preflight_commands=()
codegen_commands=()
post_codegen_commands=()
quality_commands=()
checklists=()
surfaces=()
package_script_risk_changed=false

ref_oid() {
  local ref="$1"
  git rev-parse --verify "${ref}^{commit}" 2>/dev/null || echo "__unresolved__:${ref}"
}

list_contains_word() {
  local needle="$1"
  local word
  shift
  for word in "$@"; do
    [[ "$word" == "$needle" ]] && return 0
  done
  return 1
}

# ── Routing: the Node mapping engine builds the plan ────────────────────────
#
# Routing is `scripts/gate/routing-table/` compiled by `scripts/gate/mapping.mjs`
# (ADR 0069). The gate runs the engine once, reads the plan back as the TSV
# `write_command_plan` already emits, and executes it. The bash `case` arms that
# used to hold this table, the in-gate byte comparison against them, and the
# parity harness were retired together at D5c after the soak; the table's own
# suite now owns the routing's invariants.
#
# EVERY failure below is a refusal. A mapper that crashes, exits non-zero,
# prints something unparsable, names a bucket that does not exist, or emits
# nothing at all must not leave the gate running on a partial plan: fewer mapped
# commands still print "All mapped commands passed."
mapper_path="$script_source_dir/gate/mapping.mjs"
# Checked before the call, and separately from a run failure: a mapper the gate
# cannot find is a repointing mistake, not a routing result, and it must not
# read as one.
if [[ ! -f "$mapper_path" ]]; then
  echo "error: gate mapping engine could not be loaded from ${mapper_path}" >&2
  echo "       scripts/agent-quality-gate.sh runs this module at pre-push time; moving it requires repointing that path in the same commit." >&2
  exit 2
fi

mapper_args=(
  "$mapper_path"
  --repo-root "$repo_root"
  --changed-paths-file "$changed_paths_file"
  --base "$base_ref"
  --head "$head_ref"
  --script-source-dir "$script_source_dir"
)
if [[ "$script_source_dir" == "$repo_root/scripts" ]]; then
  mapper_args+=(--real-tree)
fi
if [[ "$full_local_tests" == "1" || "$full_local_tests" == "true" ]]; then
  mapper_args+=(--full-local-tests)
fi

mapper_plan_file="$(make_tmpfile)"
mapper_status=0
node "${mapper_args[@]}" > "$mapper_plan_file" || mapper_status=$?
if [[ "$mapper_status" -ne 0 ]]; then
  echo "error: gate mapping engine failed (exit ${mapper_status}); refusing to run on a plan it did not produce" >&2
  # Exit 2, not the mapper's own code. 2 is this gate's refusal status.
  # Forwarding 1 or 3 would make a mapper crash look like a different failure
  # class to anything reading the gate's status.
  exit 2
fi
if [[ ! -s "$mapper_plan_file" ]]; then
  echo "error: gate mapping engine produced an empty plan; refusing to run" >&2
  exit 2
fi

engine_preflight_commands=()
engine_codegen_commands=()
engine_post_codegen_commands=()
engine_quality_commands=()
engine_checklists=()
engine_surfaces=()
engine_package_script_risk_changed=false
mapper_record=""
mapper_rest=""
mapper_field=""
while IFS= read -r mapper_record; do
  [[ -n "$mapper_record" ]] || continue
  mapper_rest="${mapper_record#*$'\t'}"
  case "$mapper_record" in
    flag$'\t'*)
      mapper_field="${mapper_rest%%$'\t'*}"
      case "${mapper_field}=${mapper_rest#*$'\t'}" in
        package_script_risk_changed=true) engine_package_script_risk_changed=true ;;
        package_script_risk_changed=false) ;;
        # Accepted and not stored: the engine applies this flag itself, in the
        # scoped-test post-pass, and bash has no reader for it. Still enumerated
        # rather than skipped, so an unrecognised VALUE falls through to the
        # refusal below instead of passing as a record the gate understood.
        saw_workspace_escalation=true | saw_workspace_escalation=false) ;;
        *)
          echo "error: gate mapping engine emitted an unknown flag record: ${mapper_record}" >&2
          exit 2
          ;;
      esac
      ;;
    surface$'\t'*) engine_surfaces+=("$mapper_rest") ;;
    checklist$'\t'*)
      engine_checklists+=("${mapper_rest%%$'\t'*}|${mapper_rest#*$'\t'}")
      ;;
    preflight$'\t'*)
      engine_preflight_commands+=("${mapper_rest%%$'\t'*}|${mapper_rest#*$'\t'}")
      ;;
    codegen$'\t'*)
      engine_codegen_commands+=("${mapper_rest%%$'\t'*}|${mapper_rest#*$'\t'}")
      ;;
    post-codegen$'\t'*)
      engine_post_codegen_commands+=("${mapper_rest%%$'\t'*}|${mapper_rest#*$'\t'}")
      ;;
    quality$'\t'*)
      engine_quality_commands+=("${mapper_rest%%$'\t'*}|${mapper_rest#*$'\t'}")
      ;;
    *)
      echo "error: gate mapping engine emitted an unparsable record: ${mapper_record}" >&2
      exit 2
      ;;
  esac
done < "$mapper_plan_file"

# The engine's plan is the plan. Assigned into the arrays every phase below
# already reads, so the seam is one assignment rather than a rename spread
# across the executor.
preflight_commands=("${engine_preflight_commands[@]+"${engine_preflight_commands[@]}"}")
codegen_commands=("${engine_codegen_commands[@]+"${engine_codegen_commands[@]}"}")
post_codegen_commands=("${engine_post_codegen_commands[@]+"${engine_post_codegen_commands[@]}"}")
quality_commands=("${engine_quality_commands[@]+"${engine_quality_commands[@]}"}")
checklists=("${engine_checklists[@]+"${engine_checklists[@]}"}")
surfaces=("${engine_surfaces[@]+"${engine_surfaces[@]}"}")
# This one is still read below, by the refusal that stops a run whose package
# manifests or lockfile changed, so it has to cross the seam.
package_script_risk_changed="$engine_package_script_risk_changed"

hash_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$@"
  else
    echo "Cannot compute sha256; please install sha256sum or shasum." >&2
    return 127
  fi
}

hash_stream() {
  hash_sha256 | awk '{ print $1 }'
}

hash_file() {
  local output digest
  output="$(hash_sha256 "$1")" || return 1
  digest="${output%%[[:space:]]*}"
  printf '%s\n' "$digest"
}

checked_file_digest() {
  local path="$1" digest
  digest="$(hash_file "$path")" || {
    echo "error: could not hash required implementation file: ${path}" >&2
    return 1
  }
  if [[ ! "$digest" =~ ^[a-f0-9]{64}$ ]]; then
    echo "error: implementation hash output is malformed for: ${path}" >&2
    return 1
  fi
  printf '%s\n' "$digest"
}

write_command_plan() {
  local output_file="$1"
  local entry
  local command
  local reason
  : > "$output_file"
  for entry in "${preflight_commands[@]+"${preflight_commands[@]}"}"; do
    command="${entry%%|*}"
    reason="${entry#*|}"
    command="${command//"$changed_paths_file"/__CHANGED_PATHS_FILE__}"
    printf 'preflight\t%s\t%s\n' "$command" "$reason" >> "$output_file"
  done
  for entry in "${codegen_commands[@]+"${codegen_commands[@]}"}"; do
    command="${entry%%|*}"
    reason="${entry#*|}"
    command="${command//"$changed_paths_file"/__CHANGED_PATHS_FILE__}"
    printf 'codegen\t%s\t%s\n' "$command" "$reason" >> "$output_file"
  done
  for entry in "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"; do
    command="${entry%%|*}"
    reason="${entry#*|}"
    command="${command//"$changed_paths_file"/__CHANGED_PATHS_FILE__}"
    printf 'post-codegen\t%s\t%s\n' "$command" "$reason" >> "$output_file"
  done
  for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
    command="${entry%%|*}"
    reason="${entry#*|}"
    # Some mapped commands consume the gate's randomized scratch path. The
    # execution path may vary between identical runs, but it is not part of
    # the validation plan and must not invalidate a fresh success stamp.
    command="${command//"$changed_paths_file"/__CHANGED_PATHS_FILE__}"
    printf 'quality\t%s\t%s\n' "$command" "$reason" >> "$output_file"
  done
}

implementation_signature() {
  local output_file="$1"
  local implementation_path path canonical_path digest discovered_paths status=0
  : > "$output_file" || return 1
  for path in \
    scripts/agent-quality-gate.sh \
    scripts/agent-quality-gate.test.sh \
    scripts/agent-autoreview-core.mjs \
    scripts/agent-autoreview-secret-suppressions.json \
    scripts/gate/run-handles.sh \
    scripts/gate/darwin-broker-launch-preflight.mjs \
    scripts/gate/darwin-broker-launch-preflight.test.mjs \
    scripts/gate/darwin-process-identity.c \
    scripts/gate/darwin-process-identity-runtime.inc.c \
    scripts/gate/darwin-process-identity-helper.mjs \
    scripts/gate/darwin-process-lineage-model.mjs \
    scripts/gate/darwin-process-lineage-state.mjs \
    scripts/gate/darwin-process-lineage.mjs \
    scripts/gate/darwin-process-lineage.sh \
    scripts/gate/mapped-command-process-identity.mjs \
    scripts/gate/trunk-check-once.sh \
    scripts/check-agent-quality-gate-package-scripts.mjs \
    scripts/docs/docs-navigation-eval-helpers.mjs \
    scripts/gate/lockfile-scope.mjs \
    scripts/gate/mapping.mjs \
    scripts/gate/mapping/facts.mjs \
    scripts/gate/mapping/plan.mjs \
    scripts/gate/mapping/post-passes.mjs \
    scripts/gate/mapping/route.mjs \
    scripts/gate/mapping/shell-quote.mjs \
    scripts/gate/mapping/shell-quote.test.mjs \
    scripts/gate/mapping/verbs.mjs \
    scripts/gate/mapping/engine.test.mjs \
    scripts/gate/routing-table/arms-agent-modules.mjs \
    scripts/gate/routing-table/arms-alerts.mjs \
    scripts/gate/routing-table/arms-packages.mjs \
    scripts/gate/routing-table/arms-script-modules.mjs \
    scripts/gate/routing-table/arms-scripts.mjs \
    scripts/gate/routing-table/arms-sentry-modules.mjs \
    scripts/gate/routing-table/arms-services.mjs \
    scripts/gate/routing-table/arms-tooling-modules.mjs \
    scripts/gate/routing-table/arms-workflows.mjs \
    scripts/gate/routing-table/checks.mjs \
    scripts/gate/routing-table/groups-head.mjs \
    scripts/gate/routing-table/groups-tail.mjs \
    scripts/gate/routing-table/index.mjs \
    scripts/gate/routing-table/indexer-invariant-parity.test.mjs \
    scripts/gate/routing-table/pattern-oracle.test.mjs \
    scripts/gate/routing-table/pattern.mjs \
    scripts/gate/routing-table/pins.test.mjs \
    scripts/gate/routing-table/routing-table.test.mjs \
    scripts/gate/routing-table/schema.mjs \
    scripts/gate/quality-gate-coordinator.sh \
    scripts/gate/quality-gate-coordinator-support.sh \
    scripts/terraform/terraform-fmt-check.mjs \
    scripts/terraform/terraform-fmt-check.test.mjs \
    turbo.json \
    .trunk/trunk.yaml; do
  # Gate-loaded runtime entries execute from this checkout even when a fixture
  # makes $repo_root a different repository. Hash the same source tree the gate
  # executes. The mapper and routing-table suites are mapped commands from the
  # repository under test, so they stay anchored there.
  case "$path" in
    scripts/gate/mapping/*.test.mjs | scripts/gate/routing-table/*.test.mjs)
        implementation_path="$repo_root/$path"
        ;;
      scripts/agent-quality-gate.sh | scripts/agent-autoreview-core.mjs | scripts/agent-autoreview-secret-suppressions.json | scripts/docs/docs-navigation-eval-helpers.mjs | scripts/gate/lockfile-scope.mjs | scripts/gate/run-handles.sh | scripts/gate/darwin-broker-launch-preflight.mjs | scripts/gate/darwin-process-identity.c | scripts/gate/darwin-process-identity-runtime.inc.c | scripts/gate/darwin-process-identity-helper.mjs | scripts/gate/darwin-process-lineage-model.mjs | scripts/gate/darwin-process-lineage-state.mjs | scripts/gate/darwin-process-lineage.mjs | scripts/gate/darwin-process-lineage.sh | scripts/gate/trunk-check-once.sh | scripts/gate/mapping.mjs | scripts/gate/mapping/*.mjs | scripts/gate/routing-table/*.mjs | scripts/gate/quality-gate-coordinator.sh | scripts/gate/quality-gate-coordinator-support.sh)
        implementation_path="$script_source_dir/${path#scripts/}"
        ;;
      *)
        implementation_path="$repo_root/$path"
        ;;
    esac
    if [[ -L "$implementation_path" ]]; then
      echo "error: required implementation path is a symlink: ${implementation_path}" >&2
      return 1
    elif [[ -f "$implementation_path" ]]; then
      digest="$(checked_file_digest "$implementation_path")" || return 1
      printf '%s %s\n' "$path" "$digest" >> "$output_file" || return 1
    elif [[ -e "$implementation_path" ]]; then
      echo "error: required implementation path is not a regular file: ${implementation_path}" >&2
      return 1
    else
      printf '%s __missing__\n' "$path" >> "$output_file" || return 1
    fi
  done

  # Discover production coordinator modules from the checkout that the gate
  # loaded. A new module must invalidate local freshness and shared execution
  # before another caller learns its exact filename.
  discovered_paths="$(mktemp "$scratch_dir/implementation-runtime-paths.XXXXXX")" || return 1
  if ! find "$script_source_dir/gate" -maxdepth 1 \
    -name 'quality-gate-coordinator*.mjs' ! -name '*.test.mjs' -print \
    > "$discovered_paths" 2>/dev/null; then
    rm -f "$discovered_paths"
    return 1
  fi
  if ! LC_ALL=C sort -o "$discovered_paths" "$discovered_paths"; then
    rm -f "$discovered_paths"
    return 1
  fi
  while IFS= read -r implementation_path; do
    canonical_path="scripts/gate/${implementation_path##*/}"
    if [[ -L "$implementation_path" || ! -f "$implementation_path" ]]; then
      echo "error: discovered implementation path is not a regular file: ${implementation_path}" >&2
      status=1
      break
    fi
    digest="$(checked_file_digest "$implementation_path")" || {
      status=1
      break
    }
    if ! printf '%s %s\n' "$canonical_path" "$digest" >> "$output_file"; then
      status=1
      break
    fi
  done < "$discovered_paths"
  rm -f "$discovered_paths"
  [[ "$status" -eq 0 ]] || return 1

  # Coordinator tests and scheduler fixtures execute from the repository under
  # test. Keep their physical root separate from the loaded runtime root.
  if [[ -d "$repo_root/scripts/gate" ]]; then
    discovered_paths="$(mktemp "$scratch_dir/implementation-test-paths.XXXXXX")" || return 1
    if ! find "$repo_root/scripts/gate" -maxdepth 1 \
      \( -name 'quality-gate-coordinator*.test.mjs' -o \
      -name 'agent-quality-gate-scheduler*.mjs' -o \
      -name 'agent-quality-gate-fixture-processes.mjs' \) -print \
      > "$discovered_paths" 2>/dev/null; then
      rm -f "$discovered_paths"
      return 1
    fi
    if ! LC_ALL=C sort -o "$discovered_paths" "$discovered_paths"; then
      rm -f "$discovered_paths"
      return 1
    fi
    while IFS= read -r implementation_path; do
      canonical_path="scripts/gate/${implementation_path##*/}"
      if [[ -L "$implementation_path" || ! -f "$implementation_path" ]]; then
        echo "error: discovered implementation path is not a regular file: ${implementation_path}" >&2
        status=1
        break
      fi
      digest="$(checked_file_digest "$implementation_path")" || {
        status=1
        break
      }
      if ! printf '%s %s\n' "$canonical_path" "$digest" >> "$output_file"; then
        status=1
        break
      fi
    done < "$discovered_paths"
    rm -f "$discovered_paths"
    [[ "$status" -eq 0 ]] || return 1
  fi
}

implementation_hash_value() {
  local manifest digest
  manifest="$(mktemp "$scratch_dir/implementation-signature.XXXXXX")" || return 1
  if ! implementation_signature "$manifest"; then
    rm -f "$manifest"
    return 1
  fi
  digest="$(checked_file_digest "$manifest")" || {
    rm -f "$manifest"
    return 1
  }
  rm -f "$manifest"
  printf '%s\n' "$digest"
}

# The mode of a path, read from the worktree rather than from the index, so the
# answer does not depend on whether the path is tracked yet. This is what the
# ` create mode <mode> …` line dropped below used to carry. `-x` asks whether
# THIS user may execute it, which is git's own rule — the owner bit — for a file
# this user owns, and that is every file in a worktree it is working in. Where
# the two differ (a file owned by somebody else, an execute bit set only for
# group or other) this answer is still the same on both sides of a `git add`,
# which is the property the freshness stamp needs from it.
gate_worktree_filemode() {
  local path="$1"
  if [[ -L "$path" ]]; then
    printf '120000'
  elif [[ -x "$path" ]]; then
    printf '100755'
  else
    printf '100644'
  fi
}

gate_symlink_target_hash() {
  local path="$1"
  [[ -L "$path" ]] || return 1
  readlink "$path" | hash_stream
}

gate_resolved_filemode() {
  local path="$1"
  if [[ -x "$path" ]]; then
    printf '100755'
  else
    printf '100644'
  fi
}

validation_content_signature() {
  local path link_hash resolved_digest

  {
    while IFS= read -r path; do
      printf 'path %s\0' "$path"
      if [[ -L "$path" ]]; then
        link_hash="$(gate_symlink_target_hash "$path")" || return 1
        printf 'symlink %s\0' "$link_hash"
        if [[ -f "$path" ]]; then
          resolved_digest="$(hash_file "$path")" || return 1
          printf 'resolved-file %s\0' "$resolved_digest"
          printf 'resolved-mode %s\0' "$(gate_resolved_filemode "$path")"
        elif [[ -d "$path" ]]; then
          # A directory target has no bounded content digest. Keep the gate
          # valid, but bind the physical worktree so another worktree cannot
          # reuse a result for different directory contents behind the same
          # relative link.
          printf 'resolved-directory-worktree %s\0' "$repo_root"
        elif [[ -e "$path" ]]; then
          printf 'resolved-other-worktree %s\0' "$repo_root"
        else
          printf 'resolved-missing\0'
        fi
      elif [[ -f "$path" ]]; then
        printf 'file %s\0' "$(hash_file "$path")"
        # The executable bit is not in the content hash. Read it from the
        # worktree so `git add` cannot move it.
        printf 'mode %s\0' "$(gate_worktree_filemode "$path")"
      elif [[ -d "$path" ]]; then
        printf 'directory\0'
      elif [[ -e "$path" ]]; then
        printf 'other\0'
      else
        printf 'deleted\0'
      fi
      # `create mode` lines are dropped: they appear the moment a path becomes
      # tracked and say nothing about what was validated. An untracked path is
      # invisible to `git diff`, so `git add` alone used to move this signature
      # and cost a fresh stamp a full re-run — with the changed-path set, the
      # command plan, the base OID and the file's bytes all provably unchanged
      # (GitHub issue 1899). Deletions and mode changes are not index-state
      # transitions in the same way — `git diff <base> -- <path>` reports both
      # from the worktree, staged or not — so those summary lines stay.
      # `awk` rather than `grep -v`, which exits 1 when it filters everything
      # out and would abort the run under `set -e`.
      git diff --no-ext-diff --summary "$base_ref" -- "$path" 2>/dev/null |
        awk '!/^ create mode /' || true
    done < "$changed_paths_file"
  } | hash_stream
}

command_plan_file="$(make_tmpfile)"
write_command_plan "$command_plan_file"

base_oid="$(ref_oid "$base_ref")"
changed_paths_hash="$(hash_file "$changed_paths_file")"
command_plan_hash="$(hash_file "$command_plan_file")"
implementation_hash="$(implementation_hash_value)"
validated_content_hash="$(validation_content_signature)"

# `allow_package_script_changes` only gates the pre-run package-script refusal,
# which is a no-op unless `package_script_risk_changed`. Fold it out of the
# freshness stamp in the common no-risk case so a warm manual run (which may pass
# --allow-package-script-changes defensively) produces the SAME stamp as the
# flag-less pre-push hook — otherwise warm-then-push never skips. When package
# risk IS present, keep the real value so an unacknowledged hook run cannot reuse
# an acknowledged manual run.
if [[ "$package_script_risk_changed" == "true" ]]; then
  stamp_allow_package_scripts="${allow_package_script_changes:-false}"
else
  stamp_allow_package_scripts="n/a"
fi

gate_coordinator_freshness_context=""
gate_coordinator_execution_head=""

# The coordinator execution fingerprint binds HEAD. The pre-push workflow must
# also accept a warm run made immediately before committing the same validated
# bytes. Build a separate compatibility context from every execution-fingerprint
# input except HEAD; stamp_line already carries base, paths, plan,
# implementation, content, and package-risk policy. Equality therefore means
# that only HEAD can differ. Legacy and --no-lock runs keep the v3 stamp.
gate_coordinator_freshness_context_hash() {
  local os_name os_arch node_path node_version pnpm_path pnpm_version
  local env_digest policy_hash runtime_hash repository_identity
  local submodule_state
  [[ "$gate_mapped_child_scrub_policy_hash" =~ ^[a-f0-9]{64}$ ]] || return 1
  gate_coordinator_assert_scrub_policy_current || return 1
  os_name="$(uname -s)" || return 1
  os_arch="$(uname -m)" || return 1
  node_path="$(command -v node)" || return 1
  node_version="$(node --version 2>/dev/null)" || return 1
  pnpm_path="$(command -v pnpm)" || return 1
  pnpm_version="$(pnpm --version 2>/dev/null)" || return 1
  env_digest="$(gate_coordinator_material_env_digest)" || return 1
  policy_hash="${gate_coordinator_policy_hash:-}"
  [[ "$policy_hash" =~ ^[a-f0-9]{64}$ ]] || return 1
  runtime_hash="$(gate_coordinator_runtime_signature)" || return 1
  repository_identity="$(gate_coordinator_repository_identity)" || return 1
  submodule_state="$(
    gate_coordinator_submodule_state_hash "$command_plan_file"
  )" || return 1
  printf '%s\n' \
    "schema=v2" "repository=${repository_identity}" \
    "commandTimeout=${command_timeout_seconds}" \
    "gateSelftestTimeout=${gate_selftest_timeout_seconds}" \
    "gateLockWait=${gate_lock_wait_seconds}" \
    "qualityParallelism=${quality_parallelism}" "failFast=${fail_fast}" \
    "os=${os_name}" "arch=${os_arch}" "nodePath=${node_path}" \
    "node=${node_version}" "pnpmPath=${pnpm_path}" \
    "pnpm=${pnpm_version}" "policy=${policy_hash}" \
    "runtime=${runtime_hash}" "environment=${env_digest}" \
    "submodules=${submodule_state}" \
    "mappedChildScrubPolicy=${gate_mapped_child_scrub_policy_hash}" |
    hash_stream
}

stamp_line() {
  if [[ -n "$gate_coordinator_freshness_context" ]]; then
    printf 'v4\tbase=%s\tpaths=%s\tplan=%s\timplementation=%s\tcontent=%s\tpackageRisk=%s\tallowPackageScripts=%s\tscrubPolicy=%s\tcoordinatorContext=%s\n' \
      "$base_oid" \
      "$changed_paths_hash" \
      "$command_plan_hash" \
      "$implementation_hash" \
      "$validated_content_hash" \
      "$package_script_risk_changed" \
      "$stamp_allow_package_scripts" \
      "$gate_mapped_child_scrub_policy_hash" \
      "$gate_coordinator_freshness_context"
    return
  fi
  printf 'v3\tbase=%s\tpaths=%s\tplan=%s\timplementation=%s\tcontent=%s\tpackageRisk=%s\tallowPackageScripts=%s\tscrubPolicy=%s\n' \
    "$base_oid" \
    "$changed_paths_hash" \
    "$command_plan_hash" \
    "$implementation_hash" \
    "$validated_content_hash" \
    "$package_script_risk_changed" \
    "$stamp_allow_package_scripts" \
    "$gate_mapped_child_scrub_policy_hash"
}

current_stamp=""

recomputed_stamp_line() {
  local fresh_paths_file fresh_plan_file fresh_base fresh_paths fresh_plan
  local fresh_implementation fresh_content fresh_coordinator_context
  fresh_paths_file="$(mktemp "$scratch_dir/fresh-paths.XXXXXX")" || return 1
  fresh_plan_file="$(mktemp "$scratch_dir/fresh-plan.XXXXXX")" || {
    rm -f "$fresh_paths_file"
    return 1
  }
  if ! collect_current_changed_paths |
    sed '/^$/d' | LC_ALL=C sort -u > "$fresh_paths_file"; then
    rm -f "$fresh_paths_file" "$fresh_plan_file"
    return 1
  fi
  write_command_plan "$fresh_plan_file" || {
    rm -f "$fresh_paths_file" "$fresh_plan_file"
    return 1
  }
  fresh_base="$(ref_oid "$base_ref")" || {
    rm -f "$fresh_paths_file" "$fresh_plan_file"
    return 1
  }
  fresh_paths="$(hash_file "$fresh_paths_file")" || {
    rm -f "$fresh_paths_file" "$fresh_plan_file"
    return 1
  }
  fresh_plan="$(hash_file "$fresh_plan_file")" || {
    rm -f "$fresh_paths_file" "$fresh_plan_file"
    return 1
  }
  fresh_implementation="$(implementation_hash_value)" || {
    rm -f "$fresh_paths_file" "$fresh_plan_file"
    return 1
  }
  fresh_content="$(validation_content_signature)" || {
    rm -f "$fresh_paths_file" "$fresh_plan_file"
    return 1
  }
  rm -f "$fresh_paths_file" "$fresh_plan_file" || return 1
  if [[ -n "$gate_coordinator_freshness_context" ]]; then
    fresh_coordinator_context="$(gate_coordinator_freshness_context_hash)" || return 1
    printf 'v4\tbase=%s\tpaths=%s\tplan=%s\timplementation=%s\tcontent=%s\tpackageRisk=%s\tallowPackageScripts=%s\tscrubPolicy=%s\tcoordinatorContext=%s\n' \
      "$fresh_base" "$fresh_paths" "$fresh_plan" "$fresh_implementation" \
      "$fresh_content" "$package_script_risk_changed" \
      "$stamp_allow_package_scripts" "$gate_mapped_child_scrub_policy_hash" \
      "$fresh_coordinator_context"
    return
  fi
  printf 'v3\tbase=%s\tpaths=%s\tplan=%s\timplementation=%s\tcontent=%s\tpackageRisk=%s\tallowPackageScripts=%s\tscrubPolicy=%s\n' \
    "$fresh_base" "$fresh_paths" "$fresh_plan" "$fresh_implementation" \
    "$fresh_content" "$package_script_risk_changed" \
    "$stamp_allow_package_scripts" "$gate_mapped_child_scrub_policy_hash"
}

is_fresh_success_stamp() {
  local stamped_at
  local stamped_value
  local stamped_execution_fingerprint
  local stamped_execution_head
  local now
  [[ -f "$success_stamp_file" ]] || return 1
  stamped_at="$(sed -n '1s/^created_at=//p' "$success_stamp_file")"
  stamped_value="$(sed -n '2s/^stamp=//p' "$success_stamp_file")"
  [[ "$stamped_value" == "$current_stamp" ]] || return 1
  if [[ -n "$gate_coordinator_freshness_context" ]]; then
    stamped_execution_fingerprint="$(
      sed -n '3s/^execution_fingerprint=//p' "$success_stamp_file"
    )"
    stamped_execution_head="$(
      sed -n '4s/^execution_head=//p' "$success_stamp_file"
    )"
    [[ "$stamped_execution_fingerprint" =~ ^[a-f0-9]{64}$ ]] || return 1
    [[ "$stamped_execution_head" =~ ^[a-f0-9]{40}([a-f0-9]{24})?$ ]] || return 1
    if [[ "$stamped_execution_head" == "$gate_coordinator_execution_head" ]]; then
      [[ "$stamped_execution_fingerprint" == \
        "$gate_coordinator_registration_fingerprint" ]] || return 1
    fi
    # If HEAD changed after a warm run, the matching v4 stamp above proves
    # equality for every other execution input and permits only that transition.
  fi
  [[ "$stamped_at" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  # Reject future-dated stamps (clock stepped backward after stamping): a
  # negative age would satisfy an upper-bound-only check and extend reuse
  # until the clock catches up. Fail toward rerun.
  [[ "$stamped_at" -le "$now" ]] || return 1
  [[ $((now - stamped_at)) -le "$success_stamp_ttl_seconds" ]]
}

echo "Agent quality gate"
echo
echo "Base: ${base_ref}"
echo "Head: ${head_ref}"
echo "Mode: ${mode}"
if [[ -n "${TURBO_CACHE_DIR:-}" ]]; then
  echo "Turbo cache dir: ${TURBO_CACHE_DIR}"
fi
echo
echo "Changed paths:"
sed 's/^/- /' "$changed_paths_file"
echo

if [[ ${#surfaces[@]} -gt 0 ]]; then
  echo "Detected surfaces:"
  for surface in "${surfaces[@]+"${surfaces[@]}"}"; do
    echo "- ${surface}"
  done
  echo
fi

if [[ ${#checklists[@]} -gt 0 ]]; then
  echo "Required checklist review:"
  for entry in "${checklists[@]+"${checklists[@]}"}"; do
    echo "- ${entry%%|*} (${entry#*|})"
  done
  echo
fi

echo "Mapped safe local commands:"
for entry in "${preflight_commands[@]+"${preflight_commands[@]}"}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
for entry in "${codegen_commands[@]+"${codegen_commands[@]}"}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
for entry in "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
echo

if [[ "$mode" == "dry-run" ]]; then
  echo "Dry run only. Re-run with --run to execute the mapped commands."
  exit 0
fi

# A coordinated zero-work success must first derive the same source, plan,
# toolchain, material environment, runtime, and policy identity used for
# registration. The second full fingerprint read brackets the compatible
# headless context and fails closed if any execution input moves during it.
if gate_coordinator_requested; then
  exec 7>&1
  gate_coordinator_stdout_reserved=1
  if ! gate_lock_ensure_local_host_fingerprint; then
    echo "error: could not derive the local host identity for safe coordinator marker recovery." >&2
    gate_coordinator_report_no_work_failure 2 "registration preparation" \
      "No mapped command ran in this request"
    exit 2
  fi
  if ! gate_run_ensure_token; then
    gate_coordinator_report_no_work_failure 2 "registration preparation" "No mapped command ran in this request"
    exit 2
  fi
  if ! gate_coordinator_prepare_registration_fingerprint; then
    gate_coordinator_report_no_work_failure 2 "registration preparation" "No mapped command ran in this request"
    exit 2
  fi
  if ! gate_coordinator_requested; then
    exec 7>&-
    gate_coordinator_stdout_reserved=0
  fi
fi
if gate_coordinator_requested; then
  gate_coordinator_freshness_context="$(
    gate_coordinator_freshness_context_hash
  )" || {
    echo "error: could not compute the coordinated freshness context." >&2
    gate_coordinator_report_no_work_failure 2 "freshness identity preparation" \
      "No mapped command ran in this request"
    exit 2
  }
  gate_coordinator_execution_head="$(ref_oid "$head_ref")" || {
    echo "error: could not resolve HEAD for coordinated freshness reuse." >&2
    gate_coordinator_report_no_work_failure 2 "freshness identity preparation" \
      "No mapped command ran in this request"
    exit 2
  }
  verified_coordinator_fingerprint="$(
    gate_coordinator_recompute_fingerprint
  )" || {
    echo "error: could not verify the coordinator fingerprint before freshness reuse." >&2
    gate_coordinator_report_no_work_failure 2 "freshness identity preparation" \
      "No mapped command ran in this request"
    exit 2
  }
  if [[ "$verified_coordinator_fingerprint" != \
    "$gate_coordinator_registration_fingerprint" ]]; then
    echo "error: quality-gate inputs changed while the coordinated freshness identity was prepared." >&2
    gate_coordinator_report_no_work_failure 2 "freshness identity preparation" \
      "No mapped command ran in this request"
    exit 2
  fi
  unset verified_coordinator_fingerprint
fi
current_stamp="$(stamp_line)" || {
  echo "error: could not compute the quality-gate freshness stamp." >&2
  gate_report_coordinated_no_work_failure 2 "freshness identity preparation" \
    "No mapped command ran in this request"
  exit 2
}
if [[ -n "$gate_coordinator_freshness_context" ]]; then
  verified_freshness_stamp="$(recomputed_stamp_line)" || {
    echo "error: could not verify repository state before coordinated freshness reuse." >&2
    gate_coordinator_report_no_work_failure 2 "freshness identity preparation" \
      "No mapped command ran in this request"
    exit 2
  }
  if [[ "$verified_freshness_stamp" != "$current_stamp" ]]; then
    echo "error: repository or execution inputs changed while the coordinated freshness identity was prepared." >&2
    gate_coordinator_report_no_work_failure 2 "freshness identity preparation" \
      "No mapped command ran in this request"
    exit 2
  fi
  unset verified_freshness_stamp
fi

if [[ "$skip_if_fresh" == "1" || "$skip_if_fresh" == "true" ]]; then
  if is_fresh_success_stamp; then
    echo "Previous successful agent quality gate run is still fresh; skipping mapped commands."
    exit 0
  fi
fi

if [[ "$pre_push" == "1" || "$pre_push" == "true" ]]; then
  cloud_pre_push_require_fresh="$(
    git config --bool --get agent.qualityGate.cloudPrePushRequireFresh 2>/dev/null || true
  )"
  if [[ "$cloud_pre_push_require_fresh" == "true" ]]; then
    echo "Hosted pre-push requires a fresh quality-gate stamp; no mapped command ran." >&2
    echo "Run 'git fetch origin main', then start 'pnpm agent:quality-gate --run' as an observable background task." >&2
    echo "Retry the push after that command passes; the hook will reuse the fresh stamp." >&2
    gate_report_coordinated_no_work_failure 2 "hosted pre-push freshness" \
      "No mapped command ran in this request"
    exit 2
  fi
fi

if [[ "$package_script_risk_changed" == true && "$allow_package_script_changes" != "1" && "$allow_package_script_changes" != "true" ]]; then
  echo "Refusing to run because package manifests, patches, or lockfile changed." >&2
  echo "Review package scripts, lifecycle hooks, and dependency install scripts first, then re-run with --allow-package-script-changes if they are safe." >&2
  if gate_coordinator_requested; then
    gate_coordinator_report_no_work_failure 2 "pre-execution policy" \
      "No mapped command ran in this request"
  fi
  exit 2
fi

# Take the machine's run lock only once this run is definitely going to execute
# something: a dry run, a fresh-stamp skip, and a package-script refusal all
# exit above without ever competing for the machine. Coordinated runs have
# already prepared the identity that acquisition registers.
# Legacy lock acquisition and coordinator registration already prepare their
# run handles. Explicit no-lock runs and nested gates need private handles
# before acquisition changes the inherited-lock marker. Without them,
# descendant cleanup can report a false success.
if ! prepare_uncoordinated_run_handles; then
  echo "Nothing has been executed." >&2
  gate_report_coordinated_no_work_failure 2 "run-handle preparation" \
    "No mapped command ran in this request"
  exit 2
fi
acquire_gate_run_lock
if declare -F gate_coordinator_is_follower >/dev/null 2>&1 &&
  gate_coordinator_is_follower; then
  gate_coordinator_wait_for_shared_result
  exit $?
fi
# The run marker is written here, while the gate's own stderr is still live
# and the exit is unambiguously the gate's: inside run_with_timeout the
# per-command capture would swallow the message, and a parallel worker's exit
# is not the run's. Failing here also means failing before ANY command, which
# is the whole point.
gate_run_ensure_marker
# Test-only synchronization for the displaced-holder fixture. Normal runs do
# not call it, so unset behavior stays exactly on the production path.
if [[ "${AGENT_QUALITY_GATE_LOCK_TEST_READY_FILE+x}" == x || "${AGENT_QUALITY_GATE_LOCK_TEST_RELEASE_FILE+x}" == x ]]; then
  if [[ "${NODE_ENV:-}" != "test" ]]; then
    echo "error: gate lock test synchronization is allowed only with NODE_ENV=test." >&2
    echo "Nothing has been executed." >&2
    exit 2
  fi
  gate_lock_test_ready_and_wait_for_release \
    "${AGENT_QUALITY_GATE_LOCK_TEST_READY_FILE:-}" \
    "${AGENT_QUALITY_GATE_LOCK_TEST_RELEASE_FILE:-}"
fi
# Test-only: widens the gap between holding the lock and checking we still do,
# which is otherwise as short as the mapping work between them.
gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_HELD_DELAY_SECONDS:-}"

# Re-check freshness after the wait. The run we queued behind may have stamped
# this exact fingerprint while we waited — the pre-push hook queued behind the
# manual warm-up run is precisely that case — and re-running its work would
# throw away the reason the hook passes --skip-if-fresh at all.
if ! declare -F gate_coordinator_is_active >/dev/null 2>&1 ||
  ! gate_coordinator_is_active; then
  if [[ "$skip_if_fresh" == "1" || "$skip_if_fresh" == "true" ]]; then
    post_wait_stamp="$(recomputed_stamp_line)" || {
      echo "error: could not recompute the quality-gate stamp after the lock wait." >&2
      exit 2
    }
    if [[ "$post_wait_stamp" != "$current_stamp" ]]; then
      echo "error: repository state changed while this gate waited for the run lock." >&2
      echo "No mapped command ran. Re-run so routing and validation use the new state." >&2
      exit 2
    fi
    if is_fresh_success_stamp; then
      echo "A concurrent agent quality gate run left a fresh success stamp; skipping mapped commands."
      exit 0
    fi
  fi
fi

failures=0
command_summaries=()
# `<command>\n<output tail>` per failed command, replayed next to the verdict.
failed_command_outputs=()
failure_output_tail_lines=20
# Trunk launcher provisioning verdict for this run: "" (not probed yet), "ok",
# or "blocked". Probed at most once, and only after a Trunk command failed.
trunk_provisioning_state=""
# True once any Trunk arm in this run was downgraded to "skipped" because the
# environment blocked provisioning. Separate from trunk_provisioning_state
# because the launcher probe answers a question about the LAUNCHER and is
# cached, while a blocked linter download is classified per arm from that arm's
# own output. Drives the closing note and the whole-run stamp guard.
trunk_arm_environment_blocked=false
# Which provisioning stage blocked the arm currently being classified:
# "launcher" (no CLI at all), "plugin" (CLI ran, could not fetch its plugin
# sources, never reached a linter), or "linters" (CLI ran and linted, its
# runtime or linter downloads failed). Each names a different remedy.
trunk_environment_blocked_kind=""
# The transcript shape trunk_check_output_is_environment_blocked accepted, which
# is what separates the last two.
trunk_check_blocked_shape=""

format_duration() {
  local seconds="$1"
  local minutes
  local remainder

  if [[ "$seconds" -lt 60 ]]; then
    echo "${seconds}s"
    return
  fi

  minutes=$((seconds / 60))
  remainder=$((seconds % 60))
  echo "${minutes}m${remainder}s"
}

filter_expected_output() {
  local skip_expected_stack=false
  while IFS= read -r line; do
    if [[ "$line" =~ ^\[(RPC_FAILURE|RPC_FAILURE_BURST|CONTRACT_REVERT|CONTRACT_REVERT_BURST)\] ]]; then
      skip_expected_stack=false
      continue
    fi

    if [[ "$line" =~ ^\[(rebalance-check|address-labels|address-labels/[^]]+|address-reports|backup|minipay/tag|minipay/sync|arkham/enrich)\] ]]; then
      skip_expected_stack=true
      continue
    fi

    if [[ "$skip_expected_stack" == true ]]; then
      case "$line" in
        Error:*|TypeError:*|"    at "*)
          continue
          ;;
        "")
          skip_expected_stack=false
          continue
          ;;
      esac
      echo "$line"
      continue
    fi

    skip_expected_stack=false
    echo "$line"
  done
}

# The inline dump of a failing command's output can sit thousands of lines above
# the final verdict once the parallel pool interleaves several commands, and a
# command that fails while printing nothing (a launcher that swallows its own
# error) leaves no trace at all. Keep the tail of each failure so the verdict can
# repeat it, and say so explicitly when there was nothing to keep.
record_failure_output() {
  local command="$1"
  local output_file="$2"
  local tail_text

  tail_text="$(filter_expected_output < "$output_file" 2>/dev/null |
    tail -n "$failure_output_tail_lines")" || tail_text=""
  if [[ -z "${tail_text//[[:space:]]/}" ]]; then
    tail_text="(no output captured)"
  fi
  failed_command_outputs+=("${command}"$'\n'"${tail_text}")
}

print_failed_command_output() {
  local entry
  local command
  local body

  if [[ ${#failed_command_outputs[@]} -eq 0 ]]; then
    return 0
  fi

  echo >&2
  echo "Failure output (last ${failure_output_tail_lines} lines per command):" >&2
  for entry in "${failed_command_outputs[@]+"${failed_command_outputs[@]}"}"; do
    command="${entry%%$'\n'*}"
    body="${entry#*$'\n'}"
    echo "- ${command}" >&2
    printf '%s\n' "$body" | sed 's/^/    /' >&2
  done
}

# `./tools/trunk` is a launcher that self-downloads the pinned CLI from trunk.io
# on first use. Where that host is unreachable — a Claude cloud container proxies
# egress and answers "Proxy tunneling failed: Forbidden" for anything outside its
# allowlist — the launcher exits non-zero before a single linter runs, and the
# stamp-exempt Trunk arm would make an otherwise-clean gate unable to exit 0.
# `.trunk/hooks` already models the answer for commits and pushes: warn, name the
# allowlist fix, skip. The gate takes the same posture, with one restriction that
# keeps it honest — only a PROVISIONING failure may downgrade. A provisioned
# Trunk that finds real problems still fails the gate, so the probe runs AFTER
# the command failed and asks the launcher whether it can produce a CLI at all.
is_trunk_command() {
  case "$1" in
    "./tools/trunk check --ci"*)
      return 0
      ;;
  esac
  return 1
}

trunk_provisioning_probe_timeout_seconds=15
trunk_guardian_completion_bound_seconds=120
trunk_guardian_status_publish_bound_seconds=5

gate_trunk_guardian_receipt_is_safe() {
  local path="$1"
  local expected_value="$2"
  [[ "${gate_darwin_node_bin:-}" == /* ]] || return 2
  "$gate_darwin_node_bin" -e '
    const { lstatSync, readFileSync } = require("node:fs");
    const [path, expectedValue, uidText] = process.argv.slice(1);
    const stat = lstatSync(path);
    process.exit(
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === Number(uidText) &&
      (stat.mode & 0o7777) === 0o400 &&
      readFileSync(path, "utf8") === expectedValue + "\n"
        ? 0
        : 1,
    );
  ' "$path" "$expected_value" "$UID" 2>/dev/null
}

gate_trunk_guardian_prepare_handshake() {
  local directory="$1"
  local pending_file="$2"
  local done_file="$3"

  [[ "$pending_file" == "$directory/trunk-guardian.pending" &&
    "$done_file" == "$directory/trunk-guardian.done" ]] || return 2
  gate_run_private_marker_directory_is_safe "$directory" || return 2
  [[ ! -e "$pending_file" && ! -L "$pending_file" &&
    ! -e "$done_file" && ! -L "$done_file" &&
    ! -e "${done_file}.tmp" && ! -L "${done_file}.tmp" ]] || return 2
  if ! (set -o noclobber && umask 077 &&
    printf 'pending\n' >"$pending_file") ||
    ! /bin/chmod 0400 "$pending_file" ||
    ! gate_trunk_guardian_receipt_is_safe "$pending_file" pending; then
    /bin/rm -f -- "$pending_file"
    return 2
  fi
}

gate_trunk_guardian_read_signal_until() {
  local deadline="$1"
  local expected_parent="$2"
  local reader_pid
  local reader_status
  [[ "${gate_darwin_node_bin:-}" == /* ]] || return 2
  /usr/bin/env -i "$gate_darwin_node_bin" -e '
    const [deadlineText, expectedParentText] = process.argv.slice(1);
    const deadlineSeconds = Number(deadlineText);
    const expectedParent = Number(expectedParentText);
    const remainingMilliseconds = deadlineSeconds * 1_000 - Date.now();
    if (
      !Number.isSafeInteger(deadlineSeconds) ||
      deadlineSeconds <= 0 ||
      !Number.isSafeInteger(expectedParent) ||
      expectedParent <= 1 ||
      process.ppid !== expectedParent ||
      !Number.isFinite(remainingMilliseconds)
    ) {
      process.exit(2);
    }
    if (remainingMilliseconds <= 0) process.exit(11);

    let settled = false;
    let input = Buffer.alloc(0);
    let deadlineTimer;
    let parentTimer;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearInterval(parentTimer);
      process.exit(status);
    };
    const checkDeadline = () => {
      const remaining = deadlineSeconds * 1_000 - Date.now();
      if (remaining <= 0) {
        finish(11);
        return;
      }
      deadlineTimer = setTimeout(checkDeadline, Math.min(remaining, 60_000));
    };
    checkDeadline();
    parentTimer = setInterval(() => {
      if (process.ppid !== expectedParent) finish(13);
    }, 250);
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
      process.once(signal, () => finish(13));
    }
    process.stdin.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (input.length > 5) {
        finish(12);
        return;
      }
      if (input.length === 5) {
        finish(input.equals(Buffer.from("done\n", "utf8")) ? 0 : 12);
      }
    });
    process.stdin.once("end", () => {
      if (input.length === 0) {
        finish(10);
        return;
      }
      finish(12);
    });
    process.stdin.once("error", () => finish(2));
    process.stdin.resume();
  ' "$deadline" "$expected_parent" \
    3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- 10>&- 11>&- 12>&- 13>&- \
    14>&- 15>&- 16>&- 17>&- 18>&- 19>&- 20>&- 21>&- 22>&- 23>&- \
    24>&- 25>&- <&26 26<&- >/dev/null 2>/dev/null &
  reader_pid=$!
  if wait "$reader_pid"; then
    return 0
  else
    reader_status=$?
    return "$reader_status"
  fi
}

gate_trunk_guardian_wait_done() {
  local pending_file="$1"
  local done_file="$2"
  local deadline="$3"
  local expected_parent="$4"
  local directory="${pending_file%/*}"
  local signal_status=0

  if [[ ! "$deadline" =~ ^[1-9][0-9]*$ ||
    ! "$expected_parent" =~ ^[1-9][0-9]*$ ||
    "$pending_file" != "$directory/trunk-guardian.pending" ||
    "$done_file" != "$directory/trunk-guardian.done" ]] ||
    ! gate_run_private_marker_directory_is_safe "$directory" ||
    ! gate_trunk_guardian_receipt_is_safe "$pending_file" pending; then
    echo "error: Trunk guardian lifecycle handshake is invalid before settlement." >&2
    return 2
  fi

  if gate_trunk_guardian_read_signal_until "$deadline" "$expected_parent"; then
    signal_status=0
  else
    signal_status=$?
  fi
  case "$signal_status" in
    0)
      if gate_trunk_guardian_receipt_is_safe "$pending_file" pending &&
        gate_trunk_guardian_receipt_is_safe "$done_file" "done"; then
        return 0
      fi
      echo "error: Trunk guardian published an invalid completion signal." >&2
      ;;
    10)
      echo "error: Trunk guardian completion capability closed before publication." >&2
      ;;
    11)
      echo "error: Trunk guardian did not finish before its lifecycle deadline." >&2
      ;;
    12)
      echo "error: Trunk guardian published an invalid completion signal." >&2
      ;;
    *)
      echo "error: Trunk guardian completion capability could not be inspected." >&2
      ;;
  esac
  return 2
}

gate_trunk_guardian_cleanup_handshake() {
  local pending_file="$1"
  local done_file="$2"
  local directory

  if [[ "${trunk_guardian_signal_write_open:-0}" -eq 1 ]]; then
    exec 25>&-
    trunk_guardian_signal_write_open=0
  fi
  if [[ "${trunk_guardian_signal_read_open:-0}" -eq 1 ]]; then
    exec 26<&-
    trunk_guardian_signal_read_open=0
  fi

  if [[ -z "$pending_file" && -z "$done_file" ]]; then
    return 0
  fi
  directory="${pending_file%/*}"
  [[ -n "$directory" &&
    "$pending_file" == "$directory/trunk-guardian.pending" &&
    "$done_file" == "$directory/trunk-guardian.done" ]] || return 2
  /bin/rm -f -- "$pending_file" "$done_file" "${done_file}.tmp"
}

# Ask the launcher whether it can produce a CLI. Bounded: a probe that cannot
# answer within its budget is torn down and reported as NOT blocked, so an
# unanswerable question leaves the original failure standing.
trunk_provisioning_probe() {
  local command_tag="${1:-}"
  local request_tag="${2:-}"
  local command_marker="${3:-}"
  local request_marker="${4:-}"
  local coordinator_marker="${5:-}"
  local close_coordinator_stdout_fd="${6:-0}"
  local close_parallel_worker_control_fd="${7:-0}"
  local handshake_file="${8:-}"
  local pid
  local pid_start
  local exact_identity=""
  local exact_capture_status=0
  local waited=0
  local had_errexit=0
  local rc

  case "$-" in
    *e*) had_errexit=1 ;;
  esac
  set +e

  if [[ -z "$handshake_file" ]] || ! rm -f "$handshake_file"; then
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi

  # The sanitized launcher executes this Bash body.
  # shellcheck disable=SC2016
  AGENTQG_RUN="$command_tag" \
  AGENTQG_REQUEST="$request_tag" \
    "${gate_sanitized_bash_launcher[@]}" -c '
      exec 24<&- 2>/dev/null || true
      command_marker="$1"
      request_marker="$2"
      coordinator_marker="$3"
      close_coordinator_stdout_fd="$4"
      close_parallel_worker_control_fd="$5"
      handshake_file="$6"
      if [[ -n "$command_marker" ]]; then
        [[ -r "$command_marker" ]] || exit 125
        exec 9< "$command_marker" || exit 125
      fi
      if [[ -n "$request_marker" && "$request_marker" != "$command_marker" ]]; then
        [[ -r "$request_marker" ]] || exit 125
        exec 8< "$request_marker" || exit 125
      fi
      if [[ -n "$coordinator_marker" &&
        "$coordinator_marker" != "$command_marker" &&
        "$coordinator_marker" != "$request_marker" ]]; then
        [[ -r "$coordinator_marker" ]] || exit 125
        exec 6< "$coordinator_marker" || exit 125
      fi
      if [[ "$close_coordinator_stdout_fd" == 1 ]]; then
        exec 7>&-
      fi
      if [[ "$close_parallel_worker_control_fd" == 1 ]]; then
        exec 17>&-
      fi
      printf "%s\n" ready > "$handshake_file" || exit 125
      export TRUNK_LAUNCHER_QUIET=true
      exec ./tools/trunk --version
    ' trunk-provisioning-probe \
      "$command_marker" "$request_marker" "$coordinator_marker" \
      "$close_coordinator_stdout_fd" \
      "$close_parallel_worker_control_fd" "$handshake_file" \
      >/dev/null 2>&1 &
  pid=$!
  # INT/TERM cleanup must see the probe while its command identity and
  # scheduler lease remain active. The private readiness file distinguishes a
  # launcher failure from a wrapper that never retained the recovery handles.
  pid_start="$(gate_lock_process_runtime_start "$pid")"
  active_timeout_records=("${pid}|${pid_start}")
  if ! gate_darwin_exact_child_capture \
    "$pid" "${gate_mapped_command_parent_pid:-$$}"; then
    exact_capture_status=2
  else
    exact_identity="$gate_darwin_exact_identity"
  fi
  active_timeout_exact_identities=("$exact_identity")
  while kill -0 "$pid" 2>/dev/null &&
    [[ "$waited" -lt "$trunk_provisioning_probe_timeout_seconds" ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    if [[ "$gate_darwin_lineage_host_platform" == Darwin ]]; then
      if [[ "$exact_capture_status" -ne 0 || -z "$exact_identity" ]] ||
        ! gate_darwin_exact_identity_terminate "$exact_identity" "$pid"; then
        echo "error: the Trunk probe has no usable Darwin kernel identity." >&2
        rc=2
      else
        wait "$pid" 2>/dev/null
        rc=0
      fi
    else
      kill_process_tree "$pid" KILL
      wait "$pid" 2>/dev/null
      rc=0
    fi
  else
    wait "$pid" 2>/dev/null
    rc=$?
    [[ "$rc" -le 128 ]] || rc=0
  fi
  [[ "$exact_capture_status" -eq 0 ]] || rc=2
  if ! kill -0 "$pid" 2>/dev/null; then
    active_timeout_records=()
    active_timeout_exact_identities=()
  fi

  if ! read_parallel_worker_result_value "$handshake_file" ready \
    >/dev/null 2>&1; then
    rc=2
  elif [[ "$rc" -ne 0 ]]; then
    rc=1
  fi

  [[ "$had_errexit" == 1 ]] && set -e
  return "$rc"
}

trunk_provisioning_is_blocked() {
  local probe_status
  # A missing or non-executable launcher is a real failure, not an environment
  # one: tools/trunk is tracked, so its absence means the checkout is broken.
  [[ -x ./tools/trunk ]] || return 1

  if [[ -z "$trunk_provisioning_state" ]]; then
    if trunk_provisioning_probe "$@"; then
      trunk_provisioning_state=ok
    else
      probe_status=$?
      if [[ "$probe_status" -eq 1 ]]; then
        trunk_provisioning_state=blocked
      else
        echo "error: the Trunk provisioning probe could not retain the mapped command's recovery identity." >&2
        return 2
      fi
    fi
  fi

  [[ "$trunk_provisioning_state" == blocked ]]
}

# Trunk downloads more than its own CLI. The launcher self-installs the pinned
# CLI from trunk.io; that CLI then fetches plugin sources from github.com and,
# on every check, the hermetic runtimes and linter binaries the enabled linters
# need (nodejs.org, each linter's release host). An environment that allowlists
# trunk.io but not those hosts provisions the launcher — `--version` succeeds,
# so the probe above reports "ok" — and still fails every `trunk check`.
#
# Classifying that from the check output has one hard requirement: a real lint
# finding must never be excused as an environment failure. So the classifier
# never infers "nothing was found"; it only accepts output in which Trunk
# ITSELF states that it found nothing and that every failure it counted was a
# download step. Anything it cannot account for exactly leaves the failure
# standing.
#
# Trunk's own wording for a failed download, as recorded in the detail YAML the
# failed step writes. Measured against Trunk 1.25.0 with the download forced to
# fail three ways: connection refused, a 403-returning forward proxy (what an
# egress allowlist does), and an unresolvable proxy host.
#
# Each entry is a whole measured phrase, never the bare `Curl Error:` prefix.
# Trunk reports a removed or renamed artifact under that same prefix, and a 404
# is a broken pin the operator has to fix, not an allowlist to widen — matching
# the prefix would excuse it. A cause Trunk phrases some other way stays
# unclassified on purpose: an unrecognized reason fails the gate rather than
# being excused, and the fix is to measure it and add it here.
trunk_network_failure_signatures=(
  'Curl Error: Failure when receiving data from the peer'
  'Curl Error: Could not resolve proxy name'
  'Could resolve but could not establish connection to host of'
)

# True when any measured download-failure phrasing appears in the given text.
trunk_text_has_network_failure_signature() {
  local text="$1"
  local signature

  for signature in "${trunk_network_failure_signatures[@]}"; do
    case "$text" in
      *"$signature"*)
        return 0
        ;;
    esac
  done

  return 1
}

# Trunk states a failed PLUGIN download inline, in the check output itself, and
# never writes a detail YAML for it. That inline cause has its own measured
# phrasing, so it gets its own acceptance rather than widening the shared list.
#
# Measured 2026-08-26 in a real Claude cloud container (Trunk 1.25.0, cold
# TRUNK_CACHE): the platform's credential proxy intercepts github.com and gates
# it per session, so Trunk's plugin archive comes back 403 and the CLI aborts
# before linting anything. The cause it prints is
# `Unable to download plugin <url>: HTTP 403 '<url>'`.
#
# Three limits, all deliberate:
#
# - Plugin-scoped. The detail-YAML side was never measured with a 403, so adding
#   `HTTP 403` to trunk_network_failure_signatures would excuse a shape nobody
#   has seen. This acceptance reaches only `plugincause=` lines.
# - 403 only. This is the same rule that keeps the bare `Curl Error:` prefix out
#   of the list above: a 404 — or any other status — is a removed or renamed
#   artifact, a broken pin the operator has to fix, and must keep failing the
#   gate rather than reading as an allowlist to widen.
# - The measured plugin source only, which is the `uri:` .trunk/trunk.yaml pins
#   (the `ref:` is the version in the path, so a ref bump still matches). A 403
#   from some other plugin source is far more likely to be revoked credentials
#   or a misconfigured private source than a session gate, and that has to stay
#   visible. Both URLs in the phrase must be the same one, because that is the
#   shape Trunk emits.
trunk_plugin_http_403_cause_pattern=$'^Unable to download plugin (https://github\\.com/trunk-io/plugins/[^[:space:]]+): HTTP 403 \'([^[:space:]]+)\'$'

# True when the inline cause Trunk printed for a failed plugin download is a
# measured environment block.
trunk_plugin_cause_is_environment_blocked() {
  local cause="$1"

  trunk_text_has_network_failure_signature "$cause" && return 0

  [[ "$cause" =~ $trunk_plugin_http_403_cause_pattern ]] || return 1
  [[ "${BASH_REMATCH[1]}" == "${BASH_REMATCH[2]}" ]]
}

# Read the `report:` lines of one Trunk failure-detail YAML and say whether the
# reason it records is a download failure. The path comes from Trunk's own
# output, so it is accepted only in the exact shape Trunk emits — a plain file
# directly under .trunk/out — and never followed anywhere else.
#
# Scoped to `report:` and nothing else. This is one of the two checks that decide
# whether a failure may be excused, and the classifier's rule is to verify
# exactly rather than infer: a bullet under some other key must never be able to
# supply the signature that `report:` did not. A `report:` block Trunk writes in
# some other shape yields nothing here, which rejects.
trunk_detail_yaml_reports_network_failure() {
  local yaml_path="$1"
  local report

  is_trunk_detail_yaml_path "$yaml_path" || return 1
  [[ -f "$yaml_path" ]] || return 1

  report="$(trunk_detail_yaml_report_lines "$yaml_path")"
  [[ -n "$report" ]] || return 1

  trunk_text_has_network_failure_signature "$report"
}

# The bullet lines under this YAML's top-level `report:` key, in order. A
# top-level key is one that starts in column 0, so the block ends at the next
# one.
trunk_detail_yaml_report_lines() {
  local yaml_path="$1"

  awk '
    /^[^[:space:]]/ {
      in_report = ($0 ~ /^report:[[:space:]]*$/)
      next
    }
    in_report && /^[[:space:]]+-[[:space:]]/ { print }
  ' "$yaml_path" 2>/dev/null || true
}

# True when the path is exactly the shape Trunk writes its failure details to:
# a plain file directly under .trunk/out, with no traversal.
is_trunk_detail_yaml_path() {
  local yaml_path="$1"

  [[ "$yaml_path" =~ ^\.trunk/out/[A-Za-z0-9._-]+\.yaml$ ]] || return 1
  [[ "$yaml_path" == *".."* ]] && return 1
  return 0
}

# Reduce a failed `trunk check` transcript to the facts the classifier needs.
# Emits, on stdout, zero or more of:
#   shape=tools           Trunk reported zero issues and N counted failures,
#                         and exactly N rows were download steps naming a
#                         detail YAML.
#   yaml=<path>           one per such row.
#   shape=plugin          every line that was not launcher progress chrome was a
#                         plugin-download error.
#   plugincause=<text>    one per such line.
# It emits nothing when the transcript shows findings, an unexplained failure,
# or any line it cannot account for.
summarize_trunk_check_transcript() {
  local output_file="$1"

  awk '
    function strip(s) {
      gsub(/\033\[[0-9;?]*[a-zA-Z]/, "", s)
      gsub(/\r/, "", s)
      return s
    }
    # True for a tools/trunk progress line, and nothing else. Both halves are
    # read off that tracked script: the mark is one it emits for a step in
    # progress or a step that succeeded, and the message is one of its own,
    # closed by the ellipsis it appends and an optional " done".
    #
    # The mark set is why the failure mark is absent: a launcher step that
    # FAILED is not chrome, and it must keep disqualifying the transcript.
    function is_launcher_progress(l,   i, rest) {
      for (i = 1; i <= launcher_mark_count; i++) {
        if (index(l, launcher_marks[i]) != 1) continue
        rest = substr(l, length(launcher_marks[i]) + 1)
        if (rest ~ ("^ (Downloading Trunk [^ ]+|Verifying Trunk sha256|" \
          "Unpacking Trunk|Downloading latest Trunk Flaky Tests CLI|" \
          "Unpacking Trunk Flaky Tests CLI)\\.\\.\\.( done)?$")) return 1
      }
      return 0
    }
    BEGIN {
      cross = "\342\234\226"
      # tools/trunk SUCCESS_MARK, then the eight PROGRESS_MARKS it cycles.
      launcher_mark_count = split("\342\234\224 \342\241\277 \342\242\277 " \
        "\342\243\273 \342\243\275 \342\243\276 \342\243\267 \342\243\257 " \
        "\342\243\237", launcher_marks, " ")
      disqualified = 0
      declared = -1
      rows = 0
      plugins = 0
      nonblank = 0
    }
    {
      line = strip($0)
      sub(/[ \t]+$/, "", line)
      if (line ~ /^[ \t]*$/) next

      # tools/trunk is the launcher, and on a cold cache it installs the pinned
      # CLI before running it, so the check transcript opens with the launcher
      # progress lines. They are chrome, not a claim about the code, and the
      # shape-2 rule below requires the transcript to hold nothing else.
      if (is_launcher_progress(line)) next

      nonblank++

      trimmed = line
      sub(/^[ \t]+/, "", trimmed)

      # These section headers appear only when Trunk has something to report
      # about the code itself. Their presence alone disqualifies the run.
      if (trimmed == "ISSUES" || trimmed == "AUTOFIXES") {
        disqualified = 1
        next
      }

      if (index(line, cross) == 1) {
        rest = substr(line, length(cross) + 1)
        sub(/^ /, "", rest)

        if (rest ~ /^No issues, [0-9]+ failures?$/) {
          if (declared >= 0) { disqualified = 1; next }
          n = rest
          sub(/^No issues, /, "", n)
          sub(/ failures?$/, "", n)
          declared = n + 0
          next
        }

        if (rest ~ /^Unable to download plugin .+: .+$/) {
          plugins++
          # Kept whole: the URL names the host that has to be allowlisted, and
          # the reason after it is what the signature check reads.
          causes[plugins] = rest
          pluginline[nonblank] = 1
          next
        }

        # Any other verdict line is a claim about the code. Stop.
        disqualified = 1
        next
      }

      # A FAILURES-table row for a step that had to fetch something. The last
      # field is the detail YAML Trunk wrote for it.
      if (line ~ /^[ \t]/ &&
          (index(line, "Installing hermetic tool ") > 0 ||
           index(line, "Downloading hermetic ") > 0)) {
        $0 = line
        if ($NF ~ /^\.trunk\/out\/[A-Za-z0-9._-]+\.yaml$/) {
          rows++
          yamls[rows] = $NF
          next
        }
      }
    }
    END {
      if (disqualified) exit 0

      # Shape 1: Trunk ran, found nothing, and every failure it counted is a
      # download step we recognized. An unaccounted failure means rows < declared.
      if (declared >= 1 && rows == declared) {
        print "shape=tools"
        for (i = 1; i <= rows; i++) print "yaml=" yamls[i]
        exit 0
      }

      # Shape 2: Trunk could not fetch its plugin sources, so it never linted
      # anything. Accepted only when the transcript holds nothing else at all,
      # launcher progress chrome aside.
      if (plugins >= 1 && declared < 0 && rows == 0) {
        for (i = 1; i <= nonblank; i++) {
          if (!(i in pluginline)) exit 0
        }
        print "shape=plugin"
        for (i = 1; i <= plugins; i++) print "plugincause=" causes[i]
      }
    }
  ' "$output_file"
}

# True when a failed `trunk check` is provably an environment provisioning
# failure with no lint findings behind it. Publishes the accepted shape in
# trunk_check_blocked_shape, because the two shapes need different remedies.
trunk_check_output_is_environment_blocked() {
  local output_file="$1"
  local shape=""
  local line
  local value
  local evidence=0

  trunk_check_blocked_shape=""

  [[ -n "$output_file" && -s "$output_file" ]] || return 1

  while IFS= read -r line; do
    case "$line" in
      shape=*)
        shape="${line#shape=}"
        ;;
      yaml=*)
        value="${line#yaml=}"
        trunk_detail_yaml_reports_network_failure "$value" || return 1
        evidence=$((evidence + 1))
        ;;
      plugincause=*)
        value="${line#plugincause=}"
        trunk_plugin_cause_is_environment_blocked "$value" || return 1
        evidence=$((evidence + 1))
        ;;
    esac
  done < <(summarize_trunk_check_transcript "$output_file")

  [[ -n "$shape" && "$evidence" -ge 1 ]] || return 1
  trunk_check_blocked_shape="$shape"
  return 0
}

# The single question both run paths ask about a failed Trunk arm. Sets
# trunk_environment_blocked_kind for the warning and latches the run-level flag
# the closing note and the stamp guard read.
trunk_arm_is_environment_blocked() {
  local output_file="$1"

  trunk_environment_blocked_kind=""

  if trunk_provisioning_is_blocked; then
    trunk_environment_blocked_kind=launcher
  elif trunk_check_output_is_environment_blocked "$output_file"; then
    # The plugin shape gets its own warning: Trunk aborted before it downloaded
    # a single linter, so the linter warning would describe the wrong failure
    # and name a remedy that does not apply.
    if [[ "$trunk_check_blocked_shape" == plugin ]]; then
      trunk_environment_blocked_kind=plugin
    else
      trunk_environment_blocked_kind=linters
    fi
  else
    return 1
  fi

  trunk_arm_environment_blocked=true
  return 0
}

# A parallel or sanitized command shell cannot mutate this parent shell's
# cached launcher-probe state. Its authenticated result file carries that
# verdict back. Prefer that verdict, then classify download failures
# from the command transcript in this process.
trunk_arm_is_environment_blocked_with_launcher_verdict() {
  local output_file="$1"
  local launcher_blocked="$2"

  trunk_environment_blocked_kind=""

  if [[ "$launcher_blocked" == true ]]; then
    trunk_provisioning_state=blocked
    trunk_environment_blocked_kind=launcher
    trunk_arm_environment_blocked=true
    return 0
  fi

  # A false authenticated worker verdict means its in-lease launcher probe
  # succeeded. Do not probe again after the command lease is released.
  trunk_provisioning_state=ok
  if trunk_check_output_is_environment_blocked "$output_file"; then
    if [[ "$trunk_check_blocked_shape" == plugin ]]; then
      trunk_environment_blocked_kind=plugin
    else
      trunk_environment_blocked_kind=linters
    fi
    trunk_arm_environment_blocked=true
    return 0
  fi

  return 1
}

print_trunk_environment_blocked_warning() {
  local command="$1"
  local output_file="${2:-}"

  if [[ "$trunk_environment_blocked_kind" == plugin ]]; then
    print_trunk_plugin_environment_blocked_warning "$command" "$output_file"
    return
  fi

  if [[ "$trunk_environment_blocked_kind" == linters ]]; then
    print_trunk_linter_environment_blocked_warning "$command" "$output_file"
    return
  fi

  print_trunk_launcher_environment_blocked_warning "$command"
}

# Trunk fetches its plugin sources before it lints anything, so this failure
# happened before any linter existed to run. The remedy differs too: the
# measured cloud case is a credential proxy gating github.com per session, and
# widening the environment's allowed domains cannot lift that.
print_trunk_plugin_environment_blocked_warning() {
  local command="$1"
  local output_file="$2"

  echo "warning: skipping ${command} — Trunk could not fetch its plugin sources." >&2
  echo "  The CLI itself is installed — the launcher probe succeeded — but Trunk downloads the" >&2
  echo "  linter definitions it needs before it lints anything, and that download failed. It" >&2
  echo "  aborted before running a single linter, so no finding is being discarded here." >&2
  echo "  Where the host below is simply not allowlisted, add it to the environment's allowed" >&2
  echo "  domains. A Claude cloud session is the exception: its credential proxy gates" >&2
  echo "  github.com per session and answers HTTP 403, and no allowed-domains entry lifts that." >&2
  echo "  There the fix is a prewarmed Trunk cache — \$TRUNK_CACHE, else \$XDG_CACHE_HOME/trunk," >&2
  echo "  else ~/.cache/trunk — or CI." >&2
  print_trunk_provisioning_failure_causes "$output_file"
  echo "  CI still enforces Trunk on the PR (.github/workflows/trunk.yml)." >&2
}

print_trunk_linter_environment_blocked_warning() {
  local command="$1"
  local output_file="$2"

  echo "warning: skipping ${command} — Trunk could not provision its linters." >&2
  echo "  The CLI itself is installed — the launcher probe succeeded — but Trunk downloads each" >&2
  echo "  hermetic runtime and linter binary it needs, and every step that had to fetch one" >&2
  echo "  failed with a download error. Trunk reported no issues, so no finding is being" >&2
  echo "  discarded here; it never got a linter to run." >&2
  echo "  This is what an environment that allows 'trunk.io' but not the download hosts does." >&2
  echo "  Add the hosts named below to the environment's allowed domains to run it here." >&2
  print_trunk_provisioning_failure_causes "$output_file"
  echo "  CI still enforces Trunk on the PR (.github/workflows/trunk.yml)." >&2
}

# Replay what Trunk recorded for each failed download step. The step row names
# only the step; the host and the reason live in the detail YAML, and without
# them the warning cannot say which domain to allowlist. Bounded on every axis
# because the text comes from a subprocess.
print_trunk_provisioning_failure_causes() {
  local output_file="$1"
  local line
  local yaml_path
  local detail
  local printed=0

  [[ -n "$output_file" && -s "$output_file" ]] || return 0

  while IFS= read -r line; do
    [[ "$printed" -lt 8 ]] || break
    case "$line" in
      yaml=*)
        yaml_path="${line#yaml=}"
        ;;
      plugincause=*)
        printed=$((printed + 1))
        printf '  %.240s\n' "  ${line#plugincause=}" >&2
        continue
        ;;
      *)
        continue
        ;;
    esac

    is_trunk_detail_yaml_path "$yaml_path" || continue
    [[ -f "$yaml_path" ]] || continue
    while IFS= read -r detail; do
      [[ "$printed" -lt 8 ]] || break
      printed=$((printed + 1))
      printf '  %.240s\n' "  ${detail}" >&2
    done < <(
      {
        awk '/^title:/ { sub(/^title:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit }' \
          "$yaml_path" 2>/dev/null || true
        trunk_detail_yaml_report_lines "$yaml_path" |
          sed -e 's/^[[:space:]]*-[[:space:]]*//' -e 's/^"//' -e 's/"$//'
      } | head -n 4
    )
  done < <(summarize_trunk_check_transcript "$output_file")

  # The parallel run path calls this under `set -e`, and it is not the last
  # statement in its caller. A loop that ends on a failed match would otherwise
  # abort the run at the exact moment the gate is trying to degrade gracefully.
  return 0
}

print_trunk_launcher_environment_blocked_warning() {
  local command="$1"
  echo "warning: skipping ${command} — the Trunk CLI could not be provisioned." >&2
  echo "  The launcher self-downloads the pinned CLI from trunk.io and could not produce a" >&2
  echo "  working one here. The probe reports that it failed, not why." >&2
  echo "  Most often the environment blocks the download:" >&2
  echo "  Add 'trunk.io' and '*.trunk.io' to the environment's allowed domains to run it here." >&2
  echo "  A local cause — a corrupt or unwritable launcher cache — prints this same warning." >&2
  echo "  Run './tools/trunk --version' to see the launcher's own error." >&2
  echo "  CI still enforces Trunk on the PR (.github/workflows/trunk.yml)." >&2
}

is_autoreview_test_command() {
  local command="$1"
  case "$command" in
    *"pnpm agent:autoreview:test"*|*"bash scripts/agent-autoreview.test.sh"*)
      return 0
      ;;
  esac

  return 1
}

latest_autoreview_test_progress() {
  local output_file="$1"
  awk '
    length($0) <= 512 &&
      $0 ~ /^AUTOREVIEW_TEST_PROGRESS family=[[:alnum:]_,-]+ elapsed=[0-9]+s$/ {
      latest = $0
    }
    END {
      if (latest != "") {
        print latest
      }
    }
  ' "$output_file"
}

print_autoreview_test_timings() {
  local output_file="$1"
  # A canonical run currently has only a handful of families. Cap accepted
  # protocol lines defensively so a noisy child cannot flood otherwise-quiet
  # successful gate output while preserving each accepted marker verbatim.
  awk '
    count < 32 && length($0) <= 512 &&
      $0 ~ /^AUTOREVIEW_TEST_TIMING family=[[:alnum:]_-]+ status=(ok|failed) elapsed=[0-9]+s$/ {
      print
      count++
    }
  ' "$output_file"
}

log_duration_line() {
  # Best-effort append; a logging failure must never fail the gate itself.
  local status="$1"
  local elapsed="$2"
  local command="$3"
  local line_mode="$4"
  local ts

  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 0
  # This single-quoted program is JavaScript.
  # shellcheck disable=SC2016
  node -e '
    const [ts, command, status, seconds, mode, requestId, sequence, role] = process.argv.slice(1);
    process.stdout.write(`${JSON.stringify({
      ts, command, status, seconds: Number(seconds), mode,
      requestId: requestId || undefined,
      sequence: sequence ? Number(sequence) : undefined,
      role: role || undefined,
    })}\n`);
  ' "$ts" "$command" "$status" "$elapsed" "$line_mode" \
    "${gate_coordinator_request_id:-}" "${gate_coordinator_sequence:-}" \
    "${gate_coordinator_role:-}" >> "$durations_file" 2>/dev/null || true
}

record_command_summary() {
  local status="$1"
  local elapsed="$2"
  local command="$3"
  command_summaries+=("${status}|${elapsed}|${command}")
  log_duration_line "$status" "$elapsed" "$command" "$mode" || true
}

print_command_summary() {
  local entry
  local status
  local elapsed
  local elapsed_and_command
  local command

  if [[ ${#command_summaries[@]} -eq 0 ]]; then
    return
  fi

  echo
  echo "Command elapsed-time summary:"
  for entry in "${command_summaries[@]+"${command_summaries[@]}"}"; do
    status="${entry%%|*}"
    elapsed_and_command="${entry#*|}"
    elapsed="${elapsed_and_command%%|*}"
    command="${elapsed_and_command#*|}"
    echo "- ${status} $(format_duration "$elapsed") ${command}"
  done
}

monitor_sequential_autoreview_progress() {
  local command="$1"
  local output_file="$2"
  local start_ts="$3"
  local done_file="$4"
  local parent_pid="$5"
  local last_heartbeat_ts="$start_ts"
  local heartbeat_interval=20
  local now_ts

  exec 24<&- 2>/dev/null || true

  while [[ ! -e "$done_file" ]] && kill -0 "$parent_pid" 2>/dev/null; do
    sleep 1
    if [[ -e "$done_file" ]] || ! kill -0 "$parent_pid" 2>/dev/null; then
      break
    fi
    now_ts="$(date +%s)"
    if [[ $((now_ts - last_heartbeat_ts)) -ge "$heartbeat_interval" ]]; then
      printf '⏳ still running after %s:\n' "$(format_duration $((now_ts - start_ts)))"
      printf '    · %s\n' "$command"
      latest_autoreview_test_progress "$output_file"
      last_heartbeat_ts="$now_ts"
    fi
  done
}

# Portable per-command watchdog. macOS ships no timeout(1), so run the command
# in the background, arm a background killer, and reap. On timeout the command's
# whole process tree is signalled (TERM, then KILL after a short grace) so child
# processes (pnpm -> node, etc.) do not survive. Sets last_command_timed_out and
# returns the command's exit status; a signal-death is remapped to a normal
# failure code (see below). Applies per command only, never to the whole run.
mapped_command_timeout_seconds() {
  case "$1" in
    "pnpm agent:quality-gate:test"|"bash scripts/agent-quality-gate.test.sh")
      printf '%s\n' "$gate_selftest_timeout_seconds"
      ;;
    *)
      printf '%s\n' "$command_timeout_seconds"
      ;;
  esac
}

gate_command_lifecycle_uses_legacy_owner() {
  local token="$1"
  [[ -n "$gate_lock_dir" && -n "$gate_lock_token" &&
    "$token" == "$gate_lock_token" ]] || return 1
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active; then
    return 1
  fi
  return 0
}

gate_abandon_unstarted_command_lifecycle() {
  local token="$1"
  local settlement_owner="${2:-worker}"
  local lineage_status=0
  case "$settlement_owner" in
    worker) ;;
    parent)
      # The parallel parent registered this exact drain identity before it let
      # the worker run. Leave both the coordinator lease and Darwin state in
      # place. If the parent crashes, the coordinator can still turn that
      # lease into a recovery obligation backed by the retained state.
      if [[ "$active_timeout_drain_identity" == "$token" ]]; then
        active_timeout_drain_identity=""
        active_timeout_lifecycle_contract=""
      fi
      return 0
      ;;
    *) return 2 ;;
  esac
  if declare -F gate_coordinator_abandon_active_lease >/dev/null 2>&1; then
    if ! gate_coordinator_abandon_active_lease; then
      echo "error: the unstarted command lease could not be abandoned." >&2
      echo "Its Darwin lineage state remains available for recovery." >&2
      return 2
    fi
  fi
  if gate_command_lifecycle_uses_legacy_owner "$token"; then
    gate_darwin_lineage_settle "$token" 1 || lineage_status=$?
  else
    gate_darwin_lineage_settle "$token" || lineage_status=$?
  fi
  if [[ "$lineage_status" -ne 0 ]]; then
    echo "error: unstarted mapped-command lineage state could not be discharged." >&2
    return 2
  fi
  if [[ "$active_timeout_drain_identity" == "$token" ]]; then
    active_timeout_drain_identity=""
    active_timeout_lifecycle_contract=""
  fi
}

gate_abandon_verified_unbound_command_lifecycle() {
  local token="$1"
  local settlement_owner="${2:-worker}"
  local lineage_status=0
  case "$settlement_owner" in
    worker) ;;
    parent)
      # The registered parallel parent owns the pre-START lease and lineage.
      # It resolves both after the worker reports its unstarted result.
      if [[ "$active_timeout_drain_identity" == "$token" ]]; then
        active_timeout_drain_identity=""
        active_timeout_lifecycle_contract=""
      fi
      return 0
      ;;
    *) return 2 ;;
  esac
  if declare -F gate_coordinator_abandon_active_lease >/dev/null 2>&1; then
    if ! gate_coordinator_abandon_active_lease; then
      echo "error: the unstarted command lease could not be abandoned." >&2
      echo "Its unbound Darwin lineage state remains available for recovery." >&2
      return 2
    fi
  fi
  if [[ -n "${gate_coordinator_active_lease_id:-}" ]]; then
    echo "error: the unstarted command lease remains active after abandonment." >&2
    echo "Its unbound Darwin lineage state remains available for recovery." >&2
    return 2
  fi
  if gate_command_lifecycle_uses_legacy_owner "$token"; then
    gate_darwin_lineage_settle "$token" 1 || lineage_status=$?
  else
    gate_darwin_lineage_abandon_unstarted "$token" || lineage_status=$?
  fi
  if [[ "$lineage_status" -ne 0 ]]; then
    echo "error: unstarted mapped-command lineage state was not verified as unbound." >&2
    return 2
  fi
  if [[ "$active_timeout_drain_identity" == "$token" ]]; then
    active_timeout_drain_identity=""
    active_timeout_lifecycle_contract=""
  fi
}

gate_run_darwin_lineage_watcher_after_barrier() {
  local barrier_file="$1"
  local node_bin="$2"
  local module="$3"
  local state_file="$4"
  local state_directory="$5"
  local controller_identity="$6"
  local action_file="$7"
  local armed_file="$8"
  local timeout_seconds="$9"
  local action

  trap - EXIT INT TERM HUP
  exec 23< "$barrier_file" || return 127
  exec 22>&-
  IFS= read -r action <&23 || return 127
  [[ "$action" == start ]] || return 127
  exec 23<&-
  exec </dev/null
  exec 6>&- 7>&- 8>&- 9>&- 14>&- 15>&- 16>&- 17>&- 18>&- 19>&- \
    20>&- 21>&- 22>&- 24>&- 25>&- 26>&-
  exec /usr/bin/env \
    -u NODE_OPTIONS \
    -u NODE_PATH \
    -u OPENSSL_CONF \
    -u OPENSSL_MODULES \
    -u GLIBC_TUNABLES \
    -u LD_AUDIT \
    -u LD_DEBUG \
    -u LD_DEBUG_OUTPUT \
    -u LD_PRELOAD \
    -u LD_LIBRARY_PATH \
    -u LD_ORIGIN_PATH \
    -u LD_PROFILE \
    -u LD_SHOW_AUXV \
    -u DYLD_INSERT_LIBRARIES \
    -u DYLD_LIBRARY_PATH \
    -u DYLD_FRAMEWORK_PATH \
    -u DYLD_FALLBACK_LIBRARY_PATH \
    -u DYLD_FALLBACK_FRAMEWORK_PATH \
    -u DYLD_IMAGE_SUFFIX \
    -u DYLD_PRINT_TO_FILE \
    -u DYLD_ROOT_PATH \
    -u DYLD_SHARED_REGION \
    -u DYLD_VERSIONED_FRAMEWORK_PATH \
    -u DYLD_VERSIONED_LIBRARY_PATH \
    -u AGENTQG_RUN \
    -u AGENTQG_REQUEST \
    -u AGENTQG_MARKER_FDS \
    "$node_bin" "$module" watch-settle \
      --state "$state_file" \
      --state-directory "$state_directory" \
      --scratch "$scratch_dir" \
      --controller-identity "$controller_identity" \
      --cancel-file "$action_file" \
      --armed-file "$armed_file" \
      --timeout-seconds "$timeout_seconds"
}

run_with_timeout() {
  local command="$1"
  local deferred_lease_file="${2:-}"
  local command_drain_identity="${3:-}"
  local trunk_probe_handshake_file="${4:-}"
  local cmd_pid
  local cmd_start
  local watchdog_pid
  local watchdog_start
  local watchdog_reaped=0
  local lineage_watcher_pid=""
  local lineage_watcher_start=""
  local cmd_exact_identity=""
  local watchdog_exact_identity=""
  local lineage_watcher_exact_identity=""
  local rc
  local release_rc=0
  local drain_rc=0
  local lineage_bind_rc=0
  local provisioning_probe_rc=0
  local timeout_marker
  local had_errexit=0
  local command_started_at
  local command_finished_at
  local effective_command_timeout_seconds
  local command_barrier_dir
  local command_control_fifo
  local command_status_file
  local command_settlement_ack_file
  local trunk_probe_result_file=""
  local trunk_probe_result=""
  local trunk_probe_deadline=0
  local trunk_probe_completed=0
  local trunk_probe_ready_observed=0
  local trunk_probe_root_exited=0
  local trunk_guardian_pending_file=""
  local trunk_guardian_done_file=""
  local trunk_guardian_signal_fifo=""
  local trunk_guardian_signal_read_open=0
  local trunk_guardian_signal_write_open=0
  local trunk_guardian_signal_fd=""
  local trunk_guardian_started_at=""
  local trunk_guardian_wait_deadline=""
  local trunk_guardian_handshake_rc=0
  local trunk_guardian_status_deadline=""
  local lineage_watcher_barrier_dir=""
  local lineage_watcher_control_fifo=""
  local lineage_watcher_action_file=""
  local lineage_watcher_armed_file=""
  local lineage_watcher_output_file=""
  local lineage_watcher_stderr_file=""
  local lineage_watcher_state_directory=""
  local lineage_watcher_timeout_seconds=0
  local lineage_watcher_released=0
  local lineage_watcher_armed=0
  local lineage_watcher_reaped=0
  local lineage_watcher_result=""
  local lineage_watcher_result_bytes=""
  local lineage_watcher_wait_rc=0
  local lineage_watcher_module=""
  local lineage_watcher_setup_rc=0
  local command_reported_status=""
  local pre_settlement_command_status=""
  local executable_command="$command"
  local command_lineage_token
  local command_lifecycle_contract
  local resume_legacy_owner_lineage=0
  local mapped_command_parent_pid="${gate_mapped_command_parent_pid:-$$}"
  local darwin_exact_active=0
  local forced_exact_settlement=0
  local coordinator_lineage_release_required=0
  local coordinator_marker="${gate_coordinator_marker_file:-}"
  local request_marker command_marker command_tag request_tag
  local coordinator_release_deferred=0
  local close_parallel_worker_control_fd=0
  local unstarted_settlement_owner=worker

  if [[ -n "$deferred_lease_file" ]]; then
    close_parallel_worker_control_fd=1
    unstarted_settlement_owner=parent
  fi

  # A `wait` that reaps a SIGTERM/SIGKILL-killed child makes bash re-raise that
  # signal at the next `return`, which would kill the gate. Run the reaping with
  # errexit off and remap any >128 status to an ordinary failure so the caller
  # (and its `if ! run_mapped_command` / status-file plumbing) just sees a fail.
  case "$-" in
    *e*) had_errexit=1 ;;
  esac
  set +e

  effective_command_timeout_seconds="$(mapped_command_timeout_seconds "$command")"

  last_command_timed_out=false
  last_command_execution_seconds=0
  last_command_infrastructure_failed=false
  last_command_trunk_provisioning_blocked=false
  last_command_launch_state=unstarted
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active && [[ -z "$command_drain_identity" ]]; then
    parallel_command_sequence=$((parallel_command_sequence + 1))
    if ! command_drain_identity="$(make_parallel_command_drain_identity "$parallel_command_sequence")"; then
      echo "error: could not create a safe command drain identity." >&2
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
  fi
  command_lineage_token="${command_drain_identity:-${gate_run_id:-$gate_lock_token}}"
  command_lifecycle_contract="$(gate_lifecycle_contract_for_host)" || {
    echo "error: could not classify the mapped-command lifecycle contract." >&2
    last_command_infrastructure_failed=true
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  }
  active_timeout_drain_identity="$command_lineage_token"
  active_timeout_lifecycle_contract="$command_lifecycle_contract"
  if [[ -n "$gate_lock_dir" && -n "$gate_lock_token" &&
    "$command_lineage_token" == "$gate_lock_token" ]] && {
    ! declare -F gate_coordinator_is_active >/dev/null 2>&1 ||
      ! gate_coordinator_is_active;
  }; then
    resume_legacy_owner_lineage=1
  fi
  if [[ "$resume_legacy_owner_lineage" -eq 1 ]]; then
    gate_darwin_lineage_resume_owner "$command_lineage_token"
    rc=$?
  else
    gate_darwin_lineage_prepare "$command_lineage_token"
    rc=$?
  fi
  if [[ "$rc" -ne 0 ]]; then
    echo "error: refusing to request a command lease without a complete Darwin process baseline." >&2
    last_command_infrastructure_failed=true
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi
  darwin_exact_active="$gate_darwin_lineage_active"
  if declare -F gate_coordinator_before_command >/dev/null 2>&1; then
    gate_coordinator_before_command "$command" "$command_drain_identity"
    rc=$?
    if [[ "$rc" -ne 0 ]]; then
      gate_abandon_verified_unbound_command_lifecycle \
        "$command_lineage_token" "$unstarted_settlement_owner" || true
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return "$rc"
    fi
    if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
      gate_coordinator_is_active &&
      [[ "${gate_coordinator_active_lifecycle_contract:-}" != "$command_lifecycle_contract" ]]; then
      echo "error: coordinator selected a different mapped-command lifecycle contract." >&2
      gate_abandon_unstarted_command_lifecycle \
        "$command_lineage_token" "$unstarted_settlement_owner" || true
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
    if [[ -n "$deferred_lease_file" ]] && {
      ! declare -F parallel_worker_parent_is_live >/dev/null 2>&1 ||
        ! parallel_worker_parent_is_live;
    }; then
      echo "error: the parallel worker parent exited before command lease activation." >&2
      gate_abandon_unstarted_command_lifecycle \
        "$command_lineage_token" "$unstarted_settlement_owner" || true
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
    if [[ -n "$deferred_lease_file" ]] &&
      declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
      gate_coordinator_is_active; then
      if [[ -z "${gate_coordinator_active_lease_id:-}" ]] ||
        ! write_parallel_worker_lease_record \
          "$deferred_lease_file" \
          "$gate_coordinator_active_lease_id" \
          "$command_lineage_token" \
          "$command_lifecycle_contract"; then
        gate_abandon_unstarted_command_lifecycle \
          "$command_lineage_token" "$unstarted_settlement_owner" || true
        last_command_infrastructure_failed=true
        [[ "$had_errexit" == 1 ]] && set -e
        return 2
      fi
      coordinator_release_deferred=1
    fi
  fi
  # The durable pre-lease baseline closes the grant-without-evidence crash
  # window. Refresh it after scheduler wait and before this process creates the
  # mapped wrapper. Otherwise an unrelated daemon that starts while queued can
  # have a parent chain outside the old baseline and hold settlement closed.
  if ! gate_darwin_lineage_refresh; then
    echo "error: refusing to start a mapped command without a current Darwin process baseline." >&2
    gate_abandon_unstarted_command_lifecycle \
      "$command_lineage_token" "$unstarted_settlement_owner" || true
    last_command_infrastructure_failed=true
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi
  timeout_seq=$((timeout_seq + 1))
  # mktemp guarantees a unique path even across concurrent parallel-pool
  # subshells (BASHPID would too, but stock macOS Bash 3.2 does not define it
  # and this script runs under set -u). The file exists from the start; the
  # timeout signal is CONTENT (non-empty), written by the watchdog.
  timeout_marker="$(mktemp "$scratch_dir/command-timeout.XXXXXX")"

  # Tagged, and deliberately not exec'd: `bash -c "$command"` replaces itself
  # with the command for a simple command line, which would take the tag with
  # it. Keeping the wrapper alive costs one process and buys two things — the
  # command is a child that can be walked, and the wrapper carries this run's
  # token in its own argv, so a later run can find this run's survivors by
  # identity instead of waiting a guessed number of seconds for them.
  # Two inherited handles back that tag up, because the tag dies with the
  # wrapper: the token in the environment, and an open descriptor on the run's
  # marker file. A command that forks a replacement and then exits leaves that
  # replacement reparented with no tagged ancestor to walk from, and only
  # something inherited can still name it. Both are keyed to this run's token.
  # Descriptor-bound validation and a private hard-link witness prevent a
  # replaced shared marker from selecting a stranger.
  gate_run_ensure_marker \
    "The mapped command did not run" \
    "The mapped command did not start."
  request_marker="$gate_run_marker_file"
  request_tag="$(gate_run_request_tag)"
  command_marker="$request_marker"
  command_tag="$(gate_run_command_tag)"
  if [[ -n "$command_drain_identity" ]]; then
    if ! gate_lock_token_is_wellformed "$command_drain_identity"; then
      echo "error: the parallel command drain identity is malformed." >&2
      gate_abandon_unstarted_command_lifecycle \
        "$command_lineage_token" "$unstarted_settlement_owner" || true
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
    if ! gate_run_create_marker_for_identity \
      "$command_drain_identity" \
      "The mapped command did not run" \
      "The mapped command did not start." 0; then
      gate_abandon_unstarted_command_lifecycle \
        "$command_lineage_token" "$unstarted_settlement_owner" || true
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
    command_marker="$gate_run_created_marker_file"
    if [[ -n "$deferred_lease_file" ]]; then
      parallel_worker_command_marker="$command_marker"
    fi
    if declare -p gate_coordinator_active_drain_marker >/dev/null 2>&1; then
      gate_coordinator_active_drain_marker="$command_marker"
    fi
    command_tag="agentqg:${command_drain_identity}"
    if [[ -n "$deferred_lease_file" && -n "$command_marker" ]] &&
      ! exec 18< "$command_marker"; then
      echo "error: could not retain the parallel command marker." >&2
      gate_abandon_unstarted_command_lifecycle \
        "$command_lineage_token" "$unstarted_settlement_owner" || true
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
  fi
  command_barrier_dir="$(mktemp -d "$scratch_dir/command-barrier.XXXXXX")" || {
    echo "error: could not create the mapped-command launch barrier." >&2
    gate_abandon_unstarted_command_lifecycle \
      "$active_timeout_drain_identity" "$unstarted_settlement_owner" || true
    last_command_infrastructure_failed=true
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  }
  /bin/chmod 700 "$command_barrier_dir" || {
    rmdir "$command_barrier_dir" 2>/dev/null || true
    echo "error: could not protect the mapped-command launch barrier." >&2
    gate_abandon_unstarted_command_lifecycle \
      "$active_timeout_drain_identity" "$unstarted_settlement_owner" || true
    last_command_infrastructure_failed=true
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  }
  command_control_fifo="$command_barrier_dir/control"
  command_status_file="$command_barrier_dir/status"
  command_settlement_ack_file="$command_barrier_dir/settlement-ready"
  if ! /usr/bin/mkfifo "$command_control_fifo" ||
    ! : > "$command_status_file" ||
    ! exec 20<> "$command_control_fifo"; then
    rm -f "$command_control_fifo" "$command_status_file" \
      "$command_settlement_ack_file"
    rmdir "$command_barrier_dir" 2>/dev/null || true
    echo "error: could not open the mapped-command launch barrier." >&2
    gate_abandon_unstarted_command_lifecycle \
      "$active_timeout_drain_identity" "$unstarted_settlement_owner" || true
    last_command_infrastructure_failed=true
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi
  if [[ "$darwin_exact_active" -eq 1 ]] && is_trunk_command "$command"; then
    trunk_guardian_pending_file="$command_barrier_dir/trunk-guardian.pending"
    trunk_guardian_done_file="$command_barrier_dir/trunk-guardian.done"
    trunk_guardian_signal_fifo="$command_barrier_dir/trunk-guardian.signal"
    if ! gate_trunk_guardian_prepare_handshake \
      "$command_barrier_dir" "$trunk_guardian_pending_file" \
      "$trunk_guardian_done_file" ||
      ! /usr/bin/mkfifo "$trunk_guardian_signal_fifo" ||
      ! exec 27<> "$trunk_guardian_signal_fifo" ||
      ! exec 26< "$trunk_guardian_signal_fifo" ||
      ! exec 25> "$trunk_guardian_signal_fifo"; then
      exec 27>&- || true
      exec 26<&- || true
      exec 25>&- || true
      echo "error: could not create the Trunk guardian lifecycle handshake." >&2
      exec 20>&-
      gate_abandon_unstarted_command_lifecycle \
        "$active_timeout_drain_identity" "$unstarted_settlement_owner" || true
      /bin/rm -f -- "$command_control_fifo" "$command_status_file" \
        "$command_settlement_ack_file" "$trunk_guardian_pending_file" \
        "$trunk_guardian_done_file" "${trunk_guardian_done_file}.tmp" \
        "$trunk_guardian_signal_fifo"
      rmdir "$command_barrier_dir" 2>/dev/null || true
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
    exec 27>&-
    trunk_guardian_signal_read_open=1
    trunk_guardian_signal_write_open=1
    trunk_guardian_signal_fd=25
    if ! /bin/rm -f -- "$trunk_guardian_signal_fifo"; then
      exec 25>&-
      exec 26<&-
      trunk_guardian_signal_write_open=0
      trunk_guardian_signal_read_open=0
      echo "error: could not unlink the Trunk guardian completion capability." >&2
      exec 20>&-
      gate_abandon_unstarted_command_lifecycle \
        "$active_timeout_drain_identity" "$unstarted_settlement_owner" || true
      gate_trunk_guardian_cleanup_handshake \
        "$trunk_guardian_pending_file" "$trunk_guardian_done_file" || true
      rm -f "$command_control_fifo" "$command_status_file" \
        "$command_settlement_ack_file"
      rmdir "$command_barrier_dir" 2>/dev/null || true
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
  fi
  command_started_at="$(date +%s)"
  if declare -p gate_coordinator_recovery_drain_context >/dev/null 2>&1; then
    gate_coordinator_recovery_drain_context="active-command"
  fi
  if is_trunk_command "$command"; then
    if [[ "$gate_darwin_lineage_host_platform" == Darwin ]]; then
      trunk_probe_result_file="$trunk_probe_handshake_file"
    fi
    printf -v executable_command 'bash %q%s' \
      "$script_source_dir/gate/trunk-check-once.sh" \
      "${command#./tools/trunk check --ci}"
  fi
  # The sanitized launcher executes this Bash body.
  # shellcheck disable=SC2016
  AGENTQG_RUN="$command_tag" \
    AGENTQG_REQUEST="$request_tag" \
    "${gate_sanitized_bash_launcher[@]}" -c '
      exec 24<&- 2>/dev/null || true
      exec 26<&-
      # Open a read-only copy of the launch FIFO, then close the inherited
      # read/write descriptor. If the gate dies before START, this read sees
      # EOF and no target code runs.
      exec 21< "$8" || exit 127
      exec 20>&-
      IFS= read -r gate_action <&21 || exit 127
      [[ "$gate_action" == start ]] || exit 127
      marker_fds=""
      if [[ -n "$3" ]]; then
        # A marker this wrapper was given but cannot hold open is a refusal,
        # not a shrug: without the descriptor, a replacement this command
        # forks is invisible to the next run.
        if [[ ! -r "$3" ]]; then
          echo "error: cannot open the run marker $3; refusing to start the command" >&2
          exit 127
        fi
        exec 9< "$3"
        marker_fds=9
      fi
      if [[ -n "$4" && "$4" != "$3" ]]; then
        if [[ ! -r "$4" ]]; then
          echo "error: cannot open the request marker $4; refusing to start the command" >&2
          exit 127
        fi
        exec 8< "$4"
        marker_fds="${marker_fds:+${marker_fds},}8"
      fi
      if [[ -n "$5" && "$5" != "$3" && "$5" != "$4" ]]; then
        if [[ ! -r "$5" ]]; then
          echo "error: cannot open the coordinator marker $5; refusing to start the command" >&2
          exit 127
        fi
        exec 6< "$5"
        marker_fds="${marker_fds:+${marker_fds},}6"
      fi
      export AGENTQG_MARKER_FDS="$marker_fds"
      if [[ "$6" == 1 ]]; then
        exec 7>&-
      fi
      if [[ "$7" == 1 ]]; then
        # fd17 is the private parallel-worker launch/sentinel pipe. Mapped
        # code must never inherit a writer that can release its group anchor.
        exec 17>&-
      fi
      if [[ -n "${10}" ]]; then
        export AGENTQG_TRUNK_GUARDIAN_PENDING="${10}"
        export AGENTQG_TRUNK_GUARDIAN_DONE="${11}"
        export AGENTQG_TRUNK_CHECK_TIMEOUT_SECONDS="${12}"
        export AGENTQG_TRUNK_GUARDIAN_SIGNAL_FD="${13}"
      fi
      eval "$2"
      command_status=$?
      unset AGENTQG_TRUNK_GUARDIAN_PENDING AGENTQG_TRUNK_GUARDIAN_DONE \
        AGENTQG_TRUNK_CHECK_TIMEOUT_SECONDS AGENTQG_TRUNK_GUARDIAN_SIGNAL_FD
      if [[ -n "${10}" ]]; then
        exec 25>&-
      fi
      printf "%s\n" "$command_status" > "$9" || exit 127
      trunk_probe_ran=0
      while IFS= read -r gate_action <&21; do
        case "$gate_action" in
          probe)
            [[ "$command_status" -ne 0 && "$trunk_probe_ran" -eq 0 &&
              -n "${14}" ]] || exit 127
            trunk_probe_ran=1
            printf "%s\n" ready > "${14}" || exit 127
            if TRUNK_LAUNCHER_QUIET=true \
              ./tools/trunk --version 21<&- >/dev/null 2>&1; then
              trunk_probe_status=0
            else
              trunk_probe_status=$?
            fi
            trunk_probe_ready=""
            if ! {
              IFS= read -r trunk_probe_ready && ! IFS= read -r _
            } < "${14}" || [[ "$trunk_probe_ready" != ready ]]; then
              exit 127
            fi
            if [[ "$trunk_probe_status" -eq 0 ||
              "$trunk_probe_status" -gt 128 ]]; then
              printf "%s\n" ok >> "${14}" || exit 127
            else
              printf "%s\n" blocked >> "${14}" || exit 127
            fi
            ;;
          settle)
            exec 21<&-
            exit "$command_status"
            ;;
          *) exit 127 ;;
        esac
      done
      exit 127
    ' "$command_tag" "$request_tag" \
      "$executable_command" "$command_marker" "$request_marker" "$coordinator_marker" \
      "$gate_coordinator_stdout_reserved" \
      "$close_parallel_worker_control_fd" "$command_control_fifo" \
      "$command_status_file" "$trunk_guardian_pending_file" \
      "$trunk_guardian_done_file" "$effective_command_timeout_seconds" \
      "$trunk_guardian_signal_fd" "$trunk_probe_result_file" &
  cmd_pid=$!
  if ! gate_darwin_lineage_bind_root "$cmd_pid" "$mapped_command_parent_pid"; then
    echo "error: could not bind the mapped-command root to its Darwin kernel identity." >&2
    printf '%s\n' abort >&20 2>/dev/null || true
    exec 20>&-
    wait "$cmd_pid" 2>/dev/null || true
    gate_abandon_unstarted_command_lifecycle \
      "$active_timeout_drain_identity" "$unstarted_settlement_owner" || true
    gate_trunk_guardian_cleanup_handshake \
      "$trunk_guardian_pending_file" "$trunk_guardian_done_file" || true
    rm -f "$command_control_fifo" "$command_status_file" \
      "$command_settlement_ack_file"
    rmdir "$command_barrier_dir" 2>/dev/null || true
    last_command_infrastructure_failed=true
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi
  if ! gate_darwin_exact_child_capture "$cmd_pid" "$mapped_command_parent_pid"; then
    echo "error: could not capture the mapped-command root's Darwin kernel identity." >&2
    printf '%s\n' abort >&20 2>/dev/null || true
    exec 20>&-
    wait "$cmd_pid" 2>/dev/null || true
    gate_abandon_unstarted_command_lifecycle \
      "$active_timeout_drain_identity" "$unstarted_settlement_owner" || true
    gate_trunk_guardian_cleanup_handshake \
      "$trunk_guardian_pending_file" "$trunk_guardian_done_file" || true
    rm -f "$command_control_fifo" "$command_status_file" \
      "$command_settlement_ack_file"
    rmdir "$command_barrier_dir" 2>/dev/null || true
    last_command_infrastructure_failed=true
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi
  cmd_exact_identity="$gate_darwin_exact_identity"
  if ! gate_darwin_broker_preflight; then
    echo "error: Darwin broker source changed before mapped-command dispatch." >&2
    printf '%s\n' abort >&20 2>/dev/null || true
    exec 20>&-
    wait "$cmd_pid" 2>/dev/null || true
    gate_abandon_unstarted_command_lifecycle \
      "$active_timeout_drain_identity" "$unstarted_settlement_owner" || true
    gate_trunk_guardian_cleanup_handshake \
      "$trunk_guardian_pending_file" "$trunk_guardian_done_file" || true
    rm -f "$command_control_fifo" "$command_status_file" \
      "$command_settlement_ack_file"
    rmdir "$command_barrier_dir" 2>/dev/null || true
    last_command_infrastructure_failed=true
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi
  if [[ -n "$deferred_lease_file" ]] && {
    ! declare -F parallel_worker_parent_is_live >/dev/null 2>&1 ||
      ! parallel_worker_parent_is_live;
  }; then
    echo "error: the parallel worker parent exited before mapped-command dispatch." >&2
    printf '%s\n' abort >&20 2>/dev/null || true
    exec 20>&-
    wait "$cmd_pid" 2>/dev/null || true
    gate_abandon_unstarted_command_lifecycle \
      "$command_lineage_token" "$unstarted_settlement_owner" || true
    gate_trunk_guardian_cleanup_handshake \
      "$trunk_guardian_pending_file" "$trunk_guardian_done_file" || true
    rm -f "$command_control_fifo" "$command_status_file" \
      "$command_settlement_ack_file"
    rmdir "$command_barrier_dir" 2>/dev/null || true
    last_command_infrastructure_failed=true
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi
  if [[ "$darwin_exact_active" -eq 1 ]]; then
    lineage_watcher_module="$(gate_darwin_lineage_module)" ||
      lineage_watcher_setup_rc=2
    lineage_watcher_state_directory="${gate_darwin_lineage_state_file%/*}"
    lineage_watcher_timeout_seconds=$((
      effective_command_timeout_seconds +
        gate_lock_orphan_drain_bound_seconds + 90
    ))
    if [[ "$gate_darwin_controller_exact_identity" != agentqg-darwin-exact-v1:pid1-*:* ||
      -z "$lineage_watcher_state_directory" ||
      "$lineage_watcher_timeout_seconds" -gt 86400 ]]; then
      lineage_watcher_setup_rc=2
    fi
    if [[ "$lineage_watcher_setup_rc" -eq 0 ]] &&
      gate_darwin_watcher_control_prepare; then
      lineage_watcher_action_file="$gate_darwin_watcher_action_file"
      lineage_watcher_armed_file="$gate_darwin_watcher_armed_file"
      lineage_watcher_output_file="$gate_darwin_watcher_output_file"
      lineage_watcher_stderr_file="$gate_darwin_watcher_stderr_file"
    else
      lineage_watcher_setup_rc=2
    fi
    if [[ "$lineage_watcher_setup_rc" -eq 0 ]]; then
      lineage_watcher_barrier_dir="$(
        mktemp -d "$scratch_dir/watcher-barrier.XXXXXX"
      )" || lineage_watcher_setup_rc=2
    fi
    if [[ "$lineage_watcher_setup_rc" -eq 0 ]] && {
      ! chmod 700 "$lineage_watcher_barrier_dir" ||
        ! mkfifo "$lineage_watcher_barrier_dir/control";
    }; then
      lineage_watcher_setup_rc=2
    fi
    if [[ "$lineage_watcher_setup_rc" -eq 0 ]]; then
      lineage_watcher_control_fifo="$lineage_watcher_barrier_dir/control"
      if ! exec 22<> "$lineage_watcher_control_fifo"; then
        lineage_watcher_setup_rc=2
      fi
    fi
    if [[ "$lineage_watcher_setup_rc" -eq 0 ]]; then
      gate_run_darwin_lineage_watcher_after_barrier \
        "$lineage_watcher_control_fifo" "$gate_darwin_node_bin" \
        "$lineage_watcher_module" \
        "$gate_darwin_lineage_state_file" \
        "$lineage_watcher_state_directory" \
        "$gate_darwin_controller_exact_identity" \
        "$lineage_watcher_action_file" "$lineage_watcher_armed_file" \
        "$lineage_watcher_timeout_seconds" \
        >"$lineage_watcher_output_file" \
        2>"$lineage_watcher_stderr_file" &
      lineage_watcher_pid=$!
      if gate_darwin_exact_child_capture \
        "$lineage_watcher_pid" "$mapped_command_parent_pid"; then
        lineage_watcher_exact_identity="$gate_darwin_exact_identity"
      else
        lineage_watcher_setup_rc=2
      fi
    fi
    if [[ "$lineage_watcher_setup_rc" -eq 0 ]]; then
      if printf '%s\n' start >&22; then
        lineage_watcher_released=1
      else
        lineage_watcher_setup_rc=2
      fi
      exec 22>&-
    fi
    if [[ "$lineage_watcher_setup_rc" -eq 0 ]] &&
      gate_darwin_watcher_wait_armed \
        "$lineage_watcher_exact_identity" "$lineage_watcher_armed_file"; then
      lineage_watcher_armed=1
    else
      lineage_watcher_setup_rc=2
    fi
    if [[ "$lineage_watcher_setup_rc" -eq 0 &&
      -n "$deferred_lease_file" ]] && {
      ! declare -F parallel_worker_parent_is_live >/dev/null 2>&1 ||
        ! parallel_worker_parent_is_live;
    }; then
      lineage_watcher_setup_rc=2
    fi
    if [[ "$lineage_watcher_setup_rc" -ne 0 ]]; then
      echo "error: could not arm the Darwin lineage watcher before mapped-command dispatch." >&2
      if [[ -n "$lineage_watcher_pid" ]]; then
        if [[ "$lineage_watcher_released" -eq 0 ]]; then
          printf '%s\n' abort >&22 2>/dev/null || true
          exec 22>&- || true
        elif ! gate_darwin_watcher_action_publish \
          "$lineage_watcher_action_file" cancel; then
          [[ -z "$lineage_watcher_exact_identity" ]] ||
            gate_darwin_exact_identity_terminate \
              "$lineage_watcher_exact_identity" \
              "$lineage_watcher_pid" || true
        fi
        wait "$lineage_watcher_pid" 2>/dev/null || true
        lineage_watcher_reaped=1
      else
        exec 22>&- || true
      fi
      printf '%s\n' abort >&20 2>/dev/null || true
      exec 20>&-
      wait "$cmd_pid" 2>/dev/null || true
      gate_abandon_unstarted_command_lifecycle \
        "$active_timeout_drain_identity" "$unstarted_settlement_owner" || true
      gate_trunk_guardian_cleanup_handshake \
        "$trunk_guardian_pending_file" "$trunk_guardian_done_file" || true
      rm -f "$command_control_fifo" "$command_status_file" \
        "$command_settlement_ack_file"
      rmdir "$command_barrier_dir" 2>/dev/null || true
      if [[ -n "$lineage_watcher_control_fifo" ]]; then
        rm -f "$lineage_watcher_control_fifo"
      fi
      if [[ -n "$lineage_watcher_barrier_dir" ]]; then
        rmdir "$lineage_watcher_barrier_dir" 2>/dev/null || true
      fi
      if [[ -n "$lineage_watcher_action_file" ]]; then
        gate_darwin_watcher_control_cleanup \
          "$lineage_watcher_action_file" || true
      fi
      active_timeout_records=()
      active_timeout_exact_identities=()
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
    rm -f "$lineage_watcher_control_fifo"
    rmdir "$lineage_watcher_barrier_dir" 2>/dev/null || true
    cmd_start="$(gate_lock_process_runtime_start "$cmd_pid")"
    lineage_watcher_start="$(
      gate_lock_process_runtime_start "$lineage_watcher_pid"
    )"
    active_timeout_records=(
      "${cmd_pid}|${cmd_start}"
      "${lineage_watcher_pid}|${lineage_watcher_start}"
    )
    active_timeout_exact_identities=(
      "$cmd_exact_identity"
      "$lineage_watcher_exact_identity"
    )
  fi
  if ! printf '%s\n' start >&20; then
    if [[ "$lineage_watcher_armed" -eq 1 ]]; then
      if ! gate_darwin_watcher_action_publish \
        "$lineage_watcher_action_file" cancel; then
        gate_darwin_exact_identity_terminate \
          "$lineage_watcher_exact_identity" \
          "$lineage_watcher_pid" || true
      fi
      wait "$lineage_watcher_pid" 2>/dev/null || true
      lineage_watcher_reaped=1
    fi
    exec 20>&-
    wait "$cmd_pid" 2>/dev/null || true
    gate_abandon_unstarted_command_lifecycle \
      "$active_timeout_drain_identity" "$unstarted_settlement_owner" || true
    gate_trunk_guardian_cleanup_handshake \
      "$trunk_guardian_pending_file" "$trunk_guardian_done_file" || true
    rm -f "$command_control_fifo" "$command_status_file" \
      "$command_settlement_ack_file"
    rmdir "$command_barrier_dir" 2>/dev/null || true
    if [[ -n "$lineage_watcher_action_file" ]]; then
      gate_darwin_watcher_control_cleanup \
        "$lineage_watcher_action_file" || true
    fi
    active_timeout_records=()
    active_timeout_exact_identities=()
    echo "error: could not release the mapped-command launch barrier." >&2
    last_command_infrastructure_failed=true
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi
  last_command_launch_state=started
  if [[ "$trunk_guardian_signal_write_open" -eq 1 ]]; then
    exec 25>&-
    trunk_guardian_signal_write_open=0
  fi
  if [[ -n "$trunk_guardian_pending_file" ]]; then
    trunk_guardian_started_at="$(date +%s)" || trunk_guardian_started_at=""
  fi
  # Run the watchdog via `bash -c` (which execs) rather than a `( … ) &`
  # subshell. A forked subshell inherits bash's saved copy of the caller's
  # redirected stdout — the descriptor bash stashes (close-on-exec) while
  # `run_with_timeout … > file` is in effect — and would hold it open, so a
  # downstream fifo/pipe reader (e.g. the sequential progress monitor) never
  # sees EOF after the gate exits. exec drops that close-on-exec fd; the command
  # above already execs, which is why only the watchdog needed this. The tree
  # kill is inlined because bash -c cannot see this script's functions.
  # The sanitized launcher executes this Bash body.
  # shellcheck disable=SC2016
  "${gate_sanitized_bash_launcher[@]}" -c '
    exec 24<&- 2>/dev/null || true
    exec 25>&-
    exec 26<&-
    exec 7>&-
    if [[ "$6" == 1 ]]; then
      exec 17>&-
    fi
    request_tag="$1"
    cmd_pid="$2"
    timeout_secs="$3"
    marker="$4"
    gate_pid="$5"
    darwin_exact="$8"
    collect_tree() {
      local pid="$1"
      local child
      while IFS= read -r child; do
        [ -n "$child" ] && collect_tree "$child"
      done < <(pgrep -P "$pid" 2>/dev/null || true)
      echo "$pid"
    }
    kill_tree() {
      local tree
      tree="$(collect_tree "$1")"
      while IFS= read -r pid; do
        [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null
      done <<EOF_KILL
$tree
EOF_KILL
      sleep 3
      while IFS= read -r pid; do
        [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null
      done <<EOF_KILL
$tree
EOF_KILL
    }
    # Sleep in steps rather than one shot, because this watchdog outlives its
    # gate: the command is backgrounded, so a SIGKILLed gate shell leaves it
    # running with the lock already reclaimable. Nobody else can see that
    # command — but this process can, and it is the last thing standing that
    # knows the two belong together.
    # Elapsed from the clock, not from the naps it asked for: a watchdog that
    # is descheduled or suspended should still time its command out on the
    # budget it was given rather than on how much sleeping it managed.
    started_at=$(date +%s)
    waited=0
    while [ "$waited" -lt "$timeout_secs" ]; do
      nap=2
      remaining=$((timeout_secs - waited))
      [ "$nap" -le "$remaining" ] || nap="$remaining"
      [ "$nap" -ge 1 ] || nap=1
      sleep "$nap"
      # Teardown on normal command completion kills this watchdog children-first,
      # so the dying sleep must not be mistaken for an elapsed timeout: bash
      # advances past a signal-killed sleep (rc>128) before the watchdog itself
      # receives TERM, and writing the marker in that window reports a false
      # "timed out after Ns" for a command that already succeeded (the race hits
      # reliably on Linux, rarely on macOS).
      [ "$?" -eq 0 ] || exit 0
      if ! kill -0 "$gate_pid" 2>/dev/null; then
        # The gate that started this command is gone without tearing it down,
        # which only happens on SIGKILL or a crash. Its command must not keep
        # running: the lock it held is already reclaimable, so whatever starts
        # next would be sharing the machine with a run that no longer exists.
        # No marker — this is not a timeout, and nobody is left to read it.
        if [ "$darwin_exact" != 1 ]; then
          kill_tree "$cmd_pid"
        fi
        exit 0
      fi
      if ! kill -0 "$cmd_pid" 2>/dev/null; then
        exit 0
      fi
      waited=$(($(date +%s) - started_at))
    done
    echo timeout > "$marker"
    # Give the live gate time to publish its scheduler-wide settlement barrier
    # before this watchdog lets the mapped root exit. A dead gate cannot reply;
    # its coordinator owner-loss path publishes the same barrier.
    settlement_ack="$7"
    barrier_deadline=$(($(date +%s) + 3))
    while [ ! -e "$settlement_ack" ] && kill -0 "$gate_pid" 2>/dev/null &&
      [ "$(date +%s)" -lt "$barrier_deadline" ]; do
      sleep 0.02
    done
    # kill_tree snapshots the whole tree BEFORE TERM: a root that exits on TERM
    # reparents a TERM-ignoring descendant away from the tree, so a post-TERM
    # re-walk would miss it. The KILL pass targets the saved list.
    if [ "$darwin_exact" != 1 ]; then
      kill_tree "$cmd_pid"
    fi
    exit 0
  ' "$command_tag" "$request_tag" \
    "$cmd_pid" "$effective_command_timeout_seconds" "$timeout_marker" "$$" \
    "$close_parallel_worker_control_fd" "$command_settlement_ack_file" \
    "$darwin_exact_active" \
    >/dev/null 2>&1 &
  watchdog_pid=$!
  cmd_start="$(gate_lock_process_runtime_start "$cmd_pid")"
  watchdog_start="$(gate_lock_process_runtime_start "$watchdog_pid")"
  if ! gate_darwin_exact_child_capture \
    "$watchdog_pid" "$mapped_command_parent_pid"; then
    echo "error: could not capture the timeout watchdog's Darwin kernel identity." >&2
    lineage_bind_rc=2
  else
    watchdog_exact_identity="$gate_darwin_exact_identity"
  fi
  if [[ "$darwin_exact_active" -eq 1 ]]; then
    active_timeout_records=(
      "${cmd_pid}|${cmd_start}"
      "${watchdog_pid}|${watchdog_start}"
      "${lineage_watcher_pid}|${lineage_watcher_start}"
    )
    active_timeout_exact_identities=(
      "$cmd_exact_identity"
      "$watchdog_exact_identity"
      "$lineage_watcher_exact_identity"
    )
  else
    active_timeout_records=(
      "${cmd_pid}|${cmd_start}"
      "${watchdog_pid}|${watchdog_start}"
    )
    active_timeout_exact_identities=(
      "$cmd_exact_identity"
      "$watchdog_exact_identity"
    )
  fi

  if [[ -n "$trunk_guardian_pending_file" ]]; then
    if [[ ! "$trunk_guardian_started_at" =~ ^[1-9][0-9]*$ ]]; then
      echo "error: Trunk guardian lifecycle start time is unavailable." >&2
      lineage_bind_rc=2
      trunk_guardian_handshake_rc=2
    else
      trunk_guardian_wait_deadline=$((
        trunk_guardian_started_at + effective_command_timeout_seconds +
          trunk_guardian_completion_bound_seconds
      ))
      if ! gate_trunk_guardian_wait_done \
        "$trunk_guardian_pending_file" "$trunk_guardian_done_file" \
        "$trunk_guardian_wait_deadline" "$mapped_command_parent_pid"; then
        lineage_bind_rc=2
        trunk_guardian_handshake_rc=2
      fi
    fi
    if [[ "$trunk_guardian_signal_read_open" -eq 1 ]]; then
      exec 26<&-
      trunk_guardian_signal_read_open=0
    fi
    if [[ "$trunk_guardian_handshake_rc" -eq 0 ]]; then
      trunk_guardian_status_deadline=$((
        $(date +%s) + trunk_guardian_status_publish_bound_seconds
      ))
      while [[ ! -s "$command_status_file" && ! -s "$timeout_marker" ]]; do
        if ! kill -0 "$cmd_pid" 2>/dev/null; then
          break
        fi
        if gate_lock_process_is_confirmed_zombie "$cmd_pid" "$cmd_start"; then
          break
        fi
        if [[ "$(date +%s)" -ge "$trunk_guardian_status_deadline" ]]; then
          echo "error: mapped Trunk wrapper did not publish its status after authenticated completion." >&2
          lineage_bind_rc=2
          break
        fi
        sleep 0.02 || true
      done
    fi
  else
    while [[ ! -s "$command_status_file" && ! -s "$timeout_marker" ]]; do
      if ! kill -0 "$cmd_pid" 2>/dev/null; then
        break
      fi
      sleep 0.02 || true
    done
  fi
  # A failed Trunk command is not downgraded until the launcher proves that it
  # cannot provision its CLI. After the mapped status is durable, stop only the
  # command watchdog and ask the still-live mapped root to run the probe. The
  # active Darwin watcher then owns the probe and any downloader it forks.
  if [[ "$gate_darwin_lineage_host_platform" == Darwin ]] &&
    is_trunk_command "$command" && [[ -s "$command_status_file" ]]; then
    pre_settlement_command_status="$(
      cat "$command_status_file" 2>/dev/null
    )" || pre_settlement_command_status=""
    if [[ ! "$pre_settlement_command_status" =~ ^[0-9]+$ ||
      "$pre_settlement_command_status" -gt 255 ]]; then
      echo "error: mapped Trunk command returned an invalid pre-settlement status." >&2
      lineage_bind_rc=2
    elif [[ "$pre_settlement_command_status" -ne 0 &&
      ! -s "$timeout_marker" && -z "$trunk_provisioning_state" ]]; then
      # The tracked launcher must exist and be executable before a failed
      # command can enter environment classification. Its absence is a real
      # checkout failure and must retain the original Trunk verdict.
      if [[ ! -x ./tools/trunk ]]; then
        provisioning_probe_rc=1
      elif [[ -n "$watchdog_exact_identity" ]] &&
        gate_darwin_exact_identity_terminate \
          "$watchdog_exact_identity" "$watchdog_pid"; then
        wait "$watchdog_pid" 2>/dev/null || true
        watchdog_reaped=1
      else
        lineage_bind_rc=2
      fi
      if [[ "$watchdog_reaped" -eq 1 && ! -s "$timeout_marker" ]]; then
        if ! printf '%s\n' probe >&20; then
          provisioning_probe_rc=2
        else
          trunk_probe_deadline=$(($(date +%s) + trunk_provisioning_probe_timeout_seconds))
          while [[ "$(date +%s)" -lt "$trunk_probe_deadline" ]]; do
            trunk_probe_result="$(
              read_parallel_worker_result_value \
                "$trunk_probe_result_file" trunk-probe 2>/dev/null
            )" || trunk_probe_result=""
            case "$trunk_probe_result" in
              ready)
                trunk_probe_ready_observed=1
                ;;
              $'ready\nok')
                trunk_probe_ready_observed=1
                trunk_provisioning_state=ok
                trunk_probe_completed=1
                break
                ;;
              $'ready\nblocked')
                trunk_probe_ready_observed=1
                trunk_provisioning_state=blocked
                trunk_probe_completed=1
                break
                ;;
              "") ;;
            esac
            if ! kill -0 "$cmd_pid" 2>/dev/null ||
              gate_lock_process_is_confirmed_zombie "$cmd_pid" "$cmd_start"; then
              trunk_probe_root_exited=1
              break
            fi
            sleep 0.02 || true
          done
          if [[ "$trunk_probe_completed" -eq 0 &&
            "$provisioning_probe_rc" -eq 0 ]]; then
            # The mapped root appends its final record to the durable readiness
            # record. Ignore a partial append while it is live. At the deadline,
            # only `ready` proves that the probe is still in flight.
            trunk_probe_result="$(
              read_parallel_worker_result_value \
                "$trunk_probe_result_file" trunk-probe 2>/dev/null
            )" || trunk_probe_result=""
            case "$trunk_probe_result" in
              $'ready\nok')
                trunk_probe_ready_observed=1
                trunk_provisioning_state=ok
                trunk_probe_completed=1
                ;;
              $'ready\nblocked')
                trunk_probe_ready_observed=1
                trunk_provisioning_state=blocked
                trunk_probe_completed=1
                ;;
              ready)
                trunk_probe_ready_observed=1
                if [[ "$trunk_probe_root_exited" -eq 1 ]] ||
                  ! kill -0 "$cmd_pid" 2>/dev/null ||
                  gate_lock_process_is_confirmed_zombie \
                    "$cmd_pid" "$cmd_start"; then
                  provisioning_probe_rc=2
                fi
                ;;
              *) provisioning_probe_rc=2 ;;
            esac
          fi
          if [[ "$trunk_probe_completed" -eq 0 &&
            "$provisioning_probe_rc" -eq 0 &&
            "$trunk_probe_ready_observed" -eq 1 ]]; then
            # An unresponsive probe leaves the original Trunk failure standing.
            # Final settlement owns the still-live probe before lease release.
            trunk_provisioning_state=ok
          fi
        fi
      fi
    fi
    if [[ "$pre_settlement_command_status" -ne 0 &&
      "$trunk_provisioning_state" == blocked ]]; then
      last_command_trunk_provisioning_blocked=true
    fi
  fi
  if declare -F gate_coordinator_begin_command_settlement >/dev/null 2>&1; then
    if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
      gate_coordinator_is_active &&
      [[ "${gate_coordinator_active_lifecycle_contract:-}" != "$command_lifecycle_contract" ]]; then
      echo "error: coordinator settlement lost the mapped-command lifecycle contract." >&2
      lineage_bind_rc=2
    elif ! gate_coordinator_begin_command_settlement \
      "$command" "$command_lifecycle_contract"; then
      echo "error: coordinator could not publish the mapped-command settlement barrier." >&2
      lineage_bind_rc=2
    fi
  fi
  : > "$command_settlement_ack_file"
  if [[ "$darwin_exact_active" -eq 1 ]]; then
    # Keep the mapped root alive behind its settlement FIFO while the watcher
    # takes the final census. It can then see and own a last descendant fork
    # before it signals descendants deepest-first and the root last.
    forced_exact_settlement=1
    if gate_darwin_watcher_action_publish \
      "$lineage_watcher_action_file" settle; then
      wait "$lineage_watcher_pid" 2>/dev/null
      lineage_watcher_wait_rc=$?
      lineage_watcher_reaped=1
      if [[ "$lineage_watcher_wait_rc" -eq 0 ]]; then
        if IFS= read -r lineage_watcher_result \
          <"$lineage_watcher_output_file"; then
          lineage_watcher_result_bytes="$(
            LC_ALL=C wc -c < "$lineage_watcher_output_file" |
              tr -d '[:space:]'
          )"
        else
          lineage_watcher_result=""
          lineage_watcher_result_bytes=""
        fi
      fi
    fi
    if [[ "$lineage_watcher_wait_rc" -ne 0 ||
      "$lineage_watcher_result" != settled ||
      "$lineage_watcher_result_bytes" != 8 ]]; then
      if [[ "$lineage_watcher_reaped" -eq 0 ]]; then
        if gate_darwin_exact_identity_terminate \
          "$lineage_watcher_exact_identity" "$lineage_watcher_pid"; then
          wait "$lineage_watcher_pid" 2>/dev/null || true
          lineage_watcher_reaped=1
        else
          lineage_bind_rc=2
        fi
      fi
      # The exact watcher is gone before this fallback becomes the settlement
      # writer. Revision-CAS recovery preserves any census it published first.
      if [[ "$lineage_watcher_reaped" -eq 1 ]] &&
        ! gate_darwin_lineage_settle \
          "$active_timeout_drain_identity" 1; then
        lineage_bind_rc=2
      fi
    fi
    if [[ "$lineage_bind_rc" -ne 0 &&
      -s "$lineage_watcher_stderr_file" ]]; then
      cat "$lineage_watcher_stderr_file" >&2 || true
    fi
  fi
  if [[ "$darwin_exact_active" -eq 0 &&
    "$lineage_bind_rc" -eq 0 && "$forced_exact_settlement" -eq 0 ]]; then
    printf '%s\n' settle >&20 2>/dev/null || lineage_bind_rc=2
  else
    printf '%s\n' abort >&20 2>/dev/null || true
  fi
  exec 20>&-
  if [[ "$darwin_exact_active" -eq 1 &&
    "$forced_exact_settlement" -eq 1 &&
    "$lineage_bind_rc" -ne 0 ]]; then
    # Exact lineage evidence failed while the mapped root can still be live.
    # Keep the durable scheduler barrier and return without a blocking wait or
    # a reusable PID signal. A successor can retry from the retained state.
    if [[ -n "$watchdog_exact_identity" ]] &&
      gate_darwin_exact_identity_terminate \
        "$watchdog_exact_identity" "$watchdog_pid"; then
      wait "$watchdog_pid" 2>/dev/null || true
    fi
    gate_trunk_guardian_cleanup_handshake \
      "$trunk_guardian_pending_file" "$trunk_guardian_done_file" || true
    rm -f "$command_control_fifo" "$command_status_file" \
      "$command_settlement_ack_file"
    rmdir "$command_barrier_dir" 2>/dev/null || true
    if [[ "$lineage_watcher_reaped" -eq 1 &&
      -n "$lineage_watcher_action_file" ]]; then
      gate_darwin_watcher_control_cleanup \
        "$lineage_watcher_action_file" || true
    fi
    last_command_infrastructure_failed=true
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi
  wait "$cmd_pid"
  rc=$?
  if [[ -s "$command_status_file" ]]; then
    command_reported_status="$(cat "$command_status_file" 2>/dev/null)" ||
      command_reported_status=""
    if [[ ! "$command_reported_status" =~ ^[0-9]+$ ||
      "$command_reported_status" -gt 255 ]]; then
      echo "error: mapped command returned an invalid barrier status." >&2
      lineage_bind_rc=2
    elif [[ -n "$pre_settlement_command_status" &&
      "$command_reported_status" != "$pre_settlement_command_status" ]]; then
      echo "error: mapped Trunk command status changed during settlement." >&2
      lineage_bind_rc=2
    elif [[ "$lineage_bind_rc" -eq 0 &&
      "$forced_exact_settlement" -eq 0 &&
      "$rc" -ne "$command_reported_status" ]]; then
      echo "error: mapped-command wrapper status changed after settlement." >&2
      lineage_bind_rc=2
    elif [[ "$lineage_bind_rc" -eq 0 &&
      "$darwin_exact_active" -eq 1 &&
      "$forced_exact_settlement" -eq 1 ]]; then
      # The watcher can terminate the wrapper after its authoritative status is
      # durable. Preserve that command result instead of the wrapper signal.
      rc="$command_reported_status"
    fi
  elif [[ ! -s "$timeout_marker" ]]; then
    echo "error: mapped-command root exited before it published a completion status." >&2
    lineage_bind_rc=2
  fi
  gate_trunk_guardian_cleanup_handshake \
    "$trunk_guardian_pending_file" "$trunk_guardian_done_file" || true
  rm -f "$command_control_fifo" "$command_status_file" \
    "$command_settlement_ack_file"
  rmdir "$command_barrier_dir" 2>/dev/null || true

  if [[ -s "$timeout_marker" && "$watchdog_reaped" -eq 0 ]]; then
    # A timeout fired: the watchdog is mid-escalation. Let it finish its KILL
    # pass (bounded by the 3s grace) — killing it here would strand a
    # TERM-ignoring descendant whose root already exited on TERM.
    wait "$watchdog_pid" 2>/dev/null
  elif [[ "$watchdog_reaped" -eq 0 ]]; then
    # Command settled first: tear the watchdog and its pending sleep down so
    # nothing leaks on normal completion.
    if [[ "$gate_darwin_lineage_host_platform" == Darwin ]]; then
      if [[ -n "$watchdog_exact_identity" ]] &&
        gate_darwin_exact_identity_terminate \
          "$watchdog_exact_identity" "$watchdog_pid"; then
        wait "$watchdog_pid" 2>/dev/null
      else
        lineage_bind_rc=2
      fi
    else
      kill_process_tree "$watchdog_pid" TERM
      wait "$watchdog_pid" 2>/dev/null
    fi
  fi
  if [[ "$lineage_bind_rc" -eq 0 ]]; then
    active_timeout_records=()
    active_timeout_exact_identities=()
  fi
  if [[ "$lineage_watcher_reaped" -eq 1 &&
    -n "$lineage_watcher_action_file" ]] &&
    ! gate_darwin_watcher_control_cleanup \
      "$lineage_watcher_action_file"; then
    echo "error: could not retire the Darwin lineage watcher control files." >&2
    lineage_bind_rc=2
  fi
  # Portable hosts retain the existing parent-owned probe. Their tree
  # settlement can bound and reap that probe without Darwin kernel identities.
  if [[ "$gate_darwin_lineage_host_platform" != Darwin &&
    "$rc" -ne 0 && ! -s "$timeout_marker" ]] &&
    is_trunk_command "$command"; then
    if trunk_provisioning_is_blocked \
      "$command_tag" "$request_tag" "$command_marker" "$request_marker" \
      "$coordinator_marker" "$gate_coordinator_stdout_reserved" \
      "$close_parallel_worker_control_fd" "$trunk_probe_handshake_file"; then
      last_command_trunk_provisioning_blocked=true
    else
      provisioning_probe_rc=$?
    fi
  fi
  if [[ -z "$deferred_lease_file" ]]; then
    # A sequential wrapper can exit after it reparents a descendant. Keep the
    # scheduler lease until inherited handles prove that no process from this
    # command remains. Parallel workers defer the same identity drain and lease
    # release to their parent after the registered worker group settles.
    drain_completed_sequential_command || drain_rc=$?
    if [[ "$drain_rc" -eq 0 ]]; then
      active_timeout_drain_identity=""
      active_timeout_lifecycle_contract=""
    fi
  else
    # The parallel parent owns the registered identity and lease settlement.
    # Do not let this worker's EXIT trap race that parent drain.
    active_timeout_drain_identity=""
    active_timeout_lifecycle_contract=""
  fi
  command_finished_at="$(date +%s)"
  last_command_execution_seconds=$((command_finished_at - command_started_at))

  if [[ "$drain_rc" -ne 0 ]]; then
    # The command finished, but its descendants were not confirmed gone. Keep
    # the active lease and recovery marker. The caller prints the captured
    # diagnostics before it returns this infrastructure failure.
    last_command_infrastructure_failed=true
    rm -f "$timeout_marker"
    [[ "$had_errexit" == 1 ]] && set -e
    return "$drain_rc"
  fi

  if [[ "$lineage_bind_rc" -ne 0 ]]; then
    last_command_infrastructure_failed=true
    rm -f "$timeout_marker"
    [[ "$had_errexit" == 1 ]] && set -e
    return "$lineage_bind_rc"
  fi

  if [[ "$provisioning_probe_rc" -eq 2 ]]; then
    # The probe might have started work that only its inherited handles can
    # identify. The drain above settled that identity, but an unclassified
    # launcher failure must not release capacity or become a cloud skip.
    last_command_infrastructure_failed=true
    rm -f "$timeout_marker"
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi

  if [[ -s "$timeout_marker" ]]; then
    last_command_timed_out=true
    rc=1
  elif [[ "$rc" -gt 128 ]]; then
    rc=1
  fi
  rm -f "$timeout_marker"

  if [[ "$coordinator_release_deferred" -eq 0 ]] &&
    declare -F gate_coordinator_after_command >/dev/null 2>&1; then
    if [[ "$darwin_exact_active" -eq 1 ]] &&
      declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
      gate_coordinator_is_active; then
      coordinator_lineage_release_required=1
    fi
    if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
      gate_coordinator_is_active &&
      [[ "${gate_coordinator_active_lifecycle_contract:-}" != "$command_lifecycle_contract" ]]; then
      echo "error: coordinator release lost the mapped-command lifecycle contract." >&2
      release_rc=2
    else
      gate_coordinator_after_command \
        "$command" "$command_lineage_token" "$command_lifecycle_contract"
      release_rc=$?
    fi
    if [[ "$release_rc" -ne 0 ]]; then
      last_command_infrastructure_failed=true
      rc=2
    elif [[ "$coordinator_lineage_release_required" -eq 1 ]] &&
      ! gate_darwin_lineage_discard_settled "$command_lineage_token"; then
      echo "error: could not retire the discharged Darwin lineage state." >&2
      last_command_infrastructure_failed=true
      rc=2
    fi
  fi

  [[ "$had_errexit" == 1 ]] && set -e
  return "$rc"
}

# The whole-run fingerprint (current_stamp) is hashed per-command; identical
# fingerprint + command hash + within-TTL means a previous run already passed
# this exact command against unchanged content, so it can be reused.
command_stamp_key() {
  printf '%s' "$1" | hash_stream
}

# Trunk validates working-tree/repo state cheaply on every invocation, and the
# gate self-test is self-referential (it exercises this very stamp machinery),
# so both must ALWAYS re-execute — never reused, never recorded (issue #1410).
is_stamp_exempt_command() {
  case "$1" in
    "./tools/trunk check --ci"*)
      return 0
      ;;
    "pnpm agent:quality-gate:test"|"bash scripts/agent-quality-gate.test.sh")
      return 0
      ;;
  esac
  return 1
}

# Each record is `<created_at>\t<command-hash>\t<whole-run-fingerprint>`. The
# fingerprint keeps its literal tabs and is the trailing field so it round-trips
# exactly. Fail toward rerun: any parse/IO/format ambiguity returns not-fresh.
command_stamp_is_fresh() {
  local command="$1"
  local target_key
  local now
  local line
  local created_at
  local rest
  local cmd_key
  local fingerprint

  [[ -f "$command_stamps_file" ]] || return 1
  target_key="$(command_stamp_key "$command")"
  now="$(date +%s)"

  while IFS= read -r line || [[ -n "$line" ]]; do
    created_at="${line%%$'\t'*}"
    [[ "$created_at" =~ ^[0-9]+$ ]] || continue
    rest="${line#*$'\t'}"
    cmd_key="${rest%%$'\t'*}"
    fingerprint="${rest#*$'\t'}"
    [[ "$cmd_key" == "$target_key" ]] || continue
    [[ "$fingerprint" == "$current_stamp" ]] || continue
    [[ "$created_at" -le "$now" ]] || continue
    [[ $((now - created_at)) -le "$success_stamp_ttl_seconds" ]] || continue
    return 0
  done < "$command_stamps_file"

  return 1
}

record_command_stamp() {
  local command="$1"
  # Prerequisite outputs (node_modules, generated code) are invisible to the
  # source fingerprint, so prerequisite commands are never stamped or reused.
  # Quality-setup commands (shared-config build, Terraform init/validate) get
  # the same treatment by command classification as well as phase bookkeeping.
  # This keeps the stamp policy tied to command semantics if a caller or phase
  # arrangement changes later.
  [[ "${in_prerequisite_phase:-false}" == true ]] && return 0
  is_quality_setup_command "$command" && return 0
  is_stamp_exempt_command "$command" && return 0
  # Best-effort: a stamp-write failure must never fail the gate.
  printf '%s\t%s\t%s\n' \
    "$(date +%s)" "$(command_stamp_key "$command")" "$current_stamp" \
    >> "$command_stamps_file" 2>/dev/null || true
}

# Keep the file bounded: retain only entries matching this run's fingerprint and
# within the TTL, dropping the rest. Runs once before execution so even a series
# of killed runs cannot grow it without bound. A changed fingerprint (any edited
# validated file) drops every prior entry, which is exactly the required
# content-change invalidation.
prune_command_stamps() {
  [[ -f "$command_stamps_file" ]] || return 0
  local now
  local tmp
  local input_tmp
  local line
  local created_at
  local rest
  local fingerprint

  now="$(date +%s)" || return 1
  tmp="$(mktemp "$scratch_dir/agentqg.XXXXXX")" || return 1
  [[ -n "$tmp" ]] || return 1
  tmpfiles+=("$tmp")
  input_tmp="$(mktemp "$scratch_dir/agentqg.XXXXXX")" || return 1
  [[ -n "$input_tmp" ]] || return 1
  tmpfiles+=("$input_tmp")
  : > "$tmp" || return 1
  cp "$command_stamps_file" "$input_tmp" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    created_at="${line%%$'\t'*}"
    [[ "$created_at" =~ ^[0-9]+$ ]] || continue
    rest="${line#*$'\t'}"
    fingerprint="${rest#*$'\t'}"
    [[ "$fingerprint" == "$current_stamp" ]] || continue
    [[ "$created_at" -le "$now" ]] || continue
    [[ $((now - created_at)) -le "$success_stamp_ttl_seconds" ]] || continue
    printf '%s\n' "$line" >> "$tmp" || return 1
  done < "$input_tmp" || return 1
  mv -f "$tmp" "$command_stamps_file" 2>/dev/null || return 1
}

# Prints the reuse marker and records a `reused` summary entry (NOT counted as
# executed, never logged to durations) when the command was already completed by
# a previous run with the identical fingerprint. Returns 0 when reused (caller
# skips execution), 1 when the command must run.
try_reuse_command() {
  local command="$1"
  # Coordinator fingerprints bind toolchain and material environment inputs
  # that the legacy per-command stamp does not. A coordinator leader must
  # execute rather than promote a weaker local stamp into a shared verdict.
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active; then
    return 1
  fi
  [[ "${in_prerequisite_phase:-false}" == true ]] && return 1
  is_quality_setup_command "$command" && return 1
  is_stamp_exempt_command "$command" && return 1
  command_stamp_is_fresh "$command" || return 1
  echo
  echo "↻ ${command} (fresh from previous run)"
  command_summaries+=("reused|0|${command}")
  stamp_reuse_count=$((${stamp_reuse_count:-0} + 1))
  return 0
}

run_mapped_command() {
  local command="$1"
  local output_file
  local trunk_probe_handshake_file
  local gate_pid="$$"
  local monitor_done_file=""
  local monitor_pid=""
  local start_ts
  local elapsed
  local exit_code
  local infrastructure_failed
  local trunk_provisioning_blocked

  if try_reuse_command "$command"; then
    return 0
  fi

  output_file="$(make_tmpfile)"
  trunk_probe_handshake_file="$(make_tmpfile)"
  tmpfiles+=("$trunk_probe_handshake_file")
  start_ts="$(date +%s)"
  echo
  echo "+ ${command}"
  if is_autoreview_test_command "$command"; then
    monitor_done_file="${output_file}.done"
    tmpfiles+=("$monitor_done_file")
    rm -f "$monitor_done_file"
    monitor_sequential_autoreview_progress \
      "$command" "$output_file" "$start_ts" "$monitor_done_file" "$gate_pid" &
    monitor_pid="$!"
  fi
  set +e
  run_with_timeout "$command" "" "" "$trunk_probe_handshake_file" \
    > "$output_file" 2>&1
  exit_code=$?
  set -e
  local timed_out="$last_command_timed_out"
  infrastructure_failed="$last_command_infrastructure_failed"
  trunk_provisioning_blocked="$last_command_trunk_provisioning_blocked"
  rm -f "$trunk_probe_handshake_file"
  if [[ -n "$monitor_pid" ]]; then
    : > "$monitor_done_file"
    wait "$monitor_pid" 2>/dev/null || true
    rm -f "$monitor_done_file"
  fi
  elapsed="$last_command_execution_seconds"

  if [[ "$exit_code" -eq 0 ]]; then
    sed -n \
      -e '/^A completed mapped command left descendants running; stopping them before releasing its scheduler lease\.$/p' \
      -e "/^The completed mapped command's descendants are gone; releasing its scheduler lease\.$/p" \
      "$output_file"
    record_command_summary "ok" "$elapsed" "$command"
    record_command_stamp "$command"
    if is_autoreview_test_command "$command"; then
      print_autoreview_test_timings "$output_file"
    fi
    echo "✓ ${command} ($(format_duration "$elapsed"))"
    rm -f "$output_file"
    return 0
  fi

  if [[ "$infrastructure_failed" != true && "$timed_out" != true ]] &&
    is_trunk_command "$command" &&
    trunk_arm_is_environment_blocked_with_launcher_verdict \
      "$output_file" "$trunk_provisioning_blocked"; then
    record_command_summary "skipped" "$elapsed" "$command"
    print_trunk_environment_blocked_warning "$command" "$output_file"
    rm -f "$output_file"
    return 0
  fi

  record_command_summary "fail" "$elapsed" "$command"
  if [[ "$timed_out" == true ]]; then
    echo "Command timed out after $(mapped_command_timeout_seconds "$command")s: ${command}" >&2
  else
    echo "Command failed after $(format_duration "$elapsed"): ${command}" >&2
  fi
  filter_expected_output < "$output_file" >&2
  record_failure_output "$command" "$output_file"
  rm -f "$output_file"
  return "$exit_code"
}

run_mapped_command_to_files() {
  local command="$1"
  local output_file="$2"
  local status_file="$3"
  local elapsed_file="$4"
  local timeout_file="$5"
  local infrastructure_file="$6"
  local trunk_provisioning_file="$7"
  local lease_file="$8"
  local command_drain_identity="$9"
  local launch_state_file="${10}"
  local elapsed
  local exit_code

  set +e
  run_with_timeout "$command" "$lease_file" "$command_drain_identity" \
    "$trunk_provisioning_file" > "$output_file" 2>&1
  exit_code=$?
  set -e
  elapsed="$last_command_execution_seconds"

  printf '%s\n' "$exit_code" > "$status_file"
  printf '%s\n' "$elapsed" > "$elapsed_file"
  printf '%s\n' "$last_command_timed_out" > "$timeout_file"
  printf '%s\n' "$last_command_infrastructure_failed" > "$infrastructure_file"
  printf '%s\n' "$last_command_trunk_provisioning_blocked" \
    > "$trunk_provisioning_file"
  printf '%s\n' "$last_command_launch_state" > "$launch_state_file"
}

fail_command_scheduler_infrastructure() {
  local command="$1"
  local teardown_status=0
  echo "error: command scheduler infrastructure failed for: ${command}" >&2
  echo "The quality gate stops before it schedules another command." >&2
  teardown_active_timeouts || teardown_status=$?
  if [[ "$teardown_status" -ne 0 ]]; then
    echo "error: active command teardown after scheduler failure did not complete." >&2
  fi
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active &&
    declare -F gate_coordinator_cancel_and_ack >/dev/null 2>&1; then
    if ! gate_coordinator_cancel_and_ack \
      "command scheduler infrastructure failure" active-command; then
      echo "error: coordinator request cancellation after scheduler failure did not complete." >&2
    fi
  fi
  return 2
}

write_parallel_worker_lease_record() {
  local file="$1"
  local lease_id="${2:-}"
  local drain_identity="${3:-}"
  local lifecycle_contract="${4:-}"
  [[ -f "$file" && ! -L "$file" && -O "$file" ]] || return 1
  [[ "$lease_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || return 1
  gate_lock_token_is_wellformed "$drain_identity" || return 1
  gate_lifecycle_contract_is_supported "$lifecycle_contract" || return 1
  printf 'agentqg-parallel-lease-v1|%s|%s|%s\n' \
    "$lease_id" "$drain_identity" "$lifecycle_contract" > "$file"
}

parallel_worker_lease_id=""
parallel_worker_lease_drain_identity=""
parallel_worker_lease_lifecycle_contract=""

read_parallel_worker_lease_record() {
  local file="$1"
  local expected_drain_identity="${2:-}"
  local expected_lifecycle_contract="${3:-}"
  local value byte_count expected_bytes
  local version lease_id drain_identity lifecycle_contract extra
  parallel_worker_lease_id=""
  parallel_worker_lease_drain_identity=""
  parallel_worker_lease_lifecycle_contract=""
  [[ -f "$file" && ! -L "$file" && -r "$file" && -O "$file" ]] || return 1
  gate_lock_token_is_wellformed "$expected_drain_identity" || return 1
  gate_lifecycle_contract_is_supported "$expected_lifecycle_contract" || return 1
  value="$(cat "$file" 2>/dev/null)" || return 1
  byte_count="$(LC_ALL=C wc -c < "$file" 2>/dev/null | tr -d '[:space:]')" ||
    return 1
  [[ "$byte_count" =~ ^[0-9]+$ ]] || return 1
  expected_bytes=$((${#value} + 1))
  [[ "$byte_count" -eq "$expected_bytes" ]] || return 1
  IFS='|' read -r version lease_id drain_identity lifecycle_contract extra <<< "$value"
  [[ "$value" == "agentqg-parallel-lease-v1|${lease_id}|${drain_identity}|${lifecycle_contract}" ]] ||
    return 1
  [[ "$version" == agentqg-parallel-lease-v1 && -z "$extra" ]] || return 1
  [[ "$lease_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || return 1
  gate_lock_token_is_wellformed "$drain_identity" || return 1
  gate_lifecycle_contract_is_supported "$lifecycle_contract" || return 1
  [[ "$drain_identity" == "$expected_drain_identity" ]] || return 1
  [[ "$lifecycle_contract" == "$expected_lifecycle_contract" ]] || return 1
  parallel_worker_lease_id="$lease_id"
  parallel_worker_lease_drain_identity="$drain_identity"
  parallel_worker_lease_lifecycle_contract="$lifecycle_contract"
}

read_parallel_worker_result_value() {
  local file="$1"
  local field_type="$2"
  local value
  local byte_count
  local expected_bytes
  local maximum

  [[ -f "$file" && ! -L "$file" && -r "$file" ]] || return 1
  value="$(cat "$file" 2>/dev/null)" || return 1
  case "$field_type" in
    status|elapsed)
      [[ "$value" =~ ^[0-9]+$ ]] || return 1
      ;;
    boolean)
      [[ "$value" == true || "$value" == false ]] || return 1
      ;;
    launch-state)
      [[ "$value" == started || "$value" == unstarted ]] || return 1
      ;;
    ready)
      [[ "$value" == ready ]] || return 1
      ;;
    trunk-probe)
      [[ "$value" == ready || "$value" == $'ready\nok' ||
        "$value" == $'ready\nblocked' ]] || return 1
      ;;
    *) return 1 ;;
  esac
  byte_count="$(LC_ALL=C wc -c < "$file" 2>/dev/null | tr -d '[:space:]')" ||
    return 1
  [[ "$byte_count" =~ ^[0-9]+$ ]] || return 1
  expected_bytes=$((${#value} + 1))
  [[ "$byte_count" -eq "$expected_bytes" ]] || return 1
  if [[ "$field_type" == status || "$field_type" == elapsed ]]; then
    while [[ "${#value}" -gt 1 && "$value" == 0* ]]; do
      value="${value#0}"
    done
    if [[ "$field_type" == status ]]; then
      maximum=255
    else
      # Keep later Bash arithmetic within the signed 32-bit range on every
      # supported host. A command cannot legitimately run for 68 years.
      maximum=2147483647
    fi
    [[ "${#value}" -le "${#maximum}" ]] || return 1
    [[ "$value" -le "$maximum" ]] || return 1
  fi
  printf '%s\n' "$value"
}

release_parallel_worker_lease() {
  local command="$1"
  local lease_file="$2"
  local drain_identity="${3:-}"
  local lifecycle_contract="${4:-}"
  local lease_id
  gate_lock_token_is_wellformed "$drain_identity" || return 2
  gate_lifecycle_contract_is_supported "$lifecycle_contract" || return 2
  if ! declare -F gate_coordinator_is_active >/dev/null 2>&1 ||
    ! gate_coordinator_is_active; then
    [[ ! -s "$lease_file" ]] || return 2
    return 0
  fi
  [[ -z "${gate_coordinator_active_lease_id:-}" ]] || return 2
  [[ -z "${gate_coordinator_active_drain_identity:-}" ]] || return 2
  [[ -z "${gate_coordinator_active_lifecycle_contract:-}" ]] || return 2
  read_parallel_worker_lease_record \
    "$lease_file" "$drain_identity" "$lifecycle_contract" || return 2
  lease_id="$parallel_worker_lease_id"
  gate_coordinator_active_lease_id="$lease_id"
  gate_coordinator_active_drain_identity="$parallel_worker_lease_drain_identity"
  gate_coordinator_active_lifecycle_contract="$parallel_worker_lease_lifecycle_contract"
  parallel_release_attempt=$((parallel_release_attempt + 1))
  if [[ -n "$parallel_release_failure_at" &&
    "$parallel_release_attempt" -eq "$parallel_release_failure_at" ]]; then
    gate_coordinator_infrastructure_failed=1
    echo "error: injected parallel coordinator lease-release failure." >&2
    return 2
  fi
  gate_coordinator_after_command \
    "$command" "$drain_identity" "$lifecycle_contract"
}

abandon_parallel_worker_lease() {
  local lease_file="$1"
  local drain_identity="${2:-}"
  local lifecycle_contract="${3:-}"
  gate_lock_token_is_wellformed "$drain_identity" || return 2
  gate_lifecycle_contract_is_supported "$lifecycle_contract" || return 2
  declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active || return 2
  [[ -z "${gate_coordinator_active_lease_id:-}" ]] || return 2
  [[ -z "${gate_coordinator_active_drain_identity:-}" ]] || return 2
  [[ -z "${gate_coordinator_active_lifecycle_contract:-}" ]] || return 2
  read_parallel_worker_lease_record \
    "$lease_file" "$drain_identity" "$lifecycle_contract" || return 2
  gate_coordinator_active_lease_id="$parallel_worker_lease_id"
  gate_coordinator_active_drain_identity="$parallel_worker_lease_drain_identity"
  gate_coordinator_active_lifecycle_contract="$parallel_worker_lease_lifecycle_contract"
  gate_coordinator_abandon_active_lease
}

finish_unstarted_parallel_worker_lifecycle() {
  local lease_file="$1"
  local drain_identity="${2:-}"
  local lifecycle_contract="${3:-}"
  if ! declare -F gate_coordinator_is_active >/dev/null 2>&1 ||
    ! gate_coordinator_is_active; then
    # Without a coordinator, drain_completed_command_identity already retired
    # the settled Darwin proof before this typed result was read.
    return 0
  fi
  abandon_parallel_worker_lease \
    "$lease_file" "$drain_identity" "$lifecycle_contract" || return 2
  if [[ "$lifecycle_contract" == darwin-coherent-lineage-v2 ]]; then
    if ! gate_darwin_lineage_state_exists "$drain_identity" ||
      ! gate_darwin_lineage_discard_settled "$drain_identity"; then
      echo "error: the abandoned unstarted lease lost its retained Darwin settlement proof." >&2
      return 2
    fi
  fi
}

fail_parallel_worker_infrastructure() {
  local command="$1"
  local field="$2"
  local teardown_status=0
  echo "error: parallel worker left an invalid ${field} result for: ${command}" >&2
  echo "The quality gate cannot trust this worker completion and stops scheduling." >&2
  teardown_active_timeouts || teardown_status=$?
  if [[ "$teardown_status" -ne 0 ]]; then
    echo "error: active command teardown after worker failure did not complete." >&2
  fi
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active &&
    declare -F gate_coordinator_cancel_and_ack >/dev/null 2>&1; then
    if ! gate_coordinator_cancel_and_ack \
      "parallel worker infrastructure failure (${field})" active-command; then
      echo "error: coordinator request cancellation after worker failure did not complete." >&2
    fi
  fi
  return 2
}

is_quality_setup_command() {
  local command="$1"
  # These commands have side effects that later quality checks depend on, or
  # gate whether later commands may run at all, so they must finish before the
  # independent quality pool starts. Keep this list in sync with new
  # setup-style commands added by the path mapper above.
  case "$command" in
    "node scripts/check-agent-quality-gate-package-scripts.mjs")
      # A SAFETY prerequisite, not a build one. The `root-tooling-scripts`
      # classification skips the `--allow-package-script-changes` refusal for a
      # package.json edit that touches only allowlisted aliases, which is only
      # sound while this validator pins each of those aliases to an exact
      # command. `add_root_tooling_package_script_checks` queues the validator
      # into the SAME pool as `pnpm sentry:requeue:test` and friends, so before
      # this arm existed an edit appending `&& <anything>` to a trusted alias
      # ran that alias concurrently with the check meant to reject it — and
      # keep-going meant a failed validator only incremented the failure count.
      # As a setup command it runs in run_prerequisite_phase, which is fail-fast
      # and stamp-exempt, so an unpinned or drifted alias aborts the run before
      # any `pnpm <alias>` executes and `--skip-if-fresh` cannot skip it.
      return 0
      ;;
    "pnpm --filter @mento-protocol/config build")
      return 0
      ;;
    TF_DATA_DIR=*terraform\ -chdir=*)
      return 0
      ;;
    TF_DATA_DIR=*node\ scripts/terraform/terraform-fmt-check.mjs\ *)
      return 0
      ;;
  esac

  return 1
}

is_quality_serial_command() {
  local command="$1"
  # Dashboard browser setup/tests and size-limit must stay ordered relative to
  # each other, but they are not prerequisites for lint/typecheck/unit/knip.
  # Browser tests need Chromium installed first; browser tests build a fixture
  # app (`.next-fixture`) served by `next start` while size-limit runs a
  # build-backed Turbo task (`.next`), and both `next build` steps transiently
  # rewrite the tracked `next-env.d.ts`, so keep those two mutually exclusive.
  # The quality-gate self-test temporarily mutates tracked fixture files in
  # the current checkout, so it must also finish before source-fingerprinting
  # tests enter the parallel pool.
  case "$command" in
    "pnpm agent:quality-gate:test"|"bash scripts/agent-quality-gate.test.sh")
      return 0
      ;;
    "pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium")
      return 0
      ;;
    "pnpm exec turbo run test:browser --filter=@mento-protocol/ui-dashboard --cache=local:rw")
      return 0
      ;;
    "VERCEL_DEPLOYMENT_ID=local-quality-gate pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw")
      return 0
      ;;
  esac

  return 1
}

is_quality_exclusive_command() {
  local command="$1"
  # Suites that must not share the worker pool with anything (GitHub issue
  # #1802). The dashboard's Vitest suite forks its own workers across every
  # core AND spawns `scripts/browser-api-policy-lint-runner.mjs`, an ESLint
  # program load that costs ~17s of CPU and is bounded by a wall-clock test
  # timeout. Running it beside three other pool members turns that fixed CPU
  # cost into a wall time that outruns its budget: measured on a 12-core mac,
  # the runner takes ~19s uncontended and 29-38s while the machine carries a
  # load average around 30. The failure is a genuine starvation, not a flaky
  # assertion, so the fix is to stop co-scheduling it rather than to widen the
  # budget until the starvation is invisible.
  #
  # These run in their own phase AFTER the pool drains, so cheap lint/typecheck
  # feedback still arrives first. Add a command here only with a measurement:
  # every entry is wall time the pool can no longer overlap.
  case "$command" in
    "pnpm --filter @mento-protocol/ui-dashboard test:coverage")
      return 0
      ;;
    "pnpm --filter @mento-protocol/ui-dashboard exec vitest related --run "*)
      return 0
      ;;
  esac

  return 1
}

run_mapped_entries_sequential() {
  local entry
  local command
  # $1 is the phase label, accepted for call-site symmetry with the parallel
  # runner. Sequential execution does not need to print the phase.
  shift

  for entry in "$@"; do
    command="${entry%%|*}"
    if ! run_mapped_command "$command"; then
      failures=$((failures + 1))
      if [[ "$last_command_infrastructure_failed" == true ]]; then
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      if [[ "$fail_fast" == "1" || "$fail_fast" == "true" ]]; then
        echo
        echo "Stopping after first failed mapped command (--fail-fast)." >&2
        print_command_summary
        print_failed_command_output
        log_duration_line "fail" "$(($(date +%s) - gate_start_ts))" "__run_total__" "run" || true
        exit 1
      fi
    fi
  done
}

make_parallel_command_drain_identity() {
  local sequence="$1"
  local digest now label prefix identity
  digest="$(printf '%s' "${gate_run_id:-nolock-$$}:${sequence}" | hash_stream)" ||
    return 1
  if gate_run_proc_marker_scan_available &&
    [[ ! "$gate_lock_local_host_fingerprint" =~ ^[0-9a-f]{64}$ ]] &&
    ! gate_lock_ensure_local_host_fingerprint; then
    return 1
  fi
  label="cmd${digest:0:20}"
  prefix="$(
    gate_run_marker_identity_prefix \
      "$label" "$label" "$gate_lock_local_host_fingerprint" "$$"
  )" || return 1
  now="$(date +%s)" || return 1
  identity="${prefix}-$$-${now}"
  gate_lock_token_is_wellformed "$identity" || return 1
  printf '%s\n' "$identity"
}

unregister_active_parallel_worker() {
  local target_pgid="$1"
  local target_identity="$2"
  local target_start="$3"
  local target_lifecycle_contract="${4:-}"
  local index found=0
  local -a kept_pgids=()
  local -a kept_identities=()
  local -a kept_starts=()
  local -a kept_lifecycle_contracts=()
  gate_lifecycle_contract_is_supported "$target_lifecycle_contract" || return 2
  [[ "${#active_worker_pgids[@]}" -eq "${#active_worker_drain_identities[@]}" &&
    "${#active_worker_pgids[@]}" -eq "${#active_worker_start_identities[@]}" &&
    "${#active_worker_pgids[@]}" -eq "${#active_worker_lifecycle_contracts[@]}" ]] ||
    return 2
  for index in "${!active_worker_pgids[@]}"; do
    if [[ "${active_worker_pgids[$index]}" == "$target_pgid" &&
      "${active_worker_drain_identities[$index]}" == "$target_identity" &&
      "${active_worker_start_identities[$index]}" == "$target_start" &&
      "${active_worker_lifecycle_contracts[$index]}" == "$target_lifecycle_contract" ]]; then
      found=1
      continue
    fi
    kept_pgids+=("${active_worker_pgids[$index]}")
    kept_identities+=("${active_worker_drain_identities[$index]}")
    kept_starts+=("${active_worker_start_identities[$index]}")
    kept_lifecycle_contracts+=("${active_worker_lifecycle_contracts[$index]}")
  done
  [[ "$found" -eq 1 ]] || return 2
  active_worker_pgids=("${kept_pgids[@]+"${kept_pgids[@]}"}")
  active_worker_drain_identities=("${kept_identities[@]+"${kept_identities[@]}"}")
  active_worker_start_identities=("${kept_starts[@]+"${kept_starts[@]}"}")
  active_worker_lifecycle_contracts=("${kept_lifecycle_contracts[@]+"${kept_lifecycle_contracts[@]}"}")
}

run_mapped_entries_parallel() {
  local phase="$1"
  local max_parallel="$2"
  shift 2
  local entries=("$@")
  local total="${#entries[@]}"
  local next_index=0
  local completed=0
  local active_pids=()
  local active_commands=()
  local active_output_files=()
  local active_status_files=()
  local active_elapsed_files=()
  local active_timeout_files=()
  local active_infrastructure_files=()
  local active_trunk_provisioning_files=()
  local active_lease_files=()
  local active_launch_state_files=()
  local active_ready_files=()
  local active_wait_files=()
  local active_drain_identities=()
  local active_start_identities=()
  local active_lifecycle_contracts=()
  local next_active_pids=()
  local next_active_commands=()
  local next_active_output_files=()
  local next_active_status_files=()
  local next_active_elapsed_files=()
  local next_active_timeout_files=()
  local next_active_infrastructure_files=()
  local next_active_trunk_provisioning_files=()
  local next_active_lease_files=()
  local next_active_launch_state_files=()
  local next_active_ready_files=()
  local next_active_wait_files=()
  local next_active_drain_identities=()
  local next_active_start_identities=()
  local next_active_lifecycle_contracts=()
  local running_pids=()
  local entry
  local command
  local output_file
  local status_file
  local elapsed_file
  local timeout_file
  local infrastructure_file
  local trunk_provisioning_file
  local lease_file
  local launch_state_file
  local ready_file
  local ready_staging_file
  local wait_file
  local request_marker_open
  local coordinator_marker_open
  local drain_identity
  local worker_start
  local worker_lifecycle_contract
  local worker_pgid
  local worker_parent_pid
  local worker_parent_start
  local worker_has_recovery_owner
  local worker_recovery_owner_requires_lease_record
  local worker_coordinator_release_required
  local worker_exact_identity
  local worker_host_status
  local worker_identity_attempt
  local pid
  local i
  local status
  local elapsed
  local timed_out
  local infrastructure_failed
  local trunk_provisioning_blocked
  local launch_state
  local worker_ready
  local phase_start_ts last_heartbeat_ts last_coordinator_recovery_ts now_ts hb_cmd
  local heartbeat_interval=20
  local had_monitor=0

  if [[ "$total" -eq 0 ]]; then
    return
  fi

  if [[ "$max_parallel" -le 1 || "$total" -le 1 ]]; then
    run_mapped_entries_sequential "$phase" "${entries[@]}"
    return
  fi

  # No-lock workers have no successor that can reap their live sentinel. Bind
  # them to this exact parent so they can leave after a fatal parent exit.
  # Locked workers retain the same identity for the launch handshake, which
  # stops work from starting before the parent records the worker.
  worker_parent_pid="$$"
  worker_parent_start="$(gate_lock_process_runtime_start "$worker_parent_pid")"
  if [[ -z "$worker_parent_start" ]]; then
    if gate_lock_identity_source_available; then
      echo "error: could not identify the parallel worker parent." >&2
      fail_command_scheduler_infrastructure "parallel worker launch" || return $?
    fi
    worker_parent_start="$gate_lock_identity_unavailable"
  fi

  echo
  echo "Running ${phase} commands with parallelism ${max_parallel}."
  phase_start_ts="$(date +%s)"
  last_heartbeat_ts="$phase_start_ts"
  last_coordinator_recovery_ts="$phase_start_ts"

  while [[ "$completed" -lt "$total" ]]; do
    if ! [[ "${#active_pids[@]}" -eq "${#active_drain_identities[@]}" &&
      "${#active_pids[@]}" -eq "${#active_start_identities[@]}" &&
      "${#active_pids[@]}" -eq "${#active_lifecycle_contracts[@]}" &&
      "${#active_pids[@]}" -eq "${#active_commands[@]}" &&
      "${#active_pids[@]}" -eq "${#active_output_files[@]}" &&
      "${#active_pids[@]}" -eq "${#active_status_files[@]}" &&
      "${#active_pids[@]}" -eq "${#active_elapsed_files[@]}" &&
      "${#active_pids[@]}" -eq "${#active_timeout_files[@]}" &&
      "${#active_pids[@]}" -eq "${#active_infrastructure_files[@]}" &&
      "${#active_pids[@]}" -eq "${#active_trunk_provisioning_files[@]}" &&
      "${#active_pids[@]}" -eq "${#active_lease_files[@]}" &&
      "${#active_pids[@]}" -eq "${#active_launch_state_files[@]}" &&
      "${#active_pids[@]}" -eq "${#active_ready_files[@]}" &&
      "${#active_pids[@]}" -eq "${#active_wait_files[@]}" &&
      "${#active_pids[@]}" -eq "${#active_worker_pgids[@]}" &&
      "${#active_pids[@]}" -eq "${#active_worker_drain_identities[@]}" &&
      "${#active_pids[@]}" -eq "${#active_worker_start_identities[@]}" &&
      "${#active_pids[@]}" -eq "${#active_worker_lifecycle_contracts[@]}" ]]; then
      echo "error: parallel worker lifecycle registry is inconsistent." >&2
      fail_command_scheduler_infrastructure \
        "parallel worker settlement" || return $?
    fi
    running_pids=()
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && running_pids+=("$pid")
    done < <(jobs -pr || true)
    next_active_pids=()
    next_active_commands=()
    next_active_output_files=()
    next_active_status_files=()
    next_active_elapsed_files=()
    next_active_timeout_files=()
    next_active_infrastructure_files=()
    next_active_trunk_provisioning_files=()
    next_active_lease_files=()
    next_active_launch_state_files=()
    next_active_ready_files=()
    next_active_wait_files=()
    next_active_drain_identities=()
    next_active_start_identities=()
    next_active_lifecycle_contracts=()

    for i in "${!active_pids[@]}"; do
      pid="${active_pids[$i]}"
      ready_file="${active_ready_files[$i]}"
      worker_ready=0
      if read_parallel_worker_result_value "$ready_file" ready >/dev/null 2>&1; then
        worker_ready=1
      fi
      if [[ "$worker_ready" -eq 0 ]]; then
        if [[ ! -s "$ready_file" ]] &&
          list_contains_word "$pid" "${running_pids[@]+"${running_pids[@]}"}"; then
          next_active_pids+=("$pid")
          next_active_commands+=("${active_commands[$i]}")
          next_active_output_files+=("${active_output_files[$i]}")
          next_active_status_files+=("${active_status_files[$i]}")
          next_active_elapsed_files+=("${active_elapsed_files[$i]}")
          next_active_timeout_files+=("${active_timeout_files[$i]}")
          next_active_infrastructure_files+=("${active_infrastructure_files[$i]}")
          next_active_trunk_provisioning_files+=("${active_trunk_provisioning_files[$i]}")
          next_active_lease_files+=("${active_lease_files[$i]}")
          next_active_launch_state_files+=("${active_launch_state_files[$i]}")
          next_active_ready_files+=("$ready_file")
          next_active_wait_files+=("${active_wait_files[$i]}")
          next_active_drain_identities+=("${active_drain_identities[$i]}")
          next_active_start_identities+=("${active_start_identities[$i]}")
          next_active_lifecycle_contracts+=("${active_lifecycle_contracts[$i]}")
          continue
        fi
        command="${active_commands[$i]}"
        fail_parallel_worker_infrastructure "$command" readiness || return $?
      fi

      command="${active_commands[$i]}"
      drain_identity="${active_drain_identities[$i]}"
      worker_start="${active_start_identities[$i]}"
      worker_lifecycle_contract="${active_lifecycle_contracts[$i]:-}"
      if ! gate_lifecycle_contract_is_supported "$worker_lifecycle_contract"; then
        finish_worker_settlement
        fail_parallel_worker_infrastructure \
          "$command" "lifecycle contract registry" || return $?
      fi
      output_file="${active_output_files[$i]}"
      status_file="${active_status_files[$i]}"
      elapsed_file="${active_elapsed_files[$i]}"
      timeout_file="${active_timeout_files[$i]}"
      infrastructure_file="${active_infrastructure_files[$i]}"
      trunk_provisioning_file="${active_trunk_provisioning_files[$i]}"
      lease_file="${active_lease_files[$i]}"
      launch_state_file="${active_launch_state_files[$i]}"
      wait_file="${active_wait_files[$i]}"
      worker_settlement_in_progress=1
      # Capture and drain the exact command identity before signalling the
      # worker or its descendants. A detached child can leave the worker group.
      # The drain retains durable evidence for every process while signals run.
      if ! drain_completed_parallel_command \
        "$drain_identity" "$pid" "$worker_start" \
        "$worker_lifecycle_contract"; then
        finish_worker_settlement
        [[ ! -f "$output_file" ]] ||
          filter_expected_output < "$output_file" >&2
        rm -f "$output_file" "$status_file" "$elapsed_file" "$timeout_file" \
          "$infrastructure_file" "$trunk_provisioning_file" "$lease_file" \
          "$launch_state_file" \
          "$ready_file" \
          "${ready_file}.publishing" "$wait_file"
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      # The worker remains as the live group leader until this exact drain
      # captures every same-group member. Reap it only after the drain is empty.
      wait "$pid" 2>/dev/null || true
      if ! unregister_active_parallel_worker \
        "$pid" "$drain_identity" "$worker_start" \
        "$worker_lifecycle_contract"; then
        finish_worker_settlement
        fail_parallel_worker_infrastructure "$command" "drain registry" || return $?
      fi
      finish_worker_settlement
      if ! read_parallel_worker_result_value "$ready_file" ready >/dev/null; then
        fail_parallel_worker_infrastructure "$command" readiness || return $?
      fi
      if ! status="$(read_parallel_worker_result_value "$status_file" status)"; then
        fail_parallel_worker_infrastructure "$command" status || return $?
      fi
      if ! elapsed="$(read_parallel_worker_result_value "$elapsed_file" elapsed)"; then
        fail_parallel_worker_infrastructure "$command" elapsed || return $?
      fi
      if ! timed_out="$(read_parallel_worker_result_value "$timeout_file" boolean)"; then
        fail_parallel_worker_infrastructure "$command" timeout || return $?
      fi
      if ! infrastructure_failed="$(read_parallel_worker_result_value "$infrastructure_file" boolean)"; then
        fail_parallel_worker_infrastructure "$command" infrastructure || return $?
      fi
      if ! trunk_provisioning_blocked="$(read_parallel_worker_result_value "$trunk_provisioning_file" boolean)"; then
        fail_parallel_worker_infrastructure "$command" \
          "Trunk provisioning classification" || return $?
      fi
      if ! launch_state="$(read_parallel_worker_result_value "$launch_state_file" launch-state)"; then
        fail_parallel_worker_infrastructure "$command" \
          "launch state" || return $?
      fi

      if [[ "$infrastructure_failed" == true ]]; then
        if [[ "$launch_state" == unstarted ]] &&
          ! finish_unstarted_parallel_worker_lifecycle \
            "$lease_file" "$drain_identity" "$worker_lifecycle_contract"; then
          echo "error: the parallel parent could not discharge the exact unstarted command lifecycle." >&2
        fi
        filter_expected_output < "$output_file" >&2
        rm -f "$output_file" "$status_file" "$elapsed_file" "$timeout_file" \
          "$infrastructure_file" "$trunk_provisioning_file" "$lease_file" \
          "$launch_state_file" \
          "$ready_file" \
          "${ready_file}.publishing" "$wait_file"
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      if [[ "$trunk_provisioning_blocked" == true ]]; then
        trunk_provisioning_state=blocked
      fi
      worker_coordinator_release_required=0
      if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
        gate_coordinator_is_active; then
        worker_coordinator_release_required=1
      fi
      if ! release_parallel_worker_lease \
        "$command" "$lease_file" "$drain_identity" \
        "$worker_lifecycle_contract"; then
        rm -f "$output_file" "$status_file" "$elapsed_file" "$timeout_file" \
          "$infrastructure_file" "$trunk_provisioning_file" "$lease_file" \
          "$launch_state_file" \
          "$ready_file" \
          "${ready_file}.publishing" "$wait_file"
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      if [[ "$worker_coordinator_release_required" -eq 1 &&
        "$worker_lifecycle_contract" == "darwin-coherent-lineage-v2" ]] && {
        ! gate_darwin_lineage_state_exists "$drain_identity" ||
          ! gate_darwin_lineage_discard_settled "$drain_identity"
      }; then
        rm -f "$output_file" "$status_file" "$elapsed_file" "$timeout_file" \
          "$infrastructure_file" "$trunk_provisioning_file" "$lease_file" \
          "$launch_state_file" \
          "$ready_file" \
          "${ready_file}.publishing" "$wait_file"
        fail_command_scheduler_infrastructure "$command" || return $?
      fi

      if [[ "$status" -eq 0 ]]; then
        record_command_summary "ok" "$elapsed" "$command"
        record_command_stamp "$command"
        if is_autoreview_test_command "$command"; then
          print_autoreview_test_timings "$output_file"
        fi
        echo "✓ ${command} ($(format_duration "$elapsed"))"
      elif [[ "$timed_out" != true ]] && is_trunk_command "$command" &&
        trunk_arm_is_environment_blocked_with_launcher_verdict \
          "$output_file" "$trunk_provisioning_blocked"; then
        record_command_summary "skipped" "$elapsed" "$command"
        print_trunk_environment_blocked_warning "$command" "$output_file"
      else
        failures=$((failures + 1))
        record_command_summary "fail" "$elapsed" "$command"
        if [[ "$timed_out" == true ]]; then
          echo "Command timed out after $(mapped_command_timeout_seconds "$command")s: ${command}" >&2
        else
          echo "Command failed after $(format_duration "$elapsed"): ${command}" >&2
        fi
        filter_expected_output < "$output_file" >&2
        record_failure_output "$command" "$output_file"
      fi

      rm -f "$output_file" "$status_file" "$elapsed_file" "$timeout_file" \
        "$infrastructure_file" "$trunk_provisioning_file" "$lease_file" \
        "$launch_state_file" \
        "$ready_file" \
        "${ready_file}.publishing" "$wait_file"
      completed=$((completed + 1))
    done

    # INT/TERM must see either the old complete cleanup registry or the new
    # complete one. A trap between these aligned assignments would otherwise
    # clear a mismatched registry and leave its worker outside EXIT cleanup.
    worker_settlement_in_progress=1
    active_pids=("${next_active_pids[@]+"${next_active_pids[@]}"}")
    active_worker_pgids=("${next_active_pids[@]+"${next_active_pids[@]}"}")
    active_commands=("${next_active_commands[@]+"${next_active_commands[@]}"}")
    active_output_files=("${next_active_output_files[@]+"${next_active_output_files[@]}"}")
    active_status_files=("${next_active_status_files[@]+"${next_active_status_files[@]}"}")
    active_elapsed_files=("${next_active_elapsed_files[@]+"${next_active_elapsed_files[@]}"}")
    active_timeout_files=("${next_active_timeout_files[@]+"${next_active_timeout_files[@]}"}")
    active_infrastructure_files=("${next_active_infrastructure_files[@]+"${next_active_infrastructure_files[@]}"}")
    active_trunk_provisioning_files=("${next_active_trunk_provisioning_files[@]+"${next_active_trunk_provisioning_files[@]}"}")
    active_lease_files=("${next_active_lease_files[@]+"${next_active_lease_files[@]}"}")
    active_launch_state_files=("${next_active_launch_state_files[@]+"${next_active_launch_state_files[@]}"}")
    active_ready_files=("${next_active_ready_files[@]+"${next_active_ready_files[@]}"}")
    active_wait_files=("${next_active_wait_files[@]+"${next_active_wait_files[@]}"}")
    active_drain_identities=("${next_active_drain_identities[@]+"${next_active_drain_identities[@]}"}")
    active_start_identities=("${next_active_start_identities[@]+"${next_active_start_identities[@]}"}")
    active_lifecycle_contracts=("${next_active_lifecycle_contracts[@]+"${next_active_lifecycle_contracts[@]}"}")
    active_worker_drain_identities=("${next_active_drain_identities[@]+"${next_active_drain_identities[@]}"}")
    active_worker_start_identities=("${next_active_start_identities[@]+"${next_active_start_identities[@]}"}")
    active_worker_lifecycle_contracts=("${next_active_lifecycle_contracts[@]+"${next_active_lifecycle_contracts[@]}"}")
    finish_worker_settlement

    # Process every completion observed above before opening another pool slot.
    # A completed worker can report a failed coordinator lease release. Starting
    # a replacement first would let that command run beside an unresolved lease.
    while [[ "$next_index" -lt "$total" && "${#active_pids[@]}" -lt "$max_parallel" ]]; do
      entry="${entries[$next_index]}"
      command="${entry%%|*}"
      next_index=$((next_index + 1))

      # A command a previous run already completed against this exact fingerprint
      # is reused without dispatching a job, so pool accounting stays intact.
      if try_reuse_command "$command"; then
        completed=$((completed + 1))
        continue
      fi

      # A completed serialized command drains and removes its marker. Create
      # the request-wide recovery marker in this parent before forking. The
      # worker creates its command marker after its scheduler lease exists.
      gate_run_ensure_marker \
        "The parallel command batch did not run" \
        "The parallel command batch did not start."

      output_file="$(make_tmpfile)"
      status_file="$(make_tmpfile)"
      elapsed_file="$(make_tmpfile)"
      timeout_file="$(make_tmpfile)"
      infrastructure_file="$(make_tmpfile)"
      trunk_provisioning_file="$(make_tmpfile)"
      lease_file="$(make_tmpfile)"
      launch_state_file="$(make_tmpfile)"
      ready_file="$(make_tmpfile)"
      ready_staging_file="${ready_file}.publishing"
      wait_file="${ready_file}.wait"
      tmpfiles+=(
        "$output_file" "$status_file" "$elapsed_file" "$timeout_file"
        "$infrastructure_file" "$trunk_provisioning_file" "$lease_file"
        "$launch_state_file"
        "$ready_file"
        "$ready_staging_file" "$wait_file"
      )
      # The ready path must be absent until the worker atomically publishes a
      # complete result. The sibling FIFO lets the worker wait without spawning
      # a child that would look like a leaked mapped-command descendant.
      rm -f "$ready_file"
      if ! mkfifo "$wait_file"; then
        echo "error: could not create the parallel worker sentinel pipe." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      parallel_command_sequence=$((parallel_command_sequence + 1))
      if ! drain_identity="$(make_parallel_command_drain_identity "$parallel_command_sequence")"; then
        echo "error: could not create a safe parallel command drain identity." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      worker_lifecycle_contract="$(gate_lifecycle_contract_for_host)" || {
        echo "error: could not classify the parallel worker lifecycle contract." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      }

      echo
      echo "+ ${command}"
      worker_registration_in_progress=1
      request_marker_open=0
      coordinator_marker_open=0
      worker_has_recovery_owner=0
      worker_recovery_owner_requires_lease_record=0
      if [[ -n "$gate_run_marker_file" ]]; then
        if ! gate_run_marker_matches_identity \
          "${gate_run_id:-$gate_lock_token}" "$gate_run_marker_file" ||
          ! exec 19< "$gate_run_marker_file"; then
          rm -f "$wait_file"
          finish_worker_registration
          echo "error: could not prepare the parallel worker's inherited request handle." >&2
          fail_command_scheduler_infrastructure "$command" || return $?
        fi
        request_marker_open=1
        # Explicit no-lock markers are private discovery handles. No successor
        # can recover them after this parent dies, so their sentinels must keep
        # watching the exact parent instead of waiting for a recovery owner.
        case "$gate_lock_enabled" in
          0|false|no) ;;
          *) worker_has_recovery_owner=1 ;;
        esac
      fi
      # The coordinator generation marker is the compatibility handle an
      # older legacy gate knows how to drain after it reclaims run.lock. Keep
      # it in the worker itself; the mapped wrapper that also holds this marker
      # exits before the worker sentinel does.
      if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
        gate_coordinator_is_active; then
        if [[ -z "${gate_coordinator_generation_token:-}" ||
          -z "${gate_coordinator_marker_file:-}" ]] ||
          ! gate_run_marker_matches_identity \
            "$gate_coordinator_generation_token" \
            "$gate_coordinator_marker_file" ||
          ! exec 16< "$gate_coordinator_marker_file"; then
          [[ "$request_marker_open" -eq 0 ]] || exec 19<&-
          rm -f "$wait_file"
          finish_worker_registration
          echo "error: could not prepare the parallel worker's inherited coordinator generation handle." >&2
          fail_command_scheduler_infrastructure "$command" || return $?
        fi
        coordinator_marker_open=1
        # A queued coordinator lease is not a durable command-recovery
        # obligation. Keep this worker bound to its exact parent until the
        # granted lease record exists. Otherwise an owner crash while queued
        # leaves a permanent sentinel that no successor is authorised to reap.
        worker_has_recovery_owner=0
        worker_recovery_owner_requires_lease_record=1
      fi
      # Open the control FIFO in the parent before fork. The child cannot run
      # mapped work until this parent writes `start`, after it has bound the
      # worker's PID/start/PGID identity and inserted every cleanup registry.
      # O_RDWR avoids either FIFO open blocking before the other process exists.
      if ! exec 17<> "$wait_file"; then
        [[ "$coordinator_marker_open" -eq 0 ]] || exec 16<&-
        [[ "$request_marker_open" -eq 0 ]] || exec 19<&-
        rm -f "$wait_file"
        finish_worker_registration
        echo "error: could not open the parallel worker launch pipe." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      had_monitor=0
      case "$-" in
        *m*) had_monitor=1 ;;
      esac
      # macOS has no setsid(1). Bash job control is available in stock Bash
      # 3.2 and gives this background worker a dedicated process group whose ID
      # is the worker PID. The worker stays alive as that group's validated
      # leader until the parent captures and drains every member.
      set -m
      (
        # A Bash subshell inherits the parent's trap handlers and their state.
        # This worker starts while registration_in_progress=1, so keeping that
        # handler would defer the drain's TERM forever. The parent owns cleanup.
        trap - EXIT INT TERM HUP
        worker_registration_in_progress=0
        worker_settlement_in_progress=0
        pending_terminating_signal=""
        # The parent needs monitor mode only to create this worker group. Turn
        # it back off inside the worker so run_with_timeout's command and
        # watchdog children stay in that group instead of becoming new jobs.
        set +m
        parallel_worker_parent_is_live() {
          local current_parent_start proc_stat proc_remainder proc_state proc_start
          local -a proc_fields
          if [[ "$worker_parent_start" == "$gate_lock_identity_unavailable" ]]; then
            kill -0 "$worker_parent_pid" 2>/dev/null
            return $?
          fi
          # Avoid spawning ps helpers inside the worker group on Linux. A fast
          # command can finish while one of those helpers is live, which makes
          # the sentinel drain misclassify it as a command descendant.
          if [[ "$worker_parent_start" == proc:* ]]; then
            if IFS= read -r proc_stat 2>/dev/null \
              < "/proc/${worker_parent_pid}/stat" &&
              [[ "$proc_stat" == *") "* ]]; then
              proc_remainder="${proc_stat##*) }"
              read -r -a proc_fields <<< "$proc_remainder"
              proc_state="${proc_fields[0]:-}"
              proc_start="${proc_fields[19]:-}"
              if [[ "$proc_start" =~ ^[0-9]+$ && -n "$proc_state" ]]; then
                [[ "proc:${proc_start}" == "$worker_parent_start" &&
                  "$proc_state" != Z* ]]
                return $?
              fi
            fi
            # One unreadable sample is not proof that the exact parent died.
            # Keep the sentinel while the PID exists and retry on the next poll.
            kill -0 "$worker_parent_pid" 2>/dev/null
            return $?
          fi
          current_parent_start="$(gate_lock_process_start "$worker_parent_pid")"
          if [[ -z "$current_parent_start" ]]; then
            # One unreadable process-table sample is not proof that the exact
            # parent died. Keep the only live group anchor while its PID still
            # exists, then retry the identity read on the next poll.
            kill -0 "$worker_parent_pid" 2>/dev/null
            return $?
          fi
          [[ "$current_parent_start" == "$worker_parent_start" ]] || return 1
          ! gate_lock_process_is_confirmed_zombie \
            "$worker_parent_pid" "$worker_parent_start"
        }
        # The request marker and this FIFO were opened by the parent before
        # fork. Wait until the parent has recorded the exact worker identity.
        # If the parent dies before that point, leave without running work.
        worker_action=""
        while :; do
          if IFS= read -r -t 1 worker_action <&17; then
            break
          fi
          parallel_worker_parent_is_live || exit 2
        done
        case "$worker_action" in
          start:[1-9][0-9]*)
            gate_mapped_command_parent_pid="${worker_action#start:}"
            ;;
          *) exit 2 ;;
        esac
        rm -f "$wait_file"
        export AGENTQG_RUN="agentqg:${drain_identity}"
        AGENTQG_REQUEST="$(gate_run_request_tag)" || exit 2
        export AGENTQG_REQUEST
        gate_coordinator_wait_requires_live_parent=1
        parallel_worker_command_marker=""
        run_mapped_command_to_files \
          "$command" "$output_file" "$status_file" "$elapsed_file" \
          "$timeout_file" "$infrastructure_file" \
          "$trunk_provisioning_file" "$lease_file" "$drain_identity" \
          "$launch_state_file"
        # This worker dispatches one mapped command. Drop the unlinked policy
        # snapshot before the post-command sentinel wait can outlive its parent.
        exec 24<&- 2>/dev/null || true
        # The mapped root and every surviving descendant hold their own command
        # marker descriptor. The worker is their parent, not their descendant.
        # Keeping its fd18 open would make successor recovery wait on the
        # sentinel that recovery must itself terminate.
        exec 18<&- 2>/dev/null || true
        if [[ "$worker_recovery_owner_requires_lease_record" -eq 1 ]] &&
          read_parallel_worker_lease_record \
            "$lease_file" "$drain_identity" "$worker_lifecycle_contract" &&
          [[ "$parallel_worker_lease_id" == "${gate_coordinator_active_lease_id:-}" &&
            "$parallel_worker_lease_drain_identity" == "${gate_coordinator_active_drain_identity:-}" &&
            "$parallel_worker_lease_lifecycle_contract" == "${gate_coordinator_active_lifecycle_contract:-}" ]]; then
          worker_has_recovery_owner=1
        fi
        if ! printf '%s\n' ready > "$ready_staging_file" ||
          ! mv -f "$ready_staging_file" "$ready_file"; then
          exit 2
        fi
        # A locked run has a durable recovery owner, so this live group anchor
        # must remain until the parent or a successor drains it. A no-lock run
        # has no successor. Its sentinel exits when this exact parent dies.
        if [[ "$worker_has_recovery_owner" -eq 1 &&
          "$worker_lifecycle_contract" != darwin-coherent-lineage-v2 ]]; then
          # Bash can defer TERM while a blocking FIFO read has no writer. Poll
          # the private descriptor so the trap runs promptly and normal command
          # settlement does not wait for the four-second KILL escalation.
          trap 'exit 0' HUP INT TERM
          while :; do
            IFS= read -r -t 1 _ <&17 || true
          done
        else
          # Darwin successors recover the mapped command from its persisted
          # kernel lineage. The sentinel is outside that lineage, so it must
          # retire when its exact parent exits or when a drainer removes the
          # command marker. It must not become an unrecorded obligation.
          while parallel_worker_parent_is_live; do
            if [[ "$worker_lifecycle_contract" == darwin-coherent-lineage-v2 &&
              -n "$parallel_worker_command_marker" &&
              ! -e "$parallel_worker_command_marker" &&
              ! -L "$parallel_worker_command_marker" ]]; then
              break
            fi
            IFS= read -r -t 1 _ <&17 || true
          done
        fi
      ) </dev/null &
      pid="$!"
      worker_start=""
      worker_pgid=""
      for ((worker_identity_attempt = 0; worker_identity_attempt < 100; worker_identity_attempt++)); do
        worker_start="$(gate_lock_process_runtime_start "$pid")"
        worker_pgid="$(TZ=UTC LC_ALL=C ps -o pgid= -p "$pid" 2>/dev/null |
          head -n1 | tr -d '[:space:]' || true)"
        if [[ "$worker_pgid" == "$pid" ]] && {
          [[ -n "$worker_start" ]] || ! gate_lock_identity_source_available
        }; then
          break
        fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.01 || true
      done
      if [[ -z "$worker_start" ]] && ! gate_lock_identity_source_available; then
        worker_start="$gate_lock_identity_unavailable"
      fi
      if [[ -z "$worker_start" || "$worker_pgid" != "$pid" ]]; then
        # The worker is still behind the launch barrier. Ask it to leave
        # voluntarily. Do not signal a bare PID or the assumed `-$pid` group:
        # the failed reads did not establish either identity.
        printf '%s\n' abort >&17 2>/dev/null || true
        exec 17>&-
        [[ "$coordinator_marker_open" -eq 0 ]] || exec 16<&-
        [[ "$request_marker_open" -eq 0 ]] || exec 19<&-
        wait "$pid" 2>/dev/null || true
        rm -f "$ready_file" "$ready_staging_file" "$wait_file"
        if [[ "$had_monitor" -eq 0 ]]; then
          set +m
        fi
        finish_worker_registration
        echo "error: could not bind the parallel worker to its PID, start identity, and dedicated process group." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      fi

      # A coordinator journal already maps this command identity to its
      # request. A pure legacy run has no such journal, so publish the command
      # token as a legacy drain obligation before the worker can create its
      # command marker or run work. Normal settlement removes the obligation.
      # After SIGKILL, the next legacy holder can drain the command marker and
      # remove it instead of leaving an unreferenced holder file forever.
      if { ! declare -F gate_coordinator_is_active >/dev/null 2>&1 ||
        ! gate_coordinator_is_active; } &&
        [[ -n "$gate_lock_dir" && -n "$gate_lock_root_dir" &&
          -n "$gate_lock_token" ]] &&
        ! record_condemned_run \
          "$drain_identity" "$worker_lifecycle_contract"; then
        printf '%s\n' abort >&17 2>/dev/null || true
        exec 17>&-
        [[ "$coordinator_marker_open" -eq 0 ]] || exec 16<&-
        [[ "$request_marker_open" -eq 0 ]] || exec 19<&-
        wait "$pid" 2>/dev/null || true
        rm -f "$ready_file" "$ready_staging_file" "$wait_file"
        if [[ "$had_monitor" -eq 0 ]]; then
          set +m
        fi
        finish_worker_registration
        echo "error: could not persist the legacy parallel command drain identity." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      fi

      # Register every cleanup view before the worker can start mapped work.
      # A deferred INT/TERM therefore sees either no worker or this complete
      # aligned record. SIGKILL recovery uses the inherited request handle.
      active_pids+=("$pid")
      active_worker_pgids+=("$worker_pgid")
      active_worker_drain_identities+=("$drain_identity")
      active_worker_start_identities+=("$worker_start")
      active_worker_lifecycle_contracts+=("$worker_lifecycle_contract")
      active_commands+=("$command")
      active_output_files+=("$output_file")
      active_status_files+=("$status_file")
      active_elapsed_files+=("$elapsed_file")
      active_timeout_files+=("$timeout_file")
      active_infrastructure_files+=("$infrastructure_file")
      active_trunk_provisioning_files+=("$trunk_provisioning_file")
      active_lease_files+=("$lease_file")
      active_launch_state_files+=("$launch_state_file")
      active_ready_files+=("$ready_file")
      active_wait_files+=("$wait_file")
      active_drain_identities+=("$drain_identity")
      active_start_identities+=("$worker_start")
      active_lifecycle_contracts+=("$worker_lifecycle_contract")
      if ! printf 'start:%s\n' "$pid" >&17; then
        exec 17>&-
        [[ "$coordinator_marker_open" -eq 0 ]] || exec 16<&-
        [[ "$request_marker_open" -eq 0 ]] || exec 19<&-
        if [[ "$had_monitor" -eq 0 ]]; then
          set +m
        fi
        finish_worker_registration
        echo "error: could not release the registered parallel worker launch barrier." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      exec 17>&-
      [[ "$coordinator_marker_open" -eq 0 ]] || exec 16<&-
      [[ "$request_marker_open" -eq 0 ]] || exec 19<&-
      if [[ "$had_monitor" -eq 0 ]]; then
        set +m
      fi

      # Private deterministic barrier for the signal-registration regression.
      # It is inert unless the test suite opts in.
      if [[ -n "$worker_registration_test_barrier" ]]; then
        worker_exact_identity="portable"
        if gate_darwin_lineage_host_is_darwin; then
          worker_host_status=0
          if ! gate_darwin_exact_child_capture "$pid" "$$"; then
            finish_worker_registration
            echo "error: could not capture the test worker's Darwin kernel identity." >&2
            fail_command_scheduler_infrastructure "$command" || return $?
          fi
          worker_exact_identity="$gate_darwin_exact_identity"
        else
          worker_host_status=$?
          if [[ "$worker_host_status" -ne 1 ]]; then
            finish_worker_registration
            echo "error: could not classify the test worker host." >&2
            fail_command_scheduler_infrastructure "$command" || return $?
          fi
        fi
        printf 'agentqg-worker-v1|%s|%s|%s|%s|%s\n' \
          "$pid" "$worker_start" "$drain_identity" \
          "$worker_lifecycle_contract" "$worker_exact_identity" \
          >> "${worker_registration_test_barrier}.identities"
        printf '%s\n' "$pid" >> "${worker_registration_test_barrier}.workers"
        if [[ ! -e "${worker_registration_test_barrier}.ready" ]]; then
          printf '%s\n' "$pid" > "${worker_registration_test_barrier}.ready"
        fi
        while [[ ! -e "${worker_registration_test_barrier}.release" ]]; do
          sleep 0.05 || true
        done
      fi

      finish_worker_registration
    done

    # Only this parent drains stale coordinator obligations. Parallel workers
    # share shell state and capture files, so letting each queued lease waiter
    # drain would race their capture and unlink operations.
    if [[ ${#active_pids[@]} -gt 0 ]]; then
      now_ts="$(date +%s)"
      if [[ $((now_ts - last_coordinator_recovery_ts)) -ge 5 ]] &&
        declare -F gate_coordinator_recover_stale_obligations >/dev/null 2>&1; then
        if ! gate_coordinator_recover_stale_obligations; then
          echo "error: scheduler stale-worker recovery failed during the parallel pool." >&2
          return 2
        fi
        last_coordinator_recovery_ts="$now_ts"
      fi

      # Heartbeat: while commands are still in flight, emit a periodic liveness
      # line naming what is running so a slow member is visibly working, not hung.
      if [[ $((now_ts - last_heartbeat_ts)) -ge "$heartbeat_interval" ]]; then
        printf '⏳ still running after %s (%d/%d done):\n' \
          "$(format_duration $((now_ts - phase_start_ts)))" "$completed" "$total"
        for i in "${!active_commands[@]}"; do
          hb_cmd="${active_commands[$i]}"
          printf '    · %s\n' "$hb_cmd"
          if is_autoreview_test_command "$hb_cmd"; then
            latest_autoreview_test_progress "${active_output_files[$i]}"
          fi
        done
        last_heartbeat_ts="$now_ts"
      fi
    fi

    # Poll on a short cadence instead of blocking on `wait -n`. A bare `wait -n`
    # only wakes on completions, so a set of concurrently-slow commands would
    # suppress the wall-clock heartbeat above; and capping `wait -n` with a timer
    # job races with fast commands that finish mid-cycle (the timer becomes the
    # next completion and delays recording them by a full interval). A 1s poll
    # detects completions within ~1s — negligible for a gate whose parallel
    # members run for seconds to minutes — and lets the heartbeat fire on time.
    if [[ ${#active_pids[@]} -gt 0 ]]; then
      sleep 1
    fi
  done
}

run_prerequisite_phase() {
  # Ordered prerequisite phases (install / codegen / quality-setup) fail-fast
  # WITHIN themselves: a failed step must stop before its dependents — and
  # before later steps in the SAME phase (e.g. `terraform validate` after a
  # failed `terraform init`) — run. This preserves the old --fail-fast
  # prerequisite behavior even though the hook now drops global --fail-fast so
  # the independent quality pool keeps going. Serialized dashboard checks and
  # the parallel pool are NOT prerequisites (serialized only for the .next
  # mutex), so they are run keep-going and still collect their own feedback.
  local previous_fail_fast="$fail_fast"
  fail_fast=true
  # Prerequisite commands (install/codegen/quality-setup) produce OUTPUTS
  # (node_modules, generated code, built packages) that the source fingerprint
  # cannot see. A stamp from a prior run must not skip them — deleting
  # node_modules between runs would otherwise start dependent commands against
  # missing inputs. They are cheap and idempotent; always re-run them.
  in_prerequisite_phase=true
  run_mapped_entries_sequential "$@"
  in_prerequisite_phase=false
  fail_fast="$previous_fail_fast"
}

run_quality_phase() {
  local setup_entries=()
  local rest_entries=()
  local serial_entries=()
  local parallel_entries=()
  local exclusive_entries=()
  local entry
  local command

  # Split setup out FIRST, so it reaches run_prerequisite_phase on every path.
  # While the partition lived below the sequential early-return, --parallel 1
  # and the hook's keep-going setting let a failed setup command's dependents
  # run anyway: `terraform validate` after a failed `terraform init`, the
  # typechecks after a failed shared-config build, and the trusted `pnpm
  # <alias>` commands after the failed package-script validator that exists to
  # gate them.
  #
  # The sequential path keeps the mapper's original ordering for everything
  # else. Serial-vs-parallel is a concurrency partition, not a priority one, so
  # reordering it here would change which command a --fail-fast run reports
  # first for no gain.
  for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
    command="${entry%%|*}"
    if is_quality_setup_command "$command"; then
      setup_entries+=("$entry")
      continue
    fi
    rest_entries+=("$entry")
    if is_quality_serial_command "$command"; then
      serial_entries+=("$entry")
    elif is_quality_exclusive_command "$command"; then
      exclusive_entries+=("$entry")
    else
      parallel_entries+=("$entry")
    fi
  done

  run_prerequisite_phase "quality setup" "${setup_entries[@]+"${setup_entries[@]}"}"

  if [[ "$fail_fast" == "1" || "$fail_fast" == "true" || "$quality_parallelism" -le 1 ]]; then
    run_mapped_entries_sequential "quality" "${rest_entries[@]+"${rest_entries[@]}"}"
    return
  fi

  run_mapped_entries_sequential "quality serialized" "${serial_entries[@]+"${serial_entries[@]}"}"
  run_mapped_entries_parallel "quality" "$quality_parallelism" "${parallel_entries[@]+"${parallel_entries[@]}"}"

  if [[ "${#exclusive_entries[@]}" -gt 0 ]]; then
    echo
    echo "Running ${#exclusive_entries[@]} quality command(s) exclusively; the parallel pool has drained."
    run_mapped_entries_sequential "quality exclusive" "${exclusive_entries[@]}"
  fi
}

# Drop per-command stamps that don't match this run's fingerprint (any changed
# validated file invalidates all of them) or that aged past the TTL, so the file
# stays bounded and only genuine resume candidates remain.
if ! prune_command_stamps; then
  echo "error: could not read or prune the per-command stamp cache before first dispatch." >&2
  gate_report_coordinated_no_work_failure 2 "command-stamp pruning" \
    "No mapped command ran in this request"
  exit 2
fi

# Queue time can be long. Bind the first dispatch to the same source, plan,
# toolchain, environment digest, runtime, and resource policy that registration
# used. A changed key cancels the request before any mapped command starts.
if declare -F gate_coordinator_verify_registration_fingerprint >/dev/null 2>&1; then
  gate_coordinator_verify_registration_fingerprint "before first dispatch"
fi

# Last thing before anything is executed: confirm this run still holds the lock
# it took. Mapping and stamp work happen between acquiring and here, which is
# room enough for another run to have taken it over.
assert_gate_run_lock_still_ours

# A legacy holder drains every condemned run under its exclusive lock. A
# coordinator client first claims each drain token, so only one gate parent can
# capture and unlink its process evidence while other clients keep scheduling
# against the stale lease's reserved capacity and named resources.
if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
  gate_coordinator_is_active; then
  if ! gate_coordinator_recover_stale_obligations; then
    echo "error: scheduler stale-worker recovery failed before first dispatch." >&2
    gate_coordinator_report_no_work_failure 2 "stale-obligation recovery" \
      "No mapped command ran in this request"
    exit 2
  fi
else
  drain_condemned_runs
fi

# Asked again, and this is what orders the drain against publishers rather than
# hoping they are quiet. Publishing an obligation is not synchronised with the
# lock — but every publisher derives one from a record on disk, and while this
# run holds an untouched lock there is no such record to derive from: a remnant
# under this lock can only exist if this run's own record was renamed away, and
# a run condemning what it took has taken ours. So either nothing could have
# been published after the last empty scan, or the record no longer names us
# and this stops. The publications that can still land are duplicates of
# obligations this run already drained, whose processes are already gone.
assert_gate_run_lock_still_ours

# Freeze the Darwin broker policy after coordinator bootstrap and stale-run
# recovery, but before a mapped-command worker can fork. Dispatches execute
# only the unlinked descriptor snapshot and revalidate the original path.
if ! gate_darwin_broker_preflight_bind; then
  echo "error: could not bind the Darwin broker preflight before first dispatch." >&2
  gate_report_coordinated_no_work_failure 2 "run-handle preparation" \
    "No mapped command ran in this request"
  exit 2
fi
if ! gate_lock_wait_for_test_barrier "$broker_preflight_bound_test_barrier"; then
  echo "error: Darwin broker preflight binding test barrier failed." >&2
  gate_report_coordinated_no_work_failure 2 "run-handle preparation" \
    "No mapped command ran in this request"
  exit 2
fi

# Bind every Darwin command watcher to this exact gate process before a
# parallel worker can fork. The identity string is inherited by workers. It
# lets their watchers settle when this controller dies even if a worker shell
# remains alive.
if gate_darwin_lineage_host_is_darwin; then
  if ! gate_darwin_exact_identity_prepare ||
    ! gate_darwin_exact_parent_capture "$$"; then
    echo "error: could not establish the Darwin gate controller identity before first dispatch." >&2
    gate_report_coordinated_no_work_failure 2 "run-handle preparation" \
      "No mapped command ran in this request"
    exit 2
  fi
  gate_darwin_controller_exact_identity="$gate_darwin_exact_identity"
else
  darwin_controller_status=$?
  if [[ "$darwin_controller_status" -ne 1 ]]; then
    echo "error: could not classify the host before Darwin controller capture." >&2
    gate_report_coordinated_no_work_failure 2 "run-handle preparation" \
      "No mapped command ran in this request"
    exit 2
  fi
fi

# Capture this boundary after scheduler registration and stale recovery, but
# before the first mapped command. A process older than this Linux start tick
# cannot have inherited a mapped command's marker. The active-command
# descriptor census can skip it before reading UID or fd state.
if gate_run_proc_marker_scan_available; then
  if ! gate_active_command_proc_start_floor="$(
    gate_run_capture_proc_start_floor
  )" || [[ ! "$gate_active_command_proc_start_floor" =~ ^[0-9]+$ ]]; then
    echo "error: could not capture the Linux process-start boundary before mapped commands." >&2
    gate_report_coordinated_no_work_failure 2 "run-handle preparation" \
      "No mapped command ran in this request"
    exit 2
  fi
fi

run_prerequisite_phase "preflight" "${preflight_commands[@]+"${preflight_commands[@]}"}"
run_prerequisite_phase "codegen" "${codegen_commands[@]+"${codegen_commands[@]}"}"
run_prerequisite_phase "post-codegen" "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"
run_quality_phase

print_command_summary

gate_total_elapsed=$(( $(date +%s) - gate_start_ts ))

if declare -F gate_coordinator_verify_registration_fingerprint >/dev/null 2>&1; then
  gate_coordinator_verify_registration_fingerprint \
    "before terminal result publication"
fi

if [[ "$failures" -gt 0 ]]; then
  if declare -F gate_coordinator_publish_failure >/dev/null 2>&1; then
    gate_coordinator_publish_failure "$failures" || true
  fi
  log_duration_line "fail" "$gate_total_elapsed" "__run_total__" "run" || true
  print_failed_command_output
  echo
  echo "${failures} mapped command(s) failed." >&2
  exit 1
fi

if declare -F gate_coordinator_publish_success >/dev/null 2>&1; then
  gate_coordinator_publish_success \
    "$trunk_arm_environment_blocked" "$trunk_environment_blocked_kind"
fi

log_duration_line "ok" "$gate_total_elapsed" "__run_total__" "run" || true

echo
echo "All mapped commands passed."
if [[ "$trunk_arm_environment_blocked" == true ]]; then
  echo "Note: the Trunk arm was skipped because it could not be provisioned here; CI still enforces it."
fi
if [[ "${stamp_reuse_count:-0}" -eq 0 && "$trunk_arm_environment_blocked" != true ]]; then
  # Only a fully-executed green run earns the whole-run fast-path stamp. A
  # resumed run reused work whose real age lives in the per-command stamps;
  # re-dating it here would let --skip-if-fresh extend validation reuse past
  # the two-hour ceiling (command passes at t=0, retry succeeds at t=119m,
  # fresh whole-run stamp then covers t=238m). A run that skipped Trunk
  # because the launcher could not be provisioned is the same hazard from a
  # different direction: the whole-run stamp carries no record of that skip,
  # so a later --skip-if-fresh run — even one where Trunk has since become
  # provisionable — would trust the stamp and never attempt it. Withholding
  # the stamp here forces the next run to actually retry Trunk instead of
  # inheriting a pass it never earned.
  if ! {
    printf 'created_at=%s\n' "$(date +%s)"
    printf 'stamp=%s\n' "$current_stamp"
    if [[ -n "$gate_coordinator_freshness_context" ]]; then
      printf 'execution_fingerprint=%s\n' \
        "$gate_coordinator_registration_fingerprint"
      printf 'execution_head=%s\n' "$gate_coordinator_execution_head"
    fi
  } > "$success_stamp_file"; then
    echo "warning: the gate passed, but its local success stamp could not be written." >&2
  fi
fi
