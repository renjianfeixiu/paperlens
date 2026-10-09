import { describe, expect, it, vi } from "vitest";

import {
  cleanCrossrefText,
  CrossrefSearchError,
  mapCrossrefWork,
  searchCrossref,
  searchCrossrefPage,
} from "./crossref";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("Crossref request cancellation", () => {
  it("passes the search signal through to the real request adapter", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
    }));
    const pending = searchCrossrefPage("attention", { signal: controller.signal }, fetchMock);
    const aborted = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await aborted;
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});

describe("Crossref mapping", () => {
  it("removes JATS markup and decodes common entities", () => {
    expect(
      cleanCrossrefText(
        "<jats:p>A <jats:bold>useful</jats:bold> result &amp; an &#x3b1; value.</jats:p>",
      ),
    ).toBe("A useful result & an α value.");
  });

  it("removes entity-escaped markup instead of showing tags in the UI", () => {
    expect(
      cleanCrossrefText(
        "&lt;strong&gt;How retrieval works&lt;/strong&gt; &amp;amp; why it matters.",
      ),
    ).toBe("How retrieval works & why it matters.");
  });

  it("maps Crossref metadata into the unified Paper model", () => {
    expect(
      mapCrossrefWork({
        DOI: "HTTPS://DOI.ORG/10.5555/EXAMPLE.42",
        URL: "https://doi.org/10.5555/example.42",
        title: ["<i>Evidence</i> for open research"],
        author: [
          { given: "Ada", family: "Lovelace" },
          { name: "The PaperLens Consortium" },
        ],
        "published-print": { "date-parts": [[2024, 6, 1]] },
        "container-title": ["Journal of Useful Results"],
        abstract: "<jats:p>Open &amp; reproducible.</jats:p>",
        "is-referenced-by-count": 19,
        license: [{ URL: "https://creativecommons.org/licenses/by/4.0/" }],
        link: [
          { URL: "https://publisher.example/article", "content-type": "text/html" },
          { URL: "https://publisher.example/article.pdf", "content-type": "application/pdf" },
        ],
      }),
    ).toEqual({
      id: "10.5555/example.42",
      title: "Evidence for open research",
      authors: ["Ada Lovelace", "The PaperLens Consortium"],
      year: 2024,
      venue: "Journal of Useful Results",
      abstract: "Open & reproducible.",
      doi: "10.5555/example.42",
      citedByCount: 19,
      isOpenAccess: true,
      openAccessUrl: "https://publisher.example/article.pdf",
      accessLocations: [
        {
          url: "https://publisher.example/article",
          kind: "landing-page",
          source: "crossref",
          isOpenAccess: true,
          license: "https://creativecommons.org/licenses/by/4.0/",
          version: null,
          hostType: "publisher",
          hostName: "publisher.example",
        },
        {
          url: "https://publisher.example/article.pdf",
          kind: "pdf",
          source: "crossref",
          isOpenAccess: true,
          license: "https://creativecommons.org/licenses/by/4.0/",
          version: null,
          hostType: "publisher",
          hostName: "publisher.example",
        },
        {
          url: "https://doi.org/10.5555/example.42",
          kind: "landing-page",
          source: "crossref",
          isOpenAccess: true,
          license: "https://creativecommons.org/licenses/by/4.0/",
          version: null,
          hostType: "publisher",
          hostName: "doi.org",
        },
      ],
      source: "crossref",
    });
  });

  it("does not present an unlicensed publisher link as open access", () => {
    const result = mapCrossrefWork({
      DOI: "10.5555/paywalled",
      title: ["Publisher-hosted article"],
      license: [{ URL: "https://www.publisher.example/text-and-data-mining-license" }],
      link: [{ URL: "https://publisher.example/article.pdf", "content-type": "application/pdf" }],
    });

    expect(result.isOpenAccess).toBe(false);
    expect(result).not.toHaveProperty("openAccessUrl");
    expect(result.accessLocations?.find((location) => location.kind === "pdf")).toMatchObject({
      isOpenAccess: false,
      license: "https://www.publisher.example/text-and-data-mining-license",
    });
  });

  it("does not accept lookalike license URLs or licenses for another content version", () => {
    const spoofed = mapCrossrefWork({
      DOI: "10.5555/spoofed",
      title: ["Spoofed license"],
      license: [{ URL: "https://evil.example/?next=creativecommons.org/licenses/by/4.0" }],
      link: [{ URL: "https://publisher.example/spoofed.pdf", "content-type": "application/pdf" }],
    });
    const mismatched = mapCrossrefWork({
      DOI: "10.5555/mismatch",
      title: ["Mismatched version"],
      license: [
        {
          URL: "https://creativecommons.org/licenses/by/4.0/",
          "content-version": "am",
        },
      ],
      link: [
        {
          URL: "https://publisher.example/version-of-record.pdf",
          "content-type": "application/pdf; charset=binary",
          "content-version": "vor",
        },
      ],
    });

    expect(spoofed.isOpenAccess).toBe(false);
    expect(mismatched.isOpenAccess).toBe(false);
    expect(mismatched.accessLocations?.[0]).toMatchObject({
      kind: "pdf",
      isOpenAccess: false,
      license: null,
      version: "vor",
    });
  });

  it("drops unsafe and malformed access URLs", () => {
    const result = mapCrossrefWork({
      title: ["Dirty locations"],
      URL: "javascript:alert(1)",
      resource: { primary: { URL: "not a url" } },
      license: [{ URL: "https://creativecommons.org/licenses/by/4.0/" }],
      link: [
        { URL: "file:///tmp/paper.pdf", "content-type": "application/pdf" },
        { URL: "https://user:secret@example.org/paper.pdf", "content-type": "application/pdf" },
      ],
    });

    expect(result.accessLocations).toBeUndefined();
    expect(result.isOpenAccess).toBe(false);
    expect(result.openAccessUrl).toBeUndefined();
  });

  it("uses non-invented defaults for sparse records", () => {
    expect(mapCrossrefWork({ title: ["Sparse record"] })).toEqual({
      id: "metadata:sparse-record||",
      title: "Sparse record",
      authors: [],
      year: null,
      venue: "",
      citedByCount: 0,
      isOpenAccess: false,
      source: "crossref",
    });
  });
});

