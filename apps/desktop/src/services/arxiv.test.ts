import { describe, expect, it, vi } from "vitest";
import { mapArxivRecord, searchArxivPage } from "./arxiv";
import { openAccessPdfLocations } from "../domain/access";

const entry = (overrides = {}) => ({ id: "10.48550/arxiv.1706.03762", attributes: {
  titles: [{ title: "Attention Is All You Need" }], publicationYear: 2017,
  creators: [{ name: "Vaswani, Ashish" }],
  descriptions: [{ descriptionType: "Abstract", description: "An original abstract." }],
  ...overrides,
} });
const response = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => Response.json(body, { status }));

describe("arXiv metadata channel", () => {
  it("offers the reviewed official PDF as soon as the original search result arrives", () => {
    const paper = mapArxivRecord(entry())!;
    expect(new URL(openAccessPdfLocations(paper.accessLocations!)[0].url).hostname).toBe("papers.nips.cc");
  });

  it("uses the official deposited identifier to build PDF links, not arbitrary metadata URLs", () => {
    expect(mapArxivRecord(entry({ url: "https://untrusted.example/paper" }))).toMatchObject({
      doi: "10.48550/arxiv.1706.03762", year: 2017, authors: ["Ashish Vaswani"],
      abstract: "An original abstract.", openAccessUrl: "https://arxiv.org/pdf/1706.03762",
    });
    expect(mapArxivRecord({ ...entry(), id: "10.9999/not-arxiv" })).toBeUndefined();
    expect(mapArxivRecord(entry({ titles: [] }))).toBeUndefined();
    expect(mapArxivRecord(null)).toBeUndefined();
    expect(mapArxivRecord(entry({ publicationYear: "2017" }))?.year).toBeNull();
  });

  it("supports old arXiv identifiers containing a subject path", () => {
    expect(mapArxivRecord({ ...entry(), id: "10.48550/arxiv.hep-th/9901001" })?.openAccessUrl)
      .toBe("https://arxiv.org/pdf/hep-th/9901001");
  });

  it("restricts title retrieval to arXiv deposits and uses relevance, not deposit recency", async () => {
    const fetcher = response({ data: [entry()], meta: { total: 71 } });
    const controller = new AbortController();
    const page = await searchArxivPage("attention is all you need", { exactTitle: true, signal: controller.signal }, fetcher);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get("client-id")).toBe("arxiv.content");
    expect(url.searchParams.get("query")).toBe('titles.title:"attention is all you need"');
    expect(url.searchParams.get("sort")).toBe("relevance");
    expect(fetcher.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(page).toMatchObject({ total: 71, hasMore: true });
  });

  it("escapes user query syntax and forwards the requested page and year filter", async () => {
    const fetcher = response({ data: [], meta: { total: 0 } });
    await searchArxivPage('a "quoted" title', { exactTitle: true, page: 2, recentSinceYear: 2022 }, fetcher);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get("query")).toBe('(titles.title:"a \\"quoted\\" title") AND publicationYear:[2022 TO *]');
    expect(url.searchParams.get("page[number]")).toBe("2");
  });

  it("resolves original identifiers directly and rejects mismatched records", async () => {
    const fetcher = response({ data: entry() });
    expect((await searchArxivPage("1706.03762", { doi: "10.48550/arxiv.1706.03762" }, fetcher)).papers).toHaveLength(1);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/dois/10.48550%2Farxiv.1706.03762");
    expect((await searchArxivPage("x", { doi: "10.48550/arxiv.1810.04805" }, fetcher)).papers).toEqual([]);
    expect((await searchArxivPage("x", { doi: "10.5555/elsewhere" }, fetcher)).papers).toEqual([]);
    expect((await searchArxivPage("x", { doi: "10.48550/arxiv.1706.03762" }, response({}, 404))).papers).toEqual([]);
  });

  it("reports invalid payloads and upstream errors instead of claiming no results", async () => {
    await expect(searchArxivPage("attention", {}, response({ error: "bad payload" }))).rejects.toThrow("数据格式");
    await expect(searchArxivPage("attention", {}, response({}, 429))).rejects.toThrow("限流");
    const controller = new AbortController();
    controller.abort();
    const aborted = vi.fn<typeof fetch>(async () => { throw new DOMException("Aborted", "AbortError"); });
    await expect(searchArxivPage("attention", { signal: controller.signal }, aborted)).rejects.toMatchObject({ name: "AbortError" });
  });
});
