// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { Paper } from "./domain/paper";
import { getDailyRecommendations } from "./services/dailyRecommendations";
import { getOpenAlexPaperRelations } from "./services/openAlexRelations";
import { resolveFullTextLocations } from "./services/fullTextResolver";
import { listJournalPapers, searchJournals } from "./services/journalBrowse";
import { searchPapers, type AcademicSearchRequest, type AcademicSearchResult } from "./services/search";

vi.mock("./services/dailyRecommendations", () => ({ getDailyRecommendations: vi.fn() }));
vi.mock("./services/openAlexRelations", () => ({ getOpenAlexPaperRelations: vi.fn() }));
vi.mock("./services/journalBrowse", () => ({ listJournalPapers: vi.fn(), searchJournals: vi.fn() }));
vi.mock("./services/search", () => ({ searchPapers: vi.fn() }));
vi.mock("./services/fullTextResolver", () => ({
  resolveFullTextLocations: vi.fn(async () => ({ locations: [], sources: [], warnings: [] })),
}));

const paper: Paper = {
  id: "W1", title: "First paper", authors: ["Author"], year: 2026,
  venue: "Journal", citedByCount: 1, isOpenAccess: false, source: "openalex",
};

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.mocked(getDailyRecommendations).mockResolvedValue([{ paper, reason: "Test" }]);
});
afterEach(cleanup);

const searchResult = (papers: Paper[], hasMore = false, page = 1): AcademicSearchResult => ({
  papers, sources: ["openalex"], warnings: [], page, hasMore,
});

function submitSearch(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "搜索论文" }), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
}

