import { afterEach, describe, expect, it, vi } from "vitest";
import { openAccessPdfLocations } from "../domain/access";
import { searchPapers } from "./search";

// Minimized real-world failure: OpenAlex is rate-limited; Crossref has a 2025
// repost, while the 2017 original is registered by arXiv with DataCite.
const original = { id: "10.48550/arxiv.1706.03762", attributes: {
  doi: "10.48550/arxiv.1706.03762", titles: [{ title: "Attention Is All You Need" }],
  creators: [{ givenName: "Ashish", familyName: "Vaswani" }], publicationYear: 2017,
  url: "https://arxiv.org/abs/1706.03762", types: { resourceTypeGeneral: "Preprint" },
} };
afterEach(() => vi.unstubAllGlobals());

describe("original paper discovery through real adapters", () => {
  it.each(["attention is all you need", "Attention Is All You Need", "1706.03762", "https://doi.org/10.48550/arXiv.1706.03762"])
    ("finds the original and its PDF even without OpenAlex: %s", async (query) => {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.hostname === "api.openalex.org") return new Response("rate limited", { status: 429 });
        if (url.hostname === "api.crossref.org") return Response.json({ message: { items: [{
          DOI: "10.65215/ysbyhc05", title: ["Attention Is All You Need"],
          author: [{ given: "Ashish", family: "Vaswani" }], published: { "date-parts": [[2025]] },
          publisher: "Shenzhen Medical Academy of Research and Translation", type: "posted-content",
        }], "total-results": 1 } });
        if (url.hostname === "api.datacite.org") return Response.json({
          data: url.pathname === "/dois" ? [original] : original, meta: { total: 1 },
        });
        throw new Error(`Unexpected host: ${url.hostname}`);
      }));
      const result = await searchPapers(query);
      expect(result.papers[0]).toMatchObject({
        title: "Attention Is All You Need", authors: ["Ashish Vaswani"], year: 2017,
        doi: original.id, source: "arxiv",
      });
      expect(openAccessPdfLocations(result.papers[0].accessLocations ?? []).map((item) => item.url))
        .toContain("https://arxiv.org/pdf/1706.03762");
      expect(result.papers[0].matchReasons).toContain(query.toLowerCase().includes("attention") ? "exact-title" : "exact-identifier");
    });
});
