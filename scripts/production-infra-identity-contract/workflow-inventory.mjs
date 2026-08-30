import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isMapping } from "../lib/workflow-yaml.mjs";

const PROTECTED_JOB_CONDITION =
  "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && needs.plan.outputs.has-changes == 'true' && (github.event_name == 'workflow_dispatch' || needs.plan.outputs.stack-changed == 'true')";
const PRODUCTION_CONSOLE_URL =
  "https://console.cloud.google.com/home/dashboard?project=mento-terraform-seed-ffac";
const AUTOMATIC_GITHUB_CREDENTIAL = ["${{ github.", "token }}"].join("");

const APPLY_OUTPUT_COMMAND = [
  "set +e",
  "terraform apply -auto-approve -no-color -input=false -lock-timeout=10m > /tmp/tf-apply.raw 2>&1",
  "EXITCODE=$?",
  "set -e",
  '"${GITHUB_WORKSPACE}/scripts/sanitize-terraform-output.sh" /tmp/tf-apply.raw /tmp/tf-apply.txt',
  "cat /tmp/tf-apply.txt",
  'exit "$EXITCODE"',
  "",
].join("\n");

const STRIP_REFRESH_NOISE_COMMAND = [
  "if [ -f tf-apply.txt ]; then",
  "  awk '",
  "    /^Acquiring state lock|: Refreshing state\\.\\.\\.|: Reading\\.\\.\\.|: Read complete after/ { next }",
  "    NF || found { found=1; print }",
  "  ' tf-apply.txt | cat -s > tf-apply.clean.txt",
  "  mv tf-apply.clean.txt tf-apply.txt",
  "fi",
  "",
].join("\n");

