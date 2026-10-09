import { translateEnglishToChinese } from "./translation";

export const MAX_CONCEPT_CHARACTERS = 120;

export type ConceptResult = {
  title: string;
  summary: string;
  sourceUrl: string;
  sourceLabel: string;
  alternatives?: ConceptResult[];
  notice?: string;
};

export class ConceptLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConceptLookupError";
  }
}

export async function lookupChineseConcept(
  value: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConceptResult> {
  const query = value.trim();
  if (!query) throw new ConceptLookupError("请先选择一个概念或术语。");
  if (query.length > MAX_CONCEPT_CHARACTERS) {
    throw new ConceptLookupError(`概念查询最多 ${MAX_CONCEPT_CHARACTERS} 个字符，请缩短选区。`);
  }

  const local = localMeaning(query);
  if (local) return local;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const client: typeof fetch = (input, init) => fetchImpl(input, { ...init, signal: controller.signal });
  const language = /[\u3400-\u9fff]/.test(query) ? "zh" : "en";
  const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
  url.search = new URLSearchParams({
    action: "query", generator: "search", gsrsearch: query, gsrlimit: "3", gsrnamespace: "0",
    prop: "extracts|pageprops|langlinks", lllang: "zh", lllimit: "3", exintro: "1", explaintext: "1", exsentences: "2", exlimit: "3",
    format: "json", origin: "*", ...(language === "zh" ? { variant: "zh-cn" } : {}),
  }).toString();
  try {
    const response = await client(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new ConceptLookupError(`百科暂时不可用（HTTP ${response.status}），请稍后重试。`);
    const payload = await response.json() as { query?: { pages?: Record<string, {
      title?: unknown; extract?: unknown; index?: number; pageprops?: Record<string, unknown>;
      langlinks?: Array<{ lang?: string; "*"?: string }>;
    }> }; error?: unknown };
    if (payload.error) throw new ConceptLookupError("百科查询失败，请稍后重试。");
    const pages = Object.values(payload.query?.pages ?? {}).sort((a, b) => (a.index ?? 999) - (b.index ?? 999))
      .filter((page) => typeof page.title === "string" && typeof page.extract === "string" && page.extract.trim()
        && !Object.prototype.hasOwnProperty.call(page.pageprops ?? {}, "disambiguation"));
    if (!pages.length) throw new ConceptLookupError("暂未找到可用释义，请尝试更短的词或完整名称；这不代表该词不存在。");
    let translationFailed = false;
    const meanings = await Promise.all(pages.map(async (page): Promise<ConceptResult> => {
      let summary = concise(page.extract as string);
      let translated = false;
      if (language === "en") {
        const chineseTitle = page.langlinks?.find((link) => link.lang === "zh")?.["*"];
        if (chineseTitle) {
          try {
            const chineseUrl = new URL("https://zh.wikipedia.org/w/api.php");
            chineseUrl.search = new URLSearchParams({ action: "query", titles: chineseTitle, redirects: "1",
              prop: "extracts", exintro: "1", explaintext: "1", exsentences: "2", variant: "zh-cn", format: "json", origin: "*" }).toString();
            const chineseResponse = await client(chineseUrl);
            if (!chineseResponse.ok) throw new Error("Chinese article unavailable");
            const chinesePayload = await chineseResponse.json() as { query?: { pages?: Record<string, { title?: string; extract?: string }> } };
            const article = Object.values(chinesePayload.query?.pages ?? {}).find((item) => typeof item.extract === "string" && item.extract.trim());
            if (article?.extract) return {
              title: article.title ?? chineseTitle, summary: concise(article.extract),
              sourceUrl: `https://zh.wikipedia.org/wiki/${encodeURIComponent(article.title ?? chineseTitle)}`,
              sourceLabel: "维基百科 · 对应中文词条",
            };
          } catch { /* Keep the English source and try translation below. */ }
        }
        try {
          const text = concise(await translateEnglishToChinese(summary, client));
          if (!/[\u3400-\u9fff]/.test(text)) throw new Error("No Chinese translation returned");
          summary = text;
          translated = true;
        }
        catch { translationFailed = true; }
      }
      return {
        title: page.title as string, summary,
        sourceUrl: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(page.title as string)}`,
        sourceLabel: language === "zh" ? "维基百科 · 中文摘要" : translated ? "维基百科 · 机器翻译" : "维基百科 · 英文原文",
      };
    }));
    return { ...meanings[0], alternatives: meanings.slice(1), notice: [
      "以下是百科匹配结果，请核对词条名称；通用释义不等于本文的特定含义。",
      translationFailed ? "部分中文翻译暂时不可用，已保留原文。" : "",
    ].filter(Boolean).join(" ") };
  } catch (error) {
    if (error instanceof ConceptLookupError) throw error;
    throw new ConceptLookupError(controller.signal.aborted ? "释义查询超时，请重试。" : "百科连接失败，请检查网络后重试。常见内置词语仍可离线解释。");
  } finally { clearTimeout(timer); }
}

function concise(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 400 ? `${normalized.slice(0, 399)}…` : normalized;
}

const APPLE: ConceptResult[] = [
  { title: "苹果（水果）", summary: "一种常见水果，长在苹果树上，果肉通常脆、多汁，味道甜或酸甜。", sourceUrl: "https://zh.wikipedia.org/wiki/苹果", sourceLabel: "内置简明释义 · 参考维基百科" },
  { title: "苹果公司（Apple）", summary: "一家科技公司，主要设计和销售 iPhone、Mac 等电子产品，以及相关软件和服务。", sourceUrl: "https://zh.wikipedia.org/wiki/苹果公司", sourceLabel: "内置简明释义 · 参考维基百科" },
];

function localMeaning(query: string): ConceptResult | undefined {
  const key = query.toLowerCase().replace(/[®™]/g, "").replace(/\s+/g, " ");
  if (["苹果", "蘋果", "apple"].includes(key)) return {
    ...APPLE[0], alternatives: [{ ...APPLE[1] }], notice: "这个词有不同含义，请结合上下文选择；未自动判断作者指的是哪一个。",
  };
  if (["苹果公司", "蘋果公司", "apple inc.", "apple inc"].includes(key)) return { ...APPLE[1] };
  if (/^(?:(?:nvidia|英伟达|英偉達) )?(?:tesla )?v100(?: (?:gpu|tensor core gpu))?$/.test(key)) return {
    title: "NVIDIA V100 GPU", summary: "英伟达的一款数据中心计算芯片，采用 Volta 架构，常用于训练神经网络和科学计算。它能并行进行大量矩阵运算；论文提到它时，通常是在说明实验使用的计算硬件。",
    sourceUrl: "https://www.nvidia.com/en-us/data-center/v100/", sourceLabel: "内置简明释义 · 参考 NVIDIA 官方资料",
  };
  if (["gpu", "图形处理器", "圖形處理器", "graphics processing unit"].includes(key)) return {
    title: "GPU（图形处理器）", summary: "一种擅长同时处理大量相似计算的芯片。它既能绘制图像，也常用于神经网络训练和科学计算；可以把它理解为许多计算单元一起干活。",
    sourceUrl: "https://zh.wikipedia.org/wiki/图形处理器", sourceLabel: "内置简明释义 · 参考维基百科",
  };
}
