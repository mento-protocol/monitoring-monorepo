import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runPreflight } from './preflight.mjs';

const project = 'mento-monitoring';
const runtimeEmail = `grafana-agent-runtime@${project}.iam.gserviceaccount.com`;
const runtimeMember = `serviceAccount:${runtimeEmail}`;
const builderEmail = `grafana-agent-builder@${project}.iam.gserviceaccount.com`;
const builderMember = `serviceAccount:${builderEmail}`;
const legacySecretMembers = [
  'serviceAccount:mento-monitoring@appspot.gserviceaccount.com',
  'serviceAccount:80554359692@cloudbuild.gserviceaccount.com',
  'serviceAccount:80554359692-compute@developer.gserviceaccount.com',
];
const builderRoles = [
  'roles/appengine.deployer',
  'roles/artifactregistry.writer',
  'roles/cloudbuild.builds.editor',
  'roles/logging.logWriter',
  'roles/storage.objectAdmin',
];
const submitters = ['group:eng@mentolabs.xyz'];
const activationRole =
  'projects/mento-monitoring/roles/grafanaAgentActivationReader';
const activationPermissions = [
  'appengine.services.get',
  'appengine.versions.list',
];
const preflightRole =
  'projects/mento-monitoring/roles/grafanaAgentPreflightReader';
