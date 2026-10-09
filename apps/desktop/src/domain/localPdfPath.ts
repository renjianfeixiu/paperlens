/** One filename inside the library; dots inside the filename are legitimate. */
export function isLocalPdfPath(value: unknown): value is string {
  return typeof value === "string"
    && /^paperlens\/pdfs\/[a-zA-Z0-9][^/\\\u0000-\u001f\u007f]*\.pdf$/i.test(value);
}
