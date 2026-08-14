import { z } from "zod";
import type { PegAlertEvent } from "@/lib/peg-alerts";

export const PEG_ALERTS_POLICY_STEP_SECONDS = 5 * 60;
export const PEG_ALERTS_MAX_STATE_ROWS = 1_000;
const PEG_ALERTS_MAX_POLICY_FRAMES = 8;

export function policyQueryBounds(
  fromSeconds: number,
  toSeconds: number,
): { fromMs: number; toMs: number } {
  const stepMs = PEG_ALERTS_POLICY_STEP_SECONDS * 1_000;
  return {
    fromMs: Math.floor((fromSeconds * 1_000 - stepMs) / stepMs) * stepMs,
    toMs: Math.floor((toSeconds * 1_000) / stepMs) * stepMs,
  };
}

const label = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const stateFieldSchema = z
  .object({ name: z.string().min(1).max(32), type: z.string().min(1).max(32) })
  .passthrough();
const stateLineSchema = z
  .object({
    schemaVersion: z.literal(1),
    previous: z.string().min(1).max(64),
    current: z.string().min(1).max(64),
    fingerprint: z.string().min(1).max(64),
    ruleTitle: z.string().min(1).max(256),
    ruleUID: z.string().min(1).max(64),
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

const policyFieldSchema = z
  .object({
    name: z.string().min(1).max(64),
    type: z.string().min(1).max(32),
    labels: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
const policyFrameSchema = z
  .object({
    schema: z
      .object({ fields: z.array(policyFieldSchema).min(2).max(8) })
      .passthrough(),
    data: z
      .object({ values: z.array(z.array(z.unknown())).min(2).max(8) })
      .passthrough(),
  })
  .passthrough();
const policyResponseSchema = z
  .object({
    results: z.record(
      z.string(),
      z
        .object({
          frames: z.array(policyFrameSchema).max(PEG_ALERTS_MAX_POLICY_FRAMES),
          error: z.string().optional(),
          status: z.number().int().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

type StateFrame = z.infer<typeof stateFrameSchema>;
type StateLine = z.infer<typeof stateLineSchema>;
type PolicyFrame = z.infer<typeof policyFrameSchema>;

class InvalidPegAlertsUpstreamError extends Error {}

type PegStateTransition = {
  at: number;
  kind: "raised" | "cleared";
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
  if (baseState(line.current) === "Alerting") return "raised";
  if (
    baseState(line.previous) === "Alerting" &&
    baseState(line.current) === "Normal"
  )
    return "cleared";
  return null;
}

export function parseStateTransitions(
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

function policyFrameFirstSample(
  frame: PolicyFrame,
  queryFromMs: number,
  toMs: number,
): { policyVersion: string; atMs: number } | null {
  const { timeIndex, numberIndex, policyVersion } = policyFrameIdentity(frame);
  const times = frame.data.values[timeIndex]!;
  const values = frame.data.values[numberIndex]!;
  if (times.length !== values.length || times.length > 2_020)
    throw new InvalidPegAlertsUpstreamError();
  let earliest: number | null = null;
  for (let index = 0; index < times.length; index += 1) {
    const atMs = positivePolicySample(
      times[index],
      values[index],
      queryFromMs,
      toMs,
    );
    if (atMs !== null)
      earliest = earliest === null ? atMs : Math.min(earliest, atMs);
  }
  return earliest === null ? null : { policyVersion, atMs: earliest };
}

function policyFrameIdentity(frame: PolicyFrame): {
  timeIndex: number;
  numberIndex: number;
  policyVersion: string;
} {
  if (frame.schema.fields.length !== frame.data.values.length)
    throw new InvalidPegAlertsUpstreamError();
  const timeIndexes = frame.schema.fields.flatMap((field, index) =>
    field.type === "time" ? [index] : [],
  );
  const numberIndexes = frame.schema.fields.flatMap((field, index) =>
    field.type === "number" ? [index] : [],
  );
  if (timeIndexes.length !== 1 || numberIndexes.length !== 1)
    throw new InvalidPegAlertsUpstreamError();
  const timeIndex = timeIndexes[0]!;
  const numberIndex = numberIndexes[0]!;
  const labels = frame.schema.fields[numberIndex]?.labels;
  const policyResult = label.safeParse(labels?.policy_version);
  if (
    !policyResult.success ||
    (labels?.__name__ !== undefined &&
      labels.__name__ !== "mento_peg_policy_version")
  )
    throw new InvalidPegAlertsUpstreamError();
  return { timeIndex, numberIndex, policyVersion: policyResult.data };
}

function positivePolicySample(
  atMs: unknown,
  value: unknown,
  queryFromMs: number,
  toMs: number,
): number | null {
  if (
    typeof atMs !== "number" ||
    !Number.isSafeInteger(atMs) ||
    atMs < queryFromMs ||
    atMs > toMs ||
    (value !== null && (typeof value !== "number" || !Number.isFinite(value)))
  )
    throw new InvalidPegAlertsUpstreamError();
  return typeof value === "number" && value > 0 ? atMs : null;
}

export function parsePolicyActivations(
  raw: unknown,
  fromSeconds: number,
  toSeconds: number,
): PegAlertEvent[] {
  const parsed = policyResponseSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidPegAlertsUpstreamError();
  const result = parsed.data.results.P;
  if (
    result === undefined ||
    (result.error !== undefined && result.error.trim() !== "") ||
    (result.status !== undefined &&
      (result.status < 200 || result.status >= 300))
  )
    throw new InvalidPegAlertsUpstreamError();
  const fromMs = fromSeconds * 1_000;
  const toMs = toSeconds * 1_000;
  const bounds = policyQueryBounds(fromSeconds, toSeconds);
  const firstByPolicy = new Map<string, number>();
  for (const frame of result.frames) {
    const first = policyFrameFirstSample(frame, bounds.fromMs, bounds.toMs);
    if (first === null) continue;
    const existing = firstByPolicy.get(first.policyVersion);
    firstByPolicy.set(
      first.policyVersion,
      existing === undefined ? first.atMs : Math.min(existing, first.atMs),
    );
  }

  return [...firstByPolicy.entries()].flatMap(([policyVersion, atMs]) => {
    // Scrapes expose a new policy as a new label series, not an explicit
    // activation event. The first positive sample is therefore only an
    // approximation. A sample in the extra pre-window step proves the series
    // already existed and prevents a false activation at the seven-day edge.
    if (atMs <= fromMs || atMs > toMs) return [];
    return [
      {
        id: `policy:${policyVersion}:${atMs / 1_000}`,
        at: atMs / 1_000,
        severity: "policy" as const,
        lead: `Policy ${policyVersion} activated`,
        detail: "First observed in Mimir; activation time is approximate.",
      },
    ];
  });
}

const alertSubject: Record<string, string> = {
  "Blind Warning": "blindness warning",
  "Blind While Stressed Critical": "blindness critical page",
  "Critical Path Unreachable": "critical-path warning",
  "Deep-Venue Downside Critical": "downside critical page",
  "Deep-Venue Spread Warning": "spread warning",
  "Downside Warning": "downside warning",
  "Heartbeat Missing": "heartbeat warning",
  "Indexed Pool Unreachable": "indexed-pool warning",
  "Policy Rollover Stuck": "policy-rollover warning",
  "Premium Warning": "premium warning",
  "Registry Rot": "registry warning",
  "Source Permanently Dead": "source warning",
  "Source Unhealthy": "source warning",
  "Structural Saturation Warning": "structural warning",
};

function assetName(asset: string): string {
  return (asset.split("-", 1)[0] ?? asset).toUpperCase();
}

function sourceName(source: string): string | null {
  if (source === "") return null;
  const [provider, ...rest] = source.split("_");
  if (provider === undefined) return source;
  const providerName = `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)}`;
  return [providerName, ...rest.map((part) => part.toUpperCase())].join(" ");
}

function policySlot(ruleTitle: string): "active" | "previous" | "approved" {
  const match = ruleTitle.match(/ · (active|previous)]$/);
  return match?.[1] === "previous"
    ? "previous"
    : match?.[1] === "active"
      ? "active"
      : "approved";
}

function subject(line: StateLine): string {
  const title = line.ruleTitle.match(/^Peg (.+?)(?: \[|$)/)?.[1];
  if (title === undefined) return "alert";
  const mapped = alertSubject[title];
  if (mapped !== undefined) return mapped;
  const fallback = title.toLowerCase();
  return line.labels.route === "page" && !fallback.includes("page")
    ? `${fallback} page`
    : fallback;
}

function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86_400) return `${Math.max(1, Math.round(seconds / 3_600))} hr`;
  const days = Math.max(1, Math.round(seconds / 86_400));
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function phraseTransition(
  transition: PegStateTransition,
  raisedAt?: number,
): PegAlertEvent {
  const line = transition.line;
  const asset = assetName(line.labels.asset);
  const context = [
    sourceName(line.labels.source),
    `${policySlot(line.ruleTitle)} policy`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const cleared = transition.kind === "cleared";
  return {
    id: `state:${transition.identity}:${transition.kind}:${transition.at}`,
    at: transition.at,
    severity: cleared
      ? "cleared"
      : line.labels.route === "page" || line.labels.severity === "critical"
        ? "page"
        : "warning",
    lead: `${asset} ${subject(line)} ${cleared ? "cleared" : "raised"}`,
    detail:
      cleared && raisedAt !== undefined
        ? `${context} returned to normal after ${durationLabel(Math.max(0, transition.at - raisedAt))}.`
        : `${context} entered alerting.`,
  };
}

function pairStateTransitions(
  transitions: readonly PegStateTransition[],
): PegAlertEvent[] {
  const ordered = [...transitions].sort(
    (left, right) =>
      left.at - right.at ||
      (left.kind === right.kind ? 0 : left.kind === "raised" ? -1 : 1) ||
      left.identity.localeCompare(right.identity),
  );
  const open = new Map<string, PegStateTransition>();
  const events: PegAlertEvent[] = [];
  for (const transition of ordered) {
    if (transition.kind === "raised") {
      if (!open.has(transition.identity))
        open.set(transition.identity, transition);
      continue;
    }
    const raised = open.get(transition.identity);
    if (raised === undefined || transition.at < raised.at) continue;
    events.push(phraseTransition(raised));
    events.push(phraseTransition(transition, raised.at));
    open.delete(transition.identity);
  }
  for (const raised of open.values()) events.push(phraseTransition(raised));
  return events;
}

export function combinePegAlertEvents(
  stateTransitions: readonly PegStateTransition[],
  policyEvents: readonly PegAlertEvent[],
  maximumEvents: number,
): PegAlertEvent[] {
  return [...pairStateTransitions(stateTransitions), ...policyEvents]
    .sort(
      (left, right) => right.at - left.at || left.id.localeCompare(right.id),
    )
    .slice(0, maximumEvents);
}
