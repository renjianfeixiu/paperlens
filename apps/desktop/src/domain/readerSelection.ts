export type ReaderToolId = "translation" | "formula" | "concept";

export type PdfTextAnchor = {
  pageNumber: number;
  startOffset: number;
  endOffset: number;
};

export type PdfTextSelection = {
  text: string;
  anchor: PdfTextAnchor;
};

export function normalizeSelectedText(value: string): string {
  return value
    .replace(/\u00ad/g, "")
    .replace(/-\s*\n\s*(?=[a-z])/g, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function selectionEvidenceLabel(selection: PdfTextSelection): string {
  const { pageNumber, startOffset, endOffset } = selection.anchor;
  return `第 ${pageNumber} 页 · 字符 ${startOffset + 1}–${endOffset}`;
}
