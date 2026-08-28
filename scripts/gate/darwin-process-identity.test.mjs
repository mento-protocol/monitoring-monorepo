import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as osConstants } from "node:os";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import {
  darwinNativeHelperTrustForTest,
  DarwinNativeRuntimeReceiptMissingError,
  DarwinProbeContentionError,
  nativeHelper,
  nativeHelperRuntimeReceiptPath,
  requireNativeHelperRuntime,
  runNativeSnapshot,
  validateNativeHelperRuntime,
} from "./darwin-process-identity-helper.mjs";
import {
  darwinLineageTransitionForTest,
  discardSettledDarwinLineage,
} from "./darwin-process-lineage.mjs";

const SOURCE_PATH = fileURLToPath(
  new URL("./darwin-process-identity.c", import.meta.url),
);
const SNAPSHOT_HEADER = "agentqg-darwin-process-snapshot-v3";
const PROBE_OUTPUT = "agentqg-darwin-process-identity-v3";
const PROC_LIST_PID_PADDING = 20n;
const BOOT_ID_PATTERN = /^pid1-([1-9]\d*)-(0|[1-9]\d*)-([1-9]\d*)$/;
const UINT64_MAX = 0xffffffffffffffffn;

function createFakeNativeCache(directory, helperSource) {
  const sourceDigest = darwinNativeHelperTrustForTest.nativeSourceDigest();
  const cacheDirectory = join(
    directory,
    `darwin-process-identity.${sourceDigest}.cache-v3`,
  );
  mkdirSync(cacheDirectory, { mode: 0o700 });
  chmodSync(cacheDirectory, 0o700);
  for (const source of darwinNativeHelperTrustForTest.readNativeSources()) {
    const cachedPath = join(cacheDirectory, source.cacheName);
    writeFileSync(cachedPath, source.bytes, { mode: 0o400 });
    chmodSync(cachedPath, 0o400);
  }
  const helper = join(cacheDirectory, "helper");
  writeFileSync(helper, helperSource, { mode: 0o500 });
  chmodSync(helper, 0o500);
  const helperDigest = createHash("sha256")
    .update(readFileSync(helper))
    .digest("hex");
  const provenance = darwinNativeHelperTrustForTest.nativeCacheProvenance(
    sourceDigest,
    helperDigest,
  );
  const provenancePath = join(cacheDirectory, "provenance.json");
  writeFileSync(provenancePath, `${JSON.stringify(provenance)}\n`, {
    mode: 0o400,
  });
  chmodSync(provenancePath, 0o400);
  return { cacheDirectory, helper };
}

test("Darwin native contention retries use bounded waits and remaining timeouts", () => {
  const profile = {
    ...darwinNativeHelperTrustForTest.defaultRetryProfile,
    timeoutMs: 3_000,
    maxSpawnTimeoutMs: 1_000,
  };
  const statuses = [5, 5, 5, 5, 5, 0];
  const waits = [];
  const timeouts = [];
  let now = 0;
  const runtime = {
    now: () => now,
    pid: 1_234,
    wait: (delayMs) => {
      waits.push(delayMs);
      now += delayMs;
    },
  };
  const result = darwinNativeHelperTrustForTest.runContentionCommand(
    {
      args: ["probe"],
      contentionError: DarwinProbeContentionError,
      contentionMessage: "test probe stayed contended",
      helper: "/unused/test-helper",
      invoke: ({ timeoutMs }) => {
        timeouts.push(timeoutMs);
        now += 17;
        const status = statuses.shift();
        return {
          status,
          stderr: status === 5 ? "contended\n" : "",
          stdout: status === 0 ? "accepted\n" : "",
        };
      },
      parseSuccess: ({ stdout }) => stdout.trimEnd(),
      partialEvidenceMessage: "test probe emitted partial evidence",
      retryProfile: profile,
    },
    runtime,
  );

  assert.equal(result.value, "accepted");
  assert.equal(result.attempts, 6);
  assert.deepEqual(waits, [87, 116, 207, 558, 1_281]);
  assert.deepEqual(timeouts, [1_000, 1_000, 1_000, 1_000, 1_000, 666]);
  for (const [attempt, wait] of waits.entries()) {
    const slot = Math.min(
      profile.maxDelayMs,
      profile.initialDelayMs * 2 ** attempt,
    );
    assert.ok(wait >= slot && wait < slot * 2);
  }
  assert.ok(waits.reduce((total, wait) => total + wait, 0) <= 3_095);
});

test("Darwin native contention exhaustion is typed and has no terminal wait", () => {
  const profile = darwinNativeHelperTrustForTest.defaultRetryProfile;
  const waits = [];
  let attempts = 0;
  let now = 0;
  const runtime = {
    now: () => now,
    pid: 1_234,
    wait: (delayMs) => {
      waits.push(delayMs);
      now += delayMs;
    },
  };

  assert.throws(
    () =>
      darwinNativeHelperTrustForTest.runContentionCommand(
        {
          args: ["probe"],
          contentionError: DarwinProbeContentionError,
          contentionMessage: "test probe stayed contended",
          helper: "/unused/test-helper",
          invoke: () => {
            attempts += 1;
            return {
              status: 5,
              stderr: `contended-${attempts}\n`,
              stdout: "",
            };
          },
          parseSuccess: () => assert.fail("contention cannot parse success"),
          partialEvidenceMessage: "test probe emitted partial evidence",
          retryProfile: profile,
        },
        runtime,
      ),
    (error) =>
      error instanceof DarwinProbeContentionError &&
      /contended-6/u.test(error.message),
  );
  assert.equal(attempts, 6);
  assert.deepEqual(waits, [87, 116, 207, 558, 1_281]);
});

test("Darwin native contention rejects partial evidence without retrying", () => {
  let attempts = 0;
  let waits = 0;
  assert.throws(
    () =>
      darwinNativeHelperTrustForTest.runContentionCommand(
        {
          args: ["snapshot"],
          contentionError: DarwinProbeContentionError,
          contentionMessage: "test snapshot stayed contended",
          helper: "/unused/test-helper",
          invoke: () => {
            attempts += 1;
            return { status: 5, stderr: "contended\n", stdout: "partial\n" };
          },
          parseSuccess: () => assert.fail("contention cannot parse success"),
          partialEvidenceMessage: "test snapshot emitted partial evidence",
        },
        {
          now: () => 0,
          pid: 1_234,
          wait: () => {
            waits += 1;
          },
        },
      ),
    /test snapshot emitted partial evidence/u,
  );
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
});

