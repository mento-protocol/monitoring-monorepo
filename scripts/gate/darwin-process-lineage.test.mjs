import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  abandonUnstartedDarwinLineage,
  bindDarwinLineageRoot,
  captureDarwinExactChild,
  captureDarwinExactChildOrGone,
  captureDarwinExactParent,
  classifyDarwinLineageCandidates,
  darwinLineageConstantsForTest,
  darwinLineageTransitionForTest,
  darwinNativeHelperTrustForTest,
  darwinLineageWatchForTest,
  discardSettledDarwinLineage,
  parseDarwinExactIdentity,
  parseDarwinProcessSnapshot,
  prepareDarwinExactIdentityHelper,
  prepareDarwinLineage,
  refreshDarwinLineageBaseline,
  resumeDarwinOwnerLineage,
  retireDarwinOwnerLineage,
  signalDarwinExactIdentity,
  settleDarwinLineage,
  settleDarwinLineageCohort,
  statusDarwinExactIdentity,
} from "./darwin-process-lineage.mjs";
import {
  LEGACY_LIFECYCLE_CONTRACT,
  LEGACY_STATE_SCHEMA,
  hasExactDarwinAncestry,
  isExactDarwinChild,
  mergeWatchedDarwinLineageTombstones,
  validateState,
} from "./darwin-process-lineage-model.mjs";

import { readStateForSettlement } from "./darwin-process-lineage-state.mjs";
import {
  DarwinSnapshotContentionError,
  armDarwinPrivateWatcherControl,
  nativeHelper,
  nativeHelperRuntimeReceiptPath,
  readDarwinPrivateArmedMarker,
  readDarwinPrivateCancelMarker,
  runNativeSnapshot,
} from "./darwin-process-identity-helper.mjs";

