import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const PROTECTED_JOB_CONDITION =
  "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && needs.plan.outputs.has-changes == 'true' && (github.event_name == 'workflow_dispatch' || needs.plan.outputs.stack-changed == 'true')";
const PRODUCTION_CONSOLE_URL =
  "https://console.cloud.google.com/home/dashboard?project=mento-terraform-seed-ffac";

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
]);

const LOCAL_DEPENDENCY_INVENTORY = [
  {
    path: "scripts/verify-github-environment-protection.mjs",
    phase: "pre-auth protection verifier",
    sha256: "9a8dbea69115dcb29855ceecdf22f29a837021e9de3ec8d3968d13dbfe0a53af",
  },
  {
    path: "scripts/sanitize-terraform-output.sh",
    phase: "post-auth apply helper",
    sha256: "d6bce631d4eab849d7c0981ad118e33255ff5638c759ce558cf5234802be53a3",
  },
];

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function commonApplySteps() {
  return [
    {
      uses: "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
    },
    {
      name: "Verify production-infra environment protection",
      env: {
        GITHUB_TOKEN: "${{ github.token }}",
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
        uses: "Kesin11/actions-timeline@7bf79990b7c09f5dfb570ac30b814ca597bd538e",
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
      uses: "Kesin11/actions-timeline@7bf79990b7c09f5dfb570ac30b814ca597bd538e",
      if: "always()",
    },
  ];
}

export function protectedApplyJobInventory(workflowPath) {
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

export function validateWorkflowInventory(
  workflowPath,
  parsedWorkflow,
  errors,
) {
  const jobs = isMapping(parsedWorkflow.jobs) ? parsedWorkflow.jobs : {};
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

  for (const workflowPath of Object.keys(APPLY_CONFIG_BY_WORKFLOW)) {
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
