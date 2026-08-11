/**
 * The sentry-suite gate's INTEGRITY layer (issue #1779, ADR 0062).
 *
 * Split out of scripts/sentry-suite-gate.mjs when that file crossed the repo's
 * 1,000-line hard cap, along the same seam as the test split: this module owns
 * "is a gate run trustworthy as a whole", the runner owns "did this one suite
 * assert". A pure move — no behaviour change.
 *
 * Everything here answers one question: what could change a suite's result, and
 * did any of it change while the gate was running? The answer is derived rather
 * than listed, because a hand-written list was wrong three times: it missed the
 * exemption route's inputs, then enumeration itself, then each suite's
 * transitive first-party imports.
 *
 * Dependency-free (node builtins only), like everything the gate spawns.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

/** The manifest, the runner, and the second half of every exemption proof. */
export const MANIFEST_LABEL = "scripts/sentry-suite-manifest.json";
export const GATE_LABEL = "scripts/sentry-suite-gate.mjs";
export const PACKAGE_JSON_LABEL = "package.json";

/**
 * A structural failure this layer cannot proceed past. Its own class so the
 * module stays free of a back-import from the runner, which would be a cycle.
 */
export class IntegrityError extends Error {}

/**
 * SHA-256 of a file's bytes, or `null` when it cannot be read (deleted mid-run
 * is itself a tamper signal, so the caller reports the difference rather than
 * throwing here).
 *
 * @param {string} path
 * @returns {string | null}
 */
