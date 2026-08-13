/**
 * Label self-heal for the Sentry triage pipeline's settlement paths.
 *
 * Only the ingest job CREATES the queue's label set, so any name added to
 * LABEL_DEFINITIONS is absent from the repo until ingest next runs — and `gh`
 * errors on a repo-nonexistent label, on `--remove-label` exactly as on
 * `--add-label`. A consumer that ships ahead of that bootstrap therefore fails
 * on a name it was right to use, which is what took the verdict step down on
 * 2026-08-13 (`sentry:fix-scope-architectural` reached the shed list of every
 * non-architectural verdict hours before the ingest run that would have created
 * it). Every path that writes labels creates them from the single source first;
 * this module is that step for the projection leg and for the workflow's
 * settlement step, which reaches it through
 * `sentry-triage-project.mjs --ensure-labels`.
 *
 * Its own I/O is injected: the caller owns the `gh` runner (and its token
 * routing), so this file stays a pure mechanism and never imports the leg that
 * imports it.
 */

import { LABEL_DEFINITIONS } from "./sentry-triage-ingest.mjs";

/**
 * Parse the `--ensure-labels` value: a comma list, the shape the workflow
 * already builds for `--remove-label`. Empty segments are dropped so an empty
 * shed list costs nothing. An EMPTY set is a wiring bug — a step that ensures
 * nothing would silently reintroduce the failure this mode exists to prevent —
 * so it fails loud here rather than no-opping.
 */
export function parseEnsureLabelNames(raw) {
  const names = String(raw ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) {
    throw new Error("--ensure-labels requires at least one label name");
  }
  return names;
}

/**
 * SELF-HEAL a named set of labels from the single source of truth (Stage A's
 * LABEL_DEFINITIONS), the pattern every other settlement path in this pipeline
 * already uses before it writes labels (`.github/workflows/sentry-autofix.yml`
 * via `sentry-autofix-finalize.mjs label-def`, `ensureArchiveLabels` in
 * `scripts/sentry-triage-archive.mjs`, and `runProjectionBatch`).
 *
 * BEST-EFFORT per label: a create that fails warns and the loop continues, so
 * the ensure never becomes the thing that kills a settlement; the write it was
 * protecting still fails loudly, with compensation. A name absent from
 * LABEL_DEFINITIONS is drift in the single source, so it is reported as a
 * workflow annotation rather than silently skipped.
 *
 * `localRun` is the one-argument `gh` runner (no token override — these are
 * local-repo writes under the ambient GH_TOKEN).
 *
 * Returns `{ ensured, unknown, failed }` — name lists, for the CLI's JSON.
 */
export async function ensureQueueLabels(localRun, repo, names) {
  const result = { ensured: [], unknown: [], failed: [] };
  for (const name of [...new Set(names)]) {
    const def = LABEL_DEFINITIONS.find((entry) => entry.name === name);
    if (!def) {
      process.stderr.write(
        `::warning::${name} is not in LABEL_DEFINITIONS, so it cannot be self-healed; the label single-source drifted.\n`,
      );
      result.unknown.push(name);
      continue;
    }
    try {
      await localRun([
        "label",
        "create",
        def.name,
        "--repo",
        repo,
        "--color",
        def.color,
        "--description",
        def.description,
        "--force",
      ]);
      result.ensured.push(name);
    } catch (error) {
      process.stderr.write(
        `warning: could not ensure label ${name}: ${error.message}\n`,
      );
      result.failed.push(name);
    }
  }
  return result;
}

/**
 * `--ensure-labels` mode: the settlement step's pre-flight. The verdict step in
 * `.github/workflows/sentry-triage-agent.yml` runs it with every label its one
 * `gh issue edit` names — the verdict label being added, the whole shed list,
 * and `sentry:needs-triage` — immediately before that edit.
 *
 * `deps.runGh` is REQUIRED: this module owns no runner of its own, so the entry
 * script passes its `gh` wrapper and the tests pass a recorder.
 */
export async function runEnsureLabels(options, deps = {}) {
  const { runGh } = deps;
  if (typeof runGh !== "function") {
    throw new Error("runEnsureLabels requires a gh runner (deps.runGh)");
  }
  const localRun = (args) => runGh(args, {});
  return ensureQueueLabels(localRun, options.localRepo, options.ensureLabels);
}
