import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  dailySnapshotId,
  dayBucket,
  asBigInt,
  eventId,
  eventIdFromEvent,
  extractAddressFromPoolId,
  hourBucket,
  makePoolId,
  snapshotId,
} from "../src/helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(packageRoot, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) return sourceFiles(absolute);
    return absolute.endsWith(".ts") ? [absolute] : [];
  });
}

type TopLevelCollectionDeclaration = {
  kind: "Set" | "Map";
  name: string;
  propertyPath: string[];
  rootSymbolNode: ts.Identifier;
};

function newCollectionKind(
  initializer: ts.Expression,
): "Set" | "Map" | undefined {
  if (!ts.isNewExpression(initializer)) return undefined;
  const constructor = initializer.expression;
  const collectionKind = ts.isIdentifier(constructor)
    ? constructor.text
    : ts.isPropertyAccessExpression(constructor)
      ? constructor.name.text
      : undefined;
  return collectionKind === "Set" || collectionKind === "Map"
    ? collectionKind
    : undefined;
}

function nestedCollectionDeclarations(
  initializer: ts.Expression,
  name: string,
  rootSymbolNode: ts.Identifier,
  propertyPath: string[],
): TopLevelCollectionDeclaration[] {
  const collectionKind = newCollectionKind(initializer);
  if (collectionKind) {
    return [{ kind: collectionKind, name, propertyPath, rootSymbolNode }];
  }
  if (
    ts.isAsExpression(initializer) ||
    ts.isParenthesizedExpression(initializer) ||
    ts.isSatisfiesExpression(initializer) ||
    ts.isTypeAssertionExpression(initializer)
  ) {
    return nestedCollectionDeclarations(
      initializer.expression,
      name,
      rootSymbolNode,
      propertyPath,
    );
  }
  if (!ts.isObjectLiteralExpression(initializer)) return [];

  return initializer.properties.flatMap((property) => {
    if (
      !ts.isPropertyAssignment(property) ||
      !(
        ts.isIdentifier(property.name) ||
        ts.isStringLiteral(property.name) ||
        ts.isNumericLiteral(property.name)
      )
    ) {
      return [];
    }
    return nestedCollectionDeclarations(
      property.initializer,
      `${name}.${property.name.text}`,
      rootSymbolNode,
      [...propertyPath, property.name.text],
    );
  });
}

function topLevelSetOrMapDeclarationNodes(
  sourceFile: ts.SourceFile,
): TopLevelCollectionDeclaration[] {
  const declarations: TopLevelCollectionDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || !ts.isIdentifier(declaration.name)) {
        continue;
      }
      declarations.push(
        ...nestedCollectionDeclarations(
          declaration.initializer,
          declaration.name.text,
          declaration.name,
          [],
        ),
      );
    }
  }

  return declarations;
}

function topLevelSetOrMapDeclarations(
  sourceFile: ts.SourceFile,
): Map<string, "Set" | "Map"> {
  return new Map(
    topLevelSetOrMapDeclarationNodes(sourceFile).map(({ kind, name }) => [
      name,
      kind,
    ]),
  );
}

function isPreloadAccess(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === "isPreload") {
    return true;
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
    node.argumentExpression.text === "isPreload"
  ) {
    return true;
  }
  if (!ts.isBindingElement(node)) return false;
  const bindingName = node.propertyName ?? node.name;
  return (
    (ts.isIdentifier(bindingName) || ts.isStringLiteral(bindingName)) &&
    bindingName.text === "isPreload"
  );
}

function moduleLocalCollectionsInPreloadAwareModule(
  sourceText: string,
  fileName: string,
): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const moduleCollections = topLevelSetOrMapDeclarations(sourceFile);
  if (moduleCollections.size === 0) return [];

  let preloadAwareModule = false;
  const findPreload = (node: ts.Node): void => {
    if (isPreloadAccess(node)) {
      preloadAwareModule = true;
      return;
    }
    ts.forEachChild(node, findPreload);
  };
  findPreload(sourceFile);
  if (!preloadAwareModule) return [];

  return [...moduleCollections].map(
    ([name, collectionKind]) => `${fileName} ${name} (${collectionKind})`,
  );
}

