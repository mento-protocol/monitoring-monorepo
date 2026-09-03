/**
 * Persistent GitHub-server mutex for one issue-board item.
 *
 * The fixed custom ref is a LOCK and UNLOCK commit chain. Each commit keeps
 * the previous tree. GitHub's updateRefs mutation
 * applies an exact before-OID compare-and-swap to each transition.
 */

import { createHash, randomUUID } from "node:crypto";

import { Kind, parse as parseGraphql, stripIgnoredCharacters } from "graphql";

import {
  IssueOwnershipConflictError,
  OPTIONAL_PROJECT_FIELDS,
  PROSPECTIVE_PROJECT_ITEM_ID,
  splitRepo,
  validateClaimId,
} from "./issue-board-state.mjs";
import { ghGraphql, ghJson, sleep } from "./issue-board-transport.mjs";

const LOCK_KIND = "mento-issue-board-mutex";
const LOCK_VERSION = 1;
const LOCK_REF_PREFIX = "refs/mento-issue-board-locks/v1";
const ZERO_OID = "0000000000000000000000000000000000000000";
const LOCK_RECONCILE_ATTEMPTS = 3;
const LOCK_RECONCILE_DELAY_MS = 200;
const LOCK_AUTHOR = {
  name: "Mento issue board",
  email: "issue-board@users.noreply.github.com",
};

const OWNER_FIELDS_BY_OPERATION = Object.freeze({
  claim: Object.freeze(Object.values(OPTIONAL_PROJECT_FIELDS)),
  review: Object.freeze([
    OPTIONAL_PROJECT_FIELDS.branch,
    OPTIONAL_PROJECT_FIELDS.pr,
  ]),
  release: Object.freeze(Object.values(OPTIONAL_PROJECT_FIELDS)),
  backfill: Object.freeze([
    OPTIONAL_PROJECT_FIELDS.claimId,
    OPTIONAL_PROJECT_FIELDS.agent,
    OPTIONAL_PROJECT_FIELDS.branch,
    OPTIONAL_PROJECT_FIELDS.claimedAt,
  ]),
  sync: Object.freeze([]),
});

const OWNER_FIELD_TYPES = Object.freeze({
  [OPTIONAL_PROJECT_FIELDS.agent]: "TEXT",
  [OPTIONAL_PROJECT_FIELDS.branch]: "TEXT",
  [OPTIONAL_PROJECT_FIELDS.claimId]: "TEXT",
  [OPTIONAL_PROJECT_FIELDS.claimedAt]: "DATE",
  [OPTIONAL_PROJECT_FIELDS.pr]: "TEXT",
});
const OWNER_MUTATION_KINDS = new Set(["clear", "update"]);

const issueOwnerCapabilities = new WeakMap();
const issueOwnerProofTestTransports = new WeakMap();

export function createIssueOwnerProofTestOperations(operations, graphql) {
  if (!operations || typeof operations !== "object") {
    throw new TypeError("Issue owner proof test operations must be an object");
  }
  if (typeof graphql !== "function") {
    throw new TypeError("Issue owner proof test transport must be a function");
  }
  const testOperations = { ...operations };
  issueOwnerProofTestTransports.set(testOperations, graphql);
  return testOperations;
}

function cloneOperationsWithTestTransport(operations, additions) {
  const clone = { ...operations, ...additions };
  const testTransport = issueOwnerProofTestTransports.get(operations);
  if (testTransport) issueOwnerProofTestTransports.set(clone, testTransport);
  return clone;
}

export class IssueOwnerMutationCapabilityError extends Error {
  constructor(message, details = {}, options = {}) {
    super(message, options);
    this.name = "IssueOwnerMutationCapabilityError";
    this.code = "ISSUE_OWNER_MUTATION_CAPABILITY";
    this.details = details;
  }
}

export class IssueMutationLockStaleError extends Error {
  constructor(message, lease, options = {}) {
    super(message, options);
    this.name = "IssueMutationLockStaleError";
    this.code = "ISSUE_MUTATION_LOCK_STALE";
    this.lease = lease;
  }
}

function canonicalScope(options, issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      `Issue number must be a positive integer, got: ${issueNumber}`,
    );
  }
  const projectOwner = String(options.projectOwner ?? "")
    .trim()
    .toLowerCase();
  if (!projectOwner) throw new Error("Project owner must not be empty");
  if (!Number.isInteger(options.projectNumber) || options.projectNumber <= 0) {
    throw new Error("Project number must be a positive integer");
  }
  return {
    repo: splitRepo(options.repo).nameWithOwner.toLowerCase(),
    projectOwner,
    projectNumber: options.projectNumber,
    issue: issueNumber,
  };
}

function ownerTargetProofError(issueNumber, message, details = {}) {
  return new IssueOwnerMutationCapabilityError(
    `Issue #${issueNumber} owner mutation target proof failed: ${message}`,
    { issue: issueNumber, ...details },
  );
}

