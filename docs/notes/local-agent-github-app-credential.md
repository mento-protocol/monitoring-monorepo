---
title: Local agent GitHub App credential and main lifecycle cutover
status: active
owner: eng
canonical: true
last_verified: 2026-08-29
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Local agent GitHub App credential and main lifecycle cutover

This runbook activates the target state in
[ADR 0078](../adr/0078-human-only-main-update-boundary.md). Checked-in source
does not prove any GitHub, Google Cloud, host, or cloud-agent state.

Stop at each approval boundary. Do not combine Team setup, App setup, source
merge, Terraform plan, Terraform apply, host installation, credential cutover,
ruleset activation, live proof, or drift activation.

## Required outcome

The completed cutover has these properties:

- core ruleset `13494367` remains unchanged and unmanaged;
- a separate active ruleset restricts creation, update, and deletion of
  `refs/heads/main`;
- that ruleset has one source-pinned Team bypass in `pull_request` mode;
- the selected-repository agent App has no Administration permission and no
  ruleset bypass;
- each agent operation receives one fixed least-privilege profile;
- the App PEM, JWT, and installation token remain inside the trusted broker;
- the dedicated agent OS or container has no human or platform credential;
- every writable cloud-agent surface uses a proved App installation identity;
- Vercel Administration-plus-Contents remains an explicit Free-plan residual;
- live proof records an App permission-ceiling denial, exact live ruleset JSON,
  and an approved Team merge on the same ready PR;
- the daily audit reports `main-ruleset-audit state=ok`.

## Source and live-state boundary

Repository tests can prove parser, policy, profile, redaction, and plan-shape
behavior. They cannot prove these external facts:

- Team membership;
- App registration or selected-repository installation;
- App permission registration;
- the live ruleset IDs or JSON;
- Terraform apply completion;
- root ownership and modes on the broker host;
- the broker OS identity or Google credential;
- removal of a human credential from an agent host;
- a cloud platform's credential type;
- the Vercel plan constraint;
- the App's live permission registration and a permission-denied App merge or
  `main` update attempt;

Record each live fact separately. Do not infer it from source, a plan, an App
name, an installation ID, or a successful read request.

## Credential boundary

Use one GitHub App. Install it only on
`mento-protocol/monitoring-monorepo`. Keep Administration and ruleset bypass
absent. The App registration is the permission ceiling. The trusted broker
requests the smaller profile needed by one operation.

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

The App private key stays in Secret Manager after provisioning. The broker
creates the App JWT and installation token in memory. None of the three values
may reach stdout, stderr, returned JSON, a temporary file, the agent process,
or a caller-controlled child.

Checked-in source keeps the broker scaffold absent. The reviewed policy gate is
false and its impersonator is empty. A separate Phase 4 source change must
enable the complete scaffold and pin its one impersonating service account
before the credential plan can pass.

## Accepted residuals

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

1. Merge the separate Dependabot auto-merge retirement precursor with explicit
   human approval.
2. Wait until no Dependabot auto-merge run is queued, requested, pending,
   waiting, or in progress.
3. Read every open Dependabot PR. Require `autoMergeRequest: null` on each one.
4. Do not rerun a retained Dependabot auto-merge run.
5. Merge #2111 and #2131 through their own reviewed paths.
6. Rebase the boundary source on the resulting current `main`.
7. Repeat the open-PR auto-merge check immediately before the boundary source
   merge and again before the first ruleset apply.

Stop if a run or auto-merge request reappears.

## Phase 1: create the human Team

A human organization administrator creates the merge-operator Team, grants it
the required repository role, and limits membership to approved humans. Record
the Team slug, numeric Team ID, members, repository role, actor, and time.

Put the verified positive numeric ID in the reviewed policy source. Do not use
a slug, node ID, user ID, App ID, installation ID, tfvar, repository variable,
or environment variable as the bypass authority.

The repository-scoped platform PAT must not gain organization or Team
administration for this phase.

## Phase 2: create and install the App

