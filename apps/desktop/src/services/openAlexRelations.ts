import { deduplicatePapers } from "../domain/deduplicatePapers";
import { normalizeDoi } from "../domain/doi";
import type { Paper } from "../domain/paper";
import type {
  PaperRelationKind,
  PaperRelations,
} from "../domain/paperRelations";
import { mapOpenAlexWork, type OpenAlexWork } from "./openAlex";

const OPENALEX_WORKS_ENDPOINT = "https://api.openalex.org/works";
const DEFAULT_RELATION_LIMIT = 25;
const MAX_BATCH_SIZE = 100;
const PAPER_FIELDS = [
  "id",
  "doi",
  "display_name",
  "publication_year",
  "primary_location",
  "best_oa_location",
  "open_access",
  "authorships",
  "cited_by_count",
  "abstract_inverted_index",
] as const;

type OpenAlexRelationTarget = OpenAlexWork & {
  id: string;
};

type OpenAlexWorksResponse = {
  results: OpenAlexWork[];
};

export type OpenAlexWorkIdentity =
  | string
  | Pick<Paper, "id" | "doi" | "source">;

export type OpenAlexRelationLimits = Partial<
  Record<PaperRelationKind, number>
>;

export type OpenAlexRelationsOptions = {
  fetchImpl?: typeof fetch;
  limits?: OpenAlexRelationLimits;
};

export type OpenAlexRelationsErrorCode =
  | "invalid-identifier"
  | "network"
  | "not-found"
  | "rate-limited"
  | "unauthorized"
  | "upstream"
  | "invalid-response";

export class OpenAlexRelationsError extends Error {
  readonly code: OpenAlexRelationsErrorCode;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    message: string,
    code: OpenAlexRelationsErrorCode,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message);
    this.name = "OpenAlexRelationsError";
    this.code = code;
    this.status = options?.status;
    this.cause = options?.cause;
  }
}

function openAlexWorkId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().match(
    /^(?:https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?|openalex:)?(W\d+)\/?$/i,
  )?.[1];
  return normalized ? normalized.toUpperCase() : undefined;
}

function workLookupValue(identity: OpenAlexWorkIdentity): string {
  const rawId = typeof identity === "string" ? identity : identity.id;
  const id = openAlexWorkId(rawId);
  if (id) {
    return id;
  }

  const doi = normalizeDoi(
    typeof identity === "string" ? identity : identity.doi,
  );
  if (doi) {
    return `https://doi.org/${doi}`;
  }

  throw new OpenAlexRelationsError(
    "无法识别这篇论文，请提供 OpenAlex 论文 ID 或有效 DOI。",
    "invalid-identifier",
  );
}

function limitFor(
  relation: PaperRelationKind,
  limits: OpenAlexRelationLimits | undefined,
): number {
  const requested = limits?.[relation];
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_RELATION_LIMIT;
  }

  return Math.min(MAX_BATCH_SIZE, Math.max(0, Math.trunc(requested)));
}

function paperSelect(includeRelations = false): string {
  return [
    ...PAPER_FIELDS,
    ...(includeRelations ? ["referenced_works", "related_works"] : []),
  ].join(",");
}

function targetUrl(lookupValue: string): URL {
  const url = new URL(`${OPENALEX_WORKS_ENDPOINT}/${lookupValue}`);
  url.searchParams.set("select", paperSelect(true));
  return url;
}

function listUrl(filter: string, limit: number): URL {
  const url = new URL(OPENALEX_WORKS_ENDPOINT);
  url.searchParams.set("filter", filter);
  url.searchParams.set("per_page", String(limit));
  url.searchParams.set("select", paperSelect());
  return url;
}

function httpError(status: number): OpenAlexRelationsError {
  if (status === 404) {
    return new OpenAlexRelationsError(
      "OpenAlex 中没有找到这篇论文，请检查论文 ID 或 DOI。",
      "not-found",
      { status },
    );
  }
  if (status === 429) {
    return new OpenAlexRelationsError(
      "OpenAlex 请求过于频繁，请稍后再加载论文关系。",
      "rate-limited",
      { status },
    );
  }
  if (status === 401 || status === 403) {
    return new OpenAlexRelationsError(
      "OpenAlex 拒绝了论文关系请求，请检查 API 访问配置。",
      "unauthorized",
      { status },
    );
  }

  return new OpenAlexRelationsError(
    `OpenAlex 论文关系服务暂时不可用（HTTP ${status}）。`,
    "upstream",
    { status },
  );
}

async function requestJson(
  url: URL,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new OpenAlexRelationsError(
      "无法连接 OpenAlex，请检查网络后重试。",
      "network",
      { cause: error },
    );
  }

  if (!response.ok) {
    throw httpError(response.status);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new OpenAlexRelationsError(
      "OpenAlex 返回了无法解析的数据，请稍后重试。",
      "invalid-response",
      { cause: error },
    );
  }
}

function assertTarget(value: unknown): asserts value is OpenAlexRelationTarget {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    !openAlexWorkId((value as OpenAlexWork).id)
  ) {
    throw new OpenAlexRelationsError(
      "OpenAlex 返回的目标论文数据格式发生变化，请稍后重试或更新应用。",
      "invalid-response",
    );
  }
}

