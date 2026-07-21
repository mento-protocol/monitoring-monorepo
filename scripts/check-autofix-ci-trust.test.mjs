#!/usr/bin/env node
import {
  evaluateWorkflow,
  hasPullRequestTrigger,
  hasTrigger,
  referencesSecrets,
  splitJobs,
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

const SECRET_LINE = "          token: ${{ secrets.SOME_TOKEN }}";

// ── trigger detection: every valid GitHub Actions form ───────────────────────

test("trigger detection covers block, bare-key, inline-list, inline-scalar, inline-mapping forms", () => {
  assert(
    hasTrigger("on:\n  pull_request:\n    branches: [main]", "pull_request"),
    "block form",
  );
  assert(hasTrigger("on:\n  pull_request\n", "pull_request"), "bare key form");
  assert(
    hasTrigger("on: [push, pull_request]\n", "pull_request"),
    "inline list",
  );
  assert(hasTrigger("on: pull_request\n", "pull_request"), "inline scalar");
  assert(
    hasTrigger("on: { pull_request: { branches: [main] } }\n", "pull_request"),
    "inline mapping",
  );
  // pull_request must NOT match pull_request_target (and vice versa).
  assert(
    !hasTrigger("on: [pull_request_target]\n", "pull_request"),
    "no prefix match",
  );
  assert(
    usesPullRequestTarget("on: [pull_request_target]\n"),
    "inline pull_request_target detected",
  );
  assert(
    usesPullRequestTarget("on:\n  pull_request_target:\n"),
    "block pull_request_target detected",
  );
  // One-space indentation under on: is valid YAML — must not fail open.
  assert(
    hasTrigger("on:\n pull_request:\n  branches: [main]", "pull_request"),
    "one-space indent block form",
  );
  // Quoted YAML scalars/keys are valid trigger spellings.
  assert(
    hasTrigger('on: ["pull_request"]\n', "pull_request"),
    "quoted inline list",
  );
  assert(
    hasTrigger("on:\n  'pull_request':\n    branches: [main]", "pull_request"),
    "quoted block key",
  );
  assert(
    usesPullRequestTarget('on: ["pull_request_target"]\n'),
    "quoted pull_request_target detected",
  );
  // Comments and step names never count as triggers.
  assert(
    !hasTrigger("on:\n  push:\n# pull_request would be nice", "pull_request"),
    "comment ignored",
  );
  assert(
    !hasTrigger(
      "on:\n  push:\njobs:\n  x:\n    steps:\n      - name: pull_request thing",
      "pull_request",
    ),
    "step name outside on: block ignored",
  );
});

test("pull_request_target is always refused, even with a guard present", () => {
  const body = [
    "on:",
    "  pull_request_target:",
    "jobs:",
    "  x:",
    "    # sentry-autofix/ guard present but irrelevant",
    SECRET_LINE,
  ].join("\n");
  const v = evaluateWorkflow(body);
  assert(!v.ok && /pull_request_target/.test(v.reason), "refused");
});

test("referencesSecrets covers every secret-passing syntax", () => {
  assert(referencesSecrets("x: ${{ secrets.FOO }}"), "dot expression");
  assert(referencesSecrets("x: ${{ secrets['FOO'] }}"), "bracket expression");
  assert(
    referencesSecrets('x: ${{ secrets["FOO"] }}'),
    "double-quote bracket expression",
  );
  assert(
    referencesSecrets(
      "    uses: ./.github/workflows/x.yml\n    secrets: inherit",
    ),
    "reusable-workflow secrets: inherit",
  );
  assert(
    referencesSecrets(
      '    uses: ./.github/workflows/x.yml\n    secrets: "inherit"',
    ),
    "QUOTED inherit scalar has identical semantics and must count",
  );
  assert(
    referencesSecrets(
      "    uses: org/repo/.github/workflows/x.yml@sha\n    secrets:\n      token: abc",
    ),
    "reusable-workflow explicit secrets block",
  );
  assert(
    referencesSecrets("          ALL: ${{ toJSON(secrets) }}"),
    "bare secrets context (toJSON) expands every secret and must count",
  );
  assert(!referencesSecrets("x: secrets are cool"), "prose ignored");
  assert(
    !referencesSecrets("# secrets: inherit would be bad"),
    "commented inherit ignored",
  );
});

test("guard text inside a YAML comment on the if: line does NOT count", () => {
  // YAML drops the trailing comment before GitHub evaluates the expression,
  // so the job RUNS for autofix PRs — the commented guard must not certify it.
  const smuggledIfComment = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    if: github.event_name == 'pull_request' # !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/')",
    SECRET_LINE,
  ].join("\n");
  assert(
    !evaluateWorkflow(smuggledIfComment).ok,
    "comment-smuggled guard refused",
  );
});

