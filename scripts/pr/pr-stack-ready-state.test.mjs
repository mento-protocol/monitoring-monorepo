import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  classifyStackObservation,
  evaluateStackGate,
} from "./pr-stack-ready-state.mjs";

const layers = [1, 2].map((number) => ({
  number,
  state: "OPEN",
  headRefName: `branch-${number}`,
  headRefOid: String(number).repeat(40),
  baseRefName: number === 1 ? "main" : "branch-1",
  baseRefOid: "a".repeat(40),
  isDraft: false,
}));
const stack = {
  number: 9,
  protectionBaseRef: "main",
  protectionBaseOid: "a".repeat(40),
  layers,
};
const state = (number) => {
  const pr = { ...layers[number - 1], mergeStateStatus: "CLEAN" };
  return {
    ready: true,
    feedbackReady: true,
    pr,
    stack: structuredClone(stack),
  };
};
const feedback = (value) => ({ ready: value.feedbackReady });
// Report real API state, never a requested merge or a UI loading indicator.
const observed = {
  ...state(2),
  pr: { ...state(2).pr, mergeStateStatus: "CLEAN" },
  required: { blockers: [] },
};
assert.equal(classifyStackObservation(observed).state, "AWAITING_USER_MERGE");
for (const terminal of ["MERGED", "CLOSED"])
  assert.equal(
    classifyStackObservation({
      ...observed,
      pr: { ...observed.pr, state: terminal },
    }).state,
    terminal,
  );
assert.equal(
  classifyStackObservation({
    ...observed,
    pr: { ...observed.pr, autoMergeEnabledAt: "2026-09-10T12:00:00Z" },
  }).state,
  "MERGE_REQUESTED",
);
assert.equal(
  classifyStackObservation({
    ...observed,
    pr: { ...observed.pr, state: null },
    uiSpinner: false,
  }).state,
  "UNKNOWN",
);
assert.equal(
  classifyStackObservation({
    ...observed,
    pr: { ...observed.pr, mergeStateStatus: null },
  }).state,
  "UNKNOWN",
);
assert.equal(
  classifyStackObservation({
    ...observed,
    pr: { ...observed.pr, mergeStateStatus: "UNKNOWN" },
  }).state,
  "UNKNOWN",
);
assert.equal(
  classifyStackObservation({
    ...observed,
    pr: { ...observed.pr, mergeStateStatus: "BEHIND" },
  }).state,
  "BASE_UPDATE_REQUIRED",
);
for (const key of ["headRefOid", "baseRefOid", "headRefName", "baseRefName"])
  assert.equal(
    classifyStackObservation(
      { ...observed, pr: { ...observed.pr, [key]: "changed" } },
      observed,
    ).state,
    "HEAD_OR_BASE_CHANGED",
  );
for (const [checkState, expected] of [
  ["pending", "CHECKS_PENDING"],
  ["fail", "CHECKS_FAILED"],
]) {
  const blocked = {
    ...observed,
    ready: false,
    required: { blockers: [{ kind: "check", name: "ci", state: checkState }] },
  };
  assert.equal(classifyStackObservation(blocked).state, expected);
}
const canceledWithReplacement = {
  ...observed,
  ready: false,
  required: {
    blockers: [
      { kind: "check", name: "ci", state: "fail" },
      { kind: "check", name: "ci", state: "pending" },
    ],
  },
};
assert.equal(
  classifyStackObservation(canceledWithReplacement).state,
  "CHECKS_FAILED",
);
assert.match(
  await evaluateStackGate(
    observed,
    "owner/repo",
    async () => ({
      ...canceledWithReplacement,
      pr: { ...canceledWithReplacement.pr, ...layers[0] },
    }),
    feedback,
  ),
  /^PENDING /,
);

assert.equal(
  classifyStackObservation({ ...observed, feedbackReady: false }).state,
  "FEEDBACK_BLOCKED",
);
const changedMembership = structuredClone(observed);
changedMembership.stack.layers[0].headRefOid = "c".repeat(40);
assert.equal(
  classifyStackObservation(changedMembership, observed).state,
  "SNAPSHOT_CHANGED",
);
const mergeRequested = (number) => ({
  ...state(number),
  pr: {
    ...state(number).pr,
    mergeStateStatus: "CLEAN",
    autoMergeEnabledAt: "2026-09-10T12:00:00Z",
  },
});
assert.match(
  await evaluateStackGate(
    mergeRequested(2),
    "owner/repo",
    async (args) => mergeRequested(Number(args.prArg)),
    feedback,
  ),
  /^PASS .*MERGE_REQUESTED:/,
);
assert.match(
  await evaluateStackGate(
    observed,
    "owner/repo",
    async (args) => ({ ...state(Number(args.prArg)), feedbackReady: false }),
    feedback,
  ),
  /^PENDING .*FEEDBACK_BLOCKED:/,
);
for (const missing of ["headRefOid", "baseRefOid"])
  assert.equal(
    classifyStackObservation({
      ...observed,
      pr: { ...observed.pr, [missing]: null },
    }).state,
    "UNKNOWN",
  );
