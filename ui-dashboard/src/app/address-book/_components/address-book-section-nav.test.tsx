import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AddressBookSectionNav } from "./address-book-section-nav";

describe("AddressBookSectionNav", () => {
  it("links both sections and marks Addresses as the current page", () => {
    const html = renderToStaticMarkup(
      <AddressBookSectionNav active="addresses" />,
    );

    expect(html).toContain('href="/address-book"');
    expect(html).toContain('href="/address-book/entities"');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('role="tablist"');
  });

  it("marks Entities as current without treating route links as ARIA tabs", () => {
    const html = renderToStaticMarkup(
      <AddressBookSectionNav active="entities" />,
    );
    const entitiesLink = html.match(
      /<a[^>]*href="\/address-book\/entities"[^>]*>/,
    )?.[0];

    expect(entitiesLink).toContain('aria-current="page"');
    expect(html).not.toContain('aria-selected="true"');
  });
});