const APPLY_CONFIG_BY_WORKFLOW = {
  ".github/workflows/alerts-rules.yml": {
    name: "Terraform Apply (alerts/rules)",
    workingDirectory: "alerts/rules",
    summaryRoot: "alerts/rules/",
    environmentVariables: {
      TF_VAR_grafana_service_account_token:
        "${{ secrets.TF_VAR_GRAFANA_SERVICE_ACCOUNT_TOKEN }}",
      TF_VAR_slack_bot_token: "${{ secrets.TF_VAR_SLACK_BOT_TOKEN }}",
      TF_VAR_oncall_support_usergroup_id:
        "${{ secrets.TF_VAR_ONCALL_SUPPORT_USERGROUP_ID }}",
      TF_VAR_splunk_on_call_alerts_webhook_url:
        "${{ secrets.TF_VAR_SPLUNK_ON_CALL_ALERTS_WEBHOOK_URL }}",
    },
  },
  ".github/workflows/alerts-infra.yml": {
    name: "Terraform Apply (alerts/infra)",
    workingDirectory: "alerts/infra",
    summaryRoot: "alerts/infra/",
    environmentVariables: {
      TF_VAR_sentry_auth_token: "${{ secrets.TF_VAR_SENTRY_AUTH_TOKEN }}",
      TF_VAR_billing_account: "${{ secrets.TF_VAR_BILLING_ACCOUNT }}",
      TF_VAR_quicknode_api_key: "${{ secrets.TF_VAR_QUICKNODE_API_KEY }}",
      TF_VAR_quicknode_signing_secret:
        "${{ secrets.TF_VAR_QUICKNODE_SIGNING_SECRET }}",
      TF_VAR_splunk_on_call_api_id:
        "${{ secrets.TF_VAR_SPLUNK_ON_CALL_API_ID }}",
      TF_VAR_splunk_on_call_api_key:
        "${{ secrets.TF_VAR_SPLUNK_ON_CALL_API_KEY }}",
      TF_VAR_oncall_slack_channel_id:
        "${{ secrets.TF_VAR_ONCALL_SLACK_CHANNEL_ID }}",
      TF_VAR_oncall_support_usergroup_id:
        "${{ secrets.TF_VAR_ONCALL_SUPPORT_USERGROUP_ID }}",
      TF_VAR_slack_notification_channel_id:
        "${{ secrets.TF_VAR_SLACK_NOTIFICATION_CHANNEL_ID }}",
      TF_VAR_slack_bot_token: "${{ secrets.TF_VAR_SLACK_BOT_TOKEN }}",
      TF_VAR_github_token: "${{ secrets.TF_VAR_GITHUB_TOKEN }}",
    },
  },
  ".github/workflows/aegis-terraform.yml": {
    name: "Terraform Apply (aegis/terraform)",
    workingDirectory: "aegis/terraform",
    simpleApply: true,
    environmentVariables: {
      TF_VAR_grafana_service_account_token:
        "${{ secrets.TF_VAR_GRAFANA_SERVICE_ACCOUNT_TOKEN }}",
    },
  },
  ".github/workflows/governance-watchdog.yml": {
    name: "Terraform Apply (governance-watchdog/infra)",
    workingDirectory: "governance-watchdog/infra",
    summaryRoot: "governance-watchdog/infra/",
    environmentVariables: {
      TF_VAR_billing_account: "${{ secrets.TF_VAR_BILLING_ACCOUNT }}",
      TF_VAR_discord_webhook_url: "${{ secrets.TF_VAR_DISCORD_WEBHOOK_URL }}",
      TF_VAR_discord_test_webhook_url:
        "${{ secrets.TF_VAR_DISCORD_TEST_WEBHOOK_URL }}",
      TF_VAR_telegram_chat_id: "${{ secrets.TF_VAR_TELEGRAM_CHAT_ID }}",
      TF_VAR_telegram_test_chat_id:
        "${{ secrets.TF_VAR_TELEGRAM_TEST_CHAT_ID }}",
      TF_VAR_telegram_bot_token: "${{ secrets.TF_VAR_TELEGRAM_BOT_TOKEN }}",
      TF_VAR_quicknode_api_key:
        "${{ secrets.TF_VAR_GOVERNANCE_WATCHDOG_QUICKNODE_API_KEY }}",
      TF_VAR_quicknode_security_token:
        "${{ secrets.TF_VAR_QUICKNODE_SECURITY_TOKEN }}",
      TF_VAR_x_auth_token: "${{ secrets.TF_VAR_X_AUTH_TOKEN }}",
      TF_VAR_victorops_webhook_url:
        "${{ secrets.TF_VAR_VICTOROPS_WEBHOOK_URL }}",
      TF_VAR_slack_notification_channel_id:
        "${{ secrets.TF_VAR_GOVERNANCE_WATCHDOG_SLACK_NOTIFICATION_CHANNEL_ID }}",
      TF_VAR_github_token: "${{ secrets.TF_VAR_GITHUB_TOKEN }}",
    },
  },
};

const PEG_POLICY_PUBLICATION_WORKFLOW =
  ".github/workflows/peg-policy-publication.yml";
const DEPENDABOT_AUTO_MERGE_CANDIDATE_WORKFLOW =
  ".github/workflows/dependabot-auto-merge-candidate.yml";
const DEPENDABOT_AUTO_MERGE_WRITER_WORKFLOW =
  ".github/workflows/dependabot-auto-merge.yml";
// Hash parsed YAML, not comments. The pair is one security boundary: the
// pull_request classifier is read-only, and the workflow_run writer re-reads
// the classifier attempt before it can merge. Generate new hashes only after
// reviewing both complete parsed workflows together.
const DEPENDABOT_AUTO_MERGE_CANDIDATE_SEMANTIC_SHA256 =
  "47416768116736584c78a544da85216911d246c4663aaf49708e078cfd94f98d";
const DEPENDABOT_AUTO_MERGE_WRITER_SEMANTIC_SHA256 =
  "c6dd83e6b989ad120848159a86ab8ac6b021d74ac868edfa7a3b060ecac7edbe";
const PEG_POLICY_PUBLICATION_CONSOLE_URL =
  "https://console.cloud.google.com/home/dashboard?project=mento-monitoring";
