// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { searchPapers } from "./services/search";
import { downloadRemotePdf, RemotePdfError } from "./services/remotePdf";

vi.mock("./services/search", () => ({ searchPapers: vi.fn() }));
vi.mock("./services/dailyRecommendations", () => ({ getDailyRecommendations: async () => [] }));
vi.mock("./services/fullTextResolver", () => ({
  resolveFullTextLocations: async () => ({ locations: [], sources: [], warnings: [] }),
}));
vi.mock("./services/nativeFiles", async (importOriginal) => ({
  ...await importOriginal<typeof import("./services/nativeFiles")>(),
  isTauriEnvironment: () => true,
}));
vi.mock("./services/remotePdf", async (importOriginal) => ({
  ...await importOriginal<typeof import("./services/remotePdf")>(),
  downloadRemotePdf: vi.fn(),
}));

beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); });
afterEach(cleanup);

it("shows each source's actual failure instead of mislabeling all failures as the last 404", async () => {
  vi.mocked(searchPapers).mockResolvedValue({
    papers: [{
      id: "failure-test", title: "Download failure fixture", authors: ["Public fixture"],
      year: 2026, venue: "Test", citedByCount: 0, source: "openalex", isOpenAccess: true,
      accessLocations: ["arxiv.org", "missing.example"].map((host) => ({
        url: `https://${host}/paper.pdf`, kind: "pdf", source: "openalex",
        isOpenAccess: true, license: null, version: null,
      })),
    }], sources: ["openalex"], warnings: [], page: 1, hasMore: false,
  });
  vi.mocked(downloadRemotePdf)
    .mockRejectedValueOnce(new RemotePdfError("network-timeout"))
    .mockRejectedValueOnce(new RemotePdfError("http-status", { httpStatus: 404 }));
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /^发现/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "搜索论文" }), { target: { value: "fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  fireEvent.click(await screen.findByRole("button", { name: "下载并阅读" }));
  fireEvent.click(await screen.findByText("查看各来源的失败原因"));
  expect(screen.getByRole("button", { name: "arxiv.org" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "missing.example" })).toBeTruthy();
  expect(screen.getByText(/下载超时/)).toBeTruthy();
  expect(screen.getByText(/PDF 地址已失效/)).toBeTruthy();
  expect(screen.getByText(/已尝试 2 个来源/)).toBeTruthy();
  expect(downloadRemotePdf).toHaveBeenCalledTimes(2);
});
