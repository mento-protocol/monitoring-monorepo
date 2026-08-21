/**
 * Read the quality gate's live routing `case` arms out of its own source text.
 *
 * This exists for one job: the equality test that proves
 * `scripts/gate/routing-table/` and the bash arms in
 * `scripts/agent-quality-gate.sh` describe the same routing. Until the bash
 * arms are retired, the table is a second copy of a routing authority, and a
 * second copy nobody compares is a copy that drifts.
 *
 * The parser is deliberately narrow and FAILS CLOSED. It recognises exactly the
 * constructs the routing region uses today — a `case` over `$path`, a `case`
 * over the root-manifest class, three `[[ … ]]` guards, two `for` loops over
 * engine-computed pattern sets, two flag assignments, and calls to the gate's
 * own `add_*` helpers with literal arguments. Anything else raises. A parser
 * that skipped what it did not understand would report equality over the subset
 * it happened to read, which is the failure class ADR 0064 spends its
 * consequences on: routing that goes quiet instead of red.
 *
 * It is a text parser, not a shell. It never executes the gate.
 */

import assert from "node:assert/strict";

/** The line that opens the per-path routing loop. */
const REGION_START = "while IFS= read -r path; do";

/** The line that closes it. */
const REGION_END = 'done < "$changed_paths_file"';

/**
 * The token a templated command carries in place of the changed path.
 *
 * The gate writes `$(quote_path "$path")` — `printf %q` over the path — and
 * only inside an arm guarded by `[[ -f "$path" ]]`. The table cannot hold the
 * expansion, so it holds this placeholder and the engine owns the quoting.
 */
export const PATH_TOKEN = "{path}";

/** `$(quote_path "$path")`, the only command substitution any arm performs. */
const QUOTE_PATH_EXPANSION = '$(quote_path "$path")';

/**
 * The two variables the routing region assigns, and what each assignment means.
 *
 * Both are global mutations read later in the run rather than effects on the
 * command plan, so the table records the assignment itself rather than trying
 * to inline whatever reads it.
 */
const ASSIGNMENTS = new Map([
  ["package_script_risk_changed=true", "package_script_risk_changed"],
  [
    'root_package_json_class="$(get_root_package_json_class)"',
    "root_package_json_class",
  ],
]);

/** The `case` subjects the routing region switches on. */
const SUBJECTS = new Map([
  ['case "$path" in', "path"],
  ['case "$root_package_json_class" in', "root_package_json_class"],
]);

/**
 * The guards an arm may carry, as source text mapped to the closed descriptor
 * set the table uses. `pathEquals` is open-ended in its literal, so it is
 * matched by pattern rather than listed.
 */
const GUARDS = new Map([
  ['if [[ -f "$path" ]]; then', "pathIsFile"],
  ['if [[ -L "$repo_root/$path" ]]; then', "pathIsSymlink"],
  [
    'if [[ "$script_source_dir" == "$repo_root/scripts" ]]; then',
    "realTreeOnly",
  ],
]);

const PATH_EQUALS = /^if \[\[ "\$path" == "([^"]*)" \]\]; then$/;

/**
 * The two engine-computed pattern sets, keyed by the `for` header that walks
 * them. The table names the source and its position in the order; the engine
 * owns the computation, because both are read from the tree at run time.
 */
const DYNAMIC_SOURCES = new Map([
  [
    'for scripts_symlink_target in "${scripts_symlink_targets[@]+"${scripts_symlink_targets[@]}"}"; do',
    "scriptsSymlinkTargets",
  ],
  [
    'for terraform_stack_path in "${terraform_stack_paths[@]}"; do',
    "registeredTerraformStacks",
  ],
]);

/** The `if` header that fences a dynamic set behind a non-empty count. */
const DYNAMIC_GUARDS = new Map([
  ['if [[ "$terraform_stack_paths_count" -gt 0 ]]; then', "nonEmpty"],
]);

/**
 * A call to one of the gate's own helpers: a bare identifier and zero or more
 * double-quoted or bare-word arguments. Bare words appear only as the loop
 * variables the dynamic groups pass through.
 */
const CALL = /^([a-z_][a-z_0-9]*)((?: +(?:"[^"]*"|\$[a-z_][a-z_0-9]*))*)$/;

const ARGUMENT = /"([^"]*)"|(\$[a-z_][a-z_0-9]*)/g;

