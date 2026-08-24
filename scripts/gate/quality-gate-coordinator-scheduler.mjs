import { randomUUID } from "node:crypto";

import {
  CoordinatorError,
  copy,
  utc,
  validateRunToken,
} from "./quality-gate-coordinator-primitives.mjs";

export function activeLeases(state) {
  return Object.values(state.leases).filter((lease) =>
    ["granted", "drain-required"].includes(lease.status),
  );
}

export function usedCapacity(state) {
  return activeLeases(state).reduce((sum, lease) => sum + lease.weight, 0);
}

export function recoverGrantedLeases(state, recoveredGeneration, now) {
  for (const lease of Object.values(state.leases)) {
    if (lease.status === "queued") {
      // The waiting RPC connection ended with the old coordinator. Do not grant
      // work that no client can receive after the restart.
      delete state.leases[lease.leaseId];
      continue;
    }
    if (lease.status !== "granted") continue;
    const request = state.requests[lease.requestId];
    if (!request) {
      throw new CoordinatorError(
        "INCONSISTENT_RECOVERY_STATE",
        "granted lease has no request state",
      );
    }
    validateRunToken(request.drainToken, "drainToken");
    lease.status = "drain-required";
    const obligationId = `recovery-${randomUUID()}`;
    lease.drainObligationId = obligationId;
    state.drainObligations[obligationId] = {
      obligationId,
      leaseId: lease.leaseId,
      requestId: lease.requestId,
      drainToken: request.drainToken,
      owner: copy(lease.owner),
      weight: lease.weight,
      resources: copy(lease.resources),
      reason: "coordinator-restart",
      generationToken: recoveredGeneration,
      drainRequiredAt: utc(now),
      claim: null,
    };
    request.state = "drain-required";
    request.pendingTerminal ??= {
      status: "cancelled",
      payload: { reason: "coordinator-restart" },
    };
  }
}

function heldResources(state) {
  const held = new Map();
  for (const lease of activeLeases(state)) {
    for (const resource of lease.resources) held.set(resource, lease.leaseId);
  }
  return held;
}

function requestQueue(state, requestId) {
  return Object.values(state.leases)
    .filter(
      (lease) => lease.requestId === requestId && lease.status === "queued",
    )
    .sort((left, right) => left.sequence - right.sequence);
}

export function barrier(state) {
  return (
    Object.values(state.leases)
      .filter(
        (lease) =>
          lease.status === "queued" &&
          lease.allCapacity &&
          requestQueue(state, lease.requestId)[0]?.leaseId === lease.leaseId,
      )
      .sort((left, right) => left.sequence - right.sequence)[0] ?? null
  );
}

export function weightedReservation(state) {
  return (
    Object.values(state.leases)
      .filter(
        (lease) =>
          lease.status === "queued" &&
          (lease.allCapacity || lease.weight > 1) &&
          requestQueue(state, lease.requestId)[0]?.leaseId === lease.leaseId,
      )
      .sort((left, right) => left.sequence - right.sequence)[0] ?? null
  );
}

function canGrant(state, lease) {
  if (usedCapacity(state) + lease.weight > state.capacity) return false;
  const held = heldResources(state);
  return lease.resources.every((resource) => !held.has(resource));
}

export function scheduleState(state, acquiredAt, grantGuard = () => true) {
  const grants = [];
  while (true) {
    const reservation = weightedReservation(state);
    const count = state.requestOrder.length;
    const candidates = [];
    for (let offset = 0; offset < count; offset += 1) {
      const index = (state.roundRobinCursor + offset) % count;
      const lease = requestQueue(state, state.requestOrder[index])[0];
      if (lease) candidates.push({ index, lease });
    }
    let candidate;
    if (reservation) {
      const older = candidates.filter(
        ({ lease }) => lease.sequence < reservation.sequence,
      );
      candidate = older.find(({ lease }) => canGrant(state, lease));
      if (!candidate) {
        const reserved = candidates.find(
          ({ lease }) => lease.leaseId === reservation.leaseId,
        );
        if (reserved && canGrant(state, reserved.lease)) candidate = reserved;
      }
    } else {
      candidate = candidates.find(({ lease }) => canGrant(state, lease));
    }
    if (!candidate) break;
    if (grantGuard(candidate.lease) !== true) break;
    candidate.lease.status = "granted";
    candidate.lease.acquiredAt = acquiredAt;
    state.roundRobinCursor = count ? (candidate.index + 1) % count : 0;
    grants.push(candidate.lease.leaseId);
    if (candidate.lease.allCapacity) break;
  }
  return grants;
}

export function blockersForLease(state, lease) {
  if (lease.status !== "queued") return [];
  const blockers = [];
  const ownQueue = requestQueue(state, lease.requestId);
  if (ownQueue[0]?.leaseId !== lease.leaseId) {
    blockers.push({ type: "request-order", leaseId: ownQueue[0].leaseId });
  }
  const oldestBarrier = barrier(state);
  if (oldestBarrier && lease.sequence > oldestBarrier.sequence) {
    blockers.push({
      type: "all-capacity-barrier",
      leaseId: oldestBarrier.leaseId,
    });
  }
  const reservation = weightedReservation(state);
  if (
    reservation &&
    !reservation.allCapacity &&
    lease.sequence > reservation.sequence
  ) {
    blockers.push({
      type: "weighted-capacity-reservation",
      leaseId: reservation.leaseId,
      requestId: reservation.requestId,
      weight: reservation.weight,
    });
  }
  const used = usedCapacity(state);
  if (used + lease.weight > state.capacity) {
    blockers.push({
      type: "capacity",
      used,
      requested: lease.weight,
      capacity: state.capacity,
      holders: activeLeases(state).map((active) => active.leaseId),
    });
  }
  const held = heldResources(state);
  for (const resource of lease.resources) {
    if (held.has(resource)) {
      blockers.push({
        type: "resource",
        resource,
        leaseId: held.get(resource),
      });
    }
  }
  return blockers;
}

export function worktreeHolder(state, key, exclude = null) {
  return Object.values(state.requests).find(
    (request) =>
      request.requestId !== exclude &&
      request.worktreeKey === key &&
      request.admission === "held",
  );
}

export function admitWorktrees(state) {
  const waiting = Object.values(state.requests)
    .filter((request) => request.admission === "queued")
    .sort((left, right) => left.sequence - right.sequence);
  for (const request of waiting) {
    if (worktreeHolder(state, request.worktreeKey, request.requestId)) continue;
    request.admission = "held";
    request.state = request.resultReady
      ? "result-ready"
      : request.role === "leader"
        ? "active"
        : "waiting-result";
  }
}
