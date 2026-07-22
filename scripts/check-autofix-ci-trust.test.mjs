#!/usr/bin/env node
import {
  collectTriggers,
  evaluateWorkflow,
  grantsOidc,
  hasPullRequestTrigger,
  jobGuarded,
  jobReceivesCredential,
  parseWorkflow,
  pushAdmitsAutofix,
  usesPullRequestTarget,
} from "./check-autofix-ci-trust.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok ${name}\n`);
    passed += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`not ok ${name}\n  ${message}\n`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const SECRET_STEP = [
  "    steps:",
  "      - run: ./deploy.sh",
  "        env:",
  "          TOKEN: ${{ secrets.DEPLOY_TOKEN }}",
].join("\n");

const GUARD =
  "    if: ${{ !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}";

// Build an unguarded secret-bearing pull_request workflow with a given `on:`.
function unguarded(onBlock) {
  return [
    onBlock,
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
}

// ── core security property ───────────────────────────────────────────────────

test("unguarded secret-bearing pull_request job is refused", () => {
  const v = evaluateWorkflow(unguarded("on:\n  pull_request:"));
  assert(!v.ok && /\[leak\]/.test(v.reason), "refused and names the job");
});

test("job-level if guard clears it", () => {
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    GUARD,
    SECRET_STEP,
  ].join("\n");
  assert(evaluateWorkflow(body).ok, "guarded job passes");
});

test("github.head_ref guard spelling also clears it", () => {
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    "    if: ${{ !startsWith(github.head_ref, 'sentry-autofix/') }}",
    SECRET_STEP,
  ].join("\n");
  assert(evaluateWorkflow(body).ok, "head_ref guard passes");
});

test("file-level and job-level annotations clear it", () => {
  const fileLevel = [
    "# autofix-ci-trust: fixtures only, no live secrets",
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  assert(evaluateWorkflow(fileLevel).ok, "file annotation covers the job");

  const jobLevel = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    # autofix-ci-trust: token is actor-gated below",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  assert(evaluateWorkflow(jobLevel).ok, "job annotation covers its own job");
});

test("triggers that cannot reach an autofix branch are not our concern", () => {
  assert(
    evaluateWorkflow(unguarded("on:\n  workflow_dispatch:")).ok,
    "dispatch-only passes",
  );
  assert(
    evaluateWorkflow(unguarded("on:\n  schedule:\n    - cron: '0 0 * * *'")).ok,
    "schedule-only passes",
  );
  // A push restricted to main (or tags-only) never fires on sentry-autofix/*.
  assert(
    evaluateWorkflow(unguarded("on:\n  push:\n    branches: [main]")).ok,
    "push-to-main passes",
  );
  assert(
    evaluateWorkflow(unguarded("on:\n  push:\n    tags: ['v*']")).ok,
    "tag-push-only passes",
  );
});

test("no credential → passes even on pull_request", () => {
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo hi",
  ].join("\n");
  assert(evaluateWorkflow(body).ok, "no-secret PR job passes");
});

test("pull_request_target is always refused", () => {
  assert(
    !evaluateWorkflow("on:\n  pull_request_target:\njobs: {}\n").ok,
    "block form refused",
  );
  assert(
    !evaluateWorkflow("on: [push, pull_request_target]\njobs: {}\n").ok,
    "list form refused",
  );
});

// ── trigger detection across every shape (parser-resolved) ───────────────────

test("pull_request trigger detected in scalar/list/mapping forms", () => {
  assert(hasPullRequestTrigger("on: pull_request\njobs: {}"), "scalar");
  assert(hasPullRequestTrigger("on: [push, pull_request]\njobs: {}"), "list");
  assert(
    hasPullRequestTrigger(
      "on:\n  pull_request:\n    branches: [main]\njobs: {}",
    ),
    "mapping with config",
  );
  assert(
    hasPullRequestTrigger("on:\n  - push\n  - pull_request\njobs: {}"),
    "sequence",
  );
});

