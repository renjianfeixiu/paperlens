import { normalizeDoi } from "./doi";

export type SearchIntent = "doi" | "arxiv" | "title" | "topic";

export type SearchQueryPlan = {
  rawQuery: string;
  intent: SearchIntent;
  doi?: string;
  lexicalQueries: string[];
  semanticQuery?: string;
  exactTitleQuery?: string;
  interpretation?: string;
};

const ARXIV_PATTERN = /^(?:arxiv\s*:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)?([a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i;

const CHINESE_ACADEMIC_TERMS: ReadonlyArray<readonly [string, string]> = [
  ["检索增强生成", "retrieval augmented generation"],
  ["大语言模型", "large language model"],
  ["注意力机制", "attention mechanism"],
  ["交叉注意力", "cross attention"],
  ["自注意力", "self attention"],
  ["时间序列", "time series"],
  ["因果推断", "causal inference"],
  ["强化学习", "reinforcement learning"],
  ["计算机视觉", "computer vision"],
  ["医学图像", "medical imaging"],
  ["小样本", "few shot"],
  ["神经网络", "neural network"],
  ["深度学习", "deep learning"],
  ["机器学习", "machine learning"],
  ["图像分割", "image segmentation"],
  ["目标检测", "object detection"],
  ["自然语言处理", "natural language processing"],
  ["知识图谱", "knowledge graph"],
  ["多模态", "multimodal"],
  ["可解释", "interpretable"],
  ["预测", "prediction"],
  ["分类", "classification"],
  ["关注", "attention"],
  ["重要", "importance"],
  ["输入", "input"],
  ["图像", "image"],
  ["文本", "text"],
];

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function arxivDoi(query: string): string | undefined {
  const match = query.trim().match(ARXIV_PATTERN);
  return match ? `10.48550/arxiv.${match[1].toLowerCase()}` : undefined;
}

function englishExpansion(query: string): string | undefined {
  if (!/[\u3400-\u9fff]/u.test(query)) return undefined;

  const terms = CHINESE_ACADEMIC_TERMS.flatMap(([chinese, english]) =>
    query.includes(chinese) ? [english] : [],
  );
  return unique(terms).join(" ") || undefined;
}

function looksLikeEnglishSentence(query: string): boolean {
  const words = query.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  return words.length >= 7;
}

function looksLikeTitle(query: string): boolean {
  if (/^"[\s\S]+"$/.test(query)) return true;
  const words = query.match(/[A-Za-z][A-Za-z0-9'-]*/g) ?? [];
  if (words.length < 4 || words.length > 18 || /[?.!]\s*$/.test(query)) return false;
  const meaningful = words.filter((word) => word.length > 2);
  const titleCase = meaningful.filter((word) => /^[A-Z]/.test(word)).length;
  return meaningful.length > 0 && titleCase / meaningful.length >= 0.55;
}

export function analyzeSearchQuery(input: string): SearchQueryPlan {
  const rawQuery = input.trim();
  if (!rawQuery) {
    return { rawQuery, intent: "topic", lexicalQueries: [] };
  }

  const doi = normalizeDoi(rawQuery);
  if (doi) {
    return {
      rawQuery,
      intent: doi.startsWith("10.48550/arxiv.") ? "arxiv" : "doi",
      doi,
      lexicalQueries: [doi],
      interpretation: `精确标识符：${doi}`,
    };
  }

  const normalizedArxivDoi = arxivDoi(rawQuery);
  if (normalizedArxivDoi) {
    return {
      rawQuery,
      intent: "arxiv",
      doi: normalizedArxivDoi,
      lexicalQueries: [normalizedArxivDoi],
      interpretation: `arXiv 精确匹配：${normalizedArxivDoi.replace("10.48550/arxiv.", "")}`,
    };
  }

  const expansion = englishExpansion(rawQuery);
  const quotedTitle = rawQuery.match(/^"([\s\S]+)"$/)?.[1]?.trim();
  const titleQuery = quotedTitle ?? (looksLikeTitle(rawQuery) ? rawQuery : undefined);
  const wordCount = rawQuery.split(/\s+/).length;
  // Capitalization is not evidence against an exact title. Keep topic/semantic
  // retrieval too; this is a supplemental candidate, not a restrictive filter.
  const exactTitleQuery = titleQuery ?? (wordCount >= 2 && wordCount <= 18 && rawQuery.length <= 240 ? rawQuery : undefined);
  const semanticQuery = expansion ?? (looksLikeEnglishSentence(rawQuery) ? rawQuery : undefined);

  return {
    rawQuery,
    intent: titleQuery ? "title" : "topic",
    lexicalQueries: unique([rawQuery, expansion ?? ""]),
    ...(semanticQuery ? { semanticQuery } : {}),
    ...(exactTitleQuery ? { exactTitleQuery } : {}),
    ...(expansion
      ? { interpretation: `已补充英文术语：${expansion}` }
      : semanticQuery
        ? { interpretation: "已同时使用关键词与语义检索" }
        : {}),
  };
}
