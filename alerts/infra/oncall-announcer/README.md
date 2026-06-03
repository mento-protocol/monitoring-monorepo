# On-call Announcer

Cloud Function and Terraform module for announcing Splunk On-Call rotations to
Slack.

## Runtime Behavior

`handleOncallRotation` is invoked by Cloud Scheduler. Each run:

1. Fetches the current Splunk On-Call engineer from
   `/api-public/v1/oncall/current`.
2. Reads the last announced username from a private GCS state object.
3. If the username changed, resolves the Splunk On-Call email to a Slack user
   with `users.lookupByEmail`, posts a message to `#eng`, and writes the new
   state.
4. Reconciles the `@support-engineer` Slack usergroup to exactly one member on
   every run.

The default schedule is every 15 minutes. State dedupe prevents duplicate Slack
messages when the rotation has not changed.

## Slack Scopes

The shared `slack_bot_token` needs these bot token scopes for this module:

- `chat:write` / `chat:write.public`
- `channels:read`
- `usergroups:read`
- `usergroups:write`
- `users:read.email`

Existing alerts-infra channel lifecycle also needs the channel-management
scopes documented in `../terraform.tfvars.example`.

## Splunk On-Call Credentials

Set these in `alerts/infra/terraform.tfvars` and let the stack sync matching
GitHub Actions secrets:

```hcl
splunk_on_call_api_id  = "..."
splunk_on_call_api_key = "..."
```

A read-only key is sufficient.

Optional selectors:

```hcl
splunk_on_call_team_slug              = "mento"
splunk_on_call_escalation_policy_slug = "primary"
```

Leave both empty to preserve the original announcer behavior: first team,
first current schedule, first user.

## Local Checks

```bash
pnpm --filter @mento-protocol/alerts-oncall-announcer typecheck
pnpm --filter @mento-protocol/alerts-oncall-announcer lint
pnpm --filter @mento-protocol/alerts-oncall-announcer test:coverage
pnpm --filter @mento-protocol/alerts-oncall-announcer knip
```

Cloud Build deploys this directory as a standalone source root, so keep the
package-local lockfile in sync after dependency changes:

```bash
cd alerts/infra/oncall-announcer
pnpm install --lockfile-only --lockfile-dir .
```
