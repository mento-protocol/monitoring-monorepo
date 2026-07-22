---
title: Cross-Protocol Context
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Cross-Protocol Context

For any protocol-level question that crosses beyond this monitoring repo, first
read the private `mento-master-context` router when the checkout is available:

```text
../mento-master-context/.agents/mento-context/README.md
```

This applies before broad repo searches for questions about contracts,
deployments, addresses, ABIs, live on-chain state, stable supply, reserve data,
monitoring data semantics, Aegis/Grafana metrics, docs, the whitepaper, business
model, or legal/risk framing. Load only the relevant master-context card(s), then
return to this repo for implementation details. It is a router, not live truth;
verify current values through the source-specific repo, API, RPC, or dashboard
path it points to. When answering, mention which master-context card you used or
state that the checkout was unavailable.
