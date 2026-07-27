import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(AGENT_DIR, '../..');

const CONTRACT_FILES = {
  providers: 'terraform/providers.tf',
  providerLock: 'terraform/.terraform.lock.hcl',
  variables: 'terraform/variables.tf',
  bootstrap: 'terraform/aegis-bootstrap.tf',
  dockerfile: 'aegis/grafana-agent/Dockerfile',
  entrypoint: 'aegis/grafana-agent/entrypoint.sh',
  passiveHealth: 'aegis/grafana-agent/passive-health.sh',
  appYaml: 'aegis/grafana-agent/grafana-agent.yaml',
  cloudbuild: 'aegis/grafana-agent/cloudbuild.yaml',
  cloudIgnore: 'aegis/grafana-agent/.gcloudignore',
  deploy: 'aegis/grafana-agent/deploy.sh',
  preflight: 'aegis/grafana-agent/preflight.mjs',
  legacySeed: 'aegis/grafana-agent/seed-secrets.sh',
  terraformIgnore: 'terraform/.gitignore',
  tfvarsExample: 'terraform/terraform.tfvars.example',
  runbook: 'aegis/grafana-agent/README.md',
};

const EXPECTED_RUNTIME_EMAIL =
  'grafana-agent-runtime@mento-monitoring.iam.gserviceaccount.com';
const EXPECTED_BUILDER_EMAIL =
  'grafana-agent-builder@mento-monitoring.iam.gserviceaccount.com';

function readContractFiles(root = REPO_ROOT) {
  return Object.fromEntries(
    Object.entries(CONTRACT_FILES).map(([key, relativePath]) => [
      key,
      readFileSync(path.join(root, relativePath), 'utf8'),
    ]),
  );
}

