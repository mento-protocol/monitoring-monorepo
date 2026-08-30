#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const installer = path.join(
  repoRoot,
  "scripts/review/install-review-eval-launchd.sh",
);
const template = path.join(
  repoRoot,
  "scripts/review/launchd/org.mento.review-eval.plist",
);

function makeHarness({ sharedHome } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "review-eval-launchd-install-"));
  const checkout = path.join(root, "checkout & eval");
  const taskHome = sharedHome ?? path.join(root, "home & logs");
  const fakeBin = path.join(root, "fake bin");
  const lockRoot = path.join(root, "checkout git dir");
  const templateDir = path.join(checkout, "scripts/review/launchd");
  const runner = path.join(checkout, "scripts/review/run-eval.sh");
  const targetDir = path.join(taskHome, "Library/LaunchAgents");
  const target = path.join(targetDir, "org.mento.review-eval.plist");
  const runLock = path.join(lockRoot, "run.lock");
  const installLock = path.join(
    targetDir,
    ".org.mento.review-eval.install.lock",
  );
  const launchctlLog = path.join(root, "launchctl.log");
  const gitLog = path.join(root, "git.log");
  const printCount = path.join(root, "print.count");
  const plutilCount = path.join(root, "plutil.count");
  const holdReady = path.join(root, "hold.ready");
  const holdRelease = path.join(root, "hold.release");
  const bashEnv = path.join(root, "bash-env.sh");
  const realPlutilBashEnv = path.join(root, "bash-env-real-plutil.sh");
  const installedSentinel = "previous review-eval plist\n";
  const runtimeCommands = ["node", "git", "codex", "claude"];
  const runtimeDirs = runtimeCommands.map((name) =>
    path.join(root, `${name} & bin`),
  );

  mkdirSync(templateDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(lockRoot, { recursive: true });
  for (const directory of runtimeDirs)
    mkdirSync(directory, { recursive: true });

  const commandPaths = new Map(
    runtimeCommands.map((name, index) => [
      name,
      path.join(runtimeDirs[index], name),
    ]),
  );
  writeFileSync(
    commandPaths.get("node"),
    `#!/bin/sh
case "\${2:-}" in
  *renameSync*)
    if [ -n "$REVIEW_EVAL_RENAME_SIGNAL" ]; then
      /bin/kill -s "$REVIEW_EVAL_RENAME_SIGNAL" "$PPID"
    fi
    ;;
esac
exec ${JSON.stringify(process.execPath)} "$@"
`,
  );
  writeFileSync(
    commandPaths.get("git"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$REVIEW_EVAL_GIT_LOG"
case "\${3:-}" in
  rev-parse)
    case "\${4:-}" in
      --show-toplevel) printf '%s\\n' "$REVIEW_EVAL_CHECKOUT" ;;
      --absolute-git-dir) printf '%s\\n' "$REVIEW_EVAL_LOCK_ROOT" ;;
      HEAD) printf '%s\\n' "$REVIEW_EVAL_HEAD_SHA" ;;
      origin/main) printf '%s\\n' "$REVIEW_EVAL_MAIN_SHA" ;;
      *) exit 64 ;;
    esac
    ;;
  fetch) [ "$REVIEW_EVAL_FETCH_FAILS" = 0 ] || exit 65 ;;
  status) printf '%s' "$REVIEW_EVAL_DIRTY_STATUS" ;;
  *) exit 66 ;;
esac
`,
  );
  for (const name of ["codex", "claude"]) {
    writeFileSync(commandPaths.get(name), "#!/bin/sh\nexit 0\n");
  }

  const fakePlutil = path.join(fakeBin, "plutil");
  writeFileSync(
    fakePlutil,
    `#!/bin/sh
count=0
[ ! -f "$REVIEW_EVAL_PLUTIL_COUNT" ] || count="$(/bin/cat "$REVIEW_EVAL_PLUTIL_COUNT")"
count=$((count + 1))
printf '%s\\n' "$count" > "$REVIEW_EVAL_PLUTIL_COUNT"
[ "$count" -ne "$REVIEW_EVAL_PLUTIL_FAIL_AT" ] || exit 67
if [ "$1" = -extract ]; then
  case "$2" in
    ProgramArguments.5) printf '%s\\n' "$REVIEW_EVAL_EXPECTED_PATH" ;;
    ProgramArguments.6) printf '%s\\n' "$REVIEW_EVAL_EXPECTED_RUNNER" ;;
    EnvironmentVariables.PATH) printf '%s\\n' "$REVIEW_EVAL_EXPECTED_PATH" ;;
    Label) printf '%s\\n' "$REVIEW_EVAL_PRIOR_LABEL" ;;
  esac
