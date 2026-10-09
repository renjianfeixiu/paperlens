import React from "react";
import { createRoot } from "react-dom/client";
import PdfReader from "../src/components/PdfReader";
import type { PdfTextSelection } from "../src/domain/readerSelection";

declare global {
  interface Window {
    pdfBase64: string;
    webkit: { messageHandlers: { result: { postMessage(value: string): void } } };
  }
}
const report = (value: unknown) => window.webkit.messageHandlers.result.postMessage(JSON.stringify(value));
report({ streamIterator: typeof ReadableStream.prototype[Symbol.asyncIterator], userAgent: navigator.userAgent });
window.addEventListener("error", (event) => report({ error: event.message, stack: event.error?.stack }));
window.addEventListener("unhandledrejection", (event) => report({ error: String(event.reason), stack: event.reason?.stack }));
const data = Uint8Array.from(atob(window.pdfBase64), (char) => char.charCodeAt(0));
let selected: PdfTextSelection | null = null;
const file = new File([data], "smoke.pdf", { type: "application/pdf" });
const root = createRoot(document.getElementById("root")!);
const renderReader = (initialPage = 1, key = 0) => root.render(<PdfReader
  key={key}
  file={file}
  initialPage={initialPage}
  onTextSelection={(value) => { selected = value; }}
/>);
renderReader();

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    const error = document.querySelector(".pdf-reader__render-error, .pdf-reader__error");
    if (error) throw new Error(error.textContent ?? "Reader error");
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const ready = (page: number) => !!document.querySelector(`canvas[aria-label="PDF 第 ${page} 页"]`)
  && !document.querySelector(".pdf-reader__rendering, .pdf-reader__render-error, .pdf-reader__text-warning")
  && document.querySelectorAll(".textLayer span").length > 0;

async function checkReader() {
  await waitFor(() => ready(1), "first page and selectable text");
  const pageInput = document.querySelector<HTMLInputElement>('input[type="number"]')!;
  const changeDraft = async (value: string) => {
    pageInput.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(pageInput, value);
    pageInput.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(requestAnimationFrame);
  };
  await changeDraft("0");
  pageInput.blur();
  await waitFor(() => pageInput.value === "1", "clamp invalid page draft");
  await changeDraft("2");
  pageInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => pageInput.value === "1" && ready(1), "Escape cancels navigation");
  const canvas = document.querySelector("canvas")!;
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
  let darkPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] > 0 && pixels[index] < 200) darkPixels++;
  }
  if (darkPixels < 100) throw new Error("Canvas is blank");
  const span = [...document.querySelectorAll(".textLayer span")].find((item) => (item.textContent?.length ?? 0) > 10)!;
  const range = document.createRange();
  range.selectNodeContents(span);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  span.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await waitFor(() => !!selected?.text, "selection callback");
  const selectedCharacters = selected!.text.length;
  button("下一页").click();
  await waitFor(() => ready(2), "second page");
  const previousWidth = canvas.width;
  button("放大").click();
  await waitFor(() => ready(2) && canvas.width > previousWidth, "zoom rendering");
  const scrollArea = document.querySelector<HTMLElement>(".pdf-reader__scroll-area")!;
  scrollArea.scrollTop = 200;
  if (scrollArea.scrollTop <= 0) throw new Error("Scroll fixture does not overflow");
  button("上一页").click();
  await waitFor(() => ready(1) && scrollArea.scrollTop === 0, "return to first page at top");
  renderReader(2, 1);
  await waitFor(() => ready(2) && document.querySelector<HTMLInputElement>('input[type="number"]')?.value === "2", "restore page on reader remount");
  report({ done: true, ok: true, darkPixels, selectedCharacters, textSpans: document.querySelectorAll(".textLayer span").length, checks: ["first page", "text selection", "next page", "zoom", "previous page", "invalid page draft", "Escape cancels navigation", "scroll reset", "restore page on remount"] });
}
void checkReader().catch((error) => report({ done: true, ok: false, error: String(error), stack: error.stack }));
