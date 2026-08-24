import { createHash } from "node:crypto";

import {
  array,
  boundedJson,
  identitiesEqual,
  identifier,
  identity,
  isResourceNameValue,
  nonNegativeInteger,
  oneOf,
  own,
  positiveInteger,
  record,
  reject,
  runToken,
  sha256,
  text,
  utcTimestamp,
} from "./quality-gate-coordinator-journal-fields.mjs";

function validateRequest(request, key, sequences) {
  const path = `requests.${key}`;
  record(request, path);
  identifier(key, path);
  identifier(request.requestId, `${path}.requestId`);
  if (request.requestId !== key) reject(path, "map key differs from requestId");
  identifier(request.executionId, `${path}.executionId`);
  text(request.fingerprint, `${path}.fingerprint`, 64 * 1024);
  sha256(request.fingerprintHash, `${path}.fingerprintHash`);
  const computedHash = createHash("sha256")
    .update(request.fingerprint)
    .digest("hex");
  if (request.fingerprintHash !== computedHash) {
    reject(`${path}.fingerprintHash`, "does not match fingerprint");
  }
  text(request.worktreeKey, `${path}.worktreeKey`, 4096);
  runToken(request.drainIdentity, `${path}.drainIdentity`);
  sha256(request.capabilityHash, `${path}.capabilityHash`);
  identity(request.owner, `${path}.owner`);
  oneOf(request.role, ["leader", "follower", "completed"], `${path}.role`);
  identifier(request.leaderRequestId, `${path}.leaderRequestId`);
  oneOf(request.admission, ["held", "queued"], `${path}.admission`);
  oneOf(
    request.state,
    [
      "active",
      "waiting-worktree",
      "waiting-result",
      "draining",
      "drain-required",
      "result-ready",
    ],
    `${path}.state`,
  );
  positiveInteger(request.sequence, `${path}.sequence`);
  if (sequences.has(request.sequence)) {
    reject(`${path}.sequence`, `duplicates ${sequences.get(request.sequence)}`);
  }
  sequences.set(request.sequence, path);
  utcTimestamp(request.createdAt, `${path}.createdAt`);
  if (typeof request.resultReady !== "boolean") {
    reject(`${path}.resultReady`, "must be a boolean");
  }
  if (typeof request.autoAcknowledge !== "boolean") {
    reject(`${path}.autoAcknowledge`, "must be a boolean");
  }
  if (request.pendingTerminal !== null) {
    record(request.pendingTerminal, `${path}.pendingTerminal`);
    if (request.pendingTerminal.status !== "cancelled") {
      reject(`${path}.pendingTerminal.status`, "must be cancelled");
    }
    record(request.pendingTerminal.payload, `${path}.pendingTerminal.payload`);
    text(
      request.pendingTerminal.payload.reason,
      `${path}.pendingTerminal.payload.reason`,
      8192,
    );
    if (request.pendingTerminal.payload.reporter !== undefined) {
      identity(
        request.pendingTerminal.payload.reporter,
        `${path}.pendingTerminal.payload.reporter`,
      );
    }
    boundedJson(
      request.pendingTerminal.payload,
      `${path}.pendingTerminal.payload`,
    );
  }

  if (request.role === "leader") {
    if (request.leaderRequestId !== request.requestId) {
      reject(`${path}.leaderRequestId`, "leader must reference itself");
    }
    if (request.executionId !== request.requestId) {
      reject(`${path}.executionId`, "leader execution must use its requestId");
    }
  }
  if (request.role === "completed" && !request.resultReady) {
    reject(path, "completed request must be result-ready");
  }
  if (request.admission === "queued" && request.state !== "waiting-worktree") {
    reject(`${path}.state`, "queued admission must wait for its worktree");
  }
  if (request.resultReady) {
    if (request.pendingTerminal !== null) {
      reject(path, "result-ready request cannot have a pending terminal state");
    }
    const expected =
      request.admission === "held" ? "result-ready" : "waiting-worktree";
    if (request.state !== expected) {
      reject(`${path}.state`, `result-ready request must be ${expected}`);
    }
  } else if (request.pendingTerminal !== null) {
    if (
      request.role !== "leader" ||
      request.admission !== "held" ||
      !["draining", "drain-required"].includes(request.state)
    ) {
      reject(
        path,
        "pending terminal state requires an admitted draining leader",
      );
    }
  } else if (request.admission === "held") {
    const expected = request.role === "leader" ? "active" : "waiting-result";
    if (request.role === "completed" || request.state !== expected) {
      reject(
        `${path}.state`,
        `admitted non-terminal request must be ${expected}`,
      );
    }
  }
}