const PROTECTED_APPLY_WORKFLOWS = [
  ...Object.keys(APPLY_CONFIG_BY_WORKFLOW),
  PEG_POLICY_PUBLICATION_WORKFLOW,
];

const JOB_ENVIRONMENT_INVENTORY = new Map([
  [
    ".github/workflows/alerts-rules.yml#apply",
    {
      name: "production-infra",
      url: PRODUCTION_CONSOLE_URL,
    },
  ],
  [
    ".github/workflows/alerts-infra.yml#apply",
    {
      name: "production-infra",
      url: PRODUCTION_CONSOLE_URL,
    },
  ],
  [
    ".github/workflows/aegis-terraform.yml#apply",
    {
      name: "production-infra",
      url: PRODUCTION_CONSOLE_URL,
    },
  ],
  [
    ".github/workflows/governance-watchdog.yml#apply",
    {
      name: "production-infra",
      url: PRODUCTION_CONSOLE_URL,
    },
  ],
  [
    ".github/workflows/peg-policy-publication.yml#apply",
    {
      name: "production-infra",
      url: "https://console.cloud.google.com/home/dashboard?project=mento-monitoring",
    },
  ],
  [
    ".github/workflows/aegis-app-engine.yml#deploy",
    {
      name: "production-services",
      url: "https://mento-monitoring.uc.r.appspot.com",
    },
  ],
  [
    ".github/workflows/metrics-bridge.yml#deploy",
    {
      name: "production-services",
      url: "https://console.cloud.google.com/run?project=mento-monitoring",
    },
  ],
  // Sentry triage/autofix + platform-settings-drift secret-bearing jobs bind the
  // `sentry-pipeline` Environment (issue #1289) so its main-only deployment-branch
  // policy gates their secrets server-side. These jobs write the bare-string form
  // (`environment: sentry-pipeline`), so the registered value is the string, not
  // the {name, url} object form the production deploy jobs above use — the
  // inventory match is isDeepStrictEqual, so the shape must mirror the YAML.
  [".github/workflows/platform-settings-drift.yml#check", "sentry-pipeline"],
  [".github/workflows/sentry-autofix.yml#select", "sentry-pipeline"],
  [".github/workflows/sentry-autofix.yml#finalize", "sentry-pipeline"],
  [".github/workflows/sentry-triage-agent.yml#select", "sentry-pipeline"],
  [".github/workflows/sentry-triage-agent.yml#triage", "sentry-pipeline"],
  [".github/workflows/sentry-triage-agent.yml#project", "sentry-pipeline"],
  [".github/workflows/sentry-triage-archive.yml#archive", "sentry-pipeline"],
  [".github/workflows/sentry-triage-ingest.yml#ingest", "sentry-pipeline"],
]);

const LOCAL_DEPENDENCY_INVENTORY = [
  {
    path: "scripts/verify-github-environment-protection.mjs",
    phase: "pre-auth protection verifier",
    sha256: "fb6a14975ba4af5028808f0ff7b64d31c3e6ca1aa3ae8bce1b30dc26819b3780",
  },
  {
    path: "scripts/sanitize-terraform-output.sh",
    phase: "post-auth apply helper",
    sha256: "d6bce631d4eab849d7c0981ad118e33255ff5638c759ce558cf5234802be53a3",
  },
];

function commonApplySteps() {
  return [
    {
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        "persist-credentials": false,
      },
    },
    {
      name: "Verify production-infra environment protection",
      env: {
        GITHUB_TOKEN: AUTOMATIC_GITHUB_CREDENTIAL,
        GITHUB_ENVIRONMENT_NAME: "production-infra",
      },
      run: 'node "$GITHUB_WORKSPACE/scripts/verify-github-environment-protection.mjs"',
    },
    {
      name: "Authenticate to Google Cloud",
      uses: "google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093",
      with: {
        workload_identity_provider:
          "${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER }}",
        service_account: "${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}",
      },
    },
    {
      name: "Set up Cloud SDK",
      uses: "google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db",
    },
    {
      uses: "hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e",
      with: {
        terraform_version: "1.14.6",
        terraform_wrapper: false,
      },
    },
    {
      name: "Init",
      run: "terraform init -input=false",
    },
  ];
}

