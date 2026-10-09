import { describe, expect, it } from "vitest";

import { analyzeSearchQuery } from "./searchQuery";

describe("analyzeSearchQuery", () => {
  it("routes DOI URLs to an exact identifier search", () => {
    expect(analyzeSearchQuery("https://doi.org/10.1000/ABC.1")).toMatchObject({
      intent: "doi",
      doi: "10.1000/abc.1",
      lexicalQueries: ["10.1000/abc.1"],
    });
  });

  it.each([
    "arXiv:1706.03762v7",
    "https://arxiv.org/abs/1706.03762",
    "https://arxiv.org/pdf/1706.03762.pdf",
  ])("recognizes an arXiv identifier in %s", (query) => {
    expect(analyzeSearchQuery(query)).toMatchObject({
      intent: "arxiv",
      doi: "10.48550/arxiv.1706.03762",
    });
  });

  it("adds transparent English terminology to a Chinese topic", () => {
    const plan = analyzeSearchQuery("让神经网络自动关注输入中最重要的部分");
    expect(plan.intent).toBe("topic");
    expect(plan.lexicalQueries).toHaveLength(2);
    expect(plan.lexicalQueries[1]).toContain("neural network");
    expect(plan.lexicalQueries[1]).toContain("attention");
    expect(plan.semanticQuery).toBe(plan.lexicalQueries[1]);
    expect(plan.interpretation).toContain("已补充英文术语");
  });

  it("treats a title-like query as an exact-title candidate", () => {
    expect(analyzeSearchQuery("Attention Is All You Need")).toMatchObject({
      intent: "title",
      exactTitleQuery: "Attention Is All You Need",
    });
  });

  it("does not require title capitalization to try an exact title", () => {
    expect(analyzeSearchQuery("attention is all you need").exactTitleQuery)
      .toBe("attention is all you need");
  });

  it("adds semantic search for a long English description", () => {
    const query = "models that dynamically focus on important image regions without recurrence";
    expect(analyzeSearchQuery(query)).toMatchObject({
      intent: "topic",
      semanticQuery: query,
    });
  });
});
