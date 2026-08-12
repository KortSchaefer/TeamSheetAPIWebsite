import { describe, expect, it } from "vitest";
import indexHtml from "../public/index.html?raw";
import studioHtml from "../public/team-sheet-studio.html?raw";

describe("Server CSV browser import", () => {
  it.each([
    ["legacy team sheet", indexHtml],
    ["team sheet studio", studioHtml],
  ])("normalizes punctuation at the edge of BLAST headers in the %s", (_page, html) => {
    const declaration = html.match(/const normalizeHeader = \(h\) => ([^;]+);/u);
    expect(declaration).not.toBeNull();
    const normalizeHeader = new Function("h", `return ${declaration?.[1]};`) as (header: string) => string;

    expect(normalizeHeader("BLAST %")).toBe("blast");
    expect(normalizeHeader(" BLAST Percentage ")).toBe("blast_percentage");
    expect(html).toContain("'blast', 'blast_percent', 'blast_percentage', 'blast_score'");
    expect(html).toContain("const upsell_score = toBlastNumber(");
  });
});
