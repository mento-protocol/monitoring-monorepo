import assert from "node:assert/strict";

import {
  listDeadLetterObjects,
  main,
  redriveDeadLetterObject,
} from "./redrive-onchain-deadletter.mjs";

const BUCKET = "test-bucket";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/**
 * In-memory fake of the GCS JSON API (list/get-media/copyTo/delete) plus
 * Slack's chat.postMessage, keyed on URL shape. `objects` is a mutable Map
 * the test can inspect afterwards to confirm archiving happened (or didn't).
 */
function createFakeTransport(objects) {
  const slackCalls = [];

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";

    if (parsed.hostname === "slack.com") {
      const body = JSON.parse(init.body);
      slackCalls.push(body);
      if (body.channel === "FAIL_CHANNEL") {
        return jsonResponse({ ok: false, error: "channel_not_found" });
      }
      return jsonResponse({ ok: true });
    }

    const listMatch = parsed.pathname === `/storage/v1/b/${BUCKET}/o`;
    if (listMatch && method === "GET") {
      const prefix = parsed.searchParams.get("prefix") ?? "";
      const items = [...objects.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name }));
      return jsonResponse({ items });
    }

    const copyMatch = parsed.pathname.match(
      new RegExp(
        `^/storage/v1/b/${BUCKET}/o/([^/]+)/copyTo/b/${BUCKET}/o/([^/]+)$`,
      ),
    );
    if (copyMatch && method === "POST") {
      const src = decodeURIComponent(copyMatch[1]);
      const dst = decodeURIComponent(copyMatch[2]);
      assert.ok(objects.has(src), `copy source ${src} must exist`);
      objects.set(dst, objects.get(src));
      return jsonResponse({ name: dst });
    }

    const objectMatch = parsed.pathname.match(
      new RegExp(`^/storage/v1/b/${BUCKET}/o/([^/]+)$`),
    );
    if (
      objectMatch &&
      method === "GET" &&
      parsed.searchParams.get("alt") === "media"
    ) {
      const name = decodeURIComponent(objectMatch[1]);
      if (!objects.has(name)) return new Response("not found", { status: 404 });
      return jsonResponse(objects.get(name));
    }
    if (objectMatch && method === "GET") {
      // Metadata-only GET (the "done/" marker existence check).
      const name = decodeURIComponent(objectMatch[1]);
      if (!objects.has(name)) return new Response("not found", { status: 404 });
      return jsonResponse({ name });
    }
    if (objectMatch && method === "DELETE") {
      const name = decodeURIComponent(objectMatch[1]);
      objects.delete(name);
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unhandled fake request: ${method} ${parsed.toString()}`);
  };

  return { fetchImpl, slackCalls };
}

// listDeadLetterObjects: excludes the done/ archive prefix and follows
// nextPageToken pagination.
{
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.toString());
    if (calls.length === 1) {
      return jsonResponse({
        items: [
          { name: "dead-letter/a.json" },
          { name: "dead-letter/done/old.json" },
        ],
        nextPageToken: "page2",
      });
    }
    return jsonResponse({ items: [{ name: "dead-letter/b.json" }] });
  };

  const names = await listDeadLetterObjects({
    bucket: BUCKET,
    accessToken: "token",
    fetchImpl,
  });

  assert.deepEqual(names, ["dead-letter/a.json", "dead-letter/b.json"]);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("pageToken=page2"));
}

// redriveDeadLetterObject: reposts to the persisted channel, then archives
// under dead-letter/done/ and removes the original.
{
  const objects = new Map([
    [
      "dead-letter/0xtx1-0-123.json",
      { channelId: "Calerts", slackMessage: { text: "hi", blocks: [] } },
    ],
  ]);
  const { fetchImpl, slackCalls } = createFakeTransport(objects);

  await redriveDeadLetterObject({
    bucket: BUCKET,
    objectName: "dead-letter/0xtx1-0-123.json",
    slackToken: "xoxb-test",
    accessToken: "token",
    fetchImpl,
  });

  assert.deepEqual(slackCalls, [
    {
      channel: "Calerts",
      text: "hi",
      blocks: [],
      unfurl_links: false,
      unfurl_media: false,
    },
  ]);
  assert.equal(objects.has("dead-letter/0xtx1-0-123.json"), false);
  assert.equal(objects.has("dead-letter/done/0xtx1-0-123.json"), true);
}

// redriveDeadLetterObject: a Slack repost failure must NOT archive the
// object — it stays in place so a later redrive attempt can retry it.
{
  const objects = new Map([
    [
      "dead-letter/0xtx2-0-456.json",
      { channelId: "FAIL_CHANNEL", slackMessage: { text: "hi", blocks: [] } },
    ],
  ]);
  const { fetchImpl } = createFakeTransport(objects);

  await assert.rejects(
    redriveDeadLetterObject({
      bucket: BUCKET,
      objectName: "dead-letter/0xtx2-0-456.json",
      slackToken: "xoxb-test",
      accessToken: "token",
      fetchImpl,
    }),
    /channel_not_found/,
  );

  assert.equal(objects.has("dead-letter/0xtx2-0-456.json"), true);
  assert.equal(objects.has("dead-letter/done/0xtx2-0-456.json"), false);
}

// redriveDeadLetterObject: a done marker already present (copy succeeded,
// delete failed on a prior run) must skip the repost and only retry the
// archive steps.
{
  const objects = new Map([
    [
      "dead-letter/0xtx5-0-1.json",
      { channelId: "Calerts", slackMessage: { text: "hi", blocks: [] } },
    ],
    [
      "dead-letter/done/0xtx5-0-1.json",
      { channelId: "Calerts", slackMessage: { text: "hi", blocks: [] } },
    ],
  ]);
  const { fetchImpl, slackCalls } = createFakeTransport(objects);

  await redriveDeadLetterObject({
    bucket: BUCKET,
    objectName: "dead-letter/0xtx5-0-1.json",
    slackToken: "xoxb-test",
    accessToken: "token",
    fetchImpl,
  });

  assert.deepEqual(slackCalls, []);
  assert.equal(objects.has("dead-letter/0xtx5-0-1.json"), false);
  assert.equal(objects.has("dead-letter/done/0xtx5-0-1.json"), true);
}

// redriveDeadLetterObject: reruns after a delete failure never repost to
// Slack a second time — the done marker from the first attempt's successful
// copy short-circuits every retry until the delete finally succeeds.
{
  const objects = new Map([
    [
      "dead-letter/0xtx6-0-1.json",
      { channelId: "Calerts", slackMessage: { text: "hi", blocks: [] } },
    ],
  ]);
  const { fetchImpl: baseFetch, slackCalls } = createFakeTransport(objects);
  let deleteAttempts = 0;
  const flakyDeleteFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (
      parsed.hostname !== "slack.com" &&
      (init.method ?? "GET") === "DELETE"
    ) {
      deleteAttempts += 1;
      return new Response("boom", { status: 500 });
    }
    return baseFetch(url, init);
  };
  const redrive = () =>
    redriveDeadLetterObject({
      bucket: BUCKET,
      objectName: "dead-letter/0xtx6-0-1.json",
      slackToken: "xoxb-test",
      accessToken: "token",
      fetchImpl: flakyDeleteFetch,
    });

  // First run: copy succeeds, delete fails -> archive rejects, but Slack was
  // reposted once.
  await assert.rejects(redrive(), /HTTP 500/);
  assert.equal(slackCalls.length, 1);
  assert.equal(objects.has("dead-letter/0xtx6-0-1.json"), true);
  assert.equal(objects.has("dead-letter/done/0xtx6-0-1.json"), true);

  // Second run: done marker exists -> repost is skipped; delete still fails.
  await assert.rejects(redrive(), /HTTP 500/);
  assert.equal(slackCalls.length, 1);
  assert.equal(deleteAttempts, 2);

  // Third run: delete finally succeeds -> archive completes, still no
  // duplicate repost.
  await redriveDeadLetterObject({
    bucket: BUCKET,
    objectName: "dead-letter/0xtx6-0-1.json",
    slackToken: "xoxb-test",
    accessToken: "token",
    fetchImpl: baseFetch,
  });
  assert.equal(slackCalls.length, 1);
  assert.equal(objects.has("dead-letter/0xtx6-0-1.json"), false);
}

// main(): end-to-end sweep across a mix of a redrivable and a failing object,
// sourcing the Slack token from env (same as the function) and the GCS
// access token from an injected getAccessToken (standing in for gcloud).
{
  const objects = new Map([
    [
      "dead-letter/0xtx3-0-1.json",
      { channelId: "Calerts", slackMessage: { text: "ok", blocks: [] } },
    ],
    [
      "dead-letter/0xtx4-0-2.json",
      { channelId: "FAIL_CHANNEL", slackMessage: { text: "bad", blocks: [] } },
    ],
  ]);
  const { fetchImpl } = createFakeTransport(objects);

  const result = await main(
    { QUICKNODE_REPLAY_BUCKET: BUCKET, SLACK_BOT_TOKEN: "xoxb-test" },
    { getAccessToken: () => "fake-access-token", fetchImpl },
  );

  assert.deepEqual(result, { redriven: 1, failed: 1 });
  assert.equal(objects.has("dead-letter/done/0xtx3-0-1.json"), true);
  assert.equal(objects.has("dead-letter/0xtx4-0-2.json"), true);
}

// main(): requires the same env sources the function uses.
{
  await assert.rejects(
    main({ SLACK_BOT_TOKEN: "xoxb-test" }, { getAccessToken: () => "token" }),
    /QUICKNODE_REPLAY_BUCKET is required/,
  );
  await assert.rejects(
    main(
      { QUICKNODE_REPLAY_BUCKET: BUCKET },
      { getAccessToken: () => "token" },
    ),
    /SLACK_BOT_TOKEN is required/,
  );
}

// main(): no dead-lettered objects is a clean no-op.
{
  const objects = new Map();
  const { fetchImpl } = createFakeTransport(objects);
  const result = await main(
    { QUICKNODE_REPLAY_BUCKET: BUCKET, SLACK_BOT_TOKEN: "xoxb-test" },
    { getAccessToken: () => "fake-access-token", fetchImpl },
  );
  assert.deepEqual(result, { redriven: 0, failed: 0 });
}

console.log("redrive-onchain-deadletter tests passed");
