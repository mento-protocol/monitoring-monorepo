---
title: Terraform Stacks
status: active
owner: eng
canonical: true
last_verified: 2026-08-30
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Terraform Stacks

`terraform.stacks.json` is the source of truth for Terraform roots; do not infer
ownership from directory names.

| Stack                    | Path                             | State prefix             | Owns                                                                                                                                                                                             | Plan/apply policy                                                                                                   |
| ------------------------ | -------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `platform`               | `terraform/`                     | `monitoring-monorepo`    | Dashboard, Grafana read identity, Upstash, monitoring GCP, Peg storage, Cloud Run shape, Aegis bootstrap, deploy buckets, CI identities, repo Actions settings, and ADR 0080 boundary resources  | Manual plan; human-approved local apply                                                                             |
| `peg-policy-publication` | `alerts/peg-policy-publication/` | `peg-policy-publication` | One immutable GCS generation of `alerts/rules/peg-thresholds.json`; no Cloud Run configuration or Grafana resources                                                                              | Credential-free PR validation; manual `main` refresh plan, then `production-infra`-approved workflow apply          |
| `alerts-rules`           | `alerts/rules/`                  | `alerts-rules`           | Protocol Grafana alert rules + Aegis service-health and testnet-health rule groups, Grafana folders, global Grafana notification policy, contact points, message templates, mute timings         | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `alerts-delivery`        | `alerts/infra/`                  | `alerts-infra`           | QuickNode webhooks, alert Cloud Functions, Sentry bridge, Slack channel lifecycle, Splunk On-Call rotation announcements, related GCP resources, and stack-local trusted-main refresh grants     | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `aegis`                  | `aegis/terraform/`               | `aegis`                  | Aegis Grafana dashboard and Aegis folder                                                                                                                                                         | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `governance-watchdog`    | `governance-watchdog/infra/`     | `governance-watchdog`    | Dedicated governance-watchdog GCP project, Cloud Function/source archive, Secret Manager, QuickNode webhook creation, scheduler, monitoring, alerts, and stack-local trusted-main refresh grants | PR plan; `main` apply through the `production-infra` GitHub Environment; daily drift plan via `terraform-drift.yml` |

## Commands

```bash
pnpm tf list
pnpm tf validate <stack-id>
pnpm tf plan <stack-id>
pnpm tf apply <stack-id> [--force-local-apply] [terraform args...]
```

Existing aliases remain:

```bash
pnpm infra:plan
pnpm infra:apply -- -auto-approve
pnpm alerts:rules:plan
pnpm alerts:infra:plan
pnpm aegis:tf:plan
pnpm gov-watchdog:tf:plan
```

The `platform` stack's Upstash provider email and management key are bootstrap
inputs: the provider cannot create the credential it needs before planning.
[ADR 0060](adr/0060-upstash-management-key-bootstrap.md) owns the narrow
human-only console integration, separate keys, and rotation order. Agents never
create, replace, or revoke those keys.

Without a stack, `pnpm tf validate` validates every registered stack. It formats
tracked and non-ignored untracked Terraform, then runs backend-free init and
validate. On Darwin, it applies the [immutable provider trust and cache
rules](notes/agent-quality-gate-mechanics.md). Land trust updates through
reviewed `main` and CI. Then refresh `origin/main` and rerun the gate. Gitignored
operator `*.tfvars` stay outside the source check.

For stacks with `ci.apply == "push-main-production-infra-environment"`, local
apply requires a clean `main` at `origin/main` unless the operator deliberately
passes `--force-local-apply`. Normally, merge and let GitHub Actions apply
through `production-infra` approval.

