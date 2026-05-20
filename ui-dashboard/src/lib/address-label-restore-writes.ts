import { encodeLabelFields, LABELS_KEY } from "@/lib/address-label-fields";
import { encodeReportFields, REPORTS_KEY } from "@/lib/address-report-fields";
import type { AddressEntry } from "@/lib/address-labels-shared";
import type { AddressReport } from "@/lib/address-reports-shared";
import { INTEL_DEEP_KEY, type IntelDeepRecord } from "@/lib/intel-deep";
import {
  INTEL_ENTITIES_KEY,
  type IntelEntityRecord,
} from "@/lib/intel-entities";
import {
  INTEL_ENTITY_CPS_KEY,
  type IntelEntityCpsRecord,
} from "@/lib/intel-entity-cps";
import {
  INTEL_TRANSFERS_KEY,
  type IntelTransfersRecord,
} from "@/lib/intel-transfers";
import { INTEL_WEALTH_KEY, type IntelWealthRecord } from "@/lib/intel-wealth";
import { getRedis } from "@/lib/redis";
import {
  mergeRedisHashes,
  replaceRedisHashes,
  type RedisHashReplacement,
} from "@/lib/redis-hash";

type SnapshotHashReplacement = {
  labels?: Record<string, AddressEntry>;
  reports?: Record<string, AddressReport>;
  intelDeep?: Record<string, IntelDeepRecord>;
  intelTransfers?: Record<string, IntelTransfersRecord>;
  intelWealth?: Record<string, IntelWealthRecord>;
  intelEntities?: Record<string, IntelEntityRecord>;
  intelEntityCps?: Record<string, IntelEntityCpsRecord>;
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

/**
 * Intel records are stored as JSON-encoded values keyed by the record's
 * natural identifier (address for deep/transfers/wealth, slug for entities/
 * entity-cps). No normalization — the backup writes exactly what HSET reads.
 */
function encodeIntelFields<T>(
  records: Record<string, T>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, record] of Object.entries(records)) {
    fields[key] = JSON.stringify(record);
  }
  return fields;
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
  if (replacement.intelDeep !== undefined) {
    replacements.push({
      key: INTEL_DEEP_KEY,
      fields: encodeIntelFields(replacement.intelDeep),
    });
  }
  if (replacement.intelTransfers !== undefined) {
    replacements.push({
      key: INTEL_TRANSFERS_KEY,
      fields: encodeIntelFields(replacement.intelTransfers),
    });
  }
  if (replacement.intelWealth !== undefined) {
    replacements.push({
      key: INTEL_WEALTH_KEY,
      fields: encodeIntelFields(replacement.intelWealth),
    });
  }
  if (replacement.intelEntities !== undefined) {
    replacements.push({
      key: INTEL_ENTITIES_KEY,
      fields: encodeIntelFields(replacement.intelEntities),
    });
  }
  if (replacement.intelEntityCps !== undefined) {
    replacements.push({
      key: INTEL_ENTITY_CPS_KEY,
      fields: encodeIntelFields(replacement.intelEntityCps),
    });
  }

  return replacements;
}
