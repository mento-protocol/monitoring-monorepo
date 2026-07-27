import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateContract } from './contract.mjs';

const agentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(agentDir, '../..');

function sourceFiles() {
  return {
    providers: readFileSync(
      path.join(repoRoot, 'terraform/providers.tf'),
      'utf8',
    ),
    providerLock: readFileSync(
      path.join(repoRoot, 'terraform/.terraform.lock.hcl'),
      'utf8',
    ),
    variables: readFileSync(
      path.join(repoRoot, 'terraform/variables.tf'),
      'utf8',
    ),
    bootstrap: readFileSync(
      path.join(repoRoot, 'terraform/aegis-bootstrap.tf'),
      'utf8',
    ),
    dockerfile: readFileSync(path.join(agentDir, 'Dockerfile'), 'utf8'),
    entrypoint: readFileSync(path.join(agentDir, 'entrypoint.sh'), 'utf8'),
    passiveHealth: readFileSync(
      path.join(agentDir, 'passive-health.sh'),
      'utf8',
    ),
    appYaml: readFileSync(path.join(agentDir, 'grafana-agent.yaml'), 'utf8'),
    cloudbuild: readFileSync(path.join(agentDir, 'cloudbuild.yaml'), 'utf8'),
    cloudIgnore: readFileSync(path.join(agentDir, '.gcloudignore'), 'utf8'),
    deploy: readFileSync(path.join(agentDir, 'deploy.sh'), 'utf8'),
    preflight: readFileSync(path.join(agentDir, 'preflight.mjs'), 'utf8'),
    rootPackage: readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    aegisPackage: readFileSync(
      path.join(repoRoot, 'aegis/package.json'),
      'utf8',
    ),
    legacySeedExists: false,
    terraformIgnore: readFileSync(
      path.join(repoRoot, 'terraform/.gitignore'),
      'utf8',
    ),
    tfvarsExample: readFileSync(
      path.join(repoRoot, 'terraform/terraform.tfvars.example'),
      'utf8',
    ),
    runbook: readFileSync(path.join(agentDir, 'README.md'), 'utf8'),
  };
}

function expectFailure(files, pattern) {
  const errors = validateContract(files);
  assert.match(errors.join('\n'), pattern);
}

test('the checked-in Alloy Terraform/runtime contract is complete', () => {
  assert.deepEqual(validateContract(sourceFiles()), []);
});

test('missing ephemeral operator inputs fail closed', () => {
  const files = sourceFiles();
  files.variables = files.variables.replace('  ephemeral = true\n', '');
  expectFailure(files, /must be ephemeral/u);
});

test('the Google provider cannot drift from the reviewed 6.50 schema', () => {
  const files = sourceFiles();
  files.providerLock = files.providerLock.replace(
    'version     = "6.50.0"',
    'version     = "6.51.0"',
  );
  expectFailure(files, /Google provider must stay locked to 6\.50\.0/u);
});

test('the Google provider constraint cannot admit another minor', () => {
  const files = sourceFiles();
  files.providers = files.providers.replace('~> 6.50.0', '~> 6.50');
  expectFailure(files, /must stay constrained to 6\.50\.x/u);
});

test('the Google provider lock preserves the reviewed minor constraint', () => {
  const files = sourceFiles();
  files.providerLock = files.providerLock.replace('~> 6.50.0', '~> 6.50');
  expectFailure(files, /lock must preserve the 6\.50\.x constraint/u);
});

test('state-stored Secret Manager values are rejected', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    'secret_data_wo         =',
    'secret_data            =',
  );
  expectFailure(files, /state-stored secret_data is forbidden/u);
});

test('rotation-counter wiring cannot silently disappear', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    'secret_data_wo_version = var.grafana_agent_secret_rotation_counters[each.key]',
    'secret_data_wo_version = 1',
  );
  expectFailure(files, /reviewed rotation counter/u);
});

test('write-only secret rotation must create before disabling', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    '    create_before_destroy = true',
    '    create_before_destroy = false',
  );
  expectFailure(files, /create the replacement before disabling/u);
});

test('the write-only secret set cannot silently expand', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    '    "grafana-agent-password",',
    '    "grafana-agent-password",\n    "grafana-agent-extra",',
  );
  expectFailure(
    files,
    /must contain exactly endpoint, username, and password/u,
  );
});

test('the App Engine identity cannot drift from Terraform', () => {
  const files = sourceFiles();
  files.appYaml = files.appYaml.replace(
    'grafana-agent-runtime@mento-monitoring.iam.gserviceaccount.com',
    'mento-monitoring@appspot.gserviceaccount.com',
  );
  expectFailure(files, /service_account must pin/u);
});

