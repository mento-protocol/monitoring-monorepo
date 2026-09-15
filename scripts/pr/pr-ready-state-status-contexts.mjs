/**
 * Turn GitHub branch protection and ruleset API payloads into the readiness
 * probe's required-status-context list and strict-policy tri-state.
 *
 * Split out of pr-ready-state.mjs (docs/pr-checklists/recurring-review-patterns.md
 * "File-size budget": a file the change pushes up past the 600-line soft cap
 * must be split in the same PR).
 */

import { checkDisplayName } from "./pr-ready-state-core.mjs";
import {
  ghApiJsonResult,
  ghApiJsonPagesResult,
  repoPath,
  repoFromPath,
} from "./pr-ready-state-gh.mjs";

function addRequiredContext(byKey, context, integrationId = null) {
  if (!context) return;
  const normalizedIntegrationId =
    integrationId === null || integrationId === undefined
      ? null
      : Number(integrationId);
  const key = `${context}\0${normalizedIntegrationId ?? ""}`;
  byKey.set(key, {
    context,
    integrationId: normalizedIntegrationId,
  });
}

// Combine required-status-context lists from different sources (classic
// branch protection, a ruleset) into one deduplicated, sorted list, keyed the
// same way `addRequiredContext` keys a single source's contexts.
function mergeRequiredStatusContexts(...contextLists) {
  const byKey = new Map();
  for (const contexts of contextLists) {
    for (const context of contexts) {
      addRequiredContext(byKey, context.context, context.integrationId);
    }
  }
  return [...byKey.values()].sort((a, b) => a.context.localeCompare(b.context));
}

function workflowPath(workflow) {
  return (
    workflow.path ??
    workflow.workflow_path ??
    workflow.workflowPath ??
    workflow.file_path ??
    workflow.filePath ??
    null
  );
}

function workflowRepoPath(workflow, rule, fallbackRepoPath = null) {
  const explicitRepo =
    workflow.repository_full_name ??
    workflow.repositoryFullName ??
    workflow.repository?.full_name ??
    workflow.repository?.fullName ??
    workflow.repository_name ??
    workflow.repositoryName ??
    null;
  if (explicitRepo && String(explicitRepo).includes("/")) {
    return String(explicitRepo);
  }

  if (
    rule?.ruleset_source_type === "Repository" &&
    rule?.ruleset_source &&
    String(rule.ruleset_source).includes("/")
  ) {
    return String(rule.ruleset_source);
  }

  if (rule?.ruleset_source_type) {
    return null;
  }

  return fallbackRepoPath;
}

function workflowLookupKey(repoPathValue, path) {
  return repoPathValue && path ? `${repoPathValue}\0${path}` : null;
}

function flattenRules(rules = [], inherited = {}) {
  const flattened = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const current = {
      ...inherited,
      ...rule,
    };
    if (rule.type) flattened.push(current);
    flattened.push(
      ...flattenRules(rule.rules ?? [], {
        ruleset_source: current.ruleset_source,
        ruleset_source_type: current.ruleset_source_type,
      }),
    );
  }
  return flattened;
}

export function workflowPathsFromRules(rules = []) {
  const paths = new Set();
  for (const rule of flattenRules(rules)) {
    if (rule.type !== "workflows") continue;

    for (const workflow of rule.parameters?.workflows ?? []) {
      const path = workflowPath(workflow);
      if (path) paths.add(path);
    }
  }

  return [...paths].sort((a, b) => a.localeCompare(b));
}

function workflowRepoPathsFromRules(rules = [], fallbackRepoPath = null) {
  const repoPaths = new Set();
  for (const rule of flattenRules(rules)) {
    if (rule.type !== "workflows") continue;

    for (const workflow of rule.parameters?.workflows ?? []) {
      const path = workflowPath(workflow);
      const repoPathValue = workflowRepoPath(workflow, rule, fallbackRepoPath);
      if (path && repoPathValue) repoPaths.add(repoPathValue);
    }
  }

  return [...repoPaths].sort((a, b) => a.localeCompare(b));
}

