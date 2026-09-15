/**
 * The `base-red` blocker's policy: how a required context is matched to a
 * check, and when an operator's break-glass override may retire a red base.
 *
 * `base-red` stops any merge onto a red base branch, which would otherwise
 * also stop the fix or revert that turns it green. The override is the
 * authorized way out, so its conditions live here in one place rather than
 * inline among the other blockers.
 *
 * Split out of pr-ready-state-core.mjs (docs/pr-checklists/
 * recurring-review-patterns.md "File-size budget").
 */

import {
  checkDisplayName,
  classifyCheck,
} from "./pr-ready-state-check-state.mjs";
import { parseTimestamp } from "./pr-ready-state-review-signals.mjs";
import { BASE_RED_OVERRIDE_GATE } from "./pr-ready-state-overrides.mjs";

export function requiredContextName(context) {
  return typeof context === "string" ? context : context.context;
}

export function requiredContextIntegrationId(context) {
  const value =
    typeof context === "string"
      ? null
      : (context.integrationId ?? context.integration_id ?? null);
  return value === null || value === undefined ? null : Number(value);
}

export function requiredContextIdentity(context) {
  return `${requiredContextName(context)}\0${requiredContextIntegrationId(context) ?? ""}`;
}

export function checkAppId(check) {
  const value =
    check.appId ??
    check.app_id ??
    check.app?.id ??
    check.app?.databaseId ??
    null;
  return value === null || value === undefined ? null : Number(value);
}

export function checkMatchesRequiredContext(check, context) {
  if (checkDisplayName(check) !== requiredContextName(context)) return false;

  const requiredIntegrationId = requiredContextIntegrationId(context);
  if (requiredIntegrationId === null) return true;

  const appId = checkAppId(check);
  return appId !== null && appId === requiredIntegrationId;
}

// When the newest required failing run on the base finished. The override has
// to be strictly newer than this: a run that landed in the same second the
// comment was written is a result the operator could not have read, and GitHub
// timestamps are only second-precision.
function latestRedBaseRunMs(
  baseStatusCheckRollup,
  requiredStatusContexts,
  requiredStatusContextsAvailable,
) {
  return baseStatusCheckRollup
    .filter((check) => {
      if (classifyCheck(check) !== "fail") return false;
      // Match on app identity too, or an unrelated app's same-named failure —
      // which the required/optional split correctly treats as optional — would
      // expire a valid override.
      return (
        !requiredStatusContextsAvailable ||
        requiredStatusContexts.some((context) =>
          checkMatchesRequiredContext(check, context),
        )
      );
    })
    .map(
      (check) =>
        parseTimestamp(check.completedAt ?? check.startedAt ?? null) ?? 0,
    )
    .reduce((newest, at) => Math.max(newest, at), 0);
}

/**
 * Turn the base's health into blockers or, under a valid override, notes.
 *
 * The override is bound to this head, to the exact base commit the operator
 * judged, and to the failing runs they could have seen. A base whose health
 * could not be read is never overridable: waving through a state nobody
 * observed is the fail-open this blocker exists to prevent.
 *
 * `appliedOverride` is non-null only when an override actually retired a
 * finding, so callers can report `readinessOverrides[]` as the contract
 * promises — overrides that affected a gate, not comments that changed nothing.
 */
export function buildBaseRedFindings({
  redBaseChecks = [],
  baseHealthError = null,
  baseHealthOid = null,
  baseStatusCheckRollup = [],
  requiredStatusContexts = [],
  requiredStatusContextsAvailable = false,
  activeReadinessOverrides = [],
  currentHeadOid = null,
  prUrl = null,
}) {
  if (baseHealthError !== null) {
    return {
      blockers: [
        {
          kind: "base-red",
          // Stable name, diagnostic in `state`, like the branch-protection
          // blocker: a transport error carries a whole query and stderr, and
          // the compact stream is one physical line per summary.
          name: "Base branch health unavailable",
          state: `unknown: ${baseHealthError}`,
          required: true,
          url: prUrl,
        },
      ],
      notes: [],
      appliedOverride: null,
    };
  }

  if (redBaseChecks.length === 0) {
    return { blockers: [], notes: [], appliedOverride: null };
  }

  const newestFailureMs = latestRedBaseRunMs(
    baseStatusCheckRollup,
    requiredStatusContexts,
    requiredStatusContextsAvailable,
  );
  const override = activeReadinessOverrides.find(
    (candidate) =>
      candidate.gate === BASE_RED_OVERRIDE_GATE &&
      candidate.head === currentHeadOid &&
      baseHealthOid !== null &&
      candidate.base === baseHealthOid &&
      (parseTimestamp(candidate.createdAt) ?? 0) > newestFailureMs,
  );

  const findings = redBaseChecks.map((check) => ({
    kind: "base-red",
    name: `Base check ${check.name} is red at ${baseHealthOid ?? "an unknown base commit"}`,
    state: "red",
    url: check.url ?? prUrl,
  }));

  if (!override) {
    return {
      blockers: findings.map((finding) => ({ ...finding, required: true })),
      notes: [],
      appliedOverride: null,
    };
  }

  return {
    blockers: [],
    // Overridden is never silent: the operator and the reason ride along with
    // the summary, in JSON and in the human note line.
    notes: findings.map((finding) => ({
      ...finding,
      name: `${finding.name} — overridden by @${override.author}: ${override.reason}`,
      state: "overridden",
      required: false,
      override: {
        gate: BASE_RED_OVERRIDE_GATE,
        author: override.author,
        reason: override.reason,
        head: override.head,
        base: override.base,
        url: override.url,
      },
    })),
    appliedOverride: override,
  };
}
