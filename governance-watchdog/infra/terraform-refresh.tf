# Secret-version refresh calls access the managed payload to compare it with
# state. Grant only these six secrets; do not grant project-wide secret access
# to the refresh identity.
resource "google_secret_manager_secret_iam_member" "terraform_refresh_readonly" {
  for_each = {
    discord_test       = google_secret_manager_secret.discord_test_webhook_url.secret_id
    discord_primary    = google_secret_manager_secret.discord_webhook_url.secret_id
    quicknode_api      = google_secret_manager_secret.quicknode_api_key.secret_id
    quicknode_security = google_secret_manager_secret.quicknode_security_token.secret_id
    telegram_bot       = google_secret_manager_secret.telegram_bot_token.secret_id
    x_auth             = google_secret_manager_secret.x_auth_token.secret_id
  }

  project   = module.governance_watchdog.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}
