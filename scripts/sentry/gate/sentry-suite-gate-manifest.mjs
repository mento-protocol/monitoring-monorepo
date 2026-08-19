/**
 * The sentry-suite gate's MANIFEST layer (issue #1779, ADR 0062).
 *
 * Split out of scripts/sentry/gate/sentry-suite-gate.mjs when that file crossed the repo's
 * 1,000-line hard cap, along a seam the file already had: this module owns "is
 * the manifest a legal description of a run", the runner owns "did this one
 * suite assert", the integrity module owns "is the run trustworthy as a whole".
 * A pure move — no behaviour change — except that `ROOT` was a module constant
 * in the runner and is a parameter here, because a validator that closes over
 * one root cannot be pointed at a fixture.
 *
 * Dependency-free (node builtins only), like everything the gate spawns.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import { MANIFEST_LABEL } from "./sentry-suite-gate-integrity.mjs";

/** A fatal, structural failure the gate cannot proceed past (env, manifest, set drift). */
export class GateError extends Error {}

/**
 * The manifest schema, as an ALLOWLIST.
 *
 * Same inversion as the CI-job pin: enumerating bad values could not converge,
 * because every field here is honoured verbatim by the runner. `nodeArgs` is
 * spread into node's argv and `exempt` skips execution outright, so both were
 * usable to pass a throwing suite (both measured). A field the schema does not
 * list cannot influence a run, whatever a future edit calls it.
 */
const MANIFEST_TOP_LEVEL_KEYS = ["_readme", "suites"];
const ENTRY_KEYS = [
  "reporter",
  "floor",
  "nodeArgs",
  "exempt",
  "reads",
  "readsDirs",
];

/** The only `nodeArgs` the design needs: the node:test runner. */
const SUPPORTED_NODE_ARGS = ["--test"];

/** The one suite that may be exempt, and the exact route ADR 0062 records. */
const EXEMPT_SUITE = "scripts/sentry/gate/sentry-provider-contract.test.mjs";
const EXEMPT_ROUTE = {
  runBy: "production-infra-contract",
  via: "pnpm tf:test",
  importer: "scripts/tf-stacks.test.mjs",
};

/**
 * Load and shallow-validate the manifest. A malformed manifest is a fatal
 * fail-closed condition, not a skip.
 *
 * @param {string} path
 * @param {string} root repository root the declared paths are resolved against
 * @returns {{ suites: Record<string, object> }}
 */
