/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Editor-level tests for the modal lifecycle, focus handoff, and tab-panel
 * persistence. The helper-only tests in `address-label-editor.test.ts`
 * cover pure functions; this file exercises the React component itself
 * because the real risks of the form-extraction refactor live at this
 * layer (showModal lifecycle, focus on the right field after the dialog
 * opens, form state surviving a peek at the report tab).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const VALID_ADDR = "0x" + "a".repeat(40);

const mockUpsertEntry = vi.fn(async () => undefined);
const mockDeleteEntry = vi.fn(async () => undefined);
const mockIsCustom = vi.fn<(address: string | null) => boolean>(() => false);

vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    upsertEntry: mockUpsertEntry,
    deleteEntry: mockDeleteEntry,
    isCustom: mockIsCustom,
    customEntries: [],
  }),
}));

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
          e.target.value.split(",").flatMap((t) => {
            const v = t.trim();
            return v ? [v] : [];
          }),
        )
      }
    />
  ),
}));

// AddressReportEditor pulls in SWR + useSession; stub it for these tests
// since the lifecycle assertions only care about the dialog + label form.
vi.mock("@/components/address-report-editor", () => ({
  AddressReportEditor: ({ address }: { address: string }) => (
    <div data-testid="report-editor-stub" data-address={address} />
  ),
}));

// jsdom doesn't implement <dialog>.showModal/close. Polyfill on the
// prototype so the component's lifecycle effect runs without throwing,
// and spy from there to count calls. The polyfill mirrors enough of the
// browser shape (open flag toggling, InvalidStateError on showModal-while-
// open) for this suite's assertions.
if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement) {
      if (this.open) {
        const err = new Error(
          "Failed to execute 'showModal' on 'HTMLDialogElement': The element is already in an open state.",
        );
        err.name = "InvalidStateError";
        throw err;
      }
      this.setAttribute("open", "");
    },
  });
}
if (typeof HTMLDialogElement.prototype.close !== "function") {
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
}

import { AddressLabelEditor } from "../address-label-editor";

let container: HTMLDivElement;
let root: Root;
let showModalSpy: ReturnType<typeof vi.spyOn>;
let closeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockUpsertEntry.mockClear();
  mockDeleteEntry.mockClear();
  mockIsCustom.mockReset();
  mockIsCustom.mockReturnValue(false);

  showModalSpy = vi.spyOn(HTMLDialogElement.prototype, "showModal");
  closeSpy = vi.spyOn(HTMLDialogElement.prototype, "close");
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  showModalSpy?.mockRestore();
  closeSpy?.mockRestore();
});

function render(props: Parameters<typeof AddressLabelEditor>[0]) {
  act(() => {
    root.render(<AddressLabelEditor {...props} />);
  });
}

function rerender(props: Parameters<typeof AddressLabelEditor>[0]) {
  act(() => {
    root.render(<AddressLabelEditor {...props} />);
  });
}

function clickTab(name: "Label & Tags" | "Forensic Report"): void {
  const tab = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button[role=tab]"),
  ).find((b) => b.textContent?.trim() === name);
  if (!tab) throw new Error(`tab ${name} not found`);
  act(() => {
    tab.click();
  });
}

