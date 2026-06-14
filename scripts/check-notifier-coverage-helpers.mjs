/**
 * Parse helpers for check-notifier-coverage.mjs.
 * Extracted as a separate module so the script and its test file can both
 * import the real implementations instead of duplicating them.
 *
 * Uses js-yaml to parse workflow YAML correctly, handling all trigger forms
 * documented by GitHub Actions (scalar, array, mapping with branches /
 * branches-ignore / tags / tags-ignore).
 */

import jsYaml from "js-yaml";

/**
 * Returns true if the GitHub Actions branch glob `pattern` matches `branch`.
 *
 * GitHub uses fnmatch-style globs:
 *   `**`  → matches any string (including those with `/`)
 *   `*`   → matches any string that does NOT contain `/`
 *   `?`   → matches any single character that is not `/`
 *
 * For the common case of matching "main":
 *   - exact match  → trivially true
 *   - `**`         → matches everything
 *   - `*`          → matches any single path segment (main has no `/`) → true
 *
 * @param {string} pattern
 * @param {string} branch
 * @returns {boolean}
 */
function globMatchesBranch(pattern, branch) {
  // Exact match fast-path.
  if (pattern === branch) return true;

  // Convert the glob pattern to a regex.
  // Escape all regex special chars except *, ?, which we handle ourselves.
  let regexStr = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      // `**` — matches any sequence of chars including `/`
      regexStr += ".*";
      i++; // skip the second *
      // skip optional trailing `/` after `**/`
      if (pattern[i + 1] === "/") i++;
    } else if (ch === "*") {
      // `*` — matches any sequence of chars except `/`
      regexStr += "[^/]*";
    } else if (ch === "?") {
      // `?` — matches any single char except `/`
      regexStr += "[^/]";
    } else {
      // Escape regex special characters.
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regexStr}$`).test(branch);
}

/**
 * Returns true if, processing the list in order with GitHub's ordered
 * include/exclude semantics, the final decision for `branch` is "included".
 *
 * GitHub evaluates branch filters left-to-right: a pattern starting with `!`
 * is a negation — if it matches, it unsets the current match; a positive
 * pattern that matches sets it. The branch is included if and only if the
 * LAST matching pattern (positive or negative) leaves it included.
 *
 * Examples:
 *   ['**', '!main']   → false  (** matches, then !main unsets it)
 *   ['!main', '**']   → true   (!main unsets, but ** re-includes)
 *   ['**']            → true
 *   ['releases/**']   → false  (no pattern matches main)
 *
 * @param {unknown[]} list
 * @param {string} branch
 * @returns {boolean}
 */
function orderedGlobMatches(list, branch) {
  let matched = false;
  for (const rawEntry of list) {
    const entry = String(rawEntry);
    if (entry.startsWith("!")) {
      const pattern = entry.slice(1);
      if (globMatchesBranch(pattern, branch)) matched = false;
    } else {
      if (globMatchesBranch(entry, branch)) matched = true;
    }
  }
  return matched;
}

/**
 * Extract the `name:` field value from a workflow YAML text.
 * Returns null if not found.
 * @param {string} text
 * @returns {string|null}
 */
export function parseName(text) {
  const doc = jsYaml.load(text);
  if (!doc || typeof doc !== "object") return null;
  const name = doc["name"];
  if (name == null) return null;
  return String(name);
}

/**
 * Returns true if the workflow has an `on.push` trigger that can fire on the
 * `main` branch.  Handles all forms documented by GitHub Actions:
 *
 *   on: push                      → scalar  → TRUE (all branches incl. main)
 *   on: [push, schedule]          → array   → TRUE (push present)
 *   on:
 *     push:                       → null push body → TRUE (all branches)
 *     push:
 *       branches: [main]          → exact list match → TRUE
 *       branches: [not-main]      → exact list match → FALSE
 *     push:
 *       branches-ignore: [dev]    → main not ignored → TRUE
 *       branches-ignore: [main]   → main ignored     → FALSE
 *     push:
 *       tags: [v*]                → tag-only filter  → FALSE
 *       tags-ignore: [v*]         → tag-only filter  → FALSE
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasPushMain(text) {
  const doc = jsYaml.load(text);
  if (!doc || typeof doc !== "object") return false;

  const on = doc["on"] ?? doc["true"]; // YAML may parse bare `on` as true
  if (!on) return false;

  // Scalar shorthand: `on: push` or `on: "push"`
  if (typeof on === "string") return on === "push";

  // Array shorthand: `on: [push, schedule]`
  if (Array.isArray(on)) return on.includes("push");

  // Mapping form: `on:\n  push: ...`
  if (typeof on !== "object") return false;

  const push = on["push"];

  // No `push:` key — not a push workflow.
  if (!Object.prototype.hasOwnProperty.call(on, "push")) return false;

  // `push:` present but null/empty (no branch/tag filters) → runs on everything.
  if (push == null || typeof push !== "object") return true;

  const branches = push["branches"];
  const branchesIgnore = push["branches-ignore"];
  const hasBranchFilter = branches != null;
  const hasBranchIgnore = branchesIgnore != null;
  const hasTags = push["tags"] != null || push["tags-ignore"] != null;

  // Tag-only filters (no branches/branches-ignore) → runs only on tag pushes,
  // not branch pushes.
  if (!hasBranchFilter && !hasBranchIgnore && hasTags) return false;

  // No branch filter at all and no tag-only filter → runs on all branches.
  if (!hasBranchFilter && !hasBranchIgnore) return true;

  // branches: list — main must be included after ordered include/exclude eval.
  if (hasBranchFilter) {
    const list = Array.isArray(branches) ? branches : [branches];
    return orderedGlobMatches(list, "main");
  }

  // branches-ignore: list — runs on main unless some glob entry matches "main".
  const ignoreList = Array.isArray(branchesIgnore)
    ? branchesIgnore
    : [branchesIgnore];
  return !orderedGlobMatches(ignoreList, "main");
}

/**
 * Returns true if the workflow has an `on.schedule` trigger.
 * @param {string} text
 * @returns {boolean}
 */
export function hasSchedule(text) {
  const doc = jsYaml.load(text);
  if (!doc || typeof doc !== "object") return false;

  const on = doc["on"] ?? doc["true"];
  if (!on) return false;

  if (typeof on === "string") return on === "schedule";
  if (Array.isArray(on)) return on.includes("schedule");
  if (typeof on !== "object") return false;

  return Object.prototype.hasOwnProperty.call(on, "schedule");
}

/**
 * Extract the list of workflow names from the notifier's workflow_run.workflows
 * list. Returns a Set of strings.
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseNotifierList(text) {
  const doc = jsYaml.load(text);
  if (!doc || typeof doc !== "object") return new Set();

  const on = doc["on"] ?? doc["true"];
  if (!on || typeof on !== "object") return new Set();

  const workflowRun = on["workflow_run"];
  if (!workflowRun || typeof workflowRun !== "object") return new Set();

  const workflows = workflowRun["workflows"];
  if (!Array.isArray(workflows)) return new Set();

  return new Set(workflows.map(String));
}