const preflightPermissions = [
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

function successfulProjectPolicy(
  extraBindings = [],
  configuredSubmitters = submitters,
) {
  return {
    bindings: [
      { role: activationRole, members: [runtimeMember] },
      { role: 'roles/logging.logWriter', members: [runtimeMember] },
      { role: preflightRole, members: configuredSubmitters },
      ...builderRoles.map((role) => ({ role, members: [builderMember] })),
      ...extraBindings,
    ],
  };
}

function successfulRunner(overrides = {}, configuredSubmitters = submitters) {
  return (args) => {
    const key = args.join(' ');
    if (overrides[key] !== undefined) return overrides[key];
    if (key.startsWith('iam service-accounts describe ')) {
      return { email: args[3] };
    }
    if (
      key ===
      `iam service-accounts get-iam-policy ${runtimeEmail} --project ${project}`
    ) {
      return {
        bindings: [
          {
            role: 'roles/iam.serviceAccountUser',
            members: [builderMember],
          },
        ],
      };
    }
    if (
      key ===
      `iam service-accounts get-iam-policy ${builderEmail} --project ${project}`
    ) {
      return {
        bindings: [
          {
            role: 'roles/iam.serviceAccountUser',
            members: configuredSubmitters,
          },
        ],
      };
    }
    if (
      key ===
      `iam roles describe grafanaAgentActivationReader --project ${project}`
    ) {
      return { includedPermissions: activationPermissions };
    }
    if (
      key ===
      `iam roles describe grafanaAgentPreflightReader --project ${project}`
    ) {
      return {
        description: `Alloy metadata preflight. operator-set-sha256=${memberSetFingerprint(configuredSubmitters)}`,
        includedPermissions: preflightPermissions,
      };
    }
    if (key === `projects get-iam-policy ${project}`)
      return successfulProjectPolicy([], configuredSubmitters);
    if (
      key ===
      `artifacts repositories get-iam-policy us.gcr.io --location us --project ${project}`
    ) {
      return {
        bindings: [
          {
            role: 'roles/artifactregistry.reader',
            members: [runtimeMember],
          },
        ],
      };
    }
    if (key === `secrets list --project ${project}`) {
      return [
        { name: 'projects/123/secrets/grafana-agent-endpoint' },
        { name: 'projects/123/secrets/grafana-agent-username' },
        { name: 'projects/123/secrets/grafana-agent-password' },
      ];
    }
    if (key.startsWith('secrets versions describe latest ')) {
      return { name: 'metadata-only', state: 'ENABLED' };
    }
    if (key.startsWith('secrets get-iam-policy ')) {
      return {
        bindings: [
          {
            role: 'roles/secretmanager.secretAccessor',
            members: [runtimeMember],
          },
        ],
      };
    }
    if (key.startsWith('app versions describe ')) {
      return { serviceAccount: runtimeEmail };
    }
    if (key === `app services describe grafana-agent --project ${project}`) {
      return { split: { allocations: { previous: 1 } } };
    }
    throw new Error(`unexpected gcloud call: ${key}`);
  };
}

const staticPass = () => [];

test('live preflight checks only metadata and accepts the exact contract', () => {
  const output = [];
  runPreflight({
    project,
    version: 'r-abcdef0-1',
    runGcloud: successfulRunner(),
    validateStatic: staticPass,
    write: (message) => output.push(message),
  });
  assert.match(output.at(-1), /live preflight passed/u);
});

test('live preflight accepts a matching Terraform operator override', () => {
  const configuredSubmitters = [
    'group:platform@mentolabs.xyz',
    'user:release-manager@mentolabs.xyz',
  ];
  runPreflight({
    project,
    runGcloud: successfulRunner({}, configuredSubmitters),
    validateStatic: staticPass,
    write: () => {},
  });
});

test('member fingerprints match Terraform jsonencode escaping', () => {
  const configuredSubmitters = ['group:ops&alerts\u2028@example.com'];
  const preflightRoleKey = `iam roles describe grafanaAgentPreflightReader --project ${project}`;
  runPreflight({
    project,
    runGcloud: successfulRunner(
      {
        [preflightRoleKey]: {
          description:
            'Alloy metadata preflight. operator-set-sha256=191889319a5329834d3198be12ba2ac82e65decbad637aa2790dc95e06c65116',
          includedPermissions: preflightPermissions,
        },
      },
      configuredSubmitters,
    ),
    validateStatic: staticPass,
    write: () => {},
  });
});

test('coordinated policy drift still fails the Terraform fingerprint', () => {
  const driftedSubmitters = [...submitters, 'user:unexpected@example.com'];
  const projectPolicyKey = `projects get-iam-policy ${project}`;
  const builderPolicyKey = `iam service-accounts get-iam-policy ${builderEmail} --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [projectPolicyKey]: successfulProjectPolicy([], driftedSubmitters),
          [builderPolicyKey]: {
            bindings: [
              {
                role: 'roles/iam.serviceAccountUser',
                members: driftedSubmitters,
              },
            ],
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /must match the Terraform configuration fingerprint/u,
  );
});

test('static-only mode never calls gcloud', () => {
  runPreflight({
    staticOnly: true,
    runGcloud: () => assert.fail('gcloud must not run'),
    validateStatic: staticPass,
    write: () => {},
  });
});

test('a different project fails before any gcloud call', () => {
  assert.throws(
    () =>
      runPreflight({
        project: 'another-project',
        runGcloud: () => assert.fail('gcloud must not run'),
        validateStatic: staticPass,
        write: () => {},
      }),
    /refusing cross-project preflight/u,
  );
});

test('missing deployer impersonation fails closed', () => {
  const key = `iam service-accounts get-iam-policy ${runtimeEmail} --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: {
            bindings: [
              {
                role: 'roles/iam.serviceAccountUser',
                members: [],
              },
            ],
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /runtime service account deployers members must match the exact expected identities/u,
  );
});

test('an extra runtime impersonator fails closed', () => {
  const key = `iam service-accounts get-iam-policy ${runtimeEmail} --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: {
            bindings: [
              {
                role: 'roles/iam.serviceAccountUser',
                members: [
                  builderMember,
                  'serviceAccount:unexpected@example.com',
                ],
              },
            ],
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /runtime service account deployers members must match the exact expected identities/u,
  );
});

test('disabled latest secret versions fail closed even when older versions could be enabled', () => {
  const key =
    'secrets versions describe latest --secret grafana-agent-password --project mento-monitoring';
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: {
            name: 'projects/123/secrets/grafana-agent-password/versions/7',
            state: 'DISABLED',
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /latest version is not enabled/u,
  );
});

test('unexpected project roles on the runtime identity fail closed', () => {
  const key = `projects get-iam-policy ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: {
            ...successfulProjectPolicy([
              {
                role: 'roles/editor',
                members: [runtimeMember],
              },
            ]),
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /runtime activation project roles must match the least-privilege contract/u,
  );
});

test('missing App Engine Flex Logs Writer on the runtime identity fails closed', () => {
  const key = `projects get-iam-policy ${project}`;
  const projectPolicy = successfulProjectPolicy();
  projectPolicy.bindings = projectPolicy.bindings.filter(
    (binding) =>
      !(
        binding.role === 'roles/logging.logWriter' &&
        binding.members.includes(runtimeMember)
      ),
  );
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: projectPolicy,
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /runtime activation project roles must match the least-privilege contract/u,
  );
});

