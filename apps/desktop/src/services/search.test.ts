import { describe, expect, it, vi } from "vitest";

import type { Paper } from "../domain/paper";
import type { AcademicSearchProviders } from "./search";
import { AcademicSearchError, searchPapers } from "./search";

function paper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: "W1", title: "A useful paper", authors: ["Ada Lovelace"], year: 2024,
    venue: "Journal of Tests", doi: "10.5555/useful", citedByCount: 10,
    isOpenAccess: false, source: "openalex", ...overrides,
  };
}

function providers(overrides: Partial<AcademicSearchProviders> = {}): AcademicSearchProviders {
  return {
    openalex: vi.fn(async () => ({ papers: [paper()], hasMore: false, total: 1 })),
    crossref: vi.fn(async () => ({ papers: [], hasMore: false, total: 0 })),
    ...overrides,
  };
}

describe("searchPapers", () => {
  it("shows the first successful channel before the slower channel finishes", async () => {
    let finishCrossref!: (value: { papers: Paper[]; hasMore: boolean; total: number }) => void;
    const onProgress = vi.fn();
    const pending = searchPapers("10.5555/useful", { onProgress }, providers({
      crossref: () => new Promise((resolve) => { finishCrossref = resolve; }),
    }));
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      papers: [expect.objectContaining({ id: "W1" })],
      completed: 1, total: 2, pendingSources: ["crossref"],
    })));
    finishCrossref({ papers: [], hasMore: false, total: 0 });
    const result = await pending;
    expect(result.papers).toHaveLength(1);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      completed: 2, total: 2, pendingSources: [],
    }));
  });

  it("does not start providers when a search was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const searchProviders = providers();
    await expect(searchPapers("topic", { signal: controller.signal }, searchProviders))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(searchProviders.openalex).not.toHaveBeenCalled();
    expect(searchProviders.crossref).not.toHaveBeenCalled();
  });

  it("aborts every outstanding request and ignores late results even if a provider ignores cancellation", async () => {
    const controller = new AbortController();
    const onProgress = vi.fn();
    let finishCrossref!: (value: { papers: Paper[]; hasMore: boolean; total: number }) => void;
    const searchProviders = providers({
      openalex: vi.fn<AcademicSearchProviders["openalex"]>(() => new Promise(() => {})),
      crossref: vi.fn<AcademicSearchProviders["crossref"]>(() => new Promise((resolve) => { finishCrossref = resolve; })),
    });
    const pending = searchPapers("topic", { signal: controller.signal, onProgress }, searchProviders);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(searchProviders.crossref).toHaveBeenCalled());
    controller.abort();
    await rejected;
    for (const provider of [searchProviders.openalex, searchProviders.crossref]) {
      expect(vi.mocked(provider).mock.calls[0][1]?.signal?.aborted).toBe(true);
    }
    finishCrossref({ papers: [paper()], hasMore: false, total: 1 });
    await Promise.resolve();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("times out and aborts only the slow channel while retaining the successful results", async () => {
    vi.useFakeTimers();
    try {
      const slowChannel = vi.fn<AcademicSearchProviders["crossref"]>(() => new Promise(() => {}));
      const pending = searchPapers("topic", {}, providers({ crossref: slowChannel }));
      await vi.advanceTimersByTimeAsync(12_000);
      const result = await pending;
      expect(result.papers).toHaveLength(1);
      expect(result.warnings.join(" ")).toContain("Crossref");
      expect(result.warnings.join(" ")).toContain("超时");
      expect(slowChannel.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("queries both providers and merges DOI duplicates", async () => {
    const openalex = vi.fn(async () => ({ papers: [paper()], hasMore: true, total: 60 }));
    const crossref = vi.fn(async () => ({
      papers: [paper({ id: "10.5555/useful", source: "crossref", abstract: "A richer abstract.",
        citedByCount: 20, isOpenAccess: true, openAccessUrl: "https://example.org/useful.pdf" })],
      hasMore: false, total: 1,
    }));
    const result = await searchPapers("useful topic", {}, providers({ openalex, crossref }));

    expect(openalex).toHaveBeenCalledWith("useful topic", expect.objectContaining({ page: 1, mode: "lexical" }));
    expect(crossref).toHaveBeenCalledWith("useful topic", expect.objectContaining({ page: 1 }));
    expect(result.sources).toEqual(["openalex", "crossref"]);
    expect(result.warnings).toEqual([]);
    expect(result.hasMore).toBe(true);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]).toMatchObject({ abstract: "A richer abstract.", citedByCount: 20,
      isOpenAccess: true, openAccessUrl: "https://example.org/useful.pdf" });
  });

  it("expands a Chinese topic and also asks for semantic candidates", async () => {
    const searchProviders = providers();
    const result = await searchPapers("让神经网络自动关注输入中最重要的部分", {}, searchProviders);
    const calls = vi.mocked(searchProviders.openalex).mock.calls;
    expect(calls.some(([query, options]) => query.includes("attention") && options?.mode === "lexical")).toBe(true);
    expect(calls.some(([, options]) => options?.mode === "semantic")).toBe(true);
    expect(result.interpretation).toContain("attention");
  });

  it("uses exact-title retrieval for a likely paper title", async () => {
    const searchProviders = providers();
    await searchPapers("Attention Is All You Need", {}, searchProviders);
    expect(searchProviders.openalex).toHaveBeenCalledWith("Attention Is All You Need",
      expect.objectContaining({ mode: "exact", perPage: 50 }));
  });

  it("routes a DOI through identifier filters", async () => {
    const searchProviders = providers();
    await searchPapers("https://doi.org/10.5555/useful", {}, searchProviders);
    expect(searchProviders.openalex).toHaveBeenCalledWith("10.5555/useful",
      expect.objectContaining({ doi: "10.5555/useful" }));
    expect(searchProviders.crossref).toHaveBeenCalledWith("10.5555/useful",
      expect.objectContaining({ doi: "10.5555/useful" }));
  });

  it("returns partial results with a visible provider warning", async () => {
    const result = await searchPapers("topic", {}, providers({
      crossref: async () => { throw new Error("rate limited"); },
    }));
    expect(result.papers).toHaveLength(1);
    expect(result.sources).toEqual(["openalex"]);
    expect(result.warnings[0]).toContain("Crossref");
    expect(result.warnings[0]).toContain("rate limited");
  });

  it("removes indexed artifacts that are not readable papers", async () => {
    const searchProviders = providers({
      openalex: async () => ({
        papers: [
          paper({ id: "article", publicationType: "article" }),
          paper({ id: "dataset", title: "Benchmark files", publicationType: "dataset" }),
        ],
        hasMore: false,
        total: 2,
      }),
      crossref: async () => ({
        papers: [
          paper({ id: "review", title: "Review for \u201cA useful paper\u201d", publicationType: "peer-review" }),
          paper({ id: "figure", title: "Figure 2: Model architecture", publicationType: "other" }),
        ],
        hasMore: false,
        total: 2,
      }),
    });

    const result = await searchPapers("useful topic", {}, searchProviders);

    expect(result.papers.map((item) => item.id)).toEqual(["article"]);
  });

  it("fails only when every provider fails", async () => {
    await expect(searchPapers("topic", {}, providers({
      openalex: async () => Promise.reject(new Error("offline")),
      crossref: async () => Promise.reject(new Error("offline")),
    }))).rejects.toBeInstanceOf(AcademicSearchError);
  });

  it("does not mistake an empty surviving source for a complete empty page during an outage", async () => {
    await expect(searchPapers("attention", { page: 2 }, providers({
      openalex: async () => { throw new Error("rate limited"); },
      crossref: async () => ({ papers: [], hasMore: false, total: 0 }),
    }))).rejects.toBeInstanceOf(AcademicSearchError);
  });

  it("reports a failed exact-title query even if lexical queries from the same source succeed", async () => {
    const result = await searchPapers("Attention Is All You Need", {}, providers({
      openalex: async (_query, options) => {
        if (options?.mode === "exact") throw new Error("Exact-title lookup unavailable");
        return { papers: [paper()], total: 1, hasMore: false };
      },
    }));
    expect(result.papers).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("OpenAlex 部分检索未完成");
  });

  it("rejects an empty query before calling providers", async () => {
    const searchProviders = providers();
    await expect(searchPapers("  ", {}, searchProviders)).rejects.toMatchObject({
      message: "请输入论文关键词、标题或 DOI。",
    });
    expect(searchProviders.openalex).not.toHaveBeenCalled();
    expect(searchProviders.crossref).not.toHaveBeenCalled();
  });
});