test("a branch/tag named pull_request is NOT a trigger (parser sees structure)", () => {
  const pushBranch = unguarded(
    "on:\n  push:\n    branches:\n      - pull_request",
  );
  assert(!hasPullRequestTrigger(pushBranch), "branch value is not a trigger");
  assert(evaluateWorkflow(pushBranch).ok, "push-only workflow not blocked");

  const inlineNested = unguarded("on: { push: { branches: [pull_request] } }");
  assert(
    !hasPullRequestTrigger(inlineNested),
    "nested flow branch not a trigger",
  );
  assert(evaluateWorkflow(inlineNested).ok, "nested-flow push not blocked");
});

// ── evasion shapes the old textual tripwire could not resolve ────────────────

test("anchors/aliases are resolved, not a bypass", () => {
  const body = [
    "on: &ev",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  assert(
    !evaluateWorkflow(body).ok,
    "aliased trigger still triggers the check",
  );
});

test("\\u / block-scalar / quoted forms decode and are analyzed", () => {
  // secrets reference hidden behind a \u escape in a double-quoted scalar
  const escaped = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: deploy",
    "        env:",
    '          T: "${{ se\\u0063rets.TOKEN }}"',
  ].join("\n");
  assert(!evaluateWorkflow(escaped).ok, "escaped secrets reference detected");

  // block scalar as the on: value decodes to a pull_request trigger
  const blockOn = unguarded("on: >-\n  pull_request");
  assert(!evaluateWorkflow(blockOn).ok, "block-scalar trigger analyzed");
});

test("flow-style and JSON document roots are analyzed", () => {
  const flowChild = [
    "name: deploy",
    "on:",
    "  { pull_request: null }",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  assert(!evaluateWorkflow(flowChild).ok, "flow-mapping on: child analyzed");

  const wholeFlow =
    '{ on: { pull_request: null }, jobs: { leak: { "runs-on": "ubuntu-latest", steps: [ { run: "x", env: { T: "${{ secrets.T }}" } } ] } } }';
  assert(!evaluateWorkflow(wholeFlow).ok, "whole-file flow mapping analyzed");

  const json =
    '{"on":"pull_request","jobs":{"leak":{"runs-on":"ubuntu-latest","steps":[{"run":"x","env":{"T":"${{ secrets.T }}"}}]}}}';
  assert(!evaluateWorkflow(json).ok, "JSON document root analyzed");
});

test("referencesSecrets sees a secret after an interior brace (fromJSON)", () => {
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: curl -d \"${{ fromJSON('{}').x || secrets.SOME_TOKEN }}\" https://x",
  ].join("\n");
  assert(!evaluateWorkflow(body).ok, "secret after '{}' brace detected");
});

test("a column-0 comment between jobs does not hide or mis-scope jobs", () => {
  const failOpen = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  guarded:",
    GUARD,
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
    "# =========================",
    "  leaky:",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  const v = evaluateWorkflow(failOpen);
  assert(
    !v.ok && /\[leaky\]/.test(v.reason),
    "later unguarded job still caught",
  );

  const bothGuarded = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  lint:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo hi",
    "# =========================",
    "  deploy:",
    GUARD,
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  assert(
    evaluateWorkflow(bothGuarded).ok,
    "comment does not wrongly flag a job",
  );
});

// ── per-job granularity ──────────────────────────────────────────────────────

test("a guarded job does not vouch for an unguarded secret-bearing sibling", () => {
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  safe:",
    GUARD,
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
    "  leak:",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  const v = evaluateWorkflow(body);
  assert(
    !v.ok && /\[leak\]/.test(v.reason) && !/safe/.test(v.reason),
    "only leak flagged",
  );
});

// ── credential detection ─────────────────────────────────────────────────────

