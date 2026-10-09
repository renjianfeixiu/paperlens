import type { AccessLocation } from "../domain/access";
import { normalizeDoi } from "../domain/doi";
import type { Paper } from "../domain/paper";

// Reviewed version links, not title-based URL guesses. Each entry requires an
// exact identifier AND title; indexes can omit the conference version entirely.
// Source checked 2026-10-06:
// https://papers.nips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html
const VERIFIED_VERSIONS = [{
  doi: "10.48550/arxiv.1706.03762",
  title: "attention is all you need",
  landingPage: "https://papers.nips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html",
  pdf: "https://papers.nips.cc/paper_files/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf",
  hostName: "NeurIPS 官方论文集",
}];

export function verifiedPublisherLocations(paper: Pick<Paper, "doi" | "title">): AccessLocation[] {
  const doi = normalizeDoi(paper.doi);
  const title = paper.title.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const version = VERIFIED_VERSIONS.find((entry) => entry.doi === doi && entry.title === title);
  if (!version) return [];
  const shared = {
    source: "publisher-metadata" as const,
    isOpenAccess: true,
    license: null,
    version: "publishedVersion",
    hostType: "publisher",
    hostName: version.hostName,
  };
  return [
    { ...shared, kind: "pdf", url: version.pdf },
    { ...shared, kind: "landing-page", url: version.landingPage },
  ];
}