test('the activation role waits for every required API', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    `  depends_on = [
    google_project_service.appengineflex,
    google_project_service.iam,
  ]`,
    '  depends_on = [google_project_service.appengineflex]',
  );
  expectFailure(files, /must wait for App Engine Flex and IAM APIs/u);
});

test('activation inventory must follow every App Engine versions page', () => {
  const files = sourceFiles();
  files.entrypoint = files.entrypoint.replace(
    'versions_url="${versions_url}&pageToken=${encoded_page_token}"',
    'versions_url="${versions_url}"',
  );
  expectFailure(files, /must follow every version-inventory page/u);
});

test('activation inventory must reject repeated App Engine page tokens', () => {
  const files = sourceFiles();
  files.entrypoint = files.entrypoint.replace(
    "'index($token) != null'",
    "'false'",
  );
  expectFailure(files, /must reject repeated version page tokens/u);
});

test('the runtime account cannot gain another static secret grant', () => {
  const files = sourceFiles();
  files.bootstrap += `
resource "google_secret_manager_secret_iam_member" "extra_runtime_access" {
  project   = google_project.monitoring.project_id
  secret_id = "unrelated"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:\${google_service_account.grafana_agent_runtime.email}"
}
`;
  expectFailure(files, /only the exact managed Alloy secret grants/u);
});

test('the App Engine Flex runtime must keep Logs Writer', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    'resource "google_project_iam_member" "grafana_agent_runtime_log_writer"',
    'resource "google_project_iam_member" "removed_runtime_log_writer"',
  );
  expectFailure(files, /App Engine Flex Logs Writer/u);
});

test('the App Engine Flex runtime must keep repository-scoped image Reader', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    'resource "google_artifact_registry_repository_iam_member" "grafana_agent_runtime_image_reader"',
    'resource "google_artifact_registry_repository_iam_member" "removed_runtime_image_reader"',
  );
  expectFailure(files, /grafana_agent_runtime_image_reader/u);
});

test('runtime image repository must exist before its IAM binding', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    'resource "google_artifact_registry_repository" "grafana_agent_runtime_images"',
    'resource "google_artifact_registry_repository" "removed_runtime_images"',
  );
  expectFailure(files, /grafana_agent_runtime_images/u);
});

test('runtime image repository must reject deletion', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    `  depends_on = [google_project_service.artifactregistry]

  lifecycle {
    prevent_destroy = true
  }`,
    `  depends_on = [google_project_service.artifactregistry]

  lifecycle {
    prevent_destroy = false
  }`,
  );
  expectFailure(
    files,
    /runtime image repository must wait for its API and reject deletion/u,
  );
});

test('runtime image access cannot broaden beyond us.gcr.io Reader', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    'role       = "roles/artifactregistry.reader"',
    'role       = "roles/artifactregistry.writer"',
  );
  expectFailure(files, /Reader on only the us\.gcr\.io repository/u);
});

test('runtime secret IAM must preserve bootstrap ordering', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    'secret_id = google_secret_manager_secret.grafana_agent[each.value].secret_id',
    'secret_id = each.value',
  );
  expectFailure(files, /depend on each exact managed Alloy secret resource/u);
});

test('operator preflight reader cannot gain secret payload access', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    '    "secretmanager.versions.get",',
    '    "secretmanager.versions.get",\n    "secretmanager.versions.access",',
  );
  expectFailure(
    files,
    /operator preflight reader must contain only the exact metadata permissions/u,
  );
});

test('operator preflight role pins the Terraform member-set fingerprint', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    'operator-set-sha256=${sha256(jsonencode(sort(distinct(var.gcp_dev_members))))}',
    'operator-set-sha256=unverified',
  );
  expectFailure(files, /must carry the Terraform member-set fingerprint/u);
});

test('operator preflight role waits for every permission-owning API', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    `  depends_on = [
    google_project_service.appengineflex,
    google_project_service.artifactregistry,
    google_project_service.iam,
    google_project_service.secretmanager,
  ]`,
    `  depends_on = [
    google_project_service.appengineflex,
    google_project_service.iam,
    google_project_service.secretmanager,
  ]`,
  );
  expectFailure(files, /must wait for every permission-owning API/u);
});

test('operator preflight reader must stay scoped to gcp_dev_members', () => {
  const files = sourceFiles();
  files.bootstrap = files.bootstrap.replace(
    'resource "google_project_iam_member" "grafana_agent_operator_preflight_reader" {\n  for_each = toset(var.gcp_dev_members)',
    'resource "google_project_iam_member" "grafana_agent_operator_preflight_reader" {\n  for_each = toset(["allUsers"])',
  );
  expectFailure(
    files,
    /operator preflight readers must stay scoped to gcp_dev_members/u,
  );
});

