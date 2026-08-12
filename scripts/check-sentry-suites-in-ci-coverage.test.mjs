/**
 * The suite-coverage and package-script contracts behind
 * scripts/check-sentry-suites-in-ci.test.mjs.
 *
 * Split out when the entry point reached the repo's 1,000-line hard cap (issue
 * #1803). A pure move: no case renamed, no assertion changed.
 *
 * This half asserts that every Sentry suite is actually RUN, and that the
 * commands proving it cannot be subverted through package.json — direct
 * `node <suite>` invocation rather than a `pnpm <alias>`, the alias and
 * lifecycle fail-opens that closes, the provider-contract exemption route, and
 * the local gate's tooling allowlist with its exact-command pins. The entry
 * point keeps the ci.yml workflow-shape assertions (trusted jobs, sentinel,
 * triggers, reachability, env mutation, composite recursion, check-run
 * ownership) and the self/meta checks.
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

/**
 * Is `file` run by the `scripts` job as a whole-command DIRECT node invocation
 * (`node <file>` or `node --test <file>`)? Shared by invariant 1 and its
 * rejection probe so both exercise the same rule: coverage is proven by the CI
 * command alone and never by a `pnpm <alias>`, the path a `scriptShell`
 * override or a `presentry:*:test` lifecycle hook subverts. It reads no
 * package.json alias, so neither knob can change the verdict.
 *
 * @param {Record<string, any>} workflow
 * @param {string} file
 */
export function suiteRunDirectly(workflow, file) {
  const commands = provenCommands(workflow, "scripts");
  return suiteTargets(file).some((target) => runsCommand(commands, target));
}

test("every Sentry suite is invoked directly by the ci.yml `scripts` job", () => {
  // Direct `node scripts/<suite>` (or `node --test …`), never `pnpm <alias>`.
  // The pnpm-run path is the one a `scriptShell` override or a `presentry:*:test`
  // lifecycle hook subvert (Codex 3754704267, 3754704278); a direct node command
  // is on neither knob's path, so requiring it closes both fail-opens.
  const missing = SENTRY_SUITES.filter(
    (file) => !RUN_BY_ANOTHER_JOB.has(file) && !suiteRunDirectly(CI, file),
  );
  const detail = missing
    .flatMap((file) =>
      nearMisses(CI, "scripts", suiteTargets(file)).map(
        (note) => `  ${file}: ${note}`,
      ),
    )
    .join("\n");
  assert.deepEqual(
    missing,
    [],
    `these Sentry suites are not invoked directly in CI: ${missing.join(", ")}.\n${detail}\n` +
      "Add a step to the `scripts` job in .github/workflows/ci.yml that runs " +
      "`node <suite>` as its whole command (not a pnpm alias), or add an entry " +
      "to RUN_BY_ANOTHER_JOB naming the job that does run it.",
  );
});

test("the checker rejects a Sentry step that reverts to a pnpm alias", () => {
  // A `scriptShell: /bin/true` (pnpm-workspace.yaml) makes `pnpm <alias>` exit 0
  // without running the suite; a `presentry:*:test` hook empties it before it
  // runs. Both act ONLY on the `pnpm run` path. So the coverage proof must
  // reject a step that runs a suite via its pnpm alias and accept only the
  // direct node command. Swap each suite's real step for its alias and assert
  // the suite reads as uncovered — the same predicate invariant 1 uses.
  let proven = 0;
  for (const file of SENTRY_SUITES) {
    if (RUN_BY_ANOTHER_JOB.has(file)) continue;
    const aliases = aliasesFor(PKG_SCRIPTS, file);
    if (aliases.length === 0) continue; // no alias form to revert to
    const directRuns = suiteTargets(file).map((target) => target.join(" "));
    const workflow = structuredClone(CI);
    const step = workflow.jobs.scripts.steps.find(
      (candidate) =>
        typeof candidate?.run === "string" &&
        directRuns.includes(candidate.run.trim()),
    );
    assert.ok(step, `no direct step found for ${file} to mutate`);
    step.run = `pnpm ${aliases[0]}`;
    assert.equal(
      suiteRunDirectly(workflow, file),
      false,
      `the checker still counts ${file} as covered after its step reverted to \`pnpm ${aliases[0]}\``,
    );
    proven += 1;
  }
  assert.ok(proven > 0, "no Sentry suite with an alias was available to probe");
});

test("a presentry lifecycle hook cannot empty a directly-invoked Sentry suite", () => {
  // `pnpm run sentry:ingest:test` fires `presentry:ingest:test` first, which a
  // malicious PR can point at `cp /dev/null <suite>` (Codex 3754704278). Because
  // the CI step runs `node scripts/sentry-triage-ingest.test.mjs` directly, no
  // lifecycle hook is on its path — and suiteRunDirectly reads that CI command,
  // never a package.json alias, so no `presentry:*:test` hook can change the
  // verdict. Prove the representative suite is covered by the direct command.
  const file = "scripts/sentry-triage-ingest.test.mjs";
  assert.ok(
    SENTRY_SUITES.includes(file),
    `${file} is gone — pick another representative suite`,
  );
  assert.ok(
    suiteRunDirectly(CI, file),
    `${file} is not invoked as a direct node command in the scripts job, so a ` +
      "presentry:*:test lifecycle hook could still empty it",
  );
});

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
