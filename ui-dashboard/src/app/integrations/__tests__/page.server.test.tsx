import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetIntegrationProbeSnapshot, mockGetAuthSession, mockNotFound } =
  vi.hoisted(() => ({
    mockGetIntegrationProbeSnapshot: vi.fn(),
    mockGetAuthSession: vi.fn(),
    mockNotFound: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    }),
  }));

vi.mock("@/lib/integration-probes", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/integration-probes")>();
  return {
    ...actual,
    getIntegrationProbeSnapshot: mockGetIntegrationProbeSnapshot,
  };
});

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  getAuthSession: mockGetAuthSession,
}));

vi.mock("next/navigation", () => ({ notFound: mockNotFound }));

import IntegrationsPage from "../page";

describe("IntegrationsPage", () => {
  beforeEach(() => {
    mockGetIntegrationProbeSnapshot.mockReset();
    mockNotFound.mockClear();
    // Default to an authorized maintainer session so the render tests below
    // exercise the snapshot states past the auth guard.
    mockGetAuthSession.mockReset();
    mockGetAuthSession.mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
  });

  it("returns notFound for an unauthenticated visitor (never reads the snapshot)", async () => {
    mockGetAuthSession.mockResolvedValue(null);
    await expect(IntegrationsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
    expect(mockGetIntegrationProbeSnapshot).not.toHaveBeenCalled();
  });

  it("returns notFound for a session outside the maintainer Workspace", async () => {
    mockGetAuthSession.mockResolvedValue({
      user: { email: "intruder@example.com" },
    });
    await expect(IntegrationsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetIntegrationProbeSnapshot).not.toHaveBeenCalled();
  });

  it("renders an empty state before the first snapshot is published", async () => {
    mockGetIntegrationProbeSnapshot.mockResolvedValue({
      snapshot: null,
      error: null,
    });

    const html = renderToStaticMarkup(await IntegrationsPage());

    expect(html).toContain("No integration probe snapshot");
  });

  it("renders Redis read errors without throwing", async () => {
    mockGetIntegrationProbeSnapshot.mockResolvedValue({
      snapshot: null,
      error: "Redis offline",
    });

    const html = renderToStaticMarkup(await IntegrationsPage());

    expect(html).toContain("Integration probes unavailable");
    expect(html).toContain("Redis offline");
    expect(html).not.toContain("No integration probe snapshot");
  });
});
