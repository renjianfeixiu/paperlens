import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextContent, getTextContentParameters } from "pdfjs-dist/types/src/display/api";

// PDF.js 6 getTextContent uses ReadableStream async iteration, which is absent
// in some system WKWebViews even when the legacy PDF.js build is used.
// Use the supported reader API without modifying browser globals.
export async function readPdfTextContent(
  page: Pick<PDFPageProxy, "streamTextContent" | "getTextContent" | "isPureXfa">,
  options: getTextContentParameters = {},
): Promise<TextContent> {
  if (page.isPureXfa) return page.getTextContent(options);
  const reader = page.streamTextContent(options).getReader();
  const content: TextContent = { items: [], styles: Object.create(null), lang: null };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      content.lang ??= value.lang;
      Object.assign(content.styles, value.styles);
      content.items.push(...value.items);
    }
    return content;
  } finally {
    reader.releaseLock();
  }
}
