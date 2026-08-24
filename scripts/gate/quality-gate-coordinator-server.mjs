import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

import { QualityGateCoordinator } from "./quality-gate-coordinator-core.mjs";
import {
  closeBoundServer,
  createReadyConnection,
  failResponse as fail,
  probeSocket,
  rejectWhileStarting,
  sendResponse as send,
} from "./quality-gate-coordinator-socket.mjs";
import {
  rollbackReadyPublication,
  runAttestedStartupTransition,
  runCoordinatorStartupMaintenance,
  stateNamespace,
  validateStartupAttestationCallbacks,
} from "./quality-gate-coordinator-startup-attestation.mjs";
export { serializedError } from "./quality-gate-coordinator-socket.mjs";
export { stateNamespace } from "./quality-gate-coordinator-startup-attestation.mjs";
import {
  adoptLegacyRunLock,
  currentProcessIdentity,
  generatedToken,
  observeProcessIdentity,
  socketPathForRoot,
  validateLegacyToken,
} from "./quality-gate-coordinator-legacy.mjs";
import {
  CoordinatorError,
  DEFAULT_CAPACITY,
  DEFAULT_IDLE_MS,
  DEFAULT_POLICY_HASH,
  PROTOCOL_VERSION,
  ensurePrivateDirectory,
  fingerprintHash,
  positiveInteger,
  syncDirectory,
  validatePolicyHash,
  writeAtomicJson,
} from "./quality-gate-coordinator-state.mjs";

