import { describe, expect, it, vi } from "vitest";
import { readPdfTextContent } from "./pdfTextContent";

describe("WebKit PDF text extraction", () => {
  it("reads every chunk without requiring stream async iteration", async () => {
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue({ items: [{ str: "first" }], styles: { f1: { fontFamily: "serif" } }, lang: null });
      controller.enqueue({ items: [{ str: "second" }], styles: { f2: { fontFamily: "sans-serif" } }, lang: "en" });
      controller.close();
    } });
    Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });
    const getTextContent = vi.fn(async () => { throw new Error("Unsupported async iterator"); });
    const streamTextContent = vi.fn(() => stream);
    const options = { includeMarkedContent: true, disableNormalization: true };
    const result = await readPdfTextContent({ isPureXfa: false, streamTextContent, getTextContent }, options);
    expect(result.items).toEqual([{ str: "first" }, { str: "second" }]);
    expect(Object.keys(result.styles)).toEqual(["f1", "f2"]);
    expect(result.lang).toBe("en");
    expect(stream.locked).toBe(false);
    expect(streamTextContent).toHaveBeenCalledWith(options);
    expect(getTextContent).not.toHaveBeenCalled();
  });

  it("releases the reader lock if the stream fails", async () => {
    const stream = new ReadableStream({ start(controller) { controller.error(new Error("bad text")); } });
    await expect(readPdfTextContent({
      isPureXfa: false, streamTextContent: () => stream, getTextContent: vi.fn(),
    })).rejects.toThrow("bad text");
    expect(stream.locked).toBe(false);
  });
});
