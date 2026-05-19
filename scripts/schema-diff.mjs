#!/usr/bin/env node
/**
 * GraphQL schema breaking-change detector.
 *
 * Uses graphql's built-in `findBreakingChanges` + `findDangerousChanges` APIs
 * to diff a base schema file against a head schema file and emit a structured
 * Markdown summary to stdout.
 *
 * The Envio schema uses custom scalar types (BigInt, Bytes) and framework
 * directives (@index, @config) that are not part of the standard GraphQL spec.
 * We prepend minimal stub definitions so the standard parser accepts the SDL —
 * the stubs do not affect structural diffing.
 *
 * Usage:
 *   node scripts/schema-diff.mjs <base-schema-path> <head-schema-path>
 *
 * Exit codes:
 *   0  — always (advisory mode; the summary is the signal, not the exit code)
 *
 * Local shortcut: `pnpm code-health:schema-diff` diffs against origin/main.
 */

import { readFileSync } from "node:fs";
import {
  buildSchema,
  findBreakingChanges,
  findDangerousChanges,
  parse,
} from "graphql";

// Envio framework extensions not in standard GraphQL spec.
// `repeatable` is required because @index is used multiple times on the same
// type (once per field, or once per composite-index declaration).
const ENVIO_STUBS = `
scalar BigInt
scalar Bytes
directive @index(fields: [String!]) repeatable on OBJECT | FIELD_DEFINITION
directive @config(precision: Int) repeatable on FIELD_DEFINITION
`;

const [, , baseFile, headFile] = process.argv;

if (!baseFile || !headFile) {
  console.error(
    "Usage: node scripts/schema-diff.mjs <base-schema> <head-schema>",
  );
  process.exit(1);
}

function loadSchema(path) {
  try {
    return buildSchema(ENVIO_STUBS + readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`Failed to parse schema at ${path}: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Extract a map of `directiveName → Array<{ argName: value }>` from a directive
 * list.  Instances are stored as arrays so that repeatable directives (e.g.
 * multiple @index on the same type) are all preserved — a plain-object key
 * would silently overwrite earlier occurrences.
 *
 * @returns {Record<string, Array<Record<string, unknown>>>}
 */
function extractDirectiveArgs(directives) {
  /** @type {Record<string, Array<Record<string, unknown>>>} */
  const map = {};
  for (const dir of directives ?? []) {
    if (!["config", "index"].includes(dir.name.value)) continue;
    const args = {};
    for (const arg of dir.arguments ?? []) {
      args[arg.name.value] =
        arg.value.kind === "ListValue"
          ? arg.value.values.map((v) => v.value)
          : arg.value.value;
    }
    if (!map[dir.name.value]) map[dir.name.value] = [];
    map[dir.name.value].push(args);
  }
  return map;
}

/** @returns {Set<string>} all `TypeName` and `TypeName.fieldName` keys in the SDL */
function extractTypeFieldKeys(sdl) {
  const ast = parse(sdl);
  const keys = new Set();
  for (const def of ast.definitions) {
    if (def.kind !== "ObjectTypeDefinition") continue;
    keys.add(def.name.value);
    for (const field of def.fields ?? []) {
      keys.add(`${def.name.value}.${field.name.value}`);
    }
  }
  return keys;
}

/**
 * Extract a map of directive snapshots keyed by `TypeName` (object-level) or
 * `TypeName.fieldName` (field-level).  This catches applied-directive-argument
 * changes (e.g. lowering @config(precision: 78) to @config(precision: 38) or
 * changing composite @index(fields: [...]) on the type itself) that the
 * standard findBreakingChanges/findDangerousChanges APIs don't compare.
 *
 * @returns {Map<string, Record<string, Array<Record<string, unknown>>>>}
 */
function extractAppliedDirectives(sdl) {
  const ast = parse(sdl);
  /** @type {Map<string, Record<string, Record<string, string>>>} */
  const result = new Map();
  for (const def of ast.definitions) {
    if (def.kind !== "ObjectTypeDefinition") continue;
    // Object-level directives (e.g. `type Foo @index(fields: [...]) { ... }`)
    const typeDirs = extractDirectiveArgs(def.directives);
    if (Object.keys(typeDirs).length > 0) {
      result.set(def.name.value, typeDirs);
    }
    // Field-level directives
    for (const field of def.fields ?? []) {
      if (!field.directives?.length) continue;
      const fieldDirs = extractDirectiveArgs(field.directives);
      if (Object.keys(fieldDirs).length > 0) {
        result.set(`${def.name.value}.${field.name.value}`, fieldDirs);
      }
    }
  }
  return result;
}

/**
 * Compare applied @config / @index directive arguments between base and head
 * schemas and return human-readable descriptions of any changes.
 *
 * Uses per-arg comparison for single-instance directives (readable output) and
 * set-based instance comparison for repeatable directives like @index.
 */
function findDirectiveArgChanges(baseSdl, headSdl) {
  const baseMap = extractAppliedDirectives(baseSdl);
  const headMap = extractAppliedDirectives(headSdl);
  const headKeys = extractTypeFieldKeys(headSdl);
  const changes = [];
  for (const [key, baseDirs] of baseMap) {
    const headDirs = headMap.get(key);
    if (!headDirs) {
      // Skip if the type/field was itself deleted — findBreakingChanges already
      // reports FIELD_REMOVED / TYPE_REMOVED for structural deletions. Only
      // emit here when the type/field still exists but lost its tracked directives.
      if (!headKeys.has(key)) continue;
      for (const dirName of Object.keys(baseDirs)) {
        changes.push(`\`${key}\` — \`@${dirName}\` directive removed`);
      }
      continue;
    }
    for (const dirName of Object.keys(baseDirs)) {
      if (!(dirName in headDirs)) {
        changes.push(`\`${key}\` — \`@${dirName}\` directive removed`);
        continue;
      }
      const baseInstances = baseDirs[dirName];
      const headInstances = headDirs[dirName];
      if (baseInstances.length === 1 && headInstances.length === 1) {
        // Single-instance directive: per-arg comparison for readable output
        const baseArgs = baseInstances[0];
        const headArgs = headInstances[0];
        for (const [argName, baseVal] of Object.entries(baseArgs)) {
          if (!(argName in headArgs)) {
            changes.push(
              `\`${key}\` — \`@${dirName}(${argName})\` argument removed`,
            );
            continue;
          }
          const headVal = headArgs[argName];
          if (JSON.stringify(headVal) !== JSON.stringify(baseVal)) {
            changes.push(
              `\`${key}\` — \`@${dirName}(${argName})\` changed from \`${JSON.stringify(baseVal)}\` to \`${JSON.stringify(headVal)}\``,
            );
          }
        }
        for (const argName of Object.keys(headArgs)) {
          if (!(argName in baseArgs)) {
            changes.push(
              `\`${key}\` — \`@${dirName}(${argName})\` argument added`,
            );
          }
        }
      } else {
        // Repeatable directive: set-based comparison on whole instances
        const baseSet = new Set(baseInstances.map((a) => JSON.stringify(a)));
        const headSet = new Set(headInstances.map((a) => JSON.stringify(a)));
        for (const s of baseSet) {
          if (!headSet.has(s)) {
            changes.push(`\`${key}\` — \`@${dirName}\` instance removed: ${s}`);
          }
        }
        for (const s of headSet) {
          if (!baseSet.has(s)) {
            changes.push(`\`${key}\` — \`@${dirName}\` instance added: ${s}`);
          }
        }
      }
    }
    // Directive kinds present in head but not in base
    for (const dirName of Object.keys(headDirs)) {
      if (!(dirName in baseDirs)) {
        changes.push(`\`${key}\` — \`@${dirName}\` directive added`);
      }
    }
  }
  // Second pass: keys only in headMap — tracked directives added to a
  // type/field that previously had none (baseMap never visits these keys).
  for (const [key, headDirs] of headMap) {
    if (!baseMap.has(key)) {
      for (const dirName of Object.keys(headDirs)) {
        changes.push(`\`${key}\` — \`@${dirName}\` directive added`);
      }
    }
  }
  return changes;
}

