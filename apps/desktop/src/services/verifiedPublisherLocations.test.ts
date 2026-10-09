import { describe, expect, it } from "vitest";
import { openAccessPdfLocations } from "../domain/access";
import { verifiedPublisherLocations } from "./verifiedPublisherLocations";

describe("reviewed publication versions", () => {
  it("provides the official conference PDF for the exact original arXiv work", () => {
    const locations = verifiedPublisherLocations({
      doi: "https://doi.org/10.48550/arXiv.1706.03762",
      title: "Attention Is All You Need",
    });
    expect(locations).toHaveLength(2);
    expect(openAccessPdfLocations(locations)[0]).toMatchObject({
      url: "https://papers.nips.cc/paper_files/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf",
      version: "publishedVersion", hostName: "NeurIPS 官方论文集",
    });
  });

  it.each([
    { title: "Attention Is All You Need" },
    { doi: "10.1234/another-work", title: "Attention Is All You Need" },
    { doi: "10.48550/arxiv.1706.03762", title: "Attention Is All You Need for Vision" },
  ])("does not attach a similarly named or contradictory work's PDF", (paper) => {
    expect(verifiedPublisherLocations(paper)).toEqual([]);
  });
});