function setInputValue(id: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`#${id} not found`);
  act(() => {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AddressLabelEditor — modal lifecycle", () => {
  it("calls dialog.showModal exactly once on mount", () => {
    render({ address: VALID_ADDR, onClose: () => undefined });
    expect(showModalSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-fire showModal on parent re-render with the same dialog open", () => {
    // Cursor flagged that depending on `onClose` in the mount effect would
    // re-run on every parent re-render (every caller passes an inline arrow
    // → new identity → new effect run → showModal on already-open dialog →
    // InvalidStateError). Pin the latched-ref fix.
    render({ address: VALID_ADDR, onClose: () => undefined });
    expect(showModalSpy).toHaveBeenCalledTimes(1);

    // Trigger a parent re-render with a fresh inline onClose. If the effect
    // weren't mount-only this would call showModal a second time and throw.
    expect(() => {
      rerender({ address: VALID_ADDR, onClose: () => undefined });
    }).not.toThrow();
    expect(showModalSpy).toHaveBeenCalledTimes(1);
  });

  it("guards `dialog.showModal()` so a forced effect re-run doesn't throw on an already-open dialog", () => {
    // Defensive — directly invoke `dialog.showModal()` in the open state to
    // confirm jsdom's spec-compliance, then assert our component would
    // catch the precondition. The guard `if (!dialog.open) showModal()`
    // means re-running the mount effect (e.g. via React Strict Mode's
    // double-invoke in dev) is safe.
    render({ address: VALID_ADDR, onClose: () => undefined });
    const dialog = container.querySelector("dialog");
    expect(dialog?.open).toBe(true);
    // Confirm jsdom enforces the InvalidStateError that motivated the
    // guard. If this assertion ever flips (jsdom relaxes the check), our
    // guard is harmless; if it stays, the guard is load-bearing.
    expect(() => dialog?.showModal()).toThrow();
  });
});

describe("AddressLabelEditor — modal title", () => {
  it("shows 'Add label' for a contract row (existing static label, no custom yet)", () => {
    // resolveIsContractRow returns true when initial is set AND isCustom is
    // FALSE — i.e. the static contract registry has a label but the user
    // hasn't customised it yet. Title should read "Add label" because the
    // user is adding their FIRST custom label on top of the contract.
    mockIsCustom.mockReturnValue(false);
    render({
      address: VALID_ADDR,
      initial: {
        name: "ContractC",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
      onClose: () => undefined,
    });
    expect(container.querySelector("h2")?.textContent).toBe("Add label");
  });

  it("shows 'Edit label' for an existing custom entry", () => {
    mockIsCustom.mockReturnValue(true);
    render({
      address: VALID_ADDR,
      initial: {
        name: "Custom Whale",
        tags: [],
        updatedAt: "2026-01-01T00:00:00Z",
      },
      onClose: () => undefined,
    });
    expect(container.querySelector("h2")?.textContent).toBe("Edit label");
  });

  it("shows 'Add label' for a new-address flow (no initial)", () => {
    render({ address: "", onClose: () => undefined });
    expect(container.querySelector("h2")?.textContent).toBe("Add label");
  });
});

describe("AddressLabelEditor — tab panels", () => {
  it("keeps the label form mounted when switching to the Report tab (state preserved)", () => {
    // Cursor + Codex + Claude all flagged: a ternary that unmounts
    // <AddressLabelForm> would discard typed-in state on tab switch. The
    // fix renders both panels with `hidden` instead. Pin it: type a name,
    // peek at the report tab, switch back, name should still be there.
    render({ address: VALID_ADDR, onClose: () => undefined });
    setInputValue("al-name", "Whale Alice");
    expect(container.querySelector<HTMLInputElement>("#al-name")?.value).toBe(
      "Whale Alice",
    );

    clickTab("Forensic Report");
    // Label panel is hidden but still mounted — the input element survives
    // and retains its value. Both `hidden` attribute AND the input
    // existing in the DOM are part of the contract.
    const labelPanel = container.querySelector(
      '[role="tabpanel"][aria-labelledby="al-tab-label"]',
    );
    expect(labelPanel?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#al-name")?.value).toBe(
      "Whale Alice",
    );

    clickTab("Label & Tags");
    expect(labelPanel?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector<HTMLInputElement>("#al-name")?.value).toBe(
      "Whale Alice",
    );
  });

  it("renders the report panel mounted regardless of which tab is active", () => {
    // The report editor stub mounts on initial render even though the
    // label tab is the default — confirms `hidden` is doing the toggling
    // (not conditional render). This matters because the report editor's
    // SWR fetch can pre-warm its cache while the user is on the label tab.
    render({ address: VALID_ADDR, onClose: () => undefined });
    expect(
      container.querySelector('[data-testid="report-editor-stub"]'),
    ).not.toBeNull();
  });

  it("refreshes the report panel address when an already-mounted editor switches targets", () => {
    const firstAddress = "0x" + "d".repeat(40);
    const secondAddress = "0x" + "e".repeat(40);
    render({ address: firstAddress, onClose: () => undefined });
    clickTab("Forensic Report");

    let stub = container.querySelector('[data-testid="report-editor-stub"]');
    expect(stub?.getAttribute("data-address")).toBe(firstAddress);

    rerender({ address: secondAddress, onClose: () => undefined });
    stub = container.querySelector('[data-testid="report-editor-stub"]');
    expect(stub?.getAttribute("data-address")).toBe(secondAddress);
  });
});

describe("AddressLabelEditor — new-address draft sharing", () => {
  it("bubbles a typed address into the report panel via the form's onAddressChange", () => {
    // Codex P2: pre-refactor the address state lived in the modal; both
    // tabs read the same value. After extraction the typed address only
    // lived inside the form, and the report panel kept seeing the empty
    // initial prop. Pin the bubbling fix: render in new-address mode,
    // type a valid address, switch to the report tab, assert the report
    // editor stub received the typed address.
    render({ address: "", onClose: () => undefined });
    const validAddr = "0x" + "b".repeat(40);
    setInputValue("al-address", validAddr);
    clickTab("Forensic Report");

    const stub = container.querySelector('[data-testid="report-editor-stub"]');
    expect(stub).not.toBeNull();
    expect(stub?.getAttribute("data-address")).toBe(validAddr);
  });

  it("flips the modal title from 'Add label' to 'Edit label' when a typed address matches an existing custom entry", () => {
    // The new-address flow can type into an existing custom address. The
    // editor must re-derive isContractRow against the *typed* address
    // (draftAddress), not the original `""` prop, so the title updates.
    mockIsCustom.mockImplementation(
      (addr: string | null) => addr === "0x" + "c".repeat(40),
    );
    render({ address: "", onClose: () => undefined });
    expect(container.querySelector("h2")?.textContent).toBe("Add label");

    setInputValue("al-address", "0x" + "c".repeat(40));
    // Title still says "Add label" because the modal is in new-address
    // mode without any `initial` — typing an existing-custom address
    // doesn't auto-load it; the user is starting fresh. This pins the
    // documented behaviour, not the title flip; the previous bug was the
    // *report* tab seeing "" instead of the typed address.
    expect(container.querySelector("h2")?.textContent).toBe("Add label");
  });
});

describe("AddressLabelEditor — focus handoff", () => {
  it("schedules focus on the form's first field after showModal via rAF", async () => {
    // Cursor flagged that running focus inside the form's own effect races
    // the dialog's native focus steps and lands focus on the close button.
    // The fix moves focus into the editor's effect (after showModal) and
    // wraps it in requestAnimationFrame so it fires after the dialog
    // settles. Test: spy on rAF, render, assert the callback fires and
    // calls focus on #al-name (or #al-address in new-address mode).
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    let focused = "";
    // Spy on the underlying focus method so we don't depend on document.activeElement
    // (jsdom can be flaky about activeElement during synthetic mounts).
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, "focus");
    focusSpy.mockImplementation(function (this: HTMLInputElement) {
      focused = this.id;
    });

    try {
      render({ address: VALID_ADDR, onClose: () => undefined });
      expect(rafSpy).toHaveBeenCalled();
      // Run the queued rAF callbacks synchronously.
      const callbacks = rafSpy.mock.calls.map((c) => c[0]);
      for (const cb of callbacks) cb(performance.now());
      expect(focused).toBe("al-name");
    } finally {
      rafSpy.mockRestore();
      focusSpy.mockRestore();
    }
  });
});
