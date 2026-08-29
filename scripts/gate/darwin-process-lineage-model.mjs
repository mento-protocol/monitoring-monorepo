const STATE_SCHEMA = "agentqg-darwin-lineage-v4";
const LIFECYCLE_CONTRACT = "darwin-coherent-lineage-v2";
const LEGACY_STATE_SCHEMA = "agentqg-darwin-lineage-v3";
const LEGACY_LIFECYCLE_CONTRACT = "darwin-unique-lineage-v1";
const SNAPSHOT_HEADER = "agentqg-darwin-process-snapshot-v3";
const SNAPSHOT_PROOF_KIND = "xnu-coherent-process-snapshot-v1";
const PROC_LIST_PID_PADDING = 20;
const BOOT_ID = /^pid1-[1-9][0-9]*-[0-9]+-[1-9][0-9]*$/u;
const RUN_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}-[0-9]{1,10}-[0-9]{1,12}$/u;
const MAX_NATIVE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_IDENTITIES = 200_000;
const UINT32_MAX = 4_294_967_295n;
const UINT64_MAX = 18_446_744_073_709_551_615n;

function fail(message) {
  throw new Error(message);
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (!value) fail(`missing ${name}`);
  return value;
}

function parseCommandOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || options.has(name)) {
      fail("Darwin lineage command options are malformed");
    }
    options.set(name, value);
  }
  return options;
}

function unsignedDecimal(
  value,
  label,
  { allowZero = false, maximum = UINT64_MAX } = {},
) {
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) {
    fail(`${label} is not an unsigned decimal integer`);
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > maximum) {
    fail(`${label} is outside its supported range`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail(`${label} is not a supported positive integer`);
  }
  return parsed;
}

function uint32(value, label, { allowZero = true } = {}) {
  return Number(
    unsignedDecimal(String(value), label, { allowZero, maximum: UINT32_MAX }),
  );
}

function validateCoalitionPair(value, label) {
  return {
    resourceCoalitionId: unsignedDecimal(
      value.resourceCoalitionId,
      `${label} resource coalition ID`,
    ),
    jetsamCoalitionId: unsignedDecimal(
      value.jetsamCoalitionId,
      `${label} jetsam coalition ID`,
    ),
  };
}

function sameCoalitionPair(left, right) {
  return (
    left.resourceCoalitionId === right.resourceCoalitionId &&
    left.jetsamCoalitionId === right.jetsamCoalitionId
  );
}

function isExactDarwinChild(child, parent) {
  return (
    child.ppid === parent.pid &&
    child.parentUniqueId === parent.uniqueId &&
    BigInt(child.uniqueId) > BigInt(parent.uniqueId) &&
    sameCoalitionPair(child, parent)
  );
}

function matchesExactDarwinIdentity(record, expected) {
  return (
    record?.pid === expected.pid &&
    record.uniqueId === expected.uniqueId &&
    record.parentUniqueId === expected.parentUniqueId
  );
}

function hasExactDarwinAncestry(records, descendant, ancestor, uid) {
  const byUnique = new Map(records.map((record) => [record.uniqueId, record]));
  const seen = new Set();
  let current = descendant;
  while (current && !seen.has(current.uniqueId)) {
    if (
      ![current.uid, current.realUid, current.savedUid].every(
        (candidate) => candidate === uid,
      ) ||
      !sameCoalitionPair(current, ancestor)
    ) {
      return false;
    }
    if (current.uniqueId === ancestor.uniqueId) {
      return current.pid === ancestor.pid;
    }
    seen.add(current.uniqueId);
    const parent = byUnique.get(current.parentUniqueId);
    if (!parent || !isExactDarwinChild(current, parent)) return false;
    current = parent;
  }
  return false;
}