fi
`,
  );

  const fakeLaunchctl = path.join(fakeBin, "launchctl");
  writeFileSync(
    fakeLaunchctl,
    `#!/bin/sh
[ -f "$REVIEW_EVAL_RUN_LOCK" ] || exit 90
[ -f "$REVIEW_EVAL_INSTALL_LOCK" ] || exit 91
case "$1" in
  print)
    count=0
    [ ! -f "$REVIEW_EVAL_PRINT_COUNT" ] || count="$(/bin/cat "$REVIEW_EVAL_PRINT_COUNT")"
    count=$((count + 1))
    printf '%s\\n' "$count" > "$REVIEW_EVAL_PRINT_COUNT"
    if [ "$count" -eq 1 ]; then state="$REVIEW_EVAL_FIRST_STATE"; else state="$REVIEW_EVAL_SECOND_STATE"; fi
    printf 'print:%s\\n' "$state" >> "$REVIEW_EVAL_LAUNCHCTL_LOG"
    if [ "$count" -eq 1 ] && [ "$REVIEW_EVAL_HOLD_FIRST_PRINT" = 1 ]; then
      : > "$REVIEW_EVAL_HOLD_READY"
      while [ ! -f "$REVIEW_EVAL_HOLD_RELEASE" ]; do /bin/sleep 0.01; done
    fi
    if [ "$count" -eq 2 ] && [ "$REVIEW_EVAL_RACE_CONTENDER" = 1 ]; then
      ticket="$REVIEW_EVAL_LOCK_ROOT/contender.owner"
      printf '%s\\n' "$$" > "$ticket"
      if "$REVIEW_EVAL_REAL_NODE" -e 'require("node:fs").linkSync(process.argv[1], process.argv[2])' "$ticket" "$REVIEW_EVAL_RUN_LOCK" 2>/dev/null; then
        printf '%s\\n' contender-acquired >> "$REVIEW_EVAL_LAUNCHCTL_LOG"
      else
        printf '%s\\n' contender-blocked >> "$REVIEW_EVAL_LAUNCHCTL_LOG"
      fi
      /bin/rm -f "$ticket"
    fi
    case "$state" in
      absent) exit 113 ;;
      idle) printf '%s\\n' 'state = waiting' ;;
      running) printf '%s\\n' 'state = running' ;;
      *) exit 68 ;;
    esac
    ;;
  bootstrap)
    printf '%s\\n' bootstrap >> "$REVIEW_EVAL_LAUNCHCTL_LOG"
    if [ -n "$REVIEW_EVAL_BOOTSTRAP_SIGNAL" ]; then
      /bin/kill -s "$REVIEW_EVAL_BOOTSTRAP_SIGNAL" "$PPID"
      /bin/sleep 0.05
      [ "$REVIEW_EVAL_SIGNAL_BOOTSTRAP_SUCCEEDS" = 1 ] && exit 0
      exit 69
    fi
    if [ "$REVIEW_EVAL_REPLACE_LOCK" = 1 ]; then
      /bin/rm -f "$REVIEW_EVAL_RUN_LOCK"
      printf '%s\\n' replacement-owner > "$REVIEW_EVAL_RUN_LOCK"
      /bin/rm -f "$REVIEW_EVAL_INSTALL_LOCK"
      printf '%s\\n' replacement-installer > "$REVIEW_EVAL_INSTALL_LOCK"
    fi
    if [ "$REVIEW_EVAL_BOOTSTRAP_FAILS" = 1 ]; then
      [ "$REVIEW_EVAL_ROLLBACK_FAILS" = 0 ] || /bin/chmod 0555 "$REVIEW_EVAL_TARGET_DIR"
      exit 70
    fi
    ;;
  *)
    printf 'unexpected:%s\\n' "$1" >> "$REVIEW_EVAL_LAUNCHCTL_LOG"
    exit 71
    ;;
