#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// prettier-ignore
import { collectTriggers, hasWritePermission, jobReceivesCredential, parseWorkflow } from "./check-autofix-ci-trust.mjs";
import { isMapping, workflowJobSteps } from "../lib/workflow-yaml.mjs";
import { validateWorkflowInventory } from "../production-infra-identity-contract/workflow-inventory.mjs";

const CODECOV = [
  "shared|config|shared-config/coverage",
  "ui|ui-dashboard|ui-dashboard/coverage",
  "indexer|indexer-envio|indexer-envio/coverage",
  "bridge|metrics-bridge|metrics-bridge/coverage",
  "integration-probes|integration-probes|integration-probes/coverage",
  "alerts|alerts-onchain-event-handler|alerts/infra/onchain-event-handler/coverage",
  "alerts|alerts-oncall-announcer|alerts/infra/oncall-announcer/coverage",
  "gov-watchdog|governance-watchdog|governance-watchdog/coverage",
  "aegis|aegis|aegis/coverage",
];
const AUTHORITY = [
  'aegis-terraform.yml|apply|{"actions":"read","contents":"read","deployments":"read","id-token":"write"}|["github.token","secrets.TF_VAR_GRAFANA_SERVICE_ACCOUNT_TOKEN"]|{"name":"production-infra","url":"https://console.cloud.google.com/home/dashboard?project=mento-terraform-seed-ffac"}|null|null',
  'aegis-terraform.yml|plan|{"actions":"read","contents":"read","id-token":"write"}|["github.token","secrets.GCP_SERVICE_ACCOUNT_PLAN","secrets.GCP_WORKLOAD_IDENTITY_PROVIDER","secrets.TF_VAR_GRAFANA_SERVICE_ACCOUNT_TOKEN","secrets.TF_VAR_SLACK_BOT_TOKEN"]|null|null|null',
  'alerts-infra.yml|apply|{"actions":"read","contents":"read","deployments":"read","id-token":"write"}|["github.token","secrets.TF_VAR_BILLING_ACCOUNT","secrets.TF_VAR_GITHUB_TOKEN","secrets.TF_VAR_ONCALL_SLACK_CHANNEL_ID","secrets.TF_VAR_ONCALL_SUPPORT_USERGROUP_ID","secrets.TF_VAR_QUICKNODE_API_KEY","secrets.TF_VAR_QUICKNODE_SIGNING_SECRET","secrets.TF_VAR_SENTRY_AUTH_TOKEN","secrets.TF_VAR_SLACK_BOT_TOKEN","secrets.TF_VAR_SLACK_NOTIFICATION_CHANNEL_ID","secrets.TF_VAR_SPLUNK_ON_CALL_API_ID","secrets.TF_VAR_SPLUNK_ON_CALL_API_KEY"]|{"name":"production-infra","url":"https://console.cloud.google.com/home/dashboard?project=mento-terraform-seed-ffac"}|null|null',
  'alerts-infra.yml|plan|{"actions":"read","contents":"read","id-token":"write"}|["github.token","secrets.GCP_SERVICE_ACCOUNT_PLAN","secrets.GCP_WORKLOAD_IDENTITY_PROVIDER","secrets.TF_VAR_BILLING_ACCOUNT","secrets.TF_VAR_GITHUB_TOKEN","secrets.TF_VAR_ONCALL_SLACK_CHANNEL_ID","secrets.TF_VAR_ONCALL_SUPPORT_USERGROUP_ID","secrets.TF_VAR_QUICKNODE_API_KEY","secrets.TF_VAR_QUICKNODE_SIGNING_SECRET","secrets.TF_VAR_SENTRY_AUTH_TOKEN","secrets.TF_VAR_SLACK_BOT_TOKEN","secrets.TF_VAR_SLACK_BOT_TOKEN","secrets.TF_VAR_SLACK_NOTIFICATION_CHANNEL_ID","secrets.TF_VAR_SPLUNK_ON_CALL_API_ID","secrets.TF_VAR_SPLUNK_ON_CALL_API_KEY"]|null|null|null',
  'alerts-rules.yml|apply|{"actions":"read","contents":"read","deployments":"read","id-token":"write"}|["github.token","secrets.TF_VAR_GRAFANA_SERVICE_ACCOUNT_TOKEN","secrets.TF_VAR_ONCALL_SUPPORT_USERGROUP_ID","secrets.TF_VAR_SLACK_BOT_TOKEN","secrets.TF_VAR_SPLUNK_ON_CALL_ALERTS_WEBHOOK_URL"]|{"name":"production-infra","url":"https://console.cloud.google.com/home/dashboard?project=mento-terraform-seed-ffac"}|null|null',
  'alerts-rules.yml|plan|{"actions":"read","contents":"read","id-token":"write"}|["github.token","secrets.GCP_SERVICE_ACCOUNT_PLAN","secrets.GCP_WORKLOAD_IDENTITY_PROVIDER","secrets.TF_VAR_GRAFANA_SERVICE_ACCOUNT_TOKEN","secrets.TF_VAR_ONCALL_SUPPORT_USERGROUP_ID","secrets.TF_VAR_SLACK_BOT_TOKEN","secrets.TF_VAR_SLACK_BOT_TOKEN","secrets.TF_VAR_SPLUNK_ON_CALL_ALERTS_WEBHOOK_URL"]|null|null|null',
  'ci.yml|aegis|{"actions":"read","contents":"read"}|["secrets.CODECOV_TOKEN"]|null|null|null',
  'ci.yml|alerts|{"actions":"read","contents":"read"}|["secrets.CODECOV_TOKEN","secrets.CODECOV_TOKEN"]|null|null|null',
  'ci.yml|bridge|{"actions":"read","contents":"read"}|["secrets.CODECOV_TOKEN"]|null|null|null',
  'ci.yml|gov-watchdog|{"actions":"read","contents":"read"}|["secrets.CODECOV_TOKEN"]|null|null|null',
  'ci.yml|indexer|{"actions":"read","contents":"read"}|["secrets.CODECOV_TOKEN"]|null|null|null',
  'ci.yml|integration-probes|{"actions":"read","contents":"read"}|["secrets.CODECOV_TOKEN"]|null|null|null',
  'ci.yml|shared|{"actions":"read","contents":"read"}|["secrets.CODECOV_TOKEN"]|null|null|null',
  'ci.yml|ui|{"actions":"read","contents":"read"}|["secrets.CODECOV_TOKEN"]|null|null|null',
  'claude.yml|auto-review|{"actions":"read","contents":"read","pull-requests":"write"}|["github.token","secrets.CLAUDE_CODE_OAUTH_TOKEN"]|null|null|null',
  'claude.yml|claude|{"actions":"read","contents":"read","issues":"write","pull-requests":"write"}|["github.token","secrets.CLAUDE_CODE_OAUTH_TOKEN"]|null|null|null',
  'governance-watchdog.yml|apply|{"actions":"read","contents":"read","deployments":"read","id-token":"write"}|["github.token","secrets.TF_VAR_BILLING_ACCOUNT","secrets.TF_VAR_DISCORD_TEST_WEBHOOK_URL","secrets.TF_VAR_DISCORD_WEBHOOK_URL","secrets.TF_VAR_GITHUB_TOKEN","secrets.TF_VAR_GOVERNANCE_WATCHDOG_QUICKNODE_API_KEY","secrets.TF_VAR_GOVERNANCE_WATCHDOG_SLACK_NOTIFICATION_CHANNEL_ID","secrets.TF_VAR_QUICKNODE_SECURITY_TOKEN","secrets.TF_VAR_TELEGRAM_BOT_TOKEN","secrets.TF_VAR_TELEGRAM_CHAT_ID","secrets.TF_VAR_TELEGRAM_TEST_CHAT_ID","secrets.TF_VAR_VICTOROPS_WEBHOOK_URL","secrets.TF_VAR_X_AUTH_TOKEN"]|{"name":"production-infra","url":"https://console.cloud.google.com/home/dashboard?project=mento-terraform-seed-ffac"}|null|null',
  'governance-watchdog.yml|plan|{"actions":"read","contents":"read","id-token":"write"}|["github.token","secrets.GCP_SERVICE_ACCOUNT_PLAN","secrets.GCP_WORKLOAD_IDENTITY_PROVIDER","secrets.TF_VAR_BILLING_ACCOUNT","secrets.TF_VAR_DISCORD_TEST_WEBHOOK_URL","secrets.TF_VAR_DISCORD_WEBHOOK_URL","secrets.TF_VAR_GITHUB_TOKEN","secrets.TF_VAR_GOVERNANCE_WATCHDOG_QUICKNODE_API_KEY","secrets.TF_VAR_GOVERNANCE_WATCHDOG_SLACK_NOTIFICATION_CHANNEL_ID","secrets.TF_VAR_QUICKNODE_SECURITY_TOKEN","secrets.TF_VAR_SLACK_BOT_TOKEN","secrets.TF_VAR_TELEGRAM_BOT_TOKEN","secrets.TF_VAR_TELEGRAM_CHAT_ID","secrets.TF_VAR_TELEGRAM_TEST_CHAT_ID","secrets.TF_VAR_VICTOROPS_WEBHOOK_URL","secrets.TF_VAR_X_AUTH_TOKEN"]|null|null|null',
  'lighthouse.yml|lighthouse|{"contents":"read","deployments":"read","pull-requests":"read","statuses":"read"}|["secrets.VERCEL_AUTOMATION_BYPASS_SECRET","secrets.VERCEL_AUTOMATION_BYPASS_SECRET"]|null|null|null',
  'peg-policy-publication.yml|apply|{"actions":"read","contents":"read","deployments":"read","id-token":"write"}|["github.token"]|{"name":"production-infra","url":"https://console.cloud.google.com/home/dashboard?project=mento-monitoring"}|null|null',
  'peg-policy-publication.yml|plan|{"contents":"read","id-token":"write"}|[]|null|null|null',
  'review-eval-freshness.yml|freshness|{"contents":"read","issues":"write"}|["github.token"]|null|null|null',
  'supply-chain.yml|moderate-advisory-report|{"contents":"read","issues":"write"}|["github.token"]|null|null|null',
  'supply-chain.yml|override-prune-report|{"contents":"read","issues":"write"}|["github.token"]|null|null|null',
].sort();

