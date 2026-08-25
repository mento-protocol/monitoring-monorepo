import { join } from "node:path";

import {
  requestRegistration,
  reusableSuccess,
} from "./quality-gate-coordinator-results.mjs";
import {
  CoordinatorError,
  DEFAULT_SUCCESS_MAX_AGE_MS,
  PROTOCOL_VERSION,
  RECORD_SCHEMA_VERSION,
  assertRequestAuthority,
  blockersForLease,
  copy,
  fingerprintHash,
  hashRequestCapability,
  identifier,
  identitiesEqual,
  jsonSize,
  normalizeResources,
  positiveInteger,
  text,
  utc,
  validateIdentity,
  validateRunToken,
  worktreeHolder,
  writeImmutable,
} from "./quality-gate-coordinator-state.mjs";

export function registerRequest(
  coordinator,
  {
    requestId,
    fingerprint,
    worktreeKey,
    drainIdentity,
    capability,
    owner,
    metadata = {},
    successMaxAgeMs = DEFAULT_SUCCESS_MAX_AGE_MS,
  },
  commit,
) {
  identifier(requestId, "requestId");
  validateRunToken(drainIdentity, "drainIdentity");
  text(worktreeKey, "worktreeKey", 4096);
  validateIdentity(owner);
  jsonSize(metadata, "metadata");
  const hash = fingerprintHash(fingerprint);
  const capabilityHash = hashRequestCapability(capability);
  const existing = coordinator.state.requests[requestId];
  if (existing) {
    assertRequestAuthority(existing, owner, capability);
    if (
      existing.fingerprint !== fingerprint ||
      existing.drainIdentity !== drainIdentity ||
      existing.worktreeKey !== worktreeKey
    ) {
      throw new CoordinatorError(
        "REQUEST_ID_CONFLICT",
        "requestId belongs to another registration identity",
      );
    }
    return requestRegistration(
      coordinator.state,
      coordinator.capacity,
      coordinator.resultsDirectory,
      existing,
    );
  }
  const drainIdentityOwner = Object.values(coordinator.state.requests).find(
    (request) => request.drainIdentity === drainIdentity,
  );
  if (drainIdentityOwner) {
    throw new CoordinatorError(
      "DRAIN_TOKEN_CONFLICT",
      "drainIdentity belongs to another active request",
      { requestId: drainIdentityOwner.requestId },
    );
  }
  const leaseDrainIdentityOwner = Object.values(coordinator.state.leases).find(
    (lease) => lease.drainIdentity === drainIdentity,
  );
  if (leaseDrainIdentityOwner) {
    throw new CoordinatorError(
      "DRAIN_TOKEN_CONFLICT",
      "drainIdentity belongs to another active lease",
      { leaseId: leaseDrainIdentityOwner.leaseId },
    );
  }
  const singleflight = coordinator.state.singleflights[hash];
  if (singleflight && singleflight.fingerprint !== fingerprint) {
    throw new CoordinatorError(
      "FINGERPRINT_HASH_COLLISION",
      "active fingerprint does not match its digest",
    );
  }
  const reusable = singleflight
    ? null
    : reusableSuccess({
        state: coordinator.state,
        resultsDirectory: coordinator.resultsDirectory,
        fingerprint,
        fingerprintHash: hash,
        policyHash: coordinator.policyHash,
        maximumAgeMs: successMaxAgeMs,
        now: coordinator.now,
      });
  const role = singleflight ? "follower" : reusable ? "completed" : "leader";
  const executionId =
    singleflight?.executionId ?? reusable?.executionId ?? requestId;
  const leaderRequestId =
    singleflight?.leaderRequestId ?? reusable?.leaderRequestId ?? requestId;
  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    protocol: { ...PROTOCOL_VERSION },
    policyHash: coordinator.policyHash,
    requestId,
    executionId,
    fingerprint,
    fingerprintHash: hash,
    worktreeKey,
    drainIdentity,
    capabilityHash,
    owner: copy(owner),
    metadata: copy(metadata),
    role,
    leaderRequestId,
    createdAt: utc(coordinator.now),
  };
  const persisted = writeImmutable(
    join(coordinator.requestsDirectory, `${requestId}.json`),
    record,
    (left, right) =>
      left.requestId === right.requestId &&
      left.fingerprint === right.fingerprint &&
      left.worktreeKey === right.worktreeKey &&
      left.drainIdentity === right.drainIdentity &&
      left.capabilityHash === right.capabilityHash &&
      identitiesEqual(left.owner, right.owner),
  );
  if (persisted.executionId !== executionId || persisted.role !== role) {
    throw new CoordinatorError(
      "REQUEST_RECORD_CONFLICT",
      "requestId was staged for another execution role",
    );
  }
  if (
    role !== "completed" &&
    coordinator.readResult(fingerprint, executionId)
  ) {
    throw new CoordinatorError(
      "REQUEST_ALREADY_COMPLETED",
      "completed requestIds cannot be reused",
    );
  }
  const held = !worktreeHolder(coordinator.state, worktreeKey);
  const request = {
    requestId,
    executionId,
    fingerprint,
    fingerprintHash: hash,
    worktreeKey,
    drainIdentity,
    capabilityHash,
    owner: copy(owner),
    role,
    leaderRequestId,
    admission: held ? "held" : "queued",
    state: held
      ? role === "leader"
        ? "active"
        : reusable
          ? "result-ready"
          : "waiting-result"
      : "waiting-worktree",
    sequence: coordinator.state.nextSequence++,
    createdAt: persisted.createdAt,
    pendingTerminal: null,
    autoAcknowledge: false,
    resultReady: Boolean(reusable),
  };
  coordinator.state.requests[requestId] = request;
  if (singleflight) singleflight.followers.push(requestId);
  else if (!reusable) {
    coordinator.state.singleflights[hash] = {
      fingerprint,
      fingerprintHash: hash,
      executionId,
      leaderRequestId: requestId,
      followers: [],
      createdAt: request.createdAt,
    };
    coordinator.state.requestOrder.push(requestId);
  }
  commit();
  return requestRegistration(
    coordinator.state,
    coordinator.capacity,
    coordinator.resultsDirectory,
    request,
  );
}

