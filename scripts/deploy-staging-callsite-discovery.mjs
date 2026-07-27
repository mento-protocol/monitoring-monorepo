import { load as loadYaml } from "js-yaml";
import ts from "typescript";
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
  /(?:^|[^A-Za-z0-9_.-])(?:\/[A-Za-z0-9_./-]+\/)?gcloud(?:\.cmd)?(?=$|[^A-Za-z0-9_.-])/gu;
const GCLOUD_WINDOWS =
  /(?:^|[^A-Za-z0-9_.-])(?:\/[A-Za-z0-9_./-]+\/)?gcloud(?:\.cmd)?(?=$|[^A-Za-z0-9_.-])/giu;
const GCLOUD_TEXT = /gcloud(?:\.cmd)?/iu;

export function isGcloudExecutable(value) {
  const basename = value.split(/[/\\]/u).at(-1) ?? "";
  return basename === "gcloud" || /^gcloud\.cmd$/iu.test(basename);
}

function isPowerShellSource(filePath) {
  return /\.(?:ps1|psm1)$/iu.test(filePath);
}

function isBatchSource(filePath) {
  return /\.(?:bat|cmd)$/iu.test(filePath);
}

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
    return filePath.toLowerCase().endsWith(".json")
      ? JSON.parse(contents)
      : loadYaml(contents);
  } catch (error) {
    errors.push(
      `${filePath}: cannot parse executable source for deploy-staging discovery: ${error.message}`,
    );
    return undefined;
  }
}

function logicalLines(filePath, contents) {
  const lines = [];
  let pending = "";
  const continuation = isPowerShellSource(filePath)
    ? /`\s*$/u
    : isBatchSource(filePath)
      ? /\^\s*$/u
      : /\\\s*$/u;
  for (const line of contents.split(/\r?\n/u)) {
    const code = stripShellComment(line);
    const continued = continuation.test(code);
    // Shell, PowerShell, and batch files join an escaped newline without
    // inserting a character. Keeping that exact behavior catches static
    // command names split across lines.
    pending += continued ? code.replace(continuation, "") : code;
    if (!continued) {
      lines.push(pending);
      pending = "";
    }
  }
  if (pending) lines.push(pending);
  return lines;
}

function normalize(text, stripBackslashEscapes = true) {
  const unescaped = stripBackslashEscapes
    ? text.replace(/\\(.)/gu, "$1")
    : text;
  return unescaped
    .replace(/["'`]/gu, "")
    .replace(/[[\](){},:]/gu, " ")
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
  const windowsShell = isBatchSource(filePath) || isPowerShellSource(filePath);
  const stripBackslashEscapes = !windowsShell;
  for (const line of logicalLines(filePath, contents)) {
    for (const fragment of topLevelFragments(line)) {
      const normalizedFragment = normalize(fragment, stripBackslashEscapes);
      for (const match of normalizedFragment.matchAll(
        windowsShell ? GCLOUD_WINDOWS : GCLOUD,
      )) {
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

function isProgrammaticSource(filePath) {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(filePath);
}

function programmaticScriptKind(filePath) {
  const lowercasePath = filePath.toLowerCase();
  if (lowercasePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lowercasePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:cts|mts|ts)$/u.test(lowercasePath)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function staticString(node) {
  if (node === undefined) return undefined;
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function staticStringArray(node) {
  if (node === undefined || !ts.isArrayLiteralExpression(node)) {
    return undefined;
  }
  const values = [];
  for (const element of node.elements) {
    const value = staticString(element);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

function staticStringArrayProperty(node, propertyName) {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) {
    return undefined;
  }
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;
    if (name === propertyName) {
      return staticStringArray(property.initializer);
    }
  }
  return undefined;
}

function programmaticDeployRecords(filePath, contents, errors) {
  if (!GCLOUD_TEXT.test(contents)) return [];
  const sourceFile = ts.createSourceFile(
    filePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
    programmaticScriptKind(filePath),
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    const message = ts.flattenDiagnosticMessageText(
      sourceFile.parseDiagnostics[0].messageText,
      " ",
    );
    errors.push(
      `${filePath}: cannot parse programmatic source for deploy-staging discovery: ${message}`,
    );
    return [];
  }

  const records = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      // The existing line-level guard deliberately rejects literal deploy
      // shapes even through unknown wrappers. Keep that fail-closed policy
      // while using the AST only to recover shapes split across lines.
      const callText = node.getText(sourceFile);
      const existingKinds = new Set(
        lexicalDeployRecords(filePath, "shell", callText).map(
          ({ kind }) => kind,
        ),
      );
      const invocationArguments = node.arguments ?? [];
      const firstArgument = staticString(invocationArguments[0]);
      if (firstArgument !== undefined) {
        const commandRecords = lexicalDeployRecords(
          filePath,
          "programmatic",
          firstArgument.replace(/\r?\n/gu, " "),
        );
        for (const record of commandRecords) {
          if (!existingKinds.has(record.kind)) records.push(record);
        }

        if (isGcloudExecutable(firstArgument)) {
          const args =
            staticStringArray(invocationArguments[1]) ??
            staticStringArrayProperty(invocationArguments[1], "args");
          if (args !== undefined) {
            const kind = kindAfterGcloud(args.join(" "));
            if (kind && !existingKinds.has(kind)) {
              records.push({
                filePath,
                surface: "programmatic",
                kind,
                args,
                normalized: normalize(`${firstArgument} ${args.join(" ")}`),
              });
            }
          }
        }
      }

      const commandVector = staticStringArray(invocationArguments[0]);
      if (
        commandVector !== undefined &&
        isGcloudExecutable(commandVector[0] ?? "")
      ) {
        const args = commandVector.slice(1);
        const kind = kindAfterGcloud(args.join(" "));
        if (kind && !existingKinds.has(kind)) {
          records.push({
            filePath,
            surface: "programmatic",
            kind,
            args,
            normalized: normalize(`${commandVector[0]} ${args.join(" ")}`),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
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
  if (filePath.toLowerCase().endsWith(".json") && !GCLOUD_TEXT.test(contents)) {
    return [];
  }
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
  const lowercasePath = filePath.toLowerCase();
  // The centralized fixture deliberately contains forbidden examples. It is
  // the one non-production executable surface excluded from self-scanning.
  if (filePath !== CONTRACT_FIXTURE) {
    if (lowercasePath.endsWith(".tf")) {
      records.push(
        ...lexicalDeployRecords(
          filePath,
          "terraform",
          commentMaskedHcl(contents),
        ),
      );
    } else if (lowercasePath.endsWith("package.json")) {
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
      lowercasePath.endsWith(".yml") ||
      lowercasePath.endsWith(".yaml") ||
      lowercasePath.endsWith(".json")
    ) {
      records.push(...structuredRecords(filePath, contents, errors));
    } else if (isProgrammaticSource(filePath)) {
      records.push(...lexicalDeployRecords(filePath, "shell", contents));
      records.push(...programmaticDeployRecords(filePath, contents, errors));
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
