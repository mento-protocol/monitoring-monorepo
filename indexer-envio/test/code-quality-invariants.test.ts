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

function isPositivePreloadReturn(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): statement is ts.IfStatement {
  if (!ts.isIfStatement(statement)) return false;
  const condition = compactNodeText(statement.expression, sourceFile);
  const isPositivePreloadCheck =
    condition === "context.isPreload" ||
    condition === "context.isPreload===true" ||
    condition === "true===context.isPreload";
  return (
    isPositivePreloadCheck &&
    eagerPreloadStatements(statement.thenStatement) !== undefined
  );
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
    if (/preload-effect-exempt:\s*\S/.test(leadingTrivia)) {
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
): string[] {
  const offenders: string[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inspectFunction = (body: ts.Block): void => {
    const preloadReturnIndex = body.statements.findIndex((statement) =>
      isPositivePreloadReturn(statement, sourceFile),
    );
    if (preloadReturnIndex < 0) return;

    const preloadReturn = body.statements[preloadReturnIndex];
    if (
      preloadReturn === undefined ||
      !isPositivePreloadReturn(preloadReturn, sourceFile)
    ) {
      return;
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
    const beforeGuardEffects = body.statements
      .slice(0, preloadReturnIndex)
      .flatMap((statement) =>
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
  return findEffectsHiddenBehindPreloadReturnInSource(
    sourceText,
    path.join(packageRoot, "preload-effect-fixture.ts"),
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
      "Preload the identical effect key before/in the preload guard, or add an adjacent preload-effect-exempt comment with a bounded-cardinality reason",
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
          if (context.isPreload) return;
          await context.effect(afterGuardEffect, { id });
        }
      `),
      ["afterGuardEffect"],
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
      ["nestedFunctionEffect"],
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