A human security administrator creates one App and installs it only on this
repository. Grant only Actions read, Issues write, and Pull requests write.
Do not grant Administration, Contents, Workflows, Checks, or organization
Projects. The disabled Git and issue-board profiles need a separate reviewed
App-permission change and activation proof. Record:

- App ID and installation ID;
- selected repository;
- registered permission ceiling;
- absence of Administration;
- absence of a ruleset bypass;
- the owner and time of the check.

Prepare a mode-`0700` operator-owned intake directory before key generation.
Keep it outside repositories, worktrees, agent homes, shared temporary paths,
sync roots, and backup roots. Configure the browser to use that directory.

Generate one key. Require one regular operator-owned PEM file. Set its mode to
`0600` before transfer. Do not print its contents. Transfer it once into the
mode-`0600`, gitignored operator platform tfvars file. Do not use an argument,
environment variable, command substitution, clipboard history, repository
file, log, or extra temporary file.

Remove the browser download and any partial copy after the operator tfvars copy
is verified. If custody or complete removal is uncertain, revoke the key and
start again. File deletion does not revoke a key.

## Phase 3: create the disabled lifecycle ruleset

The reviewed policy starts with:

- the verified positive Team ID;
- managed lifecycle ruleset ID `0`;
- enforcement disabled;
- drift audit inactive.
- broker scaffold disabled;
- broker impersonator empty.

From a clean current-`main` operator checkout, run the guarded platform
preflight. The exact policy must permit one creation only. Require:

- no prior value at the managed lifecycle resource address;
- enforcement disabled;
- exact `refs/heads/main` targeting;
- creation, update, and deletion rules only;
- one source-pinned Team bypass in `pull_request` mode;
- no core ruleset resource;
- no action for core ruleset ID `13494367`;
- no broker service account, secret, credential version, accessor binding, or
  impersonation binding;
- no replacement, deletion, unknown managed field, or second ruleset.

Require the lifecycle ruleset create to be the plan's only non-no-op action.
The exact plan guard rejects any broker or unrelated change in this phase.

Review the full plan. Obtain separate apply approval. Run the guarded apply
from the same clean current-`main` source. Do not use direct Terraform apply.

Read the new live ruleset ID through the human Administration-read surface.
Require a positive ID different from `13494367`. Pin it in a reviewed source
change. Repeat the guarded plan. It must be a no-op for the disabled ruleset.

## Phase 4: provision the App key and broker principal

Start with a separate reviewed source change. Set the broker-scaffold policy
gate to true and pin the one approved broker impersonating principal. Keep the
gate and principal in reviewed source. Do not select either from a tfvar,
repository variable, or environment variable. The managed lifecycle ruleset
ID must already be positive and pinned.

Use the operator tfvars file for the App and installation IDs, positive
rotation counter, credential-active selector, and App key. When the selector is
true, Terraform accepts only a complete PKCS#1 or PKCS#8 PEM envelope no larger
than 65,536 bytes. An omitted, blank, malformed, or oversized key fails during
input validation before apply. The key remains sensitive and ephemeral. It
does not enter a managed-resource lifecycle condition, output, log, plan, or
state.

The platform wrapper rejects the App key and platform GitHub PAT in
`TF_VAR_*`, ambient GitHub authentication, and CLI `-var` arguments. It copies
the variable file once into its private plan directory. Terraform sends the
key only to the write-only Secret Manager field.

Review the guarded plan. Require only the expected service account, secret,
write-only version, accessor binding, and exact impersonation binding as
non-no-op actions. All five resources must be created together. The disabled,
pinned lifecycle ruleset must be unchanged. The exact plan guard rejects a
partial scaffold, an unrelated change, or broker provisioning while the source
gate is false. Obtain separate apply approval. Apply the checked plan. Remove
any obsolete operator key copy only when the approved rotation and recovery
process no longer needs it. Revoke the key if custody becomes uncertain.

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
pnpm github:agent -- --profile <profile> -- <operation> [arguments]
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

## Phase 7: activate the lifecycle ruleset

