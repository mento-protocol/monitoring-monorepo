/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import useSWR from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataFreshnessBanner } from "@/components/data-freshness-banner";
import { SwrProvider } from "@/components/swr-provider";
import { resetSWRFreshnessForTests } from "@/lib/swr-freshness";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const NOW = 1_767_225_600_000;

let container: HTMLDivElement;
let root: Root;

type TriggerRef = {
  current: (() => Promise<unknown>) | null;
};

type FallbackPayload = {
  ready: boolean;
};

function FallbackDataProbe({ triggerRef }: { triggerRef: TriggerRef }) {
  const { data, mutate } = useSWR<FallbackPayload>(
    "fallback-freshness-key",
    async () => {
      throw new Error("first refresh failed");
    },
    {
      fallbackData: { ready: true },
      refreshInterval: 30_000,
      revalidateOnMount: false,
      shouldRetryOnError: false,
    },
  );
  triggerRef.current = () => mutate();

  return (
    <>
      <DataFreshnessBanner />
      <div>{data?.ready ? "fallback ready" : "missing"}</div>
    </>
  );
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetSWRFreshnessForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  resetSWRFreshnessForTests();
  container.remove();
  vi.useRealTimers();
});

describe("SwrProvider freshness tracking", () => {
  it("seeds fallback data as last-good data before the first refresh fails", async () => {
    const triggerRef: TriggerRef = { current: null };

    act(() => {
      root.render(
        <SwrProvider>
          <FallbackDataProbe triggerRef={triggerRef} />
        </SwrProvider>,
      );
    });

    expect(container.textContent).toContain("fallback ready");
    expect(container.textContent).not.toContain("Latest refresh failed");

    await act(async () => {
      vi.setSystemTime(NOW + 1_000);
      await triggerRef.current?.().catch(() => undefined);
    });

    expect(container.textContent).toContain("Latest refresh failed");
    expect(container.textContent).toContain("last-good data from 1s ago");
  });
});
