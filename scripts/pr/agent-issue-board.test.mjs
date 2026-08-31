#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { Kind, parse as parseGraphql } from "graphql";
import { load as parseYaml } from "js-yaml";
import ts from "typescript";

import {
  acquireIssueMutationLock,
  buildClaimComment,
  buildBackfillPlan,
  backfill,
  claim,
  chooseUntriedCandidate,
  githubProjectScopeHint,
  issueBodySha256,
  isClaimable,
  isSweepClaimable,
  isBackfillable,
  isReleasable,
  isRecoverableClaimRaceError,
  isReviewable,
  IssueBoardSyncError,
  IssueClaimCandidateLossError,
  ISSUE_STATE_LABELS,
  issueMutationLockRef,
  IssueMutationLockStaleError,
  IssueOwnershipConflictError,
  labelsForState,
  parseArgs,
  parseIssueNumbers,
  projectDateFieldValue,
  projectPrFieldValue,
  parseClaimComment,
  selectNewestTrustedClaim,
  shouldRollbackFailedTransition,
  stateFromLabels,
  sync,
  release,
  releaseIssueMutationLock,
  review,
  validateOpenPr,
  verifyClaimOwnership,
  withIssueMutationLock,
} from "./agent-issue-board.mjs";
import { usage } from "./issue-board-cli.mjs";
import {
  readClaimOwnership,
  reserveClaimOwnership,
  writeProjectOwnershipMetadata,
} from "./issue-board-ownership.mjs";
import {
  findIssueProjectItem,
  getProject,
  PROSPECTIVE_PROJECT_ITEM_ID,
  readBackfillProjectFields,
  readProjectItemStatus,
  readProjectTextField,
  updateProjectMetadata,
  updateTextField,
  writeBackfillProjectFields,
} from "./issue-board-projects.mjs";
import {
  createIssueOwnerProofTestOperations,
  executeIssueOwnerMutation,
  IssueOwnerMutationCapabilityError,
} from "./issue-board-lock.mjs";
import {
  getIssue,
  getPrIssues,
  listIssueComments,
  listIssuesByLabels,
  listOpenPullRequestsForBranch,
} from "./issue-board-transport.mjs";

const EMPTY_BODY_SHA256 = issueBodySha256("");
const UNSAFE_SINGLE_LINE_TEST_CHARACTERS = [
  ["U+2028 line separator", "\u2028"],
  ["U+2029 paragraph separator", "\u2029"],
  ["U+0085 next line control", "\u0085"],
];

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result?.then) {
      pending.push(
        result.then(
          () => {
            process.stdout.write(`ok ${name}\n`);
            passed += 1;
          },
          (err) => {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`not ok ${name}\n  ${message}\n`);
            failed += 1;
          },
        ),
      );
      return;
    }
    process.stdout.write(`ok ${name}\n`);
    passed += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`not ok ${name}\n  ${message}\n`);
    failed += 1;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    // The message is what says WHICH property was being asserted; call sites
    // already pass one, and dropping it left a bare value mismatch to read.
    throw new Error(
      `${message ? `${message}: ` : ""}expected ${JSON.stringify(
        expected,
      )}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDeepEqual(actual, expected) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, got ${actualJson}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const REPO_ROOT = new URL("../../", import.meta.url);

const RUNTIME_MODULE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const RUNTIME_COMPILER_OPTIONS = {
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
};
const OWNER_MUTATION_NAMES = [
  ["clearProjectV2Item", "FieldValue"].join(""),
  ["updateProjectV2Item", "FieldValue"].join(""),
];
const [CLEAR_OWNER_MUTATION_NAME, UPDATE_OWNER_MUTATION_NAME] =
  OWNER_MUTATION_NAMES;
const OWNER_MUTATION_NAME_SET = new Set(OWNER_MUTATION_NAMES);
const OWNER_MUTATION_EXECUTOR_PATH = "scripts/pr/issue-board-projects.mjs";
const OWNER_MUTATION_ADR_PATH =
  "docs/adr/0082-persistent-issue-board-mutation-mutex.md";
const OWNER_MUTATION_ADR_LINES = new Map([
  [UPDATE_OWNER_MUTATION_NAME, `Both \`${UPDATE_OWNER_MUTATION_NAME}\` and`],
  [
    CLEAR_OWNER_MUTATION_NAME,
    `\`${CLEAR_OWNER_MUTATION_NAME}\` must remain in`,
  ],
]);
const OWNER_MUTATION_EXECUTOR_COUNTS = new Map([
  [CLEAR_OWNER_MUTATION_NAME, 1],
  [UPDATE_OWNER_MUTATION_NAME, 2],
]);
const OWNER_MUTATION_TEXT_COUNTS = new Map([
  [
    OWNER_MUTATION_ADR_PATH,
    new Map([
      [CLEAR_OWNER_MUTATION_NAME, 1],
      [UPDATE_OWNER_MUTATION_NAME, 1],
    ]),
  ],
  [OWNER_MUTATION_EXECUTOR_PATH, OWNER_MUTATION_EXECUTOR_COUNTS],
]);
const OWNER_MUTATION_TEXT_PATHS = new Set(OWNER_MUTATION_TEXT_COUNTS.keys());
const OWNER_PROOF_TEST_TRANSPORT_MODULE_PATH =
  "scripts/pr/issue-board-lock.mjs";
const OWNER_PROOF_TEST_TRANSPORT_NAME = "createIssueOwnerProofTestOperations";
const OWNER_PROOF_TEST_TRANSPORT_REFERENCE_PATHS = new Set([
  OWNER_PROOF_TEST_TRANSPORT_MODULE_PATH,
  "scripts/pr/agent-issue-board.test.mjs",
]);
const OWNER_MUTATION_EXECUTORS = new Map([
  [
    "clearProjectField",
    {
      operation: CLEAR_OWNER_MUTATION_NAME,
    },
  ],
  [
    "updateDateField",
    {
      operation: UPDATE_OWNER_MUTATION_NAME,
    },
  ],
  [
    "updateTextField",
    {
      operation: UPDATE_OWNER_MUTATION_NAME,
    },
  ],
]);

const REPOSITORY_PATH_DECODER = new TextDecoder("utf-8", { fatal: true });

function decodeRepositoryPathList(output) {
  assert(Buffer.isBuffer(output), "repository path inventory must be bytes");
  const paths = [];
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index < output.length && output[index] !== 0) continue;
    if (index > start) {
      const pathBytes = output.subarray(start, index);
      let path;
      try {
        path = REPOSITORY_PATH_DECODER.decode(pathBytes);
      } catch (err) {
        throw new Error(
          `Tracked and nonignored path inventory contains invalid UTF-8 at byte ${start}`,
          { cause: err },
        );
      }
      assert(
        Buffer.from(path, "utf8").equals(pathBytes),
        `Tracked and nonignored path inventory changed bytes at byte ${start}`,
      );
      paths.push(path);
    }
    start = index + 1;
  }
  return paths;
}

function repositoryFilePaths() {
  const repoRoot = fileURLToPath(REPO_ROOT);
  return decodeRepositoryPathList(
    execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: repoRoot },
    ),
  )
    .filter((path) => {
      try {
        const stats = lstatSync(join(repoRoot, path));
        return stats.isFile() || stats.isSymbolicLink();
      } catch (err) {
        if (err?.code === "ENOENT") return false;
        throw err;
      }
    })
    .sort();
}

function readRepositorySymlinkTarget(absolutePath, path) {
  const linkBytes = readlinkSync(absolutePath, { encoding: "buffer" });
  let link;
  try {
    link = REPOSITORY_PATH_DECODER.decode(linkBytes);
  } catch (err) {
    throw new Error(`${path} symlink target contains invalid UTF-8`, {
      cause: err,
    });
  }
  assert(
    Buffer.from(link, "utf8").equals(linkBytes),
    `${path} symlink target changed bytes during UTF-8 decoding`,
  );
  return link;
}

function repositorySymlinkTargets(repoRoot, paths) {
  const pathSet = new Set(paths);
  const targets = new Map();
  for (const path of paths) {
    const absolutePath = join(repoRoot, path);
    if (!lstatSync(absolutePath).isSymbolicLink()) continue;
    const link = readRepositorySymlinkTarget(absolutePath, path);
    assert(
      !posix.isAbsolute(link),
      `${path} symlink target must be repository-relative: ${link}`,
    );
    const target = posix.normalize(posix.join(posix.dirname(path), link));
    assert(
      target !== ".." && !target.startsWith("../"),
      `${path} symlink target escapes the repository: ${link}`,
    );
    assert(
      pathSet.has(target),
      `${path} symlink target is not an inventoried file: ${target}`,
    );
    assert(
      lstatSync(join(repoRoot, target)).isFile(),
      `${path} symlink target must be a direct inventoried regular file: ${target}`,
    );
    targets.set(path, target);
  }
  return targets;
}

function repositoryOwnerMutationTextOccurrences(paths, readSource) {
  const occurrences = [];
  for (const path of paths) {
    const source = readSource(path);
    for (const operation of OWNER_MUTATION_NAMES) {
      let offset = 0;
      while (offset < source.length) {
        const index = source.indexOf(operation, offset);
        if (index < 0) break;
        const lineStart = source.lastIndexOf("\n", index - 1) + 1;
        const nextLineBreak = source.indexOf("\n", index);
        const lineEnd = nextLineBreak < 0 ? source.length : nextLineBreak;
        occurrences.push({
          end: index + operation.length,
          index,
          line: source.slice(0, lineStart).split("\n").length,
          lineText: source.slice(lineStart, lineEnd).replace(/\r$/u, ""),
          operation,
          path,
        });
        offset = index + operation.length;
      }
    }
  }
  return occurrences.sort((left, right) =>
    `${left.path}:${String(left.index).padStart(12, "0")}:${left.operation}`.localeCompare(
      `${right.path}:${String(right.index).padStart(12, "0")}:${right.operation}`,
    ),
  );
}

function parsedYaml(path, source) {
  try {
    return parseYaml(source) ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot parse ${path}: ${message}`, { cause: err });
  }
}

function collectYamlRunSurfaces(value, path, surfaces, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectYamlRunSurfaces(entry, path, surfaces, [...trail, index]),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const nextTrail = [...trail, key];
    if (key === "run" && typeof entry === "string") {
      surfaces.push({
        path,
        surface: nextTrail.join("."),
        text: entry,
      });
      continue;
    }
    collectYamlRunSurfaces(entry, path, surfaces, nextTrail);
  }
}

function importReachableRuntimePaths(repoRoot, paths, seedPaths, readSource) {
  const supportedPaths = paths.filter((path) =>
    RUNTIME_MODULE_EXTENSIONS.has(extname(path)),
  );
  const pathByAbsoluteName = new Map(
    supportedPaths.map((path) => [resolve(repoRoot, path), path]),
  );
  const selectedPaths = new Set(seedPaths);
  const pendingPaths = [...seedPaths];
  const canonicalFileName = ts.sys.useCaseSensitiveFileNames
    ? (fileName) => fileName
    : (fileName) => fileName.toLowerCase();
  const moduleResolutionCache = ts.createModuleResolutionCache(
    repoRoot,
    canonicalFileName,
    RUNTIME_COMPILER_OPTIONS,
  );

  for (let index = 0; index < pendingPaths.length; index += 1) {
    const path = pendingPaths[index];
    const containingFile = resolve(repoRoot, path);
    const imports = ts.preProcessFile(
      readSource(path),
      true,
      true,
    ).importedFiles;
    for (const importedFile of imports) {
      const resolvedModule = ts.resolveModuleName(
        importedFile.fileName,
        containingFile,
        RUNTIME_COMPILER_OPTIONS,
        ts.sys,
        moduleResolutionCache,
      ).resolvedModule;
      if (!resolvedModule) continue;
      const importedPath = pathByAbsoluteName.get(
        resolve(resolvedModule.resolvedFileName),
      );
      if (!importedPath || selectedPaths.has(importedPath)) continue;
      selectedPaths.add(importedPath);
      pendingPaths.push(importedPath);
    }
  }

  return [...selectedPaths].sort();
}

function runtimeSurfaces(repoRoot, paths, readSource) {
  const pathSet = new Set(paths);
  const executableTextSurfaces = [];
  const actionManifestPaths = paths.filter((path) =>
    /(?:^|\/)action\.ya?ml$/u.test(path),
  );
  for (const path of actionManifestPaths) {
    const action = parsedYaml(path, readSource(path));
    const runs = action?.runs;
    if (!runs || typeof runs !== "object") continue;
    for (const phase of ["main", "pre", "post"]) {
      if (runs[phase] == null) continue;
      assert(
        typeof runs[phase] === "string",
        `${path} runs.${phase} must be a static path`,
      );
      const entryPath = posix.normalize(
        posix.join(posix.dirname(path), runs[phase]),
      );
      assert(
        !posix.isAbsolute(runs[phase]) &&
          entryPath !== ".." &&
          !entryPath.startsWith("../"),
        `${path} runs.${phase} escapes the repository: ${runs[phase]}`,
      );
      assert(
        pathSet.has(entryPath),
        `${path} runs.${phase} is missing from the tracked and nonignored inventory: ${entryPath}`,
      );
    }
    collectYamlRunSurfaces(runs, path, executableTextSurfaces, ["runs"]);
  }

  for (const path of paths.filter((candidate) =>
    /^\.github\/workflows\/.*\.ya?ml$/u.test(candidate),
  )) {
    collectYamlRunSurfaces(
      parsedYaml(path, readSource(path)),
      path,
      executableTextSurfaces,
    );
  }

  const seedModulePaths = paths.filter((path) =>
    RUNTIME_MODULE_EXTENSIONS.has(extname(path)),
  );
  return {
    executableTextSurfaces,
    modulePaths: importReachableRuntimePaths(
      repoRoot,
      paths,
      seedModulePaths,
      readSource,
    ),
  };
}

function repositoryPackageMains(paths, readSource) {
  const packageMains = new Map();
  for (const path of paths.filter((candidate) =>
    /(?:^|\/)package\.json$/u.test(candidate),
  )) {
    let packageData;
    try {
      packageData = JSON.parse(readSource(path));
    } catch {
      continue;
    }
    if (typeof packageData?.main === "string") {
      packageMains.set(path, packageData.main);
    }
  }
  return packageMains;
}

function runtimeProgramAtRoot(
  repoRoot,
  paths,
  executableTextSurfaces = [],
  repositoryTextOccurrences = [],
  repositoryTextPaths = [],
  symlinkTargets = new Map(),
  packageMains = new Map(),
) {
  const absolutePaths = paths.map((path) => join(repoRoot, path));
  const program = ts.createProgram(absolutePaths, RUNTIME_COMPILER_OPTIONS);
  const sourceFiles = new Map(
    paths.map((path, index) => [
      path,
      program.getSourceFile(absolutePaths[index]),
    ]),
  );
  for (const [path, sourceFile] of sourceFiles) {
    assert(
      sourceFile,
      `TypeScript did not load tracked runtime module ${path}`,
    );
  }
  return {
    checker: program.getTypeChecker(),
    executableTextSurfaces,
    paths,
    repositoryTextOccurrences,
    repositoryTextPaths,
    repositoryPathSet: new Set(repositoryTextPaths),
    packageMains,
    symlinkTargets,
    sourceFiles,
    pathForSourceFile: new Map(
      [...sourceFiles].map(([path, sourceFile]) => [sourceFile, path]),
    ),
  };
}

function repositoryRuntimeProgram() {
  const repoRoot = fileURLToPath(REPO_ROOT);
  const paths = repositoryFilePaths();
  const symlinkTargets = repositorySymlinkTargets(repoRoot, paths);
  const readSource = (path) => readFileSync(join(repoRoot, path), "utf8");
  const readRepositoryText = (path) => {
    const absolutePath = join(repoRoot, path);
    return lstatSync(absolutePath).isSymbolicLink()
      ? readRepositorySymlinkTarget(absolutePath, path)
      : readFileSync(absolutePath, "utf8");
  };
  const surfaces = runtimeSurfaces(repoRoot, paths, readSource);
  return runtimeProgramAtRoot(
    repoRoot,
    surfaces.modulePaths,
    surfaces.executableTextSurfaces,
    repositoryOwnerMutationTextOccurrences(paths, readRepositoryText),
    paths,
    symlinkTargets,
    repositoryPackageMains(paths, readSource),
  );
}

function resolvedSymbol(checker, symbol) {
  const seen = new Set();
  let current = symbol;
  while (current && current.flags & ts.SymbolFlags.Alias) {
    if (seen.has(current)) break;
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function nodeLocation(inventory, node) {
  const sourceFile = node.getSourceFile();
  const path = inventory.pathForSourceFile.get(sourceFile);
  assert(
    path,
    `Source file is outside the runtime inventory: ${sourceFile.fileName}`,
  );
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  return {
    end,
    key: `${path}:${start}:${end}`,
    line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
    path,
    start,
  };
}

function unwrapStaticExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isPartiallyEmittedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticStringExpression(inventory, node, seenSymbols = new Set()) {
  const current = unwrapStaticExpression(node);
  if (
    ts.isStringLiteralLike(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return {
      dependencies: new Set([nodeLocation(inventory, current).key]),
      value: current.text,
    };
  }
  if (ts.isTemplateExpression(current)) {
    const dependencies = new Set([nodeLocation(inventory, current.head).key]);
    let value = current.head.text;
    for (const span of current.templateSpans) {
      const expression = staticStringExpression(
        inventory,
        span.expression,
        seenSymbols,
      );
      if (!expression) return null;
      value += expression.value;
      value += span.literal.text;
      dependencies.add(nodeLocation(inventory, span.literal).key);
      for (const dependency of expression.dependencies) {
        dependencies.add(dependency);
      }
    }
    return { dependencies, value };
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringExpression(inventory, current.left, seenSymbols);
    const right = staticStringExpression(inventory, current.right, seenSymbols);
    if (!left || !right) return null;
    return {
      dependencies: new Set([...left.dependencies, ...right.dependencies]),
      value: left.value + right.value,
    };
  }
  if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) {
    return null;
  }
  const symbol = resolvedSymbol(
    inventory.checker,
    inventory.checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(current) ? current.name : current,
    ),
  );
  if (!symbol || seenSymbols.has(symbol)) return null;
  const nextSeen = new Set(seenSymbols);
  nextSeen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    ) {
      const resolved = staticStringExpression(
        inventory,
        declaration.initializer,
        nextSeen,
      );
      if (resolved) return resolved;
    }
    if (ts.isExportAssignment(declaration)) {
      const resolved = staticStringExpression(
        inventory,
        declaration.expression,
        nextSeen,
      );
      if (resolved) return resolved;
    }
  }
  return null;
}

function graphqlOwnerMutationAnalysis(source) {
  let document;
  try {
    document = parseGraphql(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }

  const duplicateFragments = new Set();
  const fragments = new Map();
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.FRAGMENT_DEFINITION) continue;
    if (fragments.has(definition.name.value)) {
      duplicateFragments.add(definition.name.value);
    }
    fragments.set(definition.name.value, definition);
  }

  const allFields = [];
  const collectFields = (selectionSet) => {
    for (const selection of selectionSet?.selections ?? []) {
      if (
        selection.kind === Kind.FIELD &&
        OWNER_MUTATION_NAME_SET.has(selection.name.value)
      ) {
        allFields.push(selection);
      }
      collectFields(selection.selectionSet);
    }
  };
  for (const definition of document.definitions) {
    collectFields(definition.selectionSet);
  }

  const reachableFields = [];
  const unresolvedFragments = new Set();
  const fragmentCycles = new Set();
  const visitSelections = (selectionSet, fragmentStack = []) => {
    for (const selection of selectionSet?.selections ?? []) {
      if (selection.kind === Kind.FIELD) {
        if (OWNER_MUTATION_NAME_SET.has(selection.name.value)) {
          reachableFields.push(selection);
        }
        visitSelections(selection.selectionSet, fragmentStack);
        continue;
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        visitSelections(selection.selectionSet, fragmentStack);
        continue;
      }
      if (selection.kind !== Kind.FRAGMENT_SPREAD) continue;
      const name = selection.name.value;
      const fragment = fragments.get(name);
      if (!fragment) {
        unresolvedFragments.add(name);
        continue;
      }
      if (fragmentStack.includes(name)) {
        fragmentCycles.add([...fragmentStack, name].join(" -> "));
        continue;
      }
      visitSelections(fragment.selectionSet, [...fragmentStack, name]);
    }
  };
  for (const definition of document.definitions) {
    if (
      definition.kind === Kind.OPERATION_DEFINITION &&
      definition.operation === "mutation"
    ) {
      visitSelections(definition.selectionSet);
    }
  }

  const reachableLocations = new Set(
    reachableFields.map((field) => field.loc?.start),
  );
  return {
    duplicateFragments: [...duplicateFragments].sort(),
    fields: reachableFields.map((field) => field.name.value),
    fragmentCycles: [...fragmentCycles].sort(),
    unreachableFields: allFields
      .filter((field) => !reachableLocations.has(field.loc?.start))
      .map((field) => field.name.value),
    unresolvedFragments: [...unresolvedFragments].sort(),
  };
}

function enclosingFunctionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.text;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return null;
}

function symbolComesFrom(inventory, node, path, name) {
  const symbol = resolvedSymbol(
    inventory.checker,
    inventory.checker.getSymbolAtLocation(node),
  );
  return (symbol?.declarations ?? []).some((declaration) => {
    const declarationPath = inventory.pathForSourceFile.get(
      declaration.getSourceFile(),
    );
    return declarationPath === path && symbol.name === name;
  });
}

function isImportMetaUrl(inventory, node, seenSymbols = new Set()) {
  const current = unwrapStaticExpression(node);
  if (
    ts.isPropertyAccessExpression(current) &&
    current.name.text === "url" &&
    ts.isMetaProperty(current.expression) &&
    current.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    current.expression.name.text === "meta"
  ) {
    return true;
  }
  if (!ts.isIdentifier(current)) return false;
  const symbol = resolvedSymbol(
    inventory.checker,
    inventory.checker.getSymbolAtLocation(current),
  );
  if (!symbol || seenSymbols.has(symbol)) return false;
  const nextSeen = new Set(seenSymbols);
  nextSeen.add(symbol);
  return (symbol.declarations ?? []).some(
    (declaration) =>
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const &&
      isImportMetaUrl(inventory, declaration.initializer, nextSeen),
  );
}

function staticModuleSpecifierExpression(
  inventory,
  node,
  seenSymbols = new Set(),
) {
  const current = unwrapStaticExpression(node);
  const resolvedString = staticStringExpression(
    inventory,
    current,
    seenSymbols,
  );
  if (resolvedString) return resolvedString;

  if (
    ts.isPropertyAccessExpression(current) &&
    ["href", "pathname"].includes(current.name.text)
  ) {
    const projected = staticModuleSpecifierExpression(
      inventory,
      current.expression,
      seenSymbols,
    );
    return projected?.moduleUrl ? projected : null;
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const property = staticStringExpression(
      inventory,
      current.argumentExpression,
      seenSymbols,
    );
    if (property && ["href", "pathname"].includes(property.value)) {
      const projected = staticModuleSpecifierExpression(
        inventory,
        current.expression,
        seenSymbols,
      );
      return projected?.moduleUrl ? projected : null;
    }
  }
  if (
    ts.isNewExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === "URL" &&
    current.arguments?.length === 2 &&
    isImportMetaUrl(inventory, current.arguments[1], seenSymbols)
  ) {
    const relative = staticStringExpression(
      inventory,
      current.arguments[0],
      seenSymbols,
    );
    return relative ? { ...relative, moduleUrl: true } : null;
  }
  if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) {
    return null;
  }
  const symbol = resolvedSymbol(
    inventory.checker,
    inventory.checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(current) ? current.name : current,
    ),
  );
  if (!symbol || seenSymbols.has(symbol)) return null;
  const nextSeen = new Set(seenSymbols);
  nextSeen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    ) {
      const resolved = staticModuleSpecifierExpression(
        inventory,
        declaration.initializer,
        nextSeen,
      );
      if (resolved) return resolved;
    }
  }
  return null;
}

const STATIC_MODULE_REPOSITORY_URL = new URL(
  "file:///__issue_board_static_inventory__/",
);

function resolvedRepositoryModulePath(importingPath, specifier) {
  if (!specifier.moduleUrl && !/^\.\.?\//u.test(specifier.value)) {
    return null;
  }
  const encodedImportingPath = importingPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  let resolvedPath;
  try {
    const importingUrl = new URL(
      encodedImportingPath,
      STATIC_MODULE_REPOSITORY_URL,
    );
    const resolvedUrl = new URL(specifier.value, importingUrl);
    if (resolvedUrl.protocol !== "file:") return null;
    resolvedPath = posix.relative(
      fileURLToPath(STATIC_MODULE_REPOSITORY_URL),
      fileURLToPath(resolvedUrl),
    );
  } catch {
    return null;
  }
  if (
    resolvedPath === ".." ||
    resolvedPath.startsWith("../") ||
    posix.isAbsolute(resolvedPath)
  ) {
    return null;
  }
  return resolvedPath;
}

const COMMONJS_PROBED_EXTENSIONS = [".js", ".json", ".node"];

function firstInventoriedPath(inventory, candidates) {
  return candidates.find((candidate) =>
    inventory.repositoryPathSet.has(candidate),
  );
}

function resolveCommonJsFile(inventory, path) {
  return firstInventoriedPath(inventory, [
    path,
    ...COMMONJS_PROBED_EXTENSIONS.map((extension) => `${path}${extension}`),
  ]);
}

function resolveCommonJsIndex(inventory, path) {
  return firstInventoriedPath(
    inventory,
    COMMONJS_PROBED_EXTENSIONS.map((extension) =>
      posix.join(path, `index${extension}`),
    ),
  );
}

function resolveCommonJsModule(inventory, unresolvedPath, directoryOnly) {
  if (!directoryOnly) {
    const file = resolveCommonJsFile(inventory, unresolvedPath);
    if (file) return file;
  }
  const packageMain = inventory.packageMains.get(
    posix.join(unresolvedPath, "package.json"),
  );
  if (packageMain != null && !posix.isAbsolute(packageMain)) {
    const mainPath = posix.normalize(posix.join(unresolvedPath, packageMain));
    if (
      mainPath !== ".." &&
      !mainPath.startsWith("../") &&
      !posix.isAbsolute(mainPath)
    ) {
      const mainFile = resolveCommonJsFile(inventory, mainPath);
      if (mainFile) return mainFile;
      const mainIndex = resolveCommonJsIndex(inventory, mainPath);
      if (mainIndex) return mainIndex;
    }
  }
  return resolveCommonJsIndex(inventory, unresolvedPath);
}

function moduleSpecifierComesFrom(inventory, node, path, esmUrl) {
  const symbol = resolvedSymbol(
    inventory.checker,
    inventory.checker.getSymbolAtLocation(node),
  );
  if (
    (symbol?.declarations ?? []).some(
      (declaration) =>
        inventory.pathForSourceFile.get(declaration.getSourceFile()) === path,
    )
  ) {
    return true;
  }
  const specifier = staticModuleSpecifierExpression(inventory, node);
  if (!specifier) return false;
  const importingPath = nodeLocation(inventory, node).path;
  const unresolvedPath = esmUrl
    ? resolvedRepositoryModulePath(importingPath, specifier)
    : !specifier.moduleUrl && /^\.\.?(?:\/|$)/u.test(specifier.value)
      ? posix.normalize(
          posix.join(posix.dirname(importingPath), specifier.value),
        )
      : null;
  if (!unresolvedPath) return false;
  const resolvedPath = esmUrl
    ? unresolvedPath
    : resolveCommonJsModule(
        inventory,
        unresolvedPath,
        specifier.value.endsWith("/") ||
          /(?:^|\/)\.\.?$/u.test(specifier.value),
      );
  return (
    resolvedPath === path || inventory.symlinkTargets.get(resolvedPath) === path
  );
}

function isOwnerProofTestTransportDeclaration(node, location) {
  return (
    location.path === OWNER_PROOF_TEST_TRANSPORT_MODULE_PATH &&
    ts.isIdentifier(node) &&
    ts.isFunctionDeclaration(node.parent) &&
    node.parent.name === node &&
    node.text === OWNER_PROOF_TEST_TRANSPORT_NAME
  );
}

function ownerProofTestTransportReferences(inventory) {
  const references = new Map();
  for (const [, sourceFile] of inventory.sourceFiles) {
    const visit = (node) => {
      if (
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        symbolComesFrom(
          inventory,
          node,
          OWNER_PROOF_TEST_TRANSPORT_MODULE_PATH,
          OWNER_PROOF_TEST_TRANSPORT_NAME,
        )
      ) {
        const location = nodeLocation(inventory, node);
        references.set(location.key, {
          ...location,
          declaration: isOwnerProofTestTransportDeclaration(node, location),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...references.values()].sort((left, right) =>
    `${left.path}:${left.start}`.localeCompare(`${right.path}:${right.start}`),
  );
}

function ownerProofTestTransportReferenceViolations(inventory) {
  return ownerProofTestTransportReferences(inventory).filter(
    ({ declaration, path }) =>
      path !== "scripts/pr/agent-issue-board.test.mjs" && !declaration,
  );
}

function isDirectRequireExpression(node) {
  const current = unwrapStaticExpression(node);
  if (ts.isIdentifier(current)) return current.text === "require";
  return (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    isDirectRequireExpression(current.right)
  );
}

function ownerProofTestTransportNamespaceViolations(inventory) {
  const violations = [];
  for (const [, sourceFile] of inventory.sourceFiles) {
    const visit = (node) => {
      let moduleSpecifier = null;
      let kind = null;
      let esmUrl = false;
      if (ts.isImportDeclaration(node)) {
        esmUrl = true;
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          moduleSpecifier = node.moduleSpecifier;
          kind = "namespace import";
        } else if (
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.some(
            (element) =>
              (element.propertyName ?? element.name).text ===
              OWNER_PROOF_TEST_TRANSPORT_NAME,
          )
        ) {
          moduleSpecifier = node.moduleSpecifier;
          kind = "named import";
        }
      } else if (ts.isExportDeclaration(node)) {
        esmUrl = true;
        if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
          moduleSpecifier = node.moduleSpecifier;
          kind = "namespace re-export";
        } else if (
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.some(
            (element) =>
              (element.propertyName ?? element.name).text ===
              OWNER_PROOF_TEST_TRANSPORT_NAME,
          )
        ) {
          moduleSpecifier = node.moduleSpecifier;
          kind = "named re-export";
        }
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        moduleSpecifier = node.arguments[0];
        kind = "dynamic namespace import";
        esmUrl = true;
      } else if (
        (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        isDirectRequireExpression(node.expression)
      ) {
        moduleSpecifier = node.arguments?.[0] ?? null;
        kind = ts.isNewExpression(node)
          ? "constructed CommonJS namespace import"
          : "CommonJS namespace import";
      }
      if (
        moduleSpecifier &&
        moduleSpecifierComesFrom(
          inventory,
          moduleSpecifier,
          OWNER_PROOF_TEST_TRANSPORT_MODULE_PATH,
          esmUrl,
        )
      ) {
        const location = nodeLocation(inventory, node);
        const testImport =
          location.path === "scripts/pr/agent-issue-board.test.mjs" &&
          !kind.endsWith("re-export");
        if (!testImport) violations.push({ ...location, kind });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations.sort((left, right) =>
    `${left.path}:${left.start}`.localeCompare(`${right.path}:${right.start}`),
  );
}

function ownerProofTestTransportViolations(inventory) {
  return [
    ...ownerProofTestTransportReferenceViolations(inventory),
    ...ownerProofTestTransportNamespaceViolations(inventory),
  ];
}

function exactGuardedOwnerMutationCall(
  inventory,
  path,
  call,
  argumentIndex,
  fields,
) {
  if (path !== OWNER_MUTATION_EXECUTOR_PATH || argumentIndex !== 2)
    return false;
  const functionName = enclosingFunctionName(call);
  const executor = OWNER_MUTATION_EXECUTORS.get(functionName);
  if (
    !executor ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "executeIssueOwnerMutation" ||
    !symbolComesFrom(
      inventory,
      call.expression,
      "scripts/pr/issue-board-lock.mjs",
      "executeIssueOwnerMutation",
    ) ||
    call.arguments.length !== 4
  ) {
    return false;
  }
  if (
    !ts.isIdentifier(call.arguments[0]) ||
    call.arguments[0].text !== "capability"
  ) {
    return false;
  }
  const binding = call.arguments[1];
  return (
    ts.isCallExpression(binding) &&
    ts.isIdentifier(binding.expression) &&
    binding.expression.text === "ownerMutationBinding" &&
    symbolComesFrom(
      inventory,
      binding.expression,
      OWNER_MUTATION_EXECUTOR_PATH,
      "ownerMutationBinding",
    ) &&
    fields.every((field) => field === executor.operation)
  );
}

function executableOwnerMutationOccurrences(inventory) {
  const occurrences = new Map();
  const record = (
    path,
    line,
    key,
    text,
    surface = null,
    start = null,
    end = null,
  ) => {
    for (const operation of OWNER_MUTATION_NAMES) {
      if (!text.includes(operation)) continue;
      occurrences.set(`${key}:${operation}`, {
        end,
        key,
        line,
        operation,
        path,
        start,
        surface,
      });
    }
  };

  for (const [path, sourceFile] of inventory.sourceFiles) {
    const visit = (node) => {
      if (
        ts.isIdentifier(node) ||
        ts.isStringLiteralLike(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        node.kind === ts.SyntaxKind.RegularExpressionLiteral
      ) {
        const location = nodeLocation(inventory, node);
        record(
          path,
          location.line,
          location.key,
          "text" in node ? node.text : node.getText(sourceFile),
          null,
          location.start,
          location.end,
        );
      }
      if (ts.isTemplateExpression(node)) {
        for (const part of [
          node.head,
          ...node.templateSpans.map((span) => span.literal),
        ]) {
          const location = nodeLocation(inventory, part);
          record(
            path,
            location.line,
            location.key,
            part.text,
            null,
            location.start,
            location.end,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  for (const surface of inventory.executableTextSurfaces) {
    record(
      surface.path,
      null,
      `${surface.path}:${surface.surface}`,
      surface.text,
      surface.surface,
    );
  }
  return [...occurrences.values()].sort((left, right) =>
    `${left.path}:${left.line ?? ""}:${left.operation}`.localeCompare(
      `${right.path}:${right.line ?? ""}:${right.operation}`,
    ),
  );
}

function ownerMutationConfinementReport(inventory) {
  const calls = [];
  const violations = [];
  const coveredExecutableText = new Set();
  for (const [path, sourceFile] of inventory.sourceFiles) {
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        node.arguments.forEach((argument, argumentIndex) => {
          const resolved = staticStringExpression(inventory, argument);
          if (
            !resolved ||
            !OWNER_MUTATION_NAMES.some((operation) =>
              resolved.value.includes(operation),
            )
          ) {
            return;
          }
          const location = nodeLocation(inventory, node);
          const graphql = graphqlOwnerMutationAnalysis(resolved.value);
          const call = {
            argumentIndex,
            fields: graphql.fields ?? [],
            functionName: enclosingFunctionName(node),
            line: location.line,
            path,
          };
          calls.push(call);
          if (graphql.error) {
            violations.push(
              `${path}:${location.line} has owner-mutation text that is not a static GraphQL document: ${graphql.error}`,
            );
            return;
          }
          if (
            graphql.duplicateFragments.length > 0 ||
            graphql.fragmentCycles.length > 0 ||
            graphql.unreachableFields.length > 0 ||
            graphql.unresolvedFragments.length > 0
          ) {
            violations.push(
              `${path}:${location.line} has unresolved owner-mutation GraphQL structure: ${JSON.stringify(graphql)}`,
            );
            return;
          }
          if (graphql.fields.length === 0) {
            violations.push(
              `${path}:${location.line} has owner-mutation text with no mutation field`,
            );
            return;
          }
          if (
            !exactGuardedOwnerMutationCall(
              inventory,
              path,
              node,
              argumentIndex,
              graphql.fields,
            )
          ) {
            violations.push(
              `${path}:${location.line} executes ${graphql.fields.join(", ")} outside its exact guarded executor`,
            );
            return;
          }
          for (const dependency of resolved.dependencies) {
            coveredExecutableText.add(dependency);
          }
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const executableText = executableOwnerMutationOccurrences(inventory);
  for (const occurrence of executableText) {
    if (
      occurrence.surface ||
      occurrence.path !== OWNER_MUTATION_EXECUTOR_PATH ||
      !coveredExecutableText.has(occurrence.key)
    ) {
      violations.push(
        `${occurrence.path}${occurrence.line ? `:${occurrence.line}` : ""}${
          occurrence.surface ? ` ${occurrence.surface}` : ""
        } contains executable ${occurrence.operation} text outside its exact guarded call`,
      );
    }
  }
  const repositoryTextCounts = new Map();
  for (const occurrence of inventory.repositoryTextOccurrences) {
    const coveredExecutorOccurrence = executableText.some(
      (executable) =>
        executable.path === OWNER_MUTATION_EXECUTOR_PATH &&
        occurrence.path === OWNER_MUTATION_EXECUTOR_PATH &&
        executable.operation === occurrence.operation &&
        executable.start != null &&
        executable.end != null &&
        executable.start <= occurrence.index &&
        occurrence.end <= executable.end &&
        coveredExecutableText.has(executable.key),
    );
    const allowedAdrOccurrence =
      occurrence.path === OWNER_MUTATION_ADR_PATH &&
      OWNER_MUTATION_ADR_LINES.get(occurrence.operation) ===
        occurrence.lineText;
    if (!coveredExecutorOccurrence && !allowedAdrOccurrence) {
      violations.push(
        `${occurrence.path}:${occurrence.line} contains protected ${occurrence.operation} text outside the exact repository allowlist`,
      );
      continue;
    }
    const observedCounts =
      repositoryTextCounts.get(occurrence.path) ?? new Map();
    observedCounts.set(
      occurrence.operation,
      (observedCounts.get(occurrence.operation) ?? 0) + 1,
    );
    repositoryTextCounts.set(occurrence.path, observedCounts);
  }
  const repositoryTextPathSet = new Set(inventory.repositoryTextPaths);
  for (const [path, allowedCounts] of OWNER_MUTATION_TEXT_COUNTS) {
    if (!repositoryTextPathSet.has(path)) continue;
    const observedCounts = repositoryTextCounts.get(path) ?? new Map();
    for (const [operation, expectedCount] of allowedCounts) {
      const observedCount = observedCounts.get(operation) ?? 0;
      if (observedCount !== expectedCount) {
        violations.push(
          `${path} must contain exactly ${expectedCount} reviewed ${operation} occurrence(s), found ${observedCount}`,
        );
      }
    }
  }

  return {
    calls: calls.sort((left, right) =>
      `${left.path}:${left.line}:${left.argumentIndex}`.localeCompare(
        `${right.path}:${right.line}:${right.argumentIndex}`,
      ),
    ),
    executableText,
    modulePaths: inventory.paths,
    repositoryTextOccurrences: inventory.repositoryTextOccurrences,
    repositoryTextPaths: inventory.repositoryTextPaths,
    symlinkTargets: [...inventory.symlinkTargets].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    violations: [...new Set(violations)].sort(),
  };
}

function runtimeInventoryForFiles(files) {
  const root = mkdtempSync(join(tmpdir(), "issue-owner-proof-"));
  try {
    const paths = Object.keys(files).sort();
    for (const [path, source] of Object.entries(files)) {
      assert(
        path !== ".." && !path.startsWith("../") && !posix.isAbsolute(path),
        `Invalid canary path: ${path}`,
      );
      const absolutePath = join(root, path);
      mkdirSync(dirname(absolutePath), { recursive: true });
      if (
        source &&
        typeof source === "object" &&
        (typeof source.symlink === "string" || Buffer.isBuffer(source.symlink))
      ) {
        symlinkSync(source.symlink, absolutePath);
      } else {
        assert(typeof source === "string", `Invalid canary source: ${path}`);
        writeFileSync(absolutePath, source);
      }
    }
    const symlinkTargets = repositorySymlinkTargets(root, paths);
    const readSource = (path) => readFileSync(join(root, path), "utf8");
    const readRepositoryText = (path) => {
      const absolutePath = join(root, path);
      return lstatSync(absolutePath).isSymbolicLink()
        ? readRepositorySymlinkTarget(absolutePath, path)
        : readFileSync(absolutePath, "utf8");
    };
    const surfaces = runtimeSurfaces(root, paths, readSource);
    return runtimeProgramAtRoot(
      root,
      surfaces.modulePaths,
      surfaces.executableTextSurfaces,
      repositoryOwnerMutationTextOccurrences(paths, readRepositoryText),
      paths,
      symlinkTargets,
      repositoryPackageMains(paths, readSource),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function confinementReportForFiles(files) {
  return ownerMutationConfinementReport(runtimeInventoryForFiles(files));
}

function assertConfinementCanary(files, expectedPath, expectedDetail = null) {
  const report = confinementReportForFiles(files);
  assert(
    report.violations.some(
      (violation) =>
        violation.includes(expectedPath) &&
        (!expectedDetail || violation.includes(expectedDetail)),
    ),
    `confinement canary did not reject ${expectedPath}: ${JSON.stringify(report)}`,
  );
  return report;
}

function assertOwnerProofTestTransportCanary(files, expectedPath) {
  const inventory = runtimeInventoryForFiles({
    [OWNER_PROOF_TEST_TRANSPORT_MODULE_PATH]: `export function ${OWNER_PROOF_TEST_TRANSPORT_NAME}() { return {}; }`,
    ...files,
  });
  const violations = ownerProofTestTransportViolations(inventory);
  assert(
    violations.some(({ path }) => path === expectedPath),
    `owner-proof test transport canary did not reject ${expectedPath}: ${JSON.stringify(violations)}`,
  );
}

function ownershipProject(id = "project") {
  const statusField = {
    id: "status",
    name: "Status",
    dataType: "SINGLE_SELECT",
  };
  return {
    id,
    title: "Monitoring Agent Workboard",
    statusField,
    statusOptions: [
      { id: "ready", name: "Ready" },
      { id: "active", name: "In Progress" },
      { id: "review", name: "In Review" },
      { id: "grooming", name: "Needs Grooming" },
      { id: "blocked", name: "Blocked" },
      { id: "done", name: "Done" },
    ],
    fields: [
      statusField,
      { id: "agent", name: "Agent", dataType: "TEXT" },
      { id: "branch", name: "Branch", dataType: "TEXT" },
      { id: "claim", name: "Claim ID", dataType: "TEXT" },
      { id: "claimed", name: "Claimed At", dataType: "DATE" },
      { id: "pr", name: "PR", dataType: "TEXT" },
    ],
  };
}

function projectItemSnapshot(
  project = ownershipProject(),
  { id = `item-${project.id}`, name = "Ready", optionId = "ready" } = {},
) {
  return {
    id,
    title: project.title,
    project: { id: project.id, title: project.title },
    status: { name, optionId, fieldId: project.statusField.id },
  };
}

function swapOwnerFieldIds(project, leftName, rightName) {
  const left = project.fields.find((field) => field.name === leftName);
  const right = project.fields.find((field) => field.name === rightName);
  assert(left, `missing ${leftName} field for stale-map fixture`);
  assert(right, `missing ${rightName} field for stale-map fixture`);
  return {
    ...project,
    fields: project.fields.map((field) => {
      if (field.name === leftName) return { ...field, id: right.id };
      if (field.name === rightName) return { ...field, id: left.id };
      return field;
    }),
  };
}

function assertThrows(fn, pattern) {
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!pattern.test(message)) {
      throw new Error(`expected ${message} to match ${pattern}`, {
        cause: err,
      });
    }
    return err;
  }
  throw new Error("expected function to throw");
}

async function assertRejects(fn, pattern) {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!pattern.test(message)) {
      throw new Error(`expected ${message} to match ${pattern}`, {
        cause: err,
      });
    }
    return err;
  }
  throw new Error("expected function to reject");
}

const TEST_OWNER_CAPABILITY = Object.freeze({ testOnly: true });

async function testIssueMutationLock(_options, _issue, metadata, mutation) {
  return mutation(
    {
      payload: metadata,
      markSafeToUnlock() {},
    },
    TEST_OWNER_CAPABILITY,
  );
}

function syncWithTestLock(options, dependencies = {}) {
  return sync(options, {
    ...dependencies,
    ensureProjectItem:
      dependencies.ensureProjectItem ?? (async () => "test-project-item"),
    findIssueProjectItem:
      dependencies.findIssueProjectItem ?? (async () => "test-project-item"),
    readIssueLockOwnership:
      dependencies.readIssueLockOwnership ?? (async () => null),
    withIssueMutationLock: testIssueMutationLock,
  });
}

function backfillWithTestLock(options, dependencies = {}) {
  return backfill(options, {
    ...dependencies,
    readClaimOwnership: dependencies.readClaimOwnership ?? (async () => null),
    withIssueMutationLock: testIssueMutationLock,
  });
}

function claimWithTestLock(options, dependencies = {}) {
  return claim(options, {
    ...dependencies,
    withIssueMutationLock:
      dependencies.withIssueMutationLock ?? testIssueMutationLock,
  });
}

async function preparedTestIssueMutationLock(
  _options,
  _issue,
  metadata,
  mutation,
  overrides = {},
) {
  if (overrides.prepareMetadata) {
    await overrides.prepareMetadata(metadata);
  }
  return mutation(
    {
      payload: metadata,
      markSafeToUnlock() {},
    },
    TEST_OWNER_CAPABILITY,
  );
}

function releaseWithTestLock(options, dependencies = {}) {
  return release(options, {
    ...dependencies,
    withIssueMutationLock: testIssueMutationLock,
  });
}

const LOCK_TEST_OPTIONS = {
  repo: "mento-protocol/monitoring-monorepo",
  projectOwner: "mento-protocol",
  projectNumber: 12,
  agent: "codex",
  dryRun: false,
};

function createFakeLockServer({
  ownerItemIds = null,
  ownerProject = ownershipProject(),
  ownerRepositoryIds = null,
  ownerTargetErrors = null,
  ownerTargetTransport = null,
} = {}) {
  const commits = new Map();
  let refOid = null;
  let nextOid = 0;
  const repositoryId = "repository-id";
  const zeroOid = "0000000000000000000000000000000000000000";
  const base = {
    oid: "base-commit",
    treeOid: "base-tree",
    repositoryId,
  };
  let ownerTargetReads = 0;

  async function ownerTargetGraphql(query, variables) {
    ownerTargetReads += 1;
    const configuredError = ownerTargetErrors
      ? ownerTargetErrors[
          Math.min(ownerTargetReads - 1, ownerTargetErrors.length - 1)
        ]
      : null;
    if (configuredError != null) throw configuredError;
    if (ownerTargetTransport) {
      return ownerTargetTransport(query, variables, ownerTargetReads);
    }
    assert(
      query.includes("IssueOwnerMutationTarget"),
      "fake owner-target transport received an unexpected document",
    );
    const configuredItem = ownerItemIds
      ? ownerItemIds[Math.min(ownerTargetReads - 1, ownerItemIds.length - 1)]
      : `item-${variables.issue}`;
    const configuredRepositoryId = ownerRepositoryIds
      ? ownerRepositoryIds[
          Math.min(ownerTargetReads - 1, ownerRepositoryIds.length - 1)
        ]
      : repositoryId;
    return {
      data: {
        repository: {
          id: configuredRepositoryId,
          nameWithOwner: `${variables.owner}/${variables.name}`,
          issue: {
            id: `issue-${variables.issue}`,
            number: variables.issue,
            projectItems: {
              nodes:
                configuredItem == null
                  ? []
                  : [{ id: configuredItem, project: { id: ownerProject.id } }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
        organization: {
          login: variables.projectOwner,
          projectV2: {
            id: ownerProject.id,
            number: variables.projectNumber,
            fields: {
              nodes: ownerProject.fields,
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    };
  }

  function createCommit(parent, payload) {
    const commit = {
      oid: `mutex-commit-${++nextOid}`,
      treeOid: parent.treeOid,
      parentOid: parent.oid,
      payload,
    };
    commits.set(commit.oid, commit);
    return commit;
  }

  async function compareAndSwapLockRef(
    _options,
    actualRepositoryId,
    _refName,
    beforeOid,
    afterOid,
  ) {
    assertEqual(actualRepositoryId, repositoryId);
    const observedOid = refOid ?? zeroOid;
    if (observedOid !== beforeOid) {
      throw new Error("Ref did not match beforeOid");
    }
    const commit = commits.get(afterOid);
    if (!commit || (beforeOid !== zeroOid && commit.parentOid !== beforeOid)) {
      throw new Error("Update is not a fast forward");
    }
    refOid = afterOid;
  }

  const baseOperations = {
    compareAndSwapLockRef,
    createStateCommit: async (_options, parent, payload) => {
      const commit = createCommit(parent, payload);
      return { oid: commit.oid, treeOid: commit.treeOid };
    },
    readDefaultBranchCommit: async () => base,
    readLockRef: async () => {
      const commit = commits.get(refOid);
      return commit ? { ...commit, repositoryId } : null;
    },
    sleep: async () => {},
  };
  const withOperations = (overrides = {}) =>
    createIssueOwnerProofTestOperations(
      { ...baseOperations, ...overrides },
      ownerTargetGraphql,
    );
  const operations = withOperations();

  return {
    operations,
    commits,
    compareAndSwapLockRef,
    createCommit,
    repositoryId,
    withOperations,
    get ownerTargetReads() {
      return ownerTargetReads;
    },
    get refOid() {
      return refOid;
    },
    set refOid(value) {
      refOid = value;
    },
  };
}

test("owner proof test transport exposes no copyable marker", () => {
  const operations = createFakeLockServer().operations;
  assertDeepEqual(Object.getOwnPropertySymbols(operations), []);
  assertDeepEqual(Object.getOwnPropertySymbols({ ...operations }), []);
});

async function withRealOwnerCapability(
  operation,
  project,
  issueNumber,
  mutation,
  options = LOCK_TEST_OPTIONS,
  itemId = `item-${issueNumber}`,
) {
  const server = createFakeLockServer({
    ownerItemIds: [itemId],
    ownerProject: project,
  });
  return withIssueMutationLock(
    options,
    issueNumber,
    { operation, projectId: project.id, agent: options.agent },
    (_lease, capability) => mutation(capability),
    server.operations,
  );
}

function deferredPromise() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function guardedTextWrite(
  capability,
  {
    field = "Branch",
    fieldId = "branch",
    graphql = async () => ({ data: {} }),
    issueNumber,
    itemId = `item-${issueNumber}`,
    operation = "claim",
    options = LOCK_TEST_OPTIONS,
    project = ownershipProject(),
    value = `fix/${issueNumber}`,
  },
) {
  return updateTextField(capability, options, project, itemId, fieldId, value, {
    field,
    graphql,
    issueNumber,
    operation,
  });
}

function twoPartyBarrier() {
  let arrivals = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await ready;
  };
}

test("assertEqual reports the message its call site passed", () => {
  let thrown = null;
  try {
    assertEqual(3, 10, "the count is the signal; the list is an affordance");
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  assert(thrown !== null, "a mismatch must throw");
  assert(
    thrown.includes("the count is the signal; the list is an affordance"),
    `the failure output must name what was asserted; got: ${thrown}`,
  );
  assert(thrown.includes("expected 10, got 3"), `values kept: ${thrown}`);
});

test("parses repeated, comma-separated, and URL issue references", () => {
  assertDeepEqual(
    parseIssueNumbers([
      "901,902",
      "#903",
      "https://github.com/mento-protocol/monitoring-monorepo/issues/904",
    ]),
    [901, 902, 903, 904],
  );
});

test("project scope failures name the read-write gh refresh command", () => {
  const hint = githubProjectScopeHint(
    "The 'projectV2' field requires one of the following scopes: ['read:project']",
    {},
  );
  assert(
    hint.includes("gh auth refresh -h github.com -s project"),
    "missing refresh command",
  );
  assert(
    hint.includes("`read:project` alone"),
    "missing read-only scope warning",
  );
});

test("queue-label issue lists use one all-state OR query", async () => {
  const calls = [];
  await listIssuesByLabels(
    { repo: "mento-protocol/monitoring-monorepo" },
    ISSUE_STATE_LABELS,
    {
      state: "all",
      json: async (args) => {
        calls.push(args);
        return [];
      },
    },
  );

  assertDeepEqual(calls, [
    [
      "issue",
      "list",
      "-R",
      "mento-protocol/monitoring-monorepo",
      "--state",
      "all",
      "--search",
      `is:issue label:${ISSUE_STATE_LABELS.join(",")}`,
      "--limit",
      "1000",
      "--json",
      "id,number,title,url,labels,state,projectItems",
    ],
  ]);
});

test("open PR branch proof filters the repository and fails closed at its cap", async () => {
  const options = { repo: "mento-protocol/monitoring-monorepo" };
  const prs = await listOpenPullRequestsForBranch(options, "fix/901", {
    json: async () => [
      {
        number: 1901,
        headRefName: "fix/901",
        headRepository: {
          nameWithOwner: "mento-protocol/monitoring-monorepo",
        },
      },
      {
        number: 2901,
        headRefName: "fix/901",
        headRepository: { nameWithOwner: "fork/monitoring-monorepo" },
      },
    ],
    maxResults: 3,
  });
  assertDeepEqual(
    prs.map((pr) => pr.number),
    [1901],
  );
  await assertRejects(
    () =>
      listOpenPullRequestsForBranch(options, "fix/901", {
        json: async () => [{ number: 1 }, { number: 2 }],
        maxResults: 2,
      }),
    /cannot prove that no replacement PR exists/,
  );
});

test("project mutation scope failures receive the same guidance", () => {
  assert(
    githubProjectScopeHint(
      "This mutation requires one of the following scopes: ['project']",
      {},
    ).includes("read/write `project` scope"),
    "missing mutation scope guidance",
  );
});

test("mutex GraphQL failures name the Contents write requirement", () => {
  const hint = githubProjectScopeHint(
    "GraphQL: Resource not accessible by personal access token",
    {},
    [
      "api",
      "graphql",
      "query=mutation { updateRefs(input: {}) { clientMutationId } }",
    ],
  );
  assert(
    hint.includes("repository Contents write access"),
    "missing mutex Contents guidance",
  );
});

test("project scope hints ignore scopes that are only granted", () => {
  assertEqual(
    githubProjectScopeHint(
      "The 'repository' field requires one of the following scopes: ['repo']\nThe active token has scopes: ['read:project']",
    ),
    "",
  );
});

test("environment-provided credentials receive replacement guidance", () => {
  const stderr =
    "The 'projectV2' field requires one of the following scopes: ['read:project']";
  for (const env of [{ GH_TOKEN: "token" }, { GITHUB_TOKEN: "token" }]) {
    const hint = githubProjectScopeHint(stderr, env);
    assert(
      hint.includes(
        "Replace the environment-provided GH_TOKEN or GITHUB_TOKEN",
      ),
      "missing environment credential guidance",
    );
    assert(
      !hint.includes("gh auth refresh -h github.com -s project"),
      "stored-credential refresh command should be omitted",
    );
  }
});

test("unrelated gh failures do not receive project scope guidance", () => {
  assertEqual(
    githubProjectScopeHint(
      "error connecting to api.github.com; check your internet connection",
    ),
    "",
  );
});

test("rejects issue URLs from another repository", () => {
  assertThrows(
    () =>
      parseIssueNumbers(
        ["https://github.com/other/repo/issues/904"],
        "mento-protocol/monitoring-monorepo",
      ),
    /does not match selected repo/,
  );
});

test("parses claim options for the monitoring workboard", () => {
  const args = parseArgs([
    "claim",
    "--count",
    "3",
    "--agent",
    "codex",
    "--branch",
    "agent/issues",
    "--dry-run",
  ]);

  assertEqual(args.command, "claim");
  assertEqual(args.count, 3);
  assertEqual(args.agent, "codex");
  assertEqual(args.branch, "agent/issues");
  assertEqual(args.projectOwner, "mento-protocol");
  assertEqual(args.projectNumber, 12);
  assertEqual(args.dryRun, true);
});

test("claim CLI rejects Agent and Branch metadata the claim parser cannot read", () => {
  for (const [argv, pattern] of [
    [["claim", "--agent", "x".repeat(121)], /Agent must be 1-120/],
    [["claim", "--agent", "codex\nbot"], /Agent must be 1-120/],
    [["claim", "--agent", "codex\u0000bot"], /Agent must be 1-120/],
    [["claim", "--branch", "x".repeat(257)], /Branch must be 1-256/],
    [["claim", "--branch", "fix/901\nnext"], /Branch must be 1-256/],
    [["claim", "--branch", "fix/901\u0000next"], /Branch must be 1-256/],
  ]) {
    assertThrows(() => parseArgs(argv), pattern);
  }
  for (const [, character] of UNSAFE_SINGLE_LINE_TEST_CHARACTERS) {
    assertThrows(
      () => parseArgs(["claim", "--agent", `codex${character}bot`]),
      /Agent must be 1-120/,
    );
    assertThrows(
      () => parseArgs(["claim", "--branch", `fix/901${character}next`]),
      /Branch must be 1-256/,
    );
  }
});

test("--pr is accepted only by review before any claim mutation", async () => {
  for (const argv of [
    ["claim", "--issue", "901", "--pr", "77"],
    ["release", "--issue", "901", "--claim-id", "claim-901", "--pr", "77"],
    ["board", "sync", "--pr", "77"],
    ["board", "backfill", "--issue", "901", "--pr", "77"],
  ]) {
    assertThrows(() => parseArgs(argv), /--pr is valid only for review/);
  }
  assertEqual(parseArgs(["review", "--issue", "901", "--pr", "77"]).pr, 77);
  assertEqual(
    parseArgs([
      "review",
      "--issue",
      "901",
      "--pr",
      "77",
      "--claim-id",
      "claim-901",
      "--rebind-branch",
    ]).pr,
    77,
  );

  let projectReads = 0;
  await assertRejects(
    () =>
      claim(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [901],
          branch: "fix/901",
          claimId: "claim-901",
          sweepEligible: false,
          comment: false,
          pr: 77,
        },
        {
          getProject: async () => {
            projectReads += 1;
            return ownershipProject();
          },
        },
      ),
    /--pr is valid only for review/,
  );
  assertEqual(projectReads, 0);
});

test("parses stable sweep ownership and requires release ownership", () => {
  const claimOptions = parseArgs([
    "claim",
    "--issue",
    "901",
    "--claim-id",
    "sweep-901-token",
    "--branch",
    "fix/901",
    "--sweep-eligible",
    "--body-sha256",
    EMPTY_BODY_SHA256,
  ]);
  assertEqual(claimOptions.claimId, "sweep-901-token");
  assertEqual(claimOptions.sweepEligible, true);
  assertEqual(claimOptions.bodySha256, EMPTY_BODY_SHA256);
  const releaseOptions = parseArgs([
    "release",
    "--issue",
    "901",
    "--claim-id",
    "sweep-901-token",
  ]);
  assertEqual(releaseOptions.claimId, "sweep-901-token");
  assertThrows(
    () => parseArgs(["release", "--issue", "901"]),
    /release requires --claim-id/,
  );
  assertThrows(
    () =>
      parseArgs([
        "claim",
        "--issue",
        "901",
        "--issue",
        "902",
        "--claim-id",
        "shared",
      ]),
    /exactly one explicit issue/,
  );
  assertThrows(
    () =>
      parseArgs(
        [
          "claim",
          "--issue",
          "901",
          "--claim-id",
          "sweep-901-token",
          "--sweep-eligible",
        ],
        { AGENT_BRANCH: "fix/from-ambient-env" },
      ),
    /requires an explicit --branch/,
  );

  const rebind = parseArgs([
    "review",
    "--issue",
    "2071",
    "--pr",
    "2079",
    "--claim-id",
    "claim-2071",
    "--rebind-branch",
  ]);
  assertEqual(rebind.rebindBranch, true);
  assertEqual(rebind.claimId, "claim-2071");
  assertThrows(
    () =>
      parseArgs([
        "review",
        "--issue",
        "2071",
        "--pr",
        "2079",
        "--rebind-branch",
      ]),
    /requires --claim-id/,
  );
  assertThrows(
    () =>
      parseArgs([
        "review",
        "--issue",
        "2071",
        "--pr",
        "2079",
        "--claim-id",
        "claim-2071",
      ]),
    /valid only for claim, release, or review with --rebind-branch/,
  );
  assertThrows(
    () =>
      parseArgs([
        "review",
        "--issue",
        "2071",
        "--pr",
        "2079",
        "--branch",
        "feat/rank-backlog-skill",
      ]),
    /--branch is valid only for claim/,
  );

  const merged = parseArgs([
    "release",
    "--issue",
    "2071",
    "--claim-id",
    "claim-2071",
    "--merged-pr",
    "--needs-grooming",
  ]);
  assertEqual(merged.mergedPr, true);
  assertEqual(merged.releaseState, "grooming");
  assertThrows(
    () =>
      parseArgs([
        "release",
        "--issue",
        "2071",
        "--claim-id",
        "claim-2071",
        "--merged-pr",
      ]),
    /requires --needs-grooming/,
  );
  assertThrows(
    () =>
      parseArgs([
        "release",
        "--issue",
        "2071",
        "--claim-id",
        "claim-2071",
        "--merged-pr",
        "--closed-unmerged-pr",
        "--needs-grooming",
      ]),
    /mutually exclusive/,
  );
});

test("ambient lifecycle redirects require explicit target flags", () => {
  assertThrows(
    () =>
      parseArgs(["claim", "--issue", "901"], {
        AGENT_ISSUE_REPO: "other/repo",
      }),
    /AGENT_ISSUE_REPO redirects.*pass --repo explicitly/,
  );
  const explicit = parseArgs(
    [
      "claim",
      "--issue",
      "901",
      "--repo",
      "other/repo",
      "--project-owner",
      "other",
      "--project-number",
      "9",
    ],
    {
      AGENT_ISSUE_REPO: "other/repo",
      AGENT_WORKBOARD_OWNER: "other",
      AGENT_WORKBOARD_PROJECT_NUMBER: "9",
    },
  );
  assertEqual(explicit.repo, "other/repo");
  assertEqual(explicit.projectOwner, "other");
  assertEqual(explicit.projectNumber, 9);
});

test("lifecycle operations reject ambient GitHub host redirects", () => {
  const lifecycleArgv = [
    ["claim", "--issue", "901"],
    ["review", "--issue", "901", "--pr", "902"],
    ["release", "--issue", "901", "--claim-id", "claim-901"],
    ["board", "sync"],
    ["board", "backfill", "--issue", "901"],
  ];

  for (const argv of lifecycleArgv) {
    assertThrows(
      () => parseArgs(argv, { GH_HOST: "github.example.invalid" }),
      /GH_HOST must be unset or exactly github\.com/,
    );
    assertThrows(
      () => parseArgs(argv, { GH_REPO: "github.example.invalid/acme/repo" }),
      /GH_REPO must be an unqualified owner\/repo/,
    );
    assertThrows(
      () => parseArgs(argv, { GH_REPO: "github.com/acme/repo" }),
      /GH_REPO must be an unqualified owner\/repo/,
    );
  }

  assertEqual(
    parseArgs(["board", "sync"], {
      GH_HOST: "github.com",
      GH_REPO: "ambient/repo",
    }).command,
    "sync",
  );
  assertThrows(
    () =>
      parseArgs(["claim", "--issue", "901", "--repo", "explicit/repo"], {
        GH_HOST: "github.example.invalid",
      }),
    /GH_HOST must be unset or exactly github\.com/,
  );
});

test("gh transport pins github.com and fails closed on a hostile host", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "issue-board-gh-host-"));
  const ghPath = join(fixtureDir, "gh");
  writeFileSync(
    ghPath,
    '#!/bin/sh\nprintf \'%s\\n%s\\n\' "$GH_HOST" "${GH_REPO-<unset>}"\n',
  );
  chmodSync(ghPath, 0o755);
  const transportUrl = new URL("./issue-board-transport.mjs", import.meta.url)
    .href;
  const probe = `import { runGh } from ${JSON.stringify(transportUrl)}; process.stdout.write(await runGh(["api", "user"]));`;
  const refusalProbe = `import { runGh } from ${JSON.stringify(transportUrl)}; try { await runGh(["api", "user"]); throw new Error("gh unexpectedly ran"); } catch (error) { process.stdout.write(error.message); }`;

  try {
    const pinned = execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", probe],
      {
        encoding: "utf8",
        env: {
          GH_REPO: "ambient/repo",
          PATH: fixtureDir,
        },
      },
    );
    assertEqual(pinned, "github.com\n<unset>\n");

    assertEqual(
      execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", refusalProbe],
        {
          encoding: "utf8",
          env: {
            GH_HOST: "github.example.invalid",
            PATH: fixtureDir,
          },
        },
      ),
      "GH_HOST must be unset or exactly github.com for issue-board operations",
    );
    assertEqual(
      execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", refusalProbe],
        {
          encoding: "utf8",
          env: {
            GH_REPO: "github.example.invalid/acme/repo",
            PATH: fixtureDir,
          },
        },
      ),
      "GH_REPO must be an unqualified owner/repo for issue-board operations",
    );
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
});

test("issue lookup reads blockers without a gh 2.94 JSON field dependency", async () => {
  let jsonArgs = null;
  let graphqlQuery = null;
  const issue = await getIssue(LOCK_TEST_OPTIONS, 901, {
    json: async (args) => {
      jsonArgs = args;
      return {
        id: "issue-node-901",
        number: 901,
        title: "claim safely",
        labels: [{ name: "agent-ready" }],
        projectItems: [],
      };
    },
    graphql: async (query, variables) => {
      graphqlQuery = query;
      assertDeepEqual(variables, { issue: "issue-node-901" });
      return {
        data: {
          node: {
            blockedBy: {
              totalCount: 2,
              nodes: [{ id: "blocker-node" }],
            },
            projectItems: {
              nodes: [
                {
                  id: "selected-item",
                  project: {
                    id: "selected-project",
                    title: "Monitoring Agent Workboard",
                  },
                  fieldValueByName: {
                    name: "Ready",
                    optionId: "ready",
                    field: { id: "selected-status" },
                  },
                },
                {
                  id: "same-title-item",
                  project: {
                    id: "other-project",
                    title: "Monitoring Agent Workboard",
                  },
                  fieldValueByName: {
                    name: "Blocked",
                    optionId: "blocked",
                    field: { id: "other-status" },
                  },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    },
  });

  assert(
    !jsonArgs.at(-1).split(",").includes("blockedBy"),
    "ordinary issue JSON fields must remain compatible with gh before 2.94",
  );
  assert(
    /blockedBy\(first:\s*1\)/.test(graphqlQuery),
    "blocked-by relationships must use the version-independent GraphQL path",
  );
  assert(
    graphqlQuery.includes('fieldValueByName(name: "Status")'),
    "the same snapshot must bind Project IDs to exact Status values",
  );
  assert(
    graphqlQuery.includes("pageInfo"),
    "the exact Project snapshot must include pagination state",
  );
  assertDeepEqual(issue.blockedBy, {
    totalCount: 2,
    nodes: [{ id: "blocker-node" }],
  });
  assertDeepEqual(issue.projectItems, [
    {
      id: "selected-item",
      title: "Monitoring Agent Workboard",
      project: {
        id: "selected-project",
        title: "Monitoring Agent Workboard",
      },
      status: {
        name: "Ready",
        optionId: "ready",
        fieldId: "selected-status",
      },
    },
    {
      id: "same-title-item",
      title: "Monitoring Agent Workboard",
      project: {
        id: "other-project",
        title: "Monitoring Agent Workboard",
      },
      status: {
        name: "Blocked",
        optionId: "blocked",
        fieldId: "other-status",
      },
    },
  ]);
  assertDeepEqual(issue.projectItemsPageInfo, { hasNextPage: false });

  await assertRejects(
    () =>
      getIssue(LOCK_TEST_OPTIONS, 902, {
        json: async () => ({ id: "issue-node-902", number: 902 }),
        graphql: async () => ({ data: { node: { blockedBy: null } } }),
      }),
    /blocked-by lookup returned an incomplete relationship/,
  );
});

test("issue lookup rejects incomplete Project item pages before using nodes", async () => {
  for (const [name, pageInfo] of [
    ["truncated", { hasNextPage: true }],
    ["missing pagination state", undefined],
  ]) {
    await assertRejects(
      () =>
        getIssue(LOCK_TEST_OPTIONS, 903, {
          json: async () => ({ id: "issue-node-903", number: 903 }),
          graphql: async () => ({
            data: {
              node: {
                blockedBy: { totalCount: 0, nodes: [] },
                projectItems: {
                  nodes: [
                    {
                      id: "selected-item",
                      project: { id: "selected-project" },
                    },
                  ],
                  ...(pageInfo ? { pageInfo } : {}),
                },
              },
            },
          }),
        }),
      /Project item lookup returned an incomplete page/,
      name,
    );
  }
});

function prIssuesResponse(connection) {
  return {
    data: {
      repository: {
        pullRequest: {
          id: "pr-node-123",
          state: "OPEN",
          closingIssuesReferences: connection,
        },
      },
    },
  };
}

test("PR closing issue inference accepts only a complete first page", async () => {
  let queryText = "";
  const options = { ...LOCK_TEST_OPTIONS, pr: 123 };
  const issues = await getPrIssues(options, {
    graphql: async (query, variables) => {
      queryText = query;
      assertEqual(variables.owner, "mento-protocol");
      assertEqual(variables.repo, "monitoring-monorepo");
      assertEqual(variables.number, 123);
      return prIssuesResponse({
        nodes: [
          {
            number: 901,
            repository: {
              nameWithOwner: "mento-protocol/monitoring-monorepo",
            },
          },
          {
            number: 902,
            repository: {
              nameWithOwner: "mento-protocol/other",
            },
          },
          {
            number: "903",
            repository: {
              nameWithOwner: "mento-protocol/monitoring-monorepo",
            },
          },
          null,
        ],
        pageInfo: { hasNextPage: false },
      });
    },
  });

  assert(
    queryText.includes("closingIssuesReferences(first: 100)"),
    "PR issue inference must use the bounded closing issue connection",
  );
  assert(
    queryText.includes("pageInfo"),
    "PR issue inference must request pagination state",
  );
  assertDeepEqual(issues, [901]);
});

test("PR closing issue inference rejects incomplete or paginated connections", async () => {
  const cases = [
    [
      { nodes: [], pageInfo: { hasNextPage: true } },
      /more than 100 closing issue references/,
    ],
    [{ nodes: [] }, /closing issue lookup returned an incomplete page/],
    [null, /closing issue lookup returned an incomplete page/],
    [
      { nodes: null, pageInfo: { hasNextPage: false } },
      /closing issue lookup returned an incomplete page/,
    ],
    [
      { nodes: [], pageInfo: { hasNextPage: null } },
      /closing issue lookup returned an incomplete page/,
    ],
  ];

  for (const [connection, pattern] of cases) {
    const options = { ...LOCK_TEST_OPTIONS, pr: 123 };
    await assertRejects(
      () =>
        getPrIssues(options, {
          graphql: async () => prIssuesResponse(connection),
        }),
      pattern,
    );
  }
});

test("sync is repository-wide and rejects issue scope", () => {
  const help = usage();
  assert(
    help.includes("pnpm issue:board sync --dry-run"),
    "sync help must name the repository-wide preview",
  );
  assert(
    help.includes("requires explicit repository-wide authority"),
    "sync help must require repository-wide apply authority",
  );

  const options = parseArgs(["sync", "--dry-run"]);
  assertEqual(options.command, "sync");
  assertEqual(options.dryRun, true);
  assertEqual(options.issues.length, 0);

  for (const argv of [
    ["sync", "--issue", "901"],
    ["sync", "--issues", "901,902"],
    ["sync", "901"],
  ]) {
    assertThrows(() => parseArgs(argv), /sync is repository-wide/);
  }
});

test("backfill requires exactly one explicit issue", () => {
  const options = parseArgs(["board", "backfill", "--issue", "901"]);
  assertEqual(options.issues[0], 901);
  assertEqual(options.backfillIssueFlags, undefined);
  assertEqual(options.positionalIssueValues, undefined);
  for (const argv of [
    ["board", "backfill"],
    ["board", "backfill", "901"],
    ["board", "backfill", "--issue", "901", "--issue", "902"],
    ["board", "backfill", "--issue", "901,902"],
    ["board", "backfill", "--issue", "901,901"],
    ["board", "backfill", "--issue", "0"],
    ["board", "backfill", "--issues", "901"],
  ]) {
    assertThrows(() => parseArgs(argv), /exactly one explicit --issue/);
  }
});

test("parses PR URLs only for the selected repository", () => {
  assertEqual(
    parseArgs([
      "review",
      "--repo",
      "mento-protocol/monitoring-monorepo",
      "--pr",
      "https://github.com/mento-protocol/monitoring-monorepo/pull/984",
    ]).pr,
    984,
  );
  assertEqual(
    parseArgs([
      "review",
      "--pr",
      "https://github.com/other/repo/pull/123",
      "--repo",
      "other/repo",
    ]).pr,
    123,
  );
  assertThrows(
    () =>
      parseArgs([
        "review",
        "--repo",
        "mento-protocol/monitoring-monorepo",
        "--pr",
        "https://github.com/other/repo/pull/123",
      ]),
    /does not match selected repo/,
  );
});

test("review PR guard requires an open PR", () => {
  assertEqual(
    validateOpenPr(
      { id: "PR_123", state: "OPEN" },
      { pr: 984, repo: "mento-protocol/monitoring-monorepo" },
    ).id,
    "PR_123",
  );
  assertThrows(
    () =>
      validateOpenPr(null, {
        pr: 984,
        repo: "mento-protocol/monitoring-monorepo",
      }),
    /was not found/,
  );
  assertThrows(
    () =>
      validateOpenPr(
        { id: "PR_123", state: "CLOSED" },
        { pr: 984, repo: "mento-protocol/monitoring-monorepo" },
      ),
    /requires an open PR/,
  );
});

test("review verifies the complete durable ownership snapshot", async () => {
  let issue = {
    id: "issue-905",
    number: 905,
    title: "review ownership",
    state: "OPEN",
    labels: [{ name: "agent-active" }],
  };
  const ownership = {
    claimId: "claim-905",
    agent: "codex",
    branch: "fix/905",
    claimedAt: "2026-08-28",
    pr: null,
  };
  await assertRejects(
    () =>
      review(
        {
          repo: "mento-protocol/monitoring-monorepo",
          projectOwner: "mento-protocol",
          projectNumber: 12,
          issues: [905],
          agent: "codex",
          branch: "fix/905",
          pr: 1905,
          dryRun: false,
          comment: false,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => issue,
          findIssueProjectItem: async () => "item-905",
          ensureProjectItem: async () => "item-905",
          readClaimOwnership: async () => ownership,
          getPullRequest: async () => ({
            state: "OPEN",
            headRefName: "fix/905",
            headRepository: {
              nameWithOwner: "mento-protocol/monitoring-monorepo",
            },
          }),
          editIssueLabels: async (_options, current, state) => {
            issue = {
              ...current,
              labels: [{ name: state === "review" ? "in-pr" : "agent-active" }],
            };
          },
          updateProjectMetadata: async () => {
            // Simulate a successful response that did not retain the PR field.
          },
          withIssueMutationLock: async (
            _options,
            _number,
            _metadata,
            mutation,
          ) => mutation({ markSafeToUnlock() {} }),
        },
      ),
    /review ownership verification failed[\s\S]*review recovery is ambiguous/,
  );
  assertDeepEqual(issue.labels, [{ name: "in-pr" }]);
});

test("review rejects a missing stored Agent before lock or board mutation", async () => {
  let lockCalls = 0;
  let labelWrites = 0;
  let projectWrites = 0;
  let prReads = 0;
  await assertRejects(
    () =>
      review(
        {
          repo: "mento-protocol/monitoring-monorepo",
          projectOwner: "mento-protocol",
          projectNumber: 12,
          issues: [906],
          agent: "codex",
          branch: "fix/906",
          pr: 1906,
          dryRun: false,
          comment: false,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => ({
            id: "issue-906",
            number: 906,
            title: "missing stored agent",
            state: "OPEN",
            labels: [{ name: "agent-active" }],
          }),
          findIssueProjectItem: async () => "item-906",
          readClaimOwnership: async () => ({
            claimId: "claim-906",
            agent: null,
            branch: "fix/906",
            claimedAt: "2026-08-28",
            pr: null,
          }),
          getPullRequest: async () => {
            prReads += 1;
            return {
              state: "OPEN",
              headRefName: "fix/906",
              headRepository: {
                nameWithOwner: "mento-protocol/monitoring-monorepo",
              },
            };
          },
          editIssueLabels: async () => {
            labelWrites += 1;
          },
          updateProjectMetadata: async () => {
            projectWrites += 1;
          },
          withIssueMutationLock: async () => {
            lockCalls += 1;
          },
        },
      ),
    /review requires durable Claim ID, Agent, and Branch ownership/,
  );
  assertEqual(prReads, 0);
  assertEqual(lockCalls, 0);
  assertEqual(labelWrites, 0);
  assertEqual(projectWrites, 0);
});

function stageReviewFixture() {
  return {
    issue: {
      id: "issue-2071",
      number: 2071,
      title: "operator-triggered backlog sweep",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: {
      claimId: "claim-2071",
      agent: "codex",
      branch: "worktree-shoggoth",
      claimedAt: "2026-08-27",
      pr: null,
    },
  };
}

function stageReviewOptions(overrides = {}) {
  return {
    repo: "mento-protocol/monitoring-monorepo",
    projectOwner: "mento-protocol",
    projectNumber: 12,
    issues: [2071],
    agent: "codex",
    branch: "feat/rank-backlog-skill",
    claimId: "claim-2071",
    rebindBranch: true,
    pr: 2079,
    dryRun: false,
    comment: false,
    ...overrides,
  };
}

function stageReviewDependencies(state, overrides = {}) {
  return {
    getProject: async () => ownershipProject(),
    getIssue: async () => state.issue,
    findIssueProjectItem: async () => "item-2071",
    readClaimOwnership: async () => state.ownership,
    getPullRequest: async () => ({
      number: 2079,
      state: "OPEN",
      headRefName: "feat/rank-backlog-skill",
      headRepository: {
        nameWithOwner: "mento-protocol/monitoring-monorepo",
      },
    }),
    listOpenPullRequestsForBranch: async () => [],
    editIssueLabels: async (_options, current, target) => {
      state.issue = {
        ...current,
        labels: [{ name: target === "review" ? "in-pr" : "agent-active" }],
      };
    },
    updateProjectMetadata: async (
      _options,
      _project,
      _item,
      _target,
      metadata,
    ) => {
      state.ownership = { ...state.ownership, ...metadata };
    },
    withIssueMutationLock: testIssueMutationLock,
    ...overrides,
  };
}

test("explicit review rebind preserves #2071 ownership on the proven PR branch", async () => {
  const state = stageReviewFixture();
  let prReads = 0;
  let oldBranchReads = 0;
  let lockMetadata = null;
  let reviewMetadata = {};
  const [result] = await review(
    stageReviewOptions(),
    stageReviewDependencies(state, {
      getPullRequest: async () => {
        prReads += 1;
        return {
          number: 2079,
          state: "OPEN",
          headRefName: "feat/rank-backlog-skill",
          headRepository: {
            nameWithOwner: "mento-protocol/monitoring-monorepo",
          },
        };
      },
      listOpenPullRequestsForBranch: async (_options, branch) => {
        oldBranchReads += 1;
        assertEqual(branch, "worktree-shoggoth");
        return [];
      },
      withIssueMutationLock: async (_options, _number, metadata, mutation) => {
        lockMetadata = metadata;
        return mutation({ markSafeToUnlock() {} });
      },
      updateProjectMetadata: async (
        _options,
        _project,
        _item,
        target,
        metadata,
      ) => {
        assertEqual(target, "review");
        reviewMetadata = { ...reviewMetadata, ...metadata };
        state.ownership = { ...state.ownership, ...metadata };
      },
    }),
  );
  assertDeepEqual(result, {
    number: 2071,
    title: "operator-triggered backlog sweep",
    state: "review",
  });
  assertEqual(prReads, 6);
  assertEqual(oldBranchReads, 5);
  assertEqual(lockMetadata.previousBranch, "worktree-shoggoth");
  assertEqual(lockMetadata.branch, "feat/rank-backlog-skill");
  assertEqual(lockMetadata.claimId, "claim-2071");
  assertEqual(lockMetadata.claimedAt, "2026-08-27");
  assertEqual(lockMetadata.previousPr, null);
  assertDeepEqual(Object.keys(reviewMetadata).sort(), ["branch", "pr"]);
  assertDeepEqual(state.issue.labels, [{ name: "in-pr" }]);
  assertDeepEqual(state.ownership, {
    claimId: "claim-2071",
    agent: "codex",
    branch: "feat/rank-backlog-skill",
    claimedAt: "2026-08-27",
    pr: 2079,
  });
});

test("review does not overwrite an owner that changes after its label proof", async () => {
  const state = stageReviewFixture();
  const concurrentOwnership = {
    claimId: "claim-owner-b",
    agent: "other",
    branch: "fix/owner-b",
    claimedAt: "2026-08-29",
    pr: null,
  };
  let metadataWrites = 0;
  await assertRejects(
    () =>
      review(
        stageReviewOptions(),
        stageReviewDependencies(state, {
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "review");
            state.issue = { ...current, labels: [{ name: "in-pr" }] };
            state.ownership = { ...concurrentOwnership };
          },
          updateProjectMetadata: async () => {
            metadataWrites += 1;
          },
        }),
      ),
    /ownership changed before review metadata write[\s\S]*review recovery is ambiguous/,
  );
  assertEqual(metadataWrites, 0);
  assertDeepEqual(state.ownership, concurrentOwnership);
});

test("review refuses branch drift without the explicit owner rebind", async () => {
  const state = stageReviewFixture();
  let edits = 0;
  await assertRejects(
    () =>
      review(
        stageReviewOptions({
          claimId: null,
          rebindBranch: false,
          branch: "",
        }),
        stageReviewDependencies(state, {
          editIssueLabels: async () => {
            edits += 1;
          },
        }),
      ),
    /does not match claimed branch worktree-shoggoth.*--rebind-branch/,
  );
  assertEqual(edits, 0);
  assertDeepEqual(state.ownership, stageReviewFixture().ownership);
});

test("review rebind preserves an ambiguous in-pr state when the old branch gains a PR", async () => {
  const state = stageReviewFixture();
  let oldBranchReads = 0;
  await assertRejects(
    () =>
      review(
        stageReviewOptions(),
        stageReviewDependencies(state, {
          listOpenPullRequestsForBranch: async () => {
            oldBranchReads += 1;
            return oldBranchReads < 3 ? [] : [{ number: 2080 }];
          },
        }),
      ),
    /claimed branch worktree-shoggoth has open PR #2080/,
  );
  assertEqual(oldBranchReads, 3);
  assertDeepEqual(state.issue.labels, [{ name: "in-pr" }]);
  assertDeepEqual(state.ownership, stageReviewFixture().ownership);
});

test("review rebind preserves its applied state when the selected PR changes at final proof", async () => {
  const state = stageReviewFixture();
  let prReads = 0;
  await assertRejects(
    () =>
      review(
        stageReviewOptions(),
        stageReviewDependencies(state, {
          getPullRequest: async () => {
            prReads += 1;
            return {
              number: 2079,
              state: "OPEN",
              headRefName:
                prReads < 6 ? "feat/rank-backlog-skill" : "feat/replacement",
              headRepository: {
                nameWithOwner: "mento-protocol/monitoring-monorepo",
              },
            };
          },
        }),
      ),
    /head changed from feat\/rank-backlog-skill to feat\/replacement/,
  );
  assertEqual(prReads, 7);
  assertDeepEqual(state.issue.labels, [{ name: "in-pr" }]);
  assertDeepEqual(state.ownership, {
    claimId: "claim-2071",
    agent: "codex",
    branch: "feat/rank-backlog-skill",
    claimedAt: "2026-08-27",
    pr: 2079,
  });
});

test("review recovery preserves a proven applied in-pr endpoint", async () => {
  const server = createFakeLockServer();
  const state = stageReviewFixture();
  await assertRejects(
    () =>
      review(
        stageReviewOptions(),
        stageReviewDependencies(state, {
          updateProjectMetadata: async (
            _options,
            _project,
            _item,
            target,
            metadata,
          ) => {
            assertEqual(target, "review");
            state.ownership = { ...state.ownership, ...metadata };
            if (Object.hasOwn(metadata, "pr")) {
              throw new Error("review Project response lost");
            }
          },
          withIssueMutationLock: (options, number, metadata, mutation) =>
            withIssueMutationLock(
              options,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        }),
      ),
    /review Project response lost/,
  );
  assertDeepEqual(state.issue.labels, [{ name: "in-pr" }]);
  assertDeepEqual(state.ownership, {
    claimId: "claim-2071",
    agent: "codex",
    branch: "feat/rank-backlog-skill",
    claimedAt: "2026-08-27",
    pr: 2079,
  });
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  assertEqual(
    server.commits.get(server.refOid).payload.outcome,
    "applied review state preserved",
  );
});

test("review label with previous ownership remains LOCK for manual recovery", async () => {
  const server = createFakeLockServer();
  const state = stageReviewFixture();
  await assertRejects(
    () =>
      review(
        stageReviewOptions(),
        stageReviewDependencies(state, {
          updateProjectMetadata: async () => {
            throw new Error("review metadata write refused");
          },
          withIssueMutationLock: (options, number, metadata, mutation) =>
            withIssueMutationLock(
              options,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        }),
      ),
    /review recovery is ambiguous at review with partial or changed ownership[\s\S]*remains at LOCK/,
  );
  assertDeepEqual(state.issue.labels, [{ name: "in-pr" }]);
  assertDeepEqual(state.ownership, stageReviewFixture().ownership);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("review grooming label with previous ownership remains LOCK", async () => {
  const server = createFakeLockServer();
  const state = stageReviewFixture();
  await assertRejects(
    () =>
      review(
        stageReviewOptions(),
        stageReviewDependencies(state, {
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "review");
            state.issue = {
              ...current,
              labels: [{ name: "needs-grooming" }],
            };
            throw new Error("external grooming label response lost");
          },
          withIssueMutationLock: (options, number, metadata, mutation) =>
            withIssueMutationLock(
              options,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        }),
      ),
    /review recovery is ambiguous at grooming with partial or changed ownership[\s\S]*remains at LOCK/,
  );
  assertDeepEqual(state.issue.labels, [{ name: "needs-grooming" }]);
  assertDeepEqual(state.ownership, stageReviewFixture().ownership);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("review grooming label with mixed ownership remains LOCK", async () => {
  const server = createFakeLockServer();
  const state = stageReviewFixture();
  await assertRejects(
    () =>
      review(
        stageReviewOptions(),
        stageReviewDependencies(state, {
          updateProjectMetadata: async (
            _options,
            _project,
            _item,
            _target,
            metadata,
          ) => {
            state.ownership = { ...state.ownership, ...metadata };
            state.issue = {
              ...state.issue,
              labels: [{ name: "needs-grooming" }],
            };
            throw new Error(
              "external grooming followed a partial review write",
            );
          },
          withIssueMutationLock: (options, number, metadata, mutation) =>
            withIssueMutationLock(
              options,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        }),
      ),
    /review recovery is ambiguous at grooming with partial or changed ownership[\s\S]*remains at LOCK/,
  );
  assertDeepEqual(state.issue.labels, [{ name: "needs-grooming" }]);
  assertDeepEqual(state.ownership, {
    ...stageReviewFixture().ownership,
    branch: "feat/rank-backlog-skill",
  });
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("review recovery preserves only a stable empty grooming endpoint", async () => {
  const server = createFakeLockServer();
  const state = stageReviewFixture();
  await assertRejects(
    () =>
      review(
        stageReviewOptions(),
        stageReviewDependencies(state, {
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "review");
            state.issue = {
              ...current,
              labels: [{ name: "needs-grooming" }],
            };
            state.ownership = {
              claimId: null,
              agent: null,
              branch: null,
              claimedAt: null,
              pr: null,
            };
            throw new Error("external grooming completed first");
          },
          withIssueMutationLock: (options, number, metadata, mutation) =>
            withIssueMutationLock(
              options,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        }),
      ),
    /external grooming completed first/,
  );
  assertDeepEqual(state.issue.labels, [{ name: "needs-grooming" }]);
  assertDeepEqual(state.ownership, {
    claimId: null,
    agent: null,
    branch: null,
    claimedAt: null,
    pr: null,
  });
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  assertEqual(
    server.commits.get(server.refOid).payload.outcome,
    "newer grooming review state preserved",
  );
});

test("claim candidate selector skips already tried issues", () => {
  const option = chooseUntriedCandidate(
    [{ number: 901 }, { number: 902 }],
    new Set([901]),
  );

  assertEqual(option.number, 902);
  assertEqual(chooseUntriedCandidate([{ number: 901 }], new Set([901])), null);
});

test("active label transition claims the issue and removes stale state", () => {
  assertDeepEqual(labelsForState("active"), {
    addLabels: ["agent-active"],
    removeLabels: ["agent-ready", "in-pr", "needs-grooming"],
  });
});

test("closed issues with any queue label sync to done", () => {
  for (const label of ISSUE_STATE_LABELS) {
    assertEqual(
      stateFromLabels({
        state: "CLOSED",
        labels: [{ name: label }],
      }),
      "done",
      label,
    );
  }
  assertDeepEqual(labelsForState("done"), {
    addLabels: [],
    removeLabels: ISSUE_STATE_LABELS,
  });
});

test("sync leaves human-owned Status untouched for a stable open issue", async () => {
  const status = { name: "Blocked", optionId: "blocked" };
  const issue = {
    id: "issue-900",
    number: 900,
    title: "human-owned status",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
    projectItems: [
      {
        id: "item-900",
        project: { id: "project" },
        status,
      },
    ],
  };
  let membershipReads = 0;
  let membershipAdds = 0;
  let statusReads = 0;
  let metadataWrites = 0;

  const results = await syncWithTestLock(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ownershipProject(),
      listIssuesByLabels: async () => [issue],
      getIssue: async () => issue,
      findIssueProjectItem: async () => {
        membershipReads += 1;
        return "item-900";
      },
      ensureProjectItem: async () => {
        membershipAdds += 1;
        return "item-900";
      },
      readProjectItemStatus: async () => {
        statusReads += 1;
        return status;
      },
      updateProjectMetadata: async () => {
        metadataWrites += 1;
      },
    },
  );

  assertDeepEqual(results, [
    { number: 900, title: "human-owned status", state: "ready" },
  ]);
  assertEqual(membershipReads, 1);
  assertEqual(membershipAdds, 0);
  assertEqual(statusReads, 0);
  assertEqual(metadataWrites, 0);
  assertDeepEqual(issue.projectItems[0].status, status);
});

test("sync adds a missing open item without writing Project Status", async () => {
  const issue = {
    id: "issue-900b",
    number: 1900,
    title: "missing Project membership",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
    projectItems: [],
  };
  let membershipReads = 0;
  let membershipAdds = 0;
  let statusReads = 0;
  let metadataWrites = 0;

  const results = await syncWithTestLock(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ownershipProject(),
      listIssuesByLabels: async () => [issue],
      getIssue: async () => issue,
      findIssueProjectItem: async () => {
        membershipReads += 1;
        return null;
      },
      ensureProjectItem: async () => {
        membershipAdds += 1;
        return "item-1900";
      },
      readProjectItemStatus: async () => {
        statusReads += 1;
        return { name: "Ready", optionId: "ready" };
      },
      updateProjectMetadata: async () => {
        metadataWrites += 1;
      },
    },
  );

  assertDeepEqual(results, [
    { number: 1900, title: "missing Project membership", state: "ready" },
  ]);
  assertEqual(membershipReads, 1);
  assertEqual(membershipAdds, 1);
  assertEqual(statusReads, 0);
  assertEqual(metadataWrites, 0);
});

test("sync rejects a missing Project membership mutation response", async () => {
  const issue = {
    id: "issue-900c",
    number: 2900,
    title: "missing Project response",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
    projectItems: [],
  };

  await assertRejects(
    () =>
      syncWithTestLock(
        { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
        {
          getProject: async () => ownershipProject(),
          listIssuesByLabels: async () => [issue],
          getIssue: async () => issue,
          findIssueProjectItem: async () => null,
          ensureProjectItem: async () => null,
        },
      ),
    /Project membership mutation did not return the selected item ID/,
  );
});

test("sync reclassifies concurrent open label drift after a membership add", async () => {
  let issue = {
    id: "issue-900d",
    number: 3900,
    title: "open drift after Project add",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
    projectItems: [],
  };
  let ensureCalls = 0;
  let membershipAdds = 0;
  let metadataWrites = 0;

  const results = await syncWithTestLock(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ownershipProject(),
      listIssuesByLabels: async () => [issue],
      getIssue: async () => issue,
      findIssueProjectItem: async () => null,
      ensureProjectItem: async () => {
        ensureCalls += 1;
        if (ensureCalls === 1) {
          membershipAdds += 1;
          issue = {
            ...issue,
            labels: [{ name: "agent-active" }],
            projectItems: [
              {
                id: "item-3900",
                project: { id: "project" },
                status: { name: "Blocked" },
              },
            ],
          };
        }
        return "item-3900";
      },
      updateProjectMetadata: async () => {
        metadataWrites += 1;
      },
      sleep: async () => {},
    },
  );

  assertDeepEqual(results, [
    { number: 3900, title: "open drift after Project add", state: "active" },
  ]);
  assertEqual(ensureCalls, 2);
  assertEqual(membershipAdds, 1);
  assertEqual(metadataWrites, 0);
  assertDeepEqual(issue.projectItems[0].status, { name: "Blocked" });
});

test("sync clears closed queue labels without changing Project Status", async () => {
  const status = { name: "Blocked", optionId: "blocked" };
  let issue = {
    id: "issue-901",
    number: 901,
    title: "closed human-owned status",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
    projectItems: [
      {
        id: "item-901",
        project: { id: "project" },
        status,
      },
    ],
  };
  const edits = [];
  let metadataWrites = 0;

  const results = await syncWithTestLock(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ownershipProject(),
      listIssuesByLabels: async () => [issue],
      getIssue: async () => issue,
      editIssueLabels: async (_options, current, state) => {
        edits.push(state);
        issue = { ...current, labels: [] };
      },
      updateProjectMetadata: async () => {
        metadataWrites += 1;
      },
      sleep: async () => {
        throw new Error("an immediate closeout must not wait");
      },
    },
  );

  assertDeepEqual(results, [
    { number: 901, title: "closed human-owned status", state: "done" },
  ]);
  assertDeepEqual(edits, ["done"]);
  assertEqual(metadataWrites, 0);
  assertDeepEqual(issue.projectItems[0].status, status);
});

test("sync reclassifies a reopen before closed-label cleanup", async () => {
  const closed = {
    number: 902,
    title: "reopened before cleanup",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
  };
  const reopened = {
    ...closed,
    state: "OPEN",
    labels: [{ name: "agent-active" }],
  };
  const reads = [closed, closed, reopened];
  let edits = 0;

  const results = await syncWithTestLock(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ownershipProject(),
      listIssuesByLabels: async () => [closed],
      getIssue: async () => reads.shift() ?? reopened,
      editIssueLabels: async () => {
        edits += 1;
      },
      sleep: async () => {},
    },
  );

  assertDeepEqual(results, [
    { number: 902, title: "reopened before cleanup", state: "active" },
  ]);
  assertEqual(edits, 0);
});

test("sync restores the prior queue label when an issue reopens during cleanup", async () => {
  let issue = {
    number: 903,
    title: "reopened during cleanup",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
  };
  const edits = [];

  const results = await syncWithTestLock(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ownershipProject(),
      listIssuesByLabels: async () => [issue],
      getIssue: async () => issue,
      editIssueLabels: async (_options, current, state) => {
        edits.push(state);
        if (state === "done") {
          issue = { ...current, state: "OPEN", labels: [] };
          return;
        }
        assertEqual(state, "review");
        issue = { ...current, state: "OPEN", labels: [{ name: "in-pr" }] };
      },
      sleep: async () => {},
    },
  );

  assertDeepEqual(results, [
    { number: 903, title: "reopened during cleanup", state: "review" },
  ]);
  assertDeepEqual(edits, ["done", "review"]);
  assertDeepEqual(issue.labels, [{ name: "in-pr" }]);
});

test("sync fails closed while conflicting open queue labels persist", async () => {
  const issue = {
    number: 904,
    title: "conflicting labels",
    state: "OPEN",
    labels: [{ name: "agent-ready" }, { name: "agent-active" }],
  };
  let waits = 0;

  await assertRejects(
    () =>
      syncWithTestLock(
        { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
        {
          getProject: async () => ownershipProject(),
          listIssuesByLabels: async () => [issue],
          getIssue: async () => issue,
          sleep: async () => {
            waits += 1;
          },
        },
      ),
    /retained conflicting queue labels after 3 attempts: agent-ready, agent-active/,
  );
  assertEqual(waits, 2);
});

test("sync reports successful issues before a later label conflict", async () => {
  const ready = {
    number: 905,
    title: "stable ready",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  const conflict = {
    number: 906,
    title: "later conflict",
    state: "OPEN",
    labels: [{ name: "agent-ready" }, { name: "agent-active" }],
  };

  const error = await assertRejects(
    () =>
      syncWithTestLock(
        { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
        {
          getProject: async () => ownershipProject(),
          listIssuesByLabels: async () => [ready, conflict],
          getIssue: async (_options, number) =>
            number === ready.number ? ready : conflict,
          sleep: async () => {},
        },
      ),
    /completed with 1 failure\(s\) after 1 success\(es\)/,
  );
  assert(error instanceof IssueBoardSyncError, "aggregate sync error type");
  assertDeepEqual(error.results, [
    { number: 905, title: "stable ready", state: "ready" },
  ]);
});

test("sync dry-run plans closed-label cleanup without a postcondition read", async () => {
  const issue = {
    number: 907,
    title: "dry-run closed item",
    state: "CLOSED",
    labels: [{ name: "needs-grooming" }],
  };
  let edits = 0;
  let reads = 0;

  const results = await syncWithTestLock(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: true },
    {
      getProject: async () => ownershipProject(),
      listIssuesByLabels: async () => [issue],
      getIssue: async () => {
        reads += 1;
        return issue;
      },
      editIssueLabels: async (_options, _issue, state) => {
        edits += 1;
        assertEqual(state, "done");
      },
    },
  );

  assertEqual(edits, 1);
  assertEqual(reads, 2, "preflight and locked dry-run reads");
  assertDeepEqual(results, [
    { number: 907, title: "dry-run closed item", state: "done" },
  ]);
});

test("claim guard only accepts open agent-ready issues", () => {
  assertEqual(
    isClaimable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    }),
    true,
  );
  assertEqual(
    isClaimable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }, { name: "agent-active" }],
    }),
    false,
  );
  assertEqual(
    isClaimable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }, { name: "needs-grooming" }],
    }),
    false,
  );
  assertEqual(
    isClaimable({
      state: "CLOSED",
      labels: [{ name: "agent-ready" }],
    }),
    false,
  );
});

test("sweep claim guard requires low risk, one package, and no blocker", () => {
  const project = ownershipProject();
  const eligible = {
    state: "OPEN",
    labels: [
      { name: "agent-ready" },
      { name: "risk:low" },
      { name: "pkg:tooling" },
    ],
    projectItems: [projectItemSnapshot(project)],
    blockedBy: { totalCount: 0, nodes: [] },
  };
  assertEqual(isSweepClaimable(eligible, project), true);
  assertEqual(isSweepClaimable(eligible), false);
  assertEqual(
    isSweepClaimable(
      {
        ...eligible,
        labels: [...eligible.labels, { name: "risk:high" }],
      },
      project,
    ),
    false,
  );
  assertEqual(
    isSweepClaimable(
      {
        ...eligible,
        labels: [...eligible.labels, { name: "pkg:dashboard" }],
      },
      project,
    ),
    false,
  );
  assertEqual(
    isSweepClaimable(
      {
        ...eligible,
        blockedBy: { totalCount: 1, nodes: [{ number: 1 }] },
      },
      project,
    ),
    false,
  );
  assertEqual(
    isSweepClaimable(
      {
        ...eligible,
        projectItems: [
          projectItemSnapshot(project, {
            name: "Blocked",
            optionId: "blocked",
          }),
        ],
      },
      project,
    ),
    false,
  );
  assertEqual(
    isSweepClaimable({ ...eligible, blockedBy: undefined }, project),
    false,
  );
});

test("sweep claim guard scopes Blocked status to the selected Project", () => {
  const selectedProject = {
    id: "selected-project",
    title: "Monitoring Agent Workboard",
    statusField: { id: "selected-status" },
  };
  const otherProject = {
    id: "other-project",
    title: selectedProject.title,
    statusField: { id: "other-status" },
  };
  const eligible = {
    state: "OPEN",
    labels: [
      { name: "agent-ready" },
      { name: "risk:low" },
      { name: "pkg:tooling" },
    ],
    projectItems: [
      projectItemSnapshot(otherProject, {
        name: "Blocked",
        optionId: "blocked",
      }),
      projectItemSnapshot(selectedProject),
    ],
    blockedBy: { totalCount: 0, nodes: [] },
  };
  assertEqual(isSweepClaimable(eligible, selectedProject), true);
  assertEqual(
    isSweepClaimable(
      {
        ...eligible,
        projectItems: [
          projectItemSnapshot(otherProject),
          projectItemSnapshot(selectedProject, {
            name: "Blocked",
            optionId: "blocked",
          }),
        ],
      },
      selectedProject,
    ),
    false,
  );
  assertEqual(
    isSweepClaimable(
      {
        ...eligible,
        projectItems: [
          {
            title: selectedProject.title,
            status: { name: "Ready" },
          },
        ],
      },
      selectedProject,
    ),
    false,
  );
  assertEqual(
    isSweepClaimable(
      {
        ...eligible,
        projectItems: [
          projectItemSnapshot(selectedProject),
          projectItemSnapshot(selectedProject),
        ],
      },
      selectedProject,
    ),
    false,
  );
});

test("review guard only accepts open agent-active issues", () => {
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    }),
    true,
  );
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    }),
    false,
  );
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-active" }, { name: "needs-grooming" }],
    }),
    false,
  );
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-active" }, { name: "in-pr" }],
    }),
    false,
  );
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-active" }, { name: "needs-grooming" }],
    }),
    false,
  );
  assertEqual(
    isReviewable({
      state: "CLOSED",
      labels: [{ name: "agent-active" }],
    }),
    false,
  );
});

test("release guard accepts only open active issues", () => {
  assertEqual(
    isReleasable({
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    }),
    true,
  );
  assertEqual(
    isReleasable({
      state: "OPEN",
      labels: [{ name: "in-pr" }],
    }),
    false,
  );
  assertEqual(
    isReleasable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    }),
    false,
  );
  assertEqual(
    isReleasable({
      state: "OPEN",
      labels: [{ name: "agent-active" }, { name: "in-pr" }],
    }),
    false,
  );
  assertEqual(
    isReleasable({
      state: "CLOSED",
      labels: [{ name: "in-pr" }],
    }),
    false,
  );
});

test("PR project field formatting clears null releases", () => {
  assertEqual(projectPrFieldValue(984), "#984");
  assertEqual(projectPrFieldValue(null), null);
  assertEqual(projectPrFieldValue(undefined), null);
});

test("Claimed At project field formatting clears null releases", () => {
  assertEqual(projectDateFieldValue("2026-06-17T10:00:00.000Z"), "2026-06-17");
  assertEqual(projectDateFieldValue(null), null);
  assertEqual(projectDateFieldValue(undefined), null);
});

test("failed claims never roll back to ready", () => {
  assertEqual(shouldRollbackFailedTransition("active", "ready"), false);
  assertEqual(shouldRollbackFailedTransition("review", "active"), true);
  assertEqual(shouldRollbackFailedTransition("ready", null), false);
});

test("a blocker added before a sweep claim quarantines the owned partial claim", async () => {
  const state = {
    ownership: null,
    issue: {
      id: "issue-901",
      number: 901,
      title: "race claim",
      state: "OPEN",
      labels: [
        { name: "agent-ready" },
        { name: "risk:low" },
        { name: "pkg:tooling" },
      ],
      projectItems: [projectItemSnapshot()],
      blockedBy: { totalCount: 0, nodes: [] },
    },
  };
  const project = ownershipProject();
  const metadataStates = [];
  let projectStatus = { name: "Ready", optionId: "ready" };
  await assertRejects(
    () =>
      claimWithTestLock(
        {
          repo: "mento-protocol/monitoring-monorepo",
          issues: [901],
          agent: "codex",
          branch: "fix/901",
          claimId: "sweep-901-token",
          sweepEligible: true,
          bodySha256: EMPTY_BODY_SHA256,
          dryRun: false,
          comment: true,
          pr: null,
        },
        {
          getProject: async () => project,
          getIssue: async () => state.issue,
          ensureProjectItem: async () => "item-901",
          reserveClaimOwnership: async (
            _options,
            _project,
            _item,
            _issue,
            reservationMetadata,
          ) => {
            state.ownership = {
              claimId: reservationMetadata.claimId,
              agent: "codex",
              branch: "fix/901",
              claimedAt: projectDateFieldValue(reservationMetadata.claimedAt),
              pr: null,
            };
            state.issue = {
              ...state.issue,
              blockedBy: { totalCount: 1, nodes: [{ number: 900 }] },
            };
            return { missingMetadata: {} };
          },
          readClaimOwnership: async () => state.ownership,
          readProjectItemStatus: async () => projectStatus,
          editIssueLabels: async (_options, issue, target) => {
            assertEqual(target, "grooming");
            state.issue = {
              ...issue,
              labels: [
                { name: "needs-grooming" },
                { name: "risk:low" },
                { name: "pkg:tooling" },
              ],
            };
          },
          updateProjectMetadata: async (
            _options,
            _project,
            _item,
            target,
            metadata,
          ) => {
            metadataStates.push(target);
            state.ownership = { ...state.ownership, ...metadata };
          },
        },
      ),
    /not sweep-eligible[\s\S]*Claim ID: sweep-901-token[\s\S]*quarantined in needs-grooming/,
  );
  assert(
    state.issue.labels.some((label) => label.name === "needs-grooming"),
    "ineligible partial claim must move to grooming",
  );
  assert(
    !state.issue.labels.some((label) => label.name === "agent-ready"),
    "partial claim must leave the ready queue",
  );
  assertEqual(state.ownership.claimId, "sweep-901-token");
  assertDeepEqual(metadataStates, []);
  assertDeepEqual(projectStatus, { name: "Ready", optionId: "ready" });
});

test("a stale body digest rejects a sweep claim before board mutation", async () => {
  let boardMutations = 0;
  const issue = {
    id: "issue-1899",
    number: 1899,
    title: "stale body snapshot",
    body: "Waiting on an external dependency.",
    state: "OPEN",
    labels: [
      { name: "agent-ready" },
      { name: "risk:low" },
      { name: "pkg:tooling" },
    ],
    projectItems: [projectItemSnapshot()],
    blockedBy: { totalCount: 0, nodes: [] },
  };
  await assertRejects(
    () =>
      claimWithTestLock(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [1899],
          branch: "fix/1899",
          claimId: "sweep-1899-token",
          sweepEligible: true,
          bodySha256: issueBodySha256("No external dependency."),
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => issue,
          ensureProjectItem: async () => {
            boardMutations += 1;
            return "item-1899";
          },
        },
      ),
    /body changed[\s\S]*initial locked check[\s\S]*Claim ID: sweep-1899-token/,
  );
  assertEqual(boardMutations, 0);
});

test("a body change after the label transition cannot complete a sweep claim", async () => {
  let issue = {
    id: "issue-1900",
    number: 1900,
    title: "body race claim",
    body: "No external dependency.",
    state: "OPEN",
    labels: [
      { name: "agent-ready" },
      { name: "risk:low" },
      { name: "pkg:tooling" },
    ],
    projectItems: [projectItemSnapshot()],
    blockedBy: { totalCount: 0, nodes: [] },
  };
  let ownership = null;
  const project = ownershipProject();
  const error = await assertRejects(
    () =>
      claimWithTestLock(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [1900],
          branch: "fix/1900",
          claimId: "sweep-1900-token",
          sweepEligible: true,
          bodySha256: issueBodySha256(issue.body),
          comment: false,
          pr: null,
        },
        {
          getProject: async () => project,
          getIssue: async () => issue,
          ensureProjectItem: async () => "item-1900",
          reserveClaimOwnership: async (
            _options,
            _project,
            _item,
            _issue,
            metadata,
          ) => {
            ownership = {
              claimId: metadata.claimId,
              agent: metadata.agent,
              branch: metadata.branch,
              claimedAt: projectDateFieldValue(metadata.claimedAt),
              pr: null,
            };
            return { ownership, missingMetadata: {} };
          },
          readClaimOwnership: async () => ownership,
          readProjectItemStatus: async () => ({
            name: "Ready",
            optionId: "ready",
          }),
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "active");
            issue = {
              ...current,
              body: "Waiting on an external dependency.",
              labels: [
                { name: "agent-active" },
                { name: "risk:low" },
                { name: "pkg:tooling" },
              ],
            };
          },
          updateProjectMetadata: async () => {},
          verifyClaimOwnership: async () => {},
        },
      ),
    /body changed[\s\S]*post-label check[\s\S]*Claim ID: sweep-1900-token/,
  );
  assertEqual(error.partialClaim, true);
  assertEqual(isClaimable(issue), false);
  assert(
    issue.labels.some((label) => label.name === "agent-active"),
    "a detected body race must retain the partial claim outside ready",
  );
});

test("a Project Blocked change after the pre-metadata check fails the metadata-only claim", async () => {
  let issue = {
    id: "issue-901b",
    number: 1901,
    title: "Project blocker race",
    state: "OPEN",
    labels: [
      { name: "agent-ready" },
      { name: "risk:low" },
      { name: "pkg:tooling" },
    ],
    projectItems: [
      projectItemSnapshot(ownershipProject(), { id: "item-1901" }),
    ],
    blockedBy: { totalCount: 0, nodes: [] },
  };
  const ownership = {
    claimId: "sweep-1901-token",
    agent: "codex",
    branch: "fix/1901",
    claimedAt: "2026-08-28",
    pr: null,
  };
  const statuses = [
    { name: "Ready", optionId: "ready" },
    { name: "Ready", optionId: "ready" },
    { name: "Ready", optionId: "ready" },
    { name: "Blocked", optionId: "blocked" },
    { name: "Blocked", optionId: "blocked" },
  ];
  let metadataWrites = 0;
  const error = await assertRejects(
    () =>
      claimWithTestLock(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [1901],
          branch: "fix/1901",
          claimId: "sweep-1901-token",
          sweepEligible: true,
          bodySha256: EMPTY_BODY_SHA256,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => issue,
          ensureProjectItem: async () => "item-1901",
          reserveClaimOwnership: async (
            _options,
            _project,
            _item,
            _issue,
            reservationMetadata,
          ) => {
            ownership.claimedAt = projectDateFieldValue(
              reservationMetadata.claimedAt,
            );
            return { missingMetadata: {} };
          },
          readClaimOwnership: async () => ownership,
          readProjectItemStatus: async () => statuses.shift(),
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "active");
            issue = {
              ...current,
              labels: [
                { name: "agent-active" },
                { name: "risk:low" },
                { name: "pkg:tooling" },
              ],
            };
          },
          updateProjectMetadata: async () => {
            metadataWrites += 1;
          },
        },
      ),
    /became Project Blocked during post-metadata check[\s\S]*Claim ID: sweep-1901-token/,
  );
  assertEqual(metadataWrites, 0);
  assert(
    error.message.includes("remains non-ready in active"),
    "the observed blocker race must retain a non-ready owned state",
  );
  assertEqual(statuses.length, 0);
  assertEqual(isClaimable(issue), false);
});

test("partial sweep compensation stops when Project Status changes after its label transition", async () => {
  let issue = {
    id: "issue-1902",
    number: 1902,
    title: "compensation Status race",
    state: "OPEN",
    labels: [
      { name: "agent-ready" },
      { name: "risk:low" },
      { name: "pkg:tooling" },
    ],
    projectItems: [projectItemSnapshot()],
    blockedBy: { totalCount: 0, nodes: [] },
  };
  const ownership = {
    claimId: "sweep-1902-token",
    agent: "codex",
    branch: "fix/1902",
    claimedAt: null,
    pr: null,
  };
  const statuses = [
    { name: "Ready", optionId: "ready" },
    { name: "Ready", optionId: "ready" },
    { name: "Blocked", optionId: "blocked" },
  ];
  let reservations = 0;
  let metadataWrites = 0;

  await assertRejects(
    () =>
      claimWithTestLock(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [1902],
          branch: "fix/1902",
          claimId: "sweep-1902-token",
          sweepEligible: true,
          bodySha256: EMPTY_BODY_SHA256,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => issue,
          ensureProjectItem: async () => "item-1902",
          reserveClaimOwnership: async () => {
            reservations += 1;
            throw new Error("ownership reservation response was lost");
          },
          readClaimOwnership: async () => ownership,
          readProjectItemStatus: async () => statuses.shift(),
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "active");
            issue = {
              ...current,
              labels: [
                { name: "agent-active" },
                { name: "risk:low" },
                { name: "pkg:tooling" },
              ],
            };
          },
          updateProjectMetadata: async () => {
            metadataWrites += 1;
          },
        },
      ),
    /ownership reservation response was lost[\s\S]*Claim ID: sweep-1902-token/,
  );
  assertEqual(reservations, 1);
  assertEqual(metadataWrites, 0);
  assertEqual(statuses.length, 0);
  assertEqual(isClaimable(issue), false);
});

test("retrying an owned partial claim repairs project metadata", async () => {
  const issue = {
    id: "issue-902",
    number: 902,
    title: "partial claim metadata",
    state: "OPEN",
    labels: [
      { name: "agent-active" },
      { name: "risk:low" },
      { name: "pkg:tooling" },
    ],
    projectItems: [
      projectItemSnapshot(ownershipProject(), {
        id: "item-902",
        name: "In Progress",
        optionId: "active",
      }),
    ],
    blockedBy: { totalCount: 0, nodes: [] },
  };
  const project = ownershipProject();
  let reserved = false;
  let metadata = {};
  const ownership = {
    claimId: "sweep-902-token",
    agent: null,
    branch: null,
    claimedAt: null,
    pr: null,
  };
  let verified = false;

  const results = await claimWithTestLock(
    {
      repo: "mento-protocol/monitoring-monorepo",
      issues: [902],
      agent: "codex",
      branch: "fix/902",
      claimId: "sweep-902-token",
      sweepEligible: true,
      bodySha256: EMPTY_BODY_SHA256,
      dryRun: false,
      comment: true,
      pr: null,
    },
    {
      getProject: async () => project,
      now: () => new Date("2026-08-20T09:00:00.000Z"),
      getIssue: async () => issue,
      findIssueProjectItem: async () => "item-902",
      readClaimOwnership: async () => ownership,
      readProjectItemStatus: async () => ({
        name: "In Progress",
        optionId: "active",
      }),
      reserveClaimOwnership: async (
        _options,
        _project,
        _item,
        _issue,
        reservationMetadata,
      ) => {
        assertEqual(reservationMetadata.claimId, "sweep-902-token");
        reserved = true;
        return {
          missingMetadata: {
            agent: "codex",
            branch: "fix/902",
            claimedAt: reservationMetadata.claimedAt,
          },
        };
      },
      updateProjectMetadata: async (
        _options,
        _project,
        _item,
        state,
        nextMetadata,
      ) => {
        assertEqual(state, "active");
        metadata = { ...metadata, ...nextMetadata };
        Object.assign(ownership, {
          ...nextMetadata,
          claimedAt: Object.hasOwn(nextMetadata, "claimedAt")
            ? projectDateFieldValue(nextMetadata.claimedAt)
            : ownership.claimedAt,
        });
      },
      verifyClaimOwnership: async () => {
        assert(reserved, "recovery must reserve its token before verification");
        assert(metadata, "recovery must restore metadata before verification");
        verified = true;
      },
      listIssueComments: async () => [
        trustedComment({
          issue: 902,
          claimId: "sweep-902-token",
          branch: "fix/902",
          claimedAt: "2026-08-20T09:00:00.000Z",
        }),
      ],
      commentOnIssue: async () => {
        throw new Error("recovery must not add a duplicate claim comment");
      },
    },
  );

  assert(verified, "recovery must verify the repaired claim");
  assertEqual(metadata.agent, "codex");
  assertEqual(metadata.branch, "fix/902");
  assertEqual(Object.hasOwn(metadata, "claimId"), false);
  assertEqual(Object.hasOwn(metadata, "pr"), false);
  assert(
    !Number.isNaN(Date.parse(metadata.claimedAt)),
    `unexpected recovery timestamp: ${metadata.claimedAt}`,
  );
  assertDeepEqual(results, [
    {
      number: 902,
      title: "partial claim metadata",
      state: "active",
      claimId: "sweep-902-token",
      recovered: true,
    },
  ]);
});

test("same-token recovery creates a missing trusted claim comment once", async () => {
  const issue = {
    id: "issue-9021",
    number: 9021,
    title: "missing recovery comment",
    state: "OPEN",
    labels: [{ name: "agent-active" }],
  };
  const ownership = {
    claimId: "claim-9021",
    agent: "codex",
    branch: "fix/9021",
    claimedAt: "2026-08-20",
    pr: null,
  };
  const posted = [];
  let commentReads = 0;
  const [result] = await claimWithTestLock(
    {
      ...LOCK_TEST_OPTIONS,
      issues: [9021],
      branch: "fix/9021",
      claimId: "claim-9021",
      sweepEligible: false,
      comment: true,
      pr: null,
    },
    {
      getProject: async () => ownershipProject(),
      now: () => new Date("2026-08-21T09:00:00.000Z"),
      getIssue: async () => issue,
      findIssueProjectItem: async () => "item-9021",
      readClaimOwnership: async () => ownership,
      reserveClaimOwnership: async () => ({
        ownership,
        missingMetadata: {},
      }),
      updateProjectMetadata: async () => {
        throw new Error("complete recovery must not rewrite ownership");
      },
      verifyClaimOwnership: async () => {},
      listIssueComments: async () => {
        commentReads += 1;
        if (commentReads === 1) return [];
        return [
          {
            id: "posted-comment",
            createdAt: "2026-08-21T10:00:00.000Z",
            authorAssociation: "MEMBER",
            body: posted[0]?.body,
          },
        ];
      },
      commentOnIssue: async (_options, postedIssue, body) => {
        posted.push({ issue: postedIssue.number, body });
      },
      withIssueMutationLock: preparedTestIssueMutationLock,
    },
  );
  assertEqual(result.recovered, true);
  assertEqual(commentReads, 2);
  assertEqual(posted.length, 1);
  assertEqual(posted[0].issue, 9021);
  const parsed = parseClaimComment(
    {
      id: "posted-comment",
      createdAt: "2026-08-21T10:00:00.000Z",
      authorAssociation: "MEMBER",
      body: posted[0].body,
    },
    9021,
  );
  assert(parsed, "recovery must create a trusted-parser-compatible comment");
  assertEqual(parsed.metadata.Agent, "codex");
  assertEqual(parsed.metadata["Claim ID"], "claim-9021");
  assertEqual(parsed.metadata.Branch, "fix/9021");
  assertEqual(parsed.metadata["Claimed At"], "2026-08-20");
});

test("fresh claim comment failure rejects and same-token retry posts a trusted comment", async () => {
  const issue = {
    id: "issue-9025",
    number: 9025,
    title: "fresh claim comment failure",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  const ownership = {
    claimId: null,
    agent: null,
    branch: null,
    claimedAt: null,
    pr: null,
  };
  const comments = [];
  let commentWritesShouldFail = true;
  let commentReads = 0;
  let reservations = 0;
  let labelWrites = 0;
  let metadataWrites = 0;
  const options = {
    ...LOCK_TEST_OPTIONS,
    issues: [9025],
    branch: "fix/9025",
    claimId: "claim-9025",
    sweepEligible: false,
    comment: true,
    pr: null,
  };
  const dependencies = {
    getProject: async () => ownershipProject(),
    now: () => new Date("2026-08-21T09:00:00.000Z"),
    getIssue: async () => issue,
    ensureProjectItem: async () => "item-9025",
    findIssueProjectItem: async () => "item-9025",
    readClaimOwnership: async () => ownership,
    reserveClaimOwnership: async (
      _options,
      _project,
      _item,
      _issue,
      metadata,
    ) => {
      reservations += 1;
      if (ownership.claimId && ownership.claimId !== metadata.claimId) {
        throw new Error(`unexpected Claim ID ${metadata.claimId}`);
      }
      ownership.claimId ??= metadata.claimId;
      return {
        ownership,
        missingMetadata: {
          agent: metadata.agent,
          branch: metadata.branch,
          claimedAt: metadata.claimedAt,
          pr: metadata.pr ?? null,
        },
      };
    },
    editIssueLabels: async (_options, _issue, state) => {
      labelWrites += 1;
      const transition = labelsForState(state);
      issue.labels = issue.labels.filter(
        ({ name }) => !transition.removeLabels.includes(name),
      );
      issue.labels.push(...transition.addLabels.map((name) => ({ name })));
    },
    updateProjectMetadata: async (
      _options,
      _project,
      _item,
      state,
      metadata,
    ) => {
      assertEqual(state, "active");
      metadataWrites += 1;
      for (const [field, value] of Object.entries(metadata)) {
        ownership[field] =
          field === "claimedAt" ? projectDateFieldValue(value) : value;
      }
    },
    verifyClaimOwnership: async () => {
      assertEqual(ownership.claimId, "claim-9025");
      assertEqual(ownership.agent, "codex");
      assertEqual(ownership.branch, "fix/9025");
      assertEqual(ownership.claimedAt, "2026-08-21");
      assertEqual(ownership.pr, null);
    },
    listIssueComments: async () => {
      commentReads += 1;
      return comments;
    },
    commentOnIssue: async (_options, postedIssue, body) => {
      if (commentWritesShouldFail) {
        throw new Error("comment rejected");
      }
      comments.push({
        id: `posted-${comments.length + 1}`,
        createdAt: "2026-08-21T10:00:00.000Z",
        authorAssociation: "MEMBER",
        issue: postedIssue.number,
        body,
      });
    },
    withIssueMutationLock: preparedTestIssueMutationLock,
  };

  const firstError = await assertRejects(
    () => claimWithTestLock(options, dependencies),
    /comment rejected[\s\S]*Claim ID: claim-9025/,
  );

  assertEqual(firstError.partialClaim, true);
  assertEqual(
    issue.labels.some(({ name }) => name === "agent-active"),
    true,
  );
  assertEqual(comments.length, 0);
  assertEqual(commentReads, 1);
  assertEqual(labelWrites, 1);
  assert(metadataWrites > 0, "fresh claim must complete ownership metadata");

  commentWritesShouldFail = false;
  commentReads = 0;
  const [result] = await claimWithTestLock(options, dependencies);

  assertDeepEqual(result, {
    number: 9025,
    title: "fresh claim comment failure",
    state: "active",
    claimId: "claim-9025",
    recovered: true,
  });
  assert(reservations >= 2, "retry must re-reserve the same claim token");
  assertEqual(commentReads, 2);
  assertEqual(comments.length, 1);
  assertEqual(comments[0].issue, 9025);
  const parsed = parseClaimComment(comments[0], 9025);
  assert(parsed, "retry must post a trusted-parser-compatible comment");
  assertEqual(parsed.metadata.Agent, "codex");
  assertEqual(parsed.metadata["Claim ID"], "claim-9025");
  assertEqual(parsed.metadata.Branch, "fix/9025");
  assertEqual(parsed.metadata["Claimed At"], "2026-08-21");
});

test("fresh claim rejects absent, untrusted, or malformed claim comment proof", async () => {
  for (const [index, [name, recordPostedComment]] of [
    ["absent", () => {}],
    [
      "untrusted",
      ({ body, comments, number }) => {
        comments.push({
          id: `posted-${number}`,
          createdAt: "2026-08-21T10:00:00.000Z",
          authorAssociation: "CONTRIBUTOR",
          body,
        });
      },
    ],
    [
      "malformed",
      ({ body, comments, number }) => {
        comments.push({
          id: `posted-${number}`,
          createdAt: "2026-08-21T10:00:00.000Z",
          authorAssociation: "MEMBER",
          body: `${body}\nBranch: injected-second-branch`,
        });
      },
    ],
  ].entries()) {
    const number = 9026 + index;
    const issue = {
      id: `issue-${number}`,
      number,
      title: `fresh claim ${name} comment proof`,
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    };
    const ownership = {
      claimId: null,
      agent: null,
      branch: null,
      claimedAt: null,
      pr: null,
    };
    const comments = [];
    let commentReads = 0;
    let commentWrites = 0;
    let metadataWrites = 0;
    const claimId = `claim-${number}`;
    const branch = `fix/${number}`;
    const error = await assertRejects(
      () =>
        claimWithTestLock(
          {
            ...LOCK_TEST_OPTIONS,
            issues: [number],
            branch,
            claimId,
            sweepEligible: false,
            comment: true,
            pr: null,
          },
          {
            getProject: async () => ownershipProject(),
            now: () => new Date("2026-08-21T09:00:00.000Z"),
            getIssue: async () => issue,
            ensureProjectItem: async () => `item-${number}`,
            findIssueProjectItem: async () => `item-${number}`,
            readClaimOwnership: async () => ownership,
            reserveClaimOwnership: async (
              _options,
              _project,
              _item,
              _issue,
              metadata,
            ) => {
              if (ownership.claimId && ownership.claimId !== metadata.claimId) {
                throw new Error(`unexpected Claim ID ${metadata.claimId}`);
              }
              ownership.claimId ??= metadata.claimId;
              return {
                ownership,
                missingMetadata: {
                  agent: metadata.agent,
                  branch: metadata.branch,
                  claimedAt: metadata.claimedAt,
                  pr: metadata.pr ?? null,
                },
              };
            },
            editIssueLabels: async (_options, _issue, state) => {
              const transition = labelsForState(state);
              issue.labels = issue.labels.filter(
                ({ name: label }) => !transition.removeLabels.includes(label),
              );
              issue.labels.push(
                ...transition.addLabels.map((label) => ({ name: label })),
              );
            },
            updateProjectMetadata: async (
              _options,
              _project,
              _item,
              state,
              metadata,
            ) => {
              assertEqual(state, "active");
              metadataWrites += 1;
              for (const [field, value] of Object.entries(metadata)) {
                ownership[field] =
                  field === "claimedAt" ? projectDateFieldValue(value) : value;
              }
            },
            verifyClaimOwnership: async () => {
              assertEqual(ownership.claimId, claimId);
              assertEqual(ownership.agent, "codex");
              assertEqual(ownership.branch, branch);
              assertEqual(ownership.claimedAt, "2026-08-21");
              assertEqual(ownership.pr, null);
            },
            listIssueComments: async () => {
              commentReads += 1;
              return comments;
            },
            commentOnIssue: async (_options, _postedIssue, body) => {
              commentWrites += 1;
              recordPostedComment({ body, comments, number });
            },
            withIssueMutationLock: preparedTestIssueMutationLock,
          },
        ),
      /claim comment was not confirmed as a trusted parseable claim after posting[\s\S]*Claim ID:/,
    );
    assertEqual(error.partialClaim, true);
    assertEqual(
      issue.labels.some(({ name: label }) => label === "agent-active"),
      true,
    );
    assertEqual(ownership.claimId, claimId);
    assertEqual(ownership.agent, "codex");
    assertEqual(ownership.branch, branch);
    assertEqual(ownership.claimedAt, "2026-08-21");
    assertEqual(commentReads, 2);
    assertEqual(commentWrites, 1);
    assert(metadataWrites > 0, "fresh claim must complete ownership metadata");
  }
});

test("same-token recovery rejects unsafe metadata before comment recovery", async () => {
  for (const [, character] of UNSAFE_SINGLE_LINE_TEST_CHARACTERS) {
    for (const [metadata, pattern] of [
      [
        { agent: `codex${character}bot`, branch: "fix/9026" },
        /Agent must be 1-120/,
      ],
      [
        { agent: "codex", branch: `fix/9026${character}next` },
        /Branch must be 1-256/,
      ],
    ]) {
      let projectReads = 0;
      let lockCalls = 0;
      let commentReads = 0;
      let commentWrites = 0;
      await assertRejects(
        () =>
          claim(
            {
              ...LOCK_TEST_OPTIONS,
              ...metadata,
              issues: [9026],
              claimId: "claim-9026",
              sweepEligible: false,
              comment: true,
              pr: null,
            },
            {
              getProject: async () => {
                projectReads += 1;
                return ownershipProject();
              },
              withIssueMutationLock: async () => {
                lockCalls += 1;
              },
              listIssueComments: async () => {
                commentReads += 1;
                return [];
              },
              commentOnIssue: async () => {
                commentWrites += 1;
              },
            },
          ),
        pattern,
      );
      assertEqual(projectReads, 0);
      assertEqual(lockCalls, 0);
      assertEqual(commentReads, 0);
      assertEqual(commentWrites, 0);
    }
  }
});

test("same-token recovery refuses an untrusted or malformed post-write claim comment", async () => {
  for (const [name, postedComment] of [
    [
      "untrusted",
      (body) => ({
        id: "posted-untrusted",
        createdAt: "2026-08-21T10:00:00.000Z",
        authorAssociation: "CONTRIBUTOR",
        body,
      }),
    ],
    [
      "malformed",
      (body) => ({
        id: "posted-malformed",
        createdAt: "2026-08-21T10:00:00.000Z",
        authorAssociation: "MEMBER",
        body: `${body}\nBranch: injected-second-branch`,
      }),
    ],
  ]) {
    const issue = {
      id: `issue-9024-${name}`,
      number: 9024,
      title: `untrusted recovery comment ${name}`,
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    };
    const ownership = {
      claimId: "claim-9024",
      agent: "codex",
      branch: "fix/9024",
      claimedAt: "2026-08-20",
      pr: null,
    };
    const comments = [];
    let posts = 0;
    let commentReads = 0;
    await assertRejects(
      () =>
        claimWithTestLock(
          {
            ...LOCK_TEST_OPTIONS,
            issues: [9024],
            branch: "fix/9024",
            claimId: "claim-9024",
            sweepEligible: false,
            comment: true,
            pr: null,
          },
          {
            getProject: async () => ownershipProject(),
            now: () => new Date("2026-08-21T09:00:00.000Z"),
            getIssue: async () => issue,
            findIssueProjectItem: async () => "item-9024",
            readClaimOwnership: async () => ownership,
            reserveClaimOwnership: async () => ({
              ownership,
              missingMetadata: {},
            }),
            updateProjectMetadata: async () => {
              throw new Error("complete recovery must not rewrite ownership");
            },
            verifyClaimOwnership: async () => {},
            listIssueComments: async () => {
              commentReads += 1;
              return comments;
            },
            commentOnIssue: async (_options, _postedIssue, body) => {
              posts += 1;
              comments.push(postedComment(body));
            },
            withIssueMutationLock: preparedTestIssueMutationLock,
          },
        ),
      /claim comment was not confirmed as a trusted parseable claim after posting/,
    );
    assertEqual(posts, 1);
    assertEqual(commentReads, 2);
  }
});

test("same-token recovery preserves no-comment and dry-run behavior", async () => {
  for (const [comment, dryRun] of [
    [false, false],
    [true, true],
  ]) {
    const number = dryRun ? 9023 : 9022;
    const issue = {
      id: `issue-${number}`,
      number,
      title: "comment-free recovery",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    };
    const ownership = {
      claimId: `claim-${number}`,
      agent: "codex",
      branch: `fix/${number}`,
      claimedAt: "2026-08-20",
      pr: null,
    };
    const [result] = await claimWithTestLock(
      {
        ...LOCK_TEST_OPTIONS,
        issues: [number],
        branch: `fix/${number}`,
        claimId: `claim-${number}`,
        sweepEligible: false,
        comment,
        dryRun,
        pr: null,
      },
      {
        getProject: async () => ownershipProject(),
        getIssue: async () => issue,
        findIssueProjectItem: async () => `item-${number}`,
        readClaimOwnership: async () => ownership,
        reserveClaimOwnership: async () => ({
          ownership,
          missingMetadata: {},
        }),
        updateProjectMetadata: async () => {},
        verifyClaimOwnership: async () => {},
        listIssueComments: async () => {
          throw new Error("comment-free recovery must not read comments");
        },
        commentOnIssue: async () => {
          throw new Error("comment-free recovery must not post a comment");
        },
        withIssueMutationLock: preparedTestIssueMutationLock,
      },
    );
    assertEqual(result.recovered, true);
  }
});

test("same-token recovery refuses every non-empty ownership mismatch", async () => {
  const issue = {
    id: "issue-903",
    number: 903,
    title: "conflicting same-token retry",
    state: "OPEN",
    labels: [{ name: "agent-active" }],
  };
  let reservations = 0;
  let projectWrites = 0;
  const error = await assertRejects(
    () =>
      claimWithTestLock(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [903],
          agent: "codex",
          branch: "fix/new-903",
          claimId: "claim-903",
          sweepEligible: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => issue,
          findIssueProjectItem: async () => "item-903",
          readClaimOwnership: async () => ({
            claimId: "claim-903",
            agent: "other-agent",
            branch: "fix/old-903",
            claimedAt: "1900-01-01",
            pr: 1903,
          }),
          reserveClaimOwnership: async () => {
            reservations += 1;
          },
          updateProjectMetadata: async () => {
            projectWrites += 1;
          },
          withIssueMutationLock: preparedTestIssueMutationLock,
        },
      ),
    /same-token claim recovery conflicts in agent, branch, pr[\s\S]*issue:review --rebind-branch/,
  );
  assert(error.cause instanceof IssueOwnershipConflictError);
  assertDeepEqual(error.cause.details.conflictingFields, [
    "agent",
    "branch",
    "pr",
  ]);
  assertEqual(reservations, 0);
  assertEqual(projectWrites, 0);
});

test("same-token retries preserve stored Claimed At in next-day LOCK payloads", async () => {
  for (const [index, initialLabel] of [
    "agent-active",
    "agent-ready",
  ].entries()) {
    const number = 904 + index;
    const claimedAt = "2026-08-28";
    const server = createFakeLockServer();
    let issue = {
      id: `issue-${number}`,
      number,
      title: "fill-only same-token retry",
      state: "OPEN",
      labels: [{ name: initialLabel }],
    };
    const ownership = {
      claimId: `claim-${number}`,
      agent: "codex",
      branch: `fix/${number}`,
      claimedAt,
      pr: null,
    };
    let metadataWrites = 0;
    let verificationMetadata = null;
    const [result] = await claim(
      {
        ...LOCK_TEST_OPTIONS,
        issues: [number],
        branch: `fix/${number}`,
        claimId: `claim-${number}`,
        sweepEligible: false,
        comment: false,
        pr: null,
      },
      {
        getProject: async () => ownershipProject(),
        now: () => new Date("2026-08-29T01:00:00.000Z"),
        getIssue: async () => issue,
        findIssueProjectItem: async () => `item-${number}`,
        ensureProjectItem: async () => `item-${number}`,
        readClaimOwnership: async () => ownership,
        reserveClaimOwnership: async () => ({ missingMetadata: {} }),
        editIssueLabels: async (_options, current, target) => {
          assertEqual(target, "active");
          issue = { ...current, labels: [{ name: "agent-active" }] };
        },
        updateProjectMetadata: async () => {
          metadataWrites += 1;
        },
        verifyClaimOwnership: async (
          _options,
          _project,
          _item,
          _issue,
          metadata,
        ) => {
          verificationMetadata = metadata;
        },
        sleep: async () => {},
        withIssueMutationLock: (
          options,
          issueNumber,
          metadata,
          mutation,
          lockOverrides,
        ) =>
          withIssueMutationLock(
            options,
            issueNumber,
            metadata,
            mutation,
            server.withOperations(lockOverrides),
          ),
      },
    );
    const unlockPayload = server.commits.get(server.refOid).payload;
    const lockPayload = server.commits.get(unlockPayload.parentLock).payload;
    assertEqual(lockPayload.claimedAt, claimedAt);
    assertEqual(unlockPayload.claimedAt, claimedAt);
    assertEqual(verificationMetadata.claimedAt, claimedAt);
    assertEqual(metadataWrites, 0);
    assertEqual(
      result.recovered,
      initialLabel === "agent-active" ? true : undefined,
    );
  }
});

test("fresh claim does not overwrite an owner that changes after labels", async () => {
  let issue = {
    id: "issue-9041",
    number: 9041,
    title: "fresh claim owner race",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  let ownership = null;
  const concurrentOwnership = {
    claimId: "claim-owner-b",
    agent: "other",
    branch: "fix/owner-b",
    claimedAt: "2026-08-29",
    pr: null,
  };
  let metadataWrites = 0;
  await assertRejects(
    () =>
      claimWithTestLock(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [9041],
          branch: "fix/9041",
          claimId: "claim-owner-a",
          sweepEligible: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => issue,
          ensureProjectItem: async () => "item-9041",
          reserveClaimOwnership: async (
            _options,
            _project,
            _item,
            _issue,
            metadata,
          ) => {
            ownership = {
              claimId: metadata.claimId,
              agent: null,
              branch: null,
              claimedAt: null,
              pr: null,
            };
            return { missingMetadata: metadata };
          },
          readClaimOwnership: async () => ownership,
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "active");
            issue = { ...current, labels: [{ name: "agent-active" }] };
            ownership = { ...concurrentOwnership };
          },
          updateProjectMetadata: async () => {
            metadataWrites += 1;
          },
        },
      ),
    /ownership changed before its metadata write[\s\S]*Claim ID: claim-owner-a/,
  );
  assertEqual(metadataWrites, 0);
  assertDeepEqual(ownership, concurrentOwnership);
});

test("same-token recovery re-plans when another owner appears before write", async () => {
  const issue = {
    id: "issue-9042",
    number: 9042,
    title: "same-token owner race",
    state: "OPEN",
    labels: [{ name: "agent-active" }],
  };
  const ownerA = {
    claimId: "claim-owner-a",
    agent: "codex",
    branch: "fix/9042",
    claimedAt: "2026-08-28",
    pr: null,
  };
  const ownerB = {
    claimId: "claim-owner-b",
    agent: "other",
    branch: "fix/owner-b",
    claimedAt: "2026-08-29",
    pr: null,
  };
  let ownershipReads = 0;
  let metadataWrites = 0;
  await assertRejects(
    () =>
      claimWithTestLock(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [9042],
          branch: "fix/9042",
          claimId: "claim-owner-a",
          sweepEligible: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => issue,
          findIssueProjectItem: async () => "item-9042",
          readClaimOwnership: async () => {
            ownershipReads += 1;
            return ownershipReads < 4 ? ownerA : ownerB;
          },
          reserveClaimOwnership: async () => ({ missingMetadata: {} }),
          updateProjectMetadata: async () => {
            metadataWrites += 1;
          },
          withIssueMutationLock: preparedTestIssueMutationLock,
        },
      ),
    /ownership changed before its metadata write[\s\S]*Claim ID: claim-owner-a/,
  );
  assertEqual(metadataWrites, 0);
  assert(
    ownershipReads >= 3,
    "the final metadata fence must re-read ownership",
  );
});

test("partial-claim recovery does not overwrite an owner added after labels", async () => {
  let issue = {
    id: "issue-9043",
    number: 9043,
    title: "partial recovery owner race",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  const ownerA = {
    claimId: "claim-owner-a",
    agent: "codex",
    branch: "fix/9043",
    claimedAt: "2026-08-29",
    pr: null,
  };
  const ownerB = {
    claimId: "claim-owner-b",
    agent: "other",
    branch: "fix/owner-b",
    claimedAt: "2026-08-29",
    pr: null,
  };
  let ownership = ownerA;
  let reservationCalls = 0;
  let metadataWrites = 0;
  await assertRejects(
    () =>
      claimWithTestLock(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [9043],
          branch: "fix/9043",
          claimId: "claim-owner-a",
          sweepEligible: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          now: () => new Date("2026-08-29T01:00:00.000Z"),
          getIssue: async () => issue,
          ensureProjectItem: async () => "item-9043",
          readClaimOwnership: async () => ownership,
          reserveClaimOwnership: async () => {
            reservationCalls += 1;
            if (reservationCalls === 1) {
              throw new Error("claim reservation response lost");
            }
            return { missingMetadata: {} };
          },
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "active");
            issue = { ...current, labels: [{ name: "agent-active" }] };
            ownership = { ...ownerB };
          },
          updateProjectMetadata: async () => {
            metadataWrites += 1;
          },
        },
      ),
    /claim reservation response lost[\s\S]*Claim ID: claim-owner-a/,
  );
  assertEqual(reservationCalls, 2);
  assertEqual(metadataWrites, 0);
  assertDeepEqual(ownership, ownerB);
});

test("claim dry-run plans ownership for a prospective Project item without reading it", async () => {
  const issue = {
    id: "issue-905",
    number: 905,
    title: "prospective dry-run claim",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  let labelPlans = 0;
  let projectPlans = 0;
  let comments = 0;
  const [result] = await claimWithTestLock(
    {
      ...LOCK_TEST_OPTIONS,
      issues: [905],
      branch: "fix/905",
      claimId: "claim-905",
      sweepEligible: false,
      comment: true,
      pr: null,
      dryRun: true,
    },
    {
      getProject: async () => ownershipProject(),
      getIssue: async () => issue,
      ensureProjectItem: async () => PROSPECTIVE_PROJECT_ITEM_ID,
      editIssueLabels: async () => {
        labelPlans += 1;
      },
      updateProjectMetadata: async (
        _options,
        _project,
        itemId,
        target,
        metadata,
      ) => {
        assertEqual(itemId, PROSPECTIVE_PROJECT_ITEM_ID);
        assertEqual(target, "active");
        assertEqual(metadata.claimId, "claim-905");
        projectPlans += 1;
      },
      commentOnIssue: async () => {
        comments += 1;
      },
    },
  );
  assertDeepEqual(result, {
    number: 905,
    title: "prospective dry-run claim",
    state: "active",
    claimId: "claim-905",
  });
  assertEqual(labelPlans, 1);
  assertEqual(projectPlans, 1);
  assertEqual(comments, 1);
});

test("a PR opened during release restores the exact active snapshot", async () => {
  const state = {
    issue: {
      id: "issue-901",
      number: 901,
      title: "release race",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: {
      claimId: "sweep-901-token",
      agent: "codex",
      branch: "fix/901",
      claimedAt: "2026-08-28",
      pr: null,
    },
  };
  const project = ownershipProject();
  let prReads = 0;
  const projectStates = [];
  await assertRejects(
    () =>
      releaseWithTestLock(
        {
          repo: "mento-protocol/monitoring-monorepo",
          issues: [901],
          agent: "codex",
          branch: "",
          claimId: "sweep-901-token",
          releaseState: "ready",
          dryRun: false,
          comment: true,
        },
        {
          getProject: async () => project,
          getIssue: async () => state.issue,
          findIssueProjectItem: async () => "item-901",
          readClaimOwnership: async () => state.ownership,
          listOpenPullRequestsForBranch: async () => {
            prReads += 1;
            return prReads < 3 ? [] : [{ number: 77, headRefName: "fix/901" }];
          },
          editIssueLabels: async (_options, issue, target) => {
            state.issue = {
              ...issue,
              labels: [
                {
                  name:
                    target === "review"
                      ? "in-pr"
                      : target === "active"
                        ? "agent-active"
                        : "agent-ready",
                },
              ],
            };
          },
          updateProjectMetadata: async (
            _options,
            _project,
            _item,
            target,
            metadata,
          ) => {
            projectStates.push(target);
            state.ownership = { ...state.ownership, ...metadata };
          },
        },
      ),
    /branch fix\/901 has open PR #77/,
  );
  assertDeepEqual(
    state.issue.labels.map((label) => label.name),
    ["agent-active"],
  );
  assertEqual(prReads, 3);
  assertEqual(state.ownership.claimId, "sweep-901-token");
  assertDeepEqual(projectStates, []);
});

test("release does not clear an owner that changes after its label proof", async () => {
  const ownerA = {
    claimId: "claim-release-a",
    agent: "codex",
    branch: "fix/9061",
    claimedAt: "2026-08-28",
    pr: null,
  };
  const ownerB = {
    claimId: "claim-release-b",
    agent: "other",
    branch: "fix/owner-b",
    claimedAt: "2026-08-29",
    pr: null,
  };
  const state = {
    issue: {
      id: "issue-9061",
      number: 9061,
      title: "release owner race",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: { ...ownerA },
  };
  let metadataWrites = 0;
  await assertRejects(
    () =>
      releaseWithTestLock(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [9061],
          claimId: ownerA.claimId,
          releaseState: "ready",
          closedUnmergedPr: false,
          mergedPr: false,
          comment: false,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => state.issue,
          findIssueProjectItem: async () => "item-9061",
          readClaimOwnership: async () => state.ownership,
          listOpenPullRequestsForBranch: async () => [],
          editIssueLabels: async (_options, current, target) => {
            state.issue = {
              ...current,
              labels: [
                { name: target === "ready" ? "agent-ready" : "agent-active" },
              ],
            };
            if (target === "ready") state.ownership = { ...ownerB };
          },
          updateProjectMetadata: async () => {
            metadataWrites += 1;
          },
        },
      ),
    /ownership changed before release metadata write/,
  );
  assertEqual(metadataWrites, 0);
  assertDeepEqual(state.ownership, ownerB);
});

test("release stops after one field when another owner appears mid-clear", async () => {
  const server = createFakeLockServer();
  const ownerA = {
    claimId: "claim-mid-release-a",
    agent: "codex",
    branch: "fix/9063",
    claimedAt: "2026-08-28",
    pr: null,
  };
  const ownerB = {
    claimId: "claim-mid-release-b",
    agent: "other",
    branch: "fix/owner-b",
    claimedAt: "2026-08-29",
    pr: null,
  };
  const state = {
    issue: {
      id: "issue-9063",
      number: 9063,
      title: "mid-clear owner race",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: { ...ownerA },
  };
  const writes = [];
  const error = await assertRejects(
    () =>
      release(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [9063],
          claimId: ownerA.claimId,
          releaseState: "ready",
          closedUnmergedPr: false,
          mergedPr: false,
          comment: false,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => state.issue,
          findIssueProjectItem: async () => "item-9063",
          readClaimOwnership: async () => state.ownership,
          listOpenPullRequestsForBranch: async () => [],
          editIssueLabels: async (_options, current, target) => {
            state.issue = {
              ...current,
              labels: [
                { name: target === "ready" ? "agent-ready" : "agent-active" },
              ],
            };
          },
          updateProjectMetadata: async (
            _options,
            _project,
            _item,
            _target,
            metadata,
          ) => {
            const [field] = Object.keys(metadata);
            writes.push(field);
            state.ownership = { ...state.ownership, ...metadata };
            state.ownership = { ...ownerB };
          },
          withIssueMutationLock: (options, number, metadata, mutation) =>
            withIssueMutationLock(
              options,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        },
      ),
    /ownership changed before branch metadata write[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertDeepEqual(writes, ["agent"]);
  assertDeepEqual(state.ownership, ownerB);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("release recovery does not restore over an owner changed after labels", async () => {
  const ownerA = {
    claimId: "claim-recovery-a",
    agent: "codex",
    branch: "fix/9062",
    claimedAt: "2026-08-28",
    pr: null,
  };
  const ownerB = {
    claimId: "claim-recovery-b",
    agent: "other",
    branch: "fix/owner-b",
    claimedAt: "2026-08-29",
    pr: null,
  };
  const state = {
    issue: {
      id: "issue-9062",
      number: 9062,
      title: "release recovery owner race",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: { ...ownerA },
  };
  let metadataWrites = 0;
  await assertRejects(
    () =>
      releaseWithTestLock(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [9062],
          claimId: ownerA.claimId,
          releaseState: "ready",
          closedUnmergedPr: false,
          mergedPr: false,
          comment: false,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => state.issue,
          findIssueProjectItem: async () => "item-9062",
          readClaimOwnership: async () => state.ownership,
          listOpenPullRequestsForBranch: async () => [],
          editIssueLabels: async (_options, current, target) => {
            state.issue = {
              ...current,
              labels: [
                { name: target === "ready" ? "agent-ready" : "agent-active" },
              ],
            };
            if (target === "active") state.ownership = { ...ownerB };
          },
          updateProjectMetadata: async (
            _options,
            _project,
            _item,
            _target,
            metadata,
          ) => {
            metadataWrites += 1;
            state.ownership = { ...state.ownership, ...metadata };
            throw new Error("release Project response lost");
          },
        },
      ),
    /release Project response lost[\s\S]*ownership changed before release recovery metadata write/,
  );
  assertEqual(metadataWrites, 1);
  assertDeepEqual(state.ownership, ownerB);
});

test("a PR opened before final release proof restores active ownership", async () => {
  const originalOwnership = {
    claimId: "claim-902",
    agent: "codex",
    branch: "fix/902",
    claimedAt: "2026-08-28",
    pr: null,
  };
  const state = {
    issue: {
      id: "issue-902",
      number: 902,
      title: "final release proof",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: { ...originalOwnership },
  };
  let prReads = 0;
  await assertRejects(
    () =>
      releaseWithTestLock(
        {
          repo: "mento-protocol/monitoring-monorepo",
          issues: [902],
          agent: "codex",
          claimId: "claim-902",
          releaseState: "ready",
          closedUnmergedPr: false,
          dryRun: false,
          comment: false,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => state.issue,
          findIssueProjectItem: async () => "item-902",
          readClaimOwnership: async () => state.ownership,
          listOpenPullRequestsForBranch: async () => {
            prReads += 1;
            return prReads < 5 ? [] : [{ number: 903 }];
          },
          editIssueLabels: async (_options, current, target) => {
            state.issue = {
              ...current,
              labels: [
                { name: target === "active" ? "agent-active" : "agent-ready" },
              ],
            };
          },
          updateProjectMetadata: async (
            _options,
            _project,
            _item,
            _target,
            metadata,
          ) => {
            state.ownership = { ...state.ownership, ...metadata };
          },
        },
      ),
    /branch fix\/902 has open PR #903/,
  );
  assertEqual(prReads, 5);
  assertDeepEqual(state.issue.labels, [{ name: "agent-active" }]);
  assertDeepEqual(state.ownership, originalOwnership);
});

test("an ambiguous release label failure restores active ownership", async () => {
  const state = {
    issue: {
      id: "issue-903",
      number: 903,
      title: "ambiguous release labels",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: {
      claimId: "sweep-903-token",
      agent: "codex",
      branch: "fix/903",
      claimedAt: "2026-08-28",
      pr: null,
    },
  };
  const projectStates = [];

  await assertRejects(
    () =>
      releaseWithTestLock(
        {
          repo: "mento-protocol/monitoring-monorepo",
          issues: [903],
          agent: "codex",
          branch: "",
          claimId: "sweep-903-token",
          releaseState: "ready",
          dryRun: false,
          comment: true,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => state.issue,
          findIssueProjectItem: async () => "item-903",
          readClaimOwnership: async () => state.ownership,
          listOpenPullRequestsForBranch: async () => [],
          editIssueLabels: async (_options, issue, target) => {
            state.issue = {
              ...issue,
              labels: [
                { name: target === "ready" ? "agent-ready" : "agent-active" },
              ],
            };
            if (target === "ready") {
              throw new Error("ambiguous release label write");
            }
          },
          updateProjectMetadata: async (
            _options,
            _project,
            _item,
            target,
            metadata,
          ) => {
            projectStates.push(target);
            state.ownership = { ...state.ownership, ...metadata };
          },
          commentOnIssue: async () => {
            throw new Error("a failed release must not post a release comment");
          },
        },
      ),
    /ambiguous release label write/,
  );

  assertDeepEqual(state.issue.labels, [{ name: "agent-active" }]);
  assertEqual(state.ownership.claimId, "sweep-903-token");
  assertDeepEqual(projectStates, []);
});

test("release recovery preserves a stable newer in-pr transition", async () => {
  const server = createFakeLockServer();
  const state = {
    issue: {
      id: "issue-906",
      number: 906,
      title: "external review during release",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: {
      claimId: "claim-906",
      agent: "codex",
      branch: "fix/906",
      claimedAt: "2026-08-28",
      pr: null,
    },
  };
  let projectWrites = 0;
  await assertRejects(
    () =>
      release(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [906],
          claimId: "claim-906",
          releaseState: "ready",
          closedUnmergedPr: false,
          mergedPr: false,
          comment: false,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => state.issue,
          findIssueProjectItem: async () => "item-906",
          readClaimOwnership: async () => state.ownership,
          listOpenPullRequestsForBranch: async () => [],
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "ready");
            state.issue = { ...current, labels: [{ name: "in-pr" }] };
            throw new Error("external in-pr transition won the release race");
          },
          updateProjectMetadata: async () => {
            projectWrites += 1;
          },
          withIssueMutationLock: (options, number, metadata, mutation) =>
            withIssueMutationLock(
              options,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        },
      ),
    /external in-pr transition won the release race/,
  );
  assertDeepEqual(state.issue.labels, [{ name: "in-pr" }]);
  assertEqual(projectWrites, 0);
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  assertEqual(
    server.commits.get(server.refOid).payload.outcome,
    "newer review release state preserved",
  );
});

test("release recovery retains LOCK when a newer label follows a partial ownership clear", async () => {
  const server = createFakeLockServer();
  const snapshot = {
    claimId: "claim-9064",
    agent: "codex",
    branch: "fix/9064",
    claimedAt: "2026-08-28",
    pr: null,
  };
  const state = {
    issue: {
      id: "issue-9064",
      number: 9064,
      title: "external review after partial release clear",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: { ...snapshot },
  };
  const writes = [];
  const error = await assertRejects(
    () =>
      release(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [9064],
          claimId: snapshot.claimId,
          releaseState: "ready",
          closedUnmergedPr: false,
          mergedPr: false,
          comment: false,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => state.issue,
          findIssueProjectItem: async () => "item-9064",
          readClaimOwnership: async () => state.ownership,
          listOpenPullRequestsForBranch: async () => [],
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "ready");
            state.issue = {
              ...current,
              labels: [{ name: "agent-ready" }],
            };
          },
          updateProjectMetadata: async (
            _options,
            _project,
            _item,
            _target,
            metadata,
          ) => {
            const [field] = Object.keys(metadata);
            writes.push(field);
            state.ownership = { ...state.ownership, ...metadata };
            state.issue = {
              ...state.issue,
              labels: [{ name: "in-pr" }],
            };
            throw new Error("external review followed the first clear");
          },
          withIssueMutationLock: (options, number, metadata, mutation) =>
            withIssueMutationLock(
              options,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        },
      ),
    /newer review state has partial or changed ownership during release recovery[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertDeepEqual(writes, ["agent"]);
  assertDeepEqual(state.ownership, { ...snapshot, agent: null });
  assertDeepEqual(state.issue.labels, [{ name: "in-pr" }]);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("release recovery leaves an ambiguous queue snapshot locked", async () => {
  const server = createFakeLockServer();
  const state = {
    issue: {
      id: "issue-907",
      number: 907,
      title: "ambiguous release recovery",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: {
      claimId: "claim-907",
      agent: "codex",
      branch: "fix/907",
      claimedAt: "2026-08-28",
      pr: null,
    },
  };
  await assertRejects(
    () =>
      release(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [907],
          claimId: "claim-907",
          releaseState: "ready",
          closedUnmergedPr: false,
          mergedPr: false,
          comment: false,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => state.issue,
          findIssueProjectItem: async () => "item-907",
          readClaimOwnership: async () => state.ownership,
          listOpenPullRequestsForBranch: async () => [],
          editIssueLabels: async (_options, current) => {
            state.issue = {
              ...current,
              labels: [{ name: "in-pr" }, { name: "needs-grooming" }],
            };
            throw new Error("ambiguous release write");
          },
          updateProjectMetadata: async () => {},
          withIssueMutationLock: (options, number, metadata, mutation) =>
            withIssueMutationLock(
              options,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        },
      ),
    /has no exact open queue state for release recovery[\s\S]*remains at LOCK/,
  );
  assertDeepEqual(state.issue.labels, [
    { name: "in-pr" },
    { name: "needs-grooming" },
  ]);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("release recovery preserves an ambiguous needs-grooming label under LOCK", async () => {
  const server = createFakeLockServer();
  const state = {
    issue: {
      id: "issue-908",
      number: 908,
      title: "ambiguous grooming release",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: {
      claimId: "claim-908",
      agent: "codex",
      branch: "fix/908",
      claimedAt: "2026-08-28",
      pr: null,
    },
  };
  await assertRejects(
    () =>
      release(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [908],
          claimId: "claim-908",
          releaseState: "grooming",
          closedUnmergedPr: false,
          mergedPr: false,
          comment: false,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => state.issue,
          findIssueProjectItem: async () => "item-908",
          readClaimOwnership: async () => state.ownership,
          listOpenPullRequestsForBranch: async () => [],
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "grooming");
            state.issue = {
              ...current,
              labels: [{ name: "needs-grooming" }],
            };
            throw new Error("grooming label response lost");
          },
          updateProjectMetadata: async () => {},
          withIssueMutationLock: (options, number, metadata, mutation) =>
            withIssueMutationLock(
              options,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        },
      ),
    /release recovery is ambiguous at grooming with partial or changed ownership[\s\S]*remains at LOCK/,
  );
  assertDeepEqual(state.issue.labels, [{ name: "needs-grooming" }]);
  assertEqual(state.ownership.claimId, "claim-908");
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("release recovery preserves a proven complete grooming endpoint", async () => {
  const server = createFakeLockServer();
  const state = {
    issue: {
      id: "issue-909",
      number: 909,
      title: "complete grooming release",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: {
      claimId: "claim-909",
      agent: "codex",
      branch: "fix/909",
      claimedAt: "2026-08-28",
      pr: null,
    },
  };
  await assertRejects(
    () =>
      release(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [909],
          claimId: "claim-909",
          releaseState: "grooming",
          closedUnmergedPr: false,
          mergedPr: false,
          comment: false,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => state.issue,
          findIssueProjectItem: async () => "item-909",
          readClaimOwnership: async () => state.ownership,
          listOpenPullRequestsForBranch: async () => [],
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "grooming");
            state.issue = {
              ...current,
              labels: [{ name: "needs-grooming" }],
            };
          },
          updateProjectMetadata: async (
            _options,
            _project,
            _item,
            target,
            metadata,
          ) => {
            assertEqual(target, "grooming");
            state.ownership = { ...state.ownership, ...metadata };
            if (Object.hasOwn(metadata, "claimId")) {
              throw new Error("grooming Project response lost");
            }
          },
          withIssueMutationLock: (options, number, metadata, mutation) =>
            withIssueMutationLock(
              options,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        },
      ),
    /grooming Project response lost/,
  );
  assertDeepEqual(state.issue.labels, [{ name: "needs-grooming" }]);
  assertDeepEqual(state.ownership, {
    claimId: null,
    agent: null,
    branch: null,
    claimedAt: null,
    pr: null,
  });
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  assertEqual(
    server.commits.get(server.refOid).payload.outcome,
    "applied grooming release state preserved",
  );
});

test("claim queue treats stale claim races as recoverable", () => {
  assertEqual(
    isRecoverableClaimRaceError(
      new IssueOwnershipConflictError(
        "Issue #901 claim was overwritten; project Claim ID is other",
      ),
    ),
    true,
  );
  assertEqual(
    isRecoverableClaimRaceError(
      new IssueClaimCandidateLossError("Issue #901 is not claimable"),
    ),
    true,
  );
  assertEqual(
    isRecoverableClaimRaceError(new Error("gh api graphql failed")),
    false,
  );

  const staleLock = new IssueMutationLockStaleError(
    "mutex release failed",
    { refName: "refs/agent/issue-board-locks/901" },
    {
      cause: new IssueOwnershipConflictError("another claim won"),
    },
  );
  assertEqual(isRecoverableClaimRaceError(staleLock), false);
  assertEqual(
    isRecoverableClaimRaceError(
      new Error("claim wrapper", {
        cause: staleLock,
      }),
    ),
    false,
  );

  assertEqual(
    isRecoverableClaimRaceError(
      new IssueMutationLockStaleError(
        "mutex release failed",
        { refName: "refs/agent/issue-board-locks/901" },
        {
          cause: new AggregateError([
            new IssueOwnershipConflictError("another claim won"),
            new Error("unlock failed"),
          ]),
        },
      ),
    ),
    false,
  );
});

test("claim comment records agent, issue, claim id, and an optional branch", () => {
  const comment = buildClaimComment(
    {
      agent: "codex",
      branch: "agent/issue-901",
      claimId: "codex-20260617T100000",
      claimedAt: "2026-06-17T10:00:00.000Z",
    },
    { number: 901 },
  );

  assert(comment.includes("codex claimed #901"), "missing agent claim line");
  assert(comment.includes("Claim ID: codex-20260617T100000"), "missing claim");
  assert(comment.includes("Branch: agent/issue-901"), "missing branch");

  const branchless = buildClaimComment(
    {
      agent: "codex",
      claimId: "codex-20260617T100000",
      claimedAt: "2026-06-17T10:00:00.000Z",
    },
    { number: 901 },
  );
  assert(!branchless.includes("Branch:"), "unexpected branch");
});

test("claim comment builder rejects metadata the parser would later discard", () => {
  const base = {
    agent: "codex",
    branch: "agent/issue-901",
    claimId: "codex-20260617T100000",
    claimedAt: "2026-06-17T10:00:00.000Z",
  };
  for (const [metadata, pattern] of [
    [{ ...base, agent: "x".repeat(121) }, /Agent must be 1-120/],
    [{ ...base, agent: "codex\nbot" }, /Agent must be 1-120/],
    [{ ...base, agent: "codex\u0000bot" }, /Agent must be 1-120/],
    [{ ...base, branch: "x".repeat(257) }, /Branch must be 1-256/],
    [{ ...base, branch: "agent/issue-901\nnext" }, /Branch must be 1-256/],
    [{ ...base, branch: "agent/issue-901\u0000next" }, /Branch must be 1-256/],
  ]) {
    assertThrows(() => buildClaimComment(metadata, { number: 901 }), pattern);
  }
  for (const [, character] of UNSAFE_SINGLE_LINE_TEST_CHARACTERS) {
    assertThrows(
      () =>
        buildClaimComment(
          { ...base, agent: `codex${character}bot` },
          { number: 901 },
        ),
      /Agent must be 1-120/,
    );
    assertThrows(
      () =>
        buildClaimComment(
          { ...base, branch: `agent/issue-901${character}next` },
          { number: 901 },
        ),
      /Branch must be 1-256/,
    );
  }
});

test("claim metadata preserves legitimate Unicode and exact length limits", () => {
  const agent = "é".repeat(120);
  const branch = "修".repeat(256);
  const args = parseArgs(["claim", "--agent", agent, "--branch", branch]);
  assertEqual(args.agent, agent);
  assertEqual(args.branch, branch);

  const body = buildClaimComment(
    {
      agent,
      branch,
      claimId: "unicode-boundary",
      claimedAt: "2026-06-17T10:00:00.000Z",
    },
    { number: 901 },
  );
  const parsed = parseClaimComment(
    {
      id: "unicode-boundary-comment",
      createdAt: "2026-06-17T10:00:00.000Z",
      authorAssociation: "MEMBER",
      body,
    },
    901,
  );
  assert(parsed, "expected valid Unicode metadata to remain parseable");
  assertEqual(parsed.metadata.Agent, agent);
  assertEqual(parsed.metadata.Branch, branch);
});

function trustedComment({
  id = "comment-1",
  createdAt = "2026-08-20T10:00:00.000Z",
  association = "MEMBER",
  issue = 901,
  agent = "codex",
  claimId = "claim-1",
  branch = "agent/901",
  claimedAt = "2026-08-20T09:00:00.000Z",
} = {}) {
  const lines = [
    `Agent claim: ${agent} claimed #${issue} for implementation.`,
    "",
    `Claim ID: ${claimId}`,
  ];
  if (branch !== null) lines.push(`Branch: ${branch}`);
  lines.push(`Claimed at: ${claimedAt}`);
  return {
    id,
    createdAt,
    authorAssociation: association,
    body: lines.join("\n"),
  };
}

function commentWithHandoff(lines, options) {
  const comment = trustedComment(options);
  comment.body += `\n${lines.join("\n")}`;
  return comment;
}

test("claim parser rejects conflicting newest-time claims and collapses identical ties", () => {
  assertThrows(
    () =>
      selectNewestTrustedClaim(
        [
          trustedComment({ id: "a", claimId: "first" }),
          trustedComment({ id: "b", claimId: "second" }),
        ],
        901,
      ),
    /ambiguous trusted claims/,
  );
  const newest = selectNewestTrustedClaim(
    [
      trustedComment({
        id: "b",
        claimId: "same",
        createdAt: "2026-08-21T10:00:00.000Z",
      }),
      trustedComment({
        id: "a",
        claimId: "same",
        createdAt: "2026-08-21T10:00:00.000Z",
      }),
    ],
    901,
  );
  assertEqual(newest.id, "a");
  assertEqual(newest.metadata["Claim ID"], "same");
});

test("claim parser ignores untrusted, wrong-issue, and malformed comments", () => {
  const missingId = trustedComment();
  delete missingId.id;
  for (const comment of [
    trustedComment({ association: "CONTRIBUTOR", claimId: "untrusted" }),
    trustedComment({ issue: 902, claimId: "wrong" }),
    trustedComment({ createdAt: "not-a-timestamp" }),
    missingId,
    {
      ...trustedComment({ claimId: "bad" }),
      body: "Agent claim: codex claimed #901.",
    },
  ]) {
    assertEqual(parseClaimComment(comment, 901), null);
  }
  const handoff = trustedComment();
  handoff.body += "\nProject #12 fields were not set from this session.";
  assertEqual(parseClaimComment(handoff, 901).metadata.Branch, "agent/901");

  const branchless = parseClaimComment(trustedComment({ branch: null }), 901);
  assertEqual(branchless.branch, null);
  assertEqual(Object.hasOwn(branchless.metadata, "Branch"), false);
});

test("claim parser accepts bounded cloud handoffs with trailing newlines", () => {
  for (const trailingLines of [1, 2]) {
    assert(
      parseClaimComment(
        commentWithHandoff([
          "Project #12 fields were not set from this session.",
          ...Array(trailingLines).fill(""),
        ]),
        901,
      ),
      "expected trailing newlines to be accepted",
    );
  }
  assert(
    parseClaimComment(
      commentWithHandoff(["one", "two", "three", "four", "", ""]),
      901,
    ),
    "expected four handoff lines plus trailing newlines to be accepted",
  );
  assert(
    parseClaimComment(commentWithHandoff(["x".repeat(1000), "", ""]), 901),
    "expected exactly 1000 handoff characters plus trailing newlines to be accepted",
  );
  const branchless = parseClaimComment(
    commentWithHandoff(
      ["Project #12 fields were not set from this session.", ""],
      { branch: null },
    ),
    901,
  );
  assertEqual(branchless.branch, null);
  assertEqual(Object.hasOwn(branchless.metadata, "Branch"), false);
});

test("claim parser rejects unsafe or oversized cloud handoffs", () => {
  for (const lines of [
    ["first line", "", "third line"],
    ["first line", "Claim ID: second"],
    ["first line", "Branch: second"],
    ["first line", "Claimed at: 2026-08-20T10:00:00.000Z"],
    ["handoff\u0000text"],
    ["handoff\ttext"],
    ...UNSAFE_SINGLE_LINE_TEST_CHARACTERS.map(([, character]) => [
      `handoff${character}text`,
    ]),
    [" handoff"],
    ["handoff "],
    ["   "],
    ["one", "two", "three", "four", "five"],
    ["x".repeat(500), "x".repeat(500)],
  ]) {
    assertEqual(parseClaimComment(commentWithHandoff(lines), 901), null);
  }
});

test("claim parser rejects unsafe text and invalid calendar dates", () => {
  const unsafeMetadataComments = UNSAFE_SINGLE_LINE_TEST_CHARACTERS.flatMap(
    ([, character]) => [
      trustedComment({ agent: `codex${character}bot` }),
      trustedComment({ branch: `agent/901${character}next` }),
    ],
  );
  for (const comment of [
    trustedComment({ agent: `a${"x".repeat(120)}` }),
    trustedComment({ agent: "codex\nbot" }),
    trustedComment({ agent: "codex\u0000bot" }),
    trustedComment({ claimId: `claim-${"x".repeat(195)}` }),
    trustedComment({ branch: `branch-${"x".repeat(250)}` }),
    trustedComment({ branch: "agent/901\nnext" }),
    trustedComment({ branch: "agent/901\u0000next" }),
    trustedComment({ claimId: "claim\u0000id" }),
    trustedComment({ claimId: "claim with spaces" }),
    trustedComment({ agent: " codex " }),
    trustedComment({ claimId: " claim-1 " }),
    trustedComment({ branch: " agent/901 " }),
    trustedComment({ claimedAt: "2026-02-30T09:00:00.000Z" }),
    trustedComment({ claimedAt: "2026-13-01T09:00:00.000Z" }),
    ...unsafeMetadataComments,
  ]) {
    assertEqual(parseClaimComment(comment, 901), null);
  }
});

test("backfill state matrix accepts only open active or in-pr issues", () => {
  assertEqual(
    isBackfillable({ state: "OPEN", labels: [{ name: "agent-active" }] }),
    true,
  );
  assertEqual(
    isBackfillable({ state: "OPEN", labels: [{ name: "in-pr" }] }),
    true,
  );
  for (const issue of [
    { state: "CLOSED", labels: [{ name: "agent-active" }] },
    { state: "OPEN", labels: [{ name: "agent-ready" }] },
    { state: "OPEN", labels: [{ name: "agent-active" }, { name: "in-pr" }] },
    { state: "OPEN", labels: [{ name: "in-pr" }, { name: "needs-grooming" }] },
  ]) {
    assertEqual(isBackfillable(issue), false);
  }
});

test("backfill plan normalizes dates, fills only empties, and rejects conflicts", () => {
  const metadata = {
    Agent: "codex",
    "Claim ID": "claim-1",
    Branch: "agent/901",
    "Claimed At": projectDateFieldValue("2026-08-20T09:00:00.000Z"),
  };
  assertDeepEqual(
    buildBackfillPlan(
      { Agent: "codex", "Claim ID": "", Branch: null, "Claimed At": null },
      metadata,
    ),
    [
      { field: "Claim ID", value: "claim-1" },
      { field: "Branch", value: "agent/901" },
      { field: "Claimed At", value: "2026-08-20" },
    ],
  );
  assertDeepEqual(buildBackfillPlan(metadata, metadata), []);
  assertThrows(
    () => buildBackfillPlan({ ...metadata, Branch: "other" }, metadata),
    /conflicts/,
  );
  const branchless = { ...metadata };
  delete branchless.Branch;
  assertDeepEqual(
    buildBackfillPlan(
      {
        Agent: null,
        "Claim ID": null,
        Branch: "preserved-branch",
        "Claimed At": null,
      },
      branchless,
    ),
    [
      { field: "Claim ID", value: "claim-1" },
      { field: "Agent", value: "codex" },
      { field: "Claimed At", value: "2026-08-20" },
    ],
  );
});

function backfillFakes({
  values,
  comments = [trustedComment()],
  issue,
  mutate,
} = {}) {
  const project = {
    id: "project",
    title: "Workboard",
    fields: [
      { id: "agent", name: "Agent", dataType: "TEXT" },
      { id: "claim", name: "Claim ID", dataType: "TEXT" },
      { id: "branch", name: "Branch", dataType: "TEXT" },
      { id: "date", name: "Claimed At", dataType: "DATE" },
      { id: "pr", name: "PR", dataType: "TEXT" },
    ],
  };
  const state = {
    comments,
    issue: issue ?? {
      number: 901,
      title: "Backfill",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    values: {
      Agent: null,
      "Claim ID": null,
      Branch: null,
      "Claimed At": null,
      PR: null,
      ...(values ?? {}),
    },
    project,
    writes: [],
  };
  const expectedFieldTypes = {
    Agent: "TEXT",
    "Claim ID": "TEXT",
    Branch: "TEXT",
    "Claimed At": "DATE",
    PR: "TEXT",
  };
  return {
    state,
    getProject: async () => state.project,
    getIssue: async () => ({ ...state.issue, labels: [...state.issue.labels] }),
    findIssueProjectItem: async () => "item",
    listIssueComments: async () => state.comments,
    requireBackfillFields: (candidateProject) => {
      const fields = {};
      for (const [name, dataType] of Object.entries(expectedFieldTypes)) {
        const field = candidateProject.fields.find(
          (candidate) => candidate.name === name,
        );
        if (field?.dataType !== dataType) {
          throw new Error(`Project must have a ${dataType} ${name} field`);
        }
        fields[name] = field;
      }
      return fields;
    },
    readBackfillProjectFields: async () => ({ ...state.values }),
    writeBackfillProjectFields: async (_options, _project, _item, writes) => {
      if (writes.some((write) => write.field === "PR")) {
        throw new Error("backfill fake refuses a PR write");
      }
      state.writes.push(...writes);
      for (const write of writes) state.values[write.field] = write.value;
      mutate?.(state, writes);
    },
  };
}

test("backfill dry-run has no writes and returns exact writes", async () => {
  const fakes = backfillFakes();
  const [result] = await backfillWithTestLock(
    { issues: [901], dryRun: true },
    fakes,
  );
  assertEqual(fakes.state.writes.length, 0);
  assertDeepEqual(
    result.writes.map((write) => write.field),
    ["Claim ID", "Agent", "Branch", "Claimed At"],
  );
});

test("backfill writes claim ID first, fills partial matches, and is idempotent", async () => {
  const fakes = backfillFakes({
    values: {
      Agent: "codex",
      "Claim ID": null,
      Branch: null,
      "Claimed At": null,
    },
  });
  const options = { issues: [901], dryRun: false };
  const [result] = await backfillWithTestLock(options, fakes);
  assertEqual(result.state, "backfilled");
  assertEqual(fakes.state.writes[0].field, "Claim ID");
  const [again] = await backfillWithTestLock(options, fakes);
  assertEqual(again.state, "backfill already matched");
  assertEqual(fakes.state.writes.length, 3);
});

test("backfill preserves Branch when the trusted claim omits it", async () => {
  const fakes = backfillFakes({
    comments: [trustedComment({ branch: null })],
    values: {
      Agent: null,
      "Claim ID": null,
      Branch: "preserved-branch",
      "Claimed At": null,
    },
  });
  const [result] = await backfillWithTestLock(
    { issues: [901], dryRun: false },
    fakes,
  );
  assertDeepEqual(
    result.writes.map((write) => write.field),
    ["Claim ID", "Agent", "Claimed At"],
  );
  assertEqual(fakes.state.values.Branch, "preserved-branch");
  assertEqual(
    fakes.state.writes.some((write) => write.field === "Branch"),
    false,
  );
});

test("backfill aborts conflicts before writes and detects post-write verification failure", async () => {
  const conflict = backfillFakes({
    values: {
      Agent: "other",
      "Claim ID": null,
      Branch: null,
      "Claimed At": null,
    },
  });
  await assertRejects(
    () => backfillWithTestLock({ issues: [901], dryRun: false }, conflict),
    /conflicts/,
  );
  assertEqual(conflict.state.writes.length, 0);

  const broken = backfillFakes({
    mutate: (state) => {
      if (state.writes.length === 4) state.values.PR = "#9999";
    },
  });
  await assertRejects(
    () => backfillWithTestLock({ issues: [901], dryRun: false }, broken),
    /verification failed/,
  );
});

test("backfill re-reads and aborts when project values drift before writing", async () => {
  const fakes = backfillFakes();
  const read = fakes.readBackfillProjectFields;
  let reads = 0;
  fakes.readBackfillProjectFields = async (...args) => {
    reads += 1;
    if (reads === 2) fakes.state.values.Agent = "other";
    return read(...args);
  };
  await assertRejects(
    () => backfillWithTestLock({ issues: [901], dryRun: false }, fakes),
    /changed before backfill write/,
  );
  assertEqual(fakes.state.writes.length, 0);
});

test("backfill aborts when one trusted comment ID changes metadata before write", async () => {
  const fakes = backfillFakes();
  let commentReads = 0;
  fakes.listIssueComments = async () => [
    trustedComment({
      claimedAt:
        commentReads++ === 0
          ? "2026-08-20T09:00:00.000Z"
          : "2026-08-20T10:00:00.000Z",
    }),
  ];
  await assertRejects(
    () => backfillWithTestLock({ issues: [901], dryRun: false }, fakes),
    /changed before backfill write/,
  );
  assertEqual(fakes.state.writes.length, 0);
});

test("backfill fingerprints an absent Branch before writing", async () => {
  const fakes = backfillFakes({ comments: [trustedComment({ branch: null })] });
  let commentReads = 0;
  fakes.listIssueComments = async () => [
    trustedComment({
      branch: commentReads++ === 0 ? null : "agent/901",
    }),
  ];
  await assertRejects(
    () => backfillWithTestLock({ issues: [901], dryRun: false }, fakes),
    /changed before backfill write/,
  );
  assertEqual(fakes.state.writes.length, 0);
});

test("backfill stops before later writes when a newer claim arrives", async () => {
  const fakes = backfillFakes({
    mutate: (state) => {
      if (state.writes.length === 1) {
        state.comments = [
          trustedComment({
            id: "comment-2",
            claimId: "claim-2",
            createdAt: "2026-08-20T11:00:00.000Z",
          }),
        ];
      }
    },
  });
  await assertRejects(
    () => backfillWithTestLock({ issues: [901], dryRun: false }, fakes),
    /changed before backfill write/,
  );
  assertDeepEqual(
    fakes.state.writes.map((write) => write.field),
    ["Claim ID"],
  );
});

test("backfill stops before later writes when a target field drifts", async () => {
  const fakes = backfillFakes({
    mutate: (state) => {
      if (state.writes.length === 1) state.values.Agent = "other";
    },
  });
  await assertRejects(
    () => backfillWithTestLock({ issues: [901], dryRun: false }, fakes),
    /changed before backfill write/,
  );
  assertDeepEqual(
    fakes.state.writes.map((write) => write.field),
    ["Claim ID"],
  );
});

test("backfill stops before later writes when only PR ownership drifts", async () => {
  const fakes = backfillFakes({
    values: { PR: "#1901" },
    mutate: (state) => {
      if (state.writes.length === 1) state.values.PR = "#1902";
    },
  });
  await assertRejects(
    () => backfillWithTestLock({ issues: [901], dryRun: false }, fakes),
    /changed before backfill write/,
  );
  assertDeepEqual(
    fakes.state.writes.map((write) => write.field),
    ["Claim ID"],
  );
  assertEqual(fakes.state.values.PR, "#1902");
});

test("backfill stops before later writes when the lifecycle drifts", async () => {
  const fakes = backfillFakes({
    mutate: (state) => {
      if (state.writes.length === 1) {
        state.issue.labels = [{ name: "agent-ready" }];
      }
    },
  });
  await assertRejects(
    () => backfillWithTestLock({ issues: [901], dryRun: false }, fakes),
    /is not backfillable/,
  );
  assertDeepEqual(
    fakes.state.writes.map((write) => write.field),
    ["Claim ID"],
  );
});

test("backfill stops before later writes when an ownership field type drifts", async () => {
  const fakes = backfillFakes({
    mutate: (state) => {
      if (state.writes.length !== 1) return;
      state.project = {
        ...state.project,
        fields: state.project.fields.map((field) =>
          field.name === "Agent" ? { ...field, dataType: "DATE" } : field,
        ),
      };
    },
  });
  await assertRejects(
    () => backfillWithTestLock({ issues: [901], dryRun: false }, fakes),
    /Project must have a TEXT Agent field/,
  );
  assertDeepEqual(
    fakes.state.writes.map((write) => write.field),
    ["Claim ID"],
  );
});

function backfillProject() {
  return {
    id: "project",
    fields: [
      { id: "agent", name: "Agent", dataType: "TEXT" },
      { id: "claim", name: "Claim ID", dataType: "TEXT" },
      { id: "branch", name: "Branch", dataType: "TEXT" },
      { id: "date", name: "Claimed At", dataType: "DATE" },
      { id: "pr", name: "PR", dataType: "TEXT" },
    ],
  };
}

function commentPage(
  nodes,
  pageInfo = { hasNextPage: false, endCursor: null },
) {
  return { data: { repository: { issue: { comments: { nodes, pageInfo } } } } };
}

test("comment adapter reads every page and rejects bad cursor progress or caps", async () => {
  const calls = [];
  const comments = await listIssueComments(
    { repo: "mento-protocol/monitoring-monorepo" },
    901,
    {
      graphql: async (_query, variables) => {
        calls.push(variables.cursor ?? null);
        return variables.cursor
          ? commentPage([trustedComment({ id: "two" })])
          : commentPage([trustedComment({ id: "one" })], {
              hasNextPage: true,
              endCursor: "next",
            });
      },
    },
  );
  assertDeepEqual(calls, [null, "next"]);
  assertEqual(comments.length, 2);
  await assertRejects(
    () =>
      listIssueComments({ repo: "mento-protocol/monitoring-monorepo" }, 901, {
        graphql: async () =>
          commentPage([], { hasNextPage: true, endCursor: null }),
      }),
    /did not advance cursor/,
  );
  await assertRejects(
    () =>
      listIssueComments({ repo: "mento-protocol/monitoring-monorepo" }, 901, {
        graphql: async () =>
          commentPage([], { hasNextPage: true, endCursor: "same" }),
        maxPages: 3,
      }),
    /did not advance cursor/,
  );
  await assertRejects(
    () =>
      listIssueComments({ repo: "mento-protocol/monitoring-monorepo" }, 901, {
        graphql: async () =>
          commentPage([], { hasNextPage: true, endCursor: "next" }),
        maxPages: 1,
      }),
    /exceeded 1 pages/,
  );
  for (const comments of [
    { pageInfo: { hasNextPage: false } },
    { nodes: [] },
    { nodes: [], pageInfo: { hasNextPage: null } },
  ]) {
    await assertRejects(
      () =>
        listIssueComments({ repo: "mento-protocol/monitoring-monorepo" }, 901, {
          graphql: async () => ({
            data: { repository: { issue: { comments } } },
          }),
        }),
      /comment pagination returned an incomplete page/,
    );
  }
});

test("Project readers reject incomplete connections instead of empty values", async () => {
  const incompleteConnections = [
    { pageInfo: { hasNextPage: false } },
    { nodes: [] },
    { nodes: [], pageInfo: { hasNextPage: null } },
  ];
  for (const fields of incompleteConnections) {
    await assertRejects(
      () =>
        getProject(LOCK_TEST_OPTIONS, {
          graphql: async () => ({
            data: {
              organization: {
                projectV2: {
                  id: "project",
                  title: "Agent Tasks",
                  url: "https://github.com/orgs/mento-protocol/projects/12",
                  fields,
                },
              },
            },
          }),
        }),
      /Project mento-protocol\/12 field lookup was incomplete/,
    );
  }

  for (const fieldValues of incompleteConnections) {
    await assertRejects(
      () =>
        readProjectItemStatus(
          LOCK_TEST_OPTIONS,
          { statusField: { id: "status" } },
          "item-incomplete-status",
          {
            graphql: async () => ({
              data: { node: { fieldValues } },
            }),
          },
        ),
      /Status lookup was incomplete/,
    );
    await assertRejects(
      () =>
        readProjectTextField(
          LOCK_TEST_OPTIONS,
          "item-incomplete-text",
          "claim",
          {
            graphql: async () => ({
              data: { node: { fieldValues } },
            }),
          },
        ),
      /text-field lookup was incomplete/,
    );
  }
});

test("backfill rejects incomplete field pages before owner writes", async () => {
  for (const fieldValues of [
    { pageInfo: { hasNextPage: false } },
    { nodes: [] },
    { nodes: [], pageInfo: { hasNextPage: null } },
  ]) {
    const fakes = backfillFakes();
    let writes = 0;
    fakes.readBackfillProjectFields = (options, project, itemId) =>
      readBackfillProjectFields(options, project, itemId, {
        graphql: async () => ({ data: { node: { fieldValues } } }),
      });
    fakes.writeBackfillProjectFields = async () => {
      writes += 1;
    };
    await assertRejects(
      () =>
        backfillWithTestLock(
          { ...LOCK_TEST_OPTIONS, issues: [901], dryRun: false },
          fakes,
        ),
      /field pagination returned an incomplete page/,
    );
    assertEqual(writes, 0, "incomplete backfill data must not write fields");
  }
});

test("project adapters paginate, decode values, order mutations, and reject bad cursors", async () => {
  const project = backfillProject();
  const readCalls = [];
  const values = await readBackfillProjectFields({}, project, "item", {
    graphql: async (_query, variables) => {
      readCalls.push(variables.cursor ?? null);
      return variables.cursor
        ? {
            data: {
              node: {
                fieldValues: {
                  nodes: [
                    { date: "2026-08-20", field: { id: "date" } },
                    { text: "agent/901", field: { id: "branch" } },
                    { text: "#1901", field: { id: "pr" } },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }
        : {
            data: {
              node: {
                fieldValues: {
                  nodes: [
                    { text: "codex", field: { id: "agent" } },
                    { text: "claim-1", field: { id: "claim" } },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "next" },
                },
              },
            },
          };
    },
  });
  assertDeepEqual(readCalls, [null, "next"]);
  assertDeepEqual(values, {
    Agent: "codex",
    "Claim ID": "claim-1",
    Branch: "agent/901",
    "Claimed At": "2026-08-20",
    PR: "#1901",
  });
  await assertRejects(
    () =>
      readBackfillProjectFields({}, project, "item", {
        graphql: async () => ({
          data: {
            node: {
              fieldValues: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: "same" },
              },
            },
          },
        }),
        maxPages: 3,
      }),
    /did not advance cursor/,
  );
  await assertRejects(
    () =>
      readBackfillProjectFields({}, project, "item", {
        graphql: async () => ({
          data: {
            node: {
              fieldValues: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: null },
              },
            },
          },
        }),
      }),
    /did not advance cursor/,
  );
  await assertRejects(
    () =>
      readBackfillProjectFields({}, project, "item", {
        graphql: async () => ({
          data: {
            node: {
              fieldValues: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: "next" },
              },
            },
          },
        }),
        maxPages: 1,
      }),
    /exceeded 1 pages/,
  );
  const writes = [];
  await withRealOwnerCapability(
    "backfill",
    project,
    901,
    async (capability) => {
      await writeBackfillProjectFields(
        capability,
        LOCK_TEST_OPTIONS,
        project,
        "item",
        [
          { field: "Claim ID", value: "claim-1" },
          { field: "Agent", value: "codex" },
          { field: "Branch", value: "agent/901" },
          { field: "Claimed At", value: "2026-08-20" },
        ],
        {
          graphql: async (query, variables) => {
            writes.push({ query, variables });
            return { data: {} };
          },
          issueNumber: 901,
          operation: "backfill",
        },
      );
      await assertRejects(
        () =>
          writeBackfillProjectFields(
            capability,
            LOCK_TEST_OPTIONS,
            project,
            "item",
            [{ field: "PR", value: "#1902" }],
            {
              graphql: async () => {
                throw new Error("PR backfill reached GraphQL");
              },
              issueNumber: 901,
              operation: "backfill",
            },
          ),
        /Backfill cannot write field: PR/,
      );
    },
    LOCK_TEST_OPTIONS,
    "item",
  );
  assertDeepEqual(
    writes.map((write) => write.variables.field),
    ["claim", "agent", "branch", "date"],
  );
  assertEqual(writes[0].variables.text, "claim-1");
  assertEqual(writes[3].variables.date, "2026-08-20");
  assert(writes[0].query.includes("text: $text"), "missing text mutation");
  assert(writes[3].query.includes("date: $date"), "missing date mutation");
});

test("mutex refs use a stable custom namespace and canonical scope", () => {
  const first = issueMutationLockRef(LOCK_TEST_OPTIONS, 2111);
  const equivalent = issueMutationLockRef(
    {
      ...LOCK_TEST_OPTIONS,
      repo: "MENTO-PROTOCOL/MONITORING-MONOREPO",
      projectOwner: "MENTO-PROTOCOL",
    },
    2111,
  );
  const otherProject = issueMutationLockRef(
    {
      ...LOCK_TEST_OPTIONS,
      projectOwner: "another-owner",
      projectNumber: 99,
    },
    2111,
  );
  assert(
    first.startsWith("refs/mento-issue-board-locks/v1/"),
    "mutex ref must use the retained custom namespace",
  );
  assertEqual(first, equivalent);
  assertEqual(first, otherProject);
});

test("mutex initialization recovers an apply-then-throw zero-OID CAS", async () => {
  const server = createFakeLockServer();
  let creates = 0;
  const operations = server.withOperations({
    compareAndSwapLockRef: async (...args) => {
      if (args[3].startsWith("000000")) {
        creates += 1;
        await server.operations.compareAndSwapLockRef(...args);
        throw new Error("response lost after create");
      }
      return server.operations.compareAndSwapLockRef(...args);
    },
  });
  const lease = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2111,
    {
      operation: "claim",
      agent: "codex",
      claimId: "claim-2111",
      branch: "fix/2111",
      claimedAt: "2026-08-28",
    },
    operations,
  );
  assertEqual(creates, 1);
  assertEqual(lease.payload.state, "LOCK");
  assertEqual(lease.payload.scope.issue, 2111);
  assertEqual(lease.payload.scope.projectOwner, "mento-protocol");
  assertEqual(lease.payload.scope.projectNumber, 12);
  assertEqual(lease.payload.claimId, "claim-2111");
  assertEqual(lease.payload.branch, "fix/2111");
  assertEqual(lease.payload.claimedAt, "2026-08-28");
  assertEqual(lease.payload.pr, null);
  assertEqual(lease.payload.previousBranch, null);
  assertEqual(lease.payload.previousPr, null);
  await releaseIssueMutationLock(lease);
  const unlockPayload = server.commits.get(server.refOid).payload;
  assertEqual(unlockPayload.state, "UNLOCK");
  assertEqual(unlockPayload.claimId, "claim-2111");
  assertEqual(unlockPayload.branch, "fix/2111");
  assertEqual(unlockPayload.claimedAt, "2026-08-28");
  assertEqual(unlockPayload.pr, null);
  assertEqual(unlockPayload.previousBranch, null);
  assertEqual(unlockPayload.previousPr, null);
});

test("mutex initialization continues from a peer UNLOCK after losing the create race", async () => {
  const server = createFakeLockServer();
  let peerUnlockOid = null;
  const operations = server.withOperations({
    compareAndSwapLockRef: async (...args) => {
      if (args[3].startsWith("000000")) {
        const candidate = server.commits.get(args[4]);
        const peer = server.createCommit(
          { oid: candidate.parentOid, treeOid: candidate.treeOid },
          {
            ...candidate.payload,
            operationId: "peer-initialize",
          },
        );
        peerUnlockOid = peer.oid;
        server.refOid = peer.oid;
        throw new Error("peer initialized the mutex first");
      }
      return server.compareAndSwapLockRef(...args);
    },
  });

  const lease = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2112,
    {
      operation: "claim",
      agent: "codex",
      claimId: "claim-2112",
      branch: "fix/2112",
    },
    operations,
  );

  assertEqual(server.commits.get(lease.lockOid).parentOid, peerUnlockOid);
  assertEqual(lease.payload.state, "LOCK");
  await releaseIssueMutationLock(lease);
});

test("mutex payload retains the full review branch rebind snapshot", async () => {
  const server = createFakeLockServer();
  const lease = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2071,
    {
      operation: "review",
      agent: "codex",
      claimId: "claim-2071",
      branch: "feat/rank-backlog-skill",
      previousBranch: "worktree-shoggoth",
      claimedAt: "2026-08-27",
      pr: 2079,
      previousPr: null,
    },
    server.operations,
  );
  assertEqual(lease.payload.agent, "codex");
  assertEqual(lease.payload.claimId, "claim-2071");
  assertEqual(lease.payload.branch, "feat/rank-backlog-skill");
  assertEqual(lease.payload.previousBranch, "worktree-shoggoth");
  assertEqual(lease.payload.claimedAt, "2026-08-27");
  assertEqual(lease.payload.pr, 2079);
  assertEqual(lease.payload.previousPr, null);
  await releaseIssueMutationLock(lease);
  const unlockPayload = server.commits.get(server.refOid).payload;
  assertEqual(unlockPayload.branch, "feat/rank-backlog-skill");
  assertEqual(unlockPayload.previousBranch, "worktree-shoggoth");
  assertEqual(unlockPayload.claimedAt, "2026-08-27");
  assertEqual(unlockPayload.pr, 2079);
  assertEqual(unlockPayload.previousPr, null);
});

test("mutex payload retains the ordinary release ownership snapshot", async () => {
  const server = createFakeLockServer();
  const lease = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2111,
    {
      operation: "release",
      agent: "codex",
      claimId: "claim-2111",
      branch: "fix/2111",
      claimedAt: "2026-08-28",
      pr: null,
    },
    server.operations,
  );
  assertEqual(lease.payload.operation, "release");
  assertEqual(lease.payload.agent, "codex");
  assertEqual(lease.payload.claimId, "claim-2111");
  assertEqual(lease.payload.branch, "fix/2111");
  assertEqual(lease.payload.claimedAt, "2026-08-28");
  assertEqual(lease.payload.pr, null);
  await releaseIssueMutationLock(lease);
  const unlockPayload = server.commits.get(server.refOid).payload;
  assertEqual(unlockPayload.claimId, "claim-2111");
  assertEqual(unlockPayload.branch, "fix/2111");
  assertEqual(unlockPayload.claimedAt, "2026-08-28");
  assertEqual(unlockPayload.pr, null);
});

test("mutex initialization retries only while the fixed ref stays absent", async () => {
  const server = createFakeLockServer();
  let creates = 0;
  const lease = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2112,
    { operation: "sync", agent: "codex" },
    server.withOperations({
      compareAndSwapLockRef: async (...args) => {
        if (!args[3].startsWith("000000")) {
          return server.operations.compareAndSwapLockRef(...args);
        }
        creates += 1;
        if (creates < 3) throw new Error("transient create failure");
        return server.operations.compareAndSwapLockRef(...args);
      },
    }),
  );
  assertEqual(creates, 3);
  await releaseIssueMutationLock(lease);
});

test("mutex acquire and release reconcile exact apply-then-throw SHAs", async () => {
  const server = createFakeLockServer();
  let lostAcquireResponse = true;
  const lease = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2113,
    { operation: "claim", agent: "codex", branch: "fix/2113" },
    server.withOperations({
      compareAndSwapLockRef: async (...args) => {
        const commit = server.commits.get(args[4]);
        if (commit.payload.state === "LOCK" && lostAcquireResponse) {
          lostAcquireResponse = false;
          await server.compareAndSwapLockRef(...args);
          throw new Error("acquire response lost");
        }
        return server.compareAndSwapLockRef(...args);
      },
    }),
  );
  let lostReleaseResponse = true;
  const normalAdvance = lease.operations.compareAndSwapLockRef;
  lease.operations.compareAndSwapLockRef = async (...args) => {
    const commit = server.commits.get(args[4]);
    if (commit.payload.state === "UNLOCK" && lostReleaseResponse) {
      lostReleaseResponse = false;
      await normalAdvance(...args);
      throw new Error("release response lost");
    }
    return normalAdvance(...args);
  };
  await releaseIssueMutationLock(lease);
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
});

test("failed UNLOCK reconciliation reports the retained candidate and no retry", async () => {
  const server = createFakeLockServer();
  const lease = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    21131,
    { operation: "claim", agent: "codex", branch: "fix/21131" },
    server.operations,
  );
  let reconciliationReads = 0;
  lease.operations.compareAndSwapLockRef = async () => {
    throw new Error("release response unavailable");
  };
  lease.operations.readLockRef = async () => {
    reconciliationReads += 1;
    throw new Error("release reconciliation unavailable");
  };
  const error = await assertRejects(
    () => releaseIssueMutationLock(lease),
    /unknown LOCK-to-UNLOCK outcome[\s\S]*Candidate UNLOCK[\s\S]*Do not retry the lifecycle command/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(error.code, "ISSUE_MUTATION_LOCK_STALE");
  assertEqual(error.lease, lease);
  assertEqual(reconciliationReads, 3);
  assertEqual(lease.candidateUnlock.oid, error.lease.candidateUnlock.oid);
  assertEqual(lease.candidateUnlock.payload.state, "UNLOCK");
  assertEqual(error.message.includes("remains at LOCK"), false);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("stale UNLOCK reconciliation reports the candidate instead of a LOCK claim", async () => {
  const server = createFakeLockServer();
  const lease = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    21132,
    { operation: "release", agent: "codex", branch: "fix/21132" },
    server.operations,
  );
  let releaseAttempts = 0;
  lease.operations.compareAndSwapLockRef = async () => {
    releaseAttempts += 1;
    throw new Error("release response lost");
  };
  const error = await assertRejects(
    () => releaseIssueMutationLock(lease),
    /last reconciliation still reported parent[\s\S]*unknown LOCK-to-UNLOCK outcome[\s\S]*recorded candidate UNLOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(error.code, "ISSUE_MUTATION_LOCK_STALE");
  assertEqual(error.lease, lease);
  assertEqual(releaseAttempts, 3);
  assertEqual(lease.candidateUnlock.payload.parentLock, lease.lockOid);
  assertEqual(error.message.includes("remains at LOCK"), false);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("mutex acquire retries reconciliation reads after an applied CAS", async () => {
  const server = createFakeLockServer();
  const setup = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2120,
    { operation: "sync", agent: "setup" },
    server.operations,
  );
  await releaseIssueMutationLock(setup);

  let acquireApplied = false;
  let failedReads = 0;
  let lockCasAttempts = 0;
  const operations = server.withOperations({
    compareAndSwapLockRef: async (...args) => {
      const commit = server.commits.get(args[4]);
      if (commit.payload.state === "LOCK") {
        lockCasAttempts += 1;
        await server.compareAndSwapLockRef(...args);
        acquireApplied = true;
        throw new Error("acquire response lost");
      }
      return server.compareAndSwapLockRef(...args);
    },
    readLockRef: async (...args) => {
      if (acquireApplied && failedReads < 2) {
        failedReads += 1;
        throw new Error("transient reconciliation read failure");
      }
      return server.operations.readLockRef(...args);
    },
  });
  const lease = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2120,
    { operation: "claim", agent: "codex", branch: "fix/2120" },
    operations,
  );
  assertEqual(lockCasAttempts, 1);
  assertEqual(failedReads, 2);
  assertEqual(lease.lockOid, server.refOid);
  await releaseIssueMutationLock(lease);
});

test("unknown acquire outcome reports the candidate LOCK and recovery evidence", async () => {
  const server = createFakeLockServer();
  const setup = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2121,
    { operation: "sync", agent: "setup" },
    server.operations,
  );
  await releaseIssueMutationLock(setup);

  let acquireApplied = false;
  let failedReads = 0;
  const error = await assertRejects(
    () =>
      acquireIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2121,
        {
          operation: "claim",
          agent: "codex",
          claimId: "claim-2121",
          branch: "fix/2121",
        },
        server.withOperations({
          compareAndSwapLockRef: async (...args) => {
            const commit = server.commits.get(args[4]);
            if (commit.payload.state === "LOCK") {
              await server.compareAndSwapLockRef(...args);
              acquireApplied = true;
              throw new Error("acquire response lost");
            }
            return server.compareAndSwapLockRef(...args);
          },
          readLockRef: async (...args) => {
            if (acquireApplied) {
              failedReads += 1;
              throw new Error("reconciliation unavailable");
            }
            return server.operations.readLockRef(...args);
          },
        }),
      ),
    /outcome is unknown[\s\S]*candidate LOCK[\s\S]*do not retry or mutate the board/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(failedReads, 3);
  assertEqual(
    error.lease.refName,
    issueMutationLockRef(LOCK_TEST_OPTIONS, 2121),
  );
  assertEqual(error.lease.lockOid, server.refOid);
  assertEqual(error.lease.payload.claimId, "claim-2121");
  assert(
    error.message.includes(
      "prove this helper and its credential cannot resume",
    ),
    "unknown acquisition recovery must stop delayed writes",
  );
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("final acquire CAS with a stale parent read returns unknown recovery", async () => {
  const server = createFakeLockServer();
  const setup = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2122,
    { operation: "sync", agent: "setup" },
    server.operations,
  );
  await releaseIssueMutationLock(setup);
  const parentOid = server.refOid;
  const parent = server.commits.get(parentOid);
  let lockCasAttempts = 0;
  const error = await assertRejects(
    () =>
      acquireIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2122,
        {
          operation: "claim",
          agent: "codex",
          claimId: "claim-2122",
          branch: "fix/2122",
        },
        server.withOperations({
          compareAndSwapLockRef: async (...args) => {
            const commit = server.commits.get(args[4]);
            if (commit.payload.state !== "LOCK") {
              return server.compareAndSwapLockRef(...args);
            }
            lockCasAttempts += 1;
            if (lockCasAttempts === 3) {
              await server.compareAndSwapLockRef(...args);
            }
            throw new Error(`lost acquire response ${lockCasAttempts}`);
          },
          readLockRef: async (...args) => {
            if (lockCasAttempts > 0) {
              return { ...parent, repositoryId: server.repositoryId };
            }
            return server.operations.readLockRef(...args);
          },
        }),
      ),
    /outcome is unknown[\s\S]*last reconciliation still reported parent[\s\S]*do not retry/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(lockCasAttempts, 3);
  assertEqual(error.lease.lockOid, server.refOid);
  assertEqual(error.lease.payload.claimId, "claim-2122");
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("exact-SHA sibling claims allow exactly one mutex owner", async () => {
  const server = createFakeLockServer();
  const initialized = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2114,
    { operation: "sync", agent: "setup" },
    server.operations,
  );
  await releaseIssueMutationLock(initialized);

  const rendezvous = twoPartyBarrier();
  const delayedOperations = server.withOperations({
    compareAndSwapLockRef: async (...args) => {
      const commit = server.commits.get(args[4]);
      if (commit.payload.state === "LOCK") await rendezvous();
      return server.compareAndSwapLockRef(...args);
    },
  });
  const attempts = await Promise.allSettled([
    acquireIssueMutationLock(
      LOCK_TEST_OPTIONS,
      2114,
      { operation: "claim", agent: "first", branch: "first" },
      delayedOperations,
    ),
    acquireIssueMutationLock(
      {
        ...LOCK_TEST_OPTIONS,
        projectOwner: "another-owner",
        projectNumber: 99,
      },
      2114,
      { operation: "claim", agent: "second", branch: "second" },
      delayedOperations,
    ),
  ]);
  const winners = attempts.filter((result) => result.status === "fulfilled");
  const losers = attempts.filter((result) => result.status === "rejected");
  assertEqual(winners.length, 1);
  assertEqual(losers.length, 1);
  assert(
    losers[0].reason instanceof IssueOwnershipConflictError,
    "sibling loser must receive a typed ownership conflict",
  );
  await releaseIssueMutationLock(winners[0].value);
});

test("a held claim mutex excludes a concurrent release callback", async () => {
  const server = createFakeLockServer();
  let allowClaim;
  let claimStarted;
  const claimStartedPromise = new Promise((resolve) => {
    claimStarted = resolve;
  });
  const allowClaimPromise = new Promise((resolve) => {
    allowClaim = resolve;
  });
  const claimPromise = withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2115,
    {
      operation: "claim",
      projectId: "project",
      agent: "codex",
      branch: "fix/2115",
    },
    async () => {
      claimStarted();
      await allowClaimPromise;
      return "claimed";
    },
    server.operations,
  );
  await claimStartedPromise;
  let releaseRan = false;
  await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2115,
        {
          operation: "release",
          projectId: "project",
          agent: "codex",
          branch: "fix/2115",
        },
        async () => {
          releaseRan = true;
        },
        server.operations,
      ),
    /LOCK .* is held/,
  );
  assertEqual(releaseRan, false);
  allowClaim();
  assertEqual(await claimPromise, "claimed");
});

test("operation errors unlock only after proven compensation", async () => {
  const safeServer = createFakeLockServer();
  await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2116,
        {
          operation: "release",
          projectId: "project",
          agent: "codex",
          branch: "fix/2116",
        },
        async (lease) => {
          lease.markSafeToUnlock("compensation verified");
          throw new Error("release failed after compensation");
        },
        safeServer.operations,
      ),
    /release failed after compensation/,
  );
  assertEqual(
    safeServer.commits.get(safeServer.refOid).payload.state,
    "UNLOCK",
  );

  const unsafeServer = createFakeLockServer();
  const unsafeError = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2117,
        {
          operation: "release",
          projectId: "project",
          agent: "codex",
          branch: "fix/2117",
        },
        async () => {
          throw new Error("compensation failed");
        },
        unsafeServer.operations,
      ),
    /Persistent issue mutex .* remains at LOCK/,
  );
  assert(
    unsafeError.message.includes("prove the original helper cannot resume"),
    "stale-lock recovery must stop the delayed helper before ref recovery",
  );
  assert(
    unsafeError.message.includes('"operation":"release"'),
    "stale-lock recovery must surface the immutable lock payload",
  );
  assertEqual(
    unsafeServer.commits.get(unsafeServer.refOid).payload.state,
    "LOCK",
  );
  await assertRejects(
    () =>
      acquireIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2117,
        { operation: "sync", agent: "other" },
        unsafeServer.operations,
      ),
    /LOCK .* is held/,
  );
});

test("owner capability rejects forged identity and every wrong write scope", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  let capabilityAfterCallback;
  let graphqlCalls = 0;
  const graphql = async () => {
    graphqlCalls += 1;
    return { data: {} };
  };
  await withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2601,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (lease, capability) => {
      capabilityAfterCallback = capability;
      assert(Object.isFrozen(capability), "capability must be frozen");
      assertEqual(Object.hasOwn(lease.payload, "projectId"), false);
      for (const forged of [
        {},
        Object.freeze({ ...capability }),
        new Proxy(capability, {}),
      ]) {
        const error = await assertRejects(
          () =>
            guardedTextWrite(forged, {
              graphql,
              issueNumber: 2601,
              project,
            }),
          /exact active issue mutex capability/,
        );
        assert(error instanceof IssueOwnerMutationCapabilityError);
      }

      const wrongBindings = [
        {
          issueNumber: 2601,
          options: { ...LOCK_TEST_OPTIONS, repo: "mento-protocol/other" },
          project,
        },
        { issueNumber: 2602, project },
        {
          issueNumber: 2601,
          options: { ...LOCK_TEST_OPTIONS, projectOwner: "other-owner" },
          project,
        },
        {
          issueNumber: 2601,
          options: { ...LOCK_TEST_OPTIONS, projectNumber: 13 },
          project,
        },
        {
          issueNumber: 2601,
          project: { ...project, id: "another-project" },
        },
        { issueNumber: 2601, operation: "review", project },
        { fieldId: "status", issueNumber: 2601, project },
      ];
      for (const binding of wrongBindings) {
        const error = await assertRejects(
          () =>
            guardedTextWrite(capability, {
              graphql,
              ...binding,
            }),
          /scope mismatch|cannot write Project field|has proven ID/,
        );
        assert(error instanceof IssueOwnerMutationCapabilityError);
      }

      await guardedTextWrite(capability, {
        graphql,
        issueNumber: 2601,
        itemId: "item-2601",
        project,
      });
      const itemError = await assertRejects(
        () =>
          guardedTextWrite(capability, {
            graphql,
            issueNumber: 2601,
            itemId: "item-2601-replacement",
            project,
          }),
        /pinned to proven Project item item-2601/,
      );
      assert(itemError instanceof IssueOwnerMutationCapabilityError);
      assertEqual(graphqlCalls, 1);
    },
    server.operations,
  );
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  const postError = await assertRejects(
    () =>
      guardedTextWrite(capabilityAfterCallback, {
        graphql,
        issueNumber: 2601,
        project,
      }),
    /exact active issue mutex capability/,
  );
  assert(postError instanceof IssueOwnerMutationCapabilityError);
  assertEqual(graphqlCalls, 1);
});

test("owner capability rejects a runtime-built mutation document before GraphQL", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  let graphqlCalls = 0;
  const runtimeField = ["clearProjectV2Item", "FieldValue"].join("");
  const runtimeDocument = `
    mutation ($project: ID!, $item: ID!, $field: ID!) {
      ${runtimeField}(
        input: { projectId: $project, itemId: $item, fieldId: $field }
      ) {
        projectV2Item { id }
      }
    }
  `;

  await withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2602,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (_lease, capability) => {
      const error = await assertRejects(
        () =>
          executeIssueOwnerMutation(
            capability,
            {
              repo: LOCK_TEST_OPTIONS.repo,
              issueNumber: 2602,
              projectOwner: LOCK_TEST_OPTIONS.projectOwner,
              projectNumber: LOCK_TEST_OPTIONS.projectNumber,
              projectId: project.id,
              operation: "claim",
              mutationKind: "update",
              field: "Branch",
              fieldId: "branch",
              dataType: "TEXT",
              itemId: "item-2602",
            },
            runtimeDocument,
            {
              graphql: async () => {
                graphqlCalls += 1;
              },
              value: "fix/2602",
            },
          ),
        /must contain only/,
      );
      assert(error instanceof IssueOwnerMutationCapabilityError);
      assertEqual(graphqlCalls, 0);
    },
    server.operations,
  );
  assertEqual(graphqlCalls, 0);
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
});

test("trusted owner proof rejects a foreign item and forged field map before mutation", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const forgedProject = {
    ...project,
    fields: project.fields.map((field) =>
      field.id === "status"
        ? { ...field, name: "Branch", dataType: "TEXT" }
        : field,
    ),
  };
  let mutations = 0;
  await withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2701,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (_lease, capability) => {
      const foreignItem = await assertRejects(
        () =>
          guardedTextWrite(capability, {
            graphql: async () => {
              mutations += 1;
            },
            issueNumber: 2701,
            itemId: "item-foreign",
            project,
          }),
        /pinned to proven Project item item-2701/,
      );
      assert(foreignItem instanceof IssueOwnerMutationCapabilityError);
      const forgedField = await assertRejects(
        () =>
          guardedTextWrite(capability, {
            fieldId: "status",
            graphql: async () => {
              mutations += 1;
            },
            issueNumber: 2701,
            project: forgedProject,
          }),
        /Project field Branch has proven ID branch, not "status"/,
      );
      assert(forgedField instanceof IssueOwnerMutationCapabilityError);
    },
    server.operations,
  );
  assertEqual(mutations, 0);
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
});

test("semantic owner-field proof rejects same-type stale map swaps before mutation", async () => {
  const cases = [
    {
      field: "Agent",
      issueNumber: 2710,
      left: "Agent",
      right: "Branch",
    },
    {
      field: "Branch",
      issueNumber: 2711,
      left: "Branch",
      right: "PR",
    },
    {
      field: "PR",
      issueNumber: 2712,
      left: "PR",
      right: "Agent",
    },
  ];
  for (const { field, issueNumber, left, right } of cases) {
    const project = ownershipProject();
    const staleProject = swapOwnerFieldIds(project, left, right);
    const staleField = staleProject.fields.find(
      (candidate) => candidate.name === field,
    );
    const trustedField = project.fields.find(
      (candidate) => candidate.name === field,
    );
    const server = createFakeLockServer({ ownerProject: project });
    let graphqlWrites = 0;
    const error = await assertRejects(
      () =>
        withIssueMutationLock(
          LOCK_TEST_OPTIONS,
          issueNumber,
          { operation: "claim", projectId: project.id, agent: "codex" },
          async (_lease, capability) => {
            await guardedTextWrite(capability, {
              field,
              fieldId: staleField.id,
              graphql: async () => {
                graphqlWrites += 1;
                return { data: {} };
              },
              issueNumber,
              project: staleProject,
            });
          },
          server.operations,
        ),
      new RegExp(
        `Project field ${field} has proven ID ${trustedField.id}, not "${staleField.id}"[\\s\\S]*remains at LOCK`,
      ),
    );
    assert(error instanceof IssueMutationLockStaleError);
    assertEqual(graphqlWrites, 0);
    assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
  }
});

test("a fresh claim adopts only the independently proven Project item", async () => {
  const server = createFakeLockServer({
    ownerItemIds: [null, "item-2702"],
  });
  const project = ownershipProject();
  let mutations = 0;
  await withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2702,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (_lease, capability) => {
      await guardedTextWrite(capability, {
        graphql: async () => {
          mutations += 1;
          return { data: {} };
        },
        issueNumber: 2702,
        itemId: "item-2702",
        project,
      });
    },
    server.operations,
  );
  assertEqual(server.ownerTargetReads, 2);
  assertEqual(mutations, 1);
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
});

test("owner mutation variables use the frozen trusted target IDs", async () => {
  const project = ownershipProject();
  const server = createFakeLockServer({ ownerProject: project });
  const mutations = [];
  await withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2704,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (_lease, capability) => {
      const write = guardedTextWrite(capability, {
        graphql: async (document, variables, transport) => {
          mutations.push({ document, variables, transport });
          return { data: {} };
        },
        issueNumber: 2704,
        project,
      });
      project.id = "changed-after-capability-check";
      await write;
    },
    server.operations,
  );
  assertEqual(mutations.length, 1);
  const expectedField = ["updateProjectV2Item", "FieldValue"].join("");
  assert(mutations[0].document.includes(expectedField));
  assertDeepEqual(mutations[0].variables, {
    project: "project",
    item: "item-2704",
    field: "branch",
    text: "fix/2704",
  });
  assertDeepEqual(mutations[0].transport, {
    dryRun: false,
    mutates: true,
  });
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
});

test("owner proof schema failure releases LOCK before the lifecycle callback", async () => {
  const invalidProject = ownershipProject();
  invalidProject.fields = invalidProject.fields.map((field) =>
    field.id === "branch" ? { ...field, dataType: "DATE" } : field,
  );
  const server = createFakeLockServer({ ownerProject: invalidProject });
  let callbacks = 0;
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2703,
        { operation: "review", projectId: invalidProject.id, agent: "codex" },
        async () => {
          callbacks += 1;
        },
        server.operations,
      ),
    /Project field Branch must have type TEXT, found DATE/,
  );
  assert(error instanceof IssueOwnerMutationCapabilityError);
  assertEqual(callbacks, 0);
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  assertEqual(
    server.commits.get(server.refOid).payload.outcome,
    "owner target proof rejected before board mutation",
  );
});

test("owner target proof rejects missing connection nodes before the callback", async () => {
  for (const missing of ["projectItems", "fields"]) {
    const project = ownershipProject();
    const server = createFakeLockServer({
      ownerProject: project,
      ownerTargetTransport: async (_query, variables) => ({
        data: {
          repository: {
            id: "repository-id",
            nameWithOwner: `${variables.owner}/${variables.name}`,
            issue: {
              id: `issue-${variables.issue}`,
              number: variables.issue,
              projectItems: {
                ...(missing === "projectItems"
                  ? {}
                  : {
                      nodes: [
                        {
                          id: `item-${variables.issue}`,
                          project: { id: project.id },
                        },
                      ],
                    }),
                pageInfo: { hasNextPage: false },
              },
            },
          },
          organization: {
            login: variables.projectOwner,
            projectV2: {
              id: project.id,
              number: variables.projectNumber,
              fields: {
                ...(missing === "fields" ? {} : { nodes: project.fields }),
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
    });
    let callbacks = 0;
    const error = await assertRejects(
      () =>
        withIssueMutationLock(
          LOCK_TEST_OPTIONS,
          missing === "projectItems" ? 27031 : 27032,
          { operation: "review", projectId: project.id, agent: "codex" },
          async () => {
            callbacks += 1;
          },
          server.operations,
        ),
      missing === "projectItems"
        ? /Project item membership proof is missing or paginated/
        : /Project owner-field proof is missing or paginated/,
    );
    assert(error instanceof IssueOwnerMutationCapabilityError);
    assertEqual(callbacks, 0);
    assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  }
});

test("owner proof repository mismatch releases LOCK before any mutation", async () => {
  const project = ownershipProject();
  const server = createFakeLockServer({
    ownerProject: project,
    ownerRepositoryIds: ["replacement-repository-id"],
  });
  let callbacks = 0;
  let mutations = 0;
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2705,
        { operation: "review", projectId: project.id, agent: "codex" },
        async (_lease, capability) => {
          callbacks += 1;
          await guardedTextWrite(capability, {
            graphql: async () => {
              mutations += 1;
              return { data: {} };
            },
            issueNumber: 2705,
            itemId: "item-2705",
            operation: "review",
            project,
          });
        },
        server.operations,
      ),
    /proven repository replacement-repository-id does not match locked repository repository-id/,
  );
  assert(error instanceof IssueOwnerMutationCapabilityError);
  assertEqual(callbacks, 0);
  assertEqual(mutations, 0);
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  assertEqual(
    server.commits.get(server.refOid).payload.outcome,
    "owner target proof rejected before board mutation",
  );
});

test("claim target refresh retains LOCK when the repository identity changes", async () => {
  const project = ownershipProject();
  const server = createFakeLockServer({
    ownerItemIds: [null, "item-2706"],
    ownerProject: project,
    ownerRepositoryIds: ["repository-id", "replacement-repository-id"],
  });
  let mutations = 0;
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2706,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (_lease, capability) => {
          await guardedTextWrite(capability, {
            graphql: async () => {
              mutations += 1;
              return { data: {} };
            },
            issueNumber: 2706,
            itemId: "item-2706",
            project,
          });
        },
        server.operations,
      ),
    /proven repository replacement-repository-id does not match locked repository repository-id[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(server.ownerTargetReads, 2);
  assertEqual(mutations, 0);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("claim repository refresh mismatch skips cleanup and retains LOCK", async () => {
  const number = 2707;
  const project = ownershipProject();
  const claimField = project.fields.find(({ name }) => name === "Claim ID");
  const server = createFakeLockServer({
    ownerItemIds: [null, `item-${number}`],
    ownerProject: project,
    ownerRepositoryIds: ["repository-id", "replacement-repository-id"],
  });
  const issue = {
    id: `issue-${number}`,
    number,
    title: "repository replacement during fresh claim",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  let cleanupLabelWrites = 0;
  let ownerWrites = 0;
  const error = await assertRejects(
    () =>
      claim(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [number],
          branch: `fix/${number}`,
          claimId: `claim-${number}`,
          sweepEligible: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => project,
          getIssue: async () => issue,
          findIssueProjectItem: async () => null,
          ensureProjectItem: async () => `item-${number}`,
          readClaimOwnership: async () => ({
            claimId: null,
            agent: null,
            branch: null,
            claimedAt: null,
            pr: null,
          }),
          reserveClaimOwnership: async (
            options,
            currentProject,
            itemId,
            currentIssue,
            metadata,
            capability,
          ) => {
            await updateTextField(
              capability,
              options,
              currentProject,
              itemId,
              claimField.id,
              metadata.claimId,
              {
                field: "Claim ID",
                graphql: async () => {
                  ownerWrites += 1;
                  return { data: {} };
                },
                issueNumber: currentIssue.number,
                operation: "claim",
              },
            );
          },
          editIssueLabels: async () => {
            cleanupLabelWrites += 1;
          },
          removeIssueLabels: async () => {
            cleanupLabelWrites += 1;
          },
          updateProjectMetadata: async () => {
            ownerWrites += 1;
          },
          withIssueMutationLock: (
            options,
            issueNumber,
            metadata,
            mutation,
            lockOverrides,
          ) =>
            withIssueMutationLock(
              options,
              issueNumber,
              metadata,
              mutation,
              server.withOperations(lockOverrides),
            ),
        },
      ),
    /proven repository replacement-repository-id does not match locked repository repository-id[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(server.ownerTargetReads, 2);
  assertEqual(cleanupLabelWrites, 0);
  assertEqual(ownerWrites, 0);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("claim target refresh transport failure skips cleanup and retains LOCK", async () => {
  const number = 2708;
  const project = ownershipProject();
  const claimField = project.fields.find(({ name }) => name === "Claim ID");
  const refreshFailure = new Error("owner target refresh transport failed");
  const server = createFakeLockServer({
    ownerItemIds: [null, `item-${number}`],
    ownerProject: project,
    ownerTargetErrors: [null, refreshFailure],
  });
  const issue = {
    id: `issue-${number}`,
    number,
    title: "owner target transport failure during fresh claim",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  let cleanupLabelWrites = 0;
  let ownerWrites = 0;
  const error = await assertRejects(
    () =>
      claim(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [number],
          branch: `fix/${number}`,
          claimId: `claim-${number}`,
          sweepEligible: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => project,
          getIssue: async () => issue,
          findIssueProjectItem: async () => null,
          ensureProjectItem: async () => `item-${number}`,
          readClaimOwnership: async () => ({
            claimId: null,
            agent: null,
            branch: null,
            claimedAt: null,
            pr: null,
          }),
          reserveClaimOwnership: async (
            options,
            currentProject,
            itemId,
            currentIssue,
            metadata,
            capability,
          ) => {
            await updateTextField(
              capability,
              options,
              currentProject,
              itemId,
              claimField.id,
              metadata.claimId,
              {
                field: "Claim ID",
                graphql: async () => {
                  ownerWrites += 1;
                  return { data: {} };
                },
                issueNumber: currentIssue.number,
                operation: "claim",
              },
            );
          },
          editIssueLabels: async () => {
            cleanupLabelWrites += 1;
          },
          removeIssueLabels: async () => {
            cleanupLabelWrites += 1;
          },
          updateProjectMetadata: async () => {
            ownerWrites += 1;
          },
          withIssueMutationLock: (
            options,
            issueNumber,
            metadata,
            mutation,
            lockOverrides,
          ) =>
            withIssueMutationLock(
              options,
              issueNumber,
              metadata,
              mutation,
              server.withOperations(lockOverrides),
            ),
        },
      ),
    /Owner-field mutation target refresh failed[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  let cause = error;
  let retainedRefreshCause = false;
  while (cause && typeof cause === "object") {
    if (cause === refreshFailure) {
      retainedRefreshCause = true;
      break;
    }
    cause = cause.cause;
  }
  assert(retainedRefreshCause, "claim refresh failure lost its original cause");
  assertEqual(server.ownerTargetReads, 2);
  assertEqual(cleanupLabelWrites, 0);
  assertEqual(ownerWrites, 0);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("claim rejects a same-type stale getProject field map before any mutation", async () => {
  const number = 2713;
  const project = ownershipProject();
  const staleProject = swapOwnerFieldIds(project, "Claim ID", "Agent");
  const staleClaimField = staleProject.fields.find(
    (field) => field.name === "Claim ID",
  );
  const server = createFakeLockServer({ ownerProject: project });
  const issue = {
    id: `issue-${number}`,
    number,
    title: "stale same-type owner field map",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  let graphqlOwnerWrites = 0;
  let labelWrites = 0;
  let metadataWrites = 0;
  const error = await assertRejects(
    () =>
      claim(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [number],
          branch: `fix/${number}`,
          claimId: `claim-${number}`,
          sweepEligible: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => staleProject,
          getIssue: async () => issue,
          findIssueProjectItem: async () => null,
          ensureProjectItem: async () => `item-${number}`,
          readClaimOwnership: async () => ({
            claimId: null,
            agent: null,
            branch: null,
            claimedAt: null,
            pr: null,
          }),
          reserveClaimOwnership: async (
            options,
            currentProject,
            itemId,
            currentIssue,
            metadata,
            capability,
          ) => {
            await updateTextField(
              capability,
              options,
              currentProject,
              itemId,
              staleClaimField.id,
              metadata.claimId,
              {
                field: "Claim ID",
                graphql: async () => {
                  graphqlOwnerWrites += 1;
                  return { data: {} };
                },
                issueNumber: currentIssue.number,
                operation: "claim",
              },
            );
          },
          editIssueLabels: async () => {
            labelWrites += 1;
          },
          removeIssueLabels: async () => {
            labelWrites += 1;
          },
          updateProjectMetadata: async () => {
            metadataWrites += 1;
          },
          withIssueMutationLock: (
            options,
            issueNumber,
            metadata,
            mutation,
            lockOverrides,
          ) =>
            withIssueMutationLock(
              options,
              issueNumber,
              metadata,
              mutation,
              server.withOperations(lockOverrides),
            ),
        },
      ),
    /Project field Claim ID has proven ID claim, not "agent"[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(graphqlOwnerWrites, 0);
  assertEqual(labelWrites, 0);
  assertEqual(metadataWrites, 0);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("partial claim capability failure skips the label-only fallback", async () => {
  const number = 2709;
  const project = ownershipProject();
  const server = createFakeLockServer({ ownerProject: project });
  let issue = {
    id: `issue-${number}`,
    number,
    title: "capability failure during partial claim recovery",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  let ownership = {
    claimId: null,
    agent: null,
    branch: null,
    claimedAt: null,
    pr: null,
  };
  let labelWrites = 0;
  let metadataWrites = 0;
  let reservations = 0;
  const error = await assertRejects(
    () =>
      claim(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [number],
          branch: `fix/${number}`,
          claimId: `claim-${number}`,
          sweepEligible: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => project,
          getIssue: async () => issue,
          findIssueProjectItem: async () => null,
          ensureProjectItem: async () => `item-${number}`,
          readClaimOwnership: async () => ({ ...ownership }),
          reserveClaimOwnership: async (
            _options,
            _project,
            _itemId,
            _issue,
            metadata,
          ) => {
            reservations += 1;
            if (reservations === 1) {
              ownership = {
                claimId: metadata.claimId,
                agent: metadata.agent,
                branch: metadata.branch,
                claimedAt: projectDateFieldValue(metadata.claimedAt),
                pr: metadata.pr,
              };
              throw new Error("initial reservation response was lost");
            }
            throw new IssueOwnerMutationCapabilityError(
              "partial reservation capability rejected",
            );
          },
          editIssueLabels: async (_options, current, target) => {
            labelWrites += 1;
            assertEqual(target, "active");
            issue = { ...current, labels: [{ name: "agent-active" }] };
          },
          removeIssueLabels: async () => {
            throw new Error("capability failure must skip label-only cleanup");
          },
          updateProjectMetadata: async () => {
            metadataWrites += 1;
          },
          withIssueMutationLock: (
            options,
            issueNumber,
            metadata,
            mutation,
            lockOverrides,
          ) =>
            withIssueMutationLock(
              options,
              issueNumber,
              metadata,
              mutation,
              server.withOperations(lockOverrides),
            ),
        },
      ),
    /partial reservation capability rejected[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(reservations, 2);
  assertEqual(labelWrites, 1);
  assertEqual(metadataWrites, 0);
  assertDeepEqual(issue.labels, [{ name: "agent-active" }]);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("review, backfill, sync, and Status keep exact owner-field boundaries", async () => {
  const project = ownershipProject();
  const reviewFields = [];
  await withRealOwnerCapability("review", project, 2614, async (capability) => {
    for (const [field, fieldId] of [
      ["Branch", "branch"],
      ["PR", "pr"],
    ]) {
      await guardedTextWrite(capability, {
        field,
        fieldId,
        graphql: async (_query, variables) => {
          reviewFields.push(variables.field);
          return { data: {} };
        },
        issueNumber: 2614,
        itemId: "item-2614",
        operation: "review",
        project,
      });
    }
    for (const [field, fieldId] of [
      ["Agent", "agent"],
      ["Status", "status"],
    ]) {
      await assertRejects(
        () =>
          guardedTextWrite(capability, {
            field,
            fieldId,
            issueNumber: 2614,
            itemId: "item-2614",
            operation: "review",
            project,
          }),
        /cannot write Project field/,
      );
    }
  });
  assertDeepEqual(reviewFields, ["branch", "pr"]);

  let membershipWrites = 0;
  let ownerWrites = 0;
  await withRealOwnerCapability("sync", project, 2615, async (capability) => {
    await (async () => {
      membershipWrites += 1;
      return "item-2615";
    })();
    await assertRejects(
      () =>
        guardedTextWrite(capability, {
          graphql: async () => {
            ownerWrites += 1;
          },
          issueNumber: 2615,
          itemId: "item-2615",
          operation: "sync",
          project,
        }),
      /cannot write Project field/,
    );
  });
  assertEqual(membershipWrites, 1);
  assertEqual(ownerWrites, 0);
});

test("concurrent and nested capabilities cannot be swapped", async () => {
  const firstServer = createFakeLockServer();
  const secondServer = createFakeLockServer();
  const project = ownershipProject();
  const rendezvous = twoPartyBarrier();
  let firstCapability;
  let secondCapability;
  let writes = 0;
  const graphql = async () => {
    writes += 1;
    return { data: {} };
  };
  const run = (issueNumber, server, assignCapability, swappedCapability) =>
    withIssueMutationLock(
      LOCK_TEST_OPTIONS,
      issueNumber,
      { operation: "claim", projectId: project.id, agent: "codex" },
      async (_lease, capability) => {
        assignCapability(capability);
        await rendezvous();
        await assertRejects(
          () =>
            guardedTextWrite(swappedCapability(), {
              graphql,
              issueNumber,
              project,
            }),
          /scope mismatch: issue/,
        );
        await guardedTextWrite(capability, {
          graphql,
          issueNumber,
          project,
        });
      },
      server.operations,
    );
  await Promise.all([
    run(
      2602,
      firstServer,
      (capability) => {
        firstCapability = capability;
      },
      () => secondCapability,
    ),
    run(
      2603,
      secondServer,
      (capability) => {
        secondCapability = capability;
      },
      () => firstCapability,
    ),
  ]);
  assertEqual(writes, 2);

  const outerServer = createFakeLockServer();
  const innerServer = createFakeLockServer();
  await withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2604,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (_outerLease, outerCapability) => {
      let innerCapability;
      await withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2605,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (_innerLease, capability) => {
          innerCapability = capability;
          await guardedTextWrite(capability, {
            graphql,
            issueNumber: 2605,
            project,
          });
        },
        innerServer.operations,
      );
      await assertRejects(
        () =>
          guardedTextWrite(innerCapability, {
            graphql,
            issueNumber: 2605,
            project,
          }),
        /exact active issue mutex capability/,
      );
      await guardedTextWrite(outerCapability, {
        graphql,
        issueNumber: 2604,
        project,
      });
    },
    outerServer.operations,
  );
  assertEqual(writes, 4);
});

test("delayed owner writes fail after callback sealing before GraphQL", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  let graphqlCalls = 0;
  let delayedResult;
  await withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2606,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (_lease, capability) => {
      delayedResult = new Promise((resolve) => {
        setTimeout(async () => {
          try {
            await guardedTextWrite(capability, {
              graphql: async () => {
                graphqlCalls += 1;
              },
              issueNumber: 2606,
              project,
            });
            resolve(null);
          } catch (err) {
            resolve(err);
          }
        }, 0);
      });
    },
    server.operations,
  );
  const delayedError = await delayedResult;
  assert(delayedError instanceof IssueOwnerMutationCapabilityError);
  assertEqual(graphqlCalls, 0);
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
});

async function runUnawaitedOwnerWriteCase(
  issueNumber,
  { markSafe = false, reject = false } = {},
) {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const started = deferredPromise();
  const settle = deferredPromise();
  const command = withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    issueNumber,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (lease, capability) => {
      guardedTextWrite(capability, {
        graphql: async () => {
          started.resolve();
          return settle.promise;
        },
        issueNumber,
        project,
      });
      if (markSafe) lease.markSafeToUnlock("unsafe early safe mark");
    },
    server.operations,
  );
  await started.promise;
  if (reject) {
    settle.reject(new Error("unawaited GraphQL rejected"));
  } else {
    settle.resolve({ data: {} });
  }
  const error = await assertRejects(
    () => command,
    /callback settled with 1 pending owner-field mutation promise/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(error.code, "ISSUE_MUTATION_LOCK_STALE");
  assert(
    error.message.includes("Every owner-field mutation must settle"),
    "pending-write error must explain the await contract",
  );
  assert(
    error.message.includes("Do not delete or force-update the mutex ref"),
    "pending-write error must include no-retry recovery evidence",
  );
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
  return error;
}

test("unawaited owner writes retain LOCK on success, rejection, and an early safe mark", async () => {
  await runUnawaitedOwnerWriteCase(2607);
  const rejection = await runUnawaitedOwnerWriteCase(2608, { reject: true });
  assert(
    rejection.cause?.cause instanceof AggregateError,
    "pending rejection must remain in typed recovery evidence",
  );
  await runUnawaitedOwnerWriteCase(2609, { markSafe: true });
});

test("a settled owner rejection that the callback never observes retains LOCK", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2621,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (_lease, capability) => {
          guardedTextWrite(capability, {
            graphql: async () => {
              throw new Error("immediate unobserved GraphQL rejection");
            },
            issueNumber: 2621,
            project,
          });
          await new Promise((resolve) => setImmediate(resolve));
        },
        server.operations,
      ),
    /callback settled with 1 owner-field mutation failure\(s\) that did not propagate through the callback rejection[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(error.cause?.code, "ISSUE_OWNER_MUTATION_UNPROPAGATED");
  assert(
    error.cause?.cause instanceof AggregateError,
    "unpropagated rejection must remain in typed recovery evidence",
  );
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("an awaited owner rejection can use the verified recovery unlock path", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2622,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (lease, capability) => {
          try {
            await guardedTextWrite(capability, {
              graphql: async () => {
                throw new Error("awaited GraphQL rejection");
              },
              issueNumber: 2622,
              project,
            });
          } catch (writeError) {
            lease.markSafeToUnlock("awaited owner rejection handled");
            throw writeError;
          }
        },
        server.operations,
      ),
    /awaited GraphQL rejection/,
  );
  assert(!(error instanceof IssueMutationLockStaleError));
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  assertEqual(
    server.commits.get(server.refOid).payload.outcome,
    "awaited owner rejection handled",
  );
});

test("Promise.all observes owner mutation thenables before unlock", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  let writes = 0;
  const result = await withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2623,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (_lease, capability) => {
      await Promise.all([
        guardedTextWrite(capability, {
          graphql: async () => {
            writes += 1;
            return { data: {} };
          },
          issueNumber: 2623,
          project,
        }),
      ]);
      return "written";
    },
    server.operations,
  );
  assertEqual(result, "written");
  assertEqual(writes, 1);
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
});

async function runIgnoredRejectedContinuationCase(issueNumber, continuation) {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        issueNumber,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (_lease, capability) => {
          const write = guardedTextWrite(capability, {
            graphql: async () => {
              throw new Error(
                `ignored continuation GraphQL rejection ${issueNumber}`,
              );
            },
            issueNumber,
            project,
          });
          continuation(write);
          await new Promise((resolve) => setImmediate(resolve));
        },
        server.operations,
      ),
    /owner-field mutation failure\(s\) that did not propagate through the callback rejection[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(error.cause?.code, "ISSUE_OWNER_MUTATION_UNPROPAGATED");
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
}

test("an ignored then continuation retains a propagated rejection under LOCK", async () => {
  await runIgnoredRejectedContinuationCase(2624, (write) => {
    write.then(() => "unexpected success");
  });
});

test("an ignored finally continuation retains a propagated rejection under LOCK", async () => {
  await runIgnoredRejectedContinuationCase(2625, (write) => {
    write.finally(() => {});
  });
});

test("an ignored async catch continuation must settle before callback return", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const handlerStarted = deferredPromise();
  const handlerSettle = deferredPromise();
  const callbackReturning = deferredPromise();
  const command = withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2626,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (_lease, capability) => {
      guardedTextWrite(capability, {
        graphql: async () => {
          throw new Error("async catch GraphQL rejection");
        },
        issueNumber: 2626,
        project,
      }).catch(async () => {
        handlerStarted.resolve();
        await handlerSettle.promise;
      });
      await handlerStarted.promise;
      callbackReturning.resolve();
    },
    server.operations,
  );
  await callbackReturning.promise;
  await new Promise((resolve) => setImmediate(resolve));
  handlerSettle.resolve();
  const error = await assertRejects(
    () => command,
    /callback settled with 1 pending owner-field mutation promise[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(error.cause?.code, "ISSUE_OWNER_MUTATION_PENDING");
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

async function runAwaitedRejectedContinuationCase(
  issueNumber,
  name,
  continuation,
) {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        issueNumber,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (lease, capability) => {
          const write = guardedTextWrite(capability, {
            graphql: async () => {
              throw new Error(`awaited ${name} GraphQL rejection`);
            },
            issueNumber,
            project,
          });
          try {
            await continuation(write);
          } catch (writeError) {
            lease.markSafeToUnlock(`awaited ${name} rejection handled`);
            throw writeError;
          }
        },
        server.operations,
      ),
    new RegExp(`awaited ${name} GraphQL rejection`),
  );
  assert(!(error instanceof IssueMutationLockStaleError));
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  assertEqual(
    server.commits.get(server.refOid).payload.outcome,
    `awaited ${name} rejection handled`,
  );
}

test("an awaited then continuation completes its rejection path before unlock", async () => {
  await runAwaitedRejectedContinuationCase(2627, "then", (write) =>
    write.then(() => "unexpected success"),
  );
});

test("an awaited catch continuation completes its async rejection path before unlock", async () => {
  await runAwaitedRejectedContinuationCase(2628, "catch", (write) =>
    write.catch(async (error) => {
      await Promise.resolve();
      throw error;
    }),
  );
});

test("an awaited finally continuation completes its rejection path before unlock", async () => {
  await runAwaitedRejectedContinuationCase(2629, "finally", (write) =>
    write.finally(async () => {
      await Promise.resolve();
    }),
  );
});

async function runIgnoredNativeAssimilationCase(issueNumber, assimilate) {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        issueNumber,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (_lease, capability) => {
          const write = guardedTextWrite(capability, {
            graphql: async () => {
              throw new Error(
                `ignored native assimilation rejection ${issueNumber}`,
              );
            },
            issueNumber,
            project,
          });
          const nativePromise = assimilate(write);
          // Drain the process-level rejection without returning its evidence to
          // the lock callback. The settled-failure ledger must still retain it.
          void nativePromise.catch(() => {});
          await new Promise((resolve) => setImmediate(resolve));
        },
        server.operations,
      ),
    /failure\(s\) that did not propagate through the callback rejection[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(error.cause?.code, "ISSUE_OWNER_MUTATION_UNPROPAGATED");
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
}

test("an ignored fast Promise.resolve assimilation retains LOCK", async () => {
  await runIgnoredNativeAssimilationCase(2630, (write) =>
    Promise.resolve(write),
  );
});

test("an ignored fast Promise.all assimilation retains LOCK", async () => {
  await runIgnoredNativeAssimilationCase(2631, (write) => Promise.all([write]));
});

test("an ignored fast async-wrapper assimilation retains LOCK", async () => {
  await runIgnoredNativeAssimilationCase(2632, async (write) => {
    await write;
  });
});

test("late external observation cannot erase settled owner-failure evidence", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const callbackReturning = deferredPromise();
  let lateWrite;
  const command = withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2633,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (_lease, capability) => {
      lateWrite = guardedTextWrite(capability, {
        graphql: async () => {
          throw new Error("late external observation rejection");
        },
        issueNumber: 2633,
        project,
      });
      await new Promise((resolve) => setImmediate(resolve));
      callbackReturning.resolve();
    },
    server.operations,
  );
  const observedCommand = command.then(
    (value) => ({ rejected: false, value }),
    (error) => ({ error, rejected: true }),
  );
  await callbackReturning.promise;
  await new Promise((resolve) => setImmediate(resolve));
  await lateWrite.catch(() => {});
  const outcome = await observedCommand;
  assertEqual(outcome.rejected, true);
  assert(outcome.error instanceof IssueMutationLockStaleError);
  assertEqual(outcome.error.cause?.code, "ISSUE_OWNER_MUTATION_UNPROPAGATED");
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("one propagated branch does not cover a distinct ignored assimilation failure", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const ignoredFailure = new Error("ignored branch owner failure");
  const propagatedFailure = new Error("propagated branch owner failure");
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2634,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (lease, capability) => {
          const ignoredBranch = Promise.resolve(
            guardedTextWrite(capability, {
              field: "Agent",
              fieldId: "agent",
              graphql: async () => {
                throw ignoredFailure;
              },
              issueNumber: 2634,
              project,
            }),
          );
          void ignoredBranch.catch(() => {});
          try {
            await guardedTextWrite(capability, {
              graphql: async () => {
                throw propagatedFailure;
              },
              issueNumber: 2634,
              project,
            });
          } catch (writeError) {
            lease.markSafeToUnlock("one branch recovery verified");
            throw new AggregateError(
              [writeError],
              "propagated owner failure evidence",
              { cause: writeError },
            );
          }
        },
        server.operations,
      ),
    /1 owner-field mutation failure\(s\) that did not propagate[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(error.cause?.code, "ISSUE_OWNER_MUTATION_UNPROPAGATED");
  assert(
    error.cause?.cause?.errors.some((cause) =>
      Object.is(cause, ignoredFailure),
    ),
    "ignored branch failure must remain in recovery evidence",
  );
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

async function runAmbiguousDuplicateOwnerFailureCase(issueNumber, failure) {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        issueNumber,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (lease, capability) => {
          const ignoredBranch = Promise.resolve(
            guardedTextWrite(capability, {
              field: "Agent",
              fieldId: "agent",
              graphql: async () => {
                throw failure;
              },
              issueNumber,
              project,
            }),
          );
          void ignoredBranch.catch(() => {});
          try {
            await guardedTextWrite(capability, {
              graphql: async () => {
                throw failure;
              },
              issueNumber,
              project,
            });
          } catch (writeError) {
            lease.markSafeToUnlock("duplicate owner failure recovery verified");
            throw writeError;
          }
        },
        server.operations,
      ),
    /2 owner-field mutation failure\(s\) that did not propagate[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(error.cause?.code, "ISSUE_OWNER_MUTATION_UNPROPAGATED");
  const causes = error.cause?.cause?.errors;
  assert(Array.isArray(causes), "duplicate evidence must be an AggregateError");
  assertEqual(
    causes.filter((cause) => Object.is(cause, failure)).length,
    3,
    "callback and both ambiguous owner-failure occurrences must remain in evidence",
  );
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
}

test("one propagated owner write cannot cover another write with the same Error", async () => {
  await runAmbiguousDuplicateOwnerFailureCase(
    2637,
    new Error("shared owner failure object"),
  );
});

test("one propagated owner write cannot cover another write with the same falsy reason", async () => {
  for (const [index, failure] of [undefined, null, false, 0, ""].entries()) {
    await runAmbiguousDuplicateOwnerFailureCase(2680 + index, failure);
  }
});

test("an awaited Promise.all rejection can unlock after verified nested propagation", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  let callbackEvidence;
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2635,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (lease, capability) => {
          try {
            await Promise.all([
              guardedTextWrite(capability, {
                graphql: async () => {
                  throw new Error("awaited Promise.all owner rejection");
                },
                issueNumber: 2635,
                project,
              }),
            ]);
          } catch (writeError) {
            callbackEvidence = new AggregateError(
              [writeError],
              "verified Promise.all recovery",
            );
            callbackEvidence.cause = callbackEvidence;
            lease.markSafeToUnlock("Promise.all recovery verified");
            throw callbackEvidence;
          }
        },
        server.operations,
      ),
    /verified Promise.all recovery/,
  );
  assert(Object.is(error, callbackEvidence));
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  assertEqual(
    server.commits.get(server.refOid).payload.outcome,
    "Promise.all recovery verified",
  );
});

test("a swallowed awaited owner failure retains LOCK", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2636,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (_lease, capability) => {
          try {
            await guardedTextWrite(capability, {
              graphql: async () => {
                throw new Error("swallowed awaited owner failure");
              },
              issueNumber: 2636,
              project,
            });
          } catch {
            return "swallowed";
          }
          return "unreachable";
        },
        server.operations,
      ),
    /failure\(s\) that did not propagate through the callback rejection[\s\S]*remains at LOCK/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(error.cause?.code, "ISSUE_OWNER_MUTATION_UNPROPAGATED");
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

async function capturePromiseOutcome(command) {
  try {
    return { rejected: false, value: await command };
  } catch (error) {
    return { error, rejected: true };
  }
}

const FALSY_CALLBACK_REJECTIONS = [undefined, null, false, 0, ""];

test("all falsy callback rejections before mutation remain exact rejections", async () => {
  const project = ownershipProject();
  for (const [index, rejection] of FALSY_CALLBACK_REJECTIONS.entries()) {
    const server = createFakeLockServer();
    const outcome = await capturePromiseOutcome(
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2640 + index,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (lease) => {
          lease.markSafeToUnlock("pre-mutation rejection verified");
          throw rejection;
        },
        server.operations,
      ),
    );
    assertEqual(outcome.rejected, true);
    assert(
      Object.is(outcome.error, rejection),
      `pre-mutation rejection ${index} must retain exact identity`,
    );
    assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  }
});

test("all falsy callback rejections after mutation retain LOCK and exact causes", async () => {
  const project = ownershipProject();
  for (const [index, rejection] of FALSY_CALLBACK_REJECTIONS.entries()) {
    const issueNumber = 2650 + index;
    const server = createFakeLockServer();
    const outcome = await capturePromiseOutcome(
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        issueNumber,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (_lease, capability) => {
          await guardedTextWrite(capability, {
            issueNumber,
            project,
          });
          throw rejection;
        },
        server.operations,
      ),
    );
    assertEqual(outcome.rejected, true);
    assert(outcome.error instanceof IssueMutationLockStaleError);
    assert(
      Object.hasOwn(outcome.error, "cause") &&
        Object.is(outcome.error.cause, rejection),
      `post-mutation rejection ${index} must retain its exact cause`,
    );
    assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
  }
});

test("closure evidence retains every falsy callback rejection value", async () => {
  const project = ownershipProject();
  for (const [index, rejection] of FALSY_CALLBACK_REJECTIONS.entries()) {
    const issueNumber = 2660 + index;
    const server = createFakeLockServer();
    const ownerFailure = new Error(`unpropagated owner failure ${index}`);
    const outcome = await capturePromiseOutcome(
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        issueNumber,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (_lease, capability) => {
          guardedTextWrite(capability, {
            graphql: async () => {
              throw ownerFailure;
            },
            issueNumber,
            project,
          });
          await new Promise((resolve) => setImmediate(resolve));
          throw rejection;
        },
        server.operations,
      ),
    );
    assertEqual(outcome.rejected, true);
    assert(outcome.error instanceof IssueMutationLockStaleError);
    const causes = outcome.error.cause?.cause?.errors;
    assert(Array.isArray(causes), "closure evidence must be an AggregateError");
    assert(
      Object.is(causes[0], rejection),
      `closure rejection ${index} must retain its exact value`,
    );
    assert(
      causes.some((cause) => Object.is(cause, ownerFailure)),
      `closure rejection ${index} must retain owner-failure evidence`,
    );
    assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
  }
});

test("primitive owner failures retain LOCK because callback evidence has no occurrence identity", async () => {
  const project = ownershipProject();
  for (const [index, rejection] of FALSY_CALLBACK_REJECTIONS.entries()) {
    const issueNumber = 2670 + index;
    const server = createFakeLockServer();
    const outcome = await capturePromiseOutcome(
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        issueNumber,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (lease, capability) => {
          try {
            await guardedTextWrite(capability, {
              graphql: async () => {
                throw rejection;
              },
              issueNumber,
              project,
            });
          } catch (writeError) {
            lease.markSafeToUnlock("falsy owner failure recovery verified");
            throw writeError;
          }
        },
        server.operations,
      ),
    );
    assertEqual(outcome.rejected, true);
    assert(outcome.error instanceof IssueMutationLockStaleError);
    assertEqual(outcome.error.cause?.code, "ISSUE_OWNER_MUTATION_UNPROPAGATED");
    const causes = outcome.error.cause?.cause?.errors;
    assert(
      Array.isArray(causes),
      "primitive evidence must be an AggregateError",
    );
    assertEqual(
      causes.filter((cause) => Object.is(cause, rejection)).length,
      2,
      `owner failure ${index} must retain callback and ledger evidence`,
    );
    assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
  }
});

test("an unrelated callback rejection cannot cover an ignored equal primitive owner failure", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const outcome = await capturePromiseOutcome(
    withIssueMutationLock(
      LOCK_TEST_OPTIONS,
      2690,
      { operation: "claim", projectId: project.id, agent: "codex" },
      async (lease, capability) => {
        guardedTextWrite(capability, {
          graphql: async () => {
            throw undefined;
          },
          issueNumber: 2690,
          project,
        });
        await new Promise((resolve) => setImmediate(resolve));
        lease.markSafeToUnlock("unrelated primitive callback recovery");
        throw undefined;
      },
      server.operations,
    ),
  );
  assertEqual(outcome.rejected, true);
  assert(outcome.error instanceof IssueMutationLockStaleError);
  assertEqual(outcome.error.cause?.code, "ISSUE_OWNER_MUTATION_UNPROPAGATED");
  const causes = outcome.error.cause?.cause?.errors;
  assert(Array.isArray(causes), "primitive evidence must be an AggregateError");
  assertEqual(
    causes.filter((cause) => cause === undefined).length,
    2,
    "callback and ignored primitive owner failure must both remain in evidence",
  );
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("awaited owner writes settle before unlock", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const started = deferredPromise();
  const settle = deferredPromise();
  const command = withIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2610,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (_lease, capability) => {
      await guardedTextWrite(capability, {
        graphql: async () => {
          started.resolve();
          return settle.promise;
        },
        issueNumber: 2610,
        project,
      });
      return "written";
    },
    server.operations,
  );
  await started.promise;
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
  settle.resolve({ data: {} });
  assertEqual(await command, "written");
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
});

test("owner capability is revoked before an unlock failure", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  let capabilityAfterCallback;
  let graphqlCalls = 0;
  const operations = server.withOperations({
    compareAndSwapLockRef: async (...args) => {
      const commit = server.commits.get(args[4]);
      if (
        args[3] !== "0000000000000000000000000000000000000000" &&
        commit?.payload?.state === "UNLOCK"
      ) {
        throw new Error("unlock unavailable");
      }
      return server.compareAndSwapLockRef(...args);
    },
  });
  const error = await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2611,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (_lease, capability) => {
          capabilityAfterCallback = capability;
          await guardedTextWrite(capability, {
            graphql: async () => {
              graphqlCalls += 1;
              return { data: {} };
            },
            issueNumber: 2611,
            project,
          });
        },
        operations,
      ),
    /mutex release is unresolved/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  await assertRejects(
    () =>
      guardedTextWrite(capabilityAfterCallback, {
        graphql: async () => {
          graphqlCalls += 1;
        },
        issueNumber: 2611,
        project,
      }),
    /exact active issue mutex capability/,
  );
  assertEqual(graphqlCalls, 1);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("compensation uses the original active owner capability", async () => {
  const server = createFakeLockServer();
  const project = ownershipProject();
  const fields = [];
  let capabilityAfterCompensation;
  await assertRejects(
    () =>
      withIssueMutationLock(
        LOCK_TEST_OPTIONS,
        2612,
        { operation: "claim", projectId: project.id, agent: "codex" },
        async (lease, capability) => {
          capabilityAfterCompensation = capability;
          await guardedTextWrite(capability, {
            graphql: async (_query, variables) => {
              fields.push(variables.field);
              return { data: {} };
            },
            issueNumber: 2612,
            project,
          });
          try {
            throw new Error("claim postcondition failed");
          } catch (err) {
            await guardedTextWrite(capability, {
              field: "Agent",
              fieldId: "agent",
              graphql: async (_query, variables) => {
                fields.push(variables.field);
                return { data: {} };
              },
              issueNumber: 2612,
              project,
              value: "codex",
            });
            lease.markSafeToUnlock("compensation verified");
            throw err;
          }
        },
        server.operations,
      ),
    /claim postcondition failed/,
  );
  assertDeepEqual(fields, ["branch", "agent"]);
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
  await assertRejects(
    () =>
      guardedTextWrite(capabilityAfterCompensation, {
        issueNumber: 2612,
        project,
      }),
    /exact active issue mutex capability/,
  );
});

test("callback rejection and failed compensation revoke the capability", async () => {
  const project = ownershipProject();
  for (const [issueNumber, callback] of [
    [
      2616,
      async (_lease, capability) => {
        throw Object.assign(new Error("callback rejected"), { capability });
      },
    ],
    [
      2617,
      async (_lease, capability) => {
        try {
          await guardedTextWrite(capability, {
            graphql: async () => {
              throw new Error("compensation write failed");
            },
            issueNumber: 2617,
            project,
          });
        } catch (err) {
          err.capability = capability;
          throw err;
        }
      },
    ],
  ]) {
    const server = createFakeLockServer();
    let captured;
    const error = await assertRejects(
      () =>
        withIssueMutationLock(
          LOCK_TEST_OPTIONS,
          issueNumber,
          { operation: "claim", projectId: project.id, agent: "codex" },
          async (lease, capability) => {
            try {
              return await callback(lease, capability);
            } catch (err) {
              captured = err.capability ?? capability;
              throw err;
            }
          },
          server.operations,
        ),
      /callback rejected|compensation write failed/,
    );
    assert(error instanceof IssueMutationLockStaleError);
    let postGraphqlCalls = 0;
    await assertRejects(
      () =>
        guardedTextWrite(captured, {
          graphql: async () => {
            postGraphqlCalls += 1;
          },
          issueNumber,
          project,
        }),
      /exact active issue mutex capability/,
    );
    assertEqual(postGraphqlCalls, 0);
    assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
  }
});

test("dry-run uses trusted proof and only the prospective missing-item ID", async () => {
  const project = ownershipProject();
  const server = createFakeLockServer({ ownerItemIds: [null] });
  const options = { ...LOCK_TEST_OPTIONS, dryRun: true };
  let captured;
  let graphqlCalls = 0;
  const result = await withIssueMutationLock(
    options,
    2613,
    { operation: "claim", projectId: project.id, agent: "codex" },
    async (_lease, capability) => {
      captured = capability;
      await assertRejects(
        () =>
          guardedTextWrite(capability, {
            issueNumber: 2613,
            itemId: "caller-selected-item",
            options,
            project,
          }),
        /pinned to proven Project item dry-run:prospective-project-item/,
      );
      await assertRejects(
        () =>
          guardedTextWrite(capability, {
            fieldId: "status",
            issueNumber: 2613,
            itemId: PROSPECTIVE_PROJECT_ITEM_ID,
            options,
            project: {
              ...project,
              fields: project.fields.map((field) =>
                field.id === "status"
                  ? { ...field, name: "Branch", dataType: "TEXT" }
                  : field,
              ),
            },
          }),
        /Project field Branch has proven ID branch, not "status"/,
      );
      await guardedTextWrite(capability, {
        graphql: async () => {
          graphqlCalls += 1;
          return { data: {} };
        },
        issueNumber: 2613,
        itemId: PROSPECTIVE_PROJECT_ITEM_ID,
        options,
        project,
      });
      return "planned";
    },
    server.operations,
  );
  assertEqual(server.ownerTargetReads, 1);
  assertEqual(result, "planned");
  await assertRejects(
    () =>
      guardedTextWrite(captured, {
        graphql: async () => {
          graphqlCalls += 1;
        },
        issueNumber: 2613,
        itemId: PROSPECTIVE_PROJECT_ITEM_ID,
        options,
        project,
      }),
    /exact active issue mutex capability/,
  );
  assertEqual(graphqlCalls, 1);
});

test("operator recovery prevents the stale owner's later unlock", async () => {
  const server = createFakeLockServer();
  const staleLease = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2118,
    { operation: "claim", agent: "stale", branch: "stale" },
    server.operations,
  );
  const recovery = server.createCommit(
    { oid: staleLease.lockOid, treeOid: staleLease.treeOid },
    {
      ...staleLease.payload,
      state: "UNLOCK",
      operation: "operator-recovery",
      operationId: "unlock-operator",
      parentLock: staleLease.lockOid,
    },
  );
  await server.compareAndSwapLockRef(
    LOCK_TEST_OPTIONS,
    server.repositoryId,
    staleLease.refName,
    staleLease.lockOid,
    recovery.oid,
  );
  const nextLease = await acquireIssueMutationLock(
    LOCK_TEST_OPTIONS,
    2118,
    { operation: "release", agent: "next", branch: "next" },
    server.operations,
  );
  await assertRejects(
    () => releaseIssueMutationLock(staleLease),
    /release expected .* but found/,
  );
  assertEqual(server.refOid, nextLease.lockOid);
  await releaseIssueMutationLock(nextLease);
});

test("one Project read returns the complete normalized ownership snapshot", async () => {
  let reads = 0;
  const snapshot = await readClaimOwnership(
    {},
    ownershipProject(),
    "item-2111",
    {
      graphql: async () => {
        reads += 1;
        return {
          data: {
            node: {
              fieldValues: {
                nodes: [
                  { field: { id: "claim" }, text: "claim-2111" },
                  { field: { id: "agent" }, text: "codex" },
                  { field: { id: "branch" }, text: "fix/2111" },
                  { field: { id: "claimed" }, date: "2026-08-28" },
                  { field: { id: "pr" }, text: "#2121" },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        };
      },
    },
  );
  assertEqual(reads, 1);
  assertDeepEqual(snapshot, {
    claimId: "claim-2111",
    agent: "codex",
    branch: "fix/2111",
    claimedAt: "2026-08-28",
    pr: 2121,
  });
});

test("ownership reservation rejects incomplete field pages before writing", async () => {
  const incompleteConnections = [
    { pageInfo: { hasNextPage: false } },
    { nodes: [] },
    { nodes: [], pageInfo: { hasNextPage: null } },
  ];
  for (const fieldValues of incompleteConnections) {
    let writes = 0;
    await assertRejects(
      () =>
        reserveClaimOwnership(
          { dryRun: false },
          ownershipProject(),
          "item-incomplete-owner",
          { number: 2111 },
          {
            claimId: "claim-incomplete-owner",
            agent: "codex",
            branch: "fix/incomplete-owner",
            claimedAt: "2026-08-30T09:00:00.000Z",
            pr: null,
          },
          {
            readOwnership: () =>
              readClaimOwnership(
                {},
                ownershipProject(),
                "item-incomplete-owner",
                {
                  graphql: async () => ({
                    data: { node: { fieldValues } },
                  }),
                },
              ),
            writeClaimId: async () => {
              writes += 1;
            },
          },
          TEST_OWNER_CAPABILITY,
        ),
      /ownership lookup was incomplete/,
    );
    assertEqual(writes, 0, "incomplete ownership must not reserve Claim ID");
  }
});

test("claim verification rejects a non-Claim-ID field that did not persist", async () => {
  await assertRejects(
    () =>
      verifyClaimOwnership(
        { dryRun: false },
        ownershipProject(),
        "item-2111",
        { number: 2111 },
        {
          claimId: "claim-2111",
          agent: "codex",
          branch: "fix/2111",
          claimedAt: "2026-08-28T12:00:00.000Z",
          pr: null,
        },
        {
          readOwnership: async () => ({
            claimId: "claim-2111",
            agent: "codex",
            branch: null,
            claimedAt: "2026-08-28",
            pr: null,
          }),
        },
      ),
    /ownership verification failed for branch/,
  );
});

test("fresh ready reservation rejects every pre-existing ownership field", async () => {
  const issue = {
    number: 2198,
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  const partialValues = {
    agent: "foreign-agent",
    branch: "fix/foreign-2198",
    claimedAt: "1900-01-01",
    pr: 9198,
  };
  for (const [field, value] of Object.entries(partialValues)) {
    let writes = 0;
    const error = await assertRejects(
      () =>
        reserveClaimOwnership(
          { dryRun: false },
          ownershipProject(),
          "item-2198",
          issue,
          {
            claimId: "claim-2198",
            agent: "codex",
            branch: "fix/2198",
            claimedAt: "2026-08-28T12:00:00.000Z",
            pr: null,
          },
          {
            readOwnership: async () => ({
              claimId: null,
              agent: null,
              branch: null,
              claimedAt: null,
              pr: null,
              [field]: value,
            }),
            writeClaimId: async () => {
              writes += 1;
            },
          },
        ),
      new RegExp(
        `fresh claim reservation found partial ownership in ${field}[\\s\\S]*requires every other ownership field to be empty`,
      ),
    );
    assert(error instanceof IssueOwnershipConflictError);
    assertEqual(writes, 0, field);
  }
});

test("same-token ready reservation returns only missing ownership fields", async () => {
  let reads = 0;
  let writes = 0;
  const reservation = await reserveClaimOwnership(
    { dryRun: false },
    ownershipProject(),
    "item-2199",
    {
      number: 2199,
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    },
    {
      claimId: "claim-2199",
      agent: "codex",
      branch: "fix/2199",
      claimedAt: "2026-08-28T12:00:00.000Z",
      pr: null,
    },
    {
      readOwnership: async () => {
        reads += 1;
        return {
          claimId: "claim-2199",
          agent: "codex",
          branch: null,
          claimedAt: null,
          pr: null,
        };
      },
      writeClaimId: async () => {
        writes += 1;
      },
    },
  );
  assertEqual(reads, 2);
  assertEqual(writes, 0);
  assertDeepEqual(reservation.missingMetadata, {
    branch: "fix/2199",
    claimedAt: "2026-08-28T12:00:00.000Z",
  });
});

test("ownership writes stop when another owner appears between Project fields", async () => {
  const issue = { number: 2198 };
  const ownerA = {
    claimId: "claim-owner-a",
    agent: null,
    branch: null,
    claimedAt: null,
    pr: null,
  };
  const ownerB = {
    claimId: "claim-owner-b",
    agent: "other",
    branch: "fix/owner-b",
    claimedAt: "2026-08-29",
    pr: null,
  };
  let ownership = { ...ownerA };
  const writes = [];
  await assertRejects(
    () =>
      writeProjectOwnershipMetadata(
        { dryRun: false },
        ownershipProject(),
        "item-2198",
        issue,
        "active",
        ownerA,
        { agent: "codex", branch: "fix/2198" },
        {
          readOwnership: async () => ownership,
          updateMetadata: async (
            _options,
            _project,
            _item,
            _state,
            metadata,
          ) => {
            const [field] = Object.keys(metadata);
            writes.push(field);
            ownership = { ...ownership, ...metadata };
            ownership = { ...ownerB };
          },
        },
      ),
    /ownership changed before branch metadata write/,
  );
  assertDeepEqual(writes, ["agent"]);
  assertDeepEqual(ownership, ownerB);
});

test("Project V2 same-field gap can overwrite an external writer indistinguishably", async () => {
  const issue = { number: 2200 };
  const owner = {
    claimId: "claim-2200",
    agent: "codex",
    branch: null,
    claimedAt: "2026-08-28",
    pr: null,
  };
  let ownership = { ...owner };
  let externalWriteObserved = false;
  const expected = await writeProjectOwnershipMetadata(
    { dryRun: false },
    ownershipProject(),
    "item-2200",
    issue,
    "active",
    owner,
    { branch: "fix/2200" },
    {
      readOwnership: async () => ({ ...ownership }),
      updateMetadata: async (_options, _project, _item, _state, metadata) => {
        ownership = { ...ownership, branch: "manual/repair" };
        externalWriteObserved = true;
        ownership = { ...ownership, ...metadata };
      },
    },
  );

  assertEqual(externalWriteObserved, true);
  assertDeepEqual(ownership, { ...owner, branch: "fix/2200" });
  assertDeepEqual(expected, ownership);
});

test("generated claim IDs use the fixed UUID prefix", async () => {
  const state = {
    issue: {
      id: "issue-2201",
      number: 2201,
      title: "generated owner",
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    },
  };
  let metadata;
  let reservedClaimId;
  let ownership = null;
  const [result] = await claimWithTestLock(
    {
      repo: "mento-protocol/monitoring-monorepo",
      projectOwner: "mento-protocol",
      projectNumber: 12,
      issues: [2201],
      agent: "codex",
      branch: "fix/2201",
      claimId: null,
      sweepEligible: false,
      dryRun: false,
      comment: false,
      pr: null,
    },
    {
      getProject: async () => ownershipProject(),
      now: () => new Date("2026-08-29T10:15:00.000Z"),
      getIssue: async () => state.issue,
      ensureProjectItem: async () => "item-2201",
      reserveClaimOwnership: async (
        _options,
        _project,
        _item,
        _issue,
        reservationMetadata,
      ) => {
        reservedClaimId = reservationMetadata.claimId;
        ownership = {
          claimId: reservedClaimId,
          agent: null,
          branch: null,
          claimedAt: null,
          pr: null,
        };
      },
      readClaimOwnership: async () => ownership,
      editIssueLabels: async (_options, issue) => {
        state.issue = { ...issue, labels: [{ name: "agent-active" }] };
      },
      updateProjectMetadata: async (
        _options,
        _project,
        _item,
        _state,
        nextMetadata,
      ) => {
        metadata = { ...metadata, ...nextMetadata };
        ownership = {
          ...ownership,
          ...nextMetadata,
          claimedAt: Object.hasOwn(nextMetadata, "claimedAt")
            ? projectDateFieldValue(nextMetadata.claimedAt)
            : ownership.claimedAt,
        };
      },
      verifyClaimOwnership: async () => {
        assert(metadata, "claim metadata must be written before verification");
      },
      sleep: async () => {},
    },
  );
  assert(
    /^claim-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      result.claimId,
    ),
    `unexpected generated Claim ID: ${result.claimId}`,
  );
  assertEqual(result.claimId, reservedClaimId);
  assertEqual(Object.hasOwn(metadata, "claimId"), false);
  assertEqual(metadata.claimedAt, "2026-08-29T10:15:00.000Z");
});

test("sweep claims require one explicit stable Claim ID", () => {
  assertThrows(
    () =>
      parseArgs([
        "claim",
        "--issue",
        "2111",
        "--branch",
        "fix/2111",
        "--sweep-eligible",
      ]),
    /--sweep-eligible requires an explicit --claim-id/,
  );
  assertThrows(
    () =>
      parseArgs([
        "claim",
        "--issue",
        "2111",
        "--claim-id",
        "claim-2111",
        "--sweep-eligible",
      ]),
    /--sweep-eligible requires an explicit --branch/,
  );
  assertThrows(
    () =>
      parseArgs([
        "claim",
        "--issue",
        "2111",
        "--claim-id",
        "claim-2111",
        "--branch",
        "fix/2111",
        "--sweep-eligible",
      ]),
    /requires --body-sha256/,
  );
});

test("claim branch resolution fails before a lock or board mutation", async () => {
  let projectReads = 0;
  let lockCalls = 0;
  const base = {
    repo: "mento-protocol/monitoring-monorepo",
    projectOwner: "mento-protocol",
    projectNumber: 12,
    issues: [2111],
    agent: "codex",
    claimId: "claim-2111",
    bodySha256: EMPTY_BODY_SHA256,
    dryRun: false,
    comment: false,
    pr: null,
  };
  const dependencies = {
    getProject: async () => {
      projectReads += 1;
      return ownershipProject();
    },
    withIssueMutationLock: async () => {
      lockCalls += 1;
    },
  };
  await assertRejects(
    () =>
      claim(
        {
          ...base,
          issues: [],
          branch: "fix/2111",
          sweepEligible: true,
        },
        dependencies,
      ),
    /--sweep-eligible requires exactly one explicit issue/,
  );
  await assertRejects(
    () =>
      claim(
        {
          ...base,
          branch: "fix/2111",
          claimId: null,
          sweepEligible: true,
        },
        dependencies,
      ),
    /--sweep-eligible requires an explicit --claim-id/,
  );
  await assertRejects(
    () =>
      claim(
        { ...base, branch: null, sweepEligible: true },
        {
          ...dependencies,
          getGitBranch: async () => {
            throw new Error("sweep must not inspect the ambient branch");
          },
        },
      ),
    /--sweep-eligible requires an explicit --branch/,
  );
  await assertRejects(
    () =>
      claim(
        { ...base, branch: null, sweepEligible: false },
        { ...dependencies, getGitBranch: async () => "" },
      ),
    /claim requires --branch or a checked-out branch/,
  );
  await assertRejects(
    () =>
      claim({ ...base, agent: "codex\nbot", branch: "fix/2111" }, dependencies),
    /Agent must be 1-120/,
  );
  await assertRejects(
    () =>
      claim(
        { ...base, agent: "x".repeat(121), branch: "fix/2111" },
        dependencies,
      ),
    /Agent must be 1-120/,
  );
  await assertRejects(
    () => claim({ ...base, branch: "fix/2111\nnext" }, dependencies),
    /Branch must be 1-256/,
  );
  await assertRejects(
    () => claim({ ...base, branch: "x".repeat(257) }, dependencies),
    /Branch must be 1-256/,
  );
  for (const [, character] of UNSAFE_SINGLE_LINE_TEST_CHARACTERS) {
    await assertRejects(
      () =>
        claim(
          { ...base, agent: `codex${character}bot`, branch: "fix/2111" },
          dependencies,
        ),
      /Agent must be 1-120/,
    );
    await assertRejects(
      () =>
        claim({ ...base, branch: `fix/2111${character}next` }, dependencies),
      /Branch must be 1-256/,
    );
  }
  assertEqual(projectReads, 0);
  assertEqual(lockCalls, 0);
});

test("claim preflight read failure releases an unmutated mutex", async () => {
  const server = createFakeLockServer();
  let boardMutations = 0;
  await assertRejects(
    () =>
      claim(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [2119],
          branch: "fix/2119",
          claimId: "claim-2119",
          sweepEligible: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => {
            throw new Error("claim preflight read failed");
          },
          ensureProjectItem: async () => {
            boardMutations += 1;
          },
          withIssueMutationLock: (options, number, metadata, mutation) =>
            withIssueMutationLock(
              options,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        },
      ),
    /claim preflight read failed[\s\S]*Claim ID: claim-2119/,
  );
  assertEqual(boardMutations, 0);
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
});

test("claim handling preserves the stale mutex code and lease", async () => {
  const lease = { lockOid: "candidate-lock", refName: "refs/test-lock" };
  const error = await assertRejects(
    () =>
      claim(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [2123],
          branch: "fix/2123",
          claimId: "claim-2123",
          sweepEligible: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          withIssueMutationLock: async () => {
            throw new IssueMutationLockStaleError(
              "mutex outcome is unknown",
              lease,
            );
          },
        },
      ),
    /mutex outcome is unknown[\s\S]*Claim ID: claim-2123/,
  );
  assert(error instanceof IssueMutationLockStaleError);
  assertEqual(error.code, "ISSUE_MUTATION_LOCK_STALE");
  assertEqual(error.lease, lease);
});

test("owned lock quarantines empty or foreign partial claims without overwrite", async () => {
  for (const ownership of [
    { claimId: null, agent: null, branch: null, claimedAt: null, pr: null },
    {
      claimId: "claim-foreign",
      agent: "other",
      branch: "other",
      claimedAt: "2026-08-28",
      pr: null,
    },
  ]) {
    let issue = {
      id: "issue-2202",
      number: 2202,
      title: "foreign partial",
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    };
    let edits = 0;
    let projectWrites = 0;
    const error = await assertRejects(
      () =>
        claimWithTestLock(
          {
            repo: "mento-protocol/monitoring-monorepo",
            projectOwner: "mento-protocol",
            projectNumber: 12,
            issues: [2202],
            agent: "codex",
            branch: "fix/2202",
            claimId: "claim-ours",
            sweepEligible: false,
            dryRun: false,
            comment: false,
            pr: null,
          },
          {
            getProject: async () => ownershipProject(),
            getIssue: async () => issue,
            ensureProjectItem: async () => "item-2202",
            reserveClaimOwnership: async () => {
              throw new Error("ambiguous reservation");
            },
            readClaimOwnership: async () => ownership,
            editIssueLabels: async (_options, current, target) => {
              edits += 1;
              assertEqual(target, "grooming");
              issue = {
                ...current,
                labels: [{ name: "needs-grooming" }],
              };
            },
            updateProjectMetadata: async () => {
              projectWrites += 1;
            },
          },
        ),
      /ambiguous reservation[\s\S]*Claim ID: claim-ours/,
    );
    const expectedDisposition = ownership.claimId ? "foreign" : "empty";
    assert(
      error.message.includes(
        `quarantined in needs-grooming with ${expectedDisposition} Project ownership`,
      ),
      `missing ${expectedDisposition} quarantine recovery guidance`,
    );
    assertEqual(edits, 1);
    assertEqual(projectWrites, 0);
    assertDeepEqual(issue.labels, [{ name: "needs-grooming" }]);
  }
});

test("owned lock quarantines a ready claim when Project item creation is ambiguous", async () => {
  let issue = {
    id: "issue-2202",
    number: 2202,
    title: "missing item partial",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  let ownershipWrites = 0;
  const error = await assertRejects(
    () =>
      claimWithTestLock(
        {
          repo: "mento-protocol/monitoring-monorepo",
          projectOwner: "mento-protocol",
          projectNumber: 12,
          issues: [2202],
          agent: "codex",
          branch: "fix/2202",
          claimId: "claim-ours",
          sweepEligible: false,
          dryRun: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => issue,
          ensureProjectItem: async () => {
            throw new Error("item response lost");
          },
          findIssueProjectItem: async () => null,
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "grooming");
            issue = { ...current, labels: [{ name: "needs-grooming" }] };
          },
          reserveClaimOwnership: async () => {
            ownershipWrites += 1;
          },
          updateProjectMetadata: async () => {
            ownershipWrites += 1;
          },
        },
      ),
    /item response lost[\s\S]*Claim ID: claim-ours/,
  );
  assert(
    error.message.includes(
      "quarantined in needs-grooming with missing Project ownership",
    ),
    "missing-item quarantine must require operator inspection",
  );
  assertEqual(ownershipWrites, 0);
  assertDeepEqual(issue.labels, [{ name: "needs-grooming" }]);
});

test("owned ready failure reports the exact quarantine cleanup path", async () => {
  const now = new Date("2026-08-29T01:00:00.000Z");
  let issue = {
    id: "issue-2202",
    number: 2202,
    title: "owned metadata partial",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  const ownership = {
    claimId: "claim-ours",
    agent: "codex",
    branch: "fix/2202",
    claimedAt: projectDateFieldValue(now.toISOString()),
    pr: null,
  };
  const error = await assertRejects(
    () =>
      claimWithTestLock(
        {
          repo: "mento-protocol/monitoring-monorepo",
          projectOwner: "mento-protocol",
          projectNumber: 12,
          issues: [2202],
          agent: "codex",
          branch: "fix/2202",
          claimId: "claim-ours",
          sweepEligible: false,
          dryRun: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          now: () => now,
          getIssue: async () => issue,
          ensureProjectItem: async () => "item-2202",
          reserveClaimOwnership: async () => {},
          readClaimOwnership: async () => ownership,
          editIssueLabels: async (_options, current, target) => {
            if (target === "active") {
              throw new Error("active label did not persist");
            }
            issue = {
              ...current,
              labels: [{ name: "needs-grooming" }],
            };
          },
          updateProjectMetadata: async () => {},
        },
      ),
    /active label did not persist[\s\S]*Claim ID: claim-ours/,
  );
  assert(
    error.message.includes(
      "The matching partial claim is quarantined in needs-grooming",
    ),
    "owned quarantine must name its matching-token cleanup",
  );
  assert(error.message.includes("--needs-grooming"), "missing cleanup flag");
  assertDeepEqual(issue.labels, [{ name: "needs-grooming" }]);
});

test("partial compensation never overwrites a same-token ownership mismatch", async () => {
  let issue = {
    id: "issue-2202",
    number: 2202,
    title: "conflicting compensation owner",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  let projectWrites = 0;
  const error = await assertRejects(
    () =>
      claimWithTestLock(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [2202],
          branch: "fix/2202",
          claimId: "claim-ours",
          sweepEligible: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => issue,
          ensureProjectItem: async () => "item-2202",
          reserveClaimOwnership: async () => {
            throw new Error("reservation response was ambiguous");
          },
          readClaimOwnership: async () => ({
            claimId: "claim-ours",
            agent: "foreign-agent",
            branch: "fix/foreign-2202",
            claimedAt: "1900-01-01",
            pr: 999,
          }),
          editIssueLabels: async (_options, current, target) => {
            assertEqual(target, "grooming");
            issue = { ...current, labels: [{ name: "needs-grooming" }] };
          },
          updateProjectMetadata: async () => {
            projectWrites += 1;
          },
        },
      ),
    /reservation response was ambiguous[\s\S]*Claim ID: claim-ours/,
  );
  assertEqual(projectWrites, 0);
  assert(
    error.message.includes("ours-conflicting Project ownership"),
    "recovery guidance must identify the conflicting same-token snapshot",
  );
  assertDeepEqual(issue.labels, [{ name: "needs-grooming" }]);
});

test("partial claim recovery preserves a newer external non-ready state", async () => {
  let issue = {
    id: "issue-2202",
    number: 2202,
    title: "external review transition",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  let edits = 0;
  let projectWrites = 0;
  const error = await assertRejects(
    () =>
      claimWithTestLock(
        {
          repo: "mento-protocol/monitoring-monorepo",
          projectOwner: "mento-protocol",
          projectNumber: 12,
          issues: [2202],
          agent: "codex",
          branch: "fix/2202",
          claimId: "claim-ours",
          sweepEligible: false,
          dryRun: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => issue,
          ensureProjectItem: async () => "item-2202",
          reserveClaimOwnership: async () => {
            issue = { ...issue, labels: [{ name: "in-pr" }] };
            throw new Error("reservation response lost");
          },
          readClaimOwnership: async () => ({
            claimId: "claim-ours",
            agent: "codex",
            branch: "fix/2202",
            claimedAt: "2026-08-28",
            pr: null,
          }),
          editIssueLabels: async () => {
            edits += 1;
          },
          updateProjectMetadata: async () => {
            projectWrites += 1;
          },
        },
      ),
    /reservation response lost[\s\S]*Claim ID: claim-ours/,
  );
  assertEqual(edits, 0);
  assertEqual(projectWrites, 0);
  assertDeepEqual(issue.labels, [{ name: "in-pr" }]);
  assert(
    error.message.includes("remains non-ready in review"),
    "external review state must appear in recovery guidance",
  );
});

test("partial claim recovery removes only stale ready from a mixed review snapshot", async () => {
  const server = createFakeLockServer();
  let issue = {
    id: "issue-2202",
    number: 2202,
    title: "mixed external review transition",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  let readyRemovals = 0;
  const error = await assertRejects(
    () =>
      claim(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [2202],
          agent: "codex",
          branch: "fix/2202",
          claimId: "claim-ours",
          sweepEligible: false,
          dryRun: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => issue,
          ensureProjectItem: async () => "item-2202",
          reserveClaimOwnership: async () => {
            issue = {
              ...issue,
              labels: [{ name: "agent-ready" }, { name: "in-pr" }],
            };
            throw new Error("mixed reservation response lost");
          },
          readClaimOwnership: async () => ({
            claimId: null,
            agent: null,
            branch: null,
            claimedAt: null,
            pr: null,
          }),
          removeIssueLabels: async (_options, _current, labels) => {
            readyRemovals += 1;
            assertDeepEqual(labels, ["agent-ready"]);
            issue = { ...issue, labels: [{ name: "in-pr" }] };
          },
          editIssueLabels: async () => {
            throw new Error("mixed review state must not be replaced");
          },
          withIssueMutationLock: (lockOptions, number, metadata, mutation) =>
            withIssueMutationLock(
              lockOptions,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        },
      ),
    /mixed reservation response lost[\s\S]*Claim ID: claim-ours/,
  );
  assertEqual(readyRemovals, 1);
  assertDeepEqual(issue.labels, [{ name: "in-pr" }]);
  assert(error.message.includes("remains non-ready in review"));
  assertEqual(server.commits.get(server.refOid).payload.state, "UNLOCK");
});

test("partial claim recovery keeps LOCK for a conflicting non-ready snapshot", async () => {
  const server = createFakeLockServer();
  let issue = {
    id: "issue-2202",
    number: 2202,
    title: "conflicting external transition",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  const error = await assertRejects(
    () =>
      claim(
        {
          ...LOCK_TEST_OPTIONS,
          issues: [2202],
          agent: "codex",
          branch: "fix/2202",
          claimId: "claim-ours",
          sweepEligible: false,
          dryRun: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => issue,
          ensureProjectItem: async () => "item-2202",
          reserveClaimOwnership: async () => {
            issue = {
              ...issue,
              labels: [{ name: "agent-ready" }, { name: "in-pr" }],
            };
            throw new Error("conflicting reservation response lost");
          },
          readClaimOwnership: async () => ({
            claimId: null,
            agent: null,
            branch: null,
            claimedAt: null,
            pr: null,
          }),
          removeIssueLabels: async () => {
            issue = {
              ...issue,
              labels: [{ name: "in-pr" }, { name: "agent-active" }],
            };
          },
          editIssueLabels: async () => {
            throw new Error("conflicting non-ready state must not be replaced");
          },
          withIssueMutationLock: (lockOptions, number, metadata, mutation) =>
            withIssueMutationLock(
              lockOptions,
              number,
              metadata,
              mutation,
              server.operations,
            ),
        },
      ),
    /Persistent issue mutex .* remains at LOCK/,
  );
  assert(error.message.includes("Claim ID: claim-ours"));
  assertDeepEqual(issue.labels, [{ name: "in-pr" }, { name: "agent-active" }]);
  assertEqual(server.commits.get(server.refOid).payload.state, "LOCK");
});

test("fatal queue claims report every completed Claim ID", async () => {
  const states = new Map([
    [
      2203,
      {
        id: "issue-2203",
        number: 2203,
        title: "first",
        state: "OPEN",
        labels: [{ name: "agent-ready" }],
      },
    ],
    [
      2204,
      {
        id: "issue-2204",
        number: 2204,
        title: "second",
        state: "OPEN",
        labels: [{ name: "agent-ready" }],
      },
    ],
  ]);
  const ownershipByIssue = new Map();
  await assertRejects(
    () =>
      claim(
        {
          repo: "mento-protocol/monitoring-monorepo",
          projectOwner: "mento-protocol",
          projectNumber: 12,
          issues: [],
          count: 2,
          agent: "codex",
          branch: "fix/queue",
          claimId: null,
          sweepEligible: false,
          dryRun: false,
          comment: false,
          pr: null,
        },
        {
          getProject: async () => ownershipProject(),
          listReadyIssues: async () => [...states.values()],
          getIssue: async (_options, number) => states.get(number),
          ensureProjectItem: async (_options, _project, issue) =>
            `item-${issue.number}`,
          reserveClaimOwnership: async (
            _options,
            _project,
            _item,
            issue,
            metadata,
          ) => {
            ownershipByIssue.set(issue.number, {
              claimId: metadata.claimId,
              agent: null,
              branch: null,
              claimedAt: null,
              pr: null,
            });
          },
          readClaimOwnership: async (_options, _project, itemId) =>
            ownershipByIssue.get(Number(itemId.replace("item-", ""))),
          editIssueLabels: async (_options, issue) => {
            states.set(issue.number, {
              ...issue,
              labels: [{ name: "agent-active" }],
            });
          },
          updateProjectMetadata: async (
            _options,
            _project,
            itemId,
            _state,
            metadata,
          ) => {
            const number = Number(itemId.replace("item-", ""));
            const ownership = ownershipByIssue.get(number);
            ownershipByIssue.set(number, {
              ...ownership,
              ...metadata,
              claimedAt: Object.hasOwn(metadata, "claimedAt")
                ? projectDateFieldValue(metadata.claimedAt)
                : ownership.claimedAt,
            });
          },
          verifyClaimOwnership: async () => {},
          sleep: async () => {},
          withIssueMutationLock: async (
            _options,
            number,
            _metadata,
            mutation,
          ) => {
            if (number === 2204) throw new Error("fatal lock transport");
            return mutation({ markSafeToUnlock() {} });
          },
        },
      ),
    /fatal lock transport[\s\S]*Completed claims: #2203 Claim ID: claim-/,
  );
});

test("release dry-run reports the plan without requiring applied state", async () => {
  const state = {
    issue: {
      id: "issue-2205",
      number: 2205,
      title: "release dry-run",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    ownership: {
      claimId: "claim-2205",
      agent: "codex",
      branch: "fix/2205",
      claimedAt: "2026-08-28",
      pr: null,
    },
  };
  const original = structuredClone(state);
  let labelPlans = 0;
  let projectPlans = 0;
  let prProofs = 0;
  const [result] = await releaseWithTestLock(
    {
      ...LOCK_TEST_OPTIONS,
      issues: [2205],
      claimId: "claim-2205",
      releaseState: "ready",
      closedUnmergedPr: false,
      mergedPr: false,
      dryRun: true,
      comment: false,
    },
    {
      getProject: async () => ownershipProject(),
      getIssue: async () => state.issue,
      findIssueProjectItem: async () => "item-2205",
      readClaimOwnership: async () => state.ownership,
      listOpenPullRequestsForBranch: async () => {
        prProofs += 1;
        return [];
      },
      editIssueLabels: async () => {
        labelPlans += 1;
      },
      updateProjectMetadata: async () => {
        projectPlans += 1;
      },
    },
  );
  assertDeepEqual(result, {
    number: 2205,
    title: "release dry-run",
    state: "ready",
  });
  assertDeepEqual(state, original);
  assertEqual(labelPlans, 1);
  assertEqual(projectPlans, 1);
  assertEqual(prProofs, 4);
});

test("a PR at every release proof refuses or restores active ownership", async () => {
  for (let proof = 1; proof <= 5; proof += 1) {
    const number = 2220 + proof;
    const original = {
      issue: {
        id: `issue-${number}`,
        number,
        title: `release proof ${proof}`,
        state: "OPEN",
        labels: [{ name: "agent-active" }],
      },
      ownership: {
        claimId: `claim-${number}`,
        agent: "codex",
        branch: `fix/${number}`,
        claimedAt: "2026-08-28",
        pr: null,
      },
    };
    const state = structuredClone(original);
    let prReads = 0;
    await assertRejects(
      () =>
        releaseWithTestLock(
          {
            ...LOCK_TEST_OPTIONS,
            issues: [number],
            claimId: `claim-${number}`,
            releaseState: "ready",
            closedUnmergedPr: false,
            mergedPr: false,
            comment: false,
          },
          {
            getProject: async () => ownershipProject(),
            getIssue: async () => state.issue,
            findIssueProjectItem: async () => `item-${number}`,
            readClaimOwnership: async () => state.ownership,
            listOpenPullRequestsForBranch: async () => {
              prReads += 1;
              return prReads < proof ? [] : [{ number: 9000 + proof }];
            },
            editIssueLabels: async (_options, current, target) => {
              state.issue = {
                ...current,
                labels: [
                  {
                    name: target === "active" ? "agent-active" : "agent-ready",
                  },
                ],
              };
            },
            updateProjectMetadata: async (
              _options,
              _project,
              _item,
              _target,
              metadata,
            ) => {
              state.ownership = { ...state.ownership, ...metadata };
            },
          },
        ),
      /has open PR/,
    );
    assertEqual(prReads, proof);
    assertDeepEqual(state, original);
  }
});

test("closed-unmerged PR release proves the stored repo and branch binding", async () => {
  const state = {
    issue: {
      id: "issue-2205",
      number: 2205,
      title: "closed PR",
      state: "OPEN",
      labels: [{ name: "in-pr" }],
    },
    ownership: {
      claimId: "claim-2205",
      agent: "codex",
      branch: "fix/2205",
      claimedAt: "2026-08-28",
      pr: 2206,
    },
  };
  const [result] = await releaseWithTestLock(
    {
      repo: "mento-protocol/monitoring-monorepo",
      projectOwner: "mento-protocol",
      projectNumber: 12,
      issues: [2205],
      agent: "codex",
      claimId: "claim-2205",
      releaseState: "ready",
      closedUnmergedPr: true,
      dryRun: false,
      comment: false,
    },
    {
      getProject: async () => ownershipProject(),
      getIssue: async () => state.issue,
      findIssueProjectItem: async () => "item-2205",
      readClaimOwnership: async () => state.ownership,
      getPullRequest: async () => ({
        number: 2206,
        state: "CLOSED",
        mergedAt: null,
        headRefName: "fix/2205",
        headRepository: {
          nameWithOwner: "mento-protocol/monitoring-monorepo",
        },
      }),
      listOpenPullRequestsForBranch: async () => [],
      editIssueLabels: async (_options, issue, target) => {
        state.issue = {
          ...issue,
          labels: [{ name: target === "ready" ? "agent-ready" : "in-pr" }],
        };
      },
      updateProjectMetadata: async (
        _options,
        _project,
        _item,
        _target,
        metadata,
      ) => {
        state.ownership = { ...state.ownership, ...metadata };
      },
    },
  );
  assertDeepEqual(result, {
    number: 2205,
    title: "closed PR",
    state: "ready",
  });
  assertDeepEqual(state.ownership, {
    claimId: null,
    agent: null,
    branch: null,
    claimedAt: null,
    pr: null,
  });
});

function mergedContinuationFixture() {
  return {
    issue: {
      id: "issue-2071",
      number: 2071,
      title: "operator-triggered backlog sweep",
      state: "OPEN",
      labels: [{ name: "in-pr" }],
    },
    ownership: {
      claimId: "claim-2071",
      agent: "codex",
      branch: "feat/rank-backlog-skill",
      claimedAt: "2026-08-27",
      pr: 2079,
    },
  };
}

function mergedContinuationOptions(overrides = {}) {
  return {
    repo: "mento-protocol/monitoring-monorepo",
    projectOwner: "mento-protocol",
    projectNumber: 12,
    issues: [2071],
    agent: "codex",
    claimId: "claim-2071",
    releaseState: "grooming",
    closedUnmergedPr: false,
    mergedPr: true,
    dryRun: false,
    comment: false,
    ...overrides,
  };
}

function mergedContinuationDependencies(state, overrides = {}) {
  return {
    getProject: async () => ownershipProject(),
    getIssue: async () => state.issue,
    findIssueProjectItem: async () => "item-2071",
    readClaimOwnership: async () => state.ownership,
    getPullRequest: async () => ({
      number: 2079,
      state: "MERGED",
      mergedAt: "2026-08-27T13:02:47Z",
      headRefName: "feat/rank-backlog-skill",
      headRepository: {
        nameWithOwner: "mento-protocol/monitoring-monorepo",
      },
    }),
    listOpenPullRequestsForBranch: async () => [],
    editIssueLabels: async (_options, current, target) => {
      state.issue = {
        ...current,
        labels: [{ name: target === "review" ? "in-pr" : "needs-grooming" }],
      };
    },
    updateProjectMetadata: async (
      _options,
      _project,
      _item,
      _target,
      metadata,
    ) => {
      state.ownership = { ...state.ownership, ...metadata };
    },
    ...overrides,
  };
}

test("merged stage-one PR can continue #2071 only in needs-grooming", async () => {
  const state = mergedContinuationFixture();
  let mergedProofs = 0;
  let openBranchProofs = 0;
  const [result] = await releaseWithTestLock(
    mergedContinuationOptions(),
    mergedContinuationDependencies(state, {
      getPullRequest: async () => {
        mergedProofs += 1;
        return {
          number: 2079,
          state: "MERGED",
          mergedAt: "2026-08-27T13:02:47Z",
          headRefName: "feat/rank-backlog-skill",
          headRepository: {
            nameWithOwner: "mento-protocol/monitoring-monorepo",
          },
        };
      },
      listOpenPullRequestsForBranch: async () => {
        openBranchProofs += 1;
        return [];
      },
    }),
  );
  assertDeepEqual(result, {
    number: 2071,
    title: "operator-triggered backlog sweep",
    state: "grooming",
  });
  assertEqual(mergedProofs, 5);
  assertEqual(openBranchProofs, 5);
  assertDeepEqual(state.issue.labels, [{ name: "needs-grooming" }]);
  assertDeepEqual(state.ownership, {
    claimId: null,
    agent: null,
    branch: null,
    claimedAt: null,
    pr: null,
  });
});

test("merged continuation requires both MERGED state and mergedAt", async () => {
  for (const pr of [
    { state: "MERGED", mergedAt: null },
    { state: "CLOSED", mergedAt: "2026-08-27T13:02:47Z" },
  ]) {
    const state = mergedContinuationFixture();
    let edits = 0;
    await assertRejects(
      () =>
        releaseWithTestLock(
          mergedContinuationOptions(),
          mergedContinuationDependencies(state, {
            getPullRequest: async () => ({
              number: 2079,
              ...pr,
              headRefName: "feat/rank-backlog-skill",
              headRepository: {
                nameWithOwner: "mento-protocol/monitoring-monorepo",
              },
            }),
            editIssueLabels: async () => {
              edits += 1;
            },
          }),
        ),
      /must be MERGED with a merge timestamp/,
    );
    assertEqual(edits, 0);
  }
});

test("merged continuation preserves its completed grooming endpoint when a PR opens at final proof", async () => {
  const state = mergedContinuationFixture();
  let openBranchProofs = 0;
  await assertRejects(
    () =>
      releaseWithTestLock(
        mergedContinuationOptions(),
        mergedContinuationDependencies(state, {
          listOpenPullRequestsForBranch: async () => {
            openBranchProofs += 1;
            return openBranchProofs < 5 ? [] : [{ number: 2081 }];
          },
        }),
      ),
    /branch feat\/rank-backlog-skill has open PR #2081/,
  );
  assertEqual(openBranchProofs, 5);
  assertDeepEqual(state.issue.labels, [{ name: "needs-grooming" }]);
  assertDeepEqual(state.ownership, {
    claimId: null,
    agent: null,
    branch: null,
    claimedAt: null,
    pr: null,
  });
});

test("a replacement PR race restores the exact stored review snapshot", async () => {
  const originalOwnership = {
    claimId: "claim-2207",
    agent: "codex",
    branch: "fix/2207",
    claimedAt: "2026-08-28",
    pr: 2208,
  };
  const state = {
    issue: {
      id: "issue-2207",
      number: 2207,
      title: "replacement PR",
      state: "OPEN",
      labels: [{ name: "in-pr" }],
    },
    ownership: { ...originalOwnership },
  };
  let openReads = 0;
  await assertRejects(
    () =>
      releaseWithTestLock(
        {
          repo: "mento-protocol/monitoring-monorepo",
          projectOwner: "mento-protocol",
          projectNumber: 12,
          issues: [2207],
          agent: "codex",
          claimId: "claim-2207",
          releaseState: "ready",
          closedUnmergedPr: true,
          dryRun: false,
          comment: false,
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => state.issue,
          findIssueProjectItem: async () => "item-2207",
          readClaimOwnership: async () => state.ownership,
          getPullRequest: async () => ({
            number: 2208,
            state: "CLOSED",
            mergedAt: null,
            headRefName: "fix/2207",
            headRepository: {
              nameWithOwner: "mento-protocol/monitoring-monorepo",
            },
          }),
          listOpenPullRequestsForBranch: async () => {
            openReads += 1;
            return openReads < 3
              ? []
              : [
                  {
                    number: 2209,
                    headRefName: "fix/2207",
                  },
                ];
          },
          editIssueLabels: async (_options, issue, target) => {
            state.issue = {
              ...issue,
              labels: [{ name: target === "review" ? "in-pr" : "agent-ready" }],
            };
          },
          updateProjectMetadata: async (
            _options,
            _project,
            _item,
            _target,
            metadata,
          ) => {
            state.ownership = { ...state.ownership, ...metadata };
          },
        },
      ),
    /branch fix\/2207 has open PR #2209/,
  );
  assertDeepEqual(state.issue.labels, [{ name: "in-pr" }]);
  assertDeepEqual(state.ownership, originalOwnership);
});

test("general release refuses in-pr and missing durable Branch ownership", async () => {
  const reviewIssue = {
    id: "issue-2210",
    number: 2210,
    title: "still review",
    state: "OPEN",
    labels: [{ name: "in-pr" }],
  };
  await assertRejects(
    () =>
      releaseWithTestLock(
        {
          repo: "mento-protocol/monitoring-monorepo",
          issues: [2210],
          claimId: "claim-2210",
          releaseState: "ready",
          closedUnmergedPr: false,
          dryRun: false,
          comment: false,
          branch: "ambient-branch",
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => reviewIssue,
          findIssueProjectItem: async () => "item-2210",
          readClaimOwnership: async () => ({
            claimId: "claim-2210",
            agent: "codex",
            branch: "fix/2210",
            claimedAt: "2026-08-28",
            pr: 2211,
          }),
        },
      ),
    /not releasable; expected open agent-active/,
  );

  await assertRejects(
    () =>
      releaseWithTestLock(
        {
          repo: "mento-protocol/monitoring-monorepo",
          issues: [2212],
          claimId: "claim-2212",
          releaseState: "ready",
          closedUnmergedPr: false,
          dryRun: false,
          comment: false,
          branch: "ambient-branch",
        },
        {
          getProject: async () => ownershipProject(),
          getIssue: async () => ({
            id: "issue-2212",
            number: 2212,
            title: "missing branch",
            state: "OPEN",
            labels: [{ name: "agent-active" }],
          }),
          findIssueProjectItem: async () => "item-2212",
          readClaimOwnership: async () => ({
            claimId: "claim-2212",
            agent: "codex",
            branch: null,
            claimedAt: "2026-08-28",
            pr: null,
          }),
        },
      ),
    /missing Branch; release refuses ambient or local branch fallback/,
  );
});

test("matching owner can clear an exact needs-grooming claim quarantine", async () => {
  const state = {
    issue: {
      id: "issue-2213",
      number: 2213,
      title: "claim quarantine",
      state: "OPEN",
      labels: [{ name: "needs-grooming" }],
    },
    ownership: {
      claimId: "claim-2213",
      agent: "codex",
      branch: "fix/2213",
      claimedAt: "2026-08-28",
      pr: null,
    },
  };
  const [result] = await releaseWithTestLock(
    {
      repo: "mento-protocol/monitoring-monorepo",
      issues: [2213],
      agent: "codex",
      claimId: "claim-2213",
      releaseState: "grooming",
      closedUnmergedPr: false,
      dryRun: false,
      comment: false,
    },
    {
      getProject: async () => ownershipProject(),
      getIssue: async () => state.issue,
      findIssueProjectItem: async () => "item-2213",
      readClaimOwnership: async () => state.ownership,
      listOpenPullRequestsForBranch: async () => [],
      editIssueLabels: async (_options, current, target) => {
        assertEqual(target, "grooming");
        state.issue = { ...current, labels: [{ name: "needs-grooming" }] };
      },
      updateProjectMetadata: async (
        _options,
        _project,
        _item,
        target,
        metadata,
      ) => {
        assertEqual(target, "grooming");
        state.ownership = { ...state.ownership, ...metadata };
      },
    },
  );
  assertDeepEqual(result, {
    number: 2213,
    title: "claim quarantine",
    state: "grooming",
  });
  assertDeepEqual(state.ownership, {
    claimId: null,
    agent: null,
    branch: null,
    claimedAt: null,
    pr: null,
  });
});

test("lifecycle owner writers run only inside their executed mutex callbacks", async () => {
  const callbacks = [];
  const lockMetadata = new Map();
  const ownerWrites = [];
  let activeOperation = null;

  const withScopedLock = async (
    _options,
    issueNumber,
    metadata,
    mutation,
    overrides = {},
  ) => {
    const preparedMetadata = overrides.prepareMetadata
      ? await overrides.prepareMetadata(metadata)
      : metadata;
    assertEqual(activeOperation, null, "mutex callbacks must not overlap");
    activeOperation = preparedMetadata.operation;
    callbacks.push({ issueNumber, operation: preparedMetadata.operation });
    lockMetadata.set(preparedMetadata.operation, preparedMetadata);
    try {
      return await mutation({
        payload: preparedMetadata,
        markSafeToUnlock() {},
      });
    } finally {
      activeOperation = null;
    }
  };
  const scopedOwnerWriter =
    (operation, name, writer = async () => {}) =>
    async (...args) => {
      assert(
        activeOperation !== null,
        `${name} ran outside an active mutex callback`,
      );
      assertEqual(
        activeOperation,
        operation,
        `${name} ran in the wrong mutex callback`,
      );
      ownerWrites.push({ operation, name });
      return writer(...args);
    };
  const outsideScopeProbe = scopedOwnerWriter("probe", "scope probe");
  await assertRejects(
    () => outsideScopeProbe(),
    /scope probe ran outside an active mutex callback/,
  );

  const common = {
    repo: "mento-protocol/monitoring-monorepo",
    projectOwner: "mento-protocol",
    projectNumber: 12,
    agent: "codex",
    branch: "fix/2301",
    dryRun: false,
    comment: false,
  };

  let claimIssue = {
    id: "issue-2301",
    number: 2301,
    title: "claim",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  const claimOwnership = {
    claimId: null,
    agent: null,
    branch: null,
    claimedAt: null,
    pr: null,
  };
  await claim(
    {
      ...common,
      issues: [2301],
      claimId: "claim-2301",
      sweepEligible: false,
      pr: null,
    },
    {
      getProject: async () => ownershipProject(),
      getIssue: async () => ({
        ...claimIssue,
        labels: [...claimIssue.labels],
      }),
      findIssueProjectItem: async () => "item-2301",
      ensureProjectItem: async () => {
        assertEqual(activeOperation, "claim");
        return "item-2301";
      },
      readClaimOwnership: async () => ({ ...claimOwnership }),
      reserveClaimOwnership: scopedOwnerWriter(
        "claim",
        "reserveClaimOwnership",
        async (_options, _project, _itemId, _issue, metadata) => {
          claimOwnership.claimId = metadata.claimId;
        },
      ),
      updateProjectMetadata: scopedOwnerWriter(
        "claim",
        "updateProjectMetadata",
        async (_options, _project, _itemId, _state, metadata) => {
          for (const [field, value] of Object.entries(metadata)) {
            claimOwnership[field] =
              field === "claimedAt" ? projectDateFieldValue(value) : value;
          }
        },
      ),
      verifyClaimOwnership: async (
        _options,
        _project,
        _itemId,
        _issue,
        metadata,
      ) => {
        assertEqual(activeOperation, "claim");
        assertDeepEqual(claimOwnership, {
          claimId: metadata.claimId,
          agent: metadata.agent,
          branch: metadata.branch,
          claimedAt: projectDateFieldValue(metadata.claimedAt),
          pr: null,
        });
      },
      editIssueLabels: async (_options, issue, state) => {
        assertEqual(activeOperation, "claim");
        assertEqual(state, "active");
        claimIssue = {
          ...issue,
          labels: labelsForState(state).addLabels.map((name) => ({ name })),
        };
      },
      commentOnIssue: async () => {
        assertEqual(activeOperation, "claim");
      },
      sleep: async () => {},
      now: () => new Date("2026-08-29T10:00:00.000Z"),
      withIssueMutationLock: withScopedLock,
    },
  );

  let reviewIssue = {
    id: "issue-2302",
    number: 2302,
    title: "review",
    state: "OPEN",
    labels: [{ name: "agent-active" }],
  };
  const reviewOwnership = {
    claimId: "claim-2302",
    agent: "codex",
    branch: "fix/2302",
    claimedAt: "2026-08-28",
    pr: null,
  };
  await review(
    { ...common, branch: "fix/2302", issues: [2302], pr: 2303 },
    {
      getProject: async () => ownershipProject(),
      getIssue: async () => ({
        ...reviewIssue,
        labels: [...reviewIssue.labels],
      }),
      getPullRequest: async () => ({
        state: "OPEN",
        headRefName: "fix/2302",
        headRepository: {
          nameWithOwner: "mento-protocol/monitoring-monorepo",
        },
      }),
      findIssueProjectItem: async () => "item-2302",
      readClaimOwnership: async () => ({ ...reviewOwnership }),
      updateProjectMetadata: scopedOwnerWriter(
        "review",
        "updateProjectMetadata",
        async (_options, _project, _itemId, _state, metadata) => {
          Object.assign(reviewOwnership, metadata);
        },
      ),
      editIssueLabels: async (_options, issue, state) => {
        assertEqual(activeOperation, "review");
        assertEqual(state, "review");
        reviewIssue = {
          ...issue,
          labels: labelsForState(state).addLabels.map((name) => ({ name })),
        };
      },
      commentOnIssue: async () => {
        assertEqual(activeOperation, "review");
      },
      withIssueMutationLock: withScopedLock,
    },
  );

  let releaseIssue = {
    id: "issue-2304",
    number: 2304,
    title: "release",
    state: "OPEN",
    labels: [{ name: "agent-active" }],
  };
  const releaseOwnership = {
    claimId: "claim-2304",
    agent: "codex",
    branch: "fix/2304",
    claimedAt: "2026-08-28",
    pr: null,
  };
  await release(
    {
      ...common,
      issues: [2304],
      claimId: "claim-2304",
      releaseState: "ready",
      closedUnmergedPr: false,
    },
    {
      getProject: async () => ownershipProject(),
      getIssue: async () => ({
        ...releaseIssue,
        labels: [...releaseIssue.labels],
      }),
      findIssueProjectItem: async () => "item-2304",
      readClaimOwnership: async () => ({ ...releaseOwnership }),
      listOpenPullRequestsForBranch: async () => [],
      updateProjectMetadata: scopedOwnerWriter(
        "release",
        "updateProjectMetadata",
        async (_options, _project, _itemId, _state, metadata) => {
          Object.assign(releaseOwnership, metadata);
        },
      ),
      editIssueLabels: async (_options, issue, state) => {
        assertEqual(activeOperation, "release");
        assertEqual(state, "ready");
        releaseIssue = {
          ...issue,
          labels: labelsForState(state).addLabels.map((name) => ({ name })),
        };
      },
      commentOnIssue: async () => {
        assertEqual(activeOperation, "release");
      },
      withIssueMutationLock: withScopedLock,
    },
  );

  const backfillDependencies = backfillFakes({
    issue: {
      id: "issue-2306",
      number: 2306,
      title: "backfill",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    comments: [
      trustedComment({
        issue: 2306,
        claimId: "claim-2306",
        branch: "fix/2306",
      }),
    ],
  });
  const backfillWriter = backfillDependencies.writeBackfillProjectFields;
  backfillDependencies.writeBackfillProjectFields = scopedOwnerWriter(
    "backfill",
    "writeBackfillProjectFields",
    backfillWriter,
  );
  backfillDependencies.readClaimOwnership = async () => ({
    claimId: backfillDependencies.state.values["Claim ID"],
    agent: backfillDependencies.state.values.Agent,
    branch: backfillDependencies.state.values.Branch,
    claimedAt: backfillDependencies.state.values["Claimed At"],
    pr: null,
  });
  await backfill(
    { ...common, issues: [2306] },
    {
      ...backfillDependencies,
      withIssueMutationLock: withScopedLock,
    },
  );

  const syncIssue = {
    id: "issue-2305",
    number: 2305,
    title: "sync",
    state: "OPEN",
    labels: [{ name: "agent-active" }],
  };
  let syncMembershipWrites = 0;
  const unexpectedSyncWriter = (name) =>
    scopedOwnerWriter("sync", name, async () => {
      throw new Error(`sync called owner writer ${name}`);
    });
  await sync(common, {
    getProject: async () => ownershipProject(),
    listIssuesByLabels: async () => [syncIssue],
    getIssue: async () => ({ ...syncIssue, labels: [...syncIssue.labels] }),
    findIssueProjectItem: async () => null,
    readIssueLockOwnership: async () => null,
    ensureProjectItem: async () => {
      assertEqual(activeOperation, "sync");
      syncMembershipWrites += 1;
      return "item-2305";
    },
    reserveClaimOwnership: unexpectedSyncWriter("reserveClaimOwnership"),
    updateProjectMetadata: unexpectedSyncWriter("updateProjectMetadata"),
    updateTextField: unexpectedSyncWriter("updateTextField"),
    writeBackfillProjectFields: unexpectedSyncWriter(
      "writeBackfillProjectFields",
    ),
    writeProjectOwnershipMetadata: unexpectedSyncWriter(
      "writeProjectOwnershipMetadata",
    ),
    withIssueMutationLock: withScopedLock,
  });

  assertDeepEqual(callbacks, [
    { issueNumber: 2301, operation: "claim" },
    { issueNumber: 2302, operation: "review" },
    { issueNumber: 2304, operation: "release" },
    { issueNumber: 2306, operation: "backfill" },
    { issueNumber: 2305, operation: "sync" },
  ]);
  assertEqual(lockMetadata.get("review").claimId, "claim-2302");
  assertEqual(lockMetadata.get("review").branch, "fix/2302");
  assertEqual(lockMetadata.get("review").claimedAt, "2026-08-28");
  assertEqual(lockMetadata.get("sync").claimId, null);
  assertEqual(syncMembershipWrites, 1);
  for (const operation of ["claim", "review", "release", "backfill"]) {
    assert(
      ownerWrites.some((write) => write.operation === operation),
      `${operation} callback did not execute an owner writer`,
    );
  }
  assertEqual(
    ownerWrites.some((write) => write.operation === "sync"),
    false,
  );
  await assertRejects(
    () => outsideScopeProbe(),
    /scope probe ran outside an active mutex callback/,
  );
});

test("all repository runtime surfaces confine Project owner mutations", () => {
  const inventory = repositoryRuntimeProgram();
  const report = ownerMutationConfinementReport(inventory);
  assert(
    report.modulePaths.includes(OWNER_MUTATION_EXECUTOR_PATH),
    "runtime inventory omitted the guarded Project owner-mutation executor",
  );
  assertDeepEqual(report.violations, []);
  assert(
    report.calls.length > 0,
    "runtime inventory found no static Project owner-mutation call",
  );
  assert(
    report.executableText.length > 0,
    "runtime inventory found no executable Project owner-mutation text",
  );
  assert(
    report.repositoryTextOccurrences.length > 0,
    "repository text inventory found no Project owner-mutation text",
  );
  assertDeepEqual(
    [...new Set(report.repositoryTextOccurrences.map(({ path }) => path))],
    [...OWNER_MUTATION_TEXT_PATHS].sort(),
  );
  assert(
    report.symlinkTargets.length > 0,
    "repository fixture must exercise contained symlink validation",
  );
  for (const [path, target] of report.symlinkTargets) {
    assert(
      report.repositoryTextPaths.includes(target),
      `${path} omitted its inventoried regular target ${target}`,
    );
  }
  assert(
    report.modulePaths.includes(
      "indexer-envio/src/rpc/http-test-mock-bridge.ts",
    ),
    "runtime inventory omitted the production-reachable HTTP test mock bridge",
  );
  assertDeepEqual(
    [...new Set(report.calls.flatMap((call) => call.fields))].sort(),
    OWNER_MUTATION_NAMES,
  );
  const testTransportReferences = ownerProofTestTransportReferences(inventory);
  assert(
    testTransportReferences.length > 0,
    "runtime inventory found no owner-proof test transport reference",
  );
  assertDeepEqual(ownerProofTestTransportViolations(inventory), []);
  assertDeepEqual(
    [...new Set(testTransportReferences.map(({ path }) => path))].sort(),
    [...OWNER_PROOF_TEST_TRANSPORT_REFERENCE_PATHS].sort(),
  );
  const testTransportCallPaths = [];
  for (const [, sourceFile] of inventory.sourceFiles) {
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        symbolComesFrom(
          inventory,
          node.expression,
          OWNER_PROOF_TEST_TRANSPORT_MODULE_PATH,
          OWNER_PROOF_TEST_TRANSPORT_NAME,
        )
      ) {
        testTransportCallPaths.push(nodeLocation(inventory, node).path);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  assertDeepEqual(testTransportCallPaths, [
    "scripts/pr/agent-issue-board.test.mjs",
  ]);
});

test("owner-proof test transport confinement rejects aliases and re-exports", () => {
  const moduleSpecifier = "../scripts/pr/issue-board-lock.mjs";
  for (const [expectedPath, files] of [
    [
      "src/renamed-import.mjs",
      {
        "src/renamed-import.mjs": `
          import { ${OWNER_PROOF_TEST_TRANSPORT_NAME} as factory }
            from ${JSON.stringify(moduleSpecifier)};
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/renamed-query-import.mjs",
      {
        "src/renamed-query-import.mjs": `
          import { ${OWNER_PROOF_TEST_TRANSPORT_NAME} as factory }
            from ${JSON.stringify(`${moduleSpecifier}?transport=test#factory`)};
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/local-alias.mjs",
      {
        "src/local-alias.mjs": `
          import { ${OWNER_PROOF_TEST_TRANSPORT_NAME} } from ${JSON.stringify(moduleSpecifier)};
          const first = ${OWNER_PROOF_TEST_TRANSPORT_NAME};
          const second = first;
          second({}, async () => ({}));
        `,
      },
    ],
    [
      "src/namespace-alias.mjs",
      {
        "src/namespace-alias.mjs": `
          import * as ownerProof from ${JSON.stringify(moduleSpecifier)};
          const factory = ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME};
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/destructured-alias.mjs",
      {
        "src/destructured-alias.mjs": `
          import * as ownerProof from ${JSON.stringify(moduleSpecifier)};
          const { ${OWNER_PROOF_TEST_TRANSPORT_NAME}: factory } = ownerProof;
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/computed-namespace.mjs",
      {
        "src/computed-namespace.mjs": `
          import * as ownerProof from ${JSON.stringify(moduleSpecifier)};
          const factory = ownerProof[${JSON.stringify(OWNER_PROOF_TEST_TRANSPORT_NAME)}];
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/dynamic-namespace.mjs",
      {
        "src/dynamic-namespace.mjs": `
          const ownerProof = await import(${JSON.stringify(moduleSpecifier)});
          const factory = ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME};
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/dynamic-const.mjs",
      {
        "src/dynamic-const.mjs": `
          const modulePath = ${JSON.stringify(moduleSpecifier)};
          const ownerProof = await import(modulePath);
          const factory = Object.values(ownerProof).find(
            (value) => typeof value === "function",
          );
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/dynamic-concat.mjs",
      {
        "src/dynamic-concat.mjs": `
          const root = "../scripts/";
          const file = "pr/issue-board-" + "lock.mjs";
          const ownerProof = await import(root + file);
          ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
        `,
      },
    ],
    [
      "src/dynamic-template.mjs",
      {
        "src/dynamic-template.mjs": `
          const directory = "../scripts/pr";
          const stem = "issue-board-lock";
          const ownerProof = await import(\`${"${directory}"}/${"${stem}"}.mjs\`);
          ownerProof[${JSON.stringify(OWNER_PROOF_TEST_TRANSPORT_NAME)}](
            {},
            async () => ({}),
          );
        `,
      },
    ],
    [
      "src/dynamic-query-hash.mjs",
      {
        "src/dynamic-query-hash.mjs": `
          const ownerProof = await import(
            ${JSON.stringify(`${moduleSpecifier}?transport=test#factory`)}
          );
          const factory = Object.values(ownerProof).find(
            (value) => typeof value === "function",
          );
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/dynamic-percent-encoded.mjs",
      {
        "src/dynamic-percent-encoded.mjs": `
          const modulePath = "../scripts/pr/issue-board-%6c%6f%63%6b.mjs";
          const ownerProof = await import(modulePath);
          ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
        `,
      },
    ],
    [
      "src/dynamic-url-backslashes.mjs",
      {
        "src/dynamic-url-backslashes.mjs": `
          const modulePath = "../scripts/pr\\\\issue-board-lock.mjs";
          const ownerProof = await import(modulePath);
          const factory = Reflect.get(
            ownerProof,
            ${JSON.stringify(OWNER_PROOF_TEST_TRANSPORT_NAME)},
          );
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/dynamic-url.mjs",
      {
        "src/dynamic-url.mjs": `
          const modulePath = ${JSON.stringify(moduleSpecifier)};
          const ownerProof = await import(
            new URL(modulePath, import.meta.url)
          );
          ownerProof[${JSON.stringify(OWNER_PROOF_TEST_TRANSPORT_NAME)}](
            {},
            async () => ({}),
          );
        `,
      },
    ],
    [
      "src/dynamic-bound-url.mjs",
      {
        "src/dynamic-bound-url.mjs": `
          const moduleUrl = new URL(
            ${JSON.stringify(moduleSpecifier)},
            import.meta.url,
          );
          const ownerProof = await import(moduleUrl);
          const factory = Reflect.get(
            ownerProof,
            ${JSON.stringify(OWNER_PROOF_TEST_TRANSPORT_NAME)},
          );
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/dynamic-url-href.mjs",
      {
        "src/dynamic-url-href.mjs": `
          const root = "../scripts/pr/";
          const moduleUrl = new URL(
            root + "issue-board-lock.mjs?transport=test",
            import.meta.url,
          );
          const ownerProof = await import(moduleUrl.href);
          const factory = Object.values(ownerProof).find(
            (value) => typeof value === "function",
          );
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/dynamic-url-pathname.mjs",
      {
        "src/dynamic-url-pathname.mjs": `
          const moduleUrl = new URL(
            ${JSON.stringify(`${moduleSpecifier}#factory`)},
            import.meta.url,
          );
          const ownerProof = await import(moduleUrl.pathname);
          ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
        `,
      },
    ],
    [
      "src/dynamic-bound-url-base.mjs",
      {
        "src/dynamic-bound-url-base.mjs": `
          const baseUrl = import.meta.url;
          const moduleUrl = new URL(
            ${JSON.stringify(moduleSpecifier)},
            baseUrl,
          );
          const property = "href";
          const ownerProof = await import(moduleUrl[property]);
          ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
        `,
      },
    ],
    [
      "scripts/pr/dynamic-mixed-separator.mjs",
      {
        "scripts/pr/dynamic-mixed-separator.mjs": `
          const modulePath = "./\\\\issue-board-lock.mjs";
          const ownerProof = await import(modulePath);
          ownerProof[${JSON.stringify(OWNER_PROOF_TEST_TRANSPORT_NAME)}](
            {},
            async () => ({}),
          );
        `,
      },
    ],
    [
      "src/re-export.mjs",
      {
        "src/re-export.mjs": `
          export { ${OWNER_PROOF_TEST_TRANSPORT_NAME} as forgedOwnerProofOperations }
            from ${JSON.stringify(moduleSpecifier)};
        `,
        "src/re-export-user.mjs": `
          import { forgedOwnerProofOperations } from "./re-export.mjs";
          forgedOwnerProofOperations({}, async () => ({}));
        `,
      },
    ],
    [
      "src/percent-encoded-re-export.mjs",
      {
        "src/percent-encoded-re-export.mjs": `
          export { ${OWNER_PROOF_TEST_TRANSPORT_NAME} as forgedOwnerProofOperations }
            from "../scripts/pr/issue-board-%6c%6f%63%6b.mjs";
        `,
      },
    ],
    [
      OWNER_PROOF_TEST_TRANSPORT_MODULE_PATH,
      {
        [OWNER_PROOF_TEST_TRANSPORT_MODULE_PATH]: `
          export function ${OWNER_PROOF_TEST_TRANSPORT_NAME}() { return {}; }
          const sameModuleAlias = ${OWNER_PROOF_TEST_TRANSPORT_NAME};
          sameModuleAlias({}, async () => ({}));
        `,
      },
    ],
    [
      "src/wildcard-re-export.mjs",
      {
        "src/wildcard-re-export.mjs": `export * from ${JSON.stringify(moduleSpecifier)};`,
      },
    ],
    [
      "src/namespace-re-export.mjs",
      {
        "src/namespace-re-export.mjs": `export * as ownerProof from ${JSON.stringify(moduleSpecifier)};`,
      },
    ],
    [
      "src/namespace-reflection.mjs",
      {
        "src/namespace-reflection.mjs": `
          import * as ownerProof from ${JSON.stringify(moduleSpecifier)};
          const factory = Object.values(ownerProof).find(
            (value) => typeof value === "function",
          );
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/commonjs-reflection.cjs",
      {
        "src/commonjs-reflection.cjs": `
          const ownerProof = require(${JSON.stringify(moduleSpecifier)});
          const factory = Object.values(ownerProof).find(
            (value) => typeof value === "function",
          );
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/commonjs-const.cjs",
      {
        "src/commonjs-const.cjs": `
          const modulePath = ${JSON.stringify(moduleSpecifier)};
          const ownerProof = require(modulePath);
          ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
        `,
      },
    ],
    [
      "src/commonjs-parenthesized-require.cjs",
      {
        "src/commonjs-parenthesized-require.cjs": `
          const modulePath = ${JSON.stringify(moduleSpecifier)};
          const ownerProof = ((require))(modulePath);
          const factory = Object.values(ownerProof).find(
            (value) => typeof value === "function",
          );
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/commonjs-constructed-require.cjs",
      {
        "src/commonjs-constructed-require.cjs": `
          const modulePath = ${JSON.stringify(moduleSpecifier)};
          const ownerProof = new (require)(modulePath);
          ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
        `,
      },
    ],
    [
      "src/commonjs-comma-require.cjs",
      {
        "src/commonjs-comma-require.cjs": `
          const modulePath = ${JSON.stringify(moduleSpecifier)};
          const ownerProof = (0, require)(modulePath);
          const factory = Reflect.get(
            ownerProof,
            ${JSON.stringify(OWNER_PROOF_TEST_TRANSPORT_NAME)},
          );
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/commonjs-concat.cjs",
      {
        "src/commonjs-concat.cjs": `
          const root = "../scripts/";
          const file = "pr/issue-board-" + "lock.mjs";
          const ownerProof = require(root + file);
          const factory = Object.values(ownerProof).find(
            (value) => typeof value === "function",
          );
          factory({}, async () => ({}));
        `,
      },
    ],
    [
      "src/commonjs-template.cjs",
      {
        "src/commonjs-template.cjs": `
          const directory = "../scripts/pr";
          const stem = "issue-board-lock";
          const ownerProof = require(\`${"${directory}"}/${"${stem}"}.mjs\`);
          ownerProof[${JSON.stringify(OWNER_PROOF_TEST_TRANSPORT_NAME)}](
            {},
            async () => ({}),
          );
        `,
      },
    ],
    [
      "src/commonjs-package-main.cjs",
      {
        "src/commonjs-package-main.cjs": `
          const packagePath = "./transport";
          const ownerProof = require(packagePath);
          const factory = Object.values(ownerProof).find(
            (value) => typeof value === "function",
          );
          factory({}, async () => ({}));
        `,
        "src/transport/package.json": JSON.stringify({
          main: "../../scripts/pr/issue-board-lock.mjs",
        }),
      },
    ],
    [
      "src/transport/dot-package-main.cjs",
      {
        "src/transport/dot-package-main.cjs": `
          const packagePath = ".";
          const ownerProof = require(packagePath);
          ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
        `,
        "src/transport/package.json": JSON.stringify({
          main: "../../scripts/pr/issue-board-lock.mjs",
        }),
        "src/transport.js": "module.exports = { safe: true };",
      },
    ],
    [
      "src/transport/nested/dot-dot-package-main.cjs",
      {
        "src/transport/nested/dot-dot-package-main.cjs": `
          const packagePath = "..";
          const ownerProof = require(packagePath);
          const factory = Reflect.get(
            ownerProof,
            ${JSON.stringify(OWNER_PROOF_TEST_TRANSPORT_NAME)},
          );
          factory({}, async () => ({}));
        `,
        "src/transport/package.json": JSON.stringify({
          main: "../../scripts/pr/issue-board-lock.mjs",
        }),
        "src/transport.js": "module.exports = { safe: true };",
      },
    ],
    [
      "src/commonjs-trailing-directory.cjs",
      {
        "src/commonjs-trailing-directory.cjs": `
          const packagePath = "./transport/";
          const ownerProof = require(packagePath);
          ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
        `,
        "src/transport/package.json": JSON.stringify({
          main: "../../scripts/pr/issue-board-lock.mjs",
        }),
        "src/transport.js": "module.exports = { safe: true };",
      },
    ],
    [
      "src/commonjs-extension-probe.cjs",
      {
        "src/commonjs-extension-probe.cjs": `
          const modulePath = "./transport.stub";
          const ownerProof = require(modulePath);
          ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
        `,
        "src/transport.stub.js": {
          symlink: "../scripts/pr/issue-board-lock.mjs",
        },
      },
    ],
  ]) {
    assertOwnerProofTestTransportCanary(files, expectedPath);
  }
});

test("owner-proof path confinement ignores non-loadable URL lookalikes", () => {
  const moduleSpecifier = "../scripts/pr/issue-board-lock.mjs";
  const inventory = runtimeInventoryForFiles({
    [OWNER_PROOF_TEST_TRANSPORT_MODULE_PATH]: `export function ${OWNER_PROOF_TEST_TRANSPORT_NAME}() { return {}; }`,
    "src/string-property.mjs": `
      const modulePath = ${JSON.stringify(moduleSpecifier)};
      const ownerProof = await import(modulePath.href);
      ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
    `,
    "src/commonjs-query.cjs": `
      const ownerProof = require(${JSON.stringify(`${moduleSpecifier}?factory`)});
      ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
    `,
    "src/commonjs-percent.cjs": `
      const ownerProof = require("../scripts/pr/issue-board-%6c%6f%63%6b.mjs");
      ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
    `,
    "src/esm-extensionless.mjs": `
      const ownerProof = await import("../scripts/pr/issue-board-lock");
      ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
    `,
    "src/commonjs-extensionless.cjs": `
      const ownerProof = require("../scripts/pr/issue-board-lock");
      ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
    `,
    "src/commonjs-url.mjs": `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const ownerProof = require(
        new URL(${JSON.stringify(moduleSpecifier)}, import.meta.url)
      );
      ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
    `,
    "src/commonjs-file-precedence.cjs": `
      const modulePath = "./safe.stub";
      const ownerProof = require(modulePath);
      ownerProof.${OWNER_PROOF_TEST_TRANSPORT_NAME}({}, async () => ({}));
    `,
    "src/safe.stub": "module.exports = {};",
    "src/safe.stub.js": {
      symlink: "../scripts/pr/issue-board-lock.mjs",
    },
  });
  assertDeepEqual(ownerProofTestTransportViolations(inventory), []);
});

const CANARY_UPDATE_MUTATION = `mutation OwnerMutation(
  $input: UpdateProjectV2ItemFieldValueInput!
) {
  ${UPDATE_OWNER_MUTATION_NAME}(input: $input) {
    projectV2Item { id }
  }
}`;

test("owner mutation proof resolves bound and concatenated static templates", () => {
  const report = assertConfinementCanary(
    {
      "src/bound.ts": `
        const first = "updateProject";
        const second = "V2ItemFieldValue";
        const operation = first + second;
        const document = (\`mutation OwnerMutation(
          $input: UpdateProjectV2ItemFieldValueInput!
        ) {
          \${operation}(input: $input) { projectV2Item { id } }
        }\` as const);
        execute((document));
      `,
    },
    "src/bound.ts",
    "outside its exact guarded executor",
  );
  assertDeepEqual(report.calls[0].fields, [UPDATE_OWNER_MUTATION_NAME]);
});

test("owner mutation proof resolves imported static documents", () => {
  const report = assertConfinementCanary(
    {
      "src/caller.mjs": `
        import { ownerMutation as document } from "./document.mjs";
        execute(document);
      `,
      "src/document.mjs": `
        export const ownerMutation = ${JSON.stringify(CANARY_UPDATE_MUTATION)};
      `,
    },
    "src/caller.mjs",
    "outside its exact guarded executor",
  );
  assertDeepEqual(report.calls[0].fields, [UPDATE_OWNER_MUTATION_NAME]);
});

test("owner mutation proof follows GraphQL fragments and inline fragments", () => {
  const report = assertConfinementCanary(
    {
      "src/fragment.mjs": `
        execute(\`mutation OwnerMutation(
          $input: UpdateProjectV2ItemFieldValueInput!
        ) {
          ...OwnerMutationFields
        }
        fragment OwnerMutationFields on Mutation {
          ... on Mutation {
            ${UPDATE_OWNER_MUTATION_NAME}(input: $input) {
              projectV2Item { id }
            }
          }
        }\`);
      `,
    },
    "src/fragment.mjs",
    "outside its exact guarded executor",
  );
  assertDeepEqual(report.calls[0].fields, [UPDATE_OWNER_MUTATION_NAME]);
});

test("owner mutation proof rejects inline mutation calls", () => {
  const report = assertConfinementCanary(
    {
      "src/inline.mjs": `execute(${JSON.stringify(CANARY_UPDATE_MUTATION)});`,
    },
    "src/inline.mjs",
    "outside its exact guarded executor",
  );
  assertDeepEqual(report.calls[0].fields, [UPDATE_OWNER_MUTATION_NAME]);
});

test("owner mutation proof rejects a shadow capability executor", () => {
  assertConfinementCanary(
    {
      [OWNER_MUTATION_EXECUTOR_PATH]: `
        function executeIssueOwnerMutation() {
          return {};
        }
        function ownerMutationBinding() {
          return {};
        }
        function updateTextField(
          capability,
          options,
          project,
          itemId,
          fieldId,
          text,
          { graphql } = {},
        ) {
          return executeIssueOwnerMutation(
            capability,
            ownerMutationBinding(),
            ${JSON.stringify(CANARY_UPDATE_MUTATION)},
            { graphql, value: text },
          );
        }
      `,
    },
    OWNER_MUTATION_EXECUTOR_PATH,
    "outside its exact guarded executor",
  );
});

test("owner mutation proof scans dist generated and vendored runtime modules", () => {
  for (const path of [
    "dist/escape.mjs",
    "generated/escape.mjs",
    "vendor/escape.mjs",
  ]) {
    const report = assertConfinementCanary(
      { [path]: `execute(${JSON.stringify(CANARY_UPDATE_MUTATION)});` },
      path,
      "outside its exact guarded executor",
    );
    assert(
      report.modulePaths.includes(path),
      `runtime inventory omitted ${path}`,
    );
  }
});

test("owner mutation proof compiler-scans every JS and TS module", () => {
  const files = {
    "src/runtime.ts": `import "./reachable.test.ts";`,
    "src/reachable.test.ts": `export { reachable } from "./tests/reachable.spec.ts";`,
    "src/tests/reachable.spec.ts": `
      export const reachable = import("../__mocks__/reachable.mock.ts");
    `,
    "src/__mocks__/reachable.mock.ts": `
      require("../fixtures/reachable.fixture.ts");
    `,
    "src/fixtures/reachable.fixture.ts": `
      execute(${JSON.stringify(CANARY_UPDATE_MUTATION)});
    `,
    "src/unreferenced.test.ts": `
      execute(${JSON.stringify(CANARY_UPDATE_MUTATION)});
    `,
  };
  const report = assertConfinementCanary(
    files,
    "src/fixtures/reachable.fixture.ts",
    "outside its exact guarded executor",
  );
  for (const path of [
    "src/reachable.test.ts",
    "src/tests/reachable.spec.ts",
    "src/__mocks__/reachable.mock.ts",
    "src/fixtures/reachable.fixture.ts",
  ]) {
    assert(
      report.modulePaths.includes(path),
      `runtime inventory omitted import-reachable ${path}`,
    );
  }
  assert(
    report.modulePaths.includes("src/unreferenced.test.ts"),
    "compiler inventory omitted an unreferenced standalone test module",
  );
  assert(
    report.violations.some(
      (violation) =>
        violation.includes("src/unreferenced.test.ts") &&
        violation.includes("outside its exact guarded executor"),
    ),
    "compiler inventory omitted an unreferenced standalone test module",
  );
});

test("owner mutation proof decodes escaped operations in command-invoked test modules", () => {
  const escapedOperation = UPDATE_OWNER_MUTATION_NAME.replace("F", "\\u0046");
  const escapedDocument = CANARY_UPDATE_MUTATION.replace(
    UPDATE_OWNER_MUTATION_NAME,
    escapedOperation,
  );
  const commandModule = `execute(\`${escapedDocument}\`);`;
  for (const entrypoint of [
    {
      "package.json": JSON.stringify({
        scripts: { escape: "node scripts/escape.test.mjs" },
      }),
    },
    {
      ".github/workflows/escape.yml": `name: escape
on: workflow_dispatch
jobs:
  escape:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/escape.test.mjs
`,
    },
  ]) {
    const report = assertConfinementCanary(
      {
        ...entrypoint,
        "scripts/escape.test.mjs": commandModule,
      },
      "scripts/escape.test.mjs",
      "outside its exact guarded executor",
    );
    assert(
      report.modulePaths.includes("scripts/escape.test.mjs"),
      "compiler inventory omitted the command-invoked test module",
    );
  }
});

test("owner mutation proof scans action main pre post dist entrypoints", () => {
  const report = assertConfinementCanary(
    {
      ".github/actions/escape/action.yml": `
        name: escape
        runs:
          using: node20
          main: dist/main.test.js
          pre: dist/pre.test.js
          post: dist/post.test.js
      `,
      ".github/actions/escape/dist/main.test.js": "export {};",
      ".github/actions/escape/dist/post.test.js": `execute(${JSON.stringify(
        CANARY_UPDATE_MUTATION,
      )});`,
      ".github/actions/escape/dist/pre.test.js": "export {};",
    },
    ".github/actions/escape/dist/post.test.js",
    "outside its exact guarded executor",
  );
  for (const phase of ["main", "pre", "post"]) {
    assert(
      report.modulePaths.includes(
        `.github/actions/escape/dist/${phase}.test.js`,
      ),
      `action ${phase} entrypoint was not a runtime module`,
    );
  }
});

test("owner mutation proof scans composite action and workflow run surfaces", () => {
  for (const [path, source] of [
    [
      ".github/actions/escape/action.yml",
      `name: escape
runs:
  using: composite
  steps:
    - shell: bash
      run: '${CANARY_UPDATE_MUTATION.replaceAll("'", "''")}'
`,
    ],
    [
      ".github/workflows/escape.yml",
      `name: escape
on: workflow_dispatch
jobs:
  escape:
    runs-on: ubuntu-latest
    steps:
      - run: '${CANARY_UPDATE_MUTATION.replaceAll("'", "''")}'
`,
    ],
  ]) {
    assertConfinementCanary({ [path]: source }, path, "contains executable");
  }
});

test("owner mutation proof scans shell scripts outside runtime imports", () => {
  const report = assertConfinementCanary(
    {
      "scripts/owner-write.sh": `#!/usr/bin/env bash
query='${CANARY_UPDATE_MUTATION.replaceAll("'", "'\\''")}'
`,
    },
    "scripts/owner-write.sh",
    "outside the exact repository allowlist",
  );
  assertEqual(report.modulePaths.includes("scripts/owner-write.sh"), false);
});

test("owner mutation proof scans package script commands", () => {
  const report = assertConfinementCanary(
    {
      "package.json": JSON.stringify({
        scripts: { escape: `echo ${OWNER_MUTATION_NAMES[0]}` },
      }),
    },
    "package.json",
    "outside the exact repository allowlist",
  );
  assertEqual(report.modulePaths.includes("package.json"), false);
});

test("owner mutation proof scans standalone runtime GraphQL documents", () => {
  for (const extension of ["graphql", "gql"]) {
    const path = `src/owner-write.${extension}`;
    const report = assertConfinementCanary(
      { [path]: CANARY_UPDATE_MUTATION },
      path,
      "outside the exact repository allowlist",
    );
    assertEqual(report.modulePaths.includes(path), false);
  }
});

test("owner mutation proof scans generic and extensionless text surfaces", () => {
  for (const path of ["config/owner-write.toml", "bin/owner-write"]) {
    const report = assertConfinementCanary(
      { [path]: `operation = ${JSON.stringify(UPDATE_OWNER_MUTATION_NAME)}` },
      path,
      "outside the exact repository allowlist",
    );
    assertEqual(report.modulePaths.includes(path), false);
  }
});

test("owner mutation proof rejects a runtime-module symlink that escapes the repository", () => {
  assertThrows(
    () =>
      confinementReportForFiles({
        "src/owner-write.mjs": { symlink: "../../external-owner-write.mjs" },
      }),
    /src\/owner-write\.mjs symlink target escapes the repository/,
  );
});

test("repository path inventory rejects invalid UTF-8 before file lookup", () => {
  const invalidTrackedPath = Buffer.concat([
    Buffer.from("scripts/invalid-", "utf8"),
    Buffer.from([0x80, 0]),
  ]);
  assertThrows(
    () => decodeRepositoryPathList(invalidTrackedPath),
    /path inventory contains invalid UTF-8/,
  );
  assertDeepEqual(
    decodeRepositoryPathList(
      Buffer.from("scripts/valid-ümlaut.mjs\0docs/valid.md\0", "utf8"),
    ),
    ["scripts/valid-ümlaut.mjs", "docs/valid.md"],
  );
});

test("owner mutation proof rejects invalid UTF-8 symlink targets before decoy lookup", () => {
  const invalidTarget = Buffer.concat([
    Buffer.from("owner-proof-", "utf8"),
    Buffer.from([0xff]),
    Buffer.from(".mjs", "utf8"),
  ]);
  assertThrows(
    () =>
      confinementReportForFiles({
        "package.json": JSON.stringify({
          scripts: { proof: "./bin/owner-proof" },
        }),
        "bin/owner-proof": { symlink: invalidTarget },
        "bin/owner-proof-\uFFFD.mjs": "export {};",
      }),
    /bin\/owner-proof symlink target contains invalid UTF-8/,
  );
});

test("owner mutation proof rejects byte-changing symlink decoding before decoy lookup", () => {
  const bomTarget = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("owner-proof-target.mjs", "utf8"),
  ]);
  assertThrows(
    () =>
      confinementReportForFiles({
        "bin/owner-proof": { symlink: bomTarget },
        "bin/owner-proof-target.mjs": "export {};",
      }),
    /bin\/owner-proof symlink target changed bytes during UTF-8 decoding/,
  );
});

test("owner mutation proof accepts an exact Unicode symlink target", () => {
  const inventory = runtimeInventoryForFiles({
    "bin/owner-proof": { symlink: "owner-proof-\uFFFD.mjs" },
    "bin/owner-proof-\uFFFD.mjs": "export {};",
  });
  assertDeepEqual(
    [...inventory.symlinkTargets],
    [["bin/owner-proof", "bin/owner-proof-\uFFFD.mjs"]],
  );
});

test("owner mutation proof scans a contained runtime symlink target in both lanes", () => {
  const report = assertConfinementCanary(
    {
      "src/owner-write-alias.mjs": { symlink: "owner-write-target.mjs" },
      "src/owner-write-target.mjs": `execute(${JSON.stringify(
        CANARY_UPDATE_MUTATION,
      )});`,
    },
    "src/owner-write-target.mjs",
    "outside its exact guarded executor",
  );
  assertDeepEqual(report.symlinkTargets, [
    ["src/owner-write-alias.mjs", "src/owner-write-target.mjs"],
  ]);
  assert(report.modulePaths.includes("src/owner-write-target.mjs"));
  assert(
    report.repositoryTextOccurrences.some(
      ({ path }) => path === "src/owner-write-target.mjs",
    ),
    "raw inventory omitted the contained runtime symlink target",
  );
});

test("owner mutation proof rejects noninventoried extensionless command symlinks", () => {
  for (const entrypoint of [
    {
      ".github/workflows/owner-write.yml": `name: owner-write
on: workflow_dispatch
jobs:
  owner-write:
    runs-on: ubuntu-latest
    steps:
      - run: ./bin/owner-write
`,
    },
    {
      "package.json": JSON.stringify({
        scripts: { escape: "./bin/owner-write" },
      }),
    },
  ]) {
    assertThrows(
      () =>
        confinementReportForFiles({
          ...entrypoint,
          "bin/owner-write": { symlink: "../hidden/owner-write" },
        }),
      /bin\/owner-write symlink target is not an inventoried file/,
    );
  }
});

test("owner mutation proof rejects unguarded text in the executor", () => {
  assertConfinementCanary(
    {
      [OWNER_MUTATION_EXECUTOR_PATH]: `// ${UPDATE_OWNER_MUTATION_NAME}\n`,
    },
    OWNER_MUTATION_EXECUTOR_PATH,
    "outside the exact repository allowlist",
  );
});

test("owner mutation proof requires exact unique ADR occurrences", () => {
  const updateLine = OWNER_MUTATION_ADR_LINES.get(UPDATE_OWNER_MUTATION_NAME);
  const clearLine = OWNER_MUTATION_ADR_LINES.get(CLEAR_OWNER_MUTATION_NAME);
  assertConfinementCanary(
    {
      [OWNER_MUTATION_ADR_PATH]: `${updateLine}\n${updateLine}\n${clearLine}\n`,
    },
    OWNER_MUTATION_ADR_PATH,
    `must contain exactly 1 reviewed ${UPDATE_OWNER_MUTATION_NAME}`,
  );
  assertConfinementCanary(
    {
      [OWNER_MUTATION_ADR_PATH]: `Changed ${UPDATE_OWNER_MUTATION_NAME}\n${clearLine}\n`,
    },
    OWNER_MUTATION_ADR_PATH,
    "outside the exact repository allowlist",
  );
});

test("owner mutation proof detects documents passed through wrappers", () => {
  const report = assertConfinementCanary(
    {
      "src/wrapper.mjs": `
        function executeOwnerMutation(document) {
          return ghGraphql(document);
        }
        const document = ${JSON.stringify(CANARY_UPDATE_MUTATION)};
        executeOwnerMutation(document);
      `,
    },
    "src/wrapper.mjs",
    "outside its exact guarded executor",
  );
  assert(
    report.calls.some(
      (call) => call.functionName === null && call.fields.length === 1,
    ),
    `wrapper call did not resolve its static document: ${JSON.stringify(report)}`,
  );
});

test("owner mutation proof follows named and wildcard reexports", () => {
  for (const barrel of [
    `export { ownerMutation } from "./document.mjs";`,
    `export * from "./document.mjs";`,
  ]) {
    const report = assertConfinementCanary(
      {
        "src/barrel.mjs": barrel,
        "src/caller.mjs": `
          import { ownerMutation } from "./barrel.mjs";
          execute(ownerMutation);
        `,
        "src/document.mjs": `
          export const ownerMutation = ${JSON.stringify(CANARY_UPDATE_MUTATION)};
        `,
      },
      "src/caller.mjs",
      "outside its exact guarded executor",
    );
    assertDeepEqual(report.calls[0].fields, [UPDATE_OWNER_MUTATION_NAME]);
  }
});

test("owner mutation proof fails closed on missing GraphQL fragments", () => {
  assertConfinementCanary(
    {
      "src/missing-fragment.mjs": `
        execute(\`mutation OwnerMutation {
          ...${UPDATE_OWNER_MUTATION_NAME}
        }\`);
      `,
    },
    "src/missing-fragment.mjs",
    "owner-mutation",
  );
});

test("owner mutation proof fails closed on unresolved guarded documents", () => {
  assertConfinementCanary(
    {
      [OWNER_MUTATION_EXECUTOR_PATH]: `
        async function updateTextField(
          options,
          project,
          itemId,
          fieldId,
          text,
          { graphql } = {},
        ) {
          const document = options.dynamic
            ? ${JSON.stringify(CANARY_UPDATE_MUTATION)}
            : "";
          return graphql(
            document,
            { project: project.id, item: itemId, field: fieldId, text },
            { dryRun: options.dryRun, mutates: true },
          );
        }
      `,
    },
    OWNER_MUTATION_EXECUTOR_PATH,
    "outside its exact guarded call",
  );
});

test("backfill preflight rejection unlocks but post-write failure stays LOCK", async () => {
  const options = {
    ...LOCK_TEST_OPTIONS,
    issues: [901],
    branch: "agent/901",
  };
  const safeServer = createFakeLockServer();
  const conflicting = backfillFakes({
    values: {
      Agent: "codex",
      "Claim ID": "different-claim",
      Branch: "agent/901",
      "Claimed At": "2026-08-20",
    },
  });
  await assertRejects(
    () =>
      backfill(options, {
        ...conflicting,
        readClaimOwnership: async () => ({
          claimId: "different-claim",
          agent: "codex",
          branch: "agent/901",
          claimedAt: "2026-08-20",
          pr: null,
        }),
        withIssueMutationLock: (lockOptions, number, metadata, mutation) =>
          withIssueMutationLock(
            lockOptions,
            number,
            metadata,
            mutation,
            safeServer.operations,
          ),
      }),
    /conflicts/,
  );
  assertEqual(
    safeServer.commits.get(safeServer.refOid).payload.state,
    "UNLOCK",
  );

  const staleServer = createFakeLockServer();
  const afterWriteFailure = backfillFakes({
    mutate: (state) => {
      state.issue = {
        ...state.issue,
        state: "CLOSED",
      };
    },
  });
  await assertRejects(
    () =>
      backfill(options, {
        ...afterWriteFailure,
        readClaimOwnership: async () => ({
          claimId: null,
          agent: null,
          branch: null,
          claimedAt: null,
          pr: null,
        }),
        withIssueMutationLock: (lockOptions, number, metadata, mutation) =>
          withIssueMutationLock(
            lockOptions,
            number,
            metadata,
            mutation,
            staleServer.operations,
          ),
      }),
    /Persistent issue mutex .* remains at LOCK/,
  );
  assertEqual(
    staleServer.commits.get(staleServer.refOid).payload.state,
    "LOCK",
  );
  assertEqual(staleServer.commits.get(staleServer.refOid).payload.branch, null);
});

test("sync preflight rejection unlocks but attempted write failure stays LOCK", async () => {
  const options = {
    ...LOCK_TEST_OPTIONS,
    branch: "fix/2402",
  };
  const listedIssue = {
    id: "issue-2402",
    number: 2402,
    title: "sync lock disposition",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  const project = { id: "project" };
  const safeServer = createFakeLockServer();
  await assertRejects(
    () =>
      sync(options, {
        getProject: async () => project,
        listIssuesByLabels: async () => [listedIssue],
        preflightStableSyncIssue: async () => null,
        readIssueLockOwnership: async () => null,
        getIssue: async () => {
          throw new Error("sync preflight read failed");
        },
        withIssueMutationLock: (lockOptions, number, metadata, mutation) =>
          withIssueMutationLock(
            lockOptions,
            number,
            metadata,
            mutation,
            safeServer.operations,
          ),
      }),
    /sync preflight read failed/,
  );
  assertEqual(
    safeServer.commits.get(safeServer.refOid).payload.state,
    "UNLOCK",
  );
  assertEqual(safeServer.commits.get(safeServer.refOid).payload.branch, null);

  const staleServer = createFakeLockServer();
  const staleListedIssue = {
    ...listedIssue,
    state: "CLOSED",
  };
  await assertRejects(
    () =>
      sync(options, {
        getProject: async () => project,
        listIssuesByLabels: async () => [staleListedIssue],
        readIssueLockOwnership: async () => null,
        getIssue: async () => staleListedIssue,
        editIssueLabels: async () => {
          throw new Error("ambiguous sync label write");
        },
        withIssueMutationLock: (lockOptions, number, metadata, mutation) =>
          withIssueMutationLock(
            lockOptions,
            number,
            metadata,
            mutation,
            staleServer.operations,
          ),
      }),
    /Persistent issue mutex .* remains at LOCK/,
  );
  assertEqual(
    staleServer.commits.get(staleServer.refOid).payload.state,
    "LOCK",
  );
});

test("sync skips the mutex for exact open queue labels with exact Project membership", async () => {
  const issue = {
    id: "issue-2403",
    number: 2403,
    title: "stable sync item",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
    projectItems: [
      {
        title: "Agent Tasks",
        status: { name: "Ready" },
      },
    ],
  };
  let lockCalls = 0;
  let ownershipReads = 0;
  let exactItemReads = 0;
  let exactStatusReads = 0;
  const results = await sync(LOCK_TEST_OPTIONS, {
    getProject: async () => ({
      id: "project",
      title: "Agent Tasks",
      statusField: { id: "status" },
      statusOptions: [{ id: "ready", name: "Ready" }],
    }),
    listIssuesByLabels: async () => [issue],
    getIssue: async () => issue,
    findIssueProjectItem: async () => {
      exactItemReads += 1;
      return "selected-project-item";
    },
    readProjectItemStatus: async () => {
      exactStatusReads += 1;
      return { name: "Ready", optionId: "ready" };
    },
    readIssueLockOwnership: async () => {
      ownershipReads += 1;
      return null;
    },
    withIssueMutationLock: async () => {
      lockCalls += 1;
    },
  });
  assertDeepEqual(results, [
    { number: 2403, title: "stable sync item", state: "ready" },
  ]);
  assertEqual(lockCalls, 0);
  assertEqual(ownershipReads, 0);
  assertEqual(exactItemReads, 1);
  assertEqual(exactStatusReads, 0);
});

test("Project item lookup ignores a same-title Project and binds the selected ID", async () => {
  const project = { id: "selected-project", title: "Agent Tasks" };
  let queries = 0;
  const itemId = await findIssueProjectItem(
    LOCK_TEST_OPTIONS,
    {
      id: "issue-node-2405",
      projectItems: [
        {
          id: "wrong-item",
          project: { id: "other-project", title: "Agent Tasks" },
        },
      ],
    },
    project,
    {
      graphql: async (_query, variables) => {
        queries += 1;
        assertEqual(variables.issue, "issue-node-2405");
        return {
          data: {
            node: {
              projectItems: {
                nodes: [
                  {
                    id: "selected-item",
                    project: {
                      id: "selected-project",
                      title: "Agent Tasks",
                    },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        };
      },
    },
  );
  assertEqual(itemId, "selected-item");
  assertEqual(queries, 1);
});

test("Project item lookup trusts only an explicitly complete local snapshot", async () => {
  const itemId = await findIssueProjectItem(
    LOCK_TEST_OPTIONS,
    {
      id: "issue-node-2408",
      number: 2408,
      projectItems: [
        {
          id: "selected-item",
          project: { id: "selected-project", title: "Agent Tasks" },
        },
      ],
      projectItemsPageInfo: { hasNextPage: false },
    },
    { id: "selected-project", title: "Agent Tasks" },
    {
      graphql: async () => {
        throw new Error("complete local snapshot must not be re-read");
      },
    },
  );
  assertEqual(itemId, "selected-item");
});

test("Project item lookup fails closed when the selected item may be beyond the first page", async () => {
  await assertRejects(
    () =>
      findIssueProjectItem(
        LOCK_TEST_OPTIONS,
        {
          id: "issue-node-2407",
          number: 2407,
          projectItems: [],
        },
        { id: "selected-project", title: "Agent Tasks" },
        {
          graphql: async (query) => {
            assert(
              query.includes("pageInfo"),
              "Project membership lookup must request pagination state",
            );
            return {
              data: {
                node: {
                  projectItems: {
                    nodes: [
                      {
                        id: "other-item",
                        project: { id: "other-project", title: "Other" },
                      },
                    ],
                    pageInfo: { hasNextPage: true },
                  },
                },
              },
            };
          },
        },
      ),
    /Project membership lookup was incomplete/,
  );
});

test("Project item lookup rejects a selected item on a truncated page and missing pagination state", async () => {
  for (const pageInfo of [{ hasNextPage: true }, undefined]) {
    await assertRejects(
      () =>
        findIssueProjectItem(
          LOCK_TEST_OPTIONS,
          {
            id: "issue-node-2409",
            number: 2409,
            projectItems: [
              {
                id: "selected-local-item",
                project: { id: "selected-project" },
              },
            ],
          },
          { id: "selected-project", title: "Agent Tasks" },
          {
            graphql: async () => ({
              data: {
                node: {
                  projectItems: {
                    nodes: [
                      {
                        id: "selected-remote-item",
                        project: { id: "selected-project" },
                      },
                    ],
                    ...(pageInfo ? { pageInfo } : {}),
                  },
                },
              },
            }),
          },
        ),
      /Project membership lookup was incomplete/,
    );
  }
});

test("Project item lookup rejects duplicate selected Project memberships", async () => {
  const duplicateItems = [
    {
      id: "selected-item-a",
      project: { id: "selected-project", title: "Agent Tasks" },
    },
    {
      id: "selected-item-b",
      project: { id: "selected-project", title: "Agent Tasks" },
    },
  ];
  await assertRejects(
    () =>
      findIssueProjectItem(
        LOCK_TEST_OPTIONS,
        {
          id: "issue-node-2410",
          number: 2410,
          projectItems: duplicateItems,
          projectItemsPageInfo: { hasNextPage: false },
        },
        { id: "selected-project", title: "Agent Tasks" },
      ),
    /duplicate Project items for selected Project selected-project/,
  );
  await assertRejects(
    () =>
      findIssueProjectItem(
        LOCK_TEST_OPTIONS,
        {
          id: "issue-node-2411",
          number: 2411,
          projectItems: [],
        },
        { id: "selected-project", title: "Agent Tasks" },
        {
          graphql: async () => ({
            data: {
              node: {
                projectItems: {
                  nodes: duplicateItems,
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          }),
        },
      ),
    /duplicate Project items for selected Project selected-project/,
  );
});

test("Project Status reads match the selected field ID", async () => {
  const status = await readProjectItemStatus(
    LOCK_TEST_OPTIONS,
    { statusField: { id: "selected-status-field" } },
    "selected-item",
    {
      graphql: async () => ({
        data: {
          node: {
            fieldValues: {
              nodes: [
                {
                  name: "Ready",
                  optionId: "wrong-ready",
                  field: { id: "other-status-field" },
                },
                {
                  name: "In Progress",
                  optionId: "selected-progress",
                  field: { id: "selected-status-field" },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      }),
    },
  );
  assertDeepEqual(status, {
    name: "In Progress",
    optionId: "selected-progress",
  });
});

test("sync binds stable membership by selected Project ID and ignores Status", async () => {
  const issue = {
    id: "issue-2406",
    number: 2406,
    title: "same-title Project collision",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
    projectItems: [
      {
        title: "Agent Tasks",
        status: { name: "Ready" },
      },
    ],
  };
  let lockCalls = 0;
  let itemReads = 0;
  const results = await sync(LOCK_TEST_OPTIONS, {
    getProject: async () => ({
      id: "selected-project",
      title: "Agent Tasks",
      statusField: { id: "selected-status-field" },
      statusOptions: [{ id: "ready", name: "Ready" }],
    }),
    listIssuesByLabels: async () => [issue],
    getIssue: async () => issue,
    findIssueProjectItem: async () => {
      itemReads += 1;
      return "selected-project-item";
    },
    readProjectItemStatus: async () => {
      throw new Error("stable open sync must not inspect Project Status");
    },
    readIssueLockOwnership: async () => null,
    withIssueMutationLock: async (_options, number, metadata) => {
      lockCalls += 1;
      assertEqual(metadata.operation, "sync");
      return { number, title: issue.title, state: "ready" };
    },
  });
  assertEqual(lockCalls, 0);
  assertEqual(itemReads, 1);
  assertDeepEqual(results, [
    { number: 2406, title: "same-title Project collision", state: "ready" },
  ]);
});

test("sync preserves a human Status that differs from the queue label", async () => {
  const issue = {
    id: "issue-2404",
    number: 2404,
    title: "drifted sync item",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
    projectItems: [
      {
        title: "Agent Tasks",
        status: { name: "In Progress" },
      },
    ],
  };
  let lockCalls = 0;
  let itemReads = 0;
  await sync(LOCK_TEST_OPTIONS, {
    getProject: async () => ({
      id: "project",
      title: "Agent Tasks",
      statusOptions: [{ id: "ready", name: "Ready" }],
    }),
    listIssuesByLabels: async () => [issue],
    getIssue: async () => issue,
    findIssueProjectItem: async () => {
      itemReads += 1;
      return "selected-project-item";
    },
    readIssueLockOwnership: async () => null,
    withIssueMutationLock: async (_options, number, metadata) => {
      lockCalls += 1;
      assertEqual(number, 2404);
      assertEqual(metadata.operation, "sync");
      return { number, title: issue.title, state: "ready" };
    },
  });
  assertEqual(lockCalls, 0);
  assertEqual(itemReads, 1);
});

test("Project metadata writes never target the Status field", async () => {
  const project = ownershipProject();
  const writes = [];

  await withRealOwnerCapability("claim", project, 2500, async (capability) => {
    await updateProjectMetadata(
      capability,
      LOCK_TEST_OPTIONS,
      project,
      "item-2500",
      {
        agent: "codex",
        branch: "fix/2500",
        claimedAt: "2026-08-29T10:00:00.000Z",
        pr: 2501,
        claimId: "claim-2500",
      },
      {
        updateText: async (
          _capability,
          _options,
          _project,
          itemId,
          fieldId,
          value,
        ) => {
          writes.push({ kind: "text", itemId, fieldId, value });
        },
        updateDate: async (
          _capability,
          _options,
          _project,
          itemId,
          fieldId,
          value,
        ) => {
          writes.push({ kind: "date", itemId, fieldId, value });
        },
        issueNumber: 2500,
        operation: "claim",
      },
    );
  });

  assertDeepEqual(
    writes.map(({ kind, fieldId }) => ({ kind, fieldId })),
    [
      { kind: "text", fieldId: "agent" },
      { kind: "text", fieldId: "branch" },
      { kind: "text", fieldId: "pr" },
      { kind: "date", fieldId: "claimed" },
      { kind: "text", fieldId: "claim" },
    ],
  );
  assert(
    writes.every((write) => write.fieldId !== project.statusField.id),
    "metadata writes must not target Status",
  );
});

await Promise.all(pending);

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