Change only the reviewed enforcement selector from disabled to active. Keep
the source-pinned managed ruleset ID unchanged. Review the guarded plan.
Require one in-place update at that exact ID and no core ruleset action.

Obtain separate apply approval. Apply through the guarded wrapper. Read both
live rulesets through the human Administration-read surface. Require:

- unchanged core ruleset ID `13494367` and exact core shape;
- exact pinned lifecycle ruleset ID;
- active enforcement;
- creation, update, and deletion rules only;
- one approved Team bypass in `pull_request` mode;
- no App, Integration, administrator, role, or user bypass.

## Phase 8: prove the boundary

Use one ready, same-repository PR whose exact head passed required checks and
reviews. Keep the PR unchanged during proof.

1. Read the selected-repository App installation through the human
   Administration surface. Require Contents to be absent. Record the exact
   installation identity, selected repository, and permission map.
2. Through a trusted operator diagnostic that does not reveal the installation
   token, ask GitHub to perform the App-authenticated merge or equivalent
   `main` update. Require the fixed `permission-ceiling-denied` result. Do not
   return headers, request bodies, tokens, or raw provider output.
3. Record the exact live JSON for core ruleset `13494367` and the pinned
   lifecycle ruleset. Require the lifecycle ruleset to be active, target only
   `refs/heads/main`, contain only creation, update, and deletion restrictions,
   and name only the approved Team in `pull_request` bypass mode.
4. Have an approved Team member merge the same ready PR through the approved
   human merge command. Require the merge record to identify that Team member;
   this proves the source-pinned Team `pull_request` bypass path succeeded.
5. Record the PR, exact head, App installation identity, permission-denial
   class, human actor, merge record, both live ruleset JSON documents, and
   time.

The App attempt proves the App permission ceiling. It cannot prove lifecycle
ruleset evaluation because the App has no Contents permission. The exact live
ruleset JSON and the Team merge are separate proof of the configured server
control and approved human path. Do not describe the App denial as a lifecycle
ruleset refusal.

Do not add a rejected direct push as a substitute for any step. The core
pull-request rule can reject that push before the lifecycle identity rule is
tested.

## Phase 9: activate daily drift enforcement

After live proof, change only the reviewed audit selector to active. Merge that
source change through the human path. Run the platform-settings drift workflow
from trusted `main`. Require `main-ruleset-audit state=ok`.

An inert result is not proof. A missing Administration-read audit credential
must fail after activation.

## Credential inventory

Before activation and at each review interval, inventory:

- every credential issued by a merge-operator Team member;
- repository, organization, and environment Actions credential metadata;
- external CI, bot, broker, build, and deployment credentials;
- cloud-agent credential types and repository selection;
- the platform Administration PAT and its absence of Contents;
- the ruleset-audit PAT and its read-only Administration scope;
- the App registration, installation, profiles, and lack of bypass;
- protected Google principals that can read the App key;
- Vercel Administration and Contents with the Free-plan acceptance record.

Revoke an unknown credential. Revoke or rotate a human or platform credential
that reached an agent surface. Do not infer issuer identity from a secret name.

## Rotation

Key rotation needs separate approval. Disable the broker first. Generate and
transfer the replacement through the secure intake procedure. Increment the
reviewed write-only rotation counter. Review and apply the guarded credential
plan. Install and verify the new key. Revoke the old key. Wait for old
installation tokens to expire before re-enabling the broker.

Repeat the no-token, profile, repository, expiry, and refusal canaries after
rotation.

## Rollback and incidents

Disable the agent broker or App installation before changing the lifecycle
rule. Do not weaken the server control to recover an agent workflow.

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
- the App receives Administration or a bypass;
- a token, JWT, or PEM reaches an agent or output surface;
- a human or platform credential reaches an agent surface;
- Vercel changes the ruleset or `main` outside its accepted operation;
- the active audit reports drift, malformed state, or a missing credential.

Stop agent writes, preserve non-secret evidence, revoke affected credentials,
restore reviewed controls through the human path, and reconcile source before
resuming.
