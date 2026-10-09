import { deduplicatePapers } from "../domain/deduplicatePapers";
import { normalizeDoi } from "../domain/doi";
import type { Paper, PaperMatchReason } from "../domain/paper";
import { analyzeSearchQuery, type SearchQueryPlan } from "../domain/searchQuery";
import { searchArxivPage, type ArxivSearchOptions, type ArxivSearchPage } from "./arxiv";
import {
  searchCrossrefPage,
  type CrossrefSearchOptions,
  type CrossrefSearchPage,
} from "./crossref";
import {
  searchOpenAlexPage,
  type OpenAlexSearchOptions,
  type OpenAlexSearchPage,
} from "./openAlex";

export type AcademicSearchSource = "openalex" | "crossref" | "arxiv";

export type AcademicSearchFilters = {
  recent?: boolean;
  openAccess?: boolean;
};

export type AcademicSearchRequest = {
  page?: number;
  filters?: AcademicSearchFilters;
  referenceYear?: number;
  signal?: AbortSignal;
  onProgress?: (progress: AcademicSearchProgress) => void;
};

export type AcademicSearchResult = {
  papers: Paper[];
  sources: AcademicSearchSource[];
  warnings: string[];
  page: number;
  hasMore: boolean;
  interpretation?: string;
};

export type AcademicSearchProgress = AcademicSearchResult & {
  completed: number;
  total: number;
  pendingSources: AcademicSearchSource[];
};

export type AcademicSearchProviders = {
  arxiv?: (query: string, options?: ArxivSearchOptions) => Promise<ArxivSearchPage>;
  openalex: (query: string, options?: OpenAlexSearchOptions) => Promise<OpenAlexSearchPage>;
  crossref: (query: string, options?: CrossrefSearchOptions) => Promise<CrossrefSearchPage>;
};

const defaultProviders: AcademicSearchProviders = {
  arxiv: searchArxivPage,
  openalex: searchOpenAlexPage,
  crossref: searchCrossrefPage,
};

const PROVIDER_TIMEOUT_MS = 12_000;

export class AcademicSearchError extends Error {
  readonly causes: unknown[];

  constructor(message: string, causes: unknown[] = []) {
    super(message);
    this.name = "AcademicSearchError";
    this.causes = causes;
  }
}

const sourceLabels = { openalex: "OpenAlex", crossref: "Crossref", arxiv: "arXiv（DataCite）" };

function readableProviderError(source: AcademicSearchSource, reason: unknown) {
  const label = sourceLabels[source];
  const detail = reason instanceof Error ? reason.message : "未知错误";
  return label + " 暂时不可用：" + detail;
}

function searchAbortError() {
  return new DOMException("搜索已停止", "AbortError");
}

function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  source: AcademicSearchSource,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (parentSignal?.aborted) return Promise.reject(searchAbortError());
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const label = sourceLabels[source];
    let finished = false;
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => {
      finish(() => reject(searchAbortError()));
      controller.abort();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(label + " 响应超时")));
      controller.abort();
    }, PROVIDER_TIMEOUT_MS);
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    // The wrapper settles even when a provider ignores AbortSignal. The real
    // fetch receives the same signal, so timeout/cancel also releases the socket.
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw searchAbortError();
      return run(controller.signal);
    }).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "for", "in", "is", "of", "on", "the", "to", "using", "with",
]);

const NON_PAPER_PUBLICATION_TYPES = new Set([
  "component",
  "dataset",
  "journal-issue",
  "peer-review",
  "proceedings",
  "reference-entry",
]);

function isReaderRelevantPaper(paper: Paper): boolean {
  const publicationType = paper.publicationType?.toLocaleLowerCase("en");
  if (publicationType && NON_PAPER_PUBLICATION_TYPES.has(publicationType)) return false;

  // Crossref also indexes individual figures, tables and open peer-review reports.
  // They can rank highly because they inherit the parent work's words and DOI family.
  const title = paper.title.trim();
  return !/^(?:figure|table)\s+\d+\b|^review\s+for\s+[\u201c\u201d"']/iu.test(title);
}

function searchTokens(plan: SearchQueryPlan): string[] {
  return [...new Set(
    plan.lexicalQueries
      .flatMap((query) => normalizeSearchText(query).split(" "))
      .filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token)),
  )];
}

