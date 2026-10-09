import { normalizeDoi } from "../domain/doi";
import {
  augmentTrustedOpenAccessLocations,
  deduplicateAccessLocations,
  inferAccessKind,
  preferredOpenAccessUrl,
  type AccessLocation,
} from "../domain/access";
import type { Paper } from "../domain/paper";

const OPENALEX_WORKS_ENDPOINT = "https://api.openalex.org/works";
const RESULT_LIMIT = 50;

type OpenAlexLocation = {
  is_oa?: boolean | null;
  landing_page_url?: unknown;
  pdf_url?: unknown;
  license?: unknown;
  version?: unknown;
  source?: {
    display_name?: string | null;
    type?: string | null;
    host_organization_name?: string | null;
  } | null;
};

export type OpenAlexWork = {
  id?: string | null;
  doi?: string | null;
  display_name?: string | null;
  title?: string | null;
  publication_year?: number | null;
  primary_location?: OpenAlexLocation | null;
  best_oa_location?: OpenAlexLocation | null;
  locations?: unknown;
  host_venue?: {
    display_name?: string | null;
  } | null;
  authorships?: Array<{
    author?: {
      display_name?: string | null;
    } | null;
  }> | null;
  cited_by_count?: number | null;
  open_access?: {
    is_oa?: boolean | null;
    oa_url?: string | null;
  } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  referenced_works?: Array<string | null> | null;
  related_works?: Array<string | null> | null;
  relevance_score?: number | null;
  type?: string | null;
  is_retracted?: boolean | null;
};

type OpenAlexSearchResponse = {
  results: OpenAlexWork[];
  meta?: {
    count?: number | null;
    page?: number | null;
    per_page?: number | null;
  } | null;
};

export type OpenAlexSearchMode = "lexical" | "exact" | "semantic";

export type OpenAlexSearchOptions = {
  signal?: AbortSignal;
  page?: number;
  perPage?: number;
  mode?: OpenAlexSearchMode;
  doi?: string;
  recentSinceYear?: number;
  openAccessOnly?: boolean;
};

export type OpenAlexSearchPage = {
  papers: Paper[];
  hasMore: boolean;
  total: number | null;
};

export type OpenAlexSearchErrorCode =
  | "invalid-query"
  | "network"
  | "rate-limited"
  | "unauthorized"
  | "upstream"
  | "invalid-response";

export class OpenAlexSearchError extends Error {
  readonly code: OpenAlexSearchErrorCode;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    message: string,
    code: OpenAlexSearchErrorCode,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message);
    this.name = "OpenAlexSearchError";
    this.code = code;
    this.status = options?.status;
    this.cause = options?.cause;
  }
}

export function reconstructOpenAlexAbstract(
  invertedIndex: Record<string, number[]> | null | undefined,
): string | undefined {
  if (!invertedIndex) {
    return undefined;
  }

  const wordsByPosition: Array<string | undefined> = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const position of positions) {
      if (Number.isSafeInteger(position) && position >= 0) {
        wordsByPosition[position] = word;
      }
    }
  }

  const abstract = wordsByPosition.filter((word): word is string => Boolean(word)).join(" ");
  return abstract || undefined;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value): value is string => Boolean(value?.trim()))?.trim();
}

function openAlexId(value: string | null | undefined): string | undefined {
  const segments = value?.trim().split("/").filter(Boolean);
  const id = segments?.[segments.length - 1];
  return id || undefined;
}

function fallbackId(work: OpenAlexWork, title: string, doi: string | undefined): string {
  if (doi) {
    return `doi:${doi}`;
  }

  const signature = [title, work.publication_year ?? "", work.authorships?.[0]?.author?.display_name ?? ""]
    .join("|")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, "-");
  return `metadata:${signature}`;
}

function openAlexLocationCandidates(value: unknown): OpenAlexLocation[] {
  return Array.isArray(value)
    ? value.filter(
        (location): location is OpenAlexLocation =>
          typeof location === "object" && location !== null,
      )
    : [];
}

function mapOpenAlexLocation(
  location: OpenAlexLocation | null | undefined,
  forceOpenAccess = false,
): unknown[] {
  if (!location) return [];

  const isOpenAccess =
    location.is_oa === true || (forceOpenAccess && location.is_oa !== false);
  const license = firstNonEmpty(
    typeof location.license === "string" ? location.license : undefined,
  ) ?? null;
  const version = firstNonEmpty(
    typeof location.version === "string" ? location.version : undefined,
  ) ?? null;
  const hostType = firstNonEmpty(location.source?.type);
  const hostName = firstNonEmpty(
    location.source?.display_name,
    location.source?.host_organization_name,
  );
  const shared = {
    source: "openalex" as const,
    isOpenAccess,
    license,
    version,
    ...(hostType ? { hostType } : {}),
    ...(hostName ? { hostName } : {}),
  };

  return [
    {
      ...shared,
      url: location.pdf_url,
      kind: "pdf" as const,
    },
    {
      ...shared,
      url: location.landing_page_url,
      kind: "landing-page" as const,
    },
  ];
}

