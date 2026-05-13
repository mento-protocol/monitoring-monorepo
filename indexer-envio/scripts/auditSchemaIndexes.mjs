#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const schemaPath = join(repoRoot, "indexer-envio/schema.graphql");
const sourceRoots = [
  "indexer-envio/src",
  "ui-dashboard/src",
  "metrics-bridge/src",
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
    } else if (/\.(ts|tsx|graphql)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function readProjectSources() {
  return sourceRoots
    .flatMap((root) => walk(join(repoRoot, root)))
    .map((file) => ({
      file,
      text: readFileSync(file, "utf8"),
    }));
}

function addUsage(map, type, field, reason) {
  if (!type || !field) return;
  const key = `${type}.${field}`;
  const reasons = map.get(key) ?? new Set();
  reasons.add(reason);
  map.set(key, reasons);
}

function findMatching(text, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === openChar) depth += 1;
    if (char === closeChar) depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

function extractFieldsFromObject(body) {
  const fields = new Set();
  const regex = /([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  for (const match of body.matchAll(regex)) {
    const field = match[1];
    if (field.startsWith("_")) continue;
    if (["asc", "desc", "nulls_first", "nulls_last"].includes(field)) {
      continue;
    }
    fields.add(field);
  }
  return fields;
}

function extractGraphqlArgument(callText, argumentName) {
  const start = callText.indexOf(`${argumentName}:`);
  if (start === -1) return null;
  const valueStart = start + argumentName.length + 1;
  const first = callText.slice(valueStart).search(/[{\[]/);
  if (first === -1) return null;
  const openIndex = valueStart + first;
  const openChar = callText[openIndex];
  const closeChar = openChar === "{" ? "}" : "]";
  const closeIndex = findMatching(callText, openIndex, openChar, closeChar);
  if (closeIndex === -1) return null;
  return callText.slice(openIndex, closeIndex + 1);
}

function extractGraphqlUsages(sources, schemaTypes) {
  const usages = new Map();
  const dynamicWhereTypes = new Set();

  for (const { text } of sources) {
    for (const type of schemaTypes) {
      const callRegex = new RegExp(`\\b${type}\\s*\\(`, "g");
      for (const match of text.matchAll(callRegex)) {
        const openIndex = text.indexOf("(", match.index);
        const closeIndex = findMatching(text, openIndex, "(", ")");
        if (closeIndex === -1) continue;
        const callText = text.slice(match.index, closeIndex + 1);

        if (/\$where\b/.test(callText)) {
          dynamicWhereTypes.add(type);
        }
        if (/order_by\s*:\s*\$[A-Za-z_][A-Za-z0-9_]*/.test(callText)) {
          dynamicWhereTypes.add(type);
        }

        for (const field of extractFieldsFromObject(
          extractGraphqlArgument(callText, "where") ?? "",
        )) {
          addUsage(usages, type, field, "graphql:where");
        }
        for (const field of extractFieldsFromObject(
          extractGraphqlArgument(callText, "order_by") ?? "",
        )) {
          addUsage(usages, type, field, "graphql:order_by");
        }

        const distinct = /distinct_on\s*:\s*\[([^\]]+)\]/.exec(callText);
        if (distinct) {
          for (const field of distinct[1]
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)) {
            addUsage(usages, type, field, "graphql:distinct_on");
          }
        }
      }
    }
  }

  return { usages, dynamicWhereTypes };
}

function extractDiscoveryTargetUsages(sources) {
  const usages = new Map();
  const objectRegex = /\{[^{}]*\}/g;
  const property = (body, name, pattern) =>
    new RegExp(`\\b${name}\\s*:\\s*"(${pattern})"`).exec(body)?.[1] ?? null;

  for (const { text } of sources) {
    for (const match of text.matchAll(objectRegex)) {
      const objectText = match[0];
      const table = property(objectText, "table", "[A-Z][A-Za-z0-9_]*");
      const field = property(objectText, "field", "[A-Za-z_][A-Za-z0-9_]*");
      const chainIdColumn = property(
        objectText,
        "chainIdColumn",
        "[A-Za-z_][A-Za-z0-9_]*",
      );
      if (!table || !field || !chainIdColumn) continue;
      addUsage(usages, table, chainIdColumn, "dynamic-discovery:where");
      addUsage(usages, table, field, "dynamic-discovery:distinct_order");
    }
  }

  return usages;
}

function extractHandlerGetWhereUsages(sources) {
  const usages = new Map();
  const regex =
    /(?:context|args\.context|\([^)]*context[^)]*\))\.([A-Z][A-Za-z0-9_]*)\.getWhere\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  for (const { text } of sources) {
    for (const match of text.matchAll(regex)) {
      const entity = match[1];
      for (const field of extractFieldsFromObject(match[2])) {
        addUsage(usages, entity, field, "handler:getWhere");
      }
    }
  }
  return usages;
}

function mergeUsageMaps(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [key, reasons] of map) {
      const target = merged.get(key) ?? new Set();
      for (const reason of reasons) target.add(reason);
      merged.set(key, target);
    }
  }
  return merged;
}

