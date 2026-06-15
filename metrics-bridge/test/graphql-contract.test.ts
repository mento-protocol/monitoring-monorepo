import { readFileSync } from "node:fs";
import {
  buildSchema,
  FieldsOnCorrectTypeRule,
  parse,
  ScalarLeafsRule,
  validate,
} from "graphql";
import { describe, expect, it } from "vitest";

import { BRIDGE_CDPS_QUERY } from "../src/cdp-graphql.js";
import {
  BRIDGE_POOLS_OPEN_BREACH_QUERY,
  BRIDGE_POOLS_ORACLE_LINEAGE_QUERY,
  BRIDGE_POOLS_ORACLE_TX_QUERY,
  BRIDGE_POOLS_QUERY,
} from "../src/graphql.js";

// See ui-dashboard/src/lib/__tests__/graphql-contract.test.ts for the full
// rationale. Same rule subset: only FieldsOnCorrectTypeRule + ScalarLeafsRule
// (Hasura-injected args/types would false-positive under any other rule).

// Keep in sync with ENVIO_STUBS in scripts/schema-diff.mjs.
const ENVIO_STUBS = `
scalar BigInt
scalar Bytes
directive @index(fields: [String!]) repeatable on OBJECT | FIELD_DEFINITION
directive @config(precision: Int) repeatable on FIELD_DEFINITION
`;

const sdl = readFileSync(
  new URL("../../indexer-envio/schema.graphql", import.meta.url),
  "utf8",
);

const entityNames = Array.from(
  sdl.matchAll(/^type\s+([A-Za-z0-9_]+)/gm),
  (m) => m[1],
).filter((n): n is string => typeof n === "string");

const querySdl = `type Query {\n${entityNames
  .map((n) => `  ${n}: [${n}!]!\n  ${n}_by_pk(id: String!): ${n}`)
  .join("\n")}\n}`;

const schema = buildSchema(`${ENVIO_STUBS}${sdl}\n${querySdl}`);

const CONTRACT_RULES = [FieldsOnCorrectTypeRule, ScalarLeafsRule];

const QUERIES: Array<[string, string]> = [
  ["BRIDGE_POOLS_QUERY", BRIDGE_POOLS_QUERY],
  ["BRIDGE_POOLS_ORACLE_LINEAGE_QUERY", BRIDGE_POOLS_ORACLE_LINEAGE_QUERY],
  ["BRIDGE_POOLS_OPEN_BREACH_QUERY", BRIDGE_POOLS_OPEN_BREACH_QUERY],
  ["BRIDGE_POOLS_ORACLE_TX_QUERY", BRIDGE_POOLS_ORACLE_TX_QUERY],
  ["BRIDGE_CDPS_QUERY", BRIDGE_CDPS_QUERY],
];

describe("GraphQL contract: metrics-bridge queries vs indexer-envio/schema.graphql", () => {
  it.each(QUERIES)("%s matches the indexer schema", (name, query) => {
    const errors = validate(schema, parse(query), CONTRACT_RULES);
    expect(errors.map((e) => `${name}: ${e.message}`)).toEqual([]);
  });
});
