/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

// NetworkAwareLink reads useNetwork(); stub it so the boundary renders in a
// plain-render test without mounting the full provider. Mutated per-test.
// Typed as the real provider shape (sans `network` object, which no consumer
// in these boundaries needs) so a future refactor that starts reading
// `network.id` or `setNetworkId` breaks this at compile time instead of
// silently passing with a stale mock.
import type { IndexerNetworkId } from "@/lib/networks";
const mockNetwork: {
  networkId: IndexerNetworkId;
  setNetworkId: (id: IndexerNetworkId) => void;
} = {
  networkId: "celo-mainnet",
  setNetworkId: () => {},
};
vi.mock("@/components/network-provider", () => ({
  useNetwork: () => mockNetwork,
}));

import * as Sentry from "@sentry/nextjs";
import RootError from "@/app/error";
import GlobalError from "@/app/global-error";
import PoolDetailError from "@/app/pool/[poolId]/error";
import AddressBookError from "@/app/address-book/error";

describe("app/error boundaries", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockNetwork.networkId = "celo-mainnet";
    // React logs its own `console.error` for effects that throw during the
    // jsdom render (e.g. nested <html> warning from GlobalError). Silence so
    // the test output stays clean; assertions still run.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  function render(element: React.ReactElement) {
    act(() => {
      root.render(element);
    });
  }

  it("RootError renders the error message and invokes reset on click", () => {
    const reset = vi.fn();
    render(<RootError error={new Error("boom")} reset={reset} />);

    expect(container.textContent).toContain("boom");
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
    );
    const button = container.querySelector<HTMLButtonElement>(
      'button[type="button"]',
    );
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("Try again");

    act(() => {
      button?.click();
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("RootError falls back to a generic message when error.message is empty", () => {
    render(<RootError error={new Error("")} reset={vi.fn()} />);
    expect(container.textContent).toContain("Something went wrong");
  });

  it("PoolDetailError links back to the pools list on the default network", () => {
    render(<PoolDetailError error={new Error("boom")} reset={vi.fn()} />);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
    );
    const link = container.querySelector<HTMLAnchorElement>('a[href="/pools"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Back to pools");
  });

  it("PoolDetailError recovery link always goes to /pools (no ?network= needed)", () => {
    mockNetwork.networkId = "monad-mainnet";
    render(<PoolDetailError error={new Error("nope")} reset={vi.fn()} />);
    const link = container.querySelector<HTMLAnchorElement>('a[href="/pools"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/pools");
  });

  it("PoolDetailError surfaces error.digest when present", () => {
    const error = Object.assign(new Error("render crash"), {
      digest: "abc123xyz",
    });
    render(<PoolDetailError error={error} reset={vi.fn()} />);
    expect(container.textContent).toContain("Error ID:");
    expect(container.textContent).toContain("abc123xyz");
  });

  it("RootError hides the digest line when no digest is attached", () => {
    render(<RootError error={new Error("no-digest")} reset={vi.fn()} />);
    expect(container.textContent).not.toContain("Error ID");
  });

  it("AddressBookError shows a generic retry and invokes reset", () => {
    const reset = vi.fn();
    render(<AddressBookError error={new Error("boom")} reset={reset} />);

    expect(container.textContent).toContain("boom");
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
    );
    expect(container.querySelector('a[href^="/sign-in"]')).toBeNull();

    const button = container.querySelector<HTMLButtonElement>(
      'button[type="button"]',
    );
    expect(button?.textContent).toContain("Try again");
    act(() => {
      button?.click();
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("GlobalError renders its own html shell with the error message", () => {
    // GlobalError renders <html><body>…</body></html>; asserting on static
    // markup is simpler than mounting a nested <html> into jsdom. Static
    // rendering does not run effects, so assert capture via a jsdom render
    // immediately after.
    const html = renderToStaticMarkup(
      <GlobalError error={new Error("root crash")} reset={vi.fn()} />,
    );
    expect(html).toContain("root crash");
    expect(html).toContain('role="alert"');
    expect(html).toContain("<html");
    expect(html).toContain("<body");
    expect(html).toContain("Try again");

    render(<GlobalError error={new Error("boom")} reset={vi.fn()} />);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
    );
  });
});
