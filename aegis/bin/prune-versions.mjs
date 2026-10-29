// Delete old zero-traffic Aegis App Engine versions before a deploy.
//
// App Engine caps an app at 210 versions across all services. Every Aegis
// deploy creates a version and nothing removed old ones, so deploys started
// failing with APP_ENGINE_ERROR_VERSION_LIMIT_EXCEEDED. This keeps the newest
// zero-traffic versions for rollback and deletes the rest, oldest first.
//
// Usage: node aegis/bin/prune-versions.mjs [--dry-run]
// Env: AEGIS_KEEP_VERSIONS (default 20), AEGIS_MAX_DELETE (default 60).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT = 'mento-monitoring';
const SERVICE = 'default';

function nonNegativeInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${value}`);
  }
  return parsed;
}

// Fail closed: a version whose traffic share is unknown is never "idle".
function trafficShare(version) {
  const share = version.traffic_split;
  if (typeof share !== 'number') {
    throw new Error(`version ${version.id} has no numeric traffic_split`);
  }
  return share;
}

/**
 * Pick versions to delete. Never selects a version with any traffic; keeps the
 * newest `keep` zero-traffic versions; deletes at most `maxDelete`, oldest
 * first, so one run stays inside the deploy job's time limit.
 */
export function selectVersionsToDelete(versions, { keep, maxDelete }) {
  const idle = versions
    .filter((version) => trafficShare(version) === 0)
    .map((version) => ({
      id: version.id,
      createTime: version.version?.createTime,
    }));
  for (const version of idle) {
    if (typeof version.id !== 'string' || version.id === '') {
      throw new Error('version without an id in gcloud output');
    }
    if (Number.isNaN(Date.parse(version.createTime))) {
      throw new Error(`version ${version.id} has no parseable createTime`);
    }
  }
  idle.sort((a, b) => Date.parse(b.createTime) - Date.parse(a.createTime));
  return idle
    .slice(keep)
    .reverse()
    .slice(0, maxDelete)
    .map((version) => version.id);
}

function gcloud(args) {
  const run = spawnSync('gcloud', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (run.status !== 0) {
    throw new Error(
      `gcloud ${args.slice(0, 3).join(' ')} exited ${run.status}`,
    );
  }
  return run.stdout;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const keep = nonNegativeInt(
    process.env.AEGIS_KEEP_VERSIONS,
    20,
    'AEGIS_KEEP_VERSIONS',
  );
  const maxDelete = nonNegativeInt(
    process.env.AEGIS_MAX_DELETE,
    60,
    'AEGIS_MAX_DELETE',
  );
  const scope = [`--project=${PROJECT}`, `--service=${SERVICE}`];

  const versions = JSON.parse(
    gcloud(['app', 'versions', 'list', ...scope, '--format=json']),
  );
  const doomed = selectVersionsToDelete(versions, { keep, maxDelete });
  console.log(
    `prune-versions: ${PROJECT}/${SERVICE} has ${versions.length} versions; ` +
      `keeping the newest ${keep} without traffic; deleting ${doomed.length}` +
      (dryRun ? ' (dry run)' : ''),
  );
  if (doomed.length === 0) return;
  console.log(`prune-versions: ${doomed.join(' ')}`);
  if (dryRun) return;

  gcloud(['app', 'versions', 'delete', ...doomed, ...scope, '--quiet']);
  const remaining = JSON.parse(
    gcloud(['app', 'versions', 'list', ...scope, '--format=json']),
  );
  const left = new Set(remaining.map((version) => version.id));
  const survivors = doomed.filter((id) => left.has(id));
  if (survivors.length > 0) {
    throw new Error(
      `versions still present after delete: ${survivors.join(' ')}`,
    );
  }
  console.log(
    `prune-versions: ${remaining.length} versions remain in ${SERVICE}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
