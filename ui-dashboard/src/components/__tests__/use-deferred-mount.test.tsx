/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { useRef } from "react";
import {
  useDeferredMount,
  type DeferredMountMode,
} from "@/components/use-deferred-mount";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

function Probe({
  mode,
  enabled = true,
}: {
  mode: DeferredMountMode;
  enabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useDeferredMount(mode, ref, enabled);
  return <div ref={ref} data-mounted={mounted ? "yes" : "no"} />;
}

function mountedValue(): string | null {
  return container.firstElementChild?.getAttribute("data-mounted") ?? null;
}

beforeEach(() => {
  previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT =
    previousActEnvironment ?? false;
});

describe("useDeferredMount", () => {
  it("mounts immediately in none mode", () => {
    act(() => {
      root.render(<Probe mode="none" />);
    });
    expect(mountedValue()).toBe("yes");
  });

  it("waits for idle mode before mounting", () => {
    let idleCallback: (() => void) | null = null;
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: () => void) => {
        idleCallback = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    act(() => {
      root.render(<Probe mode="idle" />);
    });
    expect(mountedValue()).toBe("no");

    act(() => {
      idleCallback?.();
    });
    expect(mountedValue()).toBe("yes");
  });

  it("waits for IntersectionObserver in visible mode", () => {
    type ObserverCallback = (entries: IntersectionObserverEntry[]) => void;
    const observers: Array<{ callback: ObserverCallback; disconnect: Mock }> =
      [];
    class MockIntersectionObserver {
      private readonly callback: ObserverCallback;
      readonly disconnect = vi.fn();
      constructor(callback: ObserverCallback) {
        this.callback = callback;
        observers.push({ callback, disconnect: this.disconnect });
      }
      observe = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

    act(() => {
      root.render(<Probe mode="visible" />);
    });
    expect(mountedValue()).toBe("no");
    expect(observers).toHaveLength(1);

    act(() => {
      observers[0]!.callback([
        { isIntersecting: true } as IntersectionObserverEntry,
      ]);
    });
    expect(mountedValue()).toBe("yes");
    expect(observers[0]!.disconnect).toHaveBeenCalled();
  });
});
