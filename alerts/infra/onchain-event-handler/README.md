<!-- agent-context: title="On-chain Event Handler Module" status=active owner=eng canonical=true last_verified=2026-07-17 doc_type=runbook scope=alerts/infra/onchain-event-handler review_interval_days=90 garden_lane=operator-runbooks -->

# Onchain Event Handler Module

Terraform module for deploying the Cloud Function that processes QuickNode webhooks and routes Safe multisig events to Slack.

## Overview

This module:

1. Builds and packages the TypeScript source code
2. Creates a Cloud Storage bucket for the function source
3. Deploys a Cloud Function
4. Configures environment variables and Secret Manager access for Slack delivery
5. Sets up IAM permissions for public invocation (by QuickNode Webhooks)

The production handler routes Celo, Ethereum, and Polygon. Safe Wallet links
use each network's EIP-3770 short name (`celo`, `eth`, and `matic`
respectively); those prefixes intentionally differ from the internal
`ethereum` and `polygon` chain keys.

## Prerequisites

- Google Cloud project with billing enabled
- Cloud Functions API enabled
- Cloud Storage API enabled
- Service account with appropriate permissions

## Usage

```hcl
module "onchain_event_handler" {
  source = "./onchain-event-handler"

  project_id    = local.project_id
  region        = var.region
  common_labels = local.common_labels

  project_service_account_email = google_service_account.project_sa.email
  cloudbuild_builder_dependency = google_project_iam_member.cloudbuild_builder.id

  quicknode_signing_secret = var.quicknode_signing_secret

  # All multisigs share the same two Slack destinations (alerts and events channels)
  multisig_notifications = {
    for key, multisig in var.multisigs : key => {
      address           = multisig.address
      name              = multisig.name
      chain             = multisig.chain
      alerts_channel_id = module.slack_channels.channel_ids.alerts
      events_channel_id = module.slack_channels.channel_ids.events
    }
  }
  slack_bot_token = var.slack_bot_token

  depends_on = [
    module.slack_channels,
    module.project_factory,
    google_service_account.project_sa,
  ]
}
```

## Inputs

| Name                            | Description                                           | Type     | Default                      | Required |
| ------------------------------- | ----------------------------------------------------- | -------- | ---------------------------- | -------- |
| `project_id`                    | GCP project ID                                        | `string` | -                            | yes      |
| `region`                        | GCP region                                            | `string` | `"europe-west1"`             | no       |
| `common_labels`                 | Labels applied to module resources                    | `map`    | `{}`                         | no       |
| `function_name`                 | Function name                                         | `string` | `"onchain-event-handler"`    | no       |
| `memory_mb`                     | Memory in MB                                          | `number` | `256`                        | no       |
| `timeout_seconds`               | Timeout in seconds                                    | `number` | `300`                        | no       |
| `max_instances`                 | Max instances                                         | `number` | `10`                         | no       |
| `min_instances`                 | Min instances                                         | `number` | `0`                          | no       |
| `quicknode_signing_secret`      | QuickNode signing secret                              | `string` | -                            | yes      |
| `multisig_notifications`        | Map of multisig configs with shared Slack channel IDs | `map`    | -                            | yes      |
| `slack_bot_token`               | Slack bot OAuth token for `chat.postMessage`          | `string` | -                            | yes      |
| `project_service_account_email` | Existing project service account for Cloud Build      | `string` | `null`                       | no       |
| `cloudbuild_builder_dependency` | Opaque dependency on the Cloud Build IAM grant        | `string` | -                            | yes      |
| `runtime`                       | Cloud Function runtime                                | `string` | `"nodejs24"`                 | no       |
| `secret_name`                   | QuickNode signing-secret container name               | `string` | `"quicknode-signing-secret"` | no       |

## Outputs

| Name                | Description                             |
| ------------------- | --------------------------------------- |
| `function_url`      | Cloud Function URL for webhook endpoint |
| `function_name`     | Function name                           |
| `function_location` | Function location                       |

## Deployment

The parent `alerts/infra` stack owns the GCP project, APIs, service accounts,
function, and CI deployment. Do not enable APIs, use service-account key files,
or deploy this nested module independently.

### Step 1: Build and check the function

**IMPORTANT**: Build TypeScript before deploying:

```bash
pnpm alerts:handler:build
pnpm alerts:handler:typecheck
pnpm alerts:handler:test
```

The build compiles `src/` to `dist/`, including `src/safe-abi.json` as
`dist/safe-abi.json`. Terraform packages the module for Cloud Build while
excluding dev-only files, Terraform configs, local env files, and node_modules.

### Step 2: Configure Terraform variables

Ensure `alerts/infra/terraform.tfvars` includes all required local-plan values
(see `alerts/infra/terraform.tfvars.example` for the full list).

### Step 3: Plan and deploy through the stack

```bash
pnpm alerts:infra:init
pnpm alerts:infra:plan
```

Open a PR and review the CI plan. After merge, the apply runs through
`.github/workflows/alerts-infra.yml` behind the `production-infra` approval
gate. Do not run a local apply.

**Deployment process:**

1. Archives function source (`dist/` folder)
2. Creates Cloud Storage bucket and uploads archive
3. Deploys Cloud Function (2nd gen, Node.js 24)
4. Configures environment variables
5. Sets up public IAM permissions for QuickNode webhook access

### Step 4: Verify deployment

```bash
FUNCTION_URL=$(terraform -chdir=alerts/infra output -json google_cloud | jq -r .cloud_function_url)
curl -X POST "$FUNCTION_URL"  # Should return 401 without a signed webhook payload.
```

