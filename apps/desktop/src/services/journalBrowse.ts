import { normalizeAccessUrl } from "../domain/access";
import type { Paper } from "../domain/paper";
import { mapOpenAlexWork, type OpenAlexWork } from "./openAlex";

export type Journal = {
  id: string;
  name: string;
  issn: string | null;
  worksCount: number;
  isOpenAccess: boolean;
  homepageUrl?: string;
};

export type JournalWorksPage = {
  papers: Paper[];
  hasMore: boolean;
};

function journalId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.match(/(?:^|\/)S\d+$/)?.[0].replace(/^\//, "");
  return id && /^S\d+$/.test(id) ? id : undefined;
}

function mapJournal(value: unknown): Journal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const id = journalId(source.id);
  if (!id || source.type !== "journal" || typeof source.display_name !== "string" || !source.display_name.trim()) return undefined;
  const homepageUrl = normalizeAccessUrl(source.homepage_url);
  return {
    id,
    name: source.display_name.trim(),
    issn: typeof source.issn_l === "string" ? source.issn_l : null,
    worksCount: typeof source.works_count === "number" && source.works_count >= 0 ? source.works_count : 0,
    isOpenAccess: source.is_oa === true,
    ...(homepageUrl ? { homepageUrl } : {}),
  };
}

async function openAlexJson(url: URL, fetchImpl: typeof fetch): Promise<{ results: unknown[]; meta?: { count?: number } }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error("无法连接 OpenAlex，请检查网络后重试。");
  }
  if (!response.ok) throw new Error(`OpenAlex 暂时不可用（HTTP ${response.status}）。`);
  const payload = await response.json() as { results?: unknown; meta?: { count?: number } };
  if (!Array.isArray(payload.results)) throw new Error("OpenAlex 返回了无法识别的期刊数据。");
  return { results: payload.results, meta: payload.meta };
}

export async function searchJournals(query = "", fetchImpl: typeof fetch = fetch): Promise<Journal[]> {
  const url = new URL("https://api.openalex.org/sources");
  const term = query.trim();
  const issn = term.match(/^\d{4}-?\d{3}[\dXx]$/)?.[0].toUpperCase();
  if (issn) {
    const normalizedIssn = issn.includes("-") ? issn : `${issn.slice(0, 4)}-${issn.slice(4)}`;
    url.searchParams.set("filter", `type:journal,issn:${normalizedIssn}`);
  } else if (term) url.searchParams.set("search", term);
  else url.searchParams.set("sort", "works_count:desc");
  if (!issn) url.searchParams.set("filter", "type:journal");
  url.searchParams.set("per_page", "20");
  const payload = await openAlexJson(url, fetchImpl);
  return payload.results.flatMap((item) => {
    const journal = mapJournal(item);
    return journal ? [journal] : [];
  });
}

export async function listJournalPapers(
  journal: Pick<Journal, "id">,
  page = 1,
  fetchImpl: typeof fetch = fetch,
): Promise<JournalWorksPage> {
  if (!/^S\d+$/.test(journal.id)) throw new Error("期刊标识符无效。");
  const normalizedPage = Math.max(1, Math.floor(page));
  const today = new Date();
  const todayStamp = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-");
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("filter", `primary_location.source.id:${journal.id},type:article,to_publication_date:${todayStamp}`);
  url.searchParams.set("sort", "publication_date:desc");
  url.searchParams.set("page", String(normalizedPage));
  url.searchParams.set("per_page", "20");
  const payload = await openAlexJson(url, fetchImpl);
  const works = payload.results.filter((item): item is OpenAlexWork =>
    typeof item === "object" && item !== null,
  );
  const total = typeof payload.meta?.count === "number" ? payload.meta.count : null;
  return {
    papers: works.map(mapOpenAlexWork).filter((paper) => !paper.isRetracted),
    hasMore: total === null ? works.length === 20 : normalizedPage * 20 < total,
  };
}
