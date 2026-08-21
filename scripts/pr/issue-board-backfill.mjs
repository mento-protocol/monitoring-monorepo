/**
 * Fill missing Project ownership fields from trusted agent claim comments.
 *
 * This is deliberately a fill-only recovery path. It does not update Status
 * and it does not offer compare-and-swap semantics across GitHub surfaces.
 */

import {
  OPTIONAL_PROJECT_FIELDS,
  isBackfillable,
  labelNames,
  projectDateFieldValue,
} from "./issue-board-state.mjs";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const CLAIM_FIELDS = [
  OPTIONAL_PROJECT_FIELDS.claimId,
  OPTIONAL_PROJECT_FIELDS.agent,
  OPTIONAL_PROJECT_FIELDS.branch,
  OPTIONAL_PROJECT_FIELDS.claimedAt,
];
const MAX_AGENT_LENGTH = 120;
const MAX_CLAIM_ID_LENGTH = 160;
const MAX_BRANCH_LENGTH = 256;
const MAX_COMMENT_ID_LENGTH = 512;

function claimFields(metadata) {
  return CLAIM_FIELDS.filter(
    (field) =>
      field !== OPTIONAL_PROJECT_FIELDS.branch || metadata[field] != null,
  );
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function isSafeSingleLineText(value, maxLength) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

function isValidIsoTimestamp(value) {
  const match = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] =
    match.map((part) => (part === undefined ? undefined : Number(part)));
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (offsetHour !== undefined && (offsetHour > 23 || offsetMinute > 59))
  ) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth && Number.isFinite(Date.parse(value));
}

function isBoundedCloudHandoff(lines) {
  const handoff = [...lines];
  while (handoff[handoff.length - 1] === "") handoff.pop();
  return (
    handoff.length <= 4 &&
    handoff.join("\n").length <= 1000 &&
    handoff.every(
      (line) =>
        isSafeSingleLineText(line, 1000) &&
        !/^(Claim ID|Branch|Claimed at):/.test(line),
    )
  );
}

export function parseClaimComment(comment, issueNumber) {
  if (!TRUSTED_ASSOCIATIONS.has(comment?.authorAssociation)) return null;
  if (
    !isSafeSingleLineText(comment?.id, MAX_COMMENT_ID_LENGTH) ||
    !isValidIsoTimestamp(comment?.createdAt)
  ) {
    return null;
  }
  const lines = String(comment.body ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const first = lines.shift();
  const match = first?.match(
    /^Agent claim: (.+) claimed #(\d+) for implementation\.$/,
  );
  if (
    !match ||
    Number(match[2]) !== issueNumber ||
    !match[1].trim() ||
    !isSafeSingleLineText(match[1], MAX_AGENT_LENGTH)
  )
    return null;

  const values = new Map();
  let index = 0;
  while (index < lines.length && lines[index] === "") index += 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const field = line.match(/^(Claim ID|Branch|Claimed at):\s*(.*)$/);
    if (!field) break;
    if (values.has(field[1]) || !field[2]) return null;
    values.set(field[1], field[2]);
  }
  while (index < lines.length && lines[index] === "") index += 1;
  if (!isBoundedCloudHandoff(lines.slice(index))) return null;

  const claimId = values.get("Claim ID");
  const branch = values.get("Branch");
  const claimedAt = values.get("Claimed at");
  if (
    !isSafeSingleLineText(claimId, MAX_CLAIM_ID_LENGTH) ||
    (branch !== undefined &&
      !isSafeSingleLineText(branch, MAX_BRANCH_LENGTH)) ||
    !isValidIsoTimestamp(claimedAt)
  ) {
    return null;
  }
  return {
    id: String(comment.id),
    createdAt: comment.createdAt,
    claimedAt,
    branch: branch ?? null,
    metadata: {
      [OPTIONAL_PROJECT_FIELDS.agent]: match[1],
      [OPTIONAL_PROJECT_FIELDS.claimId]: claimId,
      ...(branch === undefined
        ? {}
        : { [OPTIONAL_PROJECT_FIELDS.branch]: branch }),
      [OPTIONAL_PROJECT_FIELDS.claimedAt]: projectDateFieldValue(claimedAt),
    },
  };
}

function claimMetadataFingerprint(claim) {
  return JSON.stringify({
    branch: claim.branch,
    claimedAt: claim.claimedAt,
    metadata: claim.metadata,
  });
}

export function selectNewestTrustedClaim(comments, issueNumber) {
  const valid = (comments ?? [])
    .map((comment) => parseClaimComment(comment, issueNumber))
    .filter(Boolean);
  if (valid.length === 0) return null;
  const newestTime = Math.max(
    ...valid.map((claim) => Date.parse(claim.createdAt)),
  );
  const newest = valid.filter(
    (claim) => Date.parse(claim.createdAt) === newestTime,
  );
  const metadata = claimMetadataFingerprint(newest[0]);
  if (newest.some((claim) => claimMetadataFingerprint(claim) !== metadata)) {
    throw new Error(
      `Issue #${issueNumber} has ambiguous trusted claims at the newest timestamp`,
    );
  }
  // IDs do not establish chronology. At one timestamp with identical metadata,
  // use one ID only to make the collapsed representation stable across pages.
  newest.sort((left, right) => left.id.localeCompare(right.id));
  return newest[0];
}

