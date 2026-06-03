# Grafana Alloy

## Overview

Grafana Alloy scrapes the Aegis and metrics-bridge Prometheus endpoints and
remote-writes the metrics to Grafana Cloud. This folder contains the deployment
logic for the Alloy collector as an App Engine flexible custom runtime.

The App Engine service, folder, commands, and Secret Manager IDs still use the
`grafana-agent` name so existing URLs and automation keep working. The running
binary and committed collector config are Alloy.

## Deployment

- `config.alloy` — Alloy runtime config converted from the old Grafana Agent static config. Reads Grafana Cloud BasicAuth credentials with `sys.env(...)`; values are supplied only at container start. **Never contains plaintext secrets.**
- `entrypoint.sh` — Runs at container start. Calls the GCE metadata server, fetches `grafana-agent-{endpoint,username,password}` from Secret Manager via the App Engine Flex AppSpot SA, exports them as env vars, then exec's Alloy. The Alloy HTTP server still listens on App Engine's required `0.0.0.0:8080`, but pprof and support-bundle endpoints are disabled and the UI is moved off `/` to `/-/alloy`.
- `Dockerfile` — Image built and deployed to App Engine. Uses the official `grafana/alloy` image, installs `jq` + `curl` for the entrypoint, copies `config.alloy` and `entrypoint.sh` (no secrets in either), and runs as a dedicated non-root user.
- `cloudbuild.yaml` — Single-step Cloud Build: `gcloud app deploy grafana-agent.yaml`. No secret-rendering step.
- `grafana-agent.yaml` — App Engine service definition. The service name is retained for the stable `grafana-agent-dot-mento-monitoring.uc.r.appspot.com` URL.

### Secret-handling design

Grafana Cloud BasicAuth credentials live in Secret Manager and are fetched at **runtime** by `entrypoint.sh`. They never touch:

- The App Engine source staging bucket (`gs://staging.<project>.appspot.com/`)
- The container image filesystem in Artifact Registry
- The Cloud Build VM disk (no `secretEnv` block; build doesn't read secrets)

Rotation: `FORCE=1 pnpm aegis:agent:seed-secrets` writes new Secret Manager versions; the Alloy container picks them up at the next App Engine restart (forced by `pnpm aegis:agent:deploy` or an explicit `gcloud app services restart`).

> Prior versions rendered `agent.yaml` on the build VM via `template-agent.sh` (sed substitution) and shipped the plaintext file via `gcloud app deploy`. The rendered yaml then sat in the source-staging bucket AND inside the container image layer indefinitely — recoverable post-rotation by anyone with `storage.objects.get` on the staging bucket or `artifactregistry.reader` on the image. The runtime-fetch design above replaces that flow, and `config.alloy` keeps credentials out of the committed config by reading `sys.env(...)`.

### Deployment flow

Requirements: `gcloud` is authenticated with permissions to submit Cloud Build jobs and deploy App Engine services in the `mento-monitoring` project.

The target project must already have enabled versions for these legacy-named
Secret Manager secrets:

- `grafana-agent-endpoint`
- `grafana-agent-username`
- `grafana-agent-password`

Terraform (`terraform/aegis-bootstrap.tf` → `google_secret_manager_secret.grafana_agent` and the matching `_iam_member` resources) creates the secret containers, plus IAM bindings granting `roles/secretmanager.secretAccessor` to:

- The App Engine default SA (`<project>@appspot.gserviceaccount.com`) via `grafana_agent_appspot_accessor` — **this is the identity `entrypoint.sh` authenticates as at runtime.** App Engine Flex apps run as the AppSpot SA (not the Compute default SA, even though the underlying VM uses Compute) — the metadata server inside the application context returns the AppSpot SA's token.
- The Compute default SA (`<project-number>-compute@developer.gserviceaccount.com`) — kept for the legacy Cloud Build path and any future Compute-SA consumers.
- The Cloud Build SA (`<project-number>@cloudbuild.gserviceaccount.com`) — historical; no longer required for this service but kept for other consumers.

Terraform does NOT manage secret values (that would put Grafana Cloud credentials in TF state). Seed the first versions after `pnpm infra:apply`:

```sh
GRAFANA_AGENT_ENDPOINT='https://...' \
  GRAFANA_AGENT_USERNAME='...' \
  GRAFANA_AGENT_PASSWORD='...' \
  pnpm aegis:agent:seed-secrets
```

The seed script refuses to overwrite existing enabled versions. To rotate the values intentionally, run it with `FORCE=1`.

1. Somebody executes `pnpm aegis:agent:seed-secrets` once per project bootstrap or `FORCE=1 pnpm aegis:agent:seed-secrets` during credential rotation.
2. Somebody executes `pnpm aegis:agent:deploy` from the monorepo root, creating and running a Cloud Build job in `mento-monitoring`.
3. [CloudBuild] Runs `gcloud app deploy grafana-agent.yaml`. No secrets touch the build VM.
4. [App engine deploy] Dockerfile is executed; image launches with `entrypoint.sh` as the entrypoint.
5. [Container start] `entrypoint.sh` fetches the 3 grafana-agent-\* secrets from Secret Manager via the AppSpot SA's metadata-server token, exports them as env vars, then exec's Alloy with `/etc/alloy/config.alloy`, `--storage.path=/var/lib/alloy/data`, pprof/support-bundle endpoints disabled, and the UI path prefix set to `/-/alloy`.