/**
 * Extract the routing region's lines, with their 1-based line numbers in the
 * gate, and prove there is exactly one such region.
 *
 * @param {string} source the whole gate script
 * @returns {{ start: number, end: number, lines: string[] }}
 */
export function routingRegion(source) {
  const lines = source.split("\n");
  const starts = indexesOf(lines, REGION_START);
  const ends = indexesOf(lines, REGION_END);
  assert.equal(
    starts.length,
    1,
    `the gate opens ${starts.length} per-path routing loops (\`${REGION_START}\`); this parser cannot know which one routes`,
  );
  assert.equal(
    ends.length,
    1,
    `the gate closes ${ends.length} per-path routing loops (\`${REGION_END}\`); this parser cannot know where routing ends`,
  );
  assert.ok(
    starts[0] < ends[0],
    "the gate's routing loop closes before it opens",
  );
  return {
    start: starts[0] + 1,
    end: ends[0] + 1,
    lines: lines.slice(starts[0] + 1, ends[0]),
  };
}

/**
 * Lines matching `wanted` EXACTLY, indentation included.
 *
 * Seven other loops in the gate read a variable named `path`, and every one of
 * them is nested inside a function. Anchoring on column 0 is what separates the
 * top-level routing loop from all of them, and an exact match is how this asks
 * the question — trimming first would find eight candidates and have to guess.
 */
function indexesOf(lines, wanted) {
  const found = [];
  lines.forEach((line, index) => {
    if (line === wanted) found.push(index);
  });
  return found;
}

/**
 * Parse the routing region into the ordered group list the equality test
 * compares against the table.
 *
 * @param {string} source the whole gate script
 * @returns {{ groups: object[], comments: Map<string, string[]> }}
 */
export function parseGateRouting(source) {
  const region = routingRegion(source);
  const reader = new Reader(region.lines, region.start);
  const body = [];
  for (;;) {
    const why = reader.takeComments();
    if (reader.done()) {
      assert.deepEqual(
        why,
        [],
        "the routing loop ends on a comment with no statement under it",
      );
      break;
    }
    body.push(parseStatement(reader, why));
  }
  return flattenGroups(body, { realTreeOnly: false, dynamic: null });
}

/**
 * Turn the loop body's statement tree into the ordered, flat group list the
 * table mirrors.
 *
 * Two wrappers are folded into flags rather than kept as nesting, because both
 * are properties OF a group rather than routing in their own right: the
 * `$script_source_dir` test that fences repository-specific groups off from the
 * gate's stub fixture repositories, and the `for` loops that walk a pattern set
 * the engine computes at run time. Everything else at this level would be
 * routing the flattener does not understand, so it refuses.
 */
function flattenGroups(body, context) {
  const groups = [];
  for (const statement of body) {
    if (statement.kind === "dispatch") {
      groups.push({
        line: statement.line ?? null,
        why: statement.why,
        subject: statement.subject,
        arms: statement.arms,
        trailingWhy: statement.trailingWhy,
        ...context,
      });
      continue;
    }
    if (statement.kind === "when" && statement.guard === "realTreeOnly") {
      groups.push(
        ...flattenGroups(statement.effects, { ...context, realTreeOnly: true }),
      );
      continue;
    }
    if (statement.kind === "when" && statement.guard === "nonEmpty") {
      groups.push(
        ...flattenGroups(statement.effects, {
          ...context,
          requiresNonEmpty: true,
        }),
      );
      continue;
    }
    if (statement.kind === "dynamic") {
      groups.push(
        ...flattenGroups(statement.effects, {
          ...context,
          dynamic: statement.source,
        }),
      );
      continue;
    }
    throw new Error(
      `the routing loop's top level holds a \`${statement.kind}\` statement, which is not a routing group; ` +
        "the routing table mirrors groups, so this has to be taught deliberately",
    );
  }
  return groups;
}

/**
 * Fold backslash-continued lines into one logical line, keeping the FIRST
 * line's number so a refusal still points at where the construct starts.
 *
 * The long pattern lists are written across several lines; to bash they are one
 * word list, and reading them as separate lines would find an arm whose pattern
 * ends in `|` and refuse a file that is perfectly ordinary shell.
 */
