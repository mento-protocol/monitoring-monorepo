import assert from "node:assert/strict";
import { generateNttAddressManifest } from "../scripts/generateNttAddresses.mjs";
import { analyzeSchemaIndexes } from "../scripts/auditSchemaIndexes.mjs";

const ADDRESS_1 = "0x0000000000000000000000000000000000000001";
const ADDRESS_2 = "0x0000000000000000000000000000000000000002";
const ADDRESS_3 = "0x0000000000000000000000000000000000000003";
const ADDRESS_4 = "0x0000000000000000000000000000000000000004";
const ADDRESS_5 = "0x0000000000000000000000000000000000000005";

describe("generateNttAddresses", () => {
  it("accumulates partial-manifest gaps unless they are allow-listed", () => {
    const fixture = {
      contractsJson: {
        "42220": {
          celo: {
            NttDeployHelperUSDm: { type: "contract", address: ADDRESS_1 },
            USDm: { address: ADDRESS_2, decimals: 6 },
            NttDeployHelperEURm: { type: "contract", address: ADDRESS_3 },
          },
        },
        "999": {
          future: {
            NttDeployHelperUSDm: { type: "contract", address: ADDRESS_4 },
            USDm: { address: ADDRESS_5, decimals: 18 },
          },
        },
      },
      namespaces: {
        "42220": "celo",
        "999": "future",
      },
      wormholeChainIds: {
        42220: 14,
      },
    };

    const blocked = generateNttAddressManifest(fixture);
    assert.deepEqual(blocked.failures.map((failure) => failure.kind).sort(), [
      "token-entry",
      "wormhole-chain-id",
    ]);
    assert.deepEqual(
      blocked.failures.map((failure) => failure.chainId).sort(),
      [42220, 999],
    );

    const allowed = generateNttAddressManifest({
      ...fixture,
      allowedMissingManifestGaps: new Set([
        "token-entry:42220:EURm",
        "wormhole-chain-id:999",
      ]),
    });
    assert.deepEqual(allowed.failures, []);
    assert.deepEqual(allowed.skipped.map((failure) => failure.kind).sort(), [
      "token-entry",
      "wormhole-chain-id",
    ]);
    assert.deepEqual(
      allowed.output.entries.map((entry) => entry.tokenSymbol),
      ["USDm"],
    );
  });
});

describe("auditSchemaIndexes", () => {
  it("requires one usage site to cover a compound index prefix", () => {
    const schema = `
type SameQuery @index(fields: ["chainId", "token"]) {
  id: ID!
  chainId: Int!
  token: String!
}

type SeparateQuery @index(fields: ["chainId", "token"]) {
  id: ID!
  chainId: Int!
  token: String!
}

type PrefixQuery @index(fields: ["chainId", "token", "day"]) {
  id: ID!
  chainId: Int!
  token: String!
  day: Int!
}
`;
    const sources = [
      {
        file: "fixture.graphql",
        text: `
query Same {
  SameQuery(where: { chainId: { _eq: 42220 } }, order_by: { token: asc }) {
    id
  }
}

query SeparateA {
  SeparateQuery(where: { chainId: { _eq: 42220 } }) { id }
}

query SeparateB {
  SeparateQuery(order_by: { token: asc }) { id }
}

query Prefix {
  PrefixQuery(where: { chainId: { _eq: 42220 }, token: { _eq: "USDm" } }) {
    id
  }
}
`,
      },
    ];

    const result = analyzeSchemaIndexes({ schema, sources });

    assert.deepEqual(
      result.referencedCompound.map((index) => index.type).sort(),
      ["PrefixQuery", "SameQuery"],
    );
    assert.deepEqual(
      result.candidateCompound.map((index) => index.type),
      ["SeparateQuery"],
    );
  });
});