function inferMatchReasons(
  paper: Paper,
  plan: SearchQueryPlan,
  mode: "lexical" | "exact" | "semantic" | "bibliographic",
): PaperMatchReason[] {
  const reasons: PaperMatchReason[] = [];
  if (plan.doi && normalizeDoi(paper.doi) === plan.doi) reasons.push("exact-identifier");

  const title = normalizeSearchText(paper.title);
  const exactTitle = plan.exactTitleQuery && normalizeSearchText(plan.exactTitleQuery);
  if (exactTitle && title === exactTitle) reasons.push("exact-title");

  const tokens = searchTokens(plan);
  const titleHits = tokens.filter((token) => title.includes(token)).length;
  if (titleHits > 0 && !reasons.includes("exact-title")) reasons.push("title");

  const abstract = normalizeSearchText(paper.abstract ?? "");
  if (tokens.some((token) => abstract.includes(token))) reasons.push("abstract");
  if (mode === "semantic") reasons.push("semantic");
  if (mode === "bibliographic" && reasons.length === 0) reasons.push("bibliographic");
  return [...new Set(reasons)];
}

function scorePaper(paper: Paper, plan: SearchQueryPlan): number {
  let score = paper.searchScore ?? 0;
  const normalizedTitle = normalizeSearchText(paper.title);
  const exactTitle = plan.exactTitleQuery && normalizeSearchText(plan.exactTitleQuery);
  if (plan.doi && normalizeDoi(paper.doi) === plan.doi) score += 2_000;
  if (exactTitle && normalizedTitle === exactTitle) score += 1_000;

  const tokens = searchTokens(plan);
  if (tokens.length > 0) {
    const titleHits = tokens.filter((token) => normalizedTitle.includes(token)).length;
    score += (titleHits / tokens.length) * 120;
  }
  score += Math.log10(paper.citedByCount + 1) * 4;
  if (paper.isRetracted) score -= 5_000;
  return score;
}

type SearchTask = {
  source: AcademicSearchSource;
  mode: "lexical" | "exact" | "semantic" | "bibliographic";
  contributesPagination: boolean;
  promise: Promise<OpenAlexSearchPage | CrossrefSearchPage>;
};

function annotatedPapers(
  papers: readonly Paper[],
  task: Pick<SearchTask, "source" | "mode">,
  plan: SearchQueryPlan,
): Paper[] {
  const base = task.mode === "exact"
    ? 260
    : task.mode === "semantic"
      ? 180
      : task.source === "openalex"
        ? 150
        : 95;

  return papers.map((paper, index) => ({
    ...paper,
    searchScore: base + Math.max(0, 60 - index) + Math.log10((paper.searchScore ?? 0) + 1),
    matchReasons: inferMatchReasons(paper, plan, task.mode),
  }));
}

type SearchSettlement = PromiseSettledResult<OpenAlexSearchPage | CrossrefSearchPage>;

function searchSnapshot(
  tasks: SearchTask[],
  settled: Array<SearchSettlement | undefined>,
  plan: SearchQueryPlan,
  page: number,
): AcademicSearchProgress {
  const papers: Paper[] = [];
  const successfulSources = new Set<AcademicSearchSource>();
  const failedBySource = new Map<AcademicSearchSource, unknown[]>();
  const pendingSources = new Set<AcademicSearchSource>();
  let hasMore = false;
  let completed = 0;
  // Aggregate in task order, not response order, for deterministic ranking.
  tasks.forEach((task, index) => {
    const result = settled[index];
    if (!result) {
      pendingSources.add(task.source);
      return;
    }
    completed += 1;
    if (result.status === "fulfilled") {
      successfulSources.add(task.source);
      papers.push(...annotatedPapers(result.value.papers, task, plan));
      if (task.contributesPagination) hasMore ||= result.value.hasMore;
    } else {
      failedBySource.set(task.source, [...(failedBySource.get(task.source) ?? []), result.reason]);
    }
  });
  const warnings = [...failedBySource.entries()].flatMap(([source, reasons]) => {
    if (pendingSources.has(source)) return [];
    const message = readableProviderError(source, reasons[0]);
    return [successfulSources.has(source)
      ? message.replace("暂时不可用", "部分检索未完成")
      : message];
  });
  const ranked = deduplicatePapers(papers.filter(isReaderRelevantPaper))
    .map((paper) => ({ ...paper, searchScore: scorePaper(paper, plan) }))
    .sort((left, right) => (right.searchScore ?? 0) - (left.searchScore ?? 0));
  return {
    papers: ranked,
    sources: [...successfulSources], warnings, page, hasMore,
    completed, total: tasks.length, pendingSources: [...pendingSources],
    ...(plan.interpretation ? { interpretation: plan.interpretation } : {}),
  };
}

