# Deployment from Scratch

How to deploy the entire governance watchdog infrastructure from scratch.

- [Infra Deployment via Terraform](#infra-deployment-via-terraform)
  - [Terraform State Management](#terraform-state-management)
  - [Google Cloud Permission Requirements](#google-cloud-permission-requirements)
    - [Using Service Account Impersonation (recommended)](#using-service-account-impersonation-recommended)
    - [Using Your Own Gcloud User Account (not recommended)](#using-your-own-gcloud-user-account-not-recommended)
  - [Deployment](#deployment)
- [Debugging Problems](#debugging-problems)
  - [View Logs](#view-logs)
- [Teardown](#teardown)

## Infra Deployment via Terraform

### Terraform State Management

- The Terraform State for this project lives in our shared Terraform Seed Project with the ID `mento-terraform-seed-ffac`
- Deploying the project for the first time should automatically create a subfolder in the [google storage bucket used for terraform state management in the seed project](https://console.cloud.google.com/storage/browser/mento-terraform-tfstate-6ed6;tab=objects?forceOnBucketsSortingFiltering=true&project=mento-terraform-seed-ffac&prefix=&forceOnObjectsSortingFiltering=false)

### Google Cloud Permission Requirements

#### Using Service Account Impersonation (recommended)

The project is preconfigured to impersonate our shared terraform service account (see `./infra/versions.tf`).
The only permission you will need on your own gcloud user account is `roles/iam.serviceAccountTokenCreator` to allow you to impersonate our shared terraform service account.

#### Using Your Own Gcloud User Account (not recommended)

If for whatever reason service account impersonation doesn't work, you'll need at least the following permissions on your personal gcloud account to deploy this project with terraform:

- `roles/resourcemanager.folderViewer` on the folder that you want to create the project in
- `roles/resourcemanager.organizationViewer` on the organization
- `roles/resourcemanager.projectCreator` on the organization
- `roles/billing.user` on the organization
- `roles/storage.admin` to allow creation of new storage buckets

### Deployment

<!-- markdown-link-check-disable -->

1. Run `./bin/set-up-terraform.sh` to check required permissions and provision all required terraform providers and modules

1. Create a `./infra/terraform.tfvars` file. This is like `.env` for Terraform:

   ```sh
   touch ./infra/terraform.tfvars
   # This file is `.gitignore`d to avoid accidentally leaking sensitive data
   ```

1. Add Google Cloud Org ID and Billing Account to your local `terraform.tfvars`

   ```hcl
   # Required for creating new GCP projects
   # Get it via `gcloud organizations list`
   org_id               = "<our-org-id>"

   # Required for creating new GCP projects
   # Get it via `gcloud billing accounts list` (pick the GmbH account)
   billing_account      = "<our-billing-account-id>"
   ```

1. [Create a Discord Webhook URL](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) for the channel you want to receive notifications in

1. Add the Discord Webhook URL to your local `terraform.tfvars`:

   ```sh
   # This will be stored in Google Secret Manager upon deployment via Terraform
   echo "discord_webhook_url = \"<discord-webhook-url>"" >> terraform.tfvars
   ```

1. [Create a Test Discord Webhook URL](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) for a test channel you want to receive test notifications in <!-- markdown-link-check-enable -->

1. Add the Test Discord Webhook URL to your local `terraform.tfvars`:

   ```sh
   # This will be stored in Google Secret Manager upon deployment via Terraform
   echo "discord_test_webhook_url = \"<discord-test-webhook-url>"" >> terraform.tfvars
   ```

1. Create a Telegram group and invite a new bot into it
   - Open a new telegram chat with @BotFather
   - Use the `/newbot` command to create a new bot
   - Copy the API key printed out at the end of the prompt and store it in your `terraform.tfvars`

     ```hcl
     telegram_bot_token = "<bot-api-key>"
     ```

   - Get the Chat ID by inviting @MissRose_bot to the group and then using the `/id` command
   - Add the Chat ID to your `terraform.tfvars`

     ```hcl
     telegram_chat_id = "<group-chat-id>"
     ```

   - Remove @MissRose_bot after you got the Chat ID

1. Now also create a Test Telegram group and invite your newly created bot into it
   - We will use this channel to test notifications without spamming the watchdog members
   - Get the Chat ID by inviting @MissRose_bot to the group and then using the `/id` command
   - Add the Chat ID to your `terraform.tfvars`

     ```hcl
     telegram_test_chat_id = "<test-chat-id>"
     ```

1. Get (or generate if non-existing) a QuickNode API key to enable Terraform to provision QuickNode Webhooks
   - Grab the API key from our QuickNode dashboard: <https://dashboard.quicknode.com/api-keys>
   - Add it to `terraform.tfvars`

   ```hcl
   quicknode_api_key = "<quicknode-api-key>"
   ```

1. Generate a QuickNode security token for secure communication between QuickNode Webhooks and our cloud function
   - Generate a new random token via `openssl rand -base64 32`
   - Add it to `terraform.tfvars`

   ```hcl
   quicknode_security_token = "<quicknode-security-token>"
   ```

1. Get a VictorOps webhook URL by copying the Service API Endpoint URL from the [VictorOps Stackdriver Integration](https://portal.victorops.com/dash/mento-labs-gmbh#/advanced/stackdriver). The routing key can be founder under the [`Settings`](https://portal.victorops.com/dash/mento-labs-gmbh#/routekeys) tab

   ```hcl
   # Required to send on-call alerts to VictorOps
   victorops_webhook_url   = "<victorops-webhook-url>/<victorops-routing-key>"
   ```

1. Generate an auth key to allow us to test the deployed function from our local machines
   - You can use your password manager to generate a long and secure (url-compatible) key
   - Add it to `terraform.tfvars`

   ```hcl
   x_auth_token = "<x-auth-token>"
   ```

1. **Deploy the entire project via `terraform apply`**
   - You will see an overview of all resources to be created. Review them if you like and then type "Yes" to confirm.
   - This command can take up to 10 minutes because it does a lot of work creating and configuring all defined Google Cloud Resources
   - ❌ Given the complexity of setting up an entire Google Cloud Project incl. service accounts, permissions, etc., you might run
     into deployment errors with some components.

     **Often a simple retry of `terraform apply` helps**. Sometimes a dependency of a resource has simply not finished creating when terraform already tried to deploy the next one, so waiting a few minutes for things to settle can help.

1. Set your local `gcloud` project ID to our freshly created one and populate your local cache with frequently used project values:

   ```sh
   pnpm run cache:clear
   ```

1. Set up a Slack notification channel for error alerts

   **Note:** This step must be done AFTER the initial `terraform apply` because the GCP project needs to exist first.

   The Slack notification channel requires OAuth and must be created manually in the GCP Console:
   - Get your project ID: `cd infra && terraform output project_id`
   - Go to GCP Console → Monitoring → Alerting → [Edit Notification Channels](https://console.cloud.google.com/monitoring/alerting/notifications) (make sure you're in the correct project!)
   - Scroll to **Slack** and click **Add New**
   - Click **Authorize Slack** and complete the OAuth flow with your Slack workspace
   - Select the channel you want error alerts to go to (e.g., `#gcp-alerts`)
   - Give it a display name like "GCP Alerts"
   - After creating, find the channel ID:
     - Click on the newly created Slack channel in the list
     - The channel ID is in the URL: `.../notificationChannels/<THIS_IS_THE_ID>`
     - Or via CLI: `gcloud beta monitoring channels list --project=<YOUR_PROJECT_ID> --format='table(name,displayName,type)'`
   - Add the channel ID to your `terraform.tfvars`:

     ```hcl
     slack_notification_channel_id = "<channel-id>"
     ```

   - Run `terraform apply` again to create the error alerting policy

1. Check that everything worked as expected

   ```sh
   # 1. Call the deployed function via:
   npm run test:prod

   # 2. Monitor the configured Discord channel for a message to appear
   open https://discord.com/channels/966739027782955068/1262714272476037212

   # 3. Monitor the configured Telegram channel for a message to appear

   # 4. Check the function logs via:
   pnpm run logs # prints logs into your local terminal incl. a URL to the full logs in the google cloud console
   ```

## Debugging Problems

### View Logs

For most problems, you'll likely want to check the cloud function logs first.

- `pnpm run logs` will print the latest 50 log entries into your local terminal for quick and easy access, followed by a URL leading to the full gcloud console logs

## Teardown

1. Run `pnpm run destroy` to delete the entire production environment from google cloud
   - You might run into permission issues here, especially around deleting the associated billing account resources
   - I didn't have time to figure out the minimum set of permissions required to delete this project so the easiest would be to let an organization owner (i.e. Bogdan) run this with full permissions if you face any issues