async function readIssueOwnerTarget(
  options,
  issueNumber,
  { graphql = ghGraphql } = {},
) {
  const scope = canonicalScope(options, issueNumber);
  const { owner, name } = splitRepo(scope.repo);
  const response = await graphql(
    `
      query IssueOwnerMutationTarget(
        $owner: String!
        $name: String!
        $issue: Int!
        $projectOwner: String!
        $projectNumber: Int!
      ) {
        repository(owner: $owner, name: $name) {
          id
          nameWithOwner
          issue(number: $issue) {
            id
            number
            projectItems(first: 100) {
              nodes {
                id
                project {
                  id
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
        organization(login: $projectOwner) {
          login
          projectV2(number: $projectNumber) {
            id
            number
            fields(first: 100) {
              nodes {
                ... on ProjectV2FieldCommon {
                  id
                  name
                  dataType
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
    {
      owner,
      name,
      issue: issueNumber,
      projectOwner: scope.projectOwner,
      projectNumber: scope.projectNumber,
    },
  );
  const repository = response?.data?.repository;
  const issue = repository?.issue;
  const organization = response?.data?.organization;
  const project = organization?.projectV2;
  if (
    !repository?.id ||
    repository.nameWithOwner?.toLowerCase() !== scope.repo
  ) {
    throw ownerTargetProofError(
      issueNumber,
      `repository ${scope.repo} was not proven`,
    );
  }
  if (!issue?.id || issue.number !== issueNumber) {
    throw ownerTargetProofError(
      issueNumber,
      `exact repository issue ${scope.repo}#${issueNumber} was not proven`,
    );
  }
  if (
    organization?.login?.toLowerCase() !== scope.projectOwner ||
    !project?.id ||
    project.number !== scope.projectNumber
  ) {
    throw ownerTargetProofError(
      issueNumber,
      `Project ${scope.projectOwner}/${scope.projectNumber} was not proven`,
    );
  }
  if (
    !Array.isArray(issue.projectItems?.nodes) ||
    issue.projectItems?.pageInfo?.hasNextPage !== false
  ) {
    throw ownerTargetProofError(
      issueNumber,
      "Project item membership proof is missing or paginated",
    );
  }
  if (
    !Array.isArray(project.fields?.nodes) ||
    project.fields?.pageInfo?.hasNextPage !== false
  ) {
    throw ownerTargetProofError(
      issueNumber,
      "Project owner-field proof is missing or paginated",
    );
  }

  const matchingItems = issue.projectItems.nodes.filter(
    (item) => item?.id && item?.project?.id === project.id,
  );
  if (matchingItems.length > 1) {
    throw ownerTargetProofError(
      issueNumber,
      `found ${matchingItems.length} items for the issue in Project ${project.id}`,
    );
  }

  const fieldNodes = project.fields.nodes.filter(
    (field) => field?.id && field?.name && field?.dataType,
  );
  const fields = [];
  const fieldIds = new Set();
  for (const [fieldName, dataType] of Object.entries(OWNER_FIELD_TYPES)) {
    const matches = fieldNodes.filter((field) => field.name === fieldName);
    if (matches.length !== 1) {
      throw ownerTargetProofError(
        issueNumber,
        `Project ${project.id} must contain exactly one ${fieldName} field, found ${matches.length}`,
      );
    }
    const field = matches[0];
    if (field.dataType !== dataType) {
      throw ownerTargetProofError(
        issueNumber,
        `Project field ${fieldName} must have type ${dataType}, found ${field.dataType}`,
      );
    }
    if (fieldIds.has(field.id)) {
      throw ownerTargetProofError(
        issueNumber,
        `Project owner fields reuse node ID ${field.id}`,
      );
    }
    fieldIds.add(field.id);
    fields.push(Object.freeze({ id: field.id, name: fieldName, dataType }));
  }
  fields.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({
    repositoryId: repository.id,
    issueId: issue.id,
    projectId: project.id,
    itemId: matchingItems[0]?.id ?? null,
    fields: Object.freeze(fields),
  });
}

function capabilityScope(options, issueNumber, metadata) {
  const scope = canonicalScope(options, issueNumber);
  if (typeof metadata?.projectId !== "string" || !metadata.projectId) {
    throw new IssueOwnerMutationCapabilityError(
      `Issue #${issueNumber} owner mutation capability requires a Project node ID`,
      { issue: issueNumber },
    );
  }
  const allowedFields = OWNER_FIELDS_BY_OPERATION[metadata.operation];
  if (!allowedFields) {
    throw new IssueOwnerMutationCapabilityError(
      `Issue #${issueNumber} owner mutation capability rejects operation ${JSON.stringify(metadata.operation)}`,
      { issue: issueNumber, operation: metadata.operation ?? null },
    );
  }
  return {
    ...scope,
    projectId: metadata.projectId,
    operation: metadata.operation,
    allowedFields,
  };
}

function mintIssueOwnerCapability(
  options,
  issueNumber,
  metadata,
  { dryRun = false, refreshTarget = null, target = null } = {},
) {
  const scope = capabilityScope(options, issueNumber, metadata);
  const capability = Object.freeze(Object.create(null));
  issueOwnerCapabilities.set(capability, {
    state: "active",
    repo: scope.repo,
    issue: scope.issue,
    projectOwner: scope.projectOwner,
    projectNumber: scope.projectNumber,
    projectId: scope.projectId,
    operation: scope.operation,
    allowedFields: scope.allowedFields,
    dryRun,
    target,
    refreshTarget,
    adoptionPromise: null,
    pendingWrites: new Set(),
    settledFailures: [],
  });
  return capability;
}

function capabilityError(message, binding = {}, options = {}) {
  return new IssueOwnerMutationCapabilityError(
    message,
    {
      repo: binding.repo ?? null,
      issue: binding.issueNumber ?? null,
      projectOwner: binding.projectOwner ?? null,
      projectNumber: binding.projectNumber ?? null,
      projectId: binding.projectId ?? null,
      operation: binding.operation ?? null,
      mutationKind: binding.mutationKind ?? null,
      field: binding.field ?? null,
      fieldId: binding.fieldId ?? null,
      dataType: binding.dataType ?? null,
      itemId: binding.itemId ?? null,
    },
    options,
  );
}

function requireActiveCapability(capability, binding) {
  const record = issueOwnerCapabilities.get(capability);
  if (!record) {
    throw capabilityError(
      "Owner-field mutation requires the exact active issue mutex capability",
      binding,
    );
  }
  if (record.state !== "active") {
    throw capabilityError("Owner-field mutation capability is sealed", binding);
  }
  let bindingScope;
  try {
    bindingScope = canonicalScope(
      {
        repo: binding.repo,
        projectOwner: binding.projectOwner,
        projectNumber: binding.projectNumber,
      },
      binding.issueNumber,
    );
  } catch (err) {
    throw capabilityError("Owner-field mutation scope is invalid", binding, {
      cause: err,
    });
  }
  const mismatches = [];
  if (bindingScope.repo !== record.repo) mismatches.push("repository");
  if (bindingScope.issue !== record.issue) mismatches.push("issue");
  if (bindingScope.projectOwner !== record.projectOwner) {
    mismatches.push("Project owner");
  }
  if (bindingScope.projectNumber !== record.projectNumber) {
    mismatches.push("Project number");
  }
  if (binding.projectId !== record.projectId) mismatches.push("Project ID");
  if (binding.operation !== record.operation) mismatches.push("operation");
  if (mismatches.length > 0) {
    throw capabilityError(
      `Owner-field mutation capability scope mismatch: ${mismatches.join(", ")}`,
      binding,
    );
  }
  if (typeof binding.itemId !== "string" || !binding.itemId) {
    throw capabilityError(
      "Owner-field mutation requires a Project item ID",
      binding,
    );
  }
  if (typeof binding.fieldId !== "string" || !binding.fieldId) {
    throw capabilityError(
      "Owner-field mutation requires a Project field ID",
      binding,
    );
  }
  if (typeof binding.field !== "string" || !binding.field) {
    throw capabilityError(
      "Owner-field mutation requires a semantic Project field name",
      binding,
    );
  }
  if (!OWNER_MUTATION_KINDS.has(binding.mutationKind)) {
    throw capabilityError(
      "Owner-field mutation requires a clear or update mutation kind",
      binding,
    );
  }
  return record;
}

