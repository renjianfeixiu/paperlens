import { describe, expect, it } from "vitest";
import type { Paper } from "../domain/paper";
import {
  LIBRARY_STORAGE_KEY,
  addPaper,
  attachLocalPdf,
  createEmptyLibrary,
  importPapers,
  isSamePaper,
  loadLibrary,
  persistLibrary,
  removePaper,
  updateReadingState,
} from "./library";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function paper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: "W1",
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani"],
    year: 2017,
    venue: "NeurIPS",
    doi: "10.5555/3295222.3295349",
    citedByCount: 100_000,
    isOpenAccess: true,
    openAccessUrl: "https://example.test/paper.pdf",
    source: "openalex",
    ...overrides,
  };
}

describe("library persistence", () => {
  it("is safe when browser storage does not exist", () => {
    expect(loadLibrary()).toEqual(createEmptyLibrary());
    expect(persistLibrary(createEmptyLibrary())).toBe(false);
  });

  it("round-trips a normalized library through storage", () => {
    const storage = new MemoryStorage();
    const saved = addPaper(createEmptyLibrary(), paper(), {
      addedAt: "2026-09-04T08:00:00.000Z",
      localFilePath: "/Users/me/Papers/attention.pdf",
    });
    const reading = updateReadingState(saved, "W1", {
      currentPage: 3,
      totalPages: 15,
      lastReadAt: "2026-09-04T08:30:00.000Z",
    });

    expect(persistLibrary(reading, storage)).toBe(true);
    expect(loadLibrary(storage)).toEqual(reading);
  });

  it("falls back when storage contains invalid JSON or throws", () => {
    const storage = new MemoryStorage();
    storage.setItem(LIBRARY_STORAGE_KEY, "{not-json");
    expect(loadLibrary(storage)).toEqual(createEmptyLibrary());

    const blocked = new MemoryStorage();
    blocked.getItem = () => {
      throw new Error("blocked");
    };
    blocked.setItem = () => {
      throw new Error("quota exceeded");
    };
    expect(loadLibrary(blocked)).toEqual(createEmptyLibrary());
    expect(persistLibrary(createEmptyLibrary(), blocked)).toBe(false);
  });

  it("restores structured access locations and repairs unsafe entries", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      LIBRARY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        items: [
          {
            paper: {
              ...paper({ openAccessUrl: undefined, isOpenAccess: false }),
              accessLocations: [
                {
                  url: "https://repository.example/paper.pdf#page=3",
                  kind: "pdf",
                  source: "openalex",
                  isOpenAccess: false,
                  license: null,
                  version: "acceptedVersion",
                },
                {
                  url: "https://repository.example/paper.pdf",
                  kind: "pdf",
                  source: "crossref",
                  isOpenAccess: true,
                  license: "https://creativecommons.org/licenses/by/4.0/",
                  version: null,
                },
                {
                  url: "javascript:alert(1)",
                  kind: "pdf",
                  source: "openalex",
                  isOpenAccess: true,
                },
                {
                  url: "https://example.org/unknown-source",
                  kind: "landing-page",
                  source: "unknown",
                  isOpenAccess: true,
                },
              ],
            },
          },
        ],
      }),
    );

    const loaded = loadLibrary(storage);
    expect(loaded.items[0].paper).toMatchObject({
      isOpenAccess: true,
      openAccessUrl: "https://repository.example/paper.pdf",
      accessLocations: [
        {
          url: "https://repository.example/paper.pdf",
          kind: "pdf",
          source: "openalex",
          isOpenAccess: true,
          license: "https://creativecommons.org/licenses/by/4.0/",
          version: "acceptedVersion",
        },
      ],
    });
    expect(persistLibrary(loaded, storage)).toBe(true);
    expect(loadLibrary(storage)).toEqual(loaded);
  });

  it("keeps a safe legacy openAccessUrl without requiring the new field", () => {
    const storage = new MemoryStorage();
    const legacy = addPaper(
      createEmptyLibrary(),
      paper({ accessLocations: undefined }),
      { addedAt: "2026-09-04T08:00:00.000Z" },
    );

    expect(persistLibrary(legacy, storage)).toBe(true);
    expect(loadLibrary(storage)).toEqual(legacy);
    expect(loadLibrary(storage).items[0].paper.accessLocations).toBeUndefined();
  });

  it("keeps valid entries and repairs malformed optional data", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      LIBRARY_STORAGE_KEY,
      JSON.stringify({
        version: 999,
        items: [
          { paper: { id: "missing-title" } },
          {
            addedAt: "not-a-date",
            paper: {
              id: "local-1",
              title: "A Local Paper",
              authors: ["Ada", null, ""],
              year: "2025",
              citedByCount: -10,
              source: "unknown-source",
            },
            reading: {
              currentPage: 99,
              totalPages: 10,
              progress: 4,
              status: "unknown",
              lastReadAt: "bad-date",
            },
          },
        ],
      }),
    );

    const loaded = loadLibrary(storage);
    expect(loaded.version).toBe(1);
    expect(loaded.items).toHaveLength(1);
    expect(loaded.items[0]).toMatchObject({
      addedAt: "1970-01-01T00:00:00.000Z",
      paper: {
        id: "local-1",
        authors: ["Ada"],
        year: null,
        venue: "",
        citedByCount: 0,
        isOpenAccess: false,
        source: "local",
      },
      reading: {
        currentPage: 10,
        totalPages: 10,
        progress: 1,
        status: "finished",
        lastReadAt: null,
      },
    });
  });
});

