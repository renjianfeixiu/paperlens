import { describe, expect, it, vi } from "vitest";
import type { AccessLocation } from "../domain/access";
import { downloadPdfFromLocations, PdfSourcesExhaustedError } from "./pdfDownloadCandidates";
import { RemotePdfError } from "./remotePdf";

const location = (host: string): AccessLocation => ({
  url: `https://${host}/paper.pdf`, kind: "pdf", source: "openalex",
  isOpenAccess: true, license: null, version: null,
});
const downloaded = { localFilePath: "paperlens/pdfs/123-paper.pdf", displayName: "paper.pdf", byteSize: 10 };

describe("PDF version fallback", () => {
  it("opens a working second version after a timeout and stops before later sources", async () => {
    const download = vi.fn().mockRejectedValueOnce(new RemotePdfError("network-timeout"))
      .mockResolvedValueOnce(downloaded);
    const onAttempt = vi.fn();
    await expect(downloadPdfFromLocations([
      location("arxiv.org"), location("papers.nips.cc"), location("unused.example"),
    ], "paper.pdf", { download, onAttempt })).resolves.toEqual(downloaded);
    expect(download.mock.calls.map(([url]) => url)).toEqual([
      "https://arxiv.org/paper.pdf", "https://papers.nips.cc/paper.pdf",
    ]);
    expect(onAttempt.mock.calls.map(([, attempt, total]) => [attempt, total])).toEqual([[1, 3], [2, 3]]);
  });

  it("retains the first timeout when the final source returns 404", async () => {
    const timeout = new RemotePdfError("network-timeout");
    const missing = new RemotePdfError("http-status", { httpStatus: 404 });
    const download = vi.fn().mockRejectedValueOnce(timeout).mockRejectedValueOnce(missing);
    let failure: unknown;
    try {
      await downloadPdfFromLocations([location("arxiv.org"), location("missing.example")], "paper.pdf", { download });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PdfSourcesExhaustedError);
    expect(failure).toMatchObject({ failures: [
      { location: location("arxiv.org"), error: timeout },
      { location: location("missing.example"), error: missing },
    ] });
  });
});
