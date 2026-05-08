/** @vitest-environment jsdom */

// Tell React 19 we're in an act-compatible test environment.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Tests for the standalone <AddressLabelForm> extracted out of
 * AddressLabelEditor. Covers form behavior in isolation — no modal, no
 * dialog — so the detail page can render it inline without surprises.
 *
 * Pure-helper tests (resolveIsContractRow / resolveEffectiveName /
 * validateEntryForm) live in address-label-editor.test.ts and continue to
 * import from the editor module via re-export. This file covers
 * end-to-end form behavior the helpers don't reach (save/delete callbacks,
 * sanity check that no <dialog> renders, cancel button visibility).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Typed via the provider's contract so `.mock.calls[0]` carries the right
// tuple shape (otherwise inferred as `[]` and indexing breaks).
const mockUpsertEntry = vi.fn<
  (
    address: string,
    entry: {
      name: string;
      tags: string[];
      notes?: string;
      isPublic?: boolean;
    },
  ) => Promise<void>
>(async () => undefined);
const mockDeleteEntry = vi.fn<(address: string) => Promise<void>>(
  async () => undefined,
);
const mockIsCustom = vi.fn<(address: string | null) => boolean>(() => false);

vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    upsertEntry: mockUpsertEntry,
    deleteEntry: mockDeleteEntry,
    isCustom: mockIsCustom,
    customEntries: [],
  }),
}));

// TagInput uses ResizeObserver internally — jsdom doesn't ship one.
vi.mock("@/components/tag-input", () => ({
  TagInput: ({
    tags,
    onChange,
  }: {
    tags: string[];
    onChange: (tags: string[]) => void;
  }) => (
    <input
      data-testid="tag-input-stub"
      value={tags.join(",")}
      onChange={(e) =>
        onChange(
          e.target.value
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        )
      }
    />
  ),
}));

import { AddressLabelForm } from "../address-label-form";

const VALID_ADDR = "0x" + "a".repeat(40);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockUpsertEntry.mockClear();
  mockDeleteEntry.mockClear();
  mockIsCustom.mockClear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(props: Parameters<typeof AddressLabelForm>[0]) {
  act(() => {
    root.render(<AddressLabelForm {...props} />);
  });
}

function setInputValue(id: string, value: string): void {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `#${id}`,
  );
  if (!input) throw new Error(`#${id} not found`);
  act(() => {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickByText(text: string): void {
  const buttons = Array.from(container.querySelectorAll("button"));
  const target = buttons.find((b) => b.textContent?.trim() === text);
  if (!target) {
    throw new Error(
      `clickByText: no <button> with text "${text}" — found: ${buttons
        .map((b) => `"${b.textContent?.trim()}"`)
        .join(", ")}`,
    );
  }
  act(() => {
    target.click();
  });
}

async function submit(): Promise<void> {
  const form = container.querySelector("form");
  if (!form) throw new Error("form not found");
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

describe("AddressLabelForm — sanity", () => {
  it("renders without a <dialog> element (extraction successful)", () => {
    render({ address: VALID_ADDR });
    expect(container.querySelector("dialog")).toBeNull();
  });

  it("renders the address as static text when not new", () => {
    render({ address: VALID_ADDR });
    // Address input only shows in new-address mode
    expect(container.querySelector("#al-address")).toBeNull();
    expect(container.textContent).toContain(VALID_ADDR);
  });

  it("renders the address as an editable input in new-address mode", () => {
    render({ address: "" });
    const input = container.querySelector<HTMLInputElement>("#al-address");
    expect(input).not.toBeNull();
    expect(input?.tagName).toBe("INPUT");
  });
});

describe("AddressLabelForm — Cancel button visibility", () => {
  it("renders Cancel only when onCancel is provided (modal use)", () => {
    render({ address: VALID_ADDR, onCancel: () => undefined });
    const cancel = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Cancel",
    );
    expect(cancel).toBeDefined();
  });

  it("omits Cancel when onCancel is not provided (page use)", () => {
    render({ address: VALID_ADDR });
    const cancel = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Cancel",
    );
    expect(cancel).toBeUndefined();
  });
});

describe("AddressLabelForm — save flow", () => {
  it("blocks submission with a validation error when name and tags are empty", async () => {
    render({ address: VALID_ADDR });
    await submit();
    expect(mockUpsertEntry).not.toHaveBeenCalled();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/Name or at least one tag is required/);
  });

  it("calls upsertEntry + onSaved with sanitized name on a valid submit", async () => {
    const onSaved = vi.fn();
    render({ address: VALID_ADDR, onSaved });
    setInputValue("al-name", "  Whale Alice  ");
    await submit();
    expect(mockUpsertEntry).toHaveBeenCalledTimes(1);
    const [calledAddress, calledEntry] = mockUpsertEntry.mock.calls[0];
    expect(calledAddress).toBe(VALID_ADDR);
    expect(calledEntry).toMatchObject({
      name: "Whale Alice",
      tags: [],
      isPublic: false,
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("sends `notes: undefined` when notes is whitespace-only", async () => {
    render({ address: VALID_ADDR });
    setInputValue("al-name", "Alice");
    setInputValue("al-notes", "   ");
    await submit();
    const [, calledEntry] = mockUpsertEntry.mock.calls[0];
    expect(calledEntry.notes).toBeUndefined();
  });
});

describe("AddressLabelForm — delete flow", () => {
  it("Remove label button is visible only for existing custom entries", () => {
    // No initial → new entry → no Remove button
    render({ address: VALID_ADDR });
    expect(
      Array.from(container.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("Remove label"),
      ),
    ).toBe(false);

    // With initial AND isCustom=true → existing custom entry → Remove visible.
    // (resolveIsContractRow returns true only when initial is set AND isCustom
    // is FALSE, so we need isCustom=true here to NOT be a contract row.)
    mockIsCustom.mockReturnValue(true);
    render({
      address: VALID_ADDR,
      initial: {
        name: "Existing",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    expect(
      Array.from(container.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("Remove label"),
      ),
    ).toBe(true);
  });

  it("calls deleteEntry + onDeleted when Remove label is clicked", async () => {
    mockIsCustom.mockReturnValue(true);
    const onDeleted = vi.fn();
    render({
      address: VALID_ADDR,
      initial: {
        name: "Existing",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
      onDeleted,
    });
    await act(async () => {
      clickByText("Remove label");
      // Drain microtasks so the async deleteEntry promise + onDeleted resolve.
      await Promise.resolve();
    });
    expect(mockDeleteEntry).toHaveBeenCalledWith(VALID_ADDR);
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });
});
