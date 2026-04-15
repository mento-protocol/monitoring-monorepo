/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RootError from "@/app/error";
import PoolDetailError from "@/app/pool/[poolId]/error";
import AddressBookError from "@/app/address-book/error";

describe("app/error boundaries", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Silence intentional console.error logging from the boundaries
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

  it("PoolDetailError surfaces a back-to-overview link", () => {
    render(<PoolDetailError error={new Error("nope")} reset={vi.fn()} />);
    const link = container.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Back to overview");
  });

  it("AddressBookError shows a sign-in link when the error looks like an auth failure", () => {
    render(
      <AddressBookError error={new Error("Unauthorized")} reset={vi.fn()} />,
    );
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href^="/sign-in"]',
    );
    expect(link).not.toBeNull();
    expect(container.textContent).toContain("session expired");
  });

  it("AddressBookError shows retry (not sign-in) for non-auth errors", () => {
    const reset = vi.fn();
    render(<AddressBookError error={new Error("500 oops")} reset={reset} />);

    const signInLink = container.querySelector('a[href^="/sign-in"]');
    expect(signInLink).toBeNull();

    const button = container.querySelector<HTMLButtonElement>(
      'button[type="button"]',
    );
    expect(button?.textContent).toContain("Try again");
    act(() => {
      button?.click();
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
