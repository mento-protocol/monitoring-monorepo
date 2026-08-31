---
title: GitHub App credentials and controlled main lifecycle cutover
status: active
owner: eng
canonical: true
last_verified: 2026-08-30
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# GitHub App credentials and controlled main lifecycle cutover

This runbook activates the target state in
[ADR 0080](../adr/0080-controlled-main-lifecycle-boundary.md). Checked-in source
does not prove any GitHub, Google Cloud, host, or cloud-agent state.

Stop at each approval boundary. Do not combine Team setup, either App setup,
source merge, Terraform plan, Terraform apply, writer migration, legacy drain,
host installation, credential cutover, ruleset activation, live proof, or drift
activation.

## Required outcome

The completed cutover has these properties:

- core ruleset `13494367` remains unchanged and unmanaged;
- a separate active ruleset restricts creation, update, and deletion of
  `refs/heads/main`;
- the reviewed boundary resource gate is true after cutover;
- that ruleset has exactly two bypass actors: the source-pinned Team in
  `pull_request` mode and the dedicated Dependabot merge App Integration in
  `exempt` mode;
- the dedicated merge App is installed only on this repository and has exactly
  Contents write, Pull requests write, and Workflows write, with no Actions
  permission;
- the selected-repository local-agent App has no Administration permission and
  no ruleset bypass;
- the #2137 final writer performs one synchronous exact-head REST merge through
  the dedicated App, and no legacy `GITHUB_TOKEN` auto-merge request remains;
- each agent operation receives one fixed least-privilege profile;
- the App PEM, JWT, and installation token remain inside the trusted broker;
- the dedicated agent OS or container has no human or platform credential;
- every writable cloud-agent surface uses a proved App installation identity;
- Vercel Administration-plus-Contents remains an explicit Free-plan residual;
- live proof records a local-agent App permission-ceiling denial, exact live
  ruleset JSON, an approved Team merge, and one routine Dependabot merge under
  the dedicated App;
- the daily audit reports `main-lifecycle-boundary-audit state=ok`.

## Source and live-state boundary

Repository tests can prove parser, policy, profile, redaction, and plan-shape
behavior. They cannot prove these external facts:

- Team membership;
- either App registration or selected-repository installation;
- either App permission registration;
- the live ruleset IDs or JSON;
- Terraform apply completion;
- root ownership and modes on the broker host;
- the broker OS identity or Google credential;
- removal of a human credential from an agent host;
- a cloud platform's credential type;
- the Vercel plan constraint;
- the local-agent App's live permission registration and a permission-denied
  merge or `main` update attempt;
- the #2137 final writer's read and final-write authentication identities;
- the final App merge actor and merge commit;

Record each live fact separately. Do not infer it from source, a plan, an App
name, an installation ID, or a successful read request.

## Credential boundary

Use two separate GitHub Apps. Install each only on
`mento-protocol/monitoring-monorepo`. The dedicated Dependabot merge App is the
sole automation bypass. It has exactly Contents write, Pull requests write, and
Workflows write. Workflows write permits the #2137 top-level workflow-update
lane. It has no Actions permission.
The local-agent App has no Administration permission and no ruleset bypass.
The local-agent App registration is the broker permission ceiling. The trusted
broker requests the smaller profile needed by one operation.

| Profile             | Purpose                                            | Maximum requested authority             |
| ------------------- | -------------------------------------------------- | --------------------------------------- |
| `read`              | Repository, PR, issue, and workflow-run REST reads | Actions, Issues, and Pull requests read |
| `pr-issue-write`    | Approved PR and issue mutations                    | Issues and Pull requests write          |
| `git-publish`       | Future feature-branch publication                  | Contents write; source-disabled         |
| `issue-board-write` | Future transactional claim/release                 | Exact #2111 authority; source-disabled  |

Do not give a read operation write authority. Do not let an agent add a
permission to a profile.

`git-publish` is source-disabled. The broker does not run Git in an
agent-controlled repository. Activation requires a root-owned clean mirror or
another reviewed trusted implementation that removes repository config, hooks,
helpers, URL rewrites, proxy settings, extra headers, and every token-bearing
caller child. Use the separate human publication lane until that proof exists.

`issue-board-write` is source-disabled. It has no active operation until merged
#2111 source pins the exact lock namespace and the trusted broker implements the
whole transaction. Generic issue comments cannot use the reserved claim,
review, or release prefixes. Never run a repository script with the token.

Workflow write is not a normal profile. It requires a root-owned,
human-controlled capability that ordinary agent input cannot select, create,
replace, or extend. The capability names one bounded publication. Remove it
after the operation. If the host cannot enforce this boundary, leave workflow
publication unavailable and use the separate human publication path.