function validateLease(lease, key, state, sequences, capacity) {
  const path = `leases.${key}`;
  record(lease, path);
  identifier(key, path);
  identifier(lease.leaseId, `${path}.leaseId`);
  if (lease.leaseId !== key) reject(path, "map key differs from leaseId");
  identifier(lease.requestId, `${path}.requestId`);
  const request = own(state.requests, lease.requestId);
  if (!request) reject(`${path}.requestId`, "does not reference a request");
  identity(lease.owner, `${path}.owner`);
  if (!identitiesEqual(lease.owner, request.owner)) {
    reject(`${path}.owner`, "differs from request owner");
  }
  positiveInteger(lease.weight, `${path}.weight`);
  if (lease.weight > capacity) reject(`${path}.weight`, "exceeds capacity");
  if (typeof lease.allCapacity !== "boolean") {
    reject(`${path}.allCapacity`, "must be a boolean");
  }
  if (lease.allCapacity && lease.weight !== capacity) {
    reject(`${path}.weight`, "all-capacity lease must equal capacity");
  }
  const resources = array(lease.resources, `${path}.resources`);
  const seenResources = new Set();
  resources.forEach((resource, index) => {
    if (!isResourceNameValue(resource)) {
      reject(`${path}.resources[${index}]`, "is not a valid resource name");
    }
    if (seenResources.has(resource)) {
      reject(`${path}.resources[${index}]`, "duplicates a resource name");
    }
    seenResources.add(resource);
    if (index && resources[index - 1] > resource) {
      reject(`${path}.resources`, "must be sorted");
    }
  });
  boundedJson(lease.metadata, `${path}.metadata`);
  positiveInteger(lease.sequence, `${path}.sequence`);
  if (sequences.has(lease.sequence)) {
    reject(`${path}.sequence`, `duplicates ${sequences.get(lease.sequence)}`);
  }
  sequences.set(lease.sequence, path);
  oneOf(
    lease.status,
    ["queued", "granted", "drain-required"],
    `${path}.status`,
  );
  utcTimestamp(lease.queuedAt, `${path}.queuedAt`);
  if (lease.status === "queued") {
    if (lease.acquiredAt !== null || lease.drainObligationId !== null) {
      reject(path, "queued lease cannot be acquired or drain-required");
    }
  } else {
    utcTimestamp(lease.acquiredAt, `${path}.acquiredAt`);
    if (lease.status === "granted" && lease.drainObligationId !== null) {
      reject(path, "granted lease cannot reference a drain obligation");
    }
    if (lease.status === "drain-required") {
      identifier(lease.drainObligationId, `${path}.drainObligationId`);
    }
  }
  if (
    request.role !== "leader" ||
    request.admission !== "held" ||
    request.resultReady
  ) {
    reject(path, "lease requires an admitted non-terminal leader request");
  }
  if (lease.status === "drain-required") {
    if (request.pendingTerminal === null) {
      reject(path, "drain-required lease needs a pending terminal request");
    }
  } else if (request.pendingTerminal !== null || request.state !== "active") {
    reject(path, "queued or granted lease requires an active request");
  }
}

