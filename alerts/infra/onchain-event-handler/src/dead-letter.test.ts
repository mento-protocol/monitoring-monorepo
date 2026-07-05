import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickNodeDecodedLog } from "./types";

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock("./logger", () => ({
  logger: {
    error: loggerMocks.error,
  },
}));

const originalReplayBucket = process.env.QUICKNODE_REPLAY_BUCKET;

const LOG_ENTRY: QuickNodeDecodedLog = {
  address: "0x123",
  name: "AddedOwner",
  transactionHash: "0xtx1",
  blockHash: "0xblock1",
  blockNumber: "100",
  logIndex: "0",
};

const SLACK_MESSAGE = { text: "hello", blocks: [] };

const metadataTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

function metadataTokenResponse(): Response {
  return new Response(
    JSON.stringify({ access_token: "metadata-token", expires_in: 300 }),
    { status: 200, statusText: "OK" },
  );
}

function uploadResponse(status = 200, statusText = "OK"): Response {
  return new Response("{}", { status, statusText });
}

async function loadWriteDeadLetter() {
  vi.resetModules();
  return (await import("./dead-letter")).writeDeadLetter;
}

describe("writeDeadLetter", () => {
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

  it("logs ERROR and does not throw when the bucket is not configured", async () => {
    delete process.env.QUICKNODE_REPLAY_BUCKET;
    const fetchMock = vi.fn<typeof fetch>();
    const writeDeadLetter = await loadWriteDeadLetter();

    await expect(
      writeDeadLetter(
        {
          logEntry: LOG_ENTRY,
          slackMessage: SLACK_MESSAGE,
          multisigKey: "SOLO_CELO",
          channelId: "Calerts",
          chain: "celo",
          failureReason: "Slack postMessage failed after all retries",
        },
        { fetchImpl: fetchMock },
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerMocks.error).toHaveBeenCalledWith("Dead-letter write failed", {
      reason: "dead_letter_bucket_not_configured",
      transactionHash: "0xtx1",
    });
  });

  it("uploads the rendered payload under the dead-letter/ prefix and logs the distinct marker", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadataTokenResponse())
      .mockResolvedValueOnce(uploadResponse());
    const writeDeadLetter = await loadWriteDeadLetter();

    await writeDeadLetter(
      {
        logEntry: LOG_ENTRY,
        slackMessage: SLACK_MESSAGE,
        multisigKey: "SOLO_CELO",
        channelId: "Calerts",
        chain: "celo",
        failureReason: "Slack postMessage failed after all retries",
      },
      { fetchImpl: fetchMock },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual([
      metadataTokenUrl,
      { headers: { "metadata-flavor": "Google" } },
    ]);

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1];
    expect(String(uploadUrl)).toMatch(
      /^https:\/\/storage\.googleapis\.com\/upload\/storage\/v1\/b\/replay-bucket\/o\?uploadType=media&name=dead-letter%2F0xtx1-0-\d+\.json$/,
    );
    expect(uploadInit).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer metadata-token",
        "content-type": "application/json",
      },
    });

    const body = JSON.parse(uploadInit?.body as string);
    expect(body).toMatchObject({
      failureReason: "Slack postMessage failed after all retries",
      eventName: "AddedOwner",
      transactionHash: "0xtx1",
      chain: "celo",
      multisigKey: "SOLO_CELO",
      channelId: "Calerts",
      logEntry: LOG_ENTRY,
      slackMessage: SLACK_MESSAGE,
    });
    expect(typeof body.deadLetteredAt).toBe("string");

    // Never persist the Slack bot token into the dead-letter object.
    expect(JSON.stringify(body)).not.toMatch(/xoxb/);

    expect(loggerMocks.error).toHaveBeenCalledWith(
      "Dead-lettered Safe alert after Slack delivery failure",
      expect.objectContaining({
        reason: "dead_lettered",
        transactionHash: "0xtx1",
        eventName: "AddedOwner",
        chain: "celo",
        multisigKey: "SOLO_CELO",
        channelId: "Calerts",
        failureReason: "Slack postMessage failed after all retries",
      }),
    );
  });

  it("logs ERROR and does not throw when the upload response is not ok", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadataTokenResponse())
      .mockResolvedValueOnce(uploadResponse(500, "Internal Server Error"));
    const writeDeadLetter = await loadWriteDeadLetter();

    await expect(
      writeDeadLetter(
        {
          logEntry: LOG_ENTRY,
          slackMessage: SLACK_MESSAGE,
          multisigKey: "SOLO_CELO",
          channelId: "Calerts",
          chain: "celo",
          failureReason: "Slack postMessage failed after all retries",
        },
        { fetchImpl: fetchMock },
      ),
    ).resolves.toBeUndefined();

    expect(loggerMocks.error).toHaveBeenCalledWith("Dead-letter write failed", {
      reason: "dead_letter_write_failed",
      status: 500,
      statusText: "Internal Server Error",
      transactionHash: "0xtx1",
    });
  });

  it("logs ERROR and does not throw when the write is aborted via signal", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      if ((init as RequestInit | undefined)?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return metadataTokenResponse();
    });
    const writeDeadLetter = await loadWriteDeadLetter();

    await expect(
      writeDeadLetter(
        {
          logEntry: LOG_ENTRY,
          slackMessage: SLACK_MESSAGE,
          multisigKey: "SOLO_CELO",
          channelId: "Calerts",
          chain: "celo",
          failureReason: "Slack postMessage failed after all retries",
        },
        { fetchImpl: fetchMock, signal: abortController.signal },
      ),
    ).resolves.toBeUndefined();

    expect(loggerMocks.error).toHaveBeenCalledWith("Dead-letter write failed", {
      reason: "dead_letter_write_failed",
      error: "The operation was aborted.",
      transactionHash: "0xtx1",
    });
  });

  it("logs ERROR and does not throw when the fetch itself rejects", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network unreachable"));
    const writeDeadLetter = await loadWriteDeadLetter();

    await expect(
      writeDeadLetter(
        {
          logEntry: LOG_ENTRY,
          slackMessage: SLACK_MESSAGE,
          multisigKey: "SOLO_CELO",
          channelId: "Calerts",
          chain: "celo",
          failureReason: "Slack postMessage failed after all retries",
        },
        { fetchImpl: fetchMock },
      ),
    ).resolves.toBeUndefined();

    expect(loggerMocks.error).toHaveBeenCalledWith("Dead-letter write failed", {
      reason: "dead_letter_write_failed",
      error: "network unreachable",
      transactionHash: "0xtx1",
    });
  });
});