// prettier-ignore
function load(root, path) { const value = parseWorkflow(readFileSync(join(root, path), "utf8")); if (!isMapping(value)) throw new Error(`${path} is not one YAML mapping`); return value; }
// prettier-ignore
function listYaml(root, directory) { return readdirSync(join(root, directory), { recursive: true }).filter((path) => /\.ya?ml$/u.test(path)).map((path) => join(directory, path)); }
// prettier-ignore
function steps(value) { return isMapping(value.runs) ? workflowJobSteps(value.runs) : Object.values(value.jobs ?? {}).flatMap(workflowJobSteps); }
// prettier-ignore
function strings(value) { return typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : isMapping(value) ? Object.values(value).flatMap(strings) : []; }

// prettier-ignore
function expr(value) { return String(value ?? "").replace(/^\$\{\{\s*/u, "").replace(/\s*\}\}$/u, "").replace(/\s+/gu, " ").trim(); }

// prettier-ignore
function stable(value) { return JSON.stringify(value, (_key, item) => isMapping(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item); }

// prettier-ignore
function authorityLine(path, id, workflow, job) { const permissions = job.permissions !== undefined ? job.permissions : workflow.permissions ?? null; const credentials = strings([workflow.env, job]).filter((value) => /\$\{\{[\s\S]*\b(?:secrets|github\s*\.\s*token)\b/iu.test(value)).map(expr).sort(); return [`${path.split("/").at(-1)}|${id}`, stable(permissions), stable(credentials), stable(job.environment ?? null), stable(job.secrets ?? null), stable(typeof job.uses === "string" ? job.uses : null)].join("|"); }

// prettier-ignore
function add(violations, valid, message) { if (!valid) violations.push(message); }

// prettier-ignore
function bool(value, expected) { return value === expected || String(value).toLowerCase() === String(expected); }

// prettier-ignore
export function hasProtectedMainSaveGuard(value) { const condition = expr(value); const clauses = new Set(condition.split("&&").map((part) => part.trim())); return !condition.includes("||") && clauses.has("github.event_name == 'push'") && clauses.has("github.ref == 'refs/heads/main'"); }

function reachableWorkflowFiles(root) {
  const workflowFiles = listYaml(root, ".github/workflows");
  const workflows = workflowFiles.filter((path) =>
    collectTriggers(load(root, path)).has("pull_request"),
  );
  const queued = [...workflows];
  for (let index = 0; index < queued.length; index += 1) {
    for (const job of Object.values(load(root, queued[index]).jobs ?? {})) {
      if (typeof job?.uses !== "string") continue;
      const match = job.uses.match(
        /^(?:(?:\.|\$)\/)?(\.github\/workflows\/[^@]+\.ya?ml)(?:@.+)?$/u,
      );
      if (
        match &&
        workflowFiles.includes(match[1]) &&
        !queued.includes(match[1])
      )
        queued.push(match[1]);
    }
  }
  return queued;
}
// prettier-ignore
function reachableSteps(root) { return [...reachableWorkflowFiles(root), ...listYaml(root, ".github/actions"), ...listYaml(root, ".trunk/setup-ci")].flatMap((path) => steps(load(root, path))); }
// prettier-ignore
const isPnpmInstall = (step) => /^(?:\.|\$)\/\.github\/actions\/pnpm-install\/?$/u.test(String(step?.uses ?? ""));
// prettier-ignore
function coldSequence(root, path, job, restoreId, cleanupName, cleanupIf, cleanupRun, commandName, commandRun, commandIf = "") {
  const workflow = load(root, path);
  const list = workflowJobSteps(job === "runs" ? workflow.runs : workflow.jobs?.[job]);
  const restoreIndex = list.findIndex((step) => step.id === restoreId && String(step.uses ?? "").startsWith("actions/cache/restore@"));
  const cleanupIndex = list.findIndex((step) => step.name === cleanupName);
  const commandIndex = list.findIndex((step) => step.name === commandName);
  const cleanup = list[cleanupIndex];
  const command = list[commandIndex];
  return restoreIndex >= 0 && restoreIndex < cleanupIndex && cleanupIndex < commandIndex && expr(cleanup?.if) === cleanupIf && cleanup?.run === cleanupRun && expr(command?.if) === commandIf && command?.run === commandRun && !/cache-hit/iu.test(JSON.stringify(command));
}

// prettier-ignore
function checkCaches(root, violations) {
  const reachable = reachableSteps(root);
  const definitions = [".github/workflows", ".github/actions", ".trunk/setup-ci"].flatMap((directory) => listYaml(root, directory)).map((path) => load(root, path)); const all = definitions.flatMap(steps); const pnpmCalls = all.filter(isPnpmInstall); const pnpmCallerJobs = definitions.flatMap((definition) => Object.values(definition.jobs ?? {})).filter((job) => workflowJobSteps(job).some(isPnpmInstall)); const pnpmRoots = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ":(glob)**/pnpm-workspace.yaml"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/u).filter(Boolean); const pnpmConfigs = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ":(glob)**/.npmrc"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/u).filter(Boolean); const pnpmOverride = /\b(?:pnpm_config_store_dir|npm_config_store_dir|pnpm_home)\b|--(?:(?:config\.)?store(?:-dir|dir)|config\.store_dir)(?:=|\s)|\bpnpm\s+config\s+set\s+(?:store(?:-dir|dir)|store_dir)(?:=|\s)/iu; const pnpmConfigOverride = /^\s*store[-_]?dir\s*=/imu;
  const used = (scope, pattern) => scope.filter((step) => pattern.test(String(step.uses ?? "")));
  const restores = used(all, /^actions\/cache\/restore@/iu);
  const saves = used(all, /^actions\/cache\/save@/iu);
  const pnpmAction = load(root, ".github/actions/pnpm-install/action.yml"); const pnpmSteps = workflowJobSteps(pnpmAction.runs); const pnpmSetups = used(pnpmSteps, /^pnpm\/action-setup@/iu); const nodeSetups = used(pnpmSteps, /^actions\/setup-node@/iu); const pnpmRestores = used(pnpmSteps, /^actions\/cache\/restore@/iu); const pnpmSaves = used(pnpmSteps, /^actions\/cache\/save@/iu); const pnpmTargets = pnpmSteps.filter((step) => step.name === "Verify pnpm store target"); const pnpmInstalls = pnpmSteps.filter((step) => step.name === "Install dependencies"); const pnpmPrepares = pnpmSteps.filter((step) => step.name === "Prepare pnpm store target"); const pnpmCleanups = pnpmSteps.filter((step) => step.name === "Clear incomplete pnpm store restore"); const pnpmSetupIndex = pnpmSteps.indexOf(pnpmSetups[0]); const nodeSetupIndex = pnpmSteps.indexOf(nodeSetups[0]); const pnpmTargetIndex = pnpmSteps.indexOf(pnpmTargets[0]); const pnpmPrepareIndex = pnpmSteps.indexOf(pnpmPrepares[0]); const pnpmRestoreIndex = pnpmSteps.indexOf(pnpmRestores[0]); const pnpmCleanupIndex = pnpmSteps.indexOf(pnpmCleanups[0]); const pnpmInstallIndex = pnpmSteps.indexOf(pnpmInstalls[0]); const pnpmSaveIndex = pnpmSteps.indexOf(pnpmSaves[0]);
  const pnpmTargetRun = `node -e 'const { existsSync, realpathSync } = require("node:fs"); const { homedir } = require("node:os"); const { isAbsolute, join, relative, sep } = require("node:path"); const workspace = process.env.GITHUB_WORKSPACE; if (!workspace) throw new Error("GITHUB_WORKSPACE is required"); const source = realpathSync(workspace); const target = join(realpathSync(homedir()), "pnpm-store"); const cache = existsSync(target) ? realpathSync(target) : target; const scope = relative(source, cache); if (!isAbsolute(scope) && scope !== ".." && !scope.startsWith(".." + sep)) throw new Error("pnpm cache target " + cache + " is inside source checkout " + source);'`; const pnpmCleanup = `node -e 'const { rmSync } = require("node:fs"); const { homedir } = require("node:os"); const { join } = require("node:path"); rmSync(join(homedir(), "pnpm-store"), { force: true, recursive: true });'`; const pnpmCachePath = "~/pnpm-store"; const pnpmInstallRun = "pnpm install --frozen-lockfile --store-dir ~/pnpm-store"; const pnpmLocalInstallRun = "pnpm install --frozen-lockfile --ignore-scripts --lockfile-dir . --store-dir ~/pnpm-store"; const pnpmCacheKey = "trusted-main-v1-pnpm-store-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('pnpm-lock.yaml', 'pnpm-workspace.yaml', '**/.npmrc', 'package.json', '.node-version') }}"; const pnpmRestorePrefix = "trusted-main-v1-pnpm-store-${{ runner.os }}-${{ runner.arch }}-"; const pnpmRestoreIf = "inputs.restore-cache == 'true'"; const pnpmCleanupIf = "inputs.restore-cache == 'true' && steps.pnpm-cache.outputs.cache-hit == ''"; const pnpmSaveIf = "inputs.restore-cache == 'true' && inputs.write-cache == 'true' && github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.pnpm-cache.outputs.cache-hit != 'true'";
  const trusted = (step) => String(step.with?.key ?? "").startsWith("trusted-main-v1-") && String(step.with?.["restore-keys"] ?? "").split(/\r?\n/u).every((key) => key.trim() === "" || key.trim().startsWith("trusted-main-v1-")); const required = (step) => step?.if == null && step?.["continue-on-error"] == null; const pnpmStepKeys = [["uses", "with"], ["uses", "with"], ["name", "run", "shell"], ["continue-on-error", "id", "if", "name", "uses", "with"], ["if", "name", "run", "shell"], ["name", "run", "shell"], ["name", "run", "shell"], ["continue-on-error", "if", "name", "uses", "with"]];
  add(violations, used(reachable, /^actions\/setup-node@/iu).every((step) => bool(step.with?.["package-manager-cache"], false) && step.with?.cache == null), "PR-reachable setup-node must disable implicit and explicit package-manager caching");
  add(violations, used(reachable, /^actions\/checkout@/iu).every((step) => bool(step.with?.["persist-credentials"], false)), "PR-reachable checkout must not persist Git credentials");
  add(violations, used(all, /^actions\/cache@/iu).length === 0, "monolithic actions/cache is forbidden");
  add(violations, [...restores, ...saves].every(trusted), "cache key or restore-key must use the trusted-main-v1 namespace");
  add(violations, restores.every((step) => bool(step["continue-on-error"], true)), "cache restore must be nonfatal");
  add(violations, saves.every((step) => bool(step["continue-on-error"], true)), "cache save must be nonfatal");
  add(violations, saves.every((step) => hasProtectedMainSaveGuard(step.if)), "cache save is not limited to an exact protected-main push");
  add(violations, stable(pnpmAction.inputs) === stable({ "restore-cache": { description: "Restore the protected-main pnpm store before install", required: false, default: "true" }, "write-cache": { description: "Save the pnpm store after install on a protected main push", required: false, default: "false" } }) && pnpmSetups.length === 1 && stable(pnpmSetups[0]?.with) === stable({ dest: "~/pnpm-home" }) && nodeSetups.length === 1 && stable(nodeSetups[0]?.with) === stable({ "node-version-file": ".node-version", "package-manager-cache": false }) && pnpmPrepares.length === 1 && pnpmTargets.length === 1 && pnpmTargets[0]?.run === pnpmTargetRun && pnpmInstalls.length === 1 && pnpmInstalls[0]?.env == null && [pnpmSetups[0], nodeSetups[0], pnpmPrepares[0], pnpmTargets[0], pnpmInstalls[0]].every(required) && [pnpmPrepares[0], pnpmCleanups[0], pnpmTargets[0], pnpmInstalls[0]].every((step) => step?.shell === "bash") && pnpmSteps.every((step) => !/\bGITHUB_(?:ENV|PATH)\b/u.test(String(step.run ?? ""))), "pnpm setup must pin cache restore and opt-in write inputs, use the hashed package.json and .node-version toolchain sources, pin one home-relative PNPM_HOME, keep required steps unconditional and fatal, require reviewed run steps to use bash, and verify its store without mutating the later-step environment");
  add(violations, pnpmCalls.length === pnpmCallerJobs.flatMap(workflowJobSteps).filter(isPnpmInstall).length && pnpmCallerJobs.every((job) => job.container == null) && all.filter((step) => step.run === pnpmLocalInstallRun).length === 3 && pnpmRoots.every((path) => !Object.hasOwn(load(root, path), "storeDir") && !Object.hasOwn(load(root, path), "store-dir")) && pnpmConfigs.every((path) => !pnpmConfigOverride.test(readFileSync(join(root, path), "utf8"))) && !pnpmOverride.test(stable(definitions).replaceAll(pnpmInstallRun, "").replaceAll(pnpmLocalInstallRun, "")), "pnpm-install must be called directly from workflow jobs, and caller jobs must not use containers; pnpm store override is forbidden in dependency roots, configuration, workflow definitions, and action definitions except the exact root and three package-local installs that select the pinned home-relative store");
  add(violations, pnpmSteps.length === 8 && pnpmSteps.every((step, index) => stable(Object.keys(step).sort()) === stable(pnpmStepKeys[index])) && pnpmRestores.length === 1 && pnpmSaves.length === 1 && pnpmCleanups.length === 1 && pnpmRestores[0]?.id === "pnpm-cache" && pnpmSteps.filter((step) => step.id === "pnpm-cache").length === 1 && stable(pnpmRestores[0]?.with) === stable({ path: pnpmCachePath, key: pnpmCacheKey, "restore-keys": `${pnpmRestorePrefix}\n` }) && stable(pnpmSaves[0]?.with) === stable({ path: pnpmCachePath, key: pnpmCacheKey }) && expr(pnpmRestores[0]?.if) === pnpmRestoreIf && expr(pnpmCleanups[0]?.if) === pnpmCleanupIf && expr(pnpmSaves[0]?.if) === pnpmSaveIf && pnpmCleanups[0]?.["continue-on-error"] == null && pnpmSetupIndex >= 0 && pnpmSetupIndex < nodeSetupIndex && nodeSetupIndex < pnpmPrepareIndex && pnpmPrepareIndex < pnpmRestoreIndex && pnpmRestoreIndex < pnpmCleanupIndex && pnpmCleanupIndex < pnpmTargetIndex && pnpmTargetIndex < pnpmInstallIndex && pnpmInstallIndex < pnpmSaveIndex, "pnpm cache must keep the exact eight-step sequence, keys, and cache inputs; the restore action must own the sole pnpm-cache id; keep one restore and one protected-main save; restore, cleanup, and save must use the exact protected controls; the matching toolchain-bound key includes pnpm-workspace.yaml; keep the pinned home-relative store, one cleanup that remains fatal, and verification in setup-to-save order");
  add(violations, pnpmPrepares.length === 1 && pnpmSetupIndex < pnpmPrepareIndex && pnpmPrepareIndex < pnpmRestoreIndex && pnpmPrepares[0]?.run === pnpmCleanup, "pnpm store target must be cleared exactly once before cache restore");
  const playwrightCleanup = `node -e 'const { rmSync } = require("node:fs"); const { homedir } = require("node:os"); const { join } = require("node:path"); rmSync(join(homedir(), ".cache", "ms-playwright"), { force: true, recursive: true });'`;
  const trunkCleanup = `node -e 'const { rmSync } = require("node:fs"); const { homedir } = require("node:os"); const { join } = require("node:path"); rmSync(join(homedir(), ".cache", "trunk"), { force: true, recursive: true });'`;
  add(violations, coldSequence(root, ".github/actions/pnpm-install/action.yml", "runs", "pnpm-cache", "Clear incomplete pnpm store restore", pnpmCleanupIf, pnpmCleanup, "Install dependencies", pnpmInstallRun), "pnpm restore must clear an incomplete extraction before the exact install command");
  add(violations, coldSequence(root, ".github/workflows/ci.yml", "ui", "playwright-cache", "Clear incomplete Playwright restore", "inputs.no_skip_audit || steps.playwright-cache.outputs.cache-hit == ''", playwrightCleanup, "Install Playwright Chromium", "pnpm --filter @mento-protocol/ui-dashboard exec playwright install --with-deps chromium"), "CI Playwright restore must clear an incomplete extraction before install");
  add(violations, coldSequence(root, ".github/workflows/lighthouse.yml", "lighthouse", "playwright-cache", "Clear incomplete Playwright restore", "always() && steps.decide.outputs.run == 'true' && steps.playwright-cache.outputs.cache-hit == ''", playwrightCleanup, "Install Playwright Chromium (for fixture + INP measurement)", "pnpm exec playwright install chromium", "always() && steps.decide.outputs.run == 'true'"), "Lighthouse Playwright restore must clear an incomplete extraction before install");
  add(violations, coldSequence(root, ".github/workflows/trunk.yml", "trunk", "trunk-cache", "Clear incomplete Trunk restore", "steps.trunk-cache.outputs.cache-hit == ''", trunkCleanup, "Run Trunk", "./tools/trunk check --ci --all"), "Trunk restore must clear an incomplete extraction before the exact check command");
}

// prettier-ignore
export function authorityInventory(root = process.cwd()) {
  const authority = [];
  for (const path of reachableWorkflowFiles(root)) {
    const workflow = load(root, path);
    const env = JSON.stringify(workflow.env ?? {});
    const inherited = { envSecrets: /secrets\s*\./iu.test(env), envWorkflowToken: /github\s*\.\s*token/iu.test(env), workflowPermissions: workflow.permissions };
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      const permissions = job?.permissions ?? workflow.permissions;
      if (hasWritePermission(permissions) || jobReceivesCredential(job, inherited)) authority.push(authorityLine(path, jobId, workflow, job));
    }
  }
  return authority.sort();
}