assert.equal(
  classifyStackObservation({
    ...observed,
    ready: false,
    uiSpinner: false,
    pr: { ...observed.pr, autoMergeEnabledAt: "2026-09-10T12:00:00Z" },
  }).state,
  "UNKNOWN",
);
// Every other layer needs a complete observation, even when selected is clean.
for (const mergeStateStatus of [null, "UNKNOWN", undefined]) {
  let reads = 0;
  const result = await evaluateStackGate(
    state(1),
    "owner/repo",
    async (args) => {
      reads++;
      const value = state(Number(args.prArg));
      if (args.prArg === "2") value.pr.mergeStateStatus = mergeStateStatus;
      return value;
    },
    feedback,
  );
  assert.match(
    result,
    /^PENDING stack layer #2 merge observation incomplete; UNKNOWN:/,
  );
  assert.equal(reads, 4);
}
// Incomplete final observations must not pass otherwise green, stable layers.
for (const patch of [
  { mergeStateStatus: null },
  { mergeStateStatus: "UNKNOWN" },
  { mergeStateStatus: undefined },
  { state: null },
  { state: "UNKNOWN" },
  { state: undefined },
  { headRefOid: undefined },
  { baseRefOid: undefined },
]) {
  let reads = 0;
  const result = await evaluateStackGate(
    state(2),
    "owner/repo",
    async (args) => {
      const value = state(Number(args.prArg));
      if (++reads === 5) Object.assign(value.pr, patch);
      return value;
    },
    feedback,
  );
  assert.match(result, /^PENDING /, JSON.stringify(patch));
  assert.equal(reads, 5);
  if (Object.hasOwn(patch, "mergeStateStatus"))
    assert.match(result, /final merge observation incomplete; UNKNOWN:/);
}
const calls = [];
assert.match(
  await evaluateStackGate(
    state(2),
    "owner/repo",
    async (args) => {
      calls.push(args);
      return state(Number(args.prArg));
    },
    feedback,
  ),
  /^PASS /,
);
assert.deepEqual(
  calls.map((call) => [call.prArg, !!call.includeFeedbackDetails]),
  [
    ["1", true],
    ["1", true],
    ["2", true],
    ["2", true],
    ["2", true],
  ],
);
// A later readiness read can contain a new top-level finding while its ready
// flag stays true. Exercise the real feedback projection on every later read.
for (const findingRead of [null, 2, 4, 5]) {
  let count = 0;
  const result = await evaluateStackGate(
    state(2),
    "owner/repo",
    async (args) => {
      count++;
      const value = state(Number(args.prArg));
      if (count === findingRead && args.includeFeedbackDetails) {
        value.topLevelBotComments = [
          {
            id: 100,
            author: "chatgpt-codex-connector[bot]",
            commitOid: value.pr.headRefOid,
            body: "[P2] Fix the newly found feedback defect.",
          },
        ];
      }
      return value;
    },
  );
  assert.match(
    result,
    findingRead === null ? /^PASS / : /^PENDING /,
    `new finding at read ${findingRead}`,
  );
  assert.equal(count, findingRead ?? 5);
}
for (const mutation of [
  "feedback",
  "readiness",
  "head",
  "base",
  "membership",
  "error",
]) {
  let count = 0;
  const result = await evaluateStackGate(
    state(2),
    "owner/repo",
    async (args) => {
      count++;
      if (mutation === "error") throw new Error("offline");
      const value = state(Number(args.prArg));
      if (mutation === "feedback" && args.prArg === "1")
        value.feedbackReady = false;
      if (mutation === "readiness" && args.prArg === "1") value.ready = false;
      if (count === 5) {
        if (mutation === "head")
          value.stack.layers[0].headRefOid = "b".repeat(40);
        if (mutation === "base")
          value.stack.layers[0].baseRefOid = "b".repeat(40);
        if (mutation === "membership") value.stack.layers.pop();
      }
      return value;
    },
    feedback,
  );
  assert.match(result, /^PENDING /, mutation);
}

// The native stack API can omit base SHAs. PR reads must still agree.
for (const scenario of [
  "stable",
  "feedback-to-readiness",
  "initial-to-feedback",
  "final-selected",
  "missing-observed-base",
]) {
  const withoutNativeBase = (number) => {
    const value = state(number);
    for (const layer of value.stack.layers) delete layer.baseRefOid;
    return value;
  };
  let count = 0;
  const result = await evaluateStackGate(
    withoutNativeBase(2),
    "owner/repo",
    async (args) => {
      count++;
      const value = withoutNativeBase(Number(args.prArg));
      if (
        (scenario === "feedback-to-readiness" && count === 2) ||
        (scenario === "initial-to-feedback" && count === 3) ||
        (scenario === "final-selected" && count === 5)
      )
        value.pr.baseRefOid = "b".repeat(40);
      if (scenario === "missing-observed-base") delete value.pr.baseRefOid;
      return value;
    },
    feedback,
  );
  assert.match(
    result,
    scenario === "stable" ? /^PASS / : /^PENDING /,
    scenario,
  );
}

