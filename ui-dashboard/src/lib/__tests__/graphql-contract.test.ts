import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSchema,
  FieldsOnCorrectTypeRule,
  parse,
  ScalarLeafsRule,
  validate,
} from "graphql";
import { describe, expect, it } from "vitest";

import * as bridgeQueries from "@/lib/bridge-queries";
import * as broker from "@/lib/queries/broker";
import * as config from "@/lib/queries/config";
import * as liquity from "@/lib/queries/liquity";
import * as lp from "@/lib/queries/lp";
import * as ols from "@/lib/queries/ols";
import * as poolDetail from "@/lib/queries/pool-detail";
import * as poolDetailSchemas from "@/lib/queries/pool-detail-schemas";
import * as pools from "@/lib/queries/pools";
import * as protocol from "@/lib/queries/protocol";
import * as reserveYield from "@/lib/queries/reserve-yield";
import * as stables from "@/lib/queries/stables";
import * as volume from "@/lib/queries/volume";
import * as volumeSchemas from "@/lib/queries/volume-schemas";
import * as volumeVia from "@/lib/queries/volume-via";

// GraphQL contract test: every hand-written query string must select only
// fields that exist in indexer-envio/schema.graphql. Catches indexer field
// renames at CI time instead of at runtime on the dashboard.
//
// Validation runs with ONLY FieldsOnCorrectTypeRule + ScalarLeafsRule.
// Hasura injects arguments (where/order_by/limit/offset) and input types
// (*_bool_exp, *_order_by, numeric) that don't exist in the Envio SDL, so
// argument/known-type/value rules would all false-positive. Do not add rules.

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCHEMA_PATH = join(REPO_ROOT, "indexer-envio", "schema.graphql");

// Keep in sync with ENVIO_STUBS in scripts/schema-diff.mjs.
const ENVIO_STUBS = `
scalar BigInt
scalar Bytes
directive @index(fields: [String!]) repeatable on OBJECT | FIELD_DEFINITION
directive @config(precision: Int) repeatable on FIELD_DEFINITION
`;

const sdl = readFileSync(SCHEMA_PATH, "utf8");

// schema.graphql has no Query root type (Hasura synthesizes it in prod), and
// graphql.validate() requires one — derive root fields from the entity types.
const entityNames = Array.from(
  sdl.matchAll(/^type\s+([A-Za-z0-9_]+)/gm),
  (m) => m[1],
).filter((n): n is string => typeof n === "string");

const querySdl = `type Query {\n${entityNames
  .map((n) => `  ${n}: [${n}!]!\n  ${n}_by_pk(id: String!): ${n}`)
  .join("\n")}\n}`;

const schema = buildSchema(`${ENVIO_STUBS}${sdl}\n${querySdl}`);

const CONTRACT_RULES = [FieldsOnCorrectTypeRule, ScalarLeafsRule];

// Every module that exports hand-written query strings. The barrel
// src/lib/queries.ts only re-exports a subset — import directly.
const QUERY_MODULES: Record<string, Record<string, unknown>> = {
  "bridge-queries": bridgeQueries,
  "queries/broker": broker,
  "queries/config": config,
  "queries/liquity": liquity,
  "queries/lp": lp,
  "queries/ols": ols,
  "queries/pool-detail": poolDetail,
  "queries/pool-detail-schemas": poolDetailSchemas,
  "queries/pools": pools,
  "queries/protocol": protocol,
  "queries/reserve-yield": reserveYield,
  "queries/stables": stables,
  "queries/volume": volume,
  "queries/volume-schemas": volumeSchemas,
  "queries/volume-via": volumeVia,
};

const QUERIES: Array<[string, string]> = [];
for (const [moduleName, mod] of Object.entries(QUERY_MODULES)) {
  for (const [exportName, value] of Object.entries(mod)) {
    if (typeof value === "string" && /\bquery\s+[A-Za-z0-9_]+/.test(value)) {
      QUERIES.push([`${moduleName}.${exportName}`, value]);
    }
  }
}

describe("GraphQL contract: dashboard queries vs indexer-envio/schema.graphql", () => {
  it("discovers the full query surface (guards a silent no-op)", () => {
    expect(QUERIES.length).toBeGreaterThanOrEqual(100);
  });

  it.each(QUERIES)("%s matches the indexer schema", (name, query) => {
    const errors = validate(schema, parse(query), CONTRACT_RULES);
    expect(errors.map((e) => `${name}: ${e.message}`)).toEqual([]);
  });
});
