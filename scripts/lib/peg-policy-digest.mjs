/**
 * The peg policy version-digest contract.
 *
 * A peg policy version string ends in the first 32 lowercase hex characters of
 * the SHA-256 digest of its own content, with the `version` field itself
 * excluded. Two validators enforce that rule from opposite sides — the alert
 * rules linter reads the gated threshold bundle, the peg registry integrity
 * checker reads the same bundle against the service registry and its git
 * lineage — so the digest they compare against must be one definition. They
 * carried byte-identical copies of it until ADR 0064 phase P8.
 *
 * The canonical form sorts object keys recursively before serializing, so a
 * key reorder that changes the file leaves the digest, and therefore the
 * version identity, unchanged.
 */
import { createHash } from "node:crypto";

/** Matches the digest suffix a valid peg policy version string ends with. */
export const POLICY_VERSION_DIGEST_PATTERN = /-([0-9a-f]{32})$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recursivelySortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(recursivelySortObjectKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, recursivelySortObjectKeys(value[key])]),
  );
}

/** Key-order-independent serialization of a policy version, digest included. */
export function pegPolicyVersionFingerprint(policyVersion) {
  return JSON.stringify(recursivelySortObjectKeys(policyVersion));
}

/**
 * The 32-character digest a policy version's own `version` string must carry.
 * Returns null for a non-object, which both callers report as a shape failure.
 */
export function pegPolicyVersionDigest(policyVersion) {
  if (!isRecord(policyVersion)) return null;
  const content = Object.fromEntries(
    Object.entries(policyVersion).filter(([key]) => key !== "version"),
  );
  return createHash("sha256")
    .update(pegPolicyVersionFingerprint(content))
    .digest("hex")
    .slice(0, 32);
}