The trusted broker performs the operation. It does not return a token for an
agent command to use. It returns only the normalized fields defined for that
operation. It uses fixed executable paths and a minimal environment. It
rejects caller `PATH`, `NODE_OPTIONS`, proxy variables, loader variables, gh
configuration, Git credential configuration, keychain helpers, SSH agents,
unknown operation fields, unknown profiles, and a different repository.

The local-agent App private key stays in Secret Manager after provisioning. The
dedicated Dependabot merge App key stays only in the ciphertext-backed
`dependabot-merge` Environment secret from Phase 4A. The broker creates the
local-agent App JWT and installation token in memory. None of the three
local-agent values may reach stdout, stderr, returned JSON, a temporary file,
the agent process, or a caller-controlled child.

Checked-in source keeps the broker scaffold absent. The reviewed scaffold and
partial-recovery gates are false, and the impersonator is empty. A separate
Phase 4B source change must enable the complete scaffold and pin its one
impersonating service account before the credential plan can pass. The recovery
gate stays false during the ordinary all-five create.

## Accepted residuals

### Exempt App audit record

The dedicated Dependabot merge App uses `exempt` bypass mode because it is the
direct `main` lifecycle update actor for the trusted writer's one synchronous
exact-head REST merge. The writer creates no standing auto-merge request.
GitHub does not create a ruleset bypass-request record for an exempt actor.
Bind each proof to the trusted writer run, workflow commit, App and installation
IDs, pull request, exact head SHA, final App merge actor, and merge commit.

### Vercel Free plan

The Vercel GitHub integration retains Administration and Contents permissions.
The Free plan does not provide the narrower control required by this cutover.
Vercel can change or remove the lifecycle ruleset and then update `main`.

Record these facts in the activation evidence:

- the Vercel installation identity;
- the selected repository;
- current Administration and Contents permissions;
- the Free-plan restriction;
- the human owner who accepted the residual;
- the follow-up trigger when a plan or product change permits separation.

The daily ruleset audit detects a later settings change. It does not prevent
one.

### Protected platform readers

The existing protected `org-terraform` project Owner and the
Environment-gated `production-infra-applier` impersonation path can read
Secret Manager payloads. They remain in the App-key blast radius. They stay
outside every agent OS and command surface.

### Organization Projects

An organization Projects grant can reach every Project visible to the App. A
selected-repository installation does not limit this organization permission
to Project 12. Request the grant only in the issue-board profile and only if
the final #2111 implementation needs it.

## Phase 0: settle prerequisites

1. Merge #2137 with its default-branch `workflow_run` final-writer boundary.
   Its interim writer may use the restricted `GITHUB_TOKEN`.
2. Merge #2111 and #2131 through their own reviewed paths.
3. Rebase this boundary source on the resulting current `main`.
4. Record every current #2137 writer run and each open Dependabot pull request
   with an auto-merge request. This is the legacy-writer baseline.
5. Keep lifecycle enforcement disabled. The later dedicated-App migration and
   legacy drain must complete before activation.

The boundary source merges with
`controlled_main_lifecycle_resources_enabled` false, zero identity and ruleset
sentinels, and all phase gates false. Terraform therefore plans zero lifecycle,
dedicated-App credential, or local-agent broker resources. The exact guard
still permits unrelated safe platform plans. This source merge does not
authorize a Team, App, credential, ruleset apply, writer migration,
cancellation, or live setting change.

## Phase 1: create the human Team

A human organization administrator creates one new Team with the exact slug
`merge-operators`. Grant it the built-in Write repository role. Write is the
least built-in role that can push and merge pull requests. Do not grant
Maintain or Admin. If the organization uses a custom role instead, a human must
select and record it during activation. The custom role must be based on Write
and must not include repository-administration or ruleset-edit authority. Limit
membership to approved humans. Record the exact slug, numeric Team ID, members,
repository role, actor, and time.

Verify the Team slug is exactly `merge-operators`. Keep the verified numeric ID
in the private activation record until Phase 3.
Do not create an intermediate source state with one positive identity and the
resource gate false. Do not use a slug, node ID, user ID, App ID, installation
ID, tfvar, repository variable, or environment variable as the bypass
authority.

The repository-scoped platform PAT must not gain organization or Team
administration for this phase.

## Phase 2: create and install both Apps

### Phase 2A: dedicated Dependabot merge App

A human security administrator creates a new dedicated App. Install it only on
`mento-protocol/monitoring-monorepo`. Grant exactly Contents write, Pull
requests write, and Workflows write. Workflows write is required for the #2137
top-level workflow-update lane. Do not grant Administration, Actions, Checks,
Issues, or organization permissions. Require an App ID different from shared
GitHub Actions App `15368`, built-in Dependabot App `29110`, and the local-agent
App. Record:

