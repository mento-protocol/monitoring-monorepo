import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchReadyState, withGhAbortSignal } from "./pr-ready-state.mjs";
import { summarizeFeedbackState } from "./pr-feedback-state-core.mjs";

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
  if (!selected || selected.state !== "OPEN")
    return "PENDING selected stack layer changed";
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
    return "PENDING selected stack layer base unavailable or changed";
  try {
    for (const layer of stack.layers.filter(
      (entry) => entry.state === "OPEN",
    )) {
      const detail = await fetchState({
        prArg: String(layer.number),
        repoArg,
        includeFeedbackDetails: true,
      });
      if (!matches(detail, layer) || feedback(detail).ready !== true)
        return `PENDING stack layer #${layer.number} feedback blocked or snapshot changed`;
      const ready = await fetchState({
        prArg: String(layer.number),
        repoArg,
        includeFeedbackDetails: true,
      });
      if (
        !matches(ready, layer) ||
        ready.ready !== true ||
        feedback(ready).ready !== true
      )
        return `PENDING stack layer #${layer.number} readiness blocked or snapshot changed`;
    }
    const final = await fetchState({
      prArg: String(selected.number),
      repoArg,
      includeFeedbackDetails: true,
    });
    if (
      !matches(final, selected) ||
      final.ready !== true ||
      feedback(final).ready !== true
    )
      return "PENDING stack changed during final verification";
    return `PASS stack #${stack.number}: every open layer passed both projections`;
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