export function digestFile(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Digest every file whose bytes must not change while the gate runs: each
 * manifest-listed suite, the manifest itself, and the gate's own source.
 *
 * Every child shares one writable checkout, so without this an alphabetically
 * earlier suite can overwrite a later one with a program that prints the
 * expected `ok` lines and a matching summary — both then report passing and the
 * gate's central claim, that each suite's result came from that suite, is void.
 * Reproduced before this existed: a `sentry-aaa-attacker` suite rewrote
 * `sentry-zzz-victim` (a genuinely failing suite) and the gate exited 0 with
 * both rows `ok`.
 *
 * @param {string[]} suites repo-relative suite paths
 * @param {string} root
 * @returns {Map<string, string | null>} repo-relative path to digest
 */
export function digestWatchSet(manifest, root) {
  return new Map(
    gateInputs(manifest, root).map((relative) => [
      relative,
      digestFile(join(root, relative)),
    ]),
  );
}

/**
 * Every file the gate READS in order to decide anything, derived from the
 * manifest rather than listed by hand.
 *
 * The watch set was twice decided by asking "which files feel load-bearing",
 * and twice missed one: the exemption route trusts BOTH the importer named in
 * the entry and `package.json` (it must contain a script that runs that
 * importer), and neither was watched — so an earlier alphabetic suite could
 * restore the import in the job's writable checkout and forge an intact route
 * for a suite the production job never runs (measured: gate exit 0 on a
 * throwing exempt suite).
 *
 * The right question is what the gate consults to reach a verdict, so this
 * derives that set from the decision inputs themselves:
 *
 *   - the manifest — decides the expected set, floors, reporters, exemptions;
 *   - the gate's own source — decides how every result is judged;
 *   - every manifest-listed suite — the thing whose output is the verdict;
 *   - per exempt entry, its `importer` and `package.json` — the only evidence
 *     that an unrun suite still runs somewhere else.
 *
 * Anything added to the manifest that brings a new input with it lands in the
 * watch set automatically, which is the property the hand-written list lacked.
 *
 * @param {{ suites: Record<string, any> }} manifest
 * @returns {string[]} repo-relative paths, sorted
 */
export function gateInputs(manifest, root) {
  // Required, and checked: without it every import closure silently reads
  // nothing and the derived set quietly shrinks back to the pre-closure one —
  // the exact regression this function exists to prevent, arriving as a
  // convenience default.
  if (typeof root !== "string" || root === "") {
    throw new IntegrityError(
      "gateInputs requires the repository root; without it the import closures cannot be read",
    );
  }
  const inputs = new Set([MANIFEST_LABEL, GATE_LABEL]);
  const external = [];
  for (const [suite, entry] of Object.entries(manifest?.suites ?? {})) {
    inputs.add(suite);
    // A suite's verdict is only as trustworthy as everything that determines
    // its output, which includes every module it pulls in, transitively.
    const closure = localImportClosure(suite, root);
    for (const dependency of closure.local) inputs.add(dependency);
    external.push(...closure.external);
    if (!entry?.exempt) continue;
    // Both halves of the route proof, per ADR 0062.
    inputs.add(entry.exempt.importer);
    for (const dependency of localImportClosure(entry.exempt.importer, root)
      .local) {
      inputs.add(dependency);
    }
    inputs.add(PACKAGE_JSON_LABEL);
  }
  if (external.length > 0) {
    // Fail closed rather than watch a moving target. Nothing under scripts/
    // reaches outside the repository today, and a relative import that does
    // cannot be pinned by a repo-relative digest, so the honest answer is to
    // refuse rather than to report a watch set that silently excludes it.
    throw new IntegrityError(
      `these relative imports resolve outside the repository, so their content cannot be watched: ${JSON.stringify(
        [...new Set(external)].sort(),
      )}. A suite's dependencies must live in this repository.`,
    );
  }
  return [...inputs].sort();
}

/**
 * The specifiers of a module's TOP-LEVEL static imports and re-exports.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function topLevelImportSpecifiers(source) {
  // Line-anchored, unlike `staticImportSpecifiers`, and deliberately so. A
  // static `import` is a top-level statement by specification, so it always
  // begins a line; a test file that embeds FIXTURE source as string literals
  // (`'import "./helper.mjs";'`) does not, and the unanchored scanner counted
  // those as real dependencies — which pulled non-existent paths into the watch
  // set and turned a fixture's deliberately-escaping import into a hard error
  // for the whole gate. Comments are stripped first so a mention in prose is
  // not a dependency either.
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const specifiers = [];
  const pattern =
    /^[ \t]*(?:import|export)\s+(?:[^'"()\n]*?\sfrom\s*)?['"]([^'"]+)['"]/gm;
  let match;
  while ((match = pattern.exec(withoutComments)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Every first-party module a file pulls in, transitively, as repo-relative
 * paths.
 *
 * Only RELATIVE specifiers are followed: a bare specifier is either a `node:`
 * builtin (immutable, and everything the gate spawns is dependency-free) or a
 * package, whose content is pinned by the lockfile rather than by this run.
 *
 * The closure is what makes a suite's result attributable to that suite. Before
 * it, an alphabetically earlier suite could rewrite a HELPER a later suite
 * imports — not the suite file, so no digest covered it — and the later suite's
 * forged pass was accepted (measured: a suite that fails against its committed
 * helper reported `ok` at exit 0).
 *
 * @param {string} relative repo-relative entry path
 * @param {string} root
 * @param {Set<string>} [seen] cycle guard, also the accumulator
 * @returns {{ local: string[], external: string[] }}
 */
export function localImportClosure(relative, root, seen = new Set()) {
  const external = [];
  let source;
  try {
    source = readFileSync(join(root, relative), "utf8");
  } catch {
    // Unreadable or absent: the digest layer records that as its own drift, and
    // a broken import fails the suite on its own merits.
    return { local: [...seen], external };
  }
  const fromDir = dirname(relative);
  for (const specifier of topLevelImportSpecifiers(source)) {
    if (!specifier.startsWith(".")) continue;
    const resolved = normalize(join(fromDir, specifier));
    if (resolved.startsWith("..") || isAbsolute(resolved)) {
      external.push(`${relative} -> ${specifier}`);
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const nested = localImportClosure(resolved, root, seen);
    external.push(...nested.external);
  }
  return { local: [...seen], external };
}

/**
 * Compare current bytes against the pre-run snapshot.
 *
 * @param {Map<string, string | null>} baseline
 * @param {string} root
 * @param {string[]} [only] restrict the check to these paths; default all
 * @returns {string[]} human-readable descriptions of every file that changed
 */
export function digestDrift(baseline, root, only) {
  const paths = only ?? [...baseline.keys()];
  const drift = [];
  for (const relative of paths) {
    const before = baseline.get(relative);
    const now = digestFile(join(root, relative));
    if (before === now) continue;
    if (now === null) {
      drift.push(`${relative} was DELETED while the gate was running`);
    } else if (before === null) {
      drift.push(`${relative} was CREATED while the gate was running`);
    } else {
      drift.push(
        `${relative} was REWRITTEN while the gate was running (${before.slice(0, 12)} → ${now.slice(0, 12)})`,
      );
    }
  }
  return drift;
}