function unlinkIfPresent(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const LINEAGE_MODULE_PATH = fileURLToPath(
  new URL("./darwin-process-lineage.mjs", import.meta.url),
);
const LINEAGE_SHELL_PATH = fileURLToPath(
  new URL("./darwin-process-lineage.sh", import.meta.url),
);
const { lifecycleContract, schema, snapshotHeader } =
  darwinLineageConstantsForTest;

test("an exact Darwin v3 file upgrades to the recovery contract", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentqg-legacy-upgrade-"));
  const timestamp = Math.floor(Date.now() / 1_000);
  const token = `legacy-upgrade-${process.pid}-${timestamp}`;
  const statePath = join(directory, `lineage.${token}.json`);
  const legacyState = {
    schema: LEGACY_STATE_SCHEMA,
    lifecycleContract: LEGACY_LIFECYCLE_CONTRACT,
    token,
    bootId: "pid1-1-0-10",
    baseline: ["10", "900"],
    root: {
      pid: 200,
      uniqueId: "1000",
      parentUniqueId: "900",
      resourceCoalitionId: "700",
      jetsamCoalitionId: "800",
    },
    launcher: {
      pid: 100,
      uniqueId: "900",
      parentUniqueId: "10",
      resourceCoalitionId: "700",
      jetsamCoalitionId: "800",
    },
    tombstones: [
      {
        pid: 201,
        uniqueId: "1001",
        parentUniqueId: "1000",
        classification: "owned",
        firstSeenAt: 2,
      },
    ],
    settledAt: null,
    settledReason: null,
    createdAt: 1,
  };
  try {
    writeFileSync(statePath, `${JSON.stringify(legacyState)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(statePath, 0o600);
    const upgraded = readStateForSettlement(statePath);
    assert.equal(upgraded.schema, schema);
    assert.equal(upgraded.lifecycleContract, lifecycleContract);
    assert.equal(upgraded.token, token);
    assert.equal(upgraded.revision, 0);
    assert.equal(upgraded.settledAt, null);
    assert.equal(upgraded.settledReason, null);
    assert.equal(upgraded.settlementProof, null);
    assert.deepEqual(upgraded.tombstones, [
      {
        ...legacyState.tombstones[0],
        termSentAt: null,
        killSentAt: null,
      },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), upgraded);

    const extendedToken = `legacy-extended-${process.pid}-${timestamp}`;
    const extendedPath = join(directory, `lineage.${extendedToken}.json`);
    writeFileSync(
      extendedPath,
      `${JSON.stringify({
        ...legacyState,
        token: extendedToken,
        unexpected: true,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    chmodSync(extendedPath, 0o600);
    assert.throws(
      () => readStateForSettlement(extendedPath),
      /not an exact legacy v3 obligation/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Darwin native source pin rejects replaceable file identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentqg-native-source-pin-"));
  const source = join(directory, "identity.c");
  const alias = join(directory, "identity-link.c");
  const hardLink = join(directory, "identity-hard-link.c");
  try {
    writeFileSync(source, "int main(void) { return 0; }\n", { mode: 0o600 });
    chmodSync(source, 0o600);
    assert.equal(
      darwinNativeHelperTrustForTest.readNativeSource(source).toString("utf8"),
      "int main(void) { return 0; }\n",
    );

    chmodSync(source, 0o620);
    assert.throws(
      () => darwinNativeHelperTrustForTest.readNativeSource(source),
      /safe current-user regular file/u,
    );
    chmodSync(source, 0o600);

    linkSync(source, hardLink);
    assert.throws(
      () => darwinNativeHelperTrustForTest.readNativeSource(source),
      /safe current-user regular file/u,
    );
    unlinkSync(hardLink);

    symlinkSync(source, alias);
    assert.throws(() => darwinNativeHelperTrustForTest.readNativeSource(alias));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Darwin native compiler is pinned to staged source and cache provenance", () => {
  const helperSource = readFileSync(
    new URL("./darwin-process-identity-helper.mjs", import.meta.url),
    "utf8",
  );
  assert.deepEqual(darwinNativeHelperTrustForTest.compilerArguments, [
    "--sdk",
    "macosx",
    "clang",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "__SOURCE__",
    "-o",
    "__OUTPUT__",
  ]);
  assert.match(
    helperSource,
    /for \(const source of sources\)[\s\S]*?writeExclusiveFile\([\s\S]*?join\(stagedDirectory, source\.cacheName\)[\s\S]*?source\.bytes[\s\S]*?spawnSync\([\s\S]*?NATIVE_COMPILER_ARGUMENTS\.map\([\s\S]*?stagedSource/u,
  );
  assert.match(
    helperSource,
    /nativeCacheProvenance\(sourceDigest, helperDigest\)[\s\S]*?renameSync\(stagedDirectory, cacheDirectory\)[\s\S]*?validateNativeHelperCache\(cacheDirectory, digest\)/u,
  );
});

test("Darwin coherent snapshot contention stays typed after bounded retries", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentqg-snapshot-retry-"));
  const helper = join(directory, "contended-helper");
  const counter = join(directory, "attempts");
  try {
    writeFileSync(
      helper,
      `#!${process.execPath}\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(counter)}, "x");\nprocess.stderr.write("contended epoch\\n");\nprocess.exit(5);\n`,
      { mode: 0o500 },
    );
    chmodSync(helper, 0o500);
    assert.throws(
      () =>
        runNativeSnapshot(helper, {
          timeoutMs: 10_000,
          maxAttempts: 6,
          maxSpawnTimeoutMs: 1_000,
          initialDelayMs: 1,
          maxDelayMs: 1,
        }),
      (error) =>
        error instanceof DarwinSnapshotContentionError &&
        /contended epoch/u.test(error.message),
    );
    assert.equal(readFileSync(counter, "utf8"), "xxxxxx");

    const lineageSource = readFileSync(LINEAGE_MODULE_PATH, "utf8");
    assert.match(
      lineageSource,
      /error instanceof DarwinSnapshotContentionError[\s\S]*?readDarwinPrivateCancelMarker[\s\S]*?deadline - performance\.now\(\)[\s\S]*?remaining <= 0[\s\S]*?return await settle\(\)/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Darwin watcher readiness is private, atomic, and replacement-safe", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentqg-watch-armed-"));
  try {
    const { armedFile, cancelFile, controlDirectory } = createWatcherControl(
      directory,
      "unit",
    );
    const pendingFile = `${armedFile}.pending`;
    const pendingDescriptor = openSync(
      pendingFile,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const pendingBefore = fstatSync(pendingDescriptor);
    assert.equal(
      readDarwinPrivateArmedMarker(
        armedFile,
        controlDirectory,
        "unit armed marker",
      ),
      "pending",
    );
    assert.deepEqual(
      armDarwinPrivateWatcherControl({
        armedFile,
        cancelFile,
        scratchDirectory: directory,
      }),
      { directory: controlDirectory, status: "armed" },
    );
    const pendingAfter = fstatSync(pendingDescriptor);
    const pendingPathAfter = lstatSync(pendingFile);
    closeSync(pendingDescriptor);
    assert.equal(pendingAfter.dev, pendingBefore.dev);
    assert.equal(pendingAfter.ino, pendingBefore.ino);
    assert.equal(pendingAfter.nlink, 1);
    assert.equal(pendingAfter.mode & 0o7777, 0o600);
    assert.equal(pendingAfter.size, 0);
    assert.equal(pendingPathAfter.dev, pendingBefore.dev);
    assert.equal(pendingPathAfter.ino, pendingBefore.ino);
    assert.equal(
      readDarwinPrivateArmedMarker(
        armedFile,
        controlDirectory,
        "unit armed marker",
      ),
      "armed",
    );
    assert.equal(readFileSync(armedFile, "utf8"), "armed\n");
    assert.equal(lstatSync(armedFile).mode & 0o7777, 0o400);
    const stagedFile = `${armedFile}.staged`;
    const armedStat = lstatSync(armedFile);
    const stagedStat = lstatSync(stagedFile);
    assert.equal(armedStat.dev, stagedStat.dev);
    assert.equal(armedStat.ino, stagedStat.ino);
    assert.equal(armedStat.nlink, 2);
    assert.equal(stagedStat.nlink, 2);

    unlinkSync(armedFile);
    writeFileSync(armedFile, "wrong\n", { mode: 0o400 });
    assert.throws(
      () =>
        readDarwinPrivateArmedMarker(
          armedFile,
          controlDirectory,
          "unit armed marker",
        ),
      /safe current-user regular file|exact staged marker/u,
    );
    unlinkSync(armedFile);
    writeFileSync(join(controlDirectory, "replacement"), "armed\n", {
      mode: 0o400,
    });
    linkSync(join(controlDirectory, "replacement"), armedFile);
    assert.throws(
      () =>
        readDarwinPrivateArmedMarker(
          armedFile,
          controlDirectory,
          "unit armed marker",
        ),
      /safe current-user regular file|exact staged marker/u,
    );

    const stagedOnly = createWatcherControl(directory, "staged-only");
    writeFileSync(`${stagedOnly.armedFile}.staged`, "armed\n", {
      flag: "wx",
      mode: 0o400,
    });
    chmodSync(`${stagedOnly.armedFile}.staged`, 0o400);
    assert.equal(
      readDarwinPrivateArmedMarker(
        stagedOnly.armedFile,
        stagedOnly.controlDirectory,
        "staged-only armed marker",
      ),
      "pending",
    );
    assert.throws(
      () =>
        armDarwinPrivateWatcherControl({
          armedFile: stagedOnly.armedFile,
          cancelFile: stagedOnly.cancelFile,
          scratchDirectory: directory,
        }),
      /EEXIST/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Darwin watcher action publication is exclusive and stage-bound", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentqg-watch-action-"));
  try {
    const control = createWatcherControl(directory, "action");
    assert.equal(
      readDarwinPrivateCancelMarker(
        control.cancelFile,
        control.controlDirectory,
        "unit action marker",
      ),
      "pending",
    );
    linkSync(`${control.cancelFile}.settle.staged`, control.cancelFile);
    assert.equal(
      readDarwinPrivateCancelMarker(
        control.cancelFile,
        control.controlDirectory,
        "unit action marker",
      ),
      "settle",
    );
    assert.throws(
      () => linkSync(`${control.cancelFile}.cancel.staged`, control.cancelFile),
      /EEXIST/u,
    );
    linkSync(control.cancelFile, join(control.controlDirectory, "extra-link"));
    assert.throws(
      () =>
        readDarwinPrivateCancelMarker(
          control.cancelFile,
          control.controlDirectory,
          "unit action marker",
        ),
      /safe current-user regular file/u,
    );

    const independent = createWatcherControl(directory, "independent");
    writeFileSync(independent.cancelFile, "cancel\n", {
      flag: "wx",
      mode: 0o400,
    });
    chmodSync(independent.cancelFile, 0o400);
    assert.throws(
      () =>
        readDarwinPrivateCancelMarker(
          independent.cancelFile,
          independent.controlDirectory,
          "independent action marker",
        ),
      /safe current-user regular file/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function record({
  pid,
  ppid,
  uniqueId,
  parentUniqueId,
  pgid = pid,
  status = 2,
  uid = 501,
  realUid = uid,
  savedUid = uid,
  resourceCoalitionId = "700",
  jetsamCoalitionId = "800",
  pidVersion = 1,
}) {
  return {
    pid,
    ppid,
    pgid,
    status,
    uid,
    realUid,
    savedUid,
    uniqueId,
    parentUniqueId,
    resourceCoalitionId,
    jetsamCoalitionId,
    pidVersion,
  };
}

function row(processRecord) {
  return [
    processRecord.pid,
    processRecord.ppid,
    processRecord.pgid,
    processRecord.status,
    processRecord.uid,
    processRecord.realUid,
    processRecord.savedUid,
    processRecord.uniqueId,
    processRecord.parentUniqueId,
    processRecord.resourceCoalitionId,
    processRecord.jetsamCoalitionId,
    processRecord.pidVersion,
  ].join("\t");
}

function coherentSnapshot(records, overrides = {}) {
  const proof = {
    header: snapshotHeader,
    lowerUniqueId: "2000",
    upperUniqueId: "2001",
    estimatedCount: 29,
    listedCount: 10,
    capacity: 30,
    zeroPidCount: 1,
    rowCount: records.length,
    ...overrides,
  };
  return `${[
    proof.header,
    proof.lowerUniqueId,
    proof.upperUniqueId,
    proof.estimatedCount,
    proof.listedCount,
    proof.capacity,
    proof.zeroPidCount,
    proof.rowCount,
  ].join("\t")}\n${records.map(row).join("\n")}${records.length ? "\n" : ""}`;
}

function state(overrides = {}) {
  const defaults = {
    schema,
    lifecycleContract,
    token: "lineage-test-123-456",
    bootId: "pid1-1-0-10",
    baseline: ["10"],
    root: {
      pid: 200,
      uniqueId: "1000",
      parentUniqueId: "900",
      resourceCoalitionId: "700",
      jetsamCoalitionId: "800",
    },
    launcher: {
      pid: 100,
      uniqueId: "900",
      parentUniqueId: "10",
      resourceCoalitionId: "700",
      jetsamCoalitionId: "800",
    },
    tombstones: [],
    settledAt: null,
    settledReason: null,
    settlementProof: null,
    createdAt: 1,
    revision: 0,
    ...overrides,
  };
  if (overrides.root && typeof overrides.root === "object") {
    defaults.root = {
      pid: 200,
      uniqueId: "1000",
      parentUniqueId: "900",
      resourceCoalitionId: "700",
      jetsamCoalitionId: "800",
      ...overrides.root,
    };
  }
  if (overrides.launcher && typeof overrides.launcher === "object") {
    defaults.launcher = {
      pid: 100,
      uniqueId: "900",
      parentUniqueId: "10",
      resourceCoalitionId: "700",
      jetsamCoalitionId: "800",
      ...overrides.launcher,
    };
  }
  return defaults;
}

test("Darwin snapshot counts tolerate one exit and reject unsafe slack", () => {
  const entry = record({
    pid: 100,
    ppid: 1,
    uniqueId: "1000",
    parentUniqueId: "10",
  });
  const afterOneExit = parseDarwinProcessSnapshot(
    coherentSnapshot([entry], { estimatedCount: 30, capacity: 30 }),
  );
  assert.equal(afterOneExit.proof.estimatedCount, 30);
  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        coherentSnapshot([entry], { estimatedCount: 28, capacity: 28 }),
      ),
    /inconsistent process counts/u,
  );
  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        coherentSnapshot([entry], {
          estimatedCount: 50,
          listedCount: 30,
          capacity: 30,
        }),
      ),
    /inconsistent process counts/u,
  );
});

test("Darwin unstarted settlement reason rejects bound state", () => {
  assert.throws(
    () =>
      validateState(
        state({
          settledAt: 2,
          settledReason: "verified-unbound-abandonment",
        }),
      ),
    /unstarted abandonment contains bound lineage evidence/u,
  );
  assert.throws(
    () =>
      validateState(
        state({
          root: null,
          launcher: null,
          tombstones: [
            {
              pid: 201,
              uniqueId: "1001",
              parentUniqueId: "1000",
              classification: "ambiguous",
              firstSeenAt: 2,
              termSentAt: null,
              killSentAt: null,
            },
          ],
          settledAt: 2,
          settledReason: "verified-unbound-abandonment",
        }),
      ),
    /unstarted abandonment contains bound lineage evidence/u,
  );
});

test("Darwin cohort settlement validates its bounded token and path set", async () => {
  const firstDirectory = mkdtempSync(join(tmpdir(), "agentqg-cohort-path-a-"));
  const secondDirectory = mkdtempSync(join(tmpdir(), "agentqg-cohort-path-b-"));
  const linkedDirectory = join(
    dirname(firstDirectory),
    `agentqg-cohort-path-link-${process.pid}-${Date.now()}`,
  );
  const timestamp = Math.floor(Date.now() / 1_000);
  const firstToken = `cohort-path-a-${process.pid}-${timestamp}`;
  const secondToken = `cohort-path-b-${process.pid}-${timestamp}`;
  const firstPath = join(firstDirectory, `lineage.${firstToken}.json`);
  const secondPath = join(firstDirectory, `lineage.${secondToken}.json`);
  try {
    symlinkSync(firstDirectory, linkedDirectory);
    const settle = (statePaths, retainState = true) =>
      settleDarwinLineageCohort({
        statePaths,
        scratchDirectory: firstDirectory,
        timeoutSeconds: 1,
        retainState,
      });
    await assert.rejects(
      settle([]),
      /must contain from 1 through 64 state paths/u,
    );
    await assert.rejects(
      settle([firstPath, firstPath]),
      /duplicate state token or path/u,
    );
    await assert.rejects(
      settle([firstPath, join(secondDirectory, `lineage.${secondToken}.json`)]),
      /must share one real directory/u,
    );
    await assert.rejects(
      settle([join(firstDirectory, "lineage.not-a-token.json")]),
      /has no valid token/u,
    );
    await assert.rejects(
      settle([join(linkedDirectory, `lineage.${firstToken}.json`)]),
      /not a current-user real directory/u,
    );
    await assert.rejects(
      settle([firstPath, secondPath], false),
      /must retain every state/u,
    );

    const invalidTokens = spawnSync(
      process.execPath,
      [
        LINEAGE_MODULE_PATH,
        "settle-cohort",
        "--state-directory",
        firstDirectory,
        "--tokens",
        `${firstToken},${firstToken}`,
        "--scratch",
        firstDirectory,
        "--timeout-seconds",
        "1",
        "--retain-state",
        "1",
      ],
      { encoding: "utf8" },
    );
    assert.equal(invalidTokens.status, 2);
    assert.match(invalidTokens.stderr, /token list is malformed/u);

    const nonRetained = spawnSync(
      process.execPath,
      [
        LINEAGE_MODULE_PATH,
        "settle-cohort",
        "--state-directory",
        firstDirectory,
        "--tokens",
        firstToken,
        "--scratch",
        firstDirectory,
        "--timeout-seconds",
        "1",
        "--retain-state",
        "0",
      ],
      { encoding: "utf8" },
    );
    assert.equal(nonRetained.status, 2);
    assert.match(nonRetained.stderr, /must retain every state/u);
  } finally {
    unlinkIfPresent(linkedDirectory);
    rmSync(firstDirectory, { recursive: true, force: true });
    rmSync(secondDirectory, { recursive: true, force: true });
  }
});

test(
  "Darwin single-state settlement keeps cohort-of-one result parity",
  { skip: process.platform !== "darwin" },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-cohort-parity-"));
    const timestamp = Math.floor(Date.now() / 1_000);
    const singleToken = `cohort-parity-single-${process.pid}-${timestamp}`;
    const cohortToken = `cohort-parity-many-${process.pid}-${timestamp}`;
    const singlePath = join(directory, `lineage.${singleToken}.json`);
    const cohortPath = join(directory, `lineage.${cohortToken}.json`);
    try {
      for (const [token, statePath] of [
        [singleToken, singlePath],
        [cohortToken, cohortPath],
      ]) {
        writeFileSync(
          statePath,
          `${JSON.stringify(
            state({
              token,
              root: null,
              launcher: null,
              settledAt: 2,
              settledReason: "verified-boot-change",
            }),
          )}\n`,
          { flag: "wx", mode: 0o600 },
        );
        chmodSync(statePath, 0o600);
      }
      const single = await settleDarwinLineage({
        statePath: singlePath,
        scratchDirectory: directory,
        timeoutSeconds: 0,
        retainState: true,
      });
      const cohort = await settleDarwinLineageCohort({
        statePaths: [cohortPath],
        scratchDirectory: directory,
        timeoutSeconds: 0,
        retainState: true,
      });
      assert.deepEqual(single, {
        active: true,
        retained: true,
        reason: "verified-boot-change",
        settled: true,
      });
      assert.deepEqual(
        {
          active: cohort.active,
          retained: cohort.retained,
          reason: cohort.settlements[0].reason,
          settled: cohort.settled,
        },
        single,
      );
      discardSettledDarwinLineage({ statePath: singlePath });
      discardSettledDarwinLineage({ statePath: cohortPath });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin zero-timeout settlement only consumes existing durable proof",
  { skip: process.platform !== "darwin" },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-zero-settle-"));
    const token = `zero-settle-${process.pid}-${Math.floor(Date.now() / 1_000)}`;
    const statePath = join(directory, `lineage.${token}.json`);
    try {
      const settledState = state({
        token,
        root: null,
        launcher: null,
        settledAt: 2,
        settledReason: "verified-boot-change",
      });
      writeFileSync(statePath, `${JSON.stringify(settledState)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      chmodSync(statePath, 0o600);

      assert.deepEqual(
        await settleDarwinLineage({
          statePath,
          scratchDirectory: directory,
          timeoutSeconds: 0,
          retainState: false,
        }),
        {
          active: true,
          retained: false,
          reason: "verified-boot-change",
          settled: true,
        },
      );
      assert.equal(existsSync(statePath), false);

      const unsettledState = state({
        token,
        root: null,
        launcher: null,
      });
      const unsettledBytes = `${JSON.stringify(unsettledState)}\n`;
      writeFileSync(statePath, unsettledBytes, { flag: "wx", mode: 0o600 });
      chmodSync(statePath, 0o600);
      await assert.rejects(
        settleDarwinLineage({
          statePath,
          scratchDirectory: directory,
          timeoutSeconds: 0,
          retainState: false,
        }),
        /lineage timeout is not a supported positive integer/u,
      );
      assert.equal(readFileSync(statePath, "utf8"), unsettledBytes);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin unstarted abandonment consumes only exact unbound v4 state",
  { skip: process.platform !== "darwin" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-unbound-abandon-"));
    const writeState = (token, value) => {
      const statePath = join(directory, `lineage.${token}.json`);
      const bytes = `${JSON.stringify(value)}\n`;
      writeFileSync(statePath, bytes, { flag: "wx", mode: 0o600 });
      chmodSync(statePath, 0o600);
      return { bytes, statePath };
    };
    try {
      const token = `unbound-abandon-${process.pid}-1`;
      const unbound = writeState(
        token,
        state({ token, root: null, launcher: null }),
      );
      assert.deepEqual(
        abandonUnstartedDarwinLineage({ statePath: unbound.statePath }),
        {
          active: true,
          abandoned: true,
          reason: "verified-unbound-abandonment",
        },
      );
      assert.equal(existsSync(unbound.statePath), false);

      const publishedToken = `unbound-abandon-${process.pid}-2`;
      const published = writeState(
        publishedToken,
        state({
          token: publishedToken,
          root: null,
          launcher: null,
          settledAt: Date.now(),
          settledReason: "verified-unbound-abandonment",
        }),
      );
      abandonUnstartedDarwinLineage({ statePath: published.statePath });
      assert.equal(existsSync(published.statePath), false);

      const boundToken = `unbound-abandon-${process.pid}-3`;
      const bound = writeState(boundToken, state({ token: boundToken }));
      assert.throws(
        () => abandonUnstartedDarwinLineage({ statePath: bound.statePath }),
        /only an exact unbound Darwin lineage/u,
      );
      assert.equal(readFileSync(bound.statePath, "utf8"), bound.bytes);

      const tombstoneToken = `unbound-abandon-${process.pid}-4`;
      const withTombstone = writeState(
        tombstoneToken,
        state({
          token: tombstoneToken,
          root: null,
          launcher: null,
          tombstones: [
            {
              pid: 201,
              uniqueId: "1001",
              parentUniqueId: "1000",
              classification: "ambiguous",
              firstSeenAt: 2,
              termSentAt: null,
              killSentAt: null,
            },
          ],
        }),
      );
      assert.throws(
        () =>
          abandonUnstartedDarwinLineage({
            statePath: withTombstone.statePath,
          }),
        /only an exact unbound Darwin lineage/u,
      );
      assert.equal(
        readFileSync(withTombstone.statePath, "utf8"),
        withTombstone.bytes,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin owner lineage spans claim, sequential commands, and lock release",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-owner-lineage-"));
    const token = `owner-lineage-${process.pid}-${Math.floor(Date.now() / 1_000)}`;
    const statePath = join(directory, `lineage.${token}.json`);
    let root;
    try {
      prepareDarwinLineage({
        statePath,
        scratchDirectory: directory,
        token,
      });
      assert.deepEqual(
        await settleDarwinLineage({
          statePath,
          scratchDirectory: directory,
          timeoutSeconds: 1,
          retainState: true,
        }),
        {
          active: true,
          retained: true,
          reason: "verified-unbound-abandonment",
          settled: true,
        },
      );

      const firstResume = resumeDarwinOwnerLineage({
        statePath,
        scratchDirectory: directory,
      });
      assert.equal(firstResume.active, true);
      assert.equal(firstResume.rearmed, true);
      let resumedState = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(resumedState.root, null);
      assert.equal(resumedState.launcher, null);
      assert.equal(resumedState.settledAt, null);
      assert.equal(resumedState.settledReason, null);
      assert.equal(resumedState.settlementProof, null);

      root = spawn(
        process.execPath,
        [
          "-e",
          "process.stdin.once('data', () => process.exit(0)); process.stdin.resume()",
        ],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      bindDarwinLineageRoot({
        statePath,
        scratchDirectory: directory,
        pid: root.pid,
        parentPid: process.pid,
      });
      root.stdin.end("settle\n");
      await once(root, "exit");

      const commandSettlement = await settleDarwinLineage({
        statePath,
        scratchDirectory: directory,
        timeoutSeconds: 5,
        retainState: true,
      });
      assert.equal(commandSettlement.reason, "empty-coherent-exact-set");
      assert.equal(commandSettlement.settled, true);

      const secondResume = resumeDarwinOwnerLineage({
        statePath,
        scratchDirectory: directory,
      });
      assert.equal(secondResume.active, true);
      assert.equal(secondResume.rearmed, true);
      resumedState = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(resumedState.root, null);
      assert.equal(resumedState.launcher, null);
      assert.deepEqual(resumedState.tombstones, []);
      assert.equal(resumedState.settledAt, null);

      assert.deepEqual(retireDarwinOwnerLineage({ statePath }), {
        active: true,
        retired: true,
        reason: "verified-unbound-abandonment",
      });
      assert.equal(existsSync(statePath), false);
    } finally {
      if (root && root.exitCode === null && root.signalCode === null) {
        root.kill("SIGKILL");
        await once(root, "exit");
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("Darwin watcher reads state from an explicit private state directory", () => {
  const scratchDirectory = mkdtempSync(
    join(tmpdir(), "agentqg-watch-scratch-"),
  );
  const stateDirectory = mkdtempSync(join(tmpdir(), "agentqg-watch-state-"));
  const token = "watch-state-123-456";
  const statePath = join(stateDirectory, `lineage.${token}.json`);
  try {
    writeFileSync(statePath, `${JSON.stringify(state({ token }))}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(statePath, 0o600);

    assert.deepEqual(
      darwinLineageWatchForTest.readPrivateWatchState(
        statePath,
        stateDirectory,
      ),
      state({ token }),
    );
    assert.throws(
      () =>
        darwinLineageWatchForTest.readPrivateWatchState(
          statePath,
          scratchDirectory,
        ),
      /private peer/u,
    );

    chmodSync(stateDirectory, 0o755);
    assert.throws(
      () =>
        darwinLineageWatchForTest.readPrivateWatchState(
          statePath,
          stateDirectory,
        ),
      /unsafe mode/u,
    );

    chmodSync(stateDirectory, 0o700);
    chmodSync(statePath, 0o640);
    assert.throws(
      () =>
        darwinLineageWatchForTest.readPrivateWatchState(
          statePath,
          stateDirectory,
        ),
      /safe current-user regular file/u,
    );
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("Darwin watcher defaults state storage to scratch and accepts an explicit peer directory", () => {
  const source = readFileSync(LINEAGE_MODULE_PATH, "utf8");
  assert.match(
    source,
    /watchDarwinLineageSettlement\(\{[\s\S]*?scratchDirectory,[\s\S]*?stateDirectory = scratchDirectory,[\s\S]*?\}\)/u,
  );
  assert.match(source, /readPrivateWatchState\(statePath, stateDirectory\)/u);
  assert.match(source, /stateDirectory: options\.get\("--state-directory"\)/u);
});

test("Darwin watcher census CAS retries are bounded by attempts and deadline", () => {
  const source = readFileSync(LINEAGE_MODULE_PATH, "utf8");
  const censusTransition = source.slice(
    source.indexOf("const MAX_WATCH_CENSUS_TRANSITION_ATTEMPTS"),
    source.indexOf("async function settleWatchedDarwinLineage"),
  );
  assert.match(censusTransition, /MAX_WATCH_CENSUS_TRANSITION_ATTEMPTS = 4/u);
  assert.match(
    censusTransition,
    /attempt < MAX_WATCH_CENSUS_TRANSITION_ATTEMPTS/u,
  );
  assert.match(censusTransition, /performance\.now\(\) >= deadline/u);
  assert.doesNotMatch(censusTransition, /while \(true\)/u);
});

function tombstone({ pid, uniqueId, parentUniqueId, classification }) {
  return {
    pid,
    uniqueId,
    parentUniqueId,
    classification,
    firstSeenAt: 1,
    termSentAt: null,
    killSentAt: null,
  };
}

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function captureCurrentExactIdentity(directory) {
  const result = spawnSync(
    process.execPath,
    [
      LINEAGE_MODULE_PATH,
      "capture-exact-parent",
      "--scratch",
      directory,
      "--pid",
      String(process.pid),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const exactIdentity = result.stdout.trim();
  assert.equal(parseDarwinExactIdentity(exactIdentity).pid, process.pid);
  return exactIdentity;
}

async function createWatcherFixture(
  directory,
  name,
  {
    rootCode = "process.on('SIGTERM', () => process.exit(0)); process.stdin.once('data', () => process.exit(0)); process.stdin.resume(); process.send('ready')",
  } = {},
) {
  const token = `${name}-${process.pid}-${Math.floor(Date.now() / 1_000)}`;
  const statePath = join(directory, `lineage.${token}.json`);
  prepareDarwinLineage({ statePath, scratchDirectory: directory, token });
  const root = spawn(process.execPath, ["-e", rootCode], {
    stdio: ["pipe", "ignore", "ignore", "ipc"],
  });
  await once(root, "message");
  bindDarwinLineageRoot({
    statePath,
    scratchDirectory: directory,
    pid: root.pid,
    parentPid: process.pid,
  });
  return {
    controllerIdentity: captureCurrentExactIdentity(directory),
    root,
    statePath,
  };
}

function createWatcherControl(directory, name, cancel = "") {
  const controlDirectory = join(directory, `deadline-recovery.${name}`);
  const cancelFile = join(controlDirectory, "action");
  const armedFile = join(controlDirectory, "armed");
  mkdirSync(controlDirectory, { mode: 0o700 });
  writeFileSync(`${cancelFile}.cancel.staged`, "cancel\n", {
    flag: "wx",
    mode: 0o400,
  });
  chmodSync(`${cancelFile}.cancel.staged`, 0o400);
  writeFileSync(`${cancelFile}.settle.staged`, "settle\n", {
    flag: "wx",
    mode: 0o400,
  });
  chmodSync(`${cancelFile}.settle.staged`, 0o400);
  if (cancel !== "") {
    writeFileSync(cancelFile, cancel, { flag: "wx", mode: 0o400 });
    chmodSync(cancelFile, 0o400);
  }
  writeFileSync(`${armedFile}.pending`, "", { flag: "wx", mode: 0o600 });
  chmodSync(`${armedFile}.pending`, 0o600);
  return { armedFile, cancelFile, controlDirectory };
}

function spawnSettlementWatcher({
  armedFile,
  cancelFile,
  controllerIdentity,
  directory,
  statePath,
  timeoutSeconds,
}) {
  const child = spawn(process.execPath, [
    LINEAGE_MODULE_PATH,
    "watch-settle",
    "--state",
    statePath,
    "--scratch",
    directory,
    "--controller-identity",
    controllerIdentity,
    "--cancel-file",
    cancelFile,
    "--armed-file",
    armedFile,
    "--timeout-seconds",
    String(timeoutSeconds),
  ]);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const resultPromise = once(child, "exit").then(([status, signal]) => ({
    signal,
    status,
    stderr,
    stdout,
  }));
  return {
    child,
    result: () => resultPromise,
  };
}

async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

const WATCHER_LAUNCHER_CODE = String.raw`
  const { spawn } = require("node:child_process");
  const {
    chmodSync,
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    writeFileSync,
  } = require("node:fs");
  const [
    modulePath,
    statePath,
    directory,
    cancelFile,
    armedFile,
    readyFile,
    rootReadyFile,
    goFile,
    watcherFile,
    outputFile,
    stderrFile,
  ] = process.argv.slice(1);
  const root = spawn(process.execPath, [
    "-e",
    "const { writeFileSync } = require('node:fs'); process.on('SIGTERM', () => process.exit(0)); writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)",
    rootReadyFile,
  ], { stdio: "ignore" });
  const readyTimer = setInterval(() => {
    if (!existsSync(rootReadyFile)) return;
    clearInterval(readyTimer);
    writeFileSync(readyFile, JSON.stringify({
      launcherPid: process.pid,
      rootPid: root.pid,
    }));
  }, 20);
  const goTimer = setInterval(() => {
    if (!existsSync(goFile)) return;
    clearInterval(goTimer);
    const options = JSON.parse(readFileSync(goFile, "utf8"));
    const stdout = openSync(outputFile, "wx", 0o600);
    const stderr = openSync(stderrFile, "wx", 0o600);
    const watcher = spawn(process.execPath, [
      modulePath,
      "watch-settle",
      "--state",
      statePath,
      "--scratch",
      directory,
      "--controller-identity",
      options.controllerIdentity,
      "--cancel-file",
      cancelFile,
      "--armed-file",
      armedFile,
      "--timeout-seconds",
      String(options.timeoutSeconds),
    ], { stdio: ["ignore", stdout, stderr] });
    closeSync(stdout);
    closeSync(stderr);
    writeFileSync(watcherFile, String(watcher.pid), { mode: 0o600 });
    chmodSync(watcherFile, 0o600);
  }, 20);
  setInterval(() => {}, 1000);
`;

const WATCHER_CONTROLLER_CODE = String.raw`
  const { spawn } = require("node:child_process");
  spawn(
    process.execPath,
    ["-e", process.argv[1], ...process.argv.slice(2)],
    { stdio: "ignore" },
  );
  setInterval(() => {}, 1000);
`;

async function launchNestedWatcherFixture({
  controllerMode,
  controllerIdentityOverride,
  directory,
  name,
  timeoutSeconds = 10,
}) {
  const token = `${name}-${process.pid}-${Math.floor(Date.now() / 1_000)}`;
  const statePath = join(directory, `lineage.${token}.json`);
  const controlDirectory = join(directory, `deadline-recovery.${name}`);
  const cancelFile = join(controlDirectory, "action");
  const armedFile = join(controlDirectory, "armed");
  const readyFile = join(directory, `${name}.ready`);
  const rootReadyFile = join(directory, `${name}.root-ready`);
  const goFile = join(directory, `${name}.go`);
  const watcherFile = join(directory, `${name}.watcher`);
  const outputFile = join(directory, `${name}.stdout`);
  const stderrFile = join(directory, `${name}.stderr`);
  prepareDarwinLineage({ statePath, scratchDirectory: directory, token });
  mkdirSync(controlDirectory, { mode: 0o700 });
  writeFileSync(`${cancelFile}.cancel.staged`, "cancel\n", {
    flag: "wx",
    mode: 0o400,
  });
  chmodSync(`${cancelFile}.cancel.staged`, 0o400);
  writeFileSync(`${cancelFile}.settle.staged`, "settle\n", {
    flag: "wx",
    mode: 0o400,
  });
  chmodSync(`${cancelFile}.settle.staged`, 0o400);
  writeFileSync(`${armedFile}.pending`, "", { flag: "wx", mode: 0o600 });
  chmodSync(`${armedFile}.pending`, 0o600);
  const launcherArguments = [
    LINEAGE_MODULE_PATH,
    statePath,
    directory,
    cancelFile,
    armedFile,
    readyFile,
    rootReadyFile,
    goFile,
    watcherFile,
    outputFile,
    stderrFile,
  ];
  let controller = null;
  let launcher = null;
  if (controllerMode === "nested") {
    controller = spawn(
      process.execPath,
      [
        "-e",
        WATCHER_CONTROLLER_CODE,
        WATCHER_LAUNCHER_CODE,
        ...launcherArguments,
      ],
      { stdio: "ignore" },
    );
  } else {
    launcher = spawn(
      process.execPath,
      ["-e", WATCHER_LAUNCHER_CODE, ...launcherArguments],
      { stdio: "ignore" },
    );
  }
  await waitFor(() => existsSync(readyFile), `${name} launcher tree`);
  const { launcherPid, rootPid } = JSON.parse(readFileSync(readyFile, "utf8"));
  const controllerPid = controller?.pid ?? process.pid;
  bindDarwinLineageRoot({
    statePath,
    scratchDirectory: directory,
    pid: rootPid,
    parentPid: launcherPid,
  });
  const capturedController = controller
    ? captureDarwinExactChild({
        scratchDirectory: directory,
        pid: controller.pid,
        parentPid: process.pid,
      }).identity
    : captureCurrentExactIdentity(directory);
  const launcherIdentity = captureDarwinExactChild({
    scratchDirectory: directory,
    pid: launcherPid,
    parentPid: controllerPid,
  }).identity;
  const rootIdentity = captureDarwinExactChild({
    scratchDirectory: directory,
    pid: rootPid,
    parentPid: launcherPid,
  }).identity;
  writeFileSync(
    goFile,
    JSON.stringify({
      controllerIdentity: controllerIdentityOverride ?? capturedController,
      timeoutSeconds,
    }),
    { flag: "wx", mode: 0o600 },
  );
  chmodSync(goFile, 0o600);
  await waitFor(() => existsSync(watcherFile), `${name} watcher launch`);
  const watcherPid = Number(readFileSync(watcherFile, "utf8"));
  const watcherCapture = captureDarwinExactChildOrGone({
    scratchDirectory: directory,
    pid: watcherPid,
    parentPid: launcherPid,
  });
  return {
    armedFile,
    cancelFile,
    controller,
    controllerIdentity: capturedController,
    launcher,
    launcherIdentity,
    outputFile,
    rootIdentity,
    statePath,
    stderrFile,
    watcherIdentity: watcherCapture.active ? watcherCapture.identity : null,
  };
}

async function stopExactProcess(directory, exactIdentity) {
  if (!exactIdentity) return;
  const { status } = statusDarwinExactIdentity({
    scratchDirectory: directory,
    exactIdentity,
  });
  if (status === "live") {
    signalDarwinExactIdentity({
      scratchDirectory: directory,
      exactIdentity,
      signal: 9,
    });
    await waitFor(
      () =>
        statusDarwinExactIdentity({
          scratchDirectory: directory,
          exactIdentity,
        }).status !== "live",
      "the exact fixture process to stop",
    );
  }
}

async function waitForWatcherSettlement(fixture, description) {
  await waitFor(
    () =>
      existsSync(fixture.outputFile) &&
      readFileSync(fixture.outputFile, "utf8") === "settled\n",
    description,
  );
  assert.equal(existsSync(fixture.statePath), true);
  const settledState = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.equal(settledState.settledReason, "empty-coherent-exact-set");
  assert.equal(typeof settledState.settlementProof, "object");
  await waitFor(
    () =>
      statusDarwinExactIdentity({
        scratchDirectory: dirname(fixture.statePath),
        exactIdentity: fixture.rootIdentity,
      }).status !== "live",
    `${description} root cleanup`,
  );
  discardSettledDarwinLineage({ statePath: fixture.statePath });
  assert.equal(existsSync(fixture.statePath), false);
}

async function assertWatcherArmed(directory, fixture) {
  await waitFor(
    () =>
      existsSync(fixture.armedFile) &&
      readFileSync(fixture.armedFile, "utf8") === "armed\n",
    "the watcher armed marker",
  );
  assert.equal(existsSync(fixture.statePath), true);
  assert.equal(readFileSync(fixture.outputFile, "utf8"), "");
  assert.equal(
    statusDarwinExactIdentity({
      scratchDirectory: directory,
      exactIdentity: fixture.rootIdentity,
    }).status,
    "live",
  );
}

async function cleanupNestedWatcherFixture(directory, fixture) {
  if (!fixture) return;
  await stopExactProcess(directory, fixture.watcherIdentity);
  await stopExactProcess(directory, fixture.rootIdentity);
  await stopExactProcess(directory, fixture.launcherIdentity);
  if (
    fixture.launcher?.exitCode === null &&
    fixture.launcher.signalCode === null
  ) {
    fixture.launcher.kill("SIGKILL");
    await waitForChildExit(fixture.launcher);
  }
  if (
    fixture.controller?.exitCode === null &&
    fixture.controller.signalCode === null
  ) {
    fixture.controller.kill("SIGKILL");
    await waitForChildExit(fixture.controller);
  }
}

test("Darwin snapshot parsing accepts only complete kernel identities", () => {
  const first = record({
    pid: 100,
    ppid: 1,
    uniqueId: "1000",
    parentUniqueId: "10",
  });
  const second = record({
    pid: 101,
    ppid: 100,
    uniqueId: "1001",
    parentUniqueId: "1000",
  });
  const parsed = parseDarwinProcessSnapshot(coherentSnapshot([first, second]));
  assert.deepEqual(parsed.records, [first, second]);
  assert.deepEqual(parsed.proof, {
    kind: "xnu-coherent-process-snapshot-v1",
    lowerUniqueId: "2000",
    upperUniqueId: "2001",
    estimatedCount: 29,
    listedCount: 10,
    capacity: 30,
    zeroPidCount: 1,
    rowCount: 2,
  });

  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        coherentSnapshot([first], { header: "wrong-header" }),
      ),
    /unsupported header/u,
  );
  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        `agentqg-darwin-process-snapshot-v2\n${row(first)}\n`,
      ),
    /unsupported header/u,
  );
  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        coherentSnapshot([first, { ...second, pid: first.pid }]),
      ),
    /duplicate PID/u,
  );
  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        coherentSnapshot([
          first,
          { ...second, uniqueId: first.uniqueId, parentUniqueId: "10" },
        ]),
      ),
    /duplicate unique ID/u,
  );
  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        coherentSnapshot([], { rowCount: 1 }) + "1\t2\t3\n",
      ),
    /does not have 12 fields/u,
  );
  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        coherentSnapshot([{ ...first, uid: 4_294_967_296 }]),
      ),
    /outside its supported range/u,
  );
  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        coherentSnapshot([{ ...first, uniqueId: "18446744073709551616" }]),
      ),
    /outside its supported range/u,
  );
  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        coherentSnapshot([{ ...first, parentUniqueId: first.uniqueId }]),
      ),
    /non-monotonic parent and child unique IDs/u,
  );
  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        coherentSnapshot([{ ...first, resourceCoalitionId: "0" }]),
      ),
    /resource coalition ID is outside its supported range/u,
  );
  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        coherentSnapshot([{ ...first, jetsamCoalitionId: "invalid" }]),
      ),
    /jetsam coalition ID is not an unsigned decimal integer/u,
  );
  for (const proof of [
    { lowerUniqueId: "0" },
    { lowerUniqueId: "18446744073709551615", upperUniqueId: "1" },
    { upperUniqueId: "2002" },
    { estimatedCount: 28 },
    { capacity: 10 },
    { zeroPidCount: 0 },
    { zeroPidCount: 2 },
    { rowCount: 2 },
  ]) {
    assert.throws(
      () => parseDarwinProcessSnapshot(coherentSnapshot([first], proof)),
      /snapshot proof|row count/u,
    );
  }
  assert.throws(
    () =>
      parseDarwinProcessSnapshot(
        coherentSnapshot([{ ...first, uniqueId: "2000" }]),
      ),
    /outside the fenced epoch/u,
  );
});

