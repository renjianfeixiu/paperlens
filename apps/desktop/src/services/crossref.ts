import { normalizeDoi } from "../domain/doi";
import {
  augmentTrustedOpenAccessLocations,
  deduplicateAccessLocations,
  inferAccessKind,
  normalizeAccessUrl,
  preferredOpenAccessUrl,
  type AccessLocation,
} from "../domain/access";
import type { Paper } from "../domain/paper";

const CROSSREF_WORKS_ENDPOINT = "https://api.crossref.org/works";
const RESULT_LIMIT = 35;

type CrossrefDate = {
  "date-parts"?: unknown;
};

type CrossrefLink = {
  URL?: unknown;
  "content-type"?: unknown;
  "content-version"?: unknown;
};

type CrossrefLicense = {
  URL?: unknown;
  "content-version"?: unknown;
};

export type CrossrefWork = {
  DOI?: unknown;
  URL?: unknown;
  title?: unknown;
  author?: unknown;
  publisher?: unknown;
  "container-title"?: unknown;
  "short-container-title"?: unknown;
  abstract?: unknown;
  "is-referenced-by-count"?: unknown;
  "published-print"?: CrossrefDate | null;
  "published-online"?: CrossrefDate | null;
  published?: CrossrefDate | null;
  issued?: CrossrefDate | null;
  link?: CrossrefLink[] | null;
  license?: CrossrefLicense[] | null;
  resource?: {
    primary?: {
      URL?: unknown;
    } | null;
  } | null;
  score?: unknown;
  type?: unknown;
  subtype?: unknown;
};

type CrossrefSearchResponse = {
  status?: unknown;
  message: {
    items: CrossrefWork[];
    "total-results"?: unknown;
  };
};

export type CrossrefSearchOptions = {
  signal?: AbortSignal;
  page?: number;
  perPage?: number;
  doi?: string;
  recentSinceYear?: number;
};

export type CrossrefSearchPage = {
  papers: Paper[];
  hasMore: boolean;
  total: number | null;
};

export type CrossrefSearchErrorCode =
  | "invalid-query"
  | "network"
  | "rate-limited"
  | "unauthorized"
  | "upstream"
  | "invalid-response";

export class CrossrefSearchError extends Error {
  readonly code: CrossrefSearchErrorCode;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    message: string,
    code: CrossrefSearchErrorCode,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message);
    this.name = "CrossrefSearchError";
    this.code = code;
    this.status = options?.status;
    this.cause = options?.cause;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstListValue(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const entry of value) {
    const text = nonEmptyString(entry);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function decodeXmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (entity, encoded: string) => {
    if (encoded.startsWith("#")) {
      const isHex = encoded[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(encoded.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return entity;
        }
      }
      return entity;
    }

    return namedEntities[encoded.toLowerCase()] ?? entity;
  });
}

/** Crossref abstracts and some titles contain JATS/XML fragments. */
export function cleanCrossrefText(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  if (!text) {
    return undefined;
  }

  // Some Crossref deposits contain literal JATS tags, while others escape the
  // same markup as `&lt;jats:p&gt;`. Decode once before removing tags, then
  // decode the remaining text entities so neither representation leaks into UI.
  const decodedMarkup = decodeXmlEntities(
    text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1"),
  );
  const cleaned = decodeXmlEntities(decodedMarkup.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || undefined;
}

function authors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const author = entry as Record<string, unknown>;
    const literalName = nonEmptyString(author.name);
    const givenName = nonEmptyString(author.given);
    const familyName = nonEmptyString(author.family);
    const combinedName = [givenName, familyName].filter(Boolean).join(" ");
    const name = literalName ?? (combinedName || undefined);
    return name ? [name] : [];
  });
}

function yearFromDate(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !("date-parts" in value)) {
    return null;
  }

  const dateParts = (value as CrossrefDate)["date-parts"];
  if (!Array.isArray(dateParts) || !Array.isArray(dateParts[0])) {
    return null;
  }

  const year = dateParts[0][0];
  return typeof year === "number" && Number.isSafeInteger(year) && year > 0 ? year : null;
}

function publicationYear(work: CrossrefWork): number | null {
  for (const date of [
    work["published-print"],
    work["published-online"],
    work.published,
    work.issued,
  ]) {
    const year = yearFromDate(date);
    if (year !== null) {
      return year;
    }
  }

  return null;
}

function httpUrl(value: unknown): string | undefined {
  return normalizeAccessUrl(value);
}

