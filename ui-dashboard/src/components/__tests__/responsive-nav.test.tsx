/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
      Auth
    </button>
  ),
}));

describe("ResponsiveNav", () => {
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
      root.render(<ResponsiveNav />);
    });
  }

  function menuButton(): HTMLButtonElement {
    const button = container.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("menu button not found");
    }
    return button;
  }

  function panelById(id: string): HTMLElement | null {
    return container.ownerDocument.getElementById(id);
  }

  it("opens a mobile menu with ordered public links and panel auth status", () => {
    renderNav();

    const button = menuButton();
    const panelId = button.getAttribute("aria-controls");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panelId).toBeTruthy();
    expect(panelById(panelId!)).toBeNull();

    act(() => {
      button.click();
    });

    const panel = panelById(panelId!);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(panel).not.toBeNull();
    expect(
      panel
        ?.querySelector("[data-auth-status]")
        ?.getAttribute("data-auth-status"),
    ).toBe("panel");
    expect(
      Array.from(panel?.querySelectorAll("a") ?? [], (link) =>
        link.getAttribute("href"),
      ),
    ).toEqual([
      "/pools",
      "/volume",
      "/stables",
      "/bridge-flows",
      "/cdps",
      "/peg-monitoring",
    ]);
  });

  it("closes the mobile menu on Escape and link activation", () => {
    renderNav();

    const button = menuButton();
    const panelId = button.getAttribute("aria-controls")!;

    act(() => {
      button.click();
    });
    expect(panelById(panelId)).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panelById(panelId)).toBeNull();

    act(() => {
      button.click();
    });
    const firstLink = panelById(panelId)?.querySelector("a");
    if (!(firstLink instanceof HTMLAnchorElement)) {
      throw new Error("mobile nav link not found");
    }
    firstLink.addEventListener("click", (event) => event.preventDefault());

    act(() => {
      firstLink.click();
    });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panelById(panelId)).toBeNull();
  });

  it("closes the mobile menu when panel auth status activates", () => {
    renderNav();

    const button = menuButton();
    const panelId = button.getAttribute("aria-controls")!;
    act(() => {
      button.click();
    });

    const authButton = panelById(panelId)?.querySelector("[data-auth-status]");
    if (!(authButton instanceof HTMLButtonElement)) {
      throw new Error("panel auth button not found");
    }

    act(() => {
      authButton.click();
    });

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panelById(panelId)).toBeNull();
  });
});