function extractHclBlock(source, header) {
  const headerIndex = source.indexOf(header);
  if (headerIndex === -1) return null;

  const openIndex = source.indexOf('{', headerIndex + header.length);
  if (openIndex === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (character === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (character === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '#') {
      inLineComment = true;
      continue;
    }
    if (character === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(headerIndex, index + 1);
    }
  }

  return null;
}

function requireBlock(errors, source, header, label) {
  const block = extractHclBlock(source, header);
  if (!block) errors.push(`${label}: missing ${header} block`);
  return block ?? '';
}

function requirePattern(errors, source, pattern, message) {
  if (!pattern.test(source)) errors.push(message);
}

export function validateContract(files = readContractFiles()) {
  const errors = [];
  const {
    providers,
    providerLock,
    variables,
    bootstrap,
    dockerfile,
    entrypoint,
    passiveHealth,
    appYaml,
    cloudbuild,
    cloudIgnore,
    deploy,
    preflight,
    legacySeed,
    terraformIgnore,
    tfvarsExample,
    runbook,
  } = files;

  const terraformBlock = requireBlock(
    errors,
    providers,
    'terraform',
    CONTRACT_FILES.providers,
  );
  requirePattern(
    errors,
    terraformBlock,
    /required_version\s*=\s*">=\s*1\.11"/u,
    `${CONTRACT_FILES.providers}: required_version must be >= 1.11`,
  );
  requirePattern(
    errors,
    terraformBlock,
    /source\s*=\s*"hashicorp\/google"\s+version\s*=\s*"~>\s*6\.50\.0"/u,
    `${CONTRACT_FILES.providers}: Google provider must stay constrained to 6.50.x`,
  );
  const googleLock = requireBlock(
    errors,
    providerLock,
    'provider "registry.terraform.io/hashicorp/google"',
    CONTRACT_FILES.providerLock,
  );
  requirePattern(
    errors,
    googleLock,
    /version\s*=\s*"6\.50\.0"/u,
    `${CONTRACT_FILES.providerLock}: Google provider must stay locked to 6.50.0`,
  );
  requirePattern(
    errors,
    googleLock,
    /constraints\s*=\s*"~>\s*6\.50\.0"/u,
    `${CONTRACT_FILES.providerLock}: Google provider lock must preserve the 6.50.x constraint`,
  );

  const valueVariable = requireBlock(
    errors,
    variables,
    'variable "grafana_agent_secret_values"',
    CONTRACT_FILES.variables,
  );
  requirePattern(
    errors,
    valueVariable,
    /sensitive\s*=\s*true/u,
    `${CONTRACT_FILES.variables}: grafana_agent_secret_values must be sensitive`,
  );
  requirePattern(
    errors,
    valueVariable,
    /ephemeral\s*=\s*true/u,
    `${CONTRACT_FILES.variables}: grafana_agent_secret_values must be ephemeral`,
  );
  if (/^\s*default\s*=/mu.test(valueVariable)) {
    errors.push(
      `${CONTRACT_FILES.variables}: grafana_agent_secret_values must remain a required operator input`,
    );
  }
  for (const key of ['endpoint', 'username', 'password']) {
    requirePattern(
      errors,
      valueVariable,
      new RegExp(`\\b${key}\\s*=\\s*string\\b`, 'u'),
      `${CONTRACT_FILES.variables}: grafana_agent_secret_values.${key} must be a string`,
    );
  }

  const counterVariable = requireBlock(
    errors,
    variables,
    'variable "grafana_agent_secret_rotation_counters"',
    CONTRACT_FILES.variables,
  );
  for (const key of ['endpoint', 'username', 'password']) {
    requirePattern(
      errors,
      counterVariable,
      new RegExp(`\\b${key}\\s*=\\s*number\\b`, 'u'),
      `${CONTRACT_FILES.variables}: rotation counter ${key} must be numeric`,
    );
  }
  requirePattern(
    errors,
    counterVariable,
    /counter\s*>=\s*1\s*&&\s*counter\s*==\s*floor\(counter\)/u,
    `${CONTRACT_FILES.variables}: rotation counters must reject zero, negative, and fractional values`,
  );

  const versionResource = requireBlock(
    errors,
    bootstrap,
    'resource "google_secret_manager_secret_version" "grafana_agent"',
    CONTRACT_FILES.bootstrap,
  );
  requirePattern(
    errors,
    versionResource,
    /secret\s*=\s*google_secret_manager_secret\.grafana_agent\[each\.value\]\.id/u,
    `${CONTRACT_FILES.bootstrap}: write-only versions must bind to the exact managed secret map`,
  );
  requirePattern(
    errors,
    versionResource,
    /secret_data_wo\s*=\s*var\.grafana_agent_secret_values\[each\.key\]/u,
    `${CONTRACT_FILES.bootstrap}: secret payloads must terminate at secret_data_wo`,
  );
  requirePattern(
    errors,
    versionResource,
    /secret_data_wo_version\s*=\s*var\.grafana_agent_secret_rotation_counters\[each\.key\]/u,
    `${CONTRACT_FILES.bootstrap}: every write-only value must be bound to its reviewed rotation counter`,
  );
  if (/^\s*secret_data\s*=/mu.test(versionResource)) {
    errors.push(
      `${CONTRACT_FILES.bootstrap}: state-stored secret_data is forbidden for Alloy`,
    );
  }
  requirePattern(
    errors,
    versionResource,
    /lifecycle\s*\{\s*create_before_destroy\s*=\s*true\s*\}/su,
    `${CONTRACT_FILES.bootstrap}: write-only secret rotation must create the replacement before disabling the previous version`,
  );

  const secretLocals = requireBlock(
    errors,
    bootstrap,
    'locals',
    CONTRACT_FILES.bootstrap,
  );
  const secretIdEntries = [
    ...secretLocals.matchAll(/^\s*"(grafana-agent-[^"]+)",$/gmu),
  ].map((match) => match[1]);
  const expectedSecretIdEntries = [
    'grafana-agent-endpoint',
    'grafana-agent-username',
    'grafana-agent-password',
  ];
  if (
    secretIdEntries.length !== expectedSecretIdEntries.length ||
    !expectedSecretIdEntries.every((entry) => secretIdEntries.includes(entry))
  ) {
    errors.push(
      `${CONTRACT_FILES.bootstrap}: grafana_agent_secret_ids must contain exactly endpoint, username, and password`,
    );
  }
  requirePattern(
    errors,
    secretLocals,
    /grafana_agent_secret_ids_by_key\s*=\s*\{\s*for secret_id in local\.grafana_agent_secret_ids\s*:\s*trimprefix\(secret_id, "grafana-agent-"\) => secret_id\s*\}/su,
    `${CONTRACT_FILES.bootstrap}: keyed secret IDs must derive exactly from grafana_agent_secret_ids`,
  );

  const runtimeAccount = requireBlock(
    errors,
    bootstrap,
    'resource "google_service_account" "grafana_agent_runtime"',
    CONTRACT_FILES.bootstrap,
  );
  requirePattern(
    errors,
    runtimeAccount,
    /account_id\s*=\s*"grafana-agent-runtime"/u,
    `${CONTRACT_FILES.bootstrap}: runtime service account ID must stay grafana-agent-runtime`,
  );

  const builderAccount = requireBlock(
    errors,
    bootstrap,
    'resource "google_service_account" "grafana_agent_builder"',
    CONTRACT_FILES.bootstrap,
  );
  requirePattern(
    errors,
    builderAccount,
    /account_id\s*=\s*"grafana-agent-builder"/u,
    `${CONTRACT_FILES.bootstrap}: builder service account ID must stay grafana-agent-builder`,
  );

  const runtimeAccessor = requireBlock(
    errors,
    bootstrap,
    'resource "google_secret_manager_secret_iam_member" "grafana_agent_runtime_accessor"',
    CONTRACT_FILES.bootstrap,
  );
  requirePattern(
    errors,
    runtimeAccessor,
    /for_each\s*=\s*local\.grafana_agent_secret_ids_by_key/u,
    `${CONTRACT_FILES.bootstrap}: runtime access must cover exactly the three managed Alloy secrets`,
  );
  requirePattern(
    errors,
    runtimeAccessor,
    /secret_id\s*=\s*google_secret_manager_secret\.grafana_agent\[each\.value\]\.secret_id/u,
    `${CONTRACT_FILES.bootstrap}: runtime access must depend on each exact managed Alloy secret resource`,
  );
  requirePattern(
    errors,
    runtimeAccessor,
    /role\s*=\s*"roles\/secretmanager\.secretAccessor"/u,
    `${CONTRACT_FILES.bootstrap}: runtime secret grants must use Secret Accessor`,
  );
  requirePattern(
    errors,
    runtimeAccessor,
    /member\s*=\s*"serviceAccount:\$\{google_service_account\.grafana_agent_runtime\.email\}"/u,
    `${CONTRACT_FILES.bootstrap}: secret grants must target the dedicated runtime account`,
  );
  const runtimeSecretGrantHeaders = [
    ...bootstrap.matchAll(
      /resource "google_secret_manager_secret_iam_member" "[^"]+"/gu,
    ),
  ].filter((match) => {
    const block = extractHclBlock(bootstrap, match[0]) ?? '';
    return (
      block.includes('google_service_account.grafana_agent_runtime') ||
      block.includes(EXPECTED_RUNTIME_EMAIL)
    );
  });
  if (
    runtimeSecretGrantHeaders.length !== 1 ||
    !runtimeSecretGrantHeaders[0]?.[0].endsWith(
      '"grafana_agent_runtime_accessor"',
    )
  ) {
    errors.push(
      `${CONTRACT_FILES.bootstrap}: runtime account must receive only the exact managed Alloy secret grants`,
    );
  }
  const projectIamHeaders = [
    ...bootstrap.matchAll(/resource "google_project_iam_member" "[^"]+"/gu),
  ];
  const runtimeProjectGrants = projectIamHeaders.filter((match) => {
    const block = extractHclBlock(bootstrap, match[0]) ?? '';
    return (
      block.includes('google_service_account.grafana_agent_runtime') ||
      block.includes(EXPECTED_RUNTIME_EMAIL)
    );
  });
  const runtimeProjectGrantNames = runtimeProjectGrants.map(
    (match) => match[0],
  );
  const expectedRuntimeProjectGrantNames = [
    'resource "google_project_iam_member" "grafana_agent_runtime_activation_reader"',
    'resource "google_project_iam_member" "grafana_agent_runtime_log_writer"',
  ];
  if (
    runtimeProjectGrantNames.length !==
      expectedRuntimeProjectGrantNames.length ||
    !expectedRuntimeProjectGrantNames.every((name) =>
      runtimeProjectGrantNames.includes(name),
    )
  ) {
    errors.push(
      `${CONTRACT_FILES.bootstrap}: runtime project access must contain only the activation reader and App Engine Flex Logs Writer grants`,
    );
  }

  const activationRole = requireBlock(
    errors,
    bootstrap,
    'resource "google_project_iam_custom_role" "grafana_agent_activation_reader"',
    CONTRACT_FILES.bootstrap,
  );
  requirePattern(
    errors,
    activationRole,
    /role_id\s*=\s*"grafanaAgentActivationReader"/u,
    `${CONTRACT_FILES.bootstrap}: activation reader role ID must remain exact`,
  );
  requirePattern(
    errors,
    activationRole,
    /depends_on\s*=\s*\[\s*google_project_service\.appengineflex,\s*google_project_service\.iam,\s*\]/u,
    `${CONTRACT_FILES.bootstrap}: activation reader role must wait for App Engine Flex and IAM APIs`,
  );
  const activationPermissions = [
    ...activationRole.matchAll(/"(appengine\.[^"]+)"/gu),
  ].map((match) => match[1]);
  const expectedActivationPermissions = [
    'appengine.services.get',
    'appengine.versions.list',
  ];
  if (
    activationPermissions.length !== expectedActivationPermissions.length ||
    !expectedActivationPermissions.every((permission) =>
      activationPermissions.includes(permission),
    )
  ) {
    errors.push(
      `${CONTRACT_FILES.bootstrap}: activation reader must contain only services.get and versions.list`,
    );
  }
  const runtimeActivationGrant = requireBlock(
    errors,
    bootstrap,
    'resource "google_project_iam_member" "grafana_agent_runtime_activation_reader"',
    CONTRACT_FILES.bootstrap,
  );
  requirePattern(
    errors,
    runtimeActivationGrant,
    /role\s*=\s*google_project_iam_custom_role\.grafana_agent_activation_reader\.name/u,
    `${CONTRACT_FILES.bootstrap}: runtime activation grant must use the exact custom role`,
  );
  const runtimeLogWriterGrant = requireBlock(
    errors,
    bootstrap,
    'resource "google_project_iam_member" "grafana_agent_runtime_log_writer"',
    CONTRACT_FILES.bootstrap,
  );
  requirePattern(
    errors,
    runtimeLogWriterGrant,
    /role\s*=\s*"roles\/logging\.logWriter"/u,
    `${CONTRACT_FILES.bootstrap}: App Engine Flex runtime must have only Logs Writer as its predefined project role`,
  );
  requirePattern(
    errors,
    runtimeLogWriterGrant,
    /member\s*=\s*"serviceAccount:\$\{google_service_account\.grafana_agent_runtime\.email\}"/u,
    `${CONTRACT_FILES.bootstrap}: Logs Writer must target the dedicated runtime account`,
  );

  const preflightRole = requireBlock(
    errors,
    bootstrap,
    'resource "google_project_iam_custom_role" "grafana_agent_preflight_reader"',
    CONTRACT_FILES.bootstrap,
  );
  requirePattern(
    errors,
    preflightRole,
    /role_id\s*=\s*"grafanaAgentPreflightReader"/u,
    `${CONTRACT_FILES.bootstrap}: operator preflight reader role ID must remain exact`,
  );
  requirePattern(
    errors,
    preflightRole,
    /description\s*=\s*"Alloy metadata preflight\. operator-set-sha256=\$\{sha256\(jsonencode\(sort\(distinct\(var\.gcp_dev_members\)\)\)\)\}"/u,
    `${CONTRACT_FILES.bootstrap}: operator preflight role must carry the Terraform member-set fingerprint`,
  );
  const preflightPermissions = [
    ...preflightRole.matchAll(/"([a-z]+\.[^"]+)"/gu),
  ].map((match) => match[1]);
  const expectedPreflightPermissions = [
    'appengine.applications.get',
    'appengine.services.get',
    'appengine.versions.get',
    'iam.roles.get',
    'iam.serviceAccounts.get',
    'iam.serviceAccounts.getIamPolicy',
    'resourcemanager.projects.get',
    'resourcemanager.projects.getIamPolicy',
    'secretmanager.secrets.getIamPolicy',
    'secretmanager.secrets.list',
    'secretmanager.versions.get',
  ];
  if (
    preflightPermissions.length !== expectedPreflightPermissions.length ||
    !expectedPreflightPermissions.every((permission) =>
      preflightPermissions.includes(permission),
    )
  ) {
    errors.push(
      `${CONTRACT_FILES.bootstrap}: operator preflight reader must contain only the exact metadata permissions`,
    );
  }
  const operatorPreflightGrant = requireBlock(
    errors,
    bootstrap,
    'resource "google_project_iam_member" "grafana_agent_operator_preflight_reader"',
    CONTRACT_FILES.bootstrap,
  );
  requirePattern(
    errors,
    operatorPreflightGrant,
    /for_each\s*=\s*toset\(var\.gcp_dev_members\)/u,
    `${CONTRACT_FILES.bootstrap}: operator preflight readers must stay scoped to gcp_dev_members`,
  );
  requirePattern(
    errors,
    operatorPreflightGrant,
    /role\s*=\s*google_project_iam_custom_role\.grafana_agent_preflight_reader\.name/u,
    `${CONTRACT_FILES.bootstrap}: operator preflight grant must use the exact custom role`,
  );
  requirePattern(
    errors,
    operatorPreflightGrant,
    /member\s*=\s*each\.value/u,
    `${CONTRACT_FILES.bootstrap}: operator preflight grant must target each configured member`,
  );

  const deployerActAs = requireBlock(
    errors,
    bootstrap,
    'resource "google_service_account_iam_member" "grafana_agent_cloudbuild_runtime_service_account_user"',
    CONTRACT_FILES.bootstrap,
  );
  requirePattern(
    errors,
    deployerActAs,
    /service_account_id\s*=\s*google_service_account\.grafana_agent_runtime\.name/u,
    `${CONTRACT_FILES.bootstrap}: deployer actAs must be scoped to the runtime account`,
  );
  requirePattern(
    errors,
    deployerActAs,
    /role\s*=\s*"roles\/iam\.serviceAccountUser"/u,
    `${CONTRACT_FILES.bootstrap}: deployer must receive only serviceAccountUser on the runtime account`,
  );
  requirePattern(
    errors,
    deployerActAs,
    /member\s*=\s*"serviceAccount:\$\{google_service_account\.grafana_agent_builder\.email\}"/u,
    `${CONTRACT_FILES.bootstrap}: only the dedicated builder may act as the runtime account`,
  );

  const builderSubmitter = requireBlock(
    errors,
    bootstrap,
    'resource "google_service_account_iam_member" "grafana_agent_builder_submitter"',
    CONTRACT_FILES.bootstrap,
  );
  requirePattern(
    errors,
    builderSubmitter,
    /for_each\s*=\s*toset\(var\.gcp_dev_members\)/u,
    `${CONTRACT_FILES.bootstrap}: builder submitters must stay scoped to gcp_dev_members`,
  );
  requirePattern(
    errors,
    builderSubmitter,
    /service_account_id\s*=\s*google_service_account\.grafana_agent_builder\.name/u,
    `${CONTRACT_FILES.bootstrap}: submitter impersonation must target the dedicated builder`,
  );
  requirePattern(
    errors,
    builderSubmitter,
    /role\s*=\s*"roles\/iam\.serviceAccountUser"\s+member\s*=\s*each\.value/u,
    `${CONTRACT_FILES.bootstrap}: builder submitters must receive only serviceAccountUser`,
  );
  if (
    bootstrap.includes(
      'grafana_agent_cloudbuild_appengine_default_service_account_user',
    )
  ) {
    errors.push(
      `${CONTRACT_FILES.bootstrap}: default Cloud Build identities must not act as the App Engine runtime`,
    );
  }

  for (const legacyResource of [
    'grafana_agent_cloudbuild_accessor',
    'grafana_agent_cloudbuild_compute_accessor',
    'grafana_agent_appspot_accessor',
  ]) {
    requireBlock(
      errors,
      bootstrap,
      `resource "google_secret_manager_secret_iam_member" "${legacyResource}"`,
      CONTRACT_FILES.bootstrap,
    );
  }
  requirePattern(
    errors,
    bootstrap,
    /Phase A rollback only/u,
    `${CONTRACT_FILES.bootstrap}: retained legacy access must be marked Phase A rollback only`,
  );

  requirePattern(
    errors,
    appYaml,
    new RegExp(
      `^service_account:\\s*${EXPECTED_RUNTIME_EMAIL.replaceAll('.', '\\.')}$`,
      'mu',
    ),
    `${CONTRACT_FILES.appYaml}: service_account must pin ${EXPECTED_RUNTIME_EMAIL}`,
  );
  requirePattern(
    errors,
    appYaml,
    /manual_scaling:\s*\n\s+instances:\s*1/u,
    `${CONTRACT_FILES.appYaml}: the active/passive contract assumes one manual-scaling instance`,
  );
  requirePattern(
    errors,
    dockerfile,
    /apt-get install -y --no-install-recommends jq curl ca-certificates socat/u,
    `${CONTRACT_FILES.dockerfile}: passive mode requires the pinned socat listener`,
  );
  requirePattern(
    errors,
    dockerfile,
    /COPY --chown=agent:agent passive-health\.sh \/usr\/local\/bin\/passive-health\.sh/u,
    `${CONTRACT_FILES.dockerfile}: passive health handler must enter the runtime image`,
  );
  requirePattern(
    errors,
    entrypoint,
    /ACTIVE_GRACE_POLLS=3/u,
    `${CONTRACT_FILES.entrypoint}: activation must require a grace handshake`,
  );
  requirePattern(
    errors,
    entrypoint,
    /\.split\.allocations\[\$version\] == 1/u,
    `${CONTRACT_FILES.entrypoint}: Alloy must activate only at the full traffic allocation`,
  );
  requirePattern(
    errors,
    entrypoint,
    /select\(\.id != \$version and \.servingStatus != "STOPPED"\).*length == 0/su,
    `${CONTRACT_FILES.entrypoint}: Alloy must stay passive until every other version is stopped`,
  );
  requirePattern(
    errors,
    entrypoint,
    /versions_url="\$\{versions_url\}&pageToken=\$\{encoded_page_token\}"[\s\S]*next_page_token=.*\.nextPageToken[\s\S]*\[ -z "\$\{next_page_token\}" \] && break/su,
    `${CONTRACT_FILES.entrypoint}: activation must follow every version-inventory page`,
  );
  requirePattern(
    errors,
    entrypoint,
    /seen_page_tokens='\[\]'[\s\S]*index\(\$token\) != null[\s\S]*version inventory repeated a page token/su,
    `${CONTRACT_FILES.entrypoint}: activation must reject repeated version page tokens`,
  );
  requirePattern(
    errors,
    entrypoint,
    /if activation_is_safe; then[\s\S]*active_observations[\s\S]*start_alloy[\s\S]*else[\s\S]*active_observations=0[\s\S]*stop_alloy/su,
    `${CONTRACT_FILES.entrypoint}: supervisor must activate and deactivate Alloy from the fail-closed handshake`,
  );
  requirePattern(
    errors,
    passiveHealth,
    /\/_ah\/health \| \/_ah\/warmup[\s\S]*200 OK[\s\S]*\/-\/healthy\)[\s\S]*collector-passive[\s\S]*503 Service Unavailable/su,
    `${CONTRACT_FILES.passiveHealth}: passive mode must distinguish container health from active collector health`,
  );
  requirePattern(
    errors,
    cloudbuild,
    /--version=\$\{_VERSION\}/u,
    `${CONTRACT_FILES.cloudbuild}: deploy must use the caller-provided version ID`,
  );
  requirePattern(
    errors,
    cloudbuild,
    /--no-promote/u,
    `${CONTRACT_FILES.cloudbuild}: build must create a zero-traffic version`,
  );
  requirePattern(
    errors,
    cloudbuild,
    new RegExp(
      `^serviceAccount:\\s*projects/mento-monitoring/serviceAccounts/${EXPECTED_BUILDER_EMAIL.replaceAll('.', '\\.')}$`,
      'mu',
    ),
    `${CONTRACT_FILES.cloudbuild}: build must pin ${EXPECTED_BUILDER_EMAIL}`,
  );
  requirePattern(
    errors,
    cloudbuild,
    /^options:\s*\n\s+logging:\s+CLOUD_LOGGING_ONLY$/mu,
    `${CONTRACT_FILES.cloudbuild}: a user-specified builder must log through Cloud Logging`,
  );
  if (/(?:^|[\s,])--promote(?:[\s,]|$)/mu.test(cloudbuild)) {
    errors.push(
      `${CONTRACT_FILES.cloudbuild}: build must not promote before live identity verification`,
    );
  }
  const cloudIgnoreRules = cloudIgnore
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const expectedCloudIgnoreRules = [
    '**',
    '!Dockerfile',
    '!config.alloy',
    '!entrypoint.sh',
    '!grafana-agent.yaml',
    '!passive-health.sh',
  ];
  if (
    cloudIgnoreRules.length !== expectedCloudIgnoreRules.length ||
    !expectedCloudIgnoreRules.every(
      (rule, index) => cloudIgnoreRules[index] === rule,
    )
  ) {
    errors.push(
      `${CONTRACT_FILES.cloudIgnore}: Cloud Build upload must allow only the five audited runtime files`,
    );
  }
  requirePattern(
    errors,
    deploy,
    /assert_current_main "\$repo_root"/u,
    `${CONTRACT_FILES.deploy}: deploy must require current main before mutation`,
  );
  requirePattern(
    errors,
    deploy,
    /git -C "\$root" fetch --quiet origin/u,
    `${CONTRACT_FILES.deploy}: deploy must refresh origin/main before mutation`,
  );
  requirePattern(
    errors,
    deploy,
    /node "\$agent_dir\/preflight\.mjs" --project "\$project"/u,
    `${CONTRACT_FILES.deploy}: deploy must run the live preflight before mutation`,
  );
  requirePattern(
    errors,
    preflight,
    /const expectedBuildSubmitters = membersForRole\(\s*projectPolicy,\s*preflightRoleName,\s*\)[\s\S]*assertExactRolePolicy\(\s*builderPolicy,\s*'roles\/iam\.serviceAccountUser',\s*expectedBuildSubmitters,[\s\S]*assertOperatorSetFingerprint\(preflightRole, expectedBuildSubmitters\)/u,
    `${CONTRACT_FILES.preflight}: both submitter policies must derive from and match the Terraform member-set fingerprint`,
  );
  if (
    preflight.includes('EXPECTED_BUILD_SUBMITTERS') ||
    preflight.includes("['group:eng@mentolabs.xyz']")
  ) {
    errors.push(
      `${CONTRACT_FILES.preflight}: operator membership must not be pinned to the default gcp_dev_members value`,
    );
  }
  requirePattern(
    errors,
    deploy,
    /node "\$verifier_root\/aegis\/grafana-agent\/preflight\.mjs"[\s\\]+--project "\$project"[\s\\]+--version "\$version"/u,
    `${CONTRACT_FILES.deploy}: deploy must run post-build verification from the immutable verifier snapshot`,
  );
  requirePattern(
    errors,
    deploy,
    /materialize_source_snapshot "\$repo_root" "\$source_head" "\$snapshot_root"/u,
    `${CONTRACT_FILES.deploy}: deploy must materialize an immutable snapshot of the verified commit`,
  );
  requirePattern(
    errors,
    deploy,
    /materialize_verifier_snapshot "\$repo_root" "\$source_head" "\$verifier_root"/u,
    `${CONTRACT_FILES.deploy}: deploy must capture committed verifier code and contract inputs`,
  );
  requirePattern(
    errors,
    deploy,
    /--config "\$snapshot_root\/cloudbuild\.yaml"[\s\\]+--substitutions "_VERSION=\$version"[\s\\]+"\$snapshot_source_dir"/u,
    `${CONTRACT_FILES.deploy}: Cloud Build must submit only the immutable snapshot`,
  );
  const buildSubmission =
    deploy.match(/gcloud builds submit[\s\S]*?\n\n/u)?.[0] ?? '';
  if (
    /(?:"\$agent_dir"|"\$repo_root"|(?:^|\s)\.(?:\s|$))/mu.test(buildSubmission)
  ) {
    errors.push(
      `${CONTRACT_FILES.deploy}: Cloud Build must not submit the mutable live checkout`,
    );
  }
  const confirmationIndex = deploy.indexOf(
    `read -r -p "Type 'deploy' to submit this production build: " confirmation`,
  );
  const finalSourceCheck = 'assert_source_ready "$repo_root" "$source_head"';
  const finalSourceCheckIndex = deploy.indexOf(finalSourceCheck);
  const snapshotIndex = deploy.indexOf(
    'materialize_source_snapshot "$repo_root" "$source_head" "$snapshot_root"',
  );
  const buildSubmissionIndex = deploy.indexOf('gcloud builds submit');
  const hostnameLookupIndex = deploy.indexOf('if ! default_hostname="$(');
  if (
    confirmationIndex === -1 ||
    finalSourceCheckIndex === -1 ||
    snapshotIndex === -1 ||
    hostnameLookupIndex === -1 ||
    buildSubmissionIndex === -1 ||
    confirmationIndex > finalSourceCheckIndex ||
    finalSourceCheckIndex > snapshotIndex ||
    snapshotIndex > hostnameLookupIndex ||
    hostnameLookupIndex > buildSubmissionIndex
  ) {
    errors.push(
      `${CONTRACT_FILES.deploy}: clean current-main source identity and hostname must be resolved before Cloud Build submission`,
    );
  }
  const currentMainIndex = deploy.indexOf('assert_current_main "$repo_root"');
  const mainIndex = deploy.indexOf('\nmain() {');
  const firstGcloudIndex = deploy.indexOf(
    'gcloud app versions list',
    mainIndex,
  );
  if (
    currentMainIndex === -1 ||
    firstGcloudIndex === -1 ||
    currentMainIndex > firstGcloudIndex
  ) {
    errors.push(
      `${CONTRACT_FILES.deploy}: current-main check must run before any gcloud call`,
    );
  }
  const versionVerification =
    'node "$verifier_root/aegis/grafana-agent/preflight.mjs"';
  const versionVerificationIndex = deploy.indexOf(versionVerification);
  const failedBuildCleanupIndex = deploy.indexOf(
    'cleanup_unpromoted_target "$version"',
    buildSubmissionIndex,
  );
  const failedVerificationCleanupIndex = deploy.indexOf(
    'cleanup_unpromoted_target "$version"',
    versionVerificationIndex,
  );
  const promotionIndex = deploy.indexOf(
    'gcloud app services set-traffic grafana-agent \\\n' +
      '    --project "$project" \\\n' +
      '    --splits "${version}=1"',
  );
  if (
    versionVerificationIndex === -1 ||
    failedBuildCleanupIndex === -1 ||
    failedVerificationCleanupIndex === -1 ||
    promotionIndex === -1 ||
    buildSubmissionIndex > failedBuildCleanupIndex ||
    failedBuildCleanupIndex > versionVerificationIndex ||
    versionVerificationIndex > failedVerificationCleanupIndex ||
    failedVerificationCleanupIndex > promotionIndex
  ) {
    errors.push(
      `${CONTRACT_FILES.deploy}: failed build or version verification must stop the passive target before traffic promotion`,
    );
  }
  const cleanupTarget = requireBlock(
    errors,
    deploy,
    'cleanup_unpromoted_target()',
    CONTRACT_FILES.deploy,
  );
  requirePattern(
    errors,
    cleanupTarget,
    /stop_and_prove_version "\$version"[\s\S]*print_manual_stop_commands "\$version"[\s\S]*return 1/u,
    `${CONTRACT_FILES.deploy}: unpromoted target cleanup must prove STOPPED or print fail-closed manual cleanup`,
  );
  const retireIndex = deploy.indexOf('stop_other_collectors "$version"');
  const healthIndex = deploy.indexOf(
    'wait_for_collector_health "$service_url"',
  );
  if (
    retireIndex === -1 ||
    healthIndex === -1 ||
    promotionIndex > retireIndex ||
    retireIndex > healthIndex
  ) {
    errors.push(
      `${CONTRACT_FILES.deploy}: stop-before-start activation must retire every prior collector before health verification`,
    );
  }
  if (/set-traffic grafana-agent[\s\S]{0,180}--migrate/u.test(deploy)) {
    errors.push(
      `${CONTRACT_FILES.deploy}: collector cutover must use an atomic 100% split without --migrate`,
    );
  }
  requirePattern(
    errors,
    deploy,
    /if ! other_versions="\$\([\s\S]*gcloud app versions list[\s\S]*\)"; then[\s\S]*return 1[\s\S]*fi/u,
    `${CONTRACT_FILES.deploy}: serving-version inventory failure must return before collector retirement`,
  );
  requirePattern(
    errors,
    deploy,
    /body=.*curl[\s\S]*if \[\[ "\$body" != "collector-passive" \]\]/u,
    `${CONTRACT_FILES.deploy}: activation proof must reject the passive health sentinel`,
  );
  const stoppedProof = requireBlock(
    errors,
    deploy,
    'version_is_stopped()',
    CONTRACT_FILES.deploy,
  );
  requirePattern(
    errors,
    stoppedProof,
    /if ! status="\$\([\s\S]*gcloud app versions describe "\$version"[\s\S]*\)"; then[\s\S]*return 1[\s\S]*\[\[ "\$status" == "STOPPED" \]\]/u,
    `${CONTRACT_FILES.deploy}: STOPPED proof must preserve describe failure status before comparing output`,
  );
  const rollback = requireBlock(
    errors,
    deploy,
    'rollback_cutover()',
    CONTRACT_FILES.deploy,
  );
  const rollbackStopIndex = rollback.indexOf(
    'gcloud app versions stop "$target_version"',
  );
  const rollbackVerifyIndex = rollback.indexOf(
    'version_is_stopped "$target_version"',
  );
  const rollbackPeersIndex = rollback.indexOf(
    'stop_other_collectors "$previous_version"',
  );
  const rollbackStartIndex = rollback.indexOf(
    'gcloud app versions start "$previous_version"',
  );
  if (
    rollbackStopIndex === -1 ||
    rollbackVerifyIndex === -1 ||
    rollbackPeersIndex === -1 ||
    rollbackStartIndex === -1 ||
    rollbackStopIndex > rollbackVerifyIndex ||
    rollbackVerifyIndex > rollbackPeersIndex ||
    rollbackPeersIndex > rollbackStartIndex
  ) {
    errors.push(
      `${CONTRACT_FILES.deploy}: rollback must prove the target and every other peer stopped before restarting the previous collector`,
    );
  }
  const manualRollback = requireBlock(
    errors,
    deploy,
    'print_manual_rollback_commands()',
    CONTRACT_FILES.deploy,
  );
  const manualStopIndex = manualRollback.indexOf(
    'gcloud app versions stop $target_version',
  );
  const manualDescribeIndex = manualRollback.indexOf(
    'gcloud app versions describe $target_version',
  );
  const manualVerifyIndex = manualRollback.indexOf(
    'test \\"\\$serving_status\\" = STOPPED',
  );
  const manualPeerListIndex = manualRollback.indexOf(
    'gcloud app versions list',
  );
  const manualPeerStopIndex = manualRollback.indexOf(
    'gcloud app versions stop \\"\\$peer_version\\"',
  );
  const manualPeerDescribeIndex = manualRollback.indexOf(
    'gcloud app versions describe \\"\\$peer_version\\"',
  );
  const manualPeerVerifyIndex = manualRollback.indexOf(
    'test \\"\\$peer_status\\" = STOPPED',
  );
  const manualStartIndex = manualRollback.indexOf(
    'gcloud app versions start $previous_version',
  );
  const manualTrafficIndex = manualRollback.indexOf(
    'gcloud app services set-traffic grafana-agent',
  );
  if (
    manualStopIndex === -1 ||
    manualDescribeIndex === -1 ||
    manualVerifyIndex === -1 ||
    manualPeerListIndex === -1 ||
    manualPeerStopIndex === -1 ||
    manualPeerDescribeIndex === -1 ||
    manualPeerVerifyIndex === -1 ||
    manualStartIndex === -1 ||
    manualTrafficIndex === -1 ||
    manualStopIndex > manualDescribeIndex ||
    manualDescribeIndex > manualVerifyIndex ||
    manualVerifyIndex > manualPeerListIndex ||
    manualPeerListIndex > manualPeerStopIndex ||
    manualPeerStopIndex > manualPeerDescribeIndex ||
    manualPeerDescribeIndex > manualPeerVerifyIndex ||
    manualPeerVerifyIndex > manualStartIndex ||
    manualStartIndex > manualTrafficIndex ||
    (manualRollback.match(/&& \\\\/gu) ?? []).length !== 8
  ) {
    errors.push(
      `${CONTRACT_FILES.deploy}: printed rollback must short-circuit target and peer STOPPED proofs before previous start and atomic traffic assignment`,
    );
  }
  const plannedManualRollbackCalls =
    deploy.match(
      /print_manual_rollback_commands "\$previous_version" "\$version"/gu,
    ) ?? [];
  requirePattern(
    errors,
    deploy,
    /print_manual_rollback_commands "\$previous_version" "\$target_version"/u,
    `${CONTRACT_FILES.deploy}: failed rollback must print target-aware stop-before-start recovery`,
  );
  if (plannedManualRollbackCalls.length !== 2) {
    errors.push(
      `${CONTRACT_FILES.deploy}: predeploy and post-success output must print target-aware stop-before-start rollback`,
    );
  }
  requirePattern(
    errors,
    legacySeed,
    /LEGACY PHASE A ROLLBACK ARTIFACT/u,
    `${CONTRACT_FILES.legacySeed}: legacy seed route must stay explicitly marked for Phase A rollback`,
  );
  requirePattern(
    errors,
    legacySeed,
    /gcloud secrets versions add/u,
    `${CONTRACT_FILES.legacySeed}: Phase A must retain the legacy rollback route`,
  );
  requirePattern(
    errors,
    terraformIgnore,
    /^terraform\.tfvars$/mu,
    `${CONTRACT_FILES.terraformIgnore}: terraform.tfvars must stay ignored`,
  );
  requirePattern(
    errors,
    terraformIgnore,
    /^\*\.auto\.tfvars$/mu,
    `${CONTRACT_FILES.terraformIgnore}: auto-loaded *.auto.tfvars files must stay ignored`,
  );
  requirePattern(
    errors,
    tfvarsExample,
    /gitignored `terraform\.tfvars` or an `\*\.auto\.tfvars` file/u,
    `${CONTRACT_FILES.tfvarsExample}: secret input guidance must name only auto-loaded ignored files`,
  );
  requirePattern(
    errors,
    runbook,
    /gitignored\s+`terraform\/terraform\.tfvars`, a gitignored `terraform\/\*\.auto\.tfvars` file/u,
    `${CONTRACT_FILES.runbook}: runbook must name the exact ignored secret input files`,
  );

  return errors;
}

function main() {
  const errors = validateContract();
  if (errors.length > 0) {
    for (const error of errors) console.error(`contract: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Alloy Terraform/runtime contract check passed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