function ownerMutationField(mutationKind) {
  const suffix = "FieldValue";
  return mutationKind === "clear"
    ? `clearProjectV2Item${suffix}`
    : `updateProjectV2Item${suffix}`;
}

function expectedOwnerMutationDocument(binding) {
  const field = ownerMutationField(binding.mutationKind);
  if (binding.mutationKind === "clear") {
    return `
      mutation ($project: ID!, $item: ID!, $field: ID!) {
        ${field}(
          input: { projectId: $project, itemId: $item, fieldId: $field }
        ) {
          projectV2Item { id }
        }
      }
    `;
  }
  const valueField = binding.dataType === "DATE" ? "date" : "text";
  const valueType = binding.dataType === "DATE" ? "Date!" : "String!";
  return `
    mutation (
      $project: ID!
      $item: ID!
      $field: ID!
      $${valueField}: ${valueType}
    ) {
      ${field}(
        input: {
          projectId: $project
          itemId: $item
          fieldId: $field
          value: { ${valueField}: $${valueField} }
        }
      ) {
        projectV2Item { id }
      }
    }
  `;
}

function requireTrustedOwnerMutationDocument(binding, document) {
  if (typeof document !== "string" || !document.trim()) {
    throw capabilityError(
      "Owner-field mutation requires a GraphQL document",
      binding,
    );
  }
  let parsed;
  try {
    parsed = parseGraphql(document);
  } catch (err) {
    throw capabilityError(
      "Owner-field mutation GraphQL document is invalid",
      binding,
      { cause: err },
    );
  }
  const operations = parsed.definitions.filter(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  const fields = operations[0]?.selectionSet?.selections ?? [];
  const expectedField = ownerMutationField(binding.mutationKind);
  if (
    parsed.definitions.length !== 1 ||
    operations.length !== 1 ||
    operations[0].operation !== "mutation" ||
    fields.length !== 1 ||
    fields[0].kind !== Kind.FIELD ||
    fields[0].name.value !== expectedField
  ) {
    throw capabilityError(
      `Owner-field mutation GraphQL document must contain only ${expectedField}`,
      binding,
    );
  }
  if (
    stripIgnoredCharacters(document) !==
    stripIgnoredCharacters(expectedOwnerMutationDocument(binding))
  ) {
    throw capabilityError(
      `Owner-field mutation GraphQL document does not match the trusted ${binding.mutationKind} contract`,
      binding,
    );
  }
}

function sameOwnerTargetSchema(left, right) {
  return (
    left?.repositoryId === right?.repositoryId &&
    left?.issueId === right?.issueId &&
    left?.projectId === right?.projectId &&
    left?.fields.length === right?.fields.length &&
    left.fields.every((field, index) => {
      const other = right.fields[index];
      return (
        field.id === other?.id &&
        field.name === other.name &&
        field.dataType === other.dataType
      );
    })
  );
}

function requireResolvedOwnerTarget(record, binding) {
  const trustedItemId =
    record.dryRun && record.target.itemId == null
      ? PROSPECTIVE_PROJECT_ITEM_ID
      : record.target.itemId;
  if (binding.itemId !== trustedItemId) {
    throw capabilityError(
      `Owner-field mutation capability is pinned to proven Project item ${trustedItemId}`,
      binding,
    );
  }
  const fields = record.target.fields.filter(
    (field) => field.name === binding.field,
  );
  if (fields.length !== 1) {
    throw capabilityError(
      `Operation ${record.operation} cannot write Project field ${JSON.stringify(binding.field)} because it is not in the trusted owner proof`,
      binding,
    );
  }
  const [field] = fields;
  if (binding.fieldId !== field.id) {
    throw capabilityError(
      `Project field ${field.name} has proven ID ${field.id}, not ${JSON.stringify(binding.fieldId)}`,
      binding,
    );
  }
  if (binding.dataType !== field.dataType) {
    throw capabilityError(
      `Project field ${field.name} has proven type ${field.dataType}, not ${JSON.stringify(binding.dataType)}`,
      binding,
    );
  }
  if (!record.allowedFields.includes(binding.field)) {
    throw capabilityError(
      `Operation ${record.operation} cannot write Project field ${JSON.stringify(field.name)}`,
      binding,
    );
  }
  return Object.freeze({
    projectId: record.target.projectId,
    itemId: trustedItemId,
    fieldId: field.id,
  });
}

async function adoptTrustedOwnerTarget(record, binding) {
  if (record.operation !== "claim" || !record.refreshTarget) {
    throw capabilityError(
      "Owner-field mutation target has no proven Project item",
      binding,
    );
  }
  record.adoptionPromise ??= Promise.resolve()
    .then(record.refreshTarget)
    .then((refreshed) => {
      if (!sameOwnerTargetSchema(record.target, refreshed)) {
        throw capabilityError(
          "Owner-field mutation target schema changed before Project item adoption",
          binding,
        );
      }
      if (!refreshed.itemId) {
        throw capabilityError(
          "Claim owner-field mutation target still has no proven Project item",
          binding,
        );
      }
      record.target = refreshed;
    })
    .catch((err) => {
      if (err instanceof IssueOwnerMutationCapabilityError) throw err;
      throw capabilityError(
        "Owner-field mutation target refresh failed",
        binding,
        { cause: err },
      );
    });
  await record.adoptionPromise;
  return requireResolvedOwnerTarget(record, binding);
}

function trackIssueOwnerMutationOutcome(record, pending, lineage) {
  record.pendingWrites.add(pending);
  void pending.then(
    () => record.pendingWrites.delete(pending),
    (reason) => {
      record.pendingWrites.delete(pending);
      record.settledFailures.push({ lineage, reason });
    },
  );

  const trackContinuation = (continuation) => {
    return trackIssueOwnerMutationOutcome(record, continuation, lineage);
  };
  return Object.freeze({
    then(onFulfilled, onRejected) {
      return trackContinuation(pending.then(onFulfilled, onRejected));
    },
    catch(onRejected) {
      return trackContinuation(pending.catch(onRejected));
    },
    finally(onFinally) {
      return trackContinuation(pending.finally(onFinally));
    },
    [Symbol.toStringTag]: "Promise",
  });
}

export function executeIssueOwnerMutation(
  capability,
  binding,
  document,
  { graphql = ghGraphql, value } = {},
) {
  if (typeof graphql !== "function") {
    throw capabilityError(
      "Owner-field mutation executor requires a GraphQL transport",
      binding,
    );
  }
  const record = requireActiveCapability(capability, binding);
  requireTrustedOwnerMutationDocument(binding, document);
  if (record.allowedFields.length === 0) {
    throw capabilityError(
      `Operation ${record.operation} cannot write Project field ID ${JSON.stringify(binding.fieldId)}`,
      binding,
    );
  }
  const resolvedTarget =
    record.dryRun || record.target?.itemId != null
      ? requireResolvedOwnerTarget(record, binding)
      : null;
  return trackIssueOwnerMutationOutcome(
    record,
    Promise.resolve().then(async () => {
      const trustedTarget =
        resolvedTarget ?? (await adoptTrustedOwnerTarget(record, binding));
      const variables = {
        project: trustedTarget.projectId,
        item: trustedTarget.itemId,
        field: trustedTarget.fieldId,
      };
      if (binding.mutationKind === "update") {
        variables[binding.dataType === "DATE" ? "date" : "text"] = value;
      }
      return graphql(document, variables, {
        dryRun: record.dryRun,
        mutates: true,
      });
    }),
    Object.freeze(Object.create(null)),
  );
}

async function sealAndDrainIssueOwnerCapability(capability) {
  const record = issueOwnerCapabilities.get(capability);
  if (!record) {
    return { pendingAtSettlement: [], settledFailures: [] };
  }
  record.state = "sealed";
  const pendingAtSettlement = [...record.pendingWrites];
  try {
    await Promise.allSettled(pendingAtSettlement);
    return {
      pendingAtSettlement,
      settledFailures: [...record.settledFailures],
    };
  } finally {
    issueOwnerCapabilities.delete(capability);
  }
}

function ownDataProperty(value, property) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor && Object.hasOwn(descriptor, "value")
      ? { found: true, value: descriptor.value }
      : { found: false, value: undefined };
  } catch {
    return { found: false, value: undefined };
  }
}