function applySummaryCommand(summaryRoot) {
  return [
    "{",
    `  echo '## Terraform Apply — \`${summaryRoot}\`'`,
    "  echo",
    '  case "$APPLY_OUTCOME" in',
    "    success) echo '**Status:** ✅ applied' ;;",
    "    failure) echo '**Status:** ❌ apply failed' ;;",
    "    *)       printf '**Status:** %s\\n' \"$APPLY_OUTCOME\" ;;",
    "  esac",
    "  echo",
    "  echo '<details open><summary>Apply output</summary>'",
    "  echo",
    "  echo '```terraform'",
    "  tail -c 50000 /tmp/tf-apply.txt 2>/dev/null || echo '(no apply output captured)'",
    "  echo '```'",
    "  echo '</details>'",
    '} >> "$GITHUB_STEP_SUMMARY"',
    "",
  ].join("\n");
}

function postAuthApplySteps(config) {
  if (config.simpleApply) {
    return [
      {
        name: "Apply",
        run: "terraform apply -auto-approve -input=false -lock-timeout=10m",
      },
      {
        uses: "Kesin11/actions-timeline@57fc93f20c6da7fbc14063c6d24a2a5627c799ad",
        if: "always()",
      },
    ];
  }

  return [
    {
      name: "Apply",
      id: "apply",
      run: APPLY_OUTPUT_COMMAND,
    },
    {
      name: "Strip refresh noise from apply output",
      if: "always()",
      "working-directory": "/tmp",
      run: STRIP_REFRESH_NOISE_COMMAND,
    },
    {
      name: "Apply summary",
      if: "always()",
      env: {
        APPLY_OUTCOME: "${{ steps.apply.outcome }}",
      },
      run: applySummaryCommand(config.summaryRoot),
    },
    {
      uses: "Kesin11/actions-timeline@57fc93f20c6da7fbc14063c6d24a2a5627c799ad",
      if: "always()",
    },
  ];
}

const PEG_POLICY_PUBLICATION_HANDOFF_COMMAND = [
  "{",
  "  echo '## Peg policy publication'",
  "  echo",
  "  echo '```json'",
  "  terraform output -json",
  "  echo '```'",
  '} >> "$GITHUB_STEP_SUMMARY"',
  "",
].join("\n");

const PEG_POLICY_PUBLICATION_PLAN_COMMAND = [
  "set +e",
  "terraform plan -detailed-exitcode -no-color -input=false -lock=false > /tmp/tf-plan.raw 2>&1",
  "EXITCODE=$?",
  "set -e",
  '"$GITHUB_WORKSPACE/scripts/sanitize-terraform-output.sh" /tmp/tf-plan.raw /tmp/tf-plan.txt',
  "cat /tmp/tf-plan.txt",
  'echo "exitcode=$EXITCODE" >> "$GITHUB_OUTPUT"',
  'case "$EXITCODE" in',
  "  0|2) ;;",
  '  *) echo "::error::terraform plan failed with exit code $EXITCODE"; exit 1 ;;',
  "esac",
  "",
].join("\n");

const PEG_POLICY_PUBLICATION_DETECT_CHANGES_COMMAND = [
  'if [ "$EXITCODE" = "2" ]; then',
  '  echo "has-changes=true" >> "$GITHUB_OUTPUT"',
  "else",
  '  echo "has-changes=false" >> "$GITHUB_OUTPUT"',
  "fi",
  "",
].join("\n");

const PEG_POLICY_PUBLICATION_VALIDATE_COMMAND = [
  "node scripts/alerts/check-peg-registry-integrity.mjs",
  "node scripts/alerts/check-peg-policy-publication.mjs",
  "",
].join("\n");

