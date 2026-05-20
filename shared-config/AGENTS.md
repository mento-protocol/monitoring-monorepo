---
title: Shared Config Instructions
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
---

# AGENTS.md — Shared Config

## Scope

`shared-config/` is the source of truth for chain metadata, deployment namespaces, token/pool label derivation, FX calendar data, and shared ABIs.

## Operating Rules

- Add or change config data with a cross-reference test.
- Keep exported modules stable for all consumers; dashboard, indexer, and bridge typechecks are part of the change surface.
- If `fx-calendar.json` changes, verify trading-seconds assumptions in both dashboard and indexer code paths.
- Do not hand-edit `dist/` as the source of truth. Update `src/` or JSON inputs, then run the package build.
- Avoid importing runtime-heavy packages here. `shared-config` is consumed by client bundle code and should stay low-dependency.

## Verification

Run monitoring-config lint, typecheck, test, and build, then typecheck consumers when exported shapes change.