esac
`,
  );

  for (const executable of [
    ...commandPaths.values(),
    fakePlutil,
    fakeLaunchctl,
  ]) {
    chmodSync(executable, 0o755);
  }
  writeFileSync(
    bashEnv,
    `function /usr/bin/plutil { "$REVIEW_EVAL_FAKE_PLUTIL" "$@"; }
function /bin/launchctl { "$REVIEW_EVAL_FAKE_LAUNCHCTL" "$@"; }
`,
  );
  writeFileSync(
    realPlutilBashEnv,
    `function /bin/launchctl { "$REVIEW_EVAL_FAKE_LAUNCHCTL" "$@"; }
`,
  );

  const inheritedPath = `${runtimeDirs.join(":")}:${fakeBin}:/usr/bin:/bin`;
  const expectedPath = `${inheritedPath}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

  function reset({ prior = true, runnerKind = "regular" } = {}) {
    rmSync(taskHome, { recursive: true, force: true });
    rmSync(lockRoot, { recursive: true, force: true });
    mkdirSync(lockRoot, { recursive: true });
    for (const file of [
      launchctlLog,
      gitLog,
      printCount,
      plutilCount,
      holdReady,
      holdRelease,
    ]) {
      rmSync(file, { force: true });
    }
    mkdirSync(templateDir, { recursive: true });
    cpSync(template, path.join(templateDir, path.basename(template)));
    rmSync(runner, { force: true });
    mkdirSync(path.dirname(runner), { recursive: true });
    if (runnerKind === "symlink") {
      symlinkSync(template, runner);
    } else if (runnerKind !== "missing") {
      writeFileSync(runner, "#!/bin/bash\nexit 0\n");
      chmodSync(runner, runnerKind === "unreadable" ? 0o000 : 0o644);
    }
    if (prior) {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(target, installedSentinel);
    }
  }

  function environment(options = {}) {
    return {
      ...process.env,
      BASH_ENV: options.realPlutil ? realPlutilBashEnv : bashEnv,
      HOME: taskHome,
      PATH: inheritedPath,
      REVIEW_EVAL_BOOTSTRAP_FAILS: options.bootstrapFails ? "1" : "0",
      REVIEW_EVAL_BOOTSTRAP_SIGNAL: options.bootstrapSignal ?? "",
      REVIEW_EVAL_CHECKOUT: checkout,
      REVIEW_EVAL_DIRTY_STATUS: options.dirty ? "?? local-file\\n" : "",
      REVIEW_EVAL_EXPECTED_PATH: expectedPath,
      REVIEW_EVAL_EXPECTED_RUNNER: path.join(
        realpathSync(checkout),
        "scripts/review/run-eval.sh",
      ),
      REVIEW_EVAL_FAKE_LAUNCHCTL: fakeLaunchctl,
      REVIEW_EVAL_FAKE_PLUTIL: fakePlutil,
      REVIEW_EVAL_FETCH_FAILS: options.fetchFails ? "1" : "0",
      REVIEW_EVAL_FIRST_STATE: options.firstState ?? "absent",
      REVIEW_EVAL_GIT_LOG: gitLog,
      REVIEW_EVAL_HEAD_SHA: options.headSha ?? "a".repeat(40),
      REVIEW_EVAL_HOLD_FIRST_PRINT: options.holdFirstPrint ? "1" : "0",
      REVIEW_EVAL_HOLD_READY: holdReady,
      REVIEW_EVAL_HOLD_RELEASE: holdRelease,
      REVIEW_EVAL_INSTALL_LOCK: installLock,
      REVIEW_EVAL_LAUNCHCTL_LOG: launchctlLog,
      REVIEW_EVAL_LOCK_ROOT: lockRoot,
      REVIEW_EVAL_MAIN_SHA: options.mainSha ?? "a".repeat(40),
      REVIEW_EVAL_PLUTIL_COUNT: plutilCount,
      REVIEW_EVAL_PLUTIL_FAIL_AT: String(options.plutilFailAt ?? 0),
      REVIEW_EVAL_PRINT_COUNT: printCount,
      REVIEW_EVAL_PRIOR_LABEL: options.priorLabel ?? "org.mento.review-eval",
      REVIEW_EVAL_RACE_CONTENDER: options.raceContender ? "1" : "0",
      REVIEW_EVAL_REAL_NODE: process.execPath,
      REVIEW_EVAL_RENAME_SIGNAL: options.renameSignal ?? "",
      REVIEW_EVAL_REPLACE_LOCK: options.replaceLock ? "1" : "0",
      REVIEW_EVAL_ROLLBACK_FAILS: options.rollbackFails ? "1" : "0",
      REVIEW_EVAL_RUN_LOCK: runLock,
      REVIEW_EVAL_SECOND_STATE: options.secondState ?? "absent",
      REVIEW_EVAL_SIGNAL_BOOTSTRAP_SUCCEEDS: options.signalBootstrapSucceeds
        ? "1"
        : "0",
      REVIEW_EVAL_TARGET_DIR: targetDir,
    };
  }

  function run(options = {}) {
    reset(options);
    if (options.preexistingLock) writeFileSync(runLock, "foreign-owner\n");
    if (options.preexistingInstallLock) {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(installLock, "foreign-installer\n");
    }
    const childUid =
      options.runnerKind === "unreadable" &&
      typeof process.geteuid === "function" &&
      process.geteuid() === 0
        ? 65534
        : undefined;
    if (childUid !== undefined) chmodSync(root, 0o755);
    const spawnOptions = {
      cwd: checkout,
      encoding: "utf8",
      env: environment(options),
    };
    if (childUid !== undefined) spawnOptions.uid = childUid;
    return spawnSync("/bin/bash", [installer], spawnOptions);
  }

  function operations() {
    return existsSync(launchctlLog)
      ? readFileSync(launchctlLog, "utf8").trim().split("\n")
      : [];
  }

  return {
    checkout,
    environment,
    holdReady,
    holdRelease,
    installedSentinel,
    installLock,
    launchctlLog,
    operations,
    reset,
    root,
    run,
    runLock,
    target,
    targetDir,
  };
}

