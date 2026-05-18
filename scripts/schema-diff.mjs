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

const base = loadSchema(baseFile);
const head = loadSchema(headFile);

const breaking = findBreakingChanges(base, head);
const dangerous = findDangerousChanges(base, head);

if (breaking.length === 0 && dangerous.length === 0) {
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

console.log(lines.join("\n"));
process.exit(0);
