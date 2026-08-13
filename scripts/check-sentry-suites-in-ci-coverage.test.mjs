/**
 * The exemption route and the package-script contracts behind
 * scripts/check-sentry-suites-in-ci.test.mjs.
 *
 * Split out when the entry point reached the repo's 1,000-line hard cap (issue
 * #1803).
 *
 * This half asserts the things about running the suites that the runtime gate
 * cannot see: the provider-contract exemption's CI route (the gate checks the
 * alias command, but never that a real, unconditional job runs it), that no
 * `sentry:*:test` alias points somewhere unenumerated, and the local gate's
 * tooling allowlist with its exact-command pins. The entry point keeps the
 * ci.yml workflow-shape assertions (trusted job, sentinel, triggers, env
 * mutation, composite recursion, check-run ownership) and the self/meta checks.
 *
 * Issue #1779 PR C retired what used to be this file's main invariant — that
 * every suite has a direct `node <suite>` step in the `scripts` job, plus the
 * pnpm-alias and `presentry:*:test` rejection probes behind it. The
 * `sentry-suites` gate now runs each suite itself, as a `node` child under
 * `env -u`, reconciled against the manifest by exact set equality, and asserts
 * from the child's own output that it passed. No pnpm alias is on that path for
 * any non-exempt suite, so neither fail-open the probes covered is reachable,
 * and "a step exists" is a strictly weaker claim than "the suite ran and
 * asserted".
 *
 * The entry point imports this module, so the single
 * `node scripts/check-sentry-suites-in-ci.test.mjs` CI step still runs it.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  aliasesFor,
  commandRunsOnly,
  invocationsOf,
  nearMisses,
  provenCommands,
  runsCommand,
  suiteTargets,
} from "./check-sentry-suites-in-ci-core.mjs";
import {
  CI,
  gateClassifications,
  PKG_SCRIPTS,
  RUN_BY_ANOTHER_JOB,
  SCRIPTS_DIR,
  SENTRY_SUITES,
  staticImports,
  VALIDATOR_PATH,
  validatorPins,
} from "./check-sentry-suites-in-ci-probes.mjs";

test("the exemption for sentry-provider-contract still holds", () => {
  for (const [file, route] of RUN_BY_ANOTHER_JOB) {
    assert.ok(
      SENTRY_SUITES.includes(file),
      `RUN_BY_ANOTHER_JOB names ${file}, which no longer exists — drop the entry`,
    );
    assert.equal(
      file,
      "scripts/sentry-provider-contract.test.mjs",
      `unproven exemption for ${file} (${route}) — extend this test to re-prove its route`,
    );

    // Half one: tf-stacks.test.mjs really imports it.
    const imports = staticImports(join(SCRIPTS_DIR, "tf-stacks.test.mjs"));
    assert.ok(
      imports.includes("./sentry-provider-contract.test.mjs"),
      `${file} is exempted because tf-stacks.test.mjs imports it, but its static ` +
        `imports are ${JSON.stringify(imports)}`,
    );

    // Half two: an unconditional job really runs tf-stacks.test.mjs.
    const owner = "production-infra-contract";
    const targets = invocationsOf(PKG_SCRIPTS, "scripts/tf-stacks.test.mjs");
    assert.ok(
      targets.length > 2,
      "no package.json alias resolves to scripts/tf-stacks.test.mjs, so `pnpm tf:test` proves nothing",
    );
    const commands = provenCommands(CI, owner);
    assert.ok(
      targets.some((target) => runsCommand(commands, target)),
      `${file} is exempted because the \`${owner}\` job runs tf-stacks.test.mjs, but no ` +
        `step there does: ${nearMisses(CI, owner, targets).join("; ") || "no step mentions it"}`,
    );
  }
});

test("every sentry:*:test script resolves to an enumerated suite", () => {
  const aliases = Object.keys(PKG_SCRIPTS).filter(
    (name) => name.startsWith("sentry:") && name.endsWith(":test"),
  );
  assert.ok(
    aliases.length > 0,
    "no sentry:*:test scripts found in package.json",
  );

  const unresolved = aliases.filter(
    (alias) =>
      !SENTRY_SUITES.some((file) =>
        aliasesFor(PKG_SCRIPTS, file).includes(alias),
      ),
  );
  assert.deepEqual(
    unresolved,
    [],
    "these sentry:*:test scripts do not run a scripts/sentry-*.test.mjs file as " +
      `their whole command, so the CI-coverage assertion above cannot see them: ${unresolved.join(", ")}`,
  );
});

test("the local gate's tooling allowlist trusts every sentry:* script", () => {
  const sentryScripts = Object.keys(PKG_SCRIPTS)
    .filter((name) => name.startsWith("sentry:"))
    .sort();

  // Two controls prove the probe is live before its verdicts are believed. A
  // silent probe would pass this test by classifying nothing.
  const trustedControl = "/scripts/tf:test";
  const untrustedControl = "/scripts/__not_an_allowlisted_alias__";
  const verdicts = gateClassifications([
    trustedControl,
    untrustedControl,
    ...sentryScripts.map((name) => `/scripts/${name}`),
  ]);
  assert.equal(
    verdicts.get(trustedControl),
    "root-tooling-scripts",
    "the allowlist probe cannot reproduce a known-trusted alias — the probe is broken, not the allowlist",
  );
  assert.equal(
    verdicts.get(untrustedControl),
    "package-scripts",
    "the allowlist probe trusts an alias that is not listed — it is matching the wrong `case` arm",
  );

  const missing = sentryScripts.filter(
    (name) => verdicts.get(`/scripts/${name}`) !== "root-tooling-scripts",
  );
  assert.deepEqual(
    missing,
    [],
    "classify_root_package_json_changes in scripts/agent-quality-gate.sh does " +
      `not list: ${missing.join(", ")}. Without the entry, a package.json edit ` +
      "touching only that script classifies as `package-scripts` instead of " +
      "`root-tooling-scripts` — conservative, but drift.",
  );
});

test("every sentry:* script the gate trusts is pinned to an exact command", () => {
  // Allowlisting an alias TRUSTS it: `agent:quality-gate --run` will execute it
  // without `--allow-package-script-changes`. That trust is only safe while
  // check-agent-quality-gate-package-scripts.sh pins the alias to an exact
  // command — otherwise appending `&& <anything>` to a trusted script runs it.
  // The two lists drifted apart before this assertion existed: 13 aliases were
  // trusted and 4 pinned.
  const sentryScripts = Object.keys(PKG_SCRIPTS)
    .filter((name) => name.startsWith("sentry:"))
    .sort();
  const pins = validatorPins();

  // The probe reads the validator's own report. If its message format changed,
  // this control fails instead of every pin silently reading as absent.
  assert.equal(
    pins.get("tf:test"),
    "node scripts/tf-stacks.test.mjs",
    `the pin probe could not read ${VALIDATOR_PATH}'s report (${pins.size} pins parsed) — ` +
      "the probe is broken, not the pins",
  );

  const unpinned = sentryScripts.filter((name) => !pins.has(name));
  assert.deepEqual(
    unpinned,
    [],
    "these sentry:* scripts are trusted by classify_root_package_json_changes " +
      "but not pinned to an exact command in " +
      `check-agent-quality-gate-package-scripts.sh: ${unpinned.join(", ")}. ` +
      "A trusted alias whose command is not pinned can gain an appended " +
      "command that the gate then runs unprompted.",
  );

  // The validator itself is not wired into CI — only into the local gate — so
  // the sentry subset is re-checked here.
  const drifted = sentryScripts.filter(
    (name) => pins.get(name) !== PKG_SCRIPTS[name],
  );
  assert.deepEqual(
    drifted,
    [],
    `these sentry:* scripts no longer match their pin: ${drifted
      .map(
        (name) =>
          `${name} is ${JSON.stringify(PKG_SCRIPTS[name])}, pinned as ${JSON.stringify(pins.get(name))}`,
      )
      .join("; ")}`,
  );
});
test("an alias resolves a suite only when it runs that suite alone", () => {
  // Synthetic input, no repo file: a package script is run WITHOUT `-e`, so
  // `node scripts/x.test.mjs\ntrue` exits 0 whatever the suite did. Accepting
  // it would let a green `pnpm <alias>` step in CI prove nothing.
  const targets = suiteTargets("scripts/x.test.mjs");
  const accepted = [
    "node scripts/x.test.mjs",
    "node --test scripts/x.test.mjs",
  ];
  const rejected = [
    "node scripts/x.test.mjs\ntrue",
    "true\nnode scripts/x.test.mjs",
    "node scripts/x.test.mjs && true",
    "node scripts/x.test.mjs || true",
    "node scripts/x.test.mjs --test-name-pattern=nothing",
    "echo scripts/x.test.mjs",
    "node scripts/y.test.mjs",
    "",
    42,
  ];
  for (const command of accepted) {
    assert.equal(
      commandRunsOnly(command, targets),
      true,
      `commandRunsOnly rejected \`${command}\`, which runs the suite as its whole script`,
    );
  }
  for (const command of rejected) {
    assert.equal(
      commandRunsOnly(command, targets),
      false,
      `commandRunsOnly accepted ${JSON.stringify(command)}, which does not run the suite as its whole script`,
    );
  }
});
