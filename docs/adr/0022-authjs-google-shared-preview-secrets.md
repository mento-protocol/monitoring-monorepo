---
title: Auth.js with Google; previews share prod auth secrets behind SSO and Git fork protection
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: ui-dashboard
date: 2026-03
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0022 — Auth.js + Google; previews share prod auth secrets behind SSO and Git fork protection

**Status:** Accepted (Mar 2026), in force.
**Scope:** ui-dashboard

## Context

Most of the dashboard is public, but private pages, write APIs, and selected
controls require a `@mentolabs.xyz` session. Google-based login must also work on
Vercel preview deployments, where OAuth callbacks land on the production domain.

## Decision

Use **Auth.js v5 with Google OAuth**. Preview deployments receive the **same**
`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`/`AUTH_SECRET` as production, because the
`redirectProxyUrl` flow requires the signed state JWE to verify against the same
`AUTH_SECRET` on both ends. This is made safe by two controls: **Vercel Deployment
Protection** and **Git fork protection**. The live Vercel project applies SSO
protection to all previews and production deployment URLs, and refuses preview
deployments from fork PRs.

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

- Google OAuth + Auth.js `4c970a0b`, `redirectProxyUrl` `92ff92ba` (2026-03);
  rotation support PR #1003.
- Live `monitoring-dashboard` protection verified with
  `vercel project protection monitoring-dashboard --scope mentolabs --format json`
  on 2026-07-24: SSO covers all previews and production deployment URLs;
  `gitForkProtection` is enabled.
- Full rationale in [`docs/deployment.md`](../deployment.md) §Security Posture —
  Preview Deployments and `terraform/dashboard.tf`.
