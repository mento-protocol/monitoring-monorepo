import { createHash } from "node:crypto";
import type { AppConfig } from "./config";
import { logger } from "./logger";
import {
  lookupSlackUserByEmail,
  postOncallAnnouncement,
  updateSupportUsergroup,
} from "./slack";
import { readRotationState, writeRotationState } from "./state";
import type {
  CurrentOncall,
  RotationResult,
  RotationState,
  SlackUser,
} from "./types";
import { fetchCurrentOncall, fetchOncallUserEmail } from "./victorops";

export interface RotationDependencies {
  fetchCurrentOncall: (config: AppConfig) => Promise<CurrentOncall>;
  fetchOncallUserEmail: (
    username: string,
    config: AppConfig,
  ) => Promise<string | undefined>;
  lookupSlackUserByEmail: (
    email: string,
    config: AppConfig,
  ) => Promise<SlackUser>;
  now: () => Date;
  postOncallAnnouncement: (
    slackUserId: string,
    username: string,
    config: AppConfig,
    clientMsgId: string,
  ) => Promise<void>;
  readRotationState: (config: AppConfig) => Promise<RotationState | undefined>;
  updateSupportUsergroup: (
    slackUserId: string,
    config: AppConfig,
  ) => Promise<void>;
  writeRotationState: (
    state: RotationState,
    config: AppConfig,
  ) => Promise<void>;
}

const defaultDependencies: RotationDependencies = {
  fetchCurrentOncall,
  fetchOncallUserEmail,
  lookupSlackUserByEmail,
  now: () => new Date(),
  postOncallAnnouncement,
  readRotationState,
  updateSupportUsergroup,
  writeRotationState,
};

export async function handleRotation(
  config: AppConfig,
  dependencies: RotationDependencies = defaultDependencies,
): Promise<RotationResult> {
  const current = await dependencies.fetchCurrentOncall(config);
  const previous = await dependencies.readRotationState(config);
  const sameVictoropsUser = previous?.victoropsUsername === current.username;
  const previousSlackUserId =
    typeof previous?.slackUserId === "string"
      ? previous.slackUserId
      : undefined;

  if (
    sameVictoropsUser &&
    // Defensive against manually edited or truncated GCS state. If the Slack
    // user ID is missing, rebuild state from Splunk On-Call instead of
    // trusting a typed-but-corrupt object.
    previousSlackUserId !== undefined &&
    previousSlackUserId.length > 0
  ) {
    await dependencies.updateSupportUsergroup(previousSlackUserId, config);
    logger.info("On-call engineer unchanged", {
      slackUserId: previousSlackUserId,
      victoropsUsername: current.username,
    });
    return {
      announced: false,
      changed: false,
      current,
      previous,
      slackUserId: previousSlackUserId,
    };
  }

  const email =
    nonBlank(current.email) ??
    nonBlank(await dependencies.fetchOncallUserEmail(current.username, config));
  if (!email) {
    throw new Error(
      `No email found for Splunk On-Call user ${current.username}`,
    );
  }

  const slackUser = await dependencies.lookupSlackUserByEmail(email, config);
  await dependencies.updateSupportUsergroup(slackUser.id, config);

  const shouldAnnounce =
    !sameVictoropsUser && (previous !== undefined || config.announceOnFirstRun);
  if (shouldAnnounce) {
    await dependencies.postOncallAnnouncement(
      slackUser.id,
      current.username,
      config,
      announcementClientMsgId(current, previous, slackUser.id),
    );
  }

  const nextState: RotationState = {
    email,
    escalationPolicySlug: current.escalationPolicySlug,
    slackUserId: slackUser.id,
    teamSlug: current.teamSlug,
    updatedAt: dependencies.now().toISOString(),
    victoropsUsername: current.username,
  };
  await dependencies.writeRotationState(nextState, config);

  logger.info("On-call rotation handled", {
    announced: shouldAnnounce,
    previousVictoropsUsername: previous?.victoropsUsername,
    slackUserId: slackUser.id,
    victoropsUsername: current.username,
  });

  return {
    announced: shouldAnnounce,
    changed: !sameVictoropsUser,
    current,
    previous,
    slackUserId: slackUser.id,
  };
}

function announcementClientMsgId(
  current: CurrentOncall,
  previous: RotationState | undefined,
  slackUserId: string,
): string {
  const hash = createHash("sha256")
    .update(
      [
        "support-engineer-rotation",
        previous?.victoropsUsername ?? "",
        current.username,
        current.teamSlug ?? "",
        current.escalationPolicySlug ?? "",
        slackUserId,
      ].join("\0"),
    )
    .digest("hex");

  const variant = ((Number.parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, "0");

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${variant}${hash.slice(18, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}
