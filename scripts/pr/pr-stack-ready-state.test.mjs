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
import { evaluateStackGate } from "./pr-stack-ready-state.mjs";

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
  const pr = { ...layers[number - 1] };
  delete pr.baseRefOid;
  return {
    ready: true,
    feedbackReady: true,
    pr,
    stack: structuredClone(stack),
  };
};
const feedback = (value) => ({ ready: value.feedbackReady });
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
    ["1", false],
    ["2", true],
    ["2", false],
    ["2", false],
  ],
);
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
    `import {readFileSync} from 'node:fs'; let calls=0; export function withGhAbortSignal(_signal,callback) { return callback(); } export async function fetchReadyState(args) { calls++; const value=JSON.parse(readFileSync('input.json')); value.pr={...value.stack.layers.find(layer=>String(layer.number)===args.prArg)}; delete value.pr.baseRefOid; if(process.env.SCENARIO==='blocked' && args.prArg==='1') value.feedbackReady=false; if(process.env.SCENARIO==='moved' && calls===5) value.stack.layers[0].headRefOid='b'.repeat(40); return value; }`,
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