type NormalizedCrossrefLicense = {
  url: string;
  version: string | null;
  recognized: boolean;
};

function isHostOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isRecognizedOpenLicenseUrl(value: string): boolean {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();

  return (
    (isHostOrSubdomain(hostname, "creativecommons.org") &&
      (pathname.startsWith("/licenses/") || pathname.startsWith("/publicdomain/"))) ||
    (isHostOrSubdomain(hostname, "opendatacommons.org") &&
      pathname.startsWith("/licenses/")) ||
    (isHostOrSubdomain(hostname, "nationalarchives.gov.uk") &&
      pathname.startsWith("/doc/open-government-licence/")) ||
    (isHostOrSubdomain(hostname, "elsevier.com") &&
      pathname.startsWith("/open-access/userlicense/"))
  );
}

function normalizedLicenses(value: unknown): NormalizedCrossrefLicense[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];

    const license = entry as CrossrefLicense;
    const url = httpUrl(license.URL);
    if (!url) return [];

    return [{
      url,
      version: nonEmptyString(license["content-version"]) ?? null,
      recognized: isRecognizedOpenLicenseUrl(url),
    }];
  });
}

function linkCandidates(value: unknown): CrossrefLink[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is CrossrefLink => typeof entry === "object" && entry !== null,
      )
    : [];
}

function licenseForVersion(
  licenses: readonly NormalizedCrossrefLicense[],
  version: string | null,
): NormalizedCrossrefLicense | undefined {
  const applicable = version
    ? licenses.filter((license) => !license.version || license.version === version)
    : licenses.filter((license) => !license.version);
  return applicable.find((license) => license.recognized) ?? applicable[0];
}

function isPdfLink(link: CrossrefLink, url: string): boolean {
  const contentType = nonEmptyString(link["content-type"])
    ?.toLowerCase()
    .split(";", 1)[0]
    ?.trim();
  return contentType === "application/pdf" || inferAccessKind(url) === "pdf";
}

function crossrefHostName(url: string, publisher: string | undefined): string | undefined {
  if (publisher) return publisher;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

export function crossrefAccessLocations(
  work: CrossrefWork,
  doi = normalizeDoi(nonEmptyString(work.DOI)),
): AccessLocation[] {
  const licenses = normalizedLicenses(work.license);
  const publisher = cleanCrossrefText(work.publisher);
  const candidates: unknown[] = [];

  for (const link of linkCandidates(work.link)) {
    const url = httpUrl(link.URL);
    if (!url) continue;

    const version = nonEmptyString(link["content-version"]) ?? null;
    const license = licenseForVersion(licenses, version);
    const hostName = crossrefHostName(url, publisher);
    candidates.push({
      url,
      kind: isPdfLink(link, url) ? "pdf" : "landing-page",
      source: "crossref",
      isOpenAccess: license?.recognized === true,
      license: license?.url ?? null,
      version: version ?? license?.version ?? null,
      hostType: "publisher",
      ...(hostName ? { hostName } : {}),
    });
  }

  const generalLicense = licenseForVersion(licenses, null);
  const generalUrls = [
    httpUrl(work.resource?.primary?.URL),
    httpUrl(work.URL),
    doi ? `https://doi.org/${doi}` : undefined,
  ];
  for (const url of generalUrls) {
    if (!url) continue;

    const hostName = crossrefHostName(url, publisher);
    candidates.push({
      url,
      kind: inferAccessKind(url),
      source: "crossref",
      isOpenAccess: generalLicense?.recognized === true,
      license: generalLicense?.url ?? null,
      version: generalLicense?.version ?? null,
      hostType: "publisher",
      ...(hostName ? { hostName } : {}),
    });
  }

  return augmentTrustedOpenAccessLocations(deduplicateAccessLocations(candidates));
}

function fallbackId(work: CrossrefWork, title: string, year: number | null, authorNames: string[]): string {
  const sourceUrl = httpUrl(work.URL) ?? httpUrl(work.resource?.primary?.URL);
  if (sourceUrl) {
    return `url:${sourceUrl}`;
  }

  const signature = [title, year ?? "", authorNames[0] ?? ""]
    .join("|")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, "-");
  return `metadata:${signature}`;
}

