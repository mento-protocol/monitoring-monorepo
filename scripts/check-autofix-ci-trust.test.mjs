#!/usr/bin/env node
import {
  evaluateWorkflow,
  hasUnanalyzableTriggers,
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

test("aliased/anchored or multi-line flow on: declarations FAIL CLOSED", () => {
  const aliased = [
    "events: &pr_events",
    "  pull_request:",
    "on: *pr_events",
    "jobs:",
    "  x:",
    SECRET_LINE,
  ].join("\n");
  assert(hasUnanalyzableTriggers(aliased), "alias detected");
  const v = evaluateWorkflow(aliased);
  assert(!v.ok && /anchors|alias/i.test(v.reason), "aliased on: refused");

  const multilineFlow = [
    "on: [pull_request,",
    "  push]",
    "jobs:",
    "  x:",
    SECRET_LINE,
  ].join("\n");
  assert(
    !evaluateWorkflow(multilineFlow).ok,
    "unterminated flow on: refused (fail closed)",
  );

  // Ordinary literal forms remain analyzable.
  assert(
    !hasUnanalyzableTriggers("on:\n  pull_request:\n    branches: [main]"),
    "literal block form analyzable",
  );
});

test("quoted secrets key forwarding inherit still counts", () => {
  assert(
    referencesSecrets(
      '    uses: ./.github/workflows/x.yml\n    "secrets": inherit',
    ),
    "quoted secrets key with inherit counts",
  );
});

test("aliases ANYWHERE (inline lists, secret-carrying anchors) fail closed; mrkdwn strings do not", () => {
  // Alias inside a valid inline trigger list.
  const inlineAlias = [
    "name: &pr pull_request",
    "on: [*pr]",
    "jobs:",
    "  x:",
    SECRET_LINE,
  ].join("\n");
  assert(!evaluateWorkflow(inlineAlias).ok, "inline-list alias refused");

  // Anchor carrying a secret env mapping consumed by a later job.
  const anchorSecrets = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  safe:",
    "    if: ${{ !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}",
    "    env: &shared_secrets",
    "      TOKEN: ${{ secrets.TOKEN }}",
    "  leak:",
    "    env: *shared_secrets",
    "    steps:",
    "      - run: pnpm test",
  ].join("\n");
  assert(!evaluateWorkflow(anchorSecrets).ok, "anchor-carried secrets refused");

  // Slack mrkdwn bold inside a quoted string is NOT a YAML alias.
  const mrkdwn = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    steps:",
    '      - run: echo "🧪 *wiring test*"',
  ].join("\n");
  assert(!hasUnanalyzableTriggers(mrkdwn), "mrkdwn bold not an alias");
  assert(evaluateWorkflow(mrkdwn).ok, "secretless mrkdwn workflow passes");
});

test("environment-bound jobs are secret-bearing even with no textual secrets", () => {
  const envJob = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    environment: production-infra",
    "    steps:",
    "      - run: pnpm deploy",
  ].join("\n");
  const v = evaluateWorkflow(envJob);
  assert(!v.ok && /\[x\]/.test(v.reason), "environment secrets counted");

  const guarded = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  x:",
    "    if: ${{ !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}",
    "    environment: production-infra",
    "    steps:",
    "      - run: pnpm deploy",
  ].join("\n");
  assert(evaluateWorkflow(guarded).ok, "guarded environment job passes");
});

test("anchors/aliases with non-identifier names (numeric, dashed) are refused", () => {
  assert(
    hasUnanalyzableTriggers("events: &1\n  pull_request:\non: *1\n"),
    "numeric anchor + alias refused",
  );
  assert(
    hasUnanalyzableTriggers("on: *-x\n"),
    "dash-leading alias name refused",
  );
});

test("YAML explicit-key syntax in mappings is refused", () => {
  assert(
    hasUnanalyzableTriggers("on:\n  ? pull_request\n  : null\n"),
    "explicit trigger key refused",
  );
  assert(
    hasUnanalyzableTriggers('on:\n  ? "pull_request"\n'),
    "quoted explicit key refused",
  );
});

