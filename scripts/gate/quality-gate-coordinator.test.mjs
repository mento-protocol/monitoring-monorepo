import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createConnection, createServer } from "node:net";
import { basename, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CoordinatorError,
  DEFAULT_CAPACITY,
  DEFAULT_POLICY_HASH,
  PROTOCOL_VERSION,
  RECORD_RETENTION_MS,
  adoptLegacyRunLock,
  connectCoordinator,
  coordinatorRpc,
  fingerprintHash,
  observeProcessIdentity,
  ownerFields,
  processStartUtc,
  serveChildEnvironment,
  socketPathForRoot,
  startCoordinator,
  startDetached,
  stateNamespace,
} from "./quality-gate-coordinator.mjs";
import {
  initialState,
  RECORD_SCHEMA_VERSION,
  syncDirectory,
  validateState,
  writeAtomicJson,
  writeImmutable,
} from "./quality-gate-coordinator-state.mjs";
import { pruneInactiveNamespaces } from "./quality-gate-coordinator-retention.mjs";

const fixtures = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.coordinator?.close("test-cleanup");
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function owner(pid) {
  return {
    pid,
    startUtc: `2026-08-21T12:${String(pid % 60).padStart(2, "0")}:00.000Z`,
  };
}

function capabilityFor(requestId) {
  return createHash("sha256")
    .update(`quality-gate-test-capability:${requestId}`)
    .digest("hex");
}

function runToken(label, pid, startedAt) {
  return `${label}-${pid}-${startedAt}`;
}

function writerArtifactSuffix() {
  return `${process.pid}-${randomUUID()}`;
}

function atomicTemporaryPath(directory, targetName) {
  return join(directory, `${targetName}.tmp-${writerArtifactSuffix()}`);
}

function immutableStagingPath(directory, identifier) {
  return join(directory, `${identifier}.json.staged-${writerArtifactSuffix()}`);
}

function setModifiedAt(path, milliseconds) {
  const seconds = milliseconds / 1_000;
  utimesSync(path, seconds, seconds);
}

const capabilityActions = new Set([
  "register",
  "request-status",
  "request-lease",
  "lease-status",
  "release-lease",
  "abandon-lease",
  "publish-result",
  "acknowledge-result",
  "cancel-request",
  "wait-result",
  "wait-admission",
  "wait-lease",
]);

async function createFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-coordinator-"));
  const coordinator = await startCoordinator({
    root,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-coordinator-process-start",
    },
    ...options,
  });
  const fixture = {
    root,
    coordinator,
    policyHash: options.policyHash ?? DEFAULT_POLICY_HASH,
  };
  fixtures.push(fixture);
  return fixture;
}

async function createLegacyFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-authority-"));
  const legacyRoot = join(root, "legacy");
  const lockDirectory = join(legacyRoot, "run.lock");
  const ownerPath = join(lockDirectory, "owner");
  mkdirSync(lockDirectory, { recursive: true });
  const nonce = randomUUID();
  const legacyOwnerToken = runToken(`legacy-${nonce}`, process.pid, 5001);
  const generationToken = runToken(`coord-${nonce}`, process.pid, 5002);
  writeFileSync(
    ownerPath,
    `pid=${process.pid}\nhost=test-host\nstart_utc=\ntoken=${legacyOwnerToken}\n`,
  );
  const coordinator = await startCoordinator({
    root,
    capacity: 1,
    idleMs: 30_000,
    ownerSweepMs: 0,
    legacyLockRoot: legacyRoot,
    legacyOwnerToken,
    generationToken,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-coordinator-process-start",
    },
    ...options,
  });
  const fixture = {
    root,
    coordinator,
    legacyRoot,
    ownerPath,
    policyHash: options.policyHash ?? DEFAULT_POLICY_HASH,
  };
  fixtures.push(fixture);
  return fixture;
}

function displaceLegacyAuthority(fixture) {
  const successorToken = runToken(
    `successor-${randomUUID()}`,
    process.pid,
    5003,
  );
  writeFileSync(
    fixture.ownerPath,
    `pid=${process.pid}\nhost=test-host\nstart_utc=successor\ntoken=${successorToken}\n`,
  );
  return successorToken;
}

async function rpc(fixture, action, params = {}, options = {}) {
  let requestId = params.requestId;
  if (!requestId && params.leaseId) {
    requestId =
      fixture.coordinator.core.state.leases[params.leaseId]?.requestId;
  }
  const authorizedParams =
    options.injectCapability !== false &&
    capabilityActions.has(action) &&
    params.capability === undefined &&
    requestId
      ? { ...params, capability: capabilityFor(requestId) }
      : params;
  return coordinatorRpc(
    {
      root: fixture.root,
      policyHash: options.policyHash ?? fixture.policyHash,
      protocol: options.protocol ?? PROTOCOL_VERSION,
    },
    action,
    authorizedParams,
  );
}

async function register(
  fixture,
  requestId,
  fingerprint,
  requestOwner,
  options = {},
) {
  const drainId = options.drainIdentity ?? `test-${requestId}-1234-1770000000`;
  return rpc(fixture, "register", {
    requestId,
    fingerprint,
    worktreeKey: options.worktreeKey ?? `/tmp/${requestId}`,
    drainIdentity: drainId,
    capability: options.capability ?? capabilityFor(requestId),
    owner: requestOwner,
    successMaxAgeMs: options.successMaxAgeMs ?? 0,
    metadata: { worktree: `/tmp/${requestId}` },
  });
}

async function lease(fixture, requestId, leaseId, requestOwner, options = {}) {
  const drainIdentity =
    options.drainIdentity ??
    runToken(`test-lease-${leaseId}`, requestOwner.pid, 1_770_000_000);
  return rpc(fixture, "request-lease", {
    requestId,
    leaseId,
    drainIdentity,
    capability: options.capability ?? capabilityFor(requestId),
    owner: requestOwner,
    weight: options.weight ?? 1,
    allCapacity: options.allCapacity ?? false,
    resources: options.resources ?? [],
    metadata: { command: options.command ?? leaseId },
  });
}

async function release(fixture, requestId, leaseId, requestOwner) {
  return rpc(fixture, "release-lease", {
    requestId,
    leaseId,
    capability: capabilityFor(requestId),
    owner: requestOwner,
  });
}

async function acknowledgeResult(fixture, requestId, requestOwner) {
  return rpc(fixture, "acknowledge-result", {
    requestId,
    capability: capabilityFor(requestId),
    owner: requestOwner,
  });
}

async function markOwnerStale(fixture, params) {
  return fixture.coordinator.core.markOwnerStale(params);
}

async function status(fixture) {
  return rpc(fixture, "inspect");
}

