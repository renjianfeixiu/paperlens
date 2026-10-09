import { invoke, isTauri } from "@tauri-apps/api/core";
import { isLocalPdfPath } from "../domain/localPdfPath";

const MAX_PDF_BYTES = 100 * 1024 * 1024;

export type RemotePdfDownload = {
  /** Relative to Tauri's AppLocalData directory. */
  localFilePath: string;
  displayName: string;
  byteSize: number;
};

export type RemotePdfErrorCode =
  | "unavailable"
  | "invalid-url"
  | "unsafe-url"
  | "redirect-limit"
  | "network-timeout"
  | "network-failed"
  | "http-status"
  | "too-large"
  | "invalid-pdf"
  | "write-failed"
  | "untrusted-landing-page"
  | "html-too-large"
  | "downloads-unavailable"
  | "invalid-response"
  | "unknown";

const ERROR_MESSAGES: Record<RemotePdfErrorCode, string> = {
  unavailable: "当前环境无法把网络 PDF 保存到本地资料库。",
  "invalid-url": "下载链接无效，请检查后重试。",
  "unsafe-url": "为保护本机安全，仅支持公开网站的 HTTPS 下载链接。",
  "redirect-limit": "下载链接重定向次数过多，已停止下载。",
  "network-timeout": "下载超时，请检查网络后重试。",
  "network-failed": "无法从论文网站获取 PDF，请稍后重试。",
  "http-status": "论文网站暂时不允许下载这份 PDF。",
  "too-large": "PDF 超过 100 MiB 下载上限。",
  "invalid-pdf": "下载内容不是有效的 PDF，可能是登录页或网站错误页。",
  "write-failed": "PDF 已下载，但无法保存到 PaperLens 本地资料库。",
  "untrusted-landing-page": "该页面不在可信学术来源列表中。",
  "html-too-large": "论文页面过大，已停止元数据解析。",
  "downloads-unavailable": "无法读取浏览器下载文件夹。",
  "invalid-response": "PaperLens 收到了无效的下载结果，已阻止打开文件。",
  unknown: "下载 PDF 时发生未知错误，请稍后重试。",
};

const KNOWN_ERROR_CODES = new Set<RemotePdfErrorCode>(
  Object.keys(ERROR_MESSAGES) as RemotePdfErrorCode[],
);

export class RemotePdfError extends Error {
  readonly code: RemotePdfErrorCode;
  readonly httpStatus?: number;
  readonly cause?: unknown;

  constructor(
    code: RemotePdfErrorCode,
    options: { httpStatus?: number; cause?: unknown } = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "RemotePdfError";
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.cause = options.cause;
  }
}

export type RemotePdfAdapter = {
  isAvailable: () => boolean;
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
};

const defaultAdapter: RemotePdfAdapter = {
  isAvailable: isTauri,
  invoke: (command, args) => invoke(command, args),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSerializedError(error: unknown): unknown {
  if (typeof error !== "string") return error;

  try {
    return JSON.parse(error) as unknown;
  } catch {
    return error;
  }
}

export function normalizeInvokeError(error: unknown): RemotePdfError {
  const parsed = parseSerializedError(error);
  if (isRecord(parsed) && typeof parsed.code === "string") {
    const code = KNOWN_ERROR_CODES.has(parsed.code as RemotePdfErrorCode)
      ? (parsed.code as RemotePdfErrorCode)
      : "unknown";
    const httpStatus =
      typeof parsed.httpStatus === "number" ? parsed.httpStatus : undefined;
    return new RemotePdfError(code, { httpStatus, cause: error });
  }

  return new RemotePdfError("unknown", { cause: error });
}

export function parseDownloadResult(result: unknown): RemotePdfDownload {
  if (!isRecord(result)) {
    throw new RemotePdfError("invalid-response", { cause: result });
  }

  const { localFilePath, displayName, byteSize } = result;
  const hasSafePath = isLocalPdfPath(localFilePath);
  const hasSafeDisplayName =
    typeof displayName === "string" &&
    displayName.toLowerCase().endsWith(".pdf") &&
    !/[\/\\\u0000-\u001f\u007f]/.test(displayName);
  const hasValidSize =
    typeof byteSize === "number" &&
    Number.isSafeInteger(byteSize) &&
    byteSize > 0 &&
    byteSize <= MAX_PDF_BYTES;

  if (!hasSafePath || !hasSafeDisplayName || !hasValidSize) {
    throw new RemotePdfError("invalid-response", { cause: result });
  }

  return { localFilePath, displayName, byteSize };
}

/**
 * Ask the Rust backend to download a public HTTPS PDF into PaperLens'
 * AppLocalData directory. The backend is the security boundary; this wrapper
 * validates its result and turns every failure into a stable Chinese message.
 */
export async function downloadRemotePdf(
  url: string,
  suggestedName?: string,
  adapter: RemotePdfAdapter = defaultAdapter,
): Promise<RemotePdfDownload> {
  if (!adapter.isAvailable()) {
    throw new RemotePdfError("unavailable");
  }

  let result: unknown;
  try {
    result = await adapter.invoke("download_pdf", {
      url,
      suggestedName: suggestedName ?? null,
    });
  } catch (error) {
    throw normalizeInvokeError(error);
  }

  return parseDownloadResult(result);
}