test('missing Artifact Registry image reader on the runtime identity fails closed', () => {
  const key = `artifacts repositories get-iam-policy us.gcr.io --location us --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: { bindings: [] },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /runtime image repository roles must match the least-privilege contract/u,
  );
});

test('broader Artifact Registry image access on the runtime identity fails closed', () => {
  const key = `artifacts repositories get-iam-policy us.gcr.io --location us --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: {
            bindings: [
              {
                role: 'roles/artifactregistry.writer',
                members: [runtimeMember],
              },
            ],
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /runtime image repository roles must match the least-privilege contract/u,
  );
});

test('conditional Artifact Registry image reader on the runtime identity fails closed', () => {
  const key = `artifacts repositories get-iam-policy us.gcr.io --location us --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: {
            bindings: [
              {
                role: 'roles/artifactregistry.reader',
                members: [runtimeMember],
                condition: {
                  title: 'inactive-reader',
                  expression:
                    'request.time < timestamp("2020-01-01T00:00:00Z")',
                },
              },
            ],
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /runtime image repository roles must be unconditional/u,
  );
});

test('flattened scalar project bindings also fail closed', () => {
  const key = `projects get-iam-policy ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: successfulProjectPolicy([
            {
              bindings: {
                role: 'roles/editor',
                members: runtimeMember,
              },
            },
          ]),
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /runtime activation project roles must match the least-privilege contract/u,
  );
});

test('an extra secret-level runtime grant fails closed', () => {
  const inventoryKey = `secrets list --project ${project}`;
  const extraPolicyKey = `secrets get-iam-policy unrelated-secret --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [inventoryKey]: [
            { name: 'projects/123/secrets/grafana-agent-endpoint' },
            { name: 'projects/123/secrets/grafana-agent-username' },
            { name: 'projects/123/secrets/grafana-agent-password' },
            { name: 'projects/123/secrets/unrelated-secret' },
          ],
          [extraPolicyKey]: {
            bindings: [
              {
                role: 'roles/secretmanager.secretAccessor',
                members: [runtimeMember],
              },
            ],
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /unexpected secret IAM/u,
  );
});

test('an extra role on a managed secret fails closed', () => {
  const key = `secrets get-iam-policy grafana-agent-endpoint --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: {
            bindings: [
              {
                role: 'roles/secretmanager.secretAccessor',
                members: [runtimeMember],
              },
              {
                role: 'roles/secretmanager.viewer',
                members: [runtimeMember],
              },
            ],
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /must have only Secret Accessor/u,
  );
});

