/** @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStatus } from "@/components/auth-status";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const mockUseSession = vi.fn();
const mockMutate = vi.fn();
const mockSignOut = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
  signOut: () => mockSignOut(),
}));

vi.mock("swr", () => ({
  useSWRConfig: () => ({ mutate: mockMutate }),
}));

vi.mock("@sentry/nextjs", () => ({
  setUser: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

let container: HTMLElement | null = null;
let root: Root | null = null;
let previousActEnvironment: boolean | undefined;

function setup(url: string) {
  window.history.replaceState(window.history.state, "", url);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

function setupServerHtml(url: string, html: string) {
  window.history.replaceState(window.history.state, "", url);
  container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
}

function renderWithoutBrowserWindow(element: React.ReactElement) {
  const originalWindow = window;
  vi.stubGlobal("window", undefined);
  try {
    return renderToString(element);
  } finally {
    vi.stubGlobal("window", originalWindow);
  }
}

function signInLink() {
  expect(container).not.toBeNull();
  const link = container?.querySelector("a");
  expect(link).not.toBeNull();
  return link as HTMLAnchorElement;
}

beforeEach(() => {
  previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" });
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  if (container?.parentNode) {
    document.body.removeChild(container);
  }
  root = null;
  container = null;
  window.history.replaceState(window.history.state, "", "/");
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("AuthStatus sign-in href", () => {
  it("updates the anchor href after history.replaceState changes search params", () => {
    setup("/pools");

    act(() => {
      root?.render(<AuthStatus />);
    });
    expect(signInLink().getAttribute("href")).toBe(
      "/sign-in?callbackUrl=%2Fpools",
    );

    act(() => {
      window.history.replaceState(
        window.history.state,
        "",
        "/pools?poolsSort=tvl&poolsDir=desc",
      );
    });

    expect(signInLink().getAttribute("href")).toBe(
      "/sign-in?callbackUrl=%2Fpools%3FpoolsSort%3Dtvl%26poolsDir%3Ddesc",
    );
  });

  it("updates the anchor href after history.pushState changes the path", () => {
    setup("/pools");

    act(() => {
      root?.render(<AuthStatus />);
    });

    act(() => {
      window.history.pushState(
        window.history.state,
        "",
        "/leaderboard?leaderboardWindow=7d",
      );
    });

    expect(signInLink().getAttribute("href")).toBe(
      "/sign-in?callbackUrl=%2Fleaderboard%3FleaderboardWindow%3D7d",
    );
  });

  it("updates the anchor href after browser back emits popstate", async () => {
    setup("/pools");

    act(() => {
      root?.render(<AuthStatus />);
    });

    act(() => {
      window.history.pushState(
        window.history.state,
        "",
        "/leaderboard?leaderboardWindow=7d",
      );
    });
    expect(signInLink().getAttribute("href")).toBe(
      "/sign-in?callbackUrl=%2Fleaderboard%3FleaderboardWindow%3D7d",
    );

    await act(async () => {
      const popped = new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
      });
      window.history.back();
      await popped;
    });

    expect(signInLink().getAttribute("href")).toBe(
      "/sign-in?callbackUrl=%2Fpools",
    );
  });

  it("updates the server fallback href immediately after hydration", async () => {
    const serverHtml = renderWithoutBrowserWindow(<AuthStatus />);
    setupServerHtml("/pools?poolsSort=tvl&poolsDir=desc", serverHtml);
    expect(signInLink().getAttribute("href")).toBe("/sign-in?callbackUrl=%2F");

    await act(async () => {
      root = hydrateRoot(container as HTMLElement, <AuthStatus />);
      await Promise.resolve();
    });

    expect(signInLink().getAttribute("href")).toBe(
      "/sign-in?callbackUrl=%2Fpools%3FpoolsSort%3Dtvl%26poolsDir%3Ddesc",
    );
  });
});