test("quoted job keys are segmented (cannot hide inside a sibling's block)", () => {
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  safe:",
    "    if: ${{ !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}",
    SECRET_LINE,
    '  "leak":',
    SECRET_LINE,
  ].join("\n");
  const blocks = splitJobs(body);
  assert(blocks.has("leak"), "quoted job key segmented");
  const v = evaluateWorkflow(body);
  assert(!v.ok && /\[leak\]/.test(v.reason), "quoted unguarded job refused");
});

test("a bare sentry-autofix/ mention does NOT count as a guard", () => {
  // A comment, step name, or POSITIVE lane-router containing the branch
  // namespace must not certify a secret-bearing job — only the strict
  // excluding if: form (or an annotation) does.
  const commentOnly = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    # we should think about sentry-autofix/ branches here someday",
    SECRET_LINE,
  ].join("\n");
  assert(!evaluateWorkflow(commentOnly).ok, "comment mention refused");

  const positiveRouter = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    if: ${{ startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}",
    SECRET_LINE,
  ].join("\n");
  assert(
    !evaluateWorkflow(positiveRouter).ok,
    "positive (non-excluding) startsWith refused",
  );

  const headRefForm = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    if: ${{ !startsWith(github.head_ref, 'sentry-autofix/') }}",
    SECRET_LINE,
  ].join("\n");
  assert(
    evaluateWorkflow(headRefForm).ok,
    "github.head_ref exclusion accepted",
  );
});

// ── per-job granularity ───────────────────────────────────────────────────────

test("splitJobs separates header and job blocks", () => {
  const body = [
    "name: X",
    "on:",
    "  pull_request:",
    "jobs:",
    "  alpha:",
    "    runs-on: ubuntu-latest",
    "  beta:",
    "    runs-on: ubuntu-latest",
    SECRET_LINE,
  ].join("\n");
  const blocks = splitJobs(body);
  assert(blocks.get("").includes("name: X"), "header captured");
  assert(blocks.has("alpha") && blocks.has("beta"), "both jobs found");
  assert(!blocks.get("alpha").includes("secrets."), "alpha has no secret");
  assert(blocks.get("beta").includes("secrets."), "beta holds the secret");
});

test("secret-bearing job without guard or annotation fails, naming the job", () => {
  const body = ["on:", "  pull_request:", "jobs:", "  x:", SECRET_LINE].join(
    "\n",
  );
  const v = evaluateWorkflow(body);
  assert(!v.ok && /\[x\]/.test(v.reason), "unguarded job refused by name");
});

test("one guarded job must NOT vouch for an unguarded sibling", () => {
  // The multi-job false-negative: job `safe` carries a guard, job `leaky`
  // reaches secrets with none. Per-job granularity must still refuse.
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  safe:",
    "    if: ${{ !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}",
    SECRET_LINE,
    "  leaky:",
    SECRET_LINE,
  ].join("\n");
  const v = evaluateWorkflow(body);
  assert(!v.ok, "sibling not vouched for");
  assert(/\[leaky\]/.test(v.reason), "only the unguarded job is named");
});

test("a guard literal in the same job satisfies that job", () => {
  const body = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    if: ${{ !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}",
    SECRET_LINE,
  ].join("\n");
  assert(evaluateWorkflow(body).ok, "guarded job passes");
});

test("a per-job annotation satisfies that job; a header annotation covers all jobs", () => {
  const perJob = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    # autofix-ci-trust: secret is step-scoped to a pinned action.",
    SECRET_LINE,
  ].join("\n");
  assert(evaluateWorkflow(perJob).ok, "job-level annotation passes");

  const fileLevel = [
    "on:",
    "  pull_request:",
    "# autofix-ci-trust: all secrets here are step-scoped; no PR-head code",
    "# executes with them in env.",
    "jobs:",
    "  x:",
    SECRET_LINE,
    "  y:",
    SECRET_LINE,
  ].join("\n");
  assert(evaluateWorkflow(fileLevel).ok, "header annotation covers all jobs");
});

