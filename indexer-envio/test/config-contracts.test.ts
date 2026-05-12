import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getContractAddress } from "../src/contractAddresses.ts";

const MAINNET_CONFIG = readFileSync(
  new URL("../config.multichain.mainnet.yaml", import.meta.url),
  "utf8",
);

function chainConfigBlock(chainId: number): string {
  const lines = MAINNET_CONFIG.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^  - id: ${chainId}\\b`).test(line),
  );
  assert.notEqual(start, -1, `missing chain ${chainId} in mainnet config`);

  const next = lines.findIndex(
    (line, index) => index > start && /^  - id: \d+\b/.test(line),
  );
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

function configuredContractAddresses(
  chainId: number,
  contractName: string,
): string[] {
  const lines = chainConfigBlock(chainId).split("\n");
  const start = lines.findIndex(
    (line) => line.trim() === `- name: ${contractName}`,
  );
  assert.notEqual(
    start,
    -1,
    `missing ${contractName} in chain ${chainId} config`,
  );

  const next = lines.findIndex(
    (line, index) => index > start && line.startsWith("      - name: "),
  );
  const section = lines.slice(start, next === -1 ? undefined : next);
  return section
    .map((line) => line.match(/^\s+-\s+(0x[0-9a-fA-F]{40})\b/)?.[1])
    .filter((address): address is string => Boolean(address))
    .map((address) => address.toLowerCase());
}

describe("multichain mainnet config", () => {
  it("keeps breaker contract addresses aligned with @mento-protocol/contracts", () => {
    for (const chainId of [42220, 143]) {
      for (const contractName of [
        "BreakerBox",
        "MedianDeltaBreaker",
        "ValueDeltaBreaker",
      ]) {
        const expected = getContractAddress(chainId, contractName);
        assert.ok(
          expected,
          `missing ${contractName} for chain ${chainId} in contracts package`,
        );
        assert.deepEqual(
          configuredContractAddresses(chainId, contractName),
          [expected.toLowerCase()],
          `${chainId} ${contractName}`,
        );
      }
    }
  });
});
