import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  LEGACY_LIFECYCLE_CONTRACT,
  LEGACY_STATE_SCHEMA,
  RUN_TOKEN,
  upgradeLegacyStateForSettlement,
  validateState,
} from "./darwin-process-lineage-model.mjs";

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSITION_BYTES = MAX_STATE_BYTES * 3 + 64 * 1024;
const TRANSITION_SCHEMA = "agentqg-darwin-lineage-transition-v1";
const DISCARD_SCHEMA = "agentqg-darwin-lineage-discard-v1";
const TRANSITION_ATTEMPTS = 3;
const MAX_TRANSITION_DIRECTORY_ENTRIES = 16_384;

class DarwinStableReadContentionError extends Error {
  constructor(message, { retryWithinTransition = true } = {}) {
    super(message);
    this.name = "DarwinStableReadContentionError";
    this.retryWithinTransition = retryWithinTransition;
  }
}

function fail(message) {
  throw new Error(message);
}

function currentUid() {
  if (typeof process.getuid !== "function") fail("current UID is unavailable");
  return process.getuid();
}

function validateDirectory(path, label) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o7022) !== 0
  ) {
    fail(`${label} is not a current-user real directory`);
  }
  return stat;
}

function validateStatePath(path, token) {
  if (typeof path !== "string" || basename(path) !== `lineage.${token}.json`) {
    fail("Darwin lineage state path does not match its token");
  }
  validateDirectory(dirname(path), "Darwin lineage state directory");
}

function tokenFromStatePath(path) {
  const match = /^lineage\.(.+)\.json$/u.exec(basename(path));
  if (!match || !RUN_TOKEN.test(match[1])) {
    fail("Darwin lineage state path has no valid token");
  }
  return match[1];
}

const sameFileIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino;
const fileMode = (stat) => Number(stat.mode & 0o7777n);

function readStableFile(
  path,
  label,
  {
    maximumBytes = MAX_STATE_BYTES,
    expectedModes = [0o600],
    expectedLinkCounts = [1, 2],
    afterRead = () => {},
    pathReplacementIsContention = false,
    linkCountIsContention = false,
  } = {},
) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor, { bigint: true });
    let pathBefore;
    try {
      pathBefore = lstatSync(path, { bigint: true });
    } catch (error) {
      if (pathReplacementIsContention && error?.code === "ENOENT") {
        throw new DarwinStableReadContentionError(
          `${label} was removed before its stable read`,
        );
      }
      throw error;
    }
    if (
      !before.isFile() ||
      !pathBefore.isFile() ||
      before.uid !== BigInt(currentUid()) ||
      before.size > BigInt(maximumBytes) ||
      !expectedModes.includes(fileMode(before)) ||
      !expectedModes.includes(fileMode(pathBefore))
    ) {
      fail(`${label} is unsafe`);
    }
    if (!sameFileIdentity(before, pathBefore)) {
      if (pathReplacementIsContention) {
        throw new DarwinStableReadContentionError(
          `${label} was replaced before its stable read`,
        );
      }
      fail(`${label} is unsafe`);
    }
    if (!expectedLinkCounts.includes(Number(before.nlink))) {
      if (linkCountIsContention) {
        throw new DarwinStableReadContentionError(
          `${label} acquired another transition link`,
          { retryWithinTransition: false },
        );
      }
      fail(`${label} is unsafe`);
    }
    const bytes = readFileSync(descriptor);
    afterRead({ bytes, stat: before });
    const after = fstatSync(descriptor, { bigint: true });
    let pathAfter;
    try {
      pathAfter = lstatSync(path, { bigint: true });
    } catch (error) {
      if (pathReplacementIsContention && error?.code === "ENOENT") {
        throw new DarwinStableReadContentionError(
          `${label} was removed while read`,
        );
      }
      throw error;
    }
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(before, pathAfter) ||
      before.size !== after.size ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs ||
      fileMode(before) !== fileMode(after) ||
      BigInt(bytes.length) !== after.size
    ) {
      throw new DarwinStableReadContentionError(`${label} changed while read`);
    }
    return { bytes, stat: after };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

const readStateValue = (path) =>
  parseJsonBytes(
    readStableFile(path, "Darwin lineage state file").bytes,
    "Darwin lineage state file",
  );
const readState = (path, expectedToken = tokenFromStatePath(path)) =>
  validateState(readStateValue(path), expectedToken);

function serializedState(state) {
  const bytes = Buffer.from(
    `${JSON.stringify(validateState(state, state.token))}\n`,
    "utf8",
  );
  if (bytes.length > MAX_STATE_BYTES) fail("Darwin lineage state is too large");
  return bytes;
}

function serializedJson(value, maximumBytes, label) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.length > maximumBytes) fail(`${label} is too large`);
  return bytes;
}