- App ID and installation ID;
- selected repository;
- exact registered permission map;
- absence of Administration and organization permissions;
- the owner and time of the check.

Do not generate a private key yet. Phase 4A first creates and protects the
`dependabot-merge` Environment. The operator can read that Environment's
Actions public key only after it exists. Generate and encrypt the App key in
the later credential step so plaintext custody stays short.

Keep the positive App ID and exact permission map in the private activation
record until Phase 3. Keep `dependabot_merge_app_credentials_enabled`,
`dependabot_merge_writer_migration_verified`, and
`legacy_dependabot_auto_merge_drained` false in source.

### Phase 2B: local-agent App

A human security administrator creates a separate local-agent App and installs
it only on this repository. Grant only Actions read, Issues write, and Pull
requests write. Do not grant Administration, Contents, Workflows, Checks, or
organization Projects. The disabled Git and issue-board profiles need a
separate reviewed App-permission change and activation proof. Record:

- App ID and installation ID;
- selected repository;
- registered permission ceiling;
- absence of Administration;
- absence of a ruleset bypass;
- the owner and time of the check.

Keep the positive local-agent App ID in the private activation record until
Phase 3. Do not supply it through a tfvar, repository variable, environment
variable, or plan input. Keep it different from the dedicated merge App ID.

Prepare a mode-`0700` operator-owned intake directory before key generation.
Keep it outside repositories, worktrees, agent homes, shared temporary paths,
sync roots, and backup roots. Configure the browser to use that directory.

Generate one key. Require one regular operator-owned PEM file. Set its mode to
`0600` before transfer. Do not print its contents. Transfer it once into the
mode-`0600`, gitignored operator platform tfvars file. Use the exact unindented
literal heredoc from `terraform/terraform.tfvars.example`. The opening marker,
PEM lines, and closing marker must start at column 1. Do not use an argument,
environment variable, command substitution, clipboard history, repository
file, log, or extra temporary file.

Do not assign `local_agent_github_app_private_key` in a `.tfvars.json` file.
The wrapper rejects every JSON assignment of this variable, including one that
a later HCL variable file would override. This rejection applies while
credential activation is false. JSON variable files can still supply unrelated
variables.

Remove the browser download and any partial copy after the operator tfvars copy
is verified. If custody or complete removal is uncertain, revoke the key and
start again. File deletion does not revoke a key.

## Phase 3: create the disabled lifecycle ruleset

Make one reviewed source change that replaces all three identity sentinels and
enables the boundary resource gate. Do not merge an intermediate identity
state. The resulting policy has:

- `controlled_main_lifecycle_resources_enabled` true;
- the verified positive Team ID;
- the verified positive dedicated Dependabot merge App ID;
- the verified positive and distinct local-agent App ID;
- the exact dedicated-App Contents/write, Pull requests/write, and
  Workflows/write permission map;
- managed lifecycle ruleset ID `0`;
- enforcement disabled;
- `dependabot-merge` Environment disabled;
- dedicated-App credentials disabled;
- exact-head REST writer-migration evidence false;
- legacy auto-merge request absence evidence false;
- drift audit inactive;
- broker scaffold disabled;
- broker partial recovery disabled;
- broker impersonator empty.

From a clean current-`main` operator checkout, run the guarded platform
preflight. The exact policy must permit one creation only. Require:

- no prior value at the managed lifecycle resource address;
- enforcement disabled;
- exact `refs/heads/main` targeting;
- creation, update, and deletion rules only;
- exactly one source-pinned Team bypass in `pull_request` mode;
- exactly one source-pinned dedicated Dependabot merge App Integration bypass
  in `exempt` mode;
- no shared GitHub Actions App, built-in Dependabot App, local-agent App,
  administrator, role, user, or third bypass;
- no core ruleset resource;
- no action for core ruleset ID `13494367`;
- no broker service account, secret, credential version, accessor binding, or
  impersonation binding;
- no `dependabot-merge` Environment, deployment policy, or dedicated-App
  Environment secret resource;
- no replacement, deletion, unknown managed field, or second ruleset.

Require the lifecycle ruleset create to be the plan's only non-no-op action.
The exact plan guard rejects any broker or unrelated change in this phase.

Review the full plan. Obtain separate apply approval. Run the guarded apply
from the same clean current-`main` source. Do not use direct Terraform apply.

Read the new live ruleset ID through the human Administration-read surface.
Require a positive ID different from `13494367`. Pin it in a reviewed source
change. Keep `controlled_main_lifecycle_resources_enabled` true. Repeat the
guarded plan. It must be a no-op for the disabled ruleset.

