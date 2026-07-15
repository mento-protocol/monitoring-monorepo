/** @vitest-environment jsdom */

import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { act, createElement, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWeekend } from "@/lib/weekend";
import { useIsWeekend } from "../use-is-weekend";

vi.mock("@/lib/weekend", () => ({ isWeekend: vi.fn() }));
const mockIsWeekend = vi.mocked(isWeekend);
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let previousActEnvironment: boolean | undefined;

function Probe({ initialIsWeekend = false }: { initialIsWeekend?: boolean }) {
  return createElement("span", null, String(useIsWeekend(initialIsWeekend)));
}

async function renderOnClient(
  initialIsWeekend = false,
): Promise<boolean | undefined> {
  let captured: boolean | undefined;
  function Probe(): null {
    captured = useIsWeekend(initialIsWeekend);
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
  beforeEach(() => {
    previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mockIsWeekend.mockReset();
    mockIsWeekend.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment ?? false;
    document.body.replaceChildren();
  });

  it.each([
    [true, "<span>true</span>"],
    [false, "<span>false</span>"],
  ])("renders the seeded %s snapshot on the server", (initial, expected) => {
    expect(
      renderToStaticMarkup(createElement(Probe, { initialIsWeekend: initial })),
    ).toBe(expected);
    expect(mockIsWeekend).not.toHaveBeenCalled();
  });

  it.each([
    { initial: true, live: false },
    { initial: false, live: true },
  ])(
    "hydrates the exact $initial server snapshot before switching to live $live",
    async ({ initial, live }) => {
      const serverHtml = renderToString(
        createElement(Probe, { initialIsWeekend: initial }),
      );
      const container = document.createElement("div");
      container.innerHTML = serverHtml;
      document.body.appendChild(container);
      expect(container.textContent).toBe(String(initial));

      mockIsWeekend.mockReturnValue(live);
      const clientSnapshots: boolean[] = [];
      function HydrationProbe(): ReactNode {
        const snapshot = useIsWeekend(initial);
        clientSnapshots.push(snapshot);
        return createElement("span", null, String(snapshot));
      }

      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      let root: Root | null = null;
      try {
        await act(async () => {
          root = hydrateRoot(container, createElement(HydrationProbe));
          await Promise.resolve();
        });

        expect(consoleError).not.toHaveBeenCalled();
        expect(clientSnapshots[0]).toBe(initial);
        expect(container.textContent).toBe(String(live));
      } finally {
        consoleError.mockRestore();
        if (root) {
          act(() => {
            (root as Root).unmount();
          });
        }
      }
    },
  );

  it("returns the real isWeekend() value on the client", async () => {
    mockIsWeekend.mockReturnValue(true);
    expect(await renderOnClient()).toBe(true);
  });

  it("returns false on the client on a weekday", async () => {
    mockIsWeekend.mockReturnValue(false);
    expect(await renderOnClient()).toBe(false);
  });

  it("self-corrects in both directions on the existing hourly interval", async () => {
    vi.useFakeTimers();
    let liveIsWeekend = false;
    mockIsWeekend.mockImplementation(() => liveIsWeekend);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(Probe));
      });
      expect(container.textContent).toBe("false");

      liveIsWeekend = true;
      act(() => {
        vi.advanceTimersByTime(60 * 60 * 1000);
      });
      expect(container.textContent).toBe("true");

      liveIsWeekend = false;
      act(() => {
        vi.advanceTimersByTime(60 * 60 * 1000);
      });
      expect(container.textContent).toBe("false");
    } finally {
      act(() => root.unmount());
    }
  });
});
