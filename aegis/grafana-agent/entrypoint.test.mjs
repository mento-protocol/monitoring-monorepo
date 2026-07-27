import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const agentDir = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.join(agentDir, 'entrypoint.sh');
const passiveHealth = path.join(agentDir, 'passive-health.sh');

function runActivationCheck(
  versionsJson,
  nextPageJson = '',
  thirdPageJson = '',
) {
  return spawnSync(
    'sh',
    [
      '-c',
      `ENTRYPOINT_SOURCE_ONLY=1 GAE_VERSION=target . "$1"
VERSIONS_JSON="$2"
NEXT_PAGE_JSON="$3"
THIRD_PAGE_JSON="$4"
get_access_token() { printf '%s' token; }
curl() {
  case "$*" in
    *"/versions?"*) printf '%s\n' "entrypoint-test: versions-request" >&2 ;;
  esac
  case "$*" in
    *"pageToken=page%203"*)
      [ -n "$THIRD_PAGE_JSON" ] || return 1
      printf '%s' "$THIRD_PAGE_JSON"
      ;;
    *"pageToken=page%2B2%2F%3D"*)
      [ -n "$NEXT_PAGE_JSON" ] || return 1
      printf '%s' "$NEXT_PAGE_JSON"
      ;;
    *"/versions?view=BASIC&pageSize=200"*) printf '%s' "$VERSIONS_JSON" ;;
    *) printf '%s' '{"split":{"allocations":{"target":1}}}' ;;
  esac
}
activation_is_safe`,
      'sh',
      entrypoint,
      versionsJson,
      nextPageJson,
      thirdPageJson,
    ],
    { encoding: 'utf8' },
  );
}

test('activation requires an exhaustive inventory with every peer stopped', () => {
  const safe = runActivationCheck(
    '{"versions":[{"id":"target","servingStatus":"SERVING"},{"id":"old","servingStatus":"STOPPED"}]}',
  );
  assert.equal(safe.status, 0, safe.stderr);

  const paginatedSafe = runActivationCheck(
    '{"versions":[{"id":"target","servingStatus":"SERVING"}],"nextPageToken":"page+2/="}',
    '{"versions":[{"id":"old","servingStatus":"STOPPED"}]}',
  );
  assert.equal(paginatedSafe.status, 0, paginatedSafe.stderr);
  assert.equal(
    paginatedSafe.stderr.match(/entrypoint-test: versions-request/gu)?.length,
    2,
  );

  const missingPage = runActivationCheck(
    '{"versions":[{"id":"target","servingStatus":"SERVING"}],"nextPageToken":"page+2/="}',
  );
  assert.notEqual(missingPage.status, 0);

  const activePeerOnFirstPage = runActivationCheck(
    '{"versions":[{"id":"target","servingStatus":"SERVING"},{"id":"old","servingStatus":"SERVING"}]}',
  );
  assert.notEqual(activePeerOnFirstPage.status, 0);

  const activePeerOnNextPage = runActivationCheck(
    '{"versions":[{"id":"target","servingStatus":"SERVING"}],"nextPageToken":"page+2/="}',
    '{"versions":[{"id":"old","servingStatus":"SERVING"}]}',
  );
  assert.notEqual(activePeerOnNextPage.status, 0);

  const threePages = runActivationCheck(
    '{"versions":[{"id":"target","servingStatus":"SERVING"}],"nextPageToken":"page+2/="}',
    '{"versions":[{"id":"old-1","servingStatus":"STOPPED"}],"nextPageToken":"page 3"}',
    '{"versions":[{"id":"old-2","servingStatus":"STOPPED"}]}',
  );
  assert.equal(threePages.status, 0, threePages.stderr);
  assert.equal(
    threePages.stderr.match(/entrypoint-test: versions-request/gu)?.length,
    3,
  );

  const repeatedPageToken = runActivationCheck(
    '{"versions":[{"id":"target","servingStatus":"SERVING"}],"nextPageToken":"page+2/="}',
    '{"versions":[{"id":"old","servingStatus":"STOPPED"}],"nextPageToken":"page+2/="}',
  );
  assert.notEqual(repeatedPageToken.status, 0);
  assert.match(repeatedPageToken.stderr, /repeated a page token/u);
  assert.equal(
    repeatedPageToken.stderr.match(/entrypoint-test: versions-request/gu)
      ?.length,
    2,
  );
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