The function URL is used as the webhook endpoint in `onchain-event-listeners`.

### Updating the function

```bash
pnpm alerts:handler:build
pnpm alerts:infra:plan
```

Commit the source change and use the same reviewed PR and gated CI apply. The
workflow builds `dist/`; Terraform archives it and creates a new function
revision when the source hash changes.

## Development

### Development Prerequisites

- Node.js 24
- pnpm 11

### Setup

```bash
cd alerts/infra/onchain-event-handler
pnpm install --frozen-lockfile --lockfile-dir .
```

### Build

```bash
pnpm run build
```

**IMPORTANT**: Build before deploying with Terraform. The build compiles `src/`
to `dist/`, including the Safe ABI JSON required by the compiled constants
module.

### Local Development

For local development, you'll need to set up environment variables. The function expects several environment variables that are normally provided by Terraform when deployed to GCP.

1. **Generate `.env` file:**

   After an explicit human approval for the targeted state mutation, generate
   `.env` from this directory:

   ```bash
   pnpm run generate:env
   ```

   Creates `.env` with: `MULTISIG_CONFIG`, `SLACK_BOT_TOKEN`,
   `SLACK_CHANNEL_ALERTS`, `SLACK_CHANNEL_EVENTS`,
   `QUICKNODE_SIGNING_SECRET`, `QUICKNODE_REPLAY_BUCKET`,
   `FUNCTION_TIMEOUT_SECONDS`, `SUPPORTED_CHAINS`.

   The script uses `terraform apply -replace` to force the provisioner
   to re-run, so `.env` is always regenerated from current state even
   if upstream variables haven't changed.

2. **Run locally:**

   ```bash
   pnpm run dev        # TypeScript development mode
   # or
   pnpm run build && pnpm start  # Compiled version
   ```

   Function available at `http://localhost:8080/` by default. Set `PORT` env var for different port.

   **Note:** Without `.env`, the function runs with warnings. Environment variables are optional in non-production for basic testing.

## Architecture

- **Runtime**: Node.js 24
- **Language**: TypeScript (compiled to JavaScript)
- **Trigger**: HTTP/HTTPS
- **Generation**: 2nd gen Cloud Functions
- **Authentication**: Public (allUsers) for QuickNode webhook access
- **Event Processing**: Processes all 17 Safe contract events
- **Routing**: Routes security events to alerts channels, operational events to events channels
- **Error Handling**: Continues processing other events if one fails

### Dead-lettering & redrive

If Slack delivery for an event exhausts its retries, the rendered payload is
persisted to the same GCS bucket used for QuickNode nonce replay protection,
under a `dead-letter/` prefix (see `src/dead-letter.ts`), instead of being
lost. The write logs `"Dead-lettered Safe alert after Slack delivery
failure"` at ERROR — this is covered by the existing
`onchain_handler_errors_policy` Cloud Monitoring alert (see
`alerts/infra/monitoring.tf`), since it fires alongside the same event's
`"Error processing log"` entry.

To re-deliver dead-lettered alerts, run `pnpm deadletter:redrive` (requires
`QUICKNODE_REPLAY_BUCKET` and `SLACK_BOT_TOKEN` in the environment, plus an
authenticated `gcloud` CLI session for GCS access). It reposts each
dead-lettered payload to its original Slack channel, then archives it to
`dead-letter/done/` so re-runs don't repost it.

## Troubleshooting

### Build Issues

#### Error: `pnpm: command not found`

- Install Node.js 24: `brew install node@24` (macOS) or use [nvm](https://github.com/nvm-sh/nvm)
- Enable pnpm via corepack (ships with Node.js 16+): `corepack enable pnpm`

#### Error: TypeScript compilation fails

- Check `tsconfig.json` is present
- Verify all dependencies are installed: `pnpm install --frozen-lockfile --lockfile-dir .`
- Check for TypeScript errors: `pnpm exec tsc --noEmit`

### Deployment Issues

#### Error: API not enabled

The parent Terraform stack owns API enablement. Inspect `pnpm alerts:infra:plan`
and the gated workflow rather than enabling APIs manually.

#### Error: Permission denied

- Ensure your GCP account has `roles/cloudfunctions.admin` and `roles/storage.admin`
- Or use a service account with appropriate permissions

#### Error: Function deployment timeout

- Check Cloud Build logs in GCP Console
- Verify the `dist/` folder exists and contains compiled JavaScript
- Ensure the archive size is reasonable (< 50MB recommended)

### Runtime Issues

#### Function returns 401 Unauthorized

- Verify `QUICKNODE_SIGNING_SECRET` environment variable is set correctly
- Check that the webhook signature verification is working

#### Function doesn't receive webhooks

- Verify the function URL is correct in QuickNode webhook configuration
- Check IAM permissions allow `allUsers` to invoke the function
- Review Cloud Function logs with
  `pnpm --filter @mento-protocol/alerts-onchain-event-handler logs`.

## Notes

- Function source is archived to Cloud Storage with dev-only files, local env
  files, tests, Terraform files, and `node_modules` excluded. Cloud Build runs
  pnpm from the checked-in package-local `pnpm-lock.yaml`, then runs the package
  build and emits `dist/safe-abi.json` from `src/safe-abi.json`.
- CI installs from the same package-local `pnpm-lock.yaml` before running
  handler typecheck, lint, knip, tests, and event-hash validation. The supply
  chain workflow also audits and lockfile-lints this deploy lockfile.
- Build required before Terraform deployment
- Environment variables set at deployment time (require redeployment to change)
