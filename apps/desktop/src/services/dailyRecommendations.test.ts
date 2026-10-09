import { describe, expect, it, vi } from "vitest";
import { getDailyRecommendations, recommendationFocuses } from "./dailyRecommendations";
import type { Paper } from "../domain/paper";

const saved: Paper = {
  id: "W1", title: "Attention Is All You Need", authors: [], year: 2017,
  venue: "NeurIPS", citedByCount: 0, isOpenAccess: true, source: "openalex",
};

describe("daily recommendations", () => {
  it("uses a saved paper topic plus rotating general topics", () => {
    const result = recommendationFocuses([saved], new Date(2026, 8, 12));
    expect(result[0]).toBe("attention");
    expect(result).toHaveLength(3);
  });

  it("loads real article records and never recommends the saved work", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ results: [
      { id: "https://openalex.org/W1", display_name: saved.title, publication_year: 2017 },
      { id: "https://openalex.org/W2", display_name: "New Attention Research", publication_year: 2026,
        authorships: [{ author: { display_name: "A. Researcher" } }],
      },
    ] })));
    const result = await getDailyRecommendations([saved], new Date(2026, 8, 12), fetchMock);
    expect(result[0].paper.id).toBe("W2");
    expect(result[0].reason).toContain("资料库主题");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain("from_publication_date");
    expect(String(fetchMock.mock.calls[0][0])).toContain("to_publication_date");
    expect(String(fetchMock.mock.calls[0][0])).toContain("relevance_score%3Adesc");
  });

  it("keeps partial recommendations if one focus fails", async () => {
    let calls = 0;
    const result = await getDailyRecommendations([], new Date(2026, 8, 12), async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return new Response(JSON.stringify({ results: [{
        id: "https://openalex.org/W3", display_name: "Causal Inference Paper", publication_year: 2026,
      }] }));
    });
    expect(result).toHaveLength(1);
  });
});