// Exercise the real hook and helper with offline probe modules and commands.
const root = mkdtempSync(join(tmpdir(), "stack-gate-"));
try {
  mkdirSync(join(root, "scripts/pr"), { recursive: true });
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ type: "module", scripts: { "pr:ready-state": "stub" } }),
  );
  writeFileSync(join(root, "input.json"), JSON.stringify(state(2)));
  writeFileSync(
    join(root, "scripts/pr/pr-stack-ready-state.mjs"),
    readFileSync(new URL("./pr-stack-ready-state.mjs", import.meta.url)),
  );
  writeFileSync(
    join(root, "scripts/pr/pr-ready-state.mjs"),
    `import {readFileSync} from 'node:fs'; let calls=0; export function withGhAbortSignal(_signal,callback) { return callback(); } export async function fetchReadyState(args) { calls++; const value=JSON.parse(readFileSync('input.json')); value.pr={...value.stack.layers.find(layer=>String(layer.number)===args.prArg),mergeStateStatus:'CLEAN'}; if(process.env.SCENARIO==='blocked' && args.prArg==='1') value.feedbackReady=false; if(process.env.SCENARIO==='moved' && calls===5) value.stack.layers[0].headRefOid='b'.repeat(40); return value; }`,
  );
  writeFileSync(
    join(root, "scripts/pr/pr-feedback-state-core.mjs"),
    "export function summarizeFeedbackState(value) { return {ready:value.feedbackReady}; }",
  );
  writeFileSync(
    join(root, "bin/gh"),
    '#!/bin/sh\nprintf "%s" "${FORK:-false}"\n',
    { mode: 0o755 },
  );
  writeFileSync(join(root, "bin/pnpm"), "#!/bin/sh\ncat input.json\n", {
    mode: 0o755,
  });
  for (const [scenario, token] of [
    ["clean", "PASS"],
    ["blocked", "PENDING"],
    ["moved", "PENDING"],
  ]) {
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; babysit_repo_gate 2 owner repo "$2"',
        "bash",
        resolve(".claude/babysit-pr.sh"),
        root,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_CODE_REMOTE: "",
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          SCENARIO: scenario,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split(" ")[0], token, scenario);
  }
  const fork = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; babysit_repo_gate 2 owner repo "$2"',
      "bash",
      resolve(".claude/babysit-pr.sh"),
      root,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        FORK: "true",
      },
    },
  );
  assert.match(fork.stdout, /^FAIL /);
  const standalone = state(2);
  delete standalone.stack;
  writeFileSync(join(root, "input.json"), JSON.stringify(standalone));
  const plain = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; babysit_repo_gate 2 owner repo "$2"',
      "bash",
      resolve(".claude/babysit-pr.sh"),
      root,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CODE_REMOTE: "",
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
      },
    },
  );
  assert.match(plain.stdout, /^PASS /);
} finally {
  rmSync(root, { recursive: true, force: true });
}
const deadlineRoot = mkdtempSync(join(tmpdir(), "stack-deadline-"));
const previousPath = process.env.PATH;
try {
  const pidPath = join(deadlineRoot, "pid");
  writeFileSync(
    join(deadlineRoot, "gh"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${deadlineRoot}:${previousPath}`;
  mock.timers.enable({ apis: ["setTimeout"] });
  const pending = evaluateStackGate(
    state(2),
    "owner/repo",
    undefined,
    undefined,
    500,
  );
  let pid;
  try {
    const startupDeadline = Date.now() + 10_000;
    while (Date.now() < startupDeadline) {
      try {
        pid = Number(readFileSync(pidPath, "utf8"));
        if (Number.isInteger(pid) && pid > 0) break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(10);
    }
    assert.ok(pid > 0, "gh stub must start before the deadline advances");
  } finally {
    mock.timers.tick(500);
    mock.timers.reset();
    assert.match(
      await pending,
      /^PENDING stack verification deadline exceeded/,
    );
  }
  // Allow the operating system to reap the child after SIGKILL.
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.throws(
    () => process.kill(pid, 0),
    { code: "ESRCH" },
    "deadline must terminate gh",
  );
} finally {
  mock.timers.reset();
  process.env.PATH = previousPath;
  rmSync(deadlineRoot, { recursive: true, force: true });
}
console.log("ok stack aggregate, deadline, and hook regression tests");