function rejectionGraphContains(callbackRejection, ownerFailure) {
  const pending = [callbackRejection];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (Object.is(current, ownerFailure)) return true;
    if (
      (typeof current !== "object" || current === null) &&
      typeof current !== "function"
    ) {
      continue;
    }
    if (visited.has(current)) continue;
    visited.add(current);

    const cause = ownDataProperty(current, "cause");
    if (cause.found) pending.push(cause.value);
    let aggregateError;
    try {
      aggregateError = current instanceof AggregateError;
    } catch {
      aggregateError = false;
    }
    if (aggregateError) {
      const errors = ownDataProperty(current, "errors");
      if (errors.found && Array.isArray(errors.value)) {
        pending.push(...errors.value);
      }
    }
  }
  return false;
}

function unpropagatedOwnerFailures(closure, mutationFailed, mutationError) {
  if (!mutationFailed) return [...closure.settledFailures];
  return closure.settledFailures.filter((failure, index, failures) => {
    const reasonHasIdentity =
      (typeof failure.reason === "object" && failure.reason !== null) ||
      typeof failure.reason === "function";
    if (!reasonHasIdentity) return true;
    const sharedAcrossLineages = failures.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        other.lineage !== failure.lineage &&
        Object.is(other.reason, failure.reason),
    );
    return (
      sharedAcrossLineages ||
      !rejectionGraphContains(mutationError, failure.reason)
    );
  });
}

function closureCauses(closure, mutationFailed, mutationError) {
  const causes = [];
  if (mutationFailed) causes.push(mutationError);
  causes.push(...closure.settledFailures.map(({ reason }) => reason));
  return causes;
}

export function issueMutationLockRef(options, issueNumber) {
  const scope = canonicalScope(options, issueNumber);
  const key = [scope.repo, String(scope.issue)].join("\n");
  const digest = createHash("sha256").update(key).digest("hex");
  return `${LOCK_REF_PREFIX}/${digest}`;
}

function sameLockIdentity(left, right) {
  return left?.repo === right.repo && left?.issue === right.issue;
}

function validRecordedScope(observed, expected) {
  return (
    sameLockIdentity(observed, expected) &&
    typeof observed?.projectOwner === "string" &&
    observed.projectOwner.length > 0 &&
    Number.isInteger(observed.projectNumber) &&
    observed.projectNumber > 0
  );
}

function lockRecoveryText(lease) {
  return [
    `Persistent issue mutex ${lease.refName} remains at LOCK ${lease.lockOid}.`,
    `Lock payload: ${JSON.stringify(lease.payload)}.`,
    "Before recovery, prove the original helper cannot resume by terminating its session or process or revoking its credential as appropriate.",
    "An operator must inspect the board state and lock payload, then compare-and-swap the ref to an UNLOCK child of that exact LOCK commit.",
    "Do not delete or force-update the mutex ref.",
  ].join(" ");
}

function ambiguousAcquireRecoveryText(lease) {
  return [
    `Persistent issue mutex ${lease.refName} may be at candidate LOCK ${lease.lockOid}.`,
    `Candidate lock payload: ${JSON.stringify(lease.payload)}.`,
    "The helper could not prove the ref state after an ambiguous compare-and-swap, so do not retry or mutate the board.",
    "Before recovery, prove this helper and its credential cannot resume or complete a delayed write.",
    "An operator must read the ref and board state, then compare-and-swap an observed candidate LOCK to an UNLOCK child only when that exact LOCK is present and the board is safe.",
    "Do not delete or force-update the mutex ref.",
  ].join(" ");
}

