---
title: Auth.js with Google; previews share prod auth secrets behind Deployment Protection
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
scope: ui-dashboard
date: 2026-03
---

# ADR 0022 — Auth.js + Google; previews share prod auth secrets behind Deployment Protection

**Status:** Accepted (Mar 2026), in force.
**Scope:** ui-dashboard

## Context

Most of the dashboard is public, but some surfaces are gated: editing address
labels, `/address-book`, `/entities`, and some `/volume`/`/integrations` controls.
We need Google-based login that also works on Vercel preview deployments, where
Google OAuth callbacks land on the production domain.

## Decision

Use **Auth.js v5 with Google OAuth**. Preview deployments receive the **same**
`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`/`AUTH_SECRET` as production, because the
`redirectProxyUrl` flow requires the signed state JWE to verify against the same
`AUTH_SECRET` on both ends. This is made safe by two controls: **Vercel Deployment
Protection** (only team members reach a preview URL) and **fork PRs producing no
preview deployments**.

## Alternatives considered

- **Separate secrets per environment** — rejected: breaks the `redirectProxyUrl`
  preview-auth flow (would need a different OAuth client + domain-local state).
- **No auth on previews** — rejected: the prior bypass relied solely on Deployment
  Protection; app-level auth is the stronger posture.

## Consequences

- If either control (Deployment Protection, fork-preview-off) is loosened, treat all
  three shared secrets as exposed and rotate them via Terraform.
- `CRON_SECRET` is production-only, so a compromised preview can't forge Bearer auth
  against prod backup endpoints. `AUTH_SECRET_PREV` supports graceful rotation.

## Evidence

- Google OAuth + Auth.js `4c970a0b`, `redirectProxyUrl` `92ff92ba` (2026-03); rotation support PR #1003.
- Full rationale in [`docs/deployment.md`](../deployment.md) §Security Posture — Preview Deployments and `terraform/dashboard.tf`.
