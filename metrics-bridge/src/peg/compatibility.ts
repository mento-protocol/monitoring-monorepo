import type { PegPolicyVersion } from "./policy.js";
import type { PegRegistry, PegSourceRole } from "./registry.js";

const authorityByRole = {
  primary: "deep",
  secondary: "secondary",
  display: "display",
} as const satisfies Record<PegSourceRole, string>;

export class PegPolicyCompatibilityError extends Error {}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertSameKeys(
  registryKeys: Iterable<string>,
  policyKeys: Iterable<string>,
  location: string,
): void {
  const registry = sorted(registryKeys);
  const policy = sorted(policyKeys);
  if (
    registry.length !== policy.length ||
    registry.some((value, index) => value !== policy[index])
  ) {
    throw new PegPolicyCompatibilityError(
      `${location} registry/policy mismatch: registry=[${registry.join(",")}] policy=[${policy.join(",")}]`,
    );
  }
}

/**
 * Prevent an old producer from acknowledging policy for topology it cannot
 * serve. The protected artifact and baked registry must describe the exact
 * same active asset/source set before any version-labeled metrics are emitted.
 */
export function assertPegPolicyRegistryCompatibility(
  registry: PegRegistry,
  policy: PegPolicyVersion,
): void {
  assertSameKeys(
    Object.keys(registry),
    Object.keys(policy.assets),
    "peg assets",
  );

  for (const [assetId, asset] of Object.entries(registry)) {
    const assetPolicy = policy.assets[assetId];
    if (assetPolicy === undefined) {
      throw new PegPolicyCompatibilityError(
        `peg asset ${assetId} is absent from active policy`,
      );
    }
    assertSameKeys(
      asset.sources.map(({ id }) => id),
      Object.keys(assetPolicy.sources),
      `peg asset ${assetId} sources`,
    );

    for (const source of asset.sources) {
      const sourcePolicy = assetPolicy.sources[source.id];
      if (sourcePolicy === undefined) {
        throw new PegPolicyCompatibilityError(
          `peg source ${assetId}/${source.id} is absent from active policy`,
        );
      }
      const expectedAuthority = authorityByRole[source.role];
      if (sourcePolicy.authority !== expectedAuthority) {
        throw new PegPolicyCompatibilityError(
          `peg source ${assetId}/${source.id} requires ${expectedAuthority} authority for ${source.role} topology`,
        );
      }
    }
  }
}
