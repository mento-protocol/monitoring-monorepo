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

const mockGetAuthSession = vi.fn();
vi.mock("@/auth", () => ({
  getAuthSession: () => mockGetAuthSession(),
}));

describe("AddressBookPage", () => {
  it("passes canEdit=true when session exists", async () => {
    mockGetAuthSession.mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const html = renderToStaticMarkup(await AddressBookPage());
    expect(html).toContain('data-can-edit="true"');
  });

  it("passes canEdit=false when session is null", async () => {
    mockGetAuthSession.mockResolvedValue(null);
    const html = renderToStaticMarkup(await AddressBookPage());
    expect(html).toContain('data-can-edit="false"');
  });
});