function unlockFailureRecoveryText(lease, unknown) {
  const candidate = lease.candidateUnlock;
  return [
    unknown
      ? `Persistent issue mutex ${lease.refName} has an unknown LOCK-to-UNLOCK outcome.`
      : `Persistent issue mutex ${lease.refName} did not confirm its LOCK-to-UNLOCK transition.`,
    `Candidate UNLOCK ${candidate.oid} has payload ${JSON.stringify(candidate.payload)}.`,
    `Its parent is LOCK ${lease.lockOid}.`,
    "Do not retry the lifecycle command or create another UNLOCK from an assumed ref state.",
    "Before recovery, prove this helper and its credential cannot resume or complete a delayed write.",
    "An operator must read the ref and board state first. If the exact LOCK is still present and the board is safe, compare-and-swap that LOCK to the recorded candidate UNLOCK. If another SHA is present, reconcile from that observed state.",
    "Do not delete or force-update the mutex ref.",
  ].join(" ");
}

function conflict(scope, refName, observed, reason, options = {}) {
  const actual = observed
    ? {
        oid: observed.oid,
        payload: observed.payload ?? null,
      }
    : null;
  return new IssueOwnershipConflictError(
    `Issue #${scope.issue} mutation mutex conflict at ${refName}: ${reason}`,
    { scope, refName, actual },
    options,
  );
}

function parseLockPayload(message, scope, refName, oid) {
  let payload;
  try {
    payload = JSON.parse(message);
  } catch (err) {
    throw conflict(
      scope,
      refName,
      { oid, payload: null },
      `commit ${oid} has an invalid JSON payload`,
      { cause: err },
    );
  }
  if (
    payload?.kind !== LOCK_KIND ||
    payload?.version !== LOCK_VERSION ||
    !["LOCK", "UNLOCK"].includes(payload?.state) ||
    !validRecordedScope(payload.scope, scope)
  ) {
    throw conflict(
      scope,
      refName,
      { oid, payload },
      `commit ${oid} is not a valid mutex state for this issue`,
    );
  }
  return payload;
}

async function readDefaultBranchCommit(options) {
  const { owner, name } = splitRepo(options.repo);
  const response = await ghGraphql(
    `query($owner:String!,$name:String!){
      repository(owner:$owner,name:$name){
        id
        defaultBranchRef {
          target {
            ... on Commit {
              oid
              tree { oid }
            }
          }
        }
      }
    }`,
    { owner, name },
  );
  const commit = response?.data?.repository?.defaultBranchRef?.target;
  if (!commit?.oid || !commit?.tree?.oid) {
    throw new Error(`Repository ${options.repo} has no default-branch commit`);
  }
  return {
    oid: commit.oid,
    treeOid: commit.tree.oid,
    repositoryId: response.data.repository.id,
  };
}

// GraphQL `repository.ref(qualifiedName:)` returns null for refs outside
// `refs/heads` and `refs/tags`, so the retained lock ref is read through the
// Git data REST API and its commit through GraphQL `repository.object`.
export async function readLockRef(
  options,
  refName,
  scope,
  { json = ghJson, graphql = ghGraphql } = {},
) {
  const matches = await json([
    "api",
    `repos/${options.repo}/git/matching-refs/${refName.slice("refs/".length)}`,
  ]);
  const match = (matches ?? []).find((entry) => entry?.ref === refName);
  if (!match) return null;
  const oid = match.object?.sha ?? null;
  const { owner, name } = splitRepo(options.repo);
  const response = oid
    ? await graphql(
        `
          query ($owner: String!, $name: String!, $oid: GitObjectID!) {
            repository(owner: $owner, name: $name) {
              id
              object(oid: $oid) {
                __typename
                oid
                ... on Commit {
                  message
                  tree {
                    oid
                  }
                }
              }
            }
          }
        `,
        { owner, name, oid },
      )
    : null;
  const target = response?.data?.repository?.object;
  if (
    match.object?.type !== "commit" ||
    target?.__typename !== "Commit" ||
    !target?.oid ||
    !target?.tree?.oid
  ) {
    throw conflict(
      scope,
      refName,
      { oid, payload: null },
      "the ref does not target a commit",
    );
  }
  return {
    oid: target.oid,
    treeOid: target.tree.oid,
    repositoryId: response.data.repository.id,
    payload: parseLockPayload(target.message, scope, refName, target.oid),
  };
}

async function createStateCommit(options, parent, payload, timestamp) {
  const response = await ghJson(
    [
      "api",
      "--method",
      "POST",
      `repos/${options.repo}/git/commits`,
      "-f",
      `message=${JSON.stringify(payload)}`,
      "-f",
      `tree=${parent.treeOid}`,
      "-f",
      `parents[]=${parent.oid}`,
      "-f",
      `author[name]=${LOCK_AUTHOR.name}`,
      "-f",
      `author[email]=${LOCK_AUTHOR.email}`,
      "-f",
      `author[date]=${timestamp}`,
      "-f",
      `committer[name]=${LOCK_AUTHOR.name}`,
      "-f",
      `committer[email]=${LOCK_AUTHOR.email}`,
      "-f",
      `committer[date]=${timestamp}`,
    ],
    { dryRun: options.dryRun, mutates: true },
  );
  if (!response?.sha)
    throw new Error("GitHub did not return a mutex commit SHA");
  return { oid: response.sha, treeOid: response.tree?.sha ?? parent.treeOid };
}

async function compareAndSwapLockRef(
  options,
  repositoryId,
  refName,
  beforeOid,
  afterOid,
) {
  const response = await ghGraphql(
    `mutation(
      $repository:ID!
      $name:GitRefname!
      $before:GitObjectID!
      $after:GitObjectID!
    ) {
      updateRefs(input:{
        repositoryId:$repository
        refUpdates:[{
          name:$name
          beforeOid:$before
          afterOid:$after
          force:false
        }]
      }) {
        clientMutationId
      }
    }`,
    {
      repository: repositoryId,
      name: refName,
      before: beforeOid,
      after: afterOid,
    },
    { dryRun: options.dryRun, mutates: true },
  );
  if (!options.dryRun && !response?.data?.updateRefs) {
    throw new Error("GitHub did not confirm the mutex ref compare-and-swap");
  }
}

