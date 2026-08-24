import {
  CoordinatorError,
  copy,
  identifier,
  identitiesEqual,
  utc,
  validateIdentity,
  validateRunToken,
} from "./quality-gate-coordinator-state.mjs";

function obligationFor(state, obligationId, drainIdentity) {
  identifier(obligationId, "obligationId");
  validateRunToken(drainIdentity, "drainIdentity");
  const obligation = state.drainObligations[obligationId];
  if (!obligation) {
    throw new CoordinatorError(
      "DRAIN_OBLIGATION_NOT_FOUND",
      "drain obligation is not active",
    );
  }
  if (obligation.drainIdentity !== drainIdentity) {
    throw new CoordinatorError(
      "DRAIN_TOKEN_MISMATCH",
      "drain token does not match the obligation",
    );
  }
  return obligation;
}

export function claimDrain(
  state,
  { obligationId, drainIdentity, claimant },
  now,
) {
  validateIdentity(claimant, "claimant");
  const obligation = obligationFor(state, obligationId, drainIdentity);
  const siblings = Object.values(state.drainObligations).filter(
    (candidate) => candidate.drainIdentity === drainIdentity,
  );
  const conflict = siblings.find(
    (candidate) =>
      candidate.claim && !identitiesEqual(candidate.claim.claimant, claimant),
  );
  if (conflict) {
    throw new CoordinatorError(
      "DRAIN_ALREADY_CLAIMED",
      "another live process identity owns this drain token",
      { claim: copy(conflict.claim) },
    );
  }
  let changed = 0;
  const claimedAt = utc(now);
  for (const sibling of siblings) {
    if (sibling.claim) continue;
    sibling.claim = { claimant: copy(claimant), claimedAt };
    changed += 1;
  }
  return {
    claimed: true,
    idempotent: changed === 0,
    drainIdentity,
    obligation: copy(obligation),
    obligations: siblings.map(copy),
  };
}

export function releaseDrainClaim(
  state,
  { obligationId, drainIdentity, claimant },
) {
  validateIdentity(claimant, "claimant");
  obligationFor(state, obligationId, drainIdentity);
  const siblings = Object.values(state.drainObligations).filter(
    (candidate) => candidate.drainIdentity === drainIdentity,
  );
  const claims = siblings.filter((candidate) => candidate.claim);
  if (!claims.length) return { released: false, reason: "not-claimed" };
  if (
    claims.some(
      (candidate) => !identitiesEqual(candidate.claim.claimant, claimant),
    )
  ) {
    throw new CoordinatorError(
      "DRAIN_CLAIM_IDENTITY_MISMATCH",
      "drain claim belongs to another process identity",
    );
  }
  for (const sibling of siblings) sibling.claim = null;
  return {
    released: true,
    obligationId,
    drainIdentity,
    releasedObligations: claims.length,
  };
}

export function assertDrainClaim(obligation, claimant) {
  validateIdentity(claimant, "drainer");
  if (!obligation.claim) {
    throw new CoordinatorError(
      "DRAIN_CLAIM_REQUIRED",
      "claim the drain obligation before acknowledgement",
    );
  }
  if (!identitiesEqual(obligation.claim.claimant, claimant)) {
    throw new CoordinatorError(
      "DRAIN_CLAIM_IDENTITY_MISMATCH",
      "drain acknowledgement identity differs from the claim",
    );
  }
}

export function staleDrainClaims(state) {
  const claims = new Map();
  for (const obligation of Object.values(state.drainObligations)) {
    if (!obligation.claim || claims.has(obligation.drainIdentity)) continue;
    claims.set(obligation.drainIdentity, {
      obligationId: obligation.obligationId,
      drainIdentity: obligation.drainIdentity,
      claimant: copy(obligation.claim.claimant),
    });
  }
  return [...claims.values()];
}
