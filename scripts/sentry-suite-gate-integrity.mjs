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
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { staticImportsOf } from "./static-imports.mjs";

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
 * `inputs` is accepted so a caller that already derived the set does not derive
 * it twice: the closure costs ~185ms of child processes on the real manifest,
 * and the gate needs the same list for its per-suite snapshots.
 *
 * @param {{ suites: Record<string, any> }} manifest
 * @param {string} root
 * @param {string[]} [inputs] precomputed `gateInputs(manifest, root)`
 * @returns {Map<string, string | null>} repo-relative path to digest
 */
export function digestWatchSet(manifest, root, inputs) {
  return new Map(
    (inputs ?? gateInputs(manifest, root)).map((relative) => [
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
  // The gate's own source decides how every result is judged, and half of that
  // source lives in the modules it imports — this one included. Closing over
  // GATE_LABEL keeps them watched by derivation rather than by remembering to
  // list them, which is the property the hand-written set lacked.
  const entryPoints = [GATE_LABEL];
  for (const [suite, entry] of Object.entries(manifest?.suites ?? {})) {
    inputs.add(suite);
    // A suite's verdict is only as trustworthy as everything that determines
    // its output, which includes every module it pulls in, transitively.
    entryPoints.push(suite);
    // …and every repository file it READS. Imports are derivable; runtime reads
    // are not, so the manifest declares them and the snapshot makes the
    // declaration self-enforcing: a suite reading a file it did not declare
    // finds it absent and fails (Codex 3761572727 reported one such read; the
    // sparse snapshot found six across three suites).
    for (const read of entry?.reads ?? []) inputs.add(read);
    // A declared directory's ENTRIES are watched individually, so a rewrite of
    // any one of them is drift in the shared checkout exactly as a declared
    // file's would be. The directory itself is not a digestible thing.
    for (const dir of entry?.readsDirs ?? []) {
      for (const file of filesUnder(join(root, dir))) {
        inputs.add(`${dir}/${file}`);
      }
    }
    if (!entry?.exempt) continue;
    // Both halves of the route proof, per ADR 0062.
    inputs.add(entry.exempt.importer);
    entryPoints.push(entry.exempt.importer);
    inputs.add(PACKAGE_JSON_LABEL);
  }
  // One closure over every entry point, so a module imported by several suites
  // is parsed once rather than once per importer.
  const { local, external } = importClosure(entryPoints, root);
  for (const dependency of local) inputs.add(dependency);
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
 * Every first-party module these files pull in, transitively, as repo-relative
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
 * The import list comes from V8 (`staticImportsOf`), not from a regex. The
 * regex this replaced was line-anchored — to stop it counting `import` inside a
 * string literal — and therefore blind to ordinary MULTILINE imports, so
 * `sentry-autofix-select.mjs`, `sentry-autofix-finalize.mjs` and
 * `sentry-triage-agent-comment.mjs` were absent from the derived watch set on
 * the very branch that introduced it (Codex 3761232904): an earlier suite could
 * rewrite a later suite's implementation, forge its pass, and leave the final
 * digest sweep green.
 *
 * Breadth-first, one child process per frontier, because a spawn costs ~28ms
 * and the real closure is ~45 files.
 *
 * @param {string[]} entries repo-relative entry paths
 * @param {string} root
 * @returns {{ local: string[], external: string[] }} `local` excludes an entry
 *   unless another module imports it
 */
export function importClosure(entries, root) {
  const seen = new Set();
  const external = [];
  let frontier = [...new Set(entries)];
  const parsed = new Set(frontier);
  while (frontier.length > 0) {
    const results = staticImportsOf(frontier.map((r) => join(root, r)));
    const next = [];
    for (const relative of frontier) {
      const result = results.get(join(root, relative));
      if (!result || result.error !== undefined) {
        // Absent is tolerated: the digest layer records a missing watched file
        // as its own drift, and an unresolvable import fails the suite on its
        // own merits. Present-but-unparsable is NOT — silently returning "no
        // dependencies" for a file V8 refused is exactly how a dependency slips
        // out of the watch set.
        if (result && !result.missing) {
          throw new IntegrityError(
            `${relative} could not be parsed for its static imports (${result.error}); ` +
              "the gate cannot derive what determines a suite's result from a file it cannot read as a module",
          );
        }
        continue;
      }
      const fromDir = dirname(relative);
      for (const specifier of result.specifiers) {
        if (!specifier.startsWith(".")) continue;
        const resolved = normalize(join(fromDir, specifier));
        if (resolved.startsWith("..") || isAbsolute(resolved)) {
          external.push(`${relative} -> ${specifier}`);
          continue;
        }
        if (!seen.has(resolved)) seen.add(resolved);
        if (parsed.has(resolved)) continue;
        parsed.add(resolved);
        next.push(resolved);
      }
    }
    frontier = next;
  }
  return { local: [...seen], external };
}

/**
 * `importClosure` for a single entry point.
 *
 * @param {string} relative repo-relative entry path
 * @param {string} root
 * @returns {{ local: string[], external: string[] }}
 */
export function localImportClosure(relative, root) {
  return importClosure([relative], root);
}

/**
 * Every file under `dir`, at any depth, as paths relative to `dir`.
 *
 * A Dirent is an `lstat`, so a directory SYMLINK reports `isDirectory() ===
 * false` and would be listed as a file and copied as one (EISDIR). Resolve
 * links with `statSync` and walk them, exactly as `findSentrySuites` does — a
 * suite reachable only through a link is one the enumeration must see. Copying
 * by content rather than relinking also means a finished snapshot contains no
 * symlink at all, so no path inside one can address anything outside it.
 *
 * @param {string} dir absolute
 * @param {string} [prefix]
 * @param {Set<string>} [ancestors] cycle guard over resolved paths
 * @returns {string[]}
 */
export function filesUnder(dir, prefix = "", ancestors = new Set()) {
  const found = [];
  const here = join(dir, prefix);
  let real;
  try {
    real = realpathSync(here);
  } catch {
    return found;
  }
  if (ancestors.has(real)) {
    throw new IntegrityError(
      `symlink cycle under a declared directory at ${prefix || dir} — resolve it; ` +
        "a snapshot cannot copy a cycle",
    );
  }
  const nextAncestors = new Set(ancestors).add(real);
  let entries;
  try {
    entries = readdirSync(here, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDirectory = statSync(join(dir, relative)).isDirectory();
      } catch {
        // A broken link has no content to copy and nothing to enumerate.
        continue;
      }
    }
    if (isDirectory) found.push(...filesUnder(dir, relative, nextAncestors));
    else found.push(relative);
  }
  return found;
}

/**
 * Copy `files` out of `root` into a fresh directory: one suite's immutable view
 * of the committed tree.
 *
 * This is what makes a suite's result its own. Digests could only ever DETECT
 * interference, and only interference that persisted: an earlier suite that
 * replaced a watched helper with a module restoring the original bytes during
 * import, then exporting a forged value, left the final digest matching the
 * baseline and the gate exiting 0 (Codex 3761572724). Before/after hashes
 * cannot see a transient rewrite. Separate directories can — because there is
 * nothing to see. Every child reads a tree no other child can reach.
 *
 * Snapshots are taken for ALL suites before the FIRST child starts. Taken
 * lazily, an earlier suite could poison the shared checkout and a later
 * snapshot would faithfully copy the poison.
 *
 * Only the derived input set is copied, not the 2,124-file tracked tree: the
 * full copy measured 1.48s each and 18.8s for thirteen, against 20ms and 241ms
 * for these ~65 files. The sparseness is also what makes an undeclared runtime
 * read fail loudly instead of silently succeeding.
 *
 * @param {string[]} files repo-relative paths
 * @param {string} root
 * @param {string} dest existing directory to fill
 * @returns {string} dest
 */
export function snapshotInputs(files, root, dest, dirs = []) {
  for (const relative of files) {
    const target = join(dest, relative);
    mkdirSync(dirname(target), { recursive: true });
    try {
      copyFileSync(join(root, relative), target);
    } catch (err) {
      // A watched file that cannot be copied is a watched file the suite would
      // read as absent. Say so here rather than letting it surface as a
      // confusing failure inside the child.
      if (err.code !== "ENOENT") throw err;
    }
  }
  // Declared DIRECTORIES are copied whole, entries and all.
  //
  // Sparseness is self-enforcing for a suite that OPENS a named file — the file
  // is absent and the suite dies. It is the opposite for a suite that
  // ENUMERATES a directory: a sparsely populated directory does not throw, it
  // yields fewer entries, and a structural check over them passes having
  // checked almost nothing. `sentry-triage-requeue.test.mjs` walks every
  // non-test `scripts/*.mjs` to prove one function has a single call site; the
  // derived set carried 25 of 92, so a forbidden call in any of the other 67
  // was invisible (Codex 3761902959). Silent weakening is worse than loud
  // breakage, and it is the failure mode this whole gate exists to prevent.
  for (const relative of dirs) {
    for (const file of filesUnder(join(root, relative))) {
      const target = join(dest, relative, file);
      mkdirSync(dirname(target), { recursive: true });
      try {
        copyFileSync(join(root, relative, file), target);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
  }
  return dest;
}

/**
 * Digest every file in a snapshot, so the child about to read it can be shown
 * the bytes are the ones copied.
 *
 * @param {string} dest snapshot root
 * @param {string} [prefix]
 * @returns {Map<string, string | null>}
 */
export function snapshotDigest(dest, prefix = "") {
  const digests = new Map();
  for (const entry of readdirSync(join(dest, prefix), {
    withFileTypes: true,
  })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [k, v] of snapshotDigest(dest, relative)) digests.set(k, v);
    } else {
      digests.set(relative, digestFile(join(dest, relative)));
    }
  }
  return digests;
}

/**
 * What changed in a snapshot since it was taken.
 *
 * This is the check that actually closes sibling tampering, and it is NOT the
 * model deleted in the previous round. That one hashed the shared checkout
 * after every child had finished, which a rewrite could undo before the sweep
 * looked. This hashes the specific inputs of the ONE child about to run, at the
 * moment it runs — and a poisoner has by definition already exited, so its
 * write is on disk and cannot be taken back.
 *
 * @param {Map<string, string | null>} baseline
 * @param {string} dest
 * @returns {string[]}
 */
export function snapshotDrift(baseline, dest) {
  const now = snapshotDigest(dest);
  const drift = [];
  for (const [relative, before] of baseline) {
    const after = now.get(relative) ?? null;
    if (before === after) continue;
    drift.push(
      after === null
        ? `${relative} was DELETED from this suite's snapshot`
        : `${relative} was REWRITTEN in this suite's snapshot`,
    );
  }
  for (const relative of now.keys()) {
    if (!baseline.has(relative)) {
      drift.push(`${relative} was ADDED to this suite's snapshot`);
    }
  }
  return drift;
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
