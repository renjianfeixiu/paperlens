import { describe, expect, it } from "vitest";

import {
  augmentTrustedOpenAccessLocations,
  deduplicateAccessLocations,
  inferAccessKind,
  normalizeAccessLocation,
  normalizeAccessUrl,
  openAccessPdfLocations,
  preferredOpenAccessUrl,
} from "./access";

describe("access locations", () => {
  it("accepts canonical HTTP URLs and rejects unsafe or dirty values", () => {
    expect(normalizeAccessUrl("  HTTPS://Example.org:443/paper.pdf#page=2  ")).toBe(
      "https://example.org/paper.pdf",
    );
    expect(normalizeAccessUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeAccessUrl("https://user:secret@example.org/paper.pdf")).toBeUndefined();
    expect(normalizeAccessUrl("https://example.org/bad\npath")).toBeUndefined();
    expect(normalizeAccessUrl("not a URL")).toBeUndefined();
  });

  it("normalizes untrusted metadata and infers PDF paths", () => {
    expect(
      normalizeAccessLocation({
        url: "https://archive.example/paper.PDF?download=1",
        source: "openalex",
        isOpenAccess: true,
        license: " cc-by ",
        hostName: " Repository ",
      }),
    ).toEqual({
      url: "https://archive.example/paper.PDF?download=1",
      kind: "pdf",
      source: "openalex",
      isOpenAccess: true,
      license: "cc-by",
      version: null,
      hostName: "Repository",
    });
    expect(inferAccessKind("https://example.org/article")).toBe("landing-page");
    expect(
      normalizeAccessLocation({ url: "file:///tmp/a.pdf", source: "local" }),
    ).toBeUndefined();
  });

  it("de-duplicates URLs and prefers an open PDF", () => {
    const locations = deduplicateAccessLocations([
      {
        url: "https://example.org/article#abstract",
        kind: "landing-page",
        source: "openalex",
        isOpenAccess: false,
        license: null,
        version: null,
      },
      {
        url: "https://example.org/article",
        kind: "landing-page",
        source: "crossref",
        isOpenAccess: true,
        license: "https://creativecommons.org/licenses/by/4.0/",
        version: "vor",
      },
      {
        url: "https://example.org/paper.pdf",
        kind: "pdf",
        source: "openalex",
        isOpenAccess: true,
        license: "cc-by",
        version: "publishedVersion",
      },
    ]);

    expect(locations).toHaveLength(2);
    expect(locations[0]).toMatchObject({
      isOpenAccess: true,
      license: "https://creativecommons.org/licenses/by/4.0/",
      version: "vor",
    });
    expect(preferredOpenAccessUrl(locations)).toBe("https://example.org/paper.pdf");
  });

  it.each([
    [
      "https://arxiv.org/abs/1706.03762v7",
      "https://arxiv.org/pdf/1706.03762",
    ],
    [
      "https://aclanthology.org/D15-1166/",
      "https://aclanthology.org/D15-1166.pdf",
    ],
    [
      "https://papers.nips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html",
      "https://papers.nips.cc/paper_files/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf",
    ],
    [
      "https://proceedings.neurips.cc/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html",
      "https://proceedings.neurips.cc/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf",
    ],
    [
      "https://papers.neurips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html",
      "https://papers.neurips.cc/paper_files/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf",
    ],
    [
      "https://proceedings.mlr.press/v80/example18a.html",
      "https://proceedings.mlr.press/v80/example18a.pdf",
    ],
    [
      "https://openaccess.thecvf.com/content_CVPR_2020/html/Wang_ECA-Net_Efficient_Channel_Attention_for_Deep_Convolutional_Neural_Networks_CVPR_2020_paper.html",
      "https://openaccess.thecvf.com/content_CVPR_2020/papers/Wang_ECA-Net_Efficient_Channel_Attention_for_Deep_Convolutional_Neural_Networks_CVPR_2020_paper.pdf",
    ],
  ])("derives a PDF only for a trusted open repository: %s", (landing, pdf) => {
    const locations = augmentTrustedOpenAccessLocations([
      {
        url: landing,
        kind: "landing-page",
        source: "openalex",
        isOpenAccess: false,
        license: null,
        version: "publishedVersion",
      },
    ]);

    expect(locations).toContainEqual(expect.objectContaining({
      url: pdf,
      kind: "pdf",
      isOpenAccess: true,
    }));
  });

  it("never promotes an arbitrary publisher landing page", () => {
    const locations = augmentTrustedOpenAccessLocations([
      {
        url: "https://publisher.example/article/123",
        kind: "landing-page",
        source: "crossref",
        isOpenAccess: false,
        license: null,
        version: null,
      },
    ]);
    expect(locations).toEqual([
      expect.objectContaining({ isOpenAccess: false, kind: "landing-page" }),
    ]);
  });

  it("does not trust a NeurIPS lookalike domain", () => {
    const locations = augmentTrustedOpenAccessLocations([{
      url: "https://papers.nips.cc.attacker.example/paper_files/paper/2017/hash/abcdef-Abstract.html",
      kind: "landing-page", source: "openalex", isOpenAccess: false, license: null, version: null,
    }]);
    expect(openAccessPdfLocations(locations)).toEqual([]);
  });

  it("orders reliable repository PDFs before a fragile publisher link", () => {
    const locations = openAccessPdfLocations([
      {
        url: "https://publisher.example/paper.pdf",
        kind: "pdf",
        source: "crossref",
        isOpenAccess: true,
        license: "cc-by",
        version: "publishedVersion",
      },
      {
        url: "https://arxiv.org/pdf/1706.03762",
        kind: "pdf",
        source: "openalex",
        isOpenAccess: true,
        license: null,
        version: "submittedVersion",
        hostType: "repository",
      },
    ]);

    expect(locations.map((location) => location.url)).toEqual([
      "https://arxiv.org/pdf/1706.03762",
      "https://publisher.example/paper.pdf",
    ]);
  });
});
