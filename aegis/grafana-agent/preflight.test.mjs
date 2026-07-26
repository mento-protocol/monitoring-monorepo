import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPreflight } from './preflight.mjs';

const project = 'mento-monitoring';
const runtimeEmail = `grafana-agent-runtime@${project}.iam.gserviceaccount.com`;
const runtimeMember = `serviceAccount:${runtimeEmail}`;
const builderEmail = `grafana-agent-builder@${project}.iam.gserviceaccount.com`;
const builderMember = `serviceAccount:${builderEmail}`;
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
  'iam.roles.get',
  'iam.serviceAccounts.get',
  'iam.serviceAccounts.getIamPolicy',
  'resourcemanager.projects.get',
  'resourcemanager.projects.getIamPolicy',
  'secretmanager.secrets.getIamPolicy',
  'secretmanager.secrets.list',
  'secretmanager.versions.get',
];

function successfulProjectPolicy(extraBindings = []) {
  return {
    bindings: [
      { role: activationRole, members: [runtimeMember] },
      { role: preflightRole, members: submitters },
      ...builderRoles.map((role) => ({ role, members: [builderMember] })),
      ...extraBindings,
    ],
  };
}

function successfulRunner(overrides = {}) {
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
            members: submitters,
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
      return { includedPermissions: preflightPermissions };
    }
    if (key === `projects get-iam-policy ${project}`)
      return successfulProjectPolicy();
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
    /has non-zero traffic allocation 0\.1/u,
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

test('operator preflight readers must match the engineering group', () => {
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
    /operator preflight reader members must match the least-privilege contract/u,
  );
});

test('builder submitters must match the engineering group', () => {
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
