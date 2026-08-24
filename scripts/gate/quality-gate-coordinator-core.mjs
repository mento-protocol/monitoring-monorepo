import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  pruneExpiredSuccessIndexes,
  prunePersistentRecords,
} from "./quality-gate-coordinator-retention.mjs";
import {
  assertDrainClaim,
  claimDrain,
  releaseDrainClaim,
  staleDrainClaims,
} from "./quality-gate-coordinator-drain.mjs";
import {
  assertResultMatchesSingleflight,
  finishExecutionState,
  publishExecutionResult,
  readReadyResult,
  removeAcknowledgedResult,
  validateRetainedResults,
} from "./quality-gate-coordinator-results.mjs";
import {
  abandonLease as abandonCoordinatorLease,
  leaseStatus as coordinatorLeaseStatus,
  registerRequest,
  releaseLease as releaseCoordinatorLease,
  requestLease as requestCoordinatorLease,
  requestStatus as coordinatorRequestStatus,
} from "./quality-gate-coordinator-requests.mjs";

import {
  CoordinatorError,
  admitWorktrees,
  assertRequestAuthority,
  copy,
  ensurePrivateDirectory,
  identifier,
  identitiesEqual,
  initialState,
  inspectState,
  jsonSize,
  positiveInteger,
  readExecutionResult,
  recoverGrantedLeases,
  scheduleState,
  staleRequestCandidates,
  stateIsIdle,
  syncDirectory,
  terminalStatus,
  text,
  utc,
  validateIdentity,
  validateState,
  validateRunToken,
  writeAtomicJson,
  writeImmutable,
} from "./quality-gate-coordinator-state.mjs";

