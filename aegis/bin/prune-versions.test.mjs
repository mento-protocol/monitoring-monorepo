import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectVersionsToDelete } from './prune-versions.mjs';

function version(id, day, trafficSplit) {
  return {
    id,
    traffic_split: trafficSplit,
    version: {
      createTime: `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`,
    },
  };
}

test('never deletes a version that receives traffic', () => {
  const versions = [version('serving', 1, 1), version('old', 2, 0)];
  assert.deepEqual(
    selectVersionsToDelete(versions, { keep: 0, maxDelete: 10 }),
    ['old'],
  );
});

test('keeps the newest idle versions and deletes the oldest first', () => {
  const versions = [
    version('v5', 5, 0),
    version('v1', 1, 0),
    version('v3', 3, 0),
    version('live', 6, 1),
    version('v4', 4, 0),
    version('v2', 2, 0),
  ];
  assert.deepEqual(
    selectVersionsToDelete(versions, { keep: 2, maxDelete: 10 }),
    ['v1', 'v2', 'v3'],
  );
});

test('caps deletions per run, oldest first', () => {
  const versions = Array.from({ length: 30 }, (_, i) =>
    version(`v${i + 1}`, i + 1, 0),
  );
  assert.deepEqual(
    selectVersionsToDelete(versions, { keep: 20, maxDelete: 3 }),
    ['v1', 'v2', 'v3'],
  );
});

test('deletes nothing when at or under the keep count', () => {
  const versions = [
    version('v1', 1, 0),
    version('v2', 2, 0),
    version('live', 3, 1),
  ];
  assert.deepEqual(
    selectVersionsToDelete(versions, { keep: 2, maxDelete: 10 }),
    [],
  );
});

test('refuses versions without a numeric traffic_split', () => {
  const versions = [
    { id: 'v1', version: { createTime: '2026-10-01T00:00:00Z' } },
  ];
  assert.throws(
    () => selectVersionsToDelete(versions, { keep: 0, maxDelete: 10 }),
    /traffic_split/u,
  );
});

test('refuses versions without a parseable createTime', () => {
  assert.throws(
    () =>
      selectVersionsToDelete([{ id: 'v1', traffic_split: 0 }], {
        keep: 0,
        maxDelete: 1,
      }),
    /createTime/u,
  );
});
