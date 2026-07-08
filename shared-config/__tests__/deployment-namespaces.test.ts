import { describe, expect, it } from "vitest";
import deploymentNamespacesJson from "../deployment-namespaces.json" with { type: "json" };
import DEPLOYMENT_NAMESPACES, {
  DEPLOYMENT_NAMESPACE_CHAIN_IDS,
  deploymentNamespace,
} from "../src/deployment-namespaces";

describe("deployment namespaces", () => {
  it("exports the canonical chain namespace map", () => {
    expect(DEPLOYMENT_NAMESPACES).toEqual(deploymentNamespacesJson);
  });

  it("keeps the typed chain id list in sync with the JSON keys", () => {
    expect([...DEPLOYMENT_NAMESPACE_CHAIN_IDS].sort()).toEqual(
      Object.keys(deploymentNamespacesJson).sort(),
    );
  });

  it("looks up known namespaces by numeric chain id", () => {
    expect(deploymentNamespace(42220)).toBe("mainnet");
    expect(deploymentNamespace(11142220)).toBe("testnet-v2-rc5");
    expect(deploymentNamespace(143)).toBe("mainnet");
    expect(deploymentNamespace(10143)).toBe("testnet-v2-rc5");
  });

  it("returns null for unknown chains", () => {
    expect(deploymentNamespace(99999)).toBeNull();
  });
});