test("the guard only counts on the JOB-LEVEL if:, not in steps or comments", () => {
  // The exact guard text inside a step's run: (or a step-level if:) does not
  // gate whether the JOB runs for autofix PRs — it must not certify the job.
  const guardInRunStep = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    steps:",
    "      - run: echo \"!startsWith(github.event.pull_request.head.ref, 'sentry-autofix/')\"",
    SECRET_LINE,
  ].join("\n");
  assert(!evaluateWorkflow(guardInRunStep).ok, "guard inside run: refused");

  const guardInStepIf = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    steps:",
    "      - if: ${{ !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}",
    "        run: echo hi",
    SECRET_LINE,
  ].join("\n");
  assert(
    !evaluateWorkflow(guardInStepIf).ok,
    "step-level if: does not certify the whole job",
  );

  // Multiline job-level if: (the repo's >- form) is credited.
  const multilineIf = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    if: >-",
    "      (github.event_name == 'pull_request'",
    "        && !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/'))",
    SECRET_LINE,
  ].join("\n");
  assert(evaluateWorkflow(multilineIf).ok, "multiline job if: credited");
});

test("annotation lookalikes inside string values do NOT count", () => {
  // Only a genuine YAML comment line is a reviewed annotation; a string that
  // merely CONTAINS the marker (e.g. echoed in a run:) must not certify a job.
  const smuggled = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    steps:",
    "      - run: \"echo '# autofix-ci-trust: not a real annotation'\"",
    SECRET_LINE,
  ].join("\n");
  assert(!evaluateWorkflow(smuggled).ok, "string-value lookalike refused");

  const genuine = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    # autofix-ci-trust: secret is step-scoped to a pinned action.",
    SECRET_LINE,
  ].join("\n");
  assert(evaluateWorkflow(genuine).ok, "genuine comment line accepted");
});

test("top-level content AFTER jobs: still counts as header (secrets and annotations)", () => {
  // YAML allows workflow-level keys below jobs:. A trailing env: secret must
  // still mark every job secret-bearing, and a trailing annotation must still
  // cover the file.
  const trailingEnvSecret = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    steps:",
    "      - run: pnpm test",
    "env:",
    "  TOKEN: ${{ secrets.SOME_TOKEN }}",
  ].join("\n");
  const v = evaluateWorkflow(trailingEnvSecret);
  assert(!v.ok && /\[x\]/.test(v.reason), "post-jobs env secret still counted");

  const trailingAnnotation = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    steps:",
    "      - run: pnpm test",
    "env:",
    "  TOKEN: ${{ secrets.SOME_TOKEN }}",
    "# autofix-ci-trust: token is a public fixture value, not a secret-bearing lane.",
  ].join("\n");
  assert(
    evaluateWorkflow(trailingAnnotation).ok,
    "post-jobs file-level annotation still honored",
  );
});

test("workflow-level env secrets make every job secret-bearing", () => {
  // Top-level `env: TOKEN: ${{ secrets.X }}` is inherited by all jobs; a job
  // with no textual secret reference still receives it.
  const headerEnv = [
    "on:",
    "  pull_request:",
    "env:",
    "  TOKEN: ${{ secrets.SOME_TOKEN }}",
    "jobs:",
    "  x:",
    "    steps:",
    "      - run: pnpm test",
  ].join("\n");
  const v = evaluateWorkflow(headerEnv);
  assert(!v.ok && /\[x\]/.test(v.reason), "inherited header secret refused");

  const guarded = [
    "on:",
    "  pull_request:",
    "env:",
    "  TOKEN: ${{ secrets.SOME_TOKEN }}",
    "jobs:",
    "  x:",
    "    if: ${{ !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}",
    "    steps:",
    "      - run: pnpm test",
  ].join("\n");
  assert(evaluateWorkflow(guarded).ok, "guarded job passes with header secret");
});

test("un-segmentable secret-bearing workflow FAILS CLOSED", () => {
  // 4-space job indentation defeats the textual splitter; the checker must
  // refuse rather than silently skip the per-job analysis.
  const weirdIndent = [
    "on:",
    "  pull_request:",
    "jobs:",
    "    x:",
    "     " + SECRET_LINE.trim(),
  ].join("\n");
  const v = evaluateWorkflow(weirdIndent);
  assert(
    !v.ok && /segmented/.test(v.reason),
    "fails closed on odd indentation",
  );
});

test("secretless pull_request workflows and non-PR workflows pass untouched", () => {
  assert(
    evaluateWorkflow(
      ["on:", "  pull_request:", "jobs:", "  x:", "    runs-on: u"].join("\n"),
    ).ok,
    "secretless PR workflow",
  );
  assert(
    evaluateWorkflow(
      ["on:", "  schedule:", "jobs:", "  x:", SECRET_LINE].join("\n"),
    ).ok,
    "schedule-only workflow with secrets",
  );
  assert(hasPullRequestTrigger("on:\n  pull_request:\n"), "detector sanity");
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