function fsyncDirectory(path) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function createState(path, state) {
  validateStatePath(path, state.token);
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, serializedState(state));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

class DarwinTransitionConflictError extends Error {
  constructor(message, { retryWithinTransition = true } = {}) {
    super(message);
    this.name = "DarwinTransitionConflictError";
    this.retryWithinTransition = retryWithinTransition;
  }
}

function transitionConflict(message, options) {
  throw new DarwinTransitionConflictError(message, options);
}

function revisionNumber(value, label, { allowLegacy = false } = {}) {
  if (allowLegacy && value === -1) return -1;
  if (!Number.isInteger(value) || value < 0 || value > 4_294_967_295) {
    fail(`${label} is not a uint32 revision`);
  }
  return value;
}

function exactObjectKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    fail(`${label} has an unsupported shape`);
  }
}

const jsonValuesEqual = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

function validateDiscardTombstone(value, expectedToken = "") {
  exactObjectKeys(
    value,
    ["expectedRevision", "nextRevision", "schema", "settledState", "token"],
    "Darwin lineage discard tombstone",
  );
  if (value.schema !== DISCARD_SCHEMA) {
    fail("Darwin lineage discard tombstone schema is unsupported");
  }
  if (
    typeof value.token !== "string" ||
    !RUN_TOKEN.test(value.token) ||
    (expectedToken && value.token !== expectedToken)
  ) {
    fail("Darwin lineage discard tombstone token is malformed");
  }
  const settledState = validateState(value.settledState, value.token);
  const expectedRevision = revisionNumber(
    value.expectedRevision,
    "Darwin lineage discard expected revision",
  );
  const nextRevision = revisionNumber(
    value.nextRevision,
    "Darwin lineage discard next revision",
  );
  if (
    settledState.revision !== expectedRevision ||
    expectedRevision === 4_294_967_295 ||
    nextRevision !== expectedRevision + 1 ||
    settledState.settledAt === null ||
    settledState.settledReason === null
  ) {
    fail("Darwin lineage discard tombstone is out of sequence");
  }
  return {
    schema: DISCARD_SCHEMA,
    token: value.token,
    expectedRevision,
    nextRevision,
    settledState,
  };
}

function normalizeTransitionExpected(value, token, expectedRevision) {
  if (expectedRevision === -1) {
    upgradeLegacyStateForSettlement(value, token);
    return value;
  }
  const state = validateState(value, token);
  if (state.revision !== expectedRevision) {
    fail("Darwin lineage transition expected state has the wrong revision");
  }
  return state;
}

function validateTransitionPlan(value, expectedToken = "") {
  exactObjectKeys(
    value,
    [
      "expectedRevision",
      "expectedState",
      "nextRevision",
      "operation",
      "schema",
      "target",
      "token",
    ],
    "Darwin lineage transition plan",
  );
  if (value.schema !== TRANSITION_SCHEMA) {
    fail("Darwin lineage transition plan schema is unsupported");
  }
  if (
    typeof value.token !== "string" ||
    !RUN_TOKEN.test(value.token) ||
    (expectedToken && value.token !== expectedToken)
  ) {
    fail("Darwin lineage transition plan token is malformed");
  }
  if (!["replace", "discard"].includes(value.operation)) {
    fail("Darwin lineage transition operation is unsupported");
  }
  const expectedRevision = revisionNumber(
    value.expectedRevision,
    "Darwin lineage transition expected revision",
    { allowLegacy: true },
  );
  const nextRevision = revisionNumber(
    value.nextRevision,
    "Darwin lineage transition next revision",
  );
  if (
    expectedRevision === 4_294_967_295 ||
    nextRevision !== expectedRevision + 1
  ) {
    fail("Darwin lineage transition revisions are out of sequence");
  }
  const expectedState = normalizeTransitionExpected(
    value.expectedState,
    value.token,
    expectedRevision,
  );
  let target;
  if (value.operation === "replace") {
    target = validateState(value.target, value.token);
    if (target.revision !== nextRevision) {
      fail("Darwin lineage replacement has the wrong next revision");
    }
    if (expectedRevision === -1) {
      const upgraded = upgradeLegacyStateForSettlement(
        expectedState,
        value.token,
      );
      if (!jsonValuesEqual(target, upgraded)) {
        fail("Darwin lineage legacy upgrade target is not exact");
      }
    }
  } else {
    if (expectedRevision === -1) {
      fail("a legacy Darwin lineage cannot be discarded without migration");
    }
    target = validateDiscardTombstone(value.target, value.token);
    if (
      target.expectedRevision !== expectedRevision ||
      target.nextRevision !== nextRevision ||
      !jsonValuesEqual(target.settledState, expectedState)
    ) {
      fail("Darwin lineage discard target does not match its expected state");
    }
  }
  return {
    schema: TRANSITION_SCHEMA,
    token: value.token,
    operation: value.operation,
    expectedRevision,
    nextRevision,
    expectedState,
    target,
  };
}

