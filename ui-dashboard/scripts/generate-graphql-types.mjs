#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSchema,
  FieldsOnCorrectTypeRule,
  getNamedType,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  Kind,
  parse,
  ScalarLeafsRule,
  validate,
  visit,
} from "graphql";
import ts from "typescript";

const DASHBOARD_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPO_ROOT = path.resolve(DASHBOARD_ROOT, "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "indexer-envio", "schema.graphql");
const STUBS_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "envio-schema-stubs.graphql",
);
const OUTPUT_PATH = path.join(
  DASHBOARD_ROOT,
  "src",
  "lib",
  "__generated__",
  "graphql.ts",
);

const DOCUMENT_SOURCES = [
  "src/lib/bridge-queries.ts",
  "src/lib/queries/broker.ts",
  "src/lib/queries/config.ts",
  "src/lib/queries/liquity.ts",
  "src/lib/queries/lp.ts",
  "src/lib/queries/ols.ts",
  "src/lib/queries/pool-detail.ts",
  "src/lib/queries/pool-detail-schemas.ts",
  "src/lib/queries/pools.ts",
  "src/lib/queries/protocol.ts",
  "src/lib/queries/reserve-yield.ts",
  "src/lib/queries/stables.ts",
  "src/lib/queries/volume.ts",
  "src/lib/queries/volume-schemas.ts",
  "src/lib/queries/volume-via.ts",
];

const MIN_OPERATION_COUNT = 100;
const CONTRACT_RULES = [FieldsOnCorrectTypeRule, ScalarLeafsRule];
const moduleCache = new Map();

function propertyName(name) {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function quoted(value) {
  return JSON.stringify(value);
}

function pascalCase(value) {
  return value
    .split(/[_\W]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function inputTypeName(graphqlName) {
  if (graphqlName === "order_by") return "OrderBy";
  if (graphqlName.endsWith("_bool_exp")) {
    return `${graphqlName.slice(0, -"_bool_exp".length)}BoolExp`;
  }
  if (graphqlName.endsWith("_order_by")) {
    return `${graphqlName.slice(0, -"_order_by".length)}OrderBy`;
  }
  if (graphqlName.endsWith("_select_column")) {
    return `${graphqlName.slice(0, -"_select_column".length)}SelectColumn`;
  }
  return pascalCase(graphqlName);
}

function scalarType(name) {
  switch (name) {
    case "Boolean":
      return "boolean";
    case "Float":
    case "Int":
      return "number";
    case "BigInt":
    case "Bytes":
    case "ID":
    case "String":
    case "numeric":
      return "string";
    default:
      return "unknown";
  }
}

function inputScalarType(name) {
  if (name === "numeric") return "number | string";
  return scalarType(name);
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
    return null;
  }
  const withoutAlias = specifier.startsWith("@/")
    ? path.join(DASHBOARD_ROOT, "src", specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    withoutAlias,
    `${withoutAlias}.ts`,
    `${withoutAlias}.tsx`,
    path.join(withoutAlias, "index.ts"),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error(`Cannot resolve import ${specifier} from ${fromFile}`);
  }
  return match;
}

function loadModule(filePath) {
  const normalized = path.resolve(filePath);
  const cached = moduleCache.get(normalized);
  if (cached) return cached;

  const sourceText = readFileSync(normalized, "utf8");
  const sourceFile = ts.createSourceFile(
    normalized,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const mod = {
    filePath: normalized,
    constants: new Map(),
    imports: new Map(),
    sourceFile,
  };
  moduleCache.set(normalized, mod);

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const importedFile = resolveImport(
        normalized,
        statement.moduleSpecifier.text,
      );
      if (importedFile == null) continue;
      for (const element of statement.importClause.namedBindings.elements) {
        mod.imports.set(element.name.text, {
          exportedName: element.propertyName?.text ?? element.name.text,
          filePath: importedFile,
        });
      }
    }

    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        mod.constants.set(declaration.name.text, declaration.initializer);
      }
    }
  }

  return mod;
}