function unresolvedWorkflowSourcesFromRules(
  rules = [],
  fallbackRepoPath = null,
) {
  const unresolved = [];
  for (const rule of flattenRules(rules)) {
    if (rule.type !== "workflows") continue;

    for (const workflow of rule.parameters?.workflows ?? []) {
      const path = workflowPath(workflow);
      if (!path) continue;
      if (workflowRepoPath(workflow, rule, fallbackRepoPath) === null) {
        unresolved.push(path);
      }
    }
  }

  return unresolved;
}

function requiredWorkflowContext(
  workflow,
  rule,
  workflowNameByPath,
  fallbackRepoPath = null,
) {
  const path = workflowPath(workflow);
  const repoPathValue = workflowRepoPath(workflow, rule, fallbackRepoPath);
  const keyedName = workflowNameByPath.get(
    workflowLookupKey(repoPathValue, path),
  );
  return (
    workflow.name ??
    workflow.workflow_name ??
    workflow.workflowName ??
    keyedName ??
    (path ? workflowNameByPath.get(path) : null) ??
    null
  );
}

function requiredWorkflowJobContexts({
  workflow,
  rule,
  workflowNameByPath,
  fallbackRepoPath,
  statusCheckRollup,
}) {
  const workflowName = requiredWorkflowContext(
    workflow,
    rule,
    workflowNameByPath,
    fallbackRepoPath,
  );
  if (!workflowName) return [];

  const matchingJobNames = statusCheckRollup
    .filter((check) => check.workflowName === workflowName)
    .map(checkDisplayName);
  return matchingJobNames.length > 0 ? matchingJobNames : [workflowName];
}

export function requiredStatusContextsFromRules(
  rules = [],
  {
    workflowNameByPath = new Map(),
    fallbackRepoPath = null,
    statusCheckRollup = [],
  } = {},
) {
  const byKey = new Map();
  for (const rule of flattenRules(rules)) {
    if (rule.type === "required_status_checks") {
      for (const check of rule.parameters?.required_status_checks ?? []) {
        addRequiredContext(
          byKey,
          check.context,
          check.integration_id ?? check.integrationId ?? null,
        );
      }
      continue;
    }

    if (rule.type === "workflows") {
      for (const workflow of rule.parameters?.workflows ?? []) {
        for (const context of requiredWorkflowJobContexts({
          workflow,
          rule,
          workflowNameByPath,
          fallbackRepoPath,
          statusCheckRollup,
        })) {
          addRequiredContext(
            byKey,
            context,
            workflow.integration_id ?? workflow.integrationId ?? null,
          );
        }
      }
    }
  }

  return [...byKey.values()].sort((a, b) => a.context.localeCompare(b.context));
}

// A base can carry more than one applicable `required_status_checks` rule
// (e.g. an org ruleset layered with a repo ruleset), and GitHub enforces the
// most restrictive of them, so any confirmed `true` wins outright. `null`
// means unknown — no matching rule, or a matching rule with no explicit
// boolean — and the caller must fail closed on it, the same as any other
// branch-protection lookup gap. Only return `false` when every matching rule
// explicitly disables strict mode.
export function strictRequiredStatusChecksPolicyFromRules(rules = []) {
  let sawRule = false;
  let sawUnknown = false;
  for (const rule of flattenRules(rules)) {
    if (rule.type !== "required_status_checks") continue;
    sawRule = true;
    const value = rule.parameters?.strict_required_status_checks_policy;
    if (value === true) return true;
    if (typeof value !== "boolean") sawUnknown = true;
  }
  return sawRule && !sawUnknown ? false : null;
}

