import type { Paper } from "../domain/paper";
import { mapOpenAlexWork, type OpenAlexWork } from "./openAlex";

export type DailyRecommendation = {
  paper: Paper;
  reason: string;
};

const DEFAULT_FOCUSES = [
  "machine learning",
  "scientific computing",
  "causal inference",
  "computer vision",
  "natural language processing",
  "time series forecasting",
];
const STOP_WORDS = new Set([
  "about", "after", "based", "deep", "from", "into", "learning", "method",
  "model", "models", "paper", "research", "study", "that", "the", "their",
  "this", "through", "towards", "using", "with", "all", "need", "and", "for",
]);

export function recommendationFocuses(savedPapers: readonly Paper[], date: Date): string[] {
  const dateSeed = Number(`${date.getFullYear()}${date.getMonth() + 1}${date.getDate()}`);
  const recentTitle = savedPapers.find((paper) => paper.source !== "local")?.title;
  const titleWords = recentTitle?.toLocaleLowerCase("en")
    .match(/[a-z]{4,}/g)?.filter((word) => !STOP_WORDS.has(word)) ?? [];
  const personal = [...new Set(titleWords)].slice(0, 2).join(" ");
  const rotating = DEFAULT_FOCUSES[dateSeed % DEFAULT_FOCUSES.length];
  const second = DEFAULT_FOCUSES[(dateSeed + 3) % DEFAULT_FOCUSES.length];
  return [...new Set([personal, rotating, second].filter(Boolean))].slice(0, 3);
}

function dateMonthsAgo(date: Date, months: number): string {
  const start = new Date(date);
  start.setMonth(start.getMonth() - months);
  return [start.getFullYear(), String(start.getMonth() + 1).padStart(2, "0"), String(start.getDate()).padStart(2, "0")].join("-");
}

function dateStamp(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

export async function getDailyRecommendations(
  savedPapers: readonly Paper[],
  date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<DailyRecommendation[]> {
  const savedIds = new Set(savedPapers.map((paper) => paper.doi ?? `${paper.source}:${paper.id}`));
  const focuses = recommendationFocuses(savedPapers, date);
  const requests = focuses.map(async (focus) => {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", focus);
    url.searchParams.set("filter", `from_publication_date:${dateMonthsAgo(date, 12)},to_publication_date:${dateStamp(date)},type:article,is_retracted:false,has_abstract:true`);
    url.searchParams.set("sort", "relevance_score:desc");
    url.searchParams.set("per_page", "8");
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`OpenAlex HTTP ${response.status}`);
    const payload = await response.json() as { results?: unknown };
    if (!Array.isArray(payload.results)) throw new Error("OpenAlex 推荐格式无效");
    return payload.results.filter(
      (value): value is OpenAlexWork => typeof value === "object" && value !== null,
    ).map(mapOpenAlexWork).filter((paper) =>
      paper.title !== "Untitled work" && !paper.isRetracted &&
      (paper.year === null || paper.year <= date.getFullYear()) &&
      !savedIds.has(paper.doi ?? `${paper.source}:${paper.id}`),
    ).slice(0, 3).map((paper) => ({
      paper,
      reason: savedPapers.length > 0 && focus === focuses[0]
        ? `与你的资料库主题「${focus}」相关`
        : `近期研究 · ${focus}`,
    }));
  });
  const settled = await Promise.allSettled(requests);
  if (settled.every((result) => result.status === "rejected")) {
    throw new Error("暂时无法加载每日推荐，请稍后重试。");
  }
  const seen = new Set<string>();
  return settled.flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .filter(({ paper }) => {
      const key = paper.doi ?? `${paper.source}:${paper.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 6);
}
