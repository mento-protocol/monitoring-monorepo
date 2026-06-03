import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetIntegrationProbeSnapshot } = vi.hoisted(() => ({
  mockGetIntegrationProbeSnapshot: vi.fn(),
}));

vi.mock("@/lib/integration-probes", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/integration-probes")>();
  return {
    ...actual,
    getIntegrationProbeSnapshot: mockGetIntegrationProbeSnapshot,
  };
});

import IntegrationsPage from "../page";

describe("IntegrationsPage", () => {
  beforeEach(() => {
    mockGetIntegrationProbeSnapshot.mockReset();
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
