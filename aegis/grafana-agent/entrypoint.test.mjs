import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const agentDir = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.join(agentDir, 'entrypoint.sh');
const passiveHealth = path.join(agentDir, 'passive-health.sh');

function runActivationCheck(versionsJson) {
  return spawnSync(
    'sh',
    [
      '-c',
      `ENTRYPOINT_SOURCE_ONLY=1 GAE_VERSION=target . "$1"
VERSIONS_JSON="$2"
get_access_token() { printf '%s' token; }
curl() {
  case "$*" in
    *"/versions?view=BASIC&pageSize=200"*) printf '%s' "$VERSIONS_JSON" ;;
    *) printf '%s' '{"split":{"allocations":{"target":1}}}' ;;
  esac
}
activation_is_safe`,
      'sh',
      entrypoint,
      versionsJson,
    ],
    { encoding: 'utf8' },
  );
}

test('activation requires an exhaustive inventory with every peer stopped', () => {
  const safe = runActivationCheck(
    '{"versions":[{"id":"target","servingStatus":"SERVING"},{"id":"old","servingStatus":"STOPPED"}]}',
  );
  assert.equal(safe.status, 0, safe.stderr);

  const hiddenPage = runActivationCheck(
    '{"versions":[{"id":"target","servingStatus":"SERVING"}],"nextPageToken":"hidden-peer"}',
  );
  assert.notEqual(hiddenPage.status, 0);

  const activePeer = runActivationCheck(
    '{"versions":[{"id":"target","servingStatus":"SERVING"},{"id":"old","servingStatus":"SERVING"}]}',
  );
  assert.notEqual(activePeer.status, 0);
});

test('passive mode satisfies container health but exposes an inactive sentinel', () => {
  const passive = spawnSync('sh', [passiveHealth], {
    encoding: 'utf8',
    input: 'GET /-/healthy HTTP/1.1\r\nHost: localhost\r\n\r\n',
  });
  assert.equal(passive.status, 0, passive.stderr);
  assert.match(passive.stdout, /HTTP\/1\.1 200 OK/u);
  assert.match(passive.stdout, /collector-passive$/u);

  const collectorRoute = spawnSync('sh', [passiveHealth], {
    encoding: 'utf8',
    input: 'GET /-/alloy HTTP/1.1\r\nHost: localhost\r\n\r\n',
  });
  assert.equal(collectorRoute.status, 0, collectorRoute.stderr);
  assert.match(collectorRoute.stdout, /503 Service Unavailable/u);
});