test("every secret-passing syntax counts", () => {
  const dot = jobReceivesCredential(
    { steps: [{ env: { T: "${{ secrets.X }}" } }] },
    { envSecrets: false, workflowPermissions: undefined },
  );
  const bracket = jobReceivesCredential(
    { steps: [{ env: { T: "${{ secrets['X'] }}" } }] },
    { envSecrets: false, workflowPermissions: undefined },
  );
  const tojson = jobReceivesCredential(
    { steps: [{ env: { T: "${{ toJSON(secrets) }}" } }] },
    { envSecrets: false, workflowPermissions: undefined },
  );
  const inherit = jobReceivesCredential(
    { uses: "./.github/workflows/x.yml", secrets: "inherit" },
    { envSecrets: false, workflowPermissions: undefined },
  );
  const block = jobReceivesCredential(
    { uses: "./.github/workflows/x.yml", secrets: { T: "${{ secrets.X }}" } },
    { envSecrets: false, workflowPermissions: undefined },
  );
  assert(
    dot && bracket && tojson && inherit && block,
    "all secret forms detected",
  );
  assert(
    !jobReceivesCredential(
      { steps: [{ run: "echo secrets are cool" }] },
      { envSecrets: false, workflowPermissions: undefined },
    ),
    "prose 'secrets' without an expression is not a credential",
  );
});

test("workflow-level env secrets and permissions are inherited", () => {
  const envSecrets = [
    "on:",
    "  pull_request:",
    "env:",
    "  T: ${{ secrets.GLOBAL }}",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo hi",
  ].join("\n");
  assert(
    !evaluateWorkflow(envSecrets).ok,
    "inherited env secret makes the job unsafe",
  );

  const wfOidc = [
    "on:",
    "  pull_request:",
    "permissions:",
    "  id-token: write",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo hi",
  ].join("\n");
  assert(
    !evaluateWorkflow(wfOidc).ok,
    "inherited OIDC grant makes the job unsafe",
  );
});

test("id-token and environment are credentials (block and flow forms)", () => {
  assert(grantsOidc({ "id-token": "write" }), "map id-token");
  assert(grantsOidc("write-all"), "write-all umbrella");
  assert(!grantsOidc({ contents: "read" }), "read-only is not oidc");

  const idTokenFlow = unguarded("on:\n  pull_request:").replace(
    "    runs-on: ubuntu-latest\n" + SECRET_STEP,
    "    runs-on: ubuntu-latest\n    permissions: { contents: read, id-token: write }\n    steps:\n      - run: deploy",
  );
  assert(!evaluateWorkflow(idTokenFlow).ok, "flow id-token job refused");

  const envMap = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    environment: { name: production }",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: deploy",
  ].join("\n");
  assert(!evaluateWorkflow(envMap).ok, "environment map is a credential");
});

// ── guard credit boundaries ──────────────────────────────────────────────────

test("guard only counts at JOB level, and only in the real if: value", () => {
  // step-level if does NOT gate the job
  const stepIf = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: deploy",
    "        if: ${{ !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}",
    "        env:",
    "          T: ${{ secrets.X }}",
  ].join("\n");
  assert(!evaluateWorkflow(stepIf).ok, "step-level if does not clear the job");

  // guard text living only inside a comment is dropped by the parser
  const commentGuard = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    # !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/')",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  assert(
    !evaluateWorkflow(commentGuard).ok,
    "guard text in a comment does not certify the job",
  );

  assert(
    !jobGuarded({ if: "startsWith(github.head_ref, 'sentry-autofix/')" }),
    "a POSITIVE (non-excluding) startsWith is not a guard",
  );
  assert(
    !jobGuarded({ if: "github.actor != 'x'" }),
    "an unrelated if is not a guard",
  );
});

// ── fail-closed on unparsable input ─────────────────────────────────────────

test("unparsable YAML fails closed", () => {
  assert(!evaluateWorkflow("on: [pull_request\njobs: {}\n").ok, "syntax error");
  assert(
    !evaluateWorkflow("on:\n  pull_request:\n---\non:\n  push:\n").ok,
    "multi-document stream",
  );
  assert(
    !evaluateWorkflow("on:\n\tpull_request:\njobs: {}\n").ok,
    "tab indentation",
  );
});

