---
title: Terraform CI separates routine deploy, PR plan, trusted-main refresh, and production apply identities
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
scope: terraform/infra
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0047 — Terraform CI separates routine deploy, PR plan, trusted-main refresh, and production apply identities

**Status:** Accepted (Jul 2026), staged cutover in progress.
**Scope:** terraform/infra

## Context

The repository historically reused the routine service deployer for trusted
`main` Terraform plans and environment-gated Terraform applies. Its direct
service-deploy roles were bounded to the monitoring project, but a
service-account-scoped Token Creator grant on the seed-project
`org-terraform` identity let any accepted routine-deployer token inherit the
full Terraform authority used by the infrastructure stacks. The
`production-infra` Environment remained an approval control in workflow YAML,
not part of the cloud authentication boundary.

PR plans already use a state-only identity. Broadening that PR-reachable
identity with live-project access would expose more production metadata and
secret-bearing Terraform state to code from the checked-out PR. Trusted
`main` plans and scheduled drift still need live refresh, but they do not need
write authority.

Workload Identity Federation principals are scoped to a pool, not to an
individual provider in that pool. Adding a stricter provider to the existing
pool would therefore not isolate production apply: the older provider could
produce a principal in the same pool namespace.

## Decision

Keep four separate authentication chains:

| Lane                             | GitHub selector                                                                                        | WIF-facing identity                     | Downstream authority                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Routine service deploy           | Existing `secrets.GCP_WORKLOAD_IDENTITY_PROVIDER` and `secrets.GCP_SERVICE_ACCOUNT`                    | `metrics-bridge-deployer`               | Direct service-deploy roles in the monitoring project; no `org-terraform` impersonation after cutover            |
| Same-repo PR plan                | Existing plan selector                                                                                 | `metrics-bridge-plan-readonly`          | `org-terraform-plan-readonly` with read-only state access; no live-project roles                                 |
| Trusted-`main` refresh and drift | `vars.GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT`                                                           | `terraform-refresh-readonly`            | `org-terraform-refresh-readonly` with read-only state and explicitly granted live-resource reads; no write roles |
| Production Terraform apply       | `vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER` and `vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT` | Seed-project `production-infra-applier` | Service-account-scoped Token Creator on `org-terraform`, reachable only through the dedicated production pool    |

Both GitHub providers require the repository slug and GitHub's immutable
repository ID `1172025835`. The numeric ID prevents a renamed or deleted
repository's old name from becoming a new trusted principal. Keeping the slug
check as well ensures a transferred or renamed repository does not retain
access under a different owner or name.

The production provider lives in a dedicated
`github-production-infra` Workload Identity pool. Its condition requires all
four signed GitHub claims:

- repository ID `1172025835`;
- repository slug `mento-protocol/monitoring-monorepo`;
- ref `refs/heads/main`;
- subject
  `repo:mento-protocol/monitoring-monorepo:environment:production-infra`.

The apply-facing service account lives in the seed project. This prevents the
routine deployer's monitoring-project `roles/iam.serviceAccountUser` grant
from becoming another path to the production applier.

The trusted-`main` refresh chain remains read-only. Its backend plans use
`-lock=false` because state-bucket `roles/storage.objectViewer` cannot create
or delete the GCS lock object. The alerts-delivery and governance-watchdog
stacks own their random project IDs, so those stacks also own the live-read
grants for `org-terraform-refresh-readonly`; the platform stack must not guess
those IDs.

Full-fidelity refresh requires more than project metadata. Each target project
grants a curated set of non-basic read roles for the services Terraform
refreshes. The guaranteed core is `roles/browser` for project metadata,
`roles/iam.securityReviewer` for Terraform-managed IAM-policy reads, and
`roles/storage.bucketViewer` for bucket metadata; each owning stack explicitly
lists any additional service-specific read roles beside those bindings. Basic
`roles/viewer` is forbidden: on uniform-bucket-level-access buckets its
`projectViewer` convenience-group membership would also grant legacy object
read access and cross the intended object-payload boundary.

GCS object and Secret Manager payload reads remain separate and exact. Each
owning stack grants
`roles/secretmanager.secretAccessor` on only its Terraform-managed secrets and
`roles/storage.objectViewer` on only its Cloud Function deployment-source
bucket or buckets. The object grants do not extend to replay, rotation-state,
or log buckets. The service-specific predefined readers can still expose
project-wide service data, including Cloud Logging entries, Monitoring time
series, and Artifact Registry contents. This is an explicit confidentiality
tradeoff: the trusted-`main` refresh identity gains those read surfaces and can
read the managed secret payloads and deployment-source objects because the
pinned Google providers read them during refresh. It still cannot mutate them,
and PR workflows cannot impersonate it.

