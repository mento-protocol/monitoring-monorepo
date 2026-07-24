#!/usr/bin/env node
/**
 * Platform-settings drift check (issue #1564): assert the repo's default GitHub
 * Actions workflow-token permission has not been reverted out-of-band.
 *
 * WHY THIS EXISTS. `scripts/check-autofix-ci-trust.mjs` treats a job with no
 * explicit `permissions:` as having no write scope — an assumption that ONLY
 * holds while the repo default workflow-token permission is `read`. #1557 pinned
 * that default to `read` in Terraform
 * (`terraform/github-actions-permissions.tf` →
 * `github_workflow_repository_permissions.default_read`), but the `platform`
 * stack is manual plan/apply and deliberately NOT in the scheduled
 * `terraform-drift.yml` matrix (a full platform plan would need the whole
 * platform secret set — Vercel/Upstash tokens, the App private key, and the
 * Administration-scoped GitHub PAT — in an unattended CI job, the exact standing
 * surface #1557 removed). So a manual flip back to `write` would sit invisible
 * until the next operator plan. This module is the DECISION layer for a
 * lightweight daily check (`.github/workflows/platform-settings-drift.yml`) that
 * reads the live setting via one read-only REST call and flags drift.
 *
 * PURE logic only — no gh/git/network I/O. The workflow does the authenticated
 * `gh api repos/{owner}/{repo}/actions/permissions/workflow` read (with a
 * dedicated Administration:Read PAT) and pipes the JSON to stdin; this module
 * returns the verdict via its exit code:
 *
 *   0  ok        — setting matches the pinned invariant
 *   2  drift      — setting reverted (mirrors terraform-drift's exit-2 = "changes")
 *   3  malformed  — response shape unexpected; fail loud, never read as ok
 *
 * Run: `printf '%s' "$json" | node scripts/check-workflow-permissions-drift.mjs`
 */

import { fileURLToPath } from "node:url";

// The invariant #1557 pins. `default_workflow_permissions` must stay "read";
// `can_approve_pull_request_reviews` must stay false (no workflow approves PRs
// via the automatic GITHUB_TOKEN, so denying it is free hardening).
export const EXPECTED = Object.freeze({
  default_workflow_permissions: "read",
  can_approve_pull_request_reviews: false,
});

/**
 * @param {unknown} api parsed JSON from
 *   `GET /repos/{owner}/{repo}/actions/permissions/workflow`
 * @returns {{ status: "ok" | "drift" | "malformed", violations: string[] }}
 */
export function evaluateWorkflowPermissions(api) {
  if (api === null || typeof api !== "object" || Array.isArray(api)) {
    return {
      status: "malformed",
      violations: ["API response was not a JSON object."],
    };
  }

  const perms = api.default_workflow_permissions;
  const canApprove = api.can_approve_pull_request_reviews;

  // Fail closed on an unexpected SHAPE — a mis-scoped token that still returned
  // 200 with an empty/renamed body, or an upstream API change, must never read
  // as "ok". Only the two documented enum values are trusted.
  if (perms !== "read" && perms !== "write") {
    return {
      status: "malformed",
      violations: [
        `default_workflow_permissions was ${JSON.stringify(perms)} — expected "read" or "write".`,
      ],
    };
  }
  if (typeof canApprove !== "boolean") {
    return {
      status: "malformed",
      violations: [
        `can_approve_pull_request_reviews was ${JSON.stringify(canApprove)} — expected a boolean.`,
      ],
    };
  }

  const violations = [];
  if (perms !== EXPECTED.default_workflow_permissions) {
    violations.push(
      `default_workflow_permissions is "${perms}" — expected "read". ` +
        `#1557 pins the repo default workflow-token permission to read-only; ` +
        `check-autofix-ci-trust.mjs treats a job with no explicit permissions: ` +
        `as having no write scope, which holds only while this stays "read".`,
    );
  }
  if (canApprove !== EXPECTED.can_approve_pull_request_reviews) {
    violations.push(
      `can_approve_pull_request_reviews is ${canApprove} — expected false ` +
        `(no workflow approves PRs via the automatic GITHUB_TOKEN).`,
    );
  }

  return {
    status: violations.length > 0 ? "drift" : "ok",
    violations,
  };
}

const EXIT = Object.freeze({ ok: 0, drift: 2, malformed: 3 });

/**
 * Evaluate a raw stdin string and render a one-block summary.
 * @param {string} raw raw JSON text from stdin
 * @param {{ stdout?: { write: (s: string) => void } }} [io]
 * @returns {number} process exit code (see module header)
 */
export function runCli(raw, { stdout = process.stdout } = {}) {
  let api;
  try {
    api = JSON.parse(raw);
  } catch {
    stdout.write("MALFORMED: stdin was not valid JSON.\n");
    return EXIT.malformed;
  }

  const verdict = evaluateWorkflowPermissions(api);

  if (verdict.status === "ok") {
    stdout.write(
      "OK: repo default workflow-token permission is read-only and token PR-approval is disabled.\n",
    );
    return EXIT.ok;
  }
  if (verdict.status === "malformed") {
    stdout.write(`MALFORMED: ${verdict.violations.join(" ")}\n`);
    return EXIT.malformed;
  }
  stdout.write(
    "DRIFT: a platform-managed GitHub Actions setting was reverted:\n" +
      verdict.violations.map((v) => `  - ${v}`).join("\n") +
      "\n",
  );
  return EXIT.drift;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  readStdin().then((raw) => {
    process.exitCode = runCli(raw);
  });
}