## Phase 4A: create the Environment, then install the App secrets

Start with a reviewed Environment source change. Set
`dependabot_merge_environment_enabled` to true. Keep
`dependabot_merge_app_credentials_enabled` false. Keep the pinned lifecycle
ruleset disabled and unchanged. Keep writer-migration evidence, legacy drain
evidence, and the drift audit false.

Review the guarded plan. Require exactly these two creates beside the disabled
no-op lifecycle ruleset:

- `github_repository_environment.dependabot_merge[0]`, with
  `can_admins_bypass = false`, `protected_branches = false`, and
  `custom_branch_policies = true`;
- `github_repository_environment_deployment_policy.dependabot_merge_main[0]`,
  with the exact branch pattern `main`.

Require no secret, workflow, ruleset, or unrelated change. Obtain separate
apply approval. Apply the checked plan. Read the live Environment and branch
policies. Require admin bypass false, custom policies true, protected branches
false, and exactly one policy with type `branch` and name `main`.

Only after that live proof, generate one App private key through the human
GitHub surface. Keep the PEM in a mode-`0700` operator-owned intake directory
and mode-`0600` file outside repositories, agent homes, shared temporary paths,
sync roots, and backup roots. Do not print it. Read the `dependabot-merge`
Environment Actions public key and key ID through an approved read-only path.
Encrypt the App ID and private key locally with that public key. Put only the
public key ID and two sealed-box base64 ciphertexts in the gitignored operator
tfvars file. Remove the transient PEM after the ciphertext copy is verified.
Revoke the key and start again if custody or removal is uncertain.

Use a second reviewed source change to set
`dependabot_merge_app_credentials_enabled` to true. The Environment gate stays
true. Review the guarded plan. Require the Environment and branch policy to be
no-ops. Require exactly these two creates:

- `github_actions_environment_secret.dependabot_merge_app_id[0]` with secret
  name `DEPENDABOT_MERGE_APP_ID`;
- `github_actions_environment_secret.dependabot_merge_app_private_key[0]` with
  secret name `DEPENDABOT_MERGE_APP_PRIVATE_KEY`.

Both secrets must name `dependabot-merge` and depend on its exact branch policy.
They use only `key_id` and `value_encrypted`. They must never use `value`,
`plaintext_value`, or deprecated `encrypted_value`. Require one shared public
key ID, bounded base64 ciphertexts, no other secret store, and no unrelated
change. The wrapper rejects both ciphertexts in `TF_VAR_*` and CLI `-var`
inputs. Obtain separate apply approval. Apply the checked plan. Read only the
resulting secret names and metadata. Do not read, print, or reconstruct a
secret value.

Do not add `environment: dependabot-merge` to the writer in either source
change. Create and protect the `dependabot-merge` Environment, then install its
Environment secrets. Only a separate reviewed writer change may declare
`environment: dependabot-merge` and consume them after both live proofs. Adding
the reference earlier can auto-create an unprotected Environment.

If the secret apply creates only one secret, record the failure. Replan with
the same reviewed source and inputs. The guard permits only the existing exact
secret as a no-op and the missing exact secret as a create. Stop if the plan
updates, replaces, deletes, or touches another resource. If GitHub rotated the
Environment Actions public key before this retry, re-encrypt both values with
the current key. The guarded recovery must create the missing secret and update
the surviving secret together. Both after-values must use the same new key ID.
The surviving key ID and ciphertext must both change.

After activation, do not disable the lifecycle ruleset to restore a secret that
GitHub lost or an administrator deleted. Stop the writer. A coherent active
source state permits only the missing exact secret or pair as creates beside
the active no-op ruleset. Review and apply that recovery alone. Verify secret
metadata, then repeat the dedicated-App writer proof before re-enabling it.

Before a later rotation, fetch the current Environment Actions public key and
key ID. A one-secret rotation keeps the same key ID and changes only that
ciphertext. A public-key rotation changes both secret resources, both
ciphertexts, and the shared key ID together. The guard rejects every partial
key rotation.

If the daily audit finds a widened Environment control or branch pattern, stop
the writer. Keep the source gates unchanged. Review a guarded platform plan
that changes only the bounded unsafe Environment or deployment-policy value to
the exact source shape beside the no-op ruleset. The guard accepts a known
boolean Environment shape, the provider's empty no-policy list, or a bounded
branch pattern as the prior value. It
requires admin bypass false, custom policies true, protected branches false,
and exact branch `main` after the repair. It rejects an unknown identity,
malformed prior shape, widening update, destructive action, secret change, or
unrelated change. Obtain separate apply approval and repeat the live audit.