function operationsFor(overrides = {}) {
  const ownerTargetGraphql =
    issueOwnerProofTestTransports.get(overrides) ?? ghGraphql;
  return {
    compareAndSwapLockRef:
      overrides.compareAndSwapLockRef ?? compareAndSwapLockRef,
    createStateCommit: overrides.createStateCommit ?? createStateCommit,
    readDefaultBranchCommit:
      overrides.readDefaultBranchCommit ?? readDefaultBranchCommit,
    readLockRef: overrides.readLockRef ?? readLockRef,
    readIssueOwnerTarget: (options, issueNumber) =>
      readIssueOwnerTarget(options, issueNumber, {
        graphql: ownerTargetGraphql,
      }),
    sleep: overrides.sleep ?? sleep,
  };
}

function basePayload(scope, state, operation, operationId, metadata) {
  const claimId = metadata.claimId ?? null;
  if (claimId != null) validateClaimId(claimId);
  return {
    kind: LOCK_KIND,
    version: LOCK_VERSION,
    state,
    scope,
    operation,
    operationId,
    agent: metadata.agent ?? null,
    claimId,
    branch: metadata.branch ?? null,
    previousBranch: metadata.previousBranch ?? null,
    claimedAt: metadata.claimedAt ?? null,
    pr: metadata.pr ?? null,
    previousPr: metadata.previousPr ?? null,
  };
}

async function initializeLockRef(
  options,
  scope,
  refName,
  operations,
  operationId,
  timestamp,
) {
  let observed = await operations.readLockRef(options, refName, scope);
  if (observed) return observed;
  const base = await operations.readDefaultBranchCommit(options);
  const payload = {
    ...basePayload(scope, "UNLOCK", "initialize", operationId, {}),
    parentLock: null,
    completedAt: timestamp,
  };
  const initial = await operations.createStateCommit(
    options,
    base,
    payload,
    timestamp,
  );
  const expected = {
    ...initial,
    repositoryId: base.repositoryId,
    payload,
  };
  let lastError = null;
  for (let attempt = 1; attempt <= LOCK_RECONCILE_ATTEMPTS; attempt += 1) {
    try {
      await operations.compareAndSwapLockRef(
        options,
        base.repositoryId,
        refName,
        ZERO_OID,
        expected.oid,
      );
      return expected;
    } catch (err) {
      lastError = err;
    }
    const reconciliation = await reconcileLockRefRead(
      options,
      scope,
      refName,
      operations,
      lastError,
      "initialize",
      expected,
    );
    observed = reconciliation.observed;
    if (observed?.oid === expected.oid) return observed;
    if (observed?.payload?.state === "UNLOCK") return observed;
    if (observed) {
      throw conflict(
        scope,
        refName,
        observed,
        `initialize expected an absent ref or ${expected.oid}, but found ${observed.oid}`,
        { cause: lastError },
      );
    }
    if (attempt < LOCK_RECONCILE_ATTEMPTS) {
      await operations.sleep(LOCK_RECONCILE_DELAY_MS);
    }
  }
  throw new Error(
    `Issue #${scope.issue} mutex ref ${refName} read as absent after ${LOCK_RECONCILE_ATTEMPTS} create-from-absent compare-and-swap attempts; last compare-and-swap error: ${String(lastError?.message ?? lastError).split("\n")[0]}`,
    { cause: lastError },
  );
}

async function reconcileLockRefRead(
  options,
  scope,
  refName,
  operations,
  updateError,
  action,
  expected,
) {
  const readErrors = [];
  for (let attempt = 1; attempt <= LOCK_RECONCILE_ATTEMPTS; attempt += 1) {
    try {
      return {
        observed: await operations.readLockRef(options, refName, scope),
      };
    } catch (err) {
      readErrors.push(err);
      if (attempt < LOCK_RECONCILE_ATTEMPTS) {
        await operations.sleep(LOCK_RECONCILE_DELAY_MS);
      }
    }
  }
  const error = new Error(
    `Issue #${scope.issue} mutex ${action} outcome is unknown at ${refName}; candidate ${expected.payload?.state ?? "state"} ${expected.oid} has payload ${JSON.stringify(expected.payload ?? null)}`,
    {
      cause: new AggregateError(
        [updateError, ...readErrors],
        `Mutex ${action} compare-and-swap and reconciliation reads failed`,
      ),
    },
  );
  error.code = "ISSUE_MUTATION_LOCK_RECONCILIATION_UNKNOWN";
  throw error;
}

function unknownRefAdvanceError(
  scope,
  refName,
  action,
  parent,
  expected,
  updateError,
) {
  const error = new Error(
    `Issue #${scope.issue} mutex ${action} outcome is unknown at ${refName}; candidate ${expected.payload?.state ?? "state"} ${expected.oid} has payload ${JSON.stringify(expected.payload ?? null)}. The last reconciliation still reported parent ${parent.oid}; do not retry because the candidate update can still complete or already be hidden by a stale read.`,
    { cause: updateError },
  );
  error.code = "ISSUE_MUTATION_LOCK_RECONCILIATION_UNKNOWN";
  return error;
}

async function advanceRef(
  options,
  scope,
  refName,
  parent,
  expected,
  operations,
  action,
) {
  for (let attempt = 1; attempt <= LOCK_RECONCILE_ATTEMPTS; attempt += 1) {
    try {
      await operations.compareAndSwapLockRef(
        options,
        parent.repositoryId,
        refName,
        parent.oid,
        expected.oid,
      );
      return expected;
    } catch (lastError) {
      const { observed } = await reconcileLockRefRead(
        options,
        scope,
        refName,
        operations,
        lastError,
        action,
        expected,
      );
      if (observed?.oid === expected.oid) return observed;
      if (observed?.oid !== parent.oid) {
        throw conflict(
          scope,
          refName,
          observed,
          `${action} expected ${parent.oid} or ${expected.oid}, but found ${observed?.oid ?? "<absent>"}`,
          { cause: lastError },
        );
      }
      if (attempt >= LOCK_RECONCILE_ATTEMPTS) {
        throw unknownRefAdvanceError(
          scope,
          refName,
          action,
          parent,
          expected,
          lastError,
        );
      }
    }
    await operations.sleep(LOCK_RECONCILE_DELAY_MS);
  }
}

