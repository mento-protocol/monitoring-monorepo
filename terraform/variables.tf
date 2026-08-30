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

variable "github_token" {
  description = <<-EOT
    GitHub PAT for writing repository Actions and Environment secrets,
    variables, repository settings, Environments, deployment policies, and the
    main lifecycle ruleset on
    `mento-protocol/monitoring-monorepo`.
    Fine-grained PAT scoped to that repo with Repository → Secrets: Read/write,
    Variables: Read/write, Administration: Read/write, and Environments:
    Read/write — least-privilege for this stack's use case (org-admin scope is
    NOT needed because the resources managed here are repo-level, not org-level).
    GitHub scopes these repo permissions independently: Variables for
    `github_actions_variable`, Administration for
    `github_workflow_repository_permissions` (`github-actions-permissions.tf`,
    issue #1557) and `github_repository_ruleset`
    (`github-controlled-main-lifecycle-ruleset.tf`, issue #2091), and Environments for the
    `sentry-pipeline` GitHub Environment and its
    `github_actions_environment_secret` mirrors (`github-environment.tf`, issue
    #1289), plus the `dependabot-merge` Environment, exact branch policy, and
    two Environment secrets (`github-dependabot-merge-app-credentials.tf`,
    issue #2091) — a PAT missing any of these 403s.
  EOT
  type        = string
  sensitive   = true
}

variable "local_agent_github_app_installation_id" {
  description = "Numeric installation ID of the local-agent GitHub App on monitoring-monorepo. Leave 0 until the human bootstrap is complete."
  type        = number
  default     = 0

  validation {
    condition = (
      var.local_agent_github_app_installation_id >= 0 &&
      floor(var.local_agent_github_app_installation_id) == var.local_agent_github_app_installation_id &&
      var.local_agent_github_app_installation_id <= 9007199254740991
    )
    error_message = "local_agent_github_app_installation_id must be 0 or a positive integer GitHub App installation ID."
  }
}

variable "local_agent_github_app_private_key" {
  description = "RSA PEM private key for the local-agent GitHub App. Supply it to Terraform as the runbook's exact unindented literal heredoc in an operator-owned gitignored HCL tfvars file for the separately approved credential apply. JSON assignment of this key is forbidden. The initial browser download follows the transient intake, removal, and revoke-on-uncertain-custody procedure. The guarded wrapper copies the tfvars file once into its private exact-plan directory, verifies canonical base64, parses and exercises the key in memory with Node crypto, and deletes the directory in `finally`. The ephemeral value terminates at a Secret Manager write-only field and is omitted from plan and state."
  type        = string
  default     = ""
  sensitive   = true
  ephemeral   = true

  validation {
    condition = (
      var.local_agent_github_app_credential_active == false ||
      (
        length(var.local_agent_github_app_private_key) <= 65536 &&
        (
          can(regex("^-----BEGIN RSA PRIVATE KEY-----\\n([A-Za-z0-9+/]{64}\\n)*([A-Za-z0-9+/]{4}){0,15}([A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/][AQgw]==)\\n-----END RSA PRIVATE KEY-----\\n?$", var.local_agent_github_app_private_key)) ||
          can(regex("^-----BEGIN PRIVATE KEY-----\\n([A-Za-z0-9+/]{64}\\n)*([A-Za-z0-9+/]{4}){0,15}([A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/][AQgw]==)\\n-----END PRIVATE KEY-----\\n?$", var.local_agent_github_app_private_key))
        )
      )
    )
    error_message = "Active local agent GitHub App credentials require a canonical RSA PKCS#1 or unencrypted PKCS#8 PEM envelope with canonical base64 pad bits and at most 65536 bytes. The guarded wrapper separately verifies the base64 encoding, parses the key, and exercises it before apply."
  }
}

variable "local_agent_github_app_private_key_rotation_counter" {
  description = "Non-secret Secret Manager rotation counter for the local-agent GitHub App private key. Keep 0 before activation; start at 1 and increment only for a separately approved rotation."
  type        = number
  default     = 0

  validation {
    condition = (
      var.local_agent_github_app_private_key_rotation_counter >= 0 &&
      floor(var.local_agent_github_app_private_key_rotation_counter) == var.local_agent_github_app_private_key_rotation_counter
    )
    error_message = "local_agent_github_app_private_key_rotation_counter must be a non-negative integer."
  }
}

variable "local_agent_github_app_credential_active" {
  description = "Create the IaC-owned local-agent GitHub App private-key version. Keep false until the separate App bootstrap and credential apply are approved."
  type        = bool
  default     = false
}

variable "dependabot_merge_app_id_encrypted_value" {
  description = "Base64 ciphertext for the source-pinned dedicated Dependabot merge App ID, encrypted outside Terraform with the monitoring-monorepo dependabot-merge Environment public key. Leave empty until the reviewed credential phase. Terraform state must never contain the plaintext value."
  type        = string
  sensitive   = true
  default     = ""
}

variable "dependabot_merge_app_environment_public_key_id" {
  description = "Public key ID returned for the monitoring-monorepo dependabot-merge Environment and used to encrypt both dedicated Dependabot merge App credential ciphertexts. On rotation, keep this ID for a one-secret ciphertext update. If GitHub changed the ID, update it and both ciphertexts together."
  type        = string
  default     = ""

  validation {
    condition = (
      var.dependabot_merge_app_environment_public_key_id == "" ||
      can(regex("^[A-Za-z0-9_-]{1,256}$", var.dependabot_merge_app_environment_public_key_id))
    )
    error_message = "dependabot_merge_app_environment_public_key_id must be empty or a bounded GitHub Actions Environment public-key ID."
  }
}

variable "dependabot_merge_app_private_key_encrypted_value" {
  description = "Base64 ciphertext for the dedicated Dependabot merge App private key, encrypted outside Terraform with the monitoring-monorepo dependabot-merge Environment public key. Leave empty until the reviewed credential phase. Terraform state must never contain plaintext key material."
  type        = string
  sensitive   = true
  default     = ""
}

variable "platform_settings_audit_token" {
  description = <<-EOT
    Fine-grained GitHub PAT with Administration: Read, Actions: Read, and
    Environments: Read on `mento-protocol/monitoring-monorepo` ONLY, consumed solely
    by `.github/workflows/platform-settings-drift.yml` to read
    repository workflow-permission, ruleset, Environment, deployment-policy,
    and secret-name endpoints. It asserts the repo default workflow-token
    permission and main lifecycle boundary stay at their pinned values (issues
    #2091, #1564, #1557). It never reads a public key or secret value.
    Mirrors into the `PLATFORM_SETTINGS_AUDIT_TOKEN` environment secret on the
    `sentry-pipeline` GitHub Environment (`github-environment.tf`, issue #1289),
    count-gated so `terraform apply` succeeds while unset. The source policy may
    keep the ruleset leg inert before activation; after activation an unset
    value fails the workflow. Read-only by design: it can never CHANGE a
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
    by `scripts/terraform/notify-terraform-apply.mjs` for the CI-applied stacks
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
  description = "Upstash provider account email. Human-owned bootstrap and rotation follow ADR 0060."
  type        = string
  sensitive   = true
}

variable "upstash_api_key" {
  description = "Sensitive Upstash provider bootstrap key. Human-owned creation and rotation follow ADR 0060."
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
    Read, Organization Read — NO write scopes. Mirrors into the
    `SENTRY_TRIAGE_TOKEN` environment secret on the `sentry-pipeline` GitHub
    Environment (`github-environment.tf`, issue #1289). Leave empty until
    provisioned; the secret resource is `count`-gated so `terraform apply`
    succeeds without it.
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
    no contents, no pull-requests. Mirrors into the `SENTRY_PROJECTION_TOKEN`
    environment secret on the `sentry-pipeline` GitHub Environment
    (`github-environment.tf`, issue #1289), which the projection step alone reads
    to file the owning-repo issue. Leave empty until provisioned; the secret resource is
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
    Mirrors into the `AUTOFIX_APP_PRIVATE_KEY` environment secret on the
    `sentry-pipeline` GitHub Environment (`github-environment.tf`, issue #1289),
    which the autofix finalize step alone reads to mint a short-lived
    installation token for the branch push + PR create. The App is installed on
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
    resolve). Mirrors into the `SENTRY_ARCHIVE_TOKEN` environment secret on the
    `sentry-pipeline` GitHub Environment (`github-environment.tf`, issue #1289).
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

# ── Grafana Cloud ─────────────────────────────────────────────────────────────

variable "grafana_url" {
  description = "Grafana Cloud stack URL. Also the origin the dashboard queries for peg history and alert state history (GRAFANA_QUERY_URL)."
  type        = string
  default     = "https://clabsmento.grafana.net"

  validation {
    condition     = startswith(var.grafana_url, "https://")
    error_message = "grafana_url must be an HTTPS origin; the dashboard sends a bearer token to it."
  }
}

variable "grafana_provisioning_token" {
  description = <<-EOT
    Admin-role Grafana Cloud service account token (glsa_...) used ONLY to
    configure this stack's Grafana provider, which mints the read-only
    dashboard identity in `grafana-read-access.tf`. Same organization
    credential the `alerts/rules` and `aegis` stacks take as
    `grafana_service_account_token`; the name differs here so it cannot be
    confused with the Viewer token this stack creates and ships to Vercel.
    Set in the gitignored terraform.tfvars. It is never written to a Vercel
    environment variable, a GitHub secret, or Secret Manager.
    Rotate from Grafana Cloud → Administration → Service accounts.
  EOT
  type        = string
  sensitive   = true
}

variable "grafana_dashboard_reader_token_rotation_counter" {
  description = <<-EOT
    Reviewed non-secret rotation counter for
    `grafana_service_account_token.dashboard_reader`. Start at 1; increment it
    through an approved current-main plan/apply to mint a replacement token and
    write it to the Vercel project, THEN redeploy the dashboard so an active
    deployment stops presenting the revoked token — the apply alone leaves
    history failing, exactly as documented for auth_secret_prev. This is the
    only rotation path: `scripts/terraform/tf-platform-plan-guard.mjs` rejects every
    platform Terraform argument outside its allowlist, so `-replace` is
    unavailable.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.grafana_dashboard_reader_token_rotation_counter >= 1 && var.grafana_dashboard_reader_token_rotation_counter == floor(var.grafana_dashboard_reader_token_rotation_counter)
    error_message = "grafana_dashboard_reader_token_rotation_counter must be a positive integer."
  }
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

variable "grafana_agent_secret_values" {
  description = <<-EOT
    Grafana Cloud remote-write values for the Alloy collector. Supply all three
    fields through the operator's gitignored terraform.tfvars only for an
    explicitly approved current-main plan/apply. The ephemeral value terminates
    at google_secret_manager_secret_version.grafana_agent.secret_data_wo and is
    omitted from Terraform plan and state.
  EOT
  type = object({
    endpoint = string
    username = string
    password = string
  })
  sensitive = true
  ephemeral = true
}

variable "grafana_agent_secret_rotation_counters" {
  description = <<-EOT
    Reviewed non-secret rotation counters for the Alloy Secret Manager values.
    Start each field at 1 for Terraform adoption and increment only the field
    whose value is intentionally rotated through an approved current-main
    plan/apply.
  EOT
  type = object({
    endpoint = number
    username = number
    password = number
  })

  validation {
    condition = alltrue([
      for counter in values(var.grafana_agent_secret_rotation_counters) :
      counter >= 1 && counter == floor(counter)
    ])
    error_message = "Every grafana_agent_secret_rotation_counters value must be a positive integer."
  }
}

variable "metrics_bridge_image" {
  description = "Bootstrap image used only when the Cloud Run service is first created. After bootstrap, image rollouts happen out-of-band via `gcloud run services update` (see scripts/deploy/deploy-bridge.sh + the GitHub workflow) — terraform ignores image drift via `lifecycle.ignore_changes`. Pinned by digest so bootstrap behavior is deterministic across environments; `gcr.io/cloudrun/hello`'s `http.HandleFunc(\"/\", …)` catch-all handles the `/health` probe."
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
  description = "IAM members who can deploy and manage monitoring services, including Alloy preflight and builder submission."
  type        = list(string)
  default     = ["group:eng@mentolabs.xyz"]
}
