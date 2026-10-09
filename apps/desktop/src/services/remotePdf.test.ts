import { describe, expect, it, vi } from "vitest";

import {
  downloadRemotePdf,
  RemotePdfError,
  type RemotePdfAdapter,
} from "./remotePdf";

const successfulResult = {
  localFilePath:
    "paperlens/pdfs/1700000000000-00000000-Attention Is All You Need.pdf",
  displayName: "Attention Is All You Need.pdf",
  byteSize: 42_000,
};

function adapter(
  overrides: Partial<RemotePdfAdapter> = {},
): RemotePdfAdapter {
  return {
    isAvailable: () => true,
    invoke: async () => successfulResult,
    ...overrides,
  };
}

describe("downloadRemotePdf", () => {
  it("calls the native downloader and returns its durable local path", async () => {
    const invoke = vi.fn(async () => successfulResult);

    await expect(
      downloadRemotePdf(
        "https://arxiv.org/pdf/1706.03762",
        "Attention Is All You Need.pdf",
        adapter({ invoke }),
      ),
    ).resolves.toEqual(successfulResult);

    expect(invoke).toHaveBeenCalledWith("download_pdf", {
      url: "https://arxiv.org/pdf/1706.03762",
      suggestedName: "Attention Is All You Need.pdf",
    });
  });

  it("does not invoke native code outside Tauri", async () => {
    const invoke = vi.fn(async () => successfulResult);

    await expect(
      downloadRemotePdf(
        "https://example.org/paper.pdf",
        undefined,
        adapter({ isAvailable: () => false, invoke }),
      ),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("本地资料库"),
    } satisfies Partial<RemotePdfError>);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts a legitimate downloaded filename containing consecutive dots", async () => {
    const result = { ...successfulResult, localFilePath: "paperlens/pdfs/123-论文 draft..v2.pdf" };
    await expect(downloadRemotePdf("https://example.org/paper.pdf", undefined,
      adapter({ invoke: async () => result }))).resolves.toEqual(result);
  });

  it.each([
    ["unsafe-url", "HTTPS"],
    ["redirect-limit", "重定向"],
    ["network-timeout", "超时"],
    ["too-large", "100 MiB"],
    ["invalid-pdf", "不是有效的 PDF"],
    ["write-failed", "本地资料库"],
  ])("maps native %s errors to a stable Chinese message", async (code, text) => {
    await expect(
      downloadRemotePdf(
        "https://example.org/paper.pdf",
        undefined,
        adapter({
          invoke: async () => {
            throw { code, message: "backend detail" };
          },
        }),
      ),
    ).rejects.toMatchObject({ code, message: expect.stringContaining(text) });
  });

  it("preserves a structured HTTP status from a serialized Tauri error", async () => {
    await expect(
      downloadRemotePdf(
        "https://example.org/paper.pdf",
        undefined,
        adapter({
          invoke: async () => {
            throw JSON.stringify({
              code: "http-status",
              message: "forbidden",
              httpStatus: 403,
            });
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "http-status", httpStatus: 403 });
  });

  it.each([
    { ...successfulResult, localFilePath: "../outside.pdf" },
    { ...successfulResult, localFilePath: "paperlens/pdfs/folder/paper.pdf" },
    { ...successfulResult, localFilePath: "paperlens/pdfs/123\u0000.pdf" },
    { ...successfulResult, localFilePath: "paperlens/pdfs/123\\outside.pdf" },
    { ...successfulResult, displayName: "paper\u0000.pdf" },
    { ...successfulResult, displayName: "not-a-pdf.txt" },
    { ...successfulResult, byteSize: 100 * 1024 * 1024 + 1 },
    { ...successfulResult, byteSize: 0 },
  ])("rejects an unsafe or malformed native result", async (result) => {
    await expect(
      downloadRemotePdf(
        "https://example.org/paper.pdf",
        undefined,
        adapter({ invoke: async () => result }),
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});
