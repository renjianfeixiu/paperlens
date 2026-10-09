import { describe, expect, it, vi } from "vitest";
import { lookupChineseConcept } from "./conceptLookup";

describe("concept lookup", () => {
  it("returns a sourced Chinese concept summary", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("wikipedia.org")) {
        return new Response(JSON.stringify({ query: { pages: { 1: {
          title: "Attention Mechanisms", index: 1,
          extract: "Methods that select relevant information.",
        } } } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        responseData: { translatedText: "选择相关信息的方法。" },
      }), { status: 200 });
    });

    await expect(lookupChineseConcept("attention mechanism", fetchMock)).resolves.toMatchObject({
      title: "Attention Mechanisms",
      summary: "选择相关信息的方法。",
      sourceUrl: "https://en.wikipedia.org/wiki/Attention%20Mechanisms",
      sourceLabel: "维基百科 · 机器翻译",
    });
  });

  it("reports an empty result", async () => {
    await expect(lookupChineseConcept("unknown", async () => new Response("{}")))
      .rejects.toThrow("暂未找到");
  });

  it("explains apple offline and keeps the company meaning distinct", async () => {
    const fetchMock = vi.fn();
    const result = await lookupChineseConcept("苹果", fetchMock);
    expect(result.summary).toContain("水果");
    expect(result.alternatives?.[0].summary).toContain("科技公司");
    expect(result.notice).toContain("不同含义");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains the exact hardware selection from the reported screenshot", async () => {
    const fetchMock = vi.fn();
    const result = await lookupChineseConcept("NVIDIA V100 GPU", fetchMock);
    expect(result.summary).toContain("计算芯片");
    expect(result.summary).toContain("Volta");
    expect(result.sourceUrl).toContain("nvidia.com");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks up ordinary Chinese words without translating or using academic topics", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("zh.wikipedia.org");
      expect(url.searchParams.get("gsrsearch")).toBe("自行车");
      expect(url.searchParams.get("explaintext")).toBe("1");
      return new Response(JSON.stringify({ query: { pages: {
        9: { title: "自行车运动", extract: "一种体育运动。", index: 2 },
        4: { title: "自行车", extract: "以人力踩踏驱动的两轮交通工具。", index: 1 },
      } } }));
    });
    const result = await lookupChineseConcept("自行车", fetchMock);
    expect(result.title).toBe("自行车");
    expect(result.summary).toContain("交通工具");
    expect(result.alternatives?.[0].title).toBe("自行车运动");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains the source text if translation fails", async () => {
    const result = await lookupChineseConcept("bicycle", async (input) => {
      if (!String(input).includes("wikipedia.org")) throw new Error("offline");
      return new Response(JSON.stringify({ query: { pages: { 1: {
        title: "Bicycle", extract: "A human-powered vehicle.",
      } } } }));
    });
    expect(result.summary).toBe("A human-powered vehicle.");
    expect(result.sourceLabel).toContain("英文原文");
    expect(result.notice).toContain("保留原文");
  });

  it("prefers an explicitly linked Chinese article over machine translation", async () => {
    const client = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "en.wikipedia.org") return new Response(JSON.stringify({ query: { pages: { 1: {
        title: "Photosynthesis", extract: "A process used by plants.", langlinks: [{ lang: "zh", "*": "光合作用" }],
      } } } }));
      expect(url.hostname).toBe("zh.wikipedia.org");
      expect(url.searchParams.get("titles")).toBe("光合作用");
      return new Response(JSON.stringify({ query: { pages: { 2: { title: "光合作用", extract: "植物利用光能制造有机物的过程。" } } } }));
    });
    const result = await lookupChineseConcept("photosynthesis", client);
    expect(result.title).toBe("光合作用");
    expect(result.sourceLabel).toContain("对应中文词条");
    expect(client).toHaveBeenCalledTimes(2);
  });

  it("distinguishes network failure from no matching entry", async () => {
    await expect(lookupChineseConcept("自行车", async () => { throw new Error("offline"); }))
      .rejects.toThrow("连接失败");
  });
});
