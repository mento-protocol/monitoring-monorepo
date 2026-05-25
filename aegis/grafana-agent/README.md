# Grafana Agent

## Overview

The grafana agent pushes the prometheus metrics to grafana. This folder contains the deployment logic for the grafana-agent as an app engine service.

## Deployment

- `agent.yaml` — Grafana Agent runtime config. Contains `${VAR}` references for the Grafana Cloud BasicAuth credentials; values resolved at container start by `entrypoint.sh` + `grafana-agent -config.expand-env=true`. **Never contains plaintext secrets.**
- `entrypoint.sh` — Runs at container start. Calls the GCE metadata server, fetches `grafana-agent-{endpoint,username,password}` from Secret Manager via the App Engine Flex compute SA, exports them as env vars, then exec's grafana-agent.
- `Dockerfile` — Image built and deployed to App Engine. Installs `jq` + `curl` for the entrypoint, copies `agent.yaml` and `entrypoint.sh` (no secrets in either).
- `cloudbuild.yaml` — Single-step Cloud Build: `gcloud app deploy grafana-agent.yaml`. No secret-rendering step.
- `grafana-agent.yaml` — App Engine service definition.

### Secret-handling design

Grafana Cloud BasicAuth credentials live in Secret Manager and are fetched at **runtime** by `entrypoint.sh`. They never touch:

- The App Engine source staging bucket (`gs://staging.<project>.appspot.com/`)
- The container image filesystem in Artifact Registry
- The Cloud Build VM disk (no `secretEnv` block; build doesn't read secrets)

Rotation: `FORCE=1 pnpm aegis:agent:seed-secrets` writes new Secret Manager versions; container picks them up at the next App Engine restart (forced by `pnpm aegis:agent:deploy` or an explicit `gcloud app services restart`).

> Prior versions rendered `agent.yaml` on the build VM via `template-agent.sh` (sed substitution) and shipped the plaintext file via `gcloud app deploy`. The rendered yaml then sat in the source-staging bucket AND inside the container image layer indefinitely — recoverable post-rotation by anyone with `storage.objects.get` on the staging bucket or `artifactregistry.reader` on the image. The runtime-fetch design above replaces that flow.

### Deployment flow

Requirements: `gcloud` is authenticated with permissions to submit Cloud Build jobs and deploy App Engine services in the `mento-monitoring` project.

The target project must already have enabled versions for these Secret Manager secrets:

- `grafana-agent-endpoint`
- `grafana-agent-username`
- `grafana-agent-password`

Terraform (`terraform/main.tf` → `google_secret_manager_secret.grafana_agent` and the matching `_iam_member` resources) creates the secret containers, plus IAM bindings granting `roles/secretmanager.secretAccessor` to:

- The Cloud Build SA (`<project-number>@cloudbuild.gserviceaccount.com`) — historical; no longer required for this service but kept for other consumers.
- The App Engine Flex compute SA (`<project-number>-compute@developer.gserviceaccount.com`) — used by `entrypoint.sh` at runtime.

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
5. [Container start] `entrypoint.sh` fetches the 3 grafana-agent-\* secrets from Secret Manager via the compute SA's metadata-server token, exports them as env vars, then exec's grafana-agent with `-config.expand-env=true` so the agent substitutes the `${VAR}` references in `agent.yaml`.
