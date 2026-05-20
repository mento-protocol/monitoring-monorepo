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

export function addUsage(map, type, field, reason) {
  if (!type || !field) return;
  const key = `${type}.${field}`;
  const reasons = map.get(key) ?? new Set();
  reasons.add(reason);
  map.set(key, reasons);
}

function addUsageSite(sites, type, fields, reason) {
  const filteredFields = Array.from(fields).filter(Boolean);
  if (!type || filteredFields.length === 0) return;
  sites.push({
    type,
    fields: new Set(filteredFields),
    reasons: new Set([reason]),
  });
}

function addUsageSet(usages, sites, type, fields, reason) {
  for (const field of fields) {
    addUsage(usages, type, field, reason);
  }
  addUsageSite(sites, type, fields, reason);
}

export function findMatching(text, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === openChar) depth += 1;
    if (char === closeChar) depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

export function extractFieldsFromObject(body) {
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

export function extractGraphqlArgument(callText, argumentName) {
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

export function extractGraphqlUsages(sources, schemaTypes) {
  const usages = new Map();
  const usageSites = [];
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

        const callFields = new Set();
        const callReasons = new Set();
        const whereFields = extractFieldsFromObject(
          extractGraphqlArgument(callText, "where") ?? "",
        );
        addUsageSet(usages, usageSites, type, whereFields, "graphql:where");
        for (const field of whereFields) callFields.add(field);
        if (whereFields.size > 0) callReasons.add("graphql:where");

        const orderByFields = extractFieldsFromObject(
          extractGraphqlArgument(callText, "order_by") ?? "",
        );
        addUsageSet(
          usages,
          usageSites,
          type,
          orderByFields,
          "graphql:order_by",
        );
        for (const field of orderByFields) callFields.add(field);
        if (orderByFields.size > 0) callReasons.add("graphql:order_by");

        const distinct = /distinct_on\s*:\s*\[([^\]]+)\]/.exec(callText);
        if (distinct) {
          const distinctFields = new Set(
            distinct[1]
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          );
          addUsageSet(
            usages,
            usageSites,
            type,
            distinctFields,
            "graphql:distinct_on",
          );
          for (const field of distinctFields) callFields.add(field);
          if (distinctFields.size > 0) callReasons.add("graphql:distinct_on");
        }

        if (callFields.size > 0) {
          usageSites.push({
            type,
            fields: callFields,
            reasons: callReasons,
          });
        }
      }
    }
  }

  return { usages, usageSites, dynamicWhereTypes };
}

export function extractDiscoveryTargetUsages(sources) {
  const usages = new Map();
  const usageSites = [];
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
      addUsageSet(
        usages,
        usageSites,
        table,
        new Set([chainIdColumn]),
        "dynamic-discovery:where",
      );
      addUsageSet(
        usages,
        usageSites,
        table,
        new Set([field]),
        "dynamic-discovery:distinct_order",
      );
      usageSites.push({
        type: table,
        fields: new Set([chainIdColumn, field]),
        reasons: new Set([
          "dynamic-discovery:where",
          "dynamic-discovery:distinct_order",
        ]),
      });
    }
  }

  return { usages, usageSites };
}

export function extractHandlerGetWhereUsages(sources) {
  const usages = new Map();
  const usageSites = [];
  const regex =
    /(?:context|args\.context|\([^)]*context[^)]*\))\.([A-Z][A-Za-z0-9_]*)\.getWhere\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  for (const { text } of sources) {
    for (const match of text.matchAll(regex)) {
      const entity = match[1];
      addUsageSet(
        usages,
        usageSites,
        entity,
        extractFieldsFromObject(match[2]),
        "handler:getWhere",
      );
    }
  }
  return { usages, usageSites };
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

function mergeUsageSites(...siteLists) {
  return siteLists.flat();
}

function compoundIndexReferencedBySite(index, site) {
  if (site.type !== index.type) return false;
  if (index.fields.length === 1) return site.fields.has(index.fields[0]);

  for (
    let prefixLength = index.fields.length;
    prefixLength >= 2;
    prefixLength -= 1
  ) {
    const prefix = index.fields.slice(0, prefixLength);
    if (prefix.every((field) => site.fields.has(field))) return true;
  }
  return false;
}

export function parseSchemaIndexes(schema = readFileSync(schemaPath, "utf8")) {
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

export function analyzeSchemaIndexes({
  schema = readFileSync(schemaPath, "utf8"),
  sources = readProjectSources(),
} = {}) {
  const { singleFieldIndexes, compoundIndexes, schemaTypes } =
    parseSchemaIndexes(schema);
  const {
    usages: graphqlUsages,
    usageSites: graphqlUsageSites,
    dynamicWhereTypes,
  } = extractGraphqlUsages(sources, schemaTypes);
  const { usages: handlerUsages, usageSites: handlerUsageSites } =
    extractHandlerGetWhereUsages(sources);
  const { usages: discoveryUsages, usageSites: discoveryUsageSites } =
    extractDiscoveryTargetUsages(sources);
  const usages = mergeUsageMaps(graphqlUsages, discoveryUsages, handlerUsages);
  const usageSites = mergeUsageSites(
    graphqlUsageSites,
    discoveryUsageSites,
    handlerUsageSites,
  );

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
    const matchingSites = usageSites.filter((site) =>
      compoundIndexReferencedBySite(index, site),
    );
    if (matchingSites.length > 0) {
      referencedCompound.push({
        ...index,
        reasons: Array.from(
          new Set(matchingSites.flatMap((site) => Array.from(site.reasons))),
        ).sort(),
      });
    } else {
      candidateCompound.push(index);
    }
  }

  return {
    singleFieldIndexes,
    compoundIndexes,
    schemaTypes,
    referenced,
    candidates,
    uncertain,
    referencedCompound,
    candidateCompound,
    uncertainCompound,
  };
}

export function main() {
  const {
    singleFieldIndexes,
    compoundIndexes,
    schemaTypes,
    referenced,
    candidates,
    uncertain,
    referencedCompound,
    candidateCompound,
    uncertainCompound,
  } = analyzeSchemaIndexes();

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
    console.log(
      "\nCandidates not referenced by local getWhere or GraphQL args:",
    );
    for (const { type, field, line } of candidates) {
      console.log(
        `- ${type}.${field} (${relative(repoRoot, schemaPath)}:${line})`,
      );
    }
  }

  if (candidateCompound.length > 0) {
    console.log(
      "\nCompound candidates not fully referenced by one local getWhere or GraphQL arg site:",
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