const base = loadSchema(baseFile);
const head = loadSchema(headFile);

const baseSdl = ENVIO_STUBS + readFileSync(baseFile, "utf8");
const headSdl = ENVIO_STUBS + readFileSync(headFile, "utf8");

const breaking = findBreakingChanges(base, head);
const dangerous = findDangerousChanges(base, head);
const directiveChanges = findDirectiveArgChanges(baseSdl, headSdl);

if (
  breaking.length === 0 &&
  dangerous.length === 0 &&
  directiveChanges.length === 0
) {
  console.log(
    "## GraphQL Schema Diff\n\nNo breaking or dangerous changes detected.",
  );
  process.exit(0);
}

const lines = ["## GraphQL Schema Diff"];

if (breaking.length > 0) {
  lines.push(
    "",
    `### Breaking changes (${breaking.length})`,
    "",
    "> These changes will break existing Hasura queries or dashboard code that depends on the current schema.",
    "",
  );
  for (const { type, description } of breaking) {
    lines.push(`- **\`${type}\`**: ${description}`);
  }
}

if (dangerous.length > 0) {
  lines.push(
    "",
    `### Dangerous changes (${dangerous.length})`,
    "",
    "> These changes are backward-compatible but may silently alter behaviour (e.g. default-value changes, new optional fields that widen enum or union possibilities).",
    "",
  );
  for (const { type, description } of dangerous) {
    lines.push(`- **\`${type}\`**: ${description}`);
  }
}

if (directiveChanges.length > 0) {
  lines.push(
    "",
    `### Applied directive changes (${directiveChanges.length})`,
    "",
    "> These changes alter Envio-specific directive arguments (e.g. `@config(precision:)`, `@index`) that affect storage precision or indexing behaviour. The standard GraphQL schema-diff APIs do not compare applied directive arguments.",
    "",
  );
  for (const desc of directiveChanges) {
    lines.push(`- ${desc}`);
  }
}

console.log(lines.join("\n"));
process.exit(0);
