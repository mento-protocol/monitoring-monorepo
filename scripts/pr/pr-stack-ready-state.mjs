import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchReadyState, withGhAbortSignal } from "./pr-ready-state.mjs";
import { summarizeFeedbackState } from "./pr-feedback-state-core.mjs";

// This describes an API observation. It never authorizes or performs a merge.
export function classifyStackObservation(value, previous = null) {
  const pr = value?.pr ?? {};
  const prior = previous?.pr ?? previous;
  const observation = {
    prNumber: pr.number ?? null,
    headRefOid: pr.headRefOid ?? null,
    baseRefOid: pr.baseRefOid ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    autoMergeEnabledAt: pr.autoMergeEnabledAt ?? null,
  };
  const result = (state, message) => ({ ...observation, state, message });
  if (pr.state === "MERGED")
    return result(
      "MERGED",
      "GitHub confirms merged; rediscover remaining layers",
    );
  if (pr.state === "CLOSED")
    return result("CLOSED", "GitHub confirms closed without merge");
  if (pr.state !== "OPEN")
    return result("UNKNOWN", "Pull request state is unavailable");
  if (
    prior &&
    ["headRefOid", "baseRefOid", "headRefName", "baseRefName"].some(
      (key) => prior[key] != null && pr[key] != null && prior[key] !== pr[key],
    )
  )
    return result(
      "HEAD_OR_BASE_CHANGED",
      "Head or base changed; repeat verification",
    );
  if (
    previous?.stack &&
    value?.stack &&
    fingerprint(previous.stack) !== fingerprint(value.stack)
  )
    return result(
      "SNAPSHOT_CHANGED",
      "Stack membership or another layer changed; repeat verification",
    );
  if (pr.mergeStateStatus === "BEHIND")
    return result(
      "BASE_UPDATE_REQUIRED",
      "Head is behind the base; integrate the current base and recheck",
    );
  const blockers = value?.required?.blockers ?? [];
  const checks = blockers.filter((item) => item.kind === "check");
  if (checks.some((item) => item.state === "fail"))
    return result(
      "CHECKS_FAILED",
      "Required checks failed or were canceled; pending replacements are not success",
    );
  if (checks.some((item) => item.state === "pending"))
    return result("CHECKS_PENDING", "Required checks are pending");
  if (value?.feedbackReady === false)
    return result("FEEDBACK_BLOCKED", "Current-head feedback is blocked");
  if (blockers.length > 0)
    return result(
      "READINESS_BLOCKED",
      "Required feedback or readiness is blocked",
    );
  if (
    value?.ready === true &&
    pr.headRefOid &&
    pr.baseRefOid &&
    pr.mergeStateStatus != null &&
    pr.mergeStateStatus !== "UNKNOWN"
  ) {
    if (pr.autoMergeEnabledAt)
      return result(
        "MERGE_REQUESTED",
        "Auto-merge intent is recorded; wait for GitHub to confirm MERGED",
      );
    return result(
      "AWAITING_USER_MERGE",
      "Readiness passed; wait for an explicit user-approved merge and confirmed MERGED state",
    );
  }
  return result("UNKNOWN", "Merge readiness is not fully observed");
}

function pendingObservation(value, context, previous = null) {
  const observation = classifyStackObservation(value, previous);
  return `PENDING ${context}; ${observation.state}: ${observation.message}`;
}

function fingerprint(stack) {
  return JSON.stringify([
    stack.number,
    stack.protectionBaseRef,
    stack.protectionBaseOid,
    stack.layers,
  ]);
}

