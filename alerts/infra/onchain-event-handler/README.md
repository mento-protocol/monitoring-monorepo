<!-- agent-context: title="On-chain Event Handler Module" status=active owner=eng canonical=true last_verified=2026-07-22 doc_type=runbook scope=alerts/infra/onchain-event-handler review_interval_days=90 garden_lane=operator-runbooks -->

# On-chain Event Handler Module

Terraform module and Node.js 24 Cloud Function that verify QuickNode webhook
payloads and route Safe multisig events to Slack.

## Ownership and configuration

The parent [`alerts/infra`](../README.md) stack owns the GCP project, APIs,
service accounts, function, secrets, and deployment. Do not instantiate or
deploy this nested module independently. Its current wiring lives in
[`../main.tf`](../main.tf), with the maintained input and output contracts in
[`variables.tf`](variables.tf) and [`outputs.tf`](outputs.tf).

Production routes Celo, Ethereum, and Polygon. Safe Wallet links use each
network's EIP-3770 short name (`celo`, `eth`, and `matic`), which intentionally
differs from the internal `ethereum` and `polygon` chain keys.

## Runtime behavior

- The public HTTP endpoint accepts QuickNode delivery; HMAC verification,
  timestamp replay protection, and configured chain/address checks authenticate
  each payload.
- All 17 Safe events in [`src/safe-abi.json`](src/safe-abi.json) are supported.
  Eight security events route to the alerts channel and nine operational events
  route to the events channel; [`src/constants.ts`](src/constants.ts) owns that
  classification.
- One malformed or failed event does not abort the rest of a webhook batch.
- The function uses the same private GCS bucket for replay nonces and
  dead-lettered Slack payloads.

## Validate and deploy

From the repository root, run the handler checks and the parent-stack plan:

```bash
pnpm --filter @mento-protocol/alerts-onchain-event-handler lint
pnpm --filter @mento-protocol/alerts-onchain-event-handler typecheck
pnpm --filter @mento-protocol/alerts-onchain-event-handler knip
pnpm --filter @mento-protocol/alerts-onchain-event-handler test:coverage
pnpm --filter @mento-protocol/alerts-onchain-event-handler build:event-hashes
pnpm alerts:infra:plan
```

`build:event-hashes` regenerates
`alerts/infra/onchain-event-listeners/event-hashes.json`; it is not a read-only
check. When the ABI is not meant to change, follow it with
`git diff --exit-code -- alerts/infra/onchain-event-listeners/event-hashes.json`.
For an intentional ABI change, review and commit the regenerated file.

Terraform archives the TypeScript source and package-local lockfile while
excluding `dist/`, tests, Terraform files, local environment files, and
`node_modules`. Cloud Build installs from that lockfile, compiles the source,
and emits `dist/safe-abi.json`. A local `dist/` build is useful for development
but is not a deployment input.

Open a PR and review its plan. After merge, the apply runs through
`.github/workflows/alerts-infra.yml` behind the `production-infra` approval
gate. Never run a local production-stack apply. The targeted `generate:env`
provisioner below is the sole documented local-development exception and still
requires explicit approval.

After the gated deploy, obtain the function URL from the stack output and
confirm that an unsigned request is rejected:

```bash
FUNCTION_URL=$(terraform -chdir=alerts/infra output -json google_cloud | jq -r .cloud_function_url)
curl -X POST "$FUNCTION_URL" # expected: 401
```

## Local development

The package is a standalone Cloud Build source root with its own lockfile:

```bash
cd alerts/infra/onchain-event-handler
pnpm install --frozen-lockfile --lockfile-dir .
pnpm run dev
```

After explicit approval for the targeted Terraform state mutation,
`pnpm run generate:env` regenerates `.env` through the provisioner. The file
contains `GCP_PROJECT_ID`, `MULTISIG_CONFIG`, `SLACK_BOT_TOKEN`,
`SLACK_CHANNEL_ALERTS`, `SLACK_CHANNEL_EVENTS`, `QUICKNODE_SIGNING_SECRET`,
`QUICKNODE_REPLAY_BUCKET`, and `SUPPORTED_CHAINS`. The runtime configuration
parser requires the multisig, signing-secret, and Slack values. Production also
needs the replay bucket for nonce reservation and dead-letter storage; local
development bypasses replay protection. `GCP_PROJECT_ID` and `SUPPORTED_CHAINS`
are generated but are not read by the current handler code.

The local function listens on `http://localhost:8080/` by default. Set `PORT`
to use another port.

## Dead-lettering and redrive

An event is written under the bucket's `dead-letter/` prefix when Slack retries
are exhausted or the processing budget expires before delivery completes. The
corresponding ERROR logs are covered by the on-chain handler monitoring
policies in [`../monitoring.tf`](../monitoring.tf).

With explicit approval, run `pnpm deadletter:redrive` from the repository root.
It requires `QUICKNODE_REPLAY_BUCKET`, `SLACK_BOT_TOKEN`, and an authenticated
`gcloud` session; it reposts payloads to Slack and then moves the GCS objects to
`dead-letter/done/`. Because the command sends messages and archives objects,
never use it as a read-only diagnostic.

## Troubleshooting

- **401 response:** verify the configured QuickNode signing secret and webhook
  signature, without printing either value.
- **No webhook deliveries:** compare the function URL with the parent listener
  configuration and inspect logs with
  `pnpm --filter @mento-protocol/alerts-onchain-event-handler logs`.
- **Deployment failure:** inspect the parent stack plan and Cloud Build logs.
  API enablement and IAM belong to the parent Terraform stack; do not repair
  them manually.
