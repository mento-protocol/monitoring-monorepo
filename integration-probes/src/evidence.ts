import { normalizeAddress } from "./amounts.js";
import type { AddressEvidence } from "./types.js";

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/g;
const ADDRESS_EXACT_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_PAYLOAD_RE = /^0x(?:[a-fA-F0-9]{2})+$/;
const MENTO_LABEL_RE = /\bmento\b/i;
const LABEL_KEYS = new Set([
  "name",
  "tool",
  "toolName",
  "provider",
  "protocol",
  "source",
  "label",
  "providerType",
]);
const TARGET_KEYS = new Set(["to", "target", "txTarget", "allowanceTarget"]);

export type EvidenceAddressBook = {
  routerAddresses: readonly string[];
  poolAddresses: readonly string[];
};

export type EvidenceResult = {
  passes: boolean;
  evidence: AddressEvidence[];
  sourceLabels: string[];
  txTarget: string | null;
  downstreamProvider: string | null;
};

export function detectEvidence(
  payload: unknown,
  addressBook: EvidenceAddressBook,
): EvidenceResult {
  const routerSet = lowerSet(addressBook.routerAddresses);
  const poolSet = lowerSet(addressBook.poolAddresses);
  const strings = collectStrings(payload);
  const evidence = addressEvidence(strings, routerSet, poolSet);
  const sourceLabels = sourceLabelEvidence(strings);
  const txTarget = findTxTarget(strings);
  const downstreamProvider = firstInterestingLabel(strings);
  const passes = evidence.some(
    (item) => item.type === "router-address" || item.type === "pool-address",
  );

  return {
    passes,
    evidence,
    sourceLabels,
    txTarget,
    downstreamProvider,
  };
}

function addressEvidence(
  strings: readonly StringAtPath[],
  routerSet: ReadonlySet<string>,
  poolSet: ReadonlySet<string>,
): AddressEvidence[] {
  const state: AddressEvidenceState = { out: [], seen: new Set<string>() };
  for (const item of strings) {
    collectAddressEvidence(item, routerSet, poolSet, state);
  }
  return state.out;
}

function sourceLabelEvidence(strings: readonly StringAtPath[]): string[] {
  const labels = new Set<string>();
  for (const item of strings) {
    if (MENTO_LABEL_RE.test(item.value)) labels.add(item.value);
  }
  return [...labels].sort();
}

function firstInterestingLabel(
  strings: readonly StringAtPath[],
): string | null {
  for (const item of strings) {
    if (!LABEL_KEYS.has(item.key)) continue;
    if (item.value.length > 0 && item.value.length <= 80) return item.value;
  }
  return null;
}

function findTxTarget(strings: readonly StringAtPath[]): string | null {
  const target = strings.find(
    (item) => TARGET_KEYS.has(item.key) && ADDRESS_EXACT_RE.test(item.value),
  );
  return target ? normalizeAddress(target.value) : null;
}

type StringAtPath = {
  key: string;
  path: string;
  value: string;
};

type AddressEvidenceState = {
  out: AddressEvidence[];
  seen: Set<string>;
};

function collectAddressEvidence(
  item: StringAtPath,
  routerSet: ReadonlySet<string>,
  poolSet: ReadonlySet<string>,
  state: AddressEvidenceState,
): void {
  for (const match of item.value.matchAll(ADDRESS_RE)) {
    const address = normalizeAddress(match[0]!);
    const type = evidenceType(address, routerSet, poolSet);
    if (!type) continue;
    pushEvidence(type, address, item.path, state);
  }
  collectPackedAddressEvidence(item, routerSet, "router-address", state);
  collectPackedAddressEvidence(item, poolSet, "pool-address", state);
}

function collectPackedAddressEvidence(
  item: StringAtPath,
  addresses: ReadonlySet<string>,
  type: AddressEvidence["type"],
  state: AddressEvidenceState,
): void {
  if (!HEX_PAYLOAD_RE.test(item.value)) return;
  const value = item.value.toLowerCase();
  for (const address of addresses) {
    if (!value.includes(address.slice(2))) continue;
    pushEvidence(type, address, item.path, state);
  }
}

function pushEvidence(
  type: AddressEvidence["type"],
  address: string,
  path: string,
  state: AddressEvidenceState,
): void {
  const key = `${type}:${address}:${path}`;
  if (state.seen.has(key)) return;
  state.seen.add(key);
  state.out.push({ type, value: address, path });
}

function evidenceType(
  address: string,
  routerSet: ReadonlySet<string>,
  poolSet: ReadonlySet<string>,
): AddressEvidence["type"] | null {
  if (routerSet.has(address)) return "router-address";
  if (poolSet.has(address)) return "pool-address";
  return null;
}

type WalkLocation = {
  key: string;
  path: string;
};

type WalkState = {
  out: StringAtPath[];
  seen: Set<unknown>;
};

function collectStrings(payload: unknown): StringAtPath[] {
  const state: WalkState = { out: [], seen: new Set<unknown>() };
  walkStrings(payload, { path: "$", key: "" }, state);
  return state.out;
}

function walkStrings(
  value: unknown,
  location: WalkLocation,
  state: WalkState,
): void {
  if (typeof value === "string") {
    state.out.push({ ...location, value });
    return;
  }
  if (value == null || typeof value !== "object") return;
  if (state.seen.has(value)) return;
  state.seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkStrings(
        item,
        { path: `${location.path}[${index}]`, key: String(index) },
        state,
      ),
    );
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    walkStrings(
      childValue,
      { path: `${location.path}.${childKey}`, key: childKey },
      state,
    );
  }
}

function lowerSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}