test("block-scalar content is inert text, not YAML (no false positives)", () => {
  const ternary = [
    "on:",
    "  push:",
    "jobs:",
    "  a:",
    "    steps:",
    "      - run: |",
    "          const x = cond",
    "            ? a",
    "            : b;",
  ].join("\n");
  assert(!hasUnanalyzableTriggers(ternary), "JS ternary in run block ignored");

  const mrkdwn = [
    "jobs:",
    "  a:",
    "    steps:",
    "      - uses: actions/github-script@v7",
    "        with:",
    "          script: |",
    "            const s = `- **${x}** &y`;",
    "            const t = `*${z}*`;",
  ].join("\n");
  assert(!hasUnanalyzableTriggers(mrkdwn), "markdown in script block ignored");

  // The introducer line itself is still scanned: an anchor BEFORE the block
  // scalar (`run: &tpl |`) must fail before the content skip kicks in.
  assert(
    hasUnanalyzableTriggers(
      "jobs:\n  a:\n    steps:\n      - run: &tpl |\n          echo hi\n",
    ),
    "anchored block scalar refused",
  );
});

test("anchored/aliased mapping KEYS are refused (not just value positions)", () => {
  assert(
    hasUnanalyzableTriggers(
      "on:\n  &event pull_request:\njobs:\n  a:\n    steps:\n      - run: echo hi\n",
    ),
    "anchored trigger key refused",
  );
  assert(
    hasUnanalyzableTriggers("on:\n  *event pull_request:\n"),
    "aliased key refused",
  );
});

test("letter-synthesizing escapes in double-quoted scalars are refused", () => {
  assert(
    hasUnanalyzableTriggers(
      'jobs:\n  a:\n    env:\n      TOKEN: "${{ se\\u0063rets.TOKEN }}"\n',
    ),
    "\\u escape refused (decodes to secrets reference)",
  );
  assert(hasUnanalyzableTriggers('x: "\\x63"\n'), "\\x escape refused");
  assert(hasUnanalyzableTriggers('x: "\\U00000063"\n'), "\\U escape refused");
  assert(
    !hasUnanalyzableTriggers(
      'jobs:\n  a:\n    steps:\n      - run: |\n          printf "\\u0041"\n          grep -P "\\x41" file\n',
    ),
    "escapes inside block scalars are literal text, not flagged",
  );
  assert(
    !hasUnanalyzableTriggers('x: "line1\\nline2"\n'),
    "non-letter escapes (\\n, \\t) pass",
  );
});

test("id-token: write is a credential (WIF token exchange), like a secret", () => {
  const base = [
    "on:",
    "  pull_request:",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    "PERMS",
    "    steps:",
    "      - uses: actions/checkout@v4",
  ].join("\n");
  const block = base.replace(
    "PERMS",
    "    permissions:\n      id-token: write",
  );
  let v = evaluateWorkflow(block);
  assert(!v.ok && /\[leak\]/.test(v.reason), "block-form id-token refused");

  const inline = base.replace("PERMS", "    permissions: { id-token: write }");
  v = evaluateWorkflow(inline);
  assert(!v.ok && /\[leak\]/.test(v.reason), "inline-flow id-token refused");

  const writeAll = base.replace("PERMS", "    permissions: write-all");
  v = evaluateWorkflow(writeAll);
  assert(!v.ok && /\[leak\]/.test(v.reason), "permissions: write-all refused");

  const readOnly = base.replace("PERMS", "    permissions: read-all");
  assert(
    evaluateWorkflow(readOnly).ok,
    "read-only permissions without secrets passes",
  );

  const header = [
    "on:",
    "  pull_request:",
    "permissions:",
    "  id-token: write",
    "jobs:",
    "  leak:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
  ].join("\n");
  v = evaluateWorkflow(header);
  assert(
    !v.ok && /\[leak\]/.test(v.reason),
    "workflow-level id-token inherited by jobs",
  );

  const guarded = block.replace(
    "    runs-on: ubuntu-latest",
    "    runs-on: ubuntu-latest\n    if: ${{ !startsWith(github.event.pull_request.head.ref, 'sentry-autofix/') }}",
  );
  assert(evaluateWorkflow(guarded).ok, "guarded id-token job passes");
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
