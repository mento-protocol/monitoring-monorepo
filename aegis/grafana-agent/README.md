<!-- agent-context: title="Grafana Alloy" status=active owner=eng canonical=true last_verified=2026-07-27 doc_type=runbook scope=aegis/grafana-agent review_interval_days=90 garden_lane=operator-runbooks -->

# Grafana Alloy

Grafana Alloy scrapes the Aegis and metrics-bridge Prometheus endpoints and
remote-writes their metrics to Grafana Cloud. It runs as an App Engine flexible
custom runtime. The service, directory, commands, and Secret Manager IDs retain
the legacy `grafana-agent` name so URLs and automation remain stable.

## Files and runtime

- [`config.alloy`](config.alloy) reads Grafana Cloud BasicAuth values from the
  process environment and never contains plaintext credentials.
- [`entrypoint.sh`](entrypoint.sh) obtains a metadata-server token, reads the
  App Engine traffic/version state, and starts Alloy only after the version has
  100% allocation and every peer version is stopped. It fetches the three
  `grafana-agent-*` values only after that activation handshake.
- [`passive-health.sh`](passive-health.sh) keeps a zero-allocation manual
  version healthy while returning the `collector-passive` sentinel from
  `/-/healthy`; ignored collector routes stay unavailable.
- [`Dockerfile`](Dockerfile) uses the pinned official Alloy image, copies only
  the runtime configuration and entrypoint, and runs as a non-root user.
- [`cloudbuild.yaml`](cloudbuild.yaml) deploys
  [`grafana-agent.yaml`](grafana-agent.yaml) without reading secret values.
- [`deploy.sh`](deploy.sh) exports exactly `Dockerfile`, `config.alloy`,
  `entrypoint.sh`, `grafana-agent.yaml`, and `passive-health.sh` from the
  verified commit into a temporary immutable snapshot.
  [`.gcloudignore`](.gcloudignore) enforces the same allowlist as defense in
  depth. It separately captures every preflight/contract input and runs the
  post-build gate from that committed verifier snapshot.

The runtime fetch keeps credentials out of the App Engine source staging
bucket, the container image, and the Cloud Build VM. Alloy listens on App
Engine's required `0.0.0.0:8080`; pprof and support-bundle endpoints are
disabled and the UI is mounted under `/-/alloy`.

## Secret and identity boundary

Platform Terraform creates the legacy-named secret containers, writes their
versions through Google provider 6.50.x write-only arguments, and binds the
dedicated runtime identity:

- `grafana-agent-endpoint`
- `grafana-agent-username`
- `grafana-agent-password`

[`grafana-agent.yaml`](grafana-agent.yaml) pins
`grafana-agent-runtime@mento-monitoring.iam.gserviceaccount.com`. That service
account receives Secret Accessor on exactly the three secrets above. Its only
project roles are the custom `grafanaAgentActivationReader` role and the
predefined `roles/logging.logWriter` role that App Engine Flex requires to
start an instance. It also receives repository-level
`roles/artifactregistry.reader` on only the Terraform-managed `us.gcr.io`
repository so Flex can pull the version image. The custom role contains only
`appengine.services.get` and `appengine.versions.list`, which the supervisor
needs to prove a single active collector. Cloud Build pins
`grafana-agent-builder@mento-monitoring.iam.gserviceaccount.com`, which has only
the five project roles needed to submit logs/artifacts and deploy App Engine
versions. Terraform grants `gcp_dev_members` permission to submit as that
builder and the metadata-only `grafanaAgentPreflightReader` role. The live
preflight requires both policies to match Terraform's member-set fingerprint
in that role's description. Only the builder can act as the runtime account;
it has no Secret Manager access. The preflight role contains the exact App
Engine get, Artifact Registry repository IAM get, IAM policy/role get, project
policy get, secret list/IAM get, and secret-version get permissions; it does
not include `secretmanager.versions.access`. Terraform grants Secret Accessor
only to the pinned runtime account. Cloud Build, the Compute default account,
and AppSpot cannot read Alloy secret payloads.

Terraform requires two operator-held inputs for this path:

- `grafana_agent_secret_values` supplies the three sensitive, ephemeral values
  to `secret_data_wo`. It has no default and must come from the gitignored
  `terraform/terraform.tfvars`, a gitignored `terraform/*.auto.tfvars` file, or
  an equivalent approved operator input.
- `grafana_agent_secret_rotation_counters` supplies the three non-secret,
  positive integer write-only versions passed as `secret_data_wo_version`.
  Increment only the counter for the value being rotated.