export function requestStatus(coordinator, requestId, owner, capability) {
  const request = coordinator.state.requests[requestId];
  if (!request) return { found: false };
  assertRequestAuthority(request, owner, capability);
  return {
    found: true,
    ...requestRegistration(
      coordinator.state,
      coordinator.capacity,
      coordinator.resultsDirectory,
      request,
    ),
  };
}

function leaseView(coordinator, lease) {
  return {
    leaseId: lease.leaseId,
    requestId: lease.requestId,
    drainIdentity: lease.drainIdentity,
    status: lease.status,
    sequence: lease.sequence,
    weight: lease.weight,
    capacity: coordinator.capacity,
    allCapacity: lease.allCapacity,
    resources: copy(lease.resources),
    queuedAt: lease.queuedAt,
    acquiredAt: lease.acquiredAt,
    blockers: blockersForLease(coordinator.state, lease),
    drainObligationId: lease.drainObligationId,
  };
}

export function requestLease(coordinator, params, schedule, commit) {
  const {
    requestId,
    leaseId,
    drainIdentity,
    capability,
    owner,
    weight = 1,
    allCapacity = false,
    resources = [],
    metadata = {},
  } = params;
  identifier(leaseId, "leaseId");
  validateRunToken(drainIdentity, "drainIdentity");
  positiveInteger(weight, "weight");
  jsonSize(metadata, "metadata");
  const normalizedAllCapacity = Boolean(allCapacity);
  const normalizedResources = normalizeResources(resources);
  const request = coordinator.state.requests[requestId];
  if (!request)
    throw new CoordinatorError("REQUEST_NOT_FOUND", "request is not active");
  assertRequestAuthority(request, owner, capability);
  if (request.role !== "leader") {
    throw new CoordinatorError(
      "FOLLOWER_CANNOT_LEASE",
      "followers do not execute",
    );
  }
  if (request.admission !== "held") {
    throw new CoordinatorError(
      "WORKTREE_NOT_ADMITTED",
      "request is waiting for its worktree lease",
    );
  }
  if (request.state !== "active") {
    throw new CoordinatorError(
      "REQUEST_NOT_ACTIVE",
      `request is ${request.state}`,
    );
  }
  if (weight > coordinator.capacity) {
    throw new CoordinatorError(
      "WEIGHT_EXCEEDS_CAPACITY",
      `weight ${weight} exceeds capacity ${coordinator.capacity}`,
    );
  }
  const effectiveWeight = normalizedAllCapacity ? coordinator.capacity : weight;
  const existing = coordinator.state.leases[leaseId];
  if (existing) {
    if (
      existing.requestId !== requestId ||
      existing.drainIdentity !== drainIdentity ||
      !identitiesEqual(existing.owner, owner) ||
      existing.weight !== effectiveWeight ||
      existing.allCapacity !== normalizedAllCapacity ||
      existing.resources.length !== normalizedResources.length ||
      existing.resources.some(
        (resource, index) => resource !== normalizedResources[index],
      )
    ) {
      throw new CoordinatorError(
        "LEASE_ID_CONFLICT",
        "leaseId belongs to another lease identity",
      );
    }
    return leaseView(coordinator, existing);
  }
  const requestDrainIdentityOwner = Object.values(
    coordinator.state.requests,
  ).find((candidate) => candidate.drainIdentity === drainIdentity);
  if (requestDrainIdentityOwner) {
    throw new CoordinatorError(
      "DRAIN_TOKEN_CONFLICT",
      "drainIdentity belongs to an active request",
      { requestId: requestDrainIdentityOwner.requestId },
    );
  }
  const leaseDrainIdentityOwner = Object.values(coordinator.state.leases).find(
    (candidate) => candidate.drainIdentity === drainIdentity,
  );
  if (leaseDrainIdentityOwner) {
    throw new CoordinatorError(
      "DRAIN_TOKEN_CONFLICT",
      "drainIdentity belongs to another active lease",
      { leaseId: leaseDrainIdentityOwner.leaseId },
    );
  }
  const lease = {
    leaseId,
    requestId,
    drainIdentity,
    owner: copy(owner),
    weight: effectiveWeight,
    allCapacity: normalizedAllCapacity,
    resources: normalizedResources,
    metadata: copy(metadata),
    sequence: coordinator.state.nextSequence++,
    status: "queued",
    queuedAt: utc(coordinator.now),
    acquiredAt: null,
    drainObligationId: null,
  };
  coordinator.state.leases[leaseId] = lease;
  schedule();
  commit();
  return leaseView(coordinator, lease);
}

