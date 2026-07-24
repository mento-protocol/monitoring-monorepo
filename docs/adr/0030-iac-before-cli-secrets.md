---
title: All secrets are managed by IaC; agents never touch them with CLI commands
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: terraform/infra
date: 2026-05
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0030 — All secrets are managed by IaC; agents never touch them with CLI commands

**Status:** Accepted (2026), in force.
**Scope:** terraform/infra

## Context

Secrets span GitHub Actions, Vercel, GCP Secret Manager, Upstash, and Grafana. When
a secret is set with a one-off CLI command (`gh secret set`, `vercel env add`,
`gcloud secrets versions add`), the source of truth silently moves out of the repo:
the next `terraform apply` either reverts it or drifts, and no reviewer sees the
change. Agents are especially prone to reaching for the quick CLI fix.

## Decision

**Every secret is modeled in the owning IaC** (a Terraform variable/resource in its
stack, or a documented owning integration such as the Vercel Blob store) and
delivered by a **human-approved plan/apply**. Agents must **not** create, rotate, or
overwrite secrets with CLI commands. If a secret can't be represented in IaC yet,
stop and add the IaC path (or ask), rather than using a CLI workaround.

## Alternatives considered

- **CLI for "just this one" secret** — rejected: creates untracked drift and a second
  source of truth; the whole failure mode this prevents.
- **Secrets in the repo** — rejected: obviously; IaC references them, it doesn't store
  plaintext.

## Consequences

- Secret changes ship as a Terraform diff + docs update in the same PR. Use
  `production-infra` for CI-applied stacks, a human-approved manual plan/apply
  for the `platform` stack, or the documented owning integration path.
- The Vercel Blob OIDC variables are the one integration-owned exception, documented
  as such.

## Evidence

- Secrets Rule in [`AGENTS.md`](../../AGENTS.md) and
  [`terraform/AGENTS.md`](../../terraform/AGENTS.md); stack policies in
  [`terraform.stacks.json`](../../terraform.stacks.json); env-var ownership
  table in [`docs/deployment.md`](../deployment.md).
