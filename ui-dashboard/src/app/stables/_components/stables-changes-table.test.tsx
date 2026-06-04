import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StablesChangesTable } from "./stables-changes-table";

describe("StablesChangesTable", () => {
  it("explains the display threshold in the empty capped state", () => {
    const html = renderToStaticMarkup(
      <StablesChangesTable
        events={[]}
        isLoading={false}
        hasError={false}
        capped={true}
      />,
    );

    expect(html).toContain("No supply changes at or above");
    expect(html).toContain("0.01 token");
    expect(html).toContain("the most recent fetched rows");
  });
});
