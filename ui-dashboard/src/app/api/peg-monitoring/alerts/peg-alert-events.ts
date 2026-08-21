import { z } from "zod";
import type { PegAlertEvent } from "@/lib/peg-alerts";
import {
  pegAlertAssetName,
  pegAlertCauseCopy,
  pegAlertRuleKind,
  pegAlertSourceCurrency,
  pegAlertSourceName,
} from "./peg-alert-copy";

export const PEG_ALERTS_MAX_STATE_ROWS = 1_000;
const POLICY_DUPLICATE_WINDOW_SECONDS = 90;

const label = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const stateFieldSchema = z
  .object({ name: z.string().min(1).max(32), type: z.string().min(1).max(32) })
  .passthrough();
const stateValuesSchema = z
  .object({
    A: z.number().finite().optional(),
    Price: z.number().finite().optional(),
    Fill: z.number().finite().optional(),
    ListingAge: z.number().finite().optional(),
    Structural: z.number().finite().optional(),
    Spread: z.number().finite().optional(),
    Corroboration: z.number().finite().optional(),
    Reason: z.number().finite().optional(),
    HttpStatus: z.number().finite().optional(),
    threshold: z.number().finite().optional(),
  })
  .strict();
const stateLineSchema = z
  .object({
    schemaVersion: z.literal(1),
    previous: z.string().min(1).max(64),
    current: z.string().min(1).max(64),
    fingerprint: z.string().min(1).max(64),
    ruleTitle: z.string().min(1).max(256),
    ruleUID: z.string().min(1).max(64),
    values: stateValuesSchema.optional().default({}),
    labels: z
      .object({
        alertname: z.string().min(1).max(256),
        asset: label,
        policy_version: label,
        route: z.enum(["market", "ops", "page"]),
        service: z.literal("peg-monitoring"),
        severity: z.enum(["warning", "critical"]),
        source: z.string().max(64),
      })
      .passthrough(),
  })
  .passthrough();
const stateFrameSchema = z
  .object({
    schema: z
      .object({
        name: z.literal("states"),
        fields: z.array(stateFieldSchema).min(3).max(8),
      })
      .passthrough(),
    data: z
      .object({ values: z.array(z.array(z.unknown())).min(3).max(8) })
      .passthrough(),
  })
  .passthrough();

type StateFrame = z.infer<typeof stateFrameSchema>;
type StateLine = z.infer<typeof stateLineSchema>;

class InvalidPegAlertsUpstreamError extends Error {}

type PegStateTransition = {
  at: number;
  kind:
    | "raised"
    | "cleared"
    | "error"
    | "error-recovered"
    | "error-recovered-alerting";
  identity: string;
  line: StateLine;
};

function onlyNamedFieldIndex(
  fields: readonly { name: string; type: string }[],
  name: string,
  type: string,
): number {
  const indexes = fields.flatMap((field, index) =>
    field.name === name && field.type === type ? [index] : [],
  );
  if (indexes.length !== 1) throw new InvalidPegAlertsUpstreamError();
  return indexes[0]!;
}

function baseState(value: string): string {
  return value.split(" ", 1)[0] ?? value;
}

function transitionKind(line: StateLine): PegStateTransition["kind"] | null {
  const current = baseState(line.current);
  const previous = baseState(line.previous);
  if (current === "Error") return "error";
  if (previous === "Error" && current === "Alerting")
    return "error-recovered-alerting";
  if (previous === "Error" && current === "Normal") return "error-recovered";
  if (current === "Alerting") return "raised";
  if (previous === "Alerting" && current === "Normal") return "cleared";
  return null;
}

export function parseStateTransitions(
  raw: unknown,
  fromSeconds: number,
  toSeconds: number,
): PegStateTransition[] {
  const frames = Array.isArray(raw) ? raw : [raw];
  return frames.flatMap((frame) =>
    parseStateFrameTransitions(frame, fromSeconds, toSeconds),
  );
}

