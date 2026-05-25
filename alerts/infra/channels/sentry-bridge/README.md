# Sentry Alerts Module

This module configures Sentry error monitoring with Discord notifications.

## Purpose

Automatically forwards Sentry application errors to project-specific Discord channels for real-time error monitoring.

## Resources Created

- **Discord Channels**: `#sentry-{project-name}` for each Sentry project
- **Alert Rules**: Forwards errors to corresponding Discord channel
- **Permissions**: Grants Sentry integration access to Discord channels

## Configuration

### Required Variables

```hcl
variable "sentry_auth_token" {
  description = "Sentry authentication token"
  type        = string
  sensitive   = true
}

variable "discord_server_id" {
  description = "Discord server ID"
  type        = string
}

variable "discord_category_id" {
  description = "Discord category ID"
  type        = string
}

variable "discord_sentry_role_id" {
  description = "Discord role ID for Sentry"
  type        = string
}
```

### Providers Used

- `sentry` - Manages Sentry resources
- `discord` - Creates Discord channels

## How It Works

1. **Project Discovery**: Automatically discovers all projects in your Sentry organization (projects are managed outside Terraform)
2. **Channel Creation**: Creates a Discord channel for each discovered project
3. **Alert Rules**: Configures Sentry to forward errors to Discord for each project
4. **Permissions**: Ensures Sentry bot can post to channels

## Project Management

**Sentry projects are managed outside of Terraform.** Terraform automatically discovers all projects in your Sentry organization and creates Discord channels and alert rules for them.

### Project Discovery Process

1. **Automatic Discovery**: The `sentry_all_projects` data source automatically discovers all projects in your Sentry organization
2. **No Import Needed**: Projects don't need to be imported - they're discovered automatically
3. **No Terraform Management**: Projects are created, updated, and deleted directly in Sentry, not via Terraform

### Adding New Projects

To add a new project:

1. Create the project directly in Sentry (via the Sentry UI or API)
2. Run `terraform apply` - Terraform will automatically discover it and create:
   - A Discord channel (`#sentry-{project-slug}`)
   - An alert rule that forwards errors to Discord

### Removing Projects

To remove a project:

1. Delete the project directly in Sentry (via the Sentry UI or API)
2. Run `terraform apply` - Terraform will automatically:
   - Remove the Discord channel
   - Remove the alert rule

**Note**: Terraform will not delete Sentry projects - you must do this manually in Sentry.

## Alert Configuration

- Frequency: 5 minutes (prevents spam)
- Conditions: Any error
- Tags: url, browser, device, os, environment, level, handled

To modify, edit `sentry_issue_alert` in `main.tf`.

## Outputs

- `sentry_organization` - Organization details
- `sentry_team` - Team ID
- `discord_channels` - Created channel IDs
- `sentry_projects` - List of monitored projects

## Testing

Trigger a test error in your application:

```javascript
// In your app
throw new Error("Test Sentry Alert");
```

Check the corresponding `#sentry-{project}` channel in Discord.

## Troubleshooting

### No Alerts Received

1. Verify Sentry integration is installed in Discord
2. Check project exists in Sentry
3. Ensure error actually occurred in app
4. Check alert rule in Sentry UI

### Channel Not Created

1. Verify Discord bot has admin permissions
2. Check category ID is correct
3. Ensure Terraform has latest project list

## Limitations

- One channel per project (no environment separation)
- All errors forwarded (use filters to limit)
- 5-minute minimum frequency between alerts