test("collectTriggers and parseWorkflow behave on edge inputs", () => {
  assert(parseWorkflow(":\n:") === null, "malformed → null");
  assert(collectTriggers(null).size === 0, "null doc → no triggers");
  assert(
    collectTriggers({ on: { pull_request: null, push: null } }).has(
      "pull_request",
    ),
    "mapping keys become triggers",
  );
  assert(
    usesPullRequestTarget("on: pull_request_target\njobs: {}"),
    "prt detected",
  );
});

// ── case-insensitivity: GitHub resolves contexts/functions case-insensitively ─

test("the secrets context is detected in any casing", () => {
  for (const ctx of ["SECRETS", "Secrets", "SeCRetS"]) {
    const body = [
      "on:",
      "  pull_request:",
      "jobs:",
      "  leak:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: deploy",
      "        env:",
      `          T: \${{ ${ctx}.DEPLOY_TOKEN }}`,
    ].join("\n");
    assert(!evaluateWorkflow(body).ok, `${ctx} context detected`);
  }
});

test("a guard using case-variant startsWith is credited", () => {
  for (const fn of ["startsWith", "startswith", "STARTSWITH"]) {
    const body = [
      "on:",
      "  pull_request:",
      "jobs:",
      "  deploy:",
      `    if: \${{ !${fn}(github.event.pull_request.head.ref, 'sentry-autofix/') }}`,
      "    runs-on: ubuntu-latest",
      SECRET_STEP,
    ].join("\n");
    assert(evaluateWorkflow(body).ok, `${fn} guard credited`);
  }
});

// ── permissions replace semantics ────────────────────────────────────────────

test("a job's own permissions REPLACE the workflow grant (no false positive)", () => {
  const narrowed = [
    "on:",
    "  pull_request:",
    "permissions:",
    "  id-token: write",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "    steps:",
    "      - run: echo hi",
  ].join("\n");
  assert(
    evaluateWorkflow(narrowed).ok,
    "job that drops id-token is not flagged",
  );

  // …but a job that does NOT declare permissions still inherits the grant.
  const inheriting = [
    "on:",
    "  pull_request:",
    "permissions:",
    "  id-token: write",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo hi",
  ].join("\n");
  assert(!evaluateWorkflow(inheriting).ok, "inherited id-token still flagged");
});

// ── annotation attribution is a GENUINE comment, correctly scoped ─────────────

test("a '# autofix-ci-trust:' line inside a run: block scalar is NOT an annotation", () => {
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: |",
    "          # autofix-ci-trust: bypass",
    "          ./deploy.sh",
    "        env:",
    "          TOKEN: ${{ secrets.DEPLOY_TOKEN }}",
  ].join("\n");
  const v = evaluateWorkflow(body);
  assert(
    !v.ok && /\[leak\]/.test(v.reason),
    "script-content # is not credited",
  );
});

test("an annotation in one job does not leak to a same-named nested key elsewhere", () => {
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    outputs:",
    "      deploy: ok",
    "      # autofix-ci-trust: unrelated note in build",
    "    steps:",
    "      - run: echo hi",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: ./d.sh",
    "        env:",
    "          T: ${{ secrets.X }}",
  ].join("\n");
  const v = evaluateWorkflow(body);
  assert(
    !v.ok && /\[deploy\]/.test(v.reason),
    "deploy job located at its own key, not the nested output",
  );
});