// Classic branch protection and a ruleset can both apply to the same base;
// GitHub enforces the stricter of the two. Combine them the same way multiple
// ruleset rules combine: any confirmed `true` wins outright. When no ruleset
// `required_status_checks` rule matches at all, classic protection's reading
// stands unopposed. Otherwise `false` requires both sources to explicitly
// confirm non-strict: an unknown classic reading (no boolean `strict` field)
// can still mean strict mode is on, so a ruleset's confirmed `false` alone
// cannot be trusted to override it — fail closed with `null` instead.
function combineStrictRequiredStatusChecksPolicy(classicStrict, rules = []) {
  const rulesetStrict = strictRequiredStatusChecksPolicyFromRules(rules);
  if (classicStrict === true || rulesetStrict === true) return true;
  const hasRulesetRequirement = flattenRules(rules).some(
    (rule) => rule.type === "required_status_checks",
  );
  if (!hasRulesetRequirement) return classicStrict;
  return classicStrict === false && rulesetStrict === false ? false : null;
}

export function requiredStatusContextsFromRulesResult(
  rules = [],
  {
    workflowNameByPath = new Map(),
    workflowNameLookupError = null,
    fallbackRepoPath = null,
    statusCheckRollup = [],
  } = {},
) {
  const unresolvedSources =
    fallbackRepoPath === null
      ? []
      : unresolvedWorkflowSourcesFromRules(rules, fallbackRepoPath);
  if (unresolvedSources.length > 0) {
    return {
      contexts: [],
      error: `Unable to resolve source repository for required workflow(s): ${unresolvedSources.join(", ")}`,
    };
  }

  if (workflowPathsFromRules(rules).length > 0 && workflowNameLookupError) {
    return { contexts: [], error: workflowNameLookupError };
  }

  return {
    contexts: requiredStatusContextsFromRules(rules, {
      workflowNameByPath,
      fallbackRepoPath,
      statusCheckRollup,
    }),
    error: null,
  };
}

export function requiredStatusContextsFromProtection(protection) {
  if (Array.isArray(protection)) return protection;

  const byKey = new Map();
  for (const check of protection?.checks ?? []) {
    addRequiredContext(
      byKey,
      check.context,
      check.app_id ?? check.appId ?? null,
    );
  }

  if (byKey.size === 0) {
    for (const context of protection?.contexts ?? []) {
      addRequiredContext(byKey, context);
    }
  }

  return [...byKey.values()].sort((a, b) => a.context.localeCompare(b.context));
}

async function fetchWorkflowNameByPath(repo, pathKey = repoPath(repo)) {
  const result = await ghApiJsonPagesResult(repo, [
    `repos/${repoPath(repo)}/actions/workflows?per_page=100`,
  ]);
  const byPath = new Map();
  if (!result.ok) return { byPath, error: result.error };

  for (const page of result.value ?? []) {
    for (const workflow of page.workflows ?? []) {
      if (workflow.path && workflow.name) {
        byPath.set(workflowLookupKey(pathKey, workflow.path), workflow.name);
        byPath.set(workflow.path, workflow.name);
      }
    }
  }

  return { byPath, error: null };
}

async function fetchWorkflowNamesForRules(repo, rules) {
  const fallbackRepoPath = repoPath(repo);
  const byPath = new Map();
  const unresolvedSources = unresolvedWorkflowSourcesFromRules(
    rules,
    fallbackRepoPath,
  );

  if (unresolvedSources.length > 0) {
    return {
      byPath: new Map(),
      error: `Unable to resolve source repository for required workflow(s): ${unresolvedSources.join(", ")}`,
    };
  }

  const results = await Promise.all(
    workflowRepoPathsFromRules(rules, fallbackRepoPath).map(
      async (sourcePath) => {
        const sourceRepo = repoFromPath(sourcePath, repo.host);
        return fetchWorkflowNameByPath(sourceRepo, sourcePath);
      },
    ),
  );

  for (const result of results) {
    if (result.error) return { byPath: new Map(), error: result.error };
    for (const [key, value] of result.byPath.entries()) {
      byPath.set(key, value);
    }
  }

  return { byPath, error: null };
}

function isHttpNotFoundError(error) {
  return /\bHTTP 404\b/i.test(String(error));
}