The manual `platform` stack has a stricter wrapper. Plan and apply both create a
private temporary saved plan from the verified current-`main` snapshot, capture
its JSON in memory, and check the Metrics Bridge service against the
source-selected stable or rollout mode. The standalone plan is a preflight and
is deleted; a later apply creates a fresh plan. Apply requires the literal
`-auto-approve` argument only as proof that the operator already received human
approval. The wrapper removes that flag, re-supplies variable inputs required
for ephemeral values, and applies the exact checked plan. A no-change plan
skips apply. The private directory is mode `0700`, the binary plan is mode
`0600`, and both are deleted after success or failure; the JSON is never
written, printed, uploaded, or cached. Every phase also forces `-input=false`,
the default workspace, and a private `TF_DATA_DIR` under the committed-source
snapshot, so interactive input or inherited workspace state cannot change the
checked execution.

The wrapper rejects caller plans, destructive/replacement modes, arbitrary
targets, unsafe lock/workspace/CLI arguments, GitHub provider overrides,
credential ingress, and caller Terraform provider-runtime state. It owns a
private mode-`0600` CLI configuration and fixed non-echo errors. Only the exact
ADR 0055 controller recovery can target or skip refresh. The guard does not
approve other changes; human preflight and apply approval remain mandatory.
[ADR 0061](adr/0061-exact-plan-guard-for-manual-platform-applies.md)
owns the exact-plan boundary.

## Controlled main lifecycle boundary

[ADR 0080](adr/0080-controlled-main-lifecycle-boundary.md) and its
[runbook](notes/local-agent-github-app-credential.md) own all phases, custody,
proof, rollback, and import deferral. Each needs approval. Initial source is
inert because its boundary resource gate gives every boundary resource count
zero and permits unrelated safe platform plans.

Source pins the boundary resource gate, repository, human Team, dedicated
Dependabot merge App, distinct local-agent App, exact dedicated-App
Contents/write, Pull requests/write, and Workflows/write permissions, managed
rule ID and enforcement, dedicated-App credential gate, #2137 exact-head REST
writer-migration evidence, legacy auto-merge request absence evidence, audit,
broker gates, and broker principal. Initial source keeps the resource gate false
and all identity and ruleset sentinels zero. After external verification, one
Phase 3 change pins all three identities and enables resources. A later change
pins the created ruleset ID. The local-agent App ID is reviewed policy, not an
operator tfvar. The dedicated App has no Actions permission.

The disabled ruleset contains creation, update, and deletion restrictions. The
`update` rule is the identity boundary. `creation` prevents delete-and-recreate
escape. `deletion` binds removal to the same actors. Core rule `13494367`
already owns `non_fast_forward` and stays unmanaged because provider `6.12.1`
loses its unattributed-change field.

The ruleset has exactly two bypass actors. The Team uses `pull_request`. The
dedicated repository-scoped Dependabot merge App Integration uses `exempt` as
the direct `main` lifecycle update actor for one synchronous exact-head REST
merge. The writer creates no standing auto-merge request. Shared GitHub Actions
App `15368`, built-in Dependabot App `29110`, and the local-agent App are
forbidden.

The dedicated App bootstrap uses two ordered source phases beside the disabled
no-op ruleset. The first creates and protects the `dependabot-merge`
Environment. It disables admin bypass and permits only the exact custom `main`
branch policy. After a human verifies that live resource, the second phase
creates `DEPENDABOT_MERGE_APP_ID` and
`DEPENDABOT_MERGE_APP_PRIVATE_KEY` as Environment secrets. The resources use
supported `value_encrypted` with one explicit Environment Actions public-key ID. Terraform
and state receive ciphertext only. A one-secret rotation keeps the key ID. A
public-key rotation updates both ciphertexts and both resource key IDs
together. The guard also permits an exact missing-secret recovery beside the
coherent disabled provisioning state or active state. If the key changed after
a partial create, the same recovery creates the missing secret and updates the
survivor's key ID and ciphertext. It rejects plaintext, deprecated
`encrypted_value`, another Environment or secret store, a partial key rotation, and unrelated
changes.

Do not add `environment: dependabot-merge` to the #2137 writer in either
bootstrap phase. A workflow reference can auto-create an unprotected
Environment. Only a separate reviewed writer change may add that reference and
consume the secrets after the protected Environment, exact branch policy, and
both secret metadata names exist live.

