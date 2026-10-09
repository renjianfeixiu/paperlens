import { describe, expect, it, vi } from "vitest";
import { resolveFullTextLocations } from "./fullTextResolver";

describe("full-text resolver", () => {
  it("retains a verified official version when the live supplemental indexes are unavailable", async () => {
    const result = await resolveFullTextLocations({
      doi: "10.48550/arxiv.1706.03762", title: "Attention Is All You Need",
    }, { fetchImpl: async () => { throw new Error("provider unavailable"); } });
    expect(result.sources).toContain("官方发表版本");
    expect(result.locations.some((item) => item.kind === "pdf" && new URL(item.url).hostname === "papers.nips.cc")).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });

  it("bounds a hanging provider and preserves other providers' results", async () => {
    vi.useFakeTimers();
    let coreSignal: AbortSignal | null | undefined;
    try {
      const fetchImpl: typeof fetch = async (input, init) => {
        if (String(input).includes("core.ac.uk")) {
          coreSignal = init?.signal;
          return new Promise<Response>(() => {});
        }
        return new Response(JSON.stringify({ resultList: { result: [{
          doi: "10.1234/example", id: "1", source: "MED", pmcid: "PMC1",
          isOpenAccess: "Y", hasPDF: "Y",
        }] } }));
      };
      const pending = resolveFullTextLocations(
        { doi: "10.1234/example", title: "Paper" }, { fetchImpl, timeoutMs: 100 },
      );
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;
      expect(result.sources).toContain("Europe PMC");
      expect(result.locations.some((item) => item.source === "europe-pmc")).toBe(true);
      expect(result.warnings).toEqual(["CORE 暂时不可用"]);
      expect(coreSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps partial results when one provider fails", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("core.ac.uk")) throw new Error("offline");
      return new Response(JSON.stringify({ resultList: { result: [{
        doi: "10.1234/example", id: "1", source: "MED", pmcid: "PMC1",
        isOpenAccess: "Y", hasPDF: "Y",
      }] } }));
    };
    const result = await resolveFullTextLocations(
      { doi: "10.1234/example", title: "Paper" },
      { fetchImpl },
    );
    expect(result.locations.some((item) => item.source === "europe-pmc")).toBe(true);
    expect(result.warnings).toEqual(["CORE 暂时不可用"]);
  });
});
