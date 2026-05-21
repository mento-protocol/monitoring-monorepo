# Discord Channel Manager Module

Creates and manages shared Discord channels and webhooks for blockchain event monitoring.

## What Gets Created

Creates 2 shared channels with webhooks for all monitored multisigs:

- **`#🔔︱multisig-events`** - Operational events (transactions, approvals, funds)
- **`#🚨︱multisig-alerts`** - Critical security events (owner/threshold/module changes)

## Usage

```hcl
module "discord_channel_manager" {
  source = "./discord-channel-manager"

  providers = {
    restapi.discord = restapi.discord
  }

  discord_server_id   = "your-server-id"
  discord_category_id = "your-category-id"
}
```

## Inputs

| Name                  | Description                                        | Type     | Required |
| --------------------- | -------------------------------------------------- | -------- | -------- |
| `discord_server_id`   | Discord server ID                                  | `string` | Yes      |
| `discord_category_id` | Discord category ID where channels will be created | `string` | Yes      |

## Outputs

| Name                        | Description                                            | Sensitive |
| --------------------------- | ------------------------------------------------------ | --------- |
| `multisig_discord_channels` | Discord channel names (alerts_channel, events_channel) | No        |
| `webhook_urls`              | Webhook URLs for alerts and events channels            | Yes       |
| `webhook_info`              | Webhook IDs and channel information                    | No        |

## Provider Setup

**Discord Provider:**

```hcl
provider "discord" {
  token = var.discord_bot_token
}
```

**REST API Provider:**

```hcl
provider "restapi" {
  alias = "discord"
  uri   = "https://discord.com/api/v10"
  headers = {
    "Authorization" = "Bot ${var.discord_bot_token}"
    "Content-Type"  = "application/json"
  }
  write_returns_object = true
}
```

**Required Bot Permissions:** Administrator (or Manage Channels + Manage Webhooks)

## Example: Using with Cloud Function

```hcl
module "onchain_event_handler" {
  source = "./onchain-event-handler"

  multisig_webhooks = {
    for key, multisig in var.multisigs : key => {
      address        = multisig.address
      name           = multisig.name
      chain          = multisig.chain
      alerts_webhook = module.discord_channel_manager.webhook_urls.alerts
      events_webhook = module.discord_channel_manager.webhook_urls.events
    }
  }
}
```

## Troubleshooting

**Webhook creation fails:**

- Verify bot has Administrator permissions
- Confirm server/category IDs are correct
- Check [Discord API status](https://discordstatus.com/)

**Channels not appearing:** Ensure bot has permissions to create channels in the category.

**Permission issues:** Use the permission checker script to diagnose Discord bot permission problems:

```bash
cd scripts && npm install
npx tsx scripts/check-discord-permissions.ts
```

The script will automatically read from `terraform.tfvars` and check both server-wide and category-specific permissions required for this module.

## Related Modules

- [`onchain-event-listeners`](../onchain-event-listeners/README.md) - QuickNode webhook configuration
- [`onchain-event-handler`](../onchain-event-handler/README.md) - Processes webhooks and routes to Discord
- [`sentry-alerts`](../sentry-alerts/README.md) - Application error monitoring
