---
title: Main branch lifecycle changes require human merge operators
status: active
owner: eng
canonical: true
last_verified: 2026-08-29
scope: ci/process, terraform/infra
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0078 — Main branch lifecycle changes require human merge operators

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

Use two independent controls. The lifecycle ruleset controls GitHub. The
credential broker controls which non-bypass App authority reaches each local
agent operation. Neither control may weaken the other.

### Separate lifecycle ruleset

Create a separate repository ruleset for `refs/heads/main`. It contains exactly
these rules:

- branch creation is restricted;
- branch updates are restricted;
- branch deletion is restricted.

The ruleset has one bypass actor. The actor is a human merge-operator Team
whose numeric ID is pinned in reviewed source. Its bypass mode is
`pull_request`. Do not add OrganizationAdmin, RepositoryRole, GitHub Actions,
the agent App, Vercel, another Integration, or a user as a bypass actor.

Keep core ruleset `13494367` unmanaged. Do not import it at the lifecycle
resource address. Provider `6.12.1` remains pinned until a separate review
proves that a later version preserves every live core field.

Terraform uses `prevent_destroy`. The exact plan guard rejects replacement,
deletion, another first-class repository ruleset, an unknown managed field, a
different Team, a mutable provider owner, and a non-public GitHub API endpoint.
It also rejects core ruleset ID `13494367` in every lifecycle resource state.
During initial ruleset creation, it rejects every other non-no-op action. When
the reviewed broker-scaffold gate first becomes true, it requires the complete
five-resource create set and rejects every unrelated change.

The reviewed policy records the repository, Team ID, managed lifecycle ruleset
ID, desired enforcement state, drift-audit state, broker-scaffold gate, and
broker impersonator. The initial source uses zero ID sentinels, disabled
enforcement, an empty impersonator, and a false scaffold gate. The state
changes in separate reviewed phases:

1. A human creates and verifies the Team. Source pins its positive numeric ID.
2. An approved Phase 3 platform apply creates only the lifecycle ruleset with
   enforcement disabled. The create plan must have no prior ruleset value and
   no broker scaffold or credential resource.
3. A human reads the new ruleset ID. A reviewed source change pins that
   positive ID. The ID must never equal `13494367`.
4. A separate reviewed Phase 4 source change enables the broker scaffold and
   pins its one service-account impersonator. Its approved plan creates only
   the service account, secret container, accessor binding, impersonation
   binding, and write-only credential version. Agent credential cutover then
   completes while the lifecycle rule is disabled.
5. A reviewed source change selects active enforcement. An approved platform
   apply changes only enforcement on the pinned lifecycle ruleset.
6. Live checks prove that the App lacks Contents permission, record the exact
   live lifecycle ruleset JSON, and prove that the approved Team
   `pull_request` bypass can merge the same ready pull request. The App denial
   proves its permission ceiling. It does not prove that GitHub evaluated the
   lifecycle ruleset.
7. A final reviewed source change activates daily drift enforcement.

The daily read-only audit checks the exact core shape and the exact lifecycle
shape. It uses the repository-scoped Administration-read audit credential for
GET requests. Issue writes use the workflow token. Before activation, the
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

A human creates the App and downloads its initial PEM outside every agent
surface. The operator transfers the PEM through the approved private tfvars
path. Credential activation accepts only a bounded PKCS#1 or PKCS#8 PEM
envelope. An omitted, blank, malformed, or larger-than-64-KiB value fails before
apply. Terraform sends the accepted ephemeral value only to Secret Manager's
write-only field. The exact plan wrapper uses one private mode-`0600`
variable-file copy inside its mode-`0700` plan directory and removes that
directory on success or failure.

The plan wrapper rejects the App PEM and the platform GitHub PAT in environment
variables and CLI `-var` arguments. It uses fixed errors that cannot echo an
unknown argument. The platform PAT has Administration but no Contents
permission. It stays on the human operator surface.

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

Retire `.github/workflows/dependabot-auto-merge.yml` in its separate precursor
PR. Merge and drain that workflow before this source change can activate. Every
open Dependabot PR must have `autoMergeRequest: null` immediately before the
source merge and again before the lifecycle apply. Do not rerun retained runs.

These actions require separate human approvals:

- Dependabot precursor merge and drain;
- Team creation and membership;
- App creation, registration, and selected-repository installation;
- source changes that pin the Team and managed ruleset IDs;
- disabled ruleset plan and apply;
- broker-scaffold source enablement and impersonator pin;
- App-key plan and apply;
- root-owned broker installation;
- local and cloud credential cutover;
- active ruleset plan and apply;
- App permission-ceiling denial, exact ruleset JSON, and human merge proof;
- drift-audit activation.

Source merge activates none of these external states.

### Rollback

Do not disable the lifecycle ruleset to recover an agent workflow. Disable the
agent broker or App installation first.

A normal rollback leaves the active lifecycle ruleset in place. It disables
the broker or App and uses a reviewed source change plus a separately approved
platform plan and apply for any credential or audit-state rollback. The plan
guard rejects an active-to-disabled enforcement transition. Changing the live
ruleset is a human break-glass action. Record the actor, reason, prior ruleset
JSON, new state, and time. Keep agent credentials disabled until reviewed
source matches the live state and both rulesets pass the audit.

If the App key custody is uncertain, revoke the key before removing local
copies. Rotate it through the approved write-only Secret Manager path. If a
human or platform credential reaches an agent surface, revoke or rotate that
credential and repeat the cutover evidence.

## Alternatives considered

**Adopt core ruleset `13494367`.** Rejected. Provider `6.12.1` cannot preserve
the unattributed-change approval field.

**Use only an update rule.** Rejected. It leaves branch creation and deletion
outside the new boundary.

**Give GitHub Actions or another Integration a bypass.** Rejected. A bypass
applies to the Integration actor, not one workflow.

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
- Only the source-pinned Team has a bypass in that ruleset, and its bypass works
  only through a pull request.
- Agent credentials authenticate as one selected-repository App installation.
- Checked-in source keeps the broker scaffold absent until a separate reviewed
  Phase 4 change enables it and pins its impersonator.
- Normal read operations receive no write permission.
- A local agent never receives the App PEM, JWT, or installation token.
- Host and cloud activation require live identity and refusal evidence.
- Vercel remains a documented Administration-plus-Contents residual.
- Repository administrators can still change settings. Drift gives detection,
  not prevention, after an authorized or compromised settings change.
- Terraform source, plan, apply, credential cutover, and live proof remain
  separate authority boundaries.
- The default App denial proves the App registration ceiling. The exact live
  ruleset JSON and Team merge prove the server configuration and human path as
  separate facts.

## Evidence

- Terraform lifecycle source:
  [`terraform/github-main-lifecycle-ruleset.tf`](../../terraform/github-main-lifecycle-ruleset.tf)
- Exact plan policy:
  [`scripts/terraform/check-human-merge-boundary-plan.mjs`](../../scripts/terraform/check-human-merge-boundary-plan.mjs)
- Drift evaluator:
  [`scripts/workflows/check-main-rulesets-drift.mjs`](../../scripts/workflows/check-main-rulesets-drift.mjs)
- Broker protocol and activation runbook:
  [`docs/notes/local-agent-github-app-credential.md`](../notes/local-agent-github-app-credential.md)
- Platform plan and apply procedure: [`docs/terraform.md`](../terraform.md)
- Prior merge boundary: [ADR 0075](0075-pr-merge.md)
- Exact-plan guard: [ADR 0061](0061-exact-plan-guard-for-manual-platform-applies.md)
