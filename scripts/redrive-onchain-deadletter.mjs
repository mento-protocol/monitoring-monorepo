#!/usr/bin/env node
/**
 * Redrive tool for the onchain-event-handler dead-letter queue.
 *
 * The Cloud Function (alerts/infra/onchain-event-handler) writes a dead-letter
 * object to GCS (under the "dead-letter/" prefix of the same bucket used for
 * QuickNode nonce replay protection) whenever it exhausts Slack delivery
 * retries for a Safe/multisig alert. This script:
 *
 *   1. Lists undone dead-letter objects (excludes "dead-letter/done/").
 *   2. Reposts each one's rendered Slack payload to its original channel,
 *      using the same SLACK_BOT_TOKEN source as the function itself.
 *   3. Archives successfully-redriven objects to "dead-letter/done/" so a
 *      re-run doesn't repost them.
 *
 * GCS access uses an operator's own gcloud credentials (`gcloud auth
 * print-access-token`) rather than the function's metadata-server token,
 * since this runs off-platform. Requires `gcloud auth login` (see
 * alerts/infra/scripts/check-gcloud-login.sh for the same prerequisite used
 * elsewhere in this repo).
 *
 * Usage:
 *   QUICKNODE_REPLAY_BUCKET=<bucket> SLACK_BOT_TOKEN=<token> \
 *     node scripts/redrive-onchain-deadletter.mjs
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEAD_LETTER_PREFIX = "dead-letter/";
const DEAD_LETTER_DONE_PREFIX = "dead-letter/done/";
const STORAGE_API_BASE = "https://storage.googleapis.com/storage/v1/b";

function defaultGetAccessToken() {
  return execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
  }).trim();
}

function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function parseJsonResponse(response, url) {
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${raw}`);
  }
  return raw ? JSON.parse(raw) : {};
}

/**
 * Lists dead-letter object names, excluding the "done/" archive prefix.
 * Follows GCS list pagination via nextPageToken.
 */
async function listDeadLetterObjects({ bucket, accessToken, fetchImpl }) {
  const objectNames = [];
  let pageToken;

  do {
    const url = new URL(`${STORAGE_API_BASE}/${encodeURIComponent(bucket)}/o`);
    url.searchParams.set("prefix", DEAD_LETTER_PREFIX);
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetchImpl(url, {
      headers: authHeaders(accessToken),
    });
    const body = await parseJsonResponse(response, url);

    for (const item of body.items ?? []) {
      if (!item.name.startsWith(DEAD_LETTER_DONE_PREFIX)) {
        objectNames.push(item.name);
      }
    }

    pageToken = body.nextPageToken;
  } while (pageToken);

  return objectNames;
}

async function getObjectJson({ bucket, objectName, accessToken, fetchImpl }) {
  const url = new URL(
    `${STORAGE_API_BASE}/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`,
  );
  url.searchParams.set("alt", "media");

  const response = await fetchImpl(url, { headers: authHeaders(accessToken) });
  return parseJsonResponse(response, url);
}

async function postToSlack({ slackToken, channel, message, fetchImpl }) {
  const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text: message.text,
      blocks: message.blocks,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  const body = await parseJsonResponse(
    response,
    "https://slack.com/api/chat.postMessage",
  );
  if (body.ok !== true) {
    throw new Error(
      `Slack chat.postMessage failed: ${body.error ?? "unknown"}`,
    );
  }
}

function doneObjectName(objectName) {
  return `${DEAD_LETTER_DONE_PREFIX}${objectName.slice(DEAD_LETTER_PREFIX.length)}`;
}

/**
 * Cheap existence check (metadata GET, no "alt=media" body fetch) for a
 * "dead-letter/done/<name>" object. Used to make redrive idempotent across a
 * partial archive failure from a prior run: if the done copy already
 * exists, the source event was already reposted to Slack, so a rerun must
 * not post it again.
 */