async function claimObligation(fixture, obligation, claimant) {
  return rpc(fixture, "claim-drain", {
    obligationId: obligation.obligationId,
    drainIdentity: obligation.drainIdentity,
    claimant,
  });
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition did not become true within ${timeoutMs} ms`);
}

async function resetCoordinatorConnection(path, payload) {
  const socket = createConnection(path);
  socket.on("error", () => {});
  await once(socket, "connect");
  const closed = once(socket, "close");
  await new Promise((resolveWrite, rejectWrite) => {
    socket.write(payload, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
  socket.destroy();
  await closed;
}

function assertWithinCapacity(snapshot) {
  assert.ok(snapshot.usedCapacity >= 0);
  assert.ok(
    snapshot.usedCapacity <= snapshot.capacity,
    `${snapshot.usedCapacity} exceeds capacity ${snapshot.capacity}`,
  );
  assert.equal(
    snapshot.availableCapacity,
    snapshot.capacity - snapshot.usedCapacity,
  );
}

test("the socket rejects incompatible protocol and policy clients", async () => {
  const fixture = await createFixture();

  const majorClient = await connectCoordinator({
    root: fixture.root,
    protocol: { major: PROTOCOL_VERSION.major + 1, minor: 0 },
  });
  await assert.rejects(
    majorClient.request("ping"),
    (error) => error.code === "PROTOCOL_MAJOR_MISMATCH",
  );
  majorClient.destroy();

  const minorClient = await connectCoordinator({
    root: fixture.root,
    protocol: { major: PROTOCOL_VERSION.major, minor: 999 },
  });
  await assert.rejects(
    minorClient.request("ping"),
    (error) => error.code === "PROTOCOL_MINOR_MISMATCH",
  );
  minorClient.destroy();

  const policyClient = await connectCoordinator({
    root: fixture.root,
    policyHash: "0".repeat(64),
  });
  await assert.rejects(
    policyClient.request("ping"),
    (error) => error.code === "POLICY_MISMATCH",
  );
  policyClient.destroy();

  const ping = await rpc(fixture, "ping");
  assert.deepEqual(ping.protocol, PROTOCOL_VERSION);
  assert.equal(ping.policyHash, DEFAULT_POLICY_HASH);
});

test("a detached coordinator child never inherits a request capability", () => {
  const source = {
    SAFE_VALUE: "kept",
    AGENT_QUALITY_GATE_REQUEST_CAPABILITY: capabilityFor("bootstrap"),
  };
  const sanitized = serveChildEnvironment(source);
  assert.deepEqual(sanitized, { SAFE_VALUE: "kept" });
  assert.ok(Object.hasOwn(source, "AGENT_QUALITY_GATE_REQUEST_CAPABILITY"));
});

test("socket path validation uses the portable byte boundary", () => {
  const suffixBytes = Buffer.byteLength("/coordinator.sock");
  const exactRoot = `/${"x".repeat(100 - suffixBytes - 1)}`;
  const exactPath = socketPathForRoot(exactRoot);
  assert.equal(Buffer.byteLength(exactPath), 100);
  assert.throws(
    () => socketPathForRoot(`${exactRoot}x`),
    (error) => error.code === "SOCKET_PATH_TOO_LONG",
  );
  const multibyteRoot = `/${"é".repeat(50)}`;
  assert.ok(multibyteRoot.length + "/coordinator.sock".length < 100);
  assert.ok(Buffer.byteLength(`${multibyteRoot}/coordinator.sock`) > 100);
  assert.throws(
    () => socketPathForRoot(multibyteRoot),
    (error) => error.code === "SOCKET_PATH_TOO_LONG",
  );
});

test("request capabilities protect exposed request and lease identities", async () => {
  const fixture = await createFixture({ capacity: 1 });
  const victimOwner = owner(249);
  const requestId = "capability-victim";
  const victimCapability = capabilityFor(requestId);
  const attackerCapability = capabilityFor("capability-attacker");
  const registration = await register(
    fixture,
    requestId,
    "capability-fingerprint",
    victimOwner,
  );
  await lease(fixture, requestId, "capability-lease", victimOwner);

  const exposed = await status(fixture);
  const exposedRequest = exposed.requests.find(
    (request) => request.requestId === requestId,
  );
  const exposedLease = exposed.leases.find(
    (candidate) => candidate.requestId === requestId,
  );
  assert.deepEqual(exposedRequest.owner, victimOwner);
  assert.equal(exposedLease.leaseId, "capability-lease");
  assert.equal(Object.hasOwn(exposedRequest, "capabilityHash"), false);

  const persistedRequest = JSON.parse(
    readFileSync(
      join(fixture.coordinator.stateRoot, "requests", `${requestId}.json`),
      "utf8",
    ),
  );
  const persistedJournal = readFileSync(
    join(fixture.coordinator.stateRoot, "journal.json"),
    "utf8",
  );
  assert.notEqual(persistedRequest.capabilityHash, victimCapability);
  assert.equal(persistedJournal.includes(victimCapability), false);

  const attackerOwnerParams = {
    requestId: exposedRequest.requestId,
    owner: exposedRequest.owner,
    capability: attackerCapability,
  };
  const rejectedCalls = [
    [
      "register",
      {
        ...attackerOwnerParams,
        fingerprint: "capability-fingerprint",
        worktreeKey: exposedRequest.worktreeKey,
        drainIdentity: exposedRequest.drainIdentity,
        successMaxAgeMs: 0,
      },
    ],
    ["request-status", attackerOwnerParams],
    ["wait-admission", { ...attackerOwnerParams, timeoutMs: 10 }],
    [
      "request-lease",
      {
        ...attackerOwnerParams,
        leaseId: "capability-attacker-lease",
        drainIdentity: runToken(
          "capability-attacker-lease",
          victimOwner.pid,
          1_770_000_000,
        ),
        weight: 1,
        resources: [],
      },
    ],
    [
      "lease-status",
      {
        leaseId: exposedLease.leaseId,
        owner: exposedRequest.owner,
        capability: attackerCapability,
      },
    ],
    [
      "wait-lease",
      {
        leaseId: exposedLease.leaseId,
        owner: exposedRequest.owner,
        capability: attackerCapability,
        timeoutMs: 10,
      },
    ],
    [
      "release-lease",
      {
        ...attackerOwnerParams,
        leaseId: exposedLease.leaseId,
      },
    ],
    [
      "abandon-lease",
      {
        ...attackerOwnerParams,
        leaseId: exposedLease.leaseId,
        commandStarted: false,
      },
    ],
    [
      "publish-result",
      {
        ...attackerOwnerParams,
        status: "success",
        payload: null,
      },
    ],
    [
      "wait-result",
      {
        ...attackerOwnerParams,
        fingerprint: "capability-fingerprint",
        executionId: registration.executionId,
        timeoutMs: 10,
      },
    ],
    ["acknowledge-result", attackerOwnerParams],
    ["cancel-request", { ...attackerOwnerParams, reason: "forged" }],
  ];
  for (const [action, params] of rejectedCalls) {
    await assert.rejects(
      rpc(fixture, action, params, { injectCapability: false }),
      (error) => error.code === "REQUEST_CAPABILITY_MISMATCH",
      action,
    );
  }
  await assert.rejects(
    rpc(
      fixture,
      "request-status",
      { requestId, owner: victimOwner },
      { injectCapability: false },
    ),
    (error) => error.code === "INVALID_REQUEST_CAPABILITY",
  );
  await assert.rejects(
    rpc(fixture, "mark-owner-stale", {
      requestId,
      observedOwner: victimOwner,
      reporter: victimOwner,
      reason: "forged stale report",
    }),
    (error) => error.code === "UNKNOWN_ACTION",
  );
  await assert.rejects(
    rpc(fixture, "read-result", {
      fingerprint: "capability-fingerprint",
      executionId: registration.executionId,
    }),
    (error) => error.code === "UNKNOWN_ACTION",
  );
  const staleCli = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./quality-gate-coordinator.mjs", import.meta.url)),
      "stale",
      "--root",
      fixture.root,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_QUALITY_GATE_REQUEST_CAPABILITY: attackerCapability,
      },
    },
  );
  assert.equal(staleCli.status, 2);
  assert.match(staleCli.stderr, /unknown command: stale/u);

  const afterAttack = await status(fixture);
  assert.equal(afterAttack.usedCapacity, 1);
  assert.equal(afterAttack.requests[0].state, "active");
  assert.equal(afterAttack.leases[0].status, "granted");

  await release(fixture, requestId, exposedLease.leaseId, victimOwner);
  await rpc(fixture, "publish-result", {
    requestId,
    owner: victimOwner,
    status: "success",
    payload: null,
  });
  await acknowledgeResult(fixture, requestId, victimOwner);
});

test("startup rejects corrupt journals before recovery or legacy adoption", async () => {
  const fixture = await createFixture({ capacity: 3 });
  const activeOwner = owner(225);
  const followerOwner = owner(226);
  const drainingOwner = owner(227);
  await register(fixture, "journal-active", "journal-active-fp", activeOwner);
  await lease(fixture, "journal-active", "journal-active-lease", activeOwner);
  await register(
    fixture,
    "journal-follower",
    "journal-active-fp",
    followerOwner,
  );
  await register(
    fixture,
    "journal-draining",
    "journal-draining-fp",
    drainingOwner,
  );
  await lease(
    fixture,
    "journal-draining",
    "journal-draining-lease-a",
    drainingOwner,
  );
  await lease(
    fixture,
    "journal-draining",
    "journal-draining-lease-b",
    drainingOwner,
  );
  await rpc(fixture, "cancel-request", {
    requestId: "journal-draining",
    owner: drainingOwner,
    reason: "journal corruption fixture",
  });

  const stateRoot = fixture.coordinator.stateRoot;
  const journalPath = join(stateRoot, "journal.json");
  const validJournal = JSON.parse(readFileSync(journalPath, "utf8"));
  validateState(validJournal, 3, DEFAULT_POLICY_HASH);
  await fixture.coordinator.close("corrupt-journal-fixture-ready");
  fixture.coordinator = null;

  const activeLease = (state) => state.leases["journal-active-lease"];
  const drainingLease = (state) => state.leases["journal-draining-lease-a"];
  const drainingObligation = (state) =>
    state.drainObligations[drainingLease(state).drainObligationId];
  const activeHash = fingerprintHash("journal-active-fp");
  const cases = [
    {
      name: "array request map",
      path: "requests",
      mutate: (state) => {
        state.requests = [];
      },
    },
    {
      name: "negative revision",
      path: "revision",
      mutate: (state) => {
        state.revision = -1;
      },
    },
    {
      name: "string lease weight",
      path: "leases.journal-active-lease.weight",
      mutate: (state) => {
        activeLease(state).weight = "1";
      },
    },
    {
      name: "negative lease weight",
      path: "leases.journal-active-lease.weight",
      mutate: (state) => {
        activeLease(state).weight = -1;
      },
    },
    {
      name: "per-lease over-capacity weight",
      path: "leases.journal-active-lease.weight",
      mutate: (state) => {
        activeLease(state).weight = 4;
      },
    },
    {
      name: "aggregate over-capacity weight",
      path: "leases",
      mutate: (state) => {
        activeLease(state).weight = 2;
      },
    },
    {
      name: "malformed resource name",
      path: "leases.journal-active-lease.resources[0]",
      mutate: (state) => {
        activeLease(state).resources = ["bad resource"];
      },
    },
    {
      name: "duplicate active resource",
      path: "leases.journal-draining-lease-a.resources",
      mutate: (state) => {
        activeLease(state).resources = ["shared-mutex"];
        drainingLease(state).resources = ["shared-mutex"];
        drainingObligation(state).resources = ["shared-mutex"];
      },
    },
    {
      name: "missing lease request",
      path: "leases.journal-active-lease.requestId",
      mutate: (state) => {
        activeLease(state).requestId = "missing-request";
      },
    },
    {
      name: "duplicate request drain token",
      path: "requests.journal-follower.drainIdentity",
      mutate: (state) => {
        const follower = state.requests["journal-follower"];
        const active = state.requests["journal-active"];
        follower.drainIdentity = active.drainIdentity;
      },
    },
    {
      name: "malformed lease drain token",
      path: "leases.journal-active-lease.drainIdentity",
      mutate: (state) => {
        activeLease(state).drainIdentity = "malformed";
      },
    },
    {
      name: "request and lease share one drain token",
      path: "leases.journal-active-lease.drainIdentity",
      mutate: (state) => {
        activeLease(state).drainIdentity =
          state.requests["journal-active"].drainIdentity;
      },
    },
    {
      name: "two leases share one drain token",
      path: "leases.journal-draining-lease-a.drainIdentity",
      mutate: (state) => {
        const duplicate = activeLease(state).drainIdentity;
        drainingLease(state).drainIdentity = duplicate;
        drainingObligation(state).drainIdentity = duplicate;
      },
    },
    {
      name: "invalid request auto acknowledgement",
      path: "requests.journal-active.autoAcknowledge",
      mutate: (state) => {
        state.requests["journal-active"].autoAcknowledge = "true";
      },
    },
    {
      name: "mismatched lease owner",
      path: "leases.journal-active-lease.owner",
      mutate: (state) => {
        activeLease(state).owner = owner(228);
      },
    },
    {
      name: "all-capacity weight mismatch",
      path: "leases.journal-active-lease.weight",
      mutate: (state) => {
        activeLease(state).allCapacity = true;
      },
    },
    {
      name: "duplicate request order",
      path: "requestOrder[2]",
      mutate: (state) => {
        state.requestOrder.push(state.requestOrder[0]);
      },
    },
    {
      name: "missing singleflight leader",
      path: `singleflights.${activeHash}.leaderRequestId`,
      mutate: (state) => {
        state.singleflights[activeHash].leaderRequestId = "missing-request";
      },
    },
    {
      name: "missing singleflight follower",
      path: `singleflights.${activeHash}.followers`,
      mutate: (state) => {
        state.singleflights[activeHash].followers = [];
      },
    },
    {
      name: "invalid drain lease link",
      path: `drainObligations.${drainingLease(validJournal).drainObligationId}`,
      mutate: (state) => {
        drainingObligation(state).leaseId = "journal-active-lease";
      },
    },
    {
      name: "obligation drain token differs from its lease",
      path: `drainObligations.${drainingLease(validJournal).drainObligationId}`,
      mutate: (state) => {
        drainingObligation(state).drainIdentity = runToken(
          "wrong-obligation",
          229,
          1_770_000_000,
        );
      },
    },
    {
      name: "one request has a partial drain claim",
      path: "drainObligations.journal-draining",
      mutate: (state) => {
        drainingObligation(state).claim = {
          claimant: owner(229),
          claimedAt: "2026-08-21T12:00:00.000Z",
        };
      },
    },
    {
      name: "invalid success index",
      path: `successIndex.${"a".repeat(64)}.completedAt`,
      mutate: (state) => {
        state.successIndex["a".repeat(64)] = {
          executionId: "old-success",
          completedAt: "not-a-time",
        };
      },
    },
    {
      name: "duplicate global sequence",
      path: "leases.journal-active-lease.sequence",
      mutate: (state) => {
        activeLease(state).sequence = state.requests["journal-active"].sequence;
      },
    },
    {
      name: "invalid coordinator identity",
      path: "coordinatorIdentity.pid",
      mutate: (state) => {
        state.coordinatorIdentity.pid = "225";
      },
    },
    {
      name: "invalid generation token",
      path: "generationToken",
      mutate: (state) => {
        state.generationToken = ["..", "generation"].join("/");
      },
    },
  ];

  for (const corruption of cases) {
    const journal = JSON.parse(JSON.stringify(validJournal));
    corruption.mutate(journal);
    const bytes = `${JSON.stringify(journal)}\n`;
    writeFileSync(journalPath, bytes);
    let reachedLegacyAdoption = false;
    await assert.rejects(
      startCoordinator({
        root: fixture.root,
        capacity: 3,
        idleMs: 30_000,
        ownerSweepMs: 0,
        coordinatorIdentity: {
          pid: process.pid,
          startUtc: "test-corrupt-journal-start",
        },
        generationToken: runToken(`valid-${randomUUID()}`, process.pid, 6000),
        beforeLegacyAdopt: async () => {
          reachedLegacyAdoption = true;
        },
      }),
      (error) => {
        assert.equal(error.code, "JOURNAL_STATE_INVALID", corruption.name);
        assert.equal(error.details?.path, corruption.path, corruption.name);
        return true;
      },
    );
    assert.equal(reachedLegacyAdoption, false, corruption.name);
    assert.equal(readFileSync(journalPath, "utf8"), bytes, corruption.name);
    assert.equal(existsSync(socketPathForRoot(fixture.root)), false);
  }

  writeFileSync(journalPath, "{\n");
  await assert.rejects(
    startCoordinator({
      root: fixture.root,
      capacity: 3,
      idleMs: 30_000,
      ownerSweepMs: 0,
    }),
    (error) =>
      error.code === "JOURNAL_STATE_INVALID" &&
      error.details?.path === "journal",
  );
  assert.equal(readFileSync(journalPath, "utf8"), "{\n");
  assert.equal(existsSync(socketPathForRoot(fixture.root)), false);
});

test("startup rejects invalid terminal results before recovery or legacy adoption", async () => {
  const fixture = await createFixture({ capacity: 3 });
  const leaderOwner = owner(248);
  const followerOwners = [owner(249), owner(250)];
  const fingerprint = "startup-result-validation-fingerprint";
  const leader = await register(
    fixture,
    "startup-result-leader",
    fingerprint,
    leaderOwner,
  );
  const followers = [];
  for (const [index, followerOwner] of followerOwners.entries()) {
    followers.push(
      await register(
        fixture,
        `startup-result-follower-${index}`,
        fingerprint,
        followerOwner,
      ),
    );
  }

  const stateRoot = fixture.coordinator.stateRoot;
  const journalPath = join(stateRoot, "journal.json");
  const journalBytes = readFileSync(journalPath, "utf8");
  const hash = fingerprintHash(fingerprint);
  const resultDirectory = join(stateRoot, "results", hash);
  const resultPath = join(resultDirectory, `${leader.executionId}.json`);
  mkdirSync(resultDirectory, { recursive: true });
  const validResult = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    protocol: { ...PROTOCOL_VERSION },
    policyHash: DEFAULT_POLICY_HASH,
    fingerprint,
    fingerprintHash: hash,
    executionId: leader.executionId,
    leaderRequestId: leader.requestId,
    followerRequestIds: followers.map((follower) => follower.requestId),
    status: "success",
    payload: { source: "startup-result-validation" },
    completedAt: "2026-08-21T12:00:00.000Z",
  };
  await fixture.coordinator.close("invalid-terminal-result-fixture-ready");
  fixture.coordinator = null;

  const cases = [
    {
      name: "malformed JSON",
      path: "result",
      bytes: "{\n",
    },
    {
      name: "wrong schema",
      path: "result.schemaVersion",
      mutate: (result) => {
        result.schemaVersion += 1;
      },
    },
    {
      name: "wrong protocol",
      path: "result.protocol",
      mutate: (result) => {
        result.protocol.minor += 1;
      },
    },
    {
      name: "wrong policy",
      path: "result.policyHash",
      mutate: (result) => {
        result.policyHash = "0".repeat(64);
      },
    },
    {
      name: "wrong fingerprint path",
      path: "result.fingerprintHash",
      mutate: (result) => {
        result.fingerprint = "another-fingerprint";
      },
    },
    {
      name: "wrong fingerprint hash",
      path: "result.fingerprintHash",
      mutate: (result) => {
        result.fingerprintHash = "0".repeat(64);
      },
    },
    {
      name: "wrong execution path",
      path: "result.executionId",
      mutate: (result) => {
        result.executionId = "another-execution";
      },
    },
    {
      name: "leader differs from execution",
      path: "result.leaderRequestId",
      mutate: (result) => {
        result.leaderRequestId = "another-leader";
      },
    },
    {
      name: "leader appears among followers",
      path: "result.followerRequestIds[0]",
      mutate: (result) => {
        result.followerRequestIds.unshift(result.leaderRequestId);
      },
    },
    {
      name: "duplicate follower",
      path: "result.followerRequestIds[1]",
      mutate: (result) => {
        result.followerRequestIds[1] = result.followerRequestIds[0];
      },
    },
    {
      name: "wrong follower membership",
      path: "result.followerRequestIds",
      mutate: (result) => {
        result.followerRequestIds[1] = "another-follower";
      },
    },
    {
      name: "wrong follower order",
      path: "result.followerRequestIds",
      mutate: (result) => {
        result.followerRequestIds.reverse();
      },
    },
    {
      name: "wrong status",
      path: "result.status",
      mutate: (result) => {
        result.status = "unknown";
      },
    },
    {
      name: "oversized payload",
      path: "result.payload",
      mutate: (result) => {
        result.payload = { data: "x".repeat(256 * 1024) };
      },
    },
    {
      name: "noncanonical timestamp",
      path: "result.completedAt",
      mutate: (result) => {
        result.completedAt = "2026-08-21 12:00:00Z";
      },
    },
  ];

  for (const invalidCase of cases) {
    const result = JSON.parse(JSON.stringify(validResult));
    invalidCase.mutate?.(result);
    const bytes = invalidCase.bytes ?? `${JSON.stringify(result)}\n`;
    writeFileSync(resultPath, bytes);
    let reachedLegacyAdoption = false;
    await assert.rejects(
      startCoordinator({
        root: fixture.root,
        capacity: 3,
        idleMs: 30_000,
        ownerSweepMs: 0,
        coordinatorIdentity: {
          pid: process.pid,
          startUtc: "test-invalid-terminal-result-start",
        },
        generationToken: runToken(`result-${randomUUID()}`, process.pid, 6001),
        beforeLegacyAdopt: async () => {
          reachedLegacyAdoption = true;
        },
      }),
      (error) => {
        assert.equal(error.code, "RESULT_RECORD_INVALID", invalidCase.name);
        assert.equal(error.details?.path, invalidCase.path, invalidCase.name);
        return true;
      },
    );
    assert.equal(reachedLegacyAdoption, false, invalidCase.name);
    assert.equal(readFileSync(journalPath, "utf8"), journalBytes);
    assert.equal(existsSync(socketPathForRoot(fixture.root)), false);
  }
});

test("startup rejects an invalid retained result after its request is acknowledged", async () => {
  const fixture = await createFixture();
  const requestOwner = owner(254);
  const fingerprint = "idle-invalid-result-fingerprint";
  const registration = await register(
    fixture,
    "idle-invalid-result",
    fingerprint,
    requestOwner,
  );
  await rpc(fixture, "publish-result", {
    requestId: registration.requestId,
    owner: requestOwner,
    status: "failure",
    payload: { source: "idle-result-validation" },
  });
  await acknowledgeResult(fixture, registration.requestId, requestOwner);
  const resultPath = join(
    fixture.coordinator.stateRoot,
    "results",
    fingerprintHash(fingerprint),
    `${registration.executionId}.json`,
  );
  await fixture.coordinator.close("idle-invalid-result-fixture-ready");
  fixture.coordinator = null;
  writeFileSync(resultPath, "{\n");

  let reachedLegacyAdoption = false;
  await assert.rejects(
    startCoordinator({
      root: fixture.root,
      idleMs: 30_000,
      ownerSweepMs: 0,
      beforeLegacyAdopt: async () => {
        reachedLegacyAdoption = true;
      },
    }),
    (error) =>
      error.code === "RESULT_RECORD_INVALID" &&
      error.details?.path === "result",
  );
  assert.equal(reachedLegacyAdoption, false);
  assert.equal(existsSync(socketPathForRoot(fixture.root)), false);
});

test("startup validates retained results when the journal is missing", async () => {
  const fixture = await createFixture();
  const requestOwner = owner(255);
  const fingerprint = "missing-journal-result-fingerprint";
  const registration = await register(
    fixture,
    "missing-journal-result",
    fingerprint,
    requestOwner,
  );
  await rpc(fixture, "publish-result", {
    requestId: registration.requestId,
    owner: requestOwner,
    status: "failure",
    payload: null,
  });
  await acknowledgeResult(fixture, registration.requestId, requestOwner);
  const stateRoot = fixture.coordinator.stateRoot;
  const journalPath = join(stateRoot, "journal.json");
  const resultPath = join(
    stateRoot,
    "results",
    fingerprintHash(fingerprint),
    `${registration.executionId}.json`,
  );
  await fixture.coordinator.close("missing-journal-result-fixture-ready");
  fixture.coordinator = null;
  rmSync(journalPath);
  writeFileSync(resultPath, "{\n");

  let reachedLegacyAdoption = false;
  await assert.rejects(
    startCoordinator({
      root: fixture.root,
      idleMs: 30_000,
      ownerSweepMs: 0,
      beforeLegacyAdopt: async () => {
        reachedLegacyAdoption = true;
      },
    }),
    (error) =>
      error.code === "RESULT_RECORD_INVALID" &&
      error.details?.path === "result",
  );
  assert.equal(reachedLegacyAdoption, false);
  assert.equal(existsSync(socketPathForRoot(fixture.root)), false);
  assert.equal(existsSync(journalPath), false);
});

test("missing-journal startup does not adopt an expired atomic temporary", async () => {
  const clock = Date.parse("2026-08-21T12:30:00.000Z");
  const fixture = await createFixture({ now: () => clock });
  const stateRoot = fixture.coordinator.stateRoot;
  const journalPath = join(stateRoot, "journal.json");
  await fixture.coordinator.close("missing-journal-temporary-fixture-ready");
  fixture.coordinator = null;
  rmSync(journalPath);

  const journalTemporary = atomicTemporaryPath(stateRoot, "journal.json");
  writeFileSync(journalTemporary, '{"mustNotBeAdopted":true}\n');
  setModifiedAt(journalTemporary, clock - RECORD_RETENTION_MS - 1);

  const legacyRoot = join(fixture.root, "missing-journal-legacy-lock");
  const lockDirectory = join(legacyRoot, "run.lock");
  mkdirSync(lockDirectory, { recursive: true });
  const nonce = randomUUID();
  const legacyOwnerToken = runToken(`legacy-${nonce}`, process.pid, 6101);
  const generationToken = runToken(`coord-${nonce}`, process.pid, 6102);
  writeFileSync(
    join(lockDirectory, "owner"),
    `pid=${process.pid}\nhost=test-host\nstart_utc=\ntoken=${legacyOwnerToken}\n`,
  );

  let temporaryExistedBeforeAdoption = false;
  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    legacyLockRoot: legacyRoot,
    legacyOwnerToken,
    generationToken,
    idleMs: 30_000,
    ownerSweepMs: 0,
    now: () => clock,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-missing-journal-temporary-start",
    },
    beforeLegacyAdopt: async () => {
      temporaryExistedBeforeAdoption = existsSync(journalTemporary);
    },
  });
  assert.equal(temporaryExistedBeforeAdoption, true);
  assert.equal(existsSync(journalTemporary), false);
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  assert.equal(journal.mustNotBeAdopted, undefined);
  assert.equal(journal.policyHash, DEFAULT_POLICY_HASH);
});

test("startup rejects a near-match immutable staging name", async () => {
  const fixture = await createFixture();
  const resultDirectory = join(
    fixture.coordinator.stateRoot,
    "results",
    fingerprintHash("near-match-staging-fingerprint"),
  );
  mkdirSync(resultDirectory);
  const nearMatch = join(
    resultDirectory,
    `near-match.json.staged-${process.pid}-00000000-0000-0000-0000-000000000000`,
  );
  writeFileSync(nearMatch, "partial writer bytes\n");
  await fixture.coordinator.close("near-match-staging-fixture-ready");
  fixture.coordinator = null;

  let reachedLegacyAdoption = false;
  await assert.rejects(
    startCoordinator({
      root: fixture.root,
      idleMs: 30_000,
      ownerSweepMs: 0,
      beforeLegacyAdopt: async () => {
        reachedLegacyAdoption = true;
      },
    }),
    (error) =>
      error.code === "RESULT_RECORD_INVALID" &&
      error.details?.path === "result.path",
  );
  assert.equal(reachedLegacyAdoption, false);
  assert.equal(existsSync(nearMatch), true);
  assert.equal(existsSync(socketPathForRoot(fixture.root)), false);
});

test("one active request owns each drain token across restart", async () => {
  const fixture = await createFixture();
  const firstOwner = owner(230);
  const secondOwner = owner(231);
  const drainIdentity = runToken("exclusive", 230, 1_770_000_000);
  const first = await register(
    fixture,
    "drain-token-first",
    "drain-token-first-fp",
    firstOwner,
    { drainIdentity },
  );
  assert.equal(first.requestId, "drain-token-first");

  await assert.rejects(
    register(
      fixture,
      "drain-token-second",
      "drain-token-second-fp",
      secondOwner,
      { drainIdentity },
    ),
    (error) =>
      error.code === "DRAIN_TOKEN_CONFLICT" &&
      error.details?.requestId === "drain-token-first",
  );
  assert.equal(
    existsSync(
      join(
        fixture.coordinator.stateRoot,
        "requests",
        "drain-token-second.json",
      ),
    ),
    false,
  );
  await assert.rejects(
    register(fixture, "drain-token-first", "drain-token-first-fp", firstOwner, {
      drainIdentity: runToken("changed", 230, 1_770_000_000),
    }),
    (error) => error.code === "REQUEST_ID_CONFLICT",
  );
  await assert.rejects(
    register(fixture, "drain-token-first", "drain-token-first-fp", firstOwner, {
      drainIdentity,
      worktreeKey: "/tmp/changed-worktree",
    }),
    (error) => error.code === "REQUEST_ID_CONFLICT",
  );
  assert.equal(
    (
      await register(
        fixture,
        "drain-token-first",
        "drain-token-first-fp",
        firstOwner,
        { drainIdentity },
      )
    ).requestId,
    "drain-token-first",
  );

  await fixture.coordinator.close("drain-token-restart");
  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-drain-token-restart",
    },
  });
  assert.equal((await status(fixture)).activeRequestCount, 1);
  assert.equal(
    (
      await register(
        fixture,
        "drain-token-first",
        "drain-token-first-fp",
        firstOwner,
        { drainIdentity },
      )
    ).requestId,
    "drain-token-first",
  );
  await assert.rejects(
    register(
      fixture,
      "drain-token-second",
      "drain-token-second-fp",
      secondOwner,
      { drainIdentity },
    ),
    (error) => error.code === "DRAIN_TOKEN_CONFLICT",
  );
});

test("each lease requires one distinct persisted drain identity", async () => {
  const fixture = await createFixture({ capacity: 2 });
  const requestOwner = owner(232);
  const requestId = "lease-drain-identity";
  const requestDrainIdentity = runToken(
    "lease-drain-request",
    requestOwner.pid,
    1_770_000_000,
  );
  const leaseDrainIdentity = runToken(
    "lease-drain-command",
    requestOwner.pid,
    1_770_000_001,
  );
  await register(
    fixture,
    requestId,
    "lease-drain-identity-fingerprint",
    requestOwner,
    { drainIdentity: requestDrainIdentity },
  );

  const baseParams = {
    requestId,
    leaseId: "lease-drain-identity-a",
    owner: requestOwner,
    weight: 1,
    resources: [],
  };
  await assert.rejects(
    rpc(fixture, "request-lease", baseParams),
    (error) => error.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    rpc(fixture, "request-lease", {
      ...baseParams,
      drainIdentity: "malformed",
    }),
    (error) => error.code === "INVALID_ARGUMENT",
  );

  const first = await rpc(fixture, "request-lease", {
    ...baseParams,
    drainIdentity: leaseDrainIdentity,
  });
  assert.equal(first.drainIdentity, leaseDrainIdentity);
  assert.equal(
    (
      await rpc(fixture, "request-lease", {
        ...baseParams,
        drainIdentity: leaseDrainIdentity,
      })
    ).drainIdentity,
    leaseDrainIdentity,
  );
  await assert.rejects(
    rpc(fixture, "request-lease", {
      ...baseParams,
      drainIdentity: runToken(
        "lease-drain-changed",
        requestOwner.pid,
        1_770_000_002,
      ),
    }),
    (error) => error.code === "LEASE_ID_CONFLICT",
  );
  await assert.rejects(
    lease(fixture, requestId, "lease-drain-identity-b", requestOwner, {
      drainIdentity: leaseDrainIdentity,
    }),
    (error) =>
      error.code === "DRAIN_TOKEN_CONFLICT" &&
      error.details?.leaseId === "lease-drain-identity-a",
  );
  await assert.rejects(
    lease(fixture, requestId, "lease-drain-identity-c", requestOwner, {
      drainIdentity: requestDrainIdentity,
    }),
    (error) =>
      error.code === "DRAIN_TOKEN_CONFLICT" &&
      error.details?.requestId === requestId,
  );
  await assert.rejects(
    register(
      fixture,
      "lease-token-request-collision",
      "lease-token-request-collision-fingerprint",
      owner(233),
      { drainIdentity: leaseDrainIdentity },
    ),
    (error) =>
      error.code === "DRAIN_TOKEN_CONFLICT" &&
      error.details?.leaseId === "lease-drain-identity-a",
  );

  const snapshot = await status(fixture);
  assert.equal(snapshot.leases.length, 1);
  assert.equal(snapshot.leases[0].drainIdentity, leaseDrainIdentity);
  const journal = JSON.parse(
    readFileSync(join(fixture.coordinator.stateRoot, "journal.json"), "utf8"),
  );
  assert.equal(
    journal.leases["lease-drain-identity-a"].drainIdentity,
    leaseDrainIdentity,
  );
});

test("a journal commit failure stops the coordinator before dirty state is served", async () => {
  let failNextJournalCommit = false;
  const fixture = await createFixture({
    journalWriter(path, value) {
      if (failNextJournalCommit) {
        failNextJournalCommit = false;
        const error = new Error("injected journal rename failure");
        error.code = "EIO";
        throw error;
      }
      writeAtomicJson(path, value);
    },
  });
  const connectedClient = await connectCoordinator({ root: fixture.root });
  const requestOwner = owner(220);
  const boundOwner = owner(221);
  await connectedClient.request("register", {
    requestId: "durable-bound-request",
    capability: capabilityFor("durable-bound-request"),
    fingerprint: "durable-bound-fingerprint",
    worktreeKey: "/tmp/durable-bound-request",
    drainIdentity: runToken("durable", 221, 1_770_000_000),
    owner: boundOwner,
    successMaxAgeMs: 0,
    bindConnection: true,
  });

  failNextJournalCommit = true;
  assert.throws(
    () =>
      fixture.coordinator.dispatch("register", {
        requestId: "failed-journal-request",
        capability: capabilityFor("failed-journal-request"),
        fingerprint: "failed-journal-fingerprint",
        worktreeKey: "/tmp/failed-journal-request",
        drainIdentity: runToken("failed", 220, 1_770_000_000),
        owner: requestOwner,
        successMaxAgeMs: 0,
      }),
    (error) =>
      error.code === "STATE_COMMIT_FAILED" &&
      error.details?.causeCode === "EIO",
  );

  const stopped = await fixture.coordinator.closed;
  assert.equal(stopped.reason, "state-commit-failed");
  assert.throws(
    () => fixture.coordinator.dispatch("inspect"),
    (error) => error.code === "COORDINATOR_STOPPING",
  );
  await assert.rejects(
    connectedClient.request("inspect"),
    (error) => error.code === "CONNECTION_CLOSED",
  );
  await assert.rejects(connectCoordinator({ root: fixture.root }), (error) =>
    ["ECONNREFUSED", "ENOENT"].includes(error.code),
  );

  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-coordinator-recovery-start",
    },
  });
  const recovered = await status(fixture);
  assert.equal(recovered.activeRequestCount, 1);
  assert.equal(recovered.requests[0].requestId, "durable-bound-request");
  assert.deepEqual(
    await rpc(fixture, "request-status", {
      requestId: "failed-journal-request",
      owner: requestOwner,
    }),
    { found: false },
  );
});

test("bound cleanup stops after its first journal commit failure", async () => {
  let failNextJournalCommit = false;
  const fixture = await createFixture({
    journalWriter(path, value) {
      if (failNextJournalCommit) {
        failNextJournalCommit = false;
        const error = new Error("injected bound cleanup journal failure");
        error.code = "EIO";
        throw error;
      }
      writeAtomicJson(path, value);
    },
  });
  const client = await connectCoordinator({ root: fixture.root });
  const boundRequests = [
    ["bound-cleanup-first", owner(212)],
    ["bound-cleanup-second", owner(213)],
  ];
  for (const [requestId, requestOwner] of boundRequests) {
    await client.request("register", {
      requestId,
      capability: capabilityFor(requestId),
      fingerprint: `${requestId}-fingerprint`,
      worktreeKey: `/tmp/${requestId}`,
      drainIdentity: runToken(requestId, 212, 1_770_000_000),
      owner: requestOwner,
      successMaxAgeMs: 0,
      bindConnection: true,
    });
    const granted = await client.request("request-lease", {
      requestId,
      leaseId: `${requestId}-lease`,
      drainIdentity: runToken(
        `${requestId}-lease`,
        requestOwner.pid,
        1_770_000_000,
      ),
      capability: capabilityFor(requestId),
      owner: requestOwner,
      weight: 1,
      resources: [],
    });
    assert.equal(granted.status, "granted");
  }
  const journalPath = join(fixture.coordinator.stateRoot, "journal.json");
  const durableBeforeDisconnect = readFileSync(journalPath, "utf8");

  failNextJournalCommit = true;
  client.destroy();
  assert.equal(
    (await fixture.coordinator.closed).reason,
    "state-commit-failed",
  );
  assert.equal(readFileSync(journalPath, "utf8"), durableBeforeDisconnect);

  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-bound-cleanup-recovery-start",
    },
  });
  const recovered = await status(fixture);
  assert.equal(recovered.leases.length, 2);
  assert.equal(recovered.drainObligations.length, 2);
  assert.ok(recovered.leases.every((item) => item.status === "drain-required"));
  assert.ok(recovered.requests.every((item) => item.resultReady === false));
});

test("restart completes a drain whose terminal journal commit failed", async () => {
  let failNextJournalCommit = false;
  const fixture = await createFixture({
    capacity: 1,
    journalWriter(path, value) {
      if (failNextJournalCommit) {
        failNextJournalCommit = false;
        const error = new Error("injected terminal journal failure");
        error.code = "EIO";
        throw error;
      }
      writeAtomicJson(path, value);
    },
  });
  const requestOwner = owner(222);
  const drainer = owner(223);
  const fingerprint = "terminal-commit-recovery-fingerprint";
  await register(
    fixture,
    "terminal-commit-recovery",
    fingerprint,
    requestOwner,
  );
  await lease(
    fixture,
    "terminal-commit-recovery",
    "terminal-commit-recovery-lease",
    requestOwner,
  );
  const stale = await markOwnerStale(fixture, {
    requestId: "terminal-commit-recovery",
    observedOwner: requestOwner,
    reporter: owner(224),
    reason: "terminal commit recovery test",
  });
  assert.equal(stale.drainObligations.length, 1);
  const [obligation] = stale.drainObligations;
  await claimObligation(fixture, obligation, drainer);

  failNextJournalCommit = true;
  assert.throws(
    () =>
      fixture.coordinator.dispatch("acknowledge-drain", {
        obligationId: obligation.obligationId,
        drainIdentity: obligation.drainIdentity,
        drainer,
        evidence: { processTreeEmpty: true },
      }),
    (error) => error.code === "STATE_COMMIT_FAILED",
  );
  assert.equal(
    (await fixture.coordinator.closed).reason,
    "state-commit-failed",
  );

  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    capacity: 1,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-terminal-commit-recovery-start",
    },
  });
  const recovered = await status(fixture);
  assert.equal(recovered.usedCapacity, 0);
  assert.equal(recovered.leases.length, 0);
  assert.equal(recovered.drainObligations.length, 0);
  const request = await rpc(fixture, "request-status", {
    requestId: "terminal-commit-recovery",
    owner: requestOwner,
  });
  assert.equal(request.state, "result-ready");
  assert.equal(request.result.status, "cancelled");
  assert.equal(request.result.fingerprint, fingerprint);
  await acknowledgeResult(fixture, request.requestId, requestOwner);
  assert.equal((await status(fixture)).activeRequestCount, 0);
});

test("result publication syncs each directory mutation before its journal commit", async () => {
  const events = [];
  const fixture = await createFixture({
    directorySync(path) {
      events.push({ type: "sync", path });
      syncDirectory(path);
    },
    journalWriter(path, value) {
      events.push({ type: "journal", path });
      writeAtomicJson(path, value);
    },
  });
  const requestOwner = owner(258);
  const fingerprint = "result-directory-sync-order-fingerprint";
  const registration = await register(
    fixture,
    "result-directory-sync-order",
    fingerprint,
    requestOwner,
  );
  const resultsDirectory = join(fixture.coordinator.stateRoot, "results");
  const resultDirectory = join(resultsDirectory, fingerprintHash(fingerprint));
  const journalPath = join(fixture.coordinator.stateRoot, "journal.json");

  events.length = 0;
  await rpc(fixture, "publish-result", {
    requestId: registration.requestId,
    owner: requestOwner,
    status: "success",
    payload: { orderedDurability: true },
  });

  assert.deepEqual(events, [
    { type: "sync", path: resultsDirectory },
    { type: "sync", path: resultDirectory },
    { type: "sync", path: resultDirectory },
    { type: "journal", path: journalPath },
  ]);
});

test("result directory sync failures stop publication before journal commit", async () => {
  for (const boundary of [
    {
      label: "hash-parent",
      path: "results",
      syncNumber: 1,
      finalLinkExists: false,
      stagingLinkRemains: false,
    },
    {
      label: "final-link",
      path: "result",
      syncNumber: 1,
      finalLinkExists: true,
      stagingLinkRemains: true,
    },
    {
      label: "staging-unlink",
      path: "result",
      syncNumber: 2,
      finalLinkExists: true,
      stagingLinkRemains: false,
    },
  ]) {
    let failurePath = null;
    let matchingDirectorySyncs = 0;
    const fixture = await createFixture({
      directorySync(path) {
        if (path === failurePath) {
          matchingDirectorySyncs += 1;
          if (matchingDirectorySyncs === boundary.syncNumber) {
            const error = new Error(
              `injected ${boundary.label} directory sync failure`,
            );
            error.code = "EIO";
            throw error;
          }
        }
        syncDirectory(path);
      },
    });
    const requestOwner = owner(262 + boundary.syncNumber);
    const requestId = `result-sync-failure-${boundary.label}`;
    const fingerprint = `${requestId}-fingerprint`;
    const registration = await register(
      fixture,
      requestId,
      fingerprint,
      requestOwner,
    );
    const resultDirectory = join(
      fixture.coordinator.stateRoot,
      "results",
      fingerprintHash(fingerprint),
    );
    const resultsDirectory = join(fixture.coordinator.stateRoot, "results");
    failurePath =
      boundary.path === "results" ? resultsDirectory : resultDirectory;
    const resultPath = join(
      resultDirectory,
      `${registration.executionId}.json`,
    );
    const journalPath = join(fixture.coordinator.stateRoot, "journal.json");
    const durableJournal = readFileSync(journalPath, "utf8");

    assert.throws(
      () =>
        fixture.coordinator.dispatch("publish-result", {
          requestId: registration.requestId,
          capability: capabilityFor(registration.requestId),
          owner: requestOwner,
          status: "success",
          payload: { failedSync: boundary.label },
        }),
      (error) =>
        error.code === "RESULT_COMMIT_FAILED" &&
        error.details?.causeCode === "EIO",
    );
    assert.equal(
      (await fixture.coordinator.closed).reason,
      "result-commit-failed",
    );

    const stagingNames = readdirSync(resultDirectory).filter((name) =>
      name.startsWith(`${registration.executionId}.json.staged-`),
    );
    assert.equal(existsSync(resultPath), boundary.finalLinkExists);
    assert.equal(stagingNames.length, boundary.stagingLinkRemains ? 1 : 0);
    if (boundary.finalLinkExists) {
      assert.equal(
        statSync(resultPath).nlink,
        boundary.stagingLinkRemains ? 2 : 1,
      );
    }
    assert.equal(readFileSync(journalPath, "utf8"), durableJournal);
  }
});

test("recovery repairs a persisted terminal result before its journal commit", async () => {
  let failAfterResultInstall = false;
  const fixture = await createFixture({
    resultWriter(path, value, equivalent) {
      const result = writeImmutable(path, value, equivalent);
      if (failAfterResultInstall) {
        failAfterResultInstall = false;
        const error = new Error("injected result directory sync failure");
        error.code = "EIO";
        throw error;
      }
      return result;
    },
  });
  const leaderOwner = owner(216);
  const followerOwner = owner(217);
  const fingerprint = "result-persistence-fingerprint";
  const leader = await register(
    fixture,
    "result-persistence-leader",
    fingerprint,
    leaderOwner,
  );
  const follower = await register(
    fixture,
    "result-persistence-follower",
    fingerprint,
    followerOwner,
  );
  const resultsDirectory = join(fixture.coordinator.stateRoot, "results");
  const resultDirectory = join(resultsDirectory, fingerprintHash(fingerprint));
  const journalPath = join(fixture.coordinator.stateRoot, "journal.json");
  const durableJournal = readFileSync(journalPath, "utf8");
  const waiter = await connectCoordinator({ root: fixture.root });
  const waitOutcome = waiter
    .request("wait-result", {
      requestId: follower.requestId,
      capability: capabilityFor(follower.requestId),
      owner: followerOwner,
      fingerprint,
      executionId: leader.executionId,
      timeoutMs: 2_000,
    })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  await waiter.request("ping");

  failAfterResultInstall = true;
  assert.throws(
    () =>
      fixture.coordinator.dispatch("publish-result", {
        requestId: leader.requestId,
        capability: capabilityFor(leader.requestId),
        owner: leaderOwner,
        status: "success",
        payload: { source: "result-persistence-regression" },
      }),
    (error) =>
      error.code === "RESULT_COMMIT_FAILED" &&
      error.details?.causeCode === "EIO",
  );
  const waited = await waitOutcome;
  assert.equal(waited.value, undefined);
  assert.ok(
    ["CONNECTION_CLOSED", "COORDINATOR_STOPPING"].includes(waited.error?.code),
  );
  assert.equal(
    (await fixture.coordinator.closed).reason,
    "result-commit-failed",
  );
  assert.equal(readFileSync(journalPath, "utf8"), durableJournal);
  waiter.destroy();

  let failedRecoveryJournalCommit = false;
  await assert.rejects(
    startCoordinator({
      root: fixture.root,
      idleMs: 30_000,
      ownerSweepMs: 0,
      coordinatorIdentity: {
        pid: process.pid,
        startUtc: "test-result-persistence-failed-recovery-start",
      },
      directorySync(path) {
        if (path === resultDirectory) {
          const error = new Error("injected recovery directory sync failure");
          error.code = "EIO";
          throw error;
        }
        syncDirectory(path);
      },
      journalWriter(path, value) {
        failedRecoveryJournalCommit = true;
        writeAtomicJson(path, value);
      },
    }),
    (error) => error.code === "EIO",
  );
  assert.equal(failedRecoveryJournalCommit, false);
  assert.equal(readFileSync(journalPath, "utf8"), durableJournal);

  const recoveryEvents = [];
  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-result-persistence-recovery-start",
    },
    directorySync(path) {
      recoveryEvents.push({ type: "sync", path });
      syncDirectory(path);
    },
    journalWriter(path, value) {
      recoveryEvents.push({ type: "journal", path });
      writeAtomicJson(path, value);
    },
  });
  assert.deepEqual(recoveryEvents, [
    { type: "sync", path: resultDirectory },
    { type: "sync", path: resultsDirectory },
    { type: "journal", path: journalPath },
  ]);
  for (const [requestId, requestOwner] of [
    [leader.requestId, leaderOwner],
    [follower.requestId, followerOwner],
  ]) {
    const request = await rpc(fixture, "request-status", {
      requestId,
      owner: requestOwner,
    });
    assert.equal(request.state, "result-ready");
    assert.equal(request.result.status, "success");
    await acknowledgeResult(fixture, requestId, requestOwner);
  }
  assert.equal((await status(fixture)).activeRequestCount, 0);
});

test("immutable result conflicts reject payload and ordered follower changes", async () => {
  const variants = [
    {
      label: "payload",
      change(record) {
        return { ...record, payload: { persisted: "different" } };
      },
    },
    {
      label: "follower-membership",
      change(record) {
        return {
          ...record,
          followerRequestIds: record.followerRequestIds.slice(0, 1),
        };
      },
    },
    {
      label: "follower-order",
      change(record) {
        return {
          ...record,
          followerRequestIds: [...record.followerRequestIds].reverse(),
        };
      },
    },
  ];

  for (const [index, variant] of variants.entries()) {
    const fixture = await createFixture();
    const leaderOwner = owner(230 + index * 3);
    const followerOwners = [owner(231 + index * 3), owner(232 + index * 3)];
    const fingerprint = `immutable-conflict-${variant.label}`;
    const leader = await register(
      fixture,
      `${variant.label}-leader`,
      fingerprint,
      leaderOwner,
    );
    const followers = [];
    for (const [followerIndex, followerOwner] of followerOwners.entries()) {
      followers.push(
        await register(
          fixture,
          `${variant.label}-follower-${followerIndex}`,
          fingerprint,
          followerOwner,
        ),
      );
    }
    const hash = fingerprintHash(fingerprint);
    const resultPath = join(
      fixture.coordinator.stateRoot,
      "results",
      hash,
      `${leader.executionId}.json`,
    );
    const expectedPayload = { persisted: "expected" };
    const expectedRecord = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      protocol: { ...PROTOCOL_VERSION },
      policyHash: DEFAULT_POLICY_HASH,
      fingerprint,
      fingerprintHash: hash,
      executionId: leader.executionId,
      leaderRequestId: leader.requestId,
      followerRequestIds: followers.map((follower) => follower.requestId),
      status: "success",
      payload: expectedPayload,
      completedAt: "2026-08-21T10:00:00.000Z",
    };
    const conflictingRecord = variant.change(expectedRecord);
    writeImmutable(resultPath, conflictingRecord, () => false);

    assert.throws(
      () =>
        fixture.coordinator.dispatch("publish-result", {
          requestId: leader.requestId,
          capability: capabilityFor(leader.requestId),
          owner: leaderOwner,
          status: "success",
          payload: expectedPayload,
        }),
      (error) =>
        error.code === "RESULT_COMMIT_FAILED" &&
        error.details?.causeCode === "IMMUTABLE_RECORD_CONFLICT",
    );
    assert.equal(
      (await fixture.coordinator.closed).reason,
      "result-commit-failed",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(resultPath, "utf8")),
      conflictingRecord,
    );
    const journal = JSON.parse(
      readFileSync(join(fixture.coordinator.stateRoot, "journal.json"), "utf8"),
    );
    for (const requestId of [
      leader.requestId,
      ...followers.map((follower) => follower.requestId),
    ]) {
      assert.equal(journal.requests[requestId].resultReady, false);
    }
    assert.ok(journal.singleflights[hash]);
    assert.equal(journal.successIndex[hash], undefined);
  }
});

test("immutable publish rejects a parseable noncanonical completion time", async () => {
  const fixture = await createFixture({
    now: () => Date.parse("2026-08-21T12:00:00.000Z"),
  });
  const requestOwner = owner(251);
  const fingerprint = "immutable-noncanonical-completion";
  const leader = await register(
    fixture,
    "immutable-noncanonical-leader",
    fingerprint,
    requestOwner,
  );
  const hash = fingerprintHash(fingerprint);
  const resultPath = join(
    fixture.coordinator.stateRoot,
    "results",
    hash,
    `${leader.executionId}.json`,
  );
  const persistedRecord = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    protocol: { ...PROTOCOL_VERSION },
    policyHash: DEFAULT_POLICY_HASH,
    fingerprint,
    fingerprintHash: hash,
    executionId: leader.executionId,
    leaderRequestId: leader.requestId,
    followerRequestIds: [],
    status: "success",
    payload: { source: "persisted" },
    completedAt: "2026-08-21 12:00:00Z",
  };
  writeImmutable(resultPath, persistedRecord, () => false);
  const journalPath = join(fixture.coordinator.stateRoot, "journal.json");
  const journalBytes = readFileSync(journalPath, "utf8");

  assert.throws(
    () =>
      fixture.coordinator.dispatch("publish-result", {
        requestId: leader.requestId,
        capability: capabilityFor(leader.requestId),
        owner: requestOwner,
        status: "success",
        payload: persistedRecord.payload,
      }),
    (error) => {
      assert.equal(error.code, "RESULT_COMMIT_FAILED");
      assert.equal(error.cause?.path, "result.completedAt");
      return true;
    },
  );
  assert.equal(
    (await fixture.coordinator.closed).reason,
    "result-commit-failed",
  );
  assert.equal(readFileSync(journalPath, "utf8"), journalBytes);
  assert.deepEqual(
    JSON.parse(readFileSync(resultPath, "utf8")),
    persistedRecord,
  );
});

test("equivalent immutable result reuse returns the exact persisted record", async () => {
  const fixture = await createFixture({
    now: () => Date.parse("2026-08-21T12:00:00.000Z"),
  });
  const leaderOwner = owner(245);
  const followerOwners = [owner(246), owner(247)];
  const fingerprint = "immutable-equivalent-result";
  const leader = await register(
    fixture,
    "immutable-equivalent-leader",
    fingerprint,
    leaderOwner,
  );
  const followers = [];
  for (const [index, followerOwner] of followerOwners.entries()) {
    followers.push(
      await register(
        fixture,
        `immutable-equivalent-follower-${index}`,
        fingerprint,
        followerOwner,
      ),
    );
  }
  const hash = fingerprintHash(fingerprint);
  const resultPath = join(
    fixture.coordinator.stateRoot,
    "results",
    hash,
    `${leader.executionId}.json`,
  );
  const payload = { source: "persisted", nested: { first: 1, second: 2 } };
  const persistedRecord = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    protocol: { ...PROTOCOL_VERSION },
    policyHash: DEFAULT_POLICY_HASH,
    fingerprint,
    fingerprintHash: hash,
    executionId: leader.executionId,
    leaderRequestId: leader.requestId,
    followerRequestIds: followers.map((follower) => follower.requestId),
    status: "success",
    payload,
    completedAt: "2026-08-21T11:00:00.000Z",
  };
  writeImmutable(resultPath, persistedRecord, () => false);
  const persistedBytes = readFileSync(resultPath, "utf8");
  let emittedResult = null;
  fixture.coordinator.core.once("result", (result) => {
    emittedResult = result;
  });

  const publication = fixture.coordinator.dispatch("publish-result", {
    requestId: leader.requestId,
    capability: capabilityFor(leader.requestId),
    owner: leaderOwner,
    status: "success",
    payload,
  });
  assert.deepEqual(publication.result, persistedRecord);
  assert.deepEqual(emittedResult, persistedRecord);
  assert.equal(readFileSync(resultPath, "utf8"), persistedBytes);
  const journal = JSON.parse(
    readFileSync(join(fixture.coordinator.stateRoot, "journal.json"), "utf8"),
  );
  assert.deepEqual(journal.successIndex[hash], {
    executionId: leader.executionId,
    completedAt: persistedRecord.completedAt,
  });
  for (const [requestId, requestOwner] of [
    [leader.requestId, leaderOwner],
    ...followers.map((follower, index) => [
      follower.requestId,
      followerOwners[index],
    ]),
  ]) {
    const request = await rpc(fixture, "request-status", {
      requestId,
      owner: requestOwner,
    });
    assert.deepEqual(request.result, persistedRecord);
  }
});

test("run tokens use the shared Bash-compatible bounded shape", async () => {
  const fixture = await createFixture();
  const requestOwner = owner(218);
  const longestValid = `${"a".repeat(181)}-1234567890-123456789012`;
  const registration = await register(
    fixture,
    "long-run-token",
    "long-run-token-fp",
    requestOwner,
    { drainIdentity: longestValid },
  );
  assert.equal(registration.drainIdentity, longestValid);
  for (const [requestId, drainIdentity] of [
    ["slash-run-token", "bad/token-1-1"],
    ["dash-run-token", "-bad-1-1"],
  ]) {
    await assert.rejects(
      register(fixture, requestId, `${requestId}-fp`, owner(219), {
        drainIdentity,
      }),
      (error) => error.code === "INVALID_ARGUMENT",
    );
  }
});

test("lease retries preserve their effective scheduling identity", async () => {
  const fixture = await createFixture({ capacity: 3 });
  const requestOwner = owner(232);
  await register(fixture, "lease-retry", "lease-retry-fp", requestOwner);
  const first = await lease(
    fixture,
    "lease-retry",
    "lease-retry-id",
    requestOwner,
    {
      weight: 2,
      resources: ["retry-b", "retry-a", "retry-a"],
      command: "first-write-metadata",
    },
  );
  const retry = await lease(
    fixture,
    "lease-retry",
    "lease-retry-id",
    requestOwner,
    {
      weight: 2,
      resources: ["retry-a", "retry-b"],
      command: "ignored-retry-metadata",
    },
  );
  assert.equal(retry.sequence, first.sequence);
  assert.equal(retry.status, first.status);
  assert.deepEqual(retry.resources, ["retry-a", "retry-b"]);

  for (const options of [
    { weight: 1, resources: ["retry-a", "retry-b"] },
    { weight: 2, allCapacity: true, resources: ["retry-a", "retry-b"] },
    { weight: 2, resources: ["retry-a", "retry-c"] },
  ]) {
    await assert.rejects(
      lease(fixture, "lease-retry", "lease-retry-id", requestOwner, options),
      (error) => error.code === "LEASE_ID_CONFLICT",
    );
  }

  const snapshot = await status(fixture);
  assert.equal(snapshot.leases.length, 1);
  assert.equal(snapshot.leases[0].metadata.command, "first-write-metadata");
});

test("request-level round robin prevents one request from taking every turn", async () => {
  const fixture = await createFixture({ capacity: 1 });
  const firstOwner = owner(101);
  const secondOwner = owner(102);
  await register(fixture, "request-a", "fingerprint-a", firstOwner);
  await register(fixture, "request-b", "fingerprint-b", secondOwner);

  assert.equal(
    (await lease(fixture, "request-a", "a-1", firstOwner)).status,
    "granted",
  );
  assert.equal(
    (await lease(fixture, "request-a", "a-2", firstOwner)).status,
    "queued",
  );
  assert.equal(
    (await lease(fixture, "request-b", "b-1", secondOwner)).status,
    "queued",
  );

  await release(fixture, "request-a", "a-1", firstOwner);
  let snapshot = await status(fixture);
  assert.equal(
    snapshot.leases.find((candidate) => candidate.leaseId === "b-1").status,
    "granted",
  );
  assert.equal(
    snapshot.leases.find((candidate) => candidate.leaseId === "a-2").status,
    "queued",
  );

  await release(fixture, "request-b", "b-1", secondOwner);
  snapshot = await status(fixture);
  assert.equal(
    snapshot.leases.find((candidate) => candidate.leaseId === "a-2").status,
    "granted",
  );
  assertWithinCapacity(snapshot);
});

test("weighted leases never exceed configured capacity", async () => {
  const fixture = await createFixture({ capacity: 3 });
  const owners = [owner(111), owner(112), owner(113)];
  for (let index = 0; index < owners.length; index += 1) {
    await register(
      fixture,
      `capacity-${index}`,
      `capacity-fingerprint-${index}`,
      owners[index],
    );
  }

  assert.equal(
    (
      await lease(fixture, "capacity-0", "capacity-lease-0", owners[0], {
        weight: 2,
      })
    ).status,
    "granted",
  );
  assert.equal(
    (
      await lease(fixture, "capacity-1", "capacity-lease-1", owners[1], {
        weight: 1,
      })
    ).status,
    "granted",
  );
  assert.equal(
    (
      await lease(fixture, "capacity-2", "capacity-lease-2", owners[2], {
        weight: 1,
      })
    ).status,
    "queued",
  );

  let snapshot = await status(fixture);
  assert.equal(snapshot.usedCapacity, 3);
  assertWithinCapacity(snapshot);
  const queued = snapshot.leases.find(
    (candidate) => candidate.leaseId === "capacity-lease-2",
  );
  assert.ok(queued.blockers.some((blocker) => blocker.type === "capacity"));

  await release(fixture, "capacity-0", "capacity-lease-0", owners[0]);
  snapshot = await status(fixture);
  assert.equal(
    snapshot.leases.find(
      (candidate) => candidate.leaseId === "capacity-lease-2",
    ).status,
    "granted",
  );
  assertWithinCapacity(snapshot);
});

test("a weighted head lease reserves capacity under continuous light churn", async () => {
  const fixture = await createFixture({ capacity: 3 });
  const lightOwners = [owner(211), owner(212), owner(213)];
  const requestIds = ["churn-a", "churn-b", "churn-c"];
  for (let index = 0; index < requestIds.length; index += 1) {
    await register(
      fixture,
      requestIds[index],
      `${requestIds[index]}-fingerprint`,
      lightOwners[index],
    );
  }
  const heavyOwner = owner(214);
  await register(fixture, "weighted-head", "weighted-head-fp", heavyOwner);
  const active = [];
  for (let index = 0; index < requestIds.length; index += 1) {
    active[index] = `${requestIds[index]}-0`;
    assert.equal(
      (
        await lease(
          fixture,
          requestIds[index],
          active[index],
          lightOwners[index],
        )
      ).status,
      "granted",
    );
  }
  assert.equal(
    (
      await lease(fixture, "weighted-head", "weighted-head-lease", heavyOwner, {
        weight: 2,
      })
    ).status,
    "queued",
  );
  let snapshot = await status(fixture);
  assert.equal(snapshot.weightedCapacityBarrier.leaseId, "weighted-head-lease");

  let grantedCycle = null;
  for (let cycle = 1; cycle <= 100; cycle += 1) {
    const index = (cycle - 1) % requestIds.length;
    const replacement = `${requestIds[index]}-${cycle}`;
    await lease(fixture, requestIds[index], replacement, lightOwners[index]);
    await release(
      fixture,
      requestIds[index],
      active[index],
      lightOwners[index],
    );
    snapshot = await status(fixture);
    if (
      snapshot.leases.find(
        (candidate) => candidate.leaseId === "weighted-head-lease",
      ).status === "granted"
    ) {
      grantedCycle = cycle;
      break;
    }
    const replacementState = snapshot.leases.find(
      (candidate) => candidate.leaseId === replacement,
    );
    if (replacementState.status === "granted") active[index] = replacement;
    else {
      assert.equal(replacementState.status, "queued");
      assert.ok(
        replacementState.blockers.some(
          (blocker) => blocker.type === "weighted-capacity-reservation",
        ),
      );
    }
  }
  assert.ok(
    grantedCycle !== null,
    "weighted lease starved for 100 churn cycles",
  );
  assert.ok(
    grantedCycle <= 2,
    `capacity did not drain promptly: ${grantedCycle}`,
  );
  assertWithinCapacity(snapshot);
});

test("a weighted resource lease reserves capacity while its resource is held", async () => {
  const fixture = await createFixture({ capacity: 3 });
  const holderOwner = owner(215);
  const weightedOwner = owner(216);
  const youngerOwner = owner(217);
  await register(fixture, "resource-holder", "resource-holder-fp", holderOwner);
  await register(
    fixture,
    "resource-weighted",
    "resource-weighted-fp",
    weightedOwner,
  );
  await register(
    fixture,
    "resource-younger",
    "resource-younger-fp",
    youngerOwner,
  );
  await lease(
    fixture,
    "resource-holder",
    "resource-holder-lease",
    holderOwner,
    { resources: ["shared-resource"] },
  );
  assert.equal(
    (
      await lease(
        fixture,
        "resource-weighted",
        "resource-weighted-lease",
        weightedOwner,
        { weight: 2, resources: ["shared-resource"] },
      )
    ).status,
    "queued",
  );
  assert.equal(
    (
      await lease(
        fixture,
        "resource-younger",
        "resource-younger-lease",
        youngerOwner,
      )
    ).status,
    "queued",
  );
  let snapshot = await status(fixture);
  assert.equal(
    snapshot.weightedCapacityBarrier.leaseId,
    "resource-weighted-lease",
  );
  assert.ok(
    snapshot.leases
      .find((candidate) => candidate.leaseId === "resource-younger-lease")
      .blockers.some(
        (blocker) => blocker.type === "weighted-capacity-reservation",
      ),
  );

  await release(
    fixture,
    "resource-holder",
    "resource-holder-lease",
    holderOwner,
  );
  snapshot = await status(fixture);
  assert.equal(
    snapshot.leases.find(
      (candidate) => candidate.leaseId === "resource-weighted-lease",
    ).status,
    "granted",
  );
  assertWithinCapacity(snapshot);
});

test("a grantable weighted lease bypasses older resource-blocked light leases", async () => {
  const fixture = await createFixture({ capacity: 3 });
  const holderOwner = owner(218);
  const firstLightOwner = owner(219);
  const secondLightOwner = owner(220);
  const weightedOwner = owner(221);
  await register(fixture, "blocked-holder", "blocked-holder-fp", holderOwner);
  await register(
    fixture,
    "blocked-light-a",
    "blocked-light-a-fp",
    firstLightOwner,
  );
  await register(
    fixture,
    "blocked-light-b",
    "blocked-light-b-fp",
    secondLightOwner,
  );
  await register(
    fixture,
    "grantable-weighted",
    "grantable-weighted-fp",
    weightedOwner,
  );
  await lease(fixture, "blocked-holder", "blocked-holder-lease", holderOwner, {
    resources: ["blocked-resource-a", "blocked-resource-b"],
  });
  assert.equal(
    (
      await lease(
        fixture,
        "blocked-light-a",
        "blocked-light-a-lease",
        firstLightOwner,
        { resources: ["blocked-resource-a"] },
      )
    ).status,
    "queued",
  );
  assert.equal(
    (
      await lease(
        fixture,
        "blocked-light-b",
        "blocked-light-b-lease",
        secondLightOwner,
        { resources: ["blocked-resource-b"] },
      )
    ).status,
    "queued",
  );

  assert.equal(
    (
      await lease(
        fixture,
        "grantable-weighted",
        "grantable-weighted-lease",
        weightedOwner,
        { weight: 2 },
      )
    ).status,
    "granted",
  );
  const snapshot = await status(fixture);
  assert.equal(snapshot.capacity, 3);
  assert.equal(snapshot.usedCapacity, 3);
  for (const leaseId of ["blocked-light-a-lease", "blocked-light-b-lease"]) {
    const blocked = snapshot.leases.find(
      (candidate) => candidate.leaseId === leaseId,
    );
    assert.equal(blocked.status, "queued");
    assert.ok(blocked.blockers.some((blocker) => blocker.type === "resource"));
  }
  assertWithinCapacity(snapshot);
});

test("a pre-command abandon removes a grant won during a timeout race", async () => {
  const fixture = await createFixture({ capacity: 1 });
  const holderOwner = owner(221);
  const timedOutOwner = owner(222);
  const nextOwner = owner(223);
  await register(fixture, "timeout-holder", "timeout-holder-fp", holderOwner);
  await register(fixture, "timeout-race", "timeout-race-fp", timedOutOwner);
  await register(fixture, "timeout-next", "timeout-next-fp", nextOwner);
  await lease(fixture, "timeout-holder", "timeout-holder-lease", holderOwner);
  await lease(fixture, "timeout-race", "timeout-race-lease", timedOutOwner, {
    allCapacity: true,
  });
  await lease(fixture, "timeout-next", "timeout-next-lease", nextOwner);
  await release(fixture, "timeout-holder", "timeout-holder-lease", holderOwner);
  assert.equal(
    (await status(fixture)).leases.find(
      (candidate) => candidate.leaseId === "timeout-race-lease",
    ).status,
    "granted",
  );
  await assert.rejects(
    rpc(fixture, "abandon-lease", {
      requestId: "timeout-race",
      leaseId: "timeout-race-lease",
      owner: timedOutOwner,
      commandStarted: true,
    }),
    (error) => error.code === "COMMAND_START_STATE_REQUIRED",
  );
  const abandoned = await rpc(fixture, "abandon-lease", {
    requestId: "timeout-race",
    leaseId: "timeout-race-lease",
    owner: timedOutOwner,
    commandStarted: false,
  });
  assert.equal(abandoned.previousStatus, "granted");
  const snapshot = await status(fixture);
  assert.equal(
    snapshot.leases.find(
      (candidate) => candidate.leaseId === "timeout-next-lease",
    ).status,
    "granted",
  );
  assertWithinCapacity(snapshot);
});

test("an all-capacity barrier blocks younger light work until it runs", async () => {
  const fixture = await createFixture({ capacity: 3 });
  const activeOwner = owner(121);
  const barrierOwner = owner(122);
  const lightOwner = owner(123);
  await register(fixture, "active", "active-fingerprint", activeOwner);
  await register(fixture, "barrier", "barrier-fingerprint", barrierOwner);
  await register(fixture, "light", "light-fingerprint", lightOwner);

  await lease(fixture, "active", "active-lease", activeOwner);
  const barrier = await lease(
    fixture,
    "barrier",
    "exclusive-lease",
    barrierOwner,
    { allCapacity: true },
  );
  assert.equal(barrier.status, "queued");
  const light = await lease(fixture, "light", "light-lease", lightOwner);
  assert.equal(light.status, "queued");
  assert.ok(
    light.blockers.some((blocker) => blocker.type === "all-capacity-barrier"),
  );

  await release(fixture, "active", "active-lease", activeOwner);
  let snapshot = await status(fixture);
  assert.equal(snapshot.usedCapacity, 3);
  assert.equal(snapshot.allCapacityBarrier, null);
  assert.equal(
    snapshot.leases.find((candidate) => candidate.leaseId === "exclusive-lease")
      .status,
    "granted",
  );
  assert.equal(
    snapshot.leases.find((candidate) => candidate.leaseId === "light-lease")
      .status,
    "queued",
  );

  await release(fixture, "barrier", "exclusive-lease", barrierOwner);
  snapshot = await status(fixture);
  assert.equal(
    snapshot.leases.find((candidate) => candidate.leaseId === "light-lease")
      .status,
    "granted",
  );
  assertWithinCapacity(snapshot);
});

test("a capacity-one barrier activates only at its request head", async () => {
  const fixture = await createFixture({ capacity: 1 });
  const holderOwner = owner(215);
  const barrierOwner = owner(216);
  const youngerOwner = owner(217);
  await register(fixture, "edge-holder", "edge-holder-fp", holderOwner);
  await register(fixture, "edge-barrier", "edge-barrier-fp", barrierOwner);
  await register(fixture, "edge-younger", "edge-younger-fp", youngerOwner);
  await lease(fixture, "edge-holder", "edge-holder-lease", holderOwner);
  await lease(fixture, "edge-barrier", "edge-predecessor", barrierOwner);
  await lease(fixture, "edge-barrier", "edge-exclusive", barrierOwner, {
    allCapacity: true,
  });
  await lease(fixture, "edge-younger", "edge-younger-lease", youngerOwner);

  let snapshot = await status(fixture);
  assert.equal(snapshot.allCapacityBarrier, null);
  assert.equal(snapshot.weightedCapacityBarrier, null);
  await release(fixture, "edge-holder", "edge-holder-lease", holderOwner);
  snapshot = await status(fixture);
  assert.equal(
    snapshot.leases.find(
      (candidate) => candidate.leaseId === "edge-predecessor",
    ).status,
    "granted",
  );
  assert.equal(snapshot.allCapacityBarrier.leaseId, "edge-exclusive");
  assert.equal(snapshot.weightedCapacityBarrier.leaseId, "edge-exclusive");
  assert.ok(
    snapshot.leases
      .find((candidate) => candidate.leaseId === "edge-younger-lease")
      .blockers.some((blocker) => blocker.type === "all-capacity-barrier"),
  );
  await release(fixture, "edge-barrier", "edge-predecessor", barrierOwner);
  snapshot = await status(fixture);
  assert.equal(
    snapshot.leases.find((candidate) => candidate.leaseId === "edge-exclusive")
      .status,
    "granted",
  );
});

test("named mutex resources are granted atomically", async () => {
  const fixture = await createFixture({ capacity: 3 });
  const databaseOwner = owner(131);
  const combinedOwner = owner(132);
  const browserOwner = owner(133);
  await register(fixture, "database", "database-fingerprint", databaseOwner);
  await register(fixture, "combined", "combined-fingerprint", combinedOwner);
  await register(fixture, "browser", "browser-fingerprint", browserOwner);

  await lease(fixture, "database", "database-lease", databaseOwner, {
    resources: ["database"],
  });
  const combined = await lease(
    fixture,
    "combined",
    "combined-lease",
    combinedOwner,
    { weight: 2, resources: ["browser-fixture-3211", "database"] },
  );
  assert.equal(combined.status, "queued");
  const browser = await lease(
    fixture,
    "browser",
    "browser-lease",
    browserOwner,
    { resources: ["browser-fixture-3211"] },
  );
  assert.equal(browser.status, "queued");

  let snapshot = await status(fixture);
  const combinedState = snapshot.leases.find(
    (candidate) => candidate.leaseId === "combined-lease",
  );
  assert.equal(combinedState.status, "queued");
  assert.deepEqual(
    combinedState.blockers
      .filter((blocker) => blocker.type === "resource")
      .map((blocker) => blocker.resource)
      .sort(),
    ["database"],
  );
  const browserState = snapshot.leases.find(
    (candidate) => candidate.leaseId === "browser-lease",
  );
  assert.equal(browserState.status, "queued");
  assert.ok(
    browserState.blockers.some(
      (blocker) => blocker.type === "weighted-capacity-reservation",
    ),
  );
  assertWithinCapacity(snapshot);

  await release(fixture, "database", "database-lease", databaseOwner);
  snapshot = await status(fixture);
  assert.equal(
    snapshot.leases.find((candidate) => candidate.leaseId === "combined-lease")
      .status,
    "granted",
  );
  assert.equal(
    snapshot.leases.find((candidate) => candidate.leaseId === "browser-lease")
      .status,
    "queued",
  );
  await release(fixture, "combined", "combined-lease", combinedOwner);
  snapshot = await status(fixture);
  assert.equal(
    snapshot.leases.find((candidate) => candidate.leaseId === "browser-lease")
      .status,
    "granted",
  );
  assert.equal(snapshot.usedCapacity, 1);
});

test("one worktree admission is held for the full request", async () => {
  const fixture = await createFixture();
  const firstOwner = owner(134);
  const secondOwner = owner(135);
  const worktreeKey = "/tmp/shared-worktree";
  const first = await register(
    fixture,
    "worktree-first",
    "worktree-first-fingerprint",
    firstOwner,
    { worktreeKey },
  );
  const second = await register(
    fixture,
    "worktree-second",
    "worktree-second-fingerprint",
    secondOwner,
    { worktreeKey },
  );
  assert.equal(first.admission, "held");
  assert.equal(second.admission, "queued");
  assert.equal(second.worktreeBlocker, first.requestId);
  assert.ok(second.sequence > first.sequence);

  const waiter = await connectCoordinator({ root: fixture.root });
  const admittedPromise = waiter.request("wait-admission", {
    requestId: second.requestId,
    capability: capabilityFor(second.requestId),
    owner: secondOwner,
    timeoutMs: 2_000,
  });
  let admittedSettled = false;
  admittedPromise.finally(() => {
    admittedSettled = true;
  });
  await rpc(fixture, "publish-result", {
    requestId: first.requestId,
    owner: firstOwner,
    status: "success",
    payload: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(admittedSettled, false);
  let snapshot = await status(fixture);
  assert.equal(
    snapshot.requests.find((request) => request.requestId === first.requestId)
      .state,
    "result-ready",
  );
  assert.equal(
    snapshot.requests.find((request) => request.requestId === second.requestId)
      .admission,
    "queued",
  );
  await acknowledgeResult(fixture, first.requestId, firstOwner);
  const admitted = await admittedPromise;
  assert.equal(admitted.admission, "held");
  assert.equal(admitted.state, "active");
  await waiter.close();
  await rpc(fixture, "cancel-request", {
    requestId: second.requestId,
    owner: secondOwner,
    reason: "test cleanup",
  });
  await acknowledgeResult(fixture, second.requestId, secondOwner);
  snapshot = await status(fixture);
  assert.equal(snapshot.activeRequestCount, 0);
});

test("success reuse is explicit, bounded, and rejects a future completion", async () => {
  let clock = Date.parse("2026-08-21T12:00:00.000Z");
  const fixture = await createFixture({ now: () => clock });
  const firstOwner = owner(136);
  const first = await register(
    fixture,
    "reuse-first",
    "reuse-fingerprint",
    firstOwner,
  );
  await rpc(fixture, "publish-result", {
    requestId: first.requestId,
    owner: firstOwner,
    status: "success",
    payload: { exactHead: true },
  });
  await acknowledgeResult(fixture, first.requestId, firstOwner);

  clock += 500;
  const cached = await register(
    fixture,
    "reuse-cached",
    "reuse-fingerprint",
    owner(137),
    { successMaxAgeMs: 1_000 },
  );
  assert.equal(cached.role, "completed");
  assert.equal(cached.result.executionId, first.executionId);
  await acknowledgeResult(fixture, cached.requestId, owner(137));

  const forcedFailureOwner = owner(230);
  const forcedFailure = await register(
    fixture,
    "reuse-forced-failure",
    "reuse-fingerprint",
    forcedFailureOwner,
  );
  assert.equal(forcedFailure.role, "leader");
  const refreshFollowerOwner = owner(232);
  const refreshFollower = await register(
    fixture,
    "reuse-active-refresh-follower",
    "reuse-fingerprint",
    refreshFollowerOwner,
    { successMaxAgeMs: 1_000 },
  );
  assert.equal(refreshFollower.role, "follower");
  assert.equal(refreshFollower.executionId, forcedFailure.executionId);
  await rpc(fixture, "publish-result", {
    requestId: forcedFailure.requestId,
    owner: forcedFailureOwner,
    status: "failure",
    payload: { reason: "newer execution failed" },
  });
  const refreshResult = fixture.coordinator.core.readResult(
    "reuse-fingerprint",
    refreshFollower.executionId,
  );
  assert.equal(refreshResult.status, "failure");
  await acknowledgeResult(fixture, forcedFailure.requestId, forcedFailureOwner);
  await acknowledgeResult(
    fixture,
    refreshFollower.requestId,
    refreshFollowerOwner,
  );
  const afterFailureOwner = owner(231);
  const afterFailure = await register(
    fixture,
    "reuse-after-failure",
    "reuse-fingerprint",
    afterFailureOwner,
    { successMaxAgeMs: 1_000 },
  );
  assert.equal(afterFailure.role, "leader");
  await rpc(fixture, "cancel-request", {
    requestId: afterFailure.requestId,
    owner: afterFailureOwner,
    reason: "newer failure invalidates older success",
  });
  await acknowledgeResult(fixture, afterFailure.requestId, afterFailureOwner);

  clock -= 1_000;
  const afterRollback = await register(
    fixture,
    "reuse-rollback",
    "reuse-fingerprint",
    owner(138),
    { successMaxAgeMs: 1_000 },
  );
  assert.equal(afterRollback.role, "leader");
  await rpc(fixture, "cancel-request", {
    requestId: afterRollback.requestId,
    owner: owner(138),
    reason: "clock rollback must retry",
  });
  await acknowledgeResult(fixture, afterRollback.requestId, owner(138));

  clock += 3_000;
  const expired = await register(
    fixture,
    "reuse-expired",
    "reuse-fingerprint",
    owner(139),
    { successMaxAgeMs: 1_000 },
  );
  assert.equal(expired.role, "leader");
});

test("startup rejects a success index that differs from its retained result", async () => {
  let clock = Date.parse("2026-08-21T12:00:00.000Z");
  const fixture = await createFixture({ now: () => clock });
  const firstOwner = owner(252);
  const fingerprint = "reuse-index-completion-mismatch";
  const first = await register(
    fixture,
    "reuse-index-completion-first",
    fingerprint,
    firstOwner,
  );
  await rpc(fixture, "publish-result", {
    requestId: first.requestId,
    owner: firstOwner,
    status: "success",
    payload: { exactHead: true },
  });
  await acknowledgeResult(fixture, first.requestId, firstOwner);

  const journalPath = join(fixture.coordinator.stateRoot, "journal.json");
  await fixture.coordinator.close("success-index-mismatch-fixture-ready");
  fixture.coordinator = null;
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.successIndex[fingerprintHash(fingerprint)].completedAt =
    "2026-08-21T11:59:59.000Z";
  writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
  clock += 500;

  let reachedLegacyAdoption = false;
  await assert.rejects(
    startCoordinator({
      root: fixture.root,
      idleMs: 30_000,
      ownerSweepMs: 0,
      now: () => clock,
      coordinatorIdentity: {
        pid: process.pid,
        startUtc: "test-success-index-mismatch-start",
      },
      beforeLegacyAdopt: async () => {
        reachedLegacyAdoption = true;
      },
    }),
    (error) =>
      error.code === "RESULT_RECORD_INVALID" &&
      error.details?.path ===
        `successIndex.${fingerprintHash(fingerprint)}.completedAt`,
  );
  assert.equal(reachedLegacyAdoption, false);
  assert.equal(existsSync(socketPathForRoot(fixture.root)), false);
});

test("retention preserves active requests and two-hour terminal results", async () => {
  let clock = Date.parse("2026-08-21T13:00:00.000Z");
  const fixture = await createFixture({ now: () => clock });
  const activeOwner = owner(227);
  await register(fixture, "retained-active", "retained-active-fp", activeOwner);
  const terminal = [
    ["retained-success", "retained-success-fp", "success", owner(228)],
    ["retained-failure", "retained-failure-fp", "failure", owner(229)],
  ];
  for (const [requestId, fingerprint, resultStatus, requestOwner] of terminal) {
    await register(fixture, requestId, fingerprint, requestOwner);
    await rpc(fixture, "publish-result", {
      requestId,
      owner: requestOwner,
      status: resultStatus,
      payload: { retained: true },
    });
    await acknowledgeResult(fixture, requestId, requestOwner);
  }
  const requestPath = (requestId) =>
    join(fixture.coordinator.stateRoot, "requests", `${requestId}.json`);
  const resultPath = (requestId, fingerprint) =>
    join(
      fixture.coordinator.stateRoot,
      "results",
      fingerprintHash(fingerprint),
      `${requestId}.json`,
    );

  clock += RECORD_RETENTION_MS;
  fixture.coordinator.core.pruneRecords();
  assert.equal(existsSync(requestPath("retained-active")), true);
  assert.equal(existsSync(requestPath("retained-success")), false);
  assert.equal(existsSync(requestPath("retained-failure")), false);
  for (const [requestId, fingerprint] of terminal) {
    assert.equal(existsSync(resultPath(requestId, fingerprint)), true);
  }

  clock += 1;
  const pruned = fixture.coordinator.core.pruneRecords();
  assert.equal(pruned.resultRecords, 2);
  assert.equal(pruned.successIndexes, 1);
  assert.equal(existsSync(requestPath("retained-active")), true);
  for (const [requestId, fingerprint] of terminal) {
    assert.equal(existsSync(resultPath(requestId, fingerprint)), false);
  }
});

test("retention commits an expired success index before deleting its result", async () => {
  let clock = Date.parse("2026-08-21T13:15:00.000Z");
  let failNextJournalCommit = false;
  const fixture = await createFixture({
    now: () => clock,
    journalWriter(path, value) {
      if (failNextJournalCommit) {
        failNextJournalCommit = false;
        const error = new Error("injected retention journal failure");
        error.code = "EIO";
        throw error;
      }
      writeAtomicJson(path, value);
    },
  });
  const requestOwner = owner(255);
  const fingerprint = "retention-journal-order-fingerprint";
  const hash = fingerprintHash(fingerprint);
  const registration = await register(
    fixture,
    "retention-journal-order",
    fingerprint,
    requestOwner,
  );
  await rpc(fixture, "publish-result", {
    requestId: registration.requestId,
    owner: requestOwner,
    status: "success",
    payload: { retainedAcrossCommitFailure: true },
  });
  await acknowledgeResult(fixture, registration.requestId, requestOwner);
  const resultPath = join(
    fixture.coordinator.stateRoot,
    "results",
    hash,
    `${registration.executionId}.json`,
  );
  const journalPath = join(fixture.coordinator.stateRoot, "journal.json");
  const journalTemporary = atomicTemporaryPath(
    fixture.coordinator.stateRoot,
    "journal.json",
  );
  writeFileSync(journalTemporary, "partial journal bytes\n");
  setModifiedAt(journalTemporary, clock);

  clock += RECORD_RETENTION_MS + 1;
  failNextJournalCommit = true;
  assert.throws(
    () => fixture.coordinator.core.pruneRecords(),
    (error) =>
      error.code === "STATE_COMMIT_FAILED" &&
      error.details?.causeCode === "EIO",
  );
  assert.equal(
    (await fixture.coordinator.closed).reason,
    "state-commit-failed",
  );
  assert.equal(existsSync(resultPath), true);
  assert.equal(existsSync(journalTemporary), true);
  assert.ok(JSON.parse(readFileSync(journalPath, "utf8")).successIndex[hash]);

  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    idleMs: 30_000,
    ownerSweepMs: 0,
    now: () => clock,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-retention-journal-order-restart",
    },
  });
  assert.equal(existsSync(resultPath), false);
  assert.equal(existsSync(journalTemporary), false);
  assert.equal(
    JSON.parse(readFileSync(journalPath, "utf8")).successIndex[hash],
    undefined,
  );
});

test("retention removes only expired exact writer artifacts", async () => {
  const clock = Date.parse("2026-08-21T13:25:00.000Z");
  const fixture = await createFixture({ now: () => clock });
  const requestOwner = owner(257);
  const fingerprint = "retention-writer-artifact-fingerprint";
  const registration = await register(
    fixture,
    "retention-writer-artifact",
    fingerprint,
    requestOwner,
  );
  await rpc(fixture, "publish-result", {
    requestId: registration.requestId,
    owner: requestOwner,
    status: "success",
    payload: { canonicalResult: true },
  });
  await acknowledgeResult(fixture, registration.requestId, requestOwner);

  const stateRoot = fixture.coordinator.stateRoot;
  const requestsDirectory = join(stateRoot, "requests");
  const resultDirectory = join(
    stateRoot,
    "results",
    fingerprintHash(fingerprint),
  );
  const resultPath = join(resultDirectory, `${registration.executionId}.json`);
  const expiredAt = clock - RECORD_RETENTION_MS - 1;
  const journalTemporary = atomicTemporaryPath(stateRoot, "journal.json");
  const requestStaging = immutableStagingPath(
    requestsDirectory,
    "expired-request-stage",
  );
  const resultStaging = immutableStagingPath(
    resultDirectory,
    "expired-result-stage",
  );
  const boundaryStaging = immutableStagingPath(
    requestsDirectory,
    "boundary-request-stage",
  );
  const futureStaging = immutableStagingPath(
    requestsDirectory,
    "future-request-stage",
  );
  const nearMatch = join(
    resultDirectory,
    `near-match.json.staged-${process.pid}-00000000-0000-0000-0000-000000000000`,
  );
  const symlinkTarget = join(stateRoot, "staging-symlink-target");
  const symlinkStaging = immutableStagingPath(
    resultDirectory,
    "symlink-result-stage",
  );

  for (const path of [journalTemporary, requestStaging, nearMatch]) {
    writeFileSync(path, "partial writer bytes\n");
    setModifiedAt(path, expiredAt);
  }
  linkSync(resultPath, resultStaging);
  setModifiedAt(resultStaging, expiredAt);
  writeFileSync(boundaryStaging, "boundary writer bytes\n");
  setModifiedAt(boundaryStaging, clock - RECORD_RETENTION_MS);
  writeFileSync(futureStaging, "future writer bytes\n");
  setModifiedAt(futureStaging, clock + 1_000);
  writeFileSync(symlinkTarget, "symlink target\n");
  symlinkSync(symlinkTarget, symlinkStaging);

  const pruned = fixture.coordinator.core.pruneRecords();
  assert.equal(pruned.temporaryRecords, 3);
  for (const path of [journalTemporary, requestStaging, resultStaging]) {
    assert.equal(existsSync(path), false);
  }
  for (const path of [
    boundaryStaging,
    futureStaging,
    nearMatch,
    symlinkStaging,
  ]) {
    assert.equal(existsSync(path), true);
  }
  assert.equal(JSON.parse(readFileSync(resultPath, "utf8")).status, "success");
  assert.equal(statSync(resultPath).nlink, 1);
});

test("recovery and retention accept staging files whose valid IDs contain the staging marker", async () => {
  let clock = Date.parse("2026-08-21T13:27:00.000Z");
  const fixture = await createFixture({ now: () => clock });
  const requestOwner = owner(261);
  const requestId = "retained.json.staged-result";
  const fingerprint = "retention-marker-identifier-fingerprint";
  const registration = await register(
    fixture,
    requestId,
    fingerprint,
    requestOwner,
  );
  await rpc(fixture, "publish-result", {
    requestId: registration.requestId,
    owner: requestOwner,
    status: "success",
    payload: { markerIdentifier: true },
  });

  const resultDirectory = join(
    fixture.coordinator.stateRoot,
    "results",
    fingerprintHash(fingerprint),
  );
  const resultPath = join(resultDirectory, `${registration.executionId}.json`);
  const stageOnly = immutableStagingPath(
    resultDirectory,
    "stage-only.json.staged-crash",
  );
  const finalAndStage = immutableStagingPath(
    resultDirectory,
    registration.executionId,
  );
  writeFileSync(stageOnly, "uncommitted staging bytes\n");
  linkSync(resultPath, finalAndStage);
  setModifiedAt(stageOnly, clock);
  setModifiedAt(finalAndStage, clock);
  await fixture.coordinator.close("staging-marker-recovery-fixture-ready");

  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    idleMs: 30_000,
    ownerSweepMs: 0,
    now: () => clock,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-staging-marker-recovery-start",
    },
  });
  const recovered = await rpc(fixture, "request-status", {
    requestId: registration.requestId,
    owner: requestOwner,
  });
  assert.equal(recovered.state, "result-ready");
  assert.equal(recovered.result.status, "success");
  assert.equal(existsSync(stageOnly), true);
  assert.equal(existsSync(finalAndStage), true);
  assert.equal(statSync(resultPath).nlink, 2);

  clock += RECORD_RETENTION_MS;
  assert.equal(fixture.coordinator.core.pruneRecords().temporaryRecords, 0);
  assert.equal(existsSync(stageOnly), true);
  assert.equal(existsSync(finalAndStage), true);

  clock += 1;
  assert.equal(fixture.coordinator.core.pruneRecords().temporaryRecords, 2);
  assert.equal(existsSync(stageOnly), false);
  assert.equal(existsSync(finalAndStage), false);
  assert.equal(existsSync(resultPath), true);
  assert.equal(statSync(resultPath).nlink, 1);
});

test("retention keeps an expired result until every handoff acknowledges", async () => {
  let clock = Date.parse("2026-08-21T13:30:00.000Z");
  const fixture = await createFixture({ now: () => clock });
  const leaderOwner = owner(225);
  const followerOwner = owner(226);
  const fingerprint = "retained-handoff-fingerprint";
  const leader = await register(
    fixture,
    "retained-handoff-leader",
    fingerprint,
    leaderOwner,
  );
  const follower = await register(
    fixture,
    "retained-handoff-follower",
    fingerprint,
    followerOwner,
  );
  await rpc(fixture, "publish-result", {
    requestId: leader.requestId,
    owner: leaderOwner,
    status: "success",
    payload: { retainedForHandoff: true },
  });
  const resultPath = join(
    fixture.coordinator.stateRoot,
    "results",
    fingerprintHash(fingerprint),
    `${leader.executionId}.json`,
  );
  assert.equal(existsSync(resultPath), true);
  await fixture.coordinator.close("simulated-crash");

  clock += RECORD_RETENTION_MS + 1;
  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    idleMs: 30_000,
    ownerSweepMs: 0,
    now: () => clock,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-retained-handoff-recovery-start",
    },
  });
  for (const [requestId, requestOwner] of [
    [leader.requestId, leaderOwner],
    [follower.requestId, followerOwner],
  ]) {
    const request = await rpc(fixture, "request-status", {
      requestId,
      owner: requestOwner,
    });
    assert.equal(request.state, "result-ready");
    assert.equal(request.result.status, "success");
  }
  assert.equal(existsSync(resultPath), true);

  await acknowledgeResult(fixture, leader.requestId, leaderOwner);
  assert.equal(existsSync(resultPath), true);
  await acknowledgeResult(fixture, follower.requestId, followerOwner);
  assert.equal(existsSync(resultPath), false);
});

test("one-shot registrations are cancelled when PID identity probing reports death", async () => {
  const fixture = await createFixture({
    // Leave enough time for the request-bound waiter to connect before the
    // synthetic probe reports the owner dead.
    ownerSweepMs: 100,
    ownerObserver: () => ({ state: "dead", startUtc: null }),
  });
  const requestOwner = owner(140);
  const registration = await register(
    fixture,
    "probed-owner",
    "probed-owner-fingerprint",
    requestOwner,
  );
  const result = await rpc(fixture, "wait-result", {
    requestId: registration.requestId,
    owner: requestOwner,
    fingerprint: "probed-owner-fingerprint",
    executionId: registration.executionId,
    timeoutMs: 2_000,
  });
  assert.equal(result.result.status, "cancelled");
  assert.match(result.result.payload.reason, /process probe reported dead/);
});

test("terminal acknowledgement removes its owner observation", async () => {
  const fixture = await createFixture({
    ownerSweepMs: 10,
    ownerObserver: (identity) => ({
      state: "live",
      startUtc: identity.startUtc,
    }),
  });
  const requestOwner = owner(233);
  await register(
    fixture,
    "observed-terminal",
    "observed-terminal-fp",
    requestOwner,
  );
  await waitUntil(async () => {
    const snapshot = await status(fixture);
    return snapshot.ownerObservations.some(
      (observation) => observation.requestId === "observed-terminal",
    );
  });

  await rpc(fixture, "publish-result", {
    requestId: "observed-terminal",
    owner: requestOwner,
    status: "success",
    payload: { observed: true },
  });
  assert.equal((await status(fixture)).ownerObservations.length, 1);

  await acknowledgeResult(fixture, "observed-terminal", requestOwner);
  assert.deepEqual((await status(fixture)).ownerObservations, []);
});

test("a joining client can drain a dead owner's tagged process tree", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    await once(child, "spawn");
    const deadOwner = { pid: child.pid, startUtc: processStartUtc(child.pid) };
    const fixture = await createFixture({ capacity: 1, ownerSweepMs: 10 });
    const deadWorkerDrainId = "gate-run-dead-worker-214-1770000000";
    await register(fixture, "dead-worker", "dead-worker-fp", deadOwner, {
      drainIdentity: "gate-request-dead-worker-214-1770000000",
    });
    await lease(fixture, "dead-worker", "dead-worker-lease", deadOwner, {
      drainIdentity: deadWorkerDrainId,
      resources: ["playwright-fixture"],
    });

    child.kill("SIGTERM");
    await once(child, "exit");
    const snapshot = await waitUntil(async () => {
      const inspected = await status(fixture);
      return inspected.drainObligations.length ? inspected : null;
    });
    const obligation = snapshot.drainObligations[0];
    assert.equal(snapshot.usedCapacity, 1);
    assert.equal(obligation.drainIdentity, deadWorkerDrainId);
    assert.equal(obligation.requestId, "dead-worker");
    assert.equal(
      obligation.generationToken,
      fixture.coordinator.metadata.generationToken,
    );

    const joiningOwner = {
      pid: process.pid,
      startUtc: processStartUtc(process.pid),
    };
    await register(
      fixture,
      "joining-worker",
      "joining-worker-fp",
      joiningOwner,
    );
    assert.equal(
      (
        await lease(
          fixture,
          "joining-worker",
          "joining-worker-lease",
          joiningOwner,
        )
      ).status,
      "queued",
    );
    const joinedStatus = await status(fixture);
    assert.equal(
      joinedStatus.drainObligations[0].drainIdentity,
      obligation.drainIdentity,
    );
    await claimObligation(fixture, obligation, joiningOwner);
    await rpc(fixture, "acknowledge-drain", {
      obligationId: obligation.obligationId,
      drainIdentity: obligation.drainIdentity,
      drainer: joiningOwner,
      evidence: {
        processTreeEmpty: true,
        drainedToken: obligation.drainIdentity,
      },
    });
    assert.equal(
      (await status(fixture)).leases.find(
        (candidate) => candidate.leaseId === "joining-worker-lease",
      ).status,
      "granted",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
});

test("a dead drain claimant releases its exact claim for another client", async () => {
  const claimant = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  try {
    await once(claimant, "spawn");
    const fixture = await createFixture({ capacity: 1, ownerSweepMs: 10 });
    const liveOwner = {
      pid: process.pid,
      startUtc: processStartUtc(process.pid),
    };
    await register(fixture, "claim-recovery", "claim-recovery-fp", liveOwner);
    await lease(fixture, "claim-recovery", "claim-recovery-lease", liveOwner);
    const stale = await markOwnerStale(fixture, {
      requestId: "claim-recovery",
      observedOwner: liveOwner,
      reporter: liveOwner,
      reason: "test creates a recoverable drain obligation",
    });
    const obligation = stale.drainObligations[0];
    assert.equal(fixture.coordinator.core.isLegacyRecoveryHandoffReady(), true);
    const firstClaimant = {
      pid: claimant.pid,
      startUtc: processStartUtc(claimant.pid),
    };
    await claimObligation(fixture, obligation, firstClaimant);
    assert.equal(
      fixture.coordinator.core.isLegacyRecoveryHandoffReady(),
      false,
    );
    await assert.rejects(
      claimObligation(fixture, obligation, liveOwner),
      (error) => error.code === "DRAIN_ALREADY_CLAIMED",
    );

    claimant.kill("SIGTERM");
    await once(claimant, "exit");
    await waitUntil(async () => {
      const current = await status(fixture);
      return current.drainObligations[0]?.claim === null ? current : null;
    });
    assert.equal(fixture.coordinator.core.isLegacyRecoveryHandoffReady(), true);
    await claimObligation(fixture, obligation, liveOwner);
    await rpc(fixture, "acknowledge-drain", {
      obligationId: obligation.obligationId,
      drainIdentity: obligation.drainIdentity,
      drainer: liveOwner,
      evidence: { processTreeEmpty: true },
    });
    assert.equal((await status(fixture)).drainObligations.length, 0);
  } finally {
    if (claimant.exitCode === null && claimant.signalCode === null) {
      claimant.kill("SIGKILL");
    }
  }
});

for (const terminalStatus of ["success", "failure", "cancelled"]) {
  test(`singleflight followers receive the exact ${terminalStatus} result`, async () => {
    const fixture = await createFixture();
    const leaderOwner = owner(140 + terminalStatus.length);
    const followerOwner = owner(150 + terminalStatus.length);
    const fingerprint = `coalesced-${terminalStatus}`;
    const leader = await register(
      fixture,
      `leader-${terminalStatus}`,
      fingerprint,
      leaderOwner,
    );
    const follower = await register(
      fixture,
      `follower-${terminalStatus}`,
      fingerprint,
      followerOwner,
    );
    assert.equal(leader.role, "leader");
    assert.equal(follower.role, "follower");
    assert.equal(follower.leaderRequestId, leader.requestId);

    const waiter = await connectCoordinator({ root: fixture.root });
    const resultPromise = waiter.request("wait-result", {
      requestId: follower.requestId,
      capability: capabilityFor(follower.requestId),
      owner: followerOwner,
      fingerprint,
      executionId: leader.executionId,
      timeoutMs: 2_000,
    });
    if (terminalStatus === "cancelled") {
      await rpc(fixture, "cancel-request", {
        requestId: leader.requestId,
        owner: leaderOwner,
        reason: "test cancellation",
      });
    } else {
      await rpc(fixture, "publish-result", {
        requestId: leader.requestId,
        owner: leaderOwner,
        status: terminalStatus,
        payload: { terminalStatus },
      });
    }
    const waited = await resultPromise;
    assert.equal(waited.found, true);
    assert.equal(waited.result.status, terminalStatus);
    if (terminalStatus !== "cancelled") {
      assert.deepEqual(waited.result.payload, { terminalStatus });
    }
    await waiter.close();

    await acknowledgeResult(fixture, leader.requestId, leaderOwner);
    await acknowledgeResult(fixture, follower.requestId, followerOwner);

    await assert.rejects(
      register(fixture, leader.requestId, fingerprint, leaderOwner),
      (error) => error.code === "REQUEST_ALREADY_COMPLETED",
    );

    const later = await register(
      fixture,
      `late-${terminalStatus}`,
      fingerprint,
      owner(160 + terminalStatus.length),
    );
    assert.equal(later.role, "leader");
    if (terminalStatus === "success") {
      await rpc(fixture, "cancel-request", {
        requestId: later.requestId,
        owner: owner(160 + terminalStatus.length),
        reason: "cleanup retry",
      });
      await acknowledgeResult(
        fixture,
        later.requestId,
        owner(160 + terminalStatus.length),
      );
    }
    assert.ok(
      existsSync(
        join(
          fixture.coordinator.stateRoot,
          "results",
          fingerprintHash(fingerprint),
          `${leader.executionId}.json`,
        ),
      ),
    );
  });
}

test("an unclean bound-client disconnect creates a drain obligation", async () => {
  const fixture = await createFixture({ capacity: 1 });
  const disconnectedOwner = owner(171);
  const waitingOwner = owner(172);
  const disconnectedDrainId = "run-disconnect-owner-171-1770000000";
  const disconnectedRequestDrainId = "request-disconnect-owner-171-1770000000";
  const unrelatedDrainId = "run-unrelated-999-1770000000";
  const client = await connectCoordinator({ root: fixture.root });
  const registration = await client.request("register", {
    requestId: "disconnect-owner",
    capability: capabilityFor("disconnect-owner"),
    fingerprint: "disconnect-fingerprint",
    worktreeKey: "/tmp/disconnect-owner",
    drainIdentity: disconnectedRequestDrainId,
    owner: disconnectedOwner,
    bindConnection: true,
  });
  await client.request("request-lease", {
    requestId: "disconnect-owner",
    leaseId: "disconnect-lease",
    drainIdentity: disconnectedDrainId,
    capability: capabilityFor("disconnect-owner"),
    owner: disconnectedOwner,
    weight: 1,
    resources: ["browser-fixture-3211"],
  });
  client.destroy();

  const drained = await waitUntil(() => {
    const snapshot = fixture.coordinator.core.inspect();
    return snapshot.drainObligations.length === 1 ? snapshot : null;
  });
  assert.equal(drained.usedCapacity, 1);
  assert.equal(drained.leases[0].status, "drain-required");
  assert.deepEqual(drained.leases[0].resources, ["browser-fixture-3211"]);

  await register(
    fixture,
    "disconnect-waiter",
    "disconnect-waiter-fingerprint",
    waitingOwner,
  );
  assert.equal(
    (
      await lease(
        fixture,
        "disconnect-waiter",
        "disconnect-waiting-lease",
        waitingOwner,
      )
    ).status,
    "queued",
  );

  const obligation = drained.drainObligations[0];
  assert.equal(obligation.drainIdentity, disconnectedDrainId);
  assert.equal(obligation.weight, 1);
  assert.deepEqual(obligation.resources, ["browser-fixture-3211"]);
  assert.equal(
    drained.requests.find((request) => request.requestId === "disconnect-owner")
      .drainIdentity,
    disconnectedRequestDrainId,
  );
  await assert.rejects(
    rpc(fixture, "acknowledge-drain", {
      obligationId: obligation.obligationId,
      drainIdentity: unrelatedDrainId,
      drainer: owner(173),
      evidence: { processTreeEmpty: true },
    }),
    (error) => error.code === "DRAIN_TOKEN_MISMATCH",
  );
  const drainer = owner(173);
  const claimed = await claimObligation(fixture, obligation, drainer);
  assert.equal(claimed.idempotent, false);
  assert.equal(
    (await claimObligation(fixture, obligation, drainer)).idempotent,
    true,
  );
  await assert.rejects(
    claimObligation(fixture, obligation, owner(174)),
    (error) => error.code === "DRAIN_ALREADY_CLAIMED",
  );
  await rpc(fixture, "acknowledge-drain", {
    obligationId: obligation.obligationId,
    drainIdentity: obligation.drainIdentity,
    drainer,
    evidence: { processTreeEmpty: true },
  });
  const snapshot = await status(fixture);
  assert.equal(
    snapshot.leases.find(
      (candidate) => candidate.leaseId === "disconnect-waiting-lease",
    ).status,
    "granted",
  );
  const result = fixture.coordinator.core.readResult(
    "disconnect-fingerprint",
    registration.executionId,
  );
  assert.equal(result.status, "cancelled");
  assert.equal(
    snapshot.requests.some(
      (candidate) => candidate.requestId === "disconnect-owner",
    ),
    false,
  );
});

test("a completed reuse registration is bound until its result handoff", async () => {
  const fixture = await createFixture({ capacity: 1 });
  const sourceOwner = owner(175);
  const fingerprint = "completed-bound-reuse-fingerprint";
  const source = await register(
    fixture,
    "completed-bound-source",
    fingerprint,
    sourceOwner,
  );
  await rpc(fixture, "publish-result", {
    requestId: source.requestId,
    owner: sourceOwner,
    status: "success",
    payload: { cached: true },
  });
  await acknowledgeResult(fixture, source.requestId, sourceOwner);

  const requestId = "completed-bound-reuse";
  const requestOwner = owner(176);
  const socket = createConnection(fixture.coordinator.socketPath);
  socket.setEncoding("utf8");
  await once(socket, "connect");
  const response = new Promise((resolveResponse, rejectResponse) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const parsed = JSON.parse(input.slice(0, newline));
      if (parsed.ok) resolveResponse(parsed.response);
      else rejectResponse(new Error(JSON.stringify(parsed.error)));
    });
    socket.once("error", rejectResponse);
  });
  socket.write(
    `${JSON.stringify({
      id: "completed-bind-raw-register",
      protocol: PROTOCOL_VERSION,
      policyHash: fixture.policyHash,
      action: "register",
      params: {
        requestId,
        capability: capabilityFor(requestId),
        fingerprint,
        worktreeKey: "/tmp/completed-bound-worktree",
        drainIdentity: runToken("completed-bound-reuse", 176, 1_770_000_000),
        owner: requestOwner,
        successMaxAgeMs: 60_000,
        bindConnection: true,
      },
    })}\n`,
  );
  assert.equal((await response).role, "completed");
  const closed = once(socket, "close");
  socket.destroy();
  await closed;

  await waitUntil(
    () =>
      fixture.coordinator.core.state.requests[requestId] === undefined || null,
  );
  const nextOwner = owner(177);
  const next = await register(
    fixture,
    "completed-bound-next",
    "completed-bound-next-fingerprint",
    nextOwner,
    { worktreeKey: "/tmp/completed-bound-worktree" },
  );
  assert.equal(next.admission, "held");
});

test("a disconnected leader auto-acknowledges after drain across restart", async () => {
  const fixture = await createFixture({ capacity: 1 });
  const requestId = "restart-bound-stale";
  const requestOwner = owner(178);
  const client = await connectCoordinator({ root: fixture.root });
  await client.request("register", {
    requestId,
    capability: capabilityFor(requestId),
    fingerprint: "restart-bound-stale-fingerprint",
    worktreeKey: "/tmp/restart-bound-worktree",
    drainIdentity: runToken("restart-bound-stale", 178, 1_770_000_000),
    owner: requestOwner,
    successMaxAgeMs: 0,
    bindConnection: true,
  });
  await client.request("request-lease", {
    requestId,
    leaseId: "restart-bound-stale-lease",
    drainIdentity: runToken(
      "restart-bound-stale-lease",
      requestOwner.pid,
      1_770_000_000,
    ),
    capability: capabilityFor(requestId),
    owner: requestOwner,
    weight: 1,
    resources: [],
  });
  client.destroy();
  const beforeRestart = await waitUntil(() => {
    const inspected = fixture.coordinator.core.inspect();
    return inspected.drainObligations.length === 1 ? inspected : null;
  });
  assert.equal(beforeRestart.requests[0].autoAcknowledge, true);

  await fixture.coordinator.close("bound-stale-restart");
  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    capacity: 1,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-bound-stale-restart",
    },
  });
  const restarted = await status(fixture);
  const [obligation] = restarted.drainObligations;
  assert.ok(obligation);
  assert.equal(restarted.requests[0].autoAcknowledge, true);
  const drainer = owner(179);
  await claimObligation(fixture, obligation, drainer);
  await rpc(fixture, "acknowledge-drain", {
    obligationId: obligation.obligationId,
    drainIdentity: obligation.drainIdentity,
    drainer,
    evidence: { processTreeEmpty: true },
  });
  const settled = await status(fixture);
  assert.equal(settled.activeRequestCount, 0);
  assert.equal(settled.leases.length, 0);
  assert.equal(settled.drainObligations.length, 0);

  const nextOwner = owner(180);
  const next = await register(
    fixture,
    "restart-bound-next",
    "restart-bound-next-fingerprint",
    nextOwner,
    { worktreeKey: "/tmp/restart-bound-worktree" },
  );
  assert.equal(next.admission, "held");
});

test("process-group TERM marks a bound request unclean", async () => {
  const fixture = await createFixture({ capacity: 1 });
  const requestId = "term-bound-request";
  const requestOwner = owner(184);
  const controlFile = join(fixture.root, "term-bound-lifecycle-control");
  const moduleUrl = new URL(
    "./quality-gate-coordinator-client.mjs",
    import.meta.url,
  ).href;
  writeFileSync(controlFile, "");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { bindCoordinatorRequest } from ${JSON.stringify(moduleUrl)};
        const [parentPid, root, policyHash, paramsJson, lifecycleControlFile] =
          process.argv.slice(1);
        await bindCoordinatorRequest(
          { root, policyHash },
          JSON.parse(paramsJson),
          {
            parentPid: Number(parentPid),
            lifecycleControlFile,
            publishResponse: async () => process.stdout.write("READY\\n"),
          },
        );
      `,
      String(process.pid),
      fixture.root,
      fixture.policyHash,
      JSON.stringify({
        requestId,
        capability: capabilityFor(requestId),
        fingerprint: "term-bound-fingerprint",
        worktreeKey: "/tmp/term-bound-worktree",
        drainIdentity: runToken("term-bound-request", 184, 1_770_000_000),
        owner: requestOwner,
        successMaxAgeMs: 0,
      }),
      controlFile,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await waitUntil(() => (stdout.includes("READY\n") ? true : null));
    await lease(fixture, requestId, "term-bound-lease", requestOwner);
    process.kill(-child.pid, "SIGTERM");
    await once(child, "exit");
    const drained = await waitUntil(() => {
      const inspected = fixture.coordinator.core.inspect();
      return inspected.drainObligations.length === 1 ? inspected : null;
    });
    assert.equal(drained.requests[0].autoAcknowledge, true);
    assert.equal(drained.leases[0].status, "drain-required");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, "SIGKILL");
      await once(child, "exit");
    }
    assert.equal(stderr, "");
  }
});

