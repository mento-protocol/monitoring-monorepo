import { load as loadYaml } from "js-yaml";
import { commentMaskedHcl } from "./production-infra-identity-contract/hcl.mjs";
import { stripShellComment } from "./production-infra-identity-contract/workflow-inventory.mjs";
import { isMapping } from "./production-infra-identity-contract/workflow-inventory.mjs";

// This is deliberately a lexical guard, not a shell parser. The source-staging
// boundary has five approved literal deploy callsites. Any other literal
// deploy-shaped text in an executable surface is an unsafe new path, including
// text passed through a shell wrapper or generated script.
const DEPLOY_KINDS = [
  { group: "builds", command: "submit", kind: "builds-submit" },
  { group: "app", command: "deploy", kind: "app-deploy" },
];
const CONTRACT_FIXTURE = "scripts/deploy-staging-contract.test.mjs";
const GCLOUD =
  /(?:^|[^A-Za-z0-9_.-])(?:\/[A-Za-z0-9_./-]+\/)?gcloud(?=$|[^A-Za-z0-9_.-])/gu;

function visitYaml(value, path, callback) {
  callback(value, path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitYaml(entry, `${path}[${index}]`, callback),
    );
    return;
  }
  if (!isMapping(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    visitYaml(entry, path ? `${path}.${key}` : key, callback);
  }
}

export function parseDeployStagingStructuredFile(filePath, contents, errors) {
  try {
    return filePath.endsWith(".json")
      ? JSON.parse(contents)
      : loadYaml(contents);
  } catch (error) {
    errors.push(
      `${filePath}: cannot parse executable source for deploy-staging discovery: ${error.message}`,
    );
    return undefined;
  }
}

function logicalLines(contents) {
  const lines = [];
  let pending = "";
  for (const line of contents.split(/\r?\n/u)) {
    const code = stripShellComment(line);
    const continued = /\\\s*$/u.test(code);
    // Shell joins an escaped newline without inserting a character. Keeping
    // that exact behavior catches static command names split across lines.
    pending += continued ? code.replace(/\\\s*$/u, "") : code;
    if (!continued) {
      lines.push(pending);
      pending = "";
    }
  }
  if (pending) lines.push(pending);
  return lines;
}

