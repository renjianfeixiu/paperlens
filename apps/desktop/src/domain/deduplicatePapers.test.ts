import { describe, expect, it } from "vitest";

import type { Paper } from "./paper";
import { deduplicatePapers, getPaperDeduplicationKeys } from "./deduplicatePapers";

function paper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: "W1",
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani"],
    year: 2017,
    venue: "NeurIPS",
    citedByCount: 10,
    isOpenAccess: false,
    source: "openalex",
    ...overrides,
  };
}

describe("paper deduplication", () => {
  it("uses a canonical DOI as the strongest identity", () => {
    const results = deduplicatePapers([
      paper({ doi: "https://doi.org/10.5555/ABC", title: "Short title" }),
      paper({
        id: "crossref:1",
        source: "crossref",
        doi: "DOI:10.5555/abc",
        title: "A richer and longer paper title",
        abstract: "A useful abstract.",
        citedByCount: 42,
        isOpenAccess: true,
        openAccessUrl: "https://example.org/paper.pdf",
        accessLocations: [
          {
            url: "https://example.org/paper.pdf",
            kind: "pdf",
            source: "crossref",
            isOpenAccess: true,
            license: "https://creativecommons.org/licenses/by/4.0/",
            version: "vor",
          },
        ],
      }),
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "W1",
      source: "openalex",
      doi: "10.5555/abc",
      title: "A richer and longer paper title",
      abstract: "A useful abstract.",
      citedByCount: 42,
      isOpenAccess: true,
      openAccessUrl: "https://example.org/paper.pdf",
    });
    expect(results[0].accessLocations).toEqual([
      {
        url: "https://example.org/paper.pdf",
        kind: "pdf",
        source: "crossref",
        isOpenAccess: true,
        license: "https://creativecommons.org/licenses/by/4.0/",
        version: "vor",
      },
    ]);
  });

  it("merges and de-duplicates access locations from multiple indexes", () => {
    const [result] = deduplicatePapers([
      paper({
        doi: "10.5555/access",
        accessLocations: [
          {
            url: "https://repository.example/paper.pdf#page=2",
            kind: "pdf",
            source: "openalex",
            isOpenAccess: true,
            license: "cc-by",
            version: "acceptedVersion",
          },
        ],
      }),
      paper({
        id: "crossref:access",
        source: "crossref",
        doi: "10.5555/access",
        accessLocations: [
          {
            url: "https://repository.example/paper.pdf",
            kind: "landing-page",
            source: "crossref",
            isOpenAccess: false,
            license: null,
            version: null,
          },
          {
            url: "https://publisher.example/article",
            kind: "landing-page",
            source: "crossref",
            isOpenAccess: false,
            license: null,
            version: "vor",
          },
        ],
      }),
    ]);

    expect(result.accessLocations).toHaveLength(2);
    expect(result.accessLocations?.[0]).toMatchObject({
      url: "https://repository.example/paper.pdf",
      kind: "pdf",
      source: "openalex",
      isOpenAccess: true,
      license: "cc-by",
    });
  });

  it("connects a DOI record to a metadata-only record", () => {
    const results = deduplicatePapers([
      paper({ doi: "10.5555/transformer" }),
      paper({ id: "local-1", source: "local", doi: undefined }),
    ]);

    expect(results).toHaveLength(1);
  });

  it("falls back to normalized title, year, and first author", () => {
    const results = deduplicatePapers([
      paper({ title: "Café: A Study!", authors: ["María García"] }),
      paper({
        id: "S2-1",
        source: "semantic-scholar",
        title: "cafe a study",
        authors: ["Maria Garcia", "Second Author"],
      }),
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].authors).toEqual(["Maria Garcia", "Second Author"]);
  });

  it("merges exact-title versions across years and keeps the earliest canonical year", () => {
    const results = deduplicatePapers([paper(), paper({ id: "W2", year: 2024 })]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "W1", year: 2017 });
  });

  it.each([false, true])("does not let a later posted copy replace original arXiv metadata (reverse=%s)", (reverse) => {
    const original = paper({ id: "arxiv:1706.03762", doi: "10.48550/arxiv.1706.03762", source: "arxiv", venue: "arXiv", publicationType: "preprint" });
    const repost = paper({ id: "repost", doi: "10.65215/ysbyhc05", source: "crossref", year: 2025,
      venue: "Shenzhen Medical Academy of Research and Translation", publicationType: "posted-content" });
    const [result] = deduplicatePapers(reverse ? [repost, original] : [original, repost]);
    expect(result).toMatchObject({ id: original.id, year: 2017, doi: original.doi, source: "arxiv" });
  });

  it("falls back to source and id when bibliographic metadata is incomplete", () => {
    const incomplete = paper({ title: "Untitled", authors: [], year: null });
    expect(getPaperDeduplicationKeys(incomplete)).toEqual(["source:openalex:W1"]);
    expect(deduplicatePapers([incomplete, { ...incomplete }])).toHaveLength(1);
  });
});
