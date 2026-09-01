/**
 * Durable Project ownership fields for issue-board transactions.
 *
 * Every ownership read comes from one ProjectV2Item fieldValues response so a
 * release can snapshot and restore all related fields consistently.
 * Repo-owned callers pass the active per-issue mutex capability through each
 * owner-field write.
 */

import {
  IssueOwnershipConflictError,
  OPTIONAL_PROJECT_FIELDS,
  projectDateFieldValue,
} from "./issue-board-state.mjs";
import {
  findField,
  PROSPECTIVE_PROJECT_ITEM_ID,
  updateTextField,
} from "./issue-board-projects.mjs";
import { ghGraphql } from "./issue-board-transport.mjs";

export function requireOwnershipFields(project) {
  const expected = {
    [OPTIONAL_PROJECT_FIELDS.agent]: "TEXT",
    [OPTIONAL_PROJECT_FIELDS.branch]: "TEXT",
    [OPTIONAL_PROJECT_FIELDS.claimId]: "TEXT",
    [OPTIONAL_PROJECT_FIELDS.claimedAt]: "DATE",
    [OPTIONAL_PROJECT_FIELDS.pr]: "TEXT",
  };
  const fields = {};
  for (const [name, dataType] of Object.entries(expected)) {
    const field = findField(project, name);
    if (field?.dataType !== dataType) {
      throw new Error(
        `Project must have a ${dataType} ${name} field for issue ownership`,
      );
    }
    fields[name] = field;
  }
  return fields;
}

export function requireClaimIdField(project) {
  return requireOwnershipFields(project)[OPTIONAL_PROJECT_FIELDS.claimId];
}