function normalize(text) {
  return text
    .replace(/\\(.)/gu, "$1")
    .replace(/["'`]/gu, "")
    .replace(/[\[\](){},:]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function topLevelFragments(text) {
  const fragments = [];
  let start = 0;
  let quote;
  let backtick = false;
  let escaped = false;
  let substitutionDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (backtick) {
      if (character === "`") backtick = false;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "`") {
      backtick = true;
      continue;
    }
    if (substitutionDepth > 0) {
      if (character === "(") substitutionDepth += 1;
      if (character === ")") substitutionDepth -= 1;
      continue;
    }
    if (character === "(" && ["$", "<", ">"].includes(text[index - 1])) {
      substitutionDepth = 1;
      continue;
    }
    if (
      character === ";" ||
      (character === "|" && text[index - 1] !== ">") ||
      (character === "&" && text[index + 1] !== ">")
    ) {
      fragments.push(text.slice(start, index));
      start = index + (text[index + 1] === character ? 2 : 1);
      if (start > index + 1) index += 1;
    }
  }
  fragments.push(text.slice(start));
  return fragments;
}

function kindAfterGcloud(text) {
  const normalized = normalize(text);
  for (const { group, command, kind } of DEPLOY_KINDS) {
    // Flags and their separated values may appear before the group or between
    // the group and command. Deliberately accept any non-command token there:
    // this checker must reject a literal deploy shape rather than model gcloud.
    const pattern = new RegExp(
      `\\b${group}\\b(?:\\s+(?![;&|]\\b)[^\\s]+)*?\\s+${command}\\b`,
      "u",
    );
    if (pattern.test(normalized)) return kind;
  }
  return undefined;
}

function lexicalDeployRecords(filePath, surface, contents) {
  const records = [];
  for (const line of logicalLines(contents)) {
    for (const fragment of topLevelFragments(line)) {
      const normalizedFragment = normalize(fragment);
      for (const match of normalizedFragment.matchAll(GCLOUD)) {
        const suffix = normalizedFragment.slice(
          (match.index ?? 0) + match[0].length,
        );
        const kind = kindAfterGcloud(suffix);
        if (!kind) continue;
        records.push({
          filePath,
          surface,
          kind,
          normalized: `${match[0]}${suffix}`,
          raw: fragment,
        });
      }
    }
  }
  return records;
}

function structuredGcloudRecord(filePath, path, value) {
  if (
    !isMapping(value) ||
    !/^gcr\.io\/cloud-builders\/gcloud(?::|@|$)/u.test(value.name) ||
    !Array.isArray(value.args)
  ) {
    return undefined;
  }
  const args = value.args.map(String);
  const kind = kindAfterGcloud(args.join(" "));
  if (!kind) return undefined;
  return {
    filePath,
    surface: `${path}.args`,
    kind,
    args,
    normalized: normalize(`gcloud ${args.join(" ")}`),
  };
}

function structuredEntryPointRecords(filePath, path, value) {
  if (
    !isMapping(value) ||
    typeof value.entrypoint !== "string" ||
    !Array.isArray(value.args)
  ) {
    return [];
  }
  return lexicalDeployRecords(
    filePath,
    `${path}.entrypoint+args`,
    `${value.entrypoint} ${value.args.map(String).join(" ")}`,
  );
}

function structuredRecords(filePath, contents, errors) {
  // JSON configuration files such as tsconfig may intentionally use comments.
  // They cannot contain a deploy signature when they do not contain gcloud.
  if (filePath.endsWith(".json") && !contents.includes("gcloud")) return [];
  const document = parseDeployStagingStructuredFile(filePath, contents, errors);
  if (document === undefined) return [];
  const records = [];
  visitYaml(document, "", (value, path) => {
    if (typeof value === "string") {
      records.push(...lexicalDeployRecords(filePath, path, value));
    }
    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      records.push(...lexicalDeployRecords(filePath, path, value.join(" ")));
    }
    const gcloud = structuredGcloudRecord(filePath, path, value);
    if (gcloud) records.push(gcloud);
    records.push(...structuredEntryPointRecords(filePath, path, value));
  });
  return records;
}

const FILE_DISCOVERY_CACHE = new Map();

function discoverDeployStagingFile(filePath, contents) {
  let byContents = FILE_DISCOVERY_CACHE.get(filePath);
  if (!byContents) {
    byContents = new Map();
    FILE_DISCOVERY_CACHE.set(filePath, byContents);
  }
  const cached = byContents.get(contents);
  if (cached) return cached;

  const records = [];
  const errors = [];
  // The centralized fixture deliberately contains forbidden examples. It is
  // the one non-production executable surface excluded from self-scanning.
  if (filePath !== CONTRACT_FIXTURE) {
    if (filePath.endsWith(".tf")) {
      records.push(
        ...lexicalDeployRecords(
          filePath,
          "terraform",
          commentMaskedHcl(contents),
        ),
      );
    } else if (filePath.endsWith("package.json")) {
      const packageJson = parseDeployStagingStructuredFile(
        filePath,
        contents,
        errors,
      );
      if (isMapping(packageJson?.scripts)) {
        for (const [name, command] of Object.entries(packageJson.scripts)) {
          if (typeof command === "string") {
            records.push(
              ...lexicalDeployRecords(filePath, `scripts.${name}`, command),
            );
          }
        }
      }
    } else if (
      filePath.endsWith(".yml") ||
      filePath.endsWith(".yaml") ||
      filePath.endsWith(".json")
    ) {
      records.push(...structuredRecords(filePath, contents, errors));
    } else {
      records.push(...lexicalDeployRecords(filePath, "shell", contents));
    }
  }

  const result = { errors, records };
  byContents.set(contents, result);
  return result;
}

export function discoverDeployStagingCallsites(files, errors = []) {
  const records = [];
  for (const [filePath, contents] of Object.entries(files)) {
    const discovered = discoverDeployStagingFile(filePath, contents);
    records.push(...discovered.records);
    errors.push(...discovered.errors);
  }
  return records;
}
