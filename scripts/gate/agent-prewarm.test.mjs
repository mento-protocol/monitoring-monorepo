import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  extractTurboCacheDir,
  extractTurboPrewarmCommands,
  hasPackageScriptRisk,
  parseParallelism,
  runCommandsParallel,
  splitPrewarmCommands,
} from "./agent-prewarm.mjs";

const gateOutput = `Agent quality gate

Mapped safe local commands:
- ./tools/trunk check ui-dashboard/src/app/page.tsx (changed existing paths should pass targeted Trunk checks)
- pnpm indexer:codegen (indexer-envio changed)
- pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --filter=@mento-protocol/metrics-bridge --cache=local:rw (ui-dashboard changed; metrics-bridge changed)
- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform validate -no-color (Terraform changed)
- pnpm dashboard:mutation (dashboard mutation baseline changed)
- pnpm exec turbo run test --filter=@mento-protocol/ui-dashboard --cache=local:rw (ui-dashboard changed)
- pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --filter=@mento-protocol/metrics-bridge --cache=local:rw (duplicate)
- REACT_DOCTOR_BASE_REF=origin/main REACT_DOCTOR_BASE_CACHE_KEY=abc123 pnpm exec turbo run react-doctor:diff --filter=@mento-protocol/ui-dashboard --cache=local:rw (ui-dashboard client code should keep React Doctor clean)
- pnpm exec turbo run test:browser --filter=@mento-protocol/ui-dashboard --cache=local:rw (ui-dashboard changed)
- VERCEL_DEPLOYMENT_ID=local-quality-gate pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw (ui-dashboard bundle inputs changed)

Dry run only. Re-run with --run to execute the mapped commands.
`;

const extractedTurboCommands = extractTurboPrewarmCommands(gateOutput);

assert.deepEqual(extractedTurboCommands, [
  "pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --filter=@mento-protocol/metrics-bridge --cache=local:rw",
  "pnpm exec turbo run test --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  "REACT_DOCTOR_BASE_REF=origin/main REACT_DOCTOR_BASE_CACHE_KEY=abc123 pnpm exec turbo run react-doctor:diff --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  "pnpm exec turbo run test:browser --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  "VERCEL_DEPLOYMENT_ID=local-quality-gate pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw",
]);