describe("library state transitions", () => {
  it("adds without mutation and ignores the same DOI", () => {
    const initial = createEmptyLibrary();
    const saved = addPaper(initial, paper(), {
      addedAt: "2026-09-04T08:00:00.000Z",
    });
    const duplicate = paper({
      id: "crossref:1",
      doi: "HTTPS://DOI.ORG/10.5555/3295222.3295349",
      source: "crossref",
    });

    expect(initial.items).toHaveLength(0);
    expect(saved.items).toHaveLength(1);
    expect(addPaper(saved, duplicate)).toBe(saved);
  });

  it("uses normalized title, year, and first author as a DOI fallback", () => {
    const first = paper({ doi: undefined });
    const duplicate = paper({
      id: "local-copy",
      title: "  ATTENTION—IS ALL YOU NEED! ",
      authors: ["ASHISH   VASWANI"],
      doi: undefined,
      source: "local",
    });
    const distinctDoi = paper({
      id: "other",
      title: "A Different Work",
      authors: ["Grace Hopper"],
      doi: "10.1000/a-different-work",
      source: "crossref",
    });

    expect(isSamePaper(first, duplicate)).toBe(true);
    expect(isSamePaper(paper(), distinctDoi)).toBe(false);
  });

  it("batch-imports in order while de-duplicating", () => {
    const first = paper({ id: "one" });
    const second = paper({
      id: "two",
      title: "BERT: Pre-training of Deep Bidirectional Transformers",
      authors: ["Jacob Devlin"],
      year: 2019,
      doi: "10.48550/arXiv.1810.04805",
    });
    const duplicate = paper({ id: "one-copy" });

    const imported = importPapers(createEmptyLibrary(), [
      first,
      second,
      duplicate,
    ]);
    expect(imported.items.map((item) => item.paper.id)).toEqual(["one", "two"]);
  });

  it("attaches a downloaded PDF to an existing DOI without duplicating metadata", () => {
    const saved = addPaper(createEmptyLibrary(), paper(), {
      addedAt: "2026-09-04T08:00:00.000Z",
    });
    const sameWorkFromAnotherSource = paper({
      id: "crossref:attention",
      source: "crossref",
    });

    const attached = attachLocalPdf(
      saved,
      sameWorkFromAnotherSource,
      "paperlens/pdfs/attention.pdf",
    );

    expect(attached.items).toHaveLength(1);
    expect(attached.items[0].paper.id).toBe("W1");
    expect(attached.items[0].localFilePath).toBe("paperlens/pdfs/attention.pdf");
    expect(attachLocalPdf(attached, sameWorkFromAnotherSource, "   ")).toBe(attached);
  });

  it("updates pages, progress, status, and timestamp without mutation", () => {
    const saved = addPaper(createEmptyLibrary(), paper(), {
      addedAt: "2026-09-04T08:00:00.000Z",
    });
    const reading = updateReadingState(saved, "W1", {
      currentPage: 12,
      totalPages: 10,
      lastReadAt: "2026-09-04T09:00:00.000Z",
    });

    expect(saved.items[0].reading).toMatchObject({
      currentPage: 0,
      progress: 0,
      status: "inbox",
    });
    expect(reading.items[0].reading).toEqual({
      currentPage: 10,
      totalPages: 10,
      progress: 1,
      status: "finished",
      lastReadAt: "2026-09-04T09:00:00.000Z",
    });

    const reset = updateReadingState(reading, "W1", -2);
    expect(reset.items[0].reading.progress).toBe(0);
  });

  it("removes by ID and preserves identity for no-op operations", () => {
    const saved = addPaper(createEmptyLibrary(), paper(), {
      addedAt: "2026-09-04T08:00:00.000Z",
    });

    expect(updateReadingState(saved, "missing", 0.5)).toBe(saved);
    expect(removePaper(saved, "missing")).toBe(saved);
    expect(removePaper(saved, "W1").items).toEqual([]);
  });
});