function isExportedConst(statement, declaration) {
  if (!ts.isIdentifier(declaration.name)) return false;
  if (!ts.isVariableStatement(statement)) return false;
  return statement.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function evalExpression(expr, mod, env = new Map()) {
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return evalExpression(expr.expression, mod, env);
  }
  if (ts.isParenthesizedExpression(expr)) {
    return evalExpression(expr.expression, mod, env);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  if (ts.isNumericLiteral(expr)) {
    return Number(expr.text);
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.map((element) => evalExpression(element, mod, env));
  }
  if (ts.isTemplateExpression(expr)) {
    return expr.templateSpans.reduce((acc, span) => {
      const value = evalExpression(span.expression, mod, env);
      return `${acc}${String(value)}${span.literal.text}`;
    }, expr.head.text);
  }
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return `${String(evalExpression(expr.left, mod, env))}${String(
      evalExpression(expr.right, mod, env),
    )}`;
  }
  if (ts.isIdentifier(expr)) {
    if (env.has(expr.text)) return env.get(expr.text);
    if (mod.constants.has(expr.text)) {
      return evalExpression(mod.constants.get(expr.text), mod, env);
    }
    const imported = mod.imports.get(expr.text);
    if (imported) {
      const importedMod = loadModule(imported.filePath);
      const importedExpr = importedMod.constants.get(imported.exportedName);
      if (!importedExpr) {
        throw new Error(
          `Cannot find exported const ${imported.exportedName} in ${imported.filePath}`,
        );
      }
      return evalExpression(importedExpr, importedMod);
    }
  }
  if (ts.isArrowFunction(expr)) {
    return { kind: "function", node: expr, mod };
  }
  if (ts.isCallExpression(expr)) {
    return evalCallExpression(expr, mod, env);
  }

  throw new Error(
    `Unsupported expression in ${path.relative(REPO_ROOT, mod.filePath)}: ${expr.getText(mod.sourceFile)}`,
  );
}

function evalCallExpression(expr, mod, env) {
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const receiver = evalExpression(expr.expression.expression, mod, env);
    const method = expr.expression.name.text;
    if (method === "join" && Array.isArray(receiver)) {
      const separator =
        expr.arguments.length > 0
          ? String(evalExpression(expr.arguments[0], mod, env))
          : ",";
      return receiver.join(separator);
    }
    if (method === "map" && Array.isArray(receiver)) {
      const callback = evalExpression(expr.arguments[0], mod, env);
      if (callback?.kind !== "function") {
        throw new Error("Only arrow callbacks are supported for query map()");
      }
      return receiver.map((item) => {
        const nextEnv = new Map(env);
        const [param] = callback.node.parameters;
        if (!param || !ts.isIdentifier(param.name)) {
          throw new Error("Only single-identifier map callbacks are supported");
        }
        nextEnv.set(param.name.text, item);
        if (!ts.isExpression(callback.node.body)) {
          throw new Error("Only expression-bodied map callbacks are supported");
        }
        return evalExpression(callback.node.body, callback.mod, nextEnv);
      });
    }
    throw new Error(
      `Unsupported method ".${method}" in ${path.relative(
        REPO_ROOT,
        mod.filePath,
      )}: only .join() and .map() are supported`,
    );
  }

  const callee = evalExpression(expr.expression, mod, env);
  if (callee?.kind === "function") {
    const nextEnv = new Map();
    callee.node.parameters.forEach((param, index) => {
      if (!ts.isIdentifier(param.name)) {
        throw new Error("Only identifier function parameters are supported");
      }
      nextEnv.set(
        param.name.text,
        evalExpression(expr.arguments[index], mod, env),
      );
    });
    if (!ts.isExpression(callee.node.body)) {
      throw new Error("Only expression-bodied helper functions are supported");
    }
    return evalExpression(callee.node.body, callee.mod, nextEnv);
  }

  throw new Error(
    `Unsupported call in ${path.relative(REPO_ROOT, mod.filePath)}: ${expr.getText(mod.sourceFile)}`,
  );
}

function exportedQueryStrings() {
  const queries = [];
  for (const source of DOCUMENT_SOURCES) {
    const filePath = path.join(DASHBOARD_ROOT, source);
    const mod = loadModule(filePath);
    for (const statement of mod.sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          !isExportedConst(statement, declaration) ||
          !declaration.initializer
        ) {
          continue;
        }
        const exportName = declaration.name.text;
        if (!/^[A-Z0-9_]+$/.test(exportName)) continue;
        const value = evalExpression(declaration.initializer, mod);
        if (
          typeof value === "string" &&
          /\bquery\s+[A-Za-z0-9_]+/.test(value)
        ) {
          queries.push({
            exportName,
            moduleName: source.replace(/^src\/lib\//, "").replace(/\.ts$/, ""),
            source,
            value,
          });
        }
      }
    }
  }
  return queries;
}