test("a private control file marks a bound request unclean", async () => {
  const fixture = await createFixture({ capacity: 1 });
  const requestId = "control-bound-request";
  const requestOwner = owner(185);
  const controlFile = join(fixture.root, "bound-lifecycle-control");
  const moduleUrl = new URL(
    "./quality-gate-coordinator-client.mjs",
    import.meta.url,
  ).href;
  writeFileSync(controlFile, "");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { bindCoordinatorRequest } from ${JSON.stringify(moduleUrl)};
        const [parentPid, root, policyHash, paramsJson, lifecycleControlFile] =
          process.argv.slice(1);
        await bindCoordinatorRequest(
          { root, policyHash },
          JSON.parse(paramsJson),
          {
            parentPid: Number(parentPid),
            lifecycleControlFile,
            publishResponse: async () => process.stdout.write("READY\\n"),
          },
        );
      `,
      String(process.pid),
      fixture.root,
      fixture.policyHash,
      JSON.stringify({
        requestId,
        capability: capabilityFor(requestId),
        fingerprint: "control-bound-fingerprint",
        worktreeKey: "/tmp/control-bound-worktree",
        drainIdentity: runToken("control-bound-request", 185, 1_770_000_000),
        owner: requestOwner,
        successMaxAgeMs: 0,
      }),
      controlFile,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await waitUntil(() => (stdout.includes("READY\n") ? true : null));
    await lease(fixture, requestId, "control-bound-lease", requestOwner);
    writeFileSync(controlFile, "unclean\n");
    await once(child, "exit");
    const drained = await waitUntil(() => {
      const inspected = fixture.coordinator.core.inspect();
      return inspected.drainObligations.length === 1 ? inspected : null;
    });
    assert.equal(drained.requests[0].autoAcknowledge, true);
    assert.equal(drained.leases[0].status, "drain-required");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    assert.equal(stderr, "");
  }
});

test("coordinator cleanup never signals a recycled PID stand-in", async () => {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-lifecycle-cleanup-"));
  fixtures.push({ root });
  const signalFile = join(root, "sentinel-signal");
  const supportPath = fileURLToPath(
    new URL("./quality-gate-coordinator-support.sh", import.meta.url),
  );
  const sentinel = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { writeFileSync } from "node:fs";
        const signalFile = process.argv[1];
        for (const signal of ["SIGUSR2", "SIGTERM"]) {
          process.on(signal, () => writeFileSync(signalFile, signal));
        }
        process.stdout.write("READY\\n");
        setInterval(() => {}, 1_000);
      `,
      signalFile,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  sentinel.stdout.setEncoding("utf8");
  sentinel.stderr.setEncoding("utf8");
  sentinel.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  sentinel.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await waitUntil(() => (stdout.includes("READY\n") ? true : null));
    for (const disposition of ["clean", "unclean"]) {
      const scratch = join(root, `scratch-${disposition}`);
      const controlFile = join(scratch, "lifecycle-control");
      const completionFile = join(scratch, "lifecycle-completion");
      const lifecycleErrorFile = join(scratch, "lifecycle-error");
      mkdirSync(scratch, { recursive: true });
      writeFileSync(controlFile, "");
      writeFileSync(completionFile, '{"status":"stopped","exitCode":0}\n');
      writeFileSync(lifecycleErrorFile, "");
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          `
            set -euo pipefail
            scratch_dir="$1"
            gate_coordinator_lifecycle_dir="$1"
            gate_coordinator_lifecycle_pid="$2"
            gate_coordinator_lifecycle_control_file="$3"
            gate_coordinator_lifecycle_completion_file="$4"
            gate_coordinator_lifecycle_error_file="$5"
            source "$6"
            gate_coordinator_stop_request_lifecycle "$7"
          `,
          "lifecycle-cleanup-test",
          scratch,
          String(sentinel.pid),
          controlFile,
          completionFile,
          lifecycleErrorFile,
          supportPath,
          disposition,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.kill(sentinel.pid, 0);
      assert.equal(existsSync(signalFile), false);
    }
    const failedScratch = join(root, "scratch-failed-lifecycle");
    const failedControlFile = join(failedScratch, "lifecycle-control");
    const failedCompletionFile = join(failedScratch, "lifecycle-completion");
    const failedErrorFile = join(failedScratch, "lifecycle-error");
    mkdirSync(failedScratch, { recursive: true });
    writeFileSync(failedControlFile, "");
    writeFileSync(failedCompletionFile, '{"status":"failed","exitCode":2}\n');
    writeFileSync(failedErrorFile, "fixture lifecycle failure\n");
    const failedResult = spawnSync(
      "/bin/bash",
      [
        "-c",
        `
          set -euo pipefail
          scratch_dir="$1"
          gate_coordinator_lifecycle_dir="$1"
          gate_coordinator_lifecycle_pid="$2"
          gate_coordinator_lifecycle_control_file="$3"
          gate_coordinator_lifecycle_completion_file="$4"
          gate_coordinator_lifecycle_error_file="$5"
          source "$6"
          gate_coordinator_stop_request_lifecycle unclean
        `,
        "failed-lifecycle-cleanup-test",
        failedScratch,
        String(sentinel.pid),
        failedControlFile,
        failedCompletionFile,
        failedErrorFile,
        supportPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(failedResult.status, 2, failedResult.stderr);
    assert.match(failedResult.stderr, /fixture lifecycle failure/u);
    assert.match(failedResult.stderr, /did not stop cleanly/u);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(sentinel.pid, 0);
    assert.equal(existsSync(signalFile), false);

    const waitScratch = join(root, "scratch-wait-cancel");
    const cancelFile = join(waitScratch, "wait-cancel");
    const waitCompletionFile = join(waitScratch, "wait-completion");
    const waitErrorFile = join(waitScratch, "wait-error");
    mkdirSync(waitScratch, { recursive: true });
    writeFileSync(cancelFile, "");
    writeFileSync(waitCompletionFile, "0\n");
    writeFileSync(waitErrorFile, "");
    const waitResult = spawnSync(
      "/bin/bash",
      [
        "-c",
        `
          set -euo pipefail
          gate_coordinator_wait_pid="$1"
          gate_coordinator_wait_dir="$2"
          gate_coordinator_wait_cancel_file="$3"
          gate_coordinator_wait_completion_file="$4"
          gate_coordinator_wait_error_file="$5"
          source "$6"
          gate_coordinator_stop_wait_cli
        `,
        "wait-cleanup-test",
        String(sentinel.pid),
        waitScratch,
        cancelFile,
        waitCompletionFile,
        waitErrorFile,
        supportPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(waitResult.status, 0, waitResult.stderr);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(sentinel.pid, 0);
    assert.equal(existsSync(signalFile), false);
  } finally {
    if (sentinel.exitCode === null && sentinel.signalCode === null) {
      sentinel.kill("SIGKILL");
      await once(sentinel, "exit");
    }
    assert.equal(stderr, "");
  }
});

test("lifecycle bootstrap records an entrypoint failure", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-lifecycle-bootstrap-"));
  fixtures.push({ root });
  const bootstrap = fileURLToPath(
    new URL("./quality-gate-coordinator-lifecycle.mjs", import.meta.url),
  );
  const completionFile = join(root, "lifecycle-completion");
  writeFileSync(completionFile, "");
  const result = spawnSync(
    process.execPath,
    [bootstrap, join(root, "missing-entrypoint.mjs"), completionFile],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(completionFile, "utf8")), {
    status: "failed",
    exitCode: 2,
  });
});

test("stale reports require an exact PID/start identity and explicit drain ack", async () => {
  const fixture = await createFixture({ capacity: 2 });
  const staleOwner = owner(181);
  await register(fixture, "stale-request", "stale-fingerprint", staleOwner);
  await lease(fixture, "stale-request", "stale-lease", staleOwner, {
    weight: 2,
  });

  await assert.rejects(
    markOwnerStale(fixture, {
      requestId: "stale-request",
      observedOwner: { ...staleOwner, startUtc: "2026-08-21T00:00:00.000Z" },
      reporter: owner(182),
      reason: "PID was reused",
    }),
    (error) => error.code === "OWNER_IDENTITY_MISMATCH",
  );
  let snapshot = await status(fixture);
  assert.equal(snapshot.leases[0].status, "granted");

  const stale = await markOwnerStale(fixture, {
    requestId: "stale-request",
    observedOwner: staleOwner,
    reporter: owner(182),
    reason: "process identity is no longer live",
  });
  assert.equal(stale.draining, true);
  assert.equal(stale.drainObligations.length, 1);
  snapshot = await status(fixture);
  assert.equal(snapshot.usedCapacity, 2);
  assert.equal(snapshot.leases[0].status, "drain-required");

  await assert.rejects(
    release(fixture, "stale-request", "stale-lease", staleOwner),
    (error) => error.code === "DRAIN_ACK_REQUIRED",
  );
  const staleDrainer = owner(183);
  await claimObligation(fixture, stale.drainObligations[0], staleDrainer);
  await assert.rejects(
    rpc(fixture, "acknowledge-drain", {
      obligationId: stale.drainObligations[0].obligationId,
      drainIdentity: stale.drainObligations[0].drainIdentity,
      drainer: staleDrainer,
      evidence: { processTreeEmpty: false },
    }),
    (error) => error.code === "DRAIN_EVIDENCE_REQUIRED",
  );
  await rpc(fixture, "acknowledge-drain", {
    obligationId: stale.drainObligations[0].obligationId,
    drainIdentity: stale.drainObligations[0].drainIdentity,
    drainer: staleDrainer,
    evidence: {
      processTreeEmpty: true,
      checkedPid: staleOwner.pid,
      descendants: [],
    },
  });
  snapshot = await status(fixture);
  assert.equal(snapshot.usedCapacity, 0);
  assert.equal(snapshot.drainObligations.length, 0);
});

test("one request claim owns its distinct per-lease drain identities", async () => {
  let clock = Date.parse("2026-08-21T12:00:00.000Z");
  const advancingNow = () => clock++;
  const fixture = await createFixture({ capacity: 2, now: advancingNow });
  const requestOwner = owner(224);
  const firstClaimant = owner(225);
  const secondClaimant = owner(226);
  await register(fixture, "sibling-drain", "sibling-drain-fp", requestOwner);
  const firstDrainIdentity = runToken(
    "sibling-drain-command-a",
    requestOwner.pid,
    1_770_000_000,
  );
  const secondDrainIdentity = runToken(
    "sibling-drain-command-b",
    requestOwner.pid,
    1_770_000_001,
  );
  await lease(fixture, "sibling-drain", "sibling-drain-a", requestOwner, {
    drainIdentity: firstDrainIdentity,
  });
  await lease(fixture, "sibling-drain", "sibling-drain-b", requestOwner, {
    drainIdentity: secondDrainIdentity,
  });
  const stale = await markOwnerStale(fixture, {
    requestId: "sibling-drain",
    observedOwner: requestOwner,
    reporter: firstClaimant,
    reason: "two granted commands need one request-scoped drainer",
  });
  assert.equal(stale.drainObligations.length, 2);
  assert.deepEqual(
    new Set(stale.drainObligations.map(({ drainIdentity }) => drainIdentity)),
    new Set([firstDrainIdentity, secondDrainIdentity]),
  );
  const firstObligation = stale.drainObligations.find(
    ({ drainIdentity }) => drainIdentity === firstDrainIdentity,
  );
  const secondObligation = stale.drainObligations.find(
    ({ drainIdentity }) => drainIdentity === secondDrainIdentity,
  );
  const firstClaim = await claimObligation(
    fixture,
    firstObligation,
    firstClaimant,
  );
  assert.equal(firstClaim.obligations.length, 2);
  assert.ok(
    firstClaim.obligations.every(
      (obligation) => obligation.claim.claimant.pid === firstClaimant.pid,
    ),
  );
  assert.equal(
    new Set(
      firstClaim.obligations.map((obligation) => obligation.claim.claimedAt),
    ).size,
    1,
  );
  await assert.rejects(
    claimObligation(fixture, secondObligation, secondClaimant),
    (error) => error.code === "DRAIN_ALREADY_CLAIMED",
  );

  const released = await rpc(fixture, "release-drain-claim", {
    obligationId: firstObligation.obligationId,
    drainIdentity: firstObligation.drainIdentity,
    claimant: firstClaimant,
  });
  assert.equal(released.released, true);
  assert.equal(released.releasedObligations, 2);
  const releasedSnapshot = await status(fixture);
  assert.equal(releasedSnapshot.drainObligations.length, 2);
  assert.ok(
    releasedSnapshot.drainObligations.every(
      (obligation) => obligation.claim === null,
    ),
  );
  const reclaimed = await claimObligation(
    fixture,
    secondObligation,
    firstClaimant,
  );
  assert.equal(reclaimed.obligations.length, 2);
  assert.ok(
    reclaimed.obligations.every(
      (obligation) => obligation.claim.claimant.pid === firstClaimant.pid,
    ),
  );

  await fixture.coordinator.close("claimed-sibling-restart");
  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    capacity: 2,
    idleMs: 30_000,
    ownerSweepMs: 0,
    now: advancingNow,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-sibling-claim-restart",
    },
  });
  const recovered = await status(fixture);
  assert.equal(recovered.drainObligations.length, 2);
  assert.equal(
    new Set(
      recovered.drainObligations.map(
        (obligation) => obligation.claim.claimedAt,
      ),
    ).size,
    1,
  );
  await assert.rejects(
    claimObligation(fixture, firstObligation, secondClaimant),
    (error) => error.code === "DRAIN_ALREADY_CLAIMED",
  );
  await rpc(fixture, "acknowledge-drain", {
    obligationId: firstObligation.obligationId,
    drainIdentity: firstObligation.drainIdentity,
    drainer: firstClaimant,
    evidence: { processTreeEmpty: true },
  });
  await rpc(fixture, "acknowledge-drain", {
    obligationId: secondObligation.obligationId,
    drainIdentity: secondObligation.drainIdentity,
    drainer: firstClaimant,
    evidence: { processTreeEmpty: true },
  });
  assert.equal((await status(fixture)).drainObligations.length, 0);
});