function findUnsafeMultiFieldGetWhereCalls(): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles(srcRoot)) {
    const sourceText = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "getWhere" &&
        node.arguments.length > 0
      ) {
        const firstArg = node.arguments[0];
        if (
          firstArg !== undefined &&
          ts.isObjectLiteralExpression(firstArg) &&
          firstArg.properties.length > 1
        ) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(
            firstArg.getStart(),
          );
          const fields = firstArg.properties.map((property) =>
            ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)
              ? property.name.text
              : property.getText(sourceFile),
          );
          if (fields.includes("chainId") || fields.includes("poolId")) {
            return;
          }
          offenders.push(
            `${path.relative(packageRoot, file)}:${line + 1}:${character + 1} ${fields.join(", ")}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return offenders;
}

type DirectEffectCall = {
  call: ts.CallExpression;
  key: string;
  name: string;
  statement: ts.Node;
};

function isFunctionLikeNode(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}

type NamedFunctionSummary = {
  callsEffect: boolean;
  callees: Set<string>;
};

function importAliases(sourceFile: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      aliases.set(
        element.name.text,
        element.propertyName?.text ?? element.name.text,
      );
    }
  }
  return aliases;
}

function isNamedNestedFunction(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node)) return node.name !== undefined;
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  );
}

function summarizeNamedFunction(
  root: ts.FunctionLikeDeclaration,
  aliases: Map<string, string>,
): NamedFunctionSummary {
  let callsEffect = false;
  const callees = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (node !== root && isNamedNestedFunction(node)) return;
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "effect"
      ) {
        callsEffect = true;
      }
      if (ts.isIdentifier(node.expression)) {
        callees.add(aliases.get(node.expression.text) ?? node.expression.text);
      }
      for (const argument of node.arguments) {
        if (ts.isIdentifier(argument)) {
          callees.add(aliases.get(argument.text) ?? argument.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return { callsEffect, callees };
}

function collectNamedFunctionSummaries(
  sourceFile: ts.SourceFile,
): Map<string, NamedFunctionSummary> {
  const summaries = new Map<string, NamedFunctionSummary>();
  const aliases = importAliases(sourceFile);
  const merge = (name: string, summary: NamedFunctionSummary): void => {
    const existing = summaries.get(name);
    if (!existing) {
      summaries.set(name, summary);
      return;
    }
    existing.callsEffect ||= summary.callsEffect;
    for (const callee of summary.callees) existing.callees.add(callee);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      merge(node.name.text, summarizeNamedFunction(node, aliases));
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      merge(node.name.text, summarizeNamedFunction(node.initializer, aliases));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return summaries;
}

function deriveEffectfulHelperNames(
  sourceFileList: ts.SourceFile[],
): Set<string> {
  const summaries = new Map<string, NamedFunctionSummary>();
  for (const sourceFile of sourceFileList) {
    for (const [name, summary] of collectNamedFunctionSummaries(sourceFile)) {
      const existing = summaries.get(name);
      if (!existing) {
        summaries.set(name, summary);
        continue;
      }
      existing.callsEffect ||= summary.callsEffect;
      for (const callee of summary.callees) existing.callees.add(callee);
    }
  }

  const effectful = new Set(
    [...summaries]
      .filter(([, summary]) => summary.callsEffect)
      .map(([name]) => name),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, summary] of summaries) {
      if (effectful.has(name)) continue;
      if ([...summary.callees].some((callee) => effectful.has(callee))) {
        effectful.add(name);
        changed = true;
      }
    }
  }
  return effectful;
}

type EffectfulProgramAnalysis = {
  checker: ts.TypeChecker;
  effectfulSymbols: Set<ts.Symbol>;
  preloadWrapperSymbols: Set<ts.Symbol>;
  program: ts.Program;
};

function canonicalSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while (
    current !== undefined &&
    (current.flags & ts.SymbolFlags.Alias) !== 0 &&
    !seen.has(current)
  ) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function functionSymbol(
  node: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)) &&
    node.name
  ) {
    return canonicalSymbol(checker, checker.getSymbolAtLocation(node.name));
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return canonicalSymbol(
      checker,
      checker.getSymbolAtLocation(node.parent.name),
    );
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isPropertyAssignment(node.parent)
  ) {
    return canonicalSymbol(
      checker,
      checker.getSymbolAtLocation(node.parent.name),
    );
  }
  return undefined;
}

function expressionSymbol(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const location = ts.isPropertyAccessExpression(expression)
    ? expression.name
    : expression;
  return canonicalSymbol(checker, checker.getSymbolAtLocation(location));
}

function callExpressionSymbols(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): Set<ts.Symbol> {
  const symbols = new Set<ts.Symbol>();
  const expression = expressionSymbol(call.expression, checker);
  if (expression) symbols.add(expression);
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration && isFunctionLikeNode(declaration)) {
    const declarationSymbol = functionSymbol(
      declaration as ts.FunctionLikeDeclaration,
      checker,
    );
    if (declarationSymbol) symbols.add(declarationSymbol);
  }
  return symbols;
}

function analyzeEffectfulProgram(
  program: ts.Program,
  includesSourceFile: (sourceFile: ts.SourceFile) => boolean,
  preloadWrapperSymbols: Set<ts.Symbol>,
): EffectfulProgramAnalysis {
  const checker = program.getTypeChecker();
  const symbolToFunctions = new Map<
    ts.Symbol,
    Set<ts.FunctionLikeDeclaration>
  >();
  const functionToSymbol = new Map<ts.FunctionLikeDeclaration, ts.Symbol>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!includesSourceFile(sourceFile) || sourceFile.isDeclarationFile) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (isFunctionLikeNode(node)) {
        const fn = node as ts.FunctionLikeDeclaration;
        const symbol = functionSymbol(fn, checker);
        if (symbol) {
          functionToSymbol.set(fn, symbol);
          const functions = symbolToFunctions.get(symbol) ?? new Set();
          functions.add(fn);
          symbolToFunctions.set(symbol, functions);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const directEffectFunctions = new Set<ts.FunctionLikeDeclaration>();
  const edges = new Map<
    ts.FunctionLikeDeclaration,
    Set<ts.FunctionLikeDeclaration>
  >();
  for (const fn of functionToSymbol.keys()) {
    const targets = new Set<ts.FunctionLikeDeclaration>();
    const visit = (node: ts.Node): void => {
      if (
        node !== fn &&
        isFunctionLikeNode(node) &&
        functionToSymbol.has(node as ts.FunctionLikeDeclaration)
      ) {
        return;
      }
      if (ts.isCallExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "effect"
        ) {
          directEffectFunctions.add(fn);
        }
        for (const calledSymbol of callExpressionSymbols(node, checker)) {
          for (const target of symbolToFunctions.get(calledSymbol) ?? []) {
            targets.add(target);
          }
        }
        for (const argument of node.arguments) {
          const argumentSymbol = expressionSymbol(argument, checker);
          if (!argumentSymbol) continue;
          for (const target of symbolToFunctions.get(argumentSymbol) ?? []) {
            targets.add(target);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
    edges.set(fn, targets);
  }

  const effectfulFunctions = new Set(directEffectFunctions);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [fn, targets] of edges) {
      if (effectfulFunctions.has(fn)) continue;
      if ([...targets].some((target) => effectfulFunctions.has(target))) {
        effectfulFunctions.add(fn);
        changed = true;
      }
    }
  }
  const effectfulSymbols = new Set<ts.Symbol>();
  for (const fn of effectfulFunctions) {
    const symbol = functionToSymbol.get(fn);
    if (symbol) effectfulSymbols.add(symbol);
  }
  return { checker, effectfulSymbols, preloadWrapperSymbols, program };
}

function exportedSymbol(
  program: ts.Program,
  checker: ts.TypeChecker,
  file: string,
  exportName: string,
): ts.Symbol | undefined {
  const sourceFile = program.getSourceFile(path.resolve(file));
  if (!sourceFile) return undefined;
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return undefined;
  return canonicalSymbol(
    checker,
    checker
      .getExportsOfModule(moduleSymbol)
      .find((symbol) => symbol.name === exportName),
  );
}

function buildEffectfulProgramAnalysis(): EffectfulProgramAnalysis {
  const configPath = path.join(packageRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    packageRoot,
    { noEmit: true },
    configPath,
  );
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  const checker = program.getTypeChecker();
  const preloadWrapperSymbols = new Set<ts.Symbol>();
  for (const [file, exportName] of [
    [path.join(srcRoot, "pool.ts"), "maybePreloadPool"],
    [path.join(srcRoot, "breakers.ts"), "maybePreloadBreaker"],
  ] as const) {
    const symbol = exportedSymbol(program, checker, file, exportName);
    if (!symbol) {
      throw new Error(
        `Missing preload wrapper export ${exportName} in ${file}`,
      );
    }
    preloadWrapperSymbols.add(symbol);
  }
  return analyzeEffectfulProgram(
    program,
    (sourceFile) =>
      path.resolve(sourceFile.fileName).startsWith(`${srcRoot}${path.sep}`),
    preloadWrapperSymbols,
  );
}

const effectfulProgramAnalysis = buildEffectfulProgramAnalysis();

type ModuleCollectionInfo = {
  kind: "Set" | "Map";
  name: string;
  sourceFile: ts.SourceFile;
};

// Follow real TypeScript symbols so imported helpers, callbacks, aliases, and
// collection parameters cannot hide worker-local mutations. Read-only lookup
// collections are intentionally allowed.
function findModuleCollectionMutationsReachableFromPreload(
  program: ts.Program,
  includesSourceFile: (sourceFile: ts.SourceFile) => boolean,
  displayRoot: string,
): string[] {
  const checker = program.getTypeChecker();
  const sourceFileList = program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        !sourceFile.isDeclarationFile && includesSourceFile(sourceFile),
    );
  type SymbolAccess = { path: string[]; root: ts.Symbol };
  type PathBinding = {
    collections: Set<ModuleCollectionInfo>;
    path: string[];
  };
  type CollectionPathBindings = Map<ts.Symbol, Map<string, PathBinding>>;
  const collectionPathBindings: CollectionPathBindings = new Map();
  const pathKey = (propertyPath: readonly string[]): string =>
    JSON.stringify(propertyPath);
  const mergePathBinding = (
    symbol: ts.Symbol,
    propertyPath: readonly string[],
    collections: ReadonlySet<ModuleCollectionInfo>,
  ): boolean => {
    const byPath = collectionPathBindings.get(symbol) ?? new Map();
    const key = pathKey(propertyPath);
    const existing = byPath.get(key) ?? {
      collections: new Set<ModuleCollectionInfo>(),
      path: [...propertyPath],
    };
    const initialSize = existing.collections.size;
    for (const collection of collections) {
      existing.collections.add(collection);
    }
    if (existing.collections.size === initialSize) return false;
    byPath.set(key, existing);
    collectionPathBindings.set(symbol, byPath);
    return true;
  };
  const expressionAccess = (
    expression: ts.Expression,
  ): SymbolAccess | undefined => {
    if (
      ts.isAsExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    ) {
      return expressionAccess(expression.expression);
    }
    if (ts.isIdentifier(expression)) {
      const root = canonicalSymbol(
        checker,
        checker.getSymbolAtLocation(expression),
      );
      return root ? { path: [], root } : undefined;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const parent = expressionAccess(expression.expression);
      return parent
        ? { path: [...parent.path, expression.name.text], root: parent.root }
        : undefined;
    }
    if (
      ts.isElementAccessExpression(expression) &&
      expression.argumentExpression &&
      (ts.isStringLiteral(expression.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression) ||
        ts.isNumericLiteral(expression.argumentExpression))
    ) {
      const parent = expressionAccess(expression.expression);
      return parent
        ? {
            path: [...parent.path, expression.argumentExpression.text],
            root: parent.root,
          }
        : undefined;
    }
    return undefined;
  };
  const copyAccessBindings = (
    alias: ts.Symbol,
    target: SymbolAccess,
  ): boolean => {
    let changed = false;
    for (const binding of collectionPathBindings.get(target.root)?.values() ??
      []) {
      if (
        target.path.length > binding.path.length ||
        target.path.some((segment, index) => binding.path[index] !== segment)
      ) {
        continue;
      }
      if (
        mergePathBinding(
          alias,
          binding.path.slice(target.path.length),
          binding.collections,
        )
      ) {
        changed = true;
      }
    }
    return changed;
  };
  const aliasEdges: Array<{
    alias: ts.Symbol;
    target: SymbolAccess;
  }> = [];
  for (const sourceFile of sourceFileList) {
    for (const {
      kind,
      name,
      propertyPath,
      rootSymbolNode,
    } of topLevelSetOrMapDeclarationNodes(sourceFile)) {
      const collection = { kind, name, sourceFile };
      const root = canonicalSymbol(
        checker,
        checker.getSymbolAtLocation(rootSymbolNode),
      );
      if (root) mergePathBinding(root, propertyPath, new Set([collection]));
    }
    const collectAliases = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const alias = canonicalSymbol(
          checker,
          checker.getSymbolAtLocation(node.name),
        );
        const target = expressionAccess(node.initializer);
        if (alias && target) aliasEdges.push({ alias, target });
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer
      ) {
        const initializerAccess = expressionAccess(node.initializer);
        for (const element of node.name.elements) {
          const propertyName = element.propertyName ?? element.name;
          if (
            !ts.isIdentifier(element.name) ||
            !(
              ts.isIdentifier(propertyName) ||
              ts.isStringLiteral(propertyName) ||
              ts.isNumericLiteral(propertyName)
            )
          ) {
            continue;
          }
          const alias = canonicalSymbol(
            checker,
            checker.getSymbolAtLocation(element.name),
          );
          if (alias && initializerAccess) {
            aliasEdges.push({
              alias,
              target: {
                path: [...initializerAccess.path, propertyName.text],
                root: initializerAccess.root,
              },
            });
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const alias = canonicalSymbol(
          checker,
          checker.getSymbolAtLocation(node.left),
        );
        const target = expressionAccess(node.right);
        if (alias && target) aliasEdges.push({ alias, target });
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(sourceFile);
  }

  const functions = new Set<ts.FunctionLikeDeclaration>();
  const functionsBySymbol = new Map<
    ts.Symbol,
    Set<ts.FunctionLikeDeclaration>
  >();
  for (const sourceFile of sourceFileList) {
    const visit = (node: ts.Node): void => {
      if (isFunctionLikeNode(node)) {
        const fn = node as ts.FunctionLikeDeclaration;
        functions.add(fn);
        const symbol = functionSymbol(fn, checker);
        if (symbol) {
          const declarations = functionsBySymbol.get(symbol) ?? new Set();
          declarations.add(fn);
          functionsBySymbol.set(symbol, declarations);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const edges = new Map<
    ts.FunctionLikeDeclaration,
    Set<ts.FunctionLikeDeclaration>
  >();
  const callSitesByFunction = new Map<
    ts.FunctionLikeDeclaration,
    Array<{
      call: ts.CallExpression;
      invokedTargets: Set<ts.FunctionLikeDeclaration>;
    }>
  >();
  const preloadFunctions = new Set<ts.FunctionLikeDeclaration>();
  for (const fn of functions) {
    const targets = new Set<ts.FunctionLikeDeclaration>();
    const callSites: Array<{
      call: ts.CallExpression;
      invokedTargets: Set<ts.FunctionLikeDeclaration>;
    }> = [];
    let preloadAware = false;
    const visit = (node: ts.Node): void => {
      if (node !== fn && isFunctionLikeNode(node)) return;
      if (isPreloadAccess(node)) {
        preloadAware = true;
      }
      if (ts.isCallExpression(node)) {
        const invokedTargets = new Set<ts.FunctionLikeDeclaration>();
        for (const calledSymbol of callExpressionSymbols(node, checker)) {
          for (const target of functionsBySymbol.get(calledSymbol) ?? []) {
            targets.add(target);
            invokedTargets.add(target);
          }
        }
        for (const argument of node.arguments) {
          if (isFunctionLikeNode(argument)) {
            const target = argument as ts.FunctionLikeDeclaration;
            targets.add(target);
          }
          const argumentSymbol = expressionSymbol(argument, checker);
          if (!argumentSymbol) continue;
          for (const target of functionsBySymbol.get(argumentSymbol) ?? []) {
            targets.add(target);
          }
        }
        callSites.push({ call: node, invokedTargets });
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
    edges.set(fn, targets);
    callSitesByFunction.set(fn, callSites);
    if (preloadAware) preloadFunctions.add(fn);
  }

  const reachableFunctions = new Set(preloadFunctions);
  const pendingFunctions = [...preloadFunctions];
  while (pendingFunctions.length > 0) {
    const fn = pendingFunctions.pop();
    if (!fn) continue;
    for (const target of edges.get(fn) ?? []) {
      if (reachableFunctions.has(target)) continue;
      reachableFunctions.add(target);
      pendingFunctions.push(target);
    }
  }

  let bindingsChanged = true;
  while (bindingsChanged) {
    bindingsChanged = false;
    for (const { alias, target } of aliasEdges) {
      if (copyAccessBindings(alias, target)) bindingsChanged = true;
    }
    for (const fn of reachableFunctions) {
      for (const { call, invokedTargets } of callSitesByFunction.get(fn) ??
        []) {
        for (const target of invokedTargets) {
          for (
            let argumentIndex = 0;
            argumentIndex < call.arguments.length;
            argumentIndex += 1
          ) {
            const argument = call.arguments[argumentIndex];
            const parameter = target.parameters[argumentIndex];
            if (!argument || !parameter) continue;
            const argumentAccess = expressionAccess(argument);
            if (!argumentAccess) continue;
            if (ts.isIdentifier(parameter.name)) {
              const parameterSymbol = canonicalSymbol(
                checker,
                checker.getSymbolAtLocation(parameter.name),
              );
              if (
                parameterSymbol &&
                copyAccessBindings(parameterSymbol, argumentAccess)
              ) {
                bindingsChanged = true;
              }
              continue;
            }
            if (ts.isObjectBindingPattern(parameter.name)) {
              for (const element of parameter.name.elements) {
                const propertyName = element.propertyName ?? element.name;
                if (
                  !ts.isIdentifier(element.name) ||
                  !(
                    ts.isIdentifier(propertyName) ||
                    ts.isStringLiteral(propertyName) ||
                    ts.isNumericLiteral(propertyName)
                  )
                ) {
                  continue;
                }
                const bindingSymbol = canonicalSymbol(
                  checker,
                  checker.getSymbolAtLocation(element.name),
                );
                if (
                  bindingSymbol &&
                  copyAccessBindings(bindingSymbol, {
                    path: [...argumentAccess.path, propertyName.text],
                    root: argumentAccess.root,
                  })
                ) {
                  bindingsChanged = true;
                }
              }
            }
          }
        }
      }
    }
  }

  const mutatedCollectionsByFunction = new Map<
    ts.FunctionLikeDeclaration,
    Set<ModuleCollectionInfo>
  >();
  for (const fn of functions) {
    const mutatedCollections = new Set<ModuleCollectionInfo>();
    const visit = (node: ts.Node): void => {
      if (node !== fn && isFunctionLikeNode(node)) return;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["add", "clear", "delete", "set"].includes(node.expression.name.text)
      ) {
        const receiverAccess = expressionAccess(node.expression.expression);
        const binding =
          receiverAccess &&
          collectionPathBindings
            .get(receiverAccess.root)
            ?.get(pathKey(receiverAccess.path));
        if (binding) {
          for (const collection of binding.collections) {
            mutatedCollections.add(collection);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
    mutatedCollectionsByFunction.set(fn, mutatedCollections);
  }

  const reachableCollections = new Set<ModuleCollectionInfo>();
  for (const fn of reachableFunctions) {
    for (const collection of mutatedCollectionsByFunction.get(fn) ?? []) {
      reachableCollections.add(collection);
    }
  }
  return [...reachableCollections]
    .map(
      ({ kind, name, sourceFile }) =>
        `${path.relative(displayRoot, sourceFile.fileName)} ${name} (${kind})`,
    )
    .sort();
}

function findHandlerCollectionMutationsReachableFromPreload(): string[] {
  const handlersRoot = path.join(srcRoot, "handlers");
  // RPC/effect modules own intentional process-local client and test caches;
  // this guard targets phase-bridging state hidden in the handler module graph.
  return findModuleCollectionMutationsReachableFromPreload(
    effectfulProgramAnalysis.program,
    (sourceFile) =>
      path
        .resolve(sourceFile.fileName)
        .startsWith(`${handlersRoot}${path.sep}`),
    packageRoot,
  );
}

function isDirectContextEffectCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText() === "context" &&
    node.expression.name.text === "effect"
  );
}

function compactNodeText(node: ts.Node | undefined, sourceFile: ts.SourceFile) {
  return node?.getText(sourceFile).replace(/\s+/g, "") ?? "<missing>";
}

function collectDirectEffectCalls(
  root: ts.Node,
  sourceFile: ts.SourceFile,
): DirectEffectCall[] {
  const calls: DirectEffectCall[] = [];
  const visit = (node: ts.Node): void => {
    if (isDirectContextEffectCall(node)) {
      let statement: ts.Node = node;
      while (statement.parent && !ts.isStatement(statement)) {
        statement = statement.parent;
      }
      calls.push({
        call: node,
        key: `${compactNodeText(node.arguments[0], sourceFile)}|${compactNodeText(node.arguments[1], sourceFile)}`,
        name: compactNodeText(node.arguments[0], sourceFile),
        statement,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

type PhaseEffectCall = DirectEffectCall & { conditions: string[] };

function conditionText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return compactNodeText(node, sourceFile).replaceAll("?.", ".");
}

function eagerCallbackMarker(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string | undefined {
  const parent = node.parent;
  if (
    !ts.isCallExpression(parent) ||
    !parent.arguments.includes(node as ts.Expression) ||
    !ts.isPropertyAccessExpression(parent.expression)
  ) {
    return undefined;
  }
  const method = parent.expression.name.text;
  return [
    "every",
    "filter",
    "flatMap",
    "forEach",
    "map",
    "reduce",
    "reduceRight",
    "some",
  ].includes(method)
    ? `eager-callback:${method}:${conditionText(parent.expression.expression, sourceFile)}`
    : undefined;
}

function collectPhaseEffectCalls(
  root: ts.Node,
  sourceFile: ts.SourceFile,
  options: {
    includeEagerCallbacks?: boolean;
    includeNestedFunctions?: boolean;
  } = {},
): PhaseEffectCall[] {
  const calls: PhaseEffectCall[] = [];
  const visit = (node: ts.Node, conditions: string[]): void => {
    if (node !== root && isFunctionLikeNode(node)) {
      const callbackMarker = eagerCallbackMarker(node, sourceFile);
      if (
        !options.includeNestedFunctions &&
        !(options.includeEagerCallbacks && callbackMarker)
      ) {
        return;
      }
      ts.forEachChild(node, (child) =>
        visit(child, [...conditions, callbackMarker ?? "nested-function"]),
      );
      return;
    }
    if (isDirectContextEffectCall(node)) {
      let statement: ts.Node = node;
      while (statement.parent && !ts.isStatement(statement)) {
        statement = statement.parent;
      }
      calls.push({
        call: node,
        key: `${compactNodeText(node.arguments[0], sourceFile)}|${compactNodeText(node.arguments[1], sourceFile)}`,
        name: compactNodeText(node.arguments[0], sourceFile),
        statement,
        conditions,
      });
    }
    if (ts.isIfStatement(node)) {
      const predicate = conditionText(node.expression, sourceFile);
      visit(node.expression, conditions);
      visit(node.thenStatement, [...conditions, `if:${predicate}`]);
      if (node.elseStatement) {
        visit(node.elseStatement, [...conditions, `else:${predicate}`]);
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      const predicate = conditionText(node.condition, sourceFile);
      visit(node.condition, conditions);
      visit(node.whenTrue, [...conditions, `if:${predicate}`]);
      visit(node.whenFalse, [...conditions, `else:${predicate}`]);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      const operator = node.operatorToken.getText(sourceFile);
      const left = conditionText(node.left, sourceFile);
      visit(node.left, conditions);
      visit(node.right, [...conditions, `${operator}:${left}`]);
      return;
    }
    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isCaseClause(node) ||
      ts.isDefaultClause(node) ||
      ts.isCatchClause(node)
    ) {
      const marker = `conditional:${ts.SyntaxKind[node.kind]}`;
      ts.forEachChild(node, (child) => visit(child, [...conditions, marker]));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, conditions));
  };
  visit(root, []);
  return calls;
}

function conditionsCover(
  preloadConditions: string[],
  processingConditions: string[],
): boolean {
  return preloadConditions.every(
    (condition, index) => processingConditions[index] === condition,
  );
}

function isPreloadPhaseCondition(condition: string): boolean {
  return condition.includes("context.isPreload");
}

function containsReturnOutsideNestedFunction(node: ts.Node): boolean {
  if (ts.isReturnStatement(node)) return true;
  if (isFunctionLikeNode(node)) return false;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsReturnOutsideNestedFunction(child)) found = true;
  });
  return found;
}

function eagerPreloadStatements(
  statement: ts.Statement,
): ts.Statement[] | undefined {
  if (ts.isReturnStatement(statement)) return [];
  if (!ts.isBlock(statement)) return undefined;
  const returnIndex = statement.statements.findIndex((child) =>
    ts.isReturnStatement(child),
  );
  if (returnIndex < 0) return undefined;
  return statement.statements.slice(0, returnIndex);
}

type PreloadWrapperResolver =
  | {
      checker: ts.TypeChecker;
      kind: "program";
      preloadWrapperSymbols: Set<ts.Symbol>;
    }
  | { kind: "fallback" };

const fallbackPreloadWrapperArity = new Map<string, readonly [number, number]>([
  ["maybePreloadPool", [2, 2]],
  ["maybePreloadBreaker", [2, 3]],
]);

function isExactPreloadWrapperCall(
  expression: ts.Expression,
  resolver: PreloadWrapperResolver,
): boolean {
  if (!ts.isCallExpression(expression)) return false;
  if (resolver.kind === "program") {
    const symbols = callExpressionSymbols(expression, resolver.checker);
    if (
      ![...symbols].some((symbol) => resolver.preloadWrapperSymbols.has(symbol))
    ) {
      return false;
    }
    const signature = resolver.checker.getResolvedSignature(expression);
    return (
      signature !== undefined &&
      expression.arguments.length >= signature.minArgumentCount &&
      expression.arguments.length <= signature.parameters.length
    );
  }
  if (!ts.isIdentifier(expression.expression)) return false;
  const arity = fallbackPreloadWrapperArity.get(expression.expression.text);
  return (
    arity !== undefined &&
    expression.arguments.length >= arity[0] &&
    expression.arguments.length <= arity[1]
  );
}

function isPositivePreloadReturn(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  resolver: PreloadWrapperResolver,
): statement is ts.IfStatement {
  if (!ts.isIfStatement(statement)) return false;
  const condition = compactNodeText(statement.expression, sourceFile);
  let expression: ts.Expression = statement.expression;
  while (ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  let awaitedExpression = ts.isAwaitExpression(expression)
    ? expression.expression
    : undefined;
  while (
    awaitedExpression !== undefined &&
    ts.isParenthesizedExpression(awaitedExpression)
  ) {
    awaitedExpression = awaitedExpression.expression;
  }
  const isPreloadWrapperCall =
    awaitedExpression !== undefined &&
    isExactPreloadWrapperCall(awaitedExpression, resolver);
  const isPositivePreloadCheck =
    condition === "context.isPreload" ||
    condition === "context.isPreload===true" ||
    condition === "true===context.isPreload" ||
    isPreloadWrapperCall;
  return (
    isPositivePreloadCheck &&
    eagerPreloadStatements(statement.thenStatement) !== undefined
  );
}

function declaredPreloadEffectHelpers(
  preloadReturn: ts.IfStatement,
  sourceFile: ts.SourceFile,
): Set<string> {
  const leadingTrivia = sourceFile.text.slice(
    preloadReturn.getFullStart(),
    preloadReturn.getStart(sourceFile),
  );
  const helpers = new Set<string>();
  for (const match of leadingTrivia.matchAll(
    /preload-effect-helpers:[ \t]*([A-Za-z0-9_.$/#, -]+)/g,
  )) {
    for (const helper of (match[1] ?? "").split(",")) {
      const trimmed = helper.trim();
      if (trimmed.length > 0) helpers.add(trimmed);
    }
  }
  return helpers;
}

function hasPreloadHandlerNote(
  preloadReturn: ts.IfStatement,
  sourceFile: ts.SourceFile,
): boolean {
  const leadingTrivia = sourceFile.text.slice(
    preloadReturn.getFullStart(),
    preloadReturn.getStart(sourceFile),
  );
  return /preload-handler-note:[ \t]*\S/.test(leadingTrivia);
}

type EffectfulHelperResolver =
  | {
      checker: ts.TypeChecker;
      effectfulSymbols: Set<ts.Symbol>;
      kind: "program";
    }
  | {
      aliases: Map<string, string>;
      effectfulNames: Set<string>;
      kind: "fallback";
    };

function effectfulReferenceName(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  resolver: EffectfulHelperResolver,
  call?: ts.CallExpression,
): string | undefined {
  if (resolver.kind === "program") {
    const symbols = call
      ? callExpressionSymbols(call, resolver.checker)
      : new Set([expressionSymbol(expression, resolver.checker)]);
    return [...symbols].some(
      (symbol) => symbol && resolver.effectfulSymbols.has(symbol),
    )
      ? expression.getText(sourceFile)
      : undefined;
  }
  const localName = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : undefined;
  if (!localName) return undefined;
  const resolvedName = resolver.aliases.get(localName) ?? localName;
  return resolver.effectfulNames.has(resolvedName)
    ? expression.getText(sourceFile)
    : undefined;
}

function collectProcessingOnlyEffectHelpers(
  root: ts.Node,
  sourceFile: ts.SourceFile,
  resolver: EffectfulHelperResolver,
): Array<{ node: ts.Node; name: string }> {
  const calls: Array<{ node: ts.Node; name: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const calledName = effectfulReferenceName(
        node.expression,
        sourceFile,
        resolver,
        node,
      );
      if (calledName) {
        calls.push({ node, name: calledName });
      }
      for (const argument of node.arguments) {
        if (
          !ts.isIdentifier(argument) &&
          !ts.isPropertyAccessExpression(argument)
        ) {
          continue;
        }
        const argumentName = effectfulReferenceName(
          argument,
          sourceFile,
          resolver,
        );
        if (argumentName) {
          calls.push({ node: argument, name: argumentName });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

function hasProcessingOnlyExemption(
  effect: DirectEffectCall,
  sourceFile: ts.SourceFile,
): boolean {
  let node: ts.Node | undefined = effect.call;
  while (node !== undefined) {
    const leadingTrivia = sourceFile.text.slice(
      node.getFullStart(),
      node.getStart(sourceFile),
    );
    if (/preload-effect-exempt:[ \t]*\S/.test(leadingTrivia)) {
      const scopedEffects = collectDirectEffectCalls(node, sourceFile);
      return (
        scopedEffects.length === 1 && scopedEffects[0]?.call === effect.call
      );
    }
    if (node === effect.statement) return false;
    node = node.parent;
  }
  return false;
}

function findEffectsHiddenBehindPreloadReturnInSource(
  sourceText: string,
  file: string,
  programAnalysis: EffectfulProgramAnalysis = effectfulProgramAnalysis,
): string[] {
  const offenders: string[] = [];
  const programSourceFile = programAnalysis.program.getSourceFile(
    path.resolve(file),
  );
  const sourceFile =
    programSourceFile?.text === sourceText
      ? programSourceFile
      : ts.createSourceFile(
          file,
          sourceText,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        );
  const helperResolver: EffectfulHelperResolver =
    sourceFile === programSourceFile
      ? {
          checker: programAnalysis.checker,
          effectfulSymbols: programAnalysis.effectfulSymbols,
          kind: "program",
        }
      : {
          aliases: importAliases(sourceFile),
          effectfulNames: deriveEffectfulHelperNames([sourceFile]),
          kind: "fallback",
        };
  const preloadWrapperResolver: PreloadWrapperResolver =
    sourceFile === programSourceFile
      ? {
          checker: programAnalysis.checker,
          kind: "program",
          preloadWrapperSymbols: programAnalysis.preloadWrapperSymbols,
        }
      : { kind: "fallback" };
  const inspectFunction = (body: ts.Block): void => {
    const preloadReturnIndexes = body.statements.flatMap((statement, index) =>
      isPositivePreloadReturn(statement, sourceFile, preloadWrapperResolver)
        ? [index]
        : [],
    );
    if (preloadReturnIndexes.length === 0) return;
    const preloadReturnIndex = preloadReturnIndexes[0];
    if (preloadReturnIndex === undefined) return;
    if (preloadReturnIndexes.length > 1) {
      const duplicate = body.statements[preloadReturnIndexes[1] ?? 0];
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        duplicate?.getStart(sourceFile) ?? body.getStart(sourceFile),
      );
      offenders.push(
        `${path.relative(packageRoot, file)}:${line + 1}:${character + 1} multiple-preload-guards`,
      );
    }

    const preloadReturn = body.statements[preloadReturnIndex];
    if (
      preloadReturn === undefined ||
      !isPositivePreloadReturn(
        preloadReturn,
        sourceFile,
        preloadWrapperResolver,
      )
    ) {
      return;
    }
    const declaredHelpers = declaredPreloadEffectHelpers(
      preloadReturn,
      sourceFile,
    );
    const statementsBeforeGuard = body.statements.slice(0, preloadReturnIndex);
    const firstEarlyReturn = statementsBeforeGuard.findIndex(
      containsReturnOutsideNestedFunction,
    );
    const preGuardHelperCalls =
      firstEarlyReturn < 0
        ? []
        : statementsBeforeGuard
            .slice(firstEarlyReturn)
            .flatMap((statement) =>
              collectProcessingOnlyEffectHelpers(
                statement,
                sourceFile,
                helperResolver,
              ),
            );
    const postGuardHelperCalls = body.statements
      .slice(preloadReturnIndex + 1)
      .flatMap((statement) =>
        collectProcessingOnlyEffectHelpers(
          statement,
          sourceFile,
          helperResolver,
        ),
      );
    const helperCalls = [...preGuardHelperCalls, ...postGuardHelperCalls];
    const actualHelperNames = new Set(helperCalls.map((call) => call.name));
    if (
      declaredHelpers.size > 0 &&
      !hasPreloadHandlerNote(preloadReturn, sourceFile)
    ) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        preloadReturn.getStart(sourceFile),
      );
      offenders.push(
        `${path.relative(packageRoot, file)}:${line + 1}:${character + 1} missing-helper-reason`,
      );
    }
    for (const helper of helperCalls) {
      if (declaredHelpers.has(helper.name)) continue;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        helper.node.getStart(sourceFile),
      );
      offenders.push(
        `${path.relative(packageRoot, file)}:${line + 1}:${character + 1} helper:${helper.name}`,
      );
    }
    for (const helper of declaredHelpers) {
      if (actualHelperNames.has(helper)) continue;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        preloadReturn.getStart(sourceFile),
      );
      offenders.push(
        `${path.relative(packageRoot, file)}:${line + 1}:${character + 1} unused-helper:${helper}`,
      );
    }
    const effects = collectDirectEffectCalls(body, sourceFile);
    const phaseEffects = collectPhaseEffectCalls(body, sourceFile, {
      includeNestedFunctions: true,
    });
    const conditionsByStart = new Map(
      phaseEffects.map((effect) => [
        effect.call.getStart(sourceFile),
        effect.conditions,
      ]),
    );
    const eagerlyReachedStatements =
      firstEarlyReturn < 0
        ? statementsBeforeGuard
        : statementsBeforeGuard.slice(0, firstEarlyReturn);
    const beforeGuardEffects = eagerlyReachedStatements.flatMap((statement) =>
      collectPhaseEffectCalls(statement, sourceFile, {
        includeEagerCallbacks: true,
      }),
    );
    const insidePreloadEffects = (
      eagerPreloadStatements(preloadReturn.thenStatement) ?? []
    ).flatMap((statement) =>
      collectPhaseEffectCalls(statement, sourceFile, {
        includeEagerCallbacks: true,
      }),
    );
    const preloadedEffects = [...beforeGuardEffects, ...insidePreloadEffects];
    const preloadedCallStarts = new Set(
      preloadedEffects.map((effect) => effect.call.getStart(sourceFile)),
    );

    for (const effect of effects) {
      const effectStart = effect.call.getStart(sourceFile);
      if (preloadedCallStarts.has(effectStart)) continue;
      const processingConditions = (
        conditionsByStart.get(effectStart) ?? ["unknown-path"]
      ).filter((condition) => !isPreloadPhaseCondition(condition));
      if (
        preloadedEffects.some(
          (preloaded) =>
            preloaded.key === effect.key &&
            conditionsCover(preloaded.conditions, processingConditions),
        )
      ) {
        continue;
      }
      if (hasProcessingOnlyExemption(effect, sourceFile)) continue;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        effect.call.getStart(sourceFile),
      );
      offenders.push(
        `${path.relative(packageRoot, file)}:${line + 1}:${character + 1} ${effect.name}`,
      );
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isArrowFunction(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node)) &&
      node.body &&
      ts.isBlock(node.body)
    ) {
      inspectFunction(node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return offenders;
}

function findEffectsHiddenBehindPreloadReturns(): string[] {
  return sourceFiles(srcRoot).flatMap((file) =>
    findEffectsHiddenBehindPreloadReturnInSource(
      readFileSync(file, "utf8"),
      file,
    ),
  );
}

function hiddenEffectNames(sourceText: string): string[] {
  const effectfulHelperPreamble = `
    async function upsertPool({ context, id }) {
      return context.effect(upsertPoolEffect, { id });
    }
    async function resolveRebalanceState({ context, id }) {
      return context.effect(resolveRebalanceStateEffect, { id });
    }
  `;
  return findEffectsHiddenBehindPreloadReturnInSource(
    `${effectfulHelperPreamble}\n${sourceText}`,
    path.join(packageRoot, "preload-effect-fixture.ts"),
  ).map((offender) => offender.slice(offender.lastIndexOf(" ") + 1));
}

type ProgramFixture = {
  fixtureFiles: Map<string, string>;
  fixtureRoot: string;
  program: ts.Program;
};

function createProgramFixture(
  files: Readonly<Record<string, string>>,
  fixtureDirectory: string,
): ProgramFixture {
  const fixtureRoot = path.join(packageRoot, fixtureDirectory);
  const fixtureFiles = new Map(
    Object.entries(files).map(([file, sourceText]) => [
      path.resolve(fixtureRoot, file),
      sourceText,
    ]),
  );
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noEmit: true,
    noLib: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(options, true);
  const defaultDirectoryExists = host.directoryExists?.bind(host);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  host.getCurrentDirectory = () => fixtureRoot;
  host.directoryExists = (directory) => {
    const absoluteDirectory = path.resolve(directory);
    return (
      absoluteDirectory === fixtureRoot ||
      absoluteDirectory.startsWith(`${fixtureRoot}${path.sep}`) ||
      (defaultDirectoryExists?.(directory) ?? false)
    );
  };
  host.fileExists = (file) =>
    fixtureFiles.has(path.resolve(file)) || defaultFileExists(file);
  host.readFile = (file) =>
    fixtureFiles.get(path.resolve(file)) ?? defaultReadFile(file);
  host.getSourceFile = (
    file,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const sourceText = fixtureFiles.get(path.resolve(file));
    return sourceText === undefined
      ? defaultGetSourceFile(
          file,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        )
      : ts.createSourceFile(
          file,
          sourceText,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        );
  };
  const program = ts.createProgram({
    host,
    options,
    rootNames: [...fixtureFiles.keys()],
  });
  const unresolvedModules = program
    .getSemanticDiagnostics()
    .filter((diagnostic) => diagnostic.code === 2307);
  if (unresolvedModules.length > 0) {
    throw new Error(
      unresolvedModules
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        )
        .join("\n"),
    );
  }
  return { fixtureFiles, fixtureRoot, program };
}

function hiddenEffectNamesInProgram(
  files: Readonly<Record<string, string>>,
  entryFile: string,
  preloadWrapperExports: ReadonlyArray<
    readonly [file: string, exportName: string]
  > = [],
): string[] {
  const { fixtureFiles, fixtureRoot, program } = createProgramFixture(
    files,
    "__preload-effect-fixtures__",
  );
  const checker = program.getTypeChecker();
  const preloadWrapperSymbols = new Set<ts.Symbol>();
  for (const [file, exportName] of preloadWrapperExports) {
    const symbol = exportedSymbol(
      program,
      checker,
      path.resolve(fixtureRoot, file),
      exportName,
    );
    if (!symbol) {
      throw new Error(
        `Missing program fixture preload wrapper ${exportName} in ${file}`,
      );
    }
    preloadWrapperSymbols.add(symbol);
  }
  const analysis = analyzeEffectfulProgram(
    program,
    (sourceFile) => fixtureFiles.has(path.resolve(sourceFile.fileName)),
    preloadWrapperSymbols,
  );
  const absoluteEntryFile = path.resolve(fixtureRoot, entryFile);
  const sourceText = fixtureFiles.get(absoluteEntryFile);
  if (sourceText === undefined) {
    throw new Error(`Missing program fixture entry ${entryFile}`);
  }
  const programEntryFile = program.getSourceFile(absoluteEntryFile);
  if (!programEntryFile || programEntryFile.text !== sourceText) {
    throw new Error(`Program did not load fixture entry ${entryFile}`);
  }
  return findEffectsHiddenBehindPreloadReturnInSource(
    sourceText,
    absoluteEntryFile,
    analysis,
  ).map((offender) => offender.slice(offender.lastIndexOf(" ") + 1));
}

function phaseCollectionNamesInProgram(
  files: Readonly<Record<string, string>>,
): string[] {
  const { fixtureFiles, fixtureRoot, program } = createProgramFixture(
    files,
    "__preload-phase-collection-fixtures__",
  );
  return findModuleCollectionMutationsReachableFromPreload(
    program,
    (sourceFile) => fixtureFiles.has(path.resolve(sourceFile.fileName)),
    fixtureRoot,
  );
}

describe("indexer code quality invariants", () => {
  it("does not hardcode mainnet-only chain iteration in source", () => {
    const mainnetPairPattern = /\[\s*(?:42220\s*,\s*143|143\s*,\s*42220)\s*\]/;
    const offenders = sourceFiles(srcRoot)
      .filter((file) => mainnetPairPattern.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(packageRoot, file));

    assert.deepEqual(offenders, []);
  });

  it("keeps preload-aware handler modules free of module-local collections", () => {
    const offenders = sourceFiles(path.join(srcRoot, "handlers")).flatMap(
      (file) =>
        moduleLocalCollectionsInPreloadAwareModule(
          readFileSync(file, "utf8"),
          path.relative(packageRoot, file),
        ),
    );

    assert.deepEqual(
      offenders,
      [],
      "Hosted Envio may run preload and processing in different workers; preload-aware handler modules must not declare module-local Set/Map state",
    );
  });

  it("keeps preload-aware handlers from mutating imported handler collections", () => {
    assert.deepEqual(
      findHandlerCollectionMutationsReachableFromPreload(),
      [],
      "Hosted Envio workers do not share module state; preload-aware handlers must not mutate module-local Set/Map state through imported handler helpers",
    );
  });

  it("detects helper-hidden phase collections without flagging locals", () => {
    assert.deepEqual(
      moduleLocalCollectionsInPreloadAwareModule(
        `
          const renamed: Set<string> = new Set();
          const cache = new globalThis.Map<string, boolean>();
          const phase = { queued: new Set<string>() };
          function remember() {
            const alias = renamed;
            alias.add("event");
            phase.queued.add("event");
          }
          function consume() {
            renamed.delete("event");
          }
          function handler(context: { isPreload: boolean }) {
            const { isPreload } = context;
            if (isPreload) remember();
            consume();
            cache.set("event", true);
            const preloadedIds = new Set<string>();
            preloadedIds.add("local");
            return preloadedIds;
          }
        `,
        "fixture.ts",
      ),
      [
        "fixture.ts renamed (Set)",
        "fixture.ts cache (Map)",
        "fixture.ts phase.queued (Set)",
      ],
    );
    assert.deepEqual(
      moduleLocalCollectionsInPreloadAwareModule(
        `
          function handler(context: { isPreload: boolean }) {
            if (context.isPreload) return;
            const warmed = new Set<string>();
            warmed.add("local");
          }
        `,
        "fixture.ts",
      ),
      [],
    );
  });

  it("follows imported helper calls to phase collections across files", () => {
    assert.deepEqual(
      phaseCollectionNamesInProgram({
        "entry.ts": `
          import { consume, remember } from "./helpers.js";
          export function handler(context: { isPreload: boolean }) {
            const { isPreload } = context;
            if (isPreload) {
              remember("event");
              return;
            }
            consume("event");
            const local = new Set<string>();
            local.add("safe");
          }
        `,
        "helpers.ts": `
          import {
            deleteState,
            writeAssignedState,
            writeCallbackState,
            writeDirectState,
            writeNestedState,
            writeParameterizedState,
            mutateLocalNestedState,
            prepareSharedAlias,
            mutateSharedAlias,
          } from "./phase-state.js";
          const unrelatedStaticLookup = new Set(["safe"]);
          export function remember(id: string) {
            writeDirectState(id);
            writeNestedState(id);
            writeParameterizedState(id);
            writeCallbackState(id);
            writeAssignedState(id);
            mutateLocalNestedState(id);
            prepareSharedAlias();
            unrelated();
          }
          export function consume(id: string) {
            deleteState(id);
            mutateSharedAlias();
          }
          export function unrelated() {
            return unrelatedStaticLookup.has("safe");
          }
        `,
        "phase-state.ts": `
          interface NestedState {
            remembered: Set<string>;
          }
          const directState = new Set<string>();
          const nestedState: NestedState = { remembered: new Set<string>() };
          const moduleLookup: NestedState = { remembered: new Set<string>() };
          const parameterState = new Set<string>();
          const callbackState = new Map<string, boolean>();
          const assignmentState = new Set<string>();
          const sharedAliasState = new Set<string>();
          const unrelatedPathState = new Set<string>();
          let sharedAlias: Set<string> | undefined;
          function mutate(target: Set<string>, id: string) {
            target.add(id);
          }
          export function writeDirectState(id: string) {
            directState.add(id);
          }
          export function writeNestedState(id: string) {
            const { remembered } = nestedState;
            remembered.add(id);
          }
          export function mutateLocalNestedState(id: string) {
            const local: NestedState = { remembered: new Set<string>() };
            local.remembered.add(id);
            moduleLookup.remembered.has(id);
          }
          export function writeParameterizedState(id: string) {
            mutate(parameterState, id);
          }
          export function writeCallbackState(id: string) {
            [id].forEach((item) => callbackState.set(item, true));
          }
          export function writeAssignedState(id: string) {
            let alias: Set<string>;
            alias = assignmentState;
            alias.add(id);
          }
          export function deleteState(id: string) {
            directState.delete(id);
          }
          export function prepareSharedAlias() {
            sharedAlias = sharedAliasState;
          }
          export function mutateSharedAlias() {
            sharedAlias?.delete("event");
          }
          export function mutateOnlyOutsideThePreloadGraph() {
            mutate(unrelatedPathState, "unrelated");
          }
        `,
        "bracket-entry.ts": `
          import { writeBracketState } from "./bracket-state.js";
          export function bracketHandler(context: { isPreload: boolean }) {
            if (context["isPreload"]) writeBracketState("event");
          }
        `,
        "bracket-state.ts": `
          const bracketState = new Set<string>();
          export function writeBracketState(id: string) {
            bracketState.add(id);
          }
        `,
      }),
      [
        "bracket-state.ts bracketState (Set)",
        "phase-state.ts assignmentState (Set)",
        "phase-state.ts callbackState (Map)",
        "phase-state.ts directState (Set)",
        "phase-state.ts nestedState.remembered (Set)",
        "phase-state.ts parameterState (Set)",
        "phase-state.ts sharedAliasState (Set)",
      ],
    );
  });

  it("keeps multi-field Envio getWhere calls chain-scoped or pool-scoped", () => {
    assert.deepEqual(findUnsafeMultiFieldGetWhereCalls(), []);
  });

  it("preloads direct effects before returning from Envio's preload pass", () => {
    assert.deepEqual(
      findEffectsHiddenBehindPreloadReturns(),
      [],
      "Preload the identical effect key before/in the preload guard; otherwise annotate each direct effect and declare every processing-only effectful helper with an ordered-state or bounded-cardinality reason",
    );
  });

  it("classifies preload effects by executable branch rather than source position", () => {
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          const warmed = context.effect(beforeGuardEffect, { id });
          if (context.isPreload) {
            await warmed;
            return;
          }
          await warmed;
        }
      `),
      [],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, warmIds, otherIds) {
          if (context.isPreload) {
            await Promise.all(
              warmIds.map((id) =>
                context.effect(mappedCollectionEffect, { id }),
              ),
            );
            return;
          }
          await Promise.all(
            otherIds.map((id) =>
              context.effect(mappedCollectionEffect, { id }),
            ),
          );
        }
      `),
      ["mappedCollectionEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (context.isPreload) {
            await context.effect(insideGuardEffect, { id });
            return;
          }
          await context.effect(insideGuardEffect, { id });
        }
      `),
      [],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (await maybePreloadPool(context, id)) return;
          await context.effect(wrapperGuardEffect, { id });
        }
      `),
      ["wrapperGuardEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, breakerId, configId) {
          if (await maybePreloadBreaker(context, breakerId, configId)) return;
          await context.effect(breakerWrapperGuardEffect, { breakerId });
        }
      `),
      ["breakerWrapperGuardEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          // preload-handler-note: ordered state must include prior batch writes
          if (await maybePreloadPool(context, id)) return;
          await context.effect(wrapperGuardException, { id });
        }
      `),
      ["wrapperGuardException"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (await maybePreloadPool(context, id)) return;
          await upsertPool({ context, id });
        }
      `),
      ["helper:upsertPool"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          // preload-handler-note: ordered state must include prior writes
          // preload-effect-helpers: upsertPool
          if (await maybePreloadPool(context, id)) return;
          await upsertPool({ context, id });
          await pureHelper(id);
        }
      `),
      [],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          // preload-handler-note: ordered state must include prior writes
          // preload-effect-helpers: upsertPool, resolveRebalanceState
          if (await maybePreloadPool(context, id)) return;
          await upsertPool({ context, id });
        }
      `),
      ["unused-helper:resolveRebalanceState"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          // preload-handler-note:
          // preload-effect-helpers: upsertPool
          if (await maybePreloadPool(context, id)) return;
          await upsertPool({ context, id });
        }
      `),
      ["missing-helper-reason"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          // preload-handler-note: ordered state must include prior writes
          // preload-effect-helpers: upsertPool
          if (await maybePreloadPool(context, id)) return;
          await upsertPool({ context, id });
          await context.effect(newUnannotatedEffect, { id });
        }
      `),
      ["newUnannotatedEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (await (maybePreloadPool(context, id))) return;
          await context.effect(parenthesizedWrapperEffect, { id });
        }
      `),
      ["parenthesizedWrapperEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (context.isPreload) return;
          await pureHelper(id);
          if (await maybePreloadPool(context, id)) return;
        }
      `),
      ["multiple-preload-guards"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if ((await maybePreloadPool(context, id)) === false) return;
          await context.effect(negativeWrapperConditionEffect, { id });
        }
      `),
      [],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if ((await maybePreloadPool(context, id)) && enabled) return;
          await context.effect(compoundWrapperConditionEffect, { id });
        }
      `),
      [],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (await helpers.maybePreloadPool(context, id)) return;
          await context.effect(propertyWrapperConditionEffect, { id });
        }
      `),
      [],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (context.isPreload) return;
          await context.effect(afterGuardEffect, { id });
        }
      `),
      ["afterGuardEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          const entity = await context.Pool.get(id);
          if (!entity) return;
          const warmed = context.effect(afterEntityReturnEffect, { id });
          if (context.isPreload) {
            await warmed;
            return;
          }
          await warmed;
        }
      `),
      ["afterEntityReturnEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          const entity = await context.Pool.get(id);
          if (!entity) return;
          const warmed = upsertPool({ context, id });
          if (context.isPreload) {
            await warmed;
            return;
          }
          await warmed;
        }
      `),
      ["helper:upsertPool"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (!isTrackedEvent(id)) return;
          const warmed = upsertPool({ context, id });
          // preload-handler-note: the event-only filter is phase-stable and the effect is awaited in preload
          // preload-effect-helpers: upsertPool
          if (context.isPreload) {
            await warmed;
            return;
          }
          await warmed;
        }
      `),
      [],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (context.isPreload) {
            return;
          } else {
            await context.effect(elseBranchEffect, { id });
          }
        }
      `),
      ["elseBranchEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          const warmed = context.effect(keyedEffect, { id });
          if (context.isPreload) {
            await warmed;
            return;
          }
          await context.effect(keyedEffect, { id, attempt: 1 });
        }
      `),
      ["keyedEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          const load = async () => context.effect(nestedFunctionEffect, { id });
          if (context.isPreload) return;
          await load();
        }
      `),
      ["helper:load", "nestedFunctionEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (context.isPreload) {
            const declaredOnly = async () =>
              context.effect(nestedPreloadBranchEffect, { id });
            void declaredOnly;
            return;
          }
          await context.effect(nestedPreloadBranchEffect, { id });
        }
      `),
      ["nestedPreloadBranchEffect", "nestedPreloadBranchEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (false) context.effect(conditionallyBeforeEffect, { id });
          if (context.isPreload) return;
          await context.effect(conditionallyBeforeEffect, { id });
        }
      `),
      ["conditionallyBeforeEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (context.isPreload) {
            if (false) context.effect(conditionallyInsideEffect, { id });
            return;
          }
          await context.effect(conditionallyInsideEffect, { id });
        }
      `),
      ["conditionallyInsideEffect"],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, ids) {
          if (context.isPreload) {
            await Promise.all(
              ids.map((id) => context.effect(mappedEffect, { id })),
            );
            return;
          }
          await Promise.all(
            ids.map((id) => context.effect(mappedEffect, { id })),
          );
        }
      `),
      [],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (context.isPreload) return;
          // preload-effect-exempt: one call for a configured bootstrap block
          await context.effect(boundedEffect, { id });
        }
      `),
      [],
    );
    assert.deepEqual(
      hiddenEffectNames(`
        async function handler(context, id) {
          if (context.isPreload) return;
          await Promise.all([
            // preload-effect-exempt: one bounded bootstrap call
            context.effect(boundedSiblingEffect, { id }),
            context.effect(unboundedSiblingEffect, { id }),
          ]);
        }
      `),
      ["unboundedSiblingEffect"],
    );
  });

  it("resolves effectful helpers across renamed imports and re-exports", () => {
    const sharedFiles = {
      "effect-source.ts": `
        export async function duplicateName({ context, id }) {
          return context.effect(remoteEffect, { id });
        }
      `,
      "barrel.ts": `
        export { duplicateName as throughBarrel } from "./effect-source";
      `,
      "pure-source.ts": `
        export async function duplicateName(id) {
          return id;
        }
      `,
    };
    assert.deepEqual(
      hiddenEffectNamesInProgram(
        {
          ...sharedFiles,
          "handler.ts": `
            import { throughBarrel as renamedEffectful } from "./barrel";
            import { duplicateName as sameTextPure } from "./pure-source";

            export async function handlerMissingDeclaration(context, id) {
              if (context.isPreload) return;
              await renamedEffectful({ context, id });
              await sameTextPure(id);
            }

            export async function handlerDeclared(context, id) {
              // preload-handler-note: ordered state requires processing-only RPC
              // preload-effect-helpers: renamedEffectful
              if (context.isPreload) return;
              await renamedEffectful({ context, id });
              await sameTextPure(id);
            }
          `,
        },
        "handler.ts",
      ),
      ["helper:renamedEffectful"],
    );
  }, 30_000);

  it("recognizes exact preload-wrapper symbols only on positive returns", () => {
    const wrapperFiles = {
      "wrappers.ts": `
        export async function maybePreloadPool(context, poolId) {
          return context.isPreload && poolId !== undefined;
        }
        export async function maybePreloadBreaker(
          context,
          breakerId,
          configId = undefined,
        ) {
          return context.isPreload && breakerId !== configId;
        }
      `,
      "wrapper-barrel.ts": `
        export {
          maybePreloadPool,
          maybePreloadBreaker,
        } from "./wrappers";
      `,
    };
    const wrapperExports = [
      ["wrappers.ts", "maybePreloadPool"],
      ["wrappers.ts", "maybePreloadBreaker"],
    ] as const;
    assert.deepEqual(
      hiddenEffectNamesInProgram(
        {
          ...wrapperFiles,
          "handler.ts": `
            import {
              maybePreloadBreaker,
              maybePreloadBreaker as preloadBreaker,
            } from "./wrapper-barrel";
            import * as preload from "./wrapper-barrel";

            export async function renamedWrapperHandler(context, breakerId) {
              if (await preloadBreaker(context, breakerId)) return;
              await context.effect(renamedWrapperEffect, { breakerId });
            }

            export async function propertyWrapperHandler(context, poolId) {
              if (await preload.maybePreloadPool(context, poolId)) return;
              await context.effect(propertyWrapperEffect, { poolId });
            }

            export async function compoundWrapperHandler(context, breakerId) {
              if ((await maybePreloadBreaker(context, breakerId)) && enabled) {
                return;
              }
              await context.effect(compoundWrapperEffect, { breakerId });
            }
          `,
        },
        "handler.ts",
        wrapperExports,
      ),
      ["renamedWrapperEffect", "propertyWrapperEffect"],
    );
  }, 30_000);

  it("keeps event IDs collision-resistant within a same-block write batch", () => {
    assert.equal(eventId(42220, 123, 4), "42220_123_4");
    assert.notEqual(eventId(42220, 123, 4), eventId(143, 123, 4));
    assert.notEqual(eventId(42220, 123, 4), eventId(42220, 124, 4));
    assert.notEqual(eventId(42220, 123, 4), eventId(42220, 123, 5));
    assert.equal(asBigInt(123), 123n);
  });

  it("derives the same collision-resistant ID from an event's identity fields", () => {
    const event = { chainId: 42220, block: { number: 123 }, logIndex: 4 };
    assert.equal(eventIdFromEvent(event), eventId(42220, 123, 4));
    assert.notEqual(
      eventIdFromEvent(event),
      eventIdFromEvent({ ...event, logIndex: 5 }),
    );
  });

  it("keeps pool IDs chain-namespaced and lowercased", () => {
    const poolId = makePoolId(
      42220,
      "0xABCDEF0000000000000000000000000000000001",
    );

    assert.equal(poolId, "42220-0xabcdef0000000000000000000000000000000001");
    assert.equal(
      extractAddressFromPoolId(poolId),
      "0xabcdef0000000000000000000000000000000001",
    );
    assert.throws(
      () =>
        extractAddressFromPoolId("0xabcdef0000000000000000000000000000000001"),
      /Expected namespaced pool ID/,
    );
    assert.throws(
      () =>
        extractAddressFromPoolId(
          "prefix-42220-0xabcdef0000000000000000000000000000000001",
        ),
      /Expected namespaced pool ID/,
    );
    assert.throws(
      () =>
        extractAddressFromPoolId(
          "42220-42220-0xabcdef0000000000000000000000000000000001",
        ),
      /Possible double-namespacing/,
    );
  });

  it("keeps snapshot IDs anchored to the chain-namespaced pool ID", () => {
    const poolId = makePoolId(
      42220,
      "0xABCDEF0000000000000000000000000000000001",
    );

    assert.equal(
      snapshotId(poolId, 1_700_000_000n),
      "42220-0xabcdef0000000000000000000000000000000001-1700000000",
    );
    assert.equal(
      dailySnapshotId(poolId, 1_699_977_600n),
      "42220-0xabcdef0000000000000000000000000000000001-1699977600",
    );
  });

  it("keeps UTC hour/day buckets as floor operations", () => {
    assert.equal(hourBucket(3_599n), 0n);
    assert.equal(hourBucket(3_600n), 3_600n);
    assert.equal(hourBucket(3_601n), 3_600n);

    assert.equal(dayBucket(86_399n), 0n);
    assert.equal(dayBucket(86_400n), 86_400n);
    assert.equal(dayBucket(86_401n), 86_400n);
  });
});