export async function startCoordinator({
  root,
  capacity = DEFAULT_CAPACITY,
  policyHash = DEFAULT_POLICY_HASH,
  idleMs = DEFAULT_IDLE_MS,
  ownerSweepMs = 1_000,
  ownerObserver = observeProcessIdentity,
  legacyLockRoot = null,
  legacyOwnerToken = null,
  readyFile = null,
  now = Date.now,
  coordinatorIdentity: suppliedCoordinatorIdentity = null,
  generationToken: suppliedGenerationToken = null,
  beforeLegacyAdopt = null,
  sourceAttestor = null,
  beforeSourceAttestation = null,
  readyMetadataWriter = writeAtomicJson,
  journalWriter = writeAtomicJson,
  resultWriter = undefined,
  directorySync = syncDirectory,
} = {}) {
  const resolvedRoot = resolve(root);
  validatePolicyHash(policyHash);
  positiveInteger(capacity, "capacity");
  positiveInteger(idleMs, "idleMs");
  validateStartupAttestationCallbacks(
    sourceAttestor,
    beforeSourceAttestation,
    readyMetadataWriter,
  );
  const attestedTransition = (phase, context, transition) =>
    runAttestedStartupTransition({
      beforeSourceAttestation,
      sourceAttestor,
      policyHash,
      phase,
      context,
      transition,
    });
  const socketPath = socketPathForRoot(resolvedRoot);
  await attestedTransition("state setup", { socketPath }, () =>
    ensurePrivateDirectory(resolvedRoot, { directorySync }),
  );
  const staleSocket = existsSync(socketPath);
  if (staleSocket) {
    if (await probeSocket(socketPath)) {
      throw new CoordinatorError(
        "COORDINATOR_ALREADY_RUNNING",
        `a coordinator already owns ${socketPath}`,
      );
    }
  }
  const connectionHandler = { accept: rejectWhileStarting };
  const serverSockets = new Set();
  const server = createServer((socket) => {
    serverSockets.add(socket);
    socket.once("close", () => serverSockets.delete(socket));
    socket.on("error", () => {
      if (!socket.destroyed) socket.destroy();
    });
    connectionHandler.accept(socket);
  });
  await attestedTransition("socket bind", { socketPath }, async () => {
    if (staleSocket) unlinkSync(socketPath);
    try {
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolveListen();
        });
      });
      chmodSync(socketPath, 0o600);
    } catch (error) {
      if (server.listening) {
        await closeBoundServer(server, socketPath, serverSockets);
      }
      throw error;
    }
  });
  let coordinatorIdentity;
  let generationToken;
  try {
    coordinatorIdentity =
      suppliedCoordinatorIdentity ?? currentProcessIdentity();
    generationToken =
      suppliedGenerationToken ?? generatedToken(coordinatorIdentity.pid);
    validateLegacyToken(generationToken, "coordinator generation token");
  } catch (error) {
    await closeBoundServer(server, socketPath, serverSockets);
    throw error;
  }
  let legacy = null;
  const legacyAuthorityRequired = Boolean(legacyLockRoot);
  function legacyAuthorityGuard(operation) {
    if (!legacyAuthorityRequired) return true;
    if (!legacy) return false;
    const observed = legacy.authority();
    if (observed.owned) return true;
    throw new CoordinatorError(
      "LEGACY_AUTHORITY_LOST",
      "coordinator no longer owns the legacy run lock and marker",
      {
        operation,
        generationToken,
        markerValid: observed.markerValid,
        observedOwnerToken: observed.owner?.token ?? null,
      },
    );
  }
  const stateRoot = stateNamespace(resolvedRoot, policyHash, capacity);
  let core;
  try {
    core = await attestedTransition(
      "state initialization",
      { socketPath, stateRoot },
      () =>
        new QualityGateCoordinator({
          root: stateRoot,
          capacity,
          policyHash,
          coordinatorIdentity,
          generationToken,
          now,
          journalWriter,
          resultWriter,
          directorySync,
          authorityGuard: legacyAuthorityGuard,
        }),
    );
  } catch (error) {
    await closeBoundServer(server, socketPath, serverSockets);
    throw error;
  }
  const ownerObservations = new Map();

  const connections = new Set();
  const bindings = new Map();
  const waiters = new Set();
  let closing = false;
  let idleTimer = null;
  let ownerTimer = null;
  let resolveClosed;
  let rejectClosed;
  const closed = new Promise((resolvePromise, rejectPromise) => {
    resolveClosed = resolvePromise;
    rejectClosed = rejectPromise;
  });
  let closePromise = null;

  function close(reason = "explicit") {
    if (closePromise) return closePromise;
    closing = true;
    connectionHandler.accept = (socket) => socket.destroy();
    if (idleTimer) clearTimeout(idleTimer);
    if (ownerTimer) clearInterval(ownerTimer);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      fail(
        waiter.socket,
        waiter.id,
        new CoordinatorError("COORDINATOR_STOPPING", `stopping: ${reason}`),
      );
    }
    waiters.clear();
    for (const socket of serverSockets) socket.destroy();
    closePromise = (async () => {
      await new Promise((resolveClose) => server.close(resolveClose));
      if (existsSync(socketPath)) unlinkSync(socketPath);
      let legacyRelease = null;
      if (legacy) {
        if (
          [
            "legacy-authority-lost",
            "maintenance-failed",
            "result-commit-failed",
            "source-attestation-failed",
            "state-commit-failed",
            "fatal-error",
          ].includes(reason)
        ) {
          legacy.abandon();
          legacyRelease = { released: false, reason };
        } else if (!core.isIdle()) {
          legacy.abandon();
          legacyRelease = { released: false, reason: "active-work" };
        } else {
          try {
            legacyRelease = legacy.releaseIfOwned();
          } catch (error) {
            legacy.abandon();
            if (error.code !== "LEGACY_RELEASE_FAILED") throw error;
            legacyRelease = {
              released: false,
              reason: "release-failed",
              error: { code: error.code, message: error.message },
            };
          }
        }
      }
      return { reason, legacyRelease };
    })();
    void closePromise.then(resolveClosed, rejectClosed);
    return closePromise;
  }

  core.on("fatal", (error) => {
    if (error.code === "STATE_COMMIT_FAILED") {
      void close("state-commit-failed");
    } else if (error.code === "RESULT_COMMIT_FAILED") {
      void close("result-commit-failed");
    } else if (error.code === "LEGACY_AUTHORITY_LOST") {
      void close("legacy-authority-lost");
    } else {
      void close("fatal-error");
    }
  });

  function assertEstablishedAuthority(operation) {
    try {
      if (legacyAuthorityGuard(operation)) return;
      throw new CoordinatorError(
        "COORDINATOR_STARTING",
        "coordinator has not acquired legacy authority",
      );
    } catch (error) {
      if (error.code !== "COORDINATOR_STARTING") core.emit("fatal", error);
      throw error;
    }
  }

  function assertResponseAuthority(operation) {
    if (sourceAttestor) {
      const attestedPolicyHash = sourceAttestor(operation);
      if (attestedPolicyHash !== policyHash) {
        throw new CoordinatorError(
          "POLICY_IDENTITY_CHANGED",
          `coordinator source attestation failed before ${operation}`,
        );
      }
    }
    assertEstablishedAuthority(operation);
  }

  function respondWithError(socket, id, error) {
    if (error.code !== "POLICY_IDENTITY_CHANGED") {
      fail(socket, id, error);
      return false;
    }
    const stop = () => void close("source-attestation-failed");
    if (!fail(socket, id, error, stop)) stop();
    return true;
  }

  function runMaintenance(operation, callback) {
    if (closing) return { ran: false };
    try {
      assertEstablishedAuthority(operation);
      if (closing) return { ran: false };
      const value = callback();
      assertEstablishedAuthority(`${operation}-complete`);
      return { ran: true, value };
    } catch (error) {
      if (!closing) {
        process.stderr.write(
          `quality-gate coordinator maintenance failed (${operation}): ${error.message}\n`,
        );
        void close("maintenance-failed");
      }
      return { ran: false, error };
    }
  }

  function evaluateWaiter(waiter) {
    try {
      assertEstablishedAuthority(waiter.action);
      let response;
      if (waiter.action === "wait-result") {
        const { fingerprint, executionId } = waiter.params;
        const request = core.requestStatus(
          waiter.params.requestId,
          waiter.params.owner,
          waiter.params.capability,
        );
        if (!request.found || request.executionId !== executionId) {
          response = { found: false };
        } else {
          const result = request.result;
          if (result?.fingerprint === fingerprint) {
            response = { found: true, result };
          } else if (
            core.state.singleflights[fingerprintHash(fingerprint)]
              ?.executionId !== executionId
          ) {
            response = { found: false };
          }
        }
      } else if (waiter.action === "wait-admission") {
        const current = core.requestStatus(
          waiter.params.requestId,
          waiter.params.owner,
          waiter.params.capability,
        );
        if (!current.found || current.admission === "held") response = current;
      } else {
        const current = core.leaseStatus(
          waiter.params.leaseId,
          waiter.params.owner,
          waiter.params.capability,
        );
        if (!current.found || current.status !== "queued") response = current;
      }
      if (response) {
        assertResponseAuthority(`${waiter.action}-response`);
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        send(waiter.socket, waiter.id, response);
      }
    } catch (error) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      respondWithError(waiter.socket, waiter.id, error);
    }
  }
  function evaluateWaiters() {
    const staleCandidateIds = new Set(
      core.staleCandidates().map((candidate) => candidate.requestId),
    );
    for (const requestId of ownerObservations.keys()) {
      if (!staleCandidateIds.has(requestId)) {
        ownerObservations.delete(requestId);
      }
    }
    for (const waiter of [...waiters]) evaluateWaiter(waiter);
    scheduleIdle();
  }
  function scheduleIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (closing || connections.size || waiters.size) return;
    const idle = core.isIdle();
    const recoveryHandoff =
      Boolean(legacy) && core.isLegacyRecoveryHandoffReady();
    if (!idle && !recoveryHandoff) return;
    if (idle) {
      const pruned = runMaintenance("prune-records", () => core.pruneRecords());
      if (!pruned.ran || pruned.value.changed) return;
    }
    idleTimer = setTimeout(() => {
      if (connections.size || waiters.size) return;
      if (core.isIdle()) void close("idle");
      else if (legacy && core.isLegacyRecoveryHandoffReady())
        void close("legacy-recovery-handoff");
    }, idleMs);
  }
  core.on("change", evaluateWaiters);

  function authority() {
    return legacy
      ? legacy.authority()
      : { owned: false, mode: "no-legacy-lock", generationToken };
  }
  function dispatch(action, params = {}) {
    if (closing) {
      throw new CoordinatorError(
        "COORDINATOR_STOPPING",
        "coordinator is stopping",
      );
    }
    assertEstablishedAuthority(action);
    switch (action) {
      case "ping":
        return {
          protocol: PROTOCOL_VERSION,
          policyHash,
          capacity,
          generationToken,
        };
      case "authority":
        return authority();
      case "register":
        return core.register(params);
      case "request-status":
        return core.requestStatus(
          params.requestId,
          params.owner,
          params.capability,
        );
      case "request-lease":
        return core.requestLease(params);
      case "lease-status":
        return core.leaseStatus(
          params.leaseId,
          params.owner,
          params.capability,
        );
      case "release-lease":
        return core.releaseLease(params);
      case "abandon-lease":
        return core.abandonLease(params);
      case "publish-result":
        return core.publishResult(params);
      case "acknowledge-result":
        return core.acknowledgeResult(params);
      case "cancel-request":
        return core.cancelRequest(params);
      case "claim-drain":
        return core.claimDrain(params);
      case "release-drain-claim":
        return core.releaseDrainClaim(params);
      case "acknowledge-drain":
        return core.acknowledgeDrain(params);
      case "inspect":
        return {
          ...core.inspect(),
          stateRoot,
          authority: authority(),
          ownerObservations: [...ownerObservations.entries()].map(
            ([requestId, observation]) => ({ requestId, ...observation }),
          ),
        };
      default:
        throw new CoordinatorError(
          "UNKNOWN_ACTION",
          `unknown action: ${action}`,
        );
    }
  }

  const readyConnection = createReadyConnection({
    isClosing: () => closing,
    connections,
    bindings,
    clearIdleTimer: () => {
      if (idleTimer) clearTimeout(idleTimer);
    },
    waiters,
    policyHash,
    evaluateWaiter,
    scheduleIdle,
    dispatch,
    assertResponseAuthority,
    respondWithError,
    runMaintenance,
    core,
    coordinatorIdentity,
  });

  try {
    if (beforeLegacyAdopt) await beforeLegacyAdopt({ socketPath, core });
    legacy = await attestedTransition(
      "legacy adoption",
      { socketPath, core },
      () =>
        legacyLockRoot
          ? adoptLegacyRunLock({
              lockRoot: resolve(legacyLockRoot),
              expectedOwnerToken: legacyOwnerToken,
              generationToken,
              coordinatorIdentity,
            })
          : null,
    );
    await attestedTransition("startup maintenance", { socketPath, core }, () =>
      runCoordinatorStartupMaintenance({
        runMaintenance,
        core,
        root: resolvedRoot,
        stateRoot,
        now,
        journalWriter,
      }),
    );
  } catch (error) {
    if (ownerTimer) clearInterval(ownerTimer);
    legacy?.rollbackHandoff();
    await closeBoundServer(server, socketPath, serverSockets);
    throw error;
  }
  const metadata = {
    protocol: PROTOCOL_VERSION,
    policyHash,
    capacity,
    socketPath,
    stateRoot,
    coordinatorIdentity,
    generationToken,
    markerPath: legacy?.markerPath ?? null,
    authority: authority(),
    readyAt: new Date().toISOString(),
  };
  try {
    await attestedTransition("ready publication", { socketPath, core }, () => {
      readyMetadataWriter(join(resolvedRoot, "coordinator.json"), metadata);
      if (readyFile) readyMetadataWriter(readyFile, metadata);
    });
  } catch (error) {
    if (ownerTimer) clearInterval(ownerTimer);
    try {
      await rollbackReadyPublication({
        paths: [join(resolvedRoot, "coordinator.json"), readyFile],
        metadata,
        directorySync,
        rollbackAuthority: () => legacy?.rollbackHandoff(),
        closeServer: () => closeBoundServer(server, socketPath, serverSockets),
      });
    } catch (rollbackError) {
      rollbackError.cause = error;
      throw rollbackError;
    }
    throw error;
  }
  if (ownerSweepMs > 0) {
    ownerTimer = setInterval(() => {
      if (closing) return;
      try {
        for (const candidate of core.staleCandidates()) {
          if (closing) return;
          const observed = {
            ...ownerObserver(candidate.owner),
            checkedAt: new Date().toISOString(),
          };
          ownerObservations.set(candidate.requestId, observed);
          if (["dead", "reused"].includes(observed.state)) {
            const maintained = runMaintenance("mark-owner-stale", () =>
              core.markOwnerStale({
                requestId: candidate.requestId,
                observedOwner: candidate.owner,
                reporter: coordinatorIdentity,
                reason: `process probe reported ${observed.state}`,
              }),
            );
            if (!maintained.ran) return;
          }
        }
        for (const candidate of core.staleDrainClaims()) {
          if (closing) return;
          const observed = ownerObserver(candidate.claimant);
          if (["dead", "reused"].includes(observed.state)) {
            const maintained = runMaintenance("release-stale-drain-claim", () =>
              core.releaseDrainClaim({
                obligationId: candidate.obligationId,
                drainToken: candidate.drainToken,
                claimant: candidate.claimant,
              }),
            );
            if (!maintained.ran) return;
          }
        }
      } catch (error) {
        if (!closing) {
          process.stderr.write(
            `quality-gate coordinator owner sweep failed: ${error.message}\n`,
          );
          void close("maintenance-failed");
        }
      }
    }, ownerSweepMs);
  }
  connectionHandler.accept = readyConnection;
  scheduleIdle();
  return {
    root: resolvedRoot,
    stateRoot,
    socketPath,
    core,
    metadata,
    closed,
    close,
    dispatch,
  };
}
