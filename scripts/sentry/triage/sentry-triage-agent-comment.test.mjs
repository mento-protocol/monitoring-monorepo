#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENT_COMMENT_MARKER,
  assertBodyPostable,
  assertBrokerAlive,
  BROKER_DOWN_FILE_RELATIVE,
  brokerDownFilePath,
  BROKER_PID_FILE_RELATIVE,
  buildChildEnv,
  collectSecretValues,
  decorateBody,
  isZombieProcStatus,
  ISSUE_ENV_VAR,
  MIN_SECRET_LENGTH,
  parseArgs,
  postAgentComment,
  probeBrokerByPid,
  redactSentryPaths,
  resolveTarget,
  SENTRY_ROUTES,
  TARGET_FILE_RELATIVE,
  targetFilePath,
  VERDICT_MARKER,
} from "./sentry-triage-agent-comment.mjs";

const RUNNER_TEMP_FOR_TESTS = "/runner/_temp";
const SENTRY_TOKEN = "sntrys_deadbeefdeadbeefdeadbeef";
const GH_TOKEN = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";
const OAUTH_TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

const VERDICT_BODY = [
  VERDICT_MARKER,
  "",
  "```yaml",
  "verdict: upstream-transient",
  "confidence: high",
  "```",
  "",
  "Third-party outage; nothing to fix here.",
].join("\n");

function baseEnv(overrides = {}) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/runner",
    RUNNER_TEMP: RUNNER_TEMP_FOR_TESTS,
    GITHUB_REPOSITORY: "mento-protocol/monitoring-monorepo",
    [ISSUE_ENV_VAR]: "123",
    GH_TOKEN,
    SENTRY_TRIAGE_TOKEN: SENTRY_TOKEN,
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
    ...overrides,
  };
}

/**
 * A pid record as the trusted broker step leaves it: read-only, in its own
 * directory. The directory is left writable here so the tests can clean up;
 * that it is LOCKED on the runner is asserted separately, against the workflow
 * and against a real 0555 directory.
 */
function stagePid(dir, value, mode = 0o444, directoryMode = 0o555) {
  const path = join(dir, BROKER_PID_FILE_RELATIVE);
  const identityDir = dirname(path);
  mkdirSync(identityDir, { recursive: true });
  // Unlock the directory to (re)stage: a locked one denies the unlink and the
  // create below, which is exactly the property under test.
  chmodSync(identityDir, 0o755);
  // The staged record is read-only, so a re-stage replaces it rather than
  // reopening it for write — which is the very thing this mode forbids.
  rmSync(path, { force: true });
  writeFileSync(path, String(value));
  chmodSync(path, mode);
  chmodSync(identityDir, directoryMode);
  return path;
}

/** Remove a staged record, unlocking the directory first — the lock denies the
 * unlink, which is the point of it. The directory is left locked afterwards so
 * the "no record at all" case still faces the real staging shape. */
function unstagePid(dir) {
  const path = join(dir, BROKER_PID_FILE_RELATIVE);
  const identityDir = dirname(path);
  chmodSync(identityDir, 0o755);
  rmSync(path, { force: true });
  chmodSync(identityDir, 0o555);
}

/** Unlock anything stagePid locked, then remove the tree. A 0555 directory
 * denies the unlink `rmSync` needs, so cleanup has to undo the lock first. */
function cleanupTemp(dir) {
  try {
    chmodSync(join(dir, dirname(BROKER_PID_FILE_RELATIVE)), 0o755);
  } catch {
    // Not every temp dir stages a pid record.
  }
  rmSync(dir, { recursive: true, force: true });
}

/** A pinned target file as the trusted workflow step leaves it: read-only. */
function pin({
  repo = "mento-protocol/monitoring-monorepo",
  issue = "123",
} = {}) {
  return () => ({
    content: JSON.stringify({ repo, issue }),
    mode: 0o100444,
  });
}

/** Drive the whole flow with the gh call — argv, env and stdin — captured. */
async function post({
  argv = ["--body", VERDICT_BODY],
  env = baseEnv(),
  readPinnedTarget = pin(),
  readBrokerDown = () => null,
  probeBroker = () => true,
} = {}) {
  const calls = [];
  const result = await postAgentComment({
    argv,
    env,
    readPinnedTarget,
    readBrokerDown,
    probeBroker,
    runGh: (args, childEnv, stdin) => {
      calls.push({ args, childEnv, stdin });
      return Promise.resolve(
        "https://github.com/o/r/issues/123#issuecomment-1\n",
      );
    },
  });
  return { result, calls };
}

