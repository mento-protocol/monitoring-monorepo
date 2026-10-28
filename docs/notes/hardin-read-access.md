---
title: Hardin read-only investigation access
status: active
owner: eng
canonical: true
last_verified: 2026-10-28
doc_type: runbook
scope: terraform/infra
review_interval_days: 90
garden_lane: operator-runbooks
---

# Hardin read-only investigation access

Hardin is the in-house SRE agent that runs on Philip's macOS gateway. It
investigates incidents read-only and never mutates infrastructure. Everything it
can reach is declared in the `platform` stack; nothing is granted by hand
([ADR 0030](../adr/0030-iac-before-cli-secrets.md)).

## Identity chain

| Hop | Identity                                                                  | Grant (Terraform)                                                                                                                    |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `giskard-readonly@governance-watchdog-b2a6.iam.gserviceaccount.com`       | Hardin's own key-bearing SA. Listed in `var.agent_readonly_impersonators` (`terraform/agent-readonly.tf`), so it holds Token Creator |
| 2   | `agent-readonly@mento-monitoring.iam.gserviceaccount.com`                 | Keyless investigator SA with the curated org-level read-only roles; impersonated by hop 1 for every GCP read                         |
| 3   | Secret Manager `hardin-grafana-reader-token` (project `mento-monitoring`) | `roles/secretmanager.secretAccessor` on this one secret for hop 2 only (`terraform/grafana-read-access.tf`)                          |
| 4   | Grafana service account `hardin-sre-reader`, role `Viewer`                | Token `hardin-sre-reader-<counter>` stored as the `latest` secret version; datasource queries and alert rule/instance reads only     |

Hardin never receives `secretAccessor` directly and never receives a Grafana
token out of band. Removing hop 1 from `var.agent_readonly_impersonators` cuts
the whole chain; flipping `is_disabled` on `hardin_reader` cuts Grafana alone.

Accepted boundary: every other impersonator of `agent-readonly` (today the
`eng@mentolabs.xyz` group) can also read this secret, as it can read everything
else that SA sees. Engineers already hold their own Grafana logins, so this
widens nothing for them, but Grafana access logs cannot distinguish a human
using this token from Hardin. Treat the token as Hardin's by convention and
rotate it if that convention is broken.

## Apply

Platform applies are manual and human-approved. From a clean checkout of
current `main` after the change merges:

```bash
pnpm infra:plan                   # review: 1 Token Creator member, 1 Grafana SA + token, 1 secret + version + IAM member
pnpm infra:apply -- -auto-approve # only after explicit approval of that plan
```

No import is needed: none of these resources exist live yet. `terraform.tfvars`
needs no new values; `grafana_hardin_reader_token_rotation_counter` defaults
to `1`.

## Verify (never prints the token)

Run as Hardin, i.e. with `gcloud` authenticated as hop 1 (the stored JSON key
activated once with `gcloud auth activate-service-account --key-file=…`, or an
equivalent in-memory credential):

```bash
set -o pipefail # a failed secret read or Grafana call must fail the pipeline, not jq's empty input
SA=agent-readonly@mento-monitoring.iam.gserviceaccount.com
gcloud secrets versions access latest \
  --secret hardin-grafana-reader-token \
  --project mento-monitoring \
  --impersonate-service-account "$SA" \
  | sed 's/^/Authorization: Bearer /' \
  | curl --silent --fail --show-error --header @- \
      https://clabsmento.grafana.net/api/user \
  | jq '{login, isGrafanaAdmin, orgId}'
```

Expected: HTTP 200 with a `login` of the form `sa-<org>-hardin-sre-reader` and
`isGrafanaAdmin: false`. A `403` on the secret read means hop 1 is not in the
impersonator list or the plan was not applied; a `401` from Grafana means the
stored version is stale (see rotation). `GET /api/health` needs no token and only
proves Grafana is up, so use `/api/user` for the credential check.

The token stays inside the pipe: the secret payload feeds `sed`, which turns it
into a header line that `curl --header @-` reads from stdin. Do not assign it to
a shell variable in an interactive session and do not pass it as a command
argument.

## Rotate

1. Increment `grafana_hardin_reader_token_rotation_counter` in the operator's
   gitignored `terraform/terraform.tfvars`.
2. Run the ordinary approved `pnpm infra:plan` → `pnpm infra:apply` path. One
   apply creates the new token `hardin-sre-reader-<counter>`, writes it as a
   new secret version, then disables the previous version and destroys the old
   token. The disabled version stays for the audit trail only; it holds a
   revoked token, so re-enabling it recovers nothing.
3. Nothing to redeploy: Hardin reads `latest` on every use. A mistaken bump is
   harmless once the apply completes; there is no rollback step.

## Boundaries

- Hardin's GCP read surface is exactly `agent-readonly`'s curated role set; this
  note adds one secret payload to it and nothing else.
- The Grafana Admin provisioning token never reaches Secret Manager, Hardin, or
  any output. The Hardin token is never a Terraform output either.
- Giskard-side runbook for the stored key and the Python credential route:
  the private `standards/tools/gcp.md` in the Giskard workspace.