test('live preflight derives submitters from the Terraform-managed operator set', () => {
  const files = sourceFiles();
  files.preflight = files.preflight.replace(
    "    expectedBuildSubmitters,\n    'builder service account submitters',",
    "    ['group:eng@mentolabs.xyz'],\n    'builder service account submitters',",
  );
  expectFailure(
    files,
    /both submitter policies must derive from and match the Terraform member-set fingerprint/u,
  );
});

test('live preflight must reject non-runtime secret members', () => {
  const files = sourceFiles();
  files.preflight = files.preflight.replace(
    '      [runtimeMember],\n      `${secretId} Secret Accessor policy`,',
    '      [runtimeMember, builderMember],\n      `${secretId} Secret Accessor policy`,',
  );
  expectFailure(
    files,
    /managed Alloy secret policies must allow only the pinned runtime identity/u,
  );
});

test('live preflight must reject project-level and conditional secret access', () => {
  const files = sourceFiles();
  files.preflight = files.preflight
    .replace(
      "'roles/secretmanager.secretAccessor',\n  );",
      "'roles/secretmanager.viewer',\n  );",
    )
    .replace('binding.role === role && binding.condition != null', 'false');
  const errors = validateContract(files).join('\n');
  assert.match(errors, /project IAM must not grant Secret Accessor/u);
  assert.match(errors, /exact IAM policies must reject conditional bindings/u);
});

test('legacy secret accessors cannot return', () => {
  const files = sourceFiles();
  files.bootstrap +=
    '\nresource "google_secret_manager_secret_iam_member" "grafana_agent_appspot_accessor" {}\n';
  expectFailure(files, /legacy secret accessor .* must stay absent/u);
});

test('deploy must verify the new version identity', () => {
  const files = sourceFiles();
  files.deploy = files.deploy.replace(
    'node "$verifier_root/aegis/grafana-agent/preflight.mjs"',
    'echo "verification skipped"',
  );
  expectFailure(files, /immutable verifier snapshot/u);
});

test('Cloud Build cannot promote before live version verification', () => {
  const files = sourceFiles();
  files.cloudbuild = files.cloudbuild.replace('--no-promote', '--promote');
  expectFailure(files, /must not promote before live identity verification/u);
});

test('Cloud Build must use the dedicated builder identity', () => {
  const files = sourceFiles();
  files.cloudbuild = files.cloudbuild.replace(
    'grafana-agent-builder@mento-monitoring.iam.gserviceaccount.com',
    '123456789@cloudbuild.gserviceaccount.com',
  );
  expectFailure(files, /build must pin grafana-agent-builder/u);
});

test('default build identities cannot regain runtime impersonation', () => {
  const files = sourceFiles();
  files.bootstrap += `
resource "google_service_account_iam_member" "grafana_agent_cloudbuild_appengine_default_service_account_user" {
  service_account_id = google_service_account.grafana_agent_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:123456789@cloudbuild.gserviceaccount.com"
}
`;
  expectFailure(files, /default Cloud Build identities must not act/u);
});

test('Cloud Build source staging cannot broaden beyond runtime inputs', () => {
  const files = sourceFiles();
  files.cloudIgnore += '\n!.env\n';
  expectFailure(
    files,
    /Cloud Build upload must allow only the five audited runtime files/u,
  );
});

test('traffic promotion must follow live version verification', () => {
  const files = sourceFiles();
  const verification =
    'node "$verifier_root/aegis/grafana-agent/preflight.mjs"';
  files.deploy = files.deploy.replace(verification, '');
  files.deploy += `\n${verification}\n`;
  expectFailure(files, /failed build or version verification must stop/u);
});

test('failed Cloud Build must clean up a partially created passive target', () => {
  const files = sourceFiles();
  files.deploy = files.deploy.replace(
    'echo "Cloud Build failed; checking for a partially created passive target." >&2\n    cleanup_unpromoted_target "$version"',
    'echo "build cleanup skipped"',
  );
  expectFailure(files, /failed build or version verification must stop/u);
});

test('failed post-build verification must clean up the passive target', () => {
  const files = sourceFiles();
  files.deploy = files.deploy.replace(
    '--version "$version"; then\n    cleanup_unpromoted_target "$version"',
    '--version "$version"; then\n    echo "cleanup skipped"',
  );
  expectFailure(files, /failed build or version verification must stop/u);
});