function buildDashboardSchema() {
  const stubs = readFileSync(STUBS_PATH, "utf8");
  const sdl = readFileSync(SCHEMA_PATH, "utf8");
  const entityFields = new Map();
  for (const def of parse(sdl).definitions) {
    if (def.kind === Kind.OBJECT_TYPE_DEFINITION) {
      entityFields.set(
        def.name.value,
        new Set((def.fields ?? []).map((field) => field.name.value)),
      );
    }
  }
  const entityNames = [...entityFields.keys()];
  const querySdl = `type Query {\n${entityNames
    .map(
      (name) => `  ${name}: [${name}!]!\n  ${name}_by_pk(id: String!): ${name}`,
    )
    .join("\n")}\n}`;
  return {
    entityFields,
    entityNames,
    schema: buildSchema(`${stubs}${sdl}\n${querySdl}`),
  };
}

function checkField(name, fields, entity, where, errors) {
  if (!fields.has(name)) {
    errors.push(
      `${where} references "${entity}.${name}" - not a field on ${entity}`,
    );
  }
}

function forEachBoolExp(value, fn) {
  if (value.kind === Kind.LIST) {
    for (const item of value.values) {
      if (item.kind === Kind.OBJECT) fn(item);
    }
  } else if (value.kind === Kind.OBJECT) {
    fn(value);
  }
}

function checkBoolExp(value, fields, entity, errors) {
  if (value.kind !== Kind.OBJECT) return;
  for (const field of value.fields) {
    const key = field.name.value;
    if (key === "_and" || key === "_or") {
      forEachBoolExp(field.value, (obj) =>
        checkBoolExp(obj, fields, entity, errors),
      );
    } else if (key === "_not") {
      checkBoolExp(field.value, fields, entity, errors);
    } else if (!key.startsWith("_")) {
      checkField(key, fields, entity, "where", errors);
    }
  }
}

function checkOrderBy(value, fields, entity, errors) {
  const objects = value.kind === Kind.LIST ? value.values : [value];
  for (const object of objects) {
    if (object.kind !== Kind.OBJECT) continue;
    for (const field of object.fields) {
      checkField(field.name.value, fields, entity, "order_by", errors);
    }
  }
}

function checkDistinctOn(value, fields, entity, errors) {
  const values = value.kind === Kind.LIST ? value.values : [value];
  for (const valueNode of values) {
    if (valueNode.kind === Kind.ENUM) {
      checkField(valueNode.value, fields, entity, "distinct_on", errors);
    }
  }
}

function checkArgumentFields(queryAst, entityFields) {
  const errors = [];
  visit(queryAst, {
    Field(node) {
      const fields = entityFields.get(node.name.value);
      if (!fields || !node.arguments) return;
      const entity = node.name.value;
      for (const arg of node.arguments) {
        if (arg.name.value === "where") {
          checkBoolExp(arg.value, fields, entity, errors);
        } else if (arg.name.value === "order_by") {
          checkOrderBy(arg.value, fields, entity, errors);
        } else if (arg.name.value === "distinct_on") {
          checkDistinctOn(arg.value, fields, entity, errors);
        }
      }
    },
  });
  return errors;
}

function validateOperation(schemaInfo, query) {
  const ast = parse(query.value);
  const outputErrors = validate(schemaInfo.schema, ast, CONTRACT_RULES);
  const argErrors = checkArgumentFields(ast, schemaInfo.entityFields);
  const errors = [...outputErrors.map((error) => error.message), ...argErrors];
  if (errors.length > 0) {
    throw new Error(
      `${query.moduleName}.${query.exportName} does not match indexer-envio/schema.graphql:\n` +
        errors.map((error) => `  - ${error}`).join("\n"),
    );
  }
  return ast;
}

function namedInputTypeToTs(name) {
  if (
    name.endsWith("_bool_exp") ||
    name.endsWith("_order_by") ||
    name.endsWith("_select_column") ||
    name === "order_by"
  ) {
    return inputTypeName(name);
  }
  return inputScalarType(name) === "unknown"
    ? inputTypeName(name)
    : inputScalarType(name);
}

function variableTypeNodeToTs(node, nullable = true) {
  if (node.kind === Kind.NON_NULL_TYPE) {
    return variableTypeNodeToTs(node.type, false);
  }
  let valueType;
  if (node.kind === Kind.LIST_TYPE) {
    valueType = `ReadonlyArray<${variableTypeNodeToTs(node.type)}>`;
  } else {
    valueType = namedInputTypeToTs(node.name.value);
  }
  return nullable ? `${valueType} | null` : valueType;
}