## Phase 4B: provision the local-agent App key and broker principal

Start with a separate reviewed source change. Set the broker-scaffold policy
gate to true and pin the one approved broker impersonating principal. Keep the
gate and principal in reviewed source. Do not select either from a tfvar,
repository variable, or environment variable. The managed lifecycle ruleset
ID must already be positive and pinned.

Use the operator tfvars file for the installation ID, positive rotation
counter, credential-active selector, and App key. The App ID stays in reviewed
policy source. When the selector is
true, Terraform accepts only canonical base64 lines and unused pad bits in an
RSA PKCS#1 or unencrypted PKCS#8 PEM envelope no larger than 65,536 bytes. The
platform wrapper reads that value from its private tfvars copy. It normalizes
the PEM body and requires an exact base64 decode and re-encode round trip. It
then parses the key with Node `crypto.createPrivateKey`, requires a
2048-bit-or-stronger RSA key, and performs one RSA-SHA256 private operation in
memory. An omitted, blank, malformed, non-RSA, weak, encrypted, or oversized
key fails with a fixed error before apply. The key remains sensitive and
ephemeral. It does not enter a managed-resource lifecycle condition, output,
log, plan, or state.

The platform wrapper rejects the App key and platform GitHub PAT in
`TF_VAR_*`, ambient GitHub authentication, and CLI `-var` arguments. It copies
the variable file once into its private plan directory. It does not create a
second key copy or pass the key to a child through argv or the environment.
Terraform sends the key only to the write-only Secret Manager field.

Review the guarded plan. Require only the expected service account, secret,
write-only version, accessor binding, and exact impersonation binding as
non-no-op actions. All five resources must be created together. The disabled,
pinned lifecycle ruleset must be unchanged. The exact plan guard rejects a
partial scaffold, an unrelated change, or broker provisioning while the source
gate is false. Obtain separate apply approval. Apply the checked plan. Remove
any obsolete operator key copy only when the approved rotation and recovery
process no longer needs it. Revoke the key if custody becomes uncertain.

The guard also checks each planned value. It pins project
`mento-monitoring`, the broker account ID, display name, description, Secret
Manager secret ID, two labels, automatic Google-managed replication, exact
Secret Accessor binding, and exact Service Account Token Creator binding. The
credential version must use `secret_data_wo`, `DISABLE` deletion policy, and
the next positive rotation counter. The plan configuration must reference the
canonical project, service account, and secret resources. Only the pinned
provider-computed IDs, names, timestamps, etags, and version number may remain
unknown during creation. A rotation may replace only the credential version
through `secret_data_wo_version`.

### Phase 4B partial-apply recovery

Terraform apply is not an atomic five-resource transaction. If it stops after
one to four scaffold creates succeed, do not retry through the ordinary apply
lane. Do not delete, replace, import, or edit state. Preserve the operator
tfvars file and key custody. Record the failed command, plan summary, completed
resource addresses, error, actor, and time.

Use a separate reviewed source change to set
`local_agent_github_broker_partial_recovery_enabled` to `true`. Keep the
scaffold enabled. Keep the managed lifecycle ruleset ID pinned, its enforcement
disabled, and the audit inactive. Preserve the current reviewed values of the
Dependabot credential, writer-migration, and legacy-drain gates. Phase 4A
normally leaves the credential gate true before this recovery can run. The
recovery gate does not force any of those independent values. From clean
current `main`, run the guarded plan with the same operator tfvars file.
Require:

- exactly the five canonical scaffold resource addresses;
- one to four `create` actions for missing members;
- one to four same-shape `no-op` actions for members already in state;
- the pinned disabled lifecycle ruleset as a no-op;
- no update, replacement, deletion, target, refresh exception, or unrelated
  action.

The recovery gate rejects an all-five create. Return the source gate to false
and use the ordinary Phase 4B lane if no member exists. Stop and request a
separate state-recovery design if the plan cannot represent the live resources
as this exact create/no-op mix.

Review the full recovery plan. Obtain separate approval for its apply. Repeat
the same bounded recovery plan after another partial failure. After a successful
apply, require an all-five no-op plan. Use a final reviewed source change to set
the partial-recovery gate to `false`. Require another no-op plan before any
other platform change or lifecycle activation.

## Phase 5: install the trusted host boundary

This repository does not install or prove the root-owned broker service. A
human host administrator must verify:

- a dedicated broker OS identity;
- `/usr/local/libexec/mento-local-agent-github-broker`,
  `/usr/local/libexec/mento-local-agent-github-broker.mjs`, and
  `/usr/local/libexec/mento-local-agent-github-command-policy.mjs`;