test("Darwin exact identity tokens reject incomplete kernel evidence", () => {
  assert.deepEqual(
    parseDarwinExactIdentity(
      "agentqg-darwin-exact-v1:pid1-100-0-10:200:300:200",
    ),
    {
      bootId: "pid1-100-0-10",
      pid: 200,
      uniqueId: "300",
      parentUniqueId: "200",
    },
  );
  assert.throws(
    () =>
      parseDarwinExactIdentity("agentqg-darwin-exact-v1:pid1-100-0-10:200:300"),
    /malformed/u,
  );
  assert.throws(
    () =>
      parseDarwinExactIdentity(
        "agentqg-darwin-exact-v1:pid1-100-0-10:200:0:400",
      ),
    /outside its supported range/u,
  );
  assert.throws(
    () =>
      parseDarwinExactIdentity(
        "agentqg-darwin-exact-v1:pid1-100-0-10:200:300:400",
      ),
    /non-monotonic parent and child unique IDs/u,
  );
});

test("Darwin watcher authority requires an exact same-coalition ancestor", () => {
  const controller = record({
    pid: 100,
    ppid: 1,
    uniqueId: "900",
    parentUniqueId: "10",
  });
  const launcher = record({
    pid: 110,
    ppid: 100,
    uniqueId: "1000",
    parentUniqueId: "900",
  });
  const watcher = record({
    pid: 120,
    ppid: 110,
    uniqueId: "1100",
    parentUniqueId: "1000",
  });
  assert.equal(isExactDarwinChild(watcher, launcher), true);
  assert.equal(
    hasExactDarwinAncestry(
      [controller, launcher, watcher],
      watcher,
      controller,
      501,
    ),
    true,
  );
  assert.equal(
    hasExactDarwinAncestry(
      [controller, { ...launcher, realUid: 0 }, watcher],
      watcher,
      controller,
      501,
    ),
    false,
  );
  assert.equal(
    hasExactDarwinAncestry(
      [controller, { ...launcher, resourceCoalitionId: "701" }, watcher],
      watcher,
      controller,
      501,
    ),
    false,
  );
  assert.equal(
    hasExactDarwinAncestry(
      [controller, launcher, watcher],
      watcher,
      record({
        pid: 200,
        ppid: 1,
        uniqueId: "950",
        parentUniqueId: "10",
      }),
      501,
    ),
    false,
  );
});

