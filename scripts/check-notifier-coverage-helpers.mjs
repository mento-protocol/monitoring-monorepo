/**
 * Parse helpers for check-notifier-coverage.mjs.
 * Extracted as a separate module so the script and its test file can both
 * import the real implementations instead of duplicating them.
 *
 * No external dependencies — pure regex / string operations.
 */

/**
 * Extract the `name:` field value from a workflow YAML text.
 * Returns null if not found.
 * @param {string} text
 * @returns {string|null}
 */
export function parseName(text) {
  const m = text.match(/^name:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

/**
 * Returns true if the workflow has an `on.push` trigger targeting `main`.
 * Handles:
 *   - Inline form:        branches: [main]
 *   - Block-sequence:     branches:\n      - main
 *   - Branchless push:    push: (no branches / branches-ignore) → runs on ALL
 *                         branches, including main
 * @param {string} text
 */
export function hasPushMain(text) {
  // Extract the `on:` block — everything until the next top-level key, with a
  // fallback for when `on:` is the last key (nothing follows at column 0).
  const onMatch =
    text.match(/^on:\s*\n([\s\S]*?)(?=^\S)/m) ??
    text.match(/^on:\s*\n([\s\S]*)$/m);
  if (!onMatch) return false;
  const onBlock = onMatch[1];

  // Look for a `push:` sub-key within the on: block, then capture everything
  // until the next same-level (2-space-indented) key.
  const pushMatch = onBlock.match(/^ {2}push:\s*\n((?:(?!^ {2}\S)[\s\S])*)/m);
  if (!pushMatch) return false;
  const pushBlock = pushMatch[1];

  // Branchless push — no `branches:` or `branches-ignore:` restriction means
  // the workflow runs on every push, which includes main.
  if (!/branches/.test(pushBlock)) return true;

  // Inline form:  branches: [main]  or  branches: [main, develop]
  if (/branches:\s*\[?[^\]]*\bmain\b/.test(pushBlock)) return true;
  // Block-sequence form:
  //   branches:
  //     - main
  if (/branches:\s*\n(?:\s*-\s+\S+\n)*\s*-\s+main\b/.test(pushBlock))
    return true;
  return false;
}

/**
 * Returns true if the workflow has an `on.schedule` trigger.
 * @param {string} text
 */
export function hasSchedule(text) {
  return /^ {2}schedule:\s*$/m.test(text);
}

/**
 * Extract the list of workflow names from the notifier's workflow_run.workflows
 * list. Returns a Set of strings.
 * @param {string} text
 */
export function parseNotifierList(text) {
  // Find the `workflows:` key under `workflow_run:` and collect all `- Name` entries.
  const workflowRunMatch = text.match(
    /workflow_run:\s*\n\s+workflows:\s*\n([\s\S]*?)(?=\s+types:)/,
  );
  if (!workflowRunMatch) return new Set();

  const listBlock = workflowRunMatch[1];
  const names = new Set();
  for (const m of listBlock.matchAll(/^\s+-\s+(.+)$/gm)) {
    names.add(m[1].trim().replace(/^['"]|['"]$/g, ""));
  }
  return names;
}