/** Hybrid retrieval across identifiers, lexical indexes and semantic candidates. */
export async function searchPapers(
  query: string,
  request: AcademicSearchRequest = {},
  providers: AcademicSearchProviders = defaultProviders,
): Promise<AcademicSearchResult> {
  if (request.signal?.aborted) throw searchAbortError();
  const plan = analyzeSearchQuery(query);
  if (!plan.rawQuery) {
    throw new AcademicSearchError("请输入论文关键词、标题或 DOI。");
  }

  const page = Math.max(1, Math.floor(request.page ?? 1));
  const referenceYear = request.referenceYear ?? new Date().getFullYear();
  const recentSinceYear = request.filters?.recent ? referenceYear - 4 : undefined;
  const common = { page, recentSinceYear };
  const tasks: SearchTask[] = [];
  const openalex = (value: string, options: OpenAlexSearchOptions) => withTimeout(
    (signal) => providers.openalex(value, { ...options, signal }), "openalex", request.signal,
  );
  const crossref = (value: string, options: CrossrefSearchOptions) => withTimeout(
    (signal) => providers.crossref(value, { ...options, signal }), "crossref", request.signal,
  );

  const arxivProvider = providers.arxiv;
  if (arxivProvider && (!plan.doi || plan.intent === "arxiv")) {
    tasks.push({
      source: "arxiv", mode: plan.exactTitleQuery ? "exact" : "lexical",
      contributesPagination: !plan.doi,
      promise: withTimeout((signal) => arxivProvider(
        plan.doi ?? plan.exactTitleQuery ?? plan.lexicalQueries[plan.lexicalQueries.length - 1],
        { ...common, doi: plan.doi, exactTitle: Boolean(plan.exactTitleQuery), signal },
      ), "arxiv", request.signal),
    });
  }

  if (plan.doi) {
    tasks.push({
      source: "openalex",
      mode: "lexical",
      contributesPagination: false,
      promise: openalex(plan.doi, {
        ...common,
        doi: plan.doi,
        openAccessOnly: request.filters?.openAccess,
        perPage: 10,
      }),
    });
    tasks.push({
      source: "crossref",
      mode: "bibliographic",
      contributesPagination: false,
      promise: crossref(plan.doi, { ...common, doi: plan.doi, perPage: 10 }),
    });
  } else {
    for (const lexicalQuery of plan.lexicalQueries) {
      tasks.push({
        source: "openalex",
        mode: "lexical",
        contributesPagination: true,
        promise: openalex(lexicalQuery, {
          ...common,
          mode: "lexical",
          openAccessOnly: request.filters?.openAccess,
        }),
      });
    }

    if (page === 1 && plan.exactTitleQuery) {
      tasks.push({
        source: "openalex",
        mode: "exact",
        contributesPagination: false,
        promise: openalex(plan.exactTitleQuery, {
          page: 1,
          perPage: 50,
          mode: "exact",
          recentSinceYear,
          openAccessOnly: request.filters?.openAccess,
        }),
      });
    }

    if (page === 1 && plan.semanticQuery) {
      tasks.push({
        source: "openalex",
        mode: "semantic",
        contributesPagination: false,
        promise: openalex(plan.semanticQuery, {
          page: 1,
          perPage: 35,
          mode: "semantic",
          recentSinceYear,
          openAccessOnly: request.filters?.openAccess,
        }),
      });
    }

    const crossrefQuery = plan.lexicalQueries[plan.lexicalQueries.length - 1] ?? plan.rawQuery;
    tasks.push({
      source: "crossref",
      mode: "bibliographic",
      contributesPagination: true,
      promise: crossref(crossrefQuery, { ...common }),
    });
  }

  const settled: Array<SearchSettlement | undefined> = tasks.map(() => undefined);
  await Promise.all(tasks.map(async (task, index) => {
    try {
      settled[index] = { status: "fulfilled", value: await task.promise };
    } catch (reason) {
      settled[index] = { status: "rejected", reason };
    }
    if (!request.signal?.aborted) {
      request.onProgress?.(searchSnapshot(tasks, settled, plan, page));
    }
  }));
  if (request.signal?.aborted) throw searchAbortError();
  const { completed: _completed, total: _total, pendingSources: _pending, ...result } =
    searchSnapshot(tasks, settled, plan, page);
  if (result.sources.length === 0 || (result.papers.length === 0 && result.warnings.length > 0)) {
    const causes = settled.flatMap((item) => item?.status === "rejected" ? [item.reason] : []);
    throw new AcademicSearchError(
      "部分学术搜索服务暂时不可用，无法确认没有结果，请重试。",
      causes,
    );
  }

  return result;
}
