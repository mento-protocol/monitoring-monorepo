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
const GCLOUD_PROGRAMMATIC_CMD =
  /(?:^|[^A-Za-z0-9_.-])(?:\/[A-Za-z0-9_./-]+\/)?[gG][cC][lL][oO][uU][dD]\.[cC][mM][dD](?=$|[^A-Za-z0-9_.-])/gu;
const GCLOUD_TEXT = /gcloud(?:\.cmd)?/iu;
const PROGRAMMATIC_EXECUTION_MEMBERS = new Set([
  "Command",
  "command",
  "commandSync",
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "execa",
  "execaSync",
  "spawn",
  "spawnSync",
]);

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

function visitYaml(value, path, callback, key) {
  callback(value, path, key);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitYaml(entry, `${path}[${index}]`, callback, index),
    );
    return;
  }
  if (!isMapping(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    visitYaml(entry, path ? `${path}.${key}` : key, callback, key);
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

function shellModeForFile(filePath) {
  if (isPowerShellSource(filePath)) return "powershell";
  if (isBatchSource(filePath)) return "cmd";
  return "unix";
}

function logicalLines(
  filePath,
  contents,
  shellMode = shellModeForFile(filePath),
) {
  const lines = [];
  let pending = "";
  const continuation =
    shellMode === "powershell"
      ? /`\s*$/u
      : shellMode === "cmd"
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

function flattenStaticShellTemplate(contents) {
  return contents
    .split(/\r?\n/u)
    .map((line) => {
      const code = stripShellComment(line);
      return code === line ? line : `${code};`;
    })
    .join(" ");
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

function lexicalDeployRecords(filePath, surface, contents, shellMode) {
  const records = [];
  const resolvedShellMode = shellMode ?? shellModeForFile(filePath);
  const windowsShell = resolvedShellMode !== "unix";
  const scans = windowsShell
    ? [{ matcher: GCLOUD_WINDOWS, stripBackslashEscapes: false }]
    : [{ matcher: GCLOUD, stripBackslashEscapes: true }];
  if (!windowsShell && surface === "programmatic") {
    scans.push({
      matcher: GCLOUD_PROGRAMMATIC_CMD,
      stripBackslashEscapes: false,
    });
  }
  for (const line of logicalLines(filePath, contents, resolvedShellMode)) {
    for (const fragment of topLevelFragments(line)) {
      const seen = new Set();
      for (const { matcher, stripBackslashEscapes } of scans) {
        const normalizedFragment = normalize(fragment, stripBackslashEscapes);
        for (const match of normalizedFragment.matchAll(matcher)) {
          const suffix = normalizedFragment.slice(
            (match.index ?? 0) + match[0].length,
          );
          const kind = kindAfterGcloud(suffix);
          if (!kind) continue;
          const key = `${kind}\0${match[0]}\0${suffix}`;
          if (seen.has(key)) continue;
          seen.add(key);
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

function unwrapStaticExpression(node) {
  let expression = node;
  while (
    expression !== undefined &&
    (ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression))
  ) {
    expression = expression.expression;
  }
  return expression;
}

function staticMemberReference(node) {
  const expression = unwrapStaticExpression(node);
  if (expression === undefined) return undefined;
  if (ts.isPropertyAccessExpression(expression)) {
    return {
      object: expression.expression,
      propertyName: expression.name.text,
    };
  }
  if (!ts.isElementAccessExpression(expression)) return undefined;
  const property = unwrapStaticExpression(expression.argumentExpression);
  if (
    property === undefined ||
    (!ts.isStringLiteral(property) &&
      !ts.isNoSubstitutionTemplateLiteral(property))
  ) {
    return undefined;
  }
  return { object: expression.expression, propertyName: property.text };
}

function isStaticReference(node) {
  const expression = unwrapStaticExpression(node);
  return (
    expression !== undefined &&
    (ts.isIdentifier(expression) ||
      staticMemberReference(expression) !== undefined)
  );
}

function acceptsResolvedCommandReferences(node) {
  const expression = unwrapStaticExpression(node.expression);
  return (
    expression !== undefined &&
    (ts.isIdentifier(expression) || isProgrammaticExecutionMember(expression))
  );
}

function isProgrammaticExecutionMember(expression) {
  if (ts.isPropertyAccessExpression(expression)) {
    return PROGRAMMATIC_EXECUTION_MEMBERS.has(expression.name.text);
  }
  if (!ts.isElementAccessExpression(expression)) return false;
  const member = unwrapStaticExpression(expression.argumentExpression);
  return (
    member !== undefined &&
    (ts.isStringLiteral(member) ||
      ts.isNoSubstitutionTemplateLiteral(member)) &&
    PROGRAMMATIC_EXECUTION_MEMBERS.has(member.text)
  );
}

function createStaticResolver(sourceFile) {
  const options = {
    allowJs: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = {
    fileExists: (fileName) => fileName === sourceFile.fileName,
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "",
    getNewLine: () => "\n",
    getSourceFile: (fileName) =>
      fileName === sourceFile.fileName ? sourceFile : undefined,
    readFile: (fileName) =>
      fileName === sourceFile.fileName ? sourceFile.text : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  const program = ts.createProgram({
    rootNames: [sourceFile.fileName],
    options,
    host,
  });
  const checker = program.getTypeChecker();
  const resolving = new Set();

  return (identifier) => {
    const symbol =
      ts.isShorthandPropertyAssignment(identifier.parent) &&
      identifier.parent.name === identifier
        ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
        : checker.getSymbolAtLocation(identifier);
    // JavaScript's binder also records assignment identifiers as declarations.
    // Require one actual binding declaration while ignoring those write sites.
    const declarations = (symbol?.declarations ?? []).filter((declaration) =>
      ts.isVariableDeclaration(declaration),
    );
    if (declarations.length !== 1) return undefined;
    const declaration = declarations[0];
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.getSourceFile() !== sourceFile ||
      !ts.isIdentifier(declaration.name) ||
      declaration.name.text !== identifier.text ||
      declaration.initializer === undefined ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
      resolving.has(declaration)
    ) {
      return undefined;
    }
    resolving.add(declaration);
    return {
      initializer: declaration.initializer,
      release: () => resolving.delete(declaration),
    };
  };
}

function staticString(node, resolveIdentifier) {
  if (node === undefined) return undefined;
  const expression = unwrapStaticExpression(node);
  if (expression === undefined) return undefined;
  if (ts.isIdentifier(expression)) {
    const resolved = resolveIdentifier?.(expression);
    if (resolved === undefined) return undefined;
    try {
      return staticString(resolved.initializer, resolveIdentifier);
    } finally {
      resolved.release();
    }
  }
  const member = staticMemberReference(expression);
  if (member !== undefined) {
    return staticStringProperty(
      member.object,
      member.propertyName,
      resolveIdentifier,
    );
  }
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(expression.left, resolveIdentifier);
    const right = staticString(expression.right, resolveIdentifier);
    return left === undefined || right === undefined
      ? undefined
      : `${left}${right}`;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const interpolation = staticString(span.expression, resolveIdentifier);
      if (interpolation === undefined) return undefined;
      value += interpolation;
      value += span.literal.text;
    }
    return value;
  }
  return undefined;
}

function staticStringArray(node, resolveIdentifier, aggregate = false) {
  const expression = unwrapStaticExpression(node);
  if (expression === undefined) {
    return undefined;
  }
  if (ts.isIdentifier(expression)) {
    const resolved = resolveIdentifier(expression);
    if (resolved === undefined) return undefined;
    try {
      return staticStringArray(resolved.initializer, resolveIdentifier, true);
    } finally {
      resolved.release();
    }
  }
  const member = staticMemberReference(expression);
  if (member !== undefined) {
    return staticStringArrayProperty(
      member.object,
      member.propertyName,
      resolveIdentifier,
    );
  }
  if (!ts.isArrayLiteralExpression(expression)) return undefined;
  const values = [];
  let trusted = !aggregate;
  for (const element of expression.elements) {
    if (ts.isSpreadElement(element)) {
      const spread = staticStringArray(element.expression, resolveIdentifier);
      if (spread === undefined) return undefined;
      values.push(...spread.values);
      // A spread is useful for conservative deploy discovery, but it is a
      // broader evaluation surface than an inline literal argument. Never let
      // it prove that an approved callsite carries the required staging flag.
      trusted = false;
      continue;
    }
    const value = staticString(element, resolveIdentifier);
    if (value === undefined) return undefined;
    // Identifier resolution can pass through a mutable const-bound object
    // property. Keep evaluating it for conservative deploy detection, but
    // only literal-only elements may prove a required staging flag.
    if (staticString(element) === undefined) trusted = false;
    values.push(value);
  }
  return { trusted, values };
}

function staticObjectProperty(expression, propertyName) {
  if (!ts.isObjectLiteralExpression(expression)) return undefined;
  let trusted = true;
  let initializer;
  for (const property of expression.properties) {
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === propertyName
    ) {
      if (initializer !== undefined) return undefined;
      initializer = property.name;
      continue;
    }
    if (
      !ts.isPropertyAssignment(property) ||
      property.name === undefined ||
      ts.isComputedPropertyName(property.name)
    ) {
      trusted = false;
      continue;
    }
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;
    if (name !== propertyName) continue;
    if (initializer !== undefined) return undefined;
    initializer = property.initializer;
  }
  return initializer === undefined ? undefined : { initializer, trusted };
}

function staticStringProperty(node, propertyName, resolveIdentifier) {
  const expression = unwrapStaticExpression(node);
  if (expression === undefined) return undefined;
  if (ts.isIdentifier(expression)) {
    const resolved = resolveIdentifier?.(expression);
    if (resolved === undefined) return undefined;
    try {
      return staticStringProperty(
        resolved.initializer,
        propertyName,
        resolveIdentifier,
      );
    } finally {
      resolved.release();
    }
  }
  const property = staticObjectProperty(expression, propertyName);
  return property === undefined
    ? undefined
    : staticString(property.initializer, resolveIdentifier);
}

function staticStringArrayProperty(node, propertyName, resolveIdentifier) {
  const expression = unwrapStaticExpression(node);
  if (expression === undefined) return undefined;
  if (ts.isIdentifier(expression)) {
    const resolved = resolveIdentifier?.(expression);
    if (resolved === undefined) return undefined;
    try {
      const property = staticStringArrayProperty(
        resolved.initializer,
        propertyName,
        resolveIdentifier,
      );
      return property === undefined
        ? undefined
        : { ...property, trusted: false };
    } finally {
      resolved.release();
    }
  }
  if (!ts.isObjectLiteralExpression(expression)) {
    return undefined;
  }
  const objectProperty = staticObjectProperty(expression, propertyName);
  if (objectProperty === undefined) return undefined;
  const property = staticStringArray(
    objectProperty.initializer,
    resolveIdentifier,
  );
  return property === undefined
    ? undefined
    : { ...property, trusted: property.trusted && objectProperty.trusted };
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

  const resolveIdentifier = createStaticResolver(sourceFile);
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
      const firstArgument =
        staticString(invocationArguments[0], resolveIdentifier) ??
        staticStringProperty(
          invocationArguments[0],
          "command",
          resolveIdentifier,
        );
      if (firstArgument !== undefined) {
        // Resolved aliases passed to arbitrary member methods may be inert
        // data. Literal expressions stay fail-closed for every callee; aliases
        // require either a direct call or a known command-execution member.
        const acceptsFirstArgument =
          !isStaticReference(invocationArguments[0]) ||
          acceptsResolvedCommandReferences(node);
        if (acceptsFirstArgument) {
          const commandRecords = lexicalDeployRecords(
            filePath,
            "programmatic",
            firstArgument.replace(/\r?\n/gu, " "),
          );
          for (const record of commandRecords) {
            if (!existingKinds.has(record.kind)) records.push(record);
          }
        }

        if (acceptsFirstArgument && isGcloudExecutable(firstArgument)) {
          const args =
            staticStringArray(invocationArguments[1], resolveIdentifier) ??
            staticStringArrayProperty(
              invocationArguments[1],
              "args",
              resolveIdentifier,
            ) ??
            staticStringArrayProperty(
              invocationArguments[0],
              "args",
              resolveIdentifier,
            );
          if (args !== undefined) {
            const kind = kindAfterGcloud(args.values.join(" "));
            if (kind && !existingKinds.has(kind)) {
              records.push({
                filePath,
                surface: "programmatic",
                kind,
                args: args.values,
                argsTrusted: args.trusted,
                normalized: normalize(
                  `${firstArgument} ${args.values.join(" ")}`,
                ),
              });
            }
          }
        }
      }

      const commandVector =
        staticStringArray(invocationArguments[0], resolveIdentifier) ??
        staticStringArrayProperty(
          invocationArguments[0],
          "cmd",
          resolveIdentifier,
        );
      if (
        commandVector !== undefined &&
        (!isStaticReference(invocationArguments[0]) ||
          acceptsResolvedCommandReferences(node)) &&
        isGcloudExecutable(commandVector.values[0] ?? "")
      ) {
        const args = commandVector.values.slice(1);
        const kind = kindAfterGcloud(args.join(" "));
        if (kind && !existingKinds.has(kind)) {
          records.push({
            filePath,
            surface: "programmatic",
            kind,
            args,
            argsTrusted: commandVector.trusted,
            normalized: normalize(
              `${commandVector.values[0]} ${args.join(" ")}`,
            ),
          });
        }
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      // A tag is an executable wrapper. Treat unknown tags like unknown calls:
      // they may execute the command or generate a script that does.
      const literalTemplateText = staticString(node.template);
      const templateText =
        literalTemplateText ?? staticString(node.template, resolveIdentifier);
      if (templateText !== undefined) {
        const existingKinds = new Set(
          lexicalDeployRecords(filePath, "shell", node.getText(sourceFile)).map(
            ({ kind }) => kind,
          ),
        );
        const templateRecords = lexicalDeployRecords(
          filePath,
          "programmatic",
          flattenStaticShellTemplate(templateText),
        );
        for (const record of templateRecords) {
          if (!existingKinds.has(record.kind)) {
            records.push({
              ...record,
              flagTrusted: literalTemplateText !== undefined,
            });
          }
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

function structuredStringRecords(filePath, path, value, key) {
  if (
    key !== "run" ||
    !filePath.toLowerCase().startsWith(".github/workflows/")
  ) {
    return lexicalDeployRecords(filePath, path, value);
  }

  // A workflow may select its shell at the step, job, workflow, runner, or
  // expression level. Scan each supported continuation form and keep the mode
  // that discovers the most literal deploys. This stays fail-closed without
  // interpreting GitHub Actions shell inheritance or custom wrapper commands.
  let records = [];
  for (const shellMode of ["unix", "powershell", "cmd"]) {
    const candidate = lexicalDeployRecords(filePath, path, value, shellMode);
    if (candidate.length > records.length) records = candidate;
  }
  return records;
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
  visitYaml(document, "", (value, path, key) => {
    if (typeof value === "string") {
      records.push(...structuredStringRecords(filePath, path, value, key));
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
