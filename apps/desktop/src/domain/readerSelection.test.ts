import { describe, expect, it } from "vitest";
import { normalizeSelectedText, selectionEvidenceLabel } from "./readerSelection";

describe("reader selection", () => {
  it("joins PDF line wraps while preserving ordinary word boundaries", () => {
    expect(normalizeSelectedText("transfor-\nmer  keeps\nformulae")).toBe(
      "transformer keeps formulae",
    );
  });

  it("formats a stable page and character anchor", () => {
    expect(selectionEvidenceLabel({
      text: "attention",
      anchor: { pageNumber: 3, startOffset: 20, endOffset: 29 },
    })).toBe("第 3 页 · 字符 21–29");
  });
});