function pegPolicyPublicationPlanJobInventory() {
  return {
    name: "Read-only Peg policy publication plan",
    needs: "validate",
    if: "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    "runs-on": "blacksmith-4vcpu-ubuntu-2404-arm",
    "timeout-minutes": 15,
    permissions: {
      contents: "read",
      "id-token": "write",
    },
    defaults: {
      run: {
        "working-directory": "alerts/peg-policy-publication",
      },
    },
    outputs: {
      "has-changes": "${{ steps.detect.outputs.has-changes }}",
    },
    steps: [
      {
        uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        with: {
          "persist-credentials": false,
        },
      },
      {
        name: "Authenticate trusted-main refresh to Google Cloud",
        uses: "google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093",
        with: {
          workload_identity_provider:
            "${{ vars.GCP_TERRAFORM_REFRESH_WORKLOAD_IDENTITY_PROVIDER }}",
          service_account:
            "${{ vars.GCP_PEG_POLICY_PUBLICATION_PLAN_SERVICE_ACCOUNT }}",
        },
      },
      {
        uses: "hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e",
        with: {
          terraform_version: "1.14.6",
          terraform_wrapper: false,
        },
      },
      {
        name: "Init read-only backend",
        run: 'terraform init -input=false -backend-config="impersonate_service_account=peg-policy-publication-reader@mento-terraform-seed-ffac.iam.gserviceaccount.com"',
      },
      {
        name: "Plan",
        id: "plan",
        env: {
          TF_VAR_terraform_service_account:
            "peg-policy-publication-reader@mento-terraform-seed-ffac.iam.gserviceaccount.com",
        },
        run: PEG_POLICY_PUBLICATION_PLAN_COMMAND,
      },
      {
        name: "Detect changes",
        id: "detect",
        env: {
          EXITCODE: "${{ steps.plan.outputs.exitcode }}",
        },
        run: PEG_POLICY_PUBLICATION_DETECT_CHANGES_COMMAND,
      },
    ],
  };
}

function pegPolicyPublicationApplyJobInventory() {
  return {
    name: "Protected Peg policy publication apply",
    needs: "plan",
    if: "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.operation == 'apply' && needs.plan.outputs.has-changes == 'true'",
    environment: {
      name: "production-infra",
      url: PEG_POLICY_PUBLICATION_CONSOLE_URL,
    },
    "runs-on": "blacksmith-4vcpu-ubuntu-2404-arm",
    "timeout-minutes": 20,
    permissions: {
      contents: "read",
      "id-token": "write",
      actions: "read",
      deployments: "read",
    },
    defaults: {
      run: {
        "working-directory": "alerts/peg-policy-publication",
      },
    },
    env: {
      TF_VAR_terraform_service_account:
        "peg-policy-publisher@mento-monitoring.iam.gserviceaccount.com",
    },
    steps: [
      {
        uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        with: {
          "persist-credentials": false,
        },
      },
      {
        name: "Verify production-infra environment protection",
        env: {
          GITHUB_TOKEN: AUTOMATIC_GITHUB_CREDENTIAL,
          GITHUB_ENVIRONMENT_NAME: "production-infra",
        },
        run: 'node "$GITHUB_WORKSPACE/scripts/verify-github-environment-protection.mjs"',
      },
      {
        name: "Authenticate to Google Cloud",
        uses: "google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093",
        with: {
          workload_identity_provider:
            "${{ vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER }}",
          service_account: "${{ vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT }}",
        },
      },
      {
        uses: "hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e",
        with: {
          terraform_version: "1.14.6",
          terraform_wrapper: false,
        },
      },
      {
        name: "Init",
        run: "terraform init -input=false",
      },
      {
        name: "Apply",
        run: "terraform apply -auto-approve -no-color -input=false -lock-timeout=10m",
      },
      {
        name: "Record published generation handoff",
        if: "success()",
        run: PEG_POLICY_PUBLICATION_HANDOFF_COMMAND,
      },
    ],
  };
}