function validateSingleflight(singleflight, key, state) {
  const path = `singleflights.${key}`;
  record(singleflight, path);
  sha256(key, path);
  text(singleflight.fingerprint, `${path}.fingerprint`, 64 * 1024);
  sha256(singleflight.fingerprintHash, `${path}.fingerprintHash`);
  if (singleflight.fingerprintHash !== key) {
    reject(path, "map key differs from fingerprintHash");
  }
  const computedHash = createHash("sha256")
    .update(singleflight.fingerprint)
    .digest("hex");
  if (computedHash !== key) reject(path, "fingerprint does not match map key");
  identifier(singleflight.executionId, `${path}.executionId`);
  identifier(singleflight.leaderRequestId, `${path}.leaderRequestId`);
  utcTimestamp(singleflight.createdAt, `${path}.createdAt`);
  const followers = array(singleflight.followers, `${path}.followers`);
  const followerSet = new Set();
  followers.forEach((requestId, index) => {
    identifier(requestId, `${path}.followers[${index}]`);
    if (followerSet.has(requestId)) {
      reject(`${path}.followers[${index}]`, "duplicates a follower");
    }
    followerSet.add(requestId);
  });

  const leader = own(state.requests, singleflight.leaderRequestId);
  if (
    !leader ||
    leader.role !== "leader" ||
    leader.resultReady ||
    leader.fingerprintHash !== key ||
    leader.fingerprint !== singleflight.fingerprint ||
    leader.executionId !== singleflight.executionId
  ) {
    reject(`${path}.leaderRequestId`, "does not reference the active leader");
  }
  if (singleflight.createdAt !== leader.createdAt) {
    reject(`${path}.createdAt`, "differs from leader creation time");
  }
  let previousSequence = leader.sequence;
  for (const requestId of followers) {
    const follower = own(state.requests, requestId);
    if (
      !follower ||
      follower.role !== "follower" ||
      follower.resultReady ||
      follower.leaderRequestId !== leader.requestId ||
      follower.fingerprintHash !== key ||
      follower.fingerprint !== singleflight.fingerprint ||
      follower.executionId !== singleflight.executionId
    ) {
      reject(`${path}.followers`, `${requestId} is not an attached follower`);
    }
    if (follower.sequence <= previousSequence) {
      reject(`${path}.followers`, "must follow request sequence order");
    }
    previousSequence = follower.sequence;
  }
  const expectedFollowers = Object.values(state.requests)
    .filter(
      (request) =>
        request.role === "follower" &&
        !request.resultReady &&
        request.fingerprintHash === key,
    )
    .sort((left, right) => left.sequence - right.sequence)
    .map((request) => request.requestId);
  if (
    expectedFollowers.length !== followers.length ||
    expectedFollowers.some((requestId, index) => requestId !== followers[index])
  ) {
    reject(`${path}.followers`, "does not match active follower requests");
  }
}

function validateObligation(obligation, key, state) {
  const path = `drainObligations.${key}`;
  record(obligation, path);
  identifier(key, path);
  identifier(obligation.obligationId, `${path}.obligationId`);
  if (obligation.obligationId !== key) {
    reject(path, "map key differs from obligationId");
  }
  identifier(obligation.leaseId, `${path}.leaseId`);
  identifier(obligation.requestId, `${path}.requestId`);
  runToken(obligation.drainIdentity, `${path}.drainIdentity`);
  identity(obligation.owner, `${path}.owner`);
  positiveInteger(obligation.weight, `${path}.weight`);
  const resources = array(obligation.resources, `${path}.resources`);
  resources.forEach((resource, index) => {
    if (!isResourceNameValue(resource)) {
      reject(`${path}.resources[${index}]`, "is not a valid resource name");
    }
  });
  text(obligation.reason, `${path}.reason`, 8192);
  runToken(obligation.generationToken, `${path}.generationToken`);
  utcTimestamp(obligation.drainRequiredAt, `${path}.drainRequiredAt`);
  if (obligation.claim !== null) {
    record(obligation.claim, `${path}.claim`);
    identity(obligation.claim.claimant, `${path}.claim.claimant`);
    utcTimestamp(obligation.claim.claimedAt, `${path}.claim.claimedAt`);
  }

  const request = own(state.requests, obligation.requestId);
  const lease = own(state.leases, obligation.leaseId);
  if (!request) reject(`${path}.requestId`, "does not reference a request");
  if (!lease) reject(`${path}.leaseId`, "does not reference a lease");
  if (
    lease.requestId !== request.requestId ||
    lease.status !== "drain-required" ||
    lease.drainObligationId !== obligation.obligationId
  ) {
    reject(path, "does not match its drain-required lease");
  }
  if (
    request.pendingTerminal === null ||
    request.pendingTerminal.payload.reason !== obligation.reason ||
    request.drainIdentity !== obligation.drainIdentity ||
    !identitiesEqual(request.owner, obligation.owner) ||
    !identitiesEqual(lease.owner, obligation.owner) ||
    lease.weight !== obligation.weight ||
    JSON.stringify(lease.resources) !== JSON.stringify(resources)
  ) {
    reject(path, "does not match its request and lease evidence");
  }
}

