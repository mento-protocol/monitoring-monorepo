import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./logger", () => ({
  logger: {
    error: loggerMocks.error,
    warn: loggerMocks.warn,
  },
}));

const originalReplayBucket = process.env.QUICKNODE_REPLAY_BUCKET;
const metadataTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

function metadataTokenResponse(
  body: Record<string, unknown> = {
    access_token: "metadata-token",
    expires_in: 300,
  },
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
  });
}

function response(status = 200, statusText = "OK"): Response {
  return new Response("{}", { status, statusText });
}

async function loadReserveQuickNodeNonce() {
  vi.resetModules();
  return (await import("./quicknode-replay-protection")).reserveQuickNodeNonce;
}

function nonceHash(nonce: string, timestamp: string): string {
  return crypto
    .createHash("sha256")
    .update(`${timestamp}:${nonce}`)
    .digest("hex");
}

describe("reserveQuickNodeNonce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.QUICKNODE_REPLAY_BUCKET = "replay-bucket";
  });

  afterEach(() => {
    if (originalReplayBucket === undefined) {
      delete process.env.QUICKNODE_REPLAY_BUCKET;
    } else {
      process.env.QUICKNODE_REPLAY_BUCKET = originalReplayBucket;
    }
    vi.resetModules();
  });

  it("returns a server error without calling metadata when the replay bucket is missing", async () => {
    delete process.env.QUICKNODE_REPLAY_BUCKET;
    const fetchMock = vi.fn<typeof fetch>();
    const reserveQuickNodeNonce = await loadReserveQuickNodeNonce();

    await expect(
      reserveQuickNodeNonce("nonce-1", "1700000000", {
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      valid: false,
      status: 500,
      message: "Server configuration error",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      "QUICKNODE_REPLAY_BUCKET is not configured",
    );
  });

  it("reserves a nonce by writing a conditional object to the replay bucket", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadataTokenResponse())
      .mockResolvedValueOnce(response());
    const reserveQuickNodeNonce = await loadReserveQuickNodeNonce();

    await expect(
      reserveQuickNodeNonce("nonce-1", "1700000000", {
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ valid: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual([
      metadataTokenUrl,
      {
        headers: {
          "metadata-flavor": "Google",
        },
      },
    ]);

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1];
    const expectedHash = nonceHash("nonce-1", "1700000000");
    expect(String(uploadUrl)).toBe(
      `https://storage.googleapis.com/upload/storage/v1/b/replay-bucket/o?uploadType=media&name=quicknode-replay-nonces%2F1700000000%2F${expectedHash}.json&ifGenerationMatch=0`,
    );
    expect(uploadInit).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer metadata-token",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(uploadInit?.body as string)).toMatchObject({
      timestamp: "1700000000",
      nonceHash: expectedHash,
    });
  });

  it("acknowledges a duplicate nonce when the conditional upload already exists", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadataTokenResponse())
      .mockResolvedValueOnce(response(412, "Precondition Failed"));
    const reserveQuickNodeNonce = await loadReserveQuickNodeNonce();

    await expect(
      reserveQuickNodeNonce("nonce-1", "1700000000", {
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      valid: false,
      status: 200,
      message: "Duplicate webhook nonce already processed",
      replayed: true,
    });

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "Rejected replayed QuickNode webhook nonce",
      {
        timestamp: "1700000000",
        nonceHash: nonceHash("nonce-1", "1700000000"),
      },
    );
  });

  it("returns a server error when the conditional upload fails", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadataTokenResponse())
      .mockResolvedValueOnce(response(503, "Service Unavailable"));
    const reserveQuickNodeNonce = await loadReserveQuickNodeNonce();

    await expect(
      reserveQuickNodeNonce("nonce-1", "1700000000", {
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      valid: false,
      status: 500,
      message: "Server configuration error",
    });

    expect(loggerMocks.error).toHaveBeenCalledWith(
      "Failed to reserve QuickNode webhook nonce",
      {
        status: 503,
        statusText: "Service Unavailable",
        timestamp: "1700000000",
        nonceHash: nonceHash("nonce-1", "1700000000"),
      },
    );
  });

  it("returns a server error when metadata token retrieval fails", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(500, "Metadata Unavailable"));
    const reserveQuickNodeNonce = await loadReserveQuickNodeNonce();

    await expect(
      reserveQuickNodeNonce("nonce-1", "1700000000", {
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      valid: false,
      status: 500,
      message: "Server configuration error",
    });

    expect(loggerMocks.error).toHaveBeenCalledWith(
      "QuickNode replay protection failed",
      {
        error: "metadata token request failed: 500 Metadata Unavailable",
        timestamp: "1700000000",
        nonceHash: nonceHash("nonce-1", "1700000000"),
      },
    );
  });

  it("returns a server error when the metadata response is missing an access token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadataTokenResponse({ expires_in: 300 }));
    const reserveQuickNodeNonce = await loadReserveQuickNodeNonce();

    await expect(
      reserveQuickNodeNonce("nonce-1", "1700000000", {
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      valid: false,
      status: 500,
      message: "Server configuration error",
    });

    expect(loggerMocks.error).toHaveBeenCalledWith(
      "QuickNode replay protection failed",
      {
        error: "metadata token response did not include access_token",
        timestamp: "1700000000",
        nonceHash: nonceHash("nonce-1", "1700000000"),
      },
    );
  });

  it("reuses a fresh metadata token for multiple nonce reservations", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadataTokenResponse())
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response());
    const reserveQuickNodeNonce = await loadReserveQuickNodeNonce();

    await expect(
      reserveQuickNodeNonce("nonce-1", "1700000000", {
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ valid: true });
    await expect(
      reserveQuickNodeNonce("nonce-2", "1700000001", {
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ valid: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(metadataTokenUrl);
    expect(String(fetchMock.mock.calls[1][0])).toContain("nonce");
    expect(String(fetchMock.mock.calls[2][0])).toContain("nonce");
  });
});