function parseStateFrameTransitions(
  raw: unknown,
  fromSeconds: number,
  toSeconds: number,
): PegStateTransition[] {
  const parsed = stateFrameSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidPegAlertsUpstreamError();
  const frame: StateFrame = parsed.data;
  if (frame.schema.fields.length !== frame.data.values.length)
    throw new InvalidPegAlertsUpstreamError();
  const timeIndex = onlyNamedFieldIndex(frame.schema.fields, "time", "time");
  const lineIndex = onlyNamedFieldIndex(frame.schema.fields, "line", "other");
  const labelsIndex = onlyNamedFieldIndex(
    frame.schema.fields,
    "labels",
    "other",
  );
  const times = frame.data.values[timeIndex]!;
  const lines = frame.data.values[lineIndex]!;
  const streamLabels = frame.data.values[labelsIndex]!;
  if (
    times.length !== lines.length ||
    times.length !== streamLabels.length ||
    times.length > PEG_ALERTS_MAX_STATE_ROWS
  )
    throw new InvalidPegAlertsUpstreamError();

  const deduped = new Map<string, PegStateTransition>();
  for (let index = 0; index < times.length; index += 1) {
    const atMs = times[index];
    const lineResult = stateLineSchema.safeParse(lines[index]);
    const streamResult = z
      .record(z.string(), z.string())
      .safeParse(streamLabels[index]);
    if (
      typeof atMs !== "number" ||
      !Number.isSafeInteger(atMs) ||
      atMs < fromSeconds * 1_000 ||
      atMs > toSeconds * 1_000 ||
      !lineResult.success ||
      !streamResult.success ||
      streamResult.data.labels_service !== "peg-monitoring"
    )
      throw new InvalidPegAlertsUpstreamError();
    const kind = transitionKind(lineResult.data);
    if (kind === null) continue;
    const transition: PegStateTransition = {
      at: atMs / 1_000,
      kind,
      identity: lineResult.data.fingerprint,
      line: lineResult.data,
    };
    deduped.set(
      `${transition.identity}:${transition.at}:${transition.kind}`,
      transition,
    );
  }
  return [...deduped.values()];
}

function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86_400) return `${Math.max(1, Math.round(seconds / 3_600))} hr`;
  const days = Math.max(1, Math.round(seconds / 86_400));
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function policySlot(line: StateLine): "active" | "previous" | "approved" {
  const match = line.ruleTitle.match(/ · (active|previous)]$/);
  return match?.[1] === "previous"
    ? "previous"
    : match?.[1] === "active"
      ? "active"
      : "approved";
}

type PhrasedEvent = PegAlertEvent & {
  duplicateKey: string;
  policySlot: ReturnType<typeof policySlot>;
};

type EvaluationState = NonNullable<
  PegAlertEvent["evidence"]["evaluationState"]
>;

function evaluationStateFor(
  kind: PegStateTransition["kind"],
): EvaluationState | undefined {
  if (kind === "error") return "failed";
  if (kind === "error-recovered") return "recovered";
  if (kind === "error-recovered-alerting") return "recovered-alerting";
  return undefined;
}

function evaluationCause(
  evidence: StateLine,
  evaluationState: EvaluationState | undefined,
  cleared: boolean,
): { includesAsset: boolean; lead: string } {
  if (evaluationState === undefined)
    return pegAlertCauseCopy(evidence, cleared);
  const sourceName = pegAlertSourceName(evidence.labels.source);
  if (evaluationState === "failed") {
    return {
      includesAsset: false,
      lead: `Grafana could not evaluate the ${sourceName} Peg rule`,
    };
  }
  return {
    includesAsset: false,
    lead:
      evaluationState === "recovered"
        ? `Grafana can evaluate the ${sourceName} Peg rule again`
        : `Grafana can evaluate the ${sourceName} Peg rule again; its alert condition is active`,
  };
}

function transitionSeverity(
  evidence: StateLine,
  cleared: boolean,
  evaluationState: EvaluationState | undefined,
): PegAlertEvent["severity"] {
  if (cleared || evaluationState === "recovered") return "cleared";
  return evidence.labels.route === "page" ||
    evidence.labels.severity === "critical"
    ? "page"
    : "warning";
}

