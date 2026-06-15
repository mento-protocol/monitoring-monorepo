import { readFileSync } from "node:fs";
import {
  buildSchema,
  FieldsOnCorrectTypeRule,
  Kind,
  parse,
  ScalarLeafsRule,
  validate,
  visit,
} from "graphql";
import type { DocumentNode, ObjectValueNode, ValueNode } from "graphql";
import { describe, expect, it } from "vitest";

import { BRIDGE_CDPS_QUERY } from "../src/cdp-graphql.js";
import {
  BRIDGE_POOLS_OPEN_BREACH_QUERY,
  BRIDGE_POOLS_ORACLE_LINEAGE_QUERY,
  BRIDGE_POOLS_ORACLE_TX_QUERY,
  BRIDGE_POOLS_QUERY,
} from "../src/graphql.js";

// See ui-dashboard/src/lib/__tests__/graphql-contract.test.ts for the full
// rationale. Two complementary checks run per query, mirroring that test:
//   1. Output selections — validate() with only FieldsOnCorrectTypeRule +
//      ScalarLeafsRule (Hasura-injected args/types would false-positive under
//      any other rule).
//   2. Argument fields — checkArgumentFields() checks the field names inside
//      where/order_by/distinct_on against the entity SDL. Load-bearing here:
//      three of the four BRIDGE_POOLS_* queries filter
//      `Pool(where: { source: { _like: ... } })` WITHOUT selecting `source`, so
//      the output rules alone would miss a Pool.source rename.
//
// The walker below is a deliberate mirror of the dashboard test's (the two
// contract tests live in different packages; cross-package import of executable
// TS is the fragile path #930 avoided even for the 4-line stub fragment). Keep
// the two in sync — same helper names, same semantics.

// Single source of truth shared with scripts/schema-diff.mjs and the dashboard
// contract test — read via fs so no cross-package import is needed.
const ENVIO_STUBS = readFileSync(
  new URL("../../scripts/envio-schema-stubs.graphql", import.meta.url),
  "utf8",
);

const sdl = readFileSync(
  new URL("../../indexer-envio/schema.graphql", import.meta.url),
  "utf8",
);

// Parse the raw Envio SDL (syntactic only) to map entity → field names. Used by
// both the synthesized Query root and the argument-field walker.
const entityFields = new Map<string, Set<string>>();
for (const def of parse(sdl).definitions) {
  if (def.kind === Kind.OBJECT_TYPE_DEFINITION) {
    entityFields.set(
      def.name.value,
      new Set((def.fields ?? []).map((f) => f.name.value)),
    );
  }
}
const entityNames = [...entityFields.keys()];

const querySdl = `type Query {\n${entityNames
  .map((n) => `  ${n}: [${n}!]!\n  ${n}_by_pk(id: String!): ${n}`)
  .join("\n")}\n}`;

const schema = buildSchema(`${ENVIO_STUBS}${sdl}\n${querySdl}`);

const CONTRACT_RULES = [FieldsOnCorrectTypeRule, ScalarLeafsRule];

// Argument-field walker — mirror of the dashboard test's. Checks only top-level
// field existence per entity root field: recurses _and/_or/_not, never recurses
// operator objects ({_eq}, {_like}) or variable args, so it stays
// false-positive-free on Hasura idioms while catching a rename of a
// filtered-but-unselected field.
function checkField(
  name: string,
  fields: Set<string>,
  entity: string,
  where: "where" | "order_by" | "distinct_on",
  errors: string[],
): void {
  if (!fields.has(name)) {
    errors.push(
      `${where} references "${entity}.${name}" — not a field on ${entity}`,
    );
  }
}

function forEachBoolExp(
  value: ValueNode,
  fn: (obj: ObjectValueNode) => void,
): void {
  if (value.kind === Kind.LIST) {
    for (const item of value.values) {
      if (item.kind === Kind.OBJECT) fn(item);
    }
  } else if (value.kind === Kind.OBJECT) {
    fn(value);
  }
}

function checkBoolExp(
  value: ValueNode,
  fields: Set<string>,
  entity: string,
  errors: string[],
): void {
  if (value.kind !== Kind.OBJECT) return; // variable / unexpected — can't introspect
  for (const f of value.fields) {
    const key = f.name.value;
    if (key === "_and" || key === "_or") {
      forEachBoolExp(f.value, (obj) =>
        checkBoolExp(obj, fields, entity, errors),
      );
    } else if (key === "_not") {
      checkBoolExp(f.value, fields, entity, errors);
    } else if (!key.startsWith("_")) {
      checkField(key, fields, entity, "where", errors);
    }
  }
}

function checkOrderBy(
  value: ValueNode,
  fields: Set<string>,
  entity: string,
  errors: string[],
): void {
  const objs = value.kind === Kind.LIST ? value.values : [value];
  for (const obj of objs) {
    if (obj.kind !== Kind.OBJECT) continue; // variable etc.
    for (const f of obj.fields) {
      checkField(f.name.value, fields, entity, "order_by", errors);
    }
  }
}

function checkDistinctOn(
  value: ValueNode,
  fields: Set<string>,
  entity: string,
  errors: string[],
): void {
  const vals = value.kind === Kind.LIST ? value.values : [value];
  for (const v of vals) {
    if (v.kind === Kind.ENUM)
      checkField(v.value, fields, entity, "distinct_on", errors);
  }
}

function checkArgumentFields(queryAst: DocumentNode): string[] {
  const errors: string[] = [];
  visit(queryAst, {
    Field(node) {
      const fields = entityFields.get(node.name.value);
      if (!fields || !node.arguments) return; // not an entity root field
      const entity = node.name.value;
      for (const arg of node.arguments) {
        const argName = arg.name.value;
        if (argName === "where") {
          checkBoolExp(arg.value, fields, entity, errors);
        } else if (argName === "order_by") {
          checkOrderBy(arg.value, fields, entity, errors);
        } else if (argName === "distinct_on") {
          checkDistinctOn(arg.value, fields, entity, errors);
        }
      }
    },
  });
  return errors;
}

const QUERIES: Array<[string, string]> = [
  ["BRIDGE_POOLS_QUERY", BRIDGE_POOLS_QUERY],
  ["BRIDGE_POOLS_ORACLE_LINEAGE_QUERY", BRIDGE_POOLS_ORACLE_LINEAGE_QUERY],
  ["BRIDGE_POOLS_OPEN_BREACH_QUERY", BRIDGE_POOLS_OPEN_BREACH_QUERY],
  ["BRIDGE_POOLS_ORACLE_TX_QUERY", BRIDGE_POOLS_ORACLE_TX_QUERY],
  ["BRIDGE_CDPS_QUERY", BRIDGE_CDPS_QUERY],
];

describe("GraphQL contract: metrics-bridge queries vs indexer-envio/schema.graphql", () => {
  it.each(QUERIES)("%s matches the indexer schema", (name, query) => {
    const ast = parse(query);
    const outputErrors = validate(schema, ast, CONTRACT_RULES);
    const argErrors = checkArgumentFields(ast);
    expect([
      ...outputErrors.map((e) => `${name}: ${e.message}`),
      ...argErrors.map((m) => `${name}: ${m}`),
    ]).toEqual([]);
  });

  it("argument-field walker flags a filtered-but-unselected field rename", () => {
    // Three BRIDGE_POOLS_* queries filter Pool.source without selecting it;
    // this asserts a rename of that filtered field would be caught.
    const bad = `query Bad { Pool(where: { nopeField: { _like: "%x%" } }) { id } }`;
    const errors = checkArgumentFields(parse(bad));
    expect(errors.join(" ")).toContain("nopeField");
  });
});