test("restart recovery preserves stale capacity until drain acknowledgement", async () => {
  const fixture = await createFixture({ capacity: 2 });
  const firstOwner = owner(191);
  const secondOwner = owner(192);
  await register(fixture, "restart-first", "restart-first-fp", firstOwner);
  await lease(fixture, "restart-first", "restart-held", firstOwner, {
    weight: 2,
    resources: ["playwright-install"],
  });
  assert.equal(
    (
      await lease(
        fixture,
        "restart-first",
        "restart-queued-before-crash",
        firstOwner,
      )
    ).status,
    "queued",
  );
  await fixture.coordinator.close("simulated-crash");

  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    capacity: 2,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-coordinator-process-start",
    },
  });
  let snapshot = await status(fixture);
  assert.equal(snapshot.usedCapacity, 2);
  assert.equal(snapshot.leases.length, 1);
  assert.equal(snapshot.leases[0].status, "drain-required");
  assert.equal(snapshot.drainObligations[0].reason, "coordinator-restart");
  assert.equal(
    snapshot.leases.some(
      (candidate) => candidate.leaseId === "restart-queued-before-crash",
    ),
    false,
  );

  await register(fixture, "restart-second", "restart-second-fp", secondOwner);
  assert.equal(
    (await lease(fixture, "restart-second", "restart-waiting", secondOwner))
      .status,
    "queued",
  );

  const restartDrainer = owner(193);
  await claimObligation(fixture, snapshot.drainObligations[0], restartDrainer);
  await rpc(fixture, "acknowledge-drain", {
    obligationId: snapshot.drainObligations[0].obligationId,
    drainIdentity: snapshot.drainObligations[0].drainIdentity,
    drainer: restartDrainer,
    evidence: { processTreeEmpty: true, recoveredAfterCrash: true },
  });
  snapshot = await status(fixture);
  assert.equal(
    snapshot.leases.find((candidate) => candidate.leaseId === "restart-waiting")
      .status,
    "granted",
  );
  assert.equal(snapshot.usedCapacity, 1);

  const journal = JSON.parse(
    readFileSync(join(fixture.coordinator.stateRoot, "journal.json"), "utf8"),
  );
  assert.equal(journal.schemaVersion, 2);
  assert.equal(journal.protocol.major, PROTOCOL_VERSION.major);
  assert.equal(journal.policyHash, DEFAULT_POLICY_HASH);
  assert.equal(Object.keys(journal.drainObligations).length, 0);
});

