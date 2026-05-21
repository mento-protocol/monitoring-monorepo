import assert from "node:assert/strict";
import { extractTurboPrewarmCommands } from "./agent-prewarm.mjs";

const gateOutput = `Agent quality gate

Mapped safe local commands:
- ./tools/trunk check ui-dashboard/src/app/page.tsx (changed existing paths should pass targeted Trunk checks)
- pnpm indexer:codegen (indexer-envio changed)
- pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --cache=local:rw (ui-dashboard changed)
- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform validate -no-color (Terraform changed)
- pnpm dashboard:mutation (dashboard mutation baseline changed)
- pnpm exec turbo run test --filter=@mento-protocol/ui-dashboard --cache=local:rw (ui-dashboard changed)
- pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --cache=local:rw (duplicate)
- REACT_DOCTOR_BASE_REF=origin/main REACT_DOCTOR_BASE_CACHE_KEY=abc123 pnpm exec turbo run react-doctor:diff --filter=@mento-protocol/ui-dashboard --cache=local:rw (ui-dashboard client code should keep React Doctor clean)
- pnpm exec turbo run build --filter=@mento-protocol/ui-dashboard --cache=local:rw (ui-dashboard bundle inputs changed)

Dry run only. Re-run with --run to execute the mapped commands.
`;

assert.deepEqual(extractTurboPrewarmCommands(gateOutput), [
  "pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  "pnpm exec turbo run test --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  "REACT_DOCTOR_BASE_REF=origin/main REACT_DOCTOR_BASE_CACHE_KEY=abc123 pnpm exec turbo run react-doctor:diff --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  "pnpm exec turbo run build --filter=@mento-protocol/ui-dashboard --cache=local:rw",
]);

assert.deepEqual(
  extractTurboPrewarmCommands(`Agent quality gate

Mapped safe local commands:
- ./tools/trunk check docs/deployment.md (changed existing paths should pass targeted Trunk checks)

Dry run only.
`),
  [],
);

console.log("agent prewarm tests passed");
