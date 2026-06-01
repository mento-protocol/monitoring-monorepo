/** @vitest-environment jsdom */

import { renderToStaticMarkup } from "react-dom/server";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isWeekend } from "@/lib/weekend";
import { useIsWeekend } from "../use-is-weekend";

vi.mock("@/lib/weekend", () => ({ isWeekend: vi.fn() }));
const mockIsWeekend = vi.mocked(isWeekend);

async function renderOnClient(): Promise<boolean | undefined> {
  let captured: boolean | undefined;
  function Probe(): null {
    captured = useIsWeekend();
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe));
  });
  await act(async () => {
    root.unmount();
  });
  return captured;
}

describe("useIsWeekend", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders false on the server even when it IS the weekend (SSR-safe)", () => {
    // getServerSnapshot is () => false, so the server HTML and the client's
    // hydration render agree — weekend-dependent UI can't cause a hydration
    // mismatch regardless of the server's day or a stale cached payload.
    mockIsWeekend.mockReturnValue(true);
    function SsrProbe(): ReactNode {
      return createElement("span", null, String(useIsWeekend()));
    }
    expect(renderToStaticMarkup(createElement(SsrProbe))).toBe(
      "<span>false</span>",
    );
  });

  it("returns the real isWeekend() value on the client", async () => {
    mockIsWeekend.mockReturnValue(true);
    expect(await renderOnClient()).toBe(true);
  });

  it("returns false on the client on a weekday", async () => {
    mockIsWeekend.mockReturnValue(false);
    expect(await renderOnClient()).toBe(false);
  });
});
