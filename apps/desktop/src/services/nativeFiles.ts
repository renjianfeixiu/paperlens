import { isTauri } from "@tauri-apps/api/core";
import { isLocalPdfPath } from "../domain/localPdfPath";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BaseDirectory,
  mkdir,
  readFile,
  writeFile,
} from "@tauri-apps/plugin-fs";

const PDF_DIRECTORY = "paperlens/pdfs";
const PDF_HEADER = "%PDF-";

export type NativePdfErrorCode =
  | "invalid-file"
  | "invalid-local-path"
  | "read-failed"
  | "write-failed";

export class NativePdfError extends Error {
  readonly code: NativePdfErrorCode;
  readonly cause?: unknown;

  constructor(message: string, code: NativePdfErrorCode, cause?: unknown) {
    super(message);
    this.name = "NativePdfError";
    this.code = code;
    this.cause = cause;
  }
}

export type NativePdfImport = {
  file: File;
  /** Relative to Tauri's AppLocalData directory. */
  localFilePath: string;
};

export type NativeFileAdapter = {
  isAvailable: () => boolean;
  pickPdf: () => Promise<string | null>;
  readExternalFile: (path: string) => Promise<Uint8Array>;
  ensurePdfDirectory: () => Promise<void>;
  writeLocalFile: (path: string, contents: Uint8Array) => Promise<void>;
  readLocalFile: (path: string) => Promise<Uint8Array>;
  now: () => number;
  uniqueId: () => string;
};

export function isTauriEnvironment() {
  return isTauri();
}

const defaultAdapter: NativeFileAdapter = {
  isAvailable: isTauriEnvironment,
  async pickPdf() {
    const selected = await open({
      multiple: false,
      directory: false,
      canCreateDirectories: false,
      title: "打开 PDF",
      filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
    });
    return typeof selected === "string" ? selected : null;
  },
  readExternalFile: (path) => readFile(path),
  ensurePdfDirectory: () =>
    mkdir(PDF_DIRECTORY, {
      baseDir: BaseDirectory.AppLocalData,
      recursive: true,
    }),
  writeLocalFile: (path, contents) =>
    writeFile(path, contents, { baseDir: BaseDirectory.AppLocalData }),
  readLocalFile: (path) =>
    readFile(path, { baseDir: BaseDirectory.AppLocalData }),
  now: () => Date.now(),
  uniqueId: () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10),
};

function originalFileName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "document.pdf";
}

function safeFileName(fileName: string) {
  const withoutExtension = fileName.replace(/\.pdf$/i, "");
  const safeStem = withoutExtension
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  // Leave room for the timestamp/ID prefix and extension on filesystems with
  // a 255-byte filename limit. Iterate code points so emoji stay intact.
  const encoder = new TextEncoder();
  let limitedStem = "";
  let byteLength = 0;
  let characterCount = 0;
  for (const character of safeStem) {
    const nextBytes = encoder.encode(character).length;
    if (characterCount >= 96 || byteLength + nextBytes > 180) break;
    limitedStem += character;
    byteLength += nextBytes;
    characterCount += 1;
  }
  return `${limitedStem || "document"}.pdf`;
}

function hasPdfHeader(contents: Uint8Array) {
  const probe = new TextDecoder("latin1").decode(contents.slice(0, 1024));
  return probe.includes(PDF_HEADER);
}

function assertPdf(fileName: string, contents: Uint8Array) {
  if (!fileName.toLowerCase().endsWith(".pdf") || !hasPdfHeader(contents)) {
    throw new NativePdfError(
      "所选文件不是有效的 PDF，请选择扩展名为 .pdf 的完整文档。",
      "invalid-file",
    );
  }
}

function assertLocalPdfPath(path: string) {
  if (
    !isLocalPdfPath(path)
  ) {
    throw new NativePdfError(
      "本地 PDF 路径无效，已阻止读取应用资料库以外的文件。",
      "invalid-local-path",
    );
  }
}

function fileFromBytes(contents: Uint8Array, name: string, lastModified: number) {
  return new File([contents.slice()], name, {
    type: "application/pdf",
    lastModified,
  });
}

async function persistPdfBytes(
  displayName: string,
  contents: Uint8Array,
  adapter: NativeFileAdapter,
): Promise<NativePdfImport> {
  assertPdf(displayName, contents);
  const importedAt = adapter.now();
  const localFilePath = `${PDF_DIRECTORY}/${importedAt}-${adapter.uniqueId()}-${safeFileName(displayName)}`;

  try {
    await adapter.ensurePdfDirectory();
    await adapter.writeLocalFile(localFilePath, contents);
  } catch (error) {
    throw new NativePdfError(
      "PDF 已读取，但无法保存到 PaperLens 本地资料库。",
      "write-failed",
      error,
    );
  }

  return {
    file: fileFromBytes(contents, displayName, importedAt),
    localFilePath,
  };
}

/**
 * Copy a PDF supplied by an HTML file input or drag-and-drop into PaperLens'
 * private AppLocalData directory so it remains readable after an app restart.
 */
export async function persistNativePdf(
  file: File,
  adapter: NativeFileAdapter = defaultAdapter,
): Promise<NativePdfImport> {
  if (!adapter.isAvailable()) {
    throw new NativePdfError("当前环境无法访问本地资料库。", "write-failed");
  }

  let contents: Uint8Array;
  try {
    contents = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    throw new NativePdfError("无法读取所选 PDF，请重新选择后重试。", "read-failed", error);
  }

  return persistPdfBytes(file.name, contents, adapter);
}

/**
 * Show the native desktop picker, copy the selected PDF into PaperLens' private
 * AppLocalData directory, and return a File that PDF.js can render immediately.
 */
export async function selectNativePdf(
  adapter: NativeFileAdapter = defaultAdapter,
): Promise<NativePdfImport | null> {
  if (!adapter.isAvailable()) return null;

  const sourcePath = await adapter.pickPdf();
  if (!sourcePath) return null;

  const displayName = originalFileName(sourcePath);
  let contents: Uint8Array;
  try {
    contents = await adapter.readExternalFile(sourcePath);
  } catch (error) {
    throw new NativePdfError("无法读取所选 PDF，请检查文件权限后重试。", "read-failed", error);
  }

  return persistPdfBytes(displayName, contents, adapter);
}

/** Restore a PDF that was previously copied into PaperLens AppLocalData. */
export async function loadLocalPdf(
  localFilePath: string,
  adapter: NativeFileAdapter = defaultAdapter,
): Promise<File> {
  if (!adapter.isAvailable()) {
    throw new NativePdfError("当前环境无法访问本地资料库。", "read-failed");
  }

  assertLocalPdfPath(localFilePath);
  let contents: Uint8Array;
  try {
    contents = await adapter.readLocalFile(localFilePath);
  } catch (error) {
    throw new NativePdfError(
      "无法恢复这份 PDF；文件可能已被移除，请重新导入。",
      "read-failed",
      error,
    );
  }

  const storedName = originalFileName(localFilePath);
  const displayName = storedName.replace(/^\d+-[a-zA-Z0-9]+-/, "");
  assertPdf(displayName, contents);
  return fileFromBytes(contents, displayName, adapter.now());
}