export async function acquireIssueMutationLock(
  options,
  issueNumber,
  metadata,
  overrides = {},
) {
  const operations = operationsFor(overrides);
  const scope = canonicalScope(options, issueNumber);
  const refName = issueMutationLockRef(options, issueNumber);
  const operationId = `lock-${randomUUID()}`;
  const timestamp = new Date().toISOString();
  const current = await initializeLockRef(
    options,
    scope,
    refName,
    operations,
    operationId,
    timestamp,
  );
  if (current.payload.state !== "UNLOCK") {
    throw conflict(
      scope,
      refName,
      current,
      `LOCK ${current.oid} is held by ${current.payload.operationId}; payload ${JSON.stringify(current.payload)}`,
    );
  }
  const preparedMetadata = overrides.prepareMetadata
    ? await overrides.prepareMetadata(metadata)
    : metadata;
  const payload = {
    ...basePayload(
      scope,
      "LOCK",
      preparedMetadata.operation,
      operationId,
      preparedMetadata,
    ),
    parentUnlock: current.oid,
    startedAt: timestamp,
  };
  const lock = await operations.createStateCommit(
    options,
    current,
    payload,
    timestamp,
  );
  lock.repositoryId = current.repositoryId;
  lock.payload = payload;
  const lease = {
    options,
    scope,
    projectId: preparedMetadata.projectId,
    refName,
    lockOid: lock.oid,
    treeOid: lock.treeOid,
    repositoryId: current.repositoryId,
    payload,
    operations,
    safeToUnlockAfterError: false,
    markSafeToUnlock(reason) {
      this.safeToUnlockAfterError = true;
      this.safeReason = reason;
    },
  };
  try {
    await advanceRef(
      options,
      scope,
      refName,
      current,
      lock,
      operations,
      "acquire",
    );
  } catch (err) {
    if (err?.code !== "ISSUE_MUTATION_LOCK_RECONCILIATION_UNKNOWN") {
      throw err;
    }
    throw new IssueMutationLockStaleError(
      `${err.message}\n${ambiguousAcquireRecoveryText(lease)}`,
      lease,
      { cause: err },
    );
  }
  return lease;
}