The plan guard permits a strengthening-only repair after Environment drift. It
requires a bounded known prior Environment shape, the provider's empty
no-policy list, or a bounded branch pattern; the exact safe source shape after
the update; an unchanged lifecycle ruleset; and no
secret or unrelated change. Stop the writer and obtain separate apply approval
before that repair.

A separate source change enables the five-resource local-agent broker scaffold
and pins its impersonator. Its first plan may create only that complete
scaffold and credential set. A reviewed recovery gate permits only the same
canonical resources as a bounded create/no-op mix after a partial apply.
Later plans use the pinned ruleset ID after cutover.

Local-agent credential activation rejects an omitted, blank, malformed,
non-RSA, weak, encrypted, or larger than 64 KiB App key. The wrapper requires
the exact unindented HCL heredoc and rejects JSON assignments of the key. It
checks canonical PEM encoding, parses and exercises the key in memory, and
emits only a fixed error. The broker keeps its PEM, JWT, and token outside
agents. Git, workflow, readiness, and transactional board lanes stay
unavailable. Stronger credentials stay outside agent OSes.

Before active enforcement, #2137 must retain `github.token` for every
authoritative read. It must wait for required checks, mint a fresh dedicated
App token after that wait, repeat the complete authoritative proof with
`github.token`, and expose the App token only to one final synchronous
exact-head REST `PUT`. Its migration PR must pin that order and token split in
a source-contract test. Every legacy writer run must finish. Every legacy
auto-merge request must be absent. Source records both writer-migration and
legacy-request absence evidence before the guard permits the active ruleset.
Live proof binds the Team path, the local-agent denial, the dedicated-App
routine merge and final actor, and an audit with
`main-lifecycle-boundary-audit state=ok`.

Vercel retains Administration plus Contents as a Free-plan residual. It can
change the rule and then `main`; drift is detective only.

`peg-policy-publication` permits only backend-free local validation with
`pnpm tf validate peg-policy-publication`. Local plan and apply are disabled,
including `--force-local-apply`. Controller recovery and the first protected
publication are complete: it created
`mento-monitoring-peg-policy/peg-policy/current.json` generation
`1785276001213660`, which the first runtime attachment used. The later protected
publication produced generation `1786443055965590`. The approved platform apply
attached that active-only generation to Metrics Bridge revision
`metrics-bridge-00196-6hg`. Post-apply proof confirmed current producer/API
packages, exactly one policy-version metric, no legacy policy labels, and all
17 Peg Grafana rules with health `ok`, unpaused, and Normal. Publication alone
never attaches a generation to Cloud Run. For a future publication, dispatch
`Peg Policy Publication` from `main`, inspect its read-only plan, then choose
`apply` and approve the `production-infra` Environment. Its output feeds a
separately reviewed runtime rollover.

## CI Model

`terraform.stacks.json` owns the coarse `workflowAdmissionPatterns` boundary.
The required `.github/workflows/ci.yml` workflow runs on every PR and applies
that boundary only to its internal Terraform job. The advisory
`.github/workflows/infra.yml` workflow copies the same boundary for push and
pull-request admission. After either route starts, `scripts/tf-stacks.mjs`
classifies the exact changed stacks from `changedPathPatterns`. `pnpm tf:test`
requires all three filters to equal the registry boundary and requires that the
boundary subsume every stack pattern. Add a new stack input under an existing
broad boundary. If it needs a new root, extend the registry boundary and all
three workflow copies in the same change. `.github/workflows/**` is the only
nested boundary. Using `.github/**` would also admit unrelated repository
metadata and actions.