export function loadManifest(path, root) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new GateError(
      `cannot read ${MANIFEST_LABEL} (${path}): ${err.message}. This file is the gate's source of truth — it must exist and list every scripts/sentry-*.test.mjs.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GateError(
      `${MANIFEST_LABEL} is not valid JSON: ${err.message}. Fix the JSON syntax in ${MANIFEST_LABEL}.`,
    );
  }
  if (!parsed || typeof parsed.suites !== "object" || parsed.suites === null) {
    throw new GateError(
      `${MANIFEST_LABEL} has no "suites" object. Give it a top-level "suites" map of "scripts/sentry-<x>.test.mjs" to its reporter and floor.`,
    );
  }
  // Top-level keys by allowlist, same discipline as the suite set itself.
  for (const key of Object.keys(parsed)) {
    if (MANIFEST_TOP_LEVEL_KEYS.includes(key)) continue;
    throw new GateError(
      `${MANIFEST_LABEL} has an unrecognised top-level key "${key}" — only ${MANIFEST_TOP_LEVEL_KEYS.map(
        (k) => `"${k}"`,
      ).join(" and ")} are allowed.`,
    );
  }

  for (const [key, entry] of Object.entries(parsed.suites)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new GateError(
        `the entry for ${key} in ${MANIFEST_LABEL} is not an object — give it { "reporter": …, "floor": … }.`,
      );
    }

    // Per-entry keys by allowlist. A field nobody has thought of cannot change
    // how a suite is run if the schema refuses to carry it.
    for (const field of Object.keys(entry)) {
      if (ENTRY_KEYS.includes(field)) continue;
      throw new GateError(
        `${key} has an unrecognised field "${field}" in ${MANIFEST_LABEL} — entries carry only ${ENTRY_KEYS.map(
          (f) => `"${f}"`,
        ).join(
          ", ",
        )}; anything else is rejected rather than silently honoured.`,
      );
    }

    const reporters = ["count-line", "node-test", "exit-only"];
    if (!reporters.includes(entry.reporter)) {
      throw new GateError(
        `${key} has an unknown reporter ${JSON.stringify(entry.reporter)} in ${MANIFEST_LABEL} — set "reporter" to one of ${reporters
          .map((r) => `"${r}"`)
          .join(", ")}.`,
      );
    }

    // `nodeArgs` is spread verbatim into the spawn, so an arbitrary value is
    // arbitrary control over node's argv: `["--eval", "console.log('1 passed')"]`
    // makes node treat the suite PATH as a positional argument and never run it,
    // so a throwing suite is judged green (measured). Only the one invocation
    // the design actually needs is permitted, matched exactly.
    if (entry.nodeArgs !== undefined) {
      const encoded = JSON.stringify(entry.nodeArgs);
      if (encoded !== JSON.stringify(SUPPORTED_NODE_ARGS)) {
        throw new GateError(
          `${key} sets "nodeArgs": ${encoded} in ${MANIFEST_LABEL} — the only supported value is ` +
            `${JSON.stringify(SUPPORTED_NODE_ARGS)} (the node:test runner). nodeArgs is passed straight to ` +
            "node, so anything else can stop the suite from running at all.",
        );
      }
      if (entry.reporter !== "node-test") {
        throw new GateError(
          `${key} sets "nodeArgs" with reporter "${entry.reporter}" in ${MANIFEST_LABEL} — ` +
            `${JSON.stringify(SUPPORTED_NODE_ARGS)} is only meaningful for the "node-test" reporter.`,
        );
      }
    }

    // `reads` names the repository files a suite opens directly, which no
    // import closure can derive. Each one joins the watch set AND that suite's
    // snapshot, so the declaration is self-enforcing rather than documentation:
    // declare too little and the suite fails on the missing file; declare a
    // path that does not exist and the gate says so here.
    if (entry.reads !== undefined) {
      if (
        !Array.isArray(entry.reads) ||
        entry.reads.some((r) => typeof r !== "string" || r === "")
      ) {
        throw new GateError(
          `${key} has a "reads" that is not an array of repo-relative paths in ${MANIFEST_LABEL} ` +
            `(got ${JSON.stringify(entry.reads)}).`,
        );
      }
      for (const read of entry.reads) {
        // A snapshot is built by joining these onto a temp directory, so an
        // absolute path or one climbing out would write outside it.
        if (isAbsolute(read) || normalize(read).startsWith("..")) {
          throw new GateError(
            `${key} declares a "reads" entry ${JSON.stringify(read)} in ${MANIFEST_LABEL} that is not ` +
              "inside the repository; declared reads are repo-relative paths.",
          );
        }
        if (!existsSync(join(root, read))) {
          throw new GateError(
            `${key} declares a "reads" entry ${JSON.stringify(read)} in ${MANIFEST_LABEL}, but no such ` +
              "file exists — remove it, or fix the path; a declared read that is absent would be " +
              "absent from the suite's snapshot too.",
          );
        }
      }
    }

    // `readsDirs` names directories a suite ENUMERATES. Same validation as
    // `reads`, plus the entry must actually be a directory: declaring a file
    // here would copy it without its siblings and leave the enumeration sparse,
    // which is the silent failure this field exists to remove.
    if (entry.readsDirs !== undefined) {
      if (
        !Array.isArray(entry.readsDirs) ||
        entry.readsDirs.some((r) => typeof r !== "string" || r === "")
      ) {
        throw new GateError(
          `${key} has a "readsDirs" that is not an array of repo-relative paths in ${MANIFEST_LABEL} ` +
            `(got ${JSON.stringify(entry.readsDirs)}).`,
        );
      }
      for (const dir of entry.readsDirs) {
        if (isAbsolute(dir) || normalize(dir).startsWith("..")) {
          throw new GateError(
            `${key} declares a "readsDirs" entry ${JSON.stringify(dir)} in ${MANIFEST_LABEL} that is not ` +
              "inside the repository; declared directory reads are repo-relative paths.",
          );
        }
        if (
          !existsSync(join(root, dir)) ||
          !statSync(join(root, dir)).isDirectory()
        ) {
          throw new GateError(
            `${key} declares a "readsDirs" entry ${JSON.stringify(dir)} in ${MANIFEST_LABEL}, but that is ` +
              "not a directory — `readsDirs` copies a directory and every entry under it, so that a suite " +
              "which enumerates it sees what the checkout has; name a file in `reads` instead.",
          );
        }
      }
    }

    if (entry.exempt !== undefined) {
      // Exemption skips execution and every count check, so it is the single
      // most powerful field here: marking any suite exempt hides it entirely
      // (measured — a throwing suite reported `exempt` at exit 0). It is
      // therefore permitted for exactly one suite, with exactly the route ADR
      // 0062 records, compared structurally rather than field-by-field.
      if (key !== EXEMPT_SUITE) {
        throw new GateError(
          `${key} is marked "exempt" in ${MANIFEST_LABEL}, but exemption is reserved for ` +
            `${EXEMPT_SUITE} alone. Every other suite must be RUN by the gate; exempting one ` +
            "skips its execution and all of its count checks.",
        );
      }
      const encoded = JSON.stringify(
        entry.exempt,
        Object.keys(EXEMPT_ROUTE).sort(),
      );
      const expected = JSON.stringify(
        EXEMPT_ROUTE,
        Object.keys(EXEMPT_ROUTE).sort(),
      );
      if (
        encoded !== expected ||
        Object.keys(entry.exempt).sort().join() !==
          Object.keys(EXEMPT_ROUTE).sort().join()
      ) {
        throw new GateError(
          `${key}'s "exempt" route in ${MANIFEST_LABEL} is ${JSON.stringify(entry.exempt)}, but the only ` +
            `route ADR 0062 records is ${expected}. The route is matched exactly, so it cannot be ` +
            "pointed at a different job or importer.",
        );
      }
      if (entry.floor !== undefined) {
        throw new GateError(
          `${key} is exempt but also carries a "floor" in ${MANIFEST_LABEL} — an exempt suite is ` +
            "never run here, so a floor on it would be meaningless.",
        );
      }
    } else if (!Number.isInteger(entry.floor) || entry.floor < 1) {
      throw new GateError(
        `${key} needs an integer "floor" >= 1 in ${MANIFEST_LABEL} (got ${JSON.stringify(
          entry.floor,
        )}) — set it to the suite's current pass count.`,
      );
    }
  }
  return parsed;
}
