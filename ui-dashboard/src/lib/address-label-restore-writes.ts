import { encodeLabelFields, LABELS_KEY } from "@/lib/address-label-fields";
import { encodeReportFields, REPORTS_KEY } from "@/lib/address-report-fields";
import type { AddressEntry } from "@/lib/address-labels-shared";
import type { AddressReport } from "@/lib/address-reports-shared";
import { getRedis } from "@/lib/redis";
import {
  mergeRedisHashes,
  replaceRedisHashes,
  type RedisHashReplacement,
} from "@/lib/redis-hash";

type SnapshotHashReplacement = {
  labels?: Record<string, AddressEntry>;
  reports?: Record<string, AddressReport>;
};

export async function replaceSnapshotHashes(
  replacement: SnapshotHashReplacement,
): Promise<void> {
  await replaceRedisHashes(getRedis(), snapshotHashReplacements(replacement));
}

export async function importSnapshotHashes(
  replacement: SnapshotHashReplacement,
): Promise<void> {
  await mergeRedisHashes(getRedis(), snapshotHashReplacements(replacement));
}

function snapshotHashReplacements(
  replacement: SnapshotHashReplacement,
): RedisHashReplacement[] {
  const replacements: RedisHashReplacement[] = [];
  if (replacement.labels !== undefined) {
    replacements.push({
      key: LABELS_KEY,
      fields: encodeLabelFields(Object.entries(replacement.labels)),
    });
  }
  if (replacement.reports !== undefined) {
    replacements.push({
      key: REPORTS_KEY,
      fields: encodeReportFields(Object.entries(replacement.reports)),
    });
  }

  return replacements;
}