The identity bootstrap, refresh routing, and authority removal land in three
separate PRs:

1. Merge the identity-bootstrap PR. Cancel every infrastructure apply queued
   by that merge; do not approve or reuse those runs because their repository
   variable context may predate the identity bootstrap.
2. Run an explicitly approved local platform plan and apply. This creates the
   dedicated pool/provider, production applier, trusted-main refresh chain,
   state access, and the three repository variables named above.
3. Re-run the alerts-delivery and governance-watchdog `main` workflows, review
   their plans, and approve the live-read grant applies.
4. Verify those runs and the new production apply authentication path. Keep
   the old routine-deployer Token Creator grant only as a temporary rollback
   path.
5. Land a cutover-routing PR that routes trusted-`main` plans and scheduled
   drift through `vars.GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT`. That PR retains
   the old routine-deployer Token Creator rollback grant.
6. Prove the curated role set through the checked-in `main` route. Complete a
   live full-refresh, unlocked plan (`-lock=false`, without `-refresh=false`)
   for every CI-managed Google-provider stack; the current set is
   `alerts-delivery` and `governance-watchdog`. A configuration-only validation
   or grants-only plan is insufficient. Add a missing permission only when the
   live provider error identifies it; never fall back to a basic role. Cancel
   superseded queued runs, drain every pre-routing and proof run to a terminal
   state, and confirm that the final IAM policy has no basic role and no
   object-payload grant outside the explicitly named state, deployment-source,
   and managed-secret resources.
7. Only after step 6 succeeds, land a final removal PR that deletes the routine
   deployer's `org-terraform` Token Creator grant from the platform
   configuration. Merge it, cancel superseded runs, and confirm that every
   infrastructure run is terminal. Then run a platform plan from clean current
   `main` and apply only with explicit human approval. Audit the final WIF and
   service-account IAM bindings before declaring the authority removal
   complete.

Do not create a dedicated peg-policy GCP project or bucket during this
bootstrap or routing cutover. Until the final removal has been applied, every
queued and active infrastructure run has drained, and the IAM audit proves the
old routine-deployer impersonation path is gone, that deployer can still reach
`org-terraform`; a new project would not provide the intended isolation. A
later reviewed change may create the project and bucket only after those gates
pass.

## Alternatives considered

- **Keep one write-capable deployer for service deploys, plans, and applies** —
  rejected because a routine workflow can inherit organization Terraform
  authority without proving the `production-infra` environment claim.
- **Add a stricter provider to the existing WIF pool** — rejected because the
  IAM principal namespace is pool-scoped and the older provider would remain
  an alternate issuance path.
- **Grant live-project reads to the PR plan identity** — rejected because
  checked-out PR code can execute provider, external-data, and local-exec logic.
- **Create the peg-policy project in the bootstrap PR** — rejected because the
  legacy routine-deployer impersonation path would make the apparent project
  separation ineffective.

## Consequences

- Production Terraform authentication now cryptographically includes the
  immutable repository ID, repository slug, protected `main` ref, and
  `production-infra` environment rather than relying on workflow structure
  alone.
- Trusted-`main` plans and scheduled drift can refresh live state without
  carrying apply authority. Read-only still includes sensitive state, managed
  secret payloads, and function source, so this identity remains unavailable
  to PRs.
- The staged rollout deliberately has a short period where both the legacy and
  replacement appliers can reach `org-terraform`. Queue control, terminal-run
  verification, and the later IAM audit are required parts of the cutover.
- The checked-in identity contract is a regression guard over enumerated
  Terraform identity and authority blocks, credential and secret-payload
  sinks, output and declassification sites, imperative execution, and
  protected-workflow shapes. It is not a sandbox against arbitrary HCL or
  application-source data flow, operator-supplied `-var`/`TF_VAR_*` values,
  deliberate registry changes, or a compromised provider/toolchain.
  Protected-environment approval and review of the live Terraform plan remain
  required.
- Adding a Terraform-managed project with a stricter data boundary remains a
  separate post-cutover decision and change.

## Evidence

- Identity and IAM ownership:
  [`terraform/ci-wif.tf`](../../terraform/ci-wif.tf).
- IaC-owned selectors:
  [`terraform/github-variables.tf`](../../terraform/github-variables.tf).
- Stack-local random-project grants:
  [`alerts/infra/main.tf`](../../alerts/infra/main.tf) and
  [`governance-watchdog/infra/main.tf`](../../governance-watchdog/infra/main.tf).
- Current operator sequence and identity routing:
  [`docs/terraform.md`](../terraform.md).
