/**
 * Extraction half of the alert-rules linter.
 *
 * Pulls every PromQL expression out of the Terraform in alerts/rules/ (expr
 * attributes, *_promql / *_expr locals, format() templates, map comprehensions,
 * heredocs, join() fragment lists), neutralizes Terraform templating, and parses
 * each expression with the Prometheus lezer grammar in strict mode. It also
 * carries the two metric-name regexes: the registered-gauge names in the
 * metrics-bridge TypeScript sources and the names the rules reference.
 *
 * The extractor is regex-based, not an HCL evaluator, so every shape it does
 * not recognize is silently invisible. The ALERT_RULES_LINT_MIN_* count floors
 * live here, next to the regexes they guard: they are the machine check that a
 * future .tf refactor has not moved expressions out of the extractor's sight.
 * Extend the extractor instead of lowering a floor.
 */
import { parser } from "@prometheus-io/lezer-promql";

const LITERAL_PERCENT = "__ALERT_RULES_LINT_LITERAL_PERCENT__";

// An HCL double-quoted string body. Handles \" escapes inside jsonencode.
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;

// Peg rollover scope is carried by a reserved Terraform-local name so the
// production extractor and the semantic validator share one executable path.
// Inline `expr` attributes remain intentionally unscoped and fail closed when
// a previous policy is retained.
function pegRuleForExpressionName(name) {
  if (/^peg_rollover_ack_[a-z0-9_]+_(?:promql|expr)$/.test(name)) {
    return { kind: "rollover-ack" };
  }
  const decision = /^peg_(active|previous)_[a-z0-9_]+_(?:promql|expr)$/.exec(
    name,
  );
  return decision === null
    ? undefined
    : { kind: "decision", policy: decision[1] };
}

function extractedExpression(file, kind, name, expr) {
  const pegRule = pegRuleForExpressionName(name);
  return pegRule === undefined
    ? { file, kind, expr }
    : { file, kind, expr, pegRule };
}

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
  const assignment = /^\s*(expr|[A-Za-z0-9_]*_(?:promql|expr))\s*=/gm;
  for (const match of text.matchAll(assignment)) {
    const name = match[1];
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
        out.push(extractedExpression(file, "join-elem", name, fragment));
      }
      if (fragments.length > 0) {
        out.push(
          extractedExpression(file, "join", name, fragments.join(separator)),
        );
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
    String.raw`^\s*(expr|[A-Za-z0-9_]*_(?:promql|expr))\s*=\s*${QUOTED}\s*,?\s*$`,
    "gm",
  );
  for (const match of text.matchAll(single)) {
    out.push(
      extractedExpression(file, "single", match[1], unescapeHcl(match[2])),
    );
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
    out.push(extractedExpression(file, "format", name, unescapeHcl(match[2])));
  }

  // Pass B2: map comprehensions whose value is a format() template. Peg rules
  // use these to materialize one version-bound expression per asset/source;
  // missing this shape would leave the generated decision plane unparsed.
  const mapFmt = new RegExp(
    String.raw`^\s*([A-Za-z0-9_]+_(?:promql|expr))\s*=\s*\{[\s\S]*?^\s*for\b[^\n]*=>\s*format\(\s*\n?\s*${QUOTED}`,
    "gm",
  );
  for (const match of text.matchAll(mapFmt)) {
    out.push(
      extractedExpression(file, "map-format", match[1], unescapeHcl(match[2])),
    );
  }

  // Pass C: heredocs assigned to expr / *_promql / *_expr.
  const heredoc = new RegExp(
    String.raw`^\s*(expr|[A-Za-z0-9_]*_(?:promql|expr))\s*=\s*<<-?EOT\n([\s\S]*?)^\s*EOT$`,
    "gm",
  );
  for (const match of text.matchAll(heredoc)) {
    out.push(extractedExpression(file, "heredoc", match[1], match[2]));
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
  [...tfSource.matchAll(/\bmento_(?:pool|cdp|peg)_[a-z0-9_]*[a-z0-9]\b/g)].map(
    (match) => match[0],
  );

const intEnv = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined ? fallback : Number.parseInt(raw, 10);
};

/**
 * The count floors. Each guards one regex above: a .tf or .ts refactor that
 * moves content into a shape the regex no longer sees drops the count, and the
 * run fails loudly instead of passing on a shrunken corpus.
 */
export function extractionFloorFailures({
  expressions,
  registered,
  referenced,
}) {
  const failures = [];
  // 169 since ADR 0067 replaced the two magnitude-based deviation criticals
  // with the two depletion rules — a real net loss of extracted expressions,
  // not an extractor regression.
  const minExpressions = intEnv("ALERT_RULES_LINT_MIN_EXPRESSIONS", 169);
  const minRegistered = intEnv("ALERT_RULES_LINT_MIN_REGISTERED", 30);
  const minReferenced = intEnv("ALERT_RULES_LINT_MIN_REFERENCED", 25);

  if (expressions < minExpressions) {
    failures.push(
      `extraction floor: ${expressions} expressions < ${minExpressions} - extend the extractor in scripts/alerts/alert-rules-lint-extract.mjs`,
    );
  }
  if (registered < minRegistered) {
    failures.push(
      `gauge floor: ${registered} registered names < ${minRegistered}`,
    );
  }
  if (referenced < minReferenced) {
    failures.push(
      `reference floor: ${referenced} referenced names < ${minReferenced}`,
    );
  }
  return failures;
}
