<!-- agent-context: title="Governance Watchdog" status=active owner=eng canonical=true last_verified=2026-07-22 doc_type=runbook scope=governance-watchdog review_interval_days=90 garden_lane=operator-runbooks -->

# Governance Watchdog

The watchdog receives Celo events from QuickNode, rejects unauthenticated or
replayed deliveries, validates supported events, and posts governance
notifications to Discord and Telegram. A separate SortedOracles event powers
the webhook health check.

The service owns a dedicated Terraform-created GCP project with a randomized
ID. It is not part of the `mento-alerts` or `mento-monitoring` projects.

![Architecture diagram](arch-diagram.png)

## Canonical routes

- Architecture decisions: [`docs/adr/`](../docs/adr/README.md), especially
  decisions scoped to `governance-watchdog`.
- Stack ownership and apply policy: [`docs/terraform.md`](../docs/terraform.md)
  and the `governance-watchdog` row in
  [`terraform.stacks.json`](../terraform.stacks.json).
- Terraform, Cloud Function, and deploy-input review:
  [`docs/pr-checklists/terraform-cloudrun.md`](../docs/pr-checklists/terraform-cloudrun.md).
- Adding an event or changing a QuickNode filter:
  [`ADDING_EVENTS.md`](ADDING_EVENTS.md).
- First deployment into a new GCP project:
  [`DEPLOY_FROM_SCRATCH.md`](DEPLOY_FROM_SCRATCH.md).

## Repository map

- `src/index.ts` — HTTP Cloud Function entry point.
- `src/events/` — event types, configs, source guards, registry, fixtures, and
  behavior tests.
- `src/event-notifications/` — Discord and Telegram builders/senders.
- `src/quicknode-health/` — live webhook-status check.
- `infra/` — the registered Terraform stack for GCP, QuickNode, monitoring,
  secrets, and GitHub Actions secret mirrors.
- `bin/` — local operator helpers. Scripts that mutate production require the
  same explicit approval as the underlying operation.

## Local development

Install dependencies from the monorepo root with `pnpm install`. Unit tests do
not need deployed secrets.

```bash
pnpm --filter @mento-protocol/governance-watchdog lint
pnpm --filter @mento-protocol/governance-watchdog typecheck
pnpm --filter @mento-protocol/governance-watchdog test:coverage
pnpm --filter @mento-protocol/governance-watchdog build
```

To exercise the HTTP function and real test-channel integrations locally:

1. Ensure the existing GCP project and Terraform state are accessible.
2. Copy `infra/terraform.tfvars.example` to the gitignored
   `infra/terraform.tfvars` and obtain individual values through their approved
   owners. Do not copy another operator's full file.
3. From `governance-watchdog/`, run `pnpm run cache:clear` and
   `pnpm run generate:env`.
4. Run `pnpm run dev`.
5. In another terminal, run a specific `pnpm run test:local:<EventName>`.

Local integration commands send messages to configured test channels. Use a
specific fixture, coordinate with channel owners, and remove test messages
when appropriate.

Useful read-only operator commands from `governance-watchdog/`:

```bash
pnpm run logs
terraform -chdir=infra output project_id
terraform -chdir=infra output function_uri
```

## Deployment

The normal deployment path is a reviewed PR. Changes to the watchdog source,
package build inputs, or `infra/` trigger
`.github/workflows/governance-watchdog.yml`. Pull requests receive a
secretless/read-only plan; after merge, the workflow re-plans and applies only
through the `production-infra` approval gate.

Do not use a local Terraform apply as the normal deploy path. The root
`pnpm tf apply governance-watchdog` wrapper deliberately refuses unsafe local
checkouts.

`pnpm run deploy:function` is a code-only break-glass helper for an existing
function. It bypasses the Terraform source object and creates state drift, so
use it only with explicit incident approval, then reconcile the reviewed
source through the normal PR/apply path.

After a deployment, inspect `pnpm run logs`. A command such as
`pnpm run test:prod:ProposalCreated` invokes the deployed function and sends
real test-channel messages; coordinate before running it.

## QuickNode filters

Terraform creates the `governor` and `healthcheck` webhooks, but deliberately
does not overwrite their live filter templates after creation. Reviewed filter
inputs live under `infra/quicknode-filter-functions/`; the post-merge,
explicitly approved update procedure is in [`ADDING_EVENTS.md`](ADDING_EVENTS.md).

The QuickNode `contracts` template argument is currently ignored. The handler
therefore enforces contract addresses in `src/events/process-event.ts`; keep
that guard synchronized with any filter or contract migration.

## Secrets

Terraform owns runtime Secret Manager values and repository secret mirrors.
Do not create, rotate, or overwrite them with ad hoc `gh`, `gcloud`, or provider
CLI secret commands. Change the owning Terraform input or documented
integration, review a plan, and obtain approval for the apply. If no IaC owner
exists, stop and establish one first.
