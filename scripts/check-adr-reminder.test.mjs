#!/usr/bin/env node
/**
 * Offline tests for the pure logic in check-adr-reminder.mjs.
 * Run: node scripts/check-adr-reminder.test.mjs  (or `pnpm adr:check:test`)
 */
import assert from "node:assert/strict";

import { adrBeingWritten, detectAdrTriggers } from "./check-adr-reminder.mjs";

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

check("adrBeingWritten true when a numbered ADR is added", () => {
  assert.equal(adrBeingWritten(["docs/adr/0034-new-thing.md"]), true);
});

check("adrBeingWritten ignores the ADR index README", () => {
  assert.equal(adrBeingWritten(["docs/adr/README.md"]), false);
});

check("adrBeingWritten false when no ADR added", () => {
  assert.equal(adrBeingWritten(["ui-dashboard/src/app/page.tsx"]), false);
});

console.log(`\n${passed} checks passed`);
