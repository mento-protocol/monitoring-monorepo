# Slack Channels

Creates the shared Slack channels used by the on-chain event handler:

- `#multisig-alerts` for security-sensitive Safe events.
- `#multisig-events` for operational Safe events.

The module uses the root `restapi.slack` provider and Slack Web API
`conversations.create` / `conversations.join` / `conversations.archive`.
Channel IDs are passed to the Cloud Function as `SLACK_CHANNEL_ALERTS` and
`SLACK_CHANNEL_EVENTS`; the Slack bot token is stored in Secret Manager as
`SLACK_BOT_TOKEN`.
