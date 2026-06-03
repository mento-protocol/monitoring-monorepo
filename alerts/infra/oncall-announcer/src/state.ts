import type { AppConfig } from "./config";
import type { RotationState } from "./types";

interface MetadataToken {
  access_token?: string;
  expires_in?: number;
}

let cachedAccessToken:
  | {
      expiresAtMs: number;
      token: string;
    }
  | undefined;

async function getAccessToken(fetchImpl: typeof fetch): Promise<string> {
  if (
    cachedAccessToken &&
    cachedAccessToken.expiresAtMs > Date.now() + 60_000
  ) {
    return cachedAccessToken.token;
  }

  const response = await fetchImpl(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    {
      headers: {
        "Metadata-Flavor": "Google",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch metadata access token: ${response.status}`,
    );
  }

  const data = (await response.json()) as MetadataToken;
  if (!data.access_token) {
    throw new Error("Metadata token response did not include access_token");
  }

  cachedAccessToken = {
    expiresAtMs: Date.now() + Math.max(data.expires_in ?? 300, 60) * 1000,
    token: data.access_token,
  };
  return data.access_token;
}

function objectPath(config: AppConfig): string {
  return encodeURIComponent(config.state.object);
}

export async function readRotationState(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RotationState | undefined> {
  const token = await getAccessToken(fetchImpl);
  const response = await fetchImpl(
    `https://storage.googleapis.com/storage/v1/b/${config.state.bucket}/o/${objectPath(
      config,
    )}?alt=media`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(`Failed to read on-call state: ${response.status}`);
  }

  return (await response.json()) as RotationState;
}

export async function writeRotationState(
  state: RotationState,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const token = await getAccessToken(fetchImpl);
  const response = await fetchImpl(
    `https://storage.googleapis.com/upload/storage/v1/b/${
      config.state.bucket
    }/o?uploadType=media&name=${objectPath(config)}`,
    {
      body: JSON.stringify(state),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to write on-call state: ${response.status}`);
  }
}

export function resetStateTokenCacheForTests(): void {
  cachedAccessToken = undefined;
}