function joinContinuations(lines) {
  const joined = [];
  let pending = null;
  for (const line of lines) {
    const text =
      pending === null ? line.text : `${pending.text} ${line.text.trim()}`;
    const number = pending === null ? line.number : pending.number;
    if (text.endsWith("\\")) {
      pending = { text: text.slice(0, -1).trimEnd(), number };
      continue;
    }
    pending = null;
    joined.push({ text, number });
  }
  assert.equal(
    pending,
    null,
    "the routing region ends on a line continuation with nothing to continue into",
  );
  return joined;
}

/** A cursor over the region's lines that keeps each line's gate line number. */
class Reader {
  constructor(lines, firstLineNumber) {
    this.lines = joinContinuations(
      lines.map((text, index) => ({
        text,
        number: firstLineNumber + index + 1,
      })),
    );
    this.index = 0;
  }

  done() {
    return this.index >= this.lines.length;
  }

  peek() {
    assert.ok(!this.done(), "the routing region ended mid-construct");
    return this.lines[this.index];
  }

  next() {
    const line = this.peek();
    this.index += 1;
    return line;
  }

  /** Every comment line immediately above the cursor, in source order. */
  takeComments() {
    const comments = [];
    while (!this.done()) {
      const trimmed = this.peek().text.trim();
      if (trimmed.startsWith("#")) {
        comments.push(trimmed.replace(/^#[ ]?/, ""));
        this.next();
      } else if (trimmed === "") {
        this.next();
      } else {
        break;
      }
    }
    return comments;
  }
}

function refuse(line, what) {
  throw new Error(
    `agent-quality-gate.sh:${line.number}: ${what}\n  ${line.text}\n` +
      "The routing-table parser recognises only the constructs the routing region uses today. " +
      "Teach it this one deliberately — silently skipping it would let the equality test pass over routing it never read.",
  );
}

/** `case … in` through its `esac`, returning `{ subject, arms, trailingWhy }`. */
function parseCase(reader) {
  const head = reader.next();
  const subject = SUBJECTS.get(head.text.trim());
  assert.ok(subject !== undefined, `not a case head: ${head.text}`);
  const arms = [];
  for (;;) {
    const why = reader.takeComments();
    const line = reader.peek();
    const trimmed = line.text.trim();
    if (trimmed === "esac") {
      reader.next();
      // A comment with no arm under it is a note about what this `case`
      // deliberately does NOT route. It is exactly the reasoning the ADR says
      // must survive the conversion, so it becomes the group's trailing note
      // rather than being dropped for having nowhere obvious to sit.
      return { subject, arms, trailingWhy: why };
    }
    arms.push(parseArm(reader, why));
  }
}

/** One `patterns)` … `;;` arm. */
function parseArm(reader, why) {
  const head = reader.next();
  const raw = head.text.trim();
  // An arm that routes NOTHING is written on one line: `*/*/*) ;;`. It is not
  // decoration — placed above a catch-all it is what stops the catch-all
  // running, so it has to be read as an arm with an empty effect list rather
  // than skipped for having no body under it.
  const empty = raw.endsWith(") ;;");
  const trimmed = empty ? raw.slice(0, -3).trimEnd() : raw;
  if (!trimmed.endsWith(")"))
    refuse(head, "expected a `case` arm pattern list");
  const patterns = trimmed
    .slice(0, -1)
    .split("|")
    .map((pattern) => unquotePattern(pattern.trim(), head));
  assert.ok(
    patterns.length > 0 && patterns.every((pattern) => pattern.length > 0),
    `agent-quality-gate.sh:${head.number}: empty pattern in \`${trimmed}\``,
  );
  const effects = empty ? [] : parseBody(reader, ";;");
  return { line: head.number, why, patterns, effects };
}

/**
 * A pattern is source text, so a quoted variable expansion has to be named
 * rather than passed through: the dynamic groups write `"$scripts_symlink_target"/*`
 * and the table records the source, not the expansion.
 */
function unquotePattern(pattern, line) {
  const dynamic = /^"\$([a-z_][a-z_0-9]*)"(.*)$/.exec(pattern);
  if (dynamic !== null) return `\${${dynamic[1]}}${dynamic[2]}`;
  if (pattern.includes('"')) refuse(line, "unrecognised quoting in a pattern");
  return pattern;
}

/** Statements up to (and consuming) `terminator`. */
function parseBody(reader, terminator) {
  const effects = [];
  for (;;) {
    const why = reader.takeComments();
    const line = reader.peek();
    const trimmed = line.text.trim();
    if (trimmed === terminator) {
      reader.next();
      return effects;
    }
    effects.push(parseStatement(reader, why));
  }
}

function parseStatement(reader, why) {
  const line = reader.peek();
  const trimmed = line.text.trim();

  if (SUBJECTS.has(trimmed)) {
    return { kind: "dispatch", why, line: line.number, ...parseCase(reader) };
  }

  const assignment = ASSIGNMENTS.get(trimmed);
  if (assignment !== undefined) {
    reader.next();
    return { kind: "set", why, name: assignment };
  }

  const guard = GUARDS.get(trimmed) ?? DYNAMIC_GUARDS.get(trimmed);
  if (guard !== undefined) {
    reader.next();
    return { kind: "when", why, guard, effects: parseBody(reader, "fi") };
  }

  const equals = PATH_EQUALS.exec(trimmed);
  if (equals !== null) {
    reader.next();
    return {
      kind: "when",
      why,
      guard: { pathEquals: equals[1] },
      effects: parseBody(reader, "fi"),
    };
  }

  const dynamic = DYNAMIC_SOURCES.get(trimmed);
  if (dynamic !== undefined) {
    reader.next();
    return {
      kind: "dynamic",
      why,
      source: dynamic,
      effects: parseBody(reader, "done"),
    };
  }

  if (trimmed === "break") {
    reader.next();
    return { kind: "break", why };
  }

  // The changed path reaches a scheduled command through exactly one
  // expansion, and it is folded to a placeholder BEFORE the call is matched so
  // the nested quotes inside it never reach the argument scanner. Any other
  // command substitution is refused rather than guessed at: an arm that
  // computed part of its command at run time would not be data at all.
  const normalized = trimmed.split(QUOTE_PATH_EXPANSION).join(PATH_TOKEN);
  if (normalized.includes("$(")) {
    refuse(line, "unrecognised command substitution in a routing statement");
  }
  const call = CALL.exec(normalized);
  if (call !== null) {
    reader.next();
    return { kind: "call", why, verb: call[1], args: parseArguments(call[2]) };
  }

  return refuse(line, "unrecognised routing statement");
}

/**
 * The parsed arms reduced to the same normal form `schema.mjs` produces for the
 * table: patterns, verbs, arguments, guards and order, with every comment,
 * line number and group name dropped.
 *
 * Comments are dropped on BOTH sides on purpose. They are the reasoning the
 * conversion exists to carry, and they are also the thing most likely to be
 * reworded — comparing them would make the equality test red on prose while
 * saying nothing about where a path routes.
 *
 * @param {string} source the whole gate script
 * @returns {object[]}
 */
export function gateRoutingPlan(source) {
  return parseGateRouting(source).map((group) => ({
    realTreeOnly: group.realTreeOnly === true,
    dynamic: group.dynamic ?? null,
    requiresNonEmpty: group.requiresNonEmpty === true,
    arms: plainArms(group.arms),
  }));
}

function plainArms(arms) {
  return arms.map((arm) => ({
    patterns: [...arm.patterns],
    effects: arm.effects.map(plainEffect),
  }));
}

function plainEffect(effect) {
  if (effect.kind === "call") {
    return { kind: "call", verb: effect.verb, args: [...effect.args] };
  }
  if (effect.kind === "set") return { kind: "set", name: effect.name };
  if (effect.kind === "break") return { kind: "break" };
  if (effect.kind === "when") {
    return {
      kind: "when",
      guard:
        typeof effect.guard === "string"
          ? effect.guard
          : { pathEquals: effect.guard.pathEquals },
      effects: effect.effects.map(plainEffect),
    };
  }
  if (effect.kind === "dispatch") {
    return {
      kind: "dispatch",
      subject: effect.subject,
      arms: plainArms(effect.arms),
    };
  }
  throw new Error(`no normal form for a \`${effect.kind}\` routing statement`);
}

function parseArguments(text) {
  const args = [];
  for (const match of text.matchAll(ARGUMENT)) {
    args.push(match[1] ?? `\${${match[2].slice(1)}}`);
  }
  return args;
}
