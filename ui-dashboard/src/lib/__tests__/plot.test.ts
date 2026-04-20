import { describe, expect, it } from "vitest";
import { escapePlotText } from "@/lib/plot";

describe("escapePlotText", () => {
  it("escapes the five HTML metacharacters that Plotly would render", () => {
    expect(escapePlotText("<")).toBe("&lt;");
    expect(escapePlotText(">")).toBe("&gt;");
    expect(escapePlotText('"')).toBe("&quot;");
    expect(escapePlotText("'")).toBe("&#39;");
    expect(escapePlotText("&")).toBe("&amp;");
  });

  it("escapes & first so existing entities are double-encoded (idempotency-safe round-trip)", () => {
    // Without the &-first ordering, an input containing `&lt;` would be
    // mistaken for a pre-escaped sequence and left as-is — meaning a hostile
    // value like `&lt;script&gt;alert(1)&lt;/script&gt;` would still execute
    // when Plotly decoded it.
    expect(escapePlotText("&lt;")).toBe("&amp;lt;");
  });

  it("neutralises the stored-XSS payload from the Codex finding", () => {
    const payload = "<img src=x onerror='alert(1)'>";
    const escaped = escapePlotText(payload);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).not.toContain("'");
    expect(escaped).toBe("&lt;img src=x onerror=&#39;alert(1)&#39;&gt;");
  });

  it("leaves benign labels untouched", () => {
    expect(escapePlotText("Treasury Wallet")).toBe("Treasury Wallet");
    expect(escapePlotText("0x1234")).toBe("0x1234");
  });
});
