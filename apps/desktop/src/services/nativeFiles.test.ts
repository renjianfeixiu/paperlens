import { describe, expect, it, vi } from "vitest";

import {
  loadLocalPdf,
  NativePdfError,
  persistNativePdf,
  selectNativePdf,
  type NativeFileAdapter,
} from "./nativeFiles";

const validPdf = new TextEncoder().encode("%PDF-1.7\n%%EOF");

function adapter(overrides: Partial<NativeFileAdapter> = {}): NativeFileAdapter {
  return {
    isAvailable: () => true,
    pickPdf: async () => "/Users/researcher/论文 Draft.pdf",
    readExternalFile: async () => validPdf,
    ensurePdfDirectory: async () => undefined,
    writeLocalFile: async () => undefined,
    readLocalFile: async () => validPdf,
    now: () => 1_700_000_000_000,
    uniqueId: () => "abc12345",
    ...overrides,
  };
}

describe("selectNativePdf", () => {
  it("imports a Windows path with spaces and Chinese characters", async () => {
    const readExternalFile = vi.fn(async () => validPdf);
    const sourcePath = "C:\\Users\\Researcher\\Downloads\\论文 Draft.pdf";
    const result = await selectNativePdf(adapter({ pickPdf: async () => sourcePath, readExternalFile }));
    expect(readExternalFile).toHaveBeenCalledWith(sourcePath);
    expect(result?.file.name).toBe("论文 Draft.pdf");
    expect(result?.localFilePath).toBe("paperlens/pdfs/1700000000000-abc12345-论文 Draft.pdf");
  });
  it("returns null without invoking a picker outside Tauri", async () => {
    const pickPdf = vi.fn(async () => "/tmp/paper.pdf");
    const result = await selectNativePdf(adapter({ isAvailable: () => false, pickPdf }));

    expect(result).toBeNull();
    expect(pickPdf).not.toHaveBeenCalled();
  });

  it("returns null when the user cancels", async () => {
    await expect(selectNativePdf(adapter({ pickPdf: async () => null }))).resolves.toBeNull();
  });

  it("copies a selected PDF to an app-local safe path", async () => {
    const ensurePdfDirectory = vi.fn(async () => undefined);
    const writeLocalFile = vi.fn(async () => undefined);
    const result = await selectNativePdf(adapter({ ensurePdfDirectory, writeLocalFile }));

    expect(result?.file.name).toBe("论文 Draft.pdf");
    expect(result?.file.type).toBe("application/pdf");
    expect(result?.localFilePath).toBe(
      "paperlens/pdfs/1700000000000-abc12345-论文 Draft.pdf",
    );
    expect(ensurePdfDirectory).toHaveBeenCalledOnce();
    expect(writeLocalFile).toHaveBeenCalledWith(result?.localFilePath, validPdf);
  });

  it("rejects a renamed non-PDF before writing", async () => {
    const writeLocalFile = vi.fn(async () => undefined);

    await expect(
      selectNativePdf(
        adapter({
          pickPdf: async () => "/tmp/not-really.pdf",
          readExternalFile: async () => new TextEncoder().encode("plain text"),
          writeLocalFile,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-file" } satisfies Partial<NativePdfError>);
    expect(writeLocalFile).not.toHaveBeenCalled();
  });

  it("classifies local copy failures", async () => {
    await expect(
      selectNativePdf(
        adapter({
          writeLocalFile: async () => {
            throw new Error("disk full");
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "write-failed" } satisfies Partial<NativePdfError>);
  });
});

describe("persistNativePdf", () => {
  it.each(["中".repeat(78), `${"x".repeat(95)}🧠`])(
    "keeps generated Unicode filenames within filesystem limits without splitting a character: %s",
    async (stem) => {
      const writeLocalFile = vi.fn(async (path: string) => {
        const name = path.split("/").pop()!;
        if (new TextEncoder().encode(name).length > 255) throw new Error("ENAMETOOLONG");
        expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      });
      const file = new File([validPdf], `${stem}.pdf`, { type: "application/pdf" });
      const imported = await persistNativePdf(file, adapter({ writeLocalFile }));
      expect(new TextEncoder().encode(imported.localFilePath.split("/").pop()!).length).toBeLessThanOrEqual(255);
      expect(imported.file.name).toBe(file.name);
      expect(writeLocalFile).toHaveBeenCalledOnce();
    },
  );
  it("copies a dropped PDF to AppLocalData and returns its durable path", async () => {
    const ensurePdfDirectory = vi.fn(async () => undefined);
    const writeLocalFile = vi.fn(async () => undefined);
    const file = new File([validPdf], "methods-and-results-final.pdf", {
      type: "application/pdf",
      lastModified: 123,
    });

    const result = await persistNativePdf(
      file,
      adapter({ ensurePdfDirectory, writeLocalFile }),
    );

    expect(result.file.name).toBe("methods-and-results-final.pdf");
    expect(result.localFilePath).toBe(
      "paperlens/pdfs/1700000000000-abc12345-methods-and-results-final.pdf",
    );
    expect(ensurePdfDirectory).toHaveBeenCalledOnce();
    expect(writeLocalFile).toHaveBeenCalledWith(result.localFilePath, validPdf);
  });

  it("rejects invalid bytes from an HTML file input before writing", async () => {
    const writeLocalFile = vi.fn(async () => undefined);
    const file = new File(["not a PDF"], "renamed.pdf", {
      type: "application/pdf",
    });

    await expect(
      persistNativePdf(file, adapter({ writeLocalFile })),
    ).rejects.toMatchObject({ code: "invalid-file" } satisfies Partial<NativePdfError>);
    expect(writeLocalFile).not.toHaveBeenCalled();
  });

  it("classifies failures while reading a browser File", async () => {
    const file = new File([validPdf], "paper.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });

    await expect(persistNativePdf(file, adapter())).rejects.toMatchObject({
      code: "read-failed",
    });
  });
});

describe("loadLocalPdf", () => {
  it("reopens the exact path produced when importing a filename containing consecutive dots", async () => {
    const files = new Map<string, Uint8Array>();
    const storage = adapter({
      pickPdf: async () => "/tmp/论文 draft..v2.pdf",
      writeLocalFile: async (path, bytes) => { files.set(path, bytes); },
      readLocalFile: async (path) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error("Not found");
        return bytes;
      },
    });
    const imported = await selectNativePdf(storage);
    expect(imported).not.toBeNull();
    const restored = await loadLocalPdf(imported!.localFilePath, storage);
    expect(restored.name).toBe("论文 draft..v2.pdf");
    expect(await restored.text()).toBe(await imported!.file.text());
  });
  it("restores a stored PDF with its display name", async () => {
    const readLocalFile = vi.fn(async () => validPdf);
    const file = await loadLocalPdf(
      "paperlens/pdfs/1700000000000-abc12345-论文 Draft.pdf",
      adapter({ readLocalFile }),
    );

    expect(file.name).toBe("论文 Draft.pdf");
    expect(await file.text()).toContain("%PDF-1.7");
    expect(readLocalFile).toHaveBeenCalledWith(
      "paperlens/pdfs/1700000000000-abc12345-论文 Draft.pdf",
    );
  });

  it("preserves every hyphen in the original display name", async () => {
    const file = await loadLocalPdf(
      "paperlens/pdfs/1788531567710-65cccdf3-RegulatoryCertification-036-00009.pdf",
      adapter(),
    );

    expect(file.name).toBe("RegulatoryCertification-036-00009.pdf");
  });

  it.each([
    "../secret.pdf",
    "/Users/researcher/secret.pdf",
    "paperlens/other/secret.pdf",
    "paperlens/pdfs/folder/secret.pdf",
    "paperlens/pdfs/../secret.pdf",
    "paperlens/pdfs/folder\\..\\secret.pdf",
    "paperlens/pdfs/secret\u0000.pdf",
  ])("rejects a path outside the private PDF directory: %s", async (path) => {
    await expect(loadLocalPdf(path, adapter())).rejects.toMatchObject({
      code: "invalid-local-path",
    });
  });
});