describe("responsive paper search", () => {
  it("follows the best result until the user explicitly selects a paper", async () => {
    let request!: AcademicSearchRequest;
    let finish!: (value: AcademicSearchResult) => void;
    vi.mocked(searchPapers).mockImplementation((_query, options) => {
      request = options!;
      return new Promise((resolve) => { finish = resolve; });
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^发现/ }));
    submitSearch("attention is all you need");
    await act(async () => request.onProgress?.({
      ...searchResult([paper]), completed: 1, total: 2, pendingSources: ["openalex"],
    }));
    expect(screen.getByRole("heading", { name: paper.title })).toBeTruthy();
    const original = { ...paper, id: "original", title: "Attention Is All You Need", year: 2017 };
    await act(async () => finish(searchResult([original, paper])));
    expect(screen.getByRole("heading", { name: original.title })).toBeTruthy();
  });

  it("displays partial results and retains the selected paper when ranking and canonical IDs change", async () => {
    let request!: AcademicSearchRequest;
    let finish!: (value: AcademicSearchResult) => void;
    vi.mocked(searchPapers).mockImplementation((_query, options) => {
      request = options!;
      return new Promise((resolve) => { finish = resolve; });
    });
    const selected: Paper = { ...paper, id: "crossref-id", doi: "10.5555/selected", title: "Selected paper", source: "crossref" };
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^发现/ }));
    submitSearch("attention");
    await act(async () => request.onProgress?.({
      ...searchResult([paper, selected]), completed: 1, total: 2, pendingSources: ["openalex"],
    }));
    fireEvent.click(await screen.findByRole("button", { name: /Selected paper/ }));
    expect(screen.getByRole("heading", { name: "Selected paper" })).toBeTruthy();
    await act(async () => finish(searchResult([
      { ...paper, id: "W-new", title: "New top result" },
      { ...selected, id: "W-selected", source: "openalex", abstract: "Richer metadata" },
    ])));
    expect(screen.getByRole("heading", { name: "Selected paper" })).toBeTruthy();
    expect(screen.getAllByText("Richer metadata").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "停止搜索" })).toBeNull();
  });

  it("allows a new query while searching, aborts the old request, and ignores stale progress", async () => {
    let oldRequest!: AcademicSearchRequest;
    let finishOld!: (value: AcademicSearchResult) => void;
    vi.mocked(searchPapers)
      .mockImplementationOnce((_query, options) => {
        oldRequest = options!;
        return new Promise((resolve) => { finishOld = resolve; });
      })
      .mockResolvedValueOnce(searchResult([{ ...paper, id: "W-new", title: "New query result" }]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^发现/ }));
    submitSearch("old query");
    submitSearch("new query");
    await screen.findByRole("heading", { name: "New query result" });
    expect(oldRequest.signal?.aborted).toBe(true);
    await act(async () => {
      oldRequest.onProgress?.({ ...searchResult([paper]), completed: 1, total: 2, pendingSources: ["crossref"] });
      finishOld(searchResult([paper]));
    });
    expect(screen.getByRole("heading", { name: "New query result" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "First paper" })).toBeNull();
  });

  it("stops an active search without discarding partial results or showing a network error", async () => {
    let request!: AcademicSearchRequest;
    let finish!: (value: AcademicSearchResult) => void;
    vi.mocked(searchPapers).mockImplementation((_query, options) => {
      request = options!;
      return new Promise((resolve) => { finish = resolve; });
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^发现/ }));
    submitSearch("attention");
    await act(async () => request.onProgress?.({
      ...searchResult([paper], true), completed: 1, total: 2, pendingSources: ["crossref"],
    }));
    fireEvent.click(screen.getByRole("button", { name: "停止搜索" }));
    expect(request.signal?.aborted).toBe(true);
    expect(screen.getByRole("heading", { name: "First paper" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "加载更多结果" })).toBeNull();
    await act(async () => finish(searchResult([{ ...paper, title: "Late result" }])));
    expect(screen.queryByText("Late result")).toBeNull();
  });

  it("retries the failed page and submitted query without losing earlier results", async () => {
    vi.mocked(searchPapers)
      .mockResolvedValueOnce(searchResult([paper], true))
      .mockRejectedValueOnce(new Error("Second page unavailable"))
      .mockResolvedValueOnce(searchResult([{ ...paper, id: "W2", title: "Second page paper" }], false, 2));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^发现/ }));
    submitSearch("attention");
    fireEvent.click(await screen.findByRole("button", { name: "加载更多结果" }));
    await screen.findByRole("alert");
    fireEvent.change(screen.getByRole("textbox", { name: "搜索论文" }), { target: { value: "unsubmitted draft" } });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("button", { name: /Second page paper/ });
    expect(searchPapers).toHaveBeenNthCalledWith(3, "attention", expect.objectContaining({ page: 2 }));
    expect(screen.getByRole("button", { name: /First paper/ })).toBeTruthy();
  });

  it("keeps newly discovered PDF links and richer metadata across overlapping search and full-text responses", async () => {
    let request!: AcademicSearchRequest;
    let finishSearch!: (value: AcademicSearchResult) => void;
    let finishLookup!: (value: Awaited<ReturnType<typeof resolveFullTextLocations>>) => void;
    vi.mocked(searchPapers).mockImplementation((_query, options) => {
      request = options!;
      return new Promise((resolve) => { finishSearch = resolve; });
    });
    vi.mocked(resolveFullTextLocations).mockImplementationOnce(() => new Promise((resolve) => { finishLookup = resolve; }));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^发现/ }));
    submitSearch("attention");
    await act(async () => request.onProgress?.({
      ...searchResult([paper]), completed: 1, total: 3, pendingSources: ["openalex", "crossref"],
    }));
    await waitFor(() => expect(resolveFullTextLocations).toHaveBeenCalled());
    const richer = { ...paper, abstract: "Abstract from the next search channel" };
    await act(async () => request.onProgress?.({
      ...searchResult([richer]), completed: 2, total: 3, pendingSources: ["crossref"],
    }));
    await act(async () => finishLookup({
      locations: [{ url: "https://example.org/confirmed.pdf", source: "core", kind: "pdf", isOpenAccess: true, license: null, version: null }],
      sources: ["CORE"], warnings: [],
    }));
    expect(screen.getByRole("button", { name: "下载并阅读" })).toBeTruthy();
    expect(screen.getAllByText(richer.abstract).length).toBeGreaterThan(0);
    await act(async () => finishSearch(searchResult([paper])));
    expect(screen.getByRole("button", { name: "下载并阅读" })).toBeTruthy();
    expect(screen.getAllByText(richer.abstract).length).toBeGreaterThan(0);
  });

  it("retries an interrupted second page without skipping pages or duplicating early results", async () => {
    let request!: AcademicSearchRequest;
    let finish!: (value: AcademicSearchResult) => void;
    const second = { ...paper, id: "W2", title: "Second page paper" };
    vi.mocked(searchPapers)
      .mockResolvedValueOnce(searchResult([paper], true))
      .mockImplementationOnce((_query, options) => {
        request = options!;
        return new Promise((resolve) => { finish = resolve; });
      })
      .mockResolvedValueOnce(searchResult([second], false, 2));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^发现/ }));
    submitSearch("attention");
    fireEvent.click(await screen.findByRole("button", { name: "加载更多结果" }));
    await act(async () => request.onProgress?.({
      ...searchResult([second], true, 2), completed: 1, total: 2, pendingSources: ["crossref"],
    }));
    fireEvent.click(screen.getByRole("button", { name: "停止搜索" }));
    fireEvent.click(screen.getByRole("button", { name: "加载更多结果" }));
    await waitFor(() => expect(searchPapers).toHaveBeenCalledTimes(3));
    expect(searchPapers).toHaveBeenNthCalledWith(3, "attention", expect.objectContaining({ page: 2 }));
    expect(screen.getAllByRole("button", { name: /Second page paper/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /First paper/ })).toBeTruthy();
    await act(async () => finish(searchResult([{ ...second, title: "Stale page" }], true, 2)));
    expect(screen.queryByText("Stale page")).toBeNull();
  });

  it("aborts the current search when the app is unmounted", () => {
    let request!: AcademicSearchRequest;
    vi.mocked(searchPapers).mockImplementation((_query, options) => {
      request = options!;
      return new Promise(() => {});
    });
    const { unmount } = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^发现/ }));
    submitSearch("attention");
    unmount();
    expect(request.signal?.aborted).toBe(true);
  });
});

