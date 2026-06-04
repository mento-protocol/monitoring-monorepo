import type { AppConfig } from "./config";
import type {
  CurrentOncall,
  VictorOpsOncallResponse,
  VictorOpsUserEntry,
  VictorOpsUsersResponse,
} from "./types";

class SplunkOnCallError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SplunkOnCallError";
  }
}

function apiHeaders(config: AppConfig): HeadersInit {
  return {
    "X-VO-Api-Id": config.splunkOnCall.apiId,
    "X-VO-Api-Key": config.splunkOnCall.apiKey,
  };
}

function apiUrl(config: AppConfig, path: string): string {
  return `${config.splunkOnCall.apiBaseUrl.replace(/\/+$/, "")}${path}`;
}

async function readJson<T>(
  config: AppConfig,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(apiUrl(config, path), {
    headers: apiHeaders(config),
  });

  if (!response.ok) {
    throw new SplunkOnCallError(
      `Splunk On-Call API error: ${response.statusText}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

export async function fetchCurrentOncall(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<CurrentOncall> {
  const data = await readJson<VictorOpsOncallResponse>(
    config,
    "/api-public/v1/oncall/current",
    fetchImpl,
  );

  const teams = data.teamsOnCall ?? [];
  const teamEntry =
    config.splunkOnCall.teamSlug === undefined
      ? teams[0]
      : teams.find(
          (entry) => entry.team?.slug === config.splunkOnCall.teamSlug,
        );

  if (!teamEntry) {
    throw new SplunkOnCallError(
      config.splunkOnCall.teamSlug
        ? `No on-call team found for slug ${config.splunkOnCall.teamSlug}`
        : "No on-call team found",
    );
  }

  const oncallEntries = teamEntry.oncallNow ?? [];
  const oncallEntry =
    config.splunkOnCall.escalationPolicySlug === undefined
      ? oncallEntries[0]
      : oncallEntries.find(
          (entry) =>
            entry.escalationPolicy?.slug ===
            config.splunkOnCall.escalationPolicySlug,
        );

  if (!oncallEntry) {
    throw new SplunkOnCallError(
      config.splunkOnCall.escalationPolicySlug
        ? `No on-call schedule found for escalation policy ${config.splunkOnCall.escalationPolicySlug}`
        : "No on-call schedule found",
    );
  }

  const user = oncallEntry.users?.[0]
    ? currentUserFromEntry(oncallEntry.users[0])
    : undefined;
  if (!user?.username) {
    throw new SplunkOnCallError("No on-call user found");
  }

  return {
    email: user.email,
    escalationPolicyName: oncallEntry.escalationPolicy?.name,
    escalationPolicySlug: oncallEntry.escalationPolicy?.slug,
    teamName: teamEntry.team?.name,
    teamSlug: teamEntry.team?.slug,
    username: user.username,
  };
}

function currentUserFromEntry(
  userEntry: VictorOpsUserEntry,
): { email?: string; username?: string } | undefined {
  return userEntry.onCallUser ?? userEntry.onCalluser;
}

export async function fetchOncallUserEmail(
  username: string,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const data = await readJson<VictorOpsUsersResponse>(
    config,
    "/api-public/v1/user",
    fetchImpl,
  );

  return data.users?.find((user) => user.username === username)?.email;
}
