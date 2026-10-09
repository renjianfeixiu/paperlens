import { normalizeDoi } from "../domain/doi";
import type { AccessLocation } from "../domain/access";
import type { Paper } from "../domain/paper";
import { verifiedPublisherLocations } from "./verifiedPublisherLocations";

// arXiv deposits its original metadata with DataCite, not Crossref. Keeping this
// channel independent also allows discovery when OpenAlex is unavailable.
const ENDPOINT = "https://api.datacite.org/dois";
const ARXIV_DOI = /^10\.48550\/arxiv\.([a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5})$/i;
export type ArxivSearchOptions = {
  page?: number;
  perPage?: number;
  doi?: string;
  exactTitle?: boolean;
  recentSinceYear?: number;
  signal?: AbortSignal;
};
export type ArxivSearchPage = { papers: Paper[]; hasMore: boolean; total: number | null };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() || undefined : undefined;
}
function literal(value: string): string {
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}

export function mapArxivRecord(value: unknown): Paper | undefined {
  const entry = record(value);
  const attributes = record(entry.attributes);
  const doi = normalizeDoi(text(attributes.doi) ?? text(entry.id));
  const id = doi?.match(ARXIV_DOI)?.[1];
  const title = list(attributes.titles).map((item) => text(item.title)).find(Boolean);
  if (!id || !title) return undefined;
  const authors = list(attributes.creators).flatMap((creator) => {
    const parts = [text(creator.givenName), text(creator.familyName)].filter(Boolean);
    const name = parts.length ? parts.join(" ") : text(creator.name)?.replace(/^([^,]+),\s*(.+)$/, "$2 $1");
    return name ? [name] : [];
  });
  const year = attributes.publicationYear;
  const license = list(attributes.rightsList).map((item) => text(item.rightsUri) ?? text(item.rights)).find(Boolean) ?? null;
  const shared = { source: "arxiv" as const, isOpenAccess: true, license, version: "submittedVersion", hostType: "repository", hostName: "arXiv" };
  const accessLocations: AccessLocation[] = [
    ...verifiedPublisherLocations({ doi, title }),
    { ...shared, kind: "pdf", url: `https://arxiv.org/pdf/${id}` },
    { ...shared, kind: "landing-page", url: `https://arxiv.org/abs/${id}` },
  ];
  const abstract = list(attributes.descriptions).find((item) => item.descriptionType === "Abstract");
  return {
    id: `arxiv:${id}`, doi, title, authors,
    year: typeof year === "number" && Number.isInteger(year) && year > 0 && year < 10_000 ? year : null,
    venue: "arXiv", abstract: text(abstract?.description),
    citedByCount: typeof attributes.citationCount === "number" ? Math.max(0, attributes.citationCount) : 0,
    source: "arxiv", publicationType: "preprint", isOpenAccess: true,
    openAccessUrl: `https://arxiv.org/pdf/${id}`, accessLocations,
  };
}

export async function searchArxivPage(
  query: string, options: ArxivSearchOptions = {}, fetchImpl: typeof fetch = fetch,
): Promise<ArxivSearchPage> {
  const normalized = query.trim();
  if (!normalized) throw new Error("请输入 arXiv 标题、主题或编号。");
  const doi = normalizeDoi(options.doi);
  if (options.doi && !doi?.match(ARXIV_DOI)) return { papers: [], total: 0, hasMore: false };
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const size = Math.min(100, Math.max(1, Math.floor(options.perPage ?? 50)));
  const url = new URL(doi ? `${ENDPOINT}/${encodeURIComponent(doi)}` : ENDPOINT);
  if (!doi) {
    url.searchParams.set("client-id", "arxiv.content");
    let expression = options.exactTitle
      ? `titles.title:${literal(normalized)}`
      : normalized.split(/\s+/).map(literal).join(" AND ");
    if (options.recentSinceYear) expression = `(${expression}) AND publicationYear:[${options.recentSinceYear} TO *]`;
    url.searchParams.set("query", expression);
    // DataCite otherwise defaults to recency: that hides older original papers.
    url.searchParams.set("sort", "relevance");
    url.searchParams.set("page[number]", String(page));
    url.searchParams.set("page[size]", String(size));
    url.searchParams.set("fields[dois]", "doi,titles,creators,publicationYear,descriptions,rightsList,citationCount");
  }
  const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: options.signal });
  if (doi && response.status === 404) return { papers: [], total: 0, hasMore: false };
  if (!response.ok) throw new Error(response.status === 429
    ? "arXiv 元数据服务限流，请稍后重试。" : `arXiv 元数据服务返回 HTTP ${response.status}。`);
  const payload = record(await response.json());
  if (doi ? !payload.data || Array.isArray(payload.data) : !Array.isArray(payload.data)) {
    throw new Error("arXiv 元数据服务返回了无效的数据格式。");
  }
  const entries = doi ? [payload.data] : payload.data as unknown[];
  const papers = entries.map(mapArxivRecord).filter((paper): paper is Paper => Boolean(paper))
    .filter((paper) => (!doi || paper.doi === doi) && (!options.recentSinceYear || (paper.year ?? 0) >= options.recentSinceYear));
  const count = record(payload.meta).total;
  const total = doi ? papers.length : typeof count === "number" ? count : null;
  return { papers, total, hasMore: !doi && (total === null ? entries.length === size : page * size < total) };
}
