import { describe, expect, it, vi } from "vitest";

import {
  mapOpenAlexWork,
  OpenAlexSearchError,
  reconstructOpenAlexAbstract,
  searchOpenAlex,
  searchOpenAlexPage,
} from "./openAlex";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("OpenAlex mapping", () => {
  it("reconstructs an abstract using token positions", () => {
    expect(
      reconstructOpenAlexAbstract({
        useful: [3],
        "PaperLens.": [4],
        makes: [1],
        papers: [2],
        This: [0],
      }),
    ).toBe("This makes papers useful PaperLens.");
  });

  it("maps a work into the unified Paper model", () => {
    expect(
      mapOpenAlexWork({
        id: "https://openalex.org/W2741809807",
        doi: "https://doi.org/10.7717/PEERJ.4375",
        display_name: "The state of OA",
        publication_year: 2018,
        authorships: [
          { author: { display_name: "Heather Piwowar" } },
          { author: { display_name: "Jason Priem" } },
        ],
        primary_location: { source: { display_name: "PeerJ" } },
        best_oa_location: {
          is_oa: true,
          landing_page_url: "https://example.org/article",
          pdf_url: "https://example.org/article.pdf",
        },
        open_access: { is_oa: true, oa_url: "https://example.org/article" },
        cited_by_count: 500,
        abstract_inverted_index: { Open: [0], science: [1], matters: [2] },
      }),
    ).toEqual({
      id: "W2741809807",
      title: "The state of OA",
      authors: ["Heather Piwowar", "Jason Priem"],
      year: 2018,
      venue: "PeerJ",
      abstract: "Open science matters",
      doi: "10.7717/peerj.4375",
      citedByCount: 500,
      isOpenAccess: true,
      openAccessUrl: "https://example.org/article.pdf",
      accessLocations: [
        {
          url: "https://example.org/article.pdf",
          kind: "pdf",
          source: "openalex",
          isOpenAccess: true,
          license: null,
          version: null,
        },
        {
          url: "https://example.org/article",
          kind: "landing-page",
          source: "openalex",
          isOpenAccess: true,
          license: null,
          version: null,
        },
      ],
      source: "openalex",
    });
  });

  it("combines all OpenAlex location fields, de-duplicates URLs, and drops unsafe URLs", () => {
    const result = mapOpenAlexWork({
      id: "W-access",
      title: "Access-rich work",
      best_oa_location: {
        pdf_url: "https://repository.example/paper.pdf#page=1",
        landing_page_url: "javascript:alert(1)",
        license: "cc-by",
        version: "acceptedVersion",
        source: { display_name: "Useful Repository", type: "repository" },
      },
      primary_location: {
        is_oa: false,
        landing_page_url: "https://publisher.example/article",
        source: { display_name: "Useful Journal", type: "journal" },
      },
      locations: [
        {
          is_oa: true,
          pdf_url: "https://repository.example/paper.pdf",
          license: "cc-by",
          version: "acceptedVersion",
          source: { display_name: "Useful Repository", type: "repository" },
        },
        { is_oa: true, pdf_url: "not a url" },
        null,
      ],
    });

    expect(result.openAccessUrl).toBe("https://repository.example/paper.pdf");
    expect(result.accessLocations).toEqual([
      {
        url: "https://repository.example/paper.pdf",
        kind: "pdf",
        source: "openalex",
        isOpenAccess: true,
        license: "cc-by",
        version: "acceptedVersion",
        hostType: "repository",
        hostName: "Useful Repository",
      },
      {
        url: "https://publisher.example/article",
        kind: "landing-page",
        source: "openalex",
        isOpenAccess: false,
        license: null,
        version: null,
        hostType: "journal",
        hostName: "Useful Journal",
      },
    ]);
  });

  it("represents missing optional metadata without fake values", () => {
    const result = mapOpenAlexWork({ id: "W123", title: "Sparse record" });

    expect(result).toMatchObject({
      id: "W123",
      title: "Sparse record",
      authors: [],
      year: null,
      venue: "",
      citedByCount: 0,
      isOpenAccess: false,
      source: "openalex",
    });
    expect(result).not.toHaveProperty("doi");
    expect(result).not.toHaveProperty("abstract");
    expect(result).not.toHaveProperty("openAccessUrl");
  });
});

describe("searchOpenAlex", () => {
  it("passes cancellation to fetch instead of treating an abort as a connection failure", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
    }));
    const pending = searchOpenAlexPage("attention", { signal: controller.signal }, fetchMock);
    const aborted = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await aborted;
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it("builds an encoded search request and maps results", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        results: [{ id: "https://openalex.org/W1", display_name: "Quantum paper" }],
      }),
    );

    const results = await searchOpenAlex("  quantum mechanics  ", fetchMock as typeof fetch);

    expect(results).toHaveLength(1);
    const [input, init] = fetchMock.mock.calls[0];
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("https://api.openalex.org/works");
    expect(url.searchParams.get("search")).toBe("quantum mechanics");
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(url.searchParams.get("select")).toContain("best_oa_location");
    expect(init).toMatchObject({ headers: { Accept: "application/json" } });
  });

  it("rejects an empty query without making a request", async () => {
    const fetchMock = vi.fn();

    await expect(searchOpenAlex("   ", fetchMock as typeof fetch)).rejects.toMatchObject({
      code: "invalid-query",
      message: "请输入论文关键词、标题或 DOI。",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns network failures into an understandable domain error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(searchOpenAlex("biology", fetchMock as typeof fetch)).rejects.toMatchObject({
      name: "OpenAlexSearchError",
      code: "network",
      message: "无法连接 OpenAlex，请检查网络后重试。",
    });
  });

  it("identifies rate limiting", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 429 }));

    await expect(searchOpenAlex("biology", fetchMock as typeof fetch)).rejects.toEqual(
      expect.objectContaining<Partial<OpenAlexSearchError>>({
        code: "rate-limited",
        status: 429,
      }),
    );
  });

  it("rejects a malformed successful response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));

    await expect(searchOpenAlex("biology", fetchMock as typeof fetch)).rejects.toMatchObject({
      code: "invalid-response",
    });
  });
});