test("legacy startup queues work until adoption before owner sweeping", async () => {
  const requestOwner = owner(197);
  const publicationOwner = owner(198);
  let adoptionPending = true;
  let observerCalls = 0;
  let leaseBeforeAdoption;
  let resultBeforeAdoption;
  const fixture = await createLegacyFixture({
    ownerSweepMs: 5,
    ownerObserver: (identity) => {
      observerCalls += 1;
      return {
        state: adoptionPending ? "dead" : "live",
        startUtc: identity.startUtc,
      };
    },
    beforeLegacyAdopt: async ({ core }) => {
      core.register({
        requestId: "adoption-pending",
        capability: capabilityFor("adoption-pending"),
        fingerprint: "adoption-pending-fingerprint",
        worktreeKey: "/tmp/adoption-pending",
        drainIdentity: runToken("adoption", 197, 5004),
        owner: requestOwner,
        successMaxAgeMs: 0,
        metadata: { worktree: "/tmp/adoption-pending" },
      });
      leaseBeforeAdoption = core.requestLease({
        requestId: "adoption-pending",
        leaseId: "adoption-pending-lease",
        drainIdentity: runToken("adoption-lease", 197, 5004),
        capability: capabilityFor("adoption-pending"),
        owner: requestOwner,
        weight: 1,
        resources: [],
        metadata: { command: "adoption-pending" },
      });
      core.register({
        requestId: "publication-before-adoption",
        capability: capabilityFor("publication-before-adoption"),
        fingerprint: "publication-before-adoption-fingerprint",
        worktreeKey: "/tmp/publication-before-adoption",
        drainIdentity: runToken("publication", 198, 5005),
        owner: publicationOwner,
        successMaxAgeMs: 0,
        metadata: { worktree: "/tmp/publication-before-adoption" },
      });
      assert.throws(
        () =>
          core.publishResult({
            requestId: "publication-before-adoption",
            capability: capabilityFor("publication-before-adoption"),
            owner: publicationOwner,
            status: "success",
            payload: { source: "pre-adoption-regression" },
          }),
        (error) => error.code === "COORDINATOR_STARTING",
      );
      resultBeforeAdoption = core.readResult(
        "publication-before-adoption-fingerprint",
        "publication-before-adoption",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(observerCalls, 0);
      adoptionPending = false;
    },
  });

  assert.equal(leaseBeforeAdoption.status, "queued");
  assert.equal(resultBeforeAdoption, null);
  assert.equal(
    fixture.coordinator.core.leaseStatus(
      "adoption-pending-lease",
      requestOwner,
      capabilityFor("adoption-pending"),
    ).status,
    "granted",
  );
});

test("a failed legacy adoption cannot mutate recovered state", async () => {
  const fixture = await createFixture({ capacity: 1 });
  const requestOwner = owner(199);
  const requestId = "failed-adoption-recovery";
  const fingerprint = "failed-adoption-recovery-fingerprint";
  await register(fixture, requestId, fingerprint, requestOwner);
  await lease(
    fixture,
    requestId,
    "failed-adoption-recovery-lease",
    requestOwner,
  );
  const recoveredGenerationToken = fixture.coordinator.metadata.generationToken;
  await fixture.coordinator.close("simulated-crash");

  const legacyRoot = join(fixture.root, "failed-adoption-legacy");
  const lockDirectory = join(legacyRoot, "run.lock");
  const ownerPath = join(lockDirectory, "owner");
  mkdirSync(lockDirectory, { recursive: true });
  const nonce = randomUUID();
  const legacyOwnerToken = runToken(`legacy-${nonce}`, process.pid, 5006);
  const successorToken = runToken(`successor-${nonce}`, process.pid, 5007);
  writeFileSync(
    ownerPath,
    `pid=${process.pid}\nhost=test-host\nstart_utc=\ntoken=${legacyOwnerToken}\n`,
  );
  let recoveryBeforeAdoption;
  await assert.rejects(
    startCoordinator({
      root: fixture.root,
      capacity: 1,
      idleMs: 30_000,
      ownerSweepMs: 0,
      legacyLockRoot: legacyRoot,
      legacyOwnerToken,
      generationToken: runToken(`coord-${nonce}`, process.pid, 5008),
      coordinatorIdentity: {
        pid: process.pid,
        startUtc: "test-failed-adoption-recovery-start",
      },
      beforeLegacyAdopt: async ({ core }) => {
        recoveryBeforeAdoption = core.inspect();
        writeFileSync(
          ownerPath,
          `pid=${process.pid}\nhost=test-host\nstart_utc=successor\ntoken=${successorToken}\n`,
        );
      },
    }),
    (error) => error.code === "LEGACY_HANDOFF_MISMATCH",
  );

  assert.equal(recoveryBeforeAdoption.leases.length, 1);
  assert.equal(recoveryBeforeAdoption.leases[0].status, "drain-required");
  assert.equal(recoveryBeforeAdoption.drainObligations.length, 1);
  assert.equal(
    recoveryBeforeAdoption.drainObligations[0].generationToken,
    recoveredGenerationToken,
  );
  const journal = JSON.parse(
    readFileSync(
      join(
        stateNamespace(fixture.root, DEFAULT_POLICY_HASH, 1),
        "journal.json",
      ),
      "utf8",
    ),
  );
  assert.equal(journal.requests[requestId].resultReady, false);
  assert.equal(
    journal.leases["failed-adoption-recovery-lease"].status,
    "drain-required",
  );
  assert.equal(Object.keys(journal.drainObligations).length, 1);
  assert.ok(journal.singleflights[fingerprintHash(fingerprint)]);
  assert.equal(
    existsSync(
      join(
        stateNamespace(fixture.root, DEFAULT_POLICY_HASH, 1),
        "results",
        fingerprintHash(fingerprint),
        `${requestId}.json`,
      ),
    ),
    false,
  );
});

test("a generic legacy authority probe error stops before mutation", async () => {
  const fixture = await createLegacyFixture();
  const requestOwner = owner(262);
  const registration = await register(
    fixture,
    "authority-probe-error",
    "authority-probe-error-fingerprint",
    requestOwner,
  );
  const journalPath = join(fixture.coordinator.stateRoot, "journal.json");
  const durableJournal = readFileSync(journalPath, "utf8");

  rmSync(fixture.ownerPath);
  mkdirSync(fixture.ownerPath);
  assert.throws(
    () =>
      fixture.coordinator.dispatch("cancel-request", {
        requestId: registration.requestId,
        capability: capabilityFor(registration.requestId),
        owner: requestOwner,
        reason: "must not mutate after an authority probe error",
      }),
    (error) => error.code === "EISDIR",
  );

  const closed = await fixture.coordinator.closed;
  assert.equal(closed.reason, "fatal-error");
  assert.equal(closed.legacyRelease.released, false);
  assert.equal(closed.legacyRelease.reason, "fatal-error");
  assert.equal(readFileSync(journalPath, "utf8"), durableJournal);
});

test(
  "owner sweeping stops before mutation after legacy authority loss",
  { timeout: 3_000 },
  async () => {
    let reportDead = false;
    const fixture = await createLegacyFixture({
      ownerSweepMs: 20,
      ownerObserver: (identity) => ({
        state: reportDead ? "dead" : "live",
        startUtc: identity.startUtc,
      }),
    });
    const requestOwner = owner(200);
    await register(
      fixture,
      "authority-owner-sweep",
      "authority-owner-sweep-fingerprint",
      requestOwner,
    );
    const journalPath = join(fixture.coordinator.stateRoot, "journal.json");
    const durableBeforeSweep = readFileSync(journalPath, "utf8");

    displaceLegacyAuthority(fixture);
    reportDead = true;
    const closed = await fixture.coordinator.closed;
    assert.equal(closed.reason, "legacy-authority-lost");
    assert.equal(readFileSync(journalPath, "utf8"), durableBeforeSweep);
  },
);

test("idle pruning stops before mutation after legacy authority loss", async () => {
  let clock = Date.parse("2026-08-21T14:00:00.000Z");
  const fixture = await createLegacyFixture({ now: () => clock });
  const requestOwner = owner(201);
  const fingerprint = "authority-idle-prune-fingerprint";
  const request = await register(
    fixture,
    "authority-idle-prune",
    fingerprint,
    requestOwner,
  );
  await rpc(fixture, "publish-result", {
    requestId: request.requestId,
    owner: requestOwner,
    status: "success",
    payload: { source: "authority-idle-prune-regression" },
  });
  await acknowledgeResult(fixture, request.requestId, requestOwner);
  const journalPath = join(fixture.coordinator.stateRoot, "journal.json");
  const resultPath = join(
    fixture.coordinator.stateRoot,
    "results",
    fingerprintHash(fingerprint),
    `${request.executionId}.json`,
  );
  const durableBeforePrune = readFileSync(journalPath, "utf8");
  assert.equal(existsSync(resultPath), true);

  clock += RECORD_RETENTION_MS + 1;
  displaceLegacyAuthority(fixture);
  fixture.coordinator.core.emit("change");
  const closed = await fixture.coordinator.closed;
  assert.equal(closed.reason, "legacy-authority-lost");
  assert.equal(readFileSync(journalPath, "utf8"), durableBeforePrune);
  assert.equal(existsSync(resultPath), true);
});

test("legacy authority loss cannot grant a queued lease after release", async () => {
  const fixture = await createLegacyFixture();
  const activeOwner = owner(194);
  const queuedOwner = owner(195);
  await register(
    fixture,
    "authority-active",
    "authority-active-fp",
    activeOwner,
  );
  await register(
    fixture,
    "authority-queued",
    "authority-queued-fp",
    queuedOwner,
  );
  assert.equal(
    (
      await lease(
        fixture,
        "authority-active",
        "authority-active-lease",
        activeOwner,
      )
    ).status,
    "granted",
  );
  assert.equal(
    (
      await lease(
        fixture,
        "authority-queued",
        "authority-queued-lease",
        queuedOwner,
      )
    ).status,
    "queued",
  );

  const waiter = await connectCoordinator({ root: fixture.root });
  const waitOutcome = waiter
    .request("wait-lease", {
      leaseId: "authority-queued-lease",
      capability: capabilityFor("authority-queued"),
      owner: queuedOwner,
      timeoutMs: 2_000,
    })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  await waiter.request("ping");
  displaceLegacyAuthority(fixture);

  assert.throws(
    () =>
      fixture.coordinator.core.releaseLease({
        requestId: "authority-active",
        leaseId: "authority-active-lease",
        capability: capabilityFor("authority-active"),
        owner: activeOwner,
      }),
    (error) => error.code === "LEGACY_AUTHORITY_LOST",
  );
  const queued = fixture.coordinator.core
    .inspect()
    .leases.find((candidate) => candidate.leaseId === "authority-queued-lease");
  assert.equal(queued.status, "queued");

  const persisted = JSON.parse(
    readFileSync(join(fixture.coordinator.stateRoot, "journal.json"), "utf8"),
  );
  assert.equal(persisted.leases["authority-active-lease"].status, "granted");
  assert.equal(persisted.leases["authority-queued-lease"].status, "queued");
  const waited = await waitOutcome;
  assert.equal(waited.value, undefined);
  assert.ok(
    ["CONNECTION_CLOSED", "COORDINATOR_STOPPING"].includes(waited.error?.code),
  );
  const closed = await fixture.coordinator.closed;
  assert.equal(closed.reason, "legacy-authority-lost");
  assert.equal(closed.legacyRelease.released, false);
  waiter.destroy();
});

test("legacy authority loss prevents success publication", async () => {
  const fixture = await createLegacyFixture();
  const requestOwner = owner(196);
  const fingerprint = "authority-result-fingerprint";
  await register(fixture, "authority-result", fingerprint, requestOwner);
  displaceLegacyAuthority(fixture);

  assert.throws(
    () =>
      fixture.coordinator.core.publishResult({
        requestId: "authority-result",
        capability: capabilityFor("authority-result"),
        owner: requestOwner,
        status: "success",
        payload: { source: "authority-loss-regression" },
      }),
    (error) => error.code === "LEGACY_AUTHORITY_LOST",
  );
  assert.equal(
    fixture.coordinator.core.readResult(fingerprint, "authority-result"),
    null,
  );
  const persisted = JSON.parse(
    readFileSync(join(fixture.coordinator.stateRoot, "journal.json"), "utf8"),
  );
  assert.equal(persisted.requests["authority-result"].resultReady, false);
  assert.ok(persisted.singleflights[fingerprintHash(fingerprint)]);
  const closed = await fixture.coordinator.closed;
  assert.equal(closed.reason, "legacy-authority-lost");
});

test("authority loss inside result publication cannot recover success", async () => {
  let fixture;
  fixture = await createLegacyFixture({
    resultWriter(path, value, equivalent) {
      const persisted = writeImmutable(path, value, equivalent);
      displaceLegacyAuthority(fixture);
      return persisted;
    },
  });
  const requestOwner = owner(197);
  const requestId = "authority-result-writer";
  const fingerprint = "authority-result-writer-fingerprint";
  const registration = await register(
    fixture,
    requestId,
    fingerprint,
    requestOwner,
  );
  const journalPath = join(fixture.coordinator.stateRoot, "journal.json");
  const durableJournal = readFileSync(journalPath, "utf8");
  const resultDirectory = join(
    fixture.coordinator.stateRoot,
    "results",
    fingerprintHash(fingerprint),
  );
  const resultPath = join(resultDirectory, `${registration.executionId}.json`);

  assert.throws(
    () =>
      fixture.coordinator.core.publishResult({
        requestId,
        capability: capabilityFor(requestId),
        owner: requestOwner,
        status: "success",
        payload: { source: "authority-loss-inside-result-writer" },
      }),
    (error) => error.code === "LEGACY_AUTHORITY_LOST",
  );
  assert.equal(existsSync(resultPath), false);
  assert.ok(
    readdirSync(resultDirectory).some((name) =>
      name.startsWith(`${registration.executionId}.json.staged-`),
    ),
  );
  assert.equal(readFileSync(journalPath, "utf8"), durableJournal);
  assert.equal(
    fixture.coordinator.core.readResult(fingerprint, registration.executionId),
    null,
  );
  assert.equal(
    (await fixture.coordinator.closed).reason,
    "legacy-authority-lost",
  );

  fixture.coordinator = await startCoordinator({
    root: fixture.root,
    capacity: 1,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-authority-result-writer-recovery-start",
    },
  });
  const recovered = await rpc(fixture, "request-status", {
    requestId,
    owner: requestOwner,
  });
  assert.equal(recovered.state, "active");
  assert.equal(recovered.result, undefined);
  const retry = await register(
    fixture,
    "authority-result-writer-retry",
    fingerprint,
    owner(198),
    { successMaxAgeMs: RECORD_RETENTION_MS },
  );
  assert.equal(retry.role, "follower");
  assert.equal(retry.executionId, registration.executionId);
});