`alerts-rules`, `alerts-delivery`, `aegis`, and `governance-watchdog` have CI
apply behavior on `main`, gated by the `production-infra` GitHub Environment.
Plans can also run for workflow/notifier edits. Applies require stack-owned
deployment changes or maintainer `workflow_dispatch`. Platform remains manual.
`terraform-drift.yml` runs daily plan-only checks for all four stacks.
Trusted-`main` plans and drift use the read-only refresh chain, full refresh,
and `-lock=false`. Run
[#30212385280](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/30212385280)
proved that route for `alerts-delivery` and `governance-watchdog`. The
2026-07-27 run drain, read-boundary audit, approved removal apply, clean
post-apply plan, and final IAM/WIF audit completed the cutover. Live
`org-terraform` Token Creator now contains only `production-infra-applier`.

Eligible same-repo human PR plans use safe placeholder `TF_VAR_*` values or
guarded targets; fork, Dependabot, and `sentry-autofix/*` plans are skipped.
Trusted push/dispatch refresh and gated apply remain authoritative for
full-stack, third-party-provider, and secret-value diffs. Alerts-rules and
alerts-delivery PR plans are intentionally partial.
See [`docs/notes/terraform-secret-strategy-2026-07.md`](notes/terraform-secret-strategy-2026-07.md)
for the exact placeholder and target boundaries.

Alloy's full write-only input, IAM, deploy, and rollback contract lives in
[`aegis/grafana-agent/README.md`](../aegis/grafana-agent/README.md). Platform
plan/apply rejects unsafe logging, requires freshly fetched clean `main`, and
runs its verified snapshot with gitignored tfvars outside. Review the manual
source snapshot; it copies each variable file once into the private plan
directory for plan and apply. Review the manual plan and get explicit approval before
`pnpm infra:apply -- -auto-approve`; never seed via CLI or use `--migrate`.

On `main`, the workflow posts a secretless Slack summary before approval.
Environment protection blocks the apply job, so the operator approves the
commit and earlier plan. Apply then creates and uses a later plan, leaving an
explicit drift window.

`Terraform Deploy Queue Watch` only warns after 60 minutes without a job start;
it never cancels or approves. Inspect the whole queue, cancel only an obsolete
predecessor, repeat approval if the plan creates the apply job later, and follow
every queued `main` run to terminal state. After apply, verify the live resource
and dispatch `terraform-drift.yml` from `main`. For manual-only platform repo
settings such as default workflow-token permission, dispatch
`platform-settings-drift.yml` instead. Channel routing lives in
[`docs/notes/slack-github-subscriptions.md`](notes/slack-github-subscriptions.md).

## Terraform CI identities

[ADR 0047](adr/0047-separated-terraform-ci-identities.md) owns the five lanes:
routine deploy, state-only same-repo PR plan, read-only trusted-`main` refresh,
the workflow-only Peg policy publication plan, and Environment-bound production
apply. All three WIF providers bind repository slug and immutable ID
`1172025835`; apply also binds protected `main` and the `production-infra`
subject, while refresh uses an exact `workflow_ref` allowlist. The identity
contract gives the publication workflow its dedicated plan account and keeps
the other trusted-main plans on the shared refresh account.

Trusted-main plans use `-lock=false` and curated non-basic readers. Run
#30212385280 completed the required full-refresh proof; the later run-drain and
read-boundary audits also completed. Never add basic `roles/viewer`; limit
object and secret payload reads to state, deployment source, and managed
secrets.

ADR 0047 selects the final no-artifact protected-stack apply contract: make a
private plan after approval, run fail-closed policy over its JSON, then apply
those exact bytes. ADR 0061 implements the first narrow slice for manual
platform plan/apply by guarding the Metrics Bridge template, ADR 0055 recovery,
and ADR 0080 lifecycle rules through
`check-main-lifecycle-boundary-plan.mjs`. Issue #1576 owns the broader policy. The
other apply paths retain their documented apply-time re-plan window.

The first local-agent broker-scaffold apply requires all five creates. If that
apply saves only part of the scaffold, use the reviewed partial-recovery source
gate in the App credential runbook. It permits only canonical create/no-op
scaffold members with a disabled no-op lifecycle ruleset and no unrelated
action. Do not use a direct retry, target, import, replacement, or manual state
edit.

When the App credential is active, the platform wrapper reads the key only from
its private mode-`0600` HCL tfvars copy. It rejects JSON key assignments. It
checks canonical PEM syntax and base64 pad bits, verifies an exact decode and
re-encode round trip, parses and exercises a 2048-bit-or-stronger RSA key in
memory, and emits only a fixed error for invalid input. It does not pass the key
in argv or the environment and does not persist another copy. The exact
activation and recovery procedures are in
[`docs/notes/local-agent-github-app-credential.md`](notes/local-agent-github-app-credential.md).

## Identity bootstrap, routing cutover, and authority removal

Routing and IAM audit complete. Removal: `0 added, 1 changed, 1 destroyed`;
plan clean; IAM has no `metrics-bridge-deployer` Token Creator grant. Platform
owns private buckets and identities; protected `peg-policy-publication` writes
the policy object.
Metrics Bridge uses the dedicated runtime identity. The first runtime attachment
pinned generation `1785276001213660` through paired `PEG_POLICY_*` values; the
current runtime pins active-only generation `1786443055965590` through the same
paired values. Publication itself attaches neither Cloud Run nor Grafana
consumers. The approved platform apply attached the current pin; the separate
alerts-rules source change and approved apply activate Grafana.
Terraform derives the pinned URL and `gcp-metadata` mode from that literal.
The checked-in platform source is back in steady state: the template-rollout
marker is `false`, and Terraform ignores the generated revision name.
Metrics Bridge ignores `template[0].revision` in steady state so routine plans
do not clear the generated name stamped by deploys. Any Terraform-owned
template change, including a policy-generation handoff, sets
`metrics_bridge_template_rollout_active = true` and removes that ignore in the
same reviewed change. Provider 6.50 then omits the old name and Cloud Run can
mint the new revision. After the approved apply and runtime proof, a separate
stabilization change restores the marker to `false` and the ignore. Buckets,
runtime, and publisher are in `mento-monitoring`; publication plan and reader
are in the seed project. Only the exact publication workflow selects that
read-only chain. Runtime and reader have direct bucket-scoped Object Viewer;
publisher has direct Object Admin.

Pause unrelated full platform applies while the rollout marker is `true`. If
the rollout apply or runtime proof fails, leave the revision ignore absent,
inspect the live revision and state, and produce a new reviewed plan. Complete
the rollout or explicitly roll back its template change before restoring the
steady-state marker and ignore. A successful rollout's immediate stabilization
changes source only and needs no apply.

Authoritative bucket policies keep direct grants exact.
`pegPolicyBucketController` gives org-Terraform only bucket get/update and
IAM-policy get/set on both buckets. Project and organization grants still
inherit; project Owner and organization IAM admins are emergency paths. Never
retain a project-level controller or use broad Storage Admin, Storage Object
Admin, or Service Account User. Audit effective access after applies and before
activation.

### Peg policy bucket controller recovery

The one-time recovery is complete. Any future recovery must follow the
explicitly approved procedure and proof in
[ADR 0055](adr/0055-peg-policy-bucket-controller-recovery.md) from clean current
`main`. Never use `roles/storage.admin`.

## Routine deployment source staging

[ADR 0053](adr/0053-explicit-deployment-source-staging.md) owns the source
upload boundary for routine GCP deploys. The platform stack creates:

- `mento-monitoring-cloud-build-source` in `var.gcp_region`, with a 7-day live
  object lifecycle;
- `mento-monitoring-app-engine-source` in `US`, with a 30-day live object
  lifecycle for App Engine's content-addressed source cache.

Both buckets use uniform access, enforced public-access prevention, disabled
soft-delete retention, `force_destroy = false`, and Terraform
`prevent_destroy`. Cloud Build callers can read bucket metadata and create
objects. The dedicated Alloy `grafana_agent_builder` and
`metrics-bridge-builder` can view Cloud Build source objects; the Alloy builder
is also an App Engine uploader. Both Metrics Bridge route canaries passed. The
follow-up cleanup removes the legacy default Compute executor
`80554359692-compute@developer.gserviceaccount.com` from the direct Cloud Build
source-bucket Object Viewer set. App Engine uploaders have Object Admin only on
the App Engine source bucket because the CLI can replace or clean up cached
hash-named objects. AppSpot can view those objects. Default Compute has no direct
App Engine source-bucket grant in this stack.

App Engine also writes its service-owned
`staging.mento-monitoring.appspot.com` bucket during a deploy. The App Engine
uploaders and default AppSpot service account have Storage Admin on that one
bucket only, as required for version submission and the internal staging path.
They have no project-wide Storage Admin grant and do not receive Storage Admin
on either Terraform-managed source bucket.

The routine deployer and `gcp_dev_members` have Service Account User only on the
dedicated Metrics Bridge runtime identity and dedicated builder. They have no
default-Compute or project-wide Service Account User grant.

Apply the direct-reader cleanup only from clean current `main`, after reviewing
a full platform plan and obtaining explicit approval. Verify that the direct
bucket policy no longer lists default Compute and still lists both dedicated
builders, then verify the live Cloud Run revision. Default Compute's separate
project-level Editor role may still grant inherited Storage access and remains
outside this cleanup. [ADR
0058](adr/0058-metrics-bridge-dedicated-cloud-build-executor.md) owns that
boundary.

The five approved checked-in `gcloud builds submit` / `gcloud app deploy`
calls use their required source-staging flag/value. `pnpm tf:test` enforces that
inventory; [ADR 0053](adr/0053-explicit-deployment-source-staging.md) defines
the supported static syntax and deliberate proof limits.

The original source-bucket rollout, five route canaries, ADR 0054 policy
foundation, broad-role removal, and effective-IAM audit are complete. ADR 0058's
additive Metrics Bridge builder is applied and verified, the checked-in build
config pins it, and both route canaries passed. The separate approved cleanup
apply removes only default Compute's direct Cloud Build source-bucket Object
Viewer.

## Platform GitHub Actions secrets and variables

The manual-apply platform stack owns repository Actions mirrors in
`terraform/github-secrets.tf` and `terraform/github-variables.tf`. Clearing an
optional input can plan deletion; inspect each one. It also owns
`GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER`,
`GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT`,
`GCP_TERRAFORM_REFRESH_WORKLOAD_IDENTITY_PROVIDER`, and
`GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT`. Workflows read these as `vars`; never
replace them with manual secrets or use the refresh selectors outside the five
registered trusted-main plan workflows and `terraform-drift.yml`.
Only `CLAUDE_CODE_OAUTH_TOKEN` currently has `prevent_destroy`; inspect every
planned mirror deletion.
Sentry credential routing lives in
[`docs/notes/sentry-triage-pipeline.md`](notes/sentry-triage-pipeline.md).

## GitHub Environments

The three current shared Environments are Terraform-managed in
`terraform/github-environment.tf`. The source-gated `dependabot-merge`
Environment is managed in
`terraform/github-dependabot-merge-app-credentials.tf`. All four restrict deployments with an **explicit
`main` branch pattern** (`custom_branch_policies = true` plus a
`github_repository_environment_deployment_policy`), never
`protected_branches = true`.

> **Use the branch pattern, not `protected_branches` (issue #1649).**
> `protected_branches = true` only admits branches covered by **classic** branch
> protection. This repo protects `main` with a **ruleset** and has no classic
> protection — `GET /repos/:o/:r/branches/main/protection` returns
> `404 Branch not protected` — so that policy matched nothing and **failed
> open**: off-main runs reached environment secrets. `GET .../branches/main`
> reporting `"protected": true` (rulesets count there, the deployment policy
> does not read it) is what made the broken config look correct. An explicit
> branch pattern does not depend on classic protection.
>
> `scripts/verify-github-environment-protection.mjs` enforces this shape before
> cloud auth, and reads the deployment-branch-policy allow-list itself so an
> empty or over-broad pattern set cannot pass.

`production-infra` has a required reviewer, self-review allowed, and admin
bypass disabled; its workflows verify that state before cloud auth. With one
maintainer this is operator acknowledgement, not independent or exact-plan
review. [ADR 0029](adr/0029-ci-apply-production-infra-gate.md) records the
decision against a same-owner `CODEOWNERS` gate; revisit PR approval,
latest-push approval, and disabled Environment self-review when a second active
maintainer exists. The reviewer rule is enforced independently of the branch
policy, so it held even while that policy was inert.

`production-services` records routine deploys from `main` without a reviewer.

`production-infra` and `production-services` were UI-managed until #1649. They
are bound to Terraform with an explicit state import — the identity contract
forbids top-level `import` blocks — before the first apply that owns them:

```bash
terraform -chdir=terraform import \
  github_repository_environment.production_infra monitoring-monorepo:production-infra
terraform -chdir=terraform import \
  github_repository_environment.production_services monitoring-monorepo:production-services
```

After importing, their plan must read `0 to add, N to change, 0 to destroy`. A
diff that drops `production-infra`'s `reviewers` would remove the production
apply gate — do not apply it.

`sentry-pipeline` (`terraform/github-environment.tf`, issue #1289,
[ADR 0050](adr/0050-environment-scoped-pipeline-secrets.md)) gates the Sentry
triage/autofix pipeline's exclusive secrets. It has the same `main`-only branch
pattern, admin bypass disabled, and — deliberately, the pipeline is unattended —
no reviewer or wait timer. Every platform apply reconciles its policy and
secrets. Every secret-bearing Sentry job declares it, so those secrets are
reachable only from `main`, server-enforced even on a branch-modified
`workflow_dispatch`. `CLAUDE_CODE_OAUTH_TOKEN` intentionally stays repo-level
for `claude.yml`.

`dependabot-merge` (issue #2091, ADR 0080) has admin bypass disabled, no
reviewer, and one exact custom `main` branch policy. Its only secret metadata
names are `DEPENDABOT_MERGE_APP_ID` and
`DEPENDABOT_MERGE_APP_PRIVATE_KEY`. The daily platform-settings audit reads
only the Environment, deployment-policy, and secret-name metadata. It never
reads a public key or secret value.

Never recreate retired `Production`/`production` names or manage
Environment secrets outside their owning IaC/integration path. A new workflow
reference can auto-create an unprotected Environment, so establish its
protection before merging the reference.

## Grafana Alert Ownership

The Aegis-to-alerts state migration is complete; do not rerun its import/state
removal procedure. Current ownership is:

- `alerts-rules` owns protocol rule groups, Aegis service-health and
  testnet-health rule groups, protocol folders, the global Grafana notification
  policy, contact points, message templates, and mute timings.
- `aegis` owns only the Aegis Grafana folder and Aegis dashboard.
- `platform` owns no Grafana alert or dashboard resources. It configures the
  Grafana provider for one purpose — minting the dashboard's read-only Viewer
  service account and token in `terraform/grafana-read-access.tf` and delivering
  that token to the Vercel project it already owns
  ([ADR 0063](adr/0063-dashboard-grafana-history-read-access.md)). Its
  `grafana_provisioning_token` input is the same organization Admin credential
  the two stacks above take as `grafana_service_account_token`; the minted
  Viewer token never provisions anything.

Use each stack's maintained `terraform.tfvars.example` (or
`aegis/terraform/variables.tf`) instead of copying inputs from this overview.

Verify ownership and drift with:

```bash
terraform -chdir=alerts/rules state list | grep -E 'grafana_(rule_group|notification_policy|contact_point|message_template|mute_timing|folder)'
terraform -chdir=aegis/terraform state list | grep grafana_rule_group
pnpm alerts:rules:plan
pnpm aegis:tf:plan
```

Expected result: protocol rule groups, global routing resources,
`grafana_rule_group.aegis_service_alerts`, and
`grafana_rule_group.aegis_testnet_health` appear only in `alerts-rules`; the
`aegis` state contains only the Aegis folder + dashboard resources (the
`grep grafana_rule_group` against `aegis` returns nothing).
