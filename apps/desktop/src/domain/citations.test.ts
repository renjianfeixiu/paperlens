import { describe, expect, it } from "vitest";
import {
  attachBibliography,
  extractNumberedBibliography,
  extractPageCitations,
  pdfItemsToText,
} from "./citations";

describe("citation evidence extraction", () => {
  it("preserves PDF line endings for bibliography detection", () => {
    expect(pdfItemsToText([
      { str: "References", hasEOL: true },
      { str: "[1] Example", hasEOL: true },
    ])).toBe("References\n[1] Example\n");
  });

  it("finds numbered and author-year markers with real surrounding text", () => {
    const text = "Attention layers improve retrieval [2, 4–5]. Smith et al. (2020) also studied them.\nReferences\n[1] Not a body citation";
    const result = extractPageCitations(text, 3);
    expect(result.map((item) => item.label)).toEqual(["[2, 4–5]", "Smith et al. (2020)"]);
    expect(result[0].referenceNumbers).toEqual([2, 4, 5]);
    expect(result[0].context).toContain("Attention layers improve retrieval");
  });

  it("finds parenthetical author-year markers", () => {
    const result = extractPageCitations("Prior work (Smith et al., 2020) offers a baseline.", 1);
    expect(result[0]).toMatchObject({ label: "(Smith et al., 2020)", style: "author-year" });
  });

  it("refuses very long or reversed numeric ranges", () => {
    expect(extractPageCitations("A [2–50] and B [5–2].", 1)).toEqual([]);
  });

  it("links only explicit numbered bibliography entries", () => {
    const bibliography = extractNumberedBibliography([
      "Some appendix.\nReferences\n[1] Smith. A useful paper. Journal, 2020.\n[2] Lee. Another paper. Journal, 2021.",
    ]);
    expect(bibliography[2]).toContain("Another paper");
    const mentions = extractPageCitations("This approach follows [2].", 1);
    expect(attachBibliography(mentions, bibliography)[0].references).toEqual([
      "[2] Lee. Another paper. Journal, 2021.",
    ]);
    expect(extractNumberedBibliography(["[1] Fake. No heading."])).toEqual({});
  });
});
