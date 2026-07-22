<!-- agent-context: title="Grafana Alloy" status=active owner=eng canonical=true last_verified=2026-07-17 doc_type=runbook scope=aegis/grafana-agent review_interval_days=90 garden_lane=operator-runbooks -->

# Grafana Alloy

Grafana Alloy scrapes the Aegis and metrics-bridge Prometheus endpoints and
remote-writes their metrics to Grafana Cloud. It runs as an App Engine flexible
custom runtime. The service, directory, commands, and Secret Manager IDs retain
the legacy `grafana-agent` name so URLs and automation remain stable.

## Files and runtime

- [`config.alloy`](config.alloy) reads Grafana Cloud BasicAuth values from the
  process environment and never contains plaintext credentials.
- [`entrypoint.sh`](entrypoint.sh) obtains a metadata-server token, reads the
  three `grafana-agent-*` Secret Manager values at container start, exports
  them, and then executes Alloy.
- [`Dockerfile`](Dockerfile) uses the pinned official Alloy image, copies only
  the runtime configuration and entrypoint, and runs as a non-root user.
- [`cloudbuild.yaml`](cloudbuild.yaml) deploys
  [`grafana-agent.yaml`](grafana-agent.yaml) without reading secret values.

The runtime fetch keeps credentials out of the App Engine source staging
bucket, the container image, and the Cloud Build VM. Alloy listens on App
Engine's required `0.0.0.0:8080`; pprof and support-bundle endpoints are
disabled and the UI is mounted under `/-/alloy`.

## Secret and identity boundary

Platform Terraform creates the legacy-named secret containers and IAM bindings:

- `grafana-agent-endpoint`
- `grafana-agent-username`
- `grafana-agent-password`

The checked-in App Engine service does not pin `service_account`, so a new
version inherits the mutable app-level default identity. Terraform currently
grants the expected AppSpot principal access, but that does not prove the live
app-level default still matches it. Verify the effective identity read-only
before deploying; do not describe AppSpot as an unconditional App Engine Flex
runtime guarantee.

The legacy `pnpm aegis:agent:seed-secrets` path calls
`gcloud secrets versions add`. That conflicts with
[`ADR 0030`](../../docs/adr/0030-iac-before-cli-secrets.md), so agents must not
use it for bootstrap or rotation. Issue
[#1473](https://github.com/mento-protocol/monitoring-monorepo/issues/1473)
tracks the owner decision and policy-compliant secret delivery and identity
preflight. Until that work lands, stop and request an approved owning
integration instead of creating, rotating, or overwriting a secret version.

Do not bump this runbook's `last_verified` date until the effective production
version identity and secret-delivery path have both been verified.

## Deploy an already provisioned service

Deploy only when all three secrets already have enabled versions and the
effective runtime identity has been verified to hold least-privilege access:

```bash
pnpm aegis:agent:deploy
```

The local operator needs permission to submit the Cloud Build job; the
configured build identity performs the App Engine deployment. The build runs
`gcloud app deploy grafana-agent.yaml`, App Engine builds the image, and the
container fetches credentials when it starts.

Credential bootstrap and rotation remain blocked on #1473. Never place the
values in Git, Terraform state, build substitutions, source staging, or image
layers as a workaround.
