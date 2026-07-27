---
title: Documentation Navigation Evaluation
status: active
owner: eng
canonical: true
last_verified: 2026-07-27
doc_type: runbook
scope: ci/process
review_interval_days: 90
garden_lane: operator-runbooks
---

# Documentation navigation evaluation

This evaluation measures whether a fresh repository agent can find the current
documentation authority without loading the whole corpus. It complements the
deterministic catalog, context budgets, and garden planner: those tools prove
that routes exist and fit their limits, while this suite tests whether a new
agent actually follows them and qualifies historical context correctly.

The evaluation is read-only. CI validates fixtures, result parsing, scoring,
and monthly issue scheduling, but it never stores a model credential, invokes a
model, edits documentation, or opens a PR.

## Contract

The versioned inputs are:

- `documentation-navigation-fixtures.json` — 18 questions, three for each of
  packages, deployment, architecture, PR hazards, commands, and operator
  workflows. Expected routes name authority, not brittle answer prose.
- `documentation-navigation-result.schema.json` — the exact structured result
  envelope.
- `documentation-navigation-baseline.json` — the evidence-backed run captured
  before the first six-lane semantic garden in issues #1348–#1353.
- `documentation-navigation-baseline-fixtures.json` — the frozen fixture
  contract used by that historical run. Current fixture changes never rewrite
  either baseline artifact.

The prompt deliberately omits accepted routes and historical-source traps. It
starts from root `AGENTS.md` plus the generated `docs/README.md`, forbids the
fixture, scorer, and baseline artifacts, and asks the agent to retrieve only
the narrowest useful documents.

Every result records:

- the fixture digest, evaluated commit, fresh-context/read-only attestations,
  model, effort, and execution time;
- ordered chosen documents and a concise answer for every question;
- one-based line evidence from the matched canonical route;
- the authority classification and qualification for each additional source;
- exact UTF-8 bytes and SHA-256 for every loaded source.

The validator recomputes authority, bytes, hashes, line bounds, and scores from
the Git commit named by the result. That keeps the pre-garden baseline
reproducible after later documentation edits. Self-reported scores are never
trusted. CI and the monthly scheduler both reject a missing, malformed, or
failing committed baseline before treating it as historical comparison
evidence. They validate it against the frozen baseline fixtures, not the
current contract.

`sources_requiring_verification` entries are historical qualification traps,
not live routes. A trap may remain in the immutable fixture after its document
is retired only when the evaluator explicitly lists that path as a tombstone;
every other missing path fails fixture validation. The trap applies only when
an evaluated agent actually loads that path at the result's pinned commit. Its
`verify_against` targets must remain current canonical authority.

## Run locally

Validate the deterministic contract first:

```bash
git status --short                 # must be empty
pnpm docs:navigation-eval -- --check-fixtures
pnpm docs:navigation-eval -- --prompt > /tmp/documentation-navigation-prompt.md
```

Prompt generation refuses a dirty checkout: the reported
`repository_base_commit` must identify the exact documentation bytes the agent
read. A result committed from a squash-merged PR must not point at an
intermediate branch commit, because a fresh clone of `main` may not contain
that object. For a pre-change baseline in the same PR as the evaluation
contract, fetch `origin/main`, verify the chosen SHA is its ancestor, and pin
the prompt explicitly:

```bash
BASE_COMMIT="$(git rev-parse origin/main)"
git merge-base --is-ancestor "$BASE_COMMIT" origin/main
pnpm docs:navigation-eval -- --prompt --base-commit "$BASE_COMMIT" \
  > /tmp/documentation-navigation-prompt.md
```

Otherwise, land the contract first and generate the result from a clean
default-branch commit in a follow-up PR. CI and the monthly workflow use a
full-history checkout so a committed result remains reproducible from any
reachable default-branch ancestor.

Run that prompt in a fresh ephemeral agent with repository read access only,
network disabled, and the result schema enforced. For example, with a locally
authenticated Codex CLI:

```bash
codex exec --ephemeral --sandbox read-only --cd . \
  --output-schema docs/evals/documentation-navigation-result.schema.json \
  - < /tmp/documentation-navigation-prompt.md \
  > /tmp/documentation-navigation-result.json
```

The evaluator must remain a distinct fresh context; do not use the agent that
wrote or reviewed the fixtures. Record the actual model and effort in the
result, then validate it:

```bash
pnpm docs:navigation-eval -- --validate /tmp/documentation-navigation-result.json
```

Validate the committed historical result against its frozen contract:

```bash
pnpm docs:navigation-eval -- --validate \
  docs/evals/documentation-navigation-baseline.json \
  --fixtures docs/evals/documentation-navigation-baseline-fixtures.json
```

For one failed or contested case, generate a bounded escalation prompt:

```bash
pnpm docs:navigation-eval -- --prompt --question commands-pr-readiness
pnpm docs:navigation-eval -- --validate /tmp/question-result.json --question commands-pr-readiness
```

A targeted result uses the same envelope and fixture digest but contains exactly
one answer. The validator keeps full runs at 15–20 answers, so a partial result
cannot be mistaken for a complete baseline.

