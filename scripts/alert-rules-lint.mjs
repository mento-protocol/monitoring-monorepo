#!/usr/bin/env node
/**
 * Static checks for the Grafana alert-rule stack in alerts/rules/.
 *
 * 1. PromQL syntax lint: extracts every PromQL expression embedded in the .tf
 *    files (expr attributes, *_promql / *_expr locals, format() templates,
 *    join() fragment lists, heredocs), neutralizes Terraform templating, and
 *    parses each expression with the Prometheus lezer grammar in strict mode.
 * 2. Metric cross-check: every mento_pool_* / mento_cdp_* series name
 *    referenced in alerts/rules must be registered in metrics-bridge.
 *
 * The extractor is regex-based, not an HCL evaluator. The count floors
 * (ALERT_RULES_LINT_MIN_*) fail loudly if a future .tf refactor moves
 * expressions into shapes the extractor no longer sees; extend the extractor
 * instead of lowering the floor.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parser } from "@prometheus-io/lezer-promql";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const rulesDir =
  process.env.ALERT_RULES_LINT_RULES_DIR ?? path.join(repoRoot, "alerts/rules");
const metricsSrcDir =
  process.env.ALERT_RULES_LINT_METRICS_DIR ??
  path.join(repoRoot, "metrics-bridge/src");
const GAUGE_SOURCE_FILES = ["metrics.ts", "cdp-metrics.ts"];
const LITERAL_PERCENT = "__ALERT_RULES_LINT_LITERAL_PERCENT__";

const intEnv = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined ? fallback : Number.parseInt(raw, 10);
};

// An HCL double-quoted string body. Handles \" escapes inside jsonencode.
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;

function stripLineComment(line) {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "#") {
      return line.slice(0, i).trimEnd();
    } else if (char === "/" && line[i + 1] === "/") {
      return line.slice(0, i).trimEnd();
    }
  }

  return line;
}

export const stripComments = (text) =>
  text.split("\n").map(stripLineComment).join("\n");

export const unescapeHcl = (value) => value.replace(/\\(["\\])/g, "$1");

// Make a Terraform-templated expression parseable as plain PromQL. Terraform
// ${...} interpolations and %s format verbs become a placeholder metric
// selector; numeric format verbs become a literal 1; %% is Terraform's escaped
// literal percent and becomes PromQL's modulo operator.
export const neutralize = (expr) =>
  expr
    .replace(/%%/g, LITERAL_PERCENT)
    .replace(/\$\{[^}]+\}/g, "placeholder_metric")
    .replace(/%s/g, "placeholder_metric")
    .replace(/%[dfg]/g, "1")
    .replaceAll(LITERAL_PERCENT, "%");

function findClosingBracket(text, openIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function extractJoinExpressions(file, text) {
  const out = [];
  const assignment = /^\s*expr\s*=/gm;
  for (const match of text.matchAll(assignment)) {
    const bodyStart = match.index + match[0].length;
    const nextAssignment = /^\s*[A-Za-z0-9_]+\s*=/gm;
    nextAssignment.lastIndex = bodyStart;
    const next = nextAssignment.exec(text);
    const bodyEnd = next ? next.index : text.length;
    const body = text.slice(bodyStart, bodyEnd);
    const joinCall = new RegExp(String.raw`join\(\s*${QUOTED}\s*,\s*\[`, "g");

    for (const join of body.matchAll(joinCall)) {
      const separator = unescapeHcl(join[1]);
      const open = join.index + join[0].lastIndexOf("[");
      const close = findClosingBracket(body, open);
      if (close === -1) continue;

      const listBody = body.slice(open + 1, close);
      const elem = new RegExp(String.raw`^\s*${QUOTED},?\s*$`, "gm");
      const fragments = [];
      for (const element of listBody.matchAll(elem)) {
        const fragment = unescapeHcl(element[1]);
        fragments.push(fragment);
        out.push({ file, kind: "join-elem", expr: fragment });
      }
      if (fragments.length > 0) {
        out.push({ file, kind: "join", expr: fragments.join(separator) });
      }
    }
  }

  return out;
}

// `text` must already be comment-stripped.
export function extractExpressions(file, text) {
  const out = [];

  // Pass A: single-line `expr = "..."` and `*_promql` / `*_expr` locals.
  const single = new RegExp(
    String.raw`^\s*(?:expr|[A-Za-z0-9_]*_(?:promql|expr))\s*=\s*${QUOTED}\s*,?\s*$`,
    "gm",
  );
  for (const match of text.matchAll(single)) {
    out.push({ file, kind: "single", expr: unescapeHcl(match[1]) });
  }

  // Pass B: format() templates (inline or template on the next line). Skip
  // *_regex* locals (label-regex builders, not PromQL); accept `expr`,
  // `*_promql` / `*_expr` names, and PascalCase duration-part map keys.
  const fmt = new RegExp(
    String.raw`^\s*([A-Za-z0-9_]+)\s*=\s*format\(\s*\n?\s*${QUOTED}`,
    "gm",
  );
  for (const match of text.matchAll(fmt)) {
    const name = match[1];
    if (/_regex/.test(name)) continue;
    if (
      name !== "expr" &&
      !/_(promql|expr)$/.test(name) &&
      !/^[A-Z][A-Za-z0-9]*$/.test(name)
    ) {
      continue;
    }
    out.push({ file, kind: "format", expr: unescapeHcl(match[2]) });
  }

  // Pass C: heredocs assigned to expr / *_promql / *_expr.
  const heredoc = new RegExp(
    String.raw`^\s*(?:expr|[A-Za-z0-9_]*_(?:promql|expr))\s*=\s*<<-?EOT\n([\s\S]*?)^\s*EOT$`,
    "gm",
  );
  for (const match of text.matchAll(heredoc)) {
    out.push({ file, kind: "heredoc", expr: match[1] });
  }

  // Pass D: quoted fragments of join("...", [ ... ]) lists inside expr
  // assignments, including format(..., join(...)) wrappers. HCL has no raw
  // string escapes inside the bracket list, so scan for the matching closing
  // bracket while ignoring PromQL range-selector brackets inside quoted
  // fragments.
  out.push(...extractJoinExpressions(file, text));

  return out;
}

const strictParser = parser.configure({ strict: true });

/** Returns null when `expr` parses, otherwise the parser error message. */
export function lintPromql(expr) {
  try {
    strictParser.parse(expr);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export const registeredMetricNames = (tsSource) =>
  [...tsSource.matchAll(/name:\s*"(mento_[a-z0-9_]+)"/g)].map(
    (match) => match[1],
  );

export const referencedMetricNames = (tfSource) =>
  [...tfSource.matchAll(/\bmento_(?:pool|cdp)_[a-z0-9_]*[a-z0-9]\b/g)].map(
    (match) => match[0],
  );

function main() {
  const minExpressions = intEnv("ALERT_RULES_LINT_MIN_EXPRESSIONS", 100);
  const minRegistered = intEnv("ALERT_RULES_LINT_MIN_REGISTERED", 30);
  const minReferenced = intEnv("ALERT_RULES_LINT_MIN_REFERENCED", 25);

  const failures = [];
  const referenced = new Set();
  let expressions = [];
  const tfFiles = readdirSync(rulesDir)
    .filter((file) => file.endsWith(".tf"))
    .sort();

  for (const file of tfFiles) {
    const cleaned = stripComments(
      readFileSync(path.join(rulesDir, file), "utf8"),
    );
    expressions.push(...extractExpressions(file, cleaned));
    for (const name of referencedMetricNames(cleaned)) referenced.add(name);
  }

  for (const { file, kind, expr } of expressions) {
    const neutralized = neutralize(expr);
    const errorMessage = lintPromql(neutralized);
    if (errorMessage !== null) {
      failures.push(
        `${file} [${kind}]: ${errorMessage}\n      ${neutralized.trim()}`,
      );
    }
  }

  const registered = new Set();
  for (const file of GAUGE_SOURCE_FILES) {
    const source = readFileSync(path.join(metricsSrcDir, file), "utf8");
    for (const name of registeredMetricNames(source)) registered.add(name);
  }

  for (const name of [...referenced].sort()) {
    if (!registered.has(name)) {
      failures.push(
        `unknown metric in alerts/rules: ${name} is not registered in metrics-bridge (${GAUGE_SOURCE_FILES.join(", ")})`,
      );
    }
  }

  if (expressions.length < minExpressions) {
    failures.push(
      `extraction floor: ${expressions.length} expressions < ${minExpressions} - extend the extractor in scripts/alert-rules-lint.mjs`,
    );
  }
  if (registered.size < minRegistered) {
    failures.push(
      `gauge floor: ${registered.size} registered names < ${minRegistered}`,
    );
  }
  if (referenced.size < minReferenced) {
    failures.push(
      `reference floor: ${referenced.size} referenced names < ${minReferenced}`,
    );
  }

  console.log(
    `alert-rules-lint: ${expressions.length} PromQL expressions parsed, ` +
      `${referenced.size} referenced metric names checked against ${registered.size} registered gauges`,
  );

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} failure(s):\n${failures
        .map((failure) => `  - ${failure}`)
        .join("\n")}`,
    );
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
