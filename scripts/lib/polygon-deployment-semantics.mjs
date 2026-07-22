// Promotion contract for the live Polygon deployment. Feed addresses come
// from each FPMM and expiries from SortedOracles; update these expectations in
// the same PR as any governance/deployment change that alters either mapping.
export const POLYGON_FPMM_EXPECTATIONS = [
  {
    id: "137-0x463c0d1f04bcd99a1efcf94ac2a75bc19ea4a7e5",
    label: "USDC/USDm",
    referenceRateFeedID: "0x81a313ff894bfc6093d33b5514e34d7faa41b7ef",
    oracleExpiry: 150n,
    requireCurrent: false,
  },
  {
    id: "137-0x93e15a22fda39fefccce82d387a09ccf030ead61",
    label: "EURm/USDm",
    referenceRateFeedID: "0xec57482aa55e3ad026c315a0e4a692b776c318ca",
    oracleExpiry: 150n,
    requireCurrent: false,
  },
  {
    id: "137-0xcd8c6811d975981f57e7fb32e59f0bee66af3201",
    label: "EURm/EUROP",
    referenceRateFeedID: "0xc22418a83dfc262b10a1f57e25309db83e7ea79e",
    oracleExpiry: 31_536_000n,
    requireCurrent: true,
  },
];

function parseBigInt(value) {
  if (
    !["bigint", "number", "string"].includes(typeof value) ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function normalizedId(value) {
  return String(value ?? "").toLowerCase();
}

/**
 * Verify that a caught-up deployment contains a complete, internally
 * consistent Polygon replay. `--allow-syncing` never bypasses these checks:
 * partial rows are not safe to promote even when the hosted status is green.
 */
export function summarizePolygonPools(rows, nowSeconds = Date.now() / 1000) {
  const inputRows = Array.isArray(rows) ? rows : [];
  const failures = [];
  const expectedIds = POLYGON_FPMM_EXPECTATIONS.map(({ id }) => id).sort();
  const actualIds = inputRows.map(({ id }) => normalizedId(id)).sort();
  const duplicateIds = actualIds.filter(
    (id, index) => index > 0 && id === actualIds[index - 1],
  );

  const missingIds = expectedIds.filter((id) => !actualIds.includes(id));
  const unexpectedIds = actualIds.filter((id) => !expectedIds.includes(id));
  if (missingIds.length > 0) {
    failures.push(`missing Polygon FPMMs: ${missingIds.join(", ")}`);
  }
  if (unexpectedIds.length > 0) {
    failures.push(`unexpected Polygon FPMMs: ${unexpectedIds.join(", ")}`);
  }
  if (duplicateIds.length > 0) {
    failures.push(`duplicate Polygon FPMMs: ${duplicateIds.join(", ")}`);
  }

  const rowsById = new Map(inputRows.map((row) => [normalizedId(row.id), row]));
  const now = BigInt(Math.floor(nowSeconds));

  for (const expected of POLYGON_FPMM_EXPECTATIONS) {
    const row = rowsById.get(expected.id);
    if (!row) continue;
    const prefix = `${expected.label} (${expected.id})`;

    if (row.source !== "fpmm_factory") {
      failures.push(`${prefix} source is ${String(row.source)}`);
    }
    if (
      normalizedId(row.referenceRateFeedID) !== expected.referenceRateFeedID
    ) {
      failures.push(
        `${prefix} feed is ${normalizedId(row.referenceRateFeedID) || "missing"}; expected ${expected.referenceRateFeedID}`,
      );
    }

    const lastOracleReportAt = parseBigInt(row.lastOracleReportAt);
    const oracleExpiry = parseBigInt(row.oracleExpiry);
    const lastOracleSnapshotTimestamp = parseBigInt(
      row.lastOracleSnapshotTimestamp,
    );
    const healthTotalSeconds = parseBigInt(row.healthTotalSeconds);
    const healthBinarySeconds = parseBigInt(row.healthBinarySeconds);

    if (lastOracleReportAt === null || lastOracleReportAt <= 0n) {
      failures.push(`${prefix} has no positive exact oracle anchor`);
    }
    if (oracleExpiry === null) {
      failures.push(`${prefix} has an invalid oracle expiry`);
    } else if (oracleExpiry !== expected.oracleExpiry) {
      failures.push(
        `${prefix} expiry is ${oracleExpiry}; expected ${expected.oracleExpiry}`,
      );
    }
    if (
      lastOracleSnapshotTimestamp === null ||
      lastOracleSnapshotTimestamp <= 0n
    ) {
      failures.push(`${prefix} has no positive oracle snapshot cursor`);
    }
    if (row.hasHealthData !== true) {
      failures.push(`${prefix} hasHealthData is not true`);
    }
    if (
      healthTotalSeconds === null ||
      healthBinarySeconds === null ||
      healthTotalSeconds < 0n ||
      healthBinarySeconds < 0n
    ) {
      failures.push(`${prefix} has invalid health counters`);
    } else if (healthBinarySeconds > healthTotalSeconds) {
      failures.push(`${prefix} health binary seconds exceed total seconds`);
    }

    if (expected.requireCurrent) {
      if (
        lastOracleReportAt !== null &&
        lastOracleReportAt > 0n &&
        oracleExpiry !== null &&
        lastOracleReportAt + oracleExpiry < now
      ) {
        failures.push(`${prefix} one-year oracle anchor is expired`);
      }
      if (row.oracleOk !== true) {
        failures.push(`${prefix} oracleOk is not true`);
      }
      if (row.medianLive !== true) {
        failures.push(`${prefix} medianLive is not true`);
      }
      if (row.healthStatus === "CRITICAL" || row.healthStatus === "N/A") {
        failures.push(`${prefix} health status is ${String(row.healthStatus)}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    expectedCount: expectedIds.length,
    actualCount: inputRows.length,
    poolIds: actualIds,
    failures,
  };
}