// prettier-ignore
function checkAuthority(root, violations) { add(violations, JSON.stringify(authorityInventory(root)) === JSON.stringify(AUTHORITY), "approved PR authority permissions or credential bindings changed"); }

// prettier-ignore
function checkCi(root, violations) {
  const ci = load(root, ".github/workflows/ci.yml");
  const secrets = strings(ci.jobs).filter((value) => /\$\{\{[\s\S]*\bsecrets\b/iu.test(value));
  add(violations, secrets.length === 9 && secrets.every((value) => value.trim() === "${{ secrets.CODECOV_TOKEN }}"), "CI secret inventory must contain only nine Codecov token bindings");
  const writers = listYaml(root, ".github/workflows").flatMap((path) => Object.entries(load(root, path).jobs ?? {}).flatMap(([job, value]) => workflowJobSteps(value).filter((step) => isPnpmInstall(step) && step.with?.["write-cache"] != null && !bool(step.with["write-cache"], false)).map((step) => `${path}|${job}|${expr(step.with["write-cache"])}|${step.if == null && step["continue-on-error"] == null}`)));
  const writerJob = ci.jobs?.["production-infra-contract"]; const writerSteps = workflowJobSteps(writerJob); const writerIndex = writerSteps.findIndex(isPnpmInstall); const writerValidator = writerSteps[1]; const writerValidators = writerSteps.filter((step) => step?.run === "node scripts/check-agent-quality-gate-package-scripts.mjs");
  add(violations, stable(ci.on?.push) === stable({ branches: ["main"] }) && stable(ci.concurrency) === stable({ group: "${{ inputs.no_skip_audit && format('ci-no-skip-{0}', github.run_id) || format('{0}-{1}', github.workflow, github.event_name == 'pull_request' && github.ref || github.sha) }}", "cancel-in-progress": "${{ !inputs.no_skip_audit }}" }) && writers.join() === ".github/workflows/ci.yml|production-infra-contract|!inputs.no_skip_audit && github.event_name == 'push' && github.ref == 'refs/heads/main'|true" && stable(Object.keys(writerJob ?? {}).sort()) === stable(["name", "permissions", "runs-on", "steps", "timeout-minutes"]) && stable(writerJob?.permissions) === stable({ contents: "read", actions: "read" }) && writerJob?.["runs-on"] === "blacksmith-2vcpu-ubuntu-2404" && writerJob?.["timeout-minutes"] === 5 && writerIndex === 2 && writerValidators.length === 1 && String(writerSteps[0]?.uses ?? "").startsWith("actions/checkout@") && stable(Object.keys(writerSteps[0] ?? {}).sort()) === stable(["uses", "with"]) && stable(writerSteps[0]?.with) === stable({ ref: "${{ inputs.no_skip_audit && inputs.audit_source_sha || github.sha }}", "fetch-depth": "${{ inputs.no_skip_audit && '0' || '1' }}", "persist-credentials": false }) && stable(Object.keys(writerValidator ?? {}).sort()) === stable(["name", "run"]) && writerValidator?.name === "Validate trusted package-script pins" && writerValidator?.run === "node scripts/check-agent-quality-gate-package-scripts.mjs" && isPnpmInstall(writerSteps[2]) && stable(Object.keys(writerSteps[2] ?? {}).sort()) === stable(["uses", "with"]) && stable(writerSteps[2]?.with) === stable({ "restore-cache": "${{ !inputs.no_skip_audit }}", "write-cache": "${{ !inputs.no_skip_audit && github.event_name == 'push' && github.ref == 'refs/heads/main' }}" }), "exactly one dependency-free package-script validator (trusted package-script pin check) and one direct dependency-free x64 pnpm cache writer must remain reachable in order on every protected-main push in production-infra-contract");
  const codegen = workflowJobSteps(ci.jobs?.indexer).filter((step) => typeof step.run === "string" && step.run.includes("codegen --config config.multichain.testnet.yaml") && step.run.includes("codegen --config config.multichain.mainnet.yaml"));
  add(violations, codegen.length === 1 && codegen[0].if == null, "both Envio codegen commands must run unconditionally");
  const uploads = [];
  let uploadsSafe = true;
  for (const [job, value] of Object.entries(ci.jobs ?? {})) {
    const jobSteps = workflowJobSteps(value);
    jobSteps.forEach((step, index) => {
      if (!String(step.uses ?? "").startsWith("codecov/codecov-action@")) return;
      uploads.push([job, step.with?.flags, step.with?.directory].join("|"));
      uploadsSafe &&= jobSteps.slice(0, index).some((prior) => /(?:coverage|test:cov)/u.test(String(prior.run ?? "")));
      uploadsSafe &&= step.uses === "codecov/codecov-action@fb8b3582c8e4def4969c97caa2f19720cb33a72f" && step.with?.token === "${{ secrets.CODECOV_TOKEN }}" && step.with?.fail_ci_if_error === false && expr(step.if) === "!inputs.no_skip_audit && !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/')";
    });
  }
  add(violations, uploadsSafe && JSON.stringify(uploads) === JSON.stringify(CODECOV), "Codecov count, order, upload decision, or exclusion changed");
}

// prettier-ignore
function checkSchema(root, violations) {
  const workflow = load(root, ".github/workflows/schema-diff.yml");
  const job = workflow.jobs?.["schema-diff"];
  const jobSteps = workflowJobSteps(job);
  add(violations, JSON.stringify(workflow.on?.pull_request) === '{"branches":["main"]}', "schema-diff must run on every main pull request");
  add(violations, Object.keys(workflow.jobs ?? {}).join() === "schema-diff" && isMapping(job) && !hasWritePermission(job.permissions ?? workflow.permissions) && job.permissions?.["pull-requests"] === "read", "schema-diff must contain one read-only job with pull-request access");
  const filter = jobSteps.find((step) => step.id === "filter");
  const decision = String(jobSteps.find((step) => step.id === "decide")?.run ?? "");
  add(violations, decision.includes("dependabot[bot]") && decision.includes('PR_HEAD_REPO" != "$BASE_REPO'), "schema-diff fork or Dependabot exclusion changed");
  add(violations, bool(filter?.["continue-on-error"], true) && decision.includes('FILTER_OUTCOME" != "success') && decision.includes('echo "run=true"'), "schema-diff path filter must be nonfatal and fail closed");
  const diff = jobSteps.find((step) => step.name === "Run schema diff");
  const summary = jobSteps.find((step) => step.name === "Publish schema diff summary");
  add(violations, expr(diff?.if) === "steps.decide.outputs.run == 'true'" && expr(diff?.run).includes("if ! node scripts/schema-diff.mjs /tmp/schema-base.graphql indexer-envio/schema.graphql") && String(diff?.run ?? "").includes("Manual review required."), "schema-diff command and advisory fallback changed");
  add(violations, expr(summary?.if) === "always()" && String(summary?.run ?? "").includes("$GITHUB_STEP_SUMMARY") && /^\s*readonly max_summary_bytes=60000\s*$/mu.test(String(summary?.run ?? "")) && String(summary?.run ?? "").includes('head -c "$max_summary_bytes"'), "schema-diff summary must always run with a 60000-byte bound");
  const forbidden = /(?:upload-artifact|download-artifact|github-script|sticky-pull-request-comment)/iu;
  add(violations, jobSteps.every((step) => !forbidden.test(String(step.uses ?? ""))), "schema-diff comment writer or artifact handoff is forbidden");
}

// prettier-ignore
function checkDependabot(root, violations) {
  const paths = [
    ".github/workflows/dependabot-auto-merge-candidate.yml",
    ".github/workflows/dependabot-auto-merge.yml",
  ];
  const presentPaths = paths.filter((path) => existsSync(join(root, path)));
  add(violations, presentPaths.length !== 1, "the Dependabot auto-merge classifier and writer workflows must be present or absent as one reviewed pair");
  for (const path of presentPaths) {
    validateWorkflowInventory(path, load(root, path), violations);
  }
}

// prettier-ignore
export function checkStructuralRepository(root = process.cwd()) { const violations = []; checkCaches(root, violations); checkAuthority(root, violations); checkCi(root, violations); checkSchema(root, violations); checkDependabot(root, violations); return violations; }

function main() {
  const violations = checkStructuralRepository();
  for (const violation of violations) console.error(`FAIL: ${violation}`);
  if (violations.length > 0) process.exitCode = 1;
  else console.log("PR validation trust contract passes.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