The validator exits nonzero for malformed or incomplete results and for a
valid result that misses a target.

## Scores and targets

Scores stay separate so a cheap strength cannot hide an expensive failure:

- **Routing accuracy** — the ordered chosen documents contain an accepted
  canonical route. Initial target: at least 90%.
- **Canonical-source compliance** — every non-canonical or unmanaged source is
  explicitly qualified and verified against loaded canonical authority.
  Target: zero unqualified uses.
- **Answer evidence** — every chosen document has valid targeted line evidence,
  measured independently of whether the chosen order matches an accepted
  route. Target: 100%.
- **Shortest useful path** — the chosen set is exactly the smallest matched
  route. Extra exploratory reads lower the reported route-efficiency ratio but
  do not masquerade as a routing failure.
- **Context bytes** — source bytes are recomputed per question and as a unique
  suite total. No question may exceed 45,000 additional source bytes and the
  complete run may not exceed 260,000 unique source bytes, including bootstrap
  sources. Fixture validation also proves that the cheapest accepted route for
  every question, and their unique union, fit those caps before a run begins.

The scorer intentionally does not claim to grade arbitrary prose for semantic
correctness. Canonical routing plus exact evidence makes the answer reviewable;
failed or ambiguous answers receive the stronger-model and independent-review
path below.

## Cost and review policy

Use the cheapest capable read-only model at low effort for the full routine
suite. Escalate only a failed or ambiguous question to a stronger reasoning
model, initially at medium effort. Any proposed change to a canonical route,
accepted route fixture, authority classification, or context limit requires an
independent high-effort review before a normal PR.

Never improve a score by exposing expected routes to the evaluated agent,
dropping a difficult question, weakening authority rules, or omitting a loaded
source. A real routing failure is useful evidence and should become a linked
issue.

## Monthly issue and routing reminders

The existing `Documentation Garden` workflow also runs the deterministic
monthly issue synchronizer. It uses the same serialized, default-branch and
OIDC-bound issue-only trust boundary as the weekly garden queue. The monthly
step:

- never invokes a model or writes repository content;
- creates at most one live navigation-evaluation issue, identified by leading
  month and fixture-digest markers plus the workflow-owned `source:audit`
  label; marker text on an unlabeled public issue is never trusted;
- preserves an open issue unchanged across reruns and blocks a later month
  until the prior issue closes;
- lists routing-sensitive paths changed since the committed baseline;
- validates the immutable baseline against its frozen fixture contract;
- creates a current-contract issue when the current fixture digest differs
  from the baseline, even during the same month.

Only the workflow or a maintainer with label permissions may apply
`source:audit`. Queue-state labels may change during claiming, but this durable
ownership label must remain on scheduler-created issues.

A monthly evaluation with no defects may close after posting its validated
score and comparison evidence. Confirmed defects become linked agent-ready
issues. The evaluation agent itself never edits documentation.

## Baseline and post-garden comparison

The baseline captures the route quality before issues #1348–#1353 prune and
consolidate the six documentation lanes. Keep both the result and its frozen
fixture artifact immutable. Baseline validation classifies those frozen routes
from `repository_base_commit`, so later retirement or authority changes in the
working tree do not rewrite the historical contract. A contract-changing PR
cannot commit its own
post-change result: the evaluated commit must already be reachable from the
default branch. After the change merges, the monthly issue runs the current
fixture from clean `main`; commit its dated result plus a short comparison in a
follow-up PR. If a fixture must change because the intended route or context
contract changed, review that change separately and report both the
historical-suite and current-suite interpretation instead of silently rewriting
the baseline digest.

### 2026-07 post-garden result

The first run after all six baseline garden trackers closed is
[`documentation-navigation-2026-07-post-garden.json`](documentation-navigation-2026-07-post-garden.json).
It evaluated default-branch commit
`c909129681b2e041f05f10e72e85a0ff7f98ec52` with `gpt-5.6-terra` at low
effort.

| Measure                             |   Frozen baseline | 2026-07 post-garden |
| ----------------------------------- | ----------------: | ------------------: |
| Routing accuracy                    |             94.4% |               88.9% |
| Unqualified non-canonical sources   |                 0 |                   0 |
| Answer evidence                     |              100% |                100% |
| Shortest useful path                |             88.9% |               88.9% |
| Bootstrap bytes                     |            42,681 |              27,305 |
| Unique suite bytes                  | 245,723 / 272,000 |   249,421 / 260,000 |
| Questions over the per-question cap |                 0 |                   0 |

The current run missed `package-indexer-add-contract`, which the baseline also
missed, and `operator-alerts-stack-boundary`. Independent review found both to
be evaluator retrieval mistakes rather than repository routing defects. The
indexer route reaches the detailed procedure through `indexer-envio/AGENTS.md`
and `indexer-envio/README.md`; the alerts boundary is stated directly in
`alerts/AGENTS.md`. No documentation follow-up issue was required.

Because two independent runs have now missed `package-indexer-add-contract`, a
third independent miss must trigger a fresh review of the accepted route and
fixture instead of another automatic evaluator-error disposition.