export async function releaseIssueMutationLock(lease) {
  const timestamp = new Date().toISOString();
  const operationId = `unlock-${randomUUID()}`;
  const payload = {
    ...basePayload(
      lease.scope,
      "UNLOCK",
      "complete",
      operationId,
      lease.payload,
    ),
    parentLock: lease.lockOid,
    completedAt: timestamp,
    outcome: lease.safeReason ?? "completed",
  };
  const parent = {
    oid: lease.lockOid,
    treeOid: lease.treeOid,
    repositoryId: lease.repositoryId,
  };
  const unlocked = await lease.operations.createStateCommit(
    lease.options,
    parent,
    payload,
    timestamp,
  );
  unlocked.repositoryId = lease.repositoryId;
  unlocked.payload = payload;
  lease.candidateUnlock = { oid: unlocked.oid, payload };
  try {
    await advanceRef(
      lease.options,
      lease.scope,
      lease.refName,
      parent,
      unlocked,
      lease.operations,
      "release",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unknown = err?.code === "ISSUE_MUTATION_LOCK_RECONCILIATION_UNKNOWN";
    throw new IssueMutationLockStaleError(
      `${message}\n${unlockFailureRecoveryText(lease, unknown)}`,
      lease,
      { cause: err },
    );
  }
  return unlocked;
}

function validateInitialOwnerTarget(issueNumber, metadata, target) {
  if (
    metadata.repositoryId != null &&
    target.repositoryId !== metadata.repositoryId
  ) {
    throw ownerTargetProofError(
      issueNumber,
      `proven repository ${target.repositoryId} does not match locked repository ${metadata.repositoryId}`,
      {
        expectedRepositoryId: metadata.repositoryId,
        actualRepositoryId: target.repositoryId,
      },
    );
  }
  if (target.projectId !== metadata.projectId) {
    throw ownerTargetProofError(
      issueNumber,
      `proven Project ${target.projectId} does not match selected Project ${metadata.projectId}`,
      {
        expectedProjectId: metadata.projectId,
        actualProjectId: target.projectId,
      },
    );
  }
  if (target.itemId == null && metadata.operation !== "claim") {
    throw ownerTargetProofError(
      issueNumber,
      `operation ${metadata.operation} requires one exact Project item`,
      { operation: metadata.operation },
    );
  }
  return target;
}

async function releaseAfterOwnerTargetProofFailure(lease, proofError) {
  lease.markSafeToUnlock("owner target proof rejected before board mutation");
  try {
    await releaseIssueMutationLock(lease);
  } catch (releaseError) {
    const proofMessage =
      proofError instanceof Error ? proofError.message : String(proofError);
    const releaseMessage =
      releaseError instanceof Error
        ? releaseError.message
        : String(releaseError);
    throw new IssueMutationLockStaleError(
      `${proofMessage}\nFailed to release the mutex after owner target proof rejection: ${releaseMessage}`,
      releaseError instanceof IssueMutationLockStaleError
        ? releaseError.lease
        : lease,
      { cause: new AggregateError([proofError, releaseError]) },
    );
  }
  throw proofError;
}

export async function withIssueMutationLock(
  options,
  issueNumber,
  metadata,
  mutation,
  overrides = {},
) {
  capabilityScope(options, issueNumber, metadata);
  if (options.dryRun) {
    const preparedMetadata = overrides.prepareMetadata
      ? await overrides.prepareMetadata(metadata)
      : metadata;
    const dryRunOperations = operationsFor(overrides);
    const target =
      OWNER_FIELDS_BY_OPERATION[preparedMetadata.operation]?.length > 0
        ? validateInitialOwnerTarget(
            issueNumber,
            preparedMetadata,
            await dryRunOperations.readIssueOwnerTarget(options, issueNumber),
          )
        : null;
    const capability = mintIssueOwnerCapability(
      options,
      issueNumber,
      preparedMetadata,
      { dryRun: true, target },
    );
    const lease = {
      dryRun: true,
      markSafeToUnlock() {},
    };
    let result;
    let mutationFailed = false;
    let mutationError;
    try {
      result = await mutation(lease, capability);
    } catch (err) {
      mutationFailed = true;
      mutationError = err;
    }
    const closure = await sealAndDrainIssueOwnerCapability(capability);
    const unpropagatedFailures = unpropagatedOwnerFailures(
      closure,
      mutationFailed,
      mutationError,
    );
    if (
      closure.pendingAtSettlement.length > 0 ||
      unpropagatedFailures.length > 0
    ) {
      const errors = closureCauses(closure, mutationFailed, mutationError);
      const closureMessages = [];
      if (closure.pendingAtSettlement.length > 0) {
        closureMessages.push(
          `${closure.pendingAtSettlement.length} pending owner-field mutation promise(s)`,
        );
      }
      if (unpropagatedFailures.length > 0) {
        closureMessages.push(
          `${unpropagatedFailures.length} settled owner-field mutation failure(s) that did not propagate through the callback rejection`,
        );
      }
      const programmingError = new IssueOwnerMutationCapabilityError(
        `Issue #${issueNumber} dry-run callback settled with ${closureMessages.join(" and ")}; every owner-field mutation must settle and every failure must propagate through the callback rejection before the callback returns`,
        {
          issue: issueNumber,
          pendingWrites: closure.pendingAtSettlement.length,
          settledFailures: closure.settledFailures.length,
          unpropagatedFailures: unpropagatedFailures.length,
        },
        errors.length > 0
          ? {
              cause: new AggregateError(
                errors,
                "Dry-run callback and owner-field mutation failures",
              ),
            }
          : {},
      );
      programmingError.programmingError = true;
      throw programmingError;
    }
    if (mutationFailed) throw mutationError;
    return result;
  }
  const lockOverrides = overrides.prepareMetadata
    ? cloneOperationsWithTestTransport(overrides, {
        prepareMetadata: async (lockMetadata) => {
          const preparedMetadata =
            await overrides.prepareMetadata(lockMetadata);
          capabilityScope(options, issueNumber, preparedMetadata);
          return preparedMetadata;
        },
      })
    : overrides;
  const lease = await acquireIssueMutationLock(
    options,
    issueNumber,
    metadata,
    lockOverrides,
  );
  let target = null;
  if (OWNER_FIELDS_BY_OPERATION[lease.payload.operation]?.length > 0) {
    try {
      target = validateInitialOwnerTarget(
        issueNumber,
        {
          operation: lease.payload.operation,
          projectId: lease.projectId,
          repositoryId: lease.repositoryId,
        },
        await lease.operations.readIssueOwnerTarget(options, issueNumber),
      );
    } catch (proofError) {
      await releaseAfterOwnerTargetProofFailure(lease, proofError);
    }
  }
  const capability = mintIssueOwnerCapability(
    options,
    issueNumber,
    {
      ...metadata,
      operation: lease.payload.operation,
      projectId: lease.projectId,
    },
    {
      target,
      refreshTarget:
        lease.payload.operation === "claim"
          ? async () =>
              validateInitialOwnerTarget(
                issueNumber,
                {
                  operation: lease.payload.operation,
                  projectId: lease.projectId,
                  repositoryId: lease.repositoryId,
                },
                await lease.operations.readIssueOwnerTarget(
                  options,
                  issueNumber,
                ),
              )
          : null,
    },
  );
  let result;
  let mutationFailed = false;
  let mutationError;
  try {
    result = await mutation(lease, capability);
  } catch (err) {
    mutationFailed = true;
    mutationError = err;
  }
  const closure = await sealAndDrainIssueOwnerCapability(capability);
  const unpropagatedFailures = unpropagatedOwnerFailures(
    closure,
    mutationFailed,
    mutationError,
  );
  if (
    closure.pendingAtSettlement.length > 0 ||
    unpropagatedFailures.length > 0
  ) {
    const errors = closureCauses(closure, mutationFailed, mutationError);
    const closureMessages = [];
    if (closure.pendingAtSettlement.length > 0) {
      closureMessages.push(
        `Issue #${issueNumber} mutex callback settled with ${closure.pendingAtSettlement.length} pending owner-field mutation promise(s).`,
      );
    }
    if (unpropagatedFailures.length > 0) {
      closureMessages.push(
        `Issue #${issueNumber} mutex callback settled with ${unpropagatedFailures.length} owner-field mutation failure(s) that did not propagate through the callback rejection.`,
      );
    }
    const programmingError = new Error(
      `${closureMessages.join(" ")} Every owner-field mutation must settle and every failure must propagate through the callback rejection before the callback returns. The helper retained LOCK because the callback did not carry complete mutation-failure evidence.`,
      errors.length > 0
        ? {
            cause: new AggregateError(
              errors,
              "Callback and owner-field mutation failures",
            ),
          }
        : {},
    );
    programmingError.code =
      closure.pendingAtSettlement.length > 0
        ? "ISSUE_OWNER_MUTATION_PENDING"
        : "ISSUE_OWNER_MUTATION_UNPROPAGATED";
    programmingError.programmingError = true;
    throw new IssueMutationLockStaleError(
      `${programmingError.message}\n${lockRecoveryText(lease)}`,
      lease,
      { cause: programmingError },
    );
  }
  if (mutationFailed) {
    if (!lease.safeToUnlockAfterError) {
      const message =
        mutationError instanceof Error
          ? mutationError.message
          : String(mutationError);
      throw new IssueMutationLockStaleError(
        `${message}\n${lockRecoveryText(lease)}`,
        lease,
        { cause: mutationError },
      );
    }
    try {
      await releaseIssueMutationLock(lease);
    } catch (releaseError) {
      const message =
        mutationError instanceof Error
          ? mutationError.message
          : String(mutationError);
      const releaseMessage =
        releaseError instanceof Error
          ? releaseError.message
          : String(releaseError);
      if (releaseError instanceof IssueMutationLockStaleError) {
        throw new IssueMutationLockStaleError(
          `${message}\nFailed to release the restored mutex: ${releaseMessage}`,
          releaseError.lease,
          { cause: new AggregateError([mutationError, releaseError]) },
        );
      }
      throw new IssueMutationLockStaleError(
        `${message}\nFailed to release the restored mutex: ${releaseMessage}\n${lockRecoveryText(lease)}`,
        lease,
        { cause: new AggregateError([mutationError, releaseError]) },
      );
    }
    throw mutationError;
  }
  try {
    await releaseIssueMutationLock(lease);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof IssueMutationLockStaleError) {
      throw new IssueMutationLockStaleError(
        `Issue #${issueNumber} mutation completed, but its mutex release is unresolved: ${message}`,
        err.lease,
        { cause: err },
      );
    }
    throw new IssueMutationLockStaleError(
      `Issue #${issueNumber} mutation completed, but its mutex did not release: ${message}\n${lockRecoveryText(lease)}`,
      lease,
      { cause: err },
    );
  }
  return result;
}