function pegPolicyPublicationWorkflowInventory() {
  return {
    name: "Peg Policy Publication",
    on: {
      workflow_dispatch: {
        inputs: {
          operation: {
            description:
              "Produce a protected plan, or plan then apply after production-infra approval",
            required: true,
            type: "choice",
            default: "plan",
            options: ["plan", "apply"],
          },
        },
      },
      pull_request: {
        branches: ["main"],
        paths: [
          "alerts/peg-policy-publication/**",
          "alerts/rules/peg-thresholds.json",
          "metrics-bridge/peg-registry.json",
          "scripts/alerts/check-peg-policy-publication.mjs",
          "scripts/alerts/check-peg-registry-integrity.mjs",
          "scripts/alerts/check-peg-registry-integrity-lineage.mjs",
          "scripts/lib/peg-policy-digest.mjs",
          "scripts/lib/hcl.mjs",
          ".github/workflows/peg-policy-publication.yml",
        ],
      },
    },
    permissions: "read-all",
    concurrency: {
      group:
        "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || 'deploy' }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      queue: "${{ github.event_name == 'pull_request' && 'single' || 'max' }}",
    },
    jobs: {
      validate: {
        name: "Terraform Validate (Peg policy publication)",
        "runs-on": "blacksmith-4vcpu-ubuntu-2404-arm",
        "timeout-minutes": 10,
        defaults: {
          run: {
            "working-directory": "alerts/peg-policy-publication",
          },
        },
        steps: [
          {
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            with: {
              "persist-credentials": false,
              "fetch-depth": 0,
            },
          },
          {
            uses: "./.github/actions/pnpm-install",
          },
          {
            uses: "hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e",
            with: {
              terraform_version: "1.14.6",
              terraform_wrapper: false,
            },
          },
          {
            name: "Format check",
            run: "terraform fmt -check -recursive",
          },
          {
            name: "Init without backend",
            run: "terraform init -backend=false -input=false",
          },
          {
            name: "Validate",
            run: "terraform validate -no-color",
          },
          {
            name: "Validate Peg registry and publication boundary",
            "working-directory": "${{ github.workspace }}",
            run: PEG_POLICY_PUBLICATION_VALIDATE_COMMAND,
          },
        ],
      },
      plan: pegPolicyPublicationPlanJobInventory(),
      apply: pegPolicyPublicationApplyJobInventory(),
    },
  };
}

export function protectedApplyJobInventory(workflowPath) {
  if (workflowPath === PEG_POLICY_PUBLICATION_WORKFLOW) {
    return pegPolicyPublicationApplyJobInventory();
  }
  const config = APPLY_CONFIG_BY_WORKFLOW[workflowPath];
  if (!config) return undefined;

  return {
    name: config.name,
    needs: "plan",
    if: PROTECTED_JOB_CONDITION,
    environment: {
      name: "production-infra",
      url: PRODUCTION_CONSOLE_URL,
    },
    "runs-on": "blacksmith-4vcpu-ubuntu-2404-arm",
    "timeout-minutes": 30,
    permissions: {
      contents: "read",
      "id-token": "write",
      actions: "read",
      deployments: "read",
    },
    defaults: {
      run: {
        "working-directory": config.workingDirectory,
      },
    },
    env: config.environmentVariables,
    steps: [...commonApplySteps(), ...postAuthApplySteps(config)],
  };
}

function decodedTreeContains(root, predicate) {
  const ancestors = new WeakSet();

  function visit(value) {
    if (typeof value === "string") return predicate(value);
    if (value === null || typeof value !== "object") return false;
    if (ancestors.has(value)) return false;

    ancestors.add(value);
    const found = Array.isArray(value)
      ? value.some(visit)
      : Object.entries(value).some(
          ([key, entry]) => predicate(key) || visit(entry),
        );
    ancestors.delete(value);
    return found;
  }

  return visit(root);
}