test("legacy handoff is safe for mixed Bash field reads and releases by token", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-legacy-"));
  fixtures.push({ root, coordinator: null });
  chmodSync(root, 0o770);
  const sharedRootMode = statSync(root).mode & 0o777;
  const lockDirectory = join(root, "run.lock");
  mkdirSync(lockDirectory);
  const oldId = `legacy-host-${process.pid}-1000`;
  const oldStart = "Thu Aug 21 11:00:00 2026";
  writeFileSync(
    join(lockDirectory, "owner"),
    [
      `pid=${process.pid}`,
      "host=legacy-host",
      "started_at=1000",
      `start_utc=${oldStart}`,
      "worktree=/tmp/old-worktree",
      `token=${oldId}`,
      "",
    ].join("\n"),
  );
  const coordinatorIdentity = {
    pid: process.pid,
    startUtc: "Thu Aug 21 12:00:00 2026",
  };
  const generationId = `coordinator-host-${process.pid}-1001`;
  const legacy = adoptLegacyRunLock({
    lockRoot: root,
    expectedOwnerToken: oldId,
    generationToken: generationId,
    coordinatorIdentity,
  });
  assert.equal(statSync(root).mode & 0o777, sharedRootMode);
  const current = ownerFields(join(lockDirectory, "owner"));
  assert.equal(current.start_utc, "");
  assert.equal(current.coordinator_start_utc, coordinatorIdentity.startUtc);
  assert.equal(current.token, generationId);

  // The old reader fetches PID before start_utc. Replacement is monotonic, so
  // the forced cross-version combinations are old PID/new blank start or new
  // PID/new blank start. Both fall back to live PID existence.
  const oldReaderWouldReclaim = (pid, recordedStart, livePids) =>
    recordedStart ? recordedStart !== oldStart : !livePids.has(pid);
  const livePids = new Set([String(process.pid)]);
  assert.equal(
    oldReaderWouldReclaim(String(process.pid), current.start_utc, livePids),
    false,
  );
  assert.equal(legacy.authority().owned, true);
  assert.equal(existsSync(legacy.markerPath), true);
  for (const name of [
    "owner.claiming.2147483645",
    "owner.coordinator.2147483646",
    "owner.rollback.2147483647",
  ]) {
    writeFileSync(join(lockDirectory, name), "unpublished owner stage\n");
  }

  const released = legacy.releaseIfOwned();
  assert.equal(released.released, true);
  assert.equal(existsSync(lockDirectory), false);
  assert.equal(existsSync(legacy.markerPath), false);
});

