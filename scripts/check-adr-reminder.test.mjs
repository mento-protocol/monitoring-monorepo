#!/usr/bin/env node
/**
 * Offline tests for the pure logic in check-adr-reminder.mjs.
 * Run: node scripts/check-adr-reminder.test.mjs  (or `pnpm adr:check:test`)
 */
import assert from "node:assert/strict";

import {
  adrBeingWritten,
  detectAdrTriggers,
  extractPackagesList,
  extractStackIds,
  hasNewEntry,
} from "./check-adr-reminder.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("new scoped AGENTS.md triggers a new-package reminder", () => {
  const t = detectAdrTriggers({ addedFiles: ["payments/AGENTS.md"] });
  assert.equal(t.length, 1);
  assert.match(t[0].why, /new package\/service "payments\/"/);
});

check(
  "editing an existing package (not an added file) does NOT trigger",
  () => {
    // The gate feeds only ADDED files here; a modified AGENTS.md is not added.
    const t = detectAdrTriggers({ addedFiles: [] });
    assert.equal(t.length, 0);
  },
);

check("a new workflow file triggers a reminder", () => {
  const t = detectAdrTriggers({
    addedFiles: [".github/workflows/deploy-thing.yml"],
  });
  assert.equal(t.length, 1);
  assert.match(t[0].why, /new GitHub Actions workflow/);
});

check("existing workflow dir but nested non-yaml does not trigger", () => {
  const t = detectAdrTriggers({ addedFiles: [".github/workflows/README.md"] });
  assert.equal(t.length, 0);
});

check("a new terraform stack triggers a reminder", () => {
  const t = detectAdrTriggers({ addedFiles: [], stacksAddsNewStack: true });
  assert.equal(t.length, 1);
  assert.equal(t[0].surface, "terraform.stacks.json");
});

check("a new workspace package triggers a reminder", () => {
  const t = detectAdrTriggers({ addedFiles: [], workspaceAddsPackage: true });
  assert.equal(t.length, 1);
  assert.equal(t[0].surface, "pnpm-workspace.yaml");
});

check("multiple triggers accumulate", () => {
  const t = detectAdrTriggers({
    addedFiles: ["svc/AGENTS.md", ".github/workflows/x.yaml"],
    stacksAddsNewStack: true,
    workspaceAddsPackage: true,
  });
  assert.equal(t.length, 4);
});

check("a package.json-only service root triggers (no AGENTS.md)", () => {
  // governance-watchdog-style: package.json but no AGENTS.md.
  const t = detectAdrTriggers({ addedFiles: ["newsvc/package.json"] });
  assert.equal(t.length, 1);
  assert.match(t[0].why, /new package\/service "newsvc\/"/);
});

check(
  "AGENTS.md + package.json for the same dir is one trigger (deduped)",
  () => {
    const t = detectAdrTriggers({
      addedFiles: ["newsvc/AGENTS.md", "newsvc/package.json"],
    });
    assert.equal(t.length, 1);
    assert.equal(t[0].surface, "newsvc/");
  },
);

check("a nested package.json is not a top-level service root", () => {
  // A new workspace member under an existing package registers via
  // pnpm-workspace.yaml (workspaceAddsPackage), not this top-level detection.
  const t = detectAdrTriggers({
    addedFiles: ["alerts/infra/newthing/package.json"],
  });
  assert.equal(t.length, 0);
});

check("adrBeingWritten true when a numbered ADR is added", () => {
  assert.equal(adrBeingWritten(["docs/adr/0034-new-thing.md"]), true);
});

check("adrBeingWritten ignores the ADR index README", () => {
  assert.equal(adrBeingWritten(["docs/adr/README.md"]), false);
});

check("adrBeingWritten false when no ADR added", () => {
  assert.equal(adrBeingWritten(["ui-dashboard/src/app/page.tsx"]), false);
});

check("extractStackIds reads stacks[].id", () => {
  const json = JSON.stringify({
    stacks: [{ id: "platform" }, { id: "aegis" }],
  });
  assert.deepEqual(extractStackIds(json), ["platform", "aegis"]);
});

check("extractStackIds tolerates empty/garbage input", () => {
  assert.deepEqual(extractStackIds(""), []);
  assert.deepEqual(extractStackIds("not json"), []);
  assert.deepEqual(extractStackIds("{}"), []);
});

check("extractPackagesList reads only the packages: block", () => {
  const yaml = [
    "packages:",
    "  - shared-config",
    "  - ui-dashboard",
    "",
    "minimumReleaseAgeExclude:",
    '  - "@mento-protocol/*"',
    "ignoredBuiltDependencies:",
    "  - sharp",
  ].join("\n");
  // The `- @mento-protocol/*` and `- sharp` items must NOT leak in.
  assert.deepEqual(extractPackagesList(yaml), [
    "shared-config",
    "ui-dashboard",
  ]);
});

check("extractPackagesList strips quotes", () => {
  const yaml = [
    "packages:",
    "  - 'alerts/infra/oncall-announcer'",
    "catalog:",
  ].join("\n");
  assert.deepEqual(extractPackagesList(yaml), [
    "alerts/infra/oncall-announcer",
  ]);
});

check("hasNewEntry true only when head has an unseen entry", () => {
  assert.equal(hasNewEntry(["a", "b"], ["a", "b"]), false);
  assert.equal(hasNewEntry(["a", "b"], ["a", "b", "c"]), true);
  assert.equal(hasNewEntry(["a", "b"], ["a"]), false); // removal is not an add
});

check("editing an existing stack path does not read as a new stack", () => {
  const base = JSON.stringify({
    stacks: [{ id: "platform", path: "terraform" }],
  });
  const head = JSON.stringify({
    stacks: [{ id: "platform", path: "infra/tf" }],
  });
  assert.equal(
    hasNewEntry(extractStackIds(base), extractStackIds(head)),
    false,
  );
});

check(
  "adding a minimumReleaseAgeExclude entry is not a workspace package add",
  () => {
    const base = [
      "packages:",
      "  - shared-config",
      "minimumReleaseAgeExclude:",
      "  - tar",
    ].join("\n");
    const head = [
      "packages:",
      "  - shared-config",
      "minimumReleaseAgeExclude:",
      "  - tar",
      "  - undici",
    ].join("\n");
    assert.equal(
      hasNewEntry(extractPackagesList(base), extractPackagesList(head)),
      false,
    );
  },
);

console.log(`\n${passed} checks passed`);