test("an annotation is credited only when UNAMBIGUOUSLY inside a job's body", () => {
  // A comment describing the job BELOW it must not silence the preceding job.
  const above = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
    "  # autofix-ci-trust: the docs job below uses no secrets",
    "  docs:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: ./build-docs.sh",
  ].join("\n");
  const v1 = evaluateWorkflow(above);
  assert(
    !v1.ok && /\[leak\]/.test(v1.reason),
    "comment above docs does not clear leak",
  );

  // A trailing file-footer comment belongs to no job.
  const footer = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: make",
    "  leak:",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
    "# autofix-ci-trust: build compiles fixtures only",
  ].join("\n");
  const v2 = evaluateWorkflow(footer);
  assert(
    !v2.ok && /\[leak\]/.test(v2.reason),
    "trailing footer does not clear leak",
  );

  // A comment between `jobs:` and the first job (at key indent) is NOT file-level.
  const leadComment = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  # autofix-ci-trust: build is safe",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: make",
    "  leak:",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  const v3 = evaluateWorkflow(leadComment);
  assert(
    !v3.ok && /\[leak\]/.test(v3.reason),
    "a comment inside the jobs section is not file-level",
  );

  // …and a genuine in-body annotation (deeper than the key) STILL clears its job.
  const inBody = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    "    # autofix-ci-trust: token is step-scoped away from PR-head code",
    SECRET_STEP,
  ].join("\n");
  assert(evaluateWorkflow(inBody).ok, "in-body annotation still credited");
});

// ── push-triggered lanes (the finalizer pushes sentry-autofix/* pre-PR) ───────

test("a push that admits autofix branches is guarded like a pull_request", () => {
  // Bare push (all branches) with a secret job → refused.
  const bare = unguarded("on:\n  push:");
  const v = evaluateWorkflow(bare);
  assert(
    !v.ok && /\[leak\]/.test(v.reason) && /push/.test(v.reason),
    "bare push refused",
  );

  // branches-ignore that does not exclude autofix → refused.
  assert(
    !evaluateWorkflow(
      unguarded("on:\n  push:\n    branches-ignore: [gh-pages]"),
    ).ok,
    "branches-ignore not covering autofix refused",
  );

  // A ref-based push guard clears it.
  const guardedPush = [
    "on:",
    "  push:",
    "jobs:",
    "  leak:",
    "    if: ${{ !startsWith(github.ref, 'refs/heads/sentry-autofix/') }}",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  assert(evaluateWorkflow(guardedPush).ok, "push-ref guard clears it");

  // The PR-context guard does NOT satisfy the push context.
  const wrongGuard = [
    "on:",
    "  push:",
    "jobs:",
    "  leak:",
    GUARD, // pull_request head_ref guard — empty on push
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  assert(!evaluateWorkflow(wrongGuard).ok, "pr guard does not cover push");
});

test("pushAdmitsAutofix models branch filters", () => {
  assert(pushAdmitsAutofix(null), "bare push admits");
  assert(pushAdmitsAutofix({ branches: ["**"] }), "** admits");
  assert(
    pushAdmitsAutofix({ branches: ["sentry-autofix/**"] }),
    "explicit admits",
  );
  assert(!pushAdmitsAutofix({ branches: ["main"] }), "main-only excludes");
  assert(!pushAdmitsAutofix({ branches: ["release/*"] }), "release/* excludes");
  assert(
    !pushAdmitsAutofix({ tags: ["v*"] }),
    "tags-only excludes branch pushes",
  );
  assert(
    !pushAdmitsAutofix({ "branches-ignore": ["sentry-autofix/**"] }),
    "ignore excludes",
  );
  assert(pushAdmitsAutofix({ paths: ["src/**"] }), "paths-only still admits");
});

// ── local reusable-workflow calls (callee may bind a credential) ──────────────

test("a pull_request job calling a LOCAL reusable workflow is credential-bearing", () => {
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  call:",
    "    uses: ./.github/workflows/deploy.yml",
  ].join("\n");
  const v = evaluateWorkflow(body);
  assert(
    !v.ok && /\[call\]/.test(v.reason),
    "local reusable call refused without guard",
  );

  // …and clears with a guard.
  const guarded = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  call:",
    "    if: ${{ !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}",
    "    uses: ./.github/workflows/deploy.yml",
  ].join("\n");
  assert(evaluateWorkflow(guarded).ok, "guarded local reusable call passes");
});

// ── multiline quoted scalar can't smuggle an annotation ──────────────────────

