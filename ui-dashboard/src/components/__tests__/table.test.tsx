import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Table, Row, Th, Td } from "@/components/table";

function renderTable(scrollClassName?: string): string {
  const scrollProps = scrollClassName ? { scrollClassName } : {};
  return renderToStaticMarkup(
    <Table aria-label="Example table" {...scrollProps}>
      <thead>
        <Row>
          <Th>Asset</Th>
          <Th align="right">Amount</Th>
        </Row>
      </thead>
      <tbody>
        <Row>
          <Td>USDm</Td>
          <Td mono align="right">
            1,000,000
          </Td>
        </Row>
      </tbody>
    </Table>,
  );
}

describe("Table", () => {
  it("adds the shared horizontal scroll cue to the scroll wrapper", () => {
    const html = renderTable();

    expect(html).toContain("table-scroll-cue");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("scrollbar-width:thin");
    expect(html).toContain('aria-label="Example table"');
  });

  it("preserves scrollClassName overrides for specific tables", () => {
    const html = renderTable("xl:overflow-x-clip");

    expect(html).toContain("table-scroll-cue");
    expect(html).toContain("xl:overflow-x-clip");
  });
});
