---
title: Main branch lifecycle changes use controlled human and Dependabot identities
status: active
owner: eng
canonical: true
last_verified: 2026-08-30
scope: ci/process, terraform/infra
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0080 — Main branch lifecycle changes use controlled human and Dependabot identities

**Status:** Accepted (Aug 2026). The source defines the target state. It does
not prove that GitHub, the local host, or a cloud agent uses that state.

**Scope:** ci/process, terraform/infra

## Context

[ADR 0075](0075-pr-merge.md) defines the approved local merge command. A local
command cannot enforce a human boundary when the calling process can use a
human credential. Issue
[#2091](https://github.com/mento-protocol/monitoring-monorepo/issues/2091)
therefore requires a GitHub-side rule and separate agent credentials.

The existing `main` ruleset has ID `13494367`. It contains the repository's
pull-request, status-check, review-thread, linear-history, deletion, and
force-push controls. It also contains
`require_extra_approval_for_unattributed_changes`. GitHub provider `6.12.1`
cannot represent that field. Importing and updating the core ruleset through
the provider can remove a live review control. The official `6.13.0` resource
schema reviewed on 2026-08-29 still omits the field, so a provider update does
not close this gap.

GitHub combines all active rulesets that target a ref. A bypass actor applies
only to the ruleset that names that actor. A separate ruleset can therefore
restrict the `main` lifecycle without adopting or weakening the core ruleset.

A user PAT or OAuth token authenticates as its user. A Contents-write token
from a merge-operator Team member carries that user's authority into
automation. Team membership does not make that token human-only.

An installation token authenticates as its GitHub App installation. It does
not inherit a human Team membership. A selected-repository App with no
Administration permission and no ruleset bypass can support agent work without
giving the agent the human merge identity.

## Decision

Use three independent controls. The lifecycle ruleset controls GitHub. A
dedicated App controls the routine Dependabot merge lane. The local-agent
credential broker controls which non-bypass App authority reaches each agent
operation. One control must not weaken another.

### Separate lifecycle ruleset

Create a separate repository ruleset for `refs/heads/main`. It contains exactly
these rules:

- branch creation is restricted;
- branch updates are restricted;
- branch deletion is restricted.

The ruleset has exactly two bypass actors:

- one human Team with exact slug `merge-operators` in `pull_request` mode;
- one dedicated repository-scoped Dependabot merge App Integration in `exempt`
  mode.

Reviewed source pins the exact Team slug, Team ID, and both App IDs. Only the Team and dedicated
App are bypass actors. The dedicated App must differ from the
shared GitHub Actions App `15368`, the built-in Dependabot App `29110`, and the
local-agent App. Do not add OrganizationAdmin, RepositoryRole, a user, Vercel,
or another Integration as a bypass actor.

The `update` rule creates the merge identity boundary. The `creation` rule
prevents an allowed actor from deleting and then recreating `main` outside the
same boundary. The `deletion` rule binds removal to the same actors. The
unmanaged core ruleset already owns `non_fast_forward`. Duplicating that rule
would add no identity control.

Use `exempt` for the dedicated App. The trusted writer waits for all required
checks, repeats its authoritative proofs, and submits one synchronous exact-head
REST merge with the App token. That call updates `main` directly under the App
identity. It cannot enqueue or leave a standing auto-merge request. `exempt`
authorizes the App as that direct lifecycle update actor. This mode has a
material audit limit: GitHub does not create a ruleset bypass request for an
exempt actor. Activation evidence must therefore bind the workflow run, App
installation, pull request, head SHA, final App merge actor, and merge commit.
The App remains subject to the unchanged core ruleset because it is not a
bypass actor there.

Keep core ruleset `13494367` unmanaged. Do not import it at the lifecycle
resource address. Provider `6.12.1` remains pinned until a separate review
proves that a later version preserves every live core field.

Terraform uses `prevent_destroy`. The exact plan guard rejects replacement,
deletion, another first-class repository ruleset, an unknown managed field, a
different Team or dedicated App, a third bypass actor, a mutable provider
owner, and a non-public GitHub API endpoint. It rejects the shared App IDs and
core ruleset ID `13494367`. During initial ruleset creation, it rejects every
other non-no-op action.

The dedicated App credentials use exactly two secrets in the Terraform-owned
`dependabot-merge` Environment: `DEPENDABOT_MERGE_APP_ID` and
`DEPENDABOT_MERGE_APP_PRIVATE_KEY`. The Environment disables admin bypass. It
uses custom branch policies and one exact `main` branch pattern. A first
reviewed phase creates and protects the Environment. An operator then encrypts
both values outside Terraform with that Environment's Actions public key. A
second reviewed phase installs the two ciphertext-backed Environment secrets.
Only after both phases are live may a separate reviewed #2137 writer change
declare `environment: dependabot-merge` and consume them. This order prevents a
workflow reference from auto-creating an unprotected Environment. The plan
guard rejects plaintext, another secret store, another secret name, a partial
create, and unrelated changes. It permits one in-place ciphertext rotation at
a time.

The guard also has one strengthening-only Environment repair lane. A reviewed
plan may change a bounded known prior Environment, the provider's empty
no-policy list, or a bounded branch-pattern value to the exact source shape
beside the unchanged lifecycle ruleset. It rejects a
malformed identity, an unknown prior shape, a widening or destructive action,
a simultaneous secret change, and every unrelated action. The writer stays
disabled until the live audit passes again.

When the reviewed broker-scaffold gate first becomes true, the guard requires
the complete five-resource local-agent broker create set and rejects every
unrelated change.

A platform apply can save part of the five-resource scaffold before a later
create fails. A separate reviewed partial-recovery gate is false during normal
provisioning. When that gate is true, the exact plan guard permits only the
canonical five scaffold members. Each member must be a create or a no-op with
the same before and after shape. At least one member must already be a no-op
when the plan has creates.
The pinned lifecycle ruleset must be disabled and unchanged. The audit must be
inactive. The guard rejects a replacement, deletion, update, all-five create,
or unrelated action. After recovery reaches an all-no-op plan, reviewed source
must return the recovery gate to false before other platform work continues.

The reviewed policy records the boundary resource gate, repository, Team ID,
both App IDs, the exact
dedicated-App repository permission map, managed lifecycle ruleset ID, desired
enforcement, dedicated-App credential state, #2137 exact-head REST
writer-migration evidence, legacy auto-merge request absence evidence,
drift-audit state, broker-scaffold gate, partial-recovery gate, and broker
impersonator. The initial source keeps the resource gate false. It uses zero ID
sentinels, disabled enforcement, an empty impersonator, the fixed permission
map, and false evidence and phase gates. Every boundary resource has count
zero. Unrelated safe platform plans remain available.

The state changes in separate reviewed phases:

1. A human organization administrator creates and verifies one new Team with
   exact slug `merge-operators`. Grant the built-in Write repository role, the
   least built-in role that can merge pull requests. Do not grant Maintain or
   Admin. A human may instead select and record a custom Write-based role at
   activation if it adds no administration or ruleset-edit authority. A human
   also creates and verifies both Apps. The operator keeps all three numeric
   IDs and the permission evidence in the private activation record.
   Intermediate source states remain invalid.
2. One reviewed source change pins the Team ID, both App IDs, and the dedicated
   App's exact repository permission map, and sets the boundary resource gate
   true. An approved platform apply then creates only the lifecycle ruleset
   with disabled enforcement. The create plan has no prior ruleset value and
   no credential or broker resource.
3. A human reads the new ruleset ID. A reviewed source change pins that positive
   ID. The ID must never equal `13494367`.
4. A reviewed Environment source change creates `dependabot-merge`, disables
   admin bypass, enables custom branch policies, and adds the exact `main`
   branch pattern. A human verifies that live boundary. A later reviewed
   credential source change installs only the two ciphertext-backed
   Environment secrets beside the disabled no-op ruleset.
5. A separate reviewed source change enables the local-agent broker scaffold
   and pins its one service-account impersonator. Its approved plan creates only
   the service account, secret container, accessor binding, impersonation
   binding, and write-only credential version. Local and cloud agent credential
   cutover completes while the lifecycle rule is disabled.
6. Only after the protected Environment and both secrets exist live, a
   separate reviewed #2137 writer change declares
   `environment: dependabot-merge`. The final writer retains its restricted
   `GITHUB_TOKEN` for every
   authoritative read. It waits for required checks, then mints a fresh
   dedicated-App token. It repeats the complete authoritative proof with the
   read token and exposes the App token only to one synchronous exact-head REST
   merge `PUT`. The writer creates no standing auto-merge request. Live
   evidence binds the writer run and final merge to that App installation and
   records the final App merge actor. Every legacy auto-merge request is then
   completed or cancelled. A final query must prove that no such request
   remains. Reviewed source records both completed gates.
7. A reviewed source change selects active enforcement. An approved platform
   apply changes only enforcement on the pinned lifecycle ruleset.
8. Live checks record the exact ruleset JSON, prove the Team pull-request path,
   prove a routine Dependabot merge under the dedicated App, and prove that the
   local-agent App cannot bypass the lifecycle ruleset.
9. A final reviewed source change activates daily drift enforcement.

The daily read-only audit checks the exact core shape, lifecycle shape,
Environment shape, one `main` branch policy, and two exact secret metadata
names. It never reads a public key or secret value. It uses the
repository-scoped Administration:Read, Actions:Read, and Environments:Read
audit credential for GET requests. Issue writes use the workflow token. Before activation, the
audit reports an inert state. After activation, a missing audit credential or
missing managed ruleset fails the workflow.

### One App with fixed broker profiles

Create one GitHub App. Install it only on
`mento-protocol/monitoring-monorepo`. Do not grant Administration permission or
a ruleset bypass. At first cutover, grant only Actions read, Issues write, and
Pull requests write. The two disabled profiles below do not extend this
ceiling. Each needs a reviewed App-permission change and activation proof.

The trusted broker selects the exact permission request for one structured
operation:

- `read`: repository, pull-request, issue, and workflow-run REST reads;
- `pr-issue-write`: approved pull-request and issue mutations;
- `git-publish`: feature-branch publication with Contents write;
- `issue-board-write`: issue-board mutation and its exact transaction lock,
  with organization Projects write only when the final #2111 implementation
  requires it.

Read operations do not receive write permissions. A profile cannot add an
unlisted permission. The broker checks GitHub's returned repository,
permissions, and expiry before it performs the operation.

The source contract keeps `git-publish` unavailable. The trusted broker does
not run Git in an agent-controlled repository and does not run a repository
script with a token. Activation needs a root-owned clean mirror or another
reviewed implementation that eliminates repository config, hooks, helpers,
URL rewrites, proxy settings, extra headers, and token-bearing caller children.
Until then, a human publishes branches through the separate human lane.

The source contract also keeps all of `issue-board-write` unavailable until the
merged #2111 source pins its exact namespace and one trusted operation
implements the whole transaction. The broker never gives a token to a
repository helper.

Workflow write is absent from every normal profile. A workflow publication
needs a root-owned, human-controlled capability. Ordinary agent input cannot
select or create that capability. The capability has a bounded operation and
must be removed after use. If the host cannot enforce this property, the
workflow publication profile stays unavailable.

The trusted side keeps the App PEM, App JWT, and installation token. It never
writes those values to stdout, stderr, returned JSON, a temporary file, an
agent environment, or a caller-controlled child. It runs only structured
allowlisted operations. It uses fixed executable paths and a minimal
allowlisted environment. It does not inherit caller `PATH`, `NODE_OPTIONS`,
proxy variables, dynamic-loader variables, gh configuration, Git credential
configuration, a keychain helper, or an SSH agent.

Repository source can define and test this protocol. Source cannot prove that
the root-owned service, OS identity, executable files, capability files, or
credential removal is active. Host installation and live proof are separate
operator steps. Until they complete, the broker is unavailable and the local
wrapper remains the active process control.

Use a dedicated agent OS account or container. It contains no human PAT, OAuth
token, SSH key, browser session, keychain entry, Git credential helper, platform
PAT, operator tfvars, App private key, or root broker credential. Every local
authenticated operation uses the broker protocol.

The first broker implements a bounded REST subset. It does not execute the
repository PR projections, issue helpers, Git, merge, GraphQL, or workflow
publication. Those operations stay unavailable or use a separately approved
human or proved MCP lane until the trusted side implements their exact
structured contracts. A smaller broker response cannot establish PR readiness
or transactional issue ownership.

Cloud agents need the same identity property. Each cloud agent surface must
prove that its credential is a repository-scoped App installation token with
no lifecycle bypass. A platform-provided credential is not accepted as proof
without that identity evidence. A cloud surface that cannot meet this rule is
outside the cutover and must not have repository write access.

### App key and platform credentials

A human creates the dedicated Dependabot merge App and installs it only on this
repository. Grant exactly Contents write, Pull requests write, and Workflows
write. Workflows write is required because #2137 accepts top-level workflow
updates. Do not grant Administration, Actions, Checks, Issues, or organization
permissions. The App ID must differ from `15368`, `29110`, and the local-agent
App ID. Reviewed policy pins the exact permission map and both App IDs.

After an approved apply creates and protects `dependabot-merge`, the operator
reads that Environment's Actions public key and key ID through an approved
read-only path. The operator encrypts the dedicated App ID and private key
outside Terraform with that public key. Terraform resources use the
supported `value_encrypted` field and explicit `key_id`. The gitignored
operator tfvars file contains only the public key ID and two sealed-box base64
ciphertexts. Terraform state contains ciphertext, not either plaintext value.
The wrapper rejects both ciphertexts in environment variables and CLI `-var`
arguments.

GitHub can rotate the Environment Actions public key. Before any credential
rotation, fetch the current public key and key ID. If the ID is unchanged,
encrypt and update only the replaced credential. If the ID changed, re-encrypt
both plaintexts and update both secret resources and both ciphertexts in one
guarded plan. This prevents a new ciphertext from being sent with a stale
public key ID.
If one secret is missing when the public key changed, recovery creates that
secret and updates the surviving secret under the new key ID in one plan. The
guard permits this exact recovery during initial provisioning or active state.
It requires the survivor's key ID and ciphertext to change.

A human separately creates the local-agent App and downloads its initial PEM outside every agent
surface. The operator transfers the PEM through the approved private tfvars
path. Credential activation requires the runbook's exact unindented HCL
literal heredoc. The wrapper rejects every JSON variable-file assignment of
the key, regardless of activation and including one that a later file would
override. The Terraform variable check accepts only canonical base64 layout
and canonical unused pad bits in a bounded RSA PKCS#1 or unencrypted PKCS#8
envelope. The exact plan wrapper normalizes the PEM body, decodes it, and
requires an exact base64 re-encoding before it parses the private key with Node
`crypto.createPrivateKey`. It requires a 2048-bit-or-stronger RSA key and
performs one in-memory RSA-SHA256 private operation. An omitted, blank,
malformed, non-RSA, weak, encrypted, or larger-than-64-KiB value fails before
apply with a fixed error. Terraform sends the accepted ephemeral value only to
Secret Manager's write-only field. The wrapper uses one private mode-`0600`
variable-file copy inside its mode-`0700` plan directory and removes that
directory on success or failure. It does not pass the key through an argument
or environment variable and does not write a second copy.

The plan wrapper rejects the local-agent App PEM, both dedicated-App
ciphertexts, and the platform GitHub PAT in environment variables and CLI
`-var` arguments. It uses fixed errors that cannot echo an unknown argument.
The platform PAT has Administration but no Contents permission. It stays on
the human operator surface.

Secret Manager access belongs to the broker service account. The approved
impersonating principal is pinned in reviewed source. Do not select it through
an arbitrary tfvars list. Existing protected project-owner and production
infrastructure impersonation paths remain in the App-key blast radius. They do
not enter the agent OS.

### Vercel Free-plan residual and activation gate

The Vercel GitHub integration retains Administration and Contents permissions
because the Free plan does not support the narrower integration control needed
here. This principal can change or remove the lifecycle ruleset and then update
`main`. It is an explicit residual, not a human-only credential.

Daily drift can detect a Vercel settings change after it occurs. It cannot
prevent the change. Activation evidence must record the Vercel installation,
its current permissions, its selected repository, the Free-plan constraint,
and the owner who accepted the residual. Do not activate the boundary until the
operator accepts this exact residual. A plan or product change that permits
permission separation must remove it in a follow-up.

### Precursor and activation boundaries

Issue `#2137` may first run its default-branch `workflow_run` writer with the restricted
`GITHUB_TOKEN`. Its use for the final write is an interim deployment state.
Before lifecycle enforcement becomes active, a separate reviewed change must
retain `github.token` for every authoritative Actions and pull-request read.
The writer can wait for required checks for up to 60 minutes. It must mint a
fresh dedicated Dependabot merge App token after that wait and before it
repeats the complete authoritative proof. It must use `github.token` for that
repeated proof and expose the App token only to the final synchronous
exact-head REST merge `PUT`. It must not mint the App token before the wait,
use an hour-old token, or replace `GH_TOKEN` globally. The migration PR must add
a source-contract test for the wait, mint order, repeated proof, exact REST
route, head binding, and token split. ADR 0080 cannot assert the later workflow
source before that change exists.

After that migration, drain every legacy write before activation. Wait for all
pre-migration writer runs to reach a terminal state. Inspect each open
Dependabot pull request. Complete or cancel each auto-merge request enabled by
the legacy `GITHUB_TOKEN` writer. The migrated writer creates no replacement
request. Require the final query to show no auto-merge request on any open
Dependabot pull request. Do not rerun a retained legacy writer run. Record the
writer run, pull request, head SHA, App and installation IDs, final App merge
actor, drain query, and query time. Only then may reviewed source set
`dependabot_merge_writer_migration_verified` and
`legacy_dependabot_auto_merge_drained` to `true`.

These actions require separate human approvals:

- exact `merge-operators` Team creation, repository role, and membership;
- dedicated Dependabot merge App creation, permissions, and installation;
- local-agent App creation, permissions, and installation;
- the atomic source change that pins the Team, dedicated App, and local-agent
  App IDs, exact dedicated-App permissions, and enabled resource gate;
- the later source change that pins the managed ruleset ID;
- disabled ruleset plan and apply;
- `dependabot-merge` Environment gate source change, exact-policy plan and
  apply, and live policy proof;
- dedicated-App Environment-secret gate source change, ciphertext plan and
  apply, and live secret-metadata proof;
- #2137 final-writer migration and live App-identity proof;
- legacy writer-run and auto-merge-request drain;
- source changes that record the writer-migration and drain evidence;
- broker-scaffold source enablement and impersonator pin;
- App-key plan and apply;
- partial-recovery source enablement and bounded recovery apply after a failed
  Phase 4B broker-scaffold apply;
- partial-recovery source disablement after an all-no-op recovery plan;
- root-owned broker installation;
- local and cloud credential cutover;
- active ruleset plan and apply;
- local-agent App permission-ceiling denial, exact ruleset JSON, human merge
  proof, and dedicated-App routine Dependabot merge proof;
- drift-audit activation.

The initial source merge activates none of these external states and does not
pause unrelated platform plans. The later identity-pin change enables the
resource gate and requires its own review before the first ruleset plan.

### Rollback

Do not disable the lifecycle ruleset to recover an agent or Dependabot
workflow. Disable the affected broker, writer, key, or App installation first.
The human Team remains the recovery merge lane.

A normal rollback leaves the active lifecycle ruleset in place. It disables
the broker or App and uses a reviewed source change plus a separately approved
platform plan and apply for any credential or audit-state rollback. The plan
guard rejects an active-to-disabled enforcement transition. Changing the live
ruleset is a human break-glass action. Record the actor, reason, prior ruleset
JSON, new state, and time. Keep agent credentials disabled until reviewed
source matches the live state and both rulesets pass the audit.

If the local-agent App key custody is uncertain, revoke the key before removing
local copies. Rotate it through the approved write-only Secret Manager path. If
the dedicated Dependabot merge App key custody is uncertain, revoke that key,
stop the writer, and replace both Environment-secret ciphertexts under the current
Environment public key ID through one approved plan. If a human or platform credential
reaches an agent surface, revoke or rotate that credential and repeat the
cutover evidence.

## Alternatives considered

**Adopt core ruleset `13494367`.** Rejected. Provider `6.12.1` cannot preserve
the unattributed-change approval field.

**Use only an update rule.** Rejected. It leaves branch creation and deletion
outside the new boundary.

**Require an approval that the merging identity cannot self-supply.** Rejected
as the identity boundary. A distinct approval can add a second decision-maker
to a pull request, but it does not constrain which credential performs the
later `main` update. An agent with a human credential could still merge an
already-approved pull request, and the approval would not protect branch
creation or deletion. Requiring a human approval on every routine Dependabot
pull request would also remove the approved automated exception. The unchanged
core approval controls remain useful defense in depth.

**Add a merge queue.** Rejected as the identity boundary. A queue serializes
eligible changes and can retest them against a newer base, but it does not
separate the credential that submits the change from a human operator
credential. It also does not protect branch creation or deletion. Queue
completion can occur later under a platform integration. That behavior does
not bind one synchronous update and its final actor to the dedicated App. The
The `#2137` writer therefore refuses a queue and uses the synchronous REST merge
endpoint, which cannot enqueue. A future queue rule needs a separate design.

**Separate credentials and bind both approved identities in a lifecycle
ruleset.** Selected. The human Team credential and dedicated repository-scoped
Dependabot App credential are different principals. The lifecycle ruleset
names only those two actors. The normal agent, shared GitHub Apps, and the
local-agent App cannot inherit either bypass. This combines server-side actor
selection with credential separation while retaining the narrow automated
Dependabot lane.

**Give shared GitHub Actions App `15368` or built-in Dependabot App `29110` a
bypass.** Rejected. Their authority is shared across more workflows or
repositories than the approved merge lane.

**Require a human merge for every Dependabot update.** Rejected. Routine
Dependabot updates are approved for a narrow automated lane. The dedicated App
keeps that exception separate from agents and shared GitHub integrations.

**Use `pull_request` bypass mode for the dedicated App.** Rejected. The
dedicated App performs the final direct `main` update through one synchronous
REST merge call. `exempt` makes that Integration the explicit lifecycle update
actor. The missing bypass-request record is accepted and replaced with
explicit workflow, App, PR, head, final merge actor, and merge-commit evidence.

**Return a short-lived installation token to the agent.** Rejected. The agent
could copy the token and bypass operation and profile parsing for its remaining
lifetime.

**Use a user PAT with narrow scopes.** Rejected. The token still authenticates
as its user and can inherit the Team bypass.

**Treat Vercel as human-only.** Rejected. Vercel is an automation principal
with Administration and Contents. The current Free-plan limit remains an
explicit residual.

## Consequences

- The active lifecycle ruleset protects creation, update, and deletion of
  `main` without modifying the core ruleset.
- Exactly two source-pinned actors bypass that ruleset. The Team works only
  through a pull request. The dedicated Dependabot merge App is exempt.
- The dedicated App can update `main` outside this lifecycle ruleset. The
  unchanged core ruleset still applies. A compromised App key can attempt any
  update allowed by that core ruleset, so selected-repository installation,
  exact Contents/write, Pull requests/write, and Workflows/write permissions,
  ciphertext-only custody, and writer classification are required controls.
- GitHub does not emit a bypass-request record for the exempt App. Activation
  and ongoing evidence must bind workflow, installation, PR, head, and merge
  actor directly.
- Agent credentials authenticate as one selected-repository App installation.
- Checked-in source keeps the broker scaffold absent until a separate reviewed
  Phase 4B change enables it and pins its impersonator.
- Normal read operations receive no write permission.
- A local agent never receives the App PEM, JWT, or installation token.
- Host and cloud activation require live identity and refusal evidence.
- Vercel remains a documented Administration-plus-Contents residual.
- Repository administrators can still change settings. Drift gives detection,
  not prevention, after an authorized or compromised settings change.
- Terraform source, plan, apply, credential cutover, and live proof remain
  separate authority boundaries.
- The local-agent App denial proves its registration ceiling. The exact live
  ruleset JSON, Team merge, and dedicated-App routine merge prove the server,
  human, and automation paths as separate facts.

## Evidence

- Terraform lifecycle source:
  [`terraform/github-controlled-main-lifecycle-ruleset.tf`](../../terraform/github-controlled-main-lifecycle-ruleset.tf)
- Terraform dedicated-App credential source:
  [`terraform/github-dependabot-merge-app-credentials.tf`](../../terraform/github-dependabot-merge-app-credentials.tf)
- Reviewed phase and sentinel policy:
  [`terraform/main-lifecycle-boundary-policy.json`](../../terraform/main-lifecycle-boundary-policy.json)
- Exact plan policy:
  [`scripts/terraform/check-main-lifecycle-boundary-plan.mjs`](../../scripts/terraform/check-main-lifecycle-boundary-plan.mjs)
- Drift evaluator:
  [`scripts/workflows/check-main-rulesets-drift.mjs`](../../scripts/workflows/check-main-rulesets-drift.mjs)
- Broker protocol and activation runbook:
  [`docs/notes/local-agent-github-app-credential.md`](../notes/local-agent-github-app-credential.md)
- Platform plan and apply procedure: [`docs/terraform.md`](../terraform.md)
- Prior merge boundary: [ADR 0075](0075-pr-merge.md)
- Exact-plan guard: [ADR 0061](0061-exact-plan-guard-for-manual-platform-applies.md)
