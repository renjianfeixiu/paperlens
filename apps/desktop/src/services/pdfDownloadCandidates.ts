import type { AccessLocation } from "../domain/access";
import { downloadRemotePdf, type RemotePdfDownload } from "./remotePdf";

export type PdfDownloadFailure = { location: AccessLocation; error: unknown };

export class PdfSourcesExhaustedError extends Error {
  constructor(readonly failures: PdfDownloadFailure[]) {
    super(`已尝试 ${failures.length} 个来源，仍未能下载。可以查看各来源的原因，或在浏览器下载后导入。`);
    this.name = "PdfSourcesExhaustedError";
  }
}

/** Try each version in order and retain every failure, rather than only the last. */
export async function downloadPdfFromLocations(
  locations: readonly AccessLocation[],
  suggestedName: string,
  options: {
    download?: typeof downloadRemotePdf;
    onAttempt?: (location: AccessLocation, attempt: number, total: number) => void;
  } = {},
): Promise<RemotePdfDownload> {
  const failures: PdfDownloadFailure[] = [];
  for (let index = 0; index < locations.length; index++) {
    const location = locations[index];
    options.onAttempt?.(location, index + 1, locations.length);
    try {
      return await (options.download ?? downloadRemotePdf)(location.url, suggestedName);
    } catch (error) {
      failures.push({ location, error });
    }
  }
  throw new PdfSourcesExhaustedError(failures);
}