test("Darwin allocator contention has a retry status distinct from infrastructure", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");
  const runtime = readFileSync(
    new URL("./darwin-process-identity-runtime.inc.c", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /EXIT_INFRASTRUCTURE = 2,[\s\S]*EXIT_RETRY_CONTENTION = 5/u,
  );
  assert.match(
    source,
    /probe_global_unique_id_allocator\(void\)[\s\S]*return EPOCH_RETRY;[\s\S]*allocator_probe_result == EPOCH_RETRY[\s\S]*probe_result = EXIT_RETRY_CONTENTION/u,
  );
  assert.match(runtime, /exit_status = EXIT_RETRY_CONTENTION/u);
});

test(
  "Darwin PID vectors tolerate one exit and reject unsafe counts",
  { skip: process.platform !== "darwin" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-pid-vector-counts-"));
    const harnessSource = join(directory, "pid-vector-counts.c");
    const harnessBinary = join(directory, "pid-vector-counts");
    try {
      writeFileSync(
        harnessSource,
        `#define proc_listallpids agentqg_test_proc_listallpids
#define main agentqg_native_helper_main
#include ${JSON.stringify(SOURCE_PATH)}
#undef main
#undef proc_listallpids

static int test_estimate;
static int test_listed;

int agentqg_test_proc_listallpids(void *buffer, int buffer_size) {
  if (buffer == NULL) {
    return test_estimate;
  }
  if (buffer_size != test_estimate * (int)sizeof(pid_t)) {
    return -1;
  }
  pid_t *vector = buffer;
  for (int index = 0; index < test_listed; index += 1) {
    vector[index] = (pid_t)index;
  }
  return test_listed;
}

static int run_count_case(int estimate, int listed,
    enum epoch_result expected_result) {
  pid_t *pids = NULL;
  int estimated_count = 0;
  int listed_count = 0;
  int capacity = 0;
  int zero_pid_count = 0;
  enum snapshot_retry_reason retry_reason = SNAPSHOT_RETRY_NONE;
  test_estimate = estimate;
  test_listed = listed;
  enum epoch_result result = capture_pid_vector(&pids, &estimated_count,
      &listed_count, &capacity, &zero_pid_count, &retry_reason);
  int failed = result != expected_result || estimated_count != estimate ||
      listed_count != listed || capacity != estimate || zero_pid_count != 1;
  if (expected_result == EPOCH_OK) {
    failed = failed || pids == NULL || retry_reason != SNAPSHOT_RETRY_NONE;
  } else {
    failed = failed || pids != NULL || retry_reason != SNAPSHOT_RETRY_COUNT;
  }
  free(pids);
  return failed;
}

int main(void) {
  if (run_count_case(29, 10, EPOCH_OK) != 0) return 1;
  if (run_count_case(30, 10, EPOCH_OK) != 0) return 2;
  if (run_count_case(28, 10, EPOCH_RETRY) != 0) return 3;
  if (run_count_case(30, 30, EPOCH_RETRY) != 0) return 4;
  return 0;
}
`,
      );
      const compiled = spawnSync(
        "clang",
        [
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-O2",
          harnessSource,
          "-o",
          harnessBinary,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(compiled.error, undefined, compiled.error?.message);
      assert.equal(compiled.status, 0, compiled.stderr);
      const result = spawnSync(harnessBinary, [], {
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("Darwin runtime validation publishes and reuses a boot-scoped receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentqg-runtime-receipt-"));
  chmodSync(directory, 0o755);
  const countersPath = join(directory, "native-counters.json");
  const helperSource = `#!${process.execPath}
const fs = require("node:fs");
const countersPath = ${JSON.stringify(countersPath)};
const counters = fs.existsSync(countersPath)
  ? JSON.parse(fs.readFileSync(countersPath, "utf8"))
  : { boot: 0, probe: 0, snapshot: 0 };
const command = process.argv[2];
if (command === "boot-id") {
  counters.boot += 1;
  fs.writeFileSync(countersPath, JSON.stringify(counters));
  process.stdout.write("pid1-1-0-1\\n");
} else if (command === "probe") {
  counters.probe += 1;
  fs.writeFileSync(countersPath, JSON.stringify(counters));
  if (counters.probe < 6) {
    process.stderr.write("allocator contended\\n");
    process.exit(5);
  }
  process.stdout.write("${PROBE_OUTPUT}\\n");
} else if (command === "snapshot") {
  counters.snapshot += 1;
  fs.writeFileSync(countersPath, JSON.stringify(counters));
  if (counters.snapshot === 1) {
    process.stderr.write("snapshot contended\\n");
    process.exit(5);
  }
  process.stdout.write("${SNAPSHOT_HEADER}\\t10\\t11\\t21\\t2\\t21\\t1\\t0\\n");
} else {
  process.exit(2);
}
`;
  const retryProfile = {
    timeoutMs: 5_000,
    maxAttempts: 6,
    maxSpawnTimeoutMs: 1_000,
    initialDelayMs: 1,
    maxDelayMs: 4,
  };
  try {
    const { helper } = createFakeNativeCache(directory, helperSource);
    const validated = validateNativeHelperRuntime(
      directory,
      helper,
      retryProfile,
    );
    assert.equal(validated.reusedReceipt, false);
    assert.equal(validated.bootId, "pid1-1-0-1");
    assert.equal(validated.snapshot.proof.lowerUniqueId, "10");
    assert.equal(validated.snapshot.proof.upperUniqueId, "11");
    assert.equal(
      validated.receiptPath,
      nativeHelperRuntimeReceiptPath(directory, helper),
    );
    assert.equal(lstatSync(validated.receiptPath).mode & 0o7777, 0o400);
    assert.deepEqual(JSON.parse(readFileSync(countersPath, "utf8")), {
      boot: 2,
      probe: 6,
      snapshot: 2,
    });

    assert.equal(nativeHelper(directory), helper);
    assert.deepEqual(JSON.parse(readFileSync(countersPath, "utf8")), {
      boot: 2,
      probe: 6,
      snapshot: 2,
    });

    const required = requireNativeHelperRuntime(
      directory,
      helper,
      retryProfile,
    );
    assert.equal(required.receiptPath, validated.receiptPath);
    const reused = validateNativeHelperRuntime(directory, helper, retryProfile);
    assert.equal(reused.reusedReceipt, true);
    assert.deepEqual(JSON.parse(readFileSync(countersPath, "utf8")), {
      boot: 6,
      probe: 6,
      snapshot: 3,
    });

    const tamperedReceipt = JSON.parse(
      readFileSync(validated.receiptPath, "utf8"),
    );
    chmodSync(validated.receiptPath, 0o600);
    writeFileSync(
      validated.receiptPath,
      `${JSON.stringify({ ...tamperedReceipt, bootId: "pid1-2-0-2" })}\n`,
    );
    chmodSync(validated.receiptPath, 0o400);
    assert.throws(
      () => requireNativeHelperRuntime(directory, helper, retryProfile),
      /capability receipt is invalid/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Darwin runtime authority stays absent after an infrastructure failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentqg-runtime-refusal-"));
  const helperSource = `#!${process.execPath}
const command = process.argv[2];
if (command === "boot-id") process.stdout.write("pid1-1-0-1\\n");
else if (command === "probe") {
  process.stderr.write("probe infrastructure failed\\n");
  process.exit(2);
} else process.exit(2);
`;
  const retryProfile = {
    timeoutMs: 2_000,
    maxAttempts: 2,
    maxSpawnTimeoutMs: 1_000,
    initialDelayMs: 1,
    maxDelayMs: 2,
  };
  try {
    const { helper } = createFakeNativeCache(directory, helperSource);
    const receiptPath = nativeHelperRuntimeReceiptPath(directory, helper);
    assert.throws(
      () => requireNativeHelperRuntime(directory, helper, retryProfile),
      (error) =>
        error instanceof DarwinNativeRuntimeReceiptMissingError &&
        /capability receipt is missing/u.test(error.message),
    );
    assert.throws(
      () => validateNativeHelperRuntime(directory, helper, retryProfile),
      /probe infrastructure failed/u,
    );
    assert.equal(existsSync(receiptPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function parseRow(line) {
  assert.match(line, /^(?:0|[1-9]\d*)(?:\t(?:0|[1-9]\d*)){11}$/);
  const values = line.split("\t").map((value) => BigInt(value));
  return {
    pid: values[0],
    ppid: values[1],
    pgid: values[2],
    status: values[3],
    uid: values[4],
    ruid: values[5],
    svuid: values[6],
    uniqueId: values[7],
    parentUniqueId: values[8],
    resourceCoalitionId: values[9],
    jetsamCoalitionId: values[10],
    pidVersion: values[11],
  };
}

function parseSnapshot(text) {
  const lines = text.trimEnd().split("\n");
  const header = lines.shift().split("\t");
  assert.equal(header.length, 8);
  assert.equal(header[0], SNAPSHOT_HEADER);
  const lowerUniqueId = BigInt(header[1]);
  const upperUniqueId = BigInt(header[2]);
  const estimatedCount = BigInt(header[3]);
  const listedCount = BigInt(header[4]);
  const capacity = BigInt(header[5]);
  const zeroPidCount = BigInt(header[6]);
  const rowCount = BigInt(header[7]);
  assert.ok(lowerUniqueId > 0n && lowerUniqueId < UINT64_MAX);
  assert.equal(upperUniqueId, lowerUniqueId + 1n);
  assert.equal(zeroPidCount, 1n);
  assert.ok(
    estimatedCount - (listedCount - zeroPidCount) >= PROC_LIST_PID_PADDING,
  );
  assert.ok(listedCount > 0n && listedCount < capacity);
  assert.ok(rowCount <= listedCount);
  const rows = lines.map(parseRow);
  assert.equal(BigInt(rows.length), rowCount);
  assert.ok(rows.every((row) => row.uniqueId < lowerUniqueId));
  assert.equal(
    new Set(rows.map((row) => row.pid.toString())).size,
    rows.length,
  );
  assert.equal(
    new Set(rows.map((row) => row.uniqueId.toString())).size,
    rows.length,
  );
  return { lowerUniqueId, upperUniqueId, rows };
}

function compileHelper(directory) {
  const binary = join(directory, "darwin-process-identity");
  const result = spawnSync(
    "clang",
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      SOURCE_PATH,
      "-o",
      binary,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return binary;
}

function runHelper(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function readCoherentSnapshot(binary) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = runHelper(binary, ["snapshot"]);
    if (result.status === 0) return parseSnapshot(result.stdout);
    assert.equal(result.status, 5, result.stderr);
    assert.equal(result.stdout, "");
  }
  assert.fail("the helper did not capture a coherent snapshot in four calls");
}

function readIdentity(binary, pid) {
  const result = runHelper(binary, ["identity", String(pid)]);
  if (result.status !== 0) return { result, row: null };
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  return { result, row: parseRow(lines[0]) };
}

async function waitFor(predicate, description, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${description}`);
}

async function waitForExit(child, description, timeoutMs = 4_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`timed out waiting for ${description}`)),
        timeoutMs,
      ),
    ),
  ]);
}

function alternateValue(value, maximum) {
  return value === maximum ? value - 1n : value + 1n;
}

function signalExact(binary, row, signalNumber) {
  return runHelper(binary, [
    "signal",
    String(row.pid),
    String(row.uniqueId),
    String(signalNumber),
  ]);
}

function transitionState(token, { revision = 0, settled = false } = {}) {
  return {
    schema: "agentqg-darwin-lineage-v4",
    lifecycleContract: "darwin-coherent-lineage-v2",
    token,
    bootId: "pid1-1-0-1",
    baseline: ["1"],
    root: null,
    launcher: null,
    tombstones: [],
    settledAt: settled ? 1 : null,
    settledReason: settled ? "verified-boot-change" : null,
    settlementProof: null,
    createdAt: 1,
    revision,
  };
}

function transitionFixture(label, { settled = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), `agentqg-${label}-`));
  const token = `${label}-${process.pid}-${Date.now() % 1_000_000_000_000}`;
  const statePath = join(directory, `lineage.${token}.json`);
  const state = transitionState(token, { settled });
  darwinLineageTransitionForTest.createState(statePath, state);
  return { directory, state, statePath, token };
}

function transitionValue(path) {
  return darwinLineageTransitionForTest.readCanonicalTransitionValue(path)
    ?.value;
}

test("Darwin lineage transition recovers before and after publication", () => {
  const fixture = transitionFixture("transition-crash");
  try {
    const claimedReplacement = { ...fixture.state, baseline: ["2"] };
    assert.throws(
      () =>
        darwinLineageTransitionForTest.replaceState(
          fixture.statePath,
          fixture.state,
          claimedReplacement,
          (boundary) => {
            if (boundary === "after-current-claim") {
              throw new Error("test crash");
            }
          },
        ),
      /test crash/u,
    );
    assert.deepEqual(transitionValue(fixture.statePath), fixture.state);
    const claimed = darwinLineageTransitionForTest.replaceState(
      fixture.statePath,
      fixture.state,
      claimedReplacement,
    );
    assert.equal(claimed.revision, 1);

    const firstReplacement = { ...claimed, baseline: ["3"] };
    assert.throws(
      () =>
        darwinLineageTransitionForTest.replaceState(
          fixture.statePath,
          claimed,
          firstReplacement,
          (boundary) => {
            if (boundary === "after-ready") throw new Error("test crash");
          },
        ),
      /test crash/u,
    );
    assert.deepEqual(transitionValue(fixture.statePath), claimed);
    const first = darwinLineageTransitionForTest.replaceState(
      fixture.statePath,
      claimed,
      firstReplacement,
    );
    assert.equal(first.revision, 2);
    assert.deepEqual(transitionValue(fixture.statePath), first);

    const secondReplacement = { ...first, baseline: ["4"] };
    assert.throws(
      () =>
        darwinLineageTransitionForTest.replaceState(
          fixture.statePath,
          first,
          secondReplacement,
          (boundary) => {
            if (boundary === "after-publication") {
              throw new Error("test crash");
            }
          },
        ),
      /test crash/u,
    );
    assert.equal(transitionValue(fixture.statePath).revision, 3);
    const second = darwinLineageTransitionForTest.replaceState(
      fixture.statePath,
      first,
      secondReplacement,
    );
    assert.deepEqual(transitionValue(fixture.statePath), second);
    for (const revision of [1, 2, 3]) {
      for (const artifact of Object.values(
        darwinLineageTransitionForTest.transitionPaths(
          fixture.statePath,
          revision,
        ),
      )) {
        assert.equal(existsSync(artifact), false);
      }
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Darwin lineage transition serializes settle and discard races", () => {
  const settlement = transitionFixture("transition-settle-race");
  try {
    const winner = {
      ...settlement.state,
      settledAt: 2,
      settledReason: "verified-boot-change",
    };
    const loser = {
      ...settlement.state,
      settledAt: 3,
      settledReason: "verified-boot-change",
    };
    let raced = false;
    let loserError;
    const result = darwinLineageTransitionForTest.replaceState(
      settlement.statePath,
      settlement.state,
      winner,
      (boundary) => {
        if (boundary !== "after-current-claim" || raced) return;
        raced = true;
        try {
          darwinLineageTransitionForTest.replaceState(
            settlement.statePath,
            settlement.state,
            loser,
          );
        } catch (error) {
          loserError = error;
        }
      },
    );
    assert.match(loserError?.message ?? "", /different Darwin lineage/u);
    assert.deepEqual(transitionValue(settlement.statePath), result);
    assert.equal(result.settledReason, "verified-boot-change");

    const stalePaths = darwinLineageTransitionForTest.transitionPaths(
      settlement.statePath,
      1,
    );
    let linkedNewerState = false;
    let staleWriterError;
    try {
      darwinLineageTransitionForTest.replaceState(
        settlement.statePath,
        settlement.state,
        loser,
        (boundary) => {
          if (boundary !== "after-current-link") return;
          const canonical = lstatSync(settlement.statePath, { bigint: true });
          const claimed = lstatSync(stalePaths.current, { bigint: true });
          linkedNewerState =
            canonical.dev === claimed.dev && canonical.ino === claimed.ino;
        },
      );
    } catch (error) {
      staleWriterError = error;
    }
    assert.equal(staleWriterError?.name, "DarwinTransitionConflictError");
    assert.match(
      staleWriterError?.message ?? "",
      /canonical state advanced before its current-state claim/u,
    );
    assert.equal(linkedNewerState, true);
    assert.deepEqual(transitionValue(settlement.statePath), result);
    assert.equal(existsSync(stalePaths.current), false);

    const sameRevision = { ...result, baseline: ["8"] };
    writeFileSync(settlement.statePath, `${JSON.stringify(sameRevision)}\n`, {
      mode: 0o600,
    });
    let sameRevisionError;
    try {
      darwinLineageTransitionForTest.replaceState(
        settlement.statePath,
        result,
        { ...result, baseline: ["9"] },
      );
    } catch (error) {
      sameRevisionError = error;
    }
    assert.notEqual(sameRevisionError?.name, "DarwinTransitionConflictError");
    assert.match(
      sameRevisionError?.message ?? "",
      /claim does not bind its exact expected state/u,
    );
  } finally {
    rmSync(settlement.directory, { recursive: true, force: true });
  }

  const readToLink = transitionFixture("transition-read-link-race");
  try {
    const target = { ...readToLink.state, baseline: ["6"] };
    let raced = false;
    let winner;
    const retried = darwinLineageTransitionForTest.replaceState(
      readToLink.statePath,
      readToLink.state,
      target,
      (boundary) => {
        if (boundary !== "before-current-link" || raced) return;
        raced = true;
        winner = darwinLineageTransitionForTest.replaceState(
          readToLink.statePath,
          readToLink.state,
          target,
        );
      },
    );
    assert.equal(raced, true);
    assert.deepEqual(retried, winner);
    assert.deepEqual(transitionValue(readToLink.statePath), winner);
    for (const artifact of Object.values(
      darwinLineageTransitionForTest.transitionPaths(readToLink.statePath, 1),
    )) {
      assert.equal(existsSync(artifact), false);
    }
  } finally {
    rmSync(readToLink.directory, { recursive: true, force: true });
  }

  const discard = transitionFixture("transition-discard-race", {
    settled: true,
  });
  try {
    let raced = false;
    let settlementError;
    assert.doesNotThrow(() =>
      darwinLineageTransitionForTest.discardState(
        discard.statePath,
        discard.state,
        (boundary) => {
          if (boundary !== "after-current-claim" || raced) return;
          raced = true;
          try {
            darwinLineageTransitionForTest.replaceState(
              discard.statePath,
              discard.state,
              { ...discard.state, baseline: ["7"] },
            );
          } catch (error) {
            settlementError = error;
          }
        },
      ),
    );
    assert.match(settlementError?.message ?? "", /different Darwin lineage/u);
    assert.equal(existsSync(discard.statePath), false);
  } finally {
    rmSync(discard.directory, { recursive: true, force: true });
  }

  const settleThenDiscard = transitionFixture("transition-settle-discard");
  try {
    const settledTarget = {
      ...settleThenDiscard.state,
      settledAt: 4,
      settledReason: "verified-boot-change",
    };
    const expectedPublished = { ...settledTarget, revision: 1 };
    let discarded = false;
    const published = darwinLineageTransitionForTest.replaceState(
      settleThenDiscard.statePath,
      settleThenDiscard.state,
      settledTarget,
      (boundary) => {
        if (boundary !== "after-publication" || discarded) return;
        discarded = true;
        darwinLineageTransitionForTest.discardState(
          settleThenDiscard.statePath,
          expectedPublished,
        );
      },
    );
    assert.deepEqual(published, expectedPublished);
    assert.equal(discarded, true);
    assert.equal(existsSync(settleThenDiscard.statePath), false);
  } finally {
    rmSync(settleThenDiscard.directory, { recursive: true, force: true });
  }
});

test("Darwin lineage transition tolerates exact same-plan publication races", () => {
  for (const seam of [
    "after-ready-absence",
    "after-payload-publish",
    "after-ready-link",
    "after-ready-validation",
    "before-publication-payload-read",
  ]) {
    const fixture = transitionFixture(
      `transition-publisher-${seam.replaceAll("-", "")}`,
    );
    try {
      const target = { ...fixture.state, baseline: ["10"] };
      let peerResult;
      let raced = false;
      const result = darwinLineageTransitionForTest.replaceState(
        fixture.statePath,
        fixture.state,
        target,
        (boundary) => {
          if (boundary !== seam || raced) return;
          raced = true;
          peerResult = darwinLineageTransitionForTest.replaceState(
            fixture.statePath,
            fixture.state,
            target,
          );
        },
      );
      assert.equal(raced, true, seam);
      assert.deepEqual(result, peerResult, seam);
      assert.deepEqual(transitionValue(fixture.statePath), result, seam);
      for (const artifact of Object.values(
        darwinLineageTransitionForTest.transitionPaths(fixture.statePath, 1),
      )) {
        assert.equal(existsSync(artifact), false, `${seam}: ${artifact}`);
      }
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("Darwin lineage readiness waits for claim staging cleanup", () => {
  const fixture = transitionFixture("transition-claim-staging");
  try {
    const paths = darwinLineageTransitionForTest.transitionPaths(
      fixture.statePath,
      1,
    );
    const stagingLink = join(fixture.directory, ".claim-staging-contention");
    let staged = false;
    let transitionError;
    try {
      darwinLineageTransitionForTest.replaceState(
        fixture.statePath,
        fixture.state,
        { ...fixture.state, baseline: ["15"] },
        (boundary) => {
          if (boundary !== "after-current-claim" || staged) return;
          staged = true;
          linkSync(paths.claim, stagingLink);
        },
      );
    } catch (error) {
      transitionError = error;
    }
    assert.equal(staged, true);
    assert.equal(transitionError?.name, "DarwinTransitionConflictError");
    assert.match(
      transitionError?.message ?? "",
      /claim staging is still in progress/u,
    );
    assert.equal(lstatSync(paths.claim, { bigint: true }).nlink, 2n);
    assert.equal(existsSync(paths.ready), false);

    unlinkSync(stagingLink);
    const result = darwinLineageTransitionForTest.replaceState(
      fixture.statePath,
      fixture.state,
      { ...fixture.state, baseline: ["15"] },
    );
    assert.equal(result.revision, 1);
    for (const artifact of Object.values(paths)) {
      assert.equal(existsSync(artifact), false, artifact);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Darwin lineage exact-target reads retry across the publication rename", () => {
  const fixture = transitionFixture("transition-target-read-race");
  try {
    const paths = darwinLineageTransitionForTest.transitionPaths(
      fixture.statePath,
      1,
    );
    const target = { ...fixture.state, baseline: ["16"] };
    let removedReady = false;
    let racedRead = false;
    let peerResult;
    const result = darwinLineageTransitionForTest.replaceState(
      fixture.statePath,
      fixture.state,
      target,
      (boundary) => {
        if (boundary === "after-ready-link" && !removedReady) {
          removedReady = true;
          unlinkSync(paths.ready);
          return;
        }
        if (boundary !== "during-canonical-target-read" || racedRead) return;
        racedRead = true;
        peerResult = darwinLineageTransitionForTest.replaceState(
          fixture.statePath,
          fixture.state,
          target,
        );
      },
    );
    assert.equal(removedReady, true);
    assert.equal(racedRead, true);
    assert.deepEqual(result, peerResult);
    assert.deepEqual(transitionValue(fixture.statePath), result);
    for (const artifact of Object.values(paths)) {
      assert.equal(existsSync(artifact), false, artifact);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Darwin lineage transition cleanup is idempotent across same-plan helpers", () => {
  for (const seam of [
    "before-cleanup-ready",
    "before-cleanup-current",
    "before-cleanup-claim",
  ]) {
    const fixture = transitionFixture(
      `transition-cleanup-${seam.replaceAll("-", "")}`,
    );
    try {
      const target = { ...fixture.state, baseline: ["11"] };
      let peerResult;
      let raced = false;
      const result = darwinLineageTransitionForTest.replaceState(
        fixture.statePath,
        fixture.state,
        target,
        (boundary) => {
          if (boundary !== seam || raced) return;
          raced = true;
          peerResult = darwinLineageTransitionForTest.replaceState(
            fixture.statePath,
            fixture.state,
            target,
          );
        },
      );
      assert.equal(raced, true, seam);
      assert.deepEqual(result, peerResult, seam);
      assert.deepEqual(transitionValue(fixture.statePath), result, seam);
      for (const artifact of Object.values(
        darwinLineageTransitionForTest.transitionPaths(fixture.statePath, 1),
      )) {
        assert.equal(existsSync(artifact), false, `${seam}: ${artifact}`);
      }
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }

  const payload = transitionFixture("transition-cleanup-payload");
  try {
    const target = { ...payload.state, baseline: ["12"] };
    const expectedPublished = { ...target, revision: 1 };
    const paths = darwinLineageTransitionForTest.transitionPaths(
      payload.statePath,
      1,
    );
    let injected = false;
    let raced = false;
    let peerResult;
    const result = darwinLineageTransitionForTest.replaceState(
      payload.statePath,
      payload.state,
      target,
      (boundary) => {
        if (boundary === "after-publication" && !injected) {
          injected = true;
          writeFileSync(
            paths.payload,
            `${JSON.stringify(expectedPublished)}\n`,
            { mode: 0o600 },
          );
          return;
        }
        if (boundary !== "before-cleanup-payload" || raced) return;
        raced = true;
        peerResult = darwinLineageTransitionForTest.replaceState(
          payload.statePath,
          payload.state,
          target,
        );
      },
    );
    assert.equal(injected, true);
    assert.equal(raced, true);
    assert.deepEqual(result, peerResult);
    assert.deepEqual(transitionValue(payload.statePath), result);
    for (const artifact of Object.values(paths)) {
      assert.equal(existsSync(artifact), false, artifact);
    }
  } finally {
    rmSync(payload.directory, { recursive: true, force: true });
  }
});

test("Darwin lineage transition rejects a missing unpublished payload", () => {
  const fixture = transitionFixture("transition-missing-payload");
  try {
    const paths = darwinLineageTransitionForTest.transitionPaths(
      fixture.statePath,
      1,
    );
    let removed = false;
    let transitionError;
    try {
      darwinLineageTransitionForTest.replaceState(
        fixture.statePath,
        fixture.state,
        { ...fixture.state, baseline: ["13"] },
        (boundary) => {
          if (boundary !== "after-ready" || removed) return;
          removed = true;
          unlinkSync(paths.payload);
        },
      );
    } catch (error) {
      transitionError = error;
    }
    assert.equal(removed, true);
    assert.equal(transitionError?.code, "ENOENT");
    assert.deepEqual(transitionValue(fixture.statePath), fixture.state);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Darwin lineage transition rejects a foreign recreated payload", () => {
  const fixture = transitionFixture("transition-foreign-payload");
  try {
    const paths = darwinLineageTransitionForTest.transitionPaths(
      fixture.statePath,
      1,
    );
    let injected = false;
    assert.throws(
      () =>
        darwinLineageTransitionForTest.replaceState(
          fixture.statePath,
          fixture.state,
          { ...fixture.state, baseline: ["14"] },
          (boundary) => {
            if (boundary !== "after-publication" || injected) return;
            injected = true;
            writeFileSync(paths.payload, "{}\n", { mode: 0o600 });
          },
        ),
      /payload does not match its exact transition value/u,
    );
    assert.equal(injected, true);
    assert.equal(transitionValue(fixture.statePath).revision, 1);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Darwin lineage discard recovers its exact tombstone", () => {
  const fixture = transitionFixture("transition-discard-crash", {
    settled: true,
  });
  try {
    assert.throws(
      () =>
        darwinLineageTransitionForTest.discardState(
          fixture.statePath,
          fixture.state,
          (boundary) => {
            if (boundary === "after-publication") {
              throw new Error("test crash");
            }
          },
        ),
      /test crash/u,
    );
    assert.equal(
      transitionValue(fixture.statePath).schema,
      "agentqg-darwin-lineage-discard-v1",
    );
    assert.deepEqual(
      discardSettledDarwinLineage({ statePath: fixture.statePath }),
      {
        active: true,
        discarded: true,
      },
    );
    assert.equal(existsSync(fixture.statePath), false);
    for (const artifact of Object.values(
      darwinLineageTransitionForTest.transitionPaths(fixture.statePath, 1),
    )) {
      assert.equal(existsSync(artifact), false);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }

  for (const crashBoundary of [
    "before-discard-retirement",
    "after-discard-retirement",
  ]) {
    const retirement = transitionFixture(
      `transition-${crashBoundary.replaceAll("-", "")}`,
      { settled: true },
    );
    try {
      assert.throws(
        () =>
          darwinLineageTransitionForTest.discardState(
            retirement.statePath,
            retirement.state,
            (boundary) => {
              if (boundary === crashBoundary) throw new Error("test crash");
            },
          ),
        /test crash/u,
      );
      if (crashBoundary === "before-discard-retirement") {
        assert.equal(
          transitionValue(retirement.statePath).schema,
          "agentqg-darwin-lineage-discard-v1",
        );
        assert.deepEqual(
          discardSettledDarwinLineage({ statePath: retirement.statePath }),
          { active: true, discarded: true },
        );
      }
      assert.equal(existsSync(retirement.statePath), false);
    } finally {
      rmSync(retirement.directory, { recursive: true, force: true });
    }
  }
});

test("Darwin lineage transition rejects malformed and foreign claims", () => {
  for (const claimKind of ["mode", "symlink", "out-of-sequence"]) {
    const fixture = transitionFixture(`transition-foreign-${claimKind}`);
    try {
      const paths = darwinLineageTransitionForTest.transitionPaths(
        fixture.statePath,
        1,
      );
      if (claimKind === "mode") {
        writeFileSync(paths.claim, "{}\n", { mode: 0o600 });
        chmodSync(paths.claim, 0o600);
      } else {
        if (claimKind === "symlink") {
          symlinkSync(fixture.statePath, paths.claim);
        } else {
          writeFileSync(
            paths.claim,
            `${JSON.stringify({
              schema: "agentqg-darwin-lineage-transition-v1",
              token: fixture.token,
              operation: "replace",
              expectedRevision: 0,
              nextRevision: 2,
              expectedState: fixture.state,
              target: {
                ...fixture.state,
                baseline: ["5"],
                revision: 2,
              },
            })}\n`,
            { mode: 0o400 },
          );
          chmodSync(paths.claim, 0o400);
        }
      }
      assert.throws(() =>
        darwinLineageTransitionForTest.replaceState(
          fixture.statePath,
          fixture.state,
          { ...fixture.state, baseline: ["4"] },
        ),
      );
      assert.deepEqual(transitionValue(fixture.statePath), fixture.state);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test(
  "Darwin helper preserves coalition IDs through fork, exec, and double fork",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-darwin-identity-"));
    let signalChild = null;
    let signalChildIdentity = null;
    let intermediate = null;
    let intermediateIdentity = null;
    let orphanIdentity = null;

    try {
      const binary = compileHelper(directory);

      const usage = runHelper(binary, []);
      assert.equal(usage.status, 1);
      assert.match(usage.stderr, /^usage: /);
      assert.equal(runHelper(binary, ["identity", "-1"]).status, 1);
      assert.equal(runHelper(binary, ["identity", " 1"]).status, 1);
      assert.equal(runHelper(binary, ["identity", "2147483647"]).status, 3);
      assert.equal(runHelper(binary, ["signal", "1", "2", "0"]).status, 1);
      assert.equal(runHelper(binary, ["signal", "1", "2", "3", "4"]).status, 1);

      const undefinedSymbols = spawnSync("nm", ["-u", binary], {
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(undefinedSymbols.status, 0, undefinedSymbols.stderr);
      assert.doesNotMatch(
        undefinedSymbols.stdout,
        /proc_signal_with_audittoken/,
      );

      const probe = runHelper(binary, ["probe"]);
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stdout, `${PROBE_OUTPUT}\n`);

      assert.equal(
        darwinNativeHelperTrustForTest.cacheSchema,
        "agentqg-darwin-native-helper-cache-v3",
      );
      assert.deepEqual(darwinNativeHelperTrustForTest.sourceNames, [
        "source.c",
        "darwin-process-identity-runtime.inc.c",
      ]);
      const nativeSources = darwinNativeHelperTrustForTest.readNativeSources();
      assert.deepEqual(
        nativeSources.map(({ cacheName }) => cacheName),
        darwinNativeHelperTrustForTest.sourceNames,
      );
      assert.ok(
        nativeSources.every(
          ({ bytes, path }) =>
            bytes.length > 0 && bytes.equals(readFileSync(path)),
        ),
      );
      const cachedBinary = nativeHelper(directory);
      assert.deepEqual(readdirSync(dirname(cachedBinary)).sort(), [
        "darwin-process-identity-runtime.inc.c",
        "helper",
        "provenance.json",
        "source.c",
      ]);
      const cachedSnapshot = runNativeSnapshot(cachedBinary);
      assert.equal(cachedSnapshot.proof.zeroPidCount, 1);
      assert.ok(
        cachedSnapshot.proof.estimatedCount -
          (cachedSnapshot.proof.listedCount - 1) >=
          Number(PROC_LIST_PID_PADDING),
      );
      assert.ok(cachedSnapshot.records.some((row) => row.pid === process.pid));

      const ignoredSigchldProbe = spawnSync(
        "/bin/sh",
        [
          "-c",
          'trap "" CHLD; exec "$1" probe',
          "ignored-sigchld-probe",
          binary,
        ],
        { encoding: "utf8", timeout: 5_000 },
      );
      assert.equal(ignoredSigchldProbe.status, 0, ignoredSigchldProbe.stderr);
      assert.equal(ignoredSigchldProbe.stdout, `${PROBE_OUTPUT}\n`);

      const bootId = runHelper(binary, ["boot-id"]);
      assert.equal(bootId.status, 0, bootId.stderr);
      const bootIdValue = bootId.stdout.trimEnd();
      const bootIdMatch = bootIdValue.match(BOOT_ID_PATTERN);
      assert.ok(bootIdMatch);
      assert.ok(BigInt(bootIdMatch[1]) > 0n);
      assert.ok(BigInt(bootIdMatch[2]) < 1_000_000n);
      assert.ok(BigInt(bootIdMatch[3]) > 0n);
      const repeatedBootId = runHelper(binary, ["boot-id"]);
      assert.equal(repeatedBootId.status, 0, repeatedBootId.stderr);
      assert.equal(repeatedBootId.stdout, bootId.stdout);

      const { rows: snapshotRows } = readCoherentSnapshot(binary);
      assert.ok(snapshotRows.length > 0);
      assert.ok(snapshotRows.some((row) => row.pid === BigInt(process.pid)));
      assert.ok(snapshotRows.every((row) => row.resourceCoalitionId > 0n));
      assert.ok(snapshotRows.every((row) => row.jetsamCoalitionId > 0n));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const repeatedSnapshot = readCoherentSnapshot(binary);
        assert.ok(
          repeatedSnapshot.rows.some((row) => row.pid === BigInt(process.pid)),
        );
      }

      const signalReadyPath = join(directory, "signal-ready");
      const signalReceivedPath = join(directory, "signal-received");
      const signalChildCode = `
        const { writeFileSync } = require("node:fs");
        process.on("SIGUSR1", () => writeFileSync(${JSON.stringify(signalReceivedPath)}, "received"));
        writeFileSync(${JSON.stringify(signalReadyPath)}, "ready");
        setTimeout(() => process.exit(91), 15000).unref();
        setInterval(() => {}, 1000);
      `;
      signalChild = spawn(process.execPath, ["-e", signalChildCode], {
        stdio: "ignore",
      });
      await waitFor(
        () => existsSync(signalReadyPath),
        "the signal test child to become ready",
      );
      ({ row: signalChildIdentity } = readIdentity(binary, signalChild.pid));
      assert.ok(signalChildIdentity);
      const { row: testParentIdentity } = readIdentity(binary, process.pid);
      assert.ok(testParentIdentity);
      assert.equal(
        signalChildIdentity.parentUniqueId,
        testParentIdentity.uniqueId,
      );
      assert.ok(signalChildIdentity.uniqueId > testParentIdentity.uniqueId);
      assert.equal(
        signalChildIdentity.resourceCoalitionId,
        testParentIdentity.resourceCoalitionId,
      );
      assert.equal(
        signalChildIdentity.jetsamCoalitionId,
        testParentIdentity.jetsamCoalitionId,
      );

      const staleUnique = runHelper(binary, [
        "signal",
        String(signalChildIdentity.pid),
        String(alternateValue(signalChildIdentity.uniqueId, UINT64_MAX)),
        String(osConstants.signals.SIGUSR1),
      ]);
      assert.equal(staleUnique.status, 3, staleUnique.stderr);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(existsSync(signalReceivedPath), false);
      assert.equal(readIdentity(binary, signalChild.pid).result.status, 0);

      const exactSignal = signalExact(
        binary,
        signalChildIdentity,
        osConstants.signals.SIGUSR1,
      );
      assert.equal(exactSignal.status, 0, exactSignal.stderr);
      await waitFor(
        () => existsSync(signalReceivedPath),
        "the exact-identity signal delivery",
      );

      const signalChildExit = once(signalChild, "exit");
      const stopSignalChild = signalExact(
        binary,
        signalChildIdentity,
        osConstants.signals.SIGTERM,
      );
      assert.equal(stopSignalChild.status, 0, stopSignalChild.stderr);
      await signalChildExit;
      signalChild = null;

      const orphanPidPath = join(directory, "orphan-pid");
      const orphanReadyPath = join(directory, "orphan-ready");
      const orphanCode = `
        const { writeFileSync } = require("node:fs");
        writeFileSync(${JSON.stringify(orphanReadyPath)}, "ready");
        setTimeout(() => process.exit(92), 15000).unref();
        setInterval(() => {}, 1000);
      `;
      const intermediateCode = `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(orphanCode)}], { stdio: "ignore" });
        child.unref();
        writeFileSync(${JSON.stringify(orphanPidPath)}, String(child.pid));
        const deadline = setTimeout(() => process.exit(93), 10000);
        process.stdin.resume();
        process.stdin.once("data", () => { clearTimeout(deadline); process.exit(0); });
      `;
      intermediate = spawn(process.execPath, ["-e", intermediateCode], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      await waitFor(
        () => existsSync(orphanPidPath) && existsSync(orphanReadyPath),
        "the reparent test processes to become ready",
      );
      const orphanPid = Number(readFileSync(orphanPidPath, "utf8"));
      ({ row: intermediateIdentity } = readIdentity(binary, intermediate.pid));
      assert.ok(intermediateIdentity);
      assert.equal(
        intermediateIdentity.resourceCoalitionId,
        testParentIdentity.resourceCoalitionId,
      );
      assert.equal(
        intermediateIdentity.jetsamCoalitionId,
        testParentIdentity.jetsamCoalitionId,
      );
      const beforeReparent = readIdentity(binary, orphanPid);
      assert.equal(
        beforeReparent.result.status,
        0,
        beforeReparent.result.stderr,
      );
      assert.equal(beforeReparent.row.ppid, BigInt(intermediate.pid));
      assert.equal(
        beforeReparent.row.parentUniqueId,
        intermediateIdentity.uniqueId,
      );
      assert.equal(
        beforeReparent.row.resourceCoalitionId,
        intermediateIdentity.resourceCoalitionId,
      );
      assert.equal(
        beforeReparent.row.jetsamCoalitionId,
        intermediateIdentity.jetsamCoalitionId,
      );
      orphanIdentity = beforeReparent.row;

      const intermediateExit = once(intermediate, "exit");
      intermediate.stdin.end("exit\n");
      await intermediateExit;
      intermediate = null;

      let afterReparent = null;
      await waitFor(() => {
        const current = readIdentity(binary, orphanPid);
        if (
          current.result.status === 0 &&
          current.row.ppid !== beforeReparent.row.ppid
        ) {
          afterReparent = current.row;
          return true;
        }
        return false;
      }, "the child process to be reparented");
      assert.equal(afterReparent.uniqueId, beforeReparent.row.uniqueId);
      assert.equal(afterReparent.pidVersion, beforeReparent.row.pidVersion);
      assert.equal(
        afterReparent.parentUniqueId,
        beforeReparent.row.parentUniqueId,
      );
      assert.equal(
        afterReparent.resourceCoalitionId,
        beforeReparent.row.resourceCoalitionId,
      );
      assert.equal(
        afterReparent.jetsamCoalitionId,
        beforeReparent.row.jetsamCoalitionId,
      );
      orphanIdentity = afterReparent;

      const stopOrphan = signalExact(
        binary,
        orphanIdentity,
        osConstants.signals.SIGTERM,
      );
      assert.equal(stopOrphan.status, 0, stopOrphan.stderr);
      await waitFor(
        () => readIdentity(binary, orphanPid).result.status === 3,
        "the reparented child to exit",
      );
      orphanIdentity = null;
    } finally {
      const binary = join(directory, "darwin-process-identity");
      if (signalChild && signalChildIdentity) {
        signalExact(binary, signalChildIdentity, osConstants.signals.SIGKILL);
        await waitForExit(signalChild, "signal test child cleanup");
      }
      if (intermediate && intermediateIdentity) {
        signalExact(binary, intermediateIdentity, osConstants.signals.SIGKILL);
        await waitForExit(intermediate, "intermediate child cleanup");
      }
      if (orphanIdentity) {
        signalExact(binary, orphanIdentity, osConstants.signals.SIGKILL);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