export async function fetchRequiredStatusContexts({
  repo,
  baseRef,
  statusCheckRollup = [],
  fetchProtection = ghApiJsonResult,
  fetchRules = ghApiJsonPagesResult,
  fetchWorkflowNames = fetchWorkflowNamesForRules,
}) {
  const encodedBaseRef = encodeURIComponent(baseRef);
  const result = await fetchProtection(repo, [
    `repos/${repoPath(repo)}/branches/${encodedBaseRef}/protection/required_status_checks`,
  ]);

  if (!result.ok) {
    if (isHttpNotFoundError(result.error)) {
      const rulesResult = await fetchRules(repo, [
        `repos/${repoPath(repo)}/rules/branches/${encodedBaseRef}`,
      ]);

      if (!rulesResult.ok) {
        return {
          contexts: [],
          error: rulesResult.error,
          strict: null,
        };
      }

      const strict = strictRequiredStatusChecksPolicyFromRules(
        rulesResult.value ?? [],
      );
      const workflowNameByPath = workflowPathsFromRules(rulesResult.value ?? [])
        .length
        ? await fetchWorkflowNames(repo, rulesResult.value ?? [])
        : { byPath: new Map(), error: null };

      const rulesContexts = requiredStatusContextsFromRulesResult(
        rulesResult.value ?? [],
        {
          workflowNameByPath: workflowNameByPath.byPath,
          workflowNameLookupError: workflowNameByPath.error,
          fallbackRepoPath: repoPath(repo),
          statusCheckRollup,
        },
      );
      if (rulesContexts.error === null && rulesContexts.contexts.length === 0) {
        return {
          contexts: [],
          error:
            "Required status contexts unavailable: classic branch protection returned HTTP 404 and branch rulesets did not define required status checks or workflows",
          strict,
        };
      }

      return { ...rulesContexts, strict };
    }

    return {
      contexts: [],
      error: result.error,
      strict: null,
    };
  }

  const classicStrict =
    typeof result.value?.strict === "boolean" ? result.value.strict : null;
  const classicContexts = requiredStatusContextsFromProtection(result.value);

  // A ruleset can also apply alongside classic protection: it can impose a
  // stricter strict-mode policy than classic protection alone reports, and it
  // can require status contexts classic protection does not know about.
  // Always consult rulesets too, even once classic protection already
  // confirms strict mode, so a ruleset-only required check is never dropped.
  const rulesResult = await fetchRules(repo, [
    `repos/${repoPath(repo)}/rules/branches/${encodedBaseRef}`,
  ]);

  if (!rulesResult.ok) {
    // A failed ruleset read means a ruleset-only required check cannot be
    // ruled out. Report classicContexts for diagnostics but propagate the
    // read error too, the same as every other branch-protection lookup
    // failure here, so callers fail closed instead of trusting classic's
    // contexts as complete.
    return {
      contexts: classicContexts,
      error: rulesResult.error,
      strict: classicStrict === true ? true : null,
    };
  }

  const strict =
    classicStrict === true
      ? true
      : combineStrictRequiredStatusChecksPolicy(
          classicStrict,
          rulesResult.value ?? [],
        );

  const workflowNameByPath = workflowPathsFromRules(rulesResult.value ?? [])
    .length
    ? await fetchWorkflowNames(repo, rulesResult.value ?? [])
    : { byPath: new Map(), error: null };

  const rulesContexts = requiredStatusContextsFromRulesResult(
    rulesResult.value ?? [],
    {
      workflowNameByPath: workflowNameByPath.byPath,
      workflowNameLookupError: workflowNameByPath.error,
      fallbackRepoPath: repoPath(repo),
      statusCheckRollup,
    },
  );

  if (rulesContexts.error !== null) {
    return { ...rulesContexts, strict };
  }

  return {
    contexts: mergeRequiredStatusContexts(
      classicContexts,
      rulesContexts.contexts,
    ),
    error: null,
    strict,
  };
}
