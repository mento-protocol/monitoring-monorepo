/** @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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

let container: HTMLElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

function setup(url: string) {
  window.history.replaceState(window.history.state, "", url);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

function signInLink() {
  const link = container.querySelector("a");
  expect(link).not.toBeNull();
  return link as HTMLAnchorElement;
}

beforeEach(() => {
  previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" });
  setup("/pools");
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.removeChild(container);
  window.history.replaceState(window.history.state, "", "/");
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("AuthStatus sign-in href", () => {
  it("updates the anchor href after history.replaceState changes search params", () => {
    act(() => {
      root.render(<AuthStatus />);
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
    act(() => {
      root.render(<AuthStatus />);
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
});
