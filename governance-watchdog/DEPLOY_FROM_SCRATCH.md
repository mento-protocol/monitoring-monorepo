---
title: Governance Watchdog Bootstrap
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: runbook
scope: governance-watchdog
review_interval_days: 90
garden_lane: operator-runbooks
---

# Governance Watchdog Bootstrap

This is the exceptional first-deployment procedure for the watchdog's
dedicated GCP project. For an existing deployment, use
[`README.md`](README.md). Stack ownership, state, and apply policy come from the
`governance-watchdog` entry in [`terraform.stacks.json`](../terraform.stacks.json).

## Safety contract

- Never run an apply or destroy without an explicit human approval based on a
  reviewed plan.
- Use the root `pnpm tf` wrapper. Local applies for this CI-owned stack are
  allowed only from a clean `main` checkout exactly at `origin/main`; do not
  bypass that guard for routine bootstrap work.
- Keep `infra/terraform.tfvars` local and gitignored. Obtain individual values
  through their approved owners; never copy or share another operator's whole
  file.
- Terraform owns Google secrets and the repository secret mirrors. Do not
  bootstrap or rotate them with `gh secret set`, `gcloud secrets versions add`,
  or another ad hoc secret command. If an input has no IaC owner, stop and add
  one before continuing.

The backend is the shared GCS bucket
`mento-terraform-tfstate-6ed6`, prefix `governance-watchdog`, in the seed
project `mento-terraform-seed-ffac`. The provider and backend impersonate the
shared Terraform service account; the operator needs
`roles/iam.serviceAccountTokenCreator` for that account.

## 1. Prepare inputs

Install Node/pnpm, Terraform, `gcloud`, and `jq`, authenticate `gcloud`, and
work from the repository root on a clean, current `main` checkout.

Copy [`infra/terraform.tfvars.example`](infra/terraform.tfvars.example) to the
gitignored `infra/terraform.tfvars` and fill every required input. The file is
the canonical input checklist; it covers org/billing, Discord and Telegram,
QuickNode, test authentication, Splunk On-Call, and the GitHub provider token.

Do not set `slack_notification_channel_id` on the first pass. The Google
Monitoring Slack channel cannot exist until Terraform has created the project.

## 2. Validate and plan

```bash
pnpm tf validate governance-watchdog
pnpm tf plan governance-watchdog
```

Review the complete plan. It should create the dedicated randomized GCP
project, APIs and IAM, Cloud Function and source bucket, Secret Manager
resources, two QuickNode webhooks, scheduler/monitoring resources, and the
GitHub Actions secret mirrors. Investigate any replacement or destroy before
requesting approval.

QuickNode 429 and 522 responses can be transient. Re-run the plan after the
provider settles; never turn a failed plan into a blind apply retry.

## 3. Apply after approval

After a human approves that exact bootstrap plan:

```bash
pnpm tf apply governance-watchdog
terraform -chdir=governance-watchdog/infra output project_id
pnpm --dir governance-watchdog run cache:clear
```

The apply wrapper re-initializes the registered stack and enforces the clean
`main == origin/main` guard. If an apply partially fails, re-run the plan,
review the remaining changes, and obtain approval for the retry.

## 4. Add the Slack notification channel

Google Monitoring's Slack OAuth channel is the one manual external bootstrap
step:

1. In the new GCP project, open **Monitoring → Alerting → Edit notification
   channels** and authorize the intended Slack channel.
2. Copy the resulting `notificationChannels/...` ID into
   `slack_notification_channel_id` in `infra/terraform.tfvars`.
3. Run `pnpm tf plan governance-watchdog` again.
4. After explicit approval, run `pnpm tf apply governance-watchdog` again.

Terraform then creates the alert policy and mirrors
`TF_VAR_GOVERNANCE_WATCHDOG_SLACK_NOTIFICATION_CHANNEL_ID` for subsequent CI
and drift runs. Do not create a competing secret manually.

## 5. Verify the deployment

```bash
pnpm --dir governance-watchdog run logs
pnpm --dir governance-watchdog run test:prod:ProposalCreated
```

The deployed test sends real messages to the configured test Discord and
Telegram channels. Coordinate it with channel owners, confirm both messages,
then inspect the function and QuickNode health logs. Also verify that future
changes produce a PR plan and require the `production-infra` approval gate on
`main`.

## Teardown

Teardown deletes a production GCP project and its integrations; it is never a
routine debugging step. First produce and review a destroy plan:

```bash
pnpm tf plan governance-watchdog -destroy
```

Only after explicit teardown approval, from clean current `main`, run:

```bash
pnpm tf apply governance-watchdog -destroy
```

Record and verify any external cleanup that Terraform reports it cannot own.
