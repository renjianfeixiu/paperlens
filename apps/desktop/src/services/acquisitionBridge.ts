import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  deduplicateAccessLocations,
  type AccessLocation,
} from "../domain/access";
import type { Paper } from "../domain/paper";
import {
  normalizeInvokeError,
  parseDownloadResult,
  type RemotePdfAdapter,
  type RemotePdfDownload,
} from "./remotePdf";

const defaultAdapter: RemotePdfAdapter = {
  isAvailable: isTauri,
  invoke: (command, args) => invoke(command, args),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function resolveTrustedLandingPage(
  location: AccessLocation,
  adapter: RemotePdfAdapter = defaultAdapter,
): Promise<AccessLocation[]> {
  if (!adapter.isAvailable() || location.kind !== "landing-page" || !location.isOpenAccess) return [];
  let result: unknown;
  try {
    result = await adapter.invoke("resolve_landing_page", { url: location.url });
  } catch (error) {
    throw normalizeInvokeError(error);
  }
  if (!isRecord(result) || !Array.isArray(result.pdfUrls)) return [];
  return deduplicateAccessLocations(result.pdfUrls.map((url) => ({
    url,
    kind: "pdf",
    source: "publisher-metadata",
    isOpenAccess: true,
    license: location.license,
    version: location.version,
    hostType: location.hostType,
    hostName: location.hostName,
  })));
}

export type BrowserPdfCandidate = {
  fileName: string;
  byteSize: number;
  modifiedAtMs: number;
};

function parseBrowserPdfCandidate(result: unknown): BrowserPdfCandidate {
  if (!isRecord(result)) throw normalizeInvokeError({ code: "invalid-response" });
  const { fileName, byteSize, modifiedAtMs } = result;
  if (typeof fileName !== "string" || !fileName.toLowerCase().endsWith(".pdf") ||
    /[\\/\u0000-\u001f]/.test(fileName) || fileName === "." || fileName === ".." ||
    typeof byteSize !== "number" || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 100 * 1024 * 1024 ||
    typeof modifiedAtMs !== "number" || !Number.isSafeInteger(modifiedAtMs) || modifiedAtMs < 0) {
    throw normalizeInvokeError({ code: "invalid-response" });
  }
  return { fileName, byteSize, modifiedAtMs };
}

export async function findRecentBrowserPdf(
  startedAtMs: number,
  ignoredNames: string[] = [],
  adapter: RemotePdfAdapter = defaultAdapter,
): Promise<BrowserPdfCandidate | null> {
  if (!adapter.isAvailable()) return null;
  let result: unknown;
  try {
    result = await adapter.invoke("find_recent_browser_pdf", {
      startedAtMs,
      ignoredNames,
    });
  } catch (error) {
    throw normalizeInvokeError(error);
  }
  return result === null ? null : parseBrowserPdfCandidate(result);
}

export async function importBrowserPdfCandidate(
  candidate: BrowserPdfCandidate,
  suggestedName: string,
  adapter: RemotePdfAdapter = defaultAdapter,
): Promise<RemotePdfDownload> {
  if (!adapter.isAvailable()) throw normalizeInvokeError({ code: "unavailable" });
  let result: unknown;
  try {
    result = await adapter.invoke("import_browser_pdf_candidate", {
      fileName: candidate.fileName,
      byteSize: candidate.byteSize,
      modifiedAtMs: candidate.modifiedAtMs,
      suggestedName,
    });
  } catch (error) {
    throw normalizeInvokeError(error);
  }
  return parseDownloadResult(result);
}

export function institutionAccessUrl(template: string, paper: Pick<Paper, "doi" | "title">): string | undefined {
  const value = template.trim();
  if (!value) return undefined;
  const target = paper.doi ? `https://doi.org/${paper.doi}` : `https://scholar.google.com/scholar?q=${encodeURIComponent(paper.title)}`;
  try {
    const expanded = value
      .split("{url}").join(encodeURIComponent(target))
      .split("{doi}").join(encodeURIComponent(paper.doi ?? ""));
    const url = new URL(expanded);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    if (!value.includes("{url}") && !value.includes("{doi}")) url.searchParams.set("url", target);
    return url.toString();
  } catch {
    return undefined;
  }
}