function transitionPaths(path, nextRevision) {
  const prefix = join(
    dirname(path),
    `.${basename(path)}.transition-${nextRevision}`,
  );
  return {
    claim: `${prefix}.claim`,
    current: `${prefix}.current`,
    payload: `${prefix}.payload`,
    ready: `${prefix}.ready`,
  };
}

function serializedTransitionPlan(plan) {
  return serializedJson(
    validateTransitionPlan(plan, plan.token),
    MAX_TRANSITION_BYTES,
    "Darwin lineage transition plan",
  );
}

function serializedTransitionTarget(plan) {
  return plan.operation === "replace"
    ? serializedState(plan.target)
    : serializedJson(
        validateDiscardTombstone(plan.target, plan.token),
        MAX_TRANSITION_BYTES,
        "Darwin lineage discard tombstone",
      );
}

function publishExclusiveLinkedFile(path, bytes, mode, label) {
  const directory = dirname(path);
  validateDirectory(directory, `${label} directory`);
  const staged = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.staging`,
  );
  let descriptor;
  let stagedStat;
  let created = false;
  try {
    descriptor = openSync(
      staged,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    stagedStat = fstatSync(descriptor, { bigint: true });
    fchmodSync(descriptor, mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const writtenStat = fstatSync(descriptor, { bigint: true });
    const stagedPathStat = lstatSync(staged, { bigint: true });
    if (
      !writtenStat.isFile() ||
      writtenStat.uid !== BigInt(currentUid()) ||
      writtenStat.size !== BigInt(bytes.length) ||
      fileMode(writtenStat) !== mode ||
      !sameFileIdentity(stagedStat, writtenStat) ||
      !sameFileIdentity(writtenStat, stagedPathStat)
    ) {
      fail(`${label} staging file is unsafe`);
    }
    try {
      linkSync(staged, path);
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (created) {
      const published = lstatSync(path, { bigint: true });
      if (!published.isFile() || !sameFileIdentity(writtenStat, published)) {
        fail(`${label} link did not publish the staged inode`);
      }
      fsyncDirectory(directory);
    }
  } finally {
    if (stagedStat !== undefined) {
      const current = lstatSync(staged, { bigint: true });
      if (!sameFileIdentity(stagedStat, current)) {
        fail(`${label} staging path changed before cleanup`);
      }
      unlinkSync(staged);
      fsyncDirectory(directory);
    }
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return created;
}

function readTransitionPlanSnapshot(path, token, expectedNextRevision) {
  const snapshot = readStableFile(path, "Darwin lineage transition claim", {
    maximumBytes: MAX_TRANSITION_BYTES,
    expectedModes: [0o400],
    expectedLinkCounts: [1, 2],
  });
  const plan = validateTransitionPlan(
    parseJsonBytes(snapshot.bytes, "Darwin lineage transition claim"),
    token,
  );
  if (plan.nextRevision !== expectedNextRevision) {
    fail("Darwin lineage transition claim is in the wrong revision slot");
  }
  return { plan, stat: snapshot.stat };
}

const readTransitionPlan = (path, token, expectedNextRevision) =>
  readTransitionPlanSnapshot(path, token, expectedNextRevision).plan;

const readPlanForTransition = (paths, plan) =>
  readTransitionPlan(paths.claim, plan.token, plan.nextRevision);

function readPlanForReadiness(paths, plan) {
  const snapshot = readTransitionPlanSnapshot(
    paths.claim,
    plan.token,
    plan.nextRevision,
  );
  if (snapshot.stat.nlink !== 1n) {
    transitionConflict(
      "Darwin lineage transition claim staging is still in progress",
    );
  }
  return snapshot.plan;
}

function readTransitionTarget(path, plan) {
  const { bytes } = readStableFile(path, "Darwin lineage transition payload", {
    maximumBytes: MAX_TRANSITION_BYTES,
    expectedModes: [0o600],
    expectedLinkCounts: [1, 2],
  });
  const expected = serializedTransitionTarget(plan);
  if (!bytes.equals(expected)) {
    fail("Darwin lineage transition payload does not match its plan");
  }
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function readCanonicalTransitionValue(
  path,
  afterRead = () => {},
  { expectedLinkCounts = [1, 2] } = {},
) {
  try {
    const { bytes, stat } = readStableFile(
      path,
      "Darwin lineage transition current state",
      {
        maximumBytes: MAX_TRANSITION_BYTES,
        expectedModes: [0o600],
        expectedLinkCounts,
        afterRead,
      },
    );
    return {
      value: parseJsonBytes(bytes, "Darwin lineage transition current state"),
      stat,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function transitionValueKind(value, plan) {
  if (plan.operation === "replace") {
    try {
      const target = validateState(value, plan.token);
      if (jsonValuesEqual(target, plan.target)) return "target";
    } catch {
      // The exact expected-state check below owns legacy and prior revisions.
    }
  } else {
    try {
      const target = validateDiscardTombstone(value, plan.token);
      if (jsonValuesEqual(target, plan.target)) return "target";
    } catch {
      // The exact expected-state check below owns a settled v4 state.
    }
  }
  try {
    const expected = normalizeTransitionExpected(
      value,
      plan.token,
      plan.expectedRevision,
    );
    if (jsonValuesEqual(expected, plan.expectedState)) return "expected";
  } catch {
    // A malformed or out-of-sequence canonical value fails closed below.
  }
  return "foreign";
}

function isAdvancedTransitionValue(value, plan) {
  try {
    const state = validateState(value, plan.token);
    return state.revision > plan.expectedRevision;
  } catch {
    // A discard tombstone is the only other valid advanced canonical value.
  }
  try {
    const tombstone = validateDiscardTombstone(value, plan.token);
    return tombstone.nextRevision > plan.expectedRevision;
  } catch {
    return false;
  }
}

function canonicalCurrentSlotLimit(value, token) {
  try {
    const state = validateState(value, token);
    return Math.min(state.revision + 1, 4_294_967_295);
  } catch {
    return validateDiscardTombstone(value, token).nextRevision;
  }
}

function validateCanonicalCurrentLinks(
  path,
  requiredCurrentPath,
  canonicalStat,
  canonicalValue,
  token,
) {
  const directory = dirname(path);
  const prefix = `.${basename(path)}.transition-`;
  const suffix = ".current";
  const linkedCurrents = [];
  const entries = readdirSync(directory);
  if (entries.length > MAX_TRANSITION_DIRECTORY_ENTRIES) {
    fail("Darwin lineage transition directory is too large to prove");
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const revisionText = name.slice(prefix.length, -suffix.length);
    if (!/^(0|[1-9]\d*)$/u.test(revisionText)) continue;
    const revision = Number(revisionText);
    if (!Number.isSafeInteger(revision) || revision > 4_294_967_295) continue;
    const currentPath = join(directory, name);
    let current;
    try {
      current = lstatSync(currentPath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new DarwinStableReadContentionError(
          "Darwin lineage canonical current links changed during proof",
        );
      }
      throw error;
    }
    if (!sameFileIdentity(canonicalStat, current)) continue;
    if (
      !current.isFile() ||
      current.uid !== BigInt(currentUid()) ||
      fileMode(current) !== 0o600
    ) {
      fail("Darwin lineage canonical current link topology is unsafe");
    }
    linkedCurrents.push({ path: currentPath, revision });
  }
  if (
    linkedCurrents.length !== Number(canonicalStat.nlink) - 1 ||
    !linkedCurrents.some((current) => current.path === requiredCurrentPath)
  ) {
    fail("Darwin lineage canonical current link topology is unsafe");
  }
  const slotLimit = canonicalCurrentSlotLimit(canonicalValue, token);
  if (linkedCurrents.some((current) => current.revision > slotLimit)) {
    fail("Darwin lineage canonical current link revision is unsafe");
  }
}

function validateClaimedCurrent(
  paths,
  plan,
  expectedCanonicalStat = null,
  { boundary = () => {}, created = false } = {},
) {
  const { bytes, stat } = readStableFile(
    paths.current,
    "Darwin lineage claimed current state",
    {
      maximumBytes: MAX_TRANSITION_BYTES,
      expectedModes: [0o600],
      expectedLinkCounts: [1, 2],
      afterRead: () => boundary("during-current-claim-read"),
      pathReplacementIsContention: true,
      linkCountIsContention: created,
    },
  );
  const value = parseJsonBytes(bytes, "Darwin lineage claimed current state");
  if (transitionValueKind(value, plan) !== "expected") {
    if (isAdvancedTransitionValue(value, plan)) {
      transitionConflict(
        "Darwin lineage canonical state advanced before its current-state claim",
      );
    }
    fail("Darwin lineage claim does not bind its exact expected state");
  }
  if (
    expectedCanonicalStat !== null &&
    !sameFileIdentity(stat, expectedCanonicalStat)
  ) {
    transitionConflict(
      "Darwin lineage canonical inode advanced before its current-state claim",
    );
  }
  return stat;
}

function validateReadyLink(paths) {
  const claim = lstatSync(paths.claim, { bigint: true });
  const ready = lstatSync(paths.ready, { bigint: true });
  if (
    !claim.isFile() ||
    !ready.isFile() ||
    claim.uid !== BigInt(currentUid()) ||
    fileMode(claim) !== 0o400 ||
    fileMode(ready) !== 0o400 ||
    claim.nlink !== 2n ||
    ready.nlink !== 2n ||
    !sameFileIdentity(claim, ready)
  ) {
    fail("Darwin lineage transition ready link is foreign");
  }
}

function canonicalHasExactTransitionTarget(path, plan, boundary = () => {}) {
  for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt += 1) {
    try {
      const current = readCanonicalTransitionValue(path, () =>
        boundary("during-canonical-target-read"),
      );
      return (
        current !== null &&
        transitionValueKind(current.value, plan) === "target"
      );
    } catch (error) {
      if (
        !(error instanceof DarwinStableReadContentionError) ||
        attempt + 1 === TRANSITION_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
  return false;
}

function artifactStepOrPublishedTarget(
  path,
  plan,
  operation,
  boundary = () => {},
) {
  try {
    operation();
    return false;
  } catch (error) {
    if (canonicalHasExactTransitionTarget(path, plan, boundary)) return true;
    throw error;
  }
}

function ensureTransitionPayload(path, paths, plan, boundary) {
  if (pathEntryExists(paths.ready)) {
    if (
      artifactStepOrPublishedTarget(
        path,
        plan,
        () => validateReadyLink(paths),
        boundary,
      )
    ) {
      return true;
    }
    boundary("after-ready-validation");
    if (
      artifactStepOrPublishedTarget(
        path,
        plan,
        () => readTransitionTarget(paths.payload, plan),
        boundary,
      )
    ) {
      return true;
    }
    return false;
  }
  boundary("after-ready-absence");
  const payloadBytes = serializedTransitionTarget(plan);
  if (
    artifactStepOrPublishedTarget(
      path,
      plan,
      () =>
        publishExclusiveLinkedFile(
          paths.payload,
          payloadBytes,
          0o600,
          "Darwin lineage transition payload",
        ),
      boundary,
    )
  ) {
    return true;
  }
  boundary("after-payload-publish");
  if (
    artifactStepOrPublishedTarget(
      path,
      plan,
      () => readTransitionTarget(paths.payload, plan),
      boundary,
    )
  ) {
    return true;
  }
  let claim;
  if (
    artifactStepOrPublishedTarget(
      path,
      plan,
      () => {
        claim = readPlanForReadiness(paths, plan);
      },
      boundary,
    )
  ) {
    return true;
  }
  if (!jsonValuesEqual(claim, plan)) {
    fail("Darwin lineage transition claim changed before readiness");
  }
  if (
    artifactStepOrPublishedTarget(
      path,
      plan,
      () => {
        try {
          linkSync(paths.claim, paths.ready);
          fsyncDirectory(dirname(paths.claim));
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      },
      boundary,
    )
  ) {
    return true;
  }
  boundary("after-ready-link");
  if (
    artifactStepOrPublishedTarget(
      path,
      plan,
      () => validateReadyLink(paths),
      boundary,
    )
  ) {
    return true;
  }
  boundary("after-ready-validation");
  if (
    artifactStepOrPublishedTarget(
      path,
      plan,
      () => readTransitionTarget(paths.payload, plan),
      boundary,
    )
  ) {
    return true;
  }
  return false;
}

function unlinkStableTransitionSnapshot(path, label, snapshot) {
  let current;
  try {
    current = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!sameFileIdentity(snapshot.stat, current)) {
    fail(`${label} changed before cleanup`);
  }
  try {
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function unlinkExactTransitionFile(
  path,
  label,
  { expectedBytes = null, ...options },
) {
  let snapshot;
  try {
    snapshot = readStableFile(path, label, options);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (expectedBytes !== null && !snapshot.bytes.equals(expectedBytes)) {
    fail(`${label} does not match its exact transition value`);
  }
  unlinkStableTransitionSnapshot(path, label, snapshot);
}

function unlinkTransitionCurrentAfterPublication(paths, plan) {
  let snapshot;
  try {
    snapshot = readStableFile(
      paths.current,
      "Darwin lineage claimed current state",
      {
        maximumBytes: MAX_TRANSITION_BYTES,
        expectedModes: [0o600],
        expectedLinkCounts: [1, 2],
      },
    );
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const value = parseJsonBytes(
    snapshot.bytes,
    "Darwin lineage claimed current state",
  );
  if (!["expected", "target"].includes(transitionValueKind(value, plan))) {
    fail("Darwin lineage cleanup current state is foreign");
  }
  unlinkStableTransitionSnapshot(
    paths.current,
    "Darwin lineage claimed current state",
    snapshot,
  );
}

function cleanupTransition(paths, plan, boundary = () => {}) {
  const payloadBytes = serializedTransitionTarget(plan);
  const planBytes = serializedTransitionPlan(plan);
  if (pathEntryExists(paths.payload)) {
    boundary("before-cleanup-payload");
    unlinkExactTransitionFile(
      paths.payload,
      "Darwin lineage transition payload",
      {
        maximumBytes: MAX_TRANSITION_BYTES,
        expectedModes: [0o600],
        expectedLinkCounts: [1, 2],
        expectedBytes: payloadBytes,
      },
    );
  }
  if (pathEntryExists(paths.ready)) {
    boundary("before-cleanup-ready");
    unlinkExactTransitionFile(
      paths.ready,
      "Darwin lineage transition ready link",
      {
        maximumBytes: MAX_TRANSITION_BYTES,
        expectedModes: [0o400],
        expectedLinkCounts: [1, 2],
        expectedBytes: planBytes,
      },
    );
  }
  if (pathEntryExists(paths.current)) {
    boundary("before-cleanup-current");
    unlinkTransitionCurrentAfterPublication(paths, plan);
  }
  if (pathEntryExists(paths.claim)) {
    boundary("before-cleanup-claim");
    unlinkExactTransitionFile(paths.claim, "Darwin lineage transition claim", {
      maximumBytes: MAX_TRANSITION_BYTES,
      expectedModes: [0o400],
      expectedLinkCounts: [1, 2],
      expectedBytes: planBytes,
    });
  }
}

function cleanupObsoleteTransitionCurrent(path, paths, plan, boundary) {
  let canonical;
  for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt += 1) {
    try {
      canonical = readCanonicalTransitionValue(
        path,
        () => boundary("during-obsolete-current-canonical-read"),
        { expectedLinkCounts: [1, 2, 3] },
      );
      break;
    } catch (error) {
      if (!(error instanceof DarwinStableReadContentionError)) throw error;
    }
  }
  if (canonical === undefined || canonical === null) return false;
  if (!isAdvancedTransitionValue(canonical.value, plan)) return false;

  if (canonical.stat.nlink === 3n) {
    canonical = undefined;
    for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt += 1) {
      try {
        canonical = readCanonicalTransitionValue(
          path,
          ({ bytes, stat: stableCanonical }) => {
            boundary("during-obsolete-current-link-proof");
            if (stableCanonical.nlink !== 3n) return;
            validateCanonicalCurrentLinks(
              path,
              paths.current,
              stableCanonical,
              parseJsonBytes(bytes, "Darwin lineage transition current state"),
              plan.token,
            );
          },
          { expectedLinkCounts: [1, 2, 3] },
        );
        break;
      } catch (error) {
        if (!(error instanceof DarwinStableReadContentionError)) throw error;
      }
    }
    if (canonical === undefined || canonical === null) return false;
    if (!isAdvancedTransitionValue(canonical.value, plan)) return false;
  }

  // A stable canonical revision at or beyond this transition's target makes
  // this revision-specific pathname obsolete. Every valid replacement in the
  // same slot is obsolete too, so cleanup does not depend on a racy inode
  // ownership check.
  boundary("before-obsolete-current-cleanup");
  try {
    unlinkSync(paths.current);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  boundary("after-obsolete-current-cleanup");
  return true;
}

function bindTransitionCurrent(
  path,
  paths,
  plan,
  expectedCanonicalStat,
  boundary,
) {
  let created = false;
  if (!pathEntryExists(paths.current)) {
    boundary("before-current-link");
    try {
      linkSync(path, paths.current);
      created = true;
      fsyncDirectory(dirname(path));
      boundary("after-current-link-before-validation");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (created) boundary("after-current-link");
  try {
    return validateClaimedCurrent(paths, plan, expectedCanonicalStat, {
      boundary,
      created,
    });
  } catch (error) {
    const obsoleteCurrentRemoved = cleanupObsoleteTransitionCurrent(
      path,
      paths,
      plan,
      boundary,
    );
    if (error instanceof DarwinStableReadContentionError) {
      transitionConflict(error.message, {
        retryWithinTransition:
          obsoleteCurrentRemoved || error.retryWithinTransition,
      });
    }
    throw error;
  }
}

function currentMatchesClaimedInode(path, claimedStat) {
  const current = lstatSync(path, { bigint: true });
  if (!current.isFile() || !sameFileIdentity(current, claimedStat)) {
    // Another valid writer can publish after this process reads the expected
    // value and before it rechecks the canonical inode. Treat that narrow
    // read-to-stat race as a revision conflict. The caller rereads and
    // revalidates the canonical state before it can publish or signal.
    transitionConflict(
      "Darwin lineage canonical state is not the claimed expected inode",
    );
  }
}

function completeTransition(path, plan, boundary = () => {}) {
  const paths = transitionPaths(path, plan.nextRevision);
  let current = readCanonicalTransitionValue(path);
  if (
    current !== null &&
    transitionValueKind(current.value, plan) === "target"
  ) {
    cleanupTransition(paths, plan, boundary);
    return plan.target;
  }
  if (current === null) {
    transitionConflict(
      "Darwin lineage transition found no canonical current state",
    );
  }
  const claimedStat = bindTransitionCurrent(
    path,
    paths,
    plan,
    current.stat,
    boundary,
  );
  current = readCanonicalTransitionValue(path);
  if (
    current !== null &&
    transitionValueKind(current.value, plan) === "target"
  ) {
    cleanupTransition(paths, plan, boundary);
    return plan.target;
  }
  if (
    current === null ||
    transitionValueKind(current.value, plan) !== "expected"
  ) {
    transitionConflict(
      "Darwin lineage transition changed before its current-state claim",
    );
  }
  currentMatchesClaimedInode(path, claimedStat);
  boundary("after-current-claim");
  current = readCanonicalTransitionValue(path);
  if (
    current !== null &&
    transitionValueKind(current.value, plan) === "target"
  ) {
    cleanupTransition(paths, plan, boundary);
    return plan.target;
  }
  if (
    current === null ||
    transitionValueKind(current.value, plan) !== "expected"
  ) {
    transitionConflict(
      "Darwin lineage transition changed after its current-state claim",
    );
  }
  currentMatchesClaimedInode(path, claimedStat);
  const durablePlan = readPlanForTransition(paths, plan);
  if (!jsonValuesEqual(durablePlan, plan)) {
    fail("Darwin lineage transition claim changed before payload creation");
  }
  const publishedByPeer = ensureTransitionPayload(path, paths, plan, boundary);
  boundary("after-ready");
  if (publishedByPeer) {
    cleanupTransition(paths, plan, boundary);
    return plan.target;
  }
  current = readCanonicalTransitionValue(path);
  if (
    current !== null &&
    transitionValueKind(current.value, plan) === "target"
  ) {
    cleanupTransition(paths, plan, boundary);
    return plan.target;
  }
  if (
    current === null ||
    transitionValueKind(current.value, plan) !== "expected"
  ) {
    transitionConflict("Darwin lineage transition changed before publication");
  }
  currentMatchesClaimedInode(path, claimedStat);
  if (
    artifactStepOrPublishedTarget(
      path,
      plan,
      () => validateReadyLink(paths),
      boundary,
    )
  ) {
    cleanupTransition(paths, plan, boundary);
    return plan.target;
  }
  boundary("before-publication-payload-read");
  if (
    artifactStepOrPublishedTarget(
      path,
      plan,
      () => readTransitionTarget(paths.payload, plan),
      boundary,
    )
  ) {
    cleanupTransition(paths, plan, boundary);
    return plan.target;
  }
  try {
    renameSync(paths.payload, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (
      error?.code === "ENOENT" &&
      canonicalHasExactTransitionTarget(path, plan, boundary)
    ) {
      cleanupTransition(paths, plan, boundary);
      return plan.target;
    }
    throw error;
  }
  current = readCanonicalTransitionValue(path);
  if (
    current === null ||
    transitionValueKind(current.value, plan) !== "target"
  ) {
    transitionConflict(
      "Darwin lineage transition publication lost its exact target",
    );
  }
  boundary("after-publication");
  cleanupTransition(paths, plan, boundary);
  return plan.target;
}

function performTransition(path, requestedPlan, boundary = () => {}) {
  const plan = validateTransitionPlan(requestedPlan, requestedPlan.token);
  validateStatePath(path, plan.token);
  const paths = transitionPaths(path, plan.nextRevision);
  const planBytes = serializedTransitionPlan(plan);
  for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt += 1) {
    const current = readCanonicalTransitionValue(path);
    if (
      current !== null &&
      transitionValueKind(current.value, plan) === "target"
    ) {
      cleanupTransition(paths, plan, boundary);
      return plan.target;
    }
    publishExclusiveLinkedFile(
      paths.claim,
      planBytes,
      0o400,
      "Darwin lineage transition claim",
    );
    const claimedPlan = readPlanForTransition(paths, plan);
    if (!jsonValuesEqual(claimedPlan, plan)) {
      completeTransition(path, claimedPlan, boundary);
      transitionConflict(
        "a different Darwin lineage transition won this revision",
      );
    }
    try {
      return completeTransition(path, plan, boundary);
    } catch (error) {
      if (!(error instanceof DarwinTransitionConflictError)) throw error;
      if (!error.retryWithinTransition) throw error;
      if (attempt + 1 === TRANSITION_ATTEMPTS) throw error;
    }
  }
  fail("Darwin lineage transition retry bound was exceeded");
}

function replacementPlan(expectedState, replacementState) {
  const token = expectedState.token;
  const expected = validateState(expectedState, token);
  if (expected.revision >= 4_294_967_295) {
    fail("Darwin lineage state revision is exhausted");
  }
  const target = validateState(
    { ...replacementState, revision: expected.revision + 1 },
    token,
  );
  return validateTransitionPlan(
    {
      schema: TRANSITION_SCHEMA,
      token,
      operation: "replace",
      expectedRevision: expected.revision,
      nextRevision: expected.revision + 1,
      expectedState: expected,
      target,
    },
    token,
  );
}

function replaceState(path, expectedState, replacementState, boundary) {
  const plan = replacementPlan(expectedState, replacementState);
  return performTransition(path, plan, boundary);
}

function upgradeLegacyStateFileForSettlement(path, boundary) {
  const token = tokenFromStatePath(path);
  const legacy = readStateValue(path);
  const target = upgradeLegacyStateForSettlement(legacy, token);
  const plan = validateTransitionPlan(
    {
      schema: TRANSITION_SCHEMA,
      token,
      operation: "replace",
      expectedRevision: -1,
      nextRevision: 0,
      expectedState: legacy,
      target,
    },
    token,
  );
  return performTransition(path, plan, boundary);
}

function readStateForSettlement(path) {
  const token = tokenFromStatePath(path);
  const value = readStateValue(path);
  if (
    value?.schema === LEGACY_STATE_SCHEMA &&
    value?.lifecycleContract === LEGACY_LIFECYCLE_CONTRACT
  ) {
    return upgradeLegacyStateFileForSettlement(path);
  }
  return validateState(value, token);
}

function discardPlan(state) {
  const expected = validateState(state, state.token);
  if (expected.settledAt === null || expected.settledReason === null) {
    fail("Darwin lineage state has no durable settlement evidence");
  }
  if (expected.revision >= 4_294_967_295) {
    fail("Darwin lineage state revision is exhausted");
  }
  const target = validateDiscardTombstone(
    {
      schema: DISCARD_SCHEMA,
      token: expected.token,
      expectedRevision: expected.revision,
      nextRevision: expected.revision + 1,
      settledState: expected,
    },
    expected.token,
  );
  return validateTransitionPlan(
    {
      schema: TRANSITION_SCHEMA,
      token: expected.token,
      operation: "discard",
      expectedRevision: expected.revision,
      nextRevision: expected.revision + 1,
      expectedState: expected,
      target,
    },
    expected.token,
  );
}

function retireDiscardTombstone(path, tombstone, boundary = () => {}) {
  const expected = validateDiscardTombstone(
    tombstone,
    tokenFromStatePath(path),
  );
  const current = readCanonicalTransitionValue(path);
  if (
    current === null ||
    !jsonValuesEqual(
      validateDiscardTombstone(current.value, expected.token),
      expected,
    )
  ) {
    fail("Darwin lineage discard did not publish its exact tombstone");
  }
  const before = current.stat;
  let pathStat;
  try {
    pathStat = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!sameFileIdentity(before, pathStat)) {
    fail("Darwin lineage discard tombstone changed before retirement");
  }
  boundary("before-discard-retirement");
  try {
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  boundary("after-discard-retirement");
}

function discardState(path, state, boundary) {
  const plan = discardPlan(state);
  const tombstone = performTransition(path, plan, boundary);
  retireDiscardTombstone(path, tombstone, boundary);
}

function discardSettledState(path, boundary) {
  const token = tokenFromStatePath(path);
  const current = readCanonicalTransitionValue(path);
  if (current === null) fail("required Darwin lineage state is missing");
  let state;
  try {
    state = validateState(current.value, token);
  } catch (stateError) {
    try {
      const tombstone = validateDiscardTombstone(current.value, token);
      const plan = discardPlan(tombstone.settledState);
      if (!jsonValuesEqual(plan.target, tombstone)) {
        fail("Darwin lineage discard tombstone does not match its plan");
      }
      const recovered = performTransition(path, plan, boundary);
      retireDiscardTombstone(path, recovered, boundary);
      return;
    } catch (recoveryError) {
      fail(
        `Darwin lineage discard recovery rejected the canonical file: ${stateError.message}; ${recoveryError.message}`,
      );
    }
  }
  discardState(path, state, boundary);
}

export {
  DarwinTransitionConflictError,
  createState,
  discardSettledState,
  discardState,
  readCanonicalTransitionValue,
  readState,
  readStateForSettlement,
  replaceState,
  transitionPaths,
  validateDiscardTombstone,
};