export async function evaluateStackGate(
  initial,
  repoArg,
  fetchState = fetchReadyState,
  feedback = summarizeFeedbackState,
  timeoutMs = 5 * 60_000,
) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve("PENDING stack verification deadline exceeded");
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      expired,
      withGhAbortSignal(controller.signal, () =>
        evaluateLayers(initial, repoArg, fetchState, feedback),
      ),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function evaluateLayers(initial, repoArg, fetchState, feedback) {
  const stack = initial?.stack;
  if (
    !stack ||
    !Array.isArray(stack.layers) ||
    stack.layers.length === 0 ||
    stack.layers.length > 100
  )
    return "PENDING stack membership unavailable or exceeds 100 layers";
  const signature = fingerprint(stack);
  const selected = stack.layers.find(
    (layer) => layer.number === initial.pr?.number,
  );
  if (!selected || selected.state !== initial.pr?.state)
    return "PENDING selected stack layer changed; SNAPSHOT_CHANGED: rediscover stack membership";
  if (selected.state !== "OPEN")
    return pendingObservation(initial, "selected stack layer is terminal");
  const observedBases = new Map();
  const matches = (value, layer) => {
    const baseOid = value?.pr?.baseRefOid;
    if (
      typeof baseOid !== "string" ||
      !/^[0-9a-f]{40}$/i.test(baseOid) ||
      (layer.baseRefOid != null && layer.baseRefOid !== baseOid) ||
      (observedBases.has(layer.number) &&
        observedBases.get(layer.number) !== baseOid)
    )
      return false;
    observedBases.set(layer.number, baseOid);
    return (
      value?.stack &&
      fingerprint(value.stack) === signature &&
      value.pr?.number === layer.number &&
      value.pr?.state === "OPEN" &&
      value.pr?.headRefOid === layer.headRefOid &&
      value.pr?.headRefName === layer.headRefName &&
      value.pr?.baseRefName === layer.baseRefName
    );
  };
  if (!matches(initial, selected))
    return pendingObservation(
      initial,
      "selected stack layer base unavailable or changed",
      selected,
    );
  try {
    for (const layer of stack.layers.filter(
      (entry) => entry.state === "OPEN",
    )) {
      const detail = await fetchState({
        prArg: String(layer.number),
        repoArg,
        includeFeedbackDetails: true,
      });
      if (!matches(detail, layer))
        return pendingObservation(
          detail,
          `stack layer #${layer.number} snapshot changed`,
          { pr: layer, stack },
        );
      if (feedback(detail).ready !== true)
        return pendingObservation(
          { ...detail, feedbackReady: false },
          `stack layer #${layer.number} feedback blocked`,
        );
      const ready = await fetchState({
        prArg: String(layer.number),
        repoArg,
        includeFeedbackDetails: true,
      });
      if (!matches(ready, layer))
        return pendingObservation(
          ready,
          `stack layer #${layer.number} snapshot changed`,
          { pr: layer, stack },
        );
      if (feedback(ready).ready !== true)
        return pendingObservation(
          { ...ready, feedbackReady: false },
          `stack layer #${layer.number} feedback blocked`,
        );
      if (ready.ready !== true)
        return pendingObservation(
          ready,
          `stack layer #${layer.number} readiness blocked`,
        );
      if (
        !["AWAITING_USER_MERGE", "MERGE_REQUESTED"].includes(
          classifyStackObservation(ready).state,
        )
      )
        return pendingObservation(
          ready,
          `stack layer #${layer.number} merge observation incomplete`,
        );
    }
    const final = await fetchState({
      prArg: String(selected.number),
      repoArg,
      includeFeedbackDetails: true,
    });
    if (!matches(final, selected))
      return pendingObservation(
        final,
        "stack changed during final verification",
        { pr: selected, stack },
      );
    if (feedback(final).ready !== true)
      return pendingObservation(
        { ...final, feedbackReady: false },
        "feedback changed during final verification",
      );
    if (final.ready !== true)
      return pendingObservation(
        final,
        "readiness changed during final verification",
      );
    const observation = classifyStackObservation(final);
    if (!["AWAITING_USER_MERGE", "MERGE_REQUESTED"].includes(observation.state))
      return pendingObservation(final, "final merge observation incomplete");
    return `PASS stack #${stack.number}: every open layer passed both projections; ${observation.state}: ${observation.message}`;
  } catch {
    return "PENDING stack projections unavailable";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await evaluateStackGate(
      JSON.parse(readFileSync(0, "utf8")),
      process.argv[2],
    );
    process.stdout.write(result);
  } catch {
    process.stdout.write("PENDING stack input unavailable");
  }
}