function variableDefinitionsToTs(variableDefinitions) {
  if (!variableDefinitions || variableDefinitions.length === 0) {
    return "Record<string, never>";
  }
  const lines = ["{"];
  for (const def of variableDefinitions) {
    const required = def.type.kind === Kind.NON_NULL_TYPE;
    const suffix = required ? "" : "?";
    lines.push(
      `  readonly ${propertyName(def.variable.name.value)}${suffix}: ${variableTypeNodeToTs(def.type)};`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}

function typeAlias(name, value) {
  const line = `export type ${name} = ${value};`;
  return line.length <= 80 ? line : `export type ${name} =\n${value};`;
}

function unionType(values) {
  if (values.length === 0) return "never";
  const oneLine = values.join(" | ");
  if (values.length <= 3 && oneLine.length <= 56) return oneLine;
  return values.map((value) => `  | ${value}`).join("\n");
}

function recursiveBoolExpProperty(entityName, key) {
  const oneLine = `  readonly ${key}?: ${entityName}BoolExp | ReadonlyArray<${entityName}BoolExp>;`;
  if (oneLine.length <= 80) return [oneLine];
  return [
    `  readonly ${key}?:`,
    `    | ${entityName}BoolExp`,
    `    | ReadonlyArray<${entityName}BoolExp>;`,
  ];
}

function enumTypes(schema) {
  return Object.values(schema.getTypeMap())
    .filter((type) => isEnumType(type) && !type.name.startsWith("__"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((type) =>
      typeAlias(
        type.name,
        unionType(type.getValues().map((value) => quoted(value.name))),
      ),
    );
}

function comparisonTypeFor(type) {
  const named = getNamedType(type);
  if (isEnumType(named)) return named.name;
  if (isScalarType(named)) return inputScalarType(named.name);
  return null;
}

function entityInputTypes(schema, entityNames) {
  const chunks = [
    typeAlias(
      "OrderBy",
      unionType([
        '"asc"',
        '"asc_nulls_first"',
        '"asc_nulls_last"',
        '"desc"',
        '"desc_nulls_first"',
        '"desc_nulls_last"',
      ]),
    ),
    "",
    "export type ComparisonExp<T> = {",
    "  readonly _eq?: T | null;",
    "  readonly _neq?: T | null;",
    "  readonly _gt?: T | null;",
    "  readonly _gte?: T | null;",
    "  readonly _lt?: T | null;",
    "  readonly _lte?: T | null;",
    "  readonly _in?: ReadonlyArray<T> | null;",
    "  readonly _nin?: ReadonlyArray<T> | null;",
    "  readonly _like?: string | null;",
    "  readonly _nlike?: string | null;",
    "  readonly _ilike?: string | null;",
    "  readonly _nilike?: string | null;",
    "  readonly _regex?: string | null;",
    "  readonly _nregex?: string | null;",
    "  readonly _is_null?: boolean | null;",
    "};",
  ];

  for (const entityName of entityNames.sort((a, b) => a.localeCompare(b))) {
    const type = schema.getType(entityName);
    if (!isObjectType(type)) continue;
    const fields = Object.values(type.getFields()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const columnFields = fields.filter(
      (field) => comparisonTypeFor(field.type) != null,
    );
    chunks.push(
      "",
      typeAlias(
        `${entityName}SelectColumn`,
        unionType(columnFields.map((field) => quoted(field.name))),
      ),
      "",
      `export type ${entityName}OrderBy = {`,
      ...columnFields.map(
        (field) => `  readonly ${propertyName(field.name)}?: OrderBy;`,
      ),
      "};",
      "",
      `export type ${entityName}BoolExp = {`,
      ...recursiveBoolExpProperty(entityName, "_and"),
      ...recursiveBoolExpProperty(entityName, "_or"),
      `  readonly _not?: ${entityName}BoolExp;`,
      ...columnFields.map(
        (field) =>
          `  readonly ${propertyName(field.name)}?: ComparisonExp<${comparisonTypeFor(
            field.type,
          )}>;`,
      ),
      "};",
    );
  }

  return chunks;
}

function getFieldDefinition(schema, parentType, fieldName) {
  if (!isObjectType(parentType)) {
    throw new Error(
      `Cannot select ${fieldName} on non-object ${parentType.name}`,
    );
  }
  if (fieldName === "__typename") {
    return { type: schema.getType("String"), forceNonNull: true };
  }
  if (parentType.name === "Query" && fieldName === "__type") {
    return { type: schema.getType("__Type"), forceNullable: true };
  }
  if (parentType.name === "Query" && fieldName === "__schema") {
    return { type: schema.getType("__Schema") };
  }
  const field = parentType.getFields()[fieldName];
  if (!field) {
    throw new Error(`Unknown field ${parentType.name}.${fieldName}`);
  }
  return { type: field.type };
}

function typeToTs(schema, type, selectionSet, indent, forceNullable = false) {
  const value = isNonNullType(type)
    ? nonNullableTypeToTs(schema, type.ofType, selectionSet, indent)
    : `${nonNullableTypeToTs(schema, type, selectionSet, indent)} | null`;
  return forceNullable && !value.endsWith(" | null")
    ? `${value} | null`
    : value;
}

function nonNullableTypeToTs(schema, type, selectionSet, indent) {
  if (isListType(type)) {
    return `ReadonlyArray<${typeToTs(schema, type.ofType, selectionSet, indent)}>`;
  }
  const named = getNamedType(type);
  if (isScalarType(named)) return scalarType(named.name);
  if (isEnumType(named)) return named.name;
  if (isObjectType(named)) {
    if (!selectionSet) return "Record<string, unknown>";
    return selectionSetToTs(schema, named, selectionSet, indent);
  }
  return "unknown";
}

function selectionSetToTs(schema, parentType, selectionSet, indent) {
  const pad = " ".repeat(indent);
  const childPad = " ".repeat(indent + 2);
  const lines = ["{"];
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const fieldName = selection.name.value;
      const responseName = selection.alias?.value ?? fieldName;
      const field = getFieldDefinition(schema, parentType, fieldName);
      const type = field.forceNonNull
        ? nonNullableTypeToTs(
            schema,
            field.type,
            selection.selectionSet,
            indent + 2,
          )
        : typeToTs(
            schema,
            field.type,
            selection.selectionSet,
            indent + 2,
            field.forceNullable,
          );
      lines.push(`${childPad}readonly ${propertyName(responseName)}: ${type};`);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const fragmentType = selection.typeCondition
        ? schema.getType(selection.typeCondition.name.value)
        : parentType;
      if (isObjectType(fragmentType)) {
        const fragment = selectionSetToTs(
          schema,
          fragmentType,
          selection.selectionSet,
          indent,
        );
        lines.push(
          ...fragment
            .split("\n")
            .slice(1, -1)
            .filter((line) => line.trim().length > 0),
        );
      }
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      throw new Error(
        `Named fragment spreads (...${selection.name.value}) are not supported by the dashboard codegen. Inline the fragment fields instead.`,
      );
    } else {
      throw new Error(`Unsupported GraphQL selection kind: ${selection.kind}`);
    }
  }
  lines.push(`${pad}}`);
  return lines.join("\n");
}

function operationTypes(schema, operations) {
  const queryType = schema.getQueryType();
  if (!queryType) throw new Error("Synthesized schema did not produce Query");
  const chunks = [];
  const seenNames = new Set();
  for (const operation of operations) {
    const def = operation.ast.definitions.find(
      (node) => node.kind === Kind.OPERATION_DEFINITION,
    );
    if (!def || def.operation !== "query" || !def.name?.value) continue;
    const name = def.name.value;
    if (seenNames.has(name)) {
      throw new Error(`Duplicate GraphQL operation name: ${name}`);
    }
    seenNames.add(name);
    chunks.push(
      "",
      `// ${operation.moduleName}.${operation.exportName}`,
      `export type ${name}QueryVariables = ${variableDefinitionsToTs(
        def.variableDefinitions,
      )};`,
      `export type ${name}Query = ${selectionSetToTs(
        schema,
        queryType,
        def.selectionSet,
        0,
      )};`,
    );
  }
  return chunks;
}

function generateFile(schemaInfo, operations) {
  const lines = [
    "/* eslint-disable */",
    "// This file is generated by `pnpm --filter @mento-protocol/ui-dashboard codegen`.",
    "// Do not edit by hand; update the GraphQL operation or indexer schema instead.",
    "",
    "export type Maybe<T> = T | null;",
    "",
    ...enumTypes(schemaInfo.schema),
    "",
    ...entityInputTypes(schemaInfo.schema, schemaInfo.entityNames),
    ...operationTypes(schemaInfo.schema, operations),
  ];
  return `${lines.join("\n")}\n`;
}

function main() {
  const queries = exportedQueryStrings();
  if (queries.length < MIN_OPERATION_COUNT) {
    throw new Error(
      `Expected at least ${MIN_OPERATION_COUNT} dashboard GraphQL operations, found ${queries.length}`,
    );
  }
  const schemaInfo = buildDashboardSchema();
  const operations = queries.map((query) => ({
    ...query,
    ast: validateOperation(schemaInfo, query),
  }));
  const content = generateFile(schemaInfo, operations);
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, content);
  console.log(
    `Generated ${path.relative(REPO_ROOT, OUTPUT_PATH)} from ${operations.length} operations`,
  );
}

main();