assert.deepEqual(splitPrewarmCommands(extractedTurboCommands), {
  serialCommands: [
    "pnpm exec turbo run test:browser --filter=@mento-protocol/ui-dashboard --cache=local:rw",
    "VERCEL_DEPLOYMENT_ID=local-quality-gate pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  ],
  parallelCommands: [
    "pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --filter=@mento-protocol/metrics-bridge --cache=local:rw",
    "pnpm exec turbo run test --filter=@mento-protocol/ui-dashboard --cache=local:rw",
    "REACT_DOCTOR_BASE_REF=origin/main REACT_DOCTOR_BASE_CACHE_KEY=abc123 pnpm exec turbo run react-doctor:diff --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  ],
});

assert.deepEqual(
  extractTurboPrewarmCommands(`Agent quality gate

Mapped safe local commands:
- ./tools/trunk check docs/deployment.md (changed existing paths should pass targeted Trunk checks)

Dry run only.
`),
  [],
);

assert.equal(
  hasPackageScriptRisk(`Agent quality gate

Changed paths:
- package.json
- ui-dashboard/src/app/page.tsx

Mapped safe local commands:
- pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --cache=local:rw (ui-dashboard changed)
`),
  true,
);

assert.equal(
  hasPackageScriptRisk(`Agent quality gate

Changed paths:
- docs/notes/pr-ready-state.md
- scripts/pr/pr-ready-state.mjs

Mapped safe local commands:
- pnpm pr:ready-state:test (PR ready-state helper changed)
`),
  false,
);

assert.equal(parseParallelism("1"), 1);
assert.equal(parseParallelism("4"), 4);
assert.throws(() => parseParallelism("0"), /positive integer/);
assert.throws(() => parseParallelism("auto"), /positive integer/);

const parallelResults = await runCommandsParallel(
  [
    'node -e "setTimeout(() => process.exit(0), 50)"',
    'node -e "setTimeout(() => process.exit(0), 10)"',
  ],
  2,
);
assert.deepEqual(
  parallelResults.map((result) => result.status),
  [0, 0],
);
assert.equal(
  parallelResults[0].command,
  'node -e "setTimeout(() => process.exit(0), 50)"',
);
assert.equal(
  parallelResults[1].command,
  'node -e "setTimeout(() => process.exit(0), 10)"',
);

// Prewarm must reuse the gate's resolved shared Turbo cache (issue #1411) so it
// warms the same dir the gate later reads; parse it from the printed line.
assert.equal(
  extractTurboCacheDir(`Agent quality gate

Base: origin/main
Head: HEAD
Mode: dry-run
Turbo cache dir: /home/agent/.cache/turbo-monitoring-monorepo

Changed paths:
- ui-dashboard/src/app/page.tsx
`),
  "/home/agent/.cache/turbo-monitoring-monorepo",
);

// Absent line (caller opt-out or unwritable home) => no shared dir to apply.
assert.equal(extractTurboCacheDir(gateOutput), null);

// ── Gate stdout contract ───────────────────────────────────────────────────
// This helper reads the gate's dry-run stdout with two regexes anchored on exact
// header text. Nothing about that coupling is declared on the gate's side, so a
// reworded header would leave prewarm silently warming nothing. Pull both
// literals out of the gate source, rebuild the stdout shape from them, and parse
// that — a rename on either side fails here instead of going quiet.
const gateSource = readFileSync(
  new URL("../agent-quality-gate.sh", import.meta.url),
  "utf8",
);

const mappedCommandsHeader = gateSource.match(
  /^echo "(Mapped safe local commands:)"$/m,
)?.[1];
assert.ok(
  mappedCommandsHeader,
  'scripts/agent-quality-gate.sh no longer emits `echo "Mapped safe local commands:"`; extractTurboPrewarmCommands matches that line exactly',
);

const turboCacheDirPrefix = gateSource.match(
  /^\s*echo "(Turbo cache dir: )\$\{TURBO_CACHE_DIR\}"$/m,
)?.[1];
assert.ok(
  turboCacheDirPrefix,
  'scripts/agent-quality-gate.sh no longer emits `echo "Turbo cache dir: ${TURBO_CACHE_DIR}"`; extractTurboCacheDir matches that prefix exactly',
);

const gateContractOutput = `Agent quality gate

Base: origin/main
${turboCacheDirPrefix}/home/agent/.cache/turbo-monitoring-monorepo

${mappedCommandsHeader}
- pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --cache=local:rw (ui-dashboard changed)

Dry run only. Re-run with --run to execute the mapped commands.
`;

assert.deepEqual(extractTurboPrewarmCommands(gateContractOutput), [
  "pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --cache=local:rw",
]);
assert.equal(
  extractTurboCacheDir(gateContractOutput),
  "/home/agent/.cache/turbo-monitoring-monorepo",
);

// ── The end-to-end contract, against the gate that actually runs ────────────
//
// Everything above rebuilds the stdout shape from literals in the gate source.
// That catches a renamed header and nothing else. Since D5b part 2 the command
// LINES come from the Node mapping engine rather than from bash `printf`s, so
// the shape this parser depends on — `- <command> (<reason>)`, Turbo commands
// carrying `--filter=` and `--cache=local:rw`, a blank line ending the block —
// is now produced by a different program than the one the literals live in.
//
// The failure mode is silence: a drifted format makes `extractTurboPrewarmCommands`
// return `[]`, and prewarm reports success having warmed nothing. So run the
// real gate and require a real, non-empty extraction.
const realGateOutput = execFileSync(
  "bash",
  [
    fileURLToPath(new URL("../agent-quality-gate.sh", import.meta.url)),
    "--changed-paths-file",
    "/dev/stdin",
    "--base",
    "HEAD",
  ],
  {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    input: "ui-dashboard/src/lib/utils.ts\n",
    encoding: "utf8",
    env: { ...process.env, AGENT_QUALITY_GATE_LOCK: "0" },
    maxBuffer: 64 * 1024 * 1024,
  },
);

const realCommands = extractTurboPrewarmCommands(realGateOutput);
assert.ok(
  realCommands.length > 0,
  "extractTurboPrewarmCommands found NO Turbo commands in a real gate dry run; " +
    "the stdout format drifted and agent:prewarm would warm nothing while reporting success",
);
assert.ok(
  realCommands.includes(
    "pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  ),
  `a dashboard source change must still yield the dashboard lint task; got ${JSON.stringify(realCommands)}`,
);
assert.ok(
  realCommands.every((command) => command.endsWith("--cache=local:rw")),
  "every extracted command must still carry the local cache flag prewarm relies on",
);

console.log("agent prewarm tests passed");