The values do not enter Terraform state, saved plans, source staging, build
substitutions, or image layers. They still enter the local Terraform process
during plan/apply, so use a clean current-`main` checkout and never print,
capture, or persist them. Unset `TF_LOG`, `TF_LOG_CORE`, `TF_LOG_PROVIDER`,
every `TF_LOG_PROVIDER_*`, `TF_LOG_SDK`, and `TF_LOG_SDK_PROTO`, or set those
actual log-level variables to `OFF`. Every other `TF_LOG_SDK_*`, including
`TF_LOG_SDK_PROTO_DATA_DIR`, must be unset or empty because `OFF` would name a
protocol-dump directory. The platform wrapper refuses unsafe plan/apply
settings; `TF_LOG_PATH` alone is safe because it does not enable logging. The
`platform` stack is manual: review a plan, then obtain explicit human approval
before apply. Its plan/apply wrapper always requires a clean `main` checkout
whose HEAD matches freshly fetched `origin/main`; `--force-local-apply` cannot
bypass this rule. It executes Terraform configuration from a temporary snapshot
of the verified commit while passing gitignored tfvars by absolute file path;
the snapshot never contains those operator values and is removed after the
command. Feature-branch validation does not replace that current-`main`
plan/apply. Secret rotation creates the replacement version before disabling
the previous version.

Production's `us.gcr.io` repository is already state-managed as
`google_artifact_registry_repository.grafana_agent_runtime_images`. Fresh
platform bootstraps create it before its IAM binding. Never remove this
resource from state or destroy it; it contains the deployed App Engine images.

Versions that do not pin
`grafana-agent-runtime@mento-monitoring.iam.gserviceaccount.com` intentionally
lack secret access and must not be restarted. Before starting a rollback
target, verify its identity and zero-traffic state:

```bash
pnpm aegis:agent:preflight -- --version TARGET
```

Do not bump this runbook's `last_verified` date until the effective production
version identity and secret-delivery path have both been verified.

## Validate and deploy an already provisioned service

Run the source contract and focused tests before a platform plan:

```bash
pnpm aegis:agent:preflight -- --static-only
pnpm aegis:agent:test
```

The deploy wrapper then fails closed before Cloud Build submission unless the
runtime and builder service accounts, their exact roles, the latest enabled
secret versions, and deployer impersonation grants match the checked-in
contract:

```bash
pnpm aegis:agent:deploy
```

It requires a clean current-`main` checkout, then prints the project, commit,
immutable App Engine version, previous serving version, verification command,
and rollback command before requiring the exact confirmation word `deploy`.
After confirmation it rechecks current `main` and submits only the five-file
runtime snapshot exported from that verified commit. It resolves the stable
App Engine hostname before submitting Cloud Build. Cloud Build creates a
passive version without traffic. The wrapper uses its committed verifier
snapshot to prove the new version still has zero allocation and the pinned
runtime identity. If the build or that proof fails, it stops and proves any
partially created passive target `STOPPED`; an unproven cleanup prints exact
manual stop commands and still fails the deploy. It then changes the split
atomically to 100% without
`--migrate`, stops and verifies every other manual-scaling version, and waits
until `/-/healthy` no longer returns the passive sentinel. The supervisor
requires three consecutive safe activation reads before fetching credentials
and starting Alloy. This stop-before-start handshake prevents the legacy
always-on version and the new version from remote-writing together, but it
leaves a temporary collection gap until the three safe reads activate Alloy or
the wrapper rolls back after 12 failed health attempts. On failure, rollback
proves the target version and every serving peer stopped before restarting the
previous version and atomically restoring its traffic; if any STOPPED proof
fails, it leaves the previous collector inactive and prints this same safe
manual sequence with concrete version IDs:

```bash
gcloud app versions stop TARGET --project mento-monitoring --service grafana-agent --quiet && \
  serving_status="$(gcloud app versions describe TARGET --project mento-monitoring --service grafana-agent --format='value(servingStatus)')" && \
  test "$serving_status" = STOPPED && \
  peer_versions="$(gcloud app versions list --project mento-monitoring --service grafana-agent --filter='version.servingStatus=SERVING AND version.id!=PREVIOUS' --format='value(version.id)')" && \
  for peer_version in $peer_versions; do \
    gcloud app versions stop "$peer_version" --project mento-monitoring --service grafana-agent --quiet && \
      peer_status="$(gcloud app versions describe "$peer_version" --project mento-monitoring --service grafana-agent --format='value(servingStatus)')" && \
      test "$peer_status" = STOPPED || exit 1; \
  done && \
  gcloud app versions start PREVIOUS --project mento-monitoring --service grafana-agent --quiet && \
  gcloud app services set-traffic grafana-agent --project mento-monitoring --splits PREVIOUS=1
```

Never start `PREVIOUS` until `TARGET` and every other serving peer report
`STOPPED`; doing so can run duplicate collectors. The local operator needs
permission to submit as the dedicated builder and change App Engine traffic;
the builder performs the version deployment without access to secret payloads.

Do not deploy until an explicitly approved platform apply has created the
write-only versions and identity bindings. Terraform's write-only path is the
only authorized bootstrap and rotation route. Never use
`gcloud secrets versions add` or another CLI workaround.