- `/usr/local/libexec/mento-node-runtime/bin/node`,
  `/usr/local/libexec/google-cloud-sdk/bin/gcloud`, and
  `/usr/local/libexec/mento-python-runtime/bin/python3`;
- root ownership, required execute bits, non-writable parents, and no symlink on
  those paths or runtime trees; provisioning and drift checks must strip or
  reject every extended ACL;
- an exact `sudoers` grant for that launcher path only, as
  `mento-github-broker`, with `env_reset`, `NOSETENV`, no executable-path
  wildcard, shell, alternate command, or other access to that OS identity;
- broker-private mode-`0700` state and temporary directories under
  `/var/lib/mento-github-broker`, plus the fixed `/var/empty` operation path;
- a minimal fixed service environment;
- no caller environment inheritance;
- a non-human Google identity that matches the source-pinned service-account
  impersonator and is unavailable to the agent;
- no agent-readable service credential or IPC endpoint that returns tokens;
- an exact operation schema and selected-repository check;
- no workflow capability, or root-owned human-controlled capability storage
  that ordinary agent input cannot select;
- service logs that contain no PEM, JWT, token, request header, or unredacted
  caller value;
- service failure when any required property is absent;
- a live smoke test against the installed runtime tree before credential
  cutover. A symlink, unsafe ACL, missing execute bit, or runtime-tree bound must
  fail closed.

Compare the installed broker bytes with the reviewed source. Record digests,
owners, modes, ACL results, paths, `sudoers` policy, Google identity, smoke
result, actor, and time. Stop before cutover if any proof is absent. Do not
report the broker active from unit tests alone.

The agent-facing syntax is:

```bash
pnpm github:agent --profile <profile> -- <operation> [arguments]
```

The source enables bounded repository, issue, pull-request, and workflow-run
REST reads plus narrow PR and issue mutations. It does not enable Git
publication, merge, workflow publication, GraphQL, the PR readiness
projections, or transactional #2111 claim/release. Keep an unsupported step on
an approved human or proved MCP lane. Do not pass a token to its repository
helper.

Active `read` operations are `repo-view`, `issue-view`, `issue-list`,
`pr-view`, `pr-list`, `run-view`, and `run-list`. Active `pr-issue-write`
operations are `issue-create`, `issue-comment`, `issue-close`, `issue-reopen`,
`pr-create`, `pr-comment`, `pr-close`, `pr-reopen`, and `pr-review`.
`pr-review` accepts only `comment` and `request-changes`; App approval is
unavailable. `git-publish` and `issue-board-write` reject every operation before
token minting. The source parser defines the bounded positional arguments.

## Phase 6: cut over agent credentials

Create a fresh dedicated agent OS account or container. It must contain none
of these values or surfaces:

- human PAT or OAuth token;
- human SSH key or agent;
- browser GitHub session;
- GitHub credential helper or keychain entry;
- platform GitHub PAT;
- operator tfvars;
- App private key;
- broker Google credential;
- ambient `GH_*`, `GITHUB_*`, or credential-routing configuration.

Configure only the non-secret broker endpoint and App/installation identifiers
that the trusted service contract requires. Run one read operation. Confirm
that the response contains only the allowed normalized fields. Run the
no-token canary. Confirm that stdout, stderr, returned data, child state, and
temporary paths contain no credential.

Repeat identity proof for each writable cloud-agent surface. Require a
repository-scoped App installation identity with no lifecycle bypass. Keep an
unproved surface read-only.

## Phase 6A: migrate the #2137 writer and drain legacy authority

Keep the lifecycle ruleset disabled. Make a separate reviewed change to the
default-branch #2137 final writer. Retain the restricted `github.token` for
every authoritative Actions and pull-request read. Use `GH_READ_TOKEN` for
those reads. The writer can wait for required checks for up to 60 minutes. Mint
a fresh dedicated Dependabot merge App token from
`DEPENDABOT_MERGE_APP_ID` and `DEPENDABOT_MERGE_APP_PRIVATE_KEY` after that wait
and before the repeated final proof. Repeat the complete workflow, run, job,
pull request, head, commit, file, queue, and required-check proof with
`GH_READ_TOKEN`. Expose the fresh App token only to the final synchronous
exact-head REST merge `PUT`. Do not mint the token before the wait, substitute
an hour-old token, assign it at job or global scope, or replace `GH_TOKEN`
globally. The dedicated App has no Actions permission, so its token cannot
replace the read credential. Keep the untrusted classifier and trusted final
writer separate. Do not expose either secret to pull-request code or artifacts.