describe("discovery navigation", () => {
  it("clears incompatible filters and prevents an old search from replacing a recommendation", async () => {
    let finishSearch!: (value: AcademicSearchResult) => void;
    vi.mocked(searchPapers).mockImplementation(() => new Promise((resolve) => { finishSearch = resolve; }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "查找 First paper" }));
    fireEvent.click(screen.getByRole("button", { name: "综述" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索论文" }), { target: { value: "pending search" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.click(screen.getByRole("button", { name: /首页/ }));
    fireEvent.click(await screen.findByRole("button", { name: "查找 First paper" }));
    await act(async () => finishSearch({
      papers: [{ ...paper, id: "W3", title: "Stale search result" }],
      sources: [], warnings: [], page: 1, hasMore: false,
    }));
    expect(screen.getByRole("heading", { name: "First paper" })).toBeTruthy();
    expect(screen.queryByText("Stale search result")).toBeNull();
    expect(screen.getByRole("button", { name: "综述" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a related paper selected even though it was not in the original results", async () => {
    const related = { ...paper, id: "W2", title: "Related paper" };
    vi.mocked(getOpenAlexPaperRelations).mockResolvedValue({
      target: paper, recommendations: [related], references: [], citedBy: [], warnings: [],
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "查找 First paper" }));
    fireEvent.click(screen.getByRole("button", { name: "加载引用与相关推荐" }));
    fireEvent.click(await screen.findByRole("button", { name: /Related paper/ }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Related paper" })).toBeTruthy();
    });
    expect(screen.queryByRole("heading", { name: "First paper" })).toBeNull();
  });

  it("ignores old journal articles arriving after a new journal search", async () => {
    const journal = { id: "S1", name: "Old journal", issn: null, worksCount: 1, isOpenAccess: false };
    const next = { ...journal, id: "S2", name: "New journal" };
    let finishOld!: (value: { papers: Paper[]; hasMore: boolean }) => void;
    vi.mocked(searchJournals).mockResolvedValueOnce([journal]).mockResolvedValueOnce([next]);
    vi.mocked(listJournalPapers)
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce({ papers: [{ ...paper, title: "New article" }], hasMore: false });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "期刊" }));
    await waitFor(() => expect(listJournalPapers).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索期刊" }), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索期刊" }));
    await screen.findByText("New article");
    await act(async () => finishOld({ papers: [{ ...paper, title: "Stale article" }], hasMore: true }));
    expect(screen.queryByText("Stale article")).toBeNull();
    expect(screen.getByText("New article")).toBeTruthy();
  });
});
