# Grafana Agent

## Overview

The grafana agent pushes the prometheus metrics to grafana. This folder contains the deployment logic for the grafana-agent as an app engine service.

## Deployment

- agent.yaml.tml - Template of the agent.yaml configuration file for the grafana-agent, it contains variables that need to be replaced with secrets during deployment.
- template-agent.sh - Script that turns agent.yaml.tml into agent.yaml, replacing variables with values from the environment.
- Dockerfile - the Dockerfile of the service that gets deployed to app engine.
- cloudbuild.yaml - Google Cloud Build Configuration that prepares and executes the deployment.
- grafana-agent.yaml - The runtime configuration of the app engine service

### Deployment flow

Requirements: `gcloud` is authenticated with permissions to submit Cloud Build
jobs and deploy App Engine services in the `mento-monitoring` project.

The target project must already have enabled versions for these Secret Manager
secrets:

- `grafana-agent-endpoint`
- `grafana-agent-username`
- `grafana-agent-password`

Terraform creates the secret containers and IAM bindings, but it does not manage
secret values because that would put Grafana Cloud credentials in Terraform
state. Seed the first versions after `pnpm infra:apply`:

```sh
GRAFANA_AGENT_ENDPOINT='https://...' \
  GRAFANA_AGENT_USERNAME='...' \
  GRAFANA_AGENT_PASSWORD='...' \
  pnpm aegis:agent:seed-secrets
```

The seed script refuses to overwrite existing enabled versions. To rotate the
values intentionally, run it with `FORCE=1`.

1. Somebody executes `pnpm aegis:agent:seed-secrets` once per project bootstrap or `FORCE=1 pnpm aegis:agent:seed-secrets` during credential rotation.
2. Somebody executes `pnpm aegis:agent:deploy` from the monorepo root, creating and running a Cloud Build job in `mento-monitoring`.
3. [CloudBuild Step 1] Runs `template-agent.sh` with values from google cloud secrets and prepares the `agent.yaml` file.
4. [CloudBuild Step 2] Runs `gcloud app deploy grafana-agent.yaml` which starts the app engine deploy flow.
5. [App engine deploy] Dockerfile is executed and image starts running.
