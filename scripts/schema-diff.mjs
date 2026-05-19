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
 * Extract a map of `TypeName.fieldName → { directiveName: { argName: value } }`
 * from the raw SDL AST.  This catches applied-directive-argument changes (e.g.
 * lowering @config(precision: 78) to @config(precision: 38)) that the standard
 * findBreakingChanges/findDangerousChanges APIs don't compare.
 */
function extractAppliedDirectives(sdl) {
  const ast = parse(sdl);
  /** @type {Map<string, Record<string, Record<string, string>>>} */
  const result = new Map();
  for (const def of ast.definitions) {
    if (def.kind !== "ObjectTypeDefinition" || !def.fields) continue;
    for (const field of def.fields) {
      if (!field.directives?.length) continue;
      for (const dir of field.directives) {
        if (!["config", "index"].includes(dir.name.value)) continue;
        const key = `${def.name.value}.${field.name.value}`;
        const args = {};
        for (const arg of dir.arguments ?? []) {
          args[arg.name.value] =
            arg.value.kind === "ListValue"
              ? arg.value.values.map((v) => v.value)
              : arg.value.value;
        }
        const existing = result.get(key) ?? {};
        existing[dir.name.value] = args;
        result.set(key, existing);
      }
    }
  }
  return result;
}

/**
 * Compare applied @config / @index directive arguments between base and head
 * schemas and return human-readable descriptions of any changes.
 */
function findDirectiveArgChanges(baseSdl, headSdl) {
  const baseMap = extractAppliedDirectives(baseSdl);
  const headMap = extractAppliedDirectives(headSdl);
  const changes = [];
  for (const [key, baseDirs] of baseMap) {
    const headDirs = headMap.get(key);
    if (!headDirs) continue; // field removal already caught by findBreakingChanges
    for (const [dirName, baseArgs] of Object.entries(baseDirs)) {
      const headArgs = headDirs[dirName] ?? {};
      for (const [argName, baseVal] of Object.entries(baseArgs)) {
        const headVal = headArgs[argName];
        if (JSON.stringify(headVal) !== JSON.stringify(baseVal)) {
          changes.push(
            `\`${key}\` — \`@${dirName}(${argName})\` changed from \`${JSON.stringify(baseVal)}\` to \`${JSON.stringify(headVal)}\``,
          );
        }
      }
      // Arg removed entirely
      for (const argName of Object.keys(baseArgs)) {
        if (!(argName in (headDirs[dirName] ?? {}))) {
          changes.push(
            `\`${key}\` — \`@${dirName}(${argName})\` argument removed`,
          );
        }
      }
    }
    // Directive removed from field
    for (const dirName of Object.keys(baseDirs)) {
      if (!(dirName in (headDirs ?? {}))) {
        changes.push(
          `\`${key}\` — \`@${dirName}\` directive removed from field`,
        );
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