test('hostname discovery must finish before Cloud Build submission', () => {
  const files = sourceFiles();
  files.deploy = files.deploy.replace(
    'if ! default_hostname="$(',
    'if ! ignored_hostname="$(',
  );
  expectFailure(files, /hostname must be resolved before Cloud Build/u);
});

test('production deploy rejects clean feature and stale main checkouts', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const cases = [
    {
      name: 'feature branch',
      gitFunction: `
git() {
  if [[ "$*" == *"rev-parse --abbrev-ref HEAD"* ]]; then
    printf '%s\\n' feature
    return 0
  fi
  return 99
}`,
      pattern: /expected main/u,
    },
    {
      name: 'stale main',
      gitFunction: `
git() {
  case "$*" in
    *"rev-parse --abbrev-ref HEAD"*) printf '%s\\n' main ;;
    *"fetch --quiet origin"*) return 0 ;;
    *"rev-parse HEAD"*) printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    *"rev-parse origin/main"*) printf '%s\\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
    *) return 99 ;;
  esac
}`,
      pattern: /does not match current origin\/main/u,
    },
  ];

  for (const testCase of cases) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `source "$1"\n${testCase.gitFunction}\nassert_current_main /tmp/repo`,
        'bash',
        deployPath,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0, testCase.name);
    assert.match(result.stderr, testCase.pattern, testCase.name);
  }
});

test('production deploy rejects source changes after confirmation', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const cases = [
    {
      name: 'dirty worktree',
      gitFunction: `
git() {
  case "$*" in
    *"rev-parse --abbrev-ref HEAD"*) printf '%s\\n' main ;;
    *"fetch --quiet origin"*) return 0 ;;
    *"rev-parse origin/main"*) printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    *"rev-parse HEAD"*) printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    *"status --porcelain"*) printf '%s\\n' ' M aegis/grafana-agent/entrypoint.sh' ;;
    *) return 99 ;;
  esac
}`,
      pattern: /working tree changed after preflight/u,
    },
    {
      name: 'advanced origin main',
      gitFunction: `
git() {
  case "$*" in
    *"status --porcelain"*) return 0 ;;
    *"rev-parse --abbrev-ref HEAD"*) printf '%s\\n' main ;;
    *"fetch --quiet origin"*) return 0 ;;
    *"rev-parse HEAD"*) printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    *"rev-parse origin/main"*) printf '%s\\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
    *) return 99 ;;
  esac
}`,
      pattern: /does not match current origin\/main/u,
    },
    {
      name: 'source head changed',
      gitFunction: `
git() {
  case "$*" in
    *"status --porcelain"*) return 0 ;;
    *"rev-parse --abbrev-ref HEAD"*) printf '%s\\n' main ;;
    *"fetch --quiet origin"*) return 0 ;;
    *"rev-parse origin/main"*) printf '%s\\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
    *"rev-parse HEAD"*) printf '%s\\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
    *) return 99 ;;
  esac
}`,
      pattern: /source HEAD changed after preflight/u,
    },
  ];

  for (const testCase of cases) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `source "$1"\n${testCase.gitFunction}\nassert_source_ready /tmp/repo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
        'bash',
        deployPath,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0, testCase.name);
    assert.match(result.stderr, testCase.pattern, testCase.name);
  }
});

test('production deploy rejects a worktree dirtied during the final origin fetch', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
expected_head="$2"
dirty=0
git() {
  case "$*" in
    *"rev-parse --abbrev-ref HEAD"*) printf '%s\\n' main ;;
    *"fetch --quiet origin"*) dirty=1 ;;
    *"status --porcelain"*)
      if [[ "$dirty" == 1 ]]; then
        printf '%s\\n' ' M aegis/grafana-agent/entrypoint.sh'
      fi
      ;;
    *"rev-parse origin/main"*) printf '%s\\n' "$expected_head" ;;
    *"rev-parse HEAD"*) printf '%s\\n' "$expected_head" ;;
    *) return 99 ;;
  esac
}
assert_source_ready /tmp/repo "$expected_head"`,
      'bash',
      deployPath,
      head,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /working tree changed after preflight/u);
});