function containsVariableSelectorIndirection(value) {
  const serializesVariables =
    /\btojson\s*\(/iu.test(value) && /\bvars\b/iu.test(value);
  return (
    serializesVariables ||
    /\bvars\s*\[/iu.test(value) ||
    /\bvars\s*\.\s*\*/iu.test(value)
  );
}

// This is a regression tripwire for paired merge-capable write scopes and for
// write-all. The exact Dependabot writer is the sole paired-scope exception.
// This is not a general merge-capability detector: contents: write alone can
// authorize the REST pull-request merge endpoint.
function usesBroadWritePermissionShape(permissions) {
  return (
    permissions === "write-all" ||
    (isMapping(permissions) &&
      permissions.contents === "write" &&
      permissions["pull-requests"] === "write")
  );
}

function validateBroadWritePermissionShape(
  workflowPath,
  parsedWorkflow,
  jobs,
  allowedCombinedWriteJobs,
  errors,
) {
  const matches = [];
  if (usesBroadWritePermissionShape(parsedWorkflow.permissions)) {
    matches.push("workflow");
  }
  for (const [jobName, job] of Object.entries(jobs)) {
    if (
      isMapping(job) &&
      usesBroadWritePermissionShape(job.permissions) &&
      !allowedCombinedWriteJobs.has(jobName)
    ) {
      matches.push(`job ${jobName}`);
    }
  }
  if (matches.length > 0) {
    errors.push(
      `${workflowPath}: repository workflows must not use permissions: write-all or combined contents: write and pull-requests: write outside the exact Dependabot writer (${matches.join(", ")})`,
    );
  }
}

export function validateWorkflowInventory(
  workflowPath,
  parsedWorkflow,
  errors,
) {
  const jobs = isMapping(parsedWorkflow.jobs) ? parsedWorkflow.jobs : {};
  const allowedCombinedWriteJobs = new Set();
  if (
    workflowPath === DEPENDABOT_AUTO_MERGE_CANDIDATE_WORKFLOW ||
    workflowPath === DEPENDABOT_AUTO_MERGE_WRITER_WORKFLOW
  ) {
    const semanticHash = createHash("sha256")
      .update(JSON.stringify(parsedWorkflow))
      .digest("hex");
    const expectedHash =
      workflowPath === DEPENDABOT_AUTO_MERGE_CANDIDATE_WORKFLOW
        ? DEPENDABOT_AUTO_MERGE_CANDIDATE_SEMANTIC_SHA256
        : DEPENDABOT_AUTO_MERGE_WRITER_SEMANTIC_SHA256;
    if (semanticHash === expectedHash) {
      // Only the exact writer has the paired merge-capable write scopes. The
      // candidate hash is pinned independently and receives no write scope.
      if (workflowPath === DEPENDABOT_AUTO_MERGE_WRITER_WORKFLOW) {
        allowedCombinedWriteJobs.add("auto-merge");
      }
    } else {
      errors.push(
        `${workflowPath}: must match the exact reviewed Dependabot auto-merge workflow pair inventory (observed semantic sha256 ${semanticHash})`,
      );
    }
  }
  validateBroadWritePermissionShape(
    workflowPath,
    parsedWorkflow,
    jobs,
    allowedCombinedWriteJobs,
    errors,
  );

  if (workflowPath === PEG_POLICY_PUBLICATION_WORKFLOW) {
    if (
      !isDeepStrictEqual(
        parsedWorkflow,
        pegPolicyPublicationWorkflowInventory(),
      )
    ) {
      errors.push(
        `${workflowPath}: must match the exact manual publication workflow inventory`,
      );
    }
    return;
  }

  const expectedEnvironmentEntries = [...JOB_ENVIRONMENT_INVENTORY].filter(
    ([key]) => key.startsWith(`${workflowPath}#`),
  );
  const invalidEnvironmentKeys = new Set();

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!isMapping(job) || !Object.hasOwn(job, "environment")) continue;
    const key = `${workflowPath}#${jobName}`;
    const expectedEnvironment = JOB_ENVIRONMENT_INVENTORY.get(key);
    if (
      !expectedEnvironment ||
      !isDeepStrictEqual(job.environment, expectedEnvironment)
    ) {
      invalidEnvironmentKeys.add(key);
    }
  }

  for (const [key, expectedEnvironment] of expectedEnvironmentEntries) {
    const jobName = key.slice(workflowPath.length + 1);
    if (
      !isMapping(jobs[jobName]) ||
      !isDeepStrictEqual(jobs[jobName].environment, expectedEnvironment)
    ) {
      invalidEnvironmentKeys.add(key);
    }
  }

  for (const key of invalidEnvironmentKeys) {
    errors.push(
      `${key}: workflow job environments must match the exact registered inventory`,
    );
  }

  if (
    decodedTreeContains(parsedWorkflow, containsVariableSelectorIndirection)
  ) {
    errors.push(
      `${workflowPath}: workflow variable selectors must be literal and must not serialize vars`,
    );
  }

  const expectedApplyJob = protectedApplyJobInventory(workflowPath);
  if (expectedApplyJob && !isDeepStrictEqual(jobs.apply, expectedApplyJob)) {
    errors.push(
      `${workflowPath}: apply job must match the exact protected semantic inventory`,
    );
  }
}

