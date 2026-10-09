import { describe, expect, it, vi } from "vitest";
import {
  findRecentBrowserPdf,
  importBrowserPdfCandidate,
  institutionAccessUrl,
  resolveTrustedLandingPage,
} from "./acquisitionBridge";

describe("native acquisition bridge", () => {
  it("parses explicit PDF metadata only for an OA landing page", async () => {
    const invoke = vi.fn(async () => ({ pdfUrls: ["https://publisher.example/article.pdf"] }));
    const result = await resolveTrustedLandingPage({
      url: "https://publisher.example/article",
      kind: "landing-page",
      source: "openalex",
      isOpenAccess: true,
      license: "cc-by",
      version: "publishedVersion",
    }, { isAvailable: () => true, invoke });
    expect(result[0]).toMatchObject({ source: "publisher-metadata", kind: "pdf", isOpenAccess: true });
  });

  it("validates a browser-downloaded candidate before importing it", async () => {
    const candidate = await findRecentBrowserPdf(100, [], {
      isAvailable: () => true,
      invoke: async () => ({
        fileName: "browser-paper.pdf",
        byteSize: 1024,
        modifiedAtMs: 101,
      }),
    });
    expect(candidate?.fileName).toBe("browser-paper.pdf");
    const result = await importBrowserPdfCandidate(candidate!, "Paper.pdf", {
      isAvailable: () => true,
      invoke: async () => ({
        localFilePath: "paperlens/pdfs/100-Paper.pdf",
        displayName: "Paper.pdf",
        byteSize: 1024,
      }),
    });
    expect(result.localFilePath).toContain("paperlens/pdfs/");
  });

  it("builds a school proxy URL without accepting unsafe schemes", () => {
    expect(institutionAccessUrl("https://proxy.example/login?url={url}", {
      doi: "10.1/test", title: "Paper",
    })).toContain(encodeURIComponent("https://doi.org/10.1/test"));
    expect(institutionAccessUrl("javascript:alert(1)", { title: "Paper" })).toBeUndefined();
  });
});