test('production deploy accepts the unchanged clean current-main source', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
expected_head="$2"
git() {
  case "$*" in
    *"status --porcelain"*) return 0 ;;
    *"rev-parse --abbrev-ref HEAD"*) printf '%s\\n' main ;;
    *"fetch --quiet origin"*) return 0 ;;
    *"rev-parse origin/main"*) printf '%s\\n' "$expected_head" ;;
    *"rev-parse HEAD"*) printf '%s\\n' "$expected_head" ;;
    *) return 99 ;;
  esac
}
assert_source_ready /tmp/repo "$expected_head"`,
      'bash',
      deployPath,
      head,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('production deploy snapshots only committed runtime inputs', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'grafana-agent-snapshot-'));
  const sourceDir = path.join(fixture, 'aegis/grafana-agent');
  const output = path.join(fixture, 'snapshot');
  const files = {
    Dockerfile: 'FROM scratch\n',
    'config.alloy': 'committed-config\n',
    'entrypoint.sh': '#!/usr/bin/env bash\nprintf committed\\n\n',
    'grafana-agent.yaml': 'runtime: custom\n',
    'passive-health.sh': '#!/usr/bin/env sh\nprintf passive\\n\n',
    'cloudbuild.yaml': 'steps: []\n',
  };

  try {
    mkdirSync(sourceDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(sourceDir, name), content);
    }
    for (const args of [
      ['init', '--quiet'],
      ['config', 'user.email', 'contract@example.com'],
      ['config', 'user.name', 'Contract Test'],
      ['add', '.'],
      ['commit', '--quiet', '-m', 'fixture'],
    ]) {
      const result = spawnSync('git', args, {
        cwd: fixture,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture,
      encoding: 'utf8',
    }).stdout.trim();

    writeFileSync(path.join(sourceDir, 'entrypoint.sh'), 'mutable-change\n');
    writeFileSync(path.join(sourceDir, '.env'), 'must-not-upload\n');

    const result = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"\nmaterialize_source_snapshot "$2" "$3" "$4"',
        'bash',
        path.join(agentDir, 'deploy.sh'),
        fixture,
        head,
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);

    const snapshotSource = path.join(output, 'aegis/grafana-agent');
    assert.deepEqual(readdirSync(snapshotSource).sort(), [
      'Dockerfile',
      'config.alloy',
      'entrypoint.sh',
      'grafana-agent.yaml',
      'passive-health.sh',
    ]);
    assert.equal(
      readFileSync(path.join(snapshotSource, 'entrypoint.sh'), 'utf8'),
      files['entrypoint.sh'],
    );
    assert.equal(
      readFileSync(path.join(output, 'cloudbuild.yaml'), 'utf8'),
      files['cloudbuild.yaml'],
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('immutable verifier snapshot executes the captured static preflight', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'alloy-verifier-snapshot-'));
  const output = path.join(fixture, 'snapshot');
  const verifierPaths = [
    'aegis/grafana-agent/.gcloudignore',
    'aegis/grafana-agent/README.md',
    'aegis/grafana-agent/Dockerfile',
    'aegis/grafana-agent/cloudbuild.yaml',
    'aegis/grafana-agent/contract.mjs',
    'aegis/grafana-agent/deploy.sh',
    'aegis/grafana-agent/entrypoint.sh',
    'aegis/grafana-agent/grafana-agent.yaml',
    'aegis/grafana-agent/passive-health.sh',
    'aegis/grafana-agent/preflight.mjs',
    'aegis/package.json',
    'package.json',
    'terraform/.gitignore',
    'terraform/.terraform.lock.hcl',
    'terraform/aegis-bootstrap.tf',
    'terraform/providers.tf',
    'terraform/terraform.tfvars.example',
    'terraform/variables.tf',
  ];

  try {
    for (const relativePath of verifierPaths) {
      const destination = path.join(fixture, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(
        destination,
        readFileSync(path.join(repoRoot, relativePath)),
      );
    }
    for (const args of [
      ['init', '--quiet'],
      ['config', 'user.email', 'contract@example.com'],
      ['config', 'user.name', 'Contract Test'],
      ['add', '.'],
      ['commit', '--quiet', '-m', 'verifier fixture'],
    ]) {
      const result = spawnSync('git', args, {
        cwd: fixture,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture,
      encoding: 'utf8',
    }).stdout.trim();
    const snapshot = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"\nmaterialize_verifier_snapshot "$2" "$3" "$4"',
        'bash',
        path.join(agentDir, 'deploy.sh'),
        fixture,
        head,
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const preflight = spawnSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        'const module = await import(process.argv[2]); module.runPreflight({ staticOnly: true, runGcloud: () => { throw new Error("static preflight invoked gcloud"); } });',
        'static-preflight-contract-test',
        path.join(output, 'aegis/grafana-agent/preflight.mjs'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal(preflight.stdout, 'Alloy static preflight passed.\n');

    const lookupFailure = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"\nmaterialize_verifier_snapshot "$2" "$3" "$4"',
        'bash',
        path.join(agentDir, 'deploy.sh'),
        fixture,
        'missing-commit',
        path.join(fixture, 'lookup-failure-snapshot'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(lookupFailure.status, 1);
    assert.match(
      lookupFailure.stderr,
      /could not prove the retired legacy seed writer is absent/u,
    );

    const legacySeedPath = path.join(
      fixture,
      'aegis/grafana-agent/seed-secrets.sh',
    );
    writeFileSync(legacySeedPath, '#!/usr/bin/env bash\n');
    for (const args of [
      ['add', 'aegis/grafana-agent/seed-secrets.sh'],
      ['commit', '--quiet', '-m', 'restore retired seed writer'],
    ]) {
      const result = spawnSync('git', args, {
        cwd: fixture,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const legacyHead = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture,
      encoding: 'utf8',
    }).stdout.trim();
    const rejectedSnapshot = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"\nmaterialize_verifier_snapshot "$2" "$3" "$4"',
        'bash',
        path.join(agentDir, 'deploy.sh'),
        fixture,
        legacyHead,
        path.join(fixture, 'rejected-snapshot'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(rejectedSnapshot.status, 1);
    assert.match(
      rejectedSnapshot.stderr,
      /source commit retains the retired legacy seed writer/u,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('collector health rejects the passive sentinel and accepts active Alloy', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const passive = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
curl() { printf '%s' collector-passive; }
sleep() { :; }
wait_for_collector_health https://example.invalid`,
      'bash',
      deployPath,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(passive.status, 0);

  const active = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