export function leaseStatus(coordinator, leaseId, owner, capability) {
  const lease = coordinator.state.leases[leaseId];
  if (!lease) return { found: false };
  const request = coordinator.state.requests[lease.requestId];
  if (!request) {
    throw new CoordinatorError(
      "REQUEST_NOT_FOUND",
      "lease request is not active",
    );
  }
  assertRequestAuthority(request, owner, capability);
  return { found: true, ...leaseView(coordinator, lease) };
}

export function releaseLease(coordinator, params, schedule, commit) {
  const { requestId, leaseId, owner, capability } = params;
  const request = coordinator.state.requests[requestId];
  const lease = coordinator.state.leases[leaseId];
  if (!request || !lease || lease.requestId !== requestId) {
    throw new CoordinatorError("LEASE_NOT_FOUND", "lease is not active");
  }
  assertRequestAuthority(request, owner, capability);
  if (lease.status === "drain-required") {
    throw new CoordinatorError(
      "DRAIN_ACK_REQUIRED",
      "stale capacity remains reserved until drain acknowledgement",
      { obligationId: lease.drainObligationId },
    );
  }
  if (lease.status !== "granted") {
    throw new CoordinatorError("LEASE_NOT_GRANTED", `lease is ${lease.status}`);
  }
  delete coordinator.state.leases[leaseId];
  schedule();
  commit();
  return { released: true, leaseId };
}

export function abandonLease(coordinator, params, schedule, commit) {
  const { requestId, leaseId, owner, capability, commandStarted } = params;
  if (commandStarted !== false) {
    throw new CoordinatorError(
      "COMMAND_START_STATE_REQUIRED",
      "abandon requires commandStarted=false",
    );
  }
  const request = coordinator.state.requests[requestId];
  const lease = coordinator.state.leases[leaseId];
  if (!request || !lease || lease.requestId !== requestId) {
    throw new CoordinatorError("LEASE_NOT_FOUND", "lease is not active");
  }
  assertRequestAuthority(request, owner, capability);
  if (!["queued", "granted"].includes(lease.status)) {
    throw new CoordinatorError(
      "LEASE_CANNOT_BE_ABANDONED",
      `lease is ${lease.status}`,
    );
  }
  delete coordinator.state.leases[leaseId];
  schedule();
  commit();
  return { abandoned: true, leaseId, previousStatus: lease.status };
}
