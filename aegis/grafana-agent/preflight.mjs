import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateContract } from './contract.mjs';

const SECRET_IDS = [
  'grafana-agent-endpoint',
  'grafana-agent-username',
  'grafana-agent-password',
];
const EXPECTED_PROJECT = 'mento-monitoring';
const BUILDER_PROJECT_ROLES = [
  'roles/appengine.deployer',
  'roles/artifactregistry.writer',
  'roles/cloudbuild.builds.editor',
  'roles/logging.logWriter',
  'roles/storage.objectAdmin',
];
const RUNTIME_PROJECT_ROLES = ['roles/logging.logWriter'];
const IMAGE_REPOSITORY = 'us.gcr.io';
const IMAGE_REPOSITORY_LOCATION = 'us';
const RUNTIME_IMAGE_ROLES = ['roles/artifactregistry.reader'];
const ACTIVATION_ROLE_ID = 'grafanaAgentActivationReader';
const ACTIVATION_PERMISSIONS = [
  'appengine.services.get',
  'appengine.versions.list',
];
const PREFLIGHT_ROLE_ID = 'grafanaAgentPreflightReader';
const PREFLIGHT_PERMISSIONS = [
  'appengine.applications.get',
  'appengine.services.get',
  'appengine.versions.get',
  'artifactregistry.repositories.getIamPolicy',
  'iam.roles.get',
  'iam.serviceAccounts.get',
  'iam.serviceAccounts.getIamPolicy',
  'resourcemanager.projects.get',
  'resourcemanager.projects.getIamPolicy',
  'secretmanager.secrets.getIamPolicy',
  'secretmanager.secrets.list',
  'secretmanager.versions.get',
];

function parseArgs(argv) {
  const options = {
    project: process.env.GCP_PROJECT || 'mento-monitoring',
    staticOnly: false,
    version: '',
    versionTraffic: 'zero',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    } else if (argument === '--static-only') {
      options.staticOnly = true;
    } else if (argument === '--project' && argv[index + 1]) {
      options.project = argv[++index];
    } else if (argument === '--version' && argv[index + 1]) {
      options.version = argv[++index];
    } else if (argument === '--version-traffic' && argv[index + 1]) {
      options.versionTraffic = argv[++index];
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }

  if (!['zero', 'full'].includes(options.versionTraffic)) {
    throw new Error('--version-traffic must be zero or full');
  }
  if (options.versionTraffic !== 'zero' && !options.version) {
    throw new Error('--version-traffic requires --version');
  }

  return options;
}

