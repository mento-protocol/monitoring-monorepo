/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { axe } from "vitest-axe";
import { ResponsiveNav } from "@/components/responsive-nav";

const mockUseSession = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

vi.mock("@/components/auth-status", () => ({
  AuthStatus: ({
    variant = "inline",
    onClose,
  }: {
    variant?: string;
    onClose?: () => void;
  }) => (
    <button type="button" data-auth-status={variant} onClick={onClose}>
      Sign in
    </button>
  ),
}));

describe("ResponsiveNav a11y", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockUseSession.mockReturnValue({ data: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    mockUseSession.mockReset();
  });

  function renderNav() {
    act(() => {
      root.render(
        <nav aria-label="Main navigation">
          <ResponsiveNav />
        </nav>,
      );
    });
  }

  function menuButton(): HTMLButtonElement {
    const button = container.querySelector("button[aria-controls]");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("menu button not found");
    }
    return button;
  }

  it("closed and open disclosure states pass axe", async () => {
    renderNav();

    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect((await axe(container)).violations).toEqual([]);

    act(() => {
      menuButton().click();
    });

    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    expect((await axe(container)).violations).toEqual([]);
  });
});