test("a '# autofix-ci-trust:' line inside a multiline quoted scalar is not an annotation", () => {
  const body = [
    'name: "line one',
    "  # autofix-ci-trust: fake",
    '  line three"',
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  const v = evaluateWorkflow(body);
  assert(
    !v.ok && /\[leak\]/.test(v.reason),
    "quoted-scalar marker does not become a file annotation",
  );
});

test("the SHORT sentry-autofix/ prefix does NOT satisfy a github.ref push guard", () => {
  // github.ref is the full refs/heads/… on a branch push, so startsWith(github.ref,
  // 'sentry-autofix/') is always false and the guard evaluates true → job runs.
  const shortRef = [
    "on:",
    "  push:",
    "jobs:",
    "  leak:",
    "    if: ${{ !startsWith(github.ref, 'sentry-autofix/') }}",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  assert(
    !evaluateWorkflow(shortRef).ok,
    "short-prefix github.ref guard rejected",
  );

  // The correct full-prefix github.ref form, and the short github.ref_name form.
  const fullRef = shortRef.replace(
    "'sentry-autofix/'",
    "'refs/heads/sentry-autofix/'",
  );
  assert(evaluateWorkflow(fullRef).ok, "full-prefix github.ref guard credited");
  const refName = shortRef.replace("github.ref,", "github.ref_name,");
  assert(
    evaluateWorkflow(refName).ok,
    "github.ref_name short-prefix guard credited",
  );
});

test("a write-scoped github.token exposed on a reachable job is a credential", () => {
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "      issues: write",
    "    steps:",
    "      - run: gh issue comment 1 --body hi",
    "        env:",
    "          GH_TOKEN: ${{ github.token }}",
  ].join("\n");
  assert(!evaluateWorkflow(body).ok, "github.token + issues:write flagged");

  // Read-only token is not a mutating credential.
  const readOnly = body.replace("      issues: write\n", "");
  assert(evaluateWorkflow(readOnly).ok, "read-only github.token not flagged");
});

test("the create event (branch creation) is a reachable context", () => {
  const body = [
    "on:",
    "  create:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    SECRET_STEP,
  ].join("\n");
  const v = evaluateWorkflow(body);
  assert(
    !v.ok && /\[leak\]/.test(v.reason),
    "create-triggered secret job flagged",
  );

  const guarded = body.replace(
    "    runs-on: ubuntu-latest",
    "    if: ${{ !startsWith(github.ref, 'refs/heads/sentry-autofix/') }}\n    runs-on: ubuntu-latest",
  );
  assert(evaluateWorkflow(guarded).ok, "ref-guarded create job passes");
});

test("branches-ignore fails closed on un-modeled glob metacharacters", () => {
  // 'v[0-9]' does not definitely exclude sentry-autofix/*, so the branch is
  // still admitted (must be guarded) — unknown patterns never assert exclusion.
  assert(
    pushAdmitsAutofix({ "branches-ignore": ["main", "v[0-9]"] }),
    "metachar branches-ignore still admits",
  );
  assert(
    !evaluateWorkflow(
      'on:\n  push:\n    branches-ignore: [main, "v[0-9]"]\njobs:\n  leak:\n    runs-on: x\n    steps:\n      - run: d\n        env:\n          T: ${{ secrets.X }}\n',
    ).ok,
    "metachar branches-ignore workflow refused",
  );
  // A pattern that DEFINITELY matches the autofix branch does exclude it.
  assert(
    !pushAdmitsAutofix({ "branches-ignore": ["sentry-autofix/**"] }),
    "explicit branches-ignore excludes",
  );
});

test("a workflow-level env github.token with write perms is inherited by jobs", () => {
  const body = [
    "on:",
    "  pull_request:",
    "permissions:",
    "  contents: write",
    "env:",
    "  GH_TOKEN: ${{ github.token }}",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: gh pr merge --admin 1",
  ].join("\n");
  const v = evaluateWorkflow(body);
  assert(
    !v.ok && /\[leak\]/.test(v.reason),
    "inherited env token+write flagged",
  );

  const readOnly = body.replace("  contents: write", "  contents: read");
  assert(
    evaluateWorkflow(readOnly).ok,
    "inherited env token with read-only perms passes",
  );
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
