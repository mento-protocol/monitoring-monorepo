import type { PegPolicyVersion } from "./policy.js";
import type { PegRegistry, PegSourceRole } from "./registry.js";

export class PegPolicyCompatibilityError extends Error {}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertSupportedKeys(
  registryKeys: Iterable<string>,
  policyKeys: Iterable<string>,
  location: string,
): void {
  const registry = new Set(registryKeys);
  const unsupported = sorted(policyKeys).filter((key) => !registry.has(key));
  if (unsupported.length > 0) {
    throw new PegPolicyCompatibilityError(
      `${location} policy topology is absent from registry: [${unsupported.join(",")}]`,
    );
  }
}

function assertSourceAuthority(
  assetId: string,
  sourceId: string,
  role: PegSourceRole,
  authority: string,
): void {
  if (authority === "deep" && role !== "primary") {
    throw new PegPolicyCompatibilityError(
      `peg source ${assetId}/${sourceId} deep authority requires primary topology`,
    );
  }
  if (role === "display" && authority !== "display") {
    throw new PegPolicyCompatibilityError(
      `peg source ${assetId}/${sourceId} display topology cannot carry alert authority`,
    );
  }
}

function assertPolicySourceAuthorities(
  registry: PegRegistry,
  policy: PegPolicyVersion,
): void {
  for (const [assetId, assetPolicy] of Object.entries(policy.assets)) {
    const asset = registry[assetId];
    if (asset === undefined) continue;
    for (const [sourceId, sourcePolicy] of Object.entries(
      assetPolicy.sources,
    )) {
      const source = asset.sources.find(({ id }) => id === sourceId);
      if (source === undefined) continue;
      assertSourceAuthority(
        assetId,
        sourceId,
        source.role,
        sourcePolicy.authority,
      );
    }
  }
}

/**
 * Allow a replica whose baked registry is a topology superset to keep serving
 * a version during additive, removal, and cleanup rolling transitions.
 */
export function assertPegPolicyRegistrySupportsPolicy(
  registry: PegRegistry,
  policy: PegPolicyVersion,
): void {
  assertSupportedKeys(
    Object.keys(registry),
    Object.keys(policy.assets),
    "peg assets",
  );
  for (const [assetId, assetPolicy] of Object.entries(policy.assets)) {
    const asset = registry[assetId];
    if (asset === undefined) continue;
    assertSupportedKeys(
      asset.sources.map(({ id }) => id),
      Object.keys(assetPolicy.sources),
      `peg asset ${assetId} sources`,
    );
  }
  assertPolicySourceAuthorities(registry, policy);
}
