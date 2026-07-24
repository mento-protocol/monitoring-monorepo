# ── Vercel ────────────────────────────────────────────────────────────────────

variable "vercel_token" {
  description = "Vercel API token. Create at vercel.com → Account Settings → Tokens."
  type        = string
  sensitive   = true
}

variable "vercel_team_id" {
  description = "Vercel team ID. Found in .vercel/project.json or team settings."
  type        = string
  default     = "team_4l4TPoxnWEcusT8VeXkHbzF2"
}

# ── GitHub ────────────────────────────────────────────────────────────────────
# Used to manage repo-level GitHub Actions secrets and variables that belong
# to the platform stack, including the Vercel bypass mirror, integration-probe
# credentials, and the Terraform-apply Slack channel routing variable.
# `alerts/infra/` uses a separate token of the same shape for its own `TF_VAR_*`
# repo-secret mirrors.

variable "github_owner" {
  description = "GitHub organization that owns the repo whose Actions secrets this stack manages."
  type        = string
  default     = "mento-protocol"
}

variable "github_token" {
  description = <<-EOT
    GitHub PAT for writing repository Actions secrets, variables, and the
    default workflow-token permission on `mento-protocol/monitoring-monorepo`.
    Fine-grained PAT scoped to that repo with Repository → Secrets: Read/write,
    Variables: Read/write, and Administration: Read/write — least-privilege for
    this stack's use case (org-admin scope is NOT needed because the resources
    managed here are repo-level, not org-level). GitHub scopes these repo
    permissions independently: Variables for `github_actions_variable`, and
    Administration for `github_workflow_repository_permissions`
    (`github-actions-permissions.tf`, issue #1557) — a Secrets-only PAT 403s on
    the latter two.
  EOT
  type        = string
  sensitive   = true
}