The separate migration PR must add a source-contract test. The test must prove
that the required-check wait precedes App-token minting, the fresh mint precedes
the repeated final proof, every read uses `GH_READ_TOKEN` from `github.token`,
and only the final REST `PUT` receives the App token. It must prove that the
request uses `PUT /repos/mento-protocol/monitoring-monorepo/pulls/{number}/merge`
with the verified head SHA and squash method. It must reject an early mint, an
old token, a job-level or global App-token assignment, `gh pr merge`, and any
auto-merge or queue command. This source cannot test a future workflow
migration before that workflow change exists.

Prove one writer run against an eligible routine Dependabot pull request.
Record the workflow run ID, workflow commit, triggering run, pull request,
exact head SHA, App ID, installation ID, token permission map, final App merge
actor, and merge commit. Confirm that the writer left no standing auto-merge
request. Stop if the writer or merge uses GitHub Actions App `15368`, Dependabot
App `29110`, a user credential, or the local-agent App.

Then drain the interim writer:

1. Wait for every pre-migration writer run to reach a terminal state.
2. Do not rerun a retained pre-migration writer run.
3. Inspect every open Dependabot pull request for an auto-merge request.
4. Complete or cancel each request enabled by the interim `GITHUB_TOKEN`
   writer.
5. Require every open Dependabot pull request to have no auto-merge request.
   The migrated writer must not create a replacement request under the
   dedicated App.
6. Repeat the query immediately before lifecycle activation. Require the same
   empty result. Record its full non-secret result and time.

Only after both proofs pass may reviewed source set
`dependabot_merge_writer_migration_verified` and
`legacy_dependabot_auto_merge_drained` to true. Run the guarded platform plan.
Require the active ruleset to remain disabled and every managed resource to be
a no-op. The evidence booleans do not change live infrastructure by themselves.

## Phase 7: activate the lifecycle ruleset

Require the dedicated-App credential gate, writer-migration evidence, and
legacy-drain evidence to be true. Require the boundary resource gate to remain
true. Require explicit owner acceptance of the Vercel Free-plan residual, or a
reviewed compensating control that removes that residual. Change only the
reviewed enforcement selector from disabled to active. Keep the source-pinned
Team, both App IDs, and managed ruleset ID unchanged. Review the guarded plan.
Require one in-place update at that exact ID and no core ruleset action.

Obtain separate apply approval. Apply through the guarded wrapper. Read both
live rulesets through the human Administration-read surface. Require:

- unchanged core ruleset ID `13494367` and exact core shape;
- exact pinned lifecycle ruleset ID;
- active enforcement;
- creation, update, and deletion rules only;
- one approved Team bypass in `pull_request` mode;
- one approved dedicated Dependabot merge App Integration bypass in `exempt`
  mode;
- no shared Actions App, built-in Dependabot App, local-agent App,
  administrator, role, user, or third bypass.
  Require the `dependabot-merge` Environment to keep an empty
  `protection_rules` list, one exact custom `main` branch policy, and only the
  two approved secret metadata names.

## Phase 8: prove the boundary

Use one ready same-repository human-path PR and one eligible routine Dependabot
PR. Keep each exact head unchanged during its proof.

1. Read both selected-repository App installations through the human
   Administration surface. Record each App ID, installation ID, selected
   repository, and permission map. Require Contents to be absent from the
   local-agent App. Require exactly Contents write, Pull requests write, and
   Workflows write on the dedicated merge App. Require Actions to be absent.
2. Through a trusted operator diagnostic that does not reveal the local-agent
   installation token, ask GitHub to perform an authenticated merge or
   equivalent `main` update on the human-path PR. Require the fixed
   `permission-ceiling-denied` result. Do not return headers, request bodies,
   tokens, or raw provider output.
3. Record the exact live JSON for core ruleset `13494367` and the pinned
   lifecycle ruleset. Require the lifecycle ruleset to be active, target only
   `refs/heads/main`, contain only creation, update, and deletion restrictions,
   and name exactly the approved Team in `pull_request` mode and dedicated App
   Integration in `exempt` mode.
4. Have an approved Team member merge the unchanged human-path PR through the
   approved human merge command. Require the merge record to identify that Team
   member.
5. Let the #2137 final writer process the unchanged routine Dependabot PR.
   Require all normal core ruleset checks. Require the writer to repeat its
   authoritative proofs and perform one synchronous exact-head REST merge under
   the dedicated App identity. Record the triggering and writer run IDs,
   workflow commit, PR, head SHA, App and installation IDs, final App merge
   actor, and merge commit.
6. Repeat the legacy auto-merge drain query. Require no auto-merge request on
   any open Dependabot pull request.
7. Record both PRs, both exact heads, the local-agent permission denial, the
   human actor, the dedicated-App actor evidence, both live ruleset JSON
   documents, drain result, and time.