async function refusal(options) {
  let thrown = null;
  const calls = [];
  try {
    await postAgentComment({
      argv: options.argv ?? ["--body", VERDICT_BODY],
      env: options.env ?? baseEnv(),
      readPinnedTarget: options.readPinnedTarget ?? pin(),
      readBrokerDown: options.readBrokerDown ?? (() => null),
      probeBroker: options.probeBroker ?? (() => true),
      runGh: (args) => {
        calls.push(args);
        return Promise.resolve("");
      },
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "expected the wrapper to refuse");
  assert.deepEqual(calls, [], "a refused post must never reach gh");
  return thrown;
}

// ── the write target comes from the trusted pinned file ──────────────────────

test("the target is read from the pinned file, not from argv", async () => {
  const { calls } = await post();
  assert.deepEqual(calls[0].args, [
    "issue",
    "comment",
    "123",
    "--repo",
    "mento-protocol/monitoring-monorepo",
    "--body-file",
    "-",
  ]);
});

test("the pinned file lives under RUNNER_TEMP at a fixed relative path", () => {
  assert.equal(
    targetFilePath(baseEnv()),
    `/runner/_temp/${TARGET_FILE_RELATIVE}`,
  );
  assert.throws(
    () => targetFilePath(baseEnv({ RUNNER_TEMP: "" })),
    /RUNNER_TEMP/,
  );
});

test("REGRESSION #1288: a shell-mutated env var cannot retarget the write", async () => {
  // `--body "…$((SENTRY_TRIAGE_COMMENT_ISSUE=1234))…"` is expanded by the
  // AGENT'S shell, so node starts with the attacker's number already in
  // process.env. Verified against bash: the child sees 1234. The pinned file
  // is what decides, and the disagreement is what gets reported.
  const err = await refusal({
    env: baseEnv({ [ISSUE_ENV_VAR]: "1234" }),
    readPinnedTarget: pin({ issue: "123" }),
  });
  assert.match(err.message, /write-target mismatch/);
  assert.match(err.message, /pinned file says 123/);
  assert.match(err.message, /says 1234/);
});

test("a mutated GITHUB_REPOSITORY cannot retarget the write either", async () => {
  const err = await refusal({
    env: baseEnv({ GITHUB_REPOSITORY: "attacker/repo" }),
  });
  assert.match(err.message, /write-target mismatch/);
  assert.match(err.message, /mento-protocol\/monitoring-monorepo/);
});

test("a WRITABLE pin is refused — a pin that can be rewritten is not a pin", async () => {
  for (const mode of [0o100644, 0o100666, 0o100464, 0o100446]) {
    const err = await refusal({
      readPinnedTarget: () => ({
        content: JSON.stringify({
          repo: "mento-protocol/monitoring-monorepo",
          issue: "123",
        }),
        mode,
      }),
    });
    assert.match(err.message, /is writable/, `mode ${mode.toString(8)}`);
  }
});

test("a missing, unparsable or malformed pin refuses", async () => {
  const missing = await refusal({
    readPinnedTarget: () => {
      throw new Error("ENOENT: no such file or directory");
    },
  });
  assert.match(missing.message, /cannot read the pinned write target/);

  const garbage = await refusal({
    readPinnedTarget: () => ({ content: "not json", mode: 0o100444 }),
  });
  assert.match(garbage.message, /not valid JSON/);

  for (const issue of ["", "12a", " ", "-1", "1_2"]) {
    const err = await refusal({
      readPinnedTarget: () => ({
        content: JSON.stringify({
          repo: "mento-protocol/monitoring-monorepo",
          issue,
        }),
        mode: 0o100444,
      }),
    });
    assert.match(err.message, /no integer issue/, JSON.stringify(issue));
  }

  const badRepo = await refusal({
    readPinnedTarget: () => ({
      content: JSON.stringify({ repo: "not-a-repo", issue: "123" }),
      mode: 0o100444,
    }),
  });
  assert.match(badRepo.message, /no owner\/repo/);
});

test("the wrapper hands gh no filesystem path, so none can be swapped", async () => {
  // The body-file argument is literally "-" (stdin). The pin is the only path
  // this script touches at all, and it only ever reads it.
  const { calls } = await post();
  const bodyFileValue = calls[0].args[calls[0].args.indexOf("--body-file") + 1];
  assert.equal(bodyFileValue, "-");
  assert.ok(
    !calls[0].args.some((arg) => arg.startsWith("/")),
    "no absolute path may appear in gh's argv",
  );
  assert.ok(
    !calls[0].args.some((arg) => arg.includes(RUNNER_TEMP_FOR_TESTS)),
    "nothing under RUNNER_TEMP may be handed to gh",
  );
});

test("digit-extension is closed by construction: the body cannot retarget", async () => {
  const body = `${VERDICT_BODY}\n\nSee also 1234 and 12345.`;
  const { calls } = await post({ argv: ["--body", body] });
  assert.equal(calls[0].args[2], "123");
});

test("an issue number passed as an argument is refused, not honoured", async () => {
  const err = await refusal({ argv: ["1234", "--body", VERDICT_BODY] });
  assert.match(err.message, /unexpected argument '1234'/);
});

test("--issue is not a flag this script understands", async () => {
  const err = await refusal({
    argv: ["--issue", "1234", "--body", VERDICT_BODY],
  });
  assert.match(err.message, /unexpected argument '--issue'/);
});

test("a missing RUNNER_TEMP refuses", () => {
  assert.throws(
    () => resolveTarget(baseEnv({ RUNNER_TEMP: "" }), pin()),
    /RUNNER_TEMP/,
  );
});

// ── a dead credential broker is not a verdict (#1956) ───────────────────────

const BROKER_DOWN_RECORD = [
  "The Sentry credential broker (pid 4242) exited while the triage agent was running; this round is void.",
  "--- /runner/_temp/sentry-mcp-broker.log ---",
  "sentry-mcp-broker: GET /api/0/organizations/mentolabs/issues/6817342991/events/a1b2c3d4e5f60718293a4b5c6d7e8f90/ -> 200 (18213b)",
  "sentry-mcp-broker: SERVER-ERROR read ECONNRESET",
].join("\n");

test("the broker-down marker lives under RUNNER_TEMP at a fixed relative path", () => {
  assert.equal(
    brokerDownFilePath(baseEnv()),
    `/runner/_temp/${BROKER_DOWN_FILE_RELATIVE}`,
  );
  assert.throws(
    () => brokerDownFilePath(baseEnv({ RUNNER_TEMP: "" })),
    /RUNNER_TEMP/,
  );
});

test("a verdict is refused when the broker died mid-run", async () => {
  // The broker is backgrounded and the job ends with the agent, so its exit
  // fails no step. Withholding the comment is what turns that into a failed
  // round: the verdict job then finds no verdict, fails loudly, and leaves
  // sentry:needs-triage on the stub for the next scheduled run.
  const err = await refusal({ readBrokerDown: () => BROKER_DOWN_RECORD });
  assert.match(err.name, /^BrokerDownError$/);
  assert.match(err.message, /the Sentry credential broker exited/);
  assert.match(err.message, new RegExp(BROKER_DOWN_FILE_RELATIVE));
  // The one-line ::error:: annotation carries the refusal; the marker — the
  // watchdog's reason AND the broker log — rides separately, because that is
  // what makes the failure attributable in the job log.
  assert.equal(err.detail, BROKER_DOWN_RECORD);
  assert.match(err.detail, /SERVER-ERROR read ECONNRESET/);
  // Single-line, or the run annotation swallows the rest.
  assert.ok(!err.message.includes("\n"), "the annotation must be one line");
});

test("an unreadable marker refuses too — present and unreadable is not absent", async () => {
  // Through the DEFAULT reader, so this pins the ENOENT-only rule rather than
  // an injected stub's behaviour. A directory where the marker should be is
  // the cheapest read error that is not ENOENT.
  const dir = mkdtempSync(join(tmpdir(), "sentry-triage-broker-"));
  try {
    mkdirSync(join(dir, BROKER_DOWN_FILE_RELATIVE));
    await assert.rejects(
      () => assertBrokerAlive(baseEnv({ RUNNER_TEMP: dir })),
      /could not be read/,
    );
  } finally {
    cleanupTemp(dir);
  }
});

test("no marker and a live broker means no interference with a normal post", async () => {
  const { calls } = await post({
    readBrokerDown: () => null,
    probeBroker: () => true,
  });
  assert.equal(calls.length, 1);
});

test("THE RACE: an unpublished marker does not let a blind verdict through", async () => {
  // The watchdog polls, so it lags the death it reports. The live probe does
  // not, and it is read in the instant before the post — so the window between
  // the broker going and the marker appearing is not an opening.
  const err = await refusal({
    readBrokerDown: () => null,
    probeBroker: () => false,
  });
  assert.match(err.name, /^BrokerDownError$/);
  assert.match(err.message, /process is gone/);
  assert.ok(!err.message.includes("\n"), "the annotation must be one line");
});

test("the live probe follows the broker PROCESS, both ways", async () => {
  // Against a real process, because that is the whole claim: alive passes,
  // gone refuses. A port cannot carry this — the kernel completes a handshake
  // from the listen backlog while the owner is on its way out, and once the
  // port is released anything that rebinds it answers in the broker's place.
  const dir = mkdtempSync(join(tmpdir(), "sentry-triage-broker-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    const env = baseEnv({ RUNNER_TEMP: dir });
    stagePid(dir, child.pid);
    await assertBrokerAlive(env);

    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    await assert.rejects(() => assertBrokerAlive(env), /process is gone/);
  } finally {
    child.kill("SIGKILL");
    cleanupTemp(dir);
  }
});

test("a ZOMBIE broker reads as gone, not as alive", () => {
  // `kill -0` answers "has a pid". A process that has exited keeps its pid
  // until someone reaps it, and a container job's PID 1 does not reap — so on
  // signal 0 alone an exited broker would read as alive, which is the silent
  // fail-open this whole mechanism exists to close.
  assert.equal(isZombieProcStatus("Name:\tnode\nState:\tZ (zombie)\n"), true);
  assert.equal(isZombieProcStatus("State:Z (zombie)"), true);
  for (const live of [
    "Name:\tnode\nState:\tS (sleeping)\n",
    "Name:\tnode\nState:\tR (running)\n",
    "Name:\tzsh\nState:\tD (disk sleep)\n",
    // Not the State line, and not a state at all.
    "Name:\tZ\nState:\tS (sleeping)\n",
    "State:\tZombieish\n".replace("Zombieish", "S (sleeping)"),
    "",
  ]) {
    assert.equal(isZombieProcStatus(live), false, JSON.stringify(live));
  }
  // No procfs to read refines nothing: the signal-0 answer stands.
  assert.equal(isZombieProcStatus(null), false);
  assert.equal(isZombieProcStatus(undefined), false);
});

test("the probe CONSULTS that state — an alive pid can still read as gone", () => {
  // Wiring, not the predicate: this pid is genuinely alive, so signal 0 alone
  // would say "up". The status is what overrules it. macOS has no procfs, so
  // the reader is injected rather than staged on disk.
  const dir = mkdtempSync(join(tmpdir(), "sentry-triage-broker-"));
  try {
    const env = baseEnv({ RUNNER_TEMP: dir });
    stagePid(dir, process.pid);
    const asked = [];
    const read = (pid) => {
      asked.push(pid);
      return "Name:\tnode\nState:\tZ (zombie)\n";
    };
    assert.equal(probeBrokerByPid(env, read), false);
    assert.deepEqual(asked, [process.pid], "the recorded pid, and only it");
    assert.equal(
      probeBrokerByPid(env, () => "State:\tS (sleeping)\n"),
      true,
    );
    assert.equal(
      probeBrokerByPid(env, () => null),
      true,
    );
  } finally {
    cleanupTemp(dir);
  }
});

test("the live probe identifies the broker from a file, not the environment", async () => {
  // SENTRY_MCP_BROKER_PORT is job env, so the agent's own shell can reassign it
  // before this process starts. The pid record is written by the trusted broker
  // step before the agent exists, and a record that is not exactly a pid — a
  // truncated write, a numeric prefix parseInt would happily accept — refuses
  // rather than naming some other process.
  const dir = mkdtempSync(join(tmpdir(), "sentry-triage-broker-"));
  try {
    const env = baseEnv({
      RUNNER_TEMP: dir,
      SENTRY_MCP_BROKER_PORT: "45678",
    });
    for (const bad of [
      `${process.pid} garbage`,
      `${process.pid}x`,
      `${process.pid}\ncorrupt`,
      "0",
      "1",
      "",
      "-1",
      "12345678901",
    ]) {
      stagePid(dir, bad);
      await assert.rejects(
        () => assertBrokerAlive(env),
        /is not a pid/,
        JSON.stringify(bad),
      );
    }

    // No pid record at all is a refusal, never a pass.
    unstagePid(dir);
    await assert.rejects(() => assertBrokerAlive(env), /pid record/);
  } finally {
    cleanupTemp(dir);
  }
});

test("a WRITABLE pid record refuses — it is not evidence of anything", async () => {
  // The agent's permitted `gh issue view … --template … > path` writes
  // arbitrary text to any path this user can write, so a pid record the agent
  // can reach is a pid record the agent chooses. Write its own (alive) pid
  // there and a dead broker would read as alive, leaving only the watchdog's
  // poll lag between it and a blind verdict. The record is published read-only
  // and this refuses if it ever is not — which also catches the workflow step
  // dropping the chmod.
  const dir = mkdtempSync(join(tmpdir(), "sentry-triage-broker-"));
  try {
    const env = baseEnv({ RUNNER_TEMP: dir });
    for (const mode of [0o666, 0o644, 0o600, 0o444 | 0o200]) {
      stagePid(dir, process.pid, mode);
      await assert.rejects(
        () => assertBrokerAlive(env),
        /pid record .* is writable/,
        `mode ${mode.toString(8)}`,
      );
    }
    // …and the read-only record the workflow actually publishes passes.
    stagePid(dir, process.pid, 0o444);
    await assertBrokerAlive(env);
  } finally {
    cleanupTemp(dir);
  }
});

test("a WRITABLE DIRECTORY refuses even when the record itself is 0444", async () => {
  // Write permission on a DIRECTORY governs unlink and rename, not the mode of
  // the file inside it. So a 0444 record in a 0755 directory protects nothing:
  // delete it, lay down your own pid, chmod the replacement back to 0444, and
  // a check that looked only at the file's mode waves it through. Verified on
  // a real filesystem — at 0755 both unlink-and-recreate and rename-over
  // succeed and the replacement reads 0444; at 0555 the unlink is denied.
  if (process.getuid && process.getuid() === 0) return; // root ignores modes
  const dir = mkdtempSync(join(tmpdir(), "sentry-triage-broker-"));
  try {
    const env = baseEnv({ RUNNER_TEMP: dir });
    const path = stagePid(dir, process.pid, 0o444, 0o755);

    // The substitution a file-mode check alone cannot see: the record is
    // replaced wholesale and the replacement still reads as read-only.
    rmSync(path);
    writeFileSync(path, String(process.pid));
    chmodSync(path, 0o444);
    assert.equal(
      statSync(path).mode & 0o777,
      0o444,
      "the planted record reads as locked",
    );
    await assert.rejects(
      () => assertBrokerAlive(env),
      /directory holding the broker's pid record/,
      "a planted record in a writable directory must refuse",
    );

    // Every writable directory mode refuses, not just 0755.
    for (const directoryMode of [0o777, 0o775, 0o755, 0o700]) {
      stagePid(dir, process.pid, 0o444, directoryMode);
      await assert.rejects(
        () => assertBrokerAlive(env),
        /is writable \(mode/,
        `directory mode ${directoryMode.toString(8)}`,
      );
    }

    // …and the locked pair the workflow actually publishes passes.
    stagePid(dir, process.pid, 0o444, 0o555);
    await assertBrokerAlive(env);
  } finally {
    cleanupTemp(dir);
  }
});

test("the staged pid lock denies the agent's write primitive outright", () => {
  // The mode is not decoration. 0444 in a 0555 directory makes the redirection
  // fail EACCES rather than merely being refused after the fact, and blocks the
  // unlink-and-recreate that would otherwise route around it. Asserted against
  // a real filesystem, since this is a kernel property and not a claim.
  if (process.getuid && process.getuid() === 0) return; // root ignores modes
  const dir = mkdtempSync(join(tmpdir(), "sentry-triage-broker-lock-"));
  const path = stagePid(dir, process.pid, 0o444);
  const identityDir = dirname(path);
  try {
    chmodSync(identityDir, 0o555);
    assert.throws(() => writeFileSync(path, "1234"), { code: "EACCES" });
    assert.throws(() => rmSync(path), { code: "EACCES" });
    assert.throws(() => writeFileSync(join(identityDir, "other"), "x"), {
      code: "EACCES",
    });
    // Control: the same writes succeed once the lock is off, so the assertions
    // above are the mode talking and not the path being wrong.
    chmodSync(identityDir, 0o755);
    chmodSync(path, 0o644);
    writeFileSync(path, "1234");
    assert.equal(readFileSync(path, "utf8"), "1234");
  } finally {
    chmodSync(identityDir, 0o755);
    cleanupTemp(dir);
  }
});

test("THE RACE, other way: a marker published DURING the probe still refuses", async () => {
  // The probe awaits, so a broker that dies inside that await is published by
  // the watchdog only afterwards. Reading the marker once, before the probe,
  // would miss it and post — with the attributable record already on disk.
  let reads = 0;
  const err = await refusal({
    readBrokerDown: () => (reads++ === 0 ? null : BROKER_DOWN_RECORD),
    probeBroker: () => Promise.resolve(true),
  });
  assert.equal(reads, 2, "the marker must be read on both sides of the probe");
  assert.match(err.message, /the Sentry credential broker exited/);
  assert.equal(err.detail, BROKER_DOWN_RECORD);
});

test("the probe cannot disturb the broker it checks", async () => {
  // The broker's fatal path hangs off its server `error` event, so a probe that
  // spoke to it could take down the thing it was asking about. This one opens
  // no connection and sends no signal — the pid check is signal 0 — so a live
  // broker sees nothing at all.
  const dir = mkdtempSync(join(tmpdir(), "sentry-triage-broker-"));
  const received = [];
  const server = createServer((socket) => {
    socket.on("data", (chunk) => received.push(chunk));
  });
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    stagePid(dir, process.pid);
    await assertBrokerAlive(baseEnv({ RUNNER_TEMP: dir }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(connections, 0, "the probe must open no connection");
    assert.deepEqual(received, [], "the probe must send no bytes");
  } finally {
    server.close();
    cleanupTemp(dir);
  }
});

test("the marker wins over a live probe — it carries the broker's log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentry-triage-broker-"));
  try {
    writeFileSync(join(dir, BROKER_DOWN_FILE_RELATIVE), BROKER_DOWN_RECORD);
    await assert.rejects(
      () =>
        assertBrokerAlive(baseEnv({ RUNNER_TEMP: dir }), undefined, () => true),
      /the Sentry credential broker exited/,
    );
  } finally {
    cleanupTemp(dir);
  }
});

test("END TO END: the refusal prints the broker log where the job log sees it", () => {
  // The whole point of putting this gate in the wrapper: the agent step's own
  // stdio is the only surface inside that step which reaches the run log, and
  // a background watchdog has none. So drive the real CLI and read its stderr.
  const dir = mkdtempSync(join(tmpdir(), "sentry-triage-broker-cli-"));
  try {
    mkdirSync(join(dir, "sentry-triage-target"));
    const pinPath = join(dir, TARGET_FILE_RELATIVE);
    writeFileSync(
      pinPath,
      JSON.stringify({
        repo: "mento-protocol/monitoring-monorepo",
        issue: "7",
      }),
    );
    chmodSync(pinPath, 0o444);
    writeFileSync(join(dir, BROKER_DOWN_FILE_RELATIVE), BROKER_DOWN_RECORD);

    const run = spawnSync(
      process.execPath,
      [
        join(SCRIPTS_DIR, "sentry-triage-agent-comment.mjs"),
        "--body",
        VERDICT_BODY,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: dir,
          GITHUB_REPOSITORY: "mento-protocol/monitoring-monorepo",
          [ISSUE_ENV_VAR]: "7",
        },
      },
    );

    assert.notEqual(run.status, 0, "a refusal must exit non-zero");
    // One-line annotation, so the runner renders it as an error on the run.
    assert.match(
      run.stderr,
      /^::error::sentry-triage-agent-comment: refusing to post: the Sentry credential broker exited[^\n]*\n/m,
    );
    // …and the broker's own log follows it, which is what makes the failure
    // attributable to a cause rather than just loud.
    assert.match(run.stderr, /SERVER-ERROR read ECONNRESET/);
    assert.match(run.stderr, /sentry-mcp-broker\.log ---/);
    // …but WITHOUT the Sentry coordinates. This stderr is the public run log of
    // a public repository; the route shape is the diagnostic, the ids are not.
    assert.ok(
      !run.stderr.includes("6817342991"),
      "the issue id must not reach the public run log",
    );
    assert.ok(
      !run.stderr.includes("a1b2c3d4e5f60718293a4b5c6d7e8f90"),
      "the event id must not reach the public run log",
    );
    assert.match(
      run.stderr,
      /GET \/api\/0\/organizations\/<redacted>\/issues\/<redacted>\/events\/<redacted>\/ -> 200 \(18213b\)/,
      "the route, method, status and byte count must survive redaction",
    );
  } finally {
    cleanupTemp(dir);
  }
});

// ── the broker log is publishable only after redaction ──────────────────────

test("redaction keeps the route shape and drops every coordinate", () => {
  assert.equal(
    redactSentryPaths(
      "sentry-mcp-broker: GET /api/0/organizations/mentolabs/issues/68173/ -> 200 (91b)",
    ),
    "sentry-mcp-broker: GET /api/0/organizations/<redacted>/issues/<redacted>/ -> 200 (91b)",
  );
  // Query strings go whole: they carry the agent's search terms and filters.
  assert.equal(
    redactSentryPaths(
      "/api/0/organizations/mentolabs/events/?query=is:unresolved",
    ),
    "/api/0/organizations/<redacted>/events/?<redacted>",
  );
  // An upstream error message embeds the absolute URL; the host is not a
  // coordinate, everything after /api/0/ is.
  assert.equal(
    redactSentryPaths(
      "sentry-mcp-broker: UPSTREAM-ERROR https://us.sentry.io/api/0/organizations/mentolabs/trace/deadbeef/ — fetch failed",
    ),
    "sentry-mcp-broker: UPSTREAM-ERROR https://us.sentry.io/api/0/organizations/<redacted>/trace/<redacted>/ — fetch failed",
  );
  // Text with no Sentry path is untouched, so a refusal reason still reads.
  const plain = "sentry-mcp-broker: SERVER-ERROR listen EADDRINUSE";
  assert.equal(redactSentryPaths(plain), plain);
});

/** The broker's ALLOWED_PATHS, re-derived from its source into the same
 * `*`-for-a-coordinate shape SENTRY_ROUTES uses. */
function brokerRoutes() {
  const brokerSource = readFileSync(
    join(SCRIPTS_DIR, "..", "broker", "sentry-mcp-broker.mjs"),
    "utf8",
  );
  const start = brokerSource.indexOf("export const ALLOWED_PATHS = [");
  const end = brokerSource.indexOf("\n];", start);
  assert.ok(start > 0 && end > start, "ALLOWED_PATHS not found in the broker");
  const block = brokerSource.slice(start, end);
  const patterns = [...block.matchAll(/`([^`]+)`|path\("([^"]+)"\)/g)].map(
    (m) => m[1] ?? m[2],
  );
  assert.ok(
    patterns.length >= 18,
    `expected the whole allowlist, parsed ${patterns.length}`,
  );
  return patterns.map((p) => p.replaceAll("${SEG}", "*"));
}

test("the redactor's route table IS the broker's allowlist", () => {
  // Drift guard, and the reason redaction can be positional at all. The guard
  // module must not import the broker — the workflow stages that module
  // separately and the wrapper's closure is asserted — so the table is
  // re-derived HERE and compared whole. A route the broker learns and this
  // table has not is a path that falls through to the unmatched branch.
  assert.deepEqual([...SENTRY_ROUTES].sort(), brokerRoutes().sort());
});

test("redaction is POSITIONAL — a slug equal to a route word still goes", () => {
  // The bug this replaced: a global "is this segment a known route word?"
  // membership test published any coordinate whose value happened to be one.
  // Route words are not a reserved namespace — an organization really can be
  // named `events`, a monitor slug really can be `replays`. A segment is a
  // coordinate because of WHERE it sits in a matched route, and nothing else.
  const cases = [
    // org slug == a route word, at the org position
    [
      "/api/0/organizations/events/issues/123/",
      "/api/0/organizations/<redacted>/issues/<redacted>/",
    ],
    // monitor slug == a route word, at the monitor position
    [
      "/api/0/organizations/mento/monitors/replays/",
      "/api/0/organizations/<redacted>/monitors/<redacted>/",
    ],
    // BOTH segments of the project route == route words
    ["/api/0/projects/trace/images/", "/api/0/projects/<redacted>/<redacted>/"],
    // an issue id that spells a route word, and an org that spells another
    [
      "/api/0/organizations/issues/issues/events/",
      "/api/0/organizations/<redacted>/issues/<redacted>/",
    ],
    // the deepest route, every coordinate a route word
    [
      "/api/0/organizations/snapshots/preprodartifacts/snapshots/images/images/api/",
      "/api/0/organizations/<redacted>/preprodartifacts/snapshots/<redacted>/images/<redacted>/",
    ],
    // ordinary values still read as before
    [
      "/api/0/organizations/mentolabs/issues/68173/",
      "/api/0/organizations/<redacted>/issues/<redacted>/",
    ],
    // THE TIE-BREAK. This path matches both `…/events/latest/` and the
    // events-by-id route, which are the same length. The more-redacting route
    // must win: preferring the literal one publishes an event id that happens
    // to be `latest`, which is the whole class of bug this replaced.
    [
      "/api/0/organizations/mento/issues/123/events/latest/",
      "/api/0/organizations/<redacted>/issues/<redacted>/events/<redacted>/",
    ],
  ];
  for (const [path, expected] of cases) {
    assert.equal(redactSentryPaths(path), expected, path);
  }
});

test("an UNMATCHED path is redacted whole, not guessed at", () => {
  // A path the broker refused, or one a newer MCP server produced, has no
  // known structure. Without a pattern there is no way to tell a route word
  // from an identifier, so every segment past `/api/0/` goes. That costs the
  // new route word deliberately — re-deriving the allowlist is done against a
  // capture server, not by reading a public run log.
  assert.equal(
    redactSentryPaths("/api/0/organizations/mento/issues/9/tags/browser/"),
    "/api/0/<redacted>/<redacted>/<redacted>/<redacted>/<redacted>/<redacted>/",
  );
  assert.equal(
    redactSentryPaths(
      "DENY 403 GET /api/0/internal/quotas/ — path not allowed",
    ),
    "DENY 403 GET /api/0/<redacted>/<redacted>/ — path not allowed",
  );
});

/** Route words that sit where another same-length route puts a coordinate.
 * Publishing one would be a guess, so the tie-break redacts it. */
function ambiguousLiterals(routes) {
  const segs = routes.map((r) => r.split("/"));
  const ambiguous = new Set();
  for (const a of segs) {
    for (const b of segs) {
      if (a === b || a.length !== b.length) continue;
      const compatible = a.every(
        (s, i) => s === "*" || b[i] === "*" || s === b[i],
      );
      if (!compatible) continue;
      a.forEach((s, i) => {
        if (s !== "*" && s !== "" && b[i] === "*") ambiguous.add(s);
      });
    }
  }
  return ambiguous;
}

test("redaction covers EVERY path the broker's allowlist admits", () => {
  // Every allowed route, driven with a distinctive marker in each coordinate
  // position. Two properties, and the first is the security one:
  //   1. no marker may survive, anywhere;
  //   2. every route literal must survive, EXCEPT where another same-length
  //      route puts a coordinate in that position — there, publishing the word
  //      would be a guess, and the tie-break redacts it.
  const routes = brokerRoutes();
  const ambiguous = ambiguousLiterals(routes);
  // Pinned, so the exception can never quietly widen into "most words go".
  assert.deepEqual(
    [...ambiguous].sort(),
    ["latest"],
    "the set of route words that read as coordinates changed",
  );

  const COORDINATE = "Zq7CoordinateZq7";
  for (const route of routes) {
    const sample = route.replaceAll("*", COORDINATE);
    const redacted = redactSentryPaths(`GET ${sample} -> 200 (1b)`);
    assert.ok(
      !redacted.includes(COORDINATE),
      `an identifier survives redaction in ${route}`,
    );
    for (const segment of route.split("/")) {
      if (segment === "" || segment === "*" || ambiguous.has(segment)) continue;
      assert.ok(
        redacted.includes(`/${segment}`),
        `route literal '${segment}' was redacted out of ${route}`,
      );
    }
  }
});

// ── argument parsing fails closed ────────────────────────────────────────────

test("--body is required, non-empty, and single", () => {
  assert.throws(() => parseArgs([]), /--body is required/);
  assert.throws(() => parseArgs(["--body"]), /--body needs a value/);
  assert.throws(() => parseArgs(["--body", "   "]), /must not be empty/);
  assert.throws(
    () => parseArgs(["--body", "a", "--body", "b"]),
    /more than once/,
  );
  assert.deepEqual(parseArgs(["--body", "x"]), { body: "x" });
});

// ── credential hygiene guard ─────────────────────────────────────────────────
//
// These cover ACCIDENTAL inclusion — prose that reproduces a credential because
// the agent quoted an environment value, a config dump, or a failed command's
// output. They are NOT evidence of a containment control and must not be read
// as one: the agent writes the shell command, so the shell can splice or
// substitute the value before this script ever receives argv. The last test in
// this block pins that limit. Closing it means getting the credential out of
// the agent's process env, which is outside this script.

test("a body that accidentally reproduces the Sentry token is refused", async () => {
  const err = await refusal({
    argv: ["--body", `${VERDICT_BODY}\n\nnote: ${SENTRY_TOKEN}`],
  });
  assert.match(err.message, /SENTRY_TRIAGE_TOKEN/);
  assert.ok(
    !err.message.includes(SENTRY_TOKEN),
    "the refusal must name the variable, never echo the value",
  );
});

test("a body that accidentally reproduces GH_TOKEN is refused", async () => {
  const err = await refusal({
    argv: ["--body", `${VERDICT_BODY}\n\n${GH_TOKEN}`],
  });
  assert.match(err.message, /GH_TOKEN/);
  assert.ok(!err.message.includes(GH_TOKEN));
});

test("a body that accidentally reproduces the Claude OAuth token is refused", async () => {
  const err = await refusal({
    argv: ["--body", `${VERDICT_BODY}\n\n${OAUTH_TOKEN}`],
  });
  assert.match(err.message, /CLAUDE_CODE_OAUTH_TOKEN/);
});

test("the verbatim value only has to appear somewhere in the body", () => {
  const secrets = collectSecretValues(baseEnv());
  assert.throws(
    () => assertBodyPostable(`${VERDICT_MARKER} ${SENTRY_TOKEN} tail`, secrets),
    /SENTRY_TRIAGE_TOKEN/,
  );
});

test("DOCUMENTED LIMIT: the guard is not containment — a shell-transformed token passes", () => {
  const secrets = collectSecretValues(baseEnv());
  // What `--body "…${SENTRY_TRIAGE_TOKEN:0:4}x${SENTRY_TRIAGE_TOKEN:4}"` hands
  // this script: the whole token with one removable character spliced in. Bash
  // did that expansion; argv is all we ever see. Splitting the value across two
  // lines defeats the scan just as easily. Asserted, not fixed — exact-value
  // scanning is the wrong layer when the adversary controls the shell.
  const spliced = `${SENTRY_TOKEN.slice(0, 4)}x${SENTRY_TOKEN.slice(4)}`;
  const split = `${SENTRY_TOKEN.slice(0, 10)}\n${SENTRY_TOKEN.slice(10)}`;
  for (const evaded of [spliced, split]) {
    assert.doesNotThrow(
      () => assertBodyPostable(`${VERDICT_MARKER}\n\n${evaded}`, secrets),
      "the guard is documented as hygiene-only; do not assert containment here",
    );
  }
});

test("short env values are not treated as secrets", () => {
  const short = "a".repeat(MIN_SECRET_LENGTH - 1);
  const secrets = collectSecretValues(baseEnv({ GITHUB_TOKEN: short }));
  assert.ok(!secrets.some((secret) => secret.name === "GITHUB_TOKEN"));
  assert.doesNotThrow(() =>
    assertBodyPostable(`${VERDICT_MARKER}\n${short}`, secrets),
  );
});

// ── authorship marker ────────────────────────────────────────────────────────

test("every posted body is stamped agent-authored", async () => {
  const { calls } = await post();
  assert.ok(calls[0].stdin.includes(AGENT_COMMENT_MARKER));
  assert.ok(calls[0].stdin.trimEnd().endsWith(AGENT_COMMENT_MARKER));
});

test("the stamp is appended, so the verdict marker still starts the body", () => {
  const decorated = decorateBody(VERDICT_BODY);
  assert.ok(
    decorated.startsWith(VERDICT_MARKER),
    "selectVerdictComment matches on startsWith(VERDICT_MARKER)",
  );
});

test("a body that forges the authorship marker is refused", async () => {
  const err = await refusal({
    argv: ["--body", `${VERDICT_BODY}\n\n${AGENT_COMMENT_MARKER}`],
  });
  assert.match(err.message, /only this script may add/);
});

test("a body that is not a verdict comment is refused", async () => {
  const err = await refusal({
    argv: ["--body", "Regressed in Sentry (last seen 2099-01-01T00:00:00Z)"],
  });
  assert.match(err.message, /must start with/);
});

test("the start anchor blocks impersonating the pipeline's pointer comments", () => {
  const secrets = collectSecretValues(baseEnv());
  for (const forged of [
    "Projected to owning repo: https://github.com/o/r/issues/1",
    "Autofixed by PR: https://github.com/o/r/pull/1",
    "Regressed in Sentry (last seen 2099-01-01T00:00:00Z)",
  ]) {
    assert.throws(
      () => assertBodyPostable(forged, secrets),
      /must start with/,
      `expected ${JSON.stringify(forged)} to be refused`,
    );
  }
});

// ── subprocess env scrub ─────────────────────────────────────────────────────

test("the gh child env drops every secret except gh's own credential", async () => {
  const { calls } = await post();
  const childEnv = calls[0].childEnv;
  assert.deepEqual(Object.keys(childEnv).sort(), ["GH_TOKEN", "HOME", "PATH"]);
  assert.equal(childEnv.GH_TOKEN, GH_TOKEN);
  const values = Object.values(childEnv);
  assert.ok(!values.includes(SENTRY_TOKEN), "Sentry token must not reach gh");
  assert.ok(!values.includes(OAUTH_TOKEN), "OAuth token must not reach gh");
});

test("nothing outside the allowlist is inherited", () => {
  const childEnv = buildChildEnv(
    baseEnv({
      AWS_SECRET_ACCESS_KEY: "aws-secret-value",
      SENTRY_PROJECTION_TOKEN: "projection-secret-value",
      GH_HOST: "evil.example.com",
    }),
  );
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in childEnv));
  assert.ok(!("SENTRY_PROJECTION_TOKEN" in childEnv));
  assert.ok(!("GH_HOST" in childEnv));
  assert.ok(!(ISSUE_ENV_VAR in childEnv));
});

test("an absent GH_TOKEN is not forged into the child env", () => {
  const env = baseEnv();
  delete env.GH_TOKEN;
  assert.ok(!("GH_TOKEN" in buildChildEnv(env)));
});

// ── posting mechanics ────────────────────────────────────────────────────────

test("the body reaches gh on stdin, never in argv", async () => {
  const { calls, result } = await post();
  assert.equal(calls[0].stdin, decorateBody(VERDICT_BODY));
  assert.ok(!calls[0].args.includes("--body"));
  assert.ok(
    !calls[0].args.some((arg) => arg.includes("upstream-transient")),
    "the body must never appear in gh's argv",
  );
  assert.ok(
    !("bodyFile" in result),
    "the result must not carry a body-file path — there is no file",
  );
});

test("REGRESSION #1288 (TOCTOU): what gh receives is what was validated", async () => {
  // The old shape validated the body, wrote it to a predictable RUNNER_TEMP
  // path, and let gh read it back. The agent can run a second permitted
  // command concurrently (`gh issue view --template '<forged>' > that-path &`)
  // and swap the content inside that window — reproduced end to end, posting a
  // forged "Regressed in Sentry …" control comment past every fence.
  //
  // Run against a REAL temp directory: the body must arrive on stdin, and the
  // wrapper must leave the directory exactly as it found it. Against the old
  // shape this fails on both counts.
  const dir = mkdtempSync(join(tmpdir(), "sentry-triage-toctou-"));
  try {
    const before = readdirSync(dir);
    let seenStdin = null;
    await postAgentComment({
      argv: ["--body", VERDICT_BODY],
      env: baseEnv({ RUNNER_TEMP: dir }),
      readPinnedTarget: pin(),
      probeBroker: () => true,
      runGh: (args, _childEnv, stdin) => {
        // Stand where gh stands: whatever is readable at this instant is what
        // gets posted. With stdin there is nothing else to read.
        seenStdin = stdin;
        assert.deepEqual(
          readdirSync(dir),
          before,
          "the wrapper must not have created a file for gh to read",
        );
        return Promise.resolve("ok\n");
      },
    });
    assert.equal(seenStdin, decorateBody(VERDICT_BODY));
    assert.deepEqual(readdirSync(dir), before, "no file may survive the post");
  } finally {
    cleanupTemp(dir);
  }
});

test("a gh failure surfaces instead of being swallowed", async () => {
  await assert.rejects(
    postAgentComment({
      argv: ["--body", VERDICT_BODY],
      env: baseEnv(),
      readPinnedTarget: pin(),
      probeBroker: () => true,
      runGh: () => Promise.reject(new Error("gh exited 1: HTTP 403")),
      writeFile: () => Promise.resolve(),
    }),
    /HTTP 403/,
  );
});

// ── the executed closure must leave the agent-writable checkout ──────────────
//
// The agent can write the checkout: Claude Code matches `Bash(cmd:*)` against a
// command carrying a redirection (CHANGELOG v1.0.123), and `gh issue view
// --template` renders arbitrary text, so `gh issue view <n> --template '<js>' >
// scripts/sentry/triage/sentry-triage-agent-comment.mjs` is inside its read-only grants. The
// workflow therefore runs a read-only COPY from $RUNNER_TEMP. If the wrapper
// grows an import the copy step does not carry, the attack just moves one file
// over — so the closure is recomputed here from the source, not trusted to a
// comment.

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = readFileSync(
  join(
    SCRIPTS_DIR,
    "..",
    "..",
    "..",
    ".github",
    "workflows",
    "sentry-triage-agent.yml",
  ),
  "utf8",
);

/** Transitive closure of relative (in-repo) imports, entry point included. */
function importClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(SCRIPTS_DIR, file), "utf8");
    for (const match of source.matchAll(
      /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["'](\.\/[^"']+)["']/g,
    )) {
      queue.push(match[1].replace(/^\.\//, ""));
    }
  }
  return [...seen].sort();
}

test("the wrapper's runtime closure is exactly what the workflow stages", () => {
  const closure = importClosure("sentry-triage-agent-comment.mjs");
  assert.deepEqual(closure, [
    "sentry-triage-agent-comment.mjs",
    // The broker liveness fence and the public-log redactor (#1956 split, when
    // the wrapper crossed the 600-line soft cap). The wrapper calls both on the
    // posting path, so the agent's job must run them from the read-only staging
    // directory too — an unstaged guard would be loaded from the
    // agent-WRITABLE checkout, which is the whole thing this staging prevents.
    "sentry-triage-broker-guard.mjs",
    // The needs-human escalation rules the verdict contract re-exports (#1782
    // split, when project-core hit the 1000-line hard cap). Pure predicates over
    // parsed fields, but the verdict contract imports them, so they are staged
    // with it.
    "sentry-triage-escalation-contract.mjs",
    "sentry-triage-project-core.mjs",
    // The neutralization helpers the verdict contract re-exports (#1748 split);
    // the wrapper reaches them through that module, so they are part of the
    // closure the job must run from the read-only staging directory.
    "sentry-triage-text.mjs",
  ]);
  // Every file in the closure must appear in the staging step's COPY LIST —
  // the `for f in … done` loop itself, not merely somewhere in the step's
  // prose. A name that appears only in a comment is staged by nothing, and the
  // slice between two step names is full of comments that mention these files.
  const stagingStep = WORKFLOW.slice(
    WORKFLOW.indexOf("Stage immutable agent tools"),
    WORKFLOW.indexOf("Render triage prompt"),
  );
  assert.ok(stagingStep.length > 0, "staging step not found in the workflow");
  const loopStart = stagingStep.indexOf("for f in");
  const loopEnd = stagingStep.indexOf("done", loopStart);
  assert.ok(
    loopStart > 0 && loopEnd > loopStart,
    "the staging step's copy loop was not found",
  );
  const copyList = stagingStep.slice(loopStart, loopEnd);
  for (const file of closure) {
    assert.ok(
      copyList.includes(file),
      `${file} is in the wrapper's runtime closure but the staging step does not copy it`,
    );
  }
});

/** The agent job's block, from its key to the next job's. */
function triageJobBlock() {
  const start = WORKFLOW.indexOf("\n  triage:");
  const end = WORKFLOW.indexOf("\n  verdict:");
  assert.ok(
    start > 0 && end > start,
    "triage/verdict job boundaries not found",
  );
  return WORKFLOW.slice(start, end);
}

test("the agent job ENDS with the agent — nothing runs after it", () => {
  // The property that makes $GITHUB_ENV injection inert. The agent can append
  // `BASH_ENV=<payload it wrote>` to $GITHUB_ENV; GitHub exports that to every
  // later step in the SAME job, and the step's bash sources the payload before
  // running its own command — which staging immutable copies does not prevent,
  // because the payload runs first. So there must be no later step.
  const steps = [
    ...triageJobBlock().matchAll(/^ {6}- (?:name|uses):\s*(.+)$/gm),
  ].map((m) => m[1].trim());
  assert.ok(steps.length > 0, "no steps parsed out of the triage job");
  assert.match(
    steps.at(-1),
    /^anthropics\/claude-code-action@/,
    `the agent must be the LAST step of its job; found "${steps.at(-1)}" after it`,
  );
});

/** The broker step's body, from its name to the pre-flight probe step's. */
function brokerStepBlock() {
  const start = WORKFLOW.indexOf("- name: Start the Sentry credential broker");
  const end = WORKFLOW.indexOf("- name: Verify the Sentry MCP toolset");
  assert.ok(start > 0 && end > start, "broker/probe step boundaries not found");
  return WORKFLOW.slice(start, end);
}

test("a broker that dies mid-agent voids the round (#1956)", () => {
  const step = brokerStepBlock();
  // The marker's name has ONE home, the wrapper's constant. A workflow writing
  // a different name would arm nothing, and only on a live run.
  assert.match(
    step,
    new RegExp(
      `down_file="\\$\\{RUNNER_TEMP\\}/${BROKER_DOWN_FILE_RELATIVE.replace(
        /\./g,
        "\\.",
      )}"`,
    ),
    "the broker step must derive the marker path from the wrapper's constant",
  );
  // Same rule for the pid record the live probe identifies the broker by, and
  // the record must be published whole — a truncated pid names some other
  // process, or nothing.
  assert.match(
    step,
    new RegExp(
      `pid_file="\\$\\{RUNNER_TEMP\\}/${BROKER_PID_FILE_RELATIVE.replace(
        /\./g,
        "\\.",
      )}"`,
    ),
    "the broker step must record the pid where the wrapper's probe reads it",
  );
  assert.match(step, /> "\$\{pid_file\}\.partial"/);
  assert.match(step, /mv "\$\{pid_file\}\.partial" "\$\{pid_file\}"/);
  // …and the record must be LOCKED before the agent exists. The agent's
  // permitted `gh issue view … --template … > path` reaches any writable path,
  // and this record is trusted for its contents — an agent that plants a
  // long-lived pid makes a dead broker read as alive. The file read-only first,
  // then its directory, so no window leaves it writable inside a writable
  // directory.
  const lockFile = step.indexOf('chmod 0444 "${pid_file}"');
  const lockDir = step.indexOf('chmod 0555 "${identity_dir}"');
  assert.ok(lockFile > 0, "the pid record must be published read-only");
  // The DIRECTORY lock is the stronger half, not a belt-and-braces extra:
  // directory write permission governs unlink and rename, so a 0444 record in
  // a writable directory can simply be replaced. The wrapper refuses when it
  // finds either unlocked; this binds the workflow to publishing both.
  assert.ok(lockDir > lockFile, "its directory must be locked, and after it");
  assert.ok(
    lockFile > step.indexOf('mv "${pid_file}.partial" "${pid_file}"'),
    "the lock must follow the publish, not precede it",
  );
  // The record lives in that directory and not in bare $RUNNER_TEMP, which
  // stays writable for the marker.
  assert.match(
    step,
    /identity_dir="\$\{RUNNER_TEMP\}\/sentry-broker-identity"/,
  );
  assert.ok(
    BROKER_PID_FILE_RELATIVE.startsWith("sentry-broker-identity/"),
    "the wrapper must read the pid out of the locked directory",
  );
  // A reused $RUNNER_TEMP would leave the directory locked from last round, so
  // it is unlocked before removal — otherwise this step fails under set -e.
  assert.match(step, /chmod -R u\+rwX "\$\{identity_dir\}"/);
  assert.match(step, /rm -rf "\$\{identity_dir\}"/);
  // A watchdog that waits on the broker's own pid — not on the port, which a
  // later listener could re-bind, and not on the ready file, which survives it.
  assert.match(step, /while kill -0 "\$\{broker_pid\}" 2>\/dev\/null/);
  // …and, like the wrapper, does not call a zombie alive.
  assert.match(
    step,
    /grep -qs '\^State:\[\[:space:\]\]\*Z' "\/proc\/\$\{broker_pid\}\/status"/,
  );
  // Attribution: the broker's log goes INTO the marker, so the wrapper's
  // refusal carries the reason the broker died and not just the fact.
  assert.match(step, /cat "\$\{log_file\}"/);
  assert.match(step, /> "\$\{down_file\}\.partial"/);
  assert.match(step, /mv "\$\{down_file\}\.partial" "\$\{down_file\}"/);
  // Backgrounded with its streams OFF the step's pipe: the runner drains that
  // pipe before starting the next step, so a watchdog holding it would hold
  // the whole job at this step.
  assert.match(step, /\) > \/dev\/null 2>&1 &/);
  // A stale marker in a reused RUNNER_TEMP must not void a healthy round.
  assert.match(step, /rm -f "\$\{ready_file\}" "\$\{down_file\}"/);
});

