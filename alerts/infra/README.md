<!-- agent-context: title="Mento Alerts Delivery Infrastructure" status=active owner=eng canonical=true last_verified=2026-07-17 doc_type=runbook scope=alerts/infra review_interval_days=90 garden_lane=operator-runbooks -->

# Mento Alerts

Terraform-managed alert infrastructure for monitoring Mento's infrastructure across multiple blockchain networks.

## 📦 Module Structure

```plain
.
├── main.tf                 # Root configuration and module orchestration
├── variables.tf            # Shared variable definitions
├── outputs.tf              # Aggregated outputs
├── monitoring.tf           # GCP operational alerts → Slack #alerts-infra
│
├── channels/
│   ├── sentry-bridge/      # Sentry JS error monitoring (Sentry → Slack bridge)
│   └── slack-channels/     # Slack channels for on-chain multisig events
├── onchain-event-listeners/ # QuickNode webhook management for on-chain events
├── oncall-announcer/        # Splunk On-Call rotation announcements to Slack
└── onchain-event-handler/   # Cloud Function for processing webhooks (TS + TF paired)
```

## 🏗️ Architecture

### Data Flow

```mermaid
graph LR
    A[Blockchain<br/>Celo/Ethereum/Polygon] -->|Events emitted| B[QuickNode<br/>Webhooks]
    B -->|HTTP POST<br/>signed| C[Cloud Function<br/>onchain-event-handler]
    C -->|1. Verify signature| C
    C -->|2. Validate payload| C
    C -->|3. Process events| C
    C -->|4. Format messages| C
    C -->|chat.postMessage| D[Slack<br/>Web API]
    D -->|Messages| E[Slack Channels<br/>alerts/events]
    F[Cloud Scheduler] -->|HTTP POST<br/>OIDC| G[Cloud Function<br/>oncall-announcer]
    G -->|GET /oncall/current| H[Splunk On-Call]
    G -->|chat.postMessage<br/>usergroups.users.update| I[Slack<br/>#eng + @support-engineer]
    F -->|failed attempt log| J[GCP Monitoring]
    J -->|notification| K[Slack<br/>#alerts-infra]
```

### Component Overview

1. **QuickNode Webhooks**: Monitor blockchain events for configured multisig addresses
2. **Cloud Function**: Processes webhooks, verifies signatures, formats messages
3. **Slack Channels**: Receives formatted alerts and event notifications
4. **On-call Announcer**: Polls Splunk On-Call, posts rotations to `#eng`, and keeps `@support-engineer` membership to the current engineer
5. **Operational Alerting**: Sends scheduler failures and dropped on-chain events to `#alerts-infra`
6. **Terraform**: Manages all infrastructure as code

### Security

- **Signature Verification**: All QuickNode webhooks are verified using HMAC-SHA256
- **Timestamp Validation**: Prevents replay attacks (5-minute window)
- **Payload Size Limits**: Maximum 10MB payload size
- **Secret Management**: Secrets stored in GCP Secret Manager

## Prerequisites

- **Terraform** >= 1.11.0
- **GCP account** with billing enabled
- **Slack bot** with channel-management, chat, usergroup membership, and email lookup scopes
- **Sentry account** (for JS error monitoring)
- **QuickNode account** (for blockchain monitoring)

## 🚀 Quick Start

### 1. Configure Variables

```bash
cp alerts/infra/terraform.tfvars.example alerts/infra/terraform.tfvars
```

Edit `alerts/infra/terraform.tfvars`:

```hcl
# Sentry Configuration
sentry_auth_token             = "your-sentry-auth-token"
sentry_organization_slug      = "my-org"            # Optional, defaults to "mento-labs"
sentry_slack_workspace_name      = "Mento Labs"        # Optional, defaults to "Mento Labs"
sentry_slack_critical_channel    = "#alerts-critical"  # Optional, defaults to "#alerts-critical"
sentry_slack_critical_channel_id = "C0AURREPNDU"       # Optional, defaults to current "#alerts-critical" ID
# If rerouting critical fan-out, update both sentry_slack_critical_channel
# and sentry_slack_critical_channel_id together. Terraform rejects partial
# overrides, but cannot prove arbitrary custom name/ID pairs match.

# Slack Configuration (used by Terraform to create + archive Sentry and
# on-chain event channels, by Cloud Functions to post Slack messages, and by
# the on-call announcer to manage @support-engineer).
# Scopes required: channels:read, channels:manage, channels:join,
# channels:write.invites, chat:write, chat:write.public, usergroups:read,
# usergroups:write, users:read, users:read.email.
slack_bot_token = "xoxb-..."

# Splunk On-Call API credentials for the on-call announcer. A read-only key is
# sufficient. Leave both empty to keep the announcer disabled until the first
# credential bootstrap; setting both values enables the Cloud Function,
# scheduler, @support-engineer membership management, and GitHub secret sync.
splunk_on_call_api_id  = "your-splunk-on-call-api-id"
splunk_on_call_api_key = "your-splunk-on-call-api-key"

# Required when the announcer is enabled: Slack channel ID for #eng.
oncall_slack_channel_id = "C0123ABC456"

# Required when the announcer is enabled: Slack usergroup ID for
# @support-engineer. Create the usergroup in Slack once, then paste its ID here.
oncall_support_usergroup_id = "S0123ABC456"

# Optional existing GCP Monitoring notification-channel ID override. Omit this
# to let Terraform create the default Slack #alerts-infra channel integration.
# slack_notification_channel_id = "1234567890123456789"

# GCP Configuration
project_name     = "alerts"              # Optional, defaults to "alerts"
org_id           = "599540483579"
billing_account  = "XXXXXX-XXXXXX-XXXXXX"  # Required
region           = "europe-west1"        # Optional, defaults to "europe-west1"

# QuickNode Configuration
quicknode_api_key        = "your-quicknode-api-key"
quicknode_signing_secret = "your-signing-secret-at-least-32-chars"  # Generate: openssl rand -hex 32

# Multisig Configuration
multisigs = {
  "mento-labs-celo" = {
    name                   = "Mento Labs Multisig"
    address                = "0x655133d8E90F8190ed5c1F0f3710F602800C0150"
    chain                  = "celo"
    quicknode_network_name = "celo-mainnet"
  }
  "reserve-polygon" = {
    name                   = "Reserve Multisig"
    address                = "0x87647780180B8f55980C7D3fFeFe08a9B29e9aE1"
    chain                  = "polygon"
    quicknode_network_name = "polygon-mainnet"
  }
  "migration-multisig-polygon" = {
    name                   = "Migration Multisig"
    address                = "0x58099B74F4ACd642Da77b4B7966b4138ec5Ba458"
    chain                  = "polygon"
    quicknode_network_name = "polygon-mainnet"
  }
}

# Optional: Additional Labels
additional_labels = {
  environment = "production"
  team        = "platform"
  cost-center = "infrastructure"
}
```

### 2. Initialize and plan

```bash
pnpm alerts:infra:init
pnpm alerts:infra:plan
```

Open a PR with the stack change and review the CI plan. Apply happens only after
merge to `main`, through `.github/workflows/alerts-infra.yml` and its
`production-infra` required-reviewer gate. Do not run a local Terraform apply.

### 3. Verify Deployment

```bash
terraform -chdir=alerts/infra output
FUNCTION_URL=$(terraform -chdir=alerts/infra output -json google_cloud | jq -r .cloud_function_url)
curl -X POST "$FUNCTION_URL"  # Should return 401 without a signed webhook payload.
```

## 📖 Usage Examples

### Single-Chain Setup

```hcl
multisigs = {
  "my-multisig" = {
    name                   = "My Multisig"
    address                = "0x1234567890123456789012345678901234567890"
    chain                  = "celo"
    quicknode_network_name = "celo-mainnet"
  }
}
```

### Multi-Chain Setup

The module automatically groups multisigs by chain and creates one QuickNode webhook per chain. A single Cloud Function handles webhooks from all chains.

```hcl
multisigs = {
  "mento-labs-celo" = {
    name                   = "Mento Labs Multisig"
    address                = "0x655133d8E90F8190ed5c1F0f3710F602800C0150"
    chain                  = "celo"
    quicknode_network_name = "celo-mainnet"
  }
  "mento-labs-ethereum" = {
    name                   = "Mento Labs Multisig"
    address                = "0x1234567890123456789012345678901234567890"
    chain                  = "ethereum"
    quicknode_network_name = "ethereum-mainnet"
  }
  "reserve-polygon" = {
    name                   = "Reserve Multisig"
    address                = "0x87647780180B8f55980C7D3fFeFe08a9B29e9aE1"
    chain                  = "polygon"
    quicknode_network_name = "polygon-mainnet"
  }
}
```

### Supported Chains

- **Celo**: `chain = "celo"`, `quicknode_network_name = "celo-mainnet"`
- **Ethereum**: `chain = "ethereum"`, `quicknode_network_name = "ethereum-mainnet"`
- **Polygon**: `chain = "polygon"`, `quicknode_network_name = "polygon-mainnet"`

The default production configuration monitors Polygon's `ReserveSafe`
(`0x8764…9aE1`) and `MigrationMultisig` (`0x5809…a458`) from
`@mento-protocol/contracts@0.9.0`. Safe Wallet links use the chain's canonical
EIP-3770 prefix (`celo`, `eth`, or `matic`) rather than the internal Terraform
chain key.

**Note:** `quicknode_network_name` must be a valid QuickNode network identifier. See QuickNode API documentation for the full list of supported networks.

## 📊 What Gets Created

### Sentry Module

- Two `sentry_alert` rules per Sentry project (auto-discovered):
  - Default alert → `#sentry-{project-slug}` Slack channel (issue lifecycle events).
  - Critical fan-out → `#alerts-critical` Slack channel (fatal first-seen/regression in production).
- One `restapi_object.sentry_slack_channel` per project — Terraform creates and archives the `#sentry-{project-slug}` channel via Slack's Web API.
- `#alerts-critical` is NOT created here (shared with Grafana page-grade alerts; managed externally).

