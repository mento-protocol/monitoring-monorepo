import type { Request, Response } from "@google-cloud/functions-framework";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleRotation: vi.fn(),
  logger: {
    error: vi.fn(),
  },
}));

vi.mock("./config", () => ({ default: {} }));
vi.mock("./logger", () => ({ logger: mocks.logger }));
vi.mock("./rotation", () => ({ handleRotation: mocks.handleRotation }));

function request(method: string): Request {
  return { method } as Request;
}

function response(): Response {
  const res = {
    json: vi.fn(),
    send: vi.fn(),
    status: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res as unknown as Response;
}

describe("handleOncallRotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handleRotation.mockResolvedValue({
      announced: true,
      changed: true,
      current: { username: "chapati" },
      slackUserId: "UCHAPATI",
    });
  });

  it("serves a health check on GET", async () => {
    const { handleOncallRotation } = await import("./index");
    const res = response();

    await handleOncallRotation(request("GET"), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      service: "oncall-announcer",
    });
    expect(mocks.handleRotation).not.toHaveBeenCalled();
  });

  it("runs the rotation check on POST", async () => {
    const { handleOncallRotation } = await import("./index");
    const res = response();

    await handleOncallRotation(request("POST"), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      announced: true,
      changed: true,
      slackUserId: "UCHAPATI",
      victoropsUsername: "chapati",
    });
  });

  it("returns 500 when rotation handling fails", async () => {
    mocks.handleRotation.mockRejectedValue(new Error("boom"));
    const { handleOncallRotation } = await import("./index");
    const res = response();

    await handleOncallRotation(request("POST"), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith("Internal Server Error");
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "Failed to handle on-call rotation",
      expect.any(Object),
    );
  });
});
