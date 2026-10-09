import { describe, expect, it, vi } from "vitest";
import { listJournalPapers, searchJournals } from "./journalBrowse";

describe("journal browsing", () => {
  it("searches journal sources and keeps ISSN and access status", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ results: [
      { id: "https://openalex.org/S123", type: "journal", display_name: "Nature Methods",
        issn_l: "1548-7091", works_count: 100, is_oa: false, homepage_url: "https://nature.com/nmeth" },
      { id: "https://openalex.org/S124", type: "repository", display_name: "Not a journal" },
    ] })));
    const journals = await searchJournals("Nature Methods", fetchMock);
    expect(journals).toEqual([expect.objectContaining({
      id: "S123", name: "Nature Methods", issn: "1548-7091", isOpenAccess: false,
    })]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("search=Nature+Methods");
  });

  it("loads a selected journal's latest article page", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      meta: { count: 21 }, results: [{ id: "https://openalex.org/W12", display_name: "Real Paper",
        publication_year: 2026, type: "article" }],
    })));
    const page = await listJournalPapers({ id: "S123" }, 1, fetchMock);
    expect(page.papers[0].title).toBe("Real Paper");
    expect(page.hasMore).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain("primary_location.source.id%3AS123");
    await expect(listJournalPapers({ id: "S123,other" }, 1, fetchMock)).rejects.toThrow("标识符");
  });

  it("uses the ISSN filter when the input is an ISSN", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ results: [] })));
    await searchJournals("15487091", fetchMock);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("filter")).toBe("type:journal,issn:1548-7091");
    expect(url.searchParams.has("search")).toBe(false);
  });
});
