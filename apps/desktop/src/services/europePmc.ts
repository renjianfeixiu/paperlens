import { deduplicateAccessLocations, type AccessLocation } from "../domain/access";
import { normalizeDoi } from "../domain/doi";

const EUROPE_PMC_ENDPOINT = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

type EuropePmcWork = {
  doi?: unknown;
  title?: unknown;
  id?: unknown;
  source?: unknown;
  pmcid?: unknown;
  isOpenAccess?: unknown;
  hasPDF?: unknown;
};

function normalizedTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim().replace(/\s+/g, " ");
  return normalized || undefined;
}

export class EuropePmcLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EuropePmcLookupError";
  }
}

export function mapEuropePmcLocations(work: EuropePmcWork): AccessLocation[] {
  const isOpenAccess = work.isOpenAccess === "Y";
  const pmcid = typeof work.pmcid === "string" ? work.pmcid : undefined;
  const source = typeof work.source === "string" ? work.source : "MED";
  const id = typeof work.id === "string" ? work.id : pmcid;
  const candidates: unknown[] = [];
  if (id) candidates.push({
    url: `https://europepmc.org/article/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
    kind: "landing-page",
    source: "europe-pmc",
    isOpenAccess,
    license: null,
    version: "publishedVersion",
    hostType: "repository",
    hostName: "Europe PMC",
  });
  if (isOpenAccess && work.hasPDF === "Y" && pmcid) candidates.push({
    url: `https://europepmc.org/articles/${encodeURIComponent(pmcid)}?pdf=render`,
    kind: "pdf",
    source: "europe-pmc",
    isOpenAccess: true,
    license: null,
    version: "publishedVersion",
    hostType: "repository",
    hostName: "Europe PMC",
  });
  return deduplicateAccessLocations(candidates);
}

export async function findEuropePmcLocations(
  paper: { doi?: string; title: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AccessLocation[]> {
  const doi = normalizeDoi(paper.doi);
  const query = doi ? `DOI:${doi}` : `TITLE:"${paper.title.trim()}"`;
  const url = new URL(EUROPE_PMC_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("resultType", "core");
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", "3");
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new EuropePmcLookupError("Europe PMC 暂时无法连接。");
  }
  if (!response.ok) throw new EuropePmcLookupError(`Europe PMC 查询失败（HTTP ${response.status}）。`);
  const payload = await response.json() as { resultList?: { result?: unknown } };
  const works = Array.isArray(payload.resultList?.result)
    ? payload.resultList.result.filter(
        (value): value is EuropePmcWork => typeof value === "object" && value !== null,
      )
    : [];
  const requestedTitle = normalizedTitle(paper.title);
  const exact = doi
    ? works.filter((work) => normalizeDoi(typeof work.doi === "string" ? work.doi : undefined) === doi)
    : works.filter((work) => normalizedTitle(work.title) === requestedTitle);
  return deduplicateAccessLocations(exact.flatMap(mapEuropePmcLocations));
}
