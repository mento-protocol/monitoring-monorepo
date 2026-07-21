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

function hiddenEffectNamesInProgram(
  files: Readonly<Record<string, string>>,
  entryFile: string,
  preloadWrapperExports: ReadonlyArray<
    readonly [file: string, exportName: string]
  > = [],
): string[] {
  const fixtureRoot = path.join(packageRoot, "__preload-effect-fixtures__");
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

describe("indexer code quality invariants", () => {
  it("does not hardcode mainnet-only chain iteration in source", () => {
    const mainnetPairPattern = /\[\s*(?:42220\s*,\s*143|143\s*,\s*42220)\s*\]/;
    const offenders = sourceFiles(srcRoot)
      .filter((file) => mainnetPairPattern.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(packageRoot, file));

    assert.deepEqual(offenders, []);
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

            export async function handler(context, id) {
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
    assert.deepEqual(
      hiddenEffectNamesInProgram(
        {
          ...sharedFiles,
          "handler.ts": `
            import { throughBarrel as renamedEffectful } from "./barrel";
            import { duplicateName as sameTextPure } from "./pure-source";

            export async function handler(context, id) {
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
      [],
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
              maybePreloadBreaker as preloadBreaker,
            } from "./wrapper-barrel";

            export async function handler(context, breakerId) {
              if (await preloadBreaker(context, breakerId)) return;
              await context.effect(renamedWrapperEffect, { breakerId });
            }
          `,
        },
        "handler.ts",
        wrapperExports,
      ),
      ["renamedWrapperEffect"],
    );
    assert.deepEqual(
      hiddenEffectNamesInProgram(
        {
          ...wrapperFiles,
          "handler.ts": `
            import * as preload from "./wrapper-barrel";

            export async function handler(context, poolId) {
              if (await preload.maybePreloadPool(context, poolId)) return;
              await context.effect(propertyWrapperEffect, { poolId });
            }
          `,
        },
        "handler.ts",
        wrapperExports,
      ),
      ["propertyWrapperEffect"],
    );
    assert.deepEqual(
      hiddenEffectNamesInProgram(
        {
          ...wrapperFiles,
          "handler.ts": `
            import { maybePreloadBreaker } from "./wrapper-barrel";

            export async function handler(context, breakerId) {
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
      [],
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
