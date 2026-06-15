import { readFileSync } from "node:fs";
import { join } from "node:path";
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

import * as bridgeQueries from "@/lib/bridge-queries";
import {
  buildDistinctQuery,
  DISCOVERY_TARGETS,
} from "@/lib/mento-address-discovery-targets";
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
// Two complementary checks run per query:
//   1. Output selections — graphql.validate() with ONLY FieldsOnCorrectTypeRule
//      + ScalarLeafsRule. Hasura injects arguments (where/order_by/limit/offset)
//      and input types (*_bool_exp, *_order_by, numeric) that don't exist in the
//      Envio SDL, so argument/known-type/value rules would all false-positive.
//      Do not add rules to this set.
//   2. Argument fields — a bespoke AST walker (checkArgumentFields) checks the
//      field names referenced inside where/order_by/distinct_on against the
//      entity's SDL fields. The output rules above structurally CANNOT see these
//      (a `where: { removed: {...} }` filter never selects `removed`), so a
//      rename of a filtered-but-unselected field would otherwise pass silently.

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCHEMA_PATH = join(REPO_ROOT, "indexer-envio", "schema.graphql");
// Single source of truth shared with scripts/schema-diff.mjs and the
// metrics-bridge contract test — read via fs so no cross-package import.
const STUBS_PATH = join(REPO_ROOT, "scripts", "envio-schema-stubs.graphql");

const ENVIO_STUBS = readFileSync(STUBS_PATH, "utf8");
const sdl = readFileSync(SCHEMA_PATH, "utf8");

// Parse the raw Envio SDL (syntactic only — directive applications and custom
// scalar usages don't need definitions to parse) to map entity → field names.
// Used by both the synthesized Query root and the argument-field walker.
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

// schema.graphql has no Query root type (Hasura synthesizes it in prod), and
// graphql.validate() requires one — derive root fields from the entity types.
const querySdl = `type Query {\n${entityNames
  .map((n) => `  ${n}: [${n}!]!\n  ${n}_by_pk(id: String!): ${n}`)
  .join("\n")}\n}`;

const schema = buildSchema(`${ENVIO_STUBS}${sdl}\n${querySdl}`);

const CONTRACT_RULES = [FieldsOnCorrectTypeRule, ScalarLeafsRule];

// Argument-field walker. Hasura's where/order_by/distinct_on name schema fields
// that the query never selects, so the output rules above can't validate them.
// This walks each query AST and checks those field references against the
// entity's real SDL fields. It deliberately checks ONLY top-level field
// existence per entity root field: it skips logical operators (_and/_or/_not,
// recursed), comparison operators ({_eq}, never recursed), and any argument
// passed as a variable (can't introspect). That keeps it false-positive-free on
// the Hasura idioms the output rules avoid, while still catching a rename of a
// filtered-but-unselected field. Nested relationship sub-filters are checked at
// their top-level field name only (the inner fields belong to a different type).
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
      // A real field key. Check existence; do NOT recurse into its operator
      // object ({_eq: ...}) or relationship sub-filter (different type).
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
    // Only `query` operations — the dashboard is read-only, so `mutation` /
    // `subscription` strings are intentionally out of scope here.
    if (typeof value === "string" && /\bquery\s+[A-Za-z0-9_]+/.test(value)) {
      QUERIES.push([`${moduleName}.${exportName}`, value]);
    }
  }
}

// Dynamically-built discovery queries (mento-address-discovery.ts) never appear
// as exported consts, so the module scan above can't see them. Generate them
// from the SAME builder the runtime uses so this covers field/table drift on
// the Arkham/MiniPay discovery cron path.
const DISCOVERY_QUERIES: Array<[string, string]> = DISCOVERY_TARGETS.map(
  (t) => [`discovery.${t.table}.${t.field}`, buildDistinctQuery(t)],
);

const ALL_QUERIES: Array<[string, string]> = [...QUERIES, ...DISCOVERY_QUERIES];

describe("GraphQL contract: dashboard queries vs indexer-envio/schema.graphql", () => {
  it("discovers the full query surface (guards a silent no-op)", () => {
    expect(QUERIES.length).toBeGreaterThanOrEqual(100);
  });

  it("covers every dynamic discovery target", () => {
    expect(DISCOVERY_QUERIES.length).toBe(DISCOVERY_TARGETS.length);
  });

  it.each(ALL_QUERIES)("%s matches the indexer schema", (name, query) => {
    const ast = parse(query);
    const outputErrors = validate(schema, ast, CONTRACT_RULES);
    const argErrors = checkArgumentFields(ast);
    expect([
      ...outputErrors.map((e) => `${name}: ${e.message}`),
      ...argErrors.map((m) => `${name}: ${m}`),
    ]).toEqual([]);
  });
});

describe("GraphQL contract: argument-field walker catches filtered-but-unselected drift", () => {
  it("accepts the real ALL_CDP_POOLS where fields (removed/chainId)", () => {
    expect(checkArgumentFields(parse(ols.ALL_CDP_POOLS))).toEqual([]);
  });

  it("flags a where field that does not exist on the entity", () => {
    const bad = `query Bad { CdpPool(where: { nopeField: { _eq: true } }) { poolId } }`;
    const errors = checkArgumentFields(parse(bad));
    expect(errors.join(" ")).toContain("nopeField");
  });

  it("flags an order_by field that does not exist on the entity", () => {
    const bad = `query Bad { CdpPool(order_by: { nopeField: desc }) { poolId } }`;
    const errors = checkArgumentFields(parse(bad));
    expect(errors.join(" ")).toContain("nopeField");
  });

  it("flags a distinct_on field that does not exist on the entity", () => {
    const bad = `query Bad { SwapEvent(distinct_on: [nopeField]) { id } }`;
    const errors = checkArgumentFields(parse(bad));
    expect(errors.join(" ")).toContain("nopeField");
  });

  it("flags drift nested inside an _and/_or bool-exp", () => {
    const bad = `query Bad { CdpPool(where: { _and: [{ nopeField: { _eq: true } }] }) { poolId } }`;
    const errors = checkArgumentFields(parse(bad));
    expect(errors.join(" ")).toContain("nopeField");
  });
});
