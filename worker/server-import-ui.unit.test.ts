import { describe, expect, it } from "vitest";
import indexHtml from "../public/index.html?raw";
import studioHtml from "../public/team-sheet-studio.html?raw";
import serverListCsv from "../scripts/Server_List.csv?raw";

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
    expect(html).toContain("const in_time = hasHeader ? resolveField(headers, cells, ['in_time', 'clock_in', 'clockin', 'start_time'])");
    expect(html).toContain("in_time: emp.notes ?? null");
    expect(html).toContain("in_time: entry.in_time ?? base.in_time ?? null");
  });

  it("keeps the bundled server list upload-ready and fully populated", () => {
    const [header, ...rows] = serverListCsv.trim().split(/\r?\n/u).map((line) => line.split(","));
    expect(header).toEqual(["name", "nickname", "upsell_score", "pitty", "employment_days", "max_guests", "in_time"]);
    expect(rows).toHaveLength(23);
    for (const row of rows) {
      expect(row).toHaveLength(header.length);
      expect(row.every((value) => value.trim().length > 0)).toBe(true);
      expect(Number(row[2])).toBeGreaterThan(0);
      expect(Number(row[3])).toBeGreaterThanOrEqual(0);
      expect(Number(row[4])).toBeGreaterThan(0);
      expect(Number(row[5])).toBeGreaterThan(0);
      expect(row[6]).toMatch(/^\d{1,2}:\d{2} (?:AM|PM)$/u);
    }
  });

  it("presents a guided daily-roster import instead of an immediate upload", () => {
    expect(studioHtml).toContain('id="import-daily-roster-btn" class="primary-action"');
    expect(studioHtml).toContain('id="daily-roster-panel"');
    expect(studioHtml).toContain('id="daily-roster-preview"');
    expect(studioHtml).toContain("const previewDailyRosterFile = async (file) =>");
    expect(studioHtml).toContain("Server profile data will be updated, then this roster will be loaded for the selected date.");
    expect(studioHtml).toContain("confirmDailyRosterBtn?.addEventListener('click', async () =>");
  });
});