export class QualityGateCoordinator extends EventEmitter {
  constructor({
    root,
    capacity,
    policyHash,
    coordinatorIdentity,
    generationToken,
    now = Date.now,
    journalWriter = writeAtomicJson,
    resultWriter = null,
    directorySync = syncDirectory,
    authorityGuard = () => true,
  }) {
    super();
    positiveInteger(capacity, "capacity");
    validateIdentity(coordinatorIdentity, "coordinatorIdentity");
    this.root = resolve(root);
    this.capacity = capacity;
    this.policyHash = policyHash;
    this.coordinatorIdentity = copy(coordinatorIdentity);
    this.generationToken = generationToken;
    this.now = now;
    this.journalWriter = journalWriter;
    if (typeof directorySync !== "function") {
      throw new CoordinatorError(
        "INVALID_ARGUMENT",
        "directorySync must be a function",
      );
    }
    this.directorySync = directorySync;
    this.resultWriter =
      resultWriter ??
      ((path, value, equivalent) =>
        writeImmutable(path, value, equivalent, { directorySync }));
    if (typeof this.resultWriter !== "function") {
      throw new CoordinatorError(
        "INVALID_ARGUMENT",
        "resultWriter must be a function",
      );
    }
    if (typeof authorityGuard !== "function") {
      throw new CoordinatorError(
        "INVALID_ARGUMENT",
        "authorityGuard must be a function",
      );
    }
    this.authorityGuard = authorityGuard;
    this.journalPath = join(this.root, "journal.json");
    this.requestsDirectory = join(this.root, "requests");
    this.resultsDirectory = join(this.root, "results");
    ensurePrivateDirectory(this.root, { directorySync });
    ensurePrivateDirectory(this.requestsDirectory, { directorySync });
    ensurePrivateDirectory(this.resultsDirectory, { directorySync });
    if (existsSync(this.journalPath)) {
      try {
        this.state = JSON.parse(readFileSync(this.journalPath, "utf8"));
      } catch (cause) {
        if (!(cause instanceof SyntaxError)) throw cause;
        throw new CoordinatorError(
          "JOURNAL_STATE_INVALID",
          "journal is not valid JSON",
          { path: "journal", reason: "must be valid JSON" },
        );
      }
      validateState(this.state, capacity, policyHash);
      this.#recover();
    } else {
      this.state = initialState(
        capacity,
        policyHash,
        coordinatorIdentity,
        generationToken,
      );
      this.#validateAndRepairRetainedResults();
      this.#commit();
    }
  }
  #validateAndRepairRetainedResults() {
    const { resultDirectories } = validateRetainedResults({
      resultsDirectory: this.resultsDirectory,
      successIndex: this.state.successIndex,
      policyHash: this.policyHash,
    });
    for (const directory of resultDirectories) {
      this.directorySync(directory);
    }
    if (resultDirectories.length > 0) {
      this.directorySync(this.resultsDirectory);
    }
  }
  #checkAuthority(operation) {
    try {
      return this.authorityGuard(operation) === true;
    } catch (error) {
      this.emit("fatal", error);
      throw error;
    }
  }
  #assertAuthority(operation) {
    if (this.#checkAuthority(operation)) return;
    const error = new CoordinatorError(
      "COORDINATOR_STARTING",
      "coordinator has not acquired legacy authority",
    );
    throw error;
  }
  #quarantinePublishedResult(resultPath, authorityError) {
    if (!existsSync(resultPath)) return;
    const quarantinePath = `${resultPath}.staged-${process.pid}-${randomUUID()}`;
    try {
      renameSync(resultPath, quarantinePath);
      this.directorySync(dirname(resultPath));
    } catch (cause) {
      const error = new CoordinatorError(
        "RESULT_COMMIT_FAILED",
        "failed to durably quarantine a terminal result after authority loss",
        typeof cause?.code === "string" ? { causeCode: cause.code } : undefined,
      );
      error.cause = cause;
      error.authorityError = authorityError;
      this.emit("fatal", error);
      throw error;
    }
  }
  #schedule() {
    return scheduleState(this.state, utc(this.now), () =>
      this.#checkAuthority("grant"),
    );
  }
  #commit({ notify = true } = {}) {
    this.state.revision += 1;
    this.state.coordinatorIdentity = copy(this.coordinatorIdentity);
    try {
      this.journalWriter(this.journalPath, this.state);
    } catch (cause) {
      const error = new CoordinatorError(
        "STATE_COMMIT_FAILED",
        "failed to persist coordinator state",
        typeof cause?.code === "string" ? { causeCode: cause.code } : undefined,
      );
      error.cause = cause;
      this.emit("fatal", error);
      throw error;
    }
    if (notify) this.emit("change");
  }
  #recover() {
    const recoveredGeneration = this.state.generationToken;
    this.#validateAndRepairRetainedResults();
    for (const request of Object.values(this.state.requests)) {
      if (!request.resultReady) continue;
      readReadyResult(this.resultsDirectory, this.policyHash, request);
    }
    for (const singleflight of Object.values(this.state.singleflights)) {
      const result = this.readResult(
        singleflight.fingerprint,
        singleflight.executionId,
      );
      if (!result) continue;
      assertResultMatchesSingleflight(result, singleflight);
      const requestIds = new Set([
        singleflight.leaderRequestId,
        ...singleflight.followers,
      ]);
      // The immutable result is written before the journal transition. If the
      // journal commit failed, remove only this completed execution's stale
      // leases and drain obligations before rebuilding its terminal state.
      for (const [leaseId, lease] of Object.entries(this.state.leases)) {
        if (requestIds.has(lease.requestId)) delete this.state.leases[leaseId];
      }
      for (const [obligationId, obligation] of Object.entries(
        this.state.drainObligations,
      )) {
        if (requestIds.has(obligation.requestId)) {
          delete this.state.drainObligations[obligationId];
        }
      }
      finishExecutionState(this.state, singleflight, result);
    }
    for (const request of Object.values(this.state.requests)) {
      if (request.resultReady && request.autoAcknowledge) {
        removeAcknowledgedResult(this.state, this.resultsDirectory, request);
      }
    }
    recoverGrantedLeases(this.state, recoveredGeneration, this.now);
    admitWorktrees(this.state);
    this.state.generationToken = this.generationToken;
    this.#schedule();
    this.#commit();
  }
  readResult(fingerprint, executionId) {
    return readExecutionResult(
      this.resultsDirectory,
      fingerprint,
      executionId,
      this.policyHash,
    );
  }
  reschedule() {
    const grants = this.#schedule();
    if (grants.length) this.#commit();
    return { grants };
  }
  register(params) {
    return registerRequest(this, params, () => this.#commit());
  }
  requestStatus(requestId, owner, capability) {
    return coordinatorRequestStatus(this, requestId, owner, capability);
  }
  requestLease(params) {
    return requestCoordinatorLease(
      this,
      params,
      () => this.#schedule(),
      () => this.#commit(),
    );
  }
  leaseStatus(leaseId, owner, capability) {
    return coordinatorLeaseStatus(this, leaseId, owner, capability);
  }
  releaseLease(params) {
    return releaseCoordinatorLease(
      this,
      params,
      () => this.#schedule(),
      () => this.#commit(),
    );
  }
  abandonLease(params) {
    return abandonCoordinatorLease(
      this,
      params,
      () => this.#schedule(),
      () => this.#commit(),
    );
  }
  publishResult({ requestId, owner, capability, status, payload = null }) {
    const request = this.state.requests[requestId];
    if (!request)
      throw new CoordinatorError("REQUEST_NOT_FOUND", "request is not active");
    assertRequestAuthority(request, owner, capability);
    if (request.role !== "leader") {
      throw new CoordinatorError(
        "FOLLOWER_CANNOT_PUBLISH",
        "only the leader publishes",
      );
    }
    terminalStatus(status);
    jsonSize(payload, "payload");
    const leases = Object.values(this.state.leases).filter(
      (lease) => lease.requestId === requestId,
    );
    if (leases.length) {
      throw new CoordinatorError(
        "LEASES_STILL_ACTIVE",
        "release or drain all leases before publishing",
        { leaseIds: leases.map((lease) => lease.leaseId) },
      );
    }
    return this.#complete(request, status, payload);
  }
  #complete(request, status, payload) {
    const singleflight = this.state.singleflights[request.fingerprintHash];
    if (!singleflight) {
      throw new CoordinatorError(
        "SINGLEFLIGHT_NOT_FOUND",
        "execution is not active",
      );
    }
    this.#assertAuthority("publish-result");
    const durableState = copy(this.state);
    const resultPath = join(
      this.resultsDirectory,
      request.fingerprintHash,
      `${request.executionId}.json`,
    );
    let result;
    let authorityFailedAfterWrite = false;
    try {
      result = publishExecutionResult({
        state: this.state,
        resultPath,
        request,
        singleflight,
        policyHash: this.policyHash,
        status,
        payload,
        now: this.now,
        resultWriter: (path, value, equivalent) => {
          const persisted = this.resultWriter(path, value, equivalent);
          try {
            this.#assertAuthority("publish-result-written");
          } catch (error) {
            authorityFailedAfterWrite = true;
            if (error.code === "COORDINATOR_STARTING") {
              this.emit("fatal", error);
            }
            this.#quarantinePublishedResult(resultPath, error);
            throw error;
          }
          return persisted;
        },
      });
    } catch (cause) {
      if (authorityFailedAfterWrite) throw cause;
      const error = new CoordinatorError(
        "RESULT_COMMIT_FAILED",
        "failed to persist the terminal result",
        typeof cause?.code === "string" ? { causeCode: cause.code } : undefined,
      );
      error.cause = cause;
      this.emit("fatal", error);
      throw error;
    }
    admitWorktrees(this.state);
    try {
      this.#schedule();
      this.#assertAuthority("publish-result-commit");
    } catch (error) {
      this.state = durableState;
      if (error.code === "COORDINATOR_STARTING") this.emit("fatal", error);
      this.#quarantinePublishedResult(resultPath, error);
      throw error;
    }
    this.#commit();
    this.emit("result", copy(result));
    if (request.autoAcknowledge) {
      this.#acknowledgeResult(request);
      return { published: true, autoAcknowledged: true, result };
    }
    return { published: true, result };
  }
  #acknowledgeResult(request) {
    const requestId = request.requestId;
    const result = removeAcknowledgedResult(
      this.state,
      this.resultsDirectory,
      request,
    );
    admitWorktrees(this.state);
    this.#schedule();
    this.#commit();
    return { acknowledged: true, requestId, result };
  }
  acknowledgeResult({ requestId, owner, capability }) {
    const request = this.state.requests[requestId];
    if (!request)
      throw new CoordinatorError("REQUEST_NOT_FOUND", "request is not active");
    assertRequestAuthority(request, owner, capability);
    return this.#acknowledgeResult(request);
  }
  #cancelRequest(request, reason) {
    const requestId = request.requestId;
    if (request.resultReady) {
      const acknowledged = this.#acknowledgeResult(request);
      return {
        cancelled: false,
        resultAcknowledged: true,
        drainObligations: [],
        result: acknowledged.result,
      };
    }
    if (request.role === "follower") {
      const singleflight = this.state.singleflights[request.fingerprintHash];
      if (singleflight) {
        singleflight.followers = singleflight.followers.filter(
          (id) => id !== requestId,
        );
      }
      delete this.state.requests[requestId];
      admitWorktrees(this.state);
      this.#schedule();
      this.#commit();
      return { cancelled: true, followerOnly: true, drainObligations: [] };
    }
    return this.#startDrain(request, { reason });
  }
  cancelRequest({ requestId, owner, capability, reason = "cancelled" }) {
    text(reason, "reason");
    const request = this.state.requests[requestId];
    if (!request)
      throw new CoordinatorError("REQUEST_NOT_FOUND", "request is not active");
    assertRequestAuthority(request, owner, capability);
    return this.#cancelRequest(request, reason);
  }
  markOwnerStale({
    requestId,
    observedOwner,
    reporter,
    reason,
    autoAcknowledge = false,
  }) {
    validateIdentity(observedOwner, "observedOwner");
    validateIdentity(reporter, "reporter");
    text(reason, "reason");
    const request = this.state.requests[requestId];
    if (!request) return { ignored: true };
    if (!identitiesEqual(request.owner, observedOwner)) {
      throw new CoordinatorError(
        "OWNER_IDENTITY_MISMATCH",
        "stale report identity differs from the request",
      );
    }
    if (request.resultReady) {
      const acknowledged = this.#acknowledgeResult(request);
      return {
        stale: true,
        resultAcknowledged: true,
        ...acknowledged,
      };
    }
    if (request.role === "follower") {
      return this.#cancelRequest(request, reason);
    }
    if (autoAcknowledge) request.autoAcknowledge = true;
    return this.#startDrain(request, {
      reason: `stale owner: ${reason}`,
      reporter,
    });
  }
  #startDrain(request, payload) {
    if (request.pendingTerminal) {
      this.#commit();
      return {
        cancelled: true,
        draining: true,
        drainObligations: Object.values(this.state.drainObligations)
          .filter((item) => item.requestId === request.requestId)
          .map(copy),
      };
    }
    request.state = "draining";
    request.pendingTerminal = { status: "cancelled", payload: copy(payload) };
    const obligations = [];
    for (const lease of Object.values(this.state.leases)) {
      if (lease.requestId !== request.requestId) continue;
      if (lease.status === "queued") {
        delete this.state.leases[lease.leaseId];
        continue;
      }
      const obligationId = `drain-${randomUUID()}`;
      lease.status = "drain-required";
      lease.drainObligationId = obligationId;
      const obligation = {
        obligationId,
        leaseId: lease.leaseId,
        requestId: request.requestId,
        drainToken: request.drainToken,
        owner: copy(lease.owner),
        weight: lease.weight,
        resources: copy(lease.resources),
        reason: payload.reason,
        generationToken: this.generationToken,
        drainRequiredAt: utc(this.now),
        claim: null,
      };
      this.state.drainObligations[obligationId] = obligation;
      obligations.push(copy(obligation));
    }
    if (!obligations.length) {
      this.#schedule();
      return this.#complete(request, "cancelled", payload);
    }
    this.#commit();
    return { cancelled: true, draining: true, drainObligations: obligations };
  }
  acknowledgeDrain({ obligationId, drainToken, drainer, evidence = {} }) {
    identifier(obligationId, "obligationId");
    validateRunToken(drainToken, "drainToken");
    validateIdentity(drainer, "drainer");
    jsonSize(evidence, "evidence");
    if (evidence.processTreeEmpty !== true) {
      throw new CoordinatorError(
        "DRAIN_EVIDENCE_REQUIRED",
        "drain evidence must state processTreeEmpty=true",
      );
    }
    const obligation = this.state.drainObligations[obligationId];
    if (!obligation) {
      throw new CoordinatorError(
        "DRAIN_OBLIGATION_NOT_FOUND",
        "drain obligation is not active",
      );
    }
    if (obligation.drainToken !== drainToken) {
      throw new CoordinatorError(
        "DRAIN_TOKEN_MISMATCH",
        "drain token does not match the obligation",
      );
    }
    assertDrainClaim(obligation, drainer);
    const lease = this.state.leases[obligation.leaseId];
    if (!lease || lease.status !== "drain-required") {
      throw new CoordinatorError(
        "INCONSISTENT_DRAIN_STATE",
        "obligation has no reserved stale lease",
      );
    }
    const request = this.state.requests[lease.requestId];
    delete this.state.leases[lease.leaseId];
    delete this.state.drainObligations[obligationId];
    const remaining = Object.values(this.state.leases).some(
      (candidate) => candidate.requestId === lease.requestId,
    );
    if (request?.pendingTerminal && !remaining) {
      this.#schedule();
      return this.#complete(
        request,
        request.pendingTerminal.status,
        request.pendingTerminal.payload,
      );
    }
    this.#schedule();
    this.#commit();
    return { acknowledged: true, obligationId };
  }
  staleCandidates() {
    return staleRequestCandidates(this.state);
  }
  claimDrain(params) {
    const result = claimDrain(this.state, params, this.now);
    if (!result.idempotent) this.#commit();
    return result;
  }
  releaseDrainClaim(params) {
    const result = releaseDrainClaim(this.state, params);
    if (result.released) this.#commit();
    return result;
  }
  staleDrainClaims() {
    return staleDrainClaims(this.state);
  }
  inspect() {
    return inspectState(this.state, this.capacity, this.coordinatorIdentity);
  }
  pruneRecords() {
    const now = this.now();
    const successIndexes = pruneExpiredSuccessIndexes({
      state: this.state,
      now,
    });
    if (successIndexes) this.#commit({ notify: false });
    const result = prunePersistentRecords({
      stateDirectory: this.root,
      requestsDirectory: this.requestsDirectory,
      resultsDirectory: this.resultsDirectory,
      state: this.state,
      now,
    });
    const changed = result.changed || successIndexes > 0;
    if (changed) this.emit("change");
    return { ...result, successIndexes, changed };
  }

  isIdle() {
    return stateIsIdle(this.state);
  }

  isLegacyRecoveryHandoffReady() {
    const obligations = Object.values(this.state.drainObligations);
    const leases = Object.values(this.state.leases);
    const requests = Object.values(this.state.requests);
    return (
      obligations.length > 0 &&
      obligations.every((obligation) => obligation.claim === null) &&
      leases.length === obligations.length &&
      leases.every((lease) => lease.status === "drain-required") &&
      requests.length > 0 &&
      requests.every(
        (request) => request.pendingTerminal && !request.resultReady,
      )
    );
  }
}