test('a conditional runtime binding on a managed secret fails closed', () => {
  const key = `secrets get-iam-policy grafana-agent-endpoint --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: {
            bindings: [
              {
                role: 'roles/secretmanager.secretAccessor',
                members: [runtimeMember],
                condition: {
                  expression:
                    'request.time < timestamp("2099-01-01T00:00:00Z")',
                  title: 'temporary',
                },
              },
            ],
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /Secret Accessor policy must be unconditional/u,
  );
});

test('effective App Engine version identity mismatch fails closed', () => {
  const version = 'r-abcdef0-1';
  const key = `app versions describe ${version} --service grafana-agent --project mento-monitoring`;
  assert.throws(
    () =>
      runPreflight({
        project,
        version,
        runGcloud: successfulRunner({
          [key]: {
            serviceAccount: 'mento-monitoring@appspot.gserviceaccount.com',
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /expected grafana-agent-runtime/u,
  );
});

test('effective App Engine version must have zero traffic before promotion', () => {
  const version = 'r-abcdef0-1';
  const key = `app services describe grafana-agent --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        version,
        runGcloud: successfulRunner({
          [key]: {
            split: { allocations: { previous: 0.9, [version]: 0.1 } },
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /has traffic allocation 0\.1, expected 0/u,
  );
});

test('effective App Engine rollback version accepts exactly full traffic', () => {
  const version = 'r-abcdef0-1';
  const key = `app services describe grafana-agent --project ${project}`;
  assert.doesNotThrow(() =>
    runPreflight({
      project,
      version,
      versionTraffic: 'full',
      runGcloud: successfulRunner({
        [key]: {
          split: { allocations: { [version]: 1 } },
        },
      }),
      validateStatic: staticPass,
      write: () => {},
    }),
  );
});

test('effective App Engine rollback version rejects partial traffic', () => {
  const version = 'r-abcdef0-1';
  const key = `app services describe grafana-agent --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        version,
        versionTraffic: 'full',
        runGcloud: successfulRunner({
          [key]: {
            split: { allocations: { previous: 0.1, [version]: 0.9 } },
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /has traffic allocation 0\.9, expected 1/u,
  );
});

test('builder must not have Secret Manager access', () => {
  const key = `secrets get-iam-policy grafana-agent-endpoint --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: {
            bindings: [
              {
                role: 'roles/secretmanager.secretAccessor',
                members: [runtimeMember, builderMember],
              },
            ],
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /builder.*must not have secret IAM/u,
  );
});

for (const legacyMember of legacySecretMembers) {
  test(`legacy secret access fails closed for ${legacyMember}`, () => {
    const key = `secrets get-iam-policy grafana-agent-endpoint --project ${project}`;
    assert.throws(
      () =>
        runPreflight({
          project,
          runGcloud: successfulRunner({
            [key]: {
              bindings: [
                {
                  role: 'roles/secretmanager.secretAccessor',
                  members: [runtimeMember, legacyMember],
                },
              ],
            },
          }),
          validateStatic: staticPass,
          write: () => {},
        }),
      /Secret Accessor policy members must match the exact expected identities/u,
    );
  });
}

for (const legacyMember of legacySecretMembers) {
  test(`project-level legacy secret access fails closed for ${legacyMember}`, () => {
    const key = `projects get-iam-policy ${project}`;
    assert.throws(
      () =>
        runPreflight({
          project,
          runGcloud: successfulRunner({
            [key]: successfulProjectPolicy([
              {
                role: 'roles/secretmanager.secretAccessor',
                members: [legacyMember],
              },
            ]),
          }),
          validateStatic: staticPass,
          write: () => {},
        }),
      /project Secret Accessor must have no members/u,
    );
  });
}

test('builder project roles must match the least-privilege set', () => {
  const key = `projects get-iam-policy ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: successfulProjectPolicy([
            { role: 'roles/storage.admin', members: [builderMember] },
          ]),
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /builder project roles must match the least-privilege contract/u,
  );
});

test('runtime activation permissions cannot broaden', () => {
  const key = `iam roles describe grafanaAgentActivationReader --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: {
            includedPermissions: [
              ...activationPermissions,
              'appengine.versions.update',
            ],
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /runtime activation permissions must match the least-privilege contract/u,
  );
});

test('operator preflight permissions cannot broaden', () => {
  const key = `iam roles describe grafanaAgentPreflightReader --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: {
            includedPermissions: [
              ...preflightPermissions,
              'secretmanager.versions.access',
            ],
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /operator preflight permissions must match the least-privilege contract/u,
  );
});

test('operator preflight readers must match builder submitters', () => {
  const key = `projects get-iam-policy ${project}`;
  const policy = successfulProjectPolicy();
  policy.bindings = policy.bindings.map((binding) =>
    binding.role === preflightRole
      ? {
          ...binding,
          members: [...submitters, 'user:unexpected@example.com'],
        }
      : binding,
  );
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({ [key]: policy }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /builder service account submitters members must match the exact expected identities/u,
  );
});

test('the authoritative operator set cannot be empty', () => {
  const key = `projects get-iam-policy ${project}`;
  const policy = successfulProjectPolicy();
  policy.bindings = policy.bindings.filter(
    (binding) => binding.role !== preflightRole,
  );
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({ [key]: policy }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /operator preflight reader must have at least one configured member/u,
  );
});

test('builder submitters must match the operator preflight readers', () => {
  const key = `iam service-accounts get-iam-policy ${builderEmail} --project ${project}`;
  assert.throws(
    () =>
      runPreflight({
        project,
        runGcloud: successfulRunner({
          [key]: {
            bindings: [
              {
                role: 'roles/iam.serviceAccountUser',
                members: [...submitters, 'user:unexpected@example.com'],
              },
            ],
          },
        }),
        validateStatic: staticPass,
        write: () => {},
      }),
    /builder service account submitters members must match the exact expected identities/u,
  );
});