test("legacy release failure settles every close caller after restoring ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "qg-close-release-"));
  const legacyRoot = join(root, "legacy");
  const lockDirectory = join(legacyRoot, "run.lock");
  const ownerPath = join(lockDirectory, "owner");
  mkdirSync(lockDirectory, { recursive: true });
  const oldId = `legacy-close-${process.pid}-1300`;
  const generationId = `coordinator-close-${process.pid}-1301`;
  writeFileSync(
    ownerPath,
    `pid=${process.pid}\nhost=legacy-close\nstart_utc=\ntoken=${oldId}\n`,
  );
  const fixture = { root, coordinator: null, policyHash: DEFAULT_POLICY_HASH };
  fixtures.push(fixture);
  fixture.coordinator = await startCoordinator({
    root,
    legacyLockRoot: legacyRoot,
    legacyOwnerToken: oldId,
    generationToken: generationId,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-close-release-process-start",
    },
  });
  const socketPath = fixture.coordinator.socketPath;
  const markerPath = fixture.coordinator.metadata.markerPath;
  const adoptedOwner = readFileSync(ownerPath, "utf8");
  const markerHolders = () => {
    const result = spawnSync("lsof", ["-w", "-t", "--", markerPath], {
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    assert.ok([0, 1].includes(result.status));
    return result.stdout.trim().split(/\s+/).filter(Boolean);
  };
  assert.ok(markerHolders().includes(String(process.pid)));
  const retainedEntries = [
    "inert",
    "owner.claiming.0",
    "owner.claiming.12.extra",
    "owner.reclaiming.12",
    `owner.claiming.${process.pid}`,
    `owner.coordinator.${process.pid}`,
    `owner.rollback.${process.pid}`,
  ];
  for (const name of retainedEntries) {
    writeFileSync(join(lockDirectory, name), "keep run.lock non-empty\n");
  }

  const firstClose = fixture.coordinator.close("release-failure-test");
  const concurrentClose = fixture.coordinator.close("ignored-concurrent");
  assert.strictEqual(concurrentClose, firstClose);
  const [firstOutcome, concurrentOutcome, projectedOutcome] = await Promise.all(
    [firstClose, concurrentClose, fixture.coordinator.closed],
  );
  assert.strictEqual(concurrentOutcome, firstOutcome);
  assert.strictEqual(projectedOutcome, firstOutcome);
  assert.equal(firstOutcome.reason, "release-failure-test");
  assert.equal(firstOutcome.legacyRelease.released, false);
  assert.equal(firstOutcome.legacyRelease.reason, "release-failed");
  assert.equal(firstOutcome.legacyRelease.error.code, "LEGACY_RELEASE_FAILED");
  assert.match(
    firstOutcome.legacyRelease.error.message,
    /could not remove legacy run\.lock/,
  );

  const sequentialClose = fixture.coordinator.close("ignored-sequential");
  assert.strictEqual(sequentialClose, firstClose);
  assert.strictEqual(await sequentialClose, firstOutcome);
  assert.equal(existsSync(socketPath), false);
  assert.equal(readFileSync(ownerPath, "utf8"), adoptedOwner);
  assert.equal(existsSync(markerPath), true);
  for (const name of retainedEntries) {
    assert.equal(existsSync(join(lockDirectory, name)), true);
  }
  assert.deepEqual(markerHolders(), []);
});

test("legacy release never removes a successor owner", () => {
  for (const phase of ["before-take", "after-take", "before-restore"]) {
    const root = mkdtempSync(
      join(tmpdir(), `quality-gate-legacy-release-${phase}-`),
    );
    fixtures.push({ root, coordinator: null });
    const lockDirectory = join(root, "run.lock");
    const ownerPath = join(lockDirectory, "owner");
    mkdirSync(lockDirectory);
    const oldId = `legacy-release-${phase}-${process.pid}-1400`;
    const generationId = `coordinator-release-${phase}-${process.pid}-1401`;
    const successorId = `legacy-successor-${phase}-${process.pid}-1402`;
    const successorOwner = `pid=${process.pid}\nstart_utc=successor\ntoken=${successorId}\n`;
    writeFileSync(
      ownerPath,
      `pid=${process.pid}\nstart_utc=old\ntoken=${oldId}\n`,
    );
    const legacy = adoptLegacyRunLock({
      lockRoot: root,
      expectedOwnerToken: oldId,
      generationToken: generationId,
      coordinatorIdentity: {
        pid: process.pid,
        startUtc: `test-release-${phase}-process-start`,
      },
      beforeReleaseOwnerTake:
        phase === "before-take"
          ? () => writeFileSync(ownerPath, successorOwner)
          : null,
      afterReleaseOwnerVisibleTake:
        phase === "before-take"
          ? ({ releaseTaken }) => {
              assert.equal(existsSync(ownerPath), false);
              assert.ok(releaseTaken.startsWith(`${lockDirectory}/`));
              assert.match(
                basename(releaseTaken),
                /^owner\.reclaiming\.release\.coordinator\./,
              );
              assert.equal(ownerFields(releaseTaken).token, successorId);
            }
          : null,
      afterReleaseOwnerTake:
        phase === "after-take"
          ? () => writeFileSync(ownerPath, successorOwner, { flag: "wx" })
          : null,
      beforeReleaseOwnerRestore:
        phase === "before-restore"
          ? () => writeFileSync(ownerPath, successorOwner, { flag: "wx" })
          : null,
    });
    if (phase === "before-restore") {
      writeFileSync(join(lockDirectory, "release-blocker"), "block rmdir\n");
    }

    const released = legacy.releaseIfOwned();
    assert.equal(released.released, false);
    assert.equal(released.reason, "authority-changed");
    assert.equal(ownerFields(ownerPath).token, successorId);
    assert.deepEqual(
      readdirSync(lockDirectory).sort(),
      phase === "before-restore" ? ["owner", "release-blocker"] : ["owner"],
    );
    assert.equal(
      readdirSync(root).some((entry) => entry.startsWith(".owner-release.")),
      false,
    );
  }
});

test("legacy release leaves a live successor recovery-visible across SIGKILL", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-release-crash-"));
  fixtures.push({ root, coordinator: null });
  const lockDirectory = join(root, "run.lock");
  const ownerPath = join(lockDirectory, "owner");
  mkdirSync(lockDirectory);
  const oldId = `legacy-release-crash-${process.pid}-1500`;
  const generationId = `coordinator-release-crash-${process.pid}-1501`;
  const successorId = `legacy-successor-crash-${process.pid}-1502`;
  const successorStart = processStartUtc(process.pid);
  assert.ok(successorStart);
  writeFileSync(
    ownerPath,
    `pid=${process.pid}\nstart_utc=old\ntoken=${oldId}\n`,
  );
  const helperPath = join(root, "release-crash.mjs");
  const legacyModuleUrl = new URL(
    "./quality-gate-coordinator-legacy.mjs",
    import.meta.url,
  ).href;
  writeFileSync(
    helperPath,
    [
      'import { writeFileSync } from "node:fs";',
      `import { adoptLegacyRunLock, processStartUtc } from ${JSON.stringify(legacyModuleUrl)};`,
      "const [lockRoot, expectedOwnerToken, generationToken, successorToken, successorPid, successorStart] = process.argv.slice(2);",
      "const ownerPath = `${lockRoot}/run.lock/owner`;",
      "const legacy = adoptLegacyRunLock({",
      "  lockRoot,",
      "  expectedOwnerToken,",
      "  generationToken,",
      "  coordinatorIdentity: { pid: process.pid, startUtc: processStartUtc(process.pid) },",
      "  beforeReleaseOwnerTake: () => {",
      "    writeFileSync(ownerPath, `pid=${successorPid}\\nstart_utc=${successorStart}\\ntoken=${successorToken}\\n`);",
      "  },",
      '  afterReleaseOwnerVisibleTake: () => process.kill(process.pid, "SIGKILL"),',
      "});",
      "legacy.releaseIfOwned();",
      "",
    ].join("\n"),
  );

  const crashed = spawnSync(
    process.execPath,
    [
      helperPath,
      root,
      oldId,
      generationId,
      successorId,
      String(process.pid),
      successorStart,
    ],
    { encoding: "utf8" },
  );
  assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
  assert.equal(existsSync(ownerPath), false);
  const remnants = readdirSync(lockDirectory).filter((entry) =>
    entry.startsWith("owner.reclaiming.release.coordinator."),
  );
  assert.equal(remnants.length, 1);
  assert.equal(
    ownerFields(join(lockDirectory, remnants[0])).token,
    successorId,
  );
  assert.equal(
    readdirSync(root).some((entry) => entry.startsWith(".owner-release.")),
    false,
  );
});

test("legacy handoff never overwrites an owner published during adoption", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-legacy-race-"));
  fixtures.push({ root, coordinator: null });
  const lockDirectory = join(root, "run.lock");
  const ownerPath = join(lockDirectory, "owner");
  mkdirSync(lockDirectory);
  const expectedId = `legacy-race-${process.pid}-1100`;
  const successorId = `legacy-successor-${process.pid}-1101`;
  const generationId = `legacy-coordinator-${process.pid}-1102`;
  const successorGenerationId = `legacy-coordinator-${process.pid}-1103`;
  writeFileSync(
    ownerPath,
    `pid=${process.pid}\nstart_utc=old\ntoken=${expectedId}\n`,
  );

  assert.throws(
    () =>
      adoptLegacyRunLock({
        lockRoot: root,
        expectedOwnerToken: expectedId,
        generationToken: generationId,
        coordinatorIdentity: {
          pid: process.pid,
          startUtc: "Thu Aug 21 12:30:00 2026",
        },
        beforeOwnerPublish: () => {
          writeFileSync(
            ownerPath,
            `pid=${process.pid}\nstart_utc=successor\ntoken=${successorId}\n`,
          );
        },
      }),
    (error) => error.code === "LEGACY_HANDOFF_MISMATCH",
  );
  assert.equal(ownerFields(ownerPath).token, successorId);
  assert.equal(existsSync(join(root, `holder.${generationId}`)), false);
  assert.deepEqual(readdirSync(lockDirectory), ["owner"]);
  assert.equal(
    readFileSync(join(root, "condemned.d", expectedId), "utf8").trim(),
    expectedId,
  );

  const successor = adoptLegacyRunLock({
    lockRoot: root,
    expectedOwnerToken: successorId,
    generationToken: successorGenerationId,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "Thu Aug 21 12:31:00 2026",
    },
  });
  assert.equal(successor.authority().owned, true);
  assert.equal(successor.releaseIfOwned().released, true);
  assert.equal(existsSync(lockDirectory), false);
});

test("legacy handoff keeps its taken owner when condemnation cannot publish", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-legacy-fail-closed-"));
  fixtures.push({ root, coordinator: null });
  const lockDirectory = join(root, "run.lock");
  const ownerPath = join(lockDirectory, "owner");
  mkdirSync(lockDirectory);
  const expectedId = `legacy-blocked-${process.pid}-1200`;
  const successorId = `legacy-successor-${process.pid}-1201`;
  const generationId = `legacy-coordinator-${process.pid}-1202`;
  writeFileSync(
    ownerPath,
    `pid=${process.pid}\nstart_utc=old\ntoken=${expectedId}\n`,
  );
  writeFileSync(join(root, "condemned.d"), "not-a-directory\n");

  assert.throws(
    () =>
      adoptLegacyRunLock({
        lockRoot: root,
        expectedOwnerToken: expectedId,
        generationToken: generationId,
        coordinatorIdentity: {
          pid: process.pid,
          startUtc: "Thu Aug 21 12:40:00 2026",
        },
        beforeOwnerPublish: () => {
          writeFileSync(
            ownerPath,
            `pid=${process.pid}\nstart_utc=successor\ntoken=${successorId}\n`,
          );
        },
      }),
    (error) => error.code === "LEGACY_OBLIGATION_UNWRITABLE",
  );
  const entries = readdirSync(lockDirectory).sort();
  const remnant = entries.find((entry) =>
    entry.startsWith("owner.reclaiming.coordinator."),
  );
  assert.equal(entries.length, 2);
  assert.ok(remnant);
  assert.equal(ownerFields(ownerPath).token, successorId);
  assert.equal(ownerFields(join(lockDirectory, remnant)).token, expectedId);
  assert.equal(existsSync(join(root, `holder.${generationId}`)), false);
});

test("zombie process identities are stale before their parent reaps them", async (t) => {
  const available = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (available.error || available.status !== 0) {
    t.skip("python3 is required to create a portable zombie fixture");
    return;
  }
  const parent = spawn(
    "python3",
    [
      "-c",
      [
        "import subprocess, sys, time",
        "child = subprocess.Popen([sys.executable, '-c', 'pass'])",
        "print(child.pid, flush=True)",
        "time.sleep(30)",
      ].join("; "),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    const zombiePid = await new Promise((resolvePid, rejectPid) => {
      let output = "";
      parent.stdout.setEncoding("utf8");
      parent.stdout.on("data", (chunk) => {
        output += chunk;
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        const parsed = Number(output.slice(0, newline));
        if (Number.isSafeInteger(parsed) && parsed > 0) resolvePid(parsed);
        else rejectPid(new Error(`invalid zombie fixture PID: ${output}`));
      });
      parent.once("error", rejectPid);
      parent.once("exit", (code) => {
        rejectPid(new Error(`zombie fixture parent exited early with ${code}`));
      });
    });
    const startUtc = await waitUntil(() => processStartUtc(zombiePid));
    const observed = await waitUntil(() => {
      const current = observeProcessIdentity({ pid: zombiePid, startUtc });
      return current.state === "dead" ? current : null;
    });
    assert.equal(observed.startUtc, startUtc);
    assert.equal(
      observeProcessIdentity({ pid: zombiePid, startUtc: `${startUtc}-other` })
        .state,
      "reused",
    );
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      parent.kill("SIGTERM");
      await once(parent, "exit");
    }
  }
});

test("policy and capacity changes each use a fresh state namespace", async () => {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-policy-upgrade-"));
  const fixture = { root, coordinator: null, policyHash: DEFAULT_POLICY_HASH };
  fixtures.push(fixture);
  const firstGenerationId = `policy-host-${process.pid}-3001`;
  fixture.coordinator = await startCoordinator({
    root,
    capacity: 2,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-coordinator-process-start",
    },
    generationToken: firstGenerationId,
  });
  const firstStateRoot = fixture.coordinator.stateRoot;
  await fixture.coordinator.close("policy-upgrade");

  const nextPolicyHash = "a".repeat(64);
  const nextGenerationId = `policy-host-${process.pid}-3002`;
  fixture.policyHash = nextPolicyHash;
  fixture.coordinator = await startCoordinator({
    root,
    policyHash: nextPolicyHash,
    capacity: 2,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-coordinator-process-start",
    },
    generationToken: nextGenerationId,
  });
  assert.notEqual(fixture.coordinator.stateRoot, firstStateRoot);
  assert.equal(
    fixture.coordinator.stateRoot,
    stateNamespace(root, nextPolicyHash, 2),
  );
  assert.equal(existsSync(firstStateRoot), false);
  assert.equal(
    existsSync(join(fixture.coordinator.stateRoot, "journal.json")),
    true,
  );
  assert.equal((await status(fixture)).capacity, 2);

  const secondStateRoot = fixture.coordinator.stateRoot;
  await fixture.coordinator.close("capacity-upgrade");
  const capacityGenerationId = `policy-host-${process.pid}-3003`;
  fixture.coordinator = await startCoordinator({
    root,
    policyHash: nextPolicyHash,
    capacity: 4,
    idleMs: 30_000,
    ownerSweepMs: 0,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-coordinator-process-start",
    },
    generationToken: capacityGenerationId,
  });
  assert.notEqual(fixture.coordinator.stateRoot, secondStateRoot);
  assert.equal(
    fixture.coordinator.stateRoot,
    stateNamespace(root, nextPolicyHash, 4),
  );
  assert.equal(existsSync(secondStateRoot), false);
  assert.equal((await status(fixture)).capacity, 4);
  assert.throws(
    () => stateNamespace(root, nextPolicyHash, 0),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});

test("inactive retention keeps invalid and newer-protocol namespaces", () => {
  const root = mkdtempSync(join(tmpdir(), "qg-invalid-namespace-retention-"));
  fixtures.push({ root, coordinator: null });
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory);
  const capacity = 2;
  const coordinatorIdentity = {
    pid: process.pid,
    startUtc: "test-inactive-namespace-validation",
  };
  const createNamespace = (name, state) => {
    const path = join(stateDirectory, name);
    mkdirSync(path);
    mkdirSync(join(path, "requests"));
    mkdirSync(join(path, "results"));
    writeFileSync(join(path, "journal.json"), `${JSON.stringify(state)}\n`);
    return path;
  };

  const invalidJournalPolicy = "1".repeat(64);
  const currentProtocolName = `v${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`;
  const invalidJournalName = `${currentProtocolName}-${invalidJournalPolicy}-c${capacity}`;
  const invalidJournalState = initialState(
    capacity,
    invalidJournalPolicy,
    coordinatorIdentity,
    runToken("invalid-journal", process.pid, 7001),
  );
  invalidJournalState.revision = "invalid";
  const invalidJournalPath = createNamespace(
    invalidJournalName,
    invalidJournalState,
  );
  const invalidJournalBytes = readFileSync(
    join(invalidJournalPath, "journal.json"),
    "utf8",
  );

  const invalidResultPolicy = "2".repeat(64);
  const invalidResultName = `${currentProtocolName}-${invalidResultPolicy}-c${capacity}`;
  const invalidResultPath = createNamespace(
    invalidResultName,
    initialState(
      capacity,
      invalidResultPolicy,
      coordinatorIdentity,
      runToken("invalid-result", process.pid, 7002),
    ),
  );
  const orphanRequestPath = join(
    invalidResultPath,
    "requests",
    "orphan-request.json",
  );
  writeFileSync(orphanRequestPath, "retained request evidence\n");
  const invalidResultDirectory = join(
    invalidResultPath,
    "results",
    "4".repeat(64),
  );
  mkdirSync(invalidResultDirectory);
  const invalidResultRecordPath = join(
    invalidResultDirectory,
    "invalid-retained-result.json",
  );
  writeFileSync(invalidResultRecordPath, "{\n");

  const newerPolicy = "3".repeat(64);
  const newerMajor = PROTOCOL_VERSION.major + 1;
  const newerName = `v${newerMajor}.0-${newerPolicy}-c${capacity}`;
  const newerState = initialState(
    capacity,
    newerPolicy,
    coordinatorIdentity,
    runToken("newer-protocol", process.pid, 7003),
  );
  newerState.protocol = { major: newerMajor, minor: 0 };
  const newerPath = createNamespace(newerName, newerState);
  const deletionMarkerPath = join(newerPath, ".deleting-v1");
  writeFileSync(deletionMarkerPath, "quality-gate-namespace-deletion-v1\n");

  const outcome = pruneInactiveNamespaces({
    root,
    activeStateRoot: join(stateDirectory, "active-namespace"),
    now: Date.parse("2026-08-22T12:00:00.000Z"),
  });

  assert.equal(outcome.scanned, 3);
  assert.equal(outcome.removed, 0);
  assert.ok(
    outcome.warnings.includes(
      `${invalidJournalName}: journal state is invalid at revision: must be a non-negative safe integer`,
    ),
  );
  assert.ok(
    outcome.warnings.some(
      (warning) =>
        warning.startsWith(
          `${invalidResultName}: terminal result is invalid at result: must be valid JSON`,
        ) && warning.includes(invalidResultRecordPath),
    ),
  );
  assert.ok(
    outcome.warnings.includes(
      `${newerName}: unsupported namespace protocol v${newerMajor}.0`,
    ),
  );
  assert.equal(
    readFileSync(join(invalidJournalPath, "journal.json"), "utf8"),
    invalidJournalBytes,
  );
  assert.equal(existsSync(orphanRequestPath), true);
  assert.equal(existsSync(invalidResultRecordPath), true);
  assert.equal(existsSync(deletionMarkerPath), true);
  assert.equal(existsSync(newerPath), true);
});