test("Darwin gate teardown routes administrative children through exact signals", () => {
  const gateSource = readFileSync(
    new URL("../agent-quality-gate.sh", import.meta.url),
    "utf8",
  );
  assert.match(
    gateSource,
    /teardown_no_lock_settle_known_processes\(\)[\s\S]*?gate_darwin_lineage_host_platform" == Darwin[\s\S]*?portable no-lock process fallback is unsafe/u,
  );
  assert.match(
    gateSource,
    /teardown_active_timeouts\(\)[\s\S]*?gate_darwin_lineage_host_platform" == Darwin[\s\S]*?gate_darwin_exact_identity_terminate/u,
  );
  assert.match(
    gateSource,
    /trunk_provisioning_probe\(\)[\s\S]*?gate_darwin_lineage_host_platform" == Darwin[\s\S]*?gate_darwin_exact_identity_terminate/u,
  );
  assert.match(
    gateSource,
    /Command settled first:[\s\S]*?gate_darwin_lineage_host_platform" == Darwin[\s\S]*?gate_darwin_exact_identity_terminate/u,
  );
  assert.match(
    gateSource,
    /forced_exact_settlement" -eq 1[\s\S]*?lineage_bind_rc" -ne 0[\s\S]*?Keep the durable scheduler barrier[\s\S]*?return 2[\s\S]*?wait "\$cmd_pid"/u,
  );
  assert.match(
    gateSource,
    /source "\$darwin_lineage_path"\nif ! gate_darwin_lineage_classify_host; then[\s\S]*?exit 2/u,
  );
  const workerControlValidationIndex = gateSource.indexOf(
    "AGENT_QUALITY_GATE_TEST_LOCK_TAKEN_BARRIER: test-only override requires NODE_ENV=test",
  );
  const workerAuthorityIndex = gateSource.indexOf(
    "! gate_darwin_exact_identity_prepare;",
    workerControlValidationIndex,
  );
  const parallelPoolIndex = gateSource.indexOf(
    "run_mapped_entries_parallel() {",
  );
  assert.ok(
    workerControlValidationIndex > 0,
    "the gate validates every worker test control",
  );
  assert.ok(
    workerAuthorityIndex > workerControlValidationIndex,
    "the validated worker test control establishes Darwin identity authority",
  );
  assert.ok(
    parallelPoolIndex > workerAuthorityIndex,
    "Darwin test authority precedes every parallel worker fork",
  );
  const prepareIndex = gateSource.indexOf(
    'gate_darwin_lineage_prepare "$command_lineage_token"',
  );
  const leaseIndex = gateSource.indexOf(
    'gate_coordinator_before_command "$command" "$command_drain_identity"',
    prepareIndex,
  );
  const refreshIndex = gateSource.indexOf(
    "gate_darwin_lineage_refresh",
    leaseIndex,
  );
  const wrapperIndex = gateSource.indexOf(
    '"${gate_sanitized_bash_launcher[@]}" -c',
    refreshIndex,
  );
  assert.ok(prepareIndex > 0, "the durable baseline precedes lease admission");
  assert.ok(leaseIndex > prepareIndex, "the lease follows durable state");
  assert.ok(refreshIndex > leaseIndex, "the baseline refresh follows wait");
  assert.ok(wrapperIndex > refreshIndex, "no mapped wrapper precedes refresh");

  const claimStart = gateSource.indexOf("claim_gate_run_lock() {");
  const claimPrepare = gateSource.indexOf(
    'gate_darwin_lineage_prepare "$token"',
    claimStart,
  );
  const ownerLink = gateSource.indexOf(
    'ln "$staged" "$lock/owner"',
    claimPrepare,
  );
  const afterLinkCrash = gateSource.indexOf(
    "gate_lock_test_crash after-link",
    ownerLink,
  );
  assert.ok(claimPrepare > claimStart, "owner state starts during exact claim");
  assert.ok(ownerLink > claimPrepare, "owner state precedes owner publication");
  assert.ok(
    afterLinkCrash > ownerLink,
    "the after-link crash retains published owner state",
  );
  assert.match(
    gateSource,
    /legacy_lock_active" -ne 1 \|\| "\$token" != "\$gate_lock_token"[\s\S]*?gate_darwin_lineage_discard_settled/u,
  );
  assert.match(
    gateSource,
    /if rmdir "\$gate_lock_dir"[\s\S]*?gate_active_command_drain_in_progress" -eq 0[\s\S]*?gate_darwin_lineage_retire_owner "\$gate_lock_token"/u,
  );
});

