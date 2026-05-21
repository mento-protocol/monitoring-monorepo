# Scripts

Utility scripts for managing the Mento Alerts infrastructure.

Each script includes comprehensive header documentation. See the script file itself for detailed usage, requirements, and examples.

## Quick Reference

### Root Scripts (`/scripts/`)

- **`common.sh`** - Shared utilities library (logging, colors, helpers)
- **`spinner.sh`** - Loading indicator utility
- **`check-gcloud-login.sh`** - Check and setup gcloud authentication
- **`set-up-terraform.sh`** - Initialize Terraform with proper permissions
- **`fix-webhook-state.sh`** - Fix Terraform state drift for QuickNode webhooks
- **`get-webhook-filter-function.sh`** - Retrieve webhook filter function from QuickNode

### Cloud Function Scripts (`/onchain-event-handler/scripts/`)

- **`get-project-vars.sh`** - Load and cache project variables
- **`deploy.sh`** - Deploy Cloud Function directly via gcloud
- **`get-logs.sh`** - View Cloud Function logs
- **`test-local.sh`** - Test locally running Cloud Function

### TypeScript Scripts

- **`check-discord-permissions.ts`** - Check Discord bot permissions

## Common Usage Patterns

### Check Discord Permissions

```bash
cd scripts && npm install
npm run check-discord-permissions
# Or directly:
tsx scripts/check-discord-permissions.ts
```

### Fix Webhook State Issues

When encountering webhook state drift (404 errors during terraform apply):

```bash
./scripts/fix-webhook-state.sh
```

### Deploy Cloud Function Directly

For debugging or testing without Terraform:

```bash
cd onchain-event-handler
./scripts/deploy.sh
```

### View Function Logs

```bash
cd onchain-event-handler
./scripts/get-logs.sh
```

## Script Details

For detailed information about any script, see the header comments in the script file itself. Each script includes:

- Purpose and use cases
- Usage instructions
- Requirements and prerequisites
- Step-by-step explanation of what it does
- Examples where applicable
