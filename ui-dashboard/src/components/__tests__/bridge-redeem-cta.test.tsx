/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  BridgeRedeemPill,
  type AddToast,
  waitForTransaction,
} from "@/components/bridge-redeem-cta";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderPill(addToast: AddToast) {
  act(() => {
    root.render(
      <BridgeRedeemPill
        sentTxHash={"0x" + "a".repeat(64)}
        destChainId={143}
        tokenSymbol="USDm"
        addToast={addToast}
      />,
    );
  });
}

describe("BridgeRedeemPill", () => {
  it("returns to idle and shows an error when VAA fetch times out", async () => {
    const addToast = vi.fn<AddToast>();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation timed out.", "AbortError"),
    );
    renderPill(addToast);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
      await Promise.resolve();
    });

    expect(container.querySelector("button")?.textContent).toContain("redeem");
    expect(addToast).toHaveBeenCalledWith(
      "Redeem request timed out. Try again.",
      "error",
    );
  });

  it("treats receipt request timeout as retryable polling work", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { status: "0x1" } }), {
          headers: { "content-type": "application/json" },
        }),
      );

    const resultPromise = waitForTransaction(
      "0x" + "b".repeat(64),
      "https://rpc.example",
      new AbortController().signal,
    );
    await vi.runOnlyPendingTimersAsync();
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: "0x1" });
  });

  it("stops receipt polling at the 90-second wall-clock deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_, init) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (!signal) return Promise.reject(new Error("missing signal"));
        return new Promise<Response>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      });

    const resultPromise = waitForTransaction(
      "0x" + "c".repeat(64),
      "https://rpc.example",
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(90_000);
    await expect(resultPromise).resolves.toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThan(12);
  });
});