export function buildBackfillPlan(values, metadata) {
  const writes = [];
  for (const field of claimFields(metadata)) {
    const current = values[field];
    const expected = metadata[field];
    if (current == null || current === "") {
      writes.push({ field, value: expected });
    } else if (current !== expected) {
      throw new Error(
        `Project ${field} conflicts: ${current} does not match trusted claim ${expected}`,
      );
    }
  }
  return writes;
}

function issueFingerprint(issue) {
  return JSON.stringify({
    state: issue.state,
    labels: [...labelNames(issue)].sort(),
  });
}

function backfillFieldFingerprint(fields) {
  return Object.fromEntries(
    Object.entries(fields)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, field]) => [
        name,
        { id: field.id, dataType: field.dataType },
      ]),
  );
}

function backfillValuesFingerprint(values) {
  return JSON.stringify(
    Object.fromEntries(
      CLAIM_FIELDS.map((field) => [field, values[field] ?? null]),
    ),
  );
}

function snapshotIdentity(snapshot) {
  return {
    issue: issueFingerprint(snapshot.issue),
    project: {
      id: snapshot.project.id,
      fields: backfillFieldFingerprint(snapshot.fields),
    },
    itemId: snapshot.itemId,
    claim: snapshot.claim
      ? {
          id: snapshot.claim.id,
          createdAt: snapshot.claim.createdAt,
          claimedAt: snapshot.claim.claimedAt,
          branch: snapshot.claim.branch,
          metadata: snapshot.claim.metadata,
        }
      : null,
  };
}

function snapshotIdentityFingerprint(snapshot) {
  return JSON.stringify(snapshotIdentity(snapshot));
}

function snapshotFingerprint(snapshot) {
  return JSON.stringify({
    ...snapshotIdentity(snapshot),
    values: backfillValuesFingerprint(snapshot.values),
  });
}

function hasExpectedValues(snapshot, expectedValues) {
  return (
    backfillValuesFingerprint(snapshot.values) ===
    backfillValuesFingerprint(expectedValues)
  );
}

function assertSnapshotMatches(
  expectedIdentity,
  expectedValues,
  snapshot,
  issueNumber,
) {
  if (
    snapshotIdentityFingerprint(snapshot) !== expectedIdentity ||
    !hasExpectedValues(snapshot, expectedValues)
  ) {
    throw new Error(`Issue #${issueNumber} changed before backfill write`);
  }
}

async function readSnapshot(options, dependencies) {
  const issue = await dependencies.getIssue(options, options.issues[0]);
  if (!isBackfillable(issue)) {
    throw new Error(
      `Issue #${issue.number} is not backfillable; expected open with exactly one of agent-active/in-pr`,
    );
  }
  const project = await dependencies.getProject(options);
  const fields = dependencies.requireBackfillFields(project);
  const itemId = await dependencies.findIssueProjectItem(
    options,
    issue,
    project,
  );
  if (!itemId) {
    throw new Error(
      `Issue #${issue.number} is not on Project ${project.title}`,
    );
  }
  const [comments, values] = await Promise.all([
    dependencies.listIssueComments(options, issue.number),
    dependencies.readBackfillProjectFields(options, project, itemId),
  ]);
  const claim = selectNewestTrustedClaim(comments, issue.number);
  if (!claim) {
    throw new Error(
      `Issue #${issue.number} has no valid trusted agent claim comment`,
    );
  }
  return { issue, project, fields, itemId, claim, values };
}

export async function backfillIssue(options, dependencies) {
  const initial = await readSnapshot(options, dependencies);
  if (options.dryRun) {
    const writes = buildBackfillPlan(initial.values, initial.claim.metadata);
    return {
      number: initial.issue.number,
      title: initial.issue.title,
      state: "backfill dry-run",
      writes,
    };
  }

  const beforeWrite = await readSnapshot(options, dependencies);
  if (snapshotFingerprint(initial) !== snapshotFingerprint(beforeWrite)) {
    throw new Error(
      `Issue #${initial.issue.number} changed before backfill write`,
    );
  }
  const writes = buildBackfillPlan(
    beforeWrite.values,
    beforeWrite.claim.metadata,
  );
  const expectedIdentity = snapshotIdentityFingerprint(beforeWrite);
  const expectedValues = { ...beforeWrite.values };
  for (const write of writes) {
    const current = await readSnapshot(options, dependencies);
    assertSnapshotMatches(
      expectedIdentity,
      expectedValues,
      current,
      beforeWrite.issue.number,
    );
    const currentPlan = buildBackfillPlan(
      current.values,
      current.claim.metadata,
    );
    if (
      !currentPlan.some(
        (candidate) =>
          candidate.field === write.field && candidate.value === write.value,
      )
    ) {
      throw new Error(
        `Issue #${beforeWrite.issue.number} changed before backfill write`,
      );
    }
    await dependencies.writeBackfillProjectFields(
      options,
      current.project,
      current.itemId,
      [write],
    );
    expectedValues[write.field] = write.value;
  }
  const verified = await readSnapshot(options, dependencies);
  if (
    snapshotIdentityFingerprint(verified) !== expectedIdentity ||
    !hasExpectedValues(verified, expectedValues)
  ) {
    throw new Error(
      `Issue #${beforeWrite.issue.number} backfill verification failed`,
    );
  }
  return {
    number: verified.issue.number,
    title: verified.issue.title,
    state: writes.length === 0 ? "backfill already matched" : "backfilled",
    writes,
  };
}
