---
title: Terraform CI/CD hardening — decisions recorded
status: active
owner: eng
last_verified: 2026-05-29
---

# Terraform CI/CD hardening — decisions recorded

Migrated off `BACKLOG.md` 2026-05-29. PR #622 shipped a saved-plan-style
"skip-when-no-changes" + production-environment gate refactor for `alerts/rules/`
and `alerts/infra/`. Follow-up PRs added Aegis auto-apply, scheduled drift
detection, and the local Terraform apply guard. Plan-credential hardening is
complete: the read-only plan SA (`metrics-bridge-plan-readonly@` →
`org-terraform-plan-readonly@…seed`, `objectViewer` on the state bucket only)
runs every PR-triggered Terraform plan job — grafana-only stacks (`alerts-rules`,
`aegis`) via `-backend-config` + `-lock=false`, and `alerts/infra` via the same
plus `-refresh=false`. `terraform-drift.yml` applies the same per-leg least
privilege (registry-driven via `matrix.planSa`).

**Everything actionable shipped.** The two decisions below were evaluated and
**declined by design** — recorded here so they are not re-litigated. (See also
PR #686, which recorded the fully-read-only drift cron as declined on
cost/benefit.)

## Declined: full-refresh read-only plan for the `alerts/infra` leg (PR plan and drift)

Both the `alerts/infra` PR plan (`-refresh=false`) and its drift leg (kept on the
write SA) stop short of a full-refresh read-only plan for the same irreducible
reason: the read-only seed SA has no project roles, so refreshing the stack's
google-provider resources would 403 (the grafana legs were free to flip because
grafana refreshes over its own token, never touching GCP). Closing it needs a
read identity with access to the `project_factory`-managed project.

- **PR plan:** don't. The only way to full-refresh the PR plan is to arm the
  read-only plan SA — the SA a malicious same-repo PR can mint via a plan-time
  data source — with project read, *widening* the PR attack surface.
  `-refresh=false` is a *functional* limitation (the PR plan won't surface
  out-of-band drift), not a security gap; drift is caught daily anyway.
- **Drift leg:** evaluated explicitly (incl. an operator offering to create the
  grant, 2026-05-29) and declined on cost/benefit. The only sound build is a
  *dedicated* `*-drift-readonly@` SA (never PR-reachable) with a hand-scoped read
  role on the alerts project + a human-reviewed apply on the `terraform/`
  platform stack — moderate, recurring cost (the scoped role must track the
  stack's resource set). The gain is low and partial: it takes the daily
  unattended cron to 0 write-SA legs, but the same `org-terraform@` deployer is
  minted by the apply jobs on every merge via the same pinned actions, so a
  supply-chain compromise of a shared action is unaffected; and drift is
  schedule/dispatch-only, so the malicious-PR vector never applied here.
  **Reopen only under a stated "no unattended CI job holds write credentials"
  invariant** (audit/compliance, or expanding what auto-applies) — then it's one
  line-item in machinery you're building anyway.

## Declined: saved-plan binding via KMS

PR #622's audit considered re-introducing the binary `tfplan` artifact via KMS
envelope encryption to recover the "binding plan" property (byte-for-byte
equality between PR-time review and apply-time execution). Cost/value: alerts
stacks change ~1-2× per month, blast radius is alert delivery (recoverable on
15-min cycle), and the drift window between plan and apply is mitigated by the
re-plan at the apply gate. **Hard prerequisite to revisit: keep scheduled drift
detection healthy for every auto-applied stack.** Once drift is caught within 24h
regardless of which plan ran, the marginal value of binding-plan approaches zero.
Reopen only if a higher-blast-radius stack (e.g. `terraform/` platform) moves to
auto-apply.