function parseProjectPr(value, itemId) {
  if (value == null || value === "") return null;
  const match = String(value).match(/^#([1-9]\d*)$/);
  if (!match) {
    throw new Error(
      `Project item ${itemId} has invalid PR ownership value ${JSON.stringify(value)}`,
    );
  }
  return Number(match[1]);
}

export async function readClaimOwnership(
  options,
  project,
  itemId,
  { graphql = ghGraphql } = {},
) {
  const fields = requireOwnershipFields(project);
  const response = await graphql(
    `
      query ($item: ID!) {
        node(id: $item) {
          ... on ProjectV2Item {
            fieldValues(first: 100) {
              nodes {
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field {
                    ... on ProjectV2FieldCommon {
                      id
                    }
                  }
                }
                ... on ProjectV2ItemFieldDateValue {
                  date
                  field {
                    ... on ProjectV2FieldCommon {
                      id
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      }
    `,
    { item: itemId },
  );
  const values = response?.data?.node?.fieldValues;
  if (!values) throw new Error(`Project item ${itemId} was not found`);
  if (
    !Array.isArray(values.nodes) ||
    typeof values.pageInfo?.hasNextPage !== "boolean"
  ) {
    throw new Error(
      `Project item ${itemId} ownership lookup was incomplete; refusing to treat missing owner fields as empty`,
    );
  }
  if (values.pageInfo.hasNextPage) {
    throw new Error(
      `Project item ${itemId} has more than 100 field values; refusing an inconsistent ownership snapshot`,
    );
  }
  const valuesById = new Map();
  for (const value of values.nodes) {
    if (value?.field?.id) {
      valuesById.set(value.field.id, value.text ?? value.date ?? null);
    }
  }
  const value = (name) => valuesById.get(fields[name].id) ?? null;
  return {
    claimId: value(OPTIONAL_PROJECT_FIELDS.claimId),
    agent: value(OPTIONAL_PROJECT_FIELDS.agent),
    branch: value(OPTIONAL_PROJECT_FIELDS.branch),
    claimedAt: value(OPTIONAL_PROJECT_FIELDS.claimedAt),
    pr: parseProjectPr(value(OPTIONAL_PROJECT_FIELDS.pr), itemId),
  };
}

function ownershipConflict(issue, expectedClaimId, actualClaimId, message) {
  return new IssueOwnershipConflictError(message, {
    issue: issue.number,
    expectedClaimId,
    actualClaimId,
  });
}

function hasOwnershipValue(value) {
  return value != null && value !== "";
}

const OWNERSHIP_KEYS = ["claimId", "agent", "branch", "claimedAt", "pr"];

export function assertExactClaimOwnership(issue, actual, expected, phase) {
  const mismatches = OWNERSHIP_KEYS.filter(
    (field) => actual?.[field] !== expected[field],
  );
  if (mismatches.length === 0) return actual;
  throw new IssueOwnershipConflictError(
    `Issue #${issue.number} ownership changed ${phase}; mismatched ${mismatches.join(", ")}`,
    {
      issue: issue.number,
      expectedClaimId: expected.claimId,
      actualClaimId: actual?.claimId ?? null,
      expected,
      actual: actual ?? null,
      conflictingFields: mismatches,
    },
  );
}

export function expectedClaimOwnership(metadata) {
  return {
    claimId: metadata.claimId,
    agent: metadata.agent ?? null,
    branch: metadata.branch ?? null,
    claimedAt: projectDateFieldValue(metadata.claimedAt),
    pr: metadata.pr ?? null,
  };
}

export function planClaimOwnershipReservation(issue, ownership, metadata) {
  const expected = expectedClaimOwnership(metadata);
  if (!hasOwnershipValue(ownership.claimId)) {
    const occupiedFields = ["agent", "branch", "claimedAt", "pr"].filter(
      (field) => hasOwnershipValue(ownership[field]),
    );
    if (occupiedFields.length > 0) {
      throw new IssueOwnershipConflictError(
        `Issue #${issue.number} fresh claim reservation found partial ownership in ${occupiedFields.join(", ")}; a fresh Claim ID requires every other ownership field to be empty`,
        {
          issue: issue.number,
          expected,
          actual: ownership,
          conflictingFields: occupiedFields,
        },
      );
    }
    return {
      mode: "fresh",
      expected,
      missingMetadata: {
        agent: metadata.agent ?? null,
        branch: metadata.branch ?? null,
        claimedAt: metadata.claimedAt ?? null,
        pr: metadata.pr ?? null,
      },
    };
  }

  if (ownership.claimId !== expected.claimId) {
    throw ownershipConflict(
      issue,
      expected.claimId,
      ownership.claimId,
      `Issue #${issue.number} is owned by project Claim ID ${ownership.claimId} instead of ${expected.claimId}`,
    );
  }

  const conflictingFields = ["agent", "branch", "claimedAt", "pr"].filter(
    (field) =>
      hasOwnershipValue(ownership[field]) &&
      ownership[field] !== expected[field],
  );
  if (conflictingFields.length > 0) {
    throw new IssueOwnershipConflictError(
      `Issue #${issue.number} same-token claim recovery conflicts in ${conflictingFields.join(", ")}; use issue:review --rebind-branch for a proven branch move`,
      {
        issue: issue.number,
        expected,
        actual: ownership,
        conflictingFields,
      },
    );
  }

  const missingMetadata = {};
  for (const field of ["agent", "branch", "claimedAt", "pr"]) {
    if (
      !hasOwnershipValue(ownership[field]) &&
      hasOwnershipValue(expected[field])
    ) {
      missingMetadata[field] = metadata[field];
    }
  }
  return { mode: "same-token", expected, missingMetadata };
}

export async function planClaimOwnershipMetadataWrite(
  options,
  project,
  itemId,
  issue,
  metadata,
  { readOwnership = readClaimOwnership } = {},
) {
  const ownership = await readOwnership(options, project, itemId);
  if (ownership.claimId !== metadata.claimId) {
    throw ownershipConflict(
      issue,
      metadata.claimId,
      ownership.claimId,
      `Issue #${issue.number} ownership changed before its metadata write; project Claim ID is ${ownership.claimId ?? "<empty>"} instead of ${metadata.claimId}`,
    );
  }
  return {
    ...planClaimOwnershipReservation(issue, ownership, metadata),
    ownership,
  };
}

const OWNERSHIP_WRITE_ORDER = ["agent", "branch", "pr", "claimedAt", "claimId"];

async function writeClaimIdWithCapability(
  options,
  project,
  itemId,
  fieldId,
  value,
  capability,
  issue,
) {
  return updateTextField(capability, options, project, itemId, fieldId, value, {
    field: OPTIONAL_PROJECT_FIELDS.claimId,
    issueNumber: issue.number,
    operation: "claim",
  });
}

function normalizedOwnershipValue(field, value) {
  if (field === "claimedAt") return projectDateFieldValue(value);
  if (field === "pr") return value == null || value === "" ? null : value;
  return value == null || value === "" ? null : value;
}

export async function writeProjectOwnershipMetadata(
  options,
  project,
  itemId,
  issue,
  state,
  expectedOwnership,
  metadata,
  { readOwnership = readClaimOwnership, updateMetadata },
  capability,
  operation,
) {
  if (options.dryRun) {
    await updateMetadata(
      options,
      project,
      itemId,
      state,
      metadata,
      capability,
      issue,
      operation,
    );
    return expectedOwnership;
  }

  const expectedProgress = { ...expectedOwnership };
  for (const field of OWNERSHIP_WRITE_ORDER) {
    if (!Object.hasOwn(metadata, field)) continue;
    const nextValue = normalizedOwnershipValue(field, metadata[field]);
    if (expectedProgress[field] === nextValue) continue;
    const actual = await readOwnership(options, project, itemId);
    assertExactClaimOwnership(
      issue,
      actual,
      expectedProgress,
      `before ${field} metadata write`,
    );
    await updateMetadata(
      options,
      project,
      itemId,
      state,
      { [field]: metadata[field] },
      capability,
      issue,
      operation,
    );
    expectedProgress[field] = nextValue;
  }
  return expectedProgress;
}

export async function reserveClaimOwnership(
  options,
  project,
  itemId,
  issue,
  metadata,
  {
    readOwnership = readClaimOwnership,
    writeClaimId = writeClaimIdWithCapability,
  } = {},
  capability,
) {
  if (options.dryRun && itemId === PROSPECTIVE_PROJECT_ITEM_ID) {
    return {
      mode: "prospective",
      expected: expectedClaimOwnership(metadata),
      missingMetadata: { ...metadata },
    };
  }
  const claimField = requireClaimIdField(project);
  const currentOwnership = await readOwnership(options, project, itemId);
  const reservation = planClaimOwnershipReservation(
    issue,
    currentOwnership,
    metadata,
  );
  if (reservation.mode === "fresh") {
    await writeClaimId(
      options,
      project,
      itemId,
      claimField.id,
      metadata.claimId,
      capability,
      issue,
    );
  }
  if (options.dryRun) return reservation;
  const verifiedOwnership = await readOwnership(options, project, itemId);
  if (verifiedOwnership.claimId !== metadata.claimId) {
    throw ownershipConflict(
      issue,
      metadata.claimId,
      verifiedOwnership.claimId,
      `Issue #${issue.number} ownership reservation lost; project Claim ID is ${verifiedOwnership.claimId ?? "<empty>"} instead of ${metadata.claimId}`,
    );
  }
  return planClaimOwnershipReservation(issue, verifiedOwnership, metadata);
}

export async function verifyClaimOwnership(
  options,
  project,
  itemId,
  issue,
  metadata,
  { readOwnership = readClaimOwnership } = {},
) {
  if (options.dryRun) return;
  const actual = await readOwnership(options, project, itemId);
  const expected = {
    claimId: metadata.claimId,
    agent: metadata.agent ?? null,
    branch: metadata.branch ?? null,
    claimedAt: projectDateFieldValue(metadata.claimedAt),
    pr: metadata.pr ?? null,
  };
  const mismatches = Object.keys(expected).filter(
    (field) => actual[field] !== expected[field],
  );
  if (mismatches.length > 0) {
    throw ownershipConflict(
      issue,
      metadata.claimId,
      actual.claimId,
      `Issue #${issue.number} ownership verification failed for ${mismatches.join(", ")}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
