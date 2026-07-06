import { env } from "./env.js";

const DAY_SECONDS = 86_400n;

export const computeRawSnapshotCutoff = (
  nowSeconds: number,
  retentionDays: number | undefined,
): bigint | null =>
  retentionDays == null
    ? null
    : BigInt(nowSeconds) - BigInt(retentionDays) * DAY_SECONDS;

export const shouldPersistRawOracleSnapshotAt = (
  blockTimestamp: bigint,
  nowSeconds: number,
  retentionDays: number | undefined,
): boolean => {
  const cutoff = computeRawSnapshotCutoff(nowSeconds, retentionDays);
  return cutoff === null || blockTimestamp >= cutoff;
};

export const shouldPersistRawOracleSnapshot = (
  blockTimestamp: bigint,
): boolean =>
  shouldPersistRawOracleSnapshotAt(
    blockTimestamp,
    Math.floor(Date.now() / 1000),
    env.ENVIO_ORACLE_SNAPSHOT_RETENTION_DAYS,
  );