function defaultGcloud(args) {
  const output = execFileSync('gcloud', [...args, '--format=json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output || 'null');
}

function collectBindings(value, bindings = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectBindings(item, bindings);
  } else if (value && typeof value === 'object') {
    const members = Array.isArray(value.members)
      ? value.members
      : typeof value.members === 'string'
        ? [value.members]
        : null;
    if (typeof value.role === 'string' && members) {
      bindings.push({ ...value, members });
    }
    for (const nested of Object.values(value))
      collectBindings(nested, bindings);
  }
  return bindings;
}

function rolesForMember(policy, member) {
  return [
    ...new Set(
      collectBindings(policy)
        .filter((binding) => binding.members.includes(member))
        .map((binding) => binding.role),
    ),
  ].sort();
}

function assertExactRolePolicy(policy, role, expectedMembers, label) {
  const bindings = collectBindings(policy);
  const unexpectedRoles = [
    ...new Set(
      bindings
        .map((binding) => binding.role)
        .filter((bindingRole) => bindingRole !== role),
    ),
  ].sort();
  if (unexpectedRoles.length > 0) {
    throw new Error(
      `${label} has unexpected inbound roles: ${unexpectedRoles.join(', ')}`,
    );
  }

  const conditionalBindings = bindings.filter(
    (binding) => binding.role === role && binding.condition != null,
  );
  if (conditionalBindings.length > 0) {
    throw new Error(`${label} must be unconditional`);
  }

  const actualMembers = [
    ...new Set(
      bindings
        .filter((binding) => binding.role === role)
        .flatMap((binding) => binding.members),
    ),
  ].sort();
  const expected = [...expectedMembers].sort();
  if (
    actualMembers.length !== expected.length ||
    !expected.every((member, index) => actualMembers[index] === member)
  ) {
    throw new Error(
      `${label} members must match the exact expected identities; found ${actualMembers.join(', ') || 'none'}`,
    );
  }
}

function assertExactProjectRoles(policy, member, expectedRoles, label) {
  const actual = rolesForMember(policy, member);
  const expected = [...expectedRoles].sort();
  if (
    actual.length !== expected.length ||
    !expected.every((role, index) => actual[index] === role)
  ) {
    throw new Error(
      `${label} project roles must match the least-privilege contract; found ${actual.join(', ') || 'none'}`,
    );
  }
}

function assertExactUnconditionalRoles(policy, member, expectedRoles, label) {
  const memberBindings = collectBindings(policy).filter((binding) =>
    binding.members.includes(member),
  );
  const conditionalRoles = memberBindings
    .filter((binding) => binding.condition != null)
    .map((binding) => binding.role)
    .sort();
  if (conditionalRoles.length > 0) {
    throw new Error(
      `${label} must be unconditional; found conditions on ${conditionalRoles.join(', ')}`,
    );
  }
  assertExactValues(
    memberBindings.map((binding) => binding.role),
    expectedRoles,
    label,
  );
}

function membersForRole(policy, role) {
  return [
    ...new Set(
      collectBindings(policy)
        .filter((binding) => binding.role === role)
        .flatMap((binding) => binding.members),
    ),
  ].sort();
}

function memberSetFingerprint(members) {
  const canonicalMembers = JSON.stringify([...new Set(members)].sort()).replace(
    /[<>&\u2028\u2029]/gu,
    (character) =>
      ({
        '<': '\\u003c',
        '>': '\\u003e',
        '&': '\\u0026',
        '\u2028': '\\u2028',
        '\u2029': '\\u2029',
      })[character],
  );
  return createHash('sha256').update(canonicalMembers).digest('hex');
}

function assertOperatorSetFingerprint(role, members) {
  const match = String(role?.description ?? '').match(
    /(?:^|\s)operator-set-sha256=([0-9a-f]{64})(?:\s|$)/u,
  );
  if (!match || match[1] !== memberSetFingerprint(members)) {
    throw new Error(
      'operator preflight reader members must match the Terraform configuration fingerprint',
    );
  }
}

function assertExactValues(actualValues, expectedValues, label) {
  const actual = [...new Set(actualValues ?? [])].sort();
  const expected = [...expectedValues].sort();
  if (
    actual.length !== expected.length ||
    !expected.every((value, index) => actual[index] === value)
  ) {
    throw new Error(
      `${label} must match the least-privilege contract; found ${actual.join(', ') || 'none'}`,
    );
  }
}

export function runPreflight({
  project = EXPECTED_PROJECT,
  version = '',
  versionTraffic = 'zero',
  staticOnly = false,
  runGcloud = defaultGcloud,
  validateStatic = validateContract,
  write = (message) => console.log(message),
} = {}) {
  if (project !== EXPECTED_PROJECT) {
    throw new Error(
      `project must be ${EXPECTED_PROJECT}; refusing cross-project preflight`,
    );
  }
  if (!['zero', 'full'].includes(versionTraffic)) {
    throw new Error('versionTraffic must be zero or full');
  }
  if (versionTraffic !== 'zero' && !version) {
    throw new Error('versionTraffic requires a version');
  }
  const contractErrors = validateStatic();
  if (contractErrors.length > 0) {
    throw new Error(`static contract failed: ${contractErrors.join('; ')}`);
  }
  if (staticOnly) {
    write('Alloy static preflight passed.');
    return;
  }

  const runtimeEmail = `grafana-agent-runtime@${project}.iam.gserviceaccount.com`;
  const runtimeMember = `serviceAccount:${runtimeEmail}`;
  const builderEmail = `grafana-agent-builder@${project}.iam.gserviceaccount.com`;
  const builderMember = `serviceAccount:${builderEmail}`;

  for (const [label, email] of [
    ['runtime', runtimeEmail],
    ['builder', builderEmail],
  ]) {
    const account = runGcloud([
      'iam',
      'service-accounts',
      'describe',
      email,
      '--project',
      project,
    ]);
    if (account?.email !== email) {
      throw new Error(`${label} service account does not match ${email}`);
    }
  }

  const runtimePolicy = runGcloud([
    'iam',
    'service-accounts',
    'get-iam-policy',
    runtimeEmail,
    '--project',
    project,
  ]);
  assertExactRolePolicy(
    runtimePolicy,
    'roles/iam.serviceAccountUser',
    [builderMember],
    'runtime service account deployers',
  );

  const builderPolicy = runGcloud([
    'iam',
    'service-accounts',
    'get-iam-policy',
    builderEmail,
    '--project',
    project,
  ]);

  const projectPolicy = runGcloud(['projects', 'get-iam-policy', project]);
  const projectSecretAccessors = membersForRole(
    projectPolicy,
    'roles/secretmanager.secretAccessor',
  );
  if (projectSecretAccessors.length > 0) {
    throw new Error(
      `project Secret Accessor must have no members; found ${projectSecretAccessors.join(', ')}`,
    );
  }
  const activationRoleName = `projects/${project}/roles/${ACTIVATION_ROLE_ID}`;
  const preflightRoleName = `projects/${project}/roles/${PREFLIGHT_ROLE_ID}`;
  const expectedBuildSubmitters = membersForRole(
    projectPolicy,
    preflightRoleName,
  );
  if (expectedBuildSubmitters.length === 0) {
    throw new Error(
      'operator preflight reader must have at least one configured member',
    );
  }
  assertExactRolePolicy(
    builderPolicy,
    'roles/iam.serviceAccountUser',
    expectedBuildSubmitters,
    'builder service account submitters',
  );
  assertExactProjectRoles(
    projectPolicy,
    runtimeMember,
    [activationRoleName, ...RUNTIME_PROJECT_ROLES],
    'runtime activation',
  );
  assertExactProjectRoles(
    projectPolicy,
    builderMember,
    BUILDER_PROJECT_ROLES,
    'builder',
  );
  const imageRepositoryPolicy = runGcloud([
    'artifacts',
    'repositories',
    'get-iam-policy',
    IMAGE_REPOSITORY,
    '--location',
    IMAGE_REPOSITORY_LOCATION,
    '--project',
    project,
  ]);
  assertExactUnconditionalRoles(
    imageRepositoryPolicy,
    runtimeMember,
    RUNTIME_IMAGE_ROLES,
    'runtime image repository roles',
  );

  const activationRole = runGcloud([
    'iam',
    'roles',
    'describe',
    ACTIVATION_ROLE_ID,
    '--project',
    project,
  ]);
  assertExactValues(
    activationRole?.includedPermissions,
    ACTIVATION_PERMISSIONS,
    'runtime activation permissions',
  );
  const preflightRole = runGcloud([
    'iam',
    'roles',
    'describe',
    PREFLIGHT_ROLE_ID,
    '--project',
    project,
  ]);
  assertExactValues(
    preflightRole?.includedPermissions,
    PREFLIGHT_PERMISSIONS,
    'operator preflight permissions',
  );
  assertOperatorSetFingerprint(preflightRole, expectedBuildSubmitters);

  const secrets = runGcloud(['secrets', 'list', '--project', project]);
  if (!Array.isArray(secrets)) {
    throw new Error(`could not inventory Secret Manager in ${project}`);
  }
  const secretIds = secrets
    .map((secret) =>
      String(secret?.name ?? '')
        .split('/')
        .at(-1),
    )
    .filter(Boolean);
  for (const expectedSecretId of SECRET_IDS) {
    if (!secretIds.includes(expectedSecretId)) {
      throw new Error(`managed secret is missing: ${expectedSecretId}`);
    }
  }

  for (const secretId of secretIds) {
    const secretPolicy = runGcloud([
      'secrets',
      'get-iam-policy',
      secretId,
      '--project',
      project,
    ]);
    const runtimeRoles = rolesForMember(secretPolicy, runtimeMember);
    const builderRoles = rolesForMember(secretPolicy, builderMember);
    if (builderRoles.length > 0) {
      throw new Error(
        `${builderEmail} must not have secret IAM on ${secretId}: ${builderRoles.join(', ')}`,
      );
    }
    if (!SECRET_IDS.includes(secretId) && runtimeRoles.length > 0) {
      throw new Error(
        `${runtimeEmail} has unexpected secret IAM on ${secretId}: ${runtimeRoles.join(', ')}`,
      );
    }
    if (!SECRET_IDS.includes(secretId)) continue;
    if (
      runtimeRoles.length !== 1 ||
      runtimeRoles[0] !== 'roles/secretmanager.secretAccessor'
    ) {
      throw new Error(
        `${runtimeEmail} must have only Secret Accessor on ${secretId}; found ${runtimeRoles.join(', ') || 'no roles'}`,
      );
    }
    assertExactRolePolicy(
      secretPolicy,
      'roles/secretmanager.secretAccessor',
      [runtimeMember],
      `${secretId} Secret Accessor policy`,
    );

    const latestVersion = runGcloud([
      'secrets',
      'versions',
      'describe',
      'latest',
      '--secret',
      secretId,
      '--project',
      project,
    ]);
    if (latestVersion?.state !== 'ENABLED') {
      throw new Error(`${secretId} latest version is not enabled`);
    }

    write(`${secretId}: latest version enabled`);
  }

  if (version) {
    const versionMetadata = runGcloud([
      'app',
      'versions',
      'describe',
      version,
      '--service',
      'grafana-agent',
      '--project',
      project,
    ]);
    if (versionMetadata?.serviceAccount !== runtimeEmail) {
      throw new Error(
        `App Engine version ${version} uses ${versionMetadata?.serviceAccount || 'no service account'}, expected ${runtimeEmail}`,
      );
    }
    const serviceMetadata = runGcloud([
      'app',
      'services',
      'describe',
      'grafana-agent',
      '--project',
      project,
    ]);
    const allocations = serviceMetadata?.split?.allocations;
    if (
      !allocations ||
      typeof allocations !== 'object' ||
      Array.isArray(allocations)
    ) {
      throw new Error('could not verify grafana-agent traffic allocations');
    }
    const targetAllocation = Number(allocations[version] ?? 0);
    const expectedAllocation = versionTraffic === 'full' ? 1 : 0;
    if (
      !Number.isFinite(targetAllocation) ||
      targetAllocation !== expectedAllocation
    ) {
      throw new Error(
        `App Engine version ${version} has traffic allocation ${allocations[version] ?? 0}, expected ${expectedAllocation}`,
      );
    }
    write(`App Engine version ${version}: runtime identity verified`);
    write(`App Engine version ${version}: ${versionTraffic} traffic verified`);
  }

  write(`Alloy live preflight passed for ${runtimeEmail}.`);
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    runPreflight(options);
  } catch (error) {
    console.error(
      `preflight: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
