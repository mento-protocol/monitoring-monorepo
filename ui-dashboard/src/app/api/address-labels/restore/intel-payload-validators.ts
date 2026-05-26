import type { SnapshotHashName } from "@/lib/address-labels/backup-format";
import { isValidAddress } from "@/lib/format";
import { INTEL_ENTITY_SLUG_RE } from "@/lib/intel-entities";

export function validateIntelDeepRecords(
  records: Record<string, unknown>,
): string | null {
  return validateObjectRecordValues("intelDeep", records, (key, record) => {
    if (!isValidAddress(key) || !hasValidAddressField(record, key)) {
      return `contains invalid intelDeep address ${key}`;
    }
    if (
      record.candidate === undefined &&
      record.counterparties === undefined &&
      record.version === undefined
    ) {
      return null;
    }
    if (
      !hasString(record, "fetchedAt") ||
      !hasNumber(record, "version") ||
      !isRecordMap(record.candidate) ||
      !hasValidAddressField(record.candidate, key) ||
      !hasNumber(record.candidate, "priority") ||
      !isStringArray(record.candidate.sources) ||
      !isCounterpartyRecordOrNull(record.counterparties)
    ) {
      return `contains invalid intelDeep payload for ${key}`;
    }
    return null;
  });
}

export function validateIntelTransfersRecords(
  records: Record<string, unknown>,
): string | null {
  return validateObjectRecordValues(
    "intelTransfers",
    records,
    (key, record) => {
      if (!isValidAddress(key) || !hasValidAddressField(record, key)) {
        return `contains invalid intelTransfers address ${key}`;
      }
      if (
        record.transfers === undefined &&
        record.transferCount === undefined
      ) {
        return null;
      }
      if (
        !hasString(record, "fetchedAt") ||
        !hasNumber(record, "transferCount") ||
        !isTransferArrayOrNull(record.transfers)
      ) {
        return `contains invalid intelTransfers payload for ${key}`;
      }
      return null;
    },
  );
}

export function validateIntelWealthRecords(
  records: Record<string, unknown>,
): string | null {
  return validateObjectRecordValues("intelWealth", records, (key, record) => {
    if (!isValidAddress(key) || !hasValidAddressField(record, key)) {
      return `contains invalid intelWealth address ${key}`;
    }
    if (
      record.sources === undefined &&
      record.balances === undefined &&
      record.portfolio === undefined &&
      record.version === undefined
    ) {
      return null;
    }
    if (
      !hasString(record, "fetchedAt") ||
      !hasNumber(record, "version") ||
      !isStringArray(record.sources) ||
      !isRecordOrNull(record.balances) ||
      !isPortfolioRecordOrNull(record.portfolio)
    ) {
      return `contains invalid intelWealth payload for ${key}`;
    }
    return null;
  });
}

export function validateIntelEntityRecords(
  records: Record<string, unknown>,
): string | null {
  return validateObjectRecordValues("intelEntities", records, (key, record) => {
    if (!INTEL_ENTITY_SLUG_RE.test(key) || record.slug !== key) {
      return `contains invalid intelEntities slug ${key}`;
    }
    if (
      record.name === undefined &&
      record.id === undefined &&
      record.type === undefined &&
      record.customized === undefined &&
      record.populatedTags === undefined
    ) {
      return null;
    }
    if (
      !hasString(record, "fetchedAt") ||
      !hasString(record, "name") ||
      !hasString(record, "id") ||
      !hasString(record, "type") ||
      typeof record.customized !== "boolean" ||
      !isArkhamTagArrayOrNull(record.populatedTags)
    ) {
      return `contains invalid intelEntities payload for ${key}`;
    }
    return null;
  });
}

export function validateIntelEntityCpsRecords(
  records: Record<string, unknown>,
): string | null {
  return validateObjectRecordValues(
    "intelEntityCps",
    records,
    (key, record) => {
      if (!INTEL_ENTITY_SLUG_RE.test(key) || record.slug !== key) {
        return `contains invalid intelEntityCps slug ${key}`;
      }
      if (record.counterparties === undefined) {
        return null;
      }
      if (
        !hasString(record, "fetchedAt") ||
        !isCounterpartyRecordOrNull(record.counterparties)
      ) {
        return `contains invalid intelEntityCps payload for ${key}`;
      }
      return null;
    },
  );
}

function validateObjectRecordValues(
  name: SnapshotHashName,
  records: Record<string, unknown>,
  validateRecord: (
    key: string,
    record: Record<string, unknown>,
  ) => string | null,
): string | null {
  for (const [key, record] of Object.entries(records)) {
    if (!isRecordMap(record)) {
      return `contains invalid ${name} payload for ${key}`;
    }
    const validationError = validateRecord(key, record);
    if (validationError) return validationError;
  }
  return null;
}

function isRecordMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValidAddressField(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return (
    typeof record.address === "string" &&
    isValidAddress(record.address) &&
    record.address.toLowerCase() === key.toLowerCase()
  );
}

function hasString<K extends string>(
  record: Record<string, unknown>,
  key: K,
): record is Record<string, unknown> & Record<K, string> {
  return typeof record[key] === "string" && record[key] !== "";
}

function hasNumber(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "number" && Number.isFinite(record[key]);
}

function isRecordOrNull(value: unknown): boolean {
  return value === null || isRecordMap(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isTransferArrayOrNull(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.every(isTransfer));
}

function isTransfer(value: unknown): boolean {
  if (!isRecordMap(value)) return false;
  return (
    hasString(value, "transactionHash") &&
    isArkhamAddressInfo(value.fromAddress) &&
    isArkhamAddressInfo(value.toAddress) &&
    hasString(value, "tokenSymbol") &&
    hasString(value, "blockTimestamp") &&
    hasNumber(value, "usd") &&
    hasString(value, "chain")
  );
}

function isArkhamAddressInfo(value: unknown): boolean {
  return (
    isRecordMap(value) &&
    hasString(value, "address") &&
    isValidAddress(value.address) &&
    hasString(value, "chain") &&
    typeof value.isUserAddress === "boolean" &&
    typeof value.contract === "boolean"
  );
}

function isPortfolioRecordOrNull(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecordMap(value)) return false;
  return Object.values(value).every(
    (entry) => isRecordMap(entry) && hasNumber(entry, "ts") && "data" in entry,
  );
}

function isCounterpartyRecordOrNull(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecordMap(value)) return false;
  return Object.values(value).every(
    (entries) => Array.isArray(entries) && entries.every(isCounterparty),
  );
}

function isCounterparty(value: unknown): boolean {
  return (
    isRecordMap(value) &&
    isArkhamAddressInfo(value.address) &&
    hasNumber(value, "usd") &&
    hasNumber(value, "transactionCount") &&
    hasString(value, "flow") &&
    isStringArray(value.chains)
  );
}

function isArkhamTagArrayOrNull(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.every(isArkhamTag));
}

function isArkhamTag(value: unknown): boolean {
  return (
    isRecordMap(value) &&
    hasString(value, "id") &&
    hasString(value, "label") &&
    hasNumber(value, "rank") &&
    typeof value.excludeEntities === "boolean" &&
    typeof value.disablePage === "boolean"
  );
}