describe("searchCrossref", () => {
  it("builds an encoded request and maps the returned items", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        status: "ok",
        message: {
          items: [{ DOI: "10.5555/quantum", title: ["Quantum paper"] }],
        },
      }),
    );

    const results = await searchCrossref("  quantum mechanics  ", fetchMock as typeof fetch);

    expect(results).toHaveLength(1);
    const [input, init] = fetchMock.mock.calls[0];
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("https://api.crossref.org/works");
    expect(url.searchParams.get("query.bibliographic")).toBe("quantum mechanics");
    expect(url.searchParams.get("rows")).toBe("35");
    expect(init).toMatchObject({ headers: { Accept: "application/json" } });
    expect(results[0]).toMatchObject({
      id: "10.5555/quantum",
      doi: "10.5555/quantum",
      source: "crossref",
    });
  });

  it("rejects an empty query without making a request", async () => {
    const fetchMock = vi.fn();

    await expect(searchCrossref("   ", fetchMock as typeof fetch)).rejects.toMatchObject({
      code: "invalid-query",
      message: "请输入论文关键词、标题或 DOI。",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps a network failure in a searchable domain error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(searchCrossref("biology", fetchMock as typeof fetch)).rejects.toMatchObject({
      name: "CrossrefSearchError",
      code: "network",
      message: "无法连接 Crossref，请检查网络后重试。",
    });
  });

  it.each([
    [429, "rate-limited"],
    [403, "unauthorized"],
    [503, "upstream"],
  ] as const)("classifies an HTTP %i response as %s", async (status, code) => {
    const fetchMock = vi.fn(async () => new Response(null, { status }));

    await expect(searchCrossref("biology", fetchMock as typeof fetch)).rejects.toEqual(
      expect.objectContaining<Partial<CrossrefSearchError>>({ code, status }),
    );
  });

  it("rejects malformed JSON", async () => {
    const fetchMock = vi.fn(
      async () => new Response("not-json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(searchCrossref("biology", fetchMock as typeof fetch)).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it.each([
    { status: "ok", message: { results: [] } },
    { status: "error", message: { items: [] } },
    { status: "ok", message: { items: [null] } },
  ])("rejects an invalid successful payload", async (body) => {
    const fetchMock = vi.fn(async () => jsonResponse(body));

    await expect(searchCrossref("biology", fetchMock as typeof fetch)).rejects.toMatchObject({
      code: "invalid-response",
    });
  });
});
