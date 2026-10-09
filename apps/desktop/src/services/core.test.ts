import { describe, expect, it, vi } from "vitest";
import { findCoreLocations, mapCoreLocations } from "./core";

describe("CORE full-text lookup", () => {
  it("maps repository download and display links", () => {
    const result = mapCoreLocations({
      downloadUrl: "https://core.ac.uk/download/123.pdf",
      sourceFulltextUrls: ["https://repository.example/item/1"],
      links: [{ type: "display", url: "https://core.ac.uk/works/1" }],
    });
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "core", kind: "pdf", isOpenAccess: true }),
      expect.objectContaining({ source: "core", kind: "landing-page", isOpenAccess: true }),
    ]));
  });

  it("keeps only exact DOI records", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [
      { doi: "10.1234/right", downloadUrl: "https://core.ac.uk/download/right.pdf" },
      { doi: "10.1234/wrong", downloadUrl: "https://core.ac.uk/download/wrong.pdf" },
    ] })));
    const result = await findCoreLocations({ doi: "10.1234/right", title: "Paper" }, fetchMock);
    expect(result.map((item) => item.url)).toEqual(["https://core.ac.uk/download/right.pdf"]);
  });

  it("does not attach a fuzzy title result to the wrong paper", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [
      { title: "Attention in Vision", downloadUrl: "https://core.ac.uk/download/wrong.pdf" },
    ] })));
    const result = await findCoreLocations({ title: "Attention Is All You Need" }, fetchMock);
    expect(result).toEqual([]);
  });
});
