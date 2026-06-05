import assert from "node:assert/strict";
import {
  extractTurboPrewarmCommands,
  hasPackageScriptRisk,
  parseParallelism,
  runCommandsParallel,
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
- pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw (ui-dashboard bundle inputs changed)

Dry run only. Re-run with --run to execute the mapped commands.
`;

assert.deepEqual(extractTurboPrewarmCommands(gateOutput), [
  "pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --filter=@mento-protocol/metrics-bridge --cache=local:rw",
  "pnpm exec turbo run test --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  "REACT_DOCTOR_BASE_REF=origin/main REACT_DOCTOR_BASE_CACHE_KEY=abc123 pnpm exec turbo run react-doctor:diff --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  "pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw",
]);

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
- scripts/pr-ready-state.mjs

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

console.log("agent prewarm tests passed");
