#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createGateFixture } from "./agent-quality-gate-scheduler-fixture.mjs";

const execFileAsync = promisify(execFile);
const fullChangedPath = "pnpm-workspace.yaml";
const shortChangedPaths = [
  "metrics-bridge/src/fixture.ts",
  "integration-probes/src/fixture.ts",
];

const stubMappedTool = `#!/usr/bin/env bash
set -u

event_log="\${QG_FIXTURE_EVENT_LOG:?}"
label="\${QG_FIXTURE_LABEL:?}"
delay_ms="\${QG_FIXTURE_DEFAULT_DELAY_MS:?}"
tool="\${0##*/}"
command="$tool"
if [[ "$#" -gt 0 ]]; then
  command="$command $*"
fi
if [[ -z "\${AGENTQG_RUN:-}" ]]; then
  if [[ "$command" == "pnpm --version" ]]; then
    echo "9.0.0"
  fi
  exit 0
fi
if [[ "$command" == "pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw" &&
  "\${VERCEL_DEPLOYMENT_ID:-}" == "local-quality-gate" ]]; then
  command="VERCEL_DEPLOYMENT_ID=local-quality-gate $command"
fi

record_event() {
  node -e '
    const fs = require("node:fs");
    const [file, event, label, shellPid, command, cwd] = process.argv.slice(1);
    fs.appendFileSync(file, JSON.stringify({
      event,
      label,
      timestampMs: Date.now(),
      shellPid: Number(shellPid),
      command,
      cwd,
    }) + "\\n");
  ' "$event_log" "$1" "$label" "$$" "$command" "$PWD"
}

record_event start
node -e 'setTimeout(() => {}, Number(process.argv[1]))' "$delay_ms"
rc=$?
record_event end
exit "$rc"
`;

const stubMappedNode = `import { appendFileSync } from "node:fs";

const eventLog = process.env.QG_FIXTURE_EVENT_LOG;
const label = process.env.QG_FIXTURE_LABEL;
const delayMs = Number(process.env.QG_FIXTURE_DEFAULT_DELAY_MS);
const command = "node scripts/pr/check-adr-reminder.mjs";
function record(event) {
  appendFileSync(eventLog, JSON.stringify({
    event,
    label,
    timestampMs: Date.now(),
    shellPid: process.pid,
    command,
    cwd: process.cwd(),
  }) + "\\n");
}
record("start");
await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
record("end");
`;

const allCapacityCommands = new Set([
  "pnpm --filter @mento-protocol/ui-dashboard test:coverage",
  "VERCEL_DEPLOYMENT_ID=local-quality-gate pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw",
]);