function validateSuccessIndex(index, key) {
  const path = `successIndex.${key}`;
  sha256(key, path);
  record(index, path);
  identifier(index.executionId, `${path}.executionId`);
  utcTimestamp(index.completedAt, `${path}.completedAt`);
}

export function validatePersistedJournal(state, capacity) {
  record(state, "journal");
  positiveInteger(capacity, "capacity");
  positiveInteger(state.schemaVersion, "schemaVersion");
  record(state.protocol, "protocol");
  positiveInteger(state.protocol.major, "protocol.major");
  nonNegativeInteger(state.protocol.minor, "protocol.minor");
  sha256(state.policyHash, "policyHash");
  positiveInteger(state.capacity, "capacity");
  if (state.capacity !== capacity) {
    reject("capacity", "differs from the configured capacity");
  }
  nonNegativeInteger(state.revision, "revision");
  positiveInteger(state.nextSequence, "nextSequence");
  nonNegativeInteger(state.roundRobinCursor, "roundRobinCursor");
  identity(state.coordinatorIdentity, "coordinatorIdentity");
  runToken(state.generationToken, "generationToken");
  record(state.requests, "requests");
  record(state.leases, "leases");
  record(state.singleflights, "singleflights");
  record(state.drainObligations, "drainObligations");
  record(state.successIndex, "successIndex");
  const requestOrder = array(state.requestOrder, "requestOrder");
  const sequences = new Map();

  for (const [key, request] of Object.entries(state.requests)) {
    validateRequest(request, key, sequences);
  }
  const requestTokens = new Map();
  for (const request of Object.values(state.requests)) {
    const owner = requestTokens.get(request.drainIdentity);
    if (owner) {
      reject(
        `requests.${request.requestId}.drainIdentity`,
        `duplicates the drain token owned by ${owner.requestId}`,
      );
    }
    requestTokens.set(request.drainIdentity, request);
  }
  const heldWorktrees = new Map();
  for (const request of Object.values(state.requests)) {
    if (request.admission !== "held") continue;
    const held = heldWorktrees.get(request.worktreeKey);
    if (held) {
      reject(
        `requests.${request.requestId}.admission`,
        `duplicates held worktree admission for ${held.requestId}`,
      );
    }
    heldWorktrees.set(request.worktreeKey, request);
  }
  for (const request of Object.values(state.requests)) {
    if (request.admission !== "queued") continue;
    const holder = heldWorktrees.get(request.worktreeKey);
    if (!holder || holder.sequence >= request.sequence) {
      reject(
        `requests.${request.requestId}.admission`,
        "queued worktree has no older holder",
      );
    }
  }

  for (const [key, lease] of Object.entries(state.leases)) {
    validateLease(lease, key, state, sequences, capacity);
  }
  for (const [key, singleflight] of Object.entries(state.singleflights)) {
    validateSingleflight(singleflight, key, state);
  }
  for (const [key, obligation] of Object.entries(state.drainObligations)) {
    validateObligation(obligation, key, state);
  }
  for (const [key, index] of Object.entries(state.successIndex)) {
    validateSuccessIndex(index, key);
  }

  const orderSet = new Set();
  let previousRequestSequence = 0;
  requestOrder.forEach((requestId, index) => {
    identifier(requestId, `requestOrder[${index}]`);
    if (orderSet.has(requestId)) {
      reject(`requestOrder[${index}]`, "duplicates a request");
    }
    orderSet.add(requestId);
    const request = own(state.requests, requestId);
    if (!request || request.role !== "leader" || request.resultReady) {
      reject(`requestOrder[${index}]`, "does not reference an active leader");
    }
    if (request.sequence <= previousRequestSequence) {
      reject("requestOrder", "must follow request sequence order");
    }
    previousRequestSequence = request.sequence;
  });
  const expectedLeaders = Object.values(state.singleflights)
    .map((singleflight) => own(state.requests, singleflight.leaderRequestId))
    .sort((left, right) => left.sequence - right.sequence)
    .map((request) => request.requestId);
  if (
    expectedLeaders.length !== requestOrder.length ||
    expectedLeaders.some(
      (requestId, index) => requestId !== requestOrder[index],
    )
  ) {
    reject("requestOrder", "does not match active singleflight leaders");
  }
  for (const request of Object.values(state.requests)) {
    if (request.resultReady || request.role === "completed") continue;
    const singleflight = own(state.singleflights, request.fingerprintHash);
    if (!singleflight) {
      reject(
        `requests.${request.requestId}`,
        "non-terminal request has no active singleflight",
      );
    }
    if (
      request.role === "leader" &&
      singleflight.leaderRequestId !== request.requestId
    ) {
      reject(`requests.${request.requestId}`, "is not its singleflight leader");
    }
    if (
      request.role === "follower" &&
      !singleflight.followers.includes(request.requestId)
    ) {
      reject(
        `requests.${request.requestId}`,
        "is not attached to its singleflight",
      );
    }
  }

  const activeResources = new Map();
  let usedCapacity = 0;
  for (const lease of Object.values(state.leases)) {
    if (!["granted", "drain-required"].includes(lease.status)) continue;
    usedCapacity += lease.weight;
    if (!Number.isSafeInteger(usedCapacity) || usedCapacity > capacity) {
      reject("leases", "active lease weight exceeds capacity");
    }
    for (const resource of lease.resources) {
      const holder = activeResources.get(resource);
      if (holder) {
        reject(
          `leases.${lease.leaseId}.resources`,
          `resource ${resource} is already held by ${holder}`,
        );
      }
      activeResources.set(resource, lease.leaseId);
    }
  }

  const obligationsByToken = new Map();
  for (const obligation of Object.values(state.drainObligations)) {
    const siblings = obligationsByToken.get(obligation.drainIdentity) ?? [];
    siblings.push(obligation);
    obligationsByToken.set(obligation.drainIdentity, siblings);
  }
  for (const [token, obligations] of obligationsByToken) {
    const requestId = obligations[0].requestId;
    const claims = obligations.map((obligation) => obligation.claim);
    if (obligations.some((obligation) => obligation.requestId !== requestId)) {
      reject(`drainObligations.${token}`, "one drain token spans requests");
    }
    if (claims.some(Boolean) && claims.some((claim) => claim === null)) {
      reject(
        `drainObligations.${token}`,
        "sibling claims are only partly held",
      );
    }
    const claimant = claims.find(Boolean)?.claimant;
    if (
      claimant &&
      claims.some((claim) => !identitiesEqual(claim.claimant, claimant))
    ) {
      reject(
        `drainObligations.${token}`,
        "sibling claims have different owners",
      );
    }
    const claimedAt = claims.find(Boolean)?.claimedAt;
    if (claimedAt && claims.some((claim) => claim.claimedAt !== claimedAt)) {
      reject(
        `drainObligations.${token}`,
        "sibling claims have different times",
      );
    }
  }
  for (const lease of Object.values(state.leases)) {
    if (lease.status !== "drain-required") continue;
    if (!own(state.drainObligations, lease.drainObligationId)) {
      reject(`leases.${lease.leaseId}`, "has no matching drain obligation");
    }
  }
  for (const request of Object.values(state.requests)) {
    const requestLeases = Object.values(state.leases).filter(
      (lease) => lease.requestId === request.requestId,
    );
    if (request.resultReady && requestLeases.length) {
      reject(
        `requests.${request.requestId}`,
        "result-ready request still has leases",
      );
    }
    if (request.pendingTerminal !== null) {
      if (
        !requestLeases.length ||
        requestLeases.some((lease) => lease.status !== "drain-required")
      ) {
        reject(
          `requests.${request.requestId}`,
          "pending terminal request must own only drain-required leases",
        );
      }
    }
  }

  if (requestOrder.length === 0) {
    if (state.roundRobinCursor !== 0) {
      reject("roundRobinCursor", "must be zero when requestOrder is empty");
    }
  } else if (state.roundRobinCursor >= requestOrder.length) {
    reject("roundRobinCursor", "is outside requestOrder");
  }
  for (const [sequence, path] of sequences) {
    if (sequence >= state.nextSequence) {
      reject(`${path}.sequence`, "must be below nextSequence");
    }
  }
}
