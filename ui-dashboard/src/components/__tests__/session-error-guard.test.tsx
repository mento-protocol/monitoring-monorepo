/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionErrorGuard } from "@/components/session-error-guard";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const mockUseSession = vi.fn();
const mockSignOut = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
  signOut: (opts: unknown) => mockSignOut(opts),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => {
    root.render(<SessionErrorGuard />);
  });
}

describe("SessionErrorGuard", () => {
  it("signs out (no redirect) when the session carries a RefreshTokenError", () => {
    mockUseSession.mockReturnValue({ data: { error: "RefreshTokenError" } });
    render();
    expect(mockSignOut).toHaveBeenCalledWith({ redirect: false });
  });

  it("does nothing for a healthy authenticated session", () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: "alice@mentolabs.xyz" } },
    });
    render();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("does nothing when there is no session", () => {
    mockUseSession.mockReturnValue({ data: null });
    render();
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
