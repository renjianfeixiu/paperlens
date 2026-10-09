import { describe, expect, it } from "vitest";
import type { Paper } from "./paper";
import { filterPapers } from "./filterPapers";

function paper(overrides: Partial<Paper>): Paper {
  return {
    id: "paper",
    title: "A research paper",
    authors: [],
    year: 2026,
    venue: "Journal",
    citedByCount: 0,
    isOpenAccess: false,
    source: "openalex",
    ...overrides,
  };
}

describe("filterPapers", () => {
  const papers = [
    paper({ id: "recent-review", title: "A Systematic Review", isOpenAccess: true }),
    paper({ id: "old-review", title: "A classic survey", year: 2018, isOpenAccess: true }),
    paper({ id: "recent-closed", title: "New empirical result", year: 2025 }),
    paper({ id: "unknown-year", title: "研究综述", year: null, isOpenAccess: true }),
  ];

  it("keeps source order when no filter is active", () => {
    expect(filterPapers(papers, [], 2026)).toEqual(papers);
  });

  it("treats the reference year and previous four years as recent", () => {
    expect(filterPapers(papers, ["recent"], 2026).map(({ id }) => id)).toEqual([
      "recent-review",
      "recent-closed",
    ]);
  });

  it("combines open-access and review filters", () => {
    expect(
      filterPapers(papers, ["open-access", "review"], 2026).map(({ id }) => id),
    ).toEqual(["recent-review", "old-review", "unknown-year"]);
  });
});