The local-agent App attempt proves its permission ceiling. It cannot prove
lifecycle ruleset evaluation because the App has no Contents permission. The
dedicated App is `exempt`, so GitHub does not produce a ruleset bypass request
for that merge. The exact live ruleset JSON and the bound writer and merge
actors provide the accepted automation evidence. The Team merge proves the
human path separately.

Do not add a rejected direct push as a substitute for any step. The core
pull-request rule can reject that push before the lifecycle identity rule is
tested.

## Phase 9: activate daily drift enforcement

After live proof, change only the reviewed audit selector to active. Merge that
source change through the human path. Run the platform-settings drift workflow
from trusted `main`. Require `main-lifecycle-boundary-audit state=ok`. The
audit must prove both
rulesets, the `dependabot-merge` Environment with admin bypass false, custom
policies true, protected branches false, one branch policy named `main`, and
only the two approved secret metadata names. It must not read a public key or
secret value.

An inert result is not proof. A missing Administration:Read, Actions:Read, and
Environments:Read audit credential must fail after activation.

## Credential inventory

Before activation and at each review interval, inventory:

- every credential issued by a merge-operator Team member;
- repository, organization, and environment Actions credential metadata;
- external CI, bot, broker, build, and deployment credentials;
- cloud-agent credential types and repository selection;
- the platform Administration PAT and its absence of Contents;
- the lifecycle-boundary audit PAT and its read-only Administration, Actions,
  and Environments scopes;
- the dedicated merge App registration, installation, exact Contents/write,
  Pull requests/write, and Workflows/write permissions with no Actions,
  ciphertext-backed `dependabot-merge` Environment secret metadata, exact
  `main` policy, and exempt bypass;
- the local-agent App registration, installation, profiles, and lack of bypass;
- protected Google principals that can read the App key;
- Vercel Administration and Contents with the Free-plan acceptance record.

Revoke an unknown credential. Revoke or rotate a human or platform credential
that reached an agent surface. Do not infer issuer identity from a secret name.

## Rotation

Each App key rotation needs separate approval.

For the dedicated merge App, stop the #2137 writer. Fetch the current
`dependabot-merge` Environment Actions public key and key ID. If the ID is
unchanged, encrypt and update only
the replaced credential ciphertext. If the ID changed, re-encrypt the App ID
and replacement key, then update both ciphertexts and the shared key ID in one
plan. Review and apply only the exact guarded secret update. Verify one writer
run and merge actor before re-enabling routine automation. Revoke the old App
key and wait for old installation tokens to expire.

For the local-agent App, disable the broker first. Generate and transfer the
replacement through the secure intake procedure. Increment the reviewed
write-only rotation counter. Review and apply the guarded credential plan.
Install and verify the new key. Revoke the old key. Wait for old installation
tokens to expire before re-enabling the broker.

Repeat the no-token, profile, repository, expiry, and refusal canaries after
rotation.

## Rollback and incidents

Disable the agent broker, #2137 writer, affected key, or affected App
installation before changing the lifecycle rule. Do not weaken the server
control to recover an agent or Dependabot workflow. The human Team remains the
recovery merge lane.

A normal rollback leaves the active lifecycle ruleset in place. Disable the
broker or App first. Use a reviewed source change, guarded plan, explicit apply
approval, live ruleset read, and drift proof for any credential or audit-state
rollback. The plan guard rejects an active-to-disabled enforcement transition.
Changing the live ruleset is a human break-glass action. Record the actor,
reason, prior JSON, new state, time, and reconciliation owner. Keep agent write
access disabled until source matches live state and both rulesets pass the
audit.

Treat these events as security incidents:

- core ruleset `13494367` appears in Terraform state at the managed lifecycle
  address;
- the lifecycle ruleset ID changes without the approved source transition;
- `main` is created, updated, or deleted outside the approved path;
- the dedicated merge App permission map differs from exact Contents write,
  Pull requests write, and Workflows write, or it appears in another
  repository;
- the local-agent App receives Administration or a ruleset bypass;
- a merge attributed to shared App `15368`, built-in App `29110`, the
  local-agent App, or a user occurs in the routine Dependabot lane;
- an auto-merge request remains on an open Dependabot pull request at
  activation;
- a token, JWT, or PEM reaches an agent or output surface;
- a human or platform credential reaches an agent surface;
- Vercel changes the ruleset or `main` outside its accepted operation;
- the active audit reports drift, malformed state, or a missing credential.

Stop agent writes, preserve non-secret evidence, revoke affected credentials,
restore reviewed controls through the human path, and reconcile source before
resuming.