curl() { printf '%s' 'Alloy is healthy'; }
wait_for_collector_health https://example.invalid`,
      'bash',
      deployPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(active.status, 0, active.stderr);
});

test('rollback proves the target stopped before restarting the previous collector', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
project=mento-monitoring
LOG_PATH="$2"
gcloud() {
  printf '%s\\n' "$*" >>"$LOG_PATH"
  if [[ "$*" == *"versions describe target"* ]]; then
    printf '%s\\n' STOPPED
  fi
}
rollback_cutover previous target`,
      'bash',
      deployPath,
      path.join(tmpdir(), `alloy-rollback-${process.pid}.log`),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const logPath = path.join(tmpdir(), `alloy-rollback-${process.pid}.log`);
  const calls = readFileSync(logPath, 'utf8');
  rmSync(logPath, { force: true });
  assert.ok(
    calls.indexOf('versions stop target') <
      calls.indexOf('versions start previous'),
  );
  assert.ok(
    calls.indexOf('versions start previous') <
      calls.indexOf('services set-traffic grafana-agent'),
  );
});

test('unpromoted target cleanup stops and proves the passive version', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const logPath = path.join(
    tmpdir(),
    `alloy-passive-cleanup-${process.pid}.log`,
  );
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
project=mento-monitoring
LOG_PATH="$2"
gcloud() {
  printf '%s\\n' "$*" >>"$LOG_PATH"
  if [[ "$*" == *"versions describe target"* ]]; then printf '%s\\n' STOPPED; fi
}
cleanup_unpromoted_target target`,
      'bash',
      deployPath,
      logPath,
    ],
    { encoding: 'utf8' },
  );
  const calls = readFileSync(logPath, 'utf8');
  rmSync(logPath, { force: true });
  assert.equal(result.status, 0, `${result.stderr}\n${calls}`);
  assert.ok(
    calls.indexOf('versions stop target') <
      calls.indexOf('versions describe target'),
  );
});

test('unpromoted target cleanup prints fail-closed recovery when proof fails', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const logPath = path.join(
    tmpdir(),
    `alloy-passive-cleanup-failure-${process.pid}.log`,
  );
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
project=mento-monitoring
LOG_PATH="$2"
gcloud() {
  printf '%s\\n' "$*" >>"$LOG_PATH"
  if [[ "$*" == *"versions describe target"* ]]; then
    printf '%s\\n' STOPPED
    return 1
  fi
}
cleanup_unpromoted_target target`,
      'bash',
      deployPath,
      logPath,
    ],
    { encoding: 'utf8' },
  );
  rmSync(logPath, { force: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Manual passive-target cleanup/u);
  assert.match(result.stderr, /versions stop target/u);
  assert.doesNotMatch(result.stderr, /versions start/u);
});

test('rollback never starts the previous collector when target stop is unproven', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const logPath = path.join(
    tmpdir(),
    `alloy-rollback-failure-${process.pid}.log`,
  );
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
project=mento-monitoring
LOG_PATH="$2"
gcloud() {
  printf '%s\\n' "$*" >>"$LOG_PATH"
  if [[ "$*" == *"versions stop target"* ]]; then return 1; fi
}
rollback_cutover previous target`,
      'bash',
      deployPath,
      logPath,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  const calls = readFileSync(logPath, 'utf8');
  rmSync(logPath, { force: true });
  assert.doesNotMatch(calls, /versions start previous/u);
  assert.match(result.stderr, /Automatic rollback halted/u);
});