function parseRecord(line, label) {
  const fields = line.split("\t");
  if (fields.length !== 12) fail(`${label} does not have 12 fields`);
  const [
    pid,
    ppid,
    pgid,
    status,
    uid,
    realUid,
    savedUid,
    uniqueId,
    parentUniqueId,
    resourceCoalitionId,
    jetsamCoalitionId,
    pidVersion,
  ] = fields;
  const coalitionPair = validateCoalitionPair(
    { resourceCoalitionId, jetsamCoalitionId },
    label,
  );
  const record = {
    pid: positiveInteger(pid, `${label} PID`, 2_147_483_647),
    ppid: uint32(ppid, `${label} PPID`),
    pgid: uint32(pgid, `${label} PGID`),
    status: uint32(status, `${label} status`),
    uid: uint32(uid, `${label} UID`),
    realUid: uint32(realUid, `${label} real UID`),
    savedUid: uint32(savedUid, `${label} saved UID`),
    uniqueId: unsignedDecimal(uniqueId, `${label} unique ID`),
    parentUniqueId: unsignedDecimal(
      parentUniqueId,
      `${label} parent unique ID`,
      { allowZero: true },
    ),
    ...coalitionPair,
    pidVersion: positiveInteger(
      pidVersion,
      `${label} PID version`,
      Number(UINT32_MAX),
    ),
  };
  if (
    record.parentUniqueId !== "0" &&
    BigInt(record.parentUniqueId) >= BigInt(record.uniqueId)
  ) {
    fail(`${label} has non-monotonic parent and child unique IDs`);
  }
  return record;
}