### Slack On-Chain Monitoring Infrastructure

**Shared channels for all multisigs:**

- `#multisig-alerts` - Critical security events (owner/threshold/module changes)
- `#multisig-events` - Normal transaction events (executions, approvals, funds)

### Cloud Function

- Processes QuickNode webhooks from all chains
- Routes security events to alerts channel, operational events to events channel
- Validates webhook signatures
- All multisigs share the same two Slack channels

### On-call Announcer

- Runs from Cloud Scheduler every 15 minutes by default
- Polls Splunk On-Call `/api-public/v1/oncall/current`
- Resolves the current Splunk On-Call user email to a Slack user ID with `users.lookupByEmail`
- Posts one Slack message to `#eng` only when the on-call username changes
- Replaces `@support-engineer` membership with exactly that Slack user on every run
- Stores last-seen state in a private GCS bucket to suppress duplicate announcements
- Uses the configured `@support-engineer` Slack usergroup ID and replaces its
  membership with exactly the current on-call Slack user
- Alerts `#alerts-infra` when Cloud Scheduler reports a failed reconciliation
  attempt, including function 5xx responses, IAM failures, timeouts, and
  unreachable targets

### Operational Alerting

- Terraform creates the GCP Monitoring Slack notification channel for
  `#alerts-infra` with the existing bot token by default
- `slack_notification_channel_id` is an override for adopting an existing
  notification channel in the same GCP project
- On-call scheduler failures use a direct log-match policy, notify immediately,
  rate-limit repeat notifications to one per hour, and auto-close
  after 30 minutes without another matching failure
- On-chain handler drop and processing-budget policies share the same
  `#alerts-infra` destination

### QuickNode Webhooks

- One webhook per chain
- Filters events by multisig addresses and event signatures
- Sends filtered events to Cloud Function

## 🔧 Common Operations

### Add New Multisig

Edit the committed default in `alerts/infra/variables.tf` and open a PR:

```hcl
multisigs = {
  "existing-name" = { ... },
  "new-multisig" = {
    name                   = "New Multisig Name"
    address                = "0xYourAddress..."
    chain                  = "celo"
    quicknode_network_name = "celo-mainnet"
  }
}
```

Run `pnpm alerts:infra:plan`, review the webhook replacement, and let the
merged PR apply through the `production-infra` gate.

### View Logs

```bash
pnpm --filter @mento-protocol/alerts-onchain-event-handler logs
```

### Destroy Resources

Model removals in a PR and inspect `pnpm alerts:infra:plan`. Any destroy requires
explicit human approval and must run through the `production-infra`-gated CI
workflow. Never run an ad hoc local destroy of this stack.

## 🐛 Troubleshooting

### Invalid Address Format

Addresses must:

- Start with `0x`
- Followed by exactly 40 hexadecimal characters
- Example: `0x655133d8E90F8190ed5c1F0f3710F602800C0150`

### Enable Debug Mode

Add to `alerts/infra/terraform.tfvars`:

```hcl
debug_mode = true
```

This shows full REST API requests and responses, including the QuickNode API
key/signing secret and Slack bot token. Keep it false in CI, never share logs
captured with it enabled, and use it only for an explicitly scoped local
diagnostic session.

## 📚 Documentation

### Module Documentation

- [`channels/sentry-bridge/README.md`](channels/sentry-bridge/README.md) - Sentry → Slack bridge module
- [`channels/slack-channels/README.md`](channels/slack-channels/README.md) - Slack channels for on-chain event notifications
- [`oncall-announcer/README.md`](oncall-announcer/README.md) - Splunk On-Call rotation announcer
- [`onchain-event-listeners/README.md`](onchain-event-listeners/README.md) - QuickNode webhook module for on-chain events
- [`onchain-event-handler/README.md`](onchain-event-handler/README.md) - Cloud Function module

### Code Quality

Follows [AWS Terraform best practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/structure.html) (adapted for GCP):

- Standard structure with data sources in dedicated `data.tf` files
- Consistent formatting (output descriptions, variable descriptions, naming conventions)
- Comprehensive labeling pattern using `merge()` for extensibility (GCP equivalent of AWS tags)
- Comprehensive README files for all modules with inline usage examples

### External Documentation

- [Terraform Documentation](https://developer.hashicorp.com/terraform/docs)
- [Sentry API Docs](https://docs.sentry.io/api/)
- [Slack API Docs](https://api.slack.com/web)
- [QuickNode Documentation](https://www.quicknode.com/docs)

## 🔒 Security

- API keys stored in `terraform.tfvars` (gitignored)
- Sensitive outputs marked appropriately
- State file contains secrets - handle carefully
- Webhook signatures validated for QuickNode requests

**Quick Commands Reference:**

```bash
pnpm alerts:infra:init
pnpm alerts:infra:plan
pnpm alerts:handler:typecheck
pnpm alerts:handler:test
pnpm alerts:oncall:typecheck
pnpm alerts:oncall:test
# Apply and approved removals run only through production-infra-gated CI.
```