export function openAlexAccessLocations(work: OpenAlexWork): AccessLocation[] {
  const candidates: unknown[] = [
    ...mapOpenAlexLocation(work.best_oa_location, true),
    ...mapOpenAlexLocation(work.primary_location),
    ...openAlexLocationCandidates(work.locations).flatMap((location) =>
      mapOpenAlexLocation(location),
    ),
  ];

  if (work.open_access?.is_oa === true && work.open_access.oa_url) {
    candidates.push({
      url: work.open_access.oa_url,
      kind: inferAccessKind(work.open_access.oa_url),
      source: "openalex",
      isOpenAccess: true,
      license: null,
      version: null,
    });
  }

  return augmentTrustedOpenAccessLocations(deduplicateAccessLocations(candidates));
}

export function mapOpenAlexWork(work: OpenAlexWork): Paper {
  const title = firstNonEmpty(work.display_name, work.title) ?? "Untitled work";
  const doi = normalizeDoi(work.doi);
  const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index);
  const accessLocations = openAlexAccessLocations(work);
  const openAccessUrl = preferredOpenAccessUrl(accessLocations);

  return {
    id: openAlexId(work.id) ?? fallbackId(work, title, doi),
    title,
    authors:
      work.authorships
        ?.map((authorship) => authorship.author?.display_name?.trim())
        .filter((author): author is string => Boolean(author)) ?? [],
    year:
      typeof work.publication_year === "number" && Number.isSafeInteger(work.publication_year)
        ? work.publication_year
        : null,
    venue:
      firstNonEmpty(
        work.primary_location?.source?.display_name,
        work.host_venue?.display_name,
        openAlexLocationCandidates(work.locations).find(
          (location) => location.source?.display_name,
        )?.source?.display_name,
      ) ?? "",
    ...(abstract ? { abstract } : {}),
    ...(doi ? { doi } : {}),
    citedByCount:
      typeof work.cited_by_count === "number" && work.cited_by_count >= 0
        ? work.cited_by_count
        : 0,
    isOpenAccess: Boolean(
      work.open_access?.is_oa || accessLocations.some((location) => location.isOpenAccess),
    ),
    ...(firstNonEmpty(work.type) ? { publicationType: firstNonEmpty(work.type) } : {}),
    ...(work.is_retracted === true ? { isRetracted: true } : {}),
    ...(typeof work.relevance_score === "number" && Number.isFinite(work.relevance_score)
      ? { searchScore: work.relevance_score }
      : {}),
    ...(openAccessUrl ? { openAccessUrl } : {}),
    ...(accessLocations.length > 0 ? { accessLocations } : {}),
    source: "openalex",
  };
}

function assertSearchResponse(value: unknown): asserts value is OpenAlexSearchResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("results" in value) ||
    !Array.isArray((value as OpenAlexSearchResponse).results)
  ) {
    throw new OpenAlexSearchError(
      "OpenAlex 返回的数据格式发生变化，请稍后重试或更新应用。",
      "invalid-response",
    );
  }
}

function httpError(status: number): OpenAlexSearchError {
  if (status === 429) {
    return new OpenAlexSearchError("OpenAlex 请求过于频繁，请稍后重试。", "rate-limited", {
      status,
    });
  }
  if (status === 401 || status === 403) {
    return new OpenAlexSearchError(
      "OpenAlex 拒绝了搜索请求，请检查 API 访问配置。",
      "unauthorized",
      { status },
    );
  }

  return new OpenAlexSearchError(`OpenAlex 搜索暂时不可用（HTTP ${status}）。`, "upstream", {
    status,
  });
}

export async function searchOpenAlexPage(
  query: string,
  options: OpenAlexSearchOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<OpenAlexSearchPage> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new OpenAlexSearchError("请输入论文关键词、标题或 DOI。", "invalid-query");
  }

  const url = new URL(OPENALEX_WORKS_ENDPOINT);
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const perPage = Math.min(100, Math.max(1, Math.floor(options.perPage ?? RESULT_LIMIT)));
  const mode = options.mode ?? "lexical";
  if (!options.doi) {
    url.searchParams.set(
      mode === "semantic" ? "search.semantic" : mode === "exact" ? "search.exact" : "search",
      normalizedQuery,
    );
  }
  const filters = [
    options.doi ? `doi:${options.doi}` : undefined,
    options.recentSinceYear ? `publication_year:>${options.recentSinceYear - 1}` : undefined,
    options.openAccessOnly ? "open_access.is_oa:true" : undefined,
  ].filter((value): value is string => Boolean(value));
  if (filters.length > 0) url.searchParams.set("filter", filters.join(","));
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set(
    "select",
    [
      "id",
      "doi",
      "display_name",
      "publication_year",
      "primary_location",
      "best_oa_location",
      "locations",
      "open_access",
      "authorships",
      "cited_by_count",
      "abstract_inverted_index",
      "relevance_score",
      "type",
      "is_retracted",
    ].join(","),
  );

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new OpenAlexSearchError("无法连接 OpenAlex，请检查网络后重试。", "network", {
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
    throw new OpenAlexSearchError(
      "OpenAlex 返回了无法解析的数据，请稍后重试。",
      "invalid-response",
      { cause: error },
    );
  }

  assertSearchResponse(payload);
  const total = typeof payload.meta?.count === "number" ? payload.meta.count : null;
  return {
    papers: payload.results.map(mapOpenAlexWork),
    hasMore: total === null ? payload.results.length === perPage : page * perPage < total,
    total,
  };
}

export async function searchOpenAlex(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Paper[]> {
  return (await searchOpenAlexPage(query, {}, fetchImpl)).papers;
}
