export const DEPLOYMENT_IDENTITY_PROBE =
  "  _meta(order_by: { chainId: asc }) { chainId readyAt startBlock }\n";

export function parseSafeInteger(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function summarizeStatus(statusJson) {
  const chains = (statusJson.data ?? []).map((row) => ({
    chainId: row.chain_id,
    startBlock: parseSafeInteger(row.start_block),
    headBlock: Number(row.block_height ?? 0),
    processedBlock: Number(row.latest_processed_block ?? 0),
    fetchedBlock: Number(row.latest_fetched_block_number ?? 0),
    events: Number(row.num_events_processed ?? 0),
    syncedAt: row.timestamp_caught_up_to_head_or_endblock ?? "",
  }));

  return {
    allSynced: chains.length > 0 && chains.every((chain) => chain.syncedAt),
    chains,
  };
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|\+00:00)$/.exec(
      value,
    );
  if (!match) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  if (new Date(milliseconds).toISOString().slice(0, 19) !== match[1]) {
    return null;
  }
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return `${match[1]}${fraction ? `.${fraction}` : ""}Z`;
}

function identityRows(rows) {
  if (!Array.isArray(rows)) return null;
  return rows.map((row) => ({
    chainId: parseSafeInteger(row?.chainId),
    readyAt: normalizeIsoTimestamp(row?.readyAt),
    startBlock: parseSafeInteger(row?.startBlock),
  }));
}

export function summarizeDeploymentIdentity(
  graphqlJson,
  sync,
  { required = false } = {},
) {
  if (!required) {
    return {
      required: false,
      ok: true,
      expected: [],
      observed: [],
      failures: [],
    };
  }

  const expected = identityRows(
    sync.chains.map((chain) => ({
      chainId: chain.chainId,
      readyAt: chain.syncedAt,
      startBlock: chain.startBlock,
    })),
  );
  const observed = identityRows(graphqlJson.data?._meta);
  const failures = [];

  if (expected === null || expected.length === 0) {
    failures.push(
      "target deployment status has no per-chain identity timestamps",
    );
  }
  if (observed === null || observed.length === 0) {
    failures.push(
      "static production endpoint returned no _meta deployment identity rows",
    );
  }

  const validExpected = expected ?? [];
  const validObserved = observed ?? [];
  const expectedByChain = new Map();
  const observedByChain = new Map();

  for (const row of validExpected) {
    if (
      row.chainId === null ||
      row.readyAt === null ||
      row.startBlock === null ||
      expectedByChain.has(row.chainId)
    ) {
      failures.push("target deployment status identity rows are invalid");
      break;
    }
    expectedByChain.set(row.chainId, row);
  }

  for (const row of validObserved) {
    if (
      row.chainId === null ||
      row.readyAt === null ||
      row.startBlock === null ||
      observedByChain.has(row.chainId)
    ) {
      failures.push(
        "static production endpoint _meta identity rows are invalid",
      );
      break;
    }
    observedByChain.set(row.chainId, row);
  }

  for (const [chainId, expectedRow] of expectedByChain) {
    const observedRow = observedByChain.get(chainId);
    if (!observedRow) {
      failures.push(
        `static production endpoint has no _meta identity for target chain ${chainId}`,
      );
      continue;
    }
    if (
      observedRow.readyAt !== expectedRow.readyAt ||
      observedRow.startBlock !== expectedRow.startBlock
    ) {
      failures.push(
        `static production endpoint identity does not match target chain ${chainId}: expected readyAt ${expectedRow.readyAt} and startBlock ${expectedRow.startBlock}; received readyAt ${observedRow.readyAt} and startBlock ${observedRow.startBlock}`,
      );
    }
  }

  for (const chainId of observedByChain.keys()) {
    if (!expectedByChain.has(chainId)) {
      failures.push(
        `static production endpoint returned unexpected _meta identity chain ${chainId}`,
      );
    }
  }

  return {
    required: true,
    ok: failures.length === 0,
    expected: validExpected,
    observed: validObserved,
    failures,
  };
}