function validateSnapshotProof(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is not an object`);
  }
  if (value.kind !== SNAPSHOT_PROOF_KIND) {
    fail(`${label} has an unsupported kind`);
  }
  const proof = {
    kind: SNAPSHOT_PROOF_KIND,
    lowerUniqueId: unsignedDecimal(
      value.lowerUniqueId,
      `${label} lower unique ID`,
    ),
    upperUniqueId: unsignedDecimal(
      value.upperUniqueId,
      `${label} upper unique ID`,
    ),
    estimatedCount: positiveInteger(
      value.estimatedCount,
      `${label} estimated process count`,
      2_147_483_647,
    ),
    listedCount: positiveInteger(
      value.listedCount,
      `${label} listed process count`,
      2_147_483_647,
    ),
    capacity: positiveInteger(
      value.capacity,
      `${label} process-vector capacity`,
      2_147_483_647,
    ),
    zeroPidCount: uint32(value.zeroPidCount, `${label} PID-zero slot count`),
    rowCount: uint32(value.rowCount, `${label} emitted row count`),
  };
  if (
    BigInt(proof.lowerUniqueId) === UINT64_MAX ||
    BigInt(proof.upperUniqueId) !== BigInt(proof.lowerUniqueId) + 1n
  ) {
    fail(`${label} does not have adjacent non-wrapping fence IDs`);
  }
  if (
    proof.zeroPidCount !== 1 ||
    proof.listedCount <= proof.zeroPidCount ||
    proof.estimatedCount - (proof.listedCount - proof.zeroPidCount) <
      PROC_LIST_PID_PADDING ||
    proof.listedCount >= proof.capacity ||
    proof.rowCount > proof.listedCount
  ) {
    fail(`${label} has inconsistent process counts`);
  }
  return proof;
}

function parseDarwinProcessSnapshot(text) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > MAX_NATIVE_OUTPUT_BYTES
  ) {
    fail("Darwin process snapshot is missing or too large");
  }
  const lines = text.trimEnd().split("\n");
  const headerFields = lines.shift().split("\t");
  if (headerFields.length !== 8 || headerFields[0] !== SNAPSHOT_HEADER) {
    fail("Darwin process snapshot has an unsupported header");
  }
  const proof = validateSnapshotProof(
    {
      kind: SNAPSHOT_PROOF_KIND,
      lowerUniqueId: headerFields[1],
      upperUniqueId: headerFields[2],
      estimatedCount: headerFields[3],
      listedCount: headerFields[4],
      capacity: headerFields[5],
      zeroPidCount: headerFields[6],
      rowCount: headerFields[7],
    },
    "Darwin process snapshot proof",
  );
  const records = [];
  const pids = new Set();
  const uniqueIds = new Set();
  for (const [index, line] of lines.entries()) {
    if (!line) fail(`Darwin process snapshot row ${index + 1} is empty`);
    const record = parseRecord(
      line,
      `Darwin process snapshot row ${index + 1}`,
    );
    if (pids.has(record.pid)) {
      fail(`duplicate PID in Darwin process snapshot: ${record.pid}`);
    }
    if (uniqueIds.has(record.uniqueId)) {
      fail(
        `duplicate unique ID in Darwin process snapshot: ${record.uniqueId}`,
      );
    }
    if (BigInt(record.uniqueId) >= BigInt(proof.lowerUniqueId)) {
      fail(
        `Darwin process snapshot row ${index + 1} is outside the fenced epoch`,
      );
    }
    pids.add(record.pid);
    uniqueIds.add(record.uniqueId);
    records.push(record);
  }
  if (records.length !== proof.rowCount) {
    fail("Darwin process snapshot proof row count does not match its rows");
  }
  return { records, proof };
}

function parseDarwinProcessIdentity(text) {
  const line = text.trimEnd();
  if (!line || line.includes("\n")) {
    fail("Darwin process identity is malformed");
  }
  return parseRecord(line, "Darwin process identity");
}

function validateRoot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Darwin lineage root is not an object");
  }
  return {
    pid: positiveInteger(value.pid, "Darwin lineage root PID", 2_147_483_647),
    uniqueId: unsignedDecimal(value.uniqueId, "Darwin lineage root unique ID"),
    parentUniqueId: unsignedDecimal(
      value.parentUniqueId,
      "Darwin lineage root parent unique ID",
      { allowZero: true },
    ),
    ...validateCoalitionPair(value, "Darwin lineage root"),
  };
}

function validateLauncher(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Darwin lineage launcher is not an object");
  }
  return {
    pid: positiveInteger(
      value.pid,
      "Darwin lineage launcher PID",
      2_147_483_647,
    ),
    uniqueId: unsignedDecimal(
      value.uniqueId,
      "Darwin lineage launcher unique ID",
    ),
    parentUniqueId: unsignedDecimal(
      value.parentUniqueId,
      "Darwin lineage launcher parent unique ID",
      { allowZero: true },
    ),
    ...validateCoalitionPair(value, "Darwin lineage launcher"),
  };
}

function validateTombstone(value, index) {
  const label = `Darwin lineage tombstone ${index + 1}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is not an object`);
  }
  if (!["owned", "ambiguous", "unrelated"].includes(value.classification)) {
    fail(`${label} has an unsupported classification`);
  }
  const parsed = {
    pid: positiveInteger(value.pid, `${label} PID`, 2_147_483_647),
    uniqueId: unsignedDecimal(value.uniqueId, `${label} unique ID`),
    parentUniqueId: unsignedDecimal(
      value.parentUniqueId,
      `${label} parent unique ID`,
      { allowZero: true },
    ),
    classification: value.classification,
    firstSeenAt: positiveInteger(value.firstSeenAt, `${label} first-seen time`),
    termSentAt: null,
    killSentAt: null,
  };
  for (const field of ["termSentAt", "killSentAt"]) {
    if (value[field] !== null && value[field] !== undefined) {
      parsed[field] = positiveInteger(value[field], `${label} ${field}`);
    }
  }
  if (
    parsed.parentUniqueId !== "0" &&
    BigInt(parsed.parentUniqueId) >= BigInt(parsed.uniqueId)
  ) {
    fail(`${label} has non-monotonic parent and child unique IDs`);
  }
  return parsed;
}

function validateSettlementProof(value) {
  const proof = validateSnapshotProof(value, "Darwin lineage settlement proof");
  return {
    ...proof,
    capturedAt: positiveInteger(
      value.capturedAt,
      "Darwin lineage settlement proof capture time",
    ),
  };
}

function validateState(value, expectedToken = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Darwin lineage state is not an object");
  }
  if (value.schema !== STATE_SCHEMA) {
    fail("Darwin lineage state schema is unsupported");
  }
  if (value.lifecycleContract !== LIFECYCLE_CONTRACT) {
    fail("Darwin lineage lifecycle contract is unsupported");
  }
  if (typeof value.token !== "string" || !RUN_TOKEN.test(value.token)) {
    fail("Darwin lineage state token is malformed");
  }
  if (expectedToken && value.token !== expectedToken) {
    fail("Darwin lineage state token does not match its path");
  }
  if (typeof value.bootId !== "string" || !BOOT_ID.test(value.bootId)) {
    fail("Darwin lineage boot identity is malformed");
  }
  if (
    !Array.isArray(value.baseline) ||
    value.baseline.length > MAX_IDENTITIES
  ) {
    fail("Darwin lineage baseline is malformed or too large");
  }
  const baseline = value.baseline.map((item, index) =>
    unsignedDecimal(item, `Darwin lineage baseline item ${index + 1}`),
  );
  if (new Set(baseline).size !== baseline.length) {
    fail("Darwin lineage baseline contains duplicate identities");
  }
  const root = value.root === null ? null : validateRoot(value.root);
  const launcher =
    value.launcher === null ? null : validateLauncher(value.launcher);
  if ((root === null) !== (launcher === null)) {
    fail("Darwin lineage root and launcher must be bound together");
  }
  if (
    root !== null &&
    (root.parentUniqueId !== launcher.uniqueId ||
      BigInt(root.uniqueId) <= BigInt(launcher.uniqueId))
  ) {
    fail("Darwin lineage root and launcher have inconsistent unique IDs");
  }
  if (root !== null && !sameCoalitionPair(root, launcher)) {
    fail("Darwin lineage root and launcher have inconsistent coalition IDs");
  }
  if (
    !Array.isArray(value.tombstones) ||
    value.tombstones.length > MAX_IDENTITIES
  ) {
    fail("Darwin lineage tombstone list is malformed or too large");
  }
  const tombstones = value.tombstones.map(validateTombstone);
  if (
    new Set(tombstones.map((item) => item.uniqueId)).size !== tombstones.length
  ) {
    fail("Darwin lineage tombstones contain duplicate identities");
  }
  let settledAt = null;
  let settledReason = null;
  let settlementProof = null;
  if (value.settledAt !== null && value.settledAt !== undefined) {
    settledAt = positiveInteger(
      value.settledAt,
      "Darwin lineage settlement time",
    );
  }
  if (value.settledReason !== null && value.settledReason !== undefined) {
    if (
      ![
        "empty-coherent-exact-set",
        "verified-boot-change",
        "verified-unbound-abandonment",
      ].includes(value.settledReason)
    ) {
      fail("Darwin lineage settlement reason is unsupported");
    }
    settledReason = value.settledReason;
  }
  if ((settledAt === null) !== (settledReason === null)) {
    fail("Darwin lineage settlement evidence is incomplete");
  }
  if (value.settlementProof !== null && value.settlementProof !== undefined) {
    settlementProof = validateSettlementProof(value.settlementProof);
  }
  if (
    (settledReason === "empty-coherent-exact-set") !==
    (settlementProof !== null)
  ) {
    fail("Darwin lineage coherent settlement proof is incomplete");
  }
  if (
    settledReason === "verified-unbound-abandonment" &&
    (root !== null ||
      launcher !== null ||
      tombstones.length !== 0 ||
      settlementProof !== null)
  ) {
    fail("Darwin unstarted abandonment contains bound lineage evidence");
  }
  const createdAt = positiveInteger(
    value.createdAt,
    "Darwin lineage creation time",
  );
  if (
    settlementProof !== null &&
    (settlementProof.capturedAt < createdAt ||
      settlementProof.capturedAt > settledAt)
  ) {
    fail("Darwin lineage coherent settlement proof has inverted time");
  }
  return {
    schema: STATE_SCHEMA,
    lifecycleContract: LIFECYCLE_CONTRACT,
    token: value.token,
    bootId: value.bootId,
    baseline,
    root,
    launcher,
    tombstones,
    settledAt,
    settledReason,
    settlementProof,
    createdAt,
    revision: uint32(value.revision, "Darwin lineage state revision"),
  };
}

function upgradeLegacyStateForSettlement(value, expectedToken = "") {
  const expectedKeys = [
    "baseline",
    "bootId",
    "createdAt",
    "launcher",
    "lifecycleContract",
    "root",
    "schema",
    "settledAt",
    "settledReason",
    "token",
    "tombstones",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== LEGACY_STATE_SCHEMA ||
    value.lifecycleContract !== LEGACY_LIFECYCLE_CONTRACT ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
  ) {
    fail("Darwin lineage state is not an exact legacy v3 obligation");
  }
  const hasSettledAt = value.settledAt !== null;
  const hasSettledReason = value.settledReason !== null;
  if (
    hasSettledAt !== hasSettledReason ||
    (hasSettledReason &&
      !["empty-exact-set", "verified-boot-change"].includes(
        value.settledReason,
      ))
  ) {
    fail("legacy Darwin lineage settlement evidence is malformed");
  }
  const tombstones = Array.isArray(value.tombstones)
    ? value.tombstones.map((item) => ({
        ...item,
        termSentAt: null,
        killSentAt: null,
      }))
    : value.tombstones;
  return validateState(
    {
      ...value,
      schema: STATE_SCHEMA,
      lifecycleContract: LIFECYCLE_CONTRACT,
      tombstones,
      settledAt: null,
      settledReason: null,
      settlementProof: null,
      revision: 0,
    },
    expectedToken,
  );
}

function controlLineage(records, controlPid) {
  const byUnique = new Map(records.map((record) => [record.uniqueId, record]));
  const start = records.find((record) => record.pid === controlPid);
  if (!start) {
    fail("Darwin process snapshot does not contain the settlement controller");
  }
  const lineage = new Set();
  let current = start;
  while (current && !lineage.has(current.uniqueId)) {
    lineage.add(current.uniqueId);
    current = byUnique.get(current.parentUniqueId);
  }
  return lineage;
}

function classifySnapshot(stateValue, records, { controlPid, now }) {
  const state = validateState(stateValue, stateValue.token);
  for (const record of records) {
    validateCoalitionPair(record, "Darwin process snapshot record");
    if (
      record.parentUniqueId !== "0" &&
      BigInt(record.parentUniqueId) >= BigInt(record.uniqueId)
    ) {
      fail(
        "Darwin process snapshot has non-monotonic parent and child unique IDs",
      );
    }
  }
  const baseline = new Set(state.baseline);
  const byUnique = new Map(records.map((record) => [record.uniqueId, record]));
  const previous = new Map(
    state.tombstones.map((item) => [item.uniqueId, item]),
  );
  if (state.root) {
    const priorRoot = previous.get(state.root.uniqueId);
    previous.set(state.root.uniqueId, {
      pid: state.root.pid,
      uniqueId: state.root.uniqueId,
      parentUniqueId: state.root.parentUniqueId,
      classification: "owned",
      firstSeenAt: priorRoot?.firstSeenAt ?? state.createdAt,
      termSentAt: priorRoot?.termSentAt ?? null,
      killSentAt: priorRoot?.killSentAt ?? null,
    });
  }
  const controls = controlLineage(records, controlPid);

  function classificationFor(record) {
    const seen = new Set();
    let childOnEdge = null;
    let uniqueId = record.uniqueId;
    while (uniqueId !== "0" && !seen.has(uniqueId)) {
      seen.add(uniqueId);
      if (state.root && uniqueId === state.root.uniqueId) return "owned";
      if (state.launcher && uniqueId === state.launcher.uniqueId) {
        if (!controls.has(uniqueId) || childOnEdge === null) return "owned";
        const launcher = byUnique.get(uniqueId);
        if (launcher && isExactDarwinChild(childOnEdge, launcher)) {
          return "unrelated";
        }
        return state.root && !sameCoalitionPair(record, state.root)
          ? "unrelated"
          : "ambiguous";
      }
      const prior = previous.get(uniqueId);
      if (prior) {
        if (prior.classification !== "unrelated" || childOnEdge === null) {
          return prior.classification;
        }
        const ancestor = byUnique.get(uniqueId);
        if (ancestor && isExactDarwinChild(childOnEdge, ancestor)) {
          return "unrelated";
        }
        return state.root && !sameCoalitionPair(record, state.root)
          ? "unrelated"
          : "ambiguous";
      }
      if (baseline.has(uniqueId) || controls.has(uniqueId)) {
        const ancestor = byUnique.get(uniqueId);
        if (
          childOnEdge !== null &&
          ancestor &&
          isExactDarwinChild(childOnEdge, ancestor)
        ) {
          return "unrelated";
        }
        return state.root && !sameCoalitionPair(record, state.root)
          ? "unrelated"
          : "ambiguous";
      }
      const current = byUnique.get(uniqueId);
      if (!current) {
        // A complete unique-parent chain to the mapped root is authoritative.
        // For an incomplete new chain, a different pair of kernel coalition
        // IDs proves that the process did not inherit the mapped root's pair.
        if (state.root && !sameCoalitionPair(record, state.root)) {
          return "unrelated";
        }
        return "ambiguous";
      }
      childOnEdge = current;
      uniqueId = current.parentUniqueId;
    }
    return "ambiguous";
  }

  const currentTracked = new Map();
  for (const record of records) {
    // SZOMB is 5 on Darwin. A zombie cannot execute or create descendants.
    if (record.status === 5 || controls.has(record.uniqueId)) {
      continue;
    }
    const prior = previous.get(record.uniqueId);
    if (
      state.launcher &&
      record.uniqueId === state.launcher.uniqueId &&
      !controls.has(record.uniqueId)
    ) {
      currentTracked.set(record.uniqueId, {
        pid: record.pid,
        uniqueId: record.uniqueId,
        parentUniqueId: record.parentUniqueId,
        classification: "owned",
        firstSeenAt: prior?.firstSeenAt ?? now,
        termSentAt: prior?.termSentAt ?? null,
        killSentAt: prior?.killSentAt ?? null,
      });
      continue;
    }
    if (baseline.has(record.uniqueId)) {
      continue;
    }
    currentTracked.set(record.uniqueId, {
      pid: record.pid,
      uniqueId: record.uniqueId,
      parentUniqueId: record.parentUniqueId,
      classification: classificationFor(record),
      firstSeenAt: prior?.firstSeenAt ?? now,
      termSentAt: prior?.termSentAt ?? null,
      killSentAt: prior?.killSentAt ?? null,
    });
  }

  const merged = new Map(previous);
  for (const [uniqueId, item] of currentTracked) merged.set(uniqueId, item);
  const tombstones = [...merged.values()].sort((left, right) => {
    const leftId = BigInt(left.uniqueId);
    const rightId = BigInt(right.uniqueId);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  if (tombstones.length > MAX_IDENTITIES) {
    fail("Darwin lineage tombstone limit was exceeded");
  }
  const candidates = [...currentTracked.values()].filter(
    (item) => item.classification !== "unrelated",
  );
  return { candidates, tombstones };
}

function classifyDarwinLineageCandidates(
  stateValue,
  records,
  { controlPid = process.pid, now = Date.now() } = {},
) {
  return classifySnapshot(stateValue, records, { controlPid, now }).candidates;
}

function mergeWatchedDarwinLineageTombstones(previous, observed) {
  const merged = new Map(previous.map((item) => [item.uniqueId, item]));
  for (const item of observed) {
    if (item.classification !== "unrelated") {
      merged.set(item.uniqueId, item);
    }
  }
  return [...merged.values()].sort((left, right) => {
    const leftId = BigInt(left.uniqueId);
    const rightId = BigInt(right.uniqueId);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

function signalOrder(candidates, tombstones) {
  const parents = new Map(
    tombstones.map((item) => [item.uniqueId, item.parentUniqueId]),
  );
  const depth = (candidate) => {
    let value = 0;
    let current = candidate.uniqueId;
    const seen = new Set();
    while (parents.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parents.get(current);
      value += 1;
    }
    return value;
  };
  return [...candidates].sort((left, right) => depth(right) - depth(left));
}

export {
  BOOT_ID,
  LEGACY_LIFECYCLE_CONTRACT,
  LEGACY_STATE_SCHEMA,
  LIFECYCLE_CONTRACT,
  MAX_NATIVE_OUTPUT_BYTES,
  RUN_TOKEN,
  SNAPSHOT_HEADER,
  SNAPSHOT_PROOF_KIND,
  STATE_SCHEMA,
  classifyDarwinLineageCandidates,
  classifySnapshot,
  hasExactDarwinAncestry,
  isExactDarwinChild,
  matchesExactDarwinIdentity,
  mergeWatchedDarwinLineageTombstones,
  parseCommandOptions,
  parseDarwinProcessIdentity,
  parseDarwinProcessSnapshot,
  positiveInteger,
  requiredOption,
  signalOrder,
  unsignedDecimal,
  upgradeLegacyStateForSettlement,
  validateState,
};