function assertWorksResponse(
  value: unknown,
): asserts value is OpenAlexWorksResponse {
  const response = value as Partial<OpenAlexWorksResponse> | null;
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(response?.results) ||
    response.results.some((work) => typeof work !== "object" || work === null)
  ) {
    throw new OpenAlexRelationsError(
      "OpenAlex 返回的论文关系数据格式发生变化，请稍后重试或更新应用。",
      "invalid-response",
    );
  }
}

function uniqueWorkIds(values: unknown, limit: number): string[] {
  if (!Array.isArray(values) || limit === 0) {
    return [];
  }

  return [
    ...new Set(
      values.flatMap((value) => {
        const id = typeof value === "string" ? openAlexWorkId(value) : undefined;
        return id ? [id] : [];
      }),
    ),
  ].slice(0, limit);
}

function relationLabel(relation: PaperRelationKind): string {
  switch (relation) {
    case "references":
      return "参考文献";
    case "citedBy":
      return "被引论文";
    case "recommendations":
      return "相关推荐";
  }
}

function readableRelationWarning(
  relation: PaperRelationKind,
  reason: unknown,
): string {
  const detail = reason instanceof Error ? reason.message : "未知错误";
  return `${relationLabel(relation)}暂时无法加载：${detail}`;
}

function finalizePapers(
  works: OpenAlexWork[],
  targetId: string,
  preferredOrder?: readonly string[],
): Paper[] {
  const papers = deduplicatePapers(works.map(mapOpenAlexWork)).filter(
    (paper) => openAlexWorkId(paper.id) !== targetId,
  );
  if (!preferredOrder) {
    return papers;
  }

  const order = new Map(preferredOrder.map((id, index) => [id, index]));
  return papers.sort(
    (left, right) =>
      (order.get(openAlexWorkId(left.id) ?? "") ?? Number.MAX_SAFE_INTEGER) -
      (order.get(openAlexWorkId(right.id) ?? "") ?? Number.MAX_SAFE_INTEGER),
  );
}

async function fetchByIds(
  ids: readonly string[],
  targetId: string,
  fetchImpl: typeof fetch,
): Promise<Paper[]> {
  if (ids.length === 0) {
    return [];
  }

  const payload = await requestJson(
    listUrl(`openalex:${ids.join("|")}`, ids.length),
    fetchImpl,
  );
  assertWorksResponse(payload);
  return finalizePapers(payload.results, targetId, ids);
}

async function fetchCitingWorks(
  targetId: string,
  limit: number,
  fetchImpl: typeof fetch,
): Promise<Paper[]> {
  if (limit === 0) {
    return [];
  }

  const payload = await requestJson(
    listUrl(`cites:${targetId}`, limit),
    fetchImpl,
  );
  assertWorksResponse(payload);
  return finalizePapers(payload.results, targetId);
}

/**
 * Load the target's outgoing citations, incoming citations, and OpenAlex
 * similarity recommendations. Independent relation failures are returned as
 * warnings so one unavailable list does not blank the entire neighborhood.
 */
export async function getOpenAlexPaperRelations(
  identity: OpenAlexWorkIdentity,
  options: OpenAlexRelationsOptions = {},
): Promise<PaperRelations> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupValue = workLookupValue(identity);
  const targetPayload = await requestJson(targetUrl(lookupValue), fetchImpl);
  assertTarget(targetPayload);

  const target = mapOpenAlexWork(targetPayload);
  const targetId = openAlexWorkId(targetPayload.id);
  if (!targetId) {
    throw new OpenAlexRelationsError(
      "OpenAlex 返回的目标论文缺少有效 ID。",
      "invalid-response",
    );
  }

  const referenceIds = uniqueWorkIds(
    targetPayload.referenced_works,
    limitFor("references", options.limits),
  ).filter((id) => id !== targetId);
  const recommendationIds = uniqueWorkIds(
    targetPayload.related_works,
    limitFor("recommendations", options.limits),
  ).filter((id) => id !== targetId);

  const requests: Array<{
    relation: PaperRelationKind;
    request: Promise<Paper[]>;
  }> = [
    {
      relation: "references",
      request: fetchByIds(referenceIds, targetId, fetchImpl),
    },
    {
      relation: "citedBy",
      request: fetchCitingWorks(
        targetId,
        limitFor("citedBy", options.limits),
        fetchImpl,
      ),
    },
    {
      relation: "recommendations",
      request: fetchByIds(recommendationIds, targetId, fetchImpl),
    },
  ];
  const settled = await Promise.allSettled(requests.map(({ request }) => request));

  const relations: Record<PaperRelationKind, Paper[]> = {
    references: [],
    citedBy: [],
    recommendations: [],
  };
  const warnings: PaperRelations["warnings"] = [];

  settled.forEach((result, index) => {
    const relation = requests[index].relation;
    if (result.status === "fulfilled") {
      relations[relation] = result.value;
      return;
    }

    warnings.push({
      relation,
      message: readableRelationWarning(relation, result.reason),
    });
  });

  return {
    target,
    references: relations.references,
    citedBy: relations.citedBy,
    recommendations: relations.recommendations,
    warnings,
  };
}