test('rollback rejects STOPPED output from a failed status query', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const logPath = path.join(
    tmpdir(),
    `alloy-rollback-status-failure-${process.pid}.log`,
  );
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
project=mento-monitoring
LOG_PATH="$2"
gcloud() {
  printf '%s\\n' "$*" >>"$LOG_PATH"
  if [[ "$*" == *"versions describe target"* ]]; then
    printf '%s\\n' STOPPED
    return 1
  fi
}
rollback_cutover previous target`,
      'bash',
      deployPath,
      logPath,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  const calls = readFileSync(logPath, 'utf8');
  rmSync(logPath, { force: true });
  assert.match(calls, /versions describe target/u);
  assert.doesNotMatch(calls, /versions start previous/u);
  assert.match(result.stderr, /Automatic rollback halted/u);
});

test('rollback never restarts previous while another peer remains serving', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const logPath = path.join(
    tmpdir(),
    `alloy-rollback-peer-failure-${process.pid}.log`,
  );
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
project=mento-monitoring
LOG_PATH="$2"
gcloud() {
  printf '%s\\n' "$*" >>"$LOG_PATH"
  if [[ "$*" == *"versions describe target"* ]]; then printf '%s\\n' STOPPED; fi
  if [[ "$*" == *"versions list"* ]]; then printf '%s\\n' peer; fi
  if [[ "$*" == *"versions stop peer"* ]]; then return 1; fi
}
rollback_cutover previous target`,
      'bash',
      deployPath,
      logPath,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  const calls = readFileSync(logPath, 'utf8');
  rmSync(logPath, { force: true });
  assert.match(calls, /versions stop peer/u);
  assert.doesNotMatch(calls, /versions start previous/u);
  assert.match(result.stderr, /another collector could not be proven STOPPED/u);
});

test('serving-version inventory failure cannot retire collectors or report success', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const logPath = path.join(
    tmpdir(),
    `alloy-inventory-failure-${process.pid}.log`,
  );
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
project=mento-monitoring
LOG_PATH="$2"
gcloud() {
  printf '%s\\n' "$*" >>"$LOG_PATH"
  if [[ "$*" == *"versions list"* ]]; then return 1; fi
}
if stop_other_collectors target; then exit 90; fi
if grep -q "versions stop" "$LOG_PATH"; then exit 91; fi`,
      'bash',
      deployPath,
      logPath,
    ],
    { encoding: 'utf8' },
  );
  rmSync(logPath, { force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /refusing activation/u);
});

test('printed rollback is ordered and short-circuits when target stop fails', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const logPath = path.join(
    tmpdir(),
    `alloy-manual-rollback-${process.pid}.log`,
  );
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
project=mento-monitoring
LOG_PATH="$2"
command="$(print_manual_rollback_commands previous target)"
[[ "$(grep -o '&&' <<<"$command" | wc -l | tr -d ' ')" == 8 ]]
gcloud() {
  printf '%s\\n' "$*" >>"$LOG_PATH"
  if [[ "$*" == *"versions stop target"* ]]; then return 1; fi
  if [[ "$*" == *"versions describe target"* ]]; then printf '%s\\n' STOPPED; fi
}
if eval "$command"; then exit 90; fi
if grep -Eq "versions describe target|versions start previous|services set-traffic" "$LOG_PATH"; then exit 91; fi`,
      'bash',
      deployPath,
      logPath,
    ],
    { encoding: 'utf8' },
  );
  const calls = readFileSync(logPath, 'utf8');
  rmSync(logPath, { force: true });
  assert.equal(result.status, 0, `${result.stderr}\n${calls}`);
  assert.match(calls, /versions stop target/u);
});