export function mapCrossrefWork(work: CrossrefWork): Paper {
  const doi = normalizeDoi(nonEmptyString(work.DOI));
  const title = cleanCrossrefText(firstListValue(work.title)) ?? "Untitled work";
  const authorNames = authors(work.author);
  const year = publicationYear(work);
  const abstract = cleanCrossrefText(work.abstract);
  const accessLocations = crossrefAccessLocations(work, doi);
  const oaUrl = preferredOpenAccessUrl(accessLocations);
  const citationCount = work["is-referenced-by-count"];

  return {
    id: doi ?? fallbackId(work, title, year, authorNames),
    title,
    authors: authorNames,
    year,
    venue:
      cleanCrossrefText(firstListValue(work["container-title"])) ??
      cleanCrossrefText(firstListValue(work["short-container-title"])) ??
      cleanCrossrefText(work.publisher) ??
      "",
    ...(abstract ? { abstract } : {}),
    ...(doi ? { doi } : {}),
    citedByCount:
      typeof citationCount === "number" && Number.isFinite(citationCount) && citationCount >= 0
        ? Math.trunc(citationCount)
        : 0,
    isOpenAccess: accessLocations.some((location) => location.isOpenAccess),
    ...(nonEmptyString(work.subtype) ?? nonEmptyString(work.type)
      ? { publicationType: nonEmptyString(work.subtype) ?? nonEmptyString(work.type) }
      : {}),
    ...(typeof work.score === "number" && Number.isFinite(work.score)
      ? { searchScore: work.score }
      : {}),
    ...(oaUrl ? { openAccessUrl: oaUrl } : {}),
    ...(accessLocations.length > 0 ? { accessLocations } : {}),
    source: "crossref",
  };
}

function assertSearchResponse(value: unknown): asserts value is CrossrefSearchResponse {
  const response = value as Partial<CrossrefSearchResponse> | null;
  const message = response?.message as CrossrefSearchResponse["message"] | undefined;

  if (
    typeof value !== "object" ||
    value === null ||
    (response?.status !== undefined && response?.status !== "ok") ||
    typeof message !== "object" ||
    message === null ||
    !Array.isArray(message.items) ||
    message.items.some((item) => typeof item !== "object" || item === null)
  ) {
    throw new CrossrefSearchError(
      "Crossref 返回的数据格式发生变化，请稍后重试或更新应用。",
      "invalid-response",
    );
  }
}

function httpError(status: number): CrossrefSearchError {
  if (status === 429) {
    return new CrossrefSearchError("Crossref 请求过于频繁，请稍后重试。", "rate-limited", {
      status,
    });
  }
  if (status === 401 || status === 403) {
    return new CrossrefSearchError(
      "Crossref 拒绝了搜索请求，请检查 API 访问配置。",
      "unauthorized",
      { status },
    );
  }

  return new CrossrefSearchError(`Crossref 搜索暂时不可用（HTTP ${status}）。`, "upstream", {
    status,
  });
}

/** Search Crossref and map its source-specific metadata into the PaperLens model. */
export async function searchCrossrefPage(
  query: string,
  options: CrossrefSearchOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<CrossrefSearchPage> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new CrossrefSearchError("请输入论文关键词、标题或 DOI。", "invalid-query");
  }

  const url = new URL(CROSSREF_WORKS_ENDPOINT);
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const perPage = Math.min(100, Math.max(1, Math.floor(options.perPage ?? RESULT_LIMIT)));
  if (!options.doi) url.searchParams.set("query.bibliographic", normalizedQuery);
  const filters = [
    options.doi ? `doi:${options.doi}` : undefined,
    options.recentSinceYear ? `from-pub-date:${options.recentSinceYear}-01-01` : undefined,
  ].filter((value): value is string => Boolean(value));
  if (filters.length > 0) url.searchParams.set("filter", filters.join(","));
  url.searchParams.set("rows", String(perPage));
  url.searchParams.set("offset", String((page - 1) * perPage));

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new CrossrefSearchError("无法连接 Crossref，请检查网络后重试。", "network", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw httpError(response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new CrossrefSearchError(
      "Crossref 返回了无法解析的数据，请稍后重试。",
      "invalid-response",
      { cause: error },
    );
  }

  assertSearchResponse(payload);
  const rawTotal = payload.message["total-results"];
  const total = typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : null;
  return {
    papers: payload.message.items.map(mapCrossrefWork),
    hasMore: total === null
      ? payload.message.items.length === perPage
      : page * perPage < total,
    total,
  };
}

export async function searchCrossref(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Paper[]> {
  return (await searchCrossrefPage(query, {}, fetchImpl)).papers;
}