test("Darwin scheduler fixtures use nonreusable signal authority", () => {
  const lineageSource = readFileSync(
    new URL("./darwin-process-lineage.mjs", import.meta.url),
    "utf8",
  );
  const fixtureProcessSource = readFileSync(
    new URL("./agent-quality-gate-fixture-processes.mjs", import.meta.url),
    "utf8",
  );
  const schedulerFixtureSource = readFileSync(
    new URL("./agent-quality-gate-scheduler-fixture.mjs", import.meta.url),
    "utf8",
  );
  const coordinatorTestSource = readFileSync(
    new URL("./quality-gate-coordinator.test.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    lineageSource,
    /signalDarwinExactIdentity\([\s\S]*?SIGSTOP[\s\S]*?SIGTERM[\s\S]*?SIGKILL/u,
  );
  assert.match(lineageSource, /signalName === "STOP"/u);
  assert.match(fixtureProcessSource, /captureDarwinExactChild/u);
  assert.doesNotMatch(
    fixtureProcessSource,
    /parentPid \?\? \(await parentOf\(pid\)\)/u,
  );
  assert.match(
    fixtureProcessSource,
    /Darwin fixture process requires an explicit parent/u,
  );
  assert.match(
    fixtureProcessSource,
    /!parentIdentity && parentPid !== this\.#rootParentPid/u,
  );
  assert.match(
    fixtureProcessSource,
    /childExact\.parentUniqueId !== parentExact\.uniqueId/u,
  );
  assert.match(
    fixtureProcessSource,
    /trackDescendant\(pid, rootIdentity\)[\s\S]*?lineage\.reverse\(\)[\s\S]*?parentPid: edge\.parentPid/u,
  );
  assert.match(
    fixtureProcessSource,
    /if \(process\.platform === "darwin"\) \{[\s\S]*?signalDarwinExactIdentity\([\s\S]*?return result\.signalled;[\s\S]*?\}\n {2}if \(!\(await identityMatches\(identity\)\)\) return false;[\s\S]*?process\.kill\(identity\.pid, signal\)/u,
  );
  assert.match(
    fixtureProcessSource,
    /stopAll\(\)[\s\S]*?signalExact\(identity, "SIGSTOP"\)/u,
  );
  assert.doesNotMatch(schedulerFixtureSource, /process\.kill\(/u);
  assert.equal(
    [...schedulerFixtureSource.matchAll(/fixtureProcesses\.track\(/gu)].length,
    4,
  );
  assert.match(
    schedulerFixtureSource,
    /fixtureProcesses\.track\(child\.pid, \{[\s\S]*?parentPid: process\.pid/u,
  );
  assert.match(
    schedulerFixtureSource,
    /fixtureProcesses\.track\(commandRoot, \{\n {6}parentPid: handle\.child\.pid/u,
  );
  assert.match(
    schedulerFixtureSource,
    /trackDescendant\(\n {6}stubPid,\n {6}commandRootIdentity/u,
  );
  assert.match(
    schedulerFixtureSource,
    /fixtureProcesses\.track\(descendantPid, \{\n {6}parentPid: stubIdentity\.pid,\n {4}\}\)/u,
  );
  assert.match(
    schedulerFixtureSource,
    /fixtureProcesses\.track\(watchdogs\[0\]\.pid, \{\n {6}parentPid: handle\.child\.pid,[\s\S]*?fixtureProcesses\.signal\(watchdogIdentity, "SIGKILL"\)/u,
  );
  assert.match(
    schedulerFixtureSource,
    /await signalGate\(handle, "SIGKILL"\)/u,
  );

  const termFixtureStart = coordinatorTestSource.indexOf(
    'test("TERM on the bound client marks its request unclean"',
  );
  const termFixtureEnd = coordinatorTestSource.indexOf(
    'test("a private control file marks a bound request unclean"',
    termFixtureStart,
  );
  assert.ok(termFixtureStart > 0 && termFixtureEnd > termFixtureStart);
  const termFixture = coordinatorTestSource.slice(
    termFixtureStart,
    termFixtureEnd,
  );
  assert.match(
    termFixture,
    /process\.platform === "darwin"[\s\S]*?child\.kill\("SIGTERM"\)[\s\S]*?else \{\n {6}process\.kill\(-child\.pid, "SIGTERM"\)/u,
  );
  assert.match(
    termFixture,
    /process\.platform === "darwin"[\s\S]*?child\.kill\("SIGKILL"\)[\s\S]*?else \{\n {8}process\.kill\(-child\.pid, "SIGKILL"\)/u,
  );
});

test("host classification ignores a PATH-shadowed uname", () => {
  const lineageShellSource = readFileSync(
    new URL("./darwin-process-lineage.sh", import.meta.url),
    "utf8",
  );
  assert.match(
    lineageShellSource,
    /detected="\$\(\/usr\/bin\/uname -s 2>\/dev\/null\)" \|\| \{[\s\S]*?return 2[\s\S]*?Darwin\|Linux\)[\s\S]*?unsupported host kernel/u,
  );
  const directory = mkdtempSync(join(tmpdir(), "agentqg-uname-shadow-"));
  const fakeUname = join(directory, "uname");
  writeFileSync(fakeUname, "#!/bin/sh\nprintf 'ShadowOS\\n'\n");
  chmodSync(fakeUname, 0o700);
  try {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        '. "$1"; gate_darwin_lineage_classify_host; printf "%s\\n" "$gate_darwin_lineage_host_platform"',
        "host-classifier-test",
        new URL("./darwin-process-lineage.sh", import.meta.url).pathname,
      ],
      {
        encoding: "utf8",
        env: { PATH: `${directory}:/usr/bin:/bin` },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      process.platform === "darwin" ? "Darwin" : "Linux",
    );

    const invalidCache = spawnSync(
      "/bin/bash",
      [
        "-c",
        '. "$1"; gate_darwin_lineage_host_platform=ShadowOS; gate_darwin_lineage_host_is_darwin',
        "host-classifier-test",
        new URL("./darwin-process-lineage.sh", import.meta.url).pathname,
      ],
      { encoding: "utf8" },
    );
    assert.equal(invalidCache.status, 2);
    assert.match(invalidCache.stderr, /classification is invalid/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Darwin lineage root accepts a concurrent real-directory creator", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentqg-lineage-root-race-"));
  try {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `source "$1"
gate_lock_root_dir="$2"
mkdir() {
  command mkdir "$@"
  return 1
}
gate_darwin_lineage_root`,
        "lineage-root-race-test",
        LINEAGE_SHELL_PATH,
        directory,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const root = result.stdout.trim();
    assert.equal(root, join(directory, `lineage-v1-u${process.getuid()}`));
    const stat = lstatSync(root);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.uid, process.getuid());
    assert.equal(stat.mode & 0o7777, 0o700);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Darwin lineage bind rejects a symlinked module before Node runs", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentqg-lineage-bind-link-"));
  const sourceDirectory = join(directory, "source");
  const gateDirectory = join(sourceDirectory, "gate");
  const target = join(directory, "replacement.mjs");
  const marker = join(directory, "invoked");
  mkdirSync(gateDirectory, { recursive: true });
  writeFileSync(
    target,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "invoked\\n");\n`,
  );
  symlinkSync(target, join(gateDirectory, "darwin-process-lineage.mjs"));
  try {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `source "$1"
script_source_dir="$2"
scratch_dir="$3"
gate_darwin_lineage_active=1
gate_darwin_lineage_state_file="$3/lineage.json"
gate_darwin_node_bin="$4"
gate_darwin_lineage_bind_root 123 456`,
        "lineage-bind-link-test",
        LINEAGE_SHELL_PATH,
        sourceDirectory,
        directory,
        process.execPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /process-lineage helper is unavailable/u);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Darwin native helper cache binds source, binary, and provenance",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-native-cache-"));
    try {
      assert.deepEqual(
        prepareDarwinExactIdentityHelper({
          scratchDirectory: directory,
        }),
        { active: true },
      );
      const cacheNames = readdirSync(directory).filter((name) =>
        name.endsWith(".cache-v3"),
      );
      assert.equal(cacheNames.length, 1);
      const cacheDirectory = join(directory, cacheNames[0]);
      assert.deepEqual(readdirSync(cacheDirectory).sort(), [
        "darwin-process-identity-runtime.inc.c",
        "helper",
        "provenance.json",
        "source.c",
      ]);
      const helper = join(cacheDirectory, "helper");
      const source = join(cacheDirectory, "source.c");
      const runtimeSource = join(
        cacheDirectory,
        "darwin-process-identity-runtime.inc.c",
      );
      const provenance = JSON.parse(
        readFileSync(join(cacheDirectory, "provenance.json"), "utf8"),
      );
      assert.equal(
        provenance.schema,
        darwinNativeHelperTrustForTest.cacheSchema,
      );
      assert.match(provenance.sourceDigest, /^[a-f0-9]{64}$/u);
      assert.match(provenance.helperDigest, /^[a-f0-9]{64}$/u);
      assert.equal(lstatSync(source).nlink, 1);
      assert.equal(lstatSync(runtimeSource).nlink, 1);
      assert.equal(lstatSync(helper).nlink, 1);

      linkSync(helper, join(directory, "helper-hard-link"));
      assert.throws(
        () => prepareDarwinExactIdentityHelper({ scratchDirectory: directory }),
        /safe current-user regular file/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin baseline refresh absorbs unrelated scheduler-wait processes",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-lineage-refresh-"));
    const token = `refresh-fixture-${process.pid}-${Math.floor(Date.now() / 1_000)}`;
    const statePath = join(directory, `lineage.${token}.json`);
    let unrelated;
    let root;
    try {
      const prepared = prepareDarwinLineage({
        statePath,
        scratchDirectory: directory,
        token,
      });
      assert.equal(prepared.active, true);
      unrelated = spawn(
        process.execPath,
        [
          "-e",
          "process.send('ready'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      await once(unrelated, "message");

      const refreshed = refreshDarwinLineageBaseline({
        statePath,
        scratchDirectory: directory,
      });
      assert.equal(refreshed.active, true);

      root = spawn(
        process.execPath,
        [
          "-e",
          "process.stdin.once('data', () => process.exit(0)); process.stdin.resume()",
        ],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      bindDarwinLineageRoot({
        statePath,
        scratchDirectory: directory,
        pid: root.pid,
        parentPid: process.pid,
      });
      const boundState = JSON.parse(readFileSync(statePath, "utf8"));
      assert.match(boundState.root.resourceCoalitionId, /^[1-9]\d*$/u);
      assert.match(boundState.root.jetsamCoalitionId, /^[1-9]\d*$/u);
      assert.equal(
        boundState.root.resourceCoalitionId,
        boundState.launcher.resourceCoalitionId,
      );
      assert.equal(
        boundState.root.jetsamCoalitionId,
        boundState.launcher.jetsamCoalitionId,
      );
      assert.throws(
        () =>
          refreshDarwinLineageBaseline({
            statePath,
            scratchDirectory: directory,
          }),
        /only an unbound Darwin lineage/u,
      );
      root.stdin.end("start\n");
      await once(root, "exit");

      const settled = await settleDarwinLineage({
        statePath,
        scratchDirectory: directory,
        timeoutSeconds: 5,
        retainState: true,
      });
      assert.equal(settled.settled, true);
      assert.equal(unrelated.exitCode, null);
      discardSettledDarwinLineage({ statePath });
    } finally {
      if (root && root.exitCode === null && root.signalCode === null) {
        root.kill("SIGKILL");
        await once(root, "exit");
      }
      if (
        unrelated &&
        unrelated.exitCode === null &&
        unrelated.signalCode === null
      ) {
        unrelated.kill("SIGTERM");
        await once(unrelated, "exit");
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin successor settlement establishes its worktree runtime receipt",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-successor-receipt-"));
    const leaderScratch = join(directory, "leader");
    const successorScratch = join(directory, "successor");
    mkdirSync(leaderScratch, { mode: 0o700 });
    mkdirSync(successorScratch, { mode: 0o700 });
    const token = `successor-receipt-${process.pid}-${Math.floor(Date.now() / 1_000)}`;
    const statePath = join(directory, `lineage.${token}.json`);
    let root;
    try {
      const prepared = prepareDarwinLineage({
        statePath,
        scratchDirectory: leaderScratch,
        token,
      });
      assert.equal(prepared.active, true);
      root = spawn(
        process.execPath,
        [
          "-e",
          "process.stdin.once('data', () => process.exit(0)); process.stdin.resume()",
        ],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      bindDarwinLineageRoot({
        statePath,
        scratchDirectory: leaderScratch,
        pid: root.pid,
        parentPid: process.pid,
      });
      root.stdin.end("stop\n");
      await once(root, "exit");

      assert.deepEqual(readdirSync(successorScratch), []);

      const settled = await settleDarwinLineage({
        statePath,
        scratchDirectory: successorScratch,
        timeoutSeconds: 10,
        retainState: true,
      });
      assert.deepEqual(settled, {
        active: true,
        retained: true,
        reason: "empty-coherent-exact-set",
        settled: true,
      });
      const successorHelper = nativeHelper(successorScratch);
      const successorReceipt = nativeHelperRuntimeReceiptPath(
        successorScratch,
        successorHelper,
      );
      assert.equal(existsSync(successorReceipt), true);
      assert.equal(lstatSync(successorReceipt).mode & 0o7777, 0o400);
      const retained = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(
        retained.settlementProof?.kind,
        "xnu-coherent-process-snapshot-v1",
      );
      assert.ok(Number.isSafeInteger(retained.settlementProof.capturedAt));
      discardSettledDarwinLineage({ statePath });
    } finally {
      if (root && root.exitCode === null && root.signalCode === null) {
        root.kill("SIGKILL");
        await once(root, "exit");
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin cohort settlement uses each sibling's exact ownership authority",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-lineage-cohort-"));
    const timestamp = Math.floor(Date.now() / 1_000);
    const tokens = [
      `cohort-owned-a-${process.pid}-${timestamp}`,
      `cohort-owned-b-${process.pid}-${timestamp}`,
    ];
    const statePaths = tokens.map((token) =>
      join(directory, `lineage.${token}.json`),
    );
    const roots = [];
    const exactIdentities = [];
    try {
      for (let index = 0; index < tokens.length; index += 1) {
        prepareDarwinLineage({
          statePath: statePaths[index],
          scratchDirectory: directory,
          token: tokens[index],
        });
      }
      for (let index = 0; index < tokens.length; index += 1) {
        const root = spawn(
          process.execPath,
          [
            "-e",
            "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)",
          ],
          { stdio: ["ignore", "ignore", "ignore", "ipc"] },
        );
        roots.push(root);
        await once(root, "message");
        bindDarwinLineageRoot({
          statePath: statePaths[index],
          scratchDirectory: directory,
          pid: root.pid,
          parentPid: process.pid,
        });
        exactIdentities.push(
          captureDarwinExactChild({
            scratchDirectory: directory,
            pid: root.pid,
            parentPid: process.pid,
          }).identity,
        );
      }

      const exact = exactIdentities.map(parseDarwinExactIdentity);
      for (let index = 0; index < statePaths.length; index += 1) {
        const sibling = exact[(index + 1) % exact.length];
        const current = JSON.parse(readFileSync(statePaths[index], "utf8"));
        darwinLineageTransitionForTest.replaceState(
          statePaths[index],
          current,
          {
            ...current,
            tombstones: [
              {
                pid: sibling.pid,
                uniqueId: sibling.uniqueId,
                parentUniqueId: sibling.parentUniqueId,
                classification: "ambiguous",
                firstSeenAt: Date.now(),
                termSentAt: null,
                killSentAt: null,
              },
            ],
          },
        );
      }

      const settled = await settleDarwinLineageCohort({
        statePaths,
        scratchDirectory: directory,
        timeoutSeconds: 12,
        retainState: true,
      });
      assert.equal(settled.active, true);
      assert.equal(settled.settled, true);
      assert.equal(settled.retained, true);
      assert.deepEqual(
        settled.settlements.map(({ token }) => token),
        tokens,
      );

      for (let index = 0; index < statePaths.length; index += 1) {
        const retained = JSON.parse(readFileSync(statePaths[index], "utf8"));
        const own = retained.tombstones.find(
          ({ uniqueId }) => uniqueId === exact[index].uniqueId,
        );
        const sibling = retained.tombstones.find(
          ({ uniqueId }) =>
            uniqueId === exact[(index + 1) % exact.length].uniqueId,
        );
        assert.equal(retained.settledReason, "empty-coherent-exact-set");
        assert.equal(own.classification, "owned");
        assert.ok(Number.isSafeInteger(own.termSentAt));
        assert.ok(Number.isSafeInteger(own.killSentAt));
        assert.ok(own.killSentAt >= own.termSentAt + 4_000);
        assert.equal(sibling.classification, "ambiguous");
        assert.equal(sibling.termSentAt, null);
        assert.equal(sibling.killSentAt, null);
        discardSettledDarwinLineage({ statePath: statePaths[index] });
      }
      for (const root of roots) await waitForChildExit(root);
    } finally {
      for (const exactIdentity of exactIdentities) {
        await stopExactProcess(directory, exactIdentity);
      }
      for (const root of roots) {
        if (root.exitCode === null && root.signalCode === null) {
          root.kill("SIGKILL");
          await waitForChildExit(root);
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin cohort settlement never signals an ambiguous-only identity",
  { skip: process.platform !== "darwin", timeout: 20_000 },
  async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "agentqg-lineage-cohort-ambiguous-"),
    );
    const timestamp = Math.floor(Date.now() / 1_000);
    const token = `cohort-ambiguous-${process.pid}-${timestamp}`;
    const statePath = join(directory, `lineage.${token}.json`);
    const termMarker = join(directory, "ambiguous.term");
    let root;
    let ambiguous;
    let rootIdentity = null;
    let ambiguousIdentity = null;
    try {
      prepareDarwinLineage({
        statePath,
        scratchDirectory: directory,
        token,
      });
      root = spawn(
        process.execPath,
        [
          "-e",
          "process.on('message', (value) => { if (value === 'exit') process.exit(0); }); process.send('ready'); setInterval(() => {}, 1000)",
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      ambiguous = spawn(
        process.execPath,
        [
          "-e",
          `const fs = require("node:fs"); process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termMarker)}, ${JSON.stringify("term\n")})); process.send("ready"); setInterval(() => {}, 1000)`,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      await Promise.all([once(root, "message"), once(ambiguous, "message")]);
      bindDarwinLineageRoot({
        statePath,
        scratchDirectory: directory,
        pid: root.pid,
        parentPid: process.pid,
      });
      rootIdentity = captureDarwinExactChild({
        scratchDirectory: directory,
        pid: root.pid,
        parentPid: process.pid,
      }).identity;
      ambiguousIdentity = captureDarwinExactChild({
        scratchDirectory: directory,
        pid: ambiguous.pid,
        parentPid: process.pid,
      }).identity;
      const ambiguousExact = parseDarwinExactIdentity(ambiguousIdentity);
      const current = JSON.parse(readFileSync(statePath, "utf8"));
      darwinLineageTransitionForTest.replaceState(statePath, current, {
        ...current,
        tombstones: [
          {
            pid: ambiguousExact.pid,
            uniqueId: ambiguousExact.uniqueId,
            parentUniqueId: ambiguousExact.parentUniqueId,
            classification: "ambiguous",
            firstSeenAt: Date.now(),
            termSentAt: null,
            killSentAt: null,
          },
        ],
      });
      root.send("exit");
      await waitForChildExit(root);

      await assert.rejects(
        settleDarwinLineageCohort({
          statePaths: [statePath],
          scratchDirectory: directory,
          timeoutSeconds: 1,
          retainState: true,
        }),
        // The last quiet delay can consume the deadline before another native
        // snapshot starts. Both errors are fail-closed. The state and process
        // assertions below prove that the ambiguous identity was not signalled.
        /(?:exact process identities remain: .*:ambiguous|no coherent snapshot was available before its deadline)/u,
      );
      assert.deepEqual(
        statusDarwinExactIdentity({
          scratchDirectory: directory,
          exactIdentity: ambiguousIdentity,
        }),
        { status: "live" },
      );
      assert.equal(existsSync(termMarker), false);
      const retained = JSON.parse(readFileSync(statePath, "utf8"));
      assert.ok(retained.revision >= current.revision + 2);
      const ambiguousTombstone = retained.tombstones.find(
        ({ uniqueId }) => uniqueId === ambiguousExact.uniqueId,
      );
      assert.equal(ambiguousTombstone.classification, "ambiguous");
      assert.equal(ambiguousTombstone.termSentAt, null);
      assert.equal(ambiguousTombstone.killSentAt, null);
      assert.equal(retained.settledAt, null);
      assert.equal(retained.settledReason, null);
    } finally {
      await stopExactProcess(directory, ambiguousIdentity);
      await stopExactProcess(directory, rootIdentity);
      for (const child of [root, ambiguous]) {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await waitForChildExit(child);
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin exact parent capture returns only the caller's direct parent",
  { skip: process.platform !== "darwin", timeout: 20_000 },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-exact-parent-"));
    try {
      assert.throws(
        () =>
          captureDarwinExactParent({
            scratchDirectory: directory,
            pid: process.ppid,
          }),
        /runtime capability receipt is missing/u,
      );
      prepareDarwinExactIdentityHelper({ scratchDirectory: directory });
      const captured = captureDarwinExactParent({
        scratchDirectory: directory,
        pid: process.ppid,
      });
      assert.equal(captured.active, true);
      assert.equal(
        parseDarwinExactIdentity(captured.identity).pid,
        process.ppid,
      );
      assert.throws(
        () =>
          captureDarwinExactParent({
            scratchDirectory: directory,
            pid: process.pid,
          }),
        /not this process's direct parent/u,
      );
      captureCurrentExactIdentity(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin exact child signalling stops only the captured kernel identity",
  { skip: process.platform !== "darwin", timeout: 20_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-exact-child-"));
    prepareDarwinExactIdentityHelper({ scratchDirectory: directory });
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)",
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    try {
      await once(child, "message");
      const captured = captureDarwinExactChild({
        scratchDirectory: directory,
        pid: child.pid,
        parentPid: process.pid,
      });
      assert.equal(captured.active, true);
      const exactIdentity = captured.identity;
      assert.equal(parseDarwinExactIdentity(exactIdentity).pid, child.pid);

      const term = signalDarwinExactIdentity({
        scratchDirectory: directory,
        exactIdentity,
        signal: 15,
      });
      assert.equal(term.signalled, true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(child.exitCode, null);

      const kill = signalDarwinExactIdentity({
        scratchDirectory: directory,
        exactIdentity,
        signal: 9,
      });
      assert.equal(kill.signalled, true);
      await once(child, "exit");

      const status = statusDarwinExactIdentity({
        scratchDirectory: directory,
        exactIdentity,
      });
      assert.deepEqual(status, { status: "gone" });

      const stale = signalDarwinExactIdentity({
        scratchDirectory: directory,
        exactIdentity,
        signal: 9,
      });
      assert.deepEqual(stale, { gone: true, signalled: false });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin settlement watcher accepts only a private pre-arm cancel action",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-watch-cancel-"));
    let fixture;
    let watcher;
    try {
      fixture = await createWatcherFixture(directory, "watch-cancel");
      const { armedFile, cancelFile } = createWatcherControl(
        directory,
        "watch-cancel",
      );
      linkSync(`${cancelFile}.cancel.staged`, cancelFile);
      watcher = spawnSettlementWatcher({
        armedFile,
        cancelFile,
        controllerIdentity: fixture.controllerIdentity,
        directory,
        statePath: fixture.statePath,
        timeoutSeconds: 5,
      });
      const result = await watcher.result();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, "cancelled\n");
      assert.equal(existsSync(fixture.statePath), true);
      assert.equal(fixture.root.exitCode, null);

      fixture.root.stdin.end("stop\n");
      await waitForChildExit(fixture.root);
      const settled = await settleDarwinLineage({
        statePath: fixture.statePath,
        scratchDirectory: directory,
        timeoutSeconds: 5,
        retainState: false,
      });
      assert.deepEqual(settled, {
        active: true,
        retained: false,
        reason: "empty-coherent-exact-set",
        settled: true,
      });
    } finally {
      if (
        watcher?.child.exitCode === null &&
        watcher.child.signalCode === null
      ) {
        watcher.child.kill("SIGKILL");
        await waitForChildExit(watcher.child);
      }
      if (fixture?.root.exitCode === null && fixture.root.signalCode === null) {
        fixture.root.kill("SIGKILL");
        await waitForChildExit(fixture.root);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin settlement watcher converts a post-arm cancel action into settlement",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-watch-phase-"));
    let fixture;
    let watcher;
    try {
      fixture = await createWatcherFixture(directory, "watch-phase");
      const { armedFile, cancelFile } = createWatcherControl(
        directory,
        "watch-phase",
      );
      watcher = spawnSettlementWatcher({
        armedFile,
        cancelFile,
        controllerIdentity: fixture.controllerIdentity,
        directory,
        statePath: fixture.statePath,
        timeoutSeconds: 5,
      });
      await waitFor(
        () =>
          existsSync(armedFile) &&
          readFileSync(armedFile, "utf8") === "armed\n",
        "the phase watcher to arm",
      );
      linkSync(`${cancelFile}.cancel.staged`, cancelFile);
      const result = await watcher.result();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "settled\n");
      await waitForChildExit(fixture.root);
      discardSettledDarwinLineage({ statePath: fixture.statePath });
    } finally {
      if (
        watcher?.child.exitCode === null &&
        watcher.child.signalCode === null
      ) {
        watcher.child.kill("SIGKILL");
        await waitForChildExit(watcher.child);
      }
      if (fixture?.root.exitCode === null && fixture.root.signalCode === null) {
        fixture.root.kill("SIGKILL");
        await waitForChildExit(fixture.root);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin settlement watcher preserves owned descendants across a broken live parent chain",
  { skip: process.platform !== "darwin", timeout: 45_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-watch-census-"));
    const rootCode = String.raw`
      const { spawn } = require("node:child_process");
      process.on("SIGTERM", () => process.exit(0));
      process.stdin.once("data", () => process.exit(0));
      process.stdin.resume();
      process.on("message", (message) => {
        if (message !== "spawn") return;
        const bridge = spawn(process.execPath, [
          "-e",
          "const { spawn } = require('node:child_process'); const leaf = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); process.send({ leafPid: leaf.pid }); setInterval(() => {}, 1000)",
        ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
        bridge.once("message", ({ leafPid }) => {
          process.send({ bridgePid: bridge.pid, leafPid });
        });
      });
      process.send("ready");
    `;
    let fixture;
    let watcher;
    let bridgeIdentity;
    let leafIdentity;
    try {
      fixture = await createWatcherFixture(directory, "watch-census", {
        rootCode,
      });
      const { armedFile, cancelFile } = createWatcherControl(
        directory,
        "watch-census",
      );
      watcher = spawnSettlementWatcher({
        armedFile,
        cancelFile,
        controllerIdentity: fixture.controllerIdentity,
        directory,
        statePath: fixture.statePath,
        timeoutSeconds: 20,
      });
      await waitFor(
        () =>
          existsSync(armedFile) &&
          readFileSync(armedFile, "utf8") === "armed\n",
        "the census watcher to arm",
      );

      const descendantMessage = once(fixture.root, "message");
      fixture.root.send("spawn");
      const [{ bridgePid, leafPid }] = await descendantMessage;
      bridgeIdentity = captureDarwinExactChild({
        scratchDirectory: directory,
        pid: bridgePid,
        parentPid: fixture.root.pid,
      }).identity;
      leafIdentity = captureDarwinExactChild({
        scratchDirectory: directory,
        pid: leafPid,
        parentPid: bridgePid,
      }).identity;
      const bridgeUniqueId = parseDarwinExactIdentity(bridgeIdentity).uniqueId;
      const leafUniqueId = parseDarwinExactIdentity(leafIdentity).uniqueId;
      await waitFor(() => {
        try {
          const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
          return [bridgeUniqueId, leafUniqueId].every((uniqueId) =>
            state.tombstones.some(
              (item) =>
                item.uniqueId === uniqueId && item.classification === "owned",
            ),
          );
        } catch {
          return false;
        }
      }, "the watcher to persist the coherent descendant chain");

      signalDarwinExactIdentity({
        scratchDirectory: directory,
        exactIdentity: bridgeIdentity,
        signal: 9,
      });
      await waitFor(
        () =>
          statusDarwinExactIdentity({
            scratchDirectory: directory,
            exactIdentity: bridgeIdentity,
          }).status !== "live",
        "the transient bridge to exit",
      );
      fixture.root.stdin.end("stop\n");
      await waitForChildExit(fixture.root);

      linkSync(`${cancelFile}.settle.staged`, cancelFile);
      const watcherResult = await watcher.result();
      assert.equal(watcherResult.status, 0, watcherResult.stderr);
      assert.equal(watcherResult.stdout, "settled\n");
      assert.equal(existsSync(fixture.statePath), true);
      assert.equal(
        statusDarwinExactIdentity({
          scratchDirectory: directory,
          exactIdentity: leafIdentity,
        }).status,
        "gone",
      );
      discardSettledDarwinLineage({ statePath: fixture.statePath });
      assert.equal(existsSync(fixture.statePath), false);
    } finally {
      if (
        watcher?.child.exitCode === null &&
        watcher.child.signalCode === null
      ) {
        watcher.child.kill("SIGKILL");
        await waitForChildExit(watcher.child);
      }
      await stopExactProcess(directory, leafIdentity);
      await stopExactProcess(directory, bridgeIdentity);
      if (fixture?.root.exitCode === null && fixture.root.signalCode === null) {
        fixture.root.kill("SIGKILL");
        await waitForChildExit(fixture.root);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin settlement watcher settles on invalid control or its deadline",
  { skip: process.platform !== "darwin", timeout: 40_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-watch-failsafe-"));
    const resources = [];
    try {
      for (const testCase of [
        { name: "watch-invalid", marker: "invalid\n", timeoutSeconds: 5 },
        { name: "watch-timeout", marker: "", timeoutSeconds: 1 },
      ]) {
        const fixture = await createWatcherFixture(directory, testCase.name);
        const { armedFile, cancelFile } = createWatcherControl(
          directory,
          testCase.name,
          testCase.marker,
        );
        const watcher = spawnSettlementWatcher({
          armedFile,
          cancelFile,
          controllerIdentity: fixture.controllerIdentity,
          directory,
          statePath: fixture.statePath,
          timeoutSeconds: testCase.timeoutSeconds,
        });
        resources.push({ fixture, watcher });
        const result = await watcher.result();
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.signal, null);
        assert.equal(result.stdout, "settled\n");
        assert.equal(existsSync(fixture.statePath), true);
        await waitForChildExit(fixture.root);
        discardSettledDarwinLineage({ statePath: fixture.statePath });
        assert.equal(existsSync(fixture.statePath), false);
      }
    } finally {
      for (const { fixture, watcher } of resources) {
        if (
          watcher.child.exitCode === null &&
          watcher.child.signalCode === null
        ) {
          watcher.child.kill("SIGKILL");
          await waitForChildExit(watcher.child);
        }
        if (
          fixture.root.exitCode === null &&
          fixture.root.signalCode === null
        ) {
          fixture.root.kill("SIGKILL");
          await waitForChildExit(fixture.root);
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin settlement watcher reacts when its controller dies but launcher remains",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-watch-controller-"));
    let fixture;
    try {
      fixture = await launchNestedWatcherFixture({
        controllerMode: "nested",
        directory,
        name: "controller-death",
      });
      await assertWatcherArmed(directory, fixture);
      fixture.controller.kill("SIGKILL");
      await waitForChildExit(fixture.controller);
      await waitForWatcherSettlement(fixture, "controller-death settlement");
      assert.equal(
        statusDarwinExactIdentity({
          scratchDirectory: directory,
          exactIdentity: fixture.launcherIdentity,
        }).status,
        "live",
      );
    } finally {
      await cleanupNestedWatcherFixture(directory, fixture);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin settlement watcher owns handoff when its controller dies after settle publication",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-watch-handoff-"));
    let fixture;
    try {
      fixture = await launchNestedWatcherFixture({
        controllerMode: "nested",
        directory,
        name: "settle-handoff-death",
      });
      await assertWatcherArmed(directory, fixture);
      linkSync(`${fixture.cancelFile}.settle.staged`, fixture.cancelFile);
      const controllerSignal = signalDarwinExactIdentity({
        scratchDirectory: directory,
        exactIdentity: fixture.controllerIdentity,
        signal: 9,
      });
      assert.equal(controllerSignal.signalled, true);
      await waitForChildExit(fixture.controller);
      await waitForWatcherSettlement(
        fixture,
        "settle-handoff controller-death settlement",
      );
      assert.equal(
        statusDarwinExactIdentity({
          scratchDirectory: directory,
          exactIdentity: fixture.launcherIdentity,
        }).status,
        "live",
      );
    } finally {
      await cleanupNestedWatcherFixture(directory, fixture);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin settlement watcher reacts when its launcher dies but controller remains",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-watch-launcher-"));
    let fixture;
    try {
      fixture = await launchNestedWatcherFixture({
        controllerMode: "direct",
        directory,
        name: "launcher-death",
      });
      await assertWatcherArmed(directory, fixture);
      fixture.launcher.kill("SIGKILL");
      await waitForChildExit(fixture.launcher);
      await waitForWatcherSettlement(fixture, "launcher-death settlement");
      assert.equal(
        statusDarwinExactIdentity({
          scratchDirectory: directory,
          exactIdentity: fixture.controllerIdentity,
        }).status,
        "live",
      );
    } finally {
      await cleanupNestedWatcherFixture(directory, fixture);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Darwin settlement watcher rejects an unrelated exact controller",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-watch-unrelated-"));
    let fixture;
    prepareDarwinExactIdentityHelper({ scratchDirectory: directory });
    const unrelated = spawn(
      process.execPath,
      [
        "-e",
        "process.send('ready'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    try {
      await once(unrelated, "message");
      const unrelatedIdentity = captureDarwinExactChild({
        scratchDirectory: directory,
        pid: unrelated.pid,
        parentPid: process.pid,
      }).identity;
      fixture = await launchNestedWatcherFixture({
        controllerMode: "direct",
        controllerIdentityOverride: unrelatedIdentity,
        directory,
        name: "unrelated-controller",
      });
      await waitForWatcherSettlement(
        fixture,
        "unrelated-controller settlement",
      );
      assert.equal(
        statusDarwinExactIdentity({
          scratchDirectory: directory,
          exactIdentity: fixture.launcherIdentity,
        }).status,
        "live",
      );
      assert.equal(unrelated.exitCode, null);
    } finally {
      await cleanupNestedWatcherFixture(directory, fixture);
      if (unrelated.exitCode === null && unrelated.signalCode === null) {
        unrelated.kill("SIGTERM");
        await waitForChildExit(unrelated);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("lineage classification owns the full exact chain to the mapped root", () => {
  const records = [
    record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
    record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
    record({ pid: 200, ppid: 100, uniqueId: "1000", parentUniqueId: "900" }),
    record({
      pid: 201,
      ppid: 200,
      uniqueId: "1001",
      parentUniqueId: "1000",
      resourceCoalitionId: "701",
    }),
    record({ pid: 300, ppid: 1, uniqueId: "1100", parentUniqueId: "10" }),
    record({ pid: 400, ppid: 999, uniqueId: "1200", parentUniqueId: "1199" }),
  ];

  const candidates = classifyDarwinLineageCandidates(state(), records, {
    controlPid: 100,
    now: 2,
  });

  assert.deepEqual(
    candidates.map(({ uniqueId, classification }) => ({
      uniqueId,
      classification,
    })),
    [
      { uniqueId: "1000", classification: "owned" },
      { uniqueId: "1001", classification: "owned" },
      { uniqueId: "1200", classification: "ambiguous" },
    ],
  );
});

test("guardian tombstone hands a surviving Trunk daemon to exact settlement", () => {
  const candidates = classifyDarwinLineageCandidates(
    state({
      tombstones: [
        tombstone({
          pid: 201,
          uniqueId: "1001",
          parentUniqueId: "1000",
          classification: "owned",
        }),
      ],
    }),
    [
      record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
      record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
      record({ pid: 200, ppid: 100, uniqueId: "1000", parentUniqueId: "900" }),
      record({ pid: 202, ppid: 1, uniqueId: "1002", parentUniqueId: "1001" }),
    ],
    { controlPid: 100, now: 2 },
  );

  const daemon = candidates.find(({ uniqueId }) => uniqueId === "1002");
  assert.deepEqual(
    {
      pid: daemon?.pid,
      uniqueId: daemon?.uniqueId,
      parentUniqueId: daemon?.parentUniqueId,
      classification: daemon?.classification,
    },
    {
      pid: 202,
      uniqueId: "1002",
      parentUniqueId: "1001",
      classification: "owned",
    },
  );
});

test("lineage classification keeps the mapped root signal history", () => {
  const rootTombstone = {
    pid: 200,
    uniqueId: "1000",
    parentUniqueId: "900",
    classification: "owned",
    firstSeenAt: 2,
    termSentAt: 3,
    killSentAt: 7,
  };
  const candidates = classifyDarwinLineageCandidates(
    state({ tombstones: [rootTombstone] }),
    [
      record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
      record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
      record({
        pid: 200,
        ppid: 100,
        uniqueId: "1000",
        parentUniqueId: "900",
      }),
    ],
    { controlPid: 100, now: 9 },
  );

  assert.deepEqual(candidates, [rootTombstone]);
});

test("lineage classification excludes exact zombies from candidates", () => {
  const candidates = classifyDarwinLineageCandidates(
    state(),
    [
      record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
      record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
      record({
        pid: 200,
        ppid: 100,
        uniqueId: "1000",
        parentUniqueId: "900",
        status: 5,
      }),
      record({
        pid: 201,
        ppid: 200,
        uniqueId: "1001",
        parentUniqueId: "1000",
        status: 5,
      }),
    ],
    { controlPid: 100, now: 2 },
  );

  assert.deepEqual(candidates, []);
});

test("watched census keeps candidates without recording fresh unrelated churn", () => {
  const priorUnrelated = tombstone({
    pid: 90,
    uniqueId: "900",
    parentUniqueId: "10",
    classification: "unrelated",
  });
  const owned = tombstone({
    pid: 100,
    uniqueId: "1000",
    parentUniqueId: "900",
    classification: "owned",
  });
  const ambiguous = tombstone({
    pid: 101,
    uniqueId: "1001",
    parentUniqueId: "999",
    classification: "ambiguous",
  });
  const freshUnrelated = tombstone({
    pid: 102,
    uniqueId: "1002",
    parentUniqueId: "10",
    classification: "unrelated",
  });

  assert.deepEqual(
    mergeWatchedDarwinLineageTombstones(
      [priorUnrelated],
      [freshUnrelated, ambiguous, owned],
    ).map(({ uniqueId, classification }) => ({
      uniqueId,
      classification,
    })),
    [
      { uniqueId: "900", classification: "unrelated" },
      { uniqueId: "1000", classification: "owned" },
      { uniqueId: "1001", classification: "ambiguous" },
    ],
  );
});

test("a different coalition excludes an otherwise incomplete new process", () => {
  const candidates = classifyDarwinLineageCandidates(
    state({
      baseline: ["10", "900"],
      root: { pid: 200, uniqueId: "1000", parentUniqueId: "900" },
      launcher: { pid: 100, uniqueId: "900", parentUniqueId: "10" },
    }),
    [
      record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
      record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
      record({
        pid: 300,
        ppid: 299,
        uniqueId: "1200",
        parentUniqueId: "899",
        resourceCoalitionId: "701",
      }),
    ],
    { controlPid: 100, now: 2 },
  );

  assert.deepEqual(candidates, []);
});

test("a same-coalition incomplete chain stays ambiguous", () => {
  const candidates = classifyDarwinLineageCandidates(
    state({
      baseline: ["10", "900"],
      root: { pid: 200, uniqueId: "1000", parentUniqueId: "900" },
      launcher: { pid: 100, uniqueId: "900", parentUniqueId: "10" },
    }),
    [
      record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
      record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
      {
        ...record({
          pid: 300,
          ppid: 299,
          uniqueId: "1200",
          parentUniqueId: "899",
        }),
        name: "external-service",
        path: "/usr/local/bin/external-service",
      },
    ],
    { controlPid: 100, now: 2 },
  );

  assert.deepEqual(
    candidates.map(({ uniqueId, classification }) => ({
      uniqueId,
      classification,
    })),
    [{ uniqueId: "1200", classification: "ambiguous" }],
  );
});

test("a reparent-exec edge into the baseline stays ambiguous", () => {
  const candidates = classifyDarwinLineageCandidates(
    state({ baseline: ["10", "900"] }),
    [
      record({
        pid: 1,
        ppid: 0,
        uniqueId: "10",
        parentUniqueId: "0",
        resourceCoalitionId: "1",
        jetsamCoalitionId: "2",
      }),
      record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
      record({ pid: 300, ppid: 1, uniqueId: "1200", parentUniqueId: "10" }),
    ],
    { controlPid: 100, now: 2 },
  );

  assert.deepEqual(
    candidates.map(({ uniqueId, classification }) => ({
      uniqueId,
      classification,
    })),
    [{ uniqueId: "1200", classification: "ambiguous" }],
  );
});

test("a parallel launcher stays owned when its identity was in the baseline", () => {
  const candidates = classifyDarwinLineageCandidates(
    state({ baseline: ["10", "900", "901"] }),
    [
      record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
      record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
      record({ pid: 101, ppid: 1, uniqueId: "901", parentUniqueId: "10" }),
    ],
    { controlPid: 101, now: 2 },
  );

  assert.deepEqual(
    candidates.map(({ uniqueId, classification }) => ({
      uniqueId,
      classification,
    })),
    [{ uniqueId: "900", classification: "owned" }],
  );
});

test("the active settlement control lineage never owns its exact launcher", () => {
  const candidates = classifyDarwinLineageCandidates(
    state({ baseline: ["10", "900"] }),
    [
      record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
      record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
    ],
    { controlPid: 100, now: 2 },
  );

  assert.deepEqual(candidates, []);
});

test("lineage classification fails closed without the settlement controller", () => {
  assert.throws(
    () =>
      classifyDarwinLineageCandidates(
        state({ baseline: ["10", "900"] }),
        [
          record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
          record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
        ],
        { controlPid: 101, now: 2 },
      ),
    /does not contain the settlement controller/u,
  );
});

test("lineage classification rejects non-monotonic kernel evidence", () => {
  assert.throws(
    () =>
      classifyDarwinLineageCandidates(
        state({ baseline: ["10", "900"] }),
        [
          record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
          record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
          record({
            pid: 300,
            ppid: 299,
            uniqueId: "1100",
            parentUniqueId: "1200",
          }),
        ],
        { controlPid: 100, now: 2 },
      ),
    /non-monotonic parent and child unique IDs/u,
  );
  assert.throws(
    () =>
      classifyDarwinLineageCandidates(
        state({
          root: { pid: 200, uniqueId: "800", parentUniqueId: "900" },
        }),
        [
          record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
          record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
        ],
        { controlPid: 100, now: 2 },
      ),
    /root and launcher have inconsistent unique IDs/u,
  );
});

test("lineage state and census reject malformed coalition IDs", () => {
  const controllerRecords = [
    record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
    record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
  ];
  assert.throws(
    () =>
      classifyDarwinLineageCandidates(
        state({ root: { resourceCoalitionId: "0" } }),
        controllerRecords,
        { controlPid: 100, now: 2 },
      ),
    /root resource coalition ID is outside its supported range/u,
  );
  assert.throws(
    () =>
      classifyDarwinLineageCandidates(
        state({ launcher: { jetsamCoalitionId: "invalid" } }),
        controllerRecords,
        { controlPid: 100, now: 2 },
      ),
    /launcher jetsam coalition ID is not an unsigned decimal integer/u,
  );
  assert.throws(
    () =>
      classifyDarwinLineageCandidates(
        state({ launcher: { resourceCoalitionId: "701" } }),
        controllerRecords,
        { controlPid: 100, now: 2 },
      ),
    /root and launcher have inconsistent coalition IDs/u,
  );
  assert.throws(
    () =>
      classifyDarwinLineageCandidates(
        state(),
        [
          ...controllerRecords,
          record({
            pid: 300,
            ppid: 299,
            uniqueId: "1200",
            parentUniqueId: "1100",
            jetsamCoalitionId: "0",
          }),
        ],
        { controlPid: 100, now: 2 },
      ),
    /snapshot record jetsam coalition ID is outside its supported range/u,
  );
});

test("persisted tombstones keep broken unrelated edges ambiguous", () => {
  const candidates = classifyDarwinLineageCandidates(
    state({
      root: null,
      launcher: null,
      tombstones: [
        tombstone({
          pid: 200,
          uniqueId: "1000",
          parentUniqueId: "900",
          classification: "owned",
        }),
        tombstone({
          pid: 400,
          uniqueId: "1200",
          parentUniqueId: "1100",
          classification: "ambiguous",
        }),
        tombstone({
          pid: 500,
          uniqueId: "1300",
          parentUniqueId: "10",
          classification: "unrelated",
        }),
      ],
    }),
    [
      record({ pid: 1, ppid: 0, uniqueId: "10", parentUniqueId: "0" }),
      record({ pid: 100, ppid: 1, uniqueId: "900", parentUniqueId: "10" }),
      record({ pid: 201, ppid: 1, uniqueId: "1001", parentUniqueId: "1000" }),
      record({ pid: 401, ppid: 1, uniqueId: "1201", parentUniqueId: "1200" }),
      record({ pid: 501, ppid: 1, uniqueId: "1301", parentUniqueId: "1300" }),
    ],
    { controlPid: 100, now: 2 },
  );

  assert.deepEqual(
    candidates.map(({ uniqueId, classification }) => ({
      uniqueId,
      classification,
    })),
    [
      { uniqueId: "1001", classification: "owned" },
      { uniqueId: "1201", classification: "ambiguous" },
      { uniqueId: "1301", classification: "ambiguous" },
    ],
  );
});

test(
  "Darwin settlement contains a setsid child that clears env and closes markers",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentqg-lineage-e2e-"));
    const token = `escape-fixture-${process.pid}-${Math.floor(Date.now() / 1_000)}`;
    const statePath = join(directory, `lineage.${token}.json`);
    const childPidPath = join(directory, "detached-child.pid");
    const childReadyPath = join(directory, "detached-child.ready");
    const markerPaths = [
      join(directory, "request.marker"),
      join(directory, "run.marker"),
    ];
    const detachedCode = `
      const assert = require("node:assert/strict");
      const { fstatSync, statSync, writeFileSync } = require("node:fs");
      assert.deepEqual(
        Object.keys(process.env).filter((name) => name.startsWith("AGENTQG_")),
        [],
      );
      for (const [fd, markerPath] of ${JSON.stringify([
        [8, markerPaths[0]],
        [9, markerPaths[1]],
      ])}) {
        const marker = statSync(markerPath, { bigint: true });
        try {
          const current = fstatSync(fd, { bigint: true });
          assert.notDeepEqual(
            [current.dev, current.ino],
            [marker.dev, marker.ino],
            "marker descriptor " + fd + " survived detached exec",
          );
        } catch (error) {
          if (error?.code !== "EBADF") throw error;
        }
      }
      process.on("SIGTERM", () => {});
      writeFileSync(${JSON.stringify(childReadyPath)}, "ready");
      setInterval(() => {}, 1000);
    `;
    const rootCode = `
      const assert = require("node:assert/strict");
      const { spawn } = require("node:child_process");
      const { fstatSync, writeFileSync } = require("node:fs");
      assert.equal(process.env.AGENTQG_MARKER_FDS, "8,9");
      for (const fd of [8, 9]) assert.equal(fstatSync(fd).isFile(), true);
      process.stdin.resume();
      process.stdin.once("data", (start) => {
        assert.equal(String(start).trim(), "start");
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(detachedCode)}], {
          detached: true,
          env: {},
          stdio: "ignore",
        });
        child.unref();
        writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
        process.stdin.once("data", (release) => {
          assert.equal(String(release).trim(), "release");
          process.exit(0);
        });
      });
    `;
    let root;
    let rootIdentity;
    let detachedIdentity;
    let detachedPid;
    const markerFds = [];

    try {
      const prepared = prepareDarwinLineage({
        statePath,
        scratchDirectory: directory,
        token,
      });
      assert.equal(prepared.active, true);

      for (const markerPath of markerPaths) {
        writeFileSync(markerPath, "marker\n", { flag: "wx", mode: 0o600 });
        markerFds.push(openSync(markerPath, "r"));
      }
      const rootStdio = Array.from({ length: 10 }, () => "ignore");
      rootStdio[0] = "pipe";
      rootStdio[8] = markerFds[0];
      rootStdio[9] = markerFds[1];
      root = spawn(process.execPath, ["-e", rootCode], {
        detached: true,
        env: {
          ...process.env,
          AGENTQG_MARKER_FDS: "8,9",
          AGENTQG_REQUEST: `agentqg:${token}:request`,
          AGENTQG_RUN: `agentqg:${token}:run`,
        },
        stdio: rootStdio,
      });
      for (const markerFd of markerFds.splice(0)) closeSync(markerFd);
      const bound = bindDarwinLineageRoot({
        statePath,
        scratchDirectory: directory,
        pid: root.pid,
        parentPid: process.pid,
      });
      assert.equal(bound.active, true);
      rootIdentity = captureDarwinExactChild({
        scratchDirectory: directory,
        pid: root.pid,
        parentPid: process.pid,
      }).identity;

      root.stdin.write("start\n");
      await waitFor(
        () => existsSync(childPidPath) && existsSync(childReadyPath),
        "the detached marker-free child",
      );
      detachedPid = Number(readFileSync(childPidPath, "utf8"));
      assert.ok(Number.isSafeInteger(detachedPid) && detachedPid > 1);
      detachedIdentity = captureDarwinExactChild({
        scratchDirectory: directory,
        pid: detachedPid,
        parentPid: root.pid,
      }).identity;
      const detachedExact = parseDarwinExactIdentity(detachedIdentity);

      root.stdin.end("release\n");
      await waitForChildExit(root);
      assert.equal(root.exitCode, 0);

      const settled = await settleDarwinLineage({
        statePath,
        scratchDirectory: directory,
        timeoutSeconds: 12,
        retainState: true,
      });
      assert.equal(settled.settled, true);
      assert.equal(settled.retained, true);
      assert.equal(existsSync(statePath), true);
      const retained = JSON.parse(readFileSync(statePath, "utf8"));
      assert.ok(Number.isSafeInteger(retained.settledAt));
      assert.equal(retained.settledReason, "empty-coherent-exact-set");
      assert.equal(
        retained.settlementProof?.kind,
        "xnu-coherent-process-snapshot-v1",
      );
      assert.equal(
        BigInt(retained.settlementProof.upperUniqueId),
        BigInt(retained.settlementProof.lowerUniqueId) + 1n,
      );
      assert.equal(retained.settlementProof.zeroPidCount, 1);
      assert.ok(
        retained.settlementProof.estimatedCount -
          (retained.settlementProof.listedCount -
            retained.settlementProof.zeroPidCount) >=
          20,
      );
      assert.ok(
        retained.settlementProof.listedCount <
          retained.settlementProof.capacity,
      );
      assert.ok(Number.isSafeInteger(retained.settlementProof.capturedAt));
      const detachedTombstone = retained.tombstones.find(
        ({ uniqueId }) => uniqueId === detachedExact.uniqueId,
      );
      assert.ok(detachedTombstone);
      assert.ok(Number.isSafeInteger(detachedTombstone.termSentAt));
      assert.ok(Number.isSafeInteger(detachedTombstone.killSentAt));
      assert.ok(detachedTombstone.killSentAt >= detachedTombstone.termSentAt);
      assert.deepEqual(
        statusDarwinExactIdentity({
          scratchDirectory: directory,
          exactIdentity: detachedIdentity,
        }),
        { status: "gone" },
      );
      assert.deepEqual(discardSettledDarwinLineage({ statePath }), {
        active: true,
        discarded: true,
      });
      assert.equal(existsSync(statePath), false);
    } finally {
      if (!rootIdentity && root?.pid) {
        try {
          const captured = captureDarwinExactChildOrGone({
            scratchDirectory: directory,
            pid: root.pid,
            parentPid: process.pid,
          });
          rootIdentity = captured.active ? captured.identity : null;
        } catch {
          // The exact root relation is no longer available. The stdin
          // handshake below remains the only safe non-signal exit request.
        }
      }
      if (!detachedPid && existsSync(childPidPath)) {
        const recordedPid = Number(readFileSync(childPidPath, "utf8"));
        if (Number.isSafeInteger(recordedPid) && recordedPid > 1) {
          detachedPid = recordedPid;
        }
      }
      if (!detachedIdentity && detachedPid && root?.pid) {
        try {
          const captured = captureDarwinExactChildOrGone({
            scratchDirectory: directory,
            pid: detachedPid,
            parentPid: root.pid,
          });
          detachedIdentity = captured.active ? captured.identity : null;
        } catch {
          // The exact child relation is no longer available. Never signal a
          // bare PID that the kernel could have reused.
        }
      }
      await stopExactProcess(directory, detachedIdentity);
      if (root && root.exitCode === null && root.signalCode === null) {
        if (!root.stdin.destroyed && !root.stdin.writableEnded) {
          root.stdin.end("release\n");
        }
        await Promise.race([
          waitForChildExit(root),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
      await stopExactProcess(directory, rootIdentity);
      if (root && root.exitCode === null && root.signalCode === null) {
        await waitForChildExit(root);
      }
      for (const markerFd of markerFds.splice(0)) closeSync(markerFd);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
