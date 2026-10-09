import {
  augmentTrustedOpenAccessLocations,
  deduplicateAccessLocations,
  inferAccessKind,
  type AccessLocation,
} from "../domain/access";
import { normalizeDoi } from "../domain/doi";

const CORE_ENDPOINT = "https://api.core.ac.uk/v3/search/works/";

type CoreWork = {
  doi?: unknown;
  title?: unknown;
  downloadUrl?: unknown;
  sourceFulltextUrls?: unknown;
  links?: unknown;
};

function normalizedTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim().replace(/\s+/g, " ");
  return normalized || undefined;
}

export class CoreLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreLookupError";
  }
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function mapCoreLocations(work: CoreWork): AccessLocation[] {
  const displayLinks = Array.isArray(work.links)
    ? work.links.flatMap((link) =>
        typeof link === "object" && link !== null && "url" in link && typeof link.url === "string"
          ? [link.url]
          : [],
      )
    : [];
  const candidates = [
    ...(typeof work.downloadUrl === "string" && work.downloadUrl ? [work.downloadUrl] : []),
    ...stringValues(work.sourceFulltextUrls),
    ...displayLinks,
  ].map((url) => ({
    url,
    kind: inferAccessKind(url),
    source: "core" as const,
    isOpenAccess: true,
    license: null,
    version: null,
    hostType: "repository",
    hostName: "CORE",
  }));
  return augmentTrustedOpenAccessLocations(deduplicateAccessLocations(candidates));
}

export async function findCoreLocations(
  paper: { doi?: string; title: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AccessLocation[]> {
  const doi = normalizeDoi(paper.doi);
  const query = doi ? `doi:"${doi}"` : `title:"${paper.title.trim()}"`;
  const url = new URL(CORE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "5");

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new CoreLookupError("CORE 暂时无法连接。");
  }
  if (!response.ok) throw new CoreLookupError(`CORE 查询失败（HTTP ${response.status}）。`);
  const payload = await response.json() as { results?: unknown };
  const works = Array.isArray(payload.results) ? payload.results.filter(
    (value): value is CoreWork => typeof value === "object" && value !== null,
  ) : [];
  const requestedTitle = normalizedTitle(paper.title);
  const exact = doi
    ? works.filter((work) => normalizeDoi(typeof work.doi === "string" ? work.doi : undefined) === doi)
    : works.filter((work) => normalizedTitle(work.title) === requestedTitle);
  return deduplicateAccessLocations(exact.flatMap(mapCoreLocations));
}
