import { describe, expect, it } from "vitest";
import { findEuropePmcLocations, mapEuropePmcLocations } from "./europePmc";

describe("Europe PMC full-text lookup", () => {
  it("adds a PDF only when Europe PMC marks it open and available", () => {
    expect(mapEuropePmcLocations({
      id: "1", source: "MED", pmcid: "PMC1", isOpenAccess: "Y", hasPDF: "Y",
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "pdf", isOpenAccess: true, source: "europe-pmc" }),
    ]));
    expect(mapEuropePmcLocations({
      id: "2", source: "MED", pmcid: "PMC2", isOpenAccess: "N", hasPDF: "Y",
    }).some((item) => item.kind === "pdf")).toBe(false);
  });

  it("looks up an exact DOI", async () => {
    const result = await findEuropePmcLocations(
      { doi: "10.1234/example", title: "Paper" },
      async () => new Response(JSON.stringify({ resultList: { result: [{
        doi: "10.1234/example", id: "10", source: "MED", pmcid: "PMC10",
        isOpenAccess: "Y", hasPDF: "Y",
      }] } })),
    );
    expect(result.some((item) => item.kind === "pdf")).toBe(true);
  });

  it("rejects a non-exact title result when DOI is missing", async () => {
    const result = await findEuropePmcLocations(
      { title: "Attention Is All You Need" },
      async () => new Response(JSON.stringify({ resultList: { result: [{
        title: "Attention in Vision", id: "10", source: "MED", pmcid: "PMC10",
        isOpenAccess: "Y", hasPDF: "Y",
      }] } })),
    );
    expect(result).toEqual([]);
  });
});