test("the launchd installer serializes, refuses loaded state, and rolls files back", async () => {
  const harness = makeHarness();
  try {
    for (const state of ["idle", "running"]) {
      const loaded = harness.run({ firstState: state });
      assert.notEqual(loaded.status, 0);
      assert.match(loaded.stderr, /scheduler is loaded/);
      assert.deepEqual(harness.operations(), [`print:${state}`]);
      assert.equal(
        readFileSync(harness.target, "utf8"),
        harness.installedSentinel,
      );
      assert.deepEqual(readdirSync(harness.targetDir), [
        path.basename(harness.target),
      ]);
      assert.equal(existsSync(harness.runLock), false);
    }

    const loadedDuringRender = harness.run({ secondState: "idle" });
    assert.notEqual(loadedDuringRender.status, 0);
    assert.match(loadedDuringRender.stderr, /scheduler is loaded/);
    assert.deepEqual(
      harness.operations(),
      ["print:absent", "print:idle"],
      loadedDuringRender.stdout + loadedDuringRender.stderr,
    );
    assert.equal(
      readFileSync(harness.target, "utf8"),
      harness.installedSentinel,
    );

    const locked = harness.run({ preexistingLock: true });
    assert.notEqual(locked.status, 0);
    assert.match(locked.stderr, /run lock already exists/);
    assert.deepEqual(harness.operations(), []);
    assert.equal(readFileSync(harness.runLock, "utf8"), "foreign-owner\n");

    const installLocked = harness.run({ preexistingInstallLock: true });
    assert.notEqual(installLocked.status, 0);
    assert.match(installLocked.stderr, /target transaction lock/);
    assert.deepEqual(harness.operations(), []);
    assert.equal(
      readFileSync(harness.installLock, "utf8"),
      "foreign-installer\n",
    );

    for (const options of [
      { fetchFails: true },
      { headSha: "b".repeat(40) },
      { dirty: true },
    ]) {
      const ineligible = harness.run(options);
      assert.notEqual(ineligible.status, 0);
      assert.deepEqual(harness.operations(), []);
      assert.equal(
        readFileSync(harness.target, "utf8"),
        harness.installedSentinel,
      );
      assert.equal(existsSync(harness.runLock), false);
    }

    for (const runnerKind of ["missing", "symlink", "unreadable"]) {
      const badRunner = harness.run({ runnerKind });
      assert.notEqual(badRunner.status, 0);
      assert.match(badRunner.stderr, /readable, regular, non-symlink script/);
      assert.deepEqual(harness.operations(), []);
    }

    const wrongLabel = harness.run({ priorLabel: "org.example.other" });
    assert.notEqual(wrongLabel.status, 0);
    assert.match(wrongLabel.stderr, /expected org\.mento\.review-eval label/);
    assert.deepEqual(harness.operations(), ["print:absent"]);
    assert.equal(
      readFileSync(harness.target, "utf8"),
      harness.installedSentinel,
    );

    for (let plutilFailAt = 1; plutilFailAt <= 13; plutilFailAt += 1) {
      const invalid = harness.run({ plutilFailAt });
      assert.notEqual(
        invalid.status,
        0,
        `plutil call ${plutilFailAt} did not fail`,
      );
      assert.doesNotMatch(
        harness.operations().join("\n"),
        /bootstrap|unexpected/,
      );
      assert.equal(
        readFileSync(harness.target, "utf8"),
        harness.installedSentinel,
      );
      assert.equal(existsSync(harness.runLock), false);
    }

    const raced = harness.run({ raceContender: true });
    assert.equal(raced.status, 0, raced.stdout + raced.stderr);
    assert.deepEqual(harness.operations(), [
      "print:absent",
      "print:absent",
      "contender-blocked",
      "bootstrap",
    ]);
    assert.notEqual(
      readFileSync(harness.target, "utf8"),
      harness.installedSentinel,
    );
    assert.equal(existsSync(harness.runLock), false);

    const loadFailure = harness.run({ bootstrapFails: true });
    assert.notEqual(loadFailure.status, 0);
    assert.match(loadFailure.stderr, /prior plist was restored/);
    assert.equal(
      readFileSync(harness.target, "utf8"),
      harness.installedSentinel,
    );
    assert.deepEqual(harness.operations(), [
      "print:absent",
      "print:absent",
      "bootstrap",
    ]);

    const newLoadFailure = harness.run({ bootstrapFails: true, prior: false });
    assert.notEqual(newLoadFailure.status, 0);
    assert.match(newLoadFailure.stderr, /new plist was removed/);
    assert.equal(existsSync(harness.target), false);

    const rollbackFailure = harness.run({
      bootstrapFails: true,
      rollbackFails: true,
    });
    chmodSync(harness.targetDir, 0o755);
    assert.notEqual(rollbackFailure.status, 0);
    assert.match(rollbackFailure.stderr, /recovery copy:/);
    assert.equal(
      readdirSync(harness.targetDir).filter((name) =>
        name.startsWith(".org.mento.review-eval.previous."),
      ).length,
      1,
    );
    assert.equal(existsSync(harness.runLock), false);

    for (const bootstrapSignal of ["HUP", "INT", "TERM"]) {
      const interrupted = harness.run({ bootstrapSignal });
      assert.notEqual(interrupted.status, 0);
      assert.equal(
        readFileSync(harness.target, "utf8"),
        harness.installedSentinel,
      );
      assert.equal(existsSync(harness.runLock), false);
    }

    for (const renameSignal of ["HUP", "INT", "TERM"]) {
      const interrupted = harness.run({ renameSignal });
      assert.notEqual(interrupted.status, 0);
      assert.equal(
        readFileSync(harness.target, "utf8"),
        harness.installedSentinel,
      );
      assert.deepEqual(harness.operations(), ["print:absent", "print:absent"]);
      assert.equal(existsSync(harness.runLock), false);
    }

    const committedAfterSignal = harness.run({
      bootstrapSignal: "TERM",
      signalBootstrapSucceeds: true,
    });
    assert.notEqual(committedAfterSignal.status, 0);
    assert.notEqual(
      readFileSync(harness.target, "utf8"),
      harness.installedSentinel,
    );
    assert.deepEqual(harness.operations(), [
      "print:absent",
      "print:absent",
      "bootstrap",
    ]);
    assert.equal(existsSync(harness.runLock), false);

    const replacedLock = harness.run({ replaceLock: true });
    assert.equal(
      replacedLock.status,
      0,
      replacedLock.stdout + replacedLock.stderr,
    );
    assert.equal(readFileSync(harness.runLock, "utf8"), "replacement-owner\n");
    assert.equal(
      readFileSync(harness.installLock, "utf8"),
      "replacement-installer\n",
    );

    harness.reset();
    const firstOutput = { stdout: "", stderr: "" };
    const first = spawn("/bin/bash", [installer], {
      cwd: harness.checkout,
      env: harness.environment({ holdFirstPrint: true }),
    });
    first.stdout.on("data", (chunk) => (firstOutput.stdout += chunk));
    first.stderr.on("data", (chunk) => (firstOutput.stderr += chunk));
    const firstExit = new Promise((resolve) => first.on("close", resolve));
    const deadline = Date.now() + 5000;
    while (!existsSync(harness.holdReady) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(harness.holdReady), true, firstOutput.stderr);
    const second = spawnSync("/bin/bash", [installer], {
      cwd: harness.checkout,
      encoding: "utf8",
      env: harness.environment(),
    });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /run lock already exists/);
    assert.equal(
      readFileSync(harness.target, "utf8"),
      harness.installedSentinel,
    );
    writeFileSync(harness.holdRelease, "release\n");
    assert.equal(await firstExit, 0, firstOutput.stdout + firstOutput.stderr);
    assert.equal(existsSync(harness.runLock), false);
    assert.doesNotMatch(harness.operations().join("\n"), /unexpected|bootout/);

    const sharedHome = path.dirname(path.dirname(harness.targetDir));
    const otherCheckout = makeHarness({ sharedHome });
    try {
      harness.reset();
      otherCheckout.reset();
      const globalFirstOutput = { stdout: "", stderr: "" };
      const globalFirst = spawn("/bin/bash", [installer], {
        cwd: harness.checkout,
        env: harness.environment({ holdFirstPrint: true }),
      });
      globalFirst.stdout.on(
        "data",
        (chunk) => (globalFirstOutput.stdout += chunk),
      );
      globalFirst.stderr.on(
        "data",
        (chunk) => (globalFirstOutput.stderr += chunk),
      );
      const globalFirstExit = new Promise((resolve) =>
        globalFirst.on("close", resolve),
      );
      const globalDeadline = Date.now() + 5000;
      while (!existsSync(harness.holdReady) && Date.now() < globalDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        existsSync(harness.holdReady),
        true,
        globalFirstOutput.stderr,
      );
      const globalSecond = spawnSync("/bin/bash", [installer], {
        cwd: otherCheckout.checkout,
        encoding: "utf8",
        env: otherCheckout.environment(),
      });
      assert.notEqual(globalSecond.status, 0);
      assert.match(globalSecond.stderr, /target transaction lock/);
      assert.deepEqual(otherCheckout.operations(), []);
      assert.equal(
        readFileSync(harness.target, "utf8"),
        harness.installedSentinel,
      );
      writeFileSync(harness.holdRelease, "release\n");
      assert.equal(
        await globalFirstExit,
        0,
        globalFirstOutput.stdout + globalFirstOutput.stderr,
      );
      assert.equal(existsSync(harness.installLock), false);
      assert.equal(existsSync(harness.runLock), false);
      assert.equal(existsSync(otherCheckout.runLock), false);
    } finally {
      rmSync(otherCheckout.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test(
  "the launchd installer rejects a real plist with another label",
  { skip: process.platform !== "darwin" },
  () => {
    const harness = makeHarness();
    try {
      harness.reset({ prior: false });
      mkdirSync(harness.targetDir, { recursive: true });
      cpSync(template, harness.target);
      const relabel = spawnSync(
        "/usr/bin/plutil",
        ["-replace", "Label", "-string", "org.example.other", harness.target],
        { encoding: "utf8" },
      );
      assert.equal(relabel.status, 0, relabel.stdout + relabel.stderr);
      const result = spawnSync("/bin/bash", [installer], {
        cwd: harness.checkout,
        encoding: "utf8",
        env: harness.environment({ realPlutil: true }),
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /expected org\.mento\.review-eval label/);
      assert.deepEqual(harness.operations(), ["print:absent"]);
      const label = spawnSync(
        "/usr/bin/plutil",
        ["-extract", "Label", "raw", "-o", "-", harness.target],
        { encoding: "utf8" },
      );
      assert.equal(label.status, 0, label.stdout + label.stderr);
      assert.equal(label.stdout.trim(), "org.example.other");
      assert.equal(existsSync(harness.installLock), false);
      assert.equal(existsSync(harness.runLock), false);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  },
);
