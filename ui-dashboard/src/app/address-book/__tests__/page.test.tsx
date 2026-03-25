import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AddressBookPage from "../page";

// Stub the client component — we only care about what prop it receives
const mockAddressBookClient = vi.fn(({ canEdit }: { canEdit: boolean }) => (
  <div data-testid="address-book-client" data-can-edit={String(canEdit)} />
));
vi.mock("../AddressBookClient", () => ({
  default: (props: { canEdit: boolean }) => mockAddressBookClient(props),
}));

describe("AddressBookPage", () => {
  it("always passes canEdit=true because middleware protects the route", () => {
    const html = renderToStaticMarkup(<AddressBookPage />);
    expect(html).toContain('data-can-edit="true"');
  });
});