async function doneObjectExists({ bucket, doneName, accessToken, fetchImpl }) {
  const url = new URL(
    `${STORAGE_API_BASE}/${encodeURIComponent(bucket)}/o/${encodeURIComponent(doneName)}`,
  );
  const response = await fetchImpl(url, { headers: authHeaders(accessToken) });
  if (response.status === 404) {
    return false;
  }
  await parseJsonResponse(response, url);
  return true;
}

async function archiveDeadLetterObject({
  bucket,
  objectName,
  accessToken,
  fetchImpl,
}) {
  const doneName = doneObjectName(objectName);
  const copyUrl = new URL(
    `${STORAGE_API_BASE}/${encodeURIComponent(bucket)}/o/${encodeURIComponent(
      objectName,
    )}/copyTo/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(doneName)}`,
  );
  const copyResponse = await fetchImpl(copyUrl, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: "{}",
  });
  await parseJsonResponse(copyResponse, copyUrl);

  const deleteUrl = new URL(
    `${STORAGE_API_BASE}/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`,
  );
  const deleteResponse = await fetchImpl(deleteUrl, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!deleteResponse.ok) {
    const raw = await deleteResponse.text();
    throw new Error(`HTTP ${deleteResponse.status} from ${deleteUrl}: ${raw}`);
  }
}

/**
 * Reposts one dead-lettered event to Slack, then archives it. Archiving only
 * happens after a successful repost — a Slack failure here must leave the
 * object in place so the next redrive attempt can retry it.
 *
 * Idempotent against a partial archive from a prior run (copy to
 * "dead-letter/done/" succeeded but the delete of the original failed): if
 * the done copy already exists, the repost is skipped and only the archive
 * steps (copy + delete) are retried, so a rerun after that kind of partial
 * failure can't post the same alert to Slack a second time.
 */
async function redriveDeadLetterObject({
  bucket,
  objectName,
  slackToken,
  accessToken,
  fetchImpl,
}) {
  const alreadyPosted = await doneObjectExists({
    bucket,
    doneName: doneObjectName(objectName),
    accessToken,
    fetchImpl,
  });

  if (!alreadyPosted) {
    const payload = await getObjectJson({
      bucket,
      objectName,
      accessToken,
      fetchImpl,
    });
    await postToSlack({
      slackToken,
      channel: payload.channelId,
      message: payload.slackMessage,
      fetchImpl,
    });
  }

  await archiveDeadLetterObject({ bucket, objectName, accessToken, fetchImpl });
}

async function main(
  env = process.env,
  { getAccessToken = defaultGetAccessToken, fetchImpl = fetch } = {},
) {
  const bucket = env.QUICKNODE_REPLAY_BUCKET;
  if (!bucket) {
    throw new Error("QUICKNODE_REPLAY_BUCKET is required");
  }
  const slackToken = env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    throw new Error("SLACK_BOT_TOKEN is required");
  }

  const accessToken = getAccessToken();
  const objectNames = await listDeadLetterObjects({
    bucket,
    accessToken,
    fetchImpl,
  });

  if (objectNames.length === 0) {
    console.log("No dead-lettered events to redrive.");
    return { redriven: 0, failed: 0 };
  }

  let redriven = 0;
  let failed = 0;
  for (const objectName of objectNames) {
    try {
      // Sequential, low-volume redrive sweep — parallelizing risks Slack rate limits.
      await redriveDeadLetterObject({
        bucket,
        objectName,
        slackToken,
        accessToken,
        fetchImpl,
      });
      console.log(`Redrove ${objectName}`);
      redriven += 1;
    } catch (error) {
      console.error(`Failed to redrive ${objectName}: ${error.message}`);
      failed += 1;
    }
  }

  console.log(
    `Redrove ${redriven}/${objectNames.length} dead-lettered event(s); ${failed} failed.`,
  );
  return { redriven, failed };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then(({ failed }) => {
      if (failed > 0) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

export {
  archiveDeadLetterObject,
  getObjectJson,
  listDeadLetterObjects,
  main,
  postToSlack,
  redriveDeadLetterObject,
};