async function run(command, args, cwd) {
  return execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function prepareBenchmarkRepository(fixture) {
  const toolDirectory = join(fixture.repository, "fixture-bin");
  for (const directory of [
    toolDirectory,
    join(fixture.repository, "aegis"),
    join(fixture.repository, "metrics-bridge/src"),
    join(fixture.repository, "integration-probes/src"),
    join(fixture.repository, "scripts/pr"),
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await Promise.all([
    writeFile(
      join(fixture.repository, fullChangedPath),
      "packages:\n  - metrics-bridge\n  - integration-probes\n",
    ),
    writeFile(
      join(fixture.repository, shortChangedPaths[0]),
      "export const fixture = true;\n",
    ),
    writeFile(
      join(fixture.repository, shortChangedPaths[1]),
      "export const fixture = true;\n",
    ),
    writeFile(join(toolDirectory, "pnpm"), stubMappedTool),
    writeFile(join(toolDirectory, "forge"), stubMappedTool),
    writeFile(join(fixture.repository, "aegis/.keep"), "fixture\n"),
    writeFile(
      join(fixture.repository, "scripts/pr/check-adr-reminder.mjs"),
      stubMappedNode,
    ),
  ]);
  await Promise.all([
    chmod(join(toolDirectory, "pnpm"), 0o755),
    chmod(join(toolDirectory, "forge"), 0o755),
  ]);
  await run("git", ["add", "."], fixture.repository);
  await run(
    "git",
    ["commit", "-q", "-m", "add scheduler benchmark plan"],
    fixture.repository,
  );
}

function commandForEvent(event) {
  if (event.command) return event.command;
  return `./tools/trunk ${event.argv}`;
}

function commandIntervals(events) {
  const open = new Map();
  const intervals = [];
  for (const event of [...events].sort(
    (left, right) => left.timestampMs - right.timestampMs,
  )) {
    const key = `${event.label}:${event.shellPid}`;
    if (event.event === "start") open.set(key, event);
    if (event.event !== "end" || !open.has(key)) continue;
    const start = open.get(key);
    intervals.push({
      label: event.label,
      command: commandForEvent(start),
      startMs: start.timestampMs,
      endMs: event.timestampMs,
    });
    open.delete(key);
  }
  assert.equal(open.size, 0, "every benchmark tool start must have an end");
  return intervals;
}

function maxConcurrency(intervals) {
  const transitions = intervals
    .flatMap((interval) => [
      { timestampMs: interval.startMs, delta: 1 },
      { timestampMs: interval.endMs, delta: -1 },
    ])
    .sort(
      (left, right) =>
        left.timestampMs - right.timestampMs || left.delta - right.delta,
    );
  let active = 0;
  let maximum = 0;
  for (const transition of transitions) {
    active += transition.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function overlaps(left, right) {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

function gateSummary(intervals, label, originMs) {
  const selected = intervals.filter((interval) => interval.label === label);
  assert.ok(selected.length > 0, `${label} must execute mapped tools`);
  const commands = selected.map((interval) => interval.command);
  return {
    commandCount: commands.length,
    commands,
    allCapacityCommands: commands.filter((command) =>
      allCapacityCommands.has(command),
    ),
    intervalMsFromFullStart: {
      start:
        Math.min(...selected.map((interval) => interval.startMs)) - originMs,
      end: Math.max(...selected.map((interval) => interval.endMs)) - originMs,
    },
  };
}

function normalizePlan(mode, plan) {
  return Object.fromEntries(
    Object.entries(plan).map(([key, value]) => [
      key.replace(`${mode}-`, ""),
      value,
    ]),
  );
}

function assertProductionPlan(plan) {
  assert.ok(
    plan.full.commandCount >= 25,
    "the full gate must be multi-command",
  );
  assert.ok(
    plan["short-a"].commandCount >= 5,
    "the metrics-bridge package gate must be multi-command",
  );
  assert.ok(
    plan["short-b"].commandCount >= 5,
    "the integration-probes package gate must be multi-command",
  );
  assert.ok(
    plan.full.commandCount > plan["short-a"].commandCount,
    "the workspace gate must be larger than the metrics-bridge gate",
  );
  assert.ok(
    plan.full.commandCount > plan["short-b"].commandCount,
    "the workspace gate must be larger than the integration-probes gate",
  );
  assert.deepEqual(plan.full.allCapacityCommands, [
    "pnpm --filter @mento-protocol/ui-dashboard test:coverage",
    "VERCEL_DEPLOYMENT_ID=local-quality-gate pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  ]);
  assert.ok(
    plan["short-a"].commands.includes(
      "pnpm exec turbo run lint --filter=@mento-protocol/metrics-bridge --cache=local:rw",
    ),
  );
  assert.ok(
    plan["short-b"].commands.includes(
      "pnpm exec turbo run lint --filter=@mento-protocol/integration-probes --cache=local:rw",
    ),
  );
}

function comparablePlan(plan) {
  return Object.fromEntries(
    Object.entries(plan).map(([name, value]) => [
      name,
      {
        commandCount: value.commandCount,
        commands: value.commands,
        allCapacityCommands: value.allCapacityCommands,
      },
    ]),
  );
}

async function runThreeGateScenario(
  fixture,
  { name, coordinator, fullCommandDelayMs, shortCommandDelayMs },
) {
  const scenario = fixture.scenarioPaths(name);
  // The legacy baseline must finish all three serialized gates. Its wait budget
  // must exceed their measured total time so this benchmark measures scheduling
  // instead of the public lock-timeout behavior.
  const lockWaitSeconds = 90;
  const [fullWorktree, shortAWorktree, shortBWorktree] = await Promise.all([
    fixture.addWorktree(`${name}-full`),
    fixture.addWorktree(`${name}-short-a`),
    fixture.addWorktree(`${name}-short-b`),
  ]);
  const full = await fixture.startGate({
    worktree: fullWorktree,
    changedPath: fullChangedPath,
    scenario,
    label: `${name}-full`,
    coordinator,
    defaultDelayMs: fullCommandDelayMs,
    lockWaitSeconds,
    allowPackageScriptChanges: true,
    extraEnvironment: {
      PATH: `${join(fullWorktree, "fixture-bin")}:${process.env.PATH}`,
    },
  });
  const fullStart = await fixture.waitForEvent(
    scenario,
    (event) => event.event === "start" && event.label === `${name}-full`,
    `${name} full gate to start its first mapped tool`,
  );
  const shortLaunchMs = Date.now();
  const [shortA, shortB] = await Promise.all(
    [shortAWorktree, shortBWorktree].map((worktree, index) =>
      fixture.startGate({
        worktree,
        changedPath: shortChangedPaths[index],
        scenario,
        label: `${name}-short-${index === 0 ? "a" : "b"}`,
        coordinator,
        defaultDelayMs: shortCommandDelayMs,
        lockWaitSeconds,
        extraEnvironment: {
          PATH: `${join(worktree, "fixture-bin")}:${process.env.PATH}`,
        },
      }),
    ),
  );
  const results = await Promise.all([full.done, shortA.done, shortB.done]);
  const failures = results.filter((result) => result.code !== 0);
  if (failures.length) {
    throw new Error(
      failures
        .map(
          (failure) =>
            `${failure.label} exited ${failure.code}:\n${failure.stdout}\n${failure.stderr}`,
        )
        .join("\n"),
    );
  }

  const intervals = commandIntervals(await fixture.events(scenario));
  const labels = [`${name}-full`, `${name}-short-a`, `${name}-short-b`];
  const plans = Object.fromEntries(
    labels.map((label) => [
      label,
      gateSummary(intervals, label, fullStart.timestampMs),
    ]),
  );
  const resultByLabel = Object.fromEntries(
    results.map((result) => [result.label, result]),
  );
  const fullBarriers = intervals.filter(
    (interval) =>
      interval.label === `${name}-full` &&
      allCapacityCommands.has(interval.command),
  );
  const barrierOverlapCount = fullBarriers.filter((barrier) =>
    intervals.some(
      (interval) => interval !== barrier && overlaps(barrier, interval),
    ),
  ).length;

  return {
    mode: coordinator ? "coordinator" : "legacy",
    elapsedMs:
      Math.max(...results.map((result) => result.finishedAtMs)) -
      fullStart.timestampMs,
    maxConcurrency: maxConcurrency(intervals),
    barrierOverlapCount,
    queueDelayMs: Object.fromEntries(
      labels.map((label) => [
        label.replace(`${name}-`, ""),
        Math.min(
          ...intervals
            .filter((interval) => interval.label === label)
            .map((interval) => interval.startMs),
        ) - resultByLabel[label].startedAtMs,
      ]),
    ),
    shortCompletionMs: {
      a: resultByLabel[`${name}-short-a`].finishedAtMs - shortLaunchMs,
      b: resultByLabel[`${name}-short-b`].finishedAtMs - shortLaunchMs,
    },
    plans: normalizePlan(name, plans),
  };
}

const fullCommandDelayMs = 250;
// Keep both short commands live through normal process-start skew so the
// capacity-three assertion measures the scheduler instead of launch timing.
const shortCommandDelayMs = 1_000;
const fixture = await createGateFixture();

try {
  await prepareBenchmarkRepository(fixture);
  const legacy = await runThreeGateScenario(fixture, {
    name: "legacy",
    coordinator: false,
    fullCommandDelayMs,
    shortCommandDelayMs,
  });
  const coordinator = await runThreeGateScenario(fixture, {
    name: "coordinator",
    coordinator: true,
    fullCommandDelayMs,
    shortCommandDelayMs,
  });

  assertProductionPlan(legacy.plans);
  assertProductionPlan(coordinator.plans);
  assert.deepEqual(
    comparablePlan(coordinator.plans),
    comparablePlan(legacy.plans),
  );
  assert.equal(legacy.maxConcurrency, 1, "legacy gates must serialize");
  assert.equal(
    coordinator.maxConcurrency,
    3,
    "the scheduler must use all three safe slots",
  );
  assert.equal(
    coordinator.barrierOverlapCount,
    0,
    "all-capacity commands must run without another mapped tool",
  );
  assert.ok(
    legacy.plans["short-a"].intervalMsFromFullStart.start >=
      legacy.plans.full.intervalMsFromFullStart.end,
    "the first legacy package gate must wait for the full workspace gate",
  );
  assert.ok(
    legacy.plans["short-b"].intervalMsFromFullStart.start >=
      legacy.plans.full.intervalMsFromFullStart.end,
    "the second legacy package gate must wait for the full workspace gate",
  );
  assert.ok(
    coordinator.plans["short-a"].intervalMsFromFullStart.end <
      coordinator.plans.full.intervalMsFromFullStart.end,
    "the first scheduled package gate must finish before the workspace gate",
  );
  assert.ok(
    coordinator.plans["short-b"].intervalMsFromFullStart.end <
      coordinator.plans.full.intervalMsFromFullStart.end,
    "the second scheduled package gate must finish before the workspace gate",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 2,
        measuredAt: new Date().toISOString(),
        fixture: {
          capacity: 3,
          fullChangedPath,
          shortChangedPaths,
          fullCommandDelayMs,
          shortCommandDelayMs,
          tools: "real Bash gate with stubbed pnpm, forge, and Trunk",
          elapsedDefinition:
            "full gate first mapped-tool start to the last gate process exit",
          queueDelayDefinition:
            "gate process launch to its first mapped-tool start; includes gate setup",
          shortCompletionDefinition:
            "short gate launch to short gate process exit",
        },
        legacy,
        coordinator,
        difference: {
          elapsedMs: legacy.elapsedMs - coordinator.elapsedMs,
          elapsedPercent: Number(
            (
              ((legacy.elapsedMs - coordinator.elapsedMs) / legacy.elapsedMs) *
              100
            ).toFixed(1),
          ),
          shortCompletionMs: {
            a: legacy.shortCompletionMs.a - coordinator.shortCompletionMs.a,
            b: legacy.shortCompletionMs.b - coordinator.shortCompletionMs.b,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await fixture.cleanup();
}