test("the watchdog is armed before the agent, since nothing can follow it", () => {
  const job = triageJobBlock();
  const armed = job.indexOf('mv "${down_file}.partial" "${down_file}"');
  assert.ok(armed > 0, "the watchdog is not in the triage job at all");
  assert.ok(
    armed < job.indexOf("anthropics/claude-code-action@"),
    "the watchdog must be armed before the agent step starts",
  );
});

test("no credential-bearing work follows the agent in its job", () => {
  const job = triageJobBlock();
  const afterAgent = job.slice(job.indexOf("anthropics/claude-code-action@"));
  for (const forbidden of [
    /- name: Apply verdict label/,
    /- name: Close queue stub/,
    /gh issue edit/,
    /gh issue close/,
    /node scripts\//,
  ]) {
    assert.ok(
      !forbidden.test(afterAgent),
      `credential-bearing work follows the agent: ${forbidden}`,
    );
  }
});

test("the trusted follow-up lives in its own job, on its own runner", () => {
  const job = WORKFLOW.slice(
    WORKFLOW.indexOf("\n  verdict:"),
    WORKFLOW.indexOf("\n  project:"),
  );
  assert.match(job, /needs: \[select, triage\]/);
  assert.match(job, /Apply verdict label \(deterministic\)/);
  assert.match(job, /Close queue stub \(deterministic\)/);
  assert.match(job, /persist-credentials: false/);
  // Narrowest permissions for the work, not a copy of the agent job's, and no
  // secret-bearing environment: this job holds only github.token.
  assert.match(job, /permissions:\n\s+contents: read\n\s+issues: write/);
  assert.ok(
    !/environment:/.test(job),
    "the verdict job holds no secret and must not claim a secret environment",
  );
  // Its checkout is pristine and the agent never touched this runner, so plain
  // scripts/ is correct HERE — and only here.
  assert.match(job, /node scripts\/sentry\/triage\/sentry-triage-project\.mjs/);
});