function phraseTransition(
  transition: PegStateTransition,
  raised?: PegStateTransition,
): PhrasedEvent {
  const evidence = raised?.line ?? transition.line;
  const cleared = transition.kind === "cleared";
  const evaluationState = evaluationStateFor(transition.kind);
  const cause = evaluationCause(evidence, evaluationState, cleared);
  const recovered =
    evaluationState === "recovered" || evaluationState === "recovered-alerting";
  const detail = [
    cause.includesAsset ? null : pegAlertAssetName(evidence.labels.asset),
    (cleared || recovered) && raised !== undefined
      ? `lasted ${durationLabel(Math.max(0, transition.at - raised.at))}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return {
    id: `state:${transition.identity}:${transition.kind}:${transition.at}`,
    at: transition.at,
    severity: transitionSeverity(evidence, cleared, evaluationState),
    lead: cause.lead,
    detail: detail === "" ? "" : `${detail}.`,
    evidence: {
      rule: pegAlertRuleKind(evidence),
      assetId: evidence.labels.asset,
      assetName: pegAlertAssetName(evidence.labels.asset),
      sourceId: evidence.labels.source,
      sourceName: pegAlertSourceName(evidence.labels.source),
      quoteCurrency: pegAlertSourceCurrency(evidence.labels.source),
      policyVersion: evidence.labels.policy_version,
      failureReason:
        evaluationState === undefined
          ? normalizedFailureReason(evidence.values.Reason)
          : null,
      ...(evaluationState === undefined ? {} : { evaluationState }),
    },
    duplicateKey: [
      pegAlertRuleKind(evidence),
      evidence.labels.asset,
      evidence.labels.source,
      transition.kind,
    ].join(":"),
    policySlot: policySlot(evidence),
  };
}

function normalizedFailureReason(reason: number | undefined): number | null {
  return reason !== undefined &&
    Number.isInteger(reason) &&
    reason >= 1 &&
    reason <= 20
    ? reason
    : null;
}

function pairStateTransitions(
  transitions: readonly PegStateTransition[],
): PhrasedEvent[] {
  const isOpening = (transition: PegStateTransition): boolean =>
    transition.kind === "raised" || transition.kind === "error";
  const cycleKey = (transition: PegStateTransition): string =>
    `${transition.identity}:${transition.kind.startsWith("error") ? "error" : "alert"}`;
  const ordered = [...transitions].sort(
    (left, right) =>
      left.at - right.at ||
      (isOpening(left) === isOpening(right) ? 0 : isOpening(left) ? -1 : 1) ||
      left.identity.localeCompare(right.identity),
  );
  const open = new Map<string, PegStateTransition>();
  const observedRaised = new Set<string>();
  const unpairedCleared = new Map<string, PegStateTransition>();
  const events: PhrasedEvent[] = [];
  for (const transition of ordered) {
    const key = cycleKey(transition);
    if (isOpening(transition)) {
      const boundaryResolution = unpairedCleared.get(key);
      if (boundaryResolution !== undefined) {
        events.push(phraseTransition(boundaryResolution));
        unpairedCleared.delete(key);
      }
      observedRaised.add(key);
      if (!open.has(key)) open.set(key, transition);
      continue;
    }
    const raised = open.get(key);
    if (raised === undefined) {
      if (!observedRaised.has(key)) unpairedCleared.set(key, transition);
      continue;
    }
    if (transition.at < raised.at) continue;
    events.push(phraseTransition(raised, raised));
    events.push(phraseTransition(transition, raised));
    open.delete(key);
  }
  for (const cleared of unpairedCleared.values())
    events.push(phraseTransition(cleared));
  for (const raised of open.values()) events.push(phraseTransition(raised));
  return events;
}

function preferPolicyEvent(
  left: PhrasedEvent,
  right: PhrasedEvent,
): PhrasedEvent {
  const rank = { active: 2, approved: 1, previous: 0 } as const;
  return rank[right.policySlot] > rank[left.policySlot] ? right : left;
}

function complementaryPolicySlots(
  left: PhrasedEvent,
  right: PhrasedEvent,
): boolean {
  return (
    (left.policySlot === "active" && right.policySlot === "previous") ||
    (left.policySlot === "previous" && right.policySlot === "active")
  );
}

function coalescePolicyDuplicates(events: PhrasedEvent[]): PegAlertEvent[] {
  const coalesced: PhrasedEvent[] = [];
  const unmatchedIndexByKey = new Map<string, number>();
  for (const event of [...events].sort((left, right) => right.at - left.at)) {
    const duplicateIndex = unmatchedIndexByKey.get(event.duplicateKey);
    const candidate =
      duplicateIndex === undefined ? undefined : coalesced[duplicateIndex];
    if (
      duplicateIndex === undefined ||
      candidate === undefined ||
      !complementaryPolicySlots(candidate, event) ||
      Math.abs(candidate.at - event.at) > POLICY_DUPLICATE_WINDOW_SECONDS
    ) {
      coalesced.push(event);
      unmatchedIndexByKey.set(event.duplicateKey, coalesced.length - 1);
      continue;
    }
    coalesced[duplicateIndex] = preferPolicyEvent(candidate, event);
    unmatchedIndexByKey.delete(event.duplicateKey);
  }
  return coalesced.map((event) => ({
    id: event.id,
    at: event.at,
    severity: event.severity,
    lead: event.lead,
    detail: event.detail,
    evidence: event.evidence,
  }));
}

export function combinePegAlertEvents(
  stateTransitions: readonly PegStateTransition[],
  maximumEvents: number,
): PegAlertEvent[] {
  return coalescePolicyDuplicates(pairStateTransitions(stateTransitions))
    .sort(
      (left, right) => right.at - left.at || left.id.localeCompare(right.id),
    )
    .slice(0, maximumEvents);
}