variable "platform_settings_audit_token" {
  description = <<-EOT
    Fine-grained GitHub PAT with Administration: Read on
    `mento-protocol/monitoring-monorepo` ONLY (no other scope), consumed solely
    by `.github/workflows/platform-settings-drift.yml` to read
    `GET /repos/{owner}/{repo}/actions/permissions/workflow` and assert the repo
    default workflow-token permission stays read-only (issues #1564, #1557).
    Mirrors into the repo-level Actions secret `PLATFORM_SETTINGS_AUDIT_TOKEN`
    (`github-secrets.tf`), count-gated so `terraform apply` succeeds while unset
    and the drift check no-ops. Read-only by design: it can never CHANGE a
    setting. Deliberately SEPARATE from `github_token` (Administration:
    Read/write, kept local-only, never a CI secret) and from the autofix App
    (whose minimal Contents+Pull-requests trust boundary we do not widen). Leave
    empty until provisioned; see docs/notes/sentry-triage-pipeline.md.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "terraform_apply_slack_channel" {
  description = <<-EOT
    Slack channel that receives the Terraform apply-pending prompt posted
    by `scripts/notify-terraform-apply.mjs` for the CI-applied stacks
    (alerts-rules, alerts-delivery, aegis, governance-watchdog). Mirrored
    to the GitHub Actions repository variable `TERRAFORM_APPLY_SLACK_CHANNEL`
    (see `github-variables.tf`), which those workflows read with a fallback
    to this same default. Changing this reroutes the message; the notify bot
    posts to any public channel via its `chat:write.public` scope without
    being a member, so a private target channel needs a one-time manual
    `/invite` and is set by its Slack channel ID (chat.postMessage needs the
    ID for private channels). See `docs/notes/slack-github-subscriptions.md`.
  EOT
  type        = string
  default     = "#deploys"

  validation {
    # Accept a `#`-prefixed channel name or a Slack channel ID (C…/G…). A
    # private reroute target must be set by ID — chat.postMessage needs the
    # ID for a private channel even after the bot is invited — so a `^#`-only
    # rule would reject the one value that actually works. Still rejects a
    # bare name like `deploys` (the typo footgun).
    condition = (
      can(regex("^#", var.terraform_apply_slack_channel)) ||
      can(regex("^[CG][A-Z0-9]{8,}$", var.terraform_apply_slack_channel))
    )
    error_message = "terraform_apply_slack_channel must be a '#'-prefixed channel name (e.g. '#deploys') or a Slack channel ID (e.g. C0123ABC456)."
  }
}

# ── Upstash ───────────────────────────────────────────────────────────────────

variable "upstash_email" {
  description = "Upstash account email. Found at console.upstash.com → Account → API Keys."
  type        = string
  sensitive   = true
}

variable "upstash_api_key" {
  description = "Upstash API key. Found at console.upstash.com → Account → API Keys."
  type        = string
  sensitive   = true
}

variable "upstash_region" {
  description = "Primary region for the Upstash Redis database."
  type        = string
  default     = "eu-west-1"

  validation {
    condition = contains([
      "us-east-1", "us-west-1", "us-west-2",
      "eu-central-1", "eu-west-1",
      "sa-east-1",
      "ap-southeast-1", "ap-southeast-2",
    ], var.upstash_region)
    error_message = "Must be a valid Upstash global region."
  }
}

# ── Hasura / Envio ────────────────────────────────────────────────────────────

variable "hasura_url" {
  description = "GraphQL endpoint for the shared Envio indexer."
  type        = string
  default     = "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql"
}

variable "hasura_testnet_url" {
  description = "Optional GraphQL endpoint for the Monad Testnet Envio indexer. Leave empty to keep Monad Testnet hidden."
  type        = string
  default     = ""
}

variable "hasura_celo_sepolia_url" {
  description = "Optional GraphQL endpoint for the Celo Sepolia Envio indexer. Leave empty to keep hosted Celo Sepolia hidden."
  type        = string
  default     = ""
}

variable "show_testnet_networks" {
  description = "Whether to expose hosted testnet networks in the dashboard network picker."
  type        = bool
  default     = false
}

# ── Integration Probes ────────────────────────────────────────────────────────

variable "lifi_api_key" {
  description = <<-EOT
    LI.FI API key for the scheduled integration-probes workflow.
    Mirrors into the repo-level Actions secret `LIFI_API_KEY`.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "flytrade_api_key" {
  description = <<-EOT
    Fly.trade (Magpie) API key for the scheduled integration-probes workflow.
    Mirrors into the repo-level Actions secret `FLYTRADE_API_KEY`.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "openocean_api_key" {
  description = <<-EOT
    OpenOcean Pro API key for the scheduled integration-probes workflow.
    Mirrors into the repo-level Actions secret `OPENOCEAN_API_KEY`.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "squid_integrator_id" {
  description = <<-EOT
    Squid integrator id for the scheduled integration-probes workflow.
    Mirrors into the repo-level Actions secret `SQUID_INTEGRATOR_ID`.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

# ── Sentry triage/autofix (ADR 0036) ──────────────────────────────────────────

variable "sentry_triage_token" {
  description = <<-EOT
    READ-ONLY Sentry internal-integration token for the scheduled Sentry
    triage/autofix pipeline (ADR 0036). Scopes: Issue & Event Read, Project
    Read, Organization Read — NO write scopes. Mirrors into the repo-level
    Actions secret `SENTRY_TRIAGE_TOKEN`. Leave empty until provisioned; the
    secret resource is `count`-gated so `terraform apply` succeeds without it.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "claude_code_oauth_token" {
  description = <<-EOT
    Claude Max-subscription OAuth token (`claude setup-token`) used by
    `anthropics/claude-code-action@v1` in the Sentry triage/autofix pipeline
    (ADR 0036). Mirrors into the repo-level Actions secret
    `CLAUDE_CODE_OAUTH_TOKEN`, which ALREADY exists live and is shared with
    `.github/workflows/claude.yml` — setting this value overwrites (rotates)
    the live secret, and once applied it must not be emptied (the resource
    has `prevent_destroy`; see github-secrets.tf and the runbook in
    docs/notes/sentry-triage-pipeline.md). Leave empty until provisioned; the
    secret resource is `count`-gated so `terraform apply` succeeds without it.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "sentry_triage_enabled" {
  description = <<-EOT
    Kill switch for the scheduled Sentry triage/autofix workflows (ADR 0036,
    ADR 0030). Mirrors into the repo-level Actions variable
    `SENTRY_TRIAGE_ENABLED`; the workflows no-op unless it equals "true".
    Defaults to "false" so the pipeline stays inert until deliberately
    activated by a follow-up tfvar change plus a re-apply.
  EOT
  type        = string
  default     = "false"

  validation {
    condition     = contains(["true", "false"], var.sentry_triage_enabled)
    error_message = "sentry_triage_enabled must be the string \"true\" or \"false\"."
  }
}

variable "sentry_projection_token" {
  description = <<-EOT
    Fine-grained GitHub PAT for the Sentry triage VERDICT PROJECTION step
    (ADR 0038): Issues Read+Write on EXACTLY the three owning repos
    (frontend-monorepo, mento-analytics-api, minipay-dapp) and NOTHING else —
    no contents, no pull-requests. Mirrors into the repo-level Actions secret
    `SENTRY_PROJECTION_TOKEN`, which the projection step alone reads to file the
    owning-repo issue. Leave empty until provisioned; the secret resource is
    `count`-gated so `terraform apply` succeeds without it and the workflow
    no-ops gracefully. See the runbook in docs/notes/sentry-triage-pipeline.md
    for how to mint it.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "autofix_app_id" {
  description = <<-EOT
    GitHub App ID for the Sentry AUTOFIX leg (ADR 0036 Phase 2b): the App the
    autofix finalize step uses to push the fix branch and open the PR, so
    required CI + Codex review actually fire on it (a `github.token` push does
    not trigger downstream workflows). Mirrors into the repo-level Actions
    variable `AUTOFIX_APP_ID`. Leave empty until provisioned; the variable
    resource is `count`-gated so `terraform apply` succeeds without it and the
    autofix workflow no-ops. See the runbook in
    docs/notes/sentry-triage-pipeline.md for how to create the App.
  EOT
  type        = string
  default     = ""
}

variable "autofix_app_private_key" {
  description = <<-EOT
    PEM private key for the Sentry autofix GitHub App (see `autofix_app_id`).
    Mirrors into the repo-level Actions secret `AUTOFIX_APP_PRIVATE_KEY`, which
    the autofix finalize step alone reads to mint a short-lived installation
    token for the branch push + PR create. The App is installed on
    `mento-protocol/monitoring-monorepo` only, with Contents: Read&Write +
    Pull requests: Read&Write and no webhooks — the whole trust boundary. Leave
    empty until provisioned; the secret resource is `count`-gated so
    `terraform apply` succeeds without it. Brand-new, no external consumer, so
    no `prevent_destroy`. See the runbook in docs/notes/sentry-triage-pipeline.md.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "sentry_archive_token" {
  description = <<-EOT
    WRITE-SCOPED Sentry internal-integration token for the Phase 2a
    human-approved archive leg (ADR 0036 Stage C). Scopes: Issue & Event
    Read + Write — NOTHING else. The archive workflow
    (`.github/workflows/sentry-triage-archive.yml`) is its ONLY consumer, and
    only to set a Sentry issue to `archived_until_escalating` (never a hard
    resolve). Mirrors into the repo-level Actions secret `SENTRY_ARCHIVE_TOKEN`.
    Separate from the read-only `sentry_triage_token` by design — do NOT reuse
    that token here. Leave empty until provisioned; the secret resource is
    `count`-gated so `terraform apply` succeeds without it and the workflow
    no-ops gracefully. See the runbook in docs/notes/sentry-triage-pipeline.md
    for how to mint it.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "sentry_autofix_enabled" {
  description = <<-EOT
    Kill switch for the scheduled Sentry AUTOFIX workflow (ADR 0036 Phase 2b,
    ADR 0030). Mirrors into the repo-level Actions variable
    `SENTRY_AUTOFIX_ENABLED`; the workflow no-ops unless it equals "true".
    Separate from `sentry_triage_enabled` so the read-only triage pipeline and
    the PR-writing autofix leg activate independently. Defaults to "false" so
    autofix stays inert until deliberately activated by a follow-up tfvar change
    plus a re-apply.
  EOT
  type        = string
  default     = "false"

  validation {
    condition     = contains(["true", "false"], var.sentry_autofix_enabled)
    error_message = "sentry_autofix_enabled must be the string \"true\" or \"false\"."
  }
}

variable "sentry_archive_enabled" {
  description = <<-EOT
    Kill switch for the Phase 2a human-approved Sentry archive workflow
    (ADR 0036, ADR 0030). Mirrors into the repo-level Actions variable
    `SENTRY_ARCHIVE_ENABLED`; the archive workflow no-ops unless it equals
    "true". Defaults to "false" so the archive leg stays inert until
    deliberately activated by a follow-up tfvar change plus a re-apply, even
    after `sentry_archive_token` is provisioned.
  EOT
  type        = string
  default     = "false"

  validation {
    condition     = contains(["true", "false"], var.sentry_archive_enabled)
    error_message = "sentry_archive_enabled must be the string \"true\" or \"false\"."
  }
}

# ── Auth (Google OAuth / NextAuth) ─────────────────────────────────────────

variable "auth_google_id" {
  description = "Google OAuth Client ID. Create at console.cloud.google.com → APIs & Services → Credentials."
  type        = string
  sensitive   = true
}

variable "auth_google_secret" {
  description = "Google OAuth Client Secret."
  type        = string
  sensitive   = true
}

variable "auth_secret" {
  description = "NextAuth.js secret for JWT encryption. Generate with: openssl rand -base64 32"
  type        = string
  sensitive   = true
}

variable "auth_secret_prev" {
  description = <<-EOT
    Previous NextAuth.js secret, set only during a graceful AUTH_SECRET rotation.
    Rotation procedure: set this to the current auth_secret value, set auth_secret
    to a new random value (openssl rand -base64 32), apply the Terraform plan, then
    redeploy the dashboard so Vercel's active deployments receive the updated
    environment variables. Auth.js verifies existing session cookies against both
    secrets so active users are not logged out after that redeploy. Remove this
    variable (set to "") after 30 days once all old-signed cookies expire, apply
    the cleanup plan, and redeploy again so no active deployment keeps accepting
    the retired secret.
  EOT
  type        = string
  default     = ""
  sensitive   = true
}

variable "cron_secret" {
  description = "Shared secret for authenticating Vercel Cron requests to /api/address-labels/backup."
  type        = string
  sensitive   = true
}

# ── Arkham Intelligence ───────────────────────────────────────────────────────

variable "arkham_api_key" {
  description = <<-EOT
    Arkham Intelligence API key, used by the manual /api/arkham/enrich
    endpoint to attach curated labels/entity attribution to Mento counterparty
    addresses when API access is available. The Vercel schedule is disabled
    while access is unavailable. Apply for access at
    https://intel.arkm.com/api (gated). Server-side only — never exposed to
    the browser.
  EOT
  type        = string
  sensitive   = true
  # Default empty so `terraform apply` doesn't hard-fail before the team
  # has obtained a key. The Vercel env var resource below skips creation
  # when this is empty so the dashboard still deploys cleanly.
  default = ""
}

# ── Dune Analytics ────────────────────────────────────────────────────────────

variable "dune_api_key" {
  description = <<-EOT
    Dune Analytics API key, used by the nightly /api/minipay/sync cron to
    pull MiniPay attestations (Celo FederatedAttestations contract,
    issuer 0x7888...7fbc) into sharded `minipay:users:<nibble>` Redis SETs.
    The tagging cron then intersects these sets with Mento-interacting
    addresses and writes `source: minipay` labels. Generate at api.dune.com →
    Settings.
    Server-side only — never exposed to the browser.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

# ── Google Cloud (metrics-bridge) ─────────────────────────────────────────────

variable "terraform_service_account" {
  description = "GCP service account to impersonate for Terraform operations."
  type        = string
  default     = "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}

variable "gcp_project_id" {
  description = "GCP project ID for the monitoring project."
  type        = string
  default     = "mento-monitoring"
}

variable "gcp_org_id" {
  description = "GCP organization ID. Find with: gcloud organizations list"
  type        = string
}

variable "gcp_billing_account" {
  description = "GCP billing account ID. Find with: gcloud billing accounts list"
  type        = string
  sensitive   = true
}

variable "gcp_region" {
  description = "GCP region for Cloud Run deployment."
  type        = string
  default     = "europe-west1"
}

variable "aegis_app_engine_location_id" {
  description = "App Engine location for Aegis and its Grafana Alloy collector. App Engine location is immutable once created; use us-central to preserve uc.r.appspot.com URLs."
  type        = string
  default     = "us-central"

  validation {
    condition     = var.aegis_app_engine_location_id == "us-central"
    error_message = "Aegis App Engine location must stay us-central unless the migration plan and all appspot URLs are updated."
  }
}

variable "metrics_bridge_image" {
  description = "Bootstrap image used only when the Cloud Run service is first created. After bootstrap, image rollouts happen out-of-band via `gcloud run services update` (see scripts/deploy-bridge.sh + the GitHub workflow) — terraform ignores image drift via `lifecycle.ignore_changes`. Pinned by digest so bootstrap behavior is deterministic across environments; `gcr.io/cloudrun/hello`'s `http.HandleFunc(\"/\", …)` catch-all handles the `/health` probe."
  type        = string
  default     = "gcr.io/cloudrun/hello@sha256:572cdac9c931d84f01557f445ad5e980f6f23860c9bb18af02f2d5ca0b3b101e"

  # Before this PR, passing `metrics_bridge_image = ""` was the documented way
  # to skip Cloud Run provisioning (via a `count` guard). That guard is gone;
  # an empty override now gets forwarded to `containers.image` and hard-fails
  # the apply. Reject the legacy empty value explicitly so the failure is a
  # clear variable error, not a downstream provider error.
  validation {
    condition     = length(var.metrics_bridge_image) > 0
    error_message = "metrics_bridge_image must not be empty. Omit the variable to use the bootstrap default, or pass a concrete image reference."
  }
}

variable "gcp_dev_members" {
  description = "IAM members who can deploy and manage the metrics-bridge service."
  type        = list(string)
  default     = ["group:eng@mentolabs.xyz"]
}
