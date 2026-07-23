---
title: Adding Governance Watchdog Events
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: runbook
scope: governance-watchdog
review_interval_days: 90
garden_lane: operator-runbooks
---

# Adding Governance Watchdog Events

Use this runbook to add a decoded QuickNode event to the watchdog. The normal
case extends one of the two existing Celo webhooks: `governor` for governance
events or `healthcheck` for the SortedOracles heartbeat. A new network,
destination, or independently operated webhook is an infrastructure change and
must be modeled in Terraform rather than created manually in QuickNode.

## Sources of truth

- [`src/events/types.ts`](src/events/types.ts) defines event payload types.
- [`src/events/configs.ts`](src/events/configs.ts) owns validation, message
  composition, emoji, and deduplication strategy.
- [`src/events/registry.ts`](src/events/registry.ts) registers every config
  automatically.
- [`src/events/process-event.ts`](src/events/process-event.ts) owns
  source-contract guards and health-check routing.
- [`infra/quicknode-filter-functions/`](infra/quicknode-filter-functions/)
  holds the reviewed filter inputs. The deploy script reads the ABI and
  contracts from each file's `template: evmAbiFilter` comment header.
- [`infra/quicknode.tf`](infra/quicknode.tf) creates webhooks during bootstrap;
  it deliberately ignores later server-side filter changes.

QuickNode currently ignores the `contracts` template argument for these
webhooks. Treat it as documentation and bootstrap input, not a security
boundary. Every event that can share a signature with another contract needs a
matching address guard in `process-event.ts`. The existing Governor events are
protected by `GOVERNOR_EVENT_TYPES` and `MENTO_GOVERNOR_ADDRESS`.

## Implementation checklist

### 1. Define the event and its source boundary

1. Add the event to `EventType` in `src/events/types.ts`.
2. Add its payload interface and `EventTypeMap` entry. Field types must match
   the decoded QuickNode payload; bigint-like JSON fields arrive as strings at
   runtime and are normalized by the current builders.
3. If the event comes from MentoGovernor, add it to
   `GOVERNOR_EVENT_TYPES`. For another contract, add an equivalent fail-closed
   address check before enabling the filter.

`ValidateEventTypeMap` makes an omitted map entry a type error.

### 2. Add behavior in `EVENT_CONFIGS`

Add one config in `src/events/configs.ts` with:

- `validateEvent` and every required field;
- Discord and Telegram message builders;
- an emoji;
- one deduplication strategy: `proposalId`, `transactionHash`, `rateFeedId`,
  or `custom` with `customDeduplicationKey`.

The registry picks up the config automatically. Only non-notifying control
events such as `MedianUpdated` need special routing in `process-event.ts`.

### 3. Update the reviewed QuickNode filter input

For a Governor event, update the trimmed ABI in
`infra/quicknode-filter-functions/governor.js`. Keep the comment header and the
matching JavaScript constants synchronized, and include only events the
handler supports. For a health-check event, use `sorted-oracles.js` instead.

Do not create a temporary production webhook. If the change genuinely needs a
third webhook, add its Terraform resource, destination, health checks, and
deployment-script routing in the same PR.

`infra/quicknode.tf` uses `filebase64(...)` on these same files for the
first-creation `filter_function`. Updating the reviewed filter source therefore
updates both the bootstrap input and the later live-patch input without a
second encoded copy.

### 4. Add fixtures and regression coverage

1. Commit a redacted real-payload fixture under `src/events/fixtures/`.
2. Add the fixture to `src/events/__tests__/event-messages.test.ts` and update
   its snapshots.
3. Cover validation, message formatting, deduplication, and the source-address
   guard at the lowest faithful test layer.
4. Add `test:local:<EventName>` and `test:prod:<EventName>` scripts to
   `package.json`, plus the corresponding case in
   `bin/test-deployed-function.sh`.

Local and deployed test scripts send messages to configured test channels; do
not run them against production destinations casually.

### 5. Validate and open the PR

From the repository root, run:

```bash
pnpm --filter @mento-protocol/governance-watchdog lint
pnpm --filter @mento-protocol/governance-watchdog typecheck
pnpm --filter @mento-protocol/governance-watchdog test:coverage
pnpm --filter @mento-protocol/governance-watchdog build
pnpm agent:quality-gate --run
```

The PR must contain the TypeScript handler, source guard, filter input,
fixture, tests, and any Terraform bootstrap change as one reviewed unit.

## Rollout order

1. Merge the reviewed PR.
2. Wait for `.github/workflows/governance-watchdog.yml` to apply the Cloud
   Function change through the `production-infra` approval gate.
3. Obtain explicit approval for the live QuickNode filter mutation.
4. From a clean checkout of the merged commit, deploy only the affected filter:

   ```bash
   ./governance-watchdog/bin/deploy-quicknode-filter.sh --webhook governor
   # or: --webhook healthcheck
   ```

   The script refuses a dirty tree, reads the API key from Secret Manager,
   patches the existing webhook, and verifies that it remains active.

5. Inspect the QuickNode dashboard and Cloud Function logs. When coordinated
   with the channel owners, run the matching `test:prod:<EventName>` command
   and verify both test-channel messages.

Deploy code before the filter so QuickNode cannot deliver an event the running
function does not yet understand. A failed or partial rollout must leave the
old filter active until the handler is ready; do not delete and recreate the
webhook to recover.
