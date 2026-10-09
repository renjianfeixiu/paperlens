import { describe, expect, it, vi } from "vitest";

import {
  getOpenAlexPaperRelations,
  OpenAlexRelationsError,
} from "./openAlexRelations";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function work(id: string, title: string, doi?: string) {
  return {
    id: `https://openalex.org/${id}`,
    display_name: title,
    publication_year: 2024,
    authorships: [{ author: { display_name: "PaperLens Author" } }],
    ...(doi ? { doi } : {}),
  };
}

describe("getOpenAlexPaperRelations", () => {
  it("loads all three relation groups, removes duplicates, and preserves ID order", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/works/W100")) {
        return jsonResponse({
          ...work("W100", "Target paper"),
          referenced_works: [
            "https://openalex.org/W2",
            "W1",
            "https://openalex.org/W2",
            "invalid",
            "W100",
          ],
          related_works: ["W3", "W100", "https://openalex.org/W4"],
        });
      }

      const filter = url.searchParams.get("filter");
      if (filter === "openalex:W2|W1") {
        return jsonResponse({
          results: [
            work("W1", "First reference"),
            work("W2", "Second reference"),
            work("W2", "Second reference"),
          ],
        });
      }
      if (filter === "cites:W100") {
        return jsonResponse({
          results: [
            work("W5", "Citing work", "10.5555/CITING"),
            work("W6", "Duplicate citing work", "https://doi.org/10.5555/citing"),
            work("W100", "Target paper"),
          ],
        });
      }
      if (filter === "openalex:W3|W4") {
        return jsonResponse({
          results: [
            work("W4", "Fourth recommendation"),
            work("W3", "Third recommendation"),
          ],
        });
      }

      throw new Error(`Unexpected OpenAlex request: ${url}`);
    });

    const result = await getOpenAlexPaperRelations("W100", {
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.target).toMatchObject({
      id: "W100",
      title: "Target paper",
      source: "openalex",
    });
    expect(result.references.map(({ id }) => id)).toEqual(["W2", "W1"]);
    expect(result.citedBy.map(({ id }) => id)).toEqual(["W5"]);
    expect(result.recommendations.map(({ id }) => id)).toEqual(["W3", "W4"]);
    expect(result.warnings).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    for (const [input, init] of fetchMock.mock.calls) {
      const url = new URL(String(input));
      expect(url.searchParams.get("select")).toContain("best_oa_location");
      expect(init).toMatchObject({ headers: { Accept: "application/json" } });
    }
  });

  it("accepts a DOI and returns stable empty groups", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/works/https://doi.org/10.5555/example")) {
        return jsonResponse({
          ...work("W7", "DOI target", "10.5555/example"),
          referenced_works: [],
          related_works: null,
        });
      }
      if (url.searchParams.get("filter") === "cites:W7") {
        return jsonResponse({ results: [] });
      }

      throw new Error(`Unexpected OpenAlex request: ${url}`);
    });

    const result = await getOpenAlexPaperRelations(
      " DOI:10.5555/EXAMPLE ",
      { fetchImpl: fetchMock as typeof fetch },
    );

    expect(result.target).toMatchObject({ id: "W7", doi: "10.5555/example" });
    expect(result.references).toEqual([]);
    expect(result.citedBy).toEqual([]);
    expect(result.recommendations).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a Paper DOI when its source ID is not an OpenAlex ID", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/works/https://doi.org/10.5555/crossref")) {
        return jsonResponse({
          ...work("W8", "Crossref target", "10.5555/crossref"),
          referenced_works: [],
          related_works: [],
        });
      }
      return jsonResponse({ results: [] });
    });

    const result = await getOpenAlexPaperRelations(
      {
        id: "10.5555/crossref",
        doi: "10.5555/crossref",
        source: "crossref",
      },
      { fetchImpl: fetchMock as typeof fetch },
    );

    expect(result.target.id).toBe("W8");
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toContain(
      "/works/https://doi.org/10.5555/crossref",
    );
  });

  it("honors per-group limits and skips groups with a zero limit", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/works/W10")) {
        return jsonResponse({
          ...work("W10", "Target"),
          referenced_works: ["W1", "W2", "W3"],
          related_works: ["W4"],
        });
      }

      expect(url.searchParams.get("filter")).toBe("openalex:W1|W2");
      expect(url.searchParams.get("per_page")).toBe("2");
      return jsonResponse({ results: [work("W1", "One"), work("W2", "Two")] });
    });

    const result = await getOpenAlexPaperRelations("W10", {
      fetchImpl: fetchMock as typeof fetch,
      limits: { references: 2, citedBy: 0, recommendations: 0 },
    });

    expect(result.references).toHaveLength(2);
    expect(result.citedBy).toEqual([]);
    expect(result.recommendations).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps successful groups when independent relation requests fail", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/works/W20")) {
        return jsonResponse({
          ...work("W20", "Target"),
          referenced_works: ["W1"],
          related_works: ["W2"],
        });
      }

      const filter = url.searchParams.get("filter");
      if (filter === "openalex:W1") {
        return new Response(null, { status: 503 });
      }
      if (filter === "cites:W20") {
        return jsonResponse({ results: [work("W3", "Citing work")] });
      }
      if (filter === "openalex:W2") {
        return jsonResponse({ data: [] });
      }

      throw new Error(`Unexpected OpenAlex request: ${url}`);
    });

    const result = await getOpenAlexPaperRelations("W20", {
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.references).toEqual([]);
    expect(result.citedBy.map(({ id }) => id)).toEqual(["W3"]);
    expect(result.recommendations).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        relation: "references",
        message: expect.stringContaining("参考文献暂时无法加载"),
      }),
      expect.objectContaining({
        relation: "recommendations",
        message: expect.stringContaining("相关推荐暂时无法加载"),
      }),
    ]);
  });

  it("rejects an invalid identifier before making a request", async () => {
    const fetchMock = vi.fn();

    await expect(
      getOpenAlexPaperRelations("not-a-paper", {
        fetchImpl: fetchMock as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "OpenAlexRelationsError",
      code: "invalid-identifier",
      message: "无法识别这篇论文，请提供 OpenAlex 论文 ID 或有效 DOI。",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps a target network failure in a Chinese domain error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(
      getOpenAlexPaperRelations("W30", {
        fetchImpl: fetchMock as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "network",
      message: "无法连接 OpenAlex，请检查网络后重试。",
    });
  });

  it.each([
    [404, "not-found"],
    [429, "rate-limited"],
    [403, "unauthorized"],
    [503, "upstream"],
  ] as const)("classifies target HTTP %i as %s", async (status, code) => {
    const fetchMock = vi.fn(async () => new Response(null, { status }));

    await expect(
      getOpenAlexPaperRelations("W40", {
        fetchImpl: fetchMock as typeof fetch,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<OpenAlexRelationsError>>({ code, status }),
    );
  });

  it("rejects malformed target data", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ display_name: "No ID" }));

    await expect(
      getOpenAlexPaperRelations("W50", {
        fetchImpl: fetchMock as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});
