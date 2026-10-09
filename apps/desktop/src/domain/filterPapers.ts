import type { Paper } from "./paper";

export type PaperFilter = "recent" | "open-access" | "review";

const REVIEW_PATTERN = /\b(review|survey|meta-analysis|tutorial)\b|综述|元分析/i;

export function filterPapers(
  papers: readonly Paper[],
  filters: readonly PaperFilter[],
  referenceYear = new Date().getFullYear(),
): Paper[] {
  const recentThreshold = referenceYear - 4;

  return papers.filter((paper) => {
    if (
      filters.includes("recent") &&
      (paper.year === null || paper.year < recentThreshold)
    ) {
      return false;
    }

    if (filters.includes("open-access") && !paper.isOpenAccess) {
      return false;
    }

    if (
      filters.includes("review") &&
      !REVIEW_PATTERN.test(`${paper.title} ${paper.venue}`)
    ) {
      return false;
    }

    return true;
  });
}