test("startup resumes only valid partial namespace deletions", async () => {
  const fixture = await createFixture({ capacity: 2 });
  const stateDirectory = join(fixture.root, "state");
  const activeJournalPath = join(fixture.coordinator.stateRoot, "journal.json");
  const stagedOwner = owner(263);
  const stagedRequest = await register(
    fixture,
    "namespace-deletion-staging-active",
    "namespace-deletion-staging-active-fingerprint",
    stagedOwner,
  );
  const nonIdleJournal = readFileSync(activeJournalPath, "utf8");
  await rpc(fixture, "cancel-request", {
    requestId: stagedRequest.requestId,
    owner: stagedOwner,
    reason: "prepare an exact non-idle deletion-staging journal",
  });
  await acknowledgeResult(fixture, stagedRequest.requestId, stagedOwner);
  const idleJournal = readFileSync(activeJournalPath, "utf8");
  await fixture.coordinator.close("namespace-deletion-fixture-ready");

  const namespacePath = (index) =>
    join(
      stateDirectory,
      `v${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}-${index
        .toString(16)
        .padStart(64, "0")}-c2`,
    );
  const markerName = ".deleting-v1";
  const markerStagingName = ".deleting-v1.staging";
  const markerContent = "quality-gate-namespace-deletion-v1\n";
  const protectedEntries = ["journal.json", "requests", "results"];
  const createCanonicalNamespace = (path, journal = idleJournal) => {
    const namespacedJournal = JSON.parse(journal);
    namespacedJournal.policyHash = basename(path).slice(5, 69);
    mkdirSync(path);
    writeFileSync(
      join(path, "journal.json"),
      `${JSON.stringify(namespacedJournal)}\n`,
    );
    mkdirSync(join(path, "requests"));
    mkdirSync(join(path, "results"));
  };
  const resumablePaths = [];
  for (let mask = 0; mask < 2 ** protectedEntries.length; mask += 1) {
    const path = namespacePath(mask + 1);
    mkdirSync(path);
    writeFileSync(join(path, markerName), markerContent);
    for (const [index, name] of protectedEntries.entries()) {
      if ((mask & (1 << index)) === 0) continue;
      if (name === "journal.json") writeFileSync(join(path, name), "{}\n");
      else mkdirSync(join(path, name));
    }
    resumablePaths.push(path);
  }
  const alreadyEmptyPath = namespacePath(9);
  mkdirSync(alreadyEmptyPath);
  resumablePaths.push(alreadyEmptyPath);

  const stageOnlyStates = [
    { path: namespacePath(12), content: markerContent },
    { path: namespacePath(13), content: "partial deletion marker bytes" },
  ];
  for (const state of stageOnlyStates) {
    createCanonicalNamespace(state.path, nonIdleJournal);
    writeFileSync(join(state.path, markerStagingName), state.content);
  }

  const markerAndStagePath = namespacePath(14);
  createCanonicalNamespace(markerAndStagePath);
  const markerAndStageStaging = join(markerAndStagePath, markerStagingName);
  writeFileSync(markerAndStageStaging, markerContent);
  linkSync(markerAndStageStaging, join(markerAndStagePath, markerName));
  assert.equal(statSync(markerAndStageStaging).nlink, 2);
  resumablePaths.push(markerAndStagePath);

  const invalidStagingPath = namespacePath(15);
  mkdirSync(invalidStagingPath);
  writeFileSync(join(invalidStagingPath, "journal.json"), idleJournal);
  mkdirSync(join(invalidStagingPath, "requests"));
  writeFileSync(join(invalidStagingPath, markerStagingName), markerContent);

  const malformedMarkerPath = namespacePath(10);
  mkdirSync(malformedMarkerPath);
  writeFileSync(join(malformedMarkerPath, markerName), "invalid marker\n");
  const unexpectedEntryPath = namespacePath(11);
  mkdirSync(unexpectedEntryPath);
  writeFileSync(join(unexpectedEntryPath, markerName), markerContent);
  writeFileSync(join(unexpectedEntryPath, "unexpected"), "must remain\n");

  const stderrWrites = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  };
  try {
    fixture.coordinator = await startCoordinator({
      root: fixture.root,
      capacity: 2,
      idleMs: 30_000,
      ownerSweepMs: 0,
      coordinatorIdentity: {
        pid: process.pid,
        startUtc: "test-namespace-deletion-recovery-start",
      },
    });
  } finally {
    process.stderr.write = originalStderrWrite;
  }

  assert.ok(resumablePaths.every((path) => !existsSync(path)));
  for (const state of stageOnlyStates) {
    assert.equal(existsSync(state.path), true);
    assert.equal(existsSync(join(state.path, markerStagingName)), false);
    assert.equal(existsSync(join(state.path, "journal.json")), true);
    assert.equal(existsSync(join(state.path, "requests")), true);
    assert.equal(existsSync(join(state.path, "results")), true);
  }
  assert.equal(existsSync(invalidStagingPath), true);
  assert.equal(existsSync(join(invalidStagingPath, markerStagingName)), true);
  assert.equal(existsSync(malformedMarkerPath), true);
  assert.equal(existsSync(unexpectedEntryPath), true);
  const warningText = stderrWrites.join("");
  for (const state of stageOnlyStates) {
    assert.ok(
      warningText.includes(`${basename(state.path)}: journal is not idle`),
    );
  }
  assert.ok(
    warningText.includes(
      `${basename(invalidStagingPath)}: namespace deletion staging state is invalid`,
    ),
  );
  assert.ok(
    warningText.includes(
      `${basename(malformedMarkerPath)}: namespace deletion marker is invalid`,
    ),
  );
  assert.ok(
    warningText.includes(
      `${basename(unexpectedEntryPath)}: namespace deletion has unexpected entry: unexpected`,
    ),
  );
});

test("obsolete namespaces retain recent results and remove them after expiry", async () => {
  let clock = Date.parse("2026-08-21T16:00:00.000Z");
  const root = mkdtempSync(join(tmpdir(), "qg-policy-ret-"));
  const fixture = { root, coordinator: null, policyHash: DEFAULT_POLICY_HASH };
  fixtures.push(fixture);
  fixture.coordinator = await startCoordinator({
    root,
    capacity: 2,
    idleMs: 30_000,
    ownerSweepMs: 0,
    now: () => clock,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-coordinator-process-start",
    },
  });
  const oldStateRoot = fixture.coordinator.stateRoot;
  const terminalOwner = owner(240);
  const terminal = await register(
    fixture,
    "obsolete-result",
    "obsolete-result-fp",
    terminalOwner,
  );
  await rpc(fixture, "publish-result", {
    requestId: terminal.requestId,
    owner: terminalOwner,
    status: "success",
    payload: { retainedAcrossPolicy: true },
  });
  await acknowledgeResult(fixture, terminal.requestId, terminalOwner);
  const oldArtifacts = [
    atomicTemporaryPath(oldStateRoot, "journal.json"),
    immutableStagingPath(
      join(oldStateRoot, "requests"),
      "obsolete-request-stage",
    ),
    immutableStagingPath(
      join(oldStateRoot, "results", fingerprintHash("obsolete-result-fp")),
      "obsolete-result-stage",
    ),
  ];
  for (const path of oldArtifacts) {
    writeFileSync(path, "obsolete writer bytes\n");
    setModifiedAt(path, clock);
  }
  await fixture.coordinator.close("first-policy-complete");

  fixture.policyHash = "b".repeat(64);
  fixture.coordinator = await startCoordinator({
    root,
    policyHash: fixture.policyHash,
    capacity: 2,
    idleMs: 30_000,
    ownerSweepMs: 0,
    now: () => clock,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-coordinator-process-start",
    },
  });
  assert.equal(existsSync(oldStateRoot), true);
  assert.ok(oldArtifacts.every((path) => existsSync(path)));
  await fixture.coordinator.close("second-policy-complete");

  clock += RECORD_RETENTION_MS + 1;
  fixture.policyHash = "c".repeat(64);
  fixture.coordinator = await startCoordinator({
    root,
    policyHash: fixture.policyHash,
    capacity: 2,
    idleMs: 30_000,
    ownerSweepMs: 0,
    now: () => clock,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-coordinator-process-start",
    },
  });
  assert.equal(existsSync(oldStateRoot), false);
});

test("inactive retention keeps a result when its index commit fails", async () => {
  let clock = Date.parse("2026-08-21T16:30:00.000Z");
  const root = mkdtempSync(join(tmpdir(), "qg-policy-ret-order-"));
  const fixture = { root, coordinator: null, policyHash: DEFAULT_POLICY_HASH };
  fixtures.push(fixture);
  fixture.coordinator = await startCoordinator({
    root,
    capacity: 2,
    idleMs: 30_000,
    ownerSweepMs: 0,
    now: () => clock,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-inactive-retention-first-policy",
    },
  });
  const oldStateRoot = fixture.coordinator.stateRoot;
  const requestOwner = owner(256);
  const fingerprint = "inactive-retention-journal-order-fingerprint";
  const hash = fingerprintHash(fingerprint);
  const registration = await register(
    fixture,
    "inactive-retention-journal-order",
    fingerprint,
    requestOwner,
  );
  await rpc(fixture, "publish-result", {
    requestId: registration.requestId,
    owner: requestOwner,
    status: "success",
    payload: { retainedAcrossInactiveCommitFailure: true },
  });
  await acknowledgeResult(fixture, registration.requestId, requestOwner);
  const oldJournalPath = join(oldStateRoot, "journal.json");
  const oldJournal = readFileSync(oldJournalPath, "utf8");
  const oldResultPath = join(
    oldStateRoot,
    "results",
    hash,
    `${registration.executionId}.json`,
  );
  const oldJournalTemporary = atomicTemporaryPath(oldStateRoot, "journal.json");
  writeFileSync(oldJournalTemporary, "partial inactive journal bytes\n");
  setModifiedAt(oldJournalTemporary, clock);
  await fixture.coordinator.close("inactive-retention-first-policy-complete");

  clock += RECORD_RETENTION_MS + 1;
  let failedOldJournalCommit = false;
  fixture.policyHash = "d".repeat(64);
  fixture.coordinator = await startCoordinator({
    root,
    policyHash: fixture.policyHash,
    capacity: 2,
    idleMs: 30_000,
    ownerSweepMs: 0,
    now: () => clock,
    journalWriter(path, value) {
      if (path === oldJournalPath) {
        failedOldJournalCommit = true;
        const error = new Error("injected inactive retention journal failure");
        error.code = "EIO";
        throw error;
      }
      writeAtomicJson(path, value);
    },
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-inactive-retention-second-policy",
    },
  });
  assert.equal(failedOldJournalCommit, true);
  assert.equal(readFileSync(oldJournalPath, "utf8"), oldJournal);
  assert.equal(existsSync(oldResultPath), true);
  assert.equal(existsSync(oldJournalTemporary), true);
  await fixture.coordinator.close("inactive-retention-failed-prune-complete");

  fixture.policyHash = DEFAULT_POLICY_HASH;
  fixture.coordinator = await startCoordinator({
    root,
    capacity: 2,
    idleMs: 30_000,
    ownerSweepMs: 0,
    now: () => clock,
    coordinatorIdentity: {
      pid: process.pid,
      startUtc: "test-inactive-retention-restart",
    },
  });
  assert.equal(existsSync(oldResultPath), false);
  assert.equal(existsSync(oldJournalTemporary), false);
  assert.equal(
    JSON.parse(readFileSync(oldJournalPath, "utf8")).successIndex[hash],
    undefined,
  );
});

test("startup source attestation guards every authority transition", async (t) => {
  const phases = [
    "state setup",
    "socket bind",
    "state initialization",
    "legacy adoption",
    "startup maintenance",
    "ready publication",
  ];
  for (const failurePhase of phases) {
    await t.test(failurePhase, async () => {
      const parent = mkdtempSync("/tmp/qga-");
      const root = join(parent, "c");
      const legacyRoot = join(parent, "l");
      const lockDirectory = join(legacyRoot, "run.lock");
      const ownerPath = join(lockDirectory, "owner");
      const readyFile = join(root, "ready.json");
      const legacyOwnerToken = runToken(
        ["attestation", "owner", randomUUID()].join("-"),
        process.pid,
        6001,
      );
      const generationToken = runToken(
        ["attestation", "coordinator", randomUUID()].join("-"),
        process.pid,
        6002,
      );
      mkdirSync(lockDirectory, { recursive: true });
      writeFileSync(
        ownerPath,
        `pid=${process.pid}\nhost=test-host\nstart_utc=\ntoken=${legacyOwnerToken}\n`,
      );
      fixtures.push({ root: parent, coordinator: null });
      const expectedStateRoot = stateNamespace(
        root,
        DEFAULT_POLICY_HASH,
        DEFAULT_CAPACITY,
      );

      let sourceRevision = 0;
      const observedPhases = [];
      const sourceAttestor = () => {
        if (sourceRevision !== 0) {
          throw new CoordinatorError(
            "POLICY_IDENTITY_CHANGED",
            "injected source mutation after initial selection",
          );
        }
        return DEFAULT_POLICY_HASH;
      };
      assert.equal(sourceAttestor(), DEFAULT_POLICY_HASH);

      await assert.rejects(
        startCoordinator({
          root,
          legacyLockRoot: legacyRoot,
          legacyOwnerToken,
          generationToken,
          readyFile,
          idleMs: 30_000,
          ownerSweepMs: 0,
          coordinatorIdentity: {
            pid: process.pid,
            startUtc: "test-source-attestation-coordinator",
          },
          sourceAttestor,
          beforeSourceAttestation({ phase, socketPath, stateRoot }) {
            observedPhases.push(phase);
            if (phase !== failurePhase) return;
            if (phase === "state setup") {
              assert.equal(existsSync(root), false);
            }
            if (["state setup", "socket bind"].includes(phase)) {
              assert.equal(existsSync(socketPath), false);
            } else {
              assert.equal(existsSync(socketPath), true);
            }
            if (phase === "state initialization") {
              assert.equal(stateRoot, expectedStateRoot);
              assert.equal(existsSync(stateRoot), false);
            }
            if (phase === "legacy adoption") {
              assert.equal(
                existsSync(join(expectedStateRoot, "journal.json")),
                true,
              );
            }
            assert.equal(
              ownerFields(ownerPath).token,
              ["startup maintenance", "ready publication"].includes(phase)
                ? generationToken
                : legacyOwnerToken,
            );
            sourceRevision += 1;
          },
        }),
        (error) => error.code === "POLICY_IDENTITY_CHANGED",
      );

      assert.deepEqual(
        observedPhases,
        phases.slice(0, phases.indexOf(failurePhase) + 1),
      );
      assert.equal(
        existsSync(socketPathForRoot(root)),
        false,
        "failed startup left its socket bound",
      );
      assert.equal(ownerFields(ownerPath).token, legacyOwnerToken);
      assert.equal(existsSync(join(root, "coordinator.json")), false);
      assert.equal(existsSync(readyFile), false);
      assert.equal(
        existsSync(join(legacyRoot, `holder.${generationToken}`)),
        false,
      );
    });
  }
});

test("ready publication failure removes its canonical metadata durably", async () => {
  const parent = mkdtempSync("/tmp/qgr-");
  const root = join(parent, "c");
  const legacyRoot = join(parent, "l");
  const lockDirectory = join(legacyRoot, "run.lock");
  const ownerPath = join(lockDirectory, "owner");
  const readyFile = join(root, "ready.json");
  const coordinatorFile = join(root, "coordinator.json");
  const legacyOwnerToken = runToken(
    ["ready", "rollback", "owner", randomUUID()].join("-"),
    process.pid,
    6101,
  );
  const generationToken = runToken(
    ["ready", "rollback", "coordinator", randomUUID()].join("-"),
    process.pid,
    6102,
  );
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(
    ownerPath,
    `pid=${process.pid}\nhost=test-host\nstart_utc=\ntoken=${legacyOwnerToken}\n`,
  );
  fixtures.push({ root: parent, coordinator: null });

  let readyRenamed = false;
  const cleanupSyncs = [];
  await assert.rejects(
    startCoordinator({
      root,
      legacyLockRoot: legacyRoot,
      legacyOwnerToken,
      generationToken,
      readyFile,
      idleMs: 30_000,
      ownerSweepMs: 0,
      coordinatorIdentity: {
        pid: process.pid,
        startUtc: "test-ready-rollback-coordinator",
      },
      readyMetadataWriter(path, value) {
        writeAtomicJson(path, value);
        if (path === readyFile) {
          readyRenamed = true;
          const error = new Error("injected failure after ready rename");
          error.code = "EIO";
          throw error;
        }
      },
      directorySync(path) {
        syncDirectory(path);
        if (readyRenamed) cleanupSyncs.push(path);
      },
    }),
    (error) => error.code === "EIO",
  );

  assert.equal(readyRenamed, true);
  assert.equal(existsSync(coordinatorFile), false);
  assert.equal(existsSync(readyFile), false);
  assert.equal(existsSync(socketPathForRoot(root)), false);
  assert.equal(ownerFields(ownerPath).token, legacyOwnerToken);
  assert.equal(
    existsSync(join(legacyRoot, `holder.${generationToken}`)),
    false,
  );
  assert.deepEqual(cleanupSyncs, [root, root]);
});

test("detached start rejects ready metadata without live child authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-ready-race-"));
  fixtures.push({ root, coordinator: null });
  const childPid = process.pid;
  const generationToken = runToken(
    `ready-race-${randomUUID()}`,
    childPid,
    6201,
  );
  let readyFile = null;
  let unrefCalled = false;
  const child = {
    pid: childPid,
    exitCode: 1,
    signalCode: null,
    once() {},
    unref() {
      unrefCalled = true;
    },
  };
  const parsed = {
    values: new Map([
      ["--root", root],
      ["--startup-timeout-ms", "250"],
    ]),
  };

  await assert.rejects(
    startDetached(parsed, ["start", "--root", root], DEFAULT_POLICY_HASH, {
      spawnChild(_executable, args) {
        const readyIndex = args.indexOf("--ready-file");
        readyFile = args[readyIndex + 1];
        writeAtomicJson(readyFile, {
          protocol: PROTOCOL_VERSION,
          policyHash: DEFAULT_POLICY_HASH,
          capacity: DEFAULT_CAPACITY,
          socketPath: socketPathForRoot(root),
          stateRoot: stateNamespace(
            root,
            DEFAULT_POLICY_HASH,
            DEFAULT_CAPACITY,
          ),
          coordinatorIdentity: {
            pid: childPid,
            startUtc: "test-ready-race-child",
          },
          generationToken,
          markerPath: null,
          authority: {
            owned: false,
            mode: "no-legacy-lock",
            generationToken,
          },
          readyAt: new Date().toISOString(),
        });
        return child;
      },
    }),
    (error) =>
      error.code === "COORDINATOR_START_FAILED" &&
      error.details?.cause?.includes("coordinator.sock"),
  );
  assert.equal(unrefCalled, false);
  assert.equal(existsSync(readyFile), false);
});

test(
  "startup binds before legacy adoption and rejects early clients",
  { timeout: 5_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "quality-gate-start-order-"));
    const coordinatorRoot = root;
    const legacyRoot = join(root, "legacy");
    const lockDirectory = join(legacyRoot, "run.lock");
    mkdirSync(lockDirectory, { recursive: true });
    const oldId = `startup-host-${process.pid}-4001`;
    const generationId = `startup-host-${process.pid}-4002`;
    writeFileSync(
      join(lockDirectory, "owner"),
      `pid=${process.pid}\nhost=startup-host\nstart_utc=\ntoken=${oldId}\n`,
    );
    const fixture = {
      root,
      coordinator: null,
      policyHash: DEFAULT_POLICY_HASH,
    };
    fixtures.push(fixture);
    let releaseAdoption;
    let reachedBoundary;
    const boundary = new Promise((resolveBoundary) => {
      reachedBoundary = resolveBoundary;
    });
    const pause = new Promise((resolvePause) => {
      releaseAdoption = resolvePause;
    });
    const starting = startCoordinator({
      root: coordinatorRoot,
      legacyLockRoot: legacyRoot,
      legacyOwnerToken: oldId,
      generationToken: generationId,
      idleMs: 30_000,
      ownerSweepMs: 0,
      coordinatorIdentity: {
        pid: process.pid,
        startUtc: "test-coordinator-process-start",
      },
      beforeLegacyAdopt: async () => {
        reachedBoundary();
        await pause;
      },
    });
    await boundary;
    assert.equal(ownerFields(join(lockDirectory, "owner")).token, oldId);
    await resetCoordinatorConnection(
      socketPathForRoot(coordinatorRoot),
      '{"id":"abrupt-starting-client"',
    );
    const early = await connectCoordinator({ root: coordinatorRoot });
    await assert.rejects(
      early.request("ping"),
      (error) => error.code === "COORDINATOR_STARTING",
    );
    early.destroy();

    const stubborn = createConnection({
      path: socketPathForRoot(coordinatorRoot),
      allowHalfOpen: true,
    });
    stubborn.on("error", () => {});
    await once(stubborn, "connect");
    const stubbornClosed = once(stubborn, "close");
    const earlyResponse = once(stubborn, "data");
    stubborn.write('{"id":"stubborn-starting-client"}\n');
    await earlyResponse;

    releaseAdoption();
    fixture.coordinator = await starting;
    assert.equal(fixture.coordinator.metadata.authority.owned, true);
    await resetCoordinatorConnection(
      socketPathForRoot(coordinatorRoot),
      `${JSON.stringify({
        id: "abrupt-ready-client",
        protocol: PROTOCOL_VERSION,
        policyHash: DEFAULT_POLICY_HASH,
        action: "ping",
        params: {},
      })}\n`,
    );
    assert.equal(
      (await coordinatorRpc({ root: coordinatorRoot }, "ping")).capacity,
      3,
    );
    const stopped = await fixture.coordinator.close(
      "startup-client-regression",
    );
    stubborn.destroy();
    await stubbornClosed;
    assert.equal(stopped.legacyRelease.released, true);
  },
);

test("a connected server that never replies hits the RPC transport bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-silent-server-"));
  fixtures.push({ root, coordinator: null });
  const server = createServer((socket) => socket.on("data", () => {}));
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPathForRoot(root), resolveListen);
  });
  const startedAt = Date.now();
  await assert.rejects(
    coordinatorRpc({ root, rpcTimeoutMs: 40 }, "ping"),
    (error) => error.code === "TRANSPORT_TIMEOUT",
  );
  assert.ok(Date.now() - startedAt < 500);
  await new Promise((resolveClose) => server.close(resolveClose));
});

test("a private cancellation file stops a connected RPC wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-cancelled-rpc-"));
  fixtures.push({ root, coordinator: null });
  const cancellationFile = join(root, "wait-cancellation");
  writeFileSync(cancellationFile, "");
  const server = createServer((socket) => socket.on("data", () => {}));
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPathForRoot(root), resolveListen);
  });
  const cancelled = coordinatorRpc(
    { root, rpcTimeoutMs: 5_000, cancellationFile },
    "ping",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  writeFileSync(cancellationFile, "cancel\n");
  await assert.rejects(cancelled, (error) => error.code === "LOCAL_CANCELLED");
  await new Promise((resolveClose) => server.close(resolveClose));
});

test("detached start returns only after the private socket is ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-detached-"));
  fixtures.push({ root, coordinator: null });
  const entrypoint = fileURLToPath(
    new URL("./quality-gate-coordinator.mjs", import.meta.url),
  );
  writeFileSync(join(root, "coordinator.log"), "x".repeat(1024 * 1024 + 1));
  const started = spawnSync(
    process.execPath,
    [
      entrypoint,
      "start",
      "--root",
      root,
      "--idle-ms",
      "500",
      "--owner-sweep-ms",
      "0",
      "--startup-timeout-ms",
      "5000",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_QUALITY_GATE_REQUEST_CAPABILITY: capabilityFor(
          "detached-start-parent",
        ),
      },
    },
  );
  assert.equal(started.status, 0, started.stderr);
  const metadata = JSON.parse(started.stdout.trim());
  assert.equal(metadata.socketPath.endsWith("coordinator.sock"), true);
  assert.equal(existsSync(metadata.socketPath), true);
  const snapshot = await coordinatorRpc(
    { root, policyHash: metadata.policyHash },
    "inspect",
  );
  assert.equal(snapshot.capacity, 3);
  assert.equal(existsSync(join(root, "coordinator.log.1")), true);
  await waitUntil(() => !existsSync(metadata.socketPath), 2_000);
});

test("a detached startup timeout terminates and reaps its child", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-gate-start-timeout-"));
  fixtures.push({ root, coordinator: null });
  const entrypoint = fileURLToPath(
    new URL("./quality-gate-coordinator.mjs", import.meta.url),
  );
  const started = spawnSync(
    process.execPath,
    [
      entrypoint,
      "start",
      "--root",
      root,
      "--startup-timeout-ms",
      "0",
      "--idle-ms",
      "30000",
    ],
    { encoding: "utf8" },
  );
  assert.equal(started.status, 2, started.stdout);
  const failure = JSON.parse(started.stderr.trim());
  assert.equal(failure.error.code, "COORDINATOR_START_FAILED");
  assert.equal(failure.error.details.terminated, true);
  assert.throws(
    () => process.kill(failure.error.details.childPid, 0),
    (error) => error.code === "ESRCH",
  );
});

test("the coordinator exits after the configured idle interval", async () => {
  const fixture = await createFixture({ idleMs: 30 });
  const socketPath = fixture.coordinator.socketPath;
  const outcome = await Promise.race([
    fixture.coordinator.closed,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("coordinator did not exit when idle")),
        1_000,
      ),
    ),
  ]);
  assert.equal(outcome.reason, "idle");
  assert.equal(existsSync(socketPath), false);
});