test('printed rollback preserves a failed status query before starting previous', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const logPath = path.join(
    tmpdir(),
    `alloy-manual-status-failure-${process.pid}.log`,
  );
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
project=mento-monitoring
LOG_PATH="$2"
command="$(print_manual_rollback_commands previous target)"
gcloud() {
  printf '%s\\n' "$*" >>"$LOG_PATH"
  if [[ "$*" == *"versions describe target"* ]]; then
    printf '%s\\n' STOPPED
    return 1
  fi
}
if eval "$command"; then exit 90; fi
if grep -Eq "versions start previous|services set-traffic" "$LOG_PATH"; then exit 91; fi`,
      'bash',
      deployPath,
      logPath,
    ],
    { encoding: 'utf8' },
  );
  const calls = readFileSync(logPath, 'utf8');
  rmSync(logPath, { force: true });
  assert.equal(result.status, 0, `${result.stderr}\n${calls}`);
  assert.match(calls, /versions describe target/u);
});

test('printed rollback stops and proves serving peers before starting previous', () => {
  const deployPath = path.join(agentDir, 'deploy.sh');
  const logPath = path.join(
    tmpdir(),
    `alloy-manual-peer-order-${process.pid}.log`,
  );
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
project=mento-monitoring
LOG_PATH="$2"
command="$(print_manual_rollback_commands previous target)"
gcloud() {
  printf '%s\\n' "$*" >>"$LOG_PATH"
  if [[ "$*" == *"versions describe target"* ]]; then printf '%s\\n' STOPPED; fi
  if [[ "$*" == *"versions list"* ]]; then printf '%s\\n' peer; fi
  if [[ "$*" == *"versions describe peer"* ]]; then printf '%s\\n' STOPPED; fi
}
eval "$command"`,
      'bash',
      deployPath,
      logPath,
    ],
    { encoding: 'utf8' },
  );
  const calls = readFileSync(logPath, 'utf8');
  rmSync(logPath, { force: true });
  assert.equal(result.status, 0, `${result.stderr}\n${calls}`);
  assert.ok(
    calls.indexOf('versions stop target') < calls.indexOf('versions stop peer'),
  );
  assert.ok(
    calls.indexOf('versions stop peer') <
      calls.indexOf('versions start previous'),
  );
  assert.ok(
    calls.indexOf('versions start previous') <
      calls.indexOf('services set-traffic grafana-agent'),
  );
});

test('post-confirmation source guard must precede Cloud Build submission', () => {
  const files = sourceFiles();
  const guard = 'assert_source_ready "$repo_root" "$source_head"';
  files.deploy = files.deploy.replace(guard, '');
  files.deploy += `\n${guard}\n`;
  expectFailure(
    files,
    /source identity and hostname must be resolved before Cloud Build/u,
  );
});

test('documented Terraform secret input files are gitignored', () => {
  for (const relativePath of [
    'terraform/terraform.tfvars',
    'terraform/alloy.auto.tfvars',
  ]) {
    const result = spawnSync('git', ['check-ignore', '--quiet', relativePath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${relativePath} must stay ignored`);
  }
});

test('completed image repository import cannot remain an operator step', () => {
  const files = sourceFiles();
  files.runbook +=
    '\nterraform -chdir=terraform import google_artifact_registry_repository.grafana_agent_runtime_images\n';
  expectFailure(files, /completed production repository import/u);
});

test('rollback guidance must reject legacy version identities', () => {
  const files = sourceFiles();
  files.runbook = files.runbook.replace(
    'pnpm aegis:agent:preflight -- --version TARGET',
    'echo legacy-rollback',
  );
  expectFailure(files, /rollback guidance must reject legacy identities/u);
});

test('deploy must retain the explicit previous-version rollback command', () => {
  const files = sourceFiles();
  files.deploy = files.deploy.replaceAll(
    'gcloud app services set-traffic grafana-agent',
    'echo rollback-skipped',
  );
  expectFailure(files, /printed rollback must short-circuit/u);
});

test('legacy CLI seed route cannot return', () => {
  const files = sourceFiles();
  files.legacySeedExists = true;
  files.rootPackage = files.rootPackage.replace(
    '"aegis:agent:deploy"',
    '"aegis:agent:seed-secrets": "forbidden",\n    "aegis:agent:deploy"',
  );
  files.aegisPackage = files.aegisPackage.replace(
    '"agent:deploy"',
    '"agent:seed-secrets": "forbidden",\n    "agent:deploy"',
  );
  files.deploy = files.deploy.replace(
    '  aegis/grafana-agent/preflight.mjs',
    '  aegis/grafana-agent/preflight.mjs\n  aegis/grafana-agent/seed-secrets.sh',
  );
  const errors = validateContract(files).join('\n');
  assert.match(errors, /legacy CLI secret writer must stay absent/u);
  assert.match(errors, /package\.json: legacy Alloy seed command/u);
  assert.match(errors, /immutable verifier must not retain/u);
});

test('immutable verifier must prove the retired seed path is absent', () => {
  const files = sourceFiles();
  files.deploy = files.deploy.replace(
    'if ! legacy_seed_entry="$(',
    'if legacy_seed_entry="$(',
  );
  expectFailure(files, /immutable verifier must fail closed while proving/u);
});
