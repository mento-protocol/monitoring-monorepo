import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @google-cloud/secret-manager before importing the module under test
const mockAccessSecretVersion = vi.fn();
vi.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: vi.fn().mockImplementation(function () {
    return { accessSecretVersion: mockAccessSecretVersion };
  }),
}));

// Mock config to avoid env-schema validation during tests
vi.mock("../../config.js", () => ({
  default: { GCP_PROJECT_ID: "test-project" },
}));

describe("get-secret", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns the secret value from Secret Manager", async () => {
    mockAccessSecretVersion.mockResolvedValueOnce([
      { payload: { data: Buffer.from("my-secret-value") } },
    ]);

    // Dynamic import so module-level singleton is re-created per test
    const { default: getSecret } = await import("../get-secret.js");
    const result = await getSecret("my-secret-id");

    expect(result).toBe("my-secret-value");
    expect(mockAccessSecretVersion).toHaveBeenCalledWith({
      name: "projects/test-project/secrets/my-secret-id/versions/latest",
    });
  });

  it("calls Secret Manager on every invocation (no value caching)", async () => {
    mockAccessSecretVersion.mockResolvedValue([
      { payload: { data: Buffer.from("secret-v1") } },
    ]);

    const { default: getSecret } = await import("../get-secret.js");

    await getSecret("my-secret-id");
    await getSecret("my-secret-id");
    await getSecret("my-secret-id");

    // Must call Secret Manager each time so secret rotation takes effect immediately
    expect(mockAccessSecretVersion).toHaveBeenCalledTimes(3);
  });

  it("reuses the singleton SecretManagerServiceClient across calls (no gRPC leak)", async () => {
    const { SecretManagerServiceClient } = await import(
      "@google-cloud/secret-manager"
    );
    mockAccessSecretVersion.mockResolvedValue([
      { payload: { data: Buffer.from("value") } },
    ]);

    const { default: getSecret } = await import("../get-secret.js");

    await getSecret("secret-a");
    await getSecret("secret-b");
    await getSecret("secret-c");

    // Client must be constructed exactly once at module load — not once per call
    expect(SecretManagerServiceClient).toHaveBeenCalledTimes(1);
  });

  it("throws when the secret payload is empty", async () => {
    mockAccessSecretVersion.mockResolvedValueOnce([
      { payload: { data: null } },
    ]);

    const { default: getSecret } = await import("../get-secret.js");

    await expect(getSecret("empty-secret")).rejects.toThrow(
      "Secret 'empty-secret' is empty or undefined",
    );
  });

  it("throws when Secret Manager returns an error", async () => {
    mockAccessSecretVersion.mockRejectedValueOnce(
      new Error("Permission denied"),
    );

    const { default: getSecret } = await import("../get-secret.js");

    await expect(getSecret("bad-secret")).rejects.toThrow("Permission denied");
  });
});
