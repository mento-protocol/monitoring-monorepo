# Onchain Event Handler Module

Terraform module for deploying the Cloud Function that processes QuickNode webhooks and routes Safe multisig events to Slack.

## Overview

This module:

1. Builds and packages the TypeScript source code
2. Creates a Cloud Storage bucket for the function source
3. Deploys a Cloud Function
4. Configures environment variables and Secret Manager access for Slack delivery
5. Sets up IAM permissions for public invocation (by QuickNode Webhooks)

## Prerequisites

- Google Cloud project with billing enabled
- Cloud Functions API enabled
- Cloud Storage API enabled
- Service account with appropriate permissions

## Usage

```hcl
module "onchain_event_handler" {
  source = "./onchain-event-handler"

  project_id    = var.gcp_project_id
  region        = var.gcp_region

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
}
```

## Inputs

| Name                       | Description                                           | Type     | Default                   | Required |
| -------------------------- | ----------------------------------------------------- | -------- | ------------------------- | -------- |
| `project_id`               | GCP project ID                                        | `string` | -                         | yes      |
| `region`                   | GCP region                                            | `string` | `"europe-west1"`          | no       |
| `function_name`            | Function name                                         | `string` | `"onchain-event-handler"` | no       |
| `memory_mb`                | Memory in MB                                          | `number` | `256`                     | no       |
| `timeout_seconds`          | Timeout in seconds                                    | `number` | `300`                     | no       |
| `max_instances`            | Max instances                                         | `number` | `10`                      | no       |
| `min_instances`            | Min instances                                         | `number` | `0`                       | no       |
| `quicknode_signing_secret` | QuickNode signing secret                              | `string` | -                         | yes      |
| `multisig_notifications`   | Map of multisig configs with shared Slack channel IDs | `map`    | -                         | yes      |
| `slack_bot_token`          | Slack bot OAuth token for `chat.postMessage`          | `string` | -                         | yes      |

## Outputs

| Name                | Description                             |
| ------------------- | --------------------------------------- |
| `function_url`      | Cloud Function URL for webhook endpoint |
| `function_name`     | Function name                           |
| `function_location` | Function location                       |

## Deployment

### Step 1: Prerequisites Setup

1. **Google Cloud Project Setup**

   ```bash
   # Set your GCP project
   gcloud config set project YOUR_PROJECT_ID

   # Enable required APIs
   gcloud services enable cloudfunctions.googleapis.com
   gcloud services enable cloudbuild.googleapis.com
   gcloud services enable storage.googleapis.com
   ```

2. **Authentication**

   ```bash
   # Authenticate with GCP (if not already done)
   gcloud auth application-default login

   # Or use a service account key
   export GOOGLE_APPLICATION_CREDENTIALS="path/to/service-account-key.json"
   ```

### Step 2: Build the Function

**IMPORTANT**: Build TypeScript before deploying:

```bash
cd onchain-event-handler
pnpm install --frozen-lockfile --lockfile-dir .
pnpm run build
```

The build compiles `src/` to `dist/`, including `src/safe-abi.json` as
`dist/safe-abi.json`. Terraform packages the module for Cloud Build while
excluding dev-only files, Terraform configs, local env files, and node_modules.

### Step 3: Configure Terraform Variables

Ensure `terraform.tfvars` includes all required variables (see `terraform.tfvars.example` for full list).

### Step 4: Deploy with Terraform

From the repository root:

```bash
terraform init
terraform plan
terraform apply
```

**Deployment process:**

1. Archives function source (`dist/` folder)
2. Creates Cloud Storage bucket and uploads archive
3. Deploys Cloud Function (2nd gen, Node.js 22)
4. Configures environment variables
5. Sets up public IAM permissions for QuickNode webhook access

### Step 5: Verify Deployment

```bash
terraform output cloud_function_url
curl $(terraform output -raw cloud_function_url)  # Should return 401 without webhook payload
```

The function URL is used as the webhook endpoint in `onchain-event-listeners`.

### Step 6: Update Function (Redeployment)

```bash
cd onchain-event-handler && pnpm run build && cd ..
terraform apply
```

Terraform detects `dist/` changes and creates a new archive, triggering a function update.

## Development

### Development Prerequisites

- Node.js 22
- pnpm 10

### Setup

```bash
cd onchain-event-handler
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

   After `terraform apply`, generate `.env` from root directory:

   ```bash
   pnpm run generate:env
   ```

   Creates `.env` with: `MULTISIG_CONFIG`, `SLACK_BOT_TOKEN`,
   `SLACK_CHANNEL_ALERTS`, `SLACK_CHANNEL_EVENTS`,
   `QUICKNODE_SIGNING_SECRET`, `QUICKNODE_REPLAY_BUCKET`,
   `FUNCTION_TIMEOUT_SECONDS`, `SUPPORTED_CHAINS`.

2. **Run locally:**

   ```bash
   pnpm run dev        # TypeScript development mode
   # or
   pnpm run build && pnpm start  # Compiled version
   ```

   Function available at `http://localhost:8080/` by default. Set `PORT` env var for different port.

   **Note:** Without `.env`, the function runs with warnings. Environment variables are optional in non-production for basic testing.

## Architecture

- **Runtime**: Node.js 22
- **Language**: TypeScript (compiled to JavaScript)
- **Trigger**: HTTP/HTTPS
- **Generation**: 2nd gen Cloud Functions
- **Authentication**: Public (allUsers) for QuickNode webhook access
- **Event Processing**: Processes all 16 Safe contract events
- **Routing**: Routes security events to alerts channels, operational events to events channels
- **Error Handling**: Continues processing other events if one fails

## Troubleshooting

### Build Issues

#### Error: `pnpm: command not found`

- Install Node.js 22: `brew install node@22` (macOS) or use [nvm](https://github.com/nvm-sh/nvm)
- Enable pnpm via corepack (ships with Node.js 16+): `corepack enable pnpm`

#### Error: TypeScript compilation fails

- Check `tsconfig.json` is present
- Verify all dependencies are installed: `pnpm install --frozen-lockfile --lockfile-dir .`
- Check for TypeScript errors: `pnpm exec tsc --noEmit`

### Deployment Issues

#### Error: API not enabled

```bash
gcloud services enable cloudfunctions.googleapis.com cloudbuild.googleapis.com storage.googleapis.com
```

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
- Review Cloud Function logs: `gcloud functions logs read onchain-event-handler --region=europe-west1`

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