function postAuthLocalDependencyPaths() {
  const dependencyPaths = new Set();
  const workspacePathPattern =
    /\$(?:\{GITHUB_WORKSPACE\}|GITHUB_WORKSPACE)\/([A-Za-z0-9._/-]+)/gu;
  const relativeRepositoryPathPattern =
    /(?<![A-Za-z0-9_/.])(?:\.\/)?((?:scripts|\.github\/actions)\/[A-Za-z0-9._/-]+)/gu;

  for (const workflowPath of PROTECTED_APPLY_WORKFLOWS) {
    const steps = protectedApplyJobInventory(workflowPath).steps;
    const authIndex = steps.findIndex(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("google-github-actions/auth@"),
    );
    for (const step of steps.slice(authIndex + 1)) {
      if (typeof step.uses === "string" && step.uses.startsWith("./")) {
        dependencyPaths.add(step.uses.slice(2));
      }
      if (typeof step.run !== "string") continue;
      for (const match of step.run.matchAll(workspacePathPattern)) {
        dependencyPaths.add(match[1]);
      }
      for (const match of step.run.matchAll(relativeRepositoryPathPattern)) {
        dependencyPaths.add(match[1]);
      }
    }
  }

  return dependencyPaths;
}

export function validateWorkflowDependencyInventory(files, errors) {
  const hasDependabotCandidate = Object.hasOwn(
    files,
    DEPENDABOT_AUTO_MERGE_CANDIDATE_WORKFLOW,
  );
  const hasDependabotWriter = Object.hasOwn(
    files,
    DEPENDABOT_AUTO_MERGE_WRITER_WORKFLOW,
  );
  if (hasDependabotCandidate !== hasDependabotWriter) {
    errors.push(
      "the Dependabot auto-merge classifier and writer workflows must be present or absent as one reviewed pair",
    );
  }

  const registeredDependencies = new Map(
    LOCAL_DEPENDENCY_INVENTORY.map((dependency) => [
      dependency.path,
      dependency,
    ]),
  );
  const postAuthDependencies = postAuthLocalDependencyPaths();
  for (const dependencyPath of postAuthDependencies) {
    if (!registeredDependencies.has(dependencyPath)) {
      errors.push(
        `${dependencyPath}: post-auth local dependency must have a pinned content hash`,
      );
    }
  }
  for (const dependency of LOCAL_DEPENDENCY_INVENTORY) {
    if (
      dependency.phase === "post-auth apply helper" &&
      !postAuthDependencies.has(dependency.path)
    ) {
      errors.push(
        `${dependency.path}: pinned post-auth dependency is not present in the protected workflow inventory`,
      );
    }
  }

  for (const dependency of LOCAL_DEPENDENCY_INVENTORY) {
    const contents = files[dependency.path];
    const actualHash =
      typeof contents === "string"
        ? createHash("sha256").update(contents).digest("hex")
        : undefined;
    if (actualHash !== dependency.sha256) {
      errors.push(
        `${dependency.path}: ${dependency.phase} must match its pinned content hash`,
      );
    }
  }
}