function parseSchemaIndexes() {
  const schema = readFileSync(schemaPath, "utf8");
  const singleFieldIndexes = [];
  const compoundIndexes = [];
  const schemaTypes = new Set();
  let currentType = null;

  function collectCompoundIndexes(type, line, lineNumber) {
    const compoundMatches = line.matchAll(
      /@index\s*\(\s*fields:\s*\[([^\]]+)\]/g,
    );
    for (const compoundMatch of compoundMatches) {
      compoundIndexes.push({
        type,
        fields: Array.from(compoundMatch[1].matchAll(/"([^"]+)"/g)).map(
          (match) => match[1],
        ),
        line: lineNumber,
      });
    }
  }

  for (const [index, line] of schema.split("\n").entries()) {
    const lineNumber = index + 1;
    const typeMatch = /^type\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (typeMatch) {
      currentType = typeMatch[1];
      schemaTypes.add(currentType);
      collectCompoundIndexes(currentType, line, lineNumber);
      continue;
    }
    if (currentType) {
      collectCompoundIndexes(currentType, line, lineNumber);
    }
    if (currentType && /^}/.test(line)) {
      currentType = null;
      continue;
    }
    if (!currentType || !line.includes("@index")) continue;
    const fieldMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (fieldMatch) {
      singleFieldIndexes.push({
        type: currentType,
        field: fieldMatch[1],
        line: lineNumber,
      });
    }
  }

  return { singleFieldIndexes, compoundIndexes, schemaTypes };
}

const { singleFieldIndexes, compoundIndexes, schemaTypes } =
  parseSchemaIndexes();
const sources = readProjectSources();
const { usages: graphqlUsages, dynamicWhereTypes } = extractGraphqlUsages(
  sources,
  schemaTypes,
);
const handlerUsages = extractHandlerGetWhereUsages(sources);
const discoveryUsages = extractDiscoveryTargetUsages(sources);
const usages = mergeUsageMaps(graphqlUsages, discoveryUsages, handlerUsages);

const referenced = [];
const candidates = [];
const uncertain = [];
for (const index of singleFieldIndexes) {
  const key = `${index.type}.${index.field}`;
  const reasons = usages.get(key);
  if (reasons) {
    referenced.push({ ...index, reasons: Array.from(reasons).sort() });
  } else if (dynamicWhereTypes.has(index.type)) {
    uncertain.push(index);
  } else {
    candidates.push(index);
  }
}

const referencedCompound = [];
const candidateCompound = [];
const uncertainCompound = [];
for (const index of compoundIndexes) {
  if (dynamicWhereTypes.has(index.type)) {
    uncertainCompound.push(index);
    continue;
  }
  const fieldUsages = index.fields.map((field) =>
    usages.get(`${index.type}.${field}`),
  );
  if (fieldUsages.every(Boolean)) {
    referencedCompound.push({
      ...index,
      reasons: fieldUsages.flatMap((reasons) => Array.from(reasons ?? [])),
    });
  } else {
    candidateCompound.push(index);
  }
}

console.log("Schema index audit");
console.log(`schema: ${relative(repoRoot, schemaPath)}`);
console.log(`source roots: ${sourceRoots.join(", ")}`);
console.log(`types: ${schemaTypes.size}`);
console.log(`single-field @index directives: ${singleFieldIndexes.length}`);
console.log(`compound @index directives: ${compoundIndexes.length}`);
console.log(`referenced single-field indexes: ${referenced.length}`);
console.log(`manual-review dynamic-$where indexes: ${uncertain.length}`);
console.log(`candidate unused single-field indexes: ${candidates.length}`);
console.log(`referenced compound indexes: ${referencedCompound.length}`);
console.log(
  `manual-review dynamic compound indexes: ${uncertainCompound.length}`,
);
console.log(`candidate unused compound indexes: ${candidateCompound.length}`);

if (candidates.length > 0) {
  console.log("\nCandidates not referenced by local getWhere or GraphQL args:");
  for (const { type, field, line } of candidates) {
    console.log(
      `- ${type}.${field} (${relative(repoRoot, schemaPath)}:${line})`,
    );
  }
}

if (candidateCompound.length > 0) {
  console.log(
    "\nCompound candidates not fully referenced by local getWhere or GraphQL args:",
  );
  for (const { type, fields, line } of candidateCompound) {
    console.log(
      `- ${type}(${fields.join(", ")}) (${relative(repoRoot, schemaPath)}:${line})`,
    );
  }
}

if (uncertain.length > 0) {
  console.log("\nManual review required; entity is queried through $where:");
  for (const { type, field, line } of uncertain) {
    console.log(
      `- ${type}.${field} (${relative(repoRoot, schemaPath)}:${line})`,
    );
  }
}

if (uncertainCompound.length > 0) {
  console.log(
    "\nManual review required; compound entity uses dynamic queries:",
  );
  for (const { type, fields, line } of uncertainCompound) {
    console.log(
      `- ${type}(${fields.join(", ")}) (${relative(repoRoot, schemaPath)}:${line})`,
    );
  }
}