test("the verdict edit sheds the other verdict labels and proves it landed", () => {
  const job = WORKFLOW.slice(
    WORKFLOW.indexOf("\n  verdict:"),
    WORKFLOW.indexOf("\n  project:"),
  );
  // The shed list comes from the SAME --parse-only output as the label, so the
  // workflow never carries a second literal copy of the verdict namespace.
  assert.match(job, /shed=\$\(jq -r '\.shed' "\$\{parse_file\}"\)/);
  assert.match(job, /--remove-label "sentry:needs-triage,\$\{shed\}"/);
  // Deleting the shed and going back to the bare removal must fail here.
  assert.ok(
    !/--remove-label ['"]sentry:needs-triage['"]/.test(job),
    "the verdict edit removes only sentry:needs-triage; stale verdict labels would survive it",
  );
  // Post-condition: the stub is re-read and >1 surviving verdict label fails
  // this matrix job rather than reaching the close/project/digest legs.
  assert.match(job, /select\(startswith\("sentry:verdict-"\)\)/);
  assert.match(job, /if \[ "\$\{survivor_count\}" -gt 1 \]; then/);
});

/** The whole `verdict` job. */
function verdictJobBlock() {
  return WORKFLOW.slice(
    WORKFLOW.indexOf("\n  verdict:"),
    WORKFLOW.indexOf("\n  project:"),
  );
}

/** The label edit that takes `sentry:needs-triage` off — the start of the
 * window where the stub is invisible to the selector. */
const VERDICT_EDIT_MARKER = '--remove-label "sentry:needs-triage,${shed}"';

/**
 * The verdict label step from that edit to the end of the step — the window
 * where every exit owes the stub a re-queue. The edit itself is INSIDE it: gh
 * sends the add and the removals as discrete mutations and fails the command on
 * a label the repo does not have, so a failed edit can leave the stub carrying
 * the verdict label and `sentry:needs-triage` at once.
 */
function verdictPostConditionBlock() {
  const job = verdictJobBlock();
  const start = job.indexOf(VERDICT_EDIT_MARKER);
  // End at the brief step, NOT the close step: the brief step has its own,
  // deliberately different failure semantics (#1769 round 10 — a CLEAR failure
  // exits 1 to BLOCK the close without re-queuing). This block is the VERDICT
  // step's post-condition, whose invariant is "every exit re-queues".
  const end = job.indexOf("- name: Render or clear the needs-human brief");
  assert.ok(
    start > 0 && end > start,
    "the verdict label step's post-condition block was not found",
  );
  return job.slice(start, end);
}

test("a failed verdict post-condition re-queues the stub instead of stranding it", () => {
  const block = verdictPostConditionBlock();
  const lines = block.split("\n");

  // The compensation is a RE-QUEUE, so it runs the one chokepoint CLI (#1782)
  // rather than its own label swap: the CLI owns the shed set
  // (REOPEN_SHED_LABELS — the whole verdict namespace, which matters here
  // because this is the one branch where a stub can be wearing more than one
  // verdict label, plus the projection, autofix and archive markers), the
  // ordering, and the terminal revalidation.
  //
  // It is DEFINED above the window rather than inside it, because the edit that
  // opens the window is itself an exit that owes a re-queue: defined below the
  // edit, `set -e` aborted the step before any compensation existed to call
  // (the 2026-08-13 failure on issue #1811).
  const job = verdictJobBlock();
  const jobLines = job.split("\n");
  const open = jobLines.findIndex(
    (line) => line.trim() === "requeue_for_retry() {",
  );
  assert.ok(open >= 0, "the verdict step has no re-queue helper");
  assert.ok(
    job.indexOf("requeue_for_retry() {") < job.indexOf(VERDICT_EDIT_MARKER),
    "the re-queue helper must be defined before the label edit, or the edit's own failure has nothing to call",
  );
  const close = jobLines.findIndex(
    (line, i) => i > open && line.trim() === "}",
  );
  const helper = jobLines.slice(open, close).join("\n");
  assert.match(
    helper,
    /node scripts\/sentry\/triage\/sentry-triage-workflow-requeue\.mjs/,
  );
  assert.match(helper, /--issue "\$\{QUEUE_ISSUE_NUMBER\}"/);
  assert.match(helper, /--reason verdict-unsettled/);
  assert.ok(
    !/--add-label|--remove-label/.test(helper),
    "the compensation must not open-code a label swap",
  );
  // The approval is shed for the reason REOPEN_SHED_LABELS gives: the archive
  // workflow's dispatch path takes approval + any verdict label as its whole
  // precondition, so a re-queued stub that keeps a human's approval can have
  // the NEXT round's occurrence archived without fresh review. Shedding an
  // approval is always allowed here; adding one never is.
  assert.ok(
    !/--add-label[^\n]*sentry:approved-archive/.test(WORKFLOW),
    "no step may ADD the human archive approval",
  );

  // Fail CLOSED on the re-read too: an unverifiable stub is re-queued, never
  // waved through to the close/project/digest legs.
  assert.match(block, /if ! gh issue view "\$\{QUEUE_ISSUE_NUMBER\}"/);

  // The property the whole block exists for: no exit leaves the stub open,
  // verdict-labeled and off sentry:needs-triage, which nothing downstream
  // re-queues — the close step never runs, the project job skips it, and the
  // scheduled selector requires sentry:needs-triage. Deleting the call from
  // any failure branch fails here.
  const meaningful = lines
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const exits = meaningful.filter((line) => line === "exit 1");
  assert.ok(
    exits.length >= 2,
    `expected the read-failure and surviving-label exits, found ${exits.length}`,
  );
  meaningful.forEach((line, i) => {
    if (line !== "exit 1") return;
    assert.equal(
      meaningful[i - 1],
      "requeue_for_retry",
      "an exit from the verdict post-condition must restore sentry:needs-triage first, or the open stub is stranded with no retry path",
    );
  });
});

/** The select job's block, from its key to the triage job's. */
function selectJobBlock() {
  const start = WORKFLOW.indexOf("\n  select:");
  const end = WORKFLOW.indexOf("\n  triage:");
  assert.ok(start > 0 && end > start, "select/triage job boundaries not found");
  return WORKFLOW.slice(start, end);
}

test("the round binding is recorded BEFORE the agent runs (#1717)", () => {
  // Only the select job can record it: it is trusted AND it runs before the
  // agent, so what it reads is what the round started from. Recorded anywhere
  // later it would see the round's own comment and prove nothing.
  const select = selectJobBlock();
  assert.match(select, /--prior-verdicts/);
  assert.match(select, /priorVerdicts: \$\{\{ steps\.prior-verdicts\.outputs/);
  assert.match(
    select,
    /node scripts\/sentry\/triage\/sentry-triage-project\.mjs/,
  );
  // It needs its own pristine checkout to run that script, and no agent runs
  // in this job.
  assert.match(select, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(select, /persist-credentials: false/);
  // No other job may recompute it: a second recorder would be free to read the
  // stub after the agent posted, which defeats the whole binding.
  const elsewhere = WORKFLOW.replace(select, "");
  assert.ok(
    !/--prior-verdicts\b/.test(elsewhere),
    "only the select job may record the prior verdict comment",
  );
});

test("the verdict step binds its resolution to the recorded round (#1717)", () => {
  const job = WORKFLOW.slice(
    WORKFLOW.indexOf("\n  verdict:"),
    WORKFLOW.indexOf("\n  project:"),
  );
  // The token travels through env + jq, never string-interpolated into the
  // command line, and its shape is checked against the parser's closed set.
  assert.match(
    job,
    /PRIOR_VERDICTS: \$\{\{ needs\.select\.outputs\.priorVerdicts \}\}/,
  );
  assert.match(job, /\^\(\[0-9\]\+\|none\|unknown\)\$/);
  assert.match(job, /--prior-verdict-comment "\$\{prior\}"/);
  // A missing record must resolve to `unknown` (which the parser refuses), not
  // to an empty string that would silently unbind the fence.
  assert.match(job, /'\.\[\$n\] \/\/ "unknown"'/);

  // The refusal has to land BEFORE the label edit takes sentry:needs-triage
  // off; after it, a refusal would strand the stub instead of re-queueing it.
  const parse = job.indexOf("--prior-verdict-comment");
  const edit = job.indexOf('--remove-label "sentry:needs-triage,${shed}"');
  assert.ok(
    parse > 0 && edit > parse,
    "the binding must be checked before the label edit",
  );
});

test("projection and digest wait for the verdict job", () => {
  assert.match(WORKFLOW, /project:\n\s+needs: \[select, triage, verdict\]/);
  assert.match(
    WORKFLOW,
    /digest:\n\s+needs: \[select, triage, verdict, project\]/,
  );
});

test("no executable grant or in-job node call points at the checkout", () => {
  const grant = /--allowedTools '([^']*)'/.exec(WORKFLOW);
  assert.ok(grant, "--allowedTools not found");
  const bashGrants = [...grant[1].matchAll(/Bash\(([^)]*)\)/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(bashGrants, [
    "gh issue view:*",
    "gh issue list:*",
    "node ${{ runner.temp }}/sentry-triage-tools/sentry-triage-agent-comment.mjs:*",
  ]);
  for (const g of bashGrants) {
    assert.ok(
      !/(^|\s)node\s+scripts\//.test(g),
      `grant executes a checkout path: ${g}`,
    );
  }
  // And no step in the AGENT job runs node against the checkout. (The verdict
  // job does, correctly: its runner and checkout are pristine.)
  assert.ok(
    !/node scripts\//.test(triageJobBlock()),
    "the triage job still executes a script from the agent-writable checkout",
  );
});

test("the agent job's checkout does not persist the git credential", () => {
  const triageJob = WORKFLOW.slice(
    WORKFLOW.indexOf("\n  triage:"),
    WORKFLOW.indexOf("\n  project:"),
  );
  assert.match(triageJob, /persist-credentials: false/);
});
